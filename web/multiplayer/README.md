# Peer-hosted multiplayer boundary

ARPG peer-hosted co-op consumes `moritzbrantner/multiplayer-setup-service`; it does not implement a second rendezvous/signaling protocol.

Accepted upstream revision: `556f1aa2ac889acffd5b2b27163fca10f1901793`.

When the browser shell lands, vendor the exact upstream resilient lobby client under `web/vendor/multiplayer-setup-service/` and guard the copied blobs with deterministic pin checks. The ARPG-facing wrapper should construct `LobbySession` with `topology: "host"`.

The host browser runs the authoritative `arpg-core` Wasm simulation. Guests send the same versioned ARPG command payloads that the dedicated-server adapter accepts and receive the same ARPG snapshot payloads. The setup service carries only lobby membership and SDP/ICE/TURN setup traffic.

Required invariants:

- participant capabilities remain private to the participant that received them;
- invite links carry only the public lobby/display identifier;
- TURN credentials are short-lived and never committed or put into invite URLs;
- guest gameplay messages are commands, never trusted state replacement;
- host changes are not silently supported: until explicit host-migration recovery exists, losing the peer host ends or pauses the gameplay session;
- peer-hosted play makes no anti-cheat claim;
- optional peer asset transfer must verify bytes against an ARPG-trusted manifest before use.

Do not use `multiplayer-setup-service` as a dedicated-server directory, account service, match history store, ranking service, or gameplay relay.
