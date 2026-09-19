import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WasmGame } = require("../.wasm-test/arpg_web_wasm.js");

const protocolEnvelope = (payload) => JSON.stringify({ protocolVersion: 2, payload });
const decodeSnapshot = (game) => JSON.parse(game.snapshotJson());

const game = new WasmGame(42);
try {
  assert.equal(game.tickHz(), 60);
  game.addPlayer(1);

  const initial = decodeSnapshot(game);
  assert.equal(initial.protocolVersion, 2);
  assert.equal(initial.payload.runSeed, 42);
  assert.equal(initial.payload.tick, 0);
  assert.equal(initial.payload.players.length, 1);
  assert.equal(initial.payload.players[0].id, 1);

  const initialPosition = initial.payload.players[0].position;
  game.applyCommand(1, 1, protocolEnvelope({ type: "setMovement", x: 1, z: 0 }));
  game.advanceTick();

  const moved = decodeSnapshot(game);
  assert.equal(moved.payload.tick, 1);
  assert.equal(moved.payload.runSeed, 42);
  assert.notDeepEqual(moved.payload.players[0].position, initialPosition);

  assert.throws(
    () => game.applyCommand(1, 2, "not-json"),
    /expected|JSON|json|malformed/i,
    "malformed JS payloads must fail at the Wasm protocol boundary",
  );

  assert.equal(game.removePlayer(1), true);
  assert.equal(decodeSnapshot(game).payload.players.length, 0);
} finally {
  game.free();
}

console.log("Wasm contract: ok");
