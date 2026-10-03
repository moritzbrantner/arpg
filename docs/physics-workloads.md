# Compatible physics adoption: seeded game controls

ARPG still uses the translational compatibility `World`. The engine pin advances
from `2108a634e304cfc8e04d212949943977d74993ab` to
`65e00816fa4e17c899f45d618dcdc8c40990dc00`, including quiet-world validation reuse
and incremental physical-field commits. This completes the baseline and compatible
adoption slices of [issue 48](https://github.com/moritzbrantner/arpg/issues/48).
Persistent floating-state solver adoption and character collision changes remain.

## Correctness and workloads

The test-only `physics_workloads` module runs the actual `ArpgGame::advance_tick`,
command, encounter, action and snapshot paths. Nine workloads use seeds 42,
3735928559 and 2753562902, with three trials of 120 completed ticks per seed:

- One quiet player and four quiet players.
- One moving player among four players, and held diagonal motion against a corner.
- Crossing a generated door into an encounter, and correcting an initially
  overlapping player against the west wall.
- Attack, stagger, kill and explicit loot pickup in an active encounter.
- A synthetic crowded encounter, relocating the five existing generated monsters
  into one room without changing their AI, attack rules or number.
- Moving players with removal and re-addition of player 4.

All 81 old/new native traces match byte for byte. Each frame includes the complete
snapshot JSON, ordered physical bodies, private player/action/movement state,
sequence counters, monsters, loot, next loot ID, spawn positions and command
outcomes. Each workload also has acceptance assertions; combat must award 50 XP
and 10 gold. Monsters are game-owned state rather than physics bodies: this crowd
control does not establish large-N dynamic-body performance.

Focused work assertions verify zero staged/quantized bodies and physical commits
on validated quiet ticks. A moving player commits one position and preserves the
body map, while staging still visits N bodies. The remaining K-only repair in
[engine issue 190](https://github.com/moritzbrantner/physics-engine/issues/190)
is not complete.

The real compiled WASM bridge passes seven public-input scenarios across the same
three seeds, each for 320 ticks. All 21 snapshot traces match the old pin and a
second new-pin replay. These controls include rejected commands/player admission,
body removal/re-addition and same-seed reconstruction. Browser acceptance exercised
cardinal and diagonal speeds, attack/heavy/interact phases, exact arena corner
stopping, same/changed-seed restart and character selection to adventure entry,
with no page errors. No browser or rendering authority was added to physics.

## Local timing evidence

Measurements below are medians of nine runs per workload on
`x86_64-unknown-linux-gnu`, rustc 1.98.0, release profile, dated 2026-09-30.
Old and new matrices ran serially after builds and browser automation finished.
Timings are advisory and are milliseconds for **120 ticks**, not single-frame
latency. The actual game contains a small number of physical bodies.

| Workload | Old physics | New physics | Old complete | New complete |
| --- | ---: | ---: | ---: | ---: |
| quiet | 0.2241 | 0.0065 | 0.8342 | 0.6170 |
| party quiet | 0.2891 | 0.0073 | 1.0081 | 0.7336 |
| sparse | 0.3404 | 0.3352 | 1.0579 | 1.0601 |
| corner | 0.3283 | 0.2298 | 0.9387 | 0.8517 |
| door | 0.2785 | 0.2679 | 0.9372 | 0.9274 |
| correction | 0.2338 | 0.0076 | 0.8496 | 0.6208 |
| combat | 0.2550 | 0.0091 | 0.9080 | 0.6692 |
| crowded encounter | 0.2896 | 0.0073 | 0.9913 | 0.7326 |
| lifecycle | 0.3327 | 0.3288 | 1.0407 | 1.0545 |

Physics measures the actual `World::step`. The residual tick duration includes
movement submissions, encounters/actions and the small test timing/report-copy
overhead. Command dispatch separately measures input and lifecycle operations.
The adapter measures snapshot construction plus JSON serialization. Complete is
tick + command + adapter; it excludes fixture setup, private-state formatting,
trace construction, rendering and network transport. Sparse and lifecycle complete
costs are approximately flat/slightly slower; this is not a general speedup claim.

[Machine-readable evidence](physics-workloads-2026-09-30.json) records phase medians,
27 unique trace hashes/sizes, source revisions and convention `sourceRevision`
`e6acb5310afaf15c0cba24f87108f5f4ad1bedc3`. The observer borrows physical bodies into
a temporary pointer vector outside timing. `observer_body_pointer_bytes` in raw
measurement output counts those pointers cumulatively; it excludes trace/string
allocations and is not retained engine memory or RSS. No retained-memory improvement
is claimed. Test instrumentation is compiled out of production Rust/WASM builds.

## Reproduce

Run current-pin replay/acceptance and the opt-in measurement matrix:

```sh
cargo test --locked -p arpg-core physics_
ARPG_PHYSICS_TRACE_DIR=/tmp/arpg-current-traces cargo test --release --locked \
  -p arpg-core physics_workloads::seeded_physics_workload_matrix -- --ignored --nocapture
cd web
bun install --frozen-lockfile
bun run setup
bun run build
bun run test:physics-wasm
```

For an old-pin comparison, create a disposable worktree at ARPG
`66400c2bbf6080de3ce3f78a670050703d38d15c`. Copy the current `arpg-core/src/lib.rs`,
`physics_workloads.rs` and core `Cargo.toml` into that worktree. Remove only the
`#[cfg(test)] mod physics_work;` declaration: its new work counters are unavailable
on the old engine. Keep the worktree's original workspace dependencies and existing
lock versions; allow Cargo to add the already locked `serde_json` to the core test
dependency list once, then use `--locked`. Apart from identical test timing hooks,
the game implementation is unchanged relative to that control revision.

Run the same ignored native matrix there with `ARPG_PHYSICS_TRACE_DIR` pointing to
an old-trace directory. Run the current matrix with
`ARPG_PHYSICS_REFERENCE_DIR` set to that directory; the Rust test directly compares
every complete trace. Build each worktree's real WASM package and compare with:

```sh
node scripts/test-physics-wasm.mjs web/src/wasm/arpg_web_wasm.js \
  /absolute/path/to/old/worktree/web/src/wasm/arpg_web_wasm.js
```

Ordinary CI runs native replay/work assertions and the compiled WASM controls in
the existing validation jobs. Paired release timings are deliberately opt-in.
