# Authoring gameplay content

Gameplay tuning lives in one typed, versioned bundle:
[`crates/arpg-core/content/base.json`](../crates/arpg-core/content/base.json), parsed and
validated by [`content.rs`](../crates/arpg-core/src/content.rs). Definitions *select*
supported behaviour; executable rules stay in Rust. Appearance and audio never live here.

## What the bundle holds (format 5)

| Section | Contents |
| --- | --- |
| `strikes` | Melee geometry: reach, frontal cone, target cap, blockable, guard cost. |
| `actions` | One definition per supported `ActionKind`: phase ticks, strike, damage ratio, stagger. |
| `combos` | Light/heavy transitions between striking actions and their input windows. |
| `counterWindowTicks` | How long a successful block keeps the counter open. |
| `monsters` | Enemy definitions: health, strike, phase ticks, damage, experience, pursuit speed, aggro/leash/switch/reacquire/separation. |
| `roomMonsters` | The monster definition of each combat room, in generation order (repeats when rooms outnumber entries). |
| `guard` | Raise ticks, guard points and regeneration, block reaction, guard-break ticks. |
| `bow` | Draw thresholds, arrow speed/damage range, lifetime, stagger and live-arrow cap. |
| `progression` | Experience per level and the base/per-level health and attack damage. |
| `loot` | Gold dropped by a defeated monster and held by a reward chest. |
| `targeting` | Target-lock acquisition range and the larger break range that keeps a held lock (stickiness). |

Ids are 1–64 ASCII characters, unique per collection and published to clients (strike
events, `MonsterSnapshot.definition`), so presentation can key appearance and audio by them.

## Adding a definition

Example: a new enemy.

1. Add its strike to `strikes` (monster strikes must reach at least 105 units so pursuit can
   close to striking distance) and its entry to `monsters`.
2. Put its id into `roomMonsters` where it should spawn. Nothing else changes: transport,
   renderer and physics consume it through the generic monster path.
3. Keep source order irrelevant: `strikes`, `actions`, `combos` and `monsters` are sorted by
   id on load; only `roomMonsters` is authored order.

A new *kind* of behaviour (a new `ActionKind`, a ranged monster attack) is a Rust change
first; content can then select it.

## Validating

Loading validates every reference and numeric bound and reports **all** violations with the
definition path, for example `monsters[1] monster.skirmisher: leashRange must exceed
aggroRange`. The built-in bundle is validated on first use, and the tests fail on any
violation:

```sh
cargo test -p arpg-core content
```

When a change touches a section whose previous values were Rust constants,
`base_content_reproduces_the_previous_tuning` pins the outcomes; update it only for a
deliberate tuning change.

## Exercising it deterministically

Gameplay is a pure function of seed, content and commands, so a definition is exercised by
a headless test on the real runtime. The second-enemy tests in
[`lib.rs`](../crates/arpg-core/src/lib.rs) (`a_skirmisher_*`,
`combat_rooms_spawn_the_monster_their_content_assigns`,
`a_save_mid_skirmisher_attack_continues_like_the_uninterrupted_game`) show the pattern:
place the player and the generated monster, advance ticks, and assert timings, reach,
damage and rewards from the definition rather than from literals. For a recorded session,
replay a `Reproduction` (scenario, seed, players, commands) with `replay_reproduction`; the
browser training arena (`?scenario=training&seed=<u32>`) runs the same authority.

## Packaging and compatibility

The bundle is compiled into `arpg-core` (`include_str!`), so the Wasm build and the dedicated
server always ship the bundle they were built with. Its **content revision** is an FNV-1a
hash of the canonical bundle:

- snapshots publish it as `contentRevision`, and saves record it; a save from another
  revision is refused on load;
- a peer guest compares the host's revision, and a dedicated client the server's, with its
  own build and refuses to play across revisions with a message naming both;
- `formatVersion` (`CONTENT_FORMAT_VERSION`) changes only when the bundle's *shape* changes.
  It is independent of the save schema and the wire protocol versions, which change only
  when their own encodings do.
