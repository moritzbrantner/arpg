# ADR 0003 — First mobile gesture-action mapping

Status: accepted, initial combat slice (2026-10-10). Follow-up to PR #121, within #57
(shared input actions and contexts) and #116 (touch aiming/target assistance).

## Experience contract

Use the owner-selected hybrid: **visible, predictable buttons with tap/hold/release
and directional swipes in combat**; later, **a dedicated contextual gesture
surface for exploration and object interaction**. They are deliberately not one
global gesture recognizer over the world canvas.

The left movement stick retains its own captured pointer. The sword's existing
Attack button owns one *other* touch pointer, and resolves that contact once,
on deliberate release:

| Sword Attack gesture | Existing semantic action | Result |
| --- | --- | --- |
| Tap (travel at most 18 CSS px) | `game.primaryAttack` | Primary/combo/counter intent |
| Swipe up (at least 32 px, 1.3× dominant axis) | `game.secondaryAttack` | Heavy intent |
| Swipe right | `game.cycleTarget` | Core cycles/locks candidate |
| Swipe left | `game.clearTarget` | Core clears current lock |
| Down, diagonal, ambiguous or interrupted contact | none | No implicit attack |

Mobile hides the redundant Heavy button; the keyboard/mouse Heavy control remains
usable. Guard retains its independent hold/release pointer, and Bow retains its
existing draw/release/cancel behavior. Swap and Interact remain explicit buttons.
No long-press distinction is claimed for sword attacks in this slice. Unlike
the prior tap-on-pointerdown behavior, sword taps commit **on release**, so a
swipe cannot accidentally send both light and heavy. Check this timing on a
real device before tuning thresholds.

## Authority and lifecycle

The touch adapter chooses only **existing `game.*` action IDs**. Keyboard and
touch reach the same browser semantic command bridge, then the existing
`game-client-runtime` / protocol / `arpg-core` authority. The adapter never
selects damage, target candidates, skill results or object eligibility.

Only the original pointer may complete the stroke; an unrelated pointer cannot
end it. Cancellation, lost capture, blur, hidden page, disabled button, weapon
change and unmount discard the pending stroke. Missing/swapped contexts do not
cause deferred input to fire. Movement and guard sources are not coupled to it.
Gestures have one completion event; recognized actions are not auto-repeated.

The currently pinned `input-bindings` source
(`b3b7204faa47d3b0af56eebc55cdfd4ced127ddc`) provides keyboard binding
resolution but **does not yet expose** its newer pointer/gesture runtime to this
ARPG consumer. This temporary button-only classifier is not a new reusable
gesture authority. Upgrading the exact pinned foundation and migrating
recognition + gesture rebinding upstream is separate bounded work under #57.
Do not add competing canvas-level gesture listeners here.

## Next contexts

The game currently knows gameplay versus settings/menu; **out of combat is not
inferred from an enemy-count heuristic or React state**. Current Interact
submits the authoritative `interact` command for the core-selected candidate.
Once a coherent interaction context and selection intent exist, expose a
separate noncombat gesture zone with drag/swipe/circle vocabulary using the
shared `input-bindings` runtime. Core must still decide which world object a
gesture refers to and whether it can be used. Precise touch aim / assistance
remains in #116; world canvas taps, camera drags and menus must not become
accidental attacks.

## Acceptance

Chromium browser tests exercise independent movement + swipes, target command
ordering, concurrent guard, cancellation, diagonal rejection and a settings
transition. Pure classifier fixtures distinguish tap, cardinal swipe, ambiguous
drag and return-to-origin drag. Real-device thumb reach and release latency
remain manual UX checks.
