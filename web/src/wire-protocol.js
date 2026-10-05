// Browser projection of the arpg-protocol v12 envelope. This adapter validates
// only data consumed by presentation; gameplay rules remain in arpg-core.
export const PROTOCOL_VERSION = 12;
const MAX_SNAPSHOT_CHARACTERS = 65_535;
const integer = (value) => Number.isSafeInteger(value);
const nonNegative = (value) => integer(value) && value >= 0;
const vector = (value, size) =>
  Array.isArray(value) && value.length === size && value.every(integer);
const phases = new Set(["windup", "active", "recovery"]);
const kinds = new Set([
  "primaryAttack",
  "secondaryAttack",
  "interact",
  "counter",
  "lightFollowUp",
  "lightFinisher",
  "heavyFinisher",
  "shoot",
]);
const weapons = new Set(["swordAndShield", "bow"]);
const scenarios = new Set([
  "dungeon",
  "dummy",
  "enemy",
  "obstructed",
  "archery",
  "archeryObstructed",
]);
const parties = new Set(["player", "monster"]);
const strikeResults = new Set(["hit", "blocked", "guardBroken", "obstructed"]);
const party = (value) => parties.has(value?.kind) && nonNegative(value.id);
const interactionTargets = new Set(["loot", "chest"]);
const interactionRefusals = new Set(["nothingInRange", "chestLocked", "obstructed"]);
const interactionTarget = (value) => interactionTargets.has(value?.kind) && nonNegative(value.id);
const interactionPrompt = (value) =>
  (value?.kind === "available" && interactionTarget(value.target)) ||
  (value?.kind === "unavailable" && interactionRefusals.has(value.reason));
const interactionResult = (value) =>
  ((value?.kind === "pickedUp" || value?.kind === "opened") &&
    interactionTarget(value.target) &&
    nonNegative(value.gold)) ||
  (value?.kind === "refused" && interactionRefusals.has(value.reason));
const comboInputs = new Set(["light", "heavy"]);
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
          (value) =>
            action(value) &&
            kinds.has(value.kind) &&
            vector(value.facing, 2) &&
            typeof value.connected === "boolean" &&
            optional(value.buffered, (input) => comboInputs.has(input)) &&
            nonNegative(value.charge),
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
        ) &&
        weapons.has(player.weapon) &&
        optional(player.drawTicks, nonNegative) &&
        interactionPrompt(player.interaction),
    ) &&
    list(
      "chests",
      (chest) =>
        nonNegative(chest?.id) &&
        nonNegative(chest.roomId) &&
        vector(chest.position, 3) &&
        typeof chest.opened === "boolean" &&
        typeof chest.available === "boolean",
    ) &&
    list(
      "interactionEvents",
      (event) => nonNegative(event?.playerId) && interactionResult(event.result),
    ) &&
    scenarios.has(snapshot.scenario) &&
    list(
      "strikeEvents",
      (event) =>
        party(event?.source) &&
        party(event.target) &&
        nonNegative(event.strikeTick) &&
        typeof event.definition === "string" &&
        event.definition.length <= 64 &&
        strikeResults.has(event.result?.kind),
    ) &&
    list(
      "arrows",
      (arrow) =>
        nonNegative(arrow?.id) &&
        nonNegative(arrow.ownerId) &&
        vector(arrow.position, 3) &&
        vector(arrow.velocity, 3) &&
        nonNegative(arrow.ticksRemaining),
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
