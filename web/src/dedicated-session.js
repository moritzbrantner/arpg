const GAME_SERVER_PROTOCOL_VERSION = 3;
const COMMAND_KIND = 1;
const SNAPSHOT_KIND = 2;
const WELCOME_KIND = 3;
const COMMAND_HEADER_BYTES = 8;
const SNAPSHOT_HEADER_BYTES = 20;
const WELCOME_BYTES = 46;
const RECONNECT_TOKEN_BYTES = 16;
const MAX_COMMAND_PAYLOAD_BYTES = 1024;
const MAX_SNAPSHOT_PAYLOAD_BYTES = 0xffff;
const MAX_PENDING_COMMANDS = 256;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 1000;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Expected binary WebTransport data");
}

function requireHeader(bytes, kind) {
  if (bytes[0] !== GAME_SERVER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported game-server protocol version ${bytes[0]}`);
  }
  if (bytes[1] !== kind) {
    throw new Error(`Unexpected game-server frame kind ${bytes[1]}`);
  }
}

function fnvUpdate(hash, bytes) {
  let next = hash;
  for (const byte of bytes) {
    next ^= BigInt(byte);
    next = (next * FNV_PRIME) & U64_MASK;
  }
  return next;
}

function u64Bytes(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function snapshotHash(tick, payload) {
  const bytes = asBytes(payload);
  let hash = fnvUpdate(FNV_OFFSET_BASIS, u64Bytes(tick));
  hash = fnvUpdate(hash, u64Bytes(bytes.byteLength));
  return fnvUpdate(hash, bytes);
}

export function encodeGameServerCommand(sequence, payload) {
  if (!Number.isInteger(sequence) || sequence <= 0 || sequence > 0xffff_ffff) {
    throw new Error("Command sequence must be a non-zero u32");
  }
  const bytes = asBytes(payload);
  if (bytes.byteLength > MAX_COMMAND_PAYLOAD_BYTES) {
    throw new Error(`Command payload exceeds ${MAX_COMMAND_PAYLOAD_BYTES} bytes`);
  }
  const frame = new Uint8Array(COMMAND_HEADER_BYTES + bytes.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = GAME_SERVER_PROTOCOL_VERSION;
  frame[1] = COMMAND_KIND;
  view.setUint32(2, sequence, false);
  view.setUint16(6, bytes.byteLength, false);
  frame.set(bytes, COMMAND_HEADER_BYTES);
  return frame;
}

export function decodeGameServerSnapshot(frame) {
  const bytes = asBytes(frame);
  if (bytes.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new Error(`Snapshot frame is shorter than ${SNAPSHOT_HEADER_BYTES} bytes`);
  }
  requireHeader(bytes, SNAPSHOT_KIND);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tick = view.getBigUint64(2, false);
  const stateHash = view.getBigUint64(10, false);
  const payloadLength = view.getUint16(18, false);
  if (payloadLength > MAX_SNAPSHOT_PAYLOAD_BYTES) {
    throw new Error("Snapshot payload exceeds protocol limit");
  }
  if (bytes.byteLength !== SNAPSHOT_HEADER_BYTES + payloadLength) {
    throw new Error("Snapshot frame length does not match its declared payload length");
  }
  const payload = bytes.slice(SNAPSHOT_HEADER_BYTES);
  const expectedHash = snapshotHash(tick, payload);
  if (expectedHash !== stateHash) {
    throw new Error("Snapshot state hash does not match payload");
  }
  return { tick, stateHash, payload };
}

export function decodeGameServerWelcome(frame) {
  const bytes = asBytes(frame);
  if (bytes.byteLength !== WELCOME_BYTES) {
    throw new Error(`Welcome frame must contain exactly ${WELCOME_BYTES} bytes`);
  }
  requireHeader(bytes, WELCOME_KIND);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    playerId: view.getUint32(2, false),
    tickHz: view.getUint16(6, false),
    maxPlayers: view.getUint16(8, false),
    currentTick: view.getBigUint64(10, false),
    connectionEpoch: view.getUint32(18, false),
    reconnectToken: bytes.slice(22, 22 + RECONNECT_TOKEN_BYTES),
    reconnectGraceTicks: view.getBigUint64(38, false),
  };
}

export function reconnectTokenHex(token) {
  const bytes = asBytes(token);
  if (bytes.byteLength !== RECONNECT_TOKEN_BYTES) {
    throw new Error(`Reconnect token must contain exactly ${RECONNECT_TOKEN_BYTES} bytes`);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function reconnectEndpoint(endpoint, token) {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/reconnect/${reconnectTokenHex(token)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function reconnectGraceMilliseconds(welcome) {
  if (!welcome || !Number.isInteger(welcome.tickHz) || welcome.tickHz <= 0) return 0;
  const ticks = BigInt(welcome.reconnectGraceTicks);
  const tickHz = BigInt(welcome.tickHz);
  const milliseconds = (ticks * 1000n + tickHz - 1n) / tickHz;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(milliseconds > maximum ? maximum : milliseconds);
}

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = asBytes(value);
      chunks.push(bytes);
      total += bytes.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class DedicatedGameSession {
  constructor({
    endpoint,
    transportFactory = (url) => new WebTransport(url),
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    sleep = delay,
    now = () => Date.now(),
  }) {
    this.endpoint = endpoint;
    this.transportFactory = transportFactory;
    this.reconnectDelayMs = Math.max(1, reconnectDelayMs);
    this.sleep = sleep;
    this.now = now;
    this.transport = null;
    this.datagramWriter = null;
    this.closedByClient = false;
    this.callbacks = {};
    this.welcome = null;
    this.connectionGeneration = 0;
    this.reconnectRequested = false;
    this.reconnectTask = null;
    this.pendingCommands = [];
  }

  async connect(callbacks = {}) {
    if (this.transport || this.reconnectTask) {
      throw new Error("Dedicated session is already connected");
    }
    this.closedByClient = false;
    this.callbacks = callbacks;
    this.welcome = null;
    this.pendingCommands = [];
    this.callbacks.onStateChange?.("connecting");
    try {
      return await this.openTransport(this.endpoint, false);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  isCurrentTransport(transport, generation) {
    return (
      !this.closedByClient &&
      this.transport === transport &&
      this.connectionGeneration === generation
    );
  }

  requireCurrentTransport(transport, generation) {
    if (!this.isCurrentTransport(transport, generation)) {
      throw new Error("Dedicated connection was superseded while opening");
    }
  }

  validateResumedWelcome(previous, welcome) {
    if (!previous) throw new Error("Cannot resume without prior reconnect identity");
    if (welcome.playerId !== previous.playerId) {
      throw new Error("Dedicated reconnect changed authoritative player identity");
    }
    if (welcome.connectionEpoch <= previous.connectionEpoch) {
      throw new Error("Dedicated reconnect did not advance the connection epoch");
    }
  }

  async openTransport(endpoint, resumed) {
    const generation = ++this.connectionGeneration;
    let transport = null;
    try {
      transport = this.transportFactory(endpoint);
      this.transport = transport;
      await transport.ready;
      this.requireCurrentTransport(transport, generation);

      const streams = transport.incomingUnidirectionalStreams.getReader();
      const { value: welcomeStream, done } = await streams.read();
      streams.releaseLock();
      if (done || !welcomeStream) throw new Error("Dedicated server closed before welcome");

      const welcome = decodeGameServerWelcome(await readAll(welcomeStream));
      this.requireCurrentTransport(transport, generation);
      const previous = this.welcome;
      if (resumed) this.validateResumedWelcome(previous, welcome);

      this.datagramWriter = transport.datagrams.writable.getWriter();
      this.welcome = welcome;
      await this.flushPendingCommands(transport, generation);
      this.requireCurrentTransport(transport, generation);

      this.callbacks.onWelcome?.(welcome, { resumed });
      this.callbacks.onStateChange?.("connected");
      void this.consumeSnapshots(transport, generation);
      transport.closed
        .then(() => this.handleTransportFailure(transport, generation))
        .catch((error) => this.handleTransportFailure(transport, generation, error));
      return welcome;
    } catch (error) {
      if (transport) this.detachTransport(transport, generation, true);
      throw error;
    }
  }

  async consumeSnapshots(transport, generation) {
    const reader = transport.datagrams.readable.getReader();
    try {
      while (this.isCurrentTransport(transport, generation)) {
        const { value, done } = await reader.read();
        if (done) return;
        this.callbacks.onSnapshot?.(decodeGameServerSnapshot(value));
      }
    } catch (error) {
      this.handleTransportFailure(transport, generation, error);
    } finally {
      reader.releaseLock();
    }
  }

  detachTransport(transport, generation, closeTransport) {
    if (this.transport !== transport || this.connectionGeneration !== generation) return false;
    this.connectionGeneration += 1;
    try {
      this.datagramWriter?.releaseLock();
    } catch {
      // A pending write owns the writer until it settles.
    }
    this.datagramWriter = null;
    this.transport = null;
    if (closeTransport) {
      try {
        transport.close({ closeCode: 0, reason: "connection replaced" });
      } catch {
        // A failed transport may already be closed.
      }
    }
    return true;
  }

  handleTransportFailure(transport, generation, error = null) {
    if (this.closedByClient || !this.isCurrentTransport(transport, generation)) return;
    if (!this.detachTransport(transport, generation, false)) return;
    if (error) this.callbacks.onError?.(error);
    if (!this.welcome) {
      this.callbacks.onStateChange?.("disconnected");
      return;
    }
    this.requestReconnect();
  }

  requestReconnect() {
    if (this.closedByClient || !this.welcome) return;
    this.reconnectRequested = true;
    if (this.reconnectTask) return;
    this.reconnectTask = this.runReconnectLoop().finally(() => {
      this.reconnectTask = null;
      if (this.reconnectRequested && !this.closedByClient) this.requestReconnect();
    });
  }

  async runReconnectLoop() {
    if (!this.reconnectRequested || this.closedByClient || !this.welcome) return;
    this.reconnectRequested = false;
    let deadline = this.now() + reconnectGraceMilliseconds(this.welcome);
    let retryDelay = 0;
    let lastError = null;
    this.callbacks.onStateChange?.("connecting");

    while (!this.closedByClient && this.welcome && this.now() <= deadline) {
      if (retryDelay > 0) {
        const remaining = Math.max(0, deadline - this.now());
        if (remaining === 0) break;
        await this.sleep(Math.min(retryDelay, remaining));
        if (this.closedByClient) return;
      }

      const token = this.welcome.reconnectToken;
      const attemptedToken = reconnectTokenHex(token);
      try {
        await this.openTransport(reconnectEndpoint(this.endpoint, token), true);
        return;
      } catch (error) {
        lastError = error;
        if (this.welcome && reconnectTokenHex(this.welcome.reconnectToken) !== attemptedToken) {
          deadline = this.now() + reconnectGraceMilliseconds(this.welcome);
        }
        retryDelay =
          retryDelay === 0
            ? this.reconnectDelayMs
            : Math.min(retryDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }

    if (this.closedByClient) return;
    this.pendingCommands = [];
    this.welcome = null;
    if (lastError) this.callbacks.onError?.(lastError);
    this.callbacks.onStateChange?.("disconnected");
  }

  enqueueCommand(frame) {
    if (this.pendingCommands.length >= MAX_PENDING_COMMANDS) {
      throw new Error(`Dedicated reconnect command buffer exceeds ${MAX_PENDING_COMMANDS} entries`);
    }
    this.pendingCommands.push(frame.slice());
  }

  async flushPendingCommands(transport, generation) {
    while (this.pendingCommands.length > 0) {
      this.requireCurrentTransport(transport, generation);
      if (!this.datagramWriter) throw new Error("Dedicated datagram writer is unavailable");
      await this.datagramWriter.write(this.pendingCommands[0]);
      this.pendingCommands.shift();
    }
  }

  async sendCommand(sequence, payload) {
    const frame = encodeGameServerCommand(sequence, payload);
    if (this.closedByClient || !this.welcome) {
      throw new Error("Dedicated session is not connected");
    }
    if (!this.datagramWriter || !this.transport) {
      this.enqueueCommand(frame);
      return;
    }

    const transport = this.transport;
    const generation = this.connectionGeneration;
    try {
      await this.datagramWriter.write(frame);
    } catch (error) {
      if (this.isCurrentTransport(transport, generation)) {
        this.enqueueCommand(frame);
        this.handleTransportFailure(transport, generation, error);
        return;
      }
      throw error;
    }
  }

  close() {
    this.closedByClient = true;
    this.reconnectRequested = false;
    this.connectionGeneration += 1;
    try {
      this.datagramWriter?.releaseLock();
    } catch {
      // A pending write owns the writer until it settles.
    }
    this.datagramWriter = null;
    try {
      this.transport?.close({ closeCode: 0, reason: "client closed" });
    } catch {
      // The transport may already be closed.
    }
    this.transport = null;
    this.welcome = null;
    this.pendingCommands = [];
  }
}
