# Browser snapshot projection and update ownership

Status: Accepted, 2026-10-01.

The browser previously stored every simulation snapshot in the root React
component, rerendering menus and settings at simulation cadence. Peer messages
also crossed into that component without sender and presentation-shape checks.

Each mounted app now owns one snapshot store containing the latest parsed
presentation snapshot. HUD, combat state, and training diagnostics subscribe to
that store. The renderer subscribes directly; shell configuration, character
selection, and settings controls update at their own cadence. The store never
decides gameplay or writes presentation state back to the Rust authority.

The browser protocol adapter validates the bounded envelope and the fields
presentation actually consumes. It does not reproduce movement, collision,
combat, progression, or loot rules. A real-WASM browser test verifies that current
Rust snapshots pass through this projection without change. Protocol or
presentation-field changes must update this adapter and that evidence together.

The peer adapter owns ARPG player admission and applies a current-session guard.
Guests accept authority packets only from the foundation's current host identity;
hosts map commands to their own participant-to-player assignment. Detaching a
session removes listeners. Signaling and WebRTC recovery remain upstream-owned.
Dedicated framing and hash validation remain in the dedicated transport adapter.

Settings use the native modal dialog for focus containment and background
inertness, with explicit restoration to the settings trigger. This avoids a
second application-owned focus-trap implementation.

Verification includes keyboard and touch combat, modal focus, blocked storage,
peer sender/session rejection, and a deterministic 120-snapshot browser check in
which the subscribing view updates while the shell renders once. That check
measures React update ownership, not GPU cost or wall-clock performance.

Observed shared policy `sourceRevision`:
`46d8793bb3034326561f876dcc67dbaa5aa1e432`.
