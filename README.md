# arpg

Architecture-first action RPG foundation inspired by the systemic shape of games such as Diablo II, built as an original implementation.

The central rule is: **gameplay truth lives in one deterministic Rust simulation and platform/network layers consume it rather than reimplement it.**

## Execution modes

The same game rules are designed to run in three modes:

- **Local** — the application runs `arpg-core` directly.
- **Peer-hosted co-op** — `multiplayer-setup-service` performs rendezvous/signaling; one browser hosts the authoritative Rust/Wasm simulation.
- **Dedicated online** — `game-server` hosts the authoritative simulation with server-owned ticks, sessions, snapshots, reconnect, replay, and recovery.

Peer-hosted co-op is intentionally a convenience/trust mode and makes no anti-cheat claim. Dedicated play is the trusted multiplayer authority path.

## Workspace

- `crates/arpg-core` — transport- and renderer-independent authority boundary for game rules/state.
- `crates/arpg-protocol` — game command/snapshot encoding shared by every network topology.
- `crates/arpg-game-server` — narrow adapter to the reusable `game-server` runtime.
- `web/multiplayer` — browser peer-host integration boundary for `multiplayer-setup-service`.
- `docs/ARCHITECTURE.md` — authority, dependency, trust, and multiplayer contracts.

The first `game-server` integration is pinned to `81cad7a4d80849d13c37120a411d3a053c46f9a0`. The accepted initial `multiplayer-setup-service` browser foundation is `556f1aa2ac889acffd5b2b27163fca10f1901793`.

## Validation

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```
