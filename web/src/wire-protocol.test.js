import { expect, test } from "bun:test";
import { decodeSnapshot } from "./wire-protocol.js";

const payload = {
  tick: 0,
  runSeed: 42,
  worldUnitsPerMeter: 100,
  players: [],
  monsters: [],
  rooms: [],
  staticColliders: [],
  groundLoot: [],
};
const encode = (value) => JSON.stringify({ protocolVersion: 6, payload: value });

test("admits bounded presentation data and rejects malformed vectors and collections", () => {
  expect(decodeSnapshot(encode(payload))).toEqual(payload);
  for (const candidate of [
    { ...payload, players: {} },
    { ...payload, worldUnitsPerMeter: 0 },
    { ...payload, tick: -1 },
    { ...payload, runSeed: 0x100000000 },
    { ...payload, monsters: [{ id: 1, alive: true, position: [0, 0] }] },
    {
      ...payload,
      staticColliders: [{ id: 1, kind: "wall", position: [0, 0, 0], halfExtents: [1, -1, 1] }],
    },
  ])
    expect(() => decodeSnapshot(encode(candidate))).toThrow();
  expect(() => decodeSnapshot(" ".repeat(65_536))).toThrow("size");
});
