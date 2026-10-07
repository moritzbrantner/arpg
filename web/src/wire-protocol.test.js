import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, contentRevisionMismatch, decodeSnapshot } from "./wire-protocol.js";

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
  contentRevision: "0123456789abcdef",
  strikeEvents: [],
  chests: [],
  interactionEvents: [],
};
const encode = (value) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, payload: value });

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

test("admits aim intent and a target lock and rejects malformed ones", () => {
  const aimed = {
    ...player,
    aim: [-250, 1000],
    lockedMonsterId: 3,
    action: { ...player.action, aim: [927, -375] },
  };
  const decoded = decodeSnapshot(encode({ ...payload, players: [aimed] })).players[0];
  expect(decoded.aim).toEqual([-250, 1000]);
  expect(decoded.lockedMonsterId).toBe(3);
  expect(decoded.action.aim).toEqual([927, -375]);
  // Absent and null both mean "no aim" and "no lock".
  expect(
    decodeSnapshot(
      encode({ ...payload, players: [{ ...player, aim: null, lockedMonsterId: null }] }),
    ).players[0].aim,
  ).toBeNull();
  for (const candidate of [
    { ...player, aim: [0, 0] },
    { ...player, aim: [1001, 0] },
    { ...player, aim: [0.5, 1] },
    { ...player, aim: [1] },
    { ...player, lockedMonsterId: -1 },
    { ...player, action: { ...player.action, aim: [0, 2000] } },
  ])
    expect(() => decodeSnapshot(encode({ ...payload, players: [candidate] }))).toThrow();
});

test("admits workbench scenario and strike events and rejects malformed ones", () => {
  const event = {
    order: 0,
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
    order: 0,
    playerId: 1,
    result: { kind: "pickedUp", target: { kind: "loot", id: 30000 }, gold: 10 },
  };
  const refused = { order: 1, playerId: 2, result: { kind: "refused", reason: "busy" } };
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

test("requires the authority's content revision", () => {
  for (const contentRevision of [undefined, "", "XYZ", "0123456789abcdef0"])
    expect(() => decodeSnapshot(encode({ ...payload, contentRevision }))).toThrow();
});

const monster = {
  id: 1,
  definition: "monster.brute",
  roomId: 2,
  position: [0, 50, 0],
  health: 100,
  maxHealth: 100,
  alive: true,
  action: null,
  reaction: null,
  behavior: "pursuing",
  targetPlayerId: 1,
};

test("monsters publish their authoritative behaviour and engaged target", () => {
  const decoded = decodeSnapshot(encode({ ...payload, monsters: [monster] }));
  expect(decoded.monsters[0].behavior).toBe("pursuing");
  expect(decoded.monsters[0].targetPlayerId).toBe(1);
  for (const behavior of ["returning", "searching", "holding", "idle", "dormant", "dead"])
    expect(
      decodeSnapshot(
        encode({ ...payload, monsters: [{ ...monster, behavior, targetPlayerId: null }] }),
      ).monsters[0].behavior,
    ).toBe(behavior);
  for (const candidate of [
    { ...monster, behavior: undefined },
    { ...monster, behavior: "fleeing" },
    { ...monster, targetPlayerId: -1 },
    { ...monster, definition: undefined },
    { ...monster, definition: "" },
    { ...monster, definition: "m".repeat(65) },
    { ...monster, maxHealth: undefined },
    { ...monster, health: 101 },
  ])
    expect(() => decodeSnapshot(encode({ ...payload, monsters: [candidate] }))).toThrow();
  expect(() =>
    decodeSnapshot(
      JSON.stringify({ protocolVersion: 14, payload: { ...payload, monsters: [monster] } }),
    ),
  ).toThrow("Unsupported");
});

test("monsters publish their content definition and maximum health", () => {
  const skirmisher = { ...monster, definition: "monster.skirmisher", health: 60, maxHealth: 60 };
  const decoded = decodeSnapshot(encode({ ...payload, monsters: [monster, skirmisher] }));
  expect(decoded.monsters.map(({ definition }) => definition)).toEqual([
    "monster.brute",
    "monster.skirmisher",
  ]);
  expect(decoded.monsters[1].maxHealth).toBe(60);
});

test("a content revision mismatch names both revisions; a match passes", () => {
  expect(contentRevisionMismatch("0123456789abcdef", payload, "host")).toBeNull();
  expect(contentRevisionMismatch("fedcba9876543210", payload, "dedicated authority")).toBe(
    "Incompatible game content: the dedicated authority runs content revision " +
      "0123456789abcdef, this client runs fedcba9876543210. Both sides need the same game build.",
  );
});
