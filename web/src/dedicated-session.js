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
  constructor({ endpoint, transportFactory = (url) => new WebTransport(url) }) {
    this.endpoint = endpoint;
    this.transportFactory = transportFactory;
    this.transport = null;
    this.datagramWriter = null;
    this.closedByClient = false;
  }

  async connect({ onWelcome, onSnapshot, onStateChange, onError } = {}) {
    if (this.transport) throw new Error("Dedicated session is already connected");
    this.closedByClient = false;
    onStateChange?.("connecting");
    const transport = this.transportFactory(this.endpoint);
    this.transport = transport;
    try {
      await transport.ready;
      const streams = transport.incomingUnidirectionalStreams.getReader();
      const { value: welcomeStream, done } = await streams.read();
      streams.releaseLock();
      if (done || !welcomeStream) throw new Error("Dedicated server closed before welcome");
      const welcome = decodeGameServerWelcome(await readAll(welcomeStream));
      this.datagramWriter = transport.datagrams.writable.getWriter();
      onWelcome?.(welcome);
      onStateChange?.("connected");
      void this.consumeSnapshots(transport, onSnapshot, onError);
      transport.closed
        .then(() => {
          if (!this.closedByClient) onStateChange?.("disconnected");
        })
        .catch((error) => {
          if (!this.closedByClient) onError?.(error);
        });
      return welcome;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async consumeSnapshots(transport, onSnapshot, onError) {
    const reader = transport.datagrams.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        try {
          onSnapshot?.(decodeGameServerSnapshot(value));
        } catch (error) {
          onError?.(error);
          this.close();
          return;
        }
      }
    } catch (error) {
      if (!this.closedByClient) onError?.(error);
    } finally {
      reader.releaseLock();
    }
  }

  async sendCommand(sequence, payload) {
    if (!this.datagramWriter) throw new Error("Dedicated session is not connected");
    await this.datagramWriter.write(encodeGameServerCommand(sequence, payload));
  }

  close() {
    this.closedByClient = true;
    try {
      this.datagramWriter?.releaseLock();
    } catch {
      // A pending write owns the writer until it settles.
    }
    this.datagramWriter = null;
    this.transport?.close({ closeCode: 0, reason: "client closed" });
    this.transport = null;
  }
}
