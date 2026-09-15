# Peer-hosted multiplayer boundary

ARPG peer-hosted co-op consumes `moritzbrantner/multiplayer-setup-service`; it does not implement a second rendezvous/signaling protocol.

Accepted upstream revision: `556f1aa2ac889acffd5b2b27163fca10f1901793`.

The browser build fetches the exact accepted `ResilientLobbySession` source into generated `web/src/vendor/multiplayer-setup-service/` and verifies its Git blob hash before Vite can build. Generated vendor files are ignored rather than becoming an ARPG-owned fork.

The browser constructs `ResilientLobbySession` with `topology: "host"`:

- player 1 is the host browser;
- ready peers receive deterministic ARPG player slots 2–4;
- guests send sequenced ARPG commands over the reliable WebRTC channel;
- the host applies those commands to the same Rust/Wasm `ArpgGame` used for local play;
- the host publishes authoritative snapshots over the realtime WebRTC channel;
- guests never submit state replacement.

The setup service carries lobby membership and SDP/ICE/TURN setup traffic only. Gameplay command/snapshot payloads stay peer-to-peer after setup.

Required invariants:

- participant capabilities remain private to the participant that received them;
- invite links carry only the public lobby/display identifier;
- the setup-service endpoint is configured separately and is not a participant capability;
- TURN credentials are short-lived and never committed or put into invite URLs;
- guest gameplay messages are commands, never trusted state replacement;
- host changes are not silently supported: until explicit host-migration recovery exists, losing the peer host ends or pauses the gameplay session;
- peer-hosted play makes no anti-cheat claim;
- optional peer asset transfer must verify bytes against an ARPG-trusted manifest before use.

For local development the ARPG settings default to `http://127.0.0.1:8787`. GitHub Pages requires a separately deployed HTTPS/WSS setup service with the ARPG Pages origin in `ALLOWED_ORIGINS`.

Do not use `multiplayer-setup-service` as a dedicated-server directory, account service, match history store, ranking service, or gameplay relay.
