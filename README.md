# arpg

Architecture-first action RPG foundation inspired by the systemic shape of Diablo II, built as an original implementation.

The MVP is intentionally an **integration proof**: gameplay truth lives in one deterministic Rust simulation and the renderer, browser UI, peer networking, and dedicated-server runtime consume that authority rather than replacing it.

## Playable MVP

The browser slice currently proves:

- WASD top-down movement with diagonal normalization;
- a procedurally partitioned, seeded dungeon whose walls and doorways are resolved by `physics-engine`;
- an isometric follow camera and simple 3D scene rendered through `3d-lab`;
- nearby primary attacks against deterministic monster state;
- deterministic character progression exposed through authoritative snapshots;
- a deterministic combat training arena available through the character screen or `?scenario=training&seed=<u32>`, with pause, single-step, explicit simulation speed, seed restart, and live combat diagnostics;
- a settings menu with graphics controls and the reusable `input-bindings` keybinding editor;
- local Rust/Wasm play;
- versioned Rust-authoritative savestates with browser quick-save/load and portable JSON import/export;
- one fresh 32-bit run seed per new authority, carried in authoritative snapshots so multiplayer and replay evidence identify the exact generated dungeon;
- host-authoritative peer co-op using `multiplayer-setup-service` for rendezvous and direct WebRTC data channels for commands/snapshots;
- dedicated online play over the shared `game-server` WebTransport protocol, with browser-side framing and snapshot-hash verification but no duplicated gameplay rules;
- the same `ArpgGame` exercised through `game-server::MatchRuntime`, with an equivalence test requiring the dedicated-runtime and direct-local paths to produce the same typed snapshot for the same input stream;
- a runnable TLS/WebTransport dedicated server using the shared `game-server` transport, reconnect, recovery, tick, and shutdown machinery;
- GitHub Pages build/deployment for browser acceptance.

This is deliberately not yet a content-complete ARPG. The slice exists to prove the foundations before inventory, loot, skills, richer AI, assets, persistence, or larger levels are built on top.

The next product foundation is the **mechanical game loop**: locomotion, action timing, targeting, hit/reaction semantics, pickup/reward interaction, and the one-way presentation cue boundary. These mechanics are treated as reusable ARPG domain contracts rather than late polish or per-skill/per-monster special cases. See [the roadmap](docs/ROADMAP.md).

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

Savestate semantics also live in `arpg-core`: the browser only persists or transfers the versioned save document and asks Rust to validate and restore it. Neither renderer nor network transport is a source of gameplay truth.

## Execution modes

- **Local** — the browser runs `arpg-core` through `arpg-web-wasm`.
- **Peer-hosted co-op** — one browser runs that same Rust/Wasm authority; guests submit sequenced commands and consume host snapshots. `multiplayer-setup-service` remains payload-opaque setup infrastructure.
- **Dedicated online** — the browser connects directly to the runnable `arpg-game-server` WebTransport endpoint. `game-server` owns admission, ticks, reconnect identity, recovery, and transport framing; the browser submits versioned `arpg-protocol` command payloads and renders verified authoritative snapshots.

Peer-hosted co-op is a convenience/trust mode, not an anti-cheat boundary. The host can cheat. Dedicated play is the trusted authority model.

Every new local or peer-hosted authority receives a fresh browser-generated run seed. Guests do not generate an alternate seed: they receive the host's seed as part of the authoritative snapshot. For deterministic local reproduction, open the browser with `?seed=<u32>`; starting another local game afterward intentionally creates a fresh seed. Dedicated runs receive the server-selected seed through authoritative snapshots.

## Run locally

Rust validation:

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

Browser shell:

```sh
cargo install wasm-pack --locked --version 0.13.1
cd web
bun install --frozen-lockfile
bun run setup
bun run dev
```

Browser validation after setup:

```sh
bun run format:check
bun run lint
bun run test
bun run build
bun run test:physics-wasm
bunx playwright install chromium
bun run test:browser
```

Formatting writes are explicit through `bun run format`. Browser tests start their
own local servers on OS-allocated ports, use the actual WASM game, and retain
failure traces under ignored `web/test-results/`.

`bun run setup` acquires the accepted browser sources from `input-bindings` and `multiplayer-setup-service`, verifies their exact Git blob hashes, and builds the Rust/Wasm package. Verified foundation files are reused without downloads or rewrites. After setup, `bun run build` bundles locally with Vite and `bun run dev` starts Vite without downloading sources. Run `bun run wasm` again after Rust changes. Generated vendored sources and Wasm output are not committed.

For peer co-op, enter `https://moenarch.com` in **Settings → Peer co-op**, or run a separate `multiplayer-setup-service` deployment. Local development defaults to `http://127.0.0.1:8787`. GitHub Pages requires an HTTPS/WSS deployment whose `ALLOWED_ORIGINS` includes the ARPG Pages origin. Hosts and guests fetch short-lived TURN credentials after lobby admission and refresh them in memory before expiry. The upstream client uses TURN during recovery when direct connectivity fails; deployments without TURN still permit direct connections.

Dedicated server:

```sh
ARPG_SERVER_CERT_PEM=cert.pem \
ARPG_SERVER_KEY_PEM=key.pem \
cargo run -p arpg-game-server --bin server
```

The dedicated host defaults to UDP port `4433` and session path `/arpg`. Optional configuration is available through `ARPG_SERVER_PORT`, `ARPG_SERVER_SESSION_PATH`, `ARPG_SERVER_RECOVERY_PATH`, and `ARPG_SERVER_DRAIN_GRACE_MS`. See [`.env.example`](.env.example) for the environment contract; export these variables into the server process because the native server does not load dotenv files. Keep local configuration, certificates, private keys, and recovery data uncommitted. A fresh run seed is generated once when the process starts and logged for replay evidence; set `ARPG_RUN_SEED=<u32>` to reproduce a known run exactly. In a browser with WebTransport support, enter the resulting HTTPS endpoint (for example `https://127.0.0.1:4433/arpg`) under **Settings → Dedicated online**. The certificate must be trusted by the browser.

## Repository development policy

[`AGENTS.md`](AGENTS.md) describes how to resolve the live shared coding-agent conventions, the domain ownership boundaries, and the checks used by this repository. Shared policy remains in the central checkout rather than being copied or pinned here.

## Pinned foundations

- `physics-engine`: `65e00816fa4e17c899f45d618dcdc8c40990dc00`
- `3d-lab`: `f484db8a3d2a7a555fa463eddf9c28790b240ce0`
- `input-bindings`: `b3b7204faa47d3b0af56eebc55cdfd4ced127ddc`
- `multiplayer-setup-service`: `cc5c20fabdac0fc9da4329a5be04d0f4e8eae383`
- `game-server`: `a3851dab9c1fb25dd31b465fb554ca475769caab`

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the authority and trust boundaries.
