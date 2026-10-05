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
  arrows: [],
  scenario: "dungeon",
  strikeEvents: [],
  chests: [],
  interactionEvents: [],
};
const encode = (value) => JSON.stringify({ protocolVersion: 12, payload: value });

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
  action: {
    kind: "lightFollowUp",
    phase: "recovery",
    ticksRemaining: 5,
    facing: [1, 0],
    connected: true,
    buffered: "heavy",
    charge: 0,
  },
  weapon: "bow",
  drawTicks: 12,
  interaction: { kind: "available", target: { kind: "chest", id: 50002 } },
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
    { ...player, action: { ...player.action, buffered: "special" } },
    { ...player, action: { ...player.action, connected: undefined } },
    { ...player, weapon: "spear" },
    { ...player, drawTicks: -1 },
    { ...player, interaction: { kind: "available", target: { kind: "door", id: 1 } } },
    { ...player, interaction: { kind: "unavailable", reason: "tooTired" } },
  ])
    expect(() => decodeSnapshot(encode({ ...payload, players: [candidate] }))).toThrow();
});

test("admits workbench scenario and strike events and rejects malformed ones", () => {
  const event = {
    source: { kind: "player", id: 1 },
    strikeTick: 4,
    definition: "sword.lightSwing",
    target: { kind: "monster", id: 2 },
    result: { kind: "hit", damage: 25, defeated: false },
  };
  const decoded = decodeSnapshot(
    encode({ ...payload, scenario: "archery", strikeEvents: [event] }),
  );
  expect(decoded.strikeEvents[0].result.kind).toBe("hit");
  for (const candidate of [
    { ...payload, scenario: "lava" },
    { ...payload, strikeEvents: [{ ...event, source: { kind: "ghost", id: 1 } }] },
    { ...payload, strikeEvents: [{ ...event, result: { kind: "parried" } }] },
    { ...payload, strikeEvents: [{ ...event, definition: "x".repeat(65) }] },
  ])
    expect(() => decodeSnapshot(encode(candidate))).toThrow();
});

test("admits chests and interaction results and rejects malformed ones", () => {
  const chest = { id: 50002, roomId: 2, position: [0, 50, 0], opened: false, available: true };
  const picked = {
    playerId: 1,
    result: { kind: "pickedUp", target: { kind: "loot", id: 30000 }, gold: 10 },
  };
  const refused = { playerId: 2, result: { kind: "refused", reason: "chestLocked" } };
  const decoded = decodeSnapshot(
    encode({ ...payload, chests: [chest], interactionEvents: [picked, refused] }),
  );
  expect(decoded.interactionEvents).toHaveLength(2);
  for (const candidate of [
    { ...payload, chests: [{ ...chest, opened: "yes" }] },
    { ...payload, interactionEvents: [{ ...picked, result: { ...picked.result, gold: -1 } }] },
    { ...payload, interactionEvents: [{ ...refused, result: { kind: "refused", reason: "x" } }] },
  ])
    expect(() => decodeSnapshot(encode(candidate))).toThrow();
});
