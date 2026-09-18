# ARPG Roadmap

This roadmap treats the moment-to-moment action loop as a **foundation**, not a polish pass.

The immediate design target is the deliberate, readable mechanical feel of classic action RPGs such as Diablo II: movement has weight without feeling sluggish, attacks have commitment without stealing control, hits are legible, enemies react consistently, and the reward loop closes quickly. The implementation remains original and is built on the repository's existing deterministic authority boundaries.

## Guiding rule

New content must be able to reuse the game loop instead of redefining it.

A new weapon, skill, monster, boss, dungeon modifier, or multiplayer mode should normally configure or compose existing mechanics. If adding content requires another private movement model, targeting rule, attack lifecycle, hit reaction path, pickup rule, or presentation timing system, the foundation is not finished yet.

The core loop is:

```text
intent
  -> locomotion / target acquisition
  -> action commitment
  -> active attack / skill
  -> authoritative hit resolution
  -> impact / reaction
  -> recovery / repositioning
  -> reward / pickup
  -> next decision
```

Simulation truth remains deterministic in `arpg-core`. Rendering, animation, camera, audio, and other presentation layers consume gameplay events and projected state; they do not become alternate gameplay authorities.

---

## Phase 0 — Mechanical game-loop foundation

This phase comes before broad content expansion.

### 0.1 Locomotion feel

Build one reusable ARPG locomotion model for player-controlled characters.

- responsive acceleration, stopping, and direction changes;
- diagonal and analog-input normalization;
- explicit walk/run or movement-speed semantics rather than presentation-owned speed;
- collision sliding and corner handling through `physics-engine`;
- deterministic movement under local, peer-hosted, dedicated, replay, and test execution;
- movement cancellation rules for attacks and interactions;
- controller, keyboard, and pointer intent projected into the same gameplay commands;
- animation speed and foot presentation derived from authoritative movement rather than driving it.

Acceptance: moving around an empty room should already feel intentional and satisfying before enemies or loot are added.

### 0.2 Action lifecycle

Introduce a domain-shaped action state machine instead of scattered cooldown checks.

Common phases should be expressible without making every action identical:

1. intent accepted;
2. wind-up / commitment;
3. active window;
4. authoritative effect or hit;
5. recovery;
6. cancellation or interruption where the action permits it.

The foundation must support melee, projectiles, movement skills, channeled actions, interactions, and future item use without a generic scripting engine.

Timing is gameplay truth in `arpg-core`. Animation and effects consume phase/cue information.

### 0.3 Targeting and interaction

Create one targeting/interaction boundary shared by attacks, skills, enemies, loot, doors, and future NPC interactions.

It should cover:

- explicit target selection where appropriate;
- direction/ground-position actions;
- range validation;
- target stickiness and loss rules;
- optional target assistance for controller/touch without changing simulation rules;
- interaction priority when several objects overlap;
- deterministic fallback when a selected target becomes invalid.

Do not let React, the renderer, or input adapters invent game-specific targeting semantics.

### 0.4 Hit and impact model

Make a hit mechanically readable before adding many damage formulas.

The authoritative model should distinguish at least:

- attack/effect emitted;
- contact or target resolution;
- damage/mitigation result;
- stagger, knockback, stun, block, or immunity result;
- death;
- secondary proc/status consequences.

Presentation may add local-only effects such as camera shake, particles, sound, and brief visual emphasis, but it must derive them from authoritative combat cues.

Knockback and physical displacement belong at the `arpg-core` + `physics-engine` boundary. Presentation-only hit stop must never pause or rewrite authoritative multiplayer time.

### 0.5 Enemy reaction foundation

Enemies need reusable reaction semantics before richer AI.

Start with:

- approach and spacing;
- attack commitment;
- hurt/stagger response;
- knockback/displacement;
- death;
- brief recovery/re-engagement behavior.

This should make a basic monster enjoyable to fight before introducing many monster types.

### 0.6 Reward loop and pickup feel

The basic combat loop should close with a satisfying reward interaction.

Foundation work:

- authoritative item/drop spawn events;
- deterministic ownership/eligibility rules where needed;
- readable world-drop presentation;
- one reusable pickup interaction;
- immediate pickup confirmation;
- inventory admission/rejection separated from world interaction;
- future controller/touch pickup assistance through the same targeting boundary.

Do not wait for a complete itemization system before making "kill -> drop -> pick up" feel good.

### 0.7 Presentation cue boundary

Define an explicit projection from simulation events/state into presentation cues.

Candidate cues include:

- action phase changed;
- swing/release moment;
- projectile spawned;
- hit landed;
- block/parry;
- stagger/knockback;
- death;
- loot dropped;
- loot picked up;
- skill unavailable/failed with a typed reason.

`3d-lab`, audio, camera, HUD, and effects consume these cues. They may interpolate and decorate them, but may not decide whether gameplay happened.

### 0.8 Combat training arena

Add a small deterministic sandbox focused entirely on feel iteration.

Controls should eventually include:

- spawn/remove enemies;
- enemy archetype and count;
- invulnerable target dummy;
- player movement/attack parameters;
- game speed;
- pause/step simulation;
- collision/debug visualization;
- action-phase visualization;
- target visualization;
- damage/event timeline;
- projectile counts;
- deterministic seed display/reset.

This should be a first-class Pages scenario, not a throwaway developer screen.

### 0.9 Foundation acceptance scenarios

Keep a small corpus of deterministic mechanical scenarios:

- empty-room movement;
- repeated stop/start/reverse movement;
- attack while approaching range;
- target dies during wind-up;
- target leaves range before active window;
- repeated melee hit/recovery;
- projectile release and impact;
- knockback into a wall;
- two enemies competing for target selection;
- kill -> drop -> pickup;
- interrupted action;
- local vs dedicated execution equivalence.

Correctness tests assert state/event semantics. Performance evidence measures deterministic work separately from advisory wall-clock timing.

---

## Phase 1 — Combat vocabulary

Once Phase 0 feels good, expand what the foundation can express.

### Weapon identity

Weapons should change mechanics, reach, rhythm, movement, and interaction rather than merely supplying different numbers.

Examples:

- spear: long reach and space control;
- hammer: slower commitment and stronger stagger/impulse;
- bow: projectile geometry and travel;
- shield: block/parry windows;
- fast one-handed weapons: shorter commitment/recovery and different spacing.

### Skill mutation

Support composable skill modifiers such as:

- piercing;
- bouncing;
- returning;
- orbiting;
- multishot;
- delayed mine;
- area conversion;
- chaining;
- altered projectile shape or trajectory.

Modifiers should transform domain mechanics rather than fork entire skills.

### Status-effect rules

Define explicit stacking/refresh/independent-instance rules, immunity, conversion, cleansing, and interactions.

This becomes the basis for combinations such as burning terrain, freeze/shatter behavior, wet/lightning interactions, and future elemental systems.

### Enemy combat roles

Add behavior-oriented archetypes:

- melee pressure;
- ranged artillery;
- healer/support;
- summoner;
- shield bearer;
- assassin/flanker;
- commander/buffer;
- crowd controller.

The encounter should change based on target priority, not only enemy health totals.

### Behavioral monster affixes

Prefer mechanics over percentage inflation:

- splits on death or hit;
- revives allies;
- absorbs/intercepts projectiles;
- teleports when surrounded;
- creates walls/hazards;
- copies or reacts to player actions;
- protects nearby allies.

### Telegraph system

Create shared data/cues for:

- ground areas;
- directional attacks;
- charge indicators;
- interrupt windows;
- trajectories;
- delayed hazards.

Telegraphs communicate authoritative intent; renderers choose how to draw them.

---

## Phase 2 — Builds, loot, and character expression

### Mechanically meaningful item affixes

Items should alter play, for example:

- returning projectiles;
- knockback converted to damage;
- perfect block resets a cooldown;
- movement leaves damaging terrain;
- status interactions change;
- skill geometry changes.

### Item provenance

Track useful origin/transformation information:

- source encounter/boss;
- dungeon/run seed;
- crafting transformations;
- event/source identifier;
- creator/trader where applicable.

This supports debugging and later multiplayer trading without making provenance itself gameplay authority.

### Crafting transformations

Prefer operations over large recipe lists:

- reroll;
- replace/move an affix;
- extract;
- fracture;
- corrupt with risk;
- sacrifice one item to alter another.

### Build planner

Expose an interactive Pages planner using the same authoritative schemas for skills/items rather than a second handwritten model.

---

## Phase 3 — Encounters and dungeons

### Boss composition

Build bosses from reusable mechanics:

- phases;
- ability sets;
- triggers;
- arena rules;
- adds;
- vulnerability windows;
- movement/spacing policies.

Do not create a separate boss engine.

### Dynamic dungeons

Generate reproducible dungeons from authored pieces with:

- connectivity constraints;
- doors/traversal;
- encounters;
- objectives;
- hazards;
- deterministic seeds.

### Dungeon modifiers

Composable rule modifiers can alter runs without special-case forks:

- darkness;
- exploding corpses;
- scarce healing;
- regenerating enemies;
- unstable terrain;
- altered projectile rules;
- stronger environmental hazards.

### Alternative objectives

Add reusable objective contracts for:

- boss hunt;
- survival;
- defense;
- escort;
- rescue;
- portal destruction;
- control points;
- escape from an advancing hazard.

### Destructible environment

Support bounded, deterministic destruction of meaningful objects such as barrels, barricades, doors, traps, pillars, and cover through the existing physics boundary.

---

## Phase 4 — World systems

### World events

Examples:

- invasions;
- caravans;
- ritual sites;
- roaming bosses;
- sieges;
- temporary corrupted regions;
- rare treasure encounters.

Events should compose existing encounter/objective mechanics.

### Faction simulation

Factions may occupy regions, conflict, and react to player actions while remaining a supporting world system rather than turning the ARPG into a strategy simulation.

---

## Phase 5 — Multiplayer depth

The same combat foundation must work unchanged in local, peer-hosted, and dedicated modes.

Potential additions:

- drop-in/drop-out co-op;
- multiplayer encounter scaling expressed through game rules, not server infrastructure;
- player separation/camera presentation;
- shared/individual loot policies;
- trading using authoritative item identity/provenance;
- reconnect-safe encounter state;
- deterministic replay/divergence tooling.

`game-server` remains runtime/session authority. `multiplayer-setup-service` remains rendezvous/signaling authority.

---

## Phase 6 — Authoring and mod-friendly content

### Declarative game data

Use MOEL for schema-validated content where it fits:

- skills;
- items;
- enemies;
- encounters;
- dungeon pieces;
- modifiers.

Executable hot-path simulation behavior remains code unless a real need justifies something more dynamic.

### Editors

Grow shared authoring surfaces only after the corresponding runtime model is stable:

- encounter editor;
- dungeon editor;
- loot/item editor;
- skill editor.

Prefer reusable editor foundations rather than separate bespoke React applications.

---

## Cross-cutting foundations

These run through every phase.

### Input

Use `input-bindings` for keyboard/controller binding semantics and context switching. Combat, inventory, map, dialogue, and debug modes should not each invent binding infrastructure.

### Rendering and assets

Use `3d-lab` for renderer primitives and asset models. ARPG owns scene composition and presentation policy. Use `asset-tooling` for reproducible asset generation/acquisition/processing.

### Physics

Use `physics-engine` for physical truth. ARPG owns the semantic request: movement intent, projectile intent, knockback intent, collision layers, and gameplay consequences.

### Replay and debugging

Preserve ordered gameplay inputs plus deterministic seed/version evidence so mechanical regressions can be reproduced. Add combat replay after the Phase 0 event/action boundaries are stable.

### Performance

Keep deterministic scenario benchmarks for representative workloads:

- dense melee;
- projectile swarm;
- large knockback chain;
- four-player combat;
- boss + adds;
- status/proc-heavy encounter.

Correctness remains separate from performance evidence, and brittle wall-clock thresholds should not become gameplay gates.

### Controller-first usability

The mechanical foundation must remain fully usable without a mouse. Target selection, radial/skill UI, inventory navigation, pickup, and interaction should all have explicit controller semantics.

### Camera

Camera behavior may react to encounter scale, indoor/outdoor constraints, boss framing, and multiplayer player separation, but it remains presentation policy and never simulation authority.

---

## Immediate implementation order

The next implementation work should stay deliberately narrow:

1. formalize the action lifecycle and combat/presentation event vocabulary;
2. improve locomotion until the empty-room movement scenario feels good;
3. rebuild the primary attack on the action lifecycle instead of simple proximity/cooldown behavior;
4. add explicit hit/stagger/knockback/death reactions;
5. unify combat and pickup targeting/interaction rules;
6. add the kill -> drop -> pickup loop;
7. add the deterministic combat training arena and debug timeline;
8. iterate on feel using those scenarios before expanding skills, loot tables, or enemy variety.

The purpose of this order is to make every later content slice cheaper: content should mostly provide data, policies, assets, and combinations while the mechanical loop stays coherent.
