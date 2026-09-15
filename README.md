# arpg

Architecture-first action RPG foundation inspired by the systemic shape of Diablo II, built as an original implementation.

The MVP is intentionally an **integration proof**: gameplay truth lives in one deterministic Rust simulation and the renderer, browser UI, peer networking, and dedicated-server runtime consume that authority rather than replacing it.

## Playable MVP

The browser slice currently proves:

- WASD top-down movement with diagonal normalization;
- a bounded dungeon with walls and pillars resolved by `physics-engine`;
- an isometric follow camera and simple 3D scene rendered through `3d-lab`;
- nearby primary attacks against deterministic monster state;
- a settings menu with graphics controls and the reusable `input-bindings` keybinding editor;
- local Rust/Wasm play;
- host-authoritative peer co-op using `multiplayer-setup-service` for rendezvous and direct WebRTC data channels for commands/snapshots;
- the same `ArpgGame` exercised through `game-server::MatchRuntime`, with an equivalence test requiring the dedicated-runtime and direct-local paths to produce the same typed snapshot for the same input stream;
- GitHub Pages build/deployment for browser acceptance.

This is deliberately not yet a content-complete ARPG. The slice exists to prove the foundations before inventory, loot, skills, progression, richer AI, assets, persistence, or larger levels are built on top.

## Foundation ownership

| Concern | Authority |
| --- | --- |
| ARPG rules, player intent, monsters, combat state | `arpg-core` |
| Collision and physical movement | `physics-engine` |
| Scene rendering and renderer contract | `3d-lab` |
| Runtime input semantics and rebinding UI | `input-bindings` |
| Game command/snapshot encoding | `arpg-protocol` |
| Peer rendezvous/signaling | `multiplayer-setup-service` |
| Dedicated sessions, ticks, reconnect, replay/recovery | `game-server` |
| Browser composition/HUD/settings | `web` |

Neither renderer nor network transport is a source of gameplay truth.

## Execution modes

- **Local** — the browser runs `arpg-core` through `arpg-web-wasm`.
- **Peer-hosted co-op** — one browser runs that same Rust/Wasm authority; guests submit sequenced commands and consume host snapshots. `multiplayer-setup-service` remains payload-opaque setup infrastructure.
- **Dedicated online** — `arpg-game-server` adapts the same core/protocol into `game-server`. The MVP proves the actual `MatchRuntime` boundary in deterministic tests; a production WebTransport/TLS launcher is a later deployment slice and is not claimed here.

Peer-hosted co-op is a convenience/trust mode, not an anti-cheat boundary. The host can cheat. Dedicated play is the trusted authority model.

## Run locally

Rust validation:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

Browser shell:

```sh
cargo install wasm-pack --locked --version 0.13.1
cd web
bun install
bun run dev
```

The web build downloads the accepted browser sources from `input-bindings` and `multiplayer-setup-service`, verifies their exact Git blob hashes, and then builds the Rust/Wasm package. Generated vendored sources and Wasm output are not committed.

For peer co-op, run or deploy `multiplayer-setup-service` separately and enter its URL in **Settings → Peer co-op**. Local development defaults to `http://127.0.0.1:8787`. GitHub Pages requires an HTTPS/WSS deployment whose `ALLOWED_ORIGINS` includes the ARPG Pages origin.

## Pinned foundations

- `physics-engine`: `43cb991ac2fce267654fc0c8a1b29984c1162428`
- `3d-lab`: `2af3ef54bb515c8f5611d4f7d39d484202a42784`
- `input-bindings`: `b3b7204faa47d3b0af56eebc55cdfd4ced127ddc`
- `multiplayer-setup-service`: `556f1aa2ac889acffd5b2b27163fca10f1901793`
- `game-server`: `81cad7a4d80849d13c37120a411d3a053c46f9a0`

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the authority and trust boundaries.
