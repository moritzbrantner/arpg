# arpg

Architecture-first action RPG foundation inspired by the systemic shape of games such as Diablo II, built as an original implementation.

The repository starts from one rule: **gameplay truth lives in one deterministic Rust simulation and platform/network layers consume it rather than reimplement it.**

The initial architecture supports three execution modes over the same game rules:

- local play, where the application runs the simulation directly;
- peer-hosted co-op, where `multiplayer-setup-service` provides rendezvous/signaling and one peer hosts the authoritative simulation;
- dedicated online play, where `game-server` hosts the authoritative simulation.

See `docs/ARCHITECTURE.md` for ownership boundaries and the first implementation slices.
