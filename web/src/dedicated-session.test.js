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

function welcomeFrame({ playerId = 7, epoch = 1, tokenByte = 0x11 } = {}) {
  const frame = new Uint8Array(46);
  const view = new DataView(frame.buffer);
  frame[0] = 3;
  frame[1] = 3;
  view.setUint32(2, playerId, false);
  view.setUint16(6, 60, false);
  view.setUint16(8, 4, false);
  view.setBigUint64(10, 99n, false);
  view.setUint32(18, epoch, false);
  frame.fill(tokenByte, 22, 38);
  view.setBigUint64(38, 600n, false);
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

class FakeTransport {
  constructor(welcome, { ready = true } = {}) {
    this.sent = [];
    this.closedFlag = false;
    this.ready = ready
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.resolveReady = resolve;
        });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
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
    const sent = this.sent;
    const writable = new WritableStream({
      write(frame) {
        sent.push(new Uint8Array(frame));
      },
    });
    this.datagramController = datagramController;
    this.datagrams = { readable, writable };
  }

  releaseReady() {
    this.resolveReady?.();
    this.resolveReady = null;
  }

  drop() {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.datagramController.close();
    this.resolveClosed();
  }

  close() {
    this.drop();
  }
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
    const payload = new TextEncoder().encode('{"protocolVersion":2,"payload":{"tick":9}}');
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
      '{"protocolVersion":2,"payload":{"tick":9}}',
    );

    frame[20] ^= 1;
    expect(() => decodeGameServerSnapshot(frame)).toThrow("state hash");
  });

  test("derives the reconnect route and grace duration from authoritative welcome metadata", () => {
    const welcome = decodeGameServerWelcome(welcomeFrame());
    expect(reconnectGraceMilliseconds(welcome)).toBe(10_000);
    expect(
      reconnectEndpoint("https://game.example/arpg?ignored=yes#fragment", welcome.reconnectToken),
    ).toBe(`https://game.example/arpg/reconnect/${"11".repeat(16)}`);
  });

  test("resumes the same player with a rotated token and flushes outage commands", async () => {
    const first = new FakeTransport(welcomeFrame({ epoch: 3, tokenByte: 0x11 }));
    const second = new FakeTransport(welcomeFrame({ epoch: 5, tokenByte: 0x22 }), {
      ready: false,
    });
    const transports = [first, second];
    const requestedUrls = [];
    let reconnectingResolve;
    const reconnecting = new Promise((resolve) => {
      reconnectingResolve = resolve;
    });
    let resumedResolve;
    const resumed = new Promise((resolve) => {
      resumedResolve = resolve;
    });
    let connectingCount = 0;

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

    const initial = await session.connect({
      onWelcome: (welcome, metadata) => {
        if (metadata.resumed) resumedResolve(welcome);
      },
      onStateChange: (state) => {
        if (state === "connecting") {
          connectingCount += 1;
          if (connectingCount === 2) reconnectingResolve();
        }
      },
    });
    expect(initial.playerId).toBe(7);
    expect(initial.connectionEpoch).toBe(3);

    first.drop();
    await reconnecting;
    await session.sendCommand(8, new Uint8Array([9, 8, 7]));
    expect(second.sent).toHaveLength(0);

    second.releaseReady();
    const resumedWelcome = await resumed;
    expect(resumedWelcome.playerId).toBe(7);
    expect(resumedWelcome.connectionEpoch).toBe(5);
    expect([...resumedWelcome.reconnectToken]).toEqual(new Array(16).fill(0x22));
    expect(requestedUrls).toEqual([
      "https://game.example/arpg",
      `https://game.example/arpg/reconnect/${"11".repeat(16)}`,
    ]);
    expect(second.sent).toHaveLength(1);
    expect([...second.sent[0]]).toEqual([...encodeGameServerCommand(8, new Uint8Array([9, 8, 7]))]);

    session.close();
  });
});
