import { describe, expect, test } from "bun:test";

import {
  decodeGameServerSnapshot,
  decodeGameServerWelcome,
  encodeGameServerCommand,
  snapshotHash,
} from "./dedicated-session.js";

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
});
