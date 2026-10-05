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
const encode = (value) => JSON.stringify({ protocolVersion: 8, payload: value });

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

const player = {
  id: 1,
  position: [0, 50, 0],
  facing: [1, 0],
  alive: true,
  health: 100,
  maxHealth: 100,
  level: 1,
  experienceIntoLevel: 0,
  experienceForNextLevel: 100,
  attackDamage: 25,
  gold: 0,
  guard: { phase: "raised", ticksRemaining: 0 },
  guardPoints: 70,
  maxGuardPoints: 100,
  reaction: { kind: "blocked", ticksRemaining: 8 },
  counter: { blockedMonsterId: 3, blockedAtTick: 9, usableFromTick: 10, expiresAtTick: 40 },
};

test("admits shield guard state and rejects malformed guard data", () => {
  expect(decodeSnapshot(encode({ ...payload, players: [player] })).players[0].guard.phase).toBe(
    "raised",
  );
  for (const candidate of [
    { ...player, guard: { phase: "lowered", ticksRemaining: 0 } },
    { ...player, guardPoints: 101 },
    { ...player, guardPoints: undefined },
    { ...player, reaction: { kind: "parried", ticksRemaining: 1 } },
    { ...player, counter: { usableFromTick: 40, expiresAtTick: 10 } },
  ])
    expect(() => decodeSnapshot(encode({ ...payload, players: [candidate] }))).toThrow();
});
