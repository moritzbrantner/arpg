import { expect, test } from "bun:test";
import { attachPeerGameSession } from "./peer-session.js";

function sessionFixture(role = "guest") {
  const session = new EventTarget();
  session.hostParticipantId = "host";
  session.sendReliable = () => {};
  const snapshots = [];
  const statuses = [];
  const commands = [];
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
    onPlayer() {},
    onSnapshot: (value) => snapshots.push(value),
    onStatus: (value) => statuses.push(value),
  });
  return {
    snapshots,
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

const snapshot = JSON.stringify({
  protocolVersion: 12,
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
    strikeEvents: [],
    chests: [],
    interactionEvents: [],
  },
});

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
