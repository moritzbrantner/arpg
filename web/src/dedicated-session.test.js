import { describe, expect, test } from "bun:test";

import {
  DedicatedGameSession,
  decodeGameServerSnapshot,
  decodeGameServerWelcome,
  encodeGameServerCommand,
  reconnectEndpoint,
  reconnectGraceMilliseconds,
  snapshotHash,
} from "./dedicated-session.js";

function welcomeFrame({
  playerId = 7,
  epoch = 1,
  tokenByte = 0x11,
  tickHz = 60,
  reconnectGraceTicks = 600n,
} = {}) {
  const frame = new Uint8Array(46);
  const view = new DataView(frame.buffer);
  frame[0] = 3;
  frame[1] = 3;
  view.setUint32(2, playerId, false);
  view.setUint16(6, tickHz, false);
  view.setUint16(8, 4, false);
  view.setBigUint64(10, 99n, false);
  view.setUint32(18, epoch, false);
  frame.fill(tokenByte, 22, 38);
  view.setBigUint64(38, BigInt(reconnectGraceTicks), false);
  return frame;
}

function readableChunk(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commandSequence(frame) {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false);
}

class FakeTransport {
  constructor(welcome, { ready = true } = {}) {
    this.sent = [];
    this.closedFlag = false;
    this.nextWriteError = null;
    this.readyDeferred = deferred();
    this.ready = this.readyDeferred.promise;
    if (ready) this.readyDeferred.resolve();
    this.closedDeferred = deferred();
    this.closed = this.closedDeferred.promise;
    this.incomingUnidirectionalStreams = new ReadableStream({
      start(controller) {
        controller.enqueue(readableChunk(welcome));
        controller.close();
      },
    });
    let datagramController;
    const readable = new ReadableStream({
      start(controller) {
        datagramController = controller;
      },
    });
    const transport = this;
    const writable = new WritableStream({
      write(frame) {
        if (transport.nextWriteError) {
          const error = transport.nextWriteError;
          transport.nextWriteError = null;
          throw error;
        }
        transport.sent.push(new Uint8Array(frame));
      },
    });
    this.datagramController = datagramController;
    this.datagrams = { readable, writable };
  }

  releaseReady() {
    this.readyDeferred.resolve();
  }

  rejectReady(error) {
    this.readyDeferred.reject(error);
  }

  failNextWrite(error = new Error("simulated datagram write failure")) {
    this.nextWriteError = error;
  }

  signalClosed() {
    this.closedDeferred.resolve();
  }

  drop() {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.datagramController.close();
    this.signalClosed();
  }

  close() {
    this.drop();
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("game-server WebTransport framing", () => {
  test("encodes commands with the pinned game-server protocol header", () => {
    expect([...encodeGameServerCommand(7, new Uint8Array([1, 2, 3]))]).toEqual([
      3,
      1,
      0,
      0,
      0,
      7,
      0,
      3,
      1,
      2,
      3,
    ]);
  });

  test("decodes welcome identity and reconnect metadata", () => {
    const frame = new Uint8Array(46);
    const view = new DataView(frame.buffer);
    frame[0] = 3;
    frame[1] = 3;
    view.setUint32(2, 7, false);
    view.setUint16(6, 60, false);
    view.setUint16(8, 4, false);
    view.setBigUint64(10, 99n, false);
    view.setUint32(18, 3, false);
    for (let index = 0; index < 16; index += 1) frame[22 + index] = index;
    view.setBigUint64(38, 600n, false);

    expect(decodeGameServerWelcome(frame)).toEqual({
      playerId: 7,
      tickHz: 60,
      maxPlayers: 4,
      currentTick: 99n,
      connectionEpoch: 3,
      reconnectToken: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
      reconnectGraceTicks: 600n,
    });
  });

  test("verifies snapshot length and state hash before exposing ARPG payload", () => {
    const payload = new TextEncoder().encode('{"protocolVersion":3,"payload":{"tick":9}}');
    const frame = new Uint8Array(20 + payload.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = 3;
    frame[1] = 2;
    view.setBigUint64(2, 9n, false);
    view.setBigUint64(10, snapshotHash(9n, payload), false);
    view.setUint16(18, payload.byteLength, false);
    frame.set(payload, 20);

    const decoded = decodeGameServerSnapshot(frame);
    expect(decoded.tick).toBe(9n);
    expect(new TextDecoder().decode(decoded.payload)).toBe(
      '{"protocolVersion":3,"payload":{"tick":9}}',
    );

    frame[20] ^= 1;
    expect(() => decodeGameServerSnapshot(frame)).toThrow("state hash");
  });
});

describe("dedicated reconnect contract", () => {
  test("derives the exact reconnect route and grace duration from authoritative welcome metadata", () => {
    const welcome = decodeGameServerWelcome(welcomeFrame());
    expect(reconnectGraceMilliseconds(welcome)).toBe(10_000);
    expect(
      reconnectEndpoint("https://game.example/arpg?ignored=yes#fragment", welcome.reconnectToken),
    ).toBe(`https://game.example/arpg/reconnect/${"11".repeat(16)}`);
  });

  test("automatically retries a failed reconnect while the authoritative grace window remains open", async () => {
    const first = new FakeTransport(welcomeFrame({ epoch: 3, tokenByte: 0x11 }));
    const resumedTransport = new FakeTransport(welcomeFrame({ epoch: 4, tokenByte: 0x22 }));
    const requestedUrls = [];
    let factoryAttempt = 0;
    const resumed = deferred();

    const session = new DedicatedGameSession({
      endpoint: "https://game.example/arpg",
      transportFactory: (url) => {
        requestedUrls.push(url);
        factoryAttempt += 1;
        if (factoryAttempt === 1) return first;
        if (factoryAttempt === 2) throw new Error("temporary reconnect failure");
        if (factoryAttempt === 3) return resumedTransport;
        throw new Error("unexpected transport attempt");
      },
      reconnectDelayMs: 1,
      sleep: async () => {},
    });

    await session.connect({
      onWelcome: (welcome, metadata) => {
        if (metadata.resumed) resumed.resolve(welcome);
      },
    });
    first.drop();

    const welcome = await resumed.promise;
    expect(welcome.playerId).toBe(7);
    expect(welcome.connectionEpoch).toBe(4);
    expect(requestedUrls).toEqual([
      "https://game.example/arpg",
      `https://game.example/arpg/reconnect/${"11".repeat(16)}`,
      `https://game.example/arpg/reconnect/${"11".repeat(16)}`,
    ]);

    session.close();
  });

  test("preserves player identity and command sequence continuity while flushing outage commands", async () => {
    const first = new FakeTransport(welcomeFrame({ epoch: 3, tokenByte: 0x11 }));
    const second = new FakeTransport(welcomeFrame({ epoch: 5, tokenByte: 0x22 }), {
      ready: false,
    });
    const transports = [first, second];
    const resumed = deferred();
    const reconnecting = deferred();
    let connectingCount = 0;

    const session = new DedicatedGameSession({
      endpoint: "https://game.example/arpg",
      transportFactory: () => {
        const transport = transports.shift();
        if (!transport) throw new Error("unexpected transport attempt");
        return transport;
      },
      reconnectDelayMs: 1,
      sleep: async () => {},
    });

    const initial = await session.connect({
      onWelcome: (welcome, metadata) => {
        if (metadata.resumed) resumed.resolve(welcome);
      },
      onStateChange: (state) => {
        if (state === "connecting") {
          connectingCount += 1;
          if (connectingCount === 2) reconnecting.resolve();
        }
      },
    });
    await session.sendCommand(41, new Uint8Array([1]));
    expect(commandSequence(first.sent[0])).toBe(41);

    first.drop();
    await reconnecting.promise;
    await session.sendCommand(42, new Uint8Array([2]));
    expect(second.sent).toHaveLength(0);

    second.releaseReady();
    const resumedWelcome = await resumed.promise;
    expect(resumedWelcome.playerId).toBe(initial.playerId);
    expect(resumedWelcome.connectionEpoch).toBeGreaterThan(initial.connectionEpoch);
    expect([...resumedWelcome.reconnectToken]).toEqual(new Array(16).fill(0x22));
    expect(second.sent).toHaveLength(1);
    expect(commandSequence(second.sent[0])).toBe(42);

    session.close();
  });

  test("uses each rotated reconnect token for the following resume and requires epochs to advance", async () => {
    const first = new FakeTransport(welcomeFrame({ epoch: 3, tokenByte: 0x11 }));
    const second = new FakeTransport(welcomeFrame({ epoch: 4, tokenByte: 0x22 }));
    const third = new FakeTransport(welcomeFrame({ epoch: 8, tokenByte: 0x33 }));
    const transports = [first, second, third];
    const requestedUrls = [];
    let resumedCount = 0;
    const twiceResumed = deferred();

    const session = new DedicatedGameSession({
      endpoint: "https://game.example/arpg",
      transportFactory: (url) => {
        requestedUrls.push(url);
        const transport = transports.shift();
        if (!transport) throw new Error("unexpected transport attempt");
        return transport;
      },
      reconnectDelayMs: 1,
      sleep: async () => {},
    });

    await session.connect({
      onWelcome: (_welcome, metadata) => {
        if (!metadata.resumed) return;
        resumedCount += 1;
        if (resumedCount === 2) twiceResumed.resolve();
      },
    });
    first.drop();
    while (resumedCount < 1) await flushMicrotasks();
    second.drop();
    await twiceResumed.promise;

    expect(requestedUrls).toEqual([
      "https://game.example/arpg",
      `https://game.example/arpg/reconnect/${"11".repeat(16)}`,
      `https://game.example/arpg/reconnect/${"22".repeat(16)}`,
    ]);
    expect(() =>
      session.validateResumedWelcome(
        decodeGameServerWelcome(welcomeFrame({ epoch: 8, tokenByte: 0x33 })),
        decodeGameServerWelcome(welcomeFrame({ epoch: 8, tokenByte: 0x44 })),
      ),
    ).toThrow("advance the connection epoch");

    session.close();
  });

  test("fences a late close callback from a superseded transport", async () => {
    const first = new FakeTransport(welcomeFrame({ epoch: 3, tokenByte: 0x11 }));
    const second = new FakeTransport(welcomeFrame({ epoch: 4, tokenByte: 0x22 }));
    const requestedUrls = [];
    const states = [];
    const resumed = deferred();

    const session = new DedicatedGameSession({
      endpoint: "https://game.example/arpg",
      transportFactory: (url) => {
        requestedUrls.push(url);
        if (requestedUrls.length === 1) return first;
        if (requestedUrls.length === 2) return second;
        throw new Error("stale callback started an unexpected reconnect");
      },
      reconnectDelayMs: 1,
      sleep: async () => {},
    });

    await session.connect({
      onWelcome: (_welcome, metadata) => {
        if (metadata.resumed) resumed.resolve();
      },
      onStateChange: (state) => states.push(state),
    });

    first.failNextWrite();
    await session.sendCommand(10, new Uint8Array([1]));
    await resumed.promise;
    const stateCountAfterResume = states.length;

    first.signalClosed();
    await flushMicrotasks();

    expect(requestedUrls).toHaveLength(2);
    expect(states).toHaveLength(stateCountAfterResume);
    expect(states.at(-1)).toBe("connected");

    first.datagramController.close();
    session.close();
  });

  test("bounds commands buffered during an outage", async () => {
    const first = new FakeTransport(welcomeFrame({ epoch: 3, tokenByte: 0x11 }));
    const blockedReconnect = new FakeTransport(welcomeFrame({ epoch: 4, tokenByte: 0x22 }), {
      ready: false,
    });
    const reconnecting = deferred();
    let connectingCount = 0;

    const session = new DedicatedGameSession({
      endpoint: "https://game.example/arpg",
      transportFactory: (url) =>
        url.includes("/reconnect/") ? blockedReconnect : first,
      reconnectDelayMs: 1,
      sleep: async () => {},
    });

    await session.connect({
      onStateChange: (state) => {
        if (state !== "connecting") return;
        connectingCount += 1;
        if (connectingCount === 2) reconnecting.resolve();
      },
    });
    first.drop();
    await reconnecting.promise;

    for (let sequence = 1; sequence <= 256; sequence += 1) {
      await session.sendCommand(sequence, new Uint8Array([sequence & 0xff]));
    }
    await expect(session.sendCommand(257, new Uint8Array([1]))).rejects.toThrow(
      "buffer exceeds 256 entries",
    );

    session.close();
  });

  test("fails closed after the reconnect grace expires", async () => {
    const first = new FakeTransport(
      welcomeFrame({
        epoch: 3,
        tokenByte: 0x11,
        tickHz: 1000,
        reconnectGraceTicks: 1n,
      }),
    );
    let now = 0;
    let reconnectAttempts = 0;
    const disconnected = deferred();

    const session = new DedicatedGameSession({
      endpoint: "https://game.example/arpg",
      transportFactory: (url) => {
        if (!url.includes("/reconnect/")) return first;
        reconnectAttempts += 1;
        throw new Error("server still unavailable");
      },
      reconnectDelayMs: 10,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await session.connect({
      onStateChange: (state) => {
        if (state === "disconnected") disconnected.resolve();
      },
    });
    first.drop();
    await disconnected.promise;

    expect(reconnectAttempts).toBe(2);
    await expect(session.sendCommand(2, new Uint8Array([1]))).rejects.toThrow(
      "not connected",
    );

    session.close();
  });
});
