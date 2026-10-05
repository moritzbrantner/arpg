import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const current = resolve(process.argv[2] ?? "web/src/wasm/arpg_web_wasm.js");
const reference = process.argv[3] && resolve(process.argv[3]);
async function load(path) {
  const module = await import(pathToFileURL(path).href);
  await module.default({ module_or_path: await readFile(join(dirname(path), "arpg_web_wasm_bg.wasm")) });
  return module;
}
const candidate = await load(current);
const baseline = reference && await load(reference);
const cases = ["quiet", "party", "sparse", "wall", "corner", "actions", "lifecycle"];
// Each module speaks its own protocol version, so an older reference build stays comparable.
function protocolVersionOf(game) {
  return JSON.parse(game.snapshotJson()).protocolVersion;
}
function command(game, sequence, payload) {
  game.applyCommand(1, sequence, JSON.stringify({ protocolVersion: protocolVersionOf(game), payload }));
}
function replay(module, seed, scenario) {
  const game = new module.WasmGame(seed);
  const players = ["party", "sparse", "lifecycle"].includes(scenario) ? 4 : 1;
  for (let id = 1; id <= players; id += 1) game.addPlayer(id);
  const initial = game.snapshotJson();
  assert.throws(() => game.addPlayer(0));
  assert.throws(() => game.addPlayer(1));
  if (players === 4) assert.throws(() => game.addPlayer(5));
  assert.equal(game.snapshotJson(), initial);
  const trace = [];
  let sequence = 0;
  let advanceMs = 0;
  let snapshotMs = 0;
  let commandMs = 0;
  for (let tick = 0; tick < 320; tick += 1) {
    let payload;
    if (scenario === "wall" && tick === 0) payload = { type: "setMovement", x: -1, z: 0 };
    if (scenario === "corner" && tick === 0) payload = { type: "setMovement", x: -1, z: -1 };
    if (["sparse", "lifecycle"].includes(scenario) && tick % 24 === 0) {
      const [x, z] = [[1, 0], [0, 1], [-1, 0], [0, -1]][Math.floor(tick / 24) % 4];
      payload = { type: "setMovement", x, z };
    }
    if (scenario === "actions" && tick % 48 === 0) payload = { type: "primaryAttack" };
    if (scenario === "actions" && tick % 48 === 16) payload = { type: "secondaryAttack" };
    if (scenario === "actions" && tick % 48 === 42) payload = { type: "interact" };
    if (scenario === "lifecycle" && tick === 40) assert.equal(game.removePlayer(4), true);
    if (scenario === "lifecycle" && tick === 70) game.addPlayer(4);
    if (payload) {
      const start = performance.now();
      command(game, ++sequence, payload);
      commandMs += performance.now() - start;
    }
    const start = performance.now();
    game.advanceTick();
    advanceMs += performance.now() - start;
    const snapshotStart = performance.now();
    const encoded = game.snapshotJson();
    snapshotMs += performance.now() - snapshotStart;
    const snapshot = JSON.parse(encoded).payload;
    // Compare gameplay payloads, not version envelopes.
    trace.push(JSON.stringify(snapshot));
    assert.equal(snapshot.tick, tick + 1);
    for (const player of snapshot.players) {
      assert(player.position[0] >= -2945 && player.position[0] <= 2945);
      assert(player.position[2] >= -1745 && player.position[2] <= 1745);
    }
  }
  const unchanged = game.snapshotJson();
  command(game, ++sequence, { type: "setMovement", x: 0, z: 0 });
  const afterCommand = game.snapshotJson();
  assert.throws(() => command(game, sequence, { type: "setMovement", x: 1, z: 0 }));
  assert.equal(game.snapshotJson(), afterCommand);
  assert.equal(JSON.parse(unchanged).payload.tick, 320);
  game.free();
  const reset = new module.WasmGame(seed);
  for (let id = 1; id <= players; id += 1) reset.addPlayer(id);
  assert.equal(reset.snapshotJson(), initial);
  reset.free();
  return { trace, advanceMs, snapshotMs, commandMs };
}
let compared = 0;
for (const seed of [42, 0xdeadbeef, 0xa4200916]) {
  for (const scenario of cases) {
    const first = replay(candidate, seed, scenario);
    const second = replay(candidate, seed, scenario);
    assert.deepEqual(first.trace, second.trace, `WASM replay ${seed}/${scenario}`);
    if (baseline) {
      const old = replay(baseline, seed, scenario);
      assert.deepEqual(first.trace, old.trace, `old/new WASM gameplay ${seed}/${scenario}`);
      compared += 1;
    }
    console.log(JSON.stringify({ scenario, seed, ticks: 320,
      hash: createHash("sha256").update(first.trace.join("\n")).digest("hex"),
      advanceMs: first.advanceMs, snapshotMs: first.snapshotMs, commandMs: first.commandMs,
    }));
  }
}
console.log(`WASM gameplay: 21 controls replay identically; ${compared} compare to the previous pin; reset, lifecycle and rejected inputs pass.`);
