import { expect, test } from "bun:test";
import { attachPeerGameSession } from "./peer-session.js";
import { PROTOCOL_VERSION } from "./wire-protocol.js";

const LOCAL_REVISION = "0123456789abcdef";

function sessionFixture(role = "guest") {
  const session = new EventTarget();
  session.hostParticipantId = "host";
  session.sendReliable = () => {};
  const snapshots = [];
  const statuses = [];
  const commands = [];
  const players = [];
  const incompatible = [];
  let current = true;
  const detach = attachPeerGameSession({
    session,
    role,
    isCurrent: () => current,
    getGame: () => ({
      addPlayer() {},
      snapshotJson: () => "{}",
      applyCommand: (...args) => commands.push(args),
    }),
    onPlayer: (value) => players.push(value),
    onSnapshot: (value) => snapshots.push(value),
    onStatus: (value) => statuses.push(value),
    localContentRevision: () => LOCAL_REVISION,
    onIncompatible: (reason) => incompatible.push(reason),
  });
  return {
    snapshots,
    players,
    incompatible,
    statuses,
    commands,
    detach,
    replace() {
      current = false;
    },
    emit(name, detail) {
      session.dispatchEvent(new CustomEvent(name, { detail }));
    },
  };
}

const snapshotWith = ({ contentRevision = LOCAL_REVISION } = {}) =>
  JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    payload: {
      tick: 1,
      runSeed: 42,
      worldUnitsPerMeter: 100,
      players: [],
      monsters: [],
      rooms: [],
      staticColliders: [],
      groundLoot: [],
      arrows: [],
      scenario: "dungeon",
      contentRevision,
      strikeEvents: [],
      chests: [],
      interactionEvents: [],
    },
  });
const snapshot = snapshotWith();

test("guests accept presentation snapshots only from the current host", () => {
  const fixture = sessionFixture();
  fixture.emit("realtime", {
    peerId: "other-guest",
    data: { kind: "snapshot", encoded: snapshot },
  });
  expect(fixture.snapshots).toHaveLength(0);
  fixture.emit("realtime", { peerId: "host", data: { kind: "snapshot", encoded: snapshot } });
  expect(fixture.snapshots).toHaveLength(1);
  fixture.replace();
  fixture.emit("realtime", { peerId: "host", data: { kind: "snapshot", encoded: snapshot } });
  expect(fixture.snapshots).toHaveLength(1);
});

test("malformed packets produce a bounded rejection and detached listeners cannot update state", () => {
  const fixture = sessionFixture();
  fixture.emit("realtime", { peerId: "host", data: { kind: "snapshot", encoded: "bad json" } });
  expect(fixture.statuses).toHaveLength(1);
  expect(fixture.snapshots).toHaveLength(0);
  fixture.detach();
  fixture.emit("statechange", { state: "closed" });
  expect(fixture.statuses).toHaveLength(1);
});

test("hosts use their own player assignment and validate command envelopes before WASM coercion", () => {
  const fixture = sessionFixture("host");
  fixture.emit("peer-ready", { peerId: "guest" });
  fixture.emit("reliable", {
    peerId: "guest",
    data: { kind: "command", sequence: 1.5, encoded: "{}" },
  });
  expect(fixture.commands).toHaveLength(0);
  fixture.emit("reliable", {
    peerId: "guest",
    data: { kind: "command", playerId: 4, sequence: 1, encoded: "{}" },
  });
  expect(fixture.commands).toEqual([[2, 1, "{}"]]);
});

test("guests refuse a host running other content before taking a player", () => {
  const fixture = sessionFixture();
  const foreign = snapshotWith({ contentRevision: "fedcba9876543210" });
  fixture.emit("reliable", {
    peerId: "host",
    data: { kind: "welcome", playerId: 2, encodedSnapshot: foreign },
  });
  expect(fixture.players).toEqual([]);
  expect(fixture.snapshots).toHaveLength(0);
  expect(fixture.incompatible).toEqual([
    "Incompatible game content: the host runs content revision fedcba9876543210, " +
      "this client runs 0123456789abcdef. Both sides need the same game build.",
  ]);
  fixture.emit("realtime", { peerId: "host", data: { kind: "snapshot", encoded: foreign } });
  expect(fixture.snapshots).toHaveLength(0);
  expect(fixture.incompatible).toHaveLength(2);
});
