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
- A chase (added with [issue 110](https://github.com/moritzbrantner/arpg/issues/110),
  after the physics comparison below): the five generated monsters start at the far
  edges of one room and pursue a player who walks a square with pauses. See
  [Enemy navigation work](#enemy-navigation-work).

All 81 old/new native traces of the first nine workloads match byte for byte. Each frame includes the complete
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

## Enemy navigation work

Pursuit (#65) rasterizes a room into 20-unit cells and plans with A* to a cell within
strike reach of the target. Its first version rebuilt the room grid and planned anew
for every pursuing monster on every tick. Since #110 the plans are retained:

- **Room grids** are kept while the fixed bodies are unchanged. Every tick that someone
  pursues, the fixed-body footprints are compared with the ones the grids came from. A
  door that locks or unlocks, or a fixed body added or removed, drops all grids and
  fields.
- **Target fields** are kept per room and *target cell* while a pursuer still chases that
  cell. A field holds exact distances to its *strict goals*: free cells whose centre is
  within reach of every point of the target's cell, with a clear line to all of it. A
  separating-axis test of the line fan against each fixed footprint, grown by one unit,
  checks the lines.
- **Routes** are the *canonical descent* of a field. From each cell, the route takes the
  first move in the fixed neighbour order that is exactly one step nearer to a strict
  goal. A search is a multi-source A* from the goals toward the body's cell. It closes
  every cell on any shortest route, so the route from any later cell on that route is its
  suffix, and a body walking its route never searches again.
- **Repaths** happen only when the target enters another cell, the fixed bodies change,
  or a body is pushed off every route its field knows. A per-tick exact plan, the #65
  planner, is used in three cases. A body already on a strict goal finishes its approach
  with it, which costs no expansion and one physics query. It is also used when no strict
  goal is reachable, and when the retained route cannot be shown to cost at most
  `ROUTE_SLACK` (two straight steps) more than the exact plan. The bound comes from
  distances to the *loose goals*: every free cell within reach of some point of the
  target's cell. They include every exact goal, so their distance bounds the exact plan's
  cost from below. When the octile cost to the nearest loose goal already proves the
  bound, nothing is searched.

### Determinism

A route is a pure function of the fixed bodies, the target's cell and the body's cell.
It does not depend on what the cache holds. The cache only decides how much has to be
searched, so it is never saved. After a load it starts empty and gives the same routes.
The fallback decisions are pure functions of the same inputs, so the
pursue-or-stand decision is exactly the per-tick planner's: a strict goal is an exact
goal for every target position in its cell, and an unreachable loose goal set means the
exact planner has no route either. A retained route reaches an exact goal for the
current target position and costs at most `ROUTE_SLACK` more than the exact plan.

The checks are:

- `navigation::tests::retained_routes_match_fresh_fields_and_the_per_tick_reference`
  covers 120 random rooms with 3 to 8 obstacles and 40 steps each. Bodies walk their
  routes or are knocked off them, and targets walk across cells. Each retained route
  equals the route from a freshly built field. Reachability agrees with the exact
  planner. Every retained route ends at an exact goal and exceeds the exact cost by at
  most 20, which is reached. Retained work there is 205,578 expansions, including exact
  plans, against 295,502 for planning every step.
- `retained_navigation_never_changes_the_game` covers 16 random strike-arena chases with
  pillars, up to three pursuers, a walking target, and a pillar that appears and later
  vanishes. Each one gives identical snapshots on every tick with the cache kept and
  with it dropped every tick.
- `retained_and_per_tick_pursuers_set_out_alike`: in 60 random chases, each pursuer
  moves on its first pursuit tick exactly when the per-tick reference moves it.
- `strict_goal_cells_have_a_clear_physics_strike_line_to_their_whole_target_cell` checks
  the line test against the physics ray.
- `a_chase_continues_identically_after_a_save_that_drops_the_navigation_cache` runs 95
  ticks after a save taken mid-chase while fields are held. Every snapshot equals the
  uninterrupted run's.

### Engagement and separation (#109)

The engagement policy decides *whom* a monster chases and whether it chases at all, and
separation bends the velocity toward the next route point. Neither touches the cache:
the target position a field is built for is still a player's position, and separation is
a pure function of the bodies' positions before the step. So the determinism argument
above holds unchanged, and `retained_navigation_never_changes_the_game` runs the chases
with engagement and separation on. A body that separation pushes off its route is a body
pushed off its route: the field repaths it like any other. A returning monster plans
with the exact planner every tick (no line test, goal within one cell of its post);
returning is rare and short, so it is not retained.

### Enemy roles (#108)

A ranged monster that a player comes too close to backs off with an exact plan every
tick: a single-source A* into its band (one cell beyond its retreat range out to one
cell inside reach, with the physics strike line), expanding only cells no nearer to the
target than its own. Like returning it is short-lived and never retained, so the cache
and its determinism argument are unchanged; the room grid it reads is the same pure
function of the fixed bodies. These plans count as `retreat_plans`, not repaths, and their
line tests count as physics queries. `retained_navigation_never_changes_the_game` and
`retained_and_per_tick_pursuers_set_out_alike` now mix brutes, archers and bruisers in their
random chases. The heavy role only changes content values (slower pursuit, a longer
wind-up), so it plans exactly like any pursuer.

### Counts

`physics_workloads::chase_navigation_work_against_the_per_tick_reference` replays the
chase workload for 120 ticks per seed. The five generated monsters engage on the first
tick (#109) and chase from the second. The counts are deterministic. A repath is a field
search or an exact plan. The counts were measured again after #108, which makes two of
the five generated monsters an archer and a bruiser: the archer holds its band and shoots
instead of closing in, and the slow bruiser winds up for longer, so there are 506 to 534
pursuit ticks per seed instead of 595. No retreat happened in this chase.

| Seed | Planner | Expansions | Peak expansions in one tick | Repaths | Physics queries | Grid builds |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 42 | per tick (#65) | 82,977 | 1,037 | 534 | 534 | 119 |
| 42 | retained | 11,455 | 724 | 101 | 0 | 1 |
| 3735928559 | per tick (#65) | 55,584 | 783 | 510 | 510 | 119 |
| 3735928559 | retained | 7,878 | 575 | 98 | 0 | 1 |
| 2753562902 | per tick (#65) | 85,407 | 1,059 | 534 | 534 | 119 |
| 2753562902 | retained | 12,852 | 752 | 110 | 0 | 1 |

The retained planner needs about a seventh of the expansions and a fifth of the repaths.
It made no physics query in this chase, because no pursuer reached a strict goal and
every route was within the bound. It rasterizes the room once instead of on every tick. The peak tick is not much lower. When the target enters a
new cell, all five pursuers search on that tick, and closing every shortest route costs
more than one A* path. The test asserts that expansions and physics queries are at most
half of the reference's. It also asserts that repaths are fewer than half of the pursuit
ticks, and that the retained trace equals the trace with the cache dropped every tick.
The two planners give different traces, because their shortest routes may break ties
differently.

The same test prints advisory whole-tick timings. The table shows medians of three
release runs on `x86_64-unknown-linux-gnu` with rustc 1.98.1, dated 2026-10-07 (after
#108), in milliseconds for 120 ticks. *Without cache* is the retained planner with its
cache dropped every tick. The chase's monsters changed with #108 (an archer and its shots,
a bruiser), so these whole-tick timings are not comparable with the #109 measurement
(retained 6.02, 5.22 and 5.90 ms).

| Seed | Per tick (#65) | Without cache | Retained |
| --- | ---: | ---: | ---: |
| 42 | 61.54 | 35.02 | 8.43 |
| 3735928559 | 43.56 | 27.42 | 5.67 |
| 2753562902 | 67.30 | 39.33 | 7.90 |

Both uncached planners rasterize the room on every tick. The test does not separate
that cost from the searches.

## Reproduce

Run current-pin replay/acceptance and the opt-in measurement matrix:

```sh
cargo test --locked -p arpg-core physics_
cargo test --locked -p arpg-core chase_navigation -- --nocapture
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
