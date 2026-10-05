// Browser projection of the arpg-protocol v8 envelope. This adapter validates
// only data consumed by presentation; gameplay rules remain in arpg-core.
export const PROTOCOL_VERSION = 8;
const MAX_SNAPSHOT_CHARACTERS = 65_535;
const integer = (value) => Number.isSafeInteger(value);
const nonNegative = (value) => integer(value) && value >= 0;
const vector = (value, size) =>
  Array.isArray(value) && value.length === size && value.every(integer);
const phases = new Set(["windup", "active", "recovery"]);
const kinds = new Set(["primaryAttack", "secondaryAttack", "interact", "counter"]);
const playerReactions = new Set(["hurt", "blocked", "guardBroken"]);
const guardPhases = new Set(["raising", "raised"]);
const optional = (value, validate) => value === null || value === undefined || validate(value);
const action = (value) => phases.has(value?.phase) && nonNegative(value.ticksRemaining);
const reaction = (value, kind) => value?.kind === kind && nonNegative(value.ticksRemaining);

export function encodeCommand(payload) {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, payload });
}

export function decodeSnapshot(encoded) {
  if (typeof encoded !== "string" || encoded.length > MAX_SNAPSHOT_CHARACTERS)
    throw new Error("Invalid ARPG snapshot size");
  const envelope = JSON.parse(encoded);
  if (envelope?.protocolVersion !== PROTOCOL_VERSION || !envelope.payload)
    throw new Error("Unsupported or malformed ARPG snapshot");
  const snapshot = envelope.payload;
  const list = (name, validate) => Array.isArray(snapshot[name]) && snapshot[name].every(validate);
  const valid =
    nonNegative(snapshot.tick) &&
    nonNegative(snapshot.runSeed) &&
    snapshot.runSeed <= 0xffff_ffff &&
    integer(snapshot.worldUnitsPerMeter) &&
    snapshot.worldUnitsPerMeter > 0 &&
    list(
      "players",
      (player) =>
        nonNegative(player?.id) &&
        vector(player.position, 3) &&
        vector(player.facing, 2) &&
        typeof player.alive === "boolean" &&
        [
          "health",
          "maxHealth",
          "level",
          "experienceIntoLevel",
          "experienceForNextLevel",
          "attackDamage",
          "gold",
        ].every((key) => nonNegative(player[key])) &&
        optional(
          player.action,
          (value) => action(value) && kinds.has(value.kind) && vector(value.facing, 2),
        ) &&
        optional(
          player.reaction,
          (value) => playerReactions.has(value?.kind) && nonNegative(value.ticksRemaining),
        ) &&
        optional(
          player.guard,
          (value) => guardPhases.has(value?.phase) && nonNegative(value.ticksRemaining),
        ) &&
        nonNegative(player.guardPoints) &&
        nonNegative(player.maxGuardPoints) &&
        player.guardPoints <= player.maxGuardPoints &&
        optional(
          player.counter,
          (value) =>
            nonNegative(value?.usableFromTick) &&
            nonNegative(value.expiresAtTick) &&
            value.usableFromTick < value.expiresAtTick,
        ),
    ) &&
    list(
      "monsters",
      (monster) =>
        nonNegative(monster?.id) &&
        vector(monster.position, 3) &&
        typeof monster.alive === "boolean" &&
        optional(
          monster.action,
          (value) => action(value) && nonNegative(value.targetPlayerId) && nonNegative(value.range),
        ) &&
        optional(monster.reaction, (value) => reaction(value, "stagger")),
    ) &&
    list(
      "rooms",
      (room) => room && ["minX", "maxX", "minZ", "maxZ"].every((key) => integer(room[key])),
    ) &&
    list(
      "staticColliders",
      (collider) =>
        nonNegative(collider?.id) &&
        vector(collider.position, 3) &&
        vector(collider.halfExtents, 3) &&
        collider.halfExtents.every((value) => value >= 0) &&
        ["wall", "door", "pillar"].includes(collider.kind),
    ) &&
    list(
      "groundLoot",
      (loot) => nonNegative(loot?.id) && vector(loot.position, 3) && loot.kind === "gold",
    );
  if (!valid) throw new Error("Malformed ARPG presentation snapshot");
  return snapshot;
}
