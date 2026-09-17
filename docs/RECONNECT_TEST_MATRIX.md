# Dedicated reconnect regression matrix

This document intentionally does not define protocol semantics. It records the browser regression coverage expected for the existing `game-server` reconnect contract.

- reconnect URL derives from the latest server-issued token
- retry remains bounded by the server-issued grace window
- player identity remains stable across resume
- connection epoch strictly advances
- command sequence numbers remain continuous across an outage
- commands produced during a brief outage flush after resume
- stale callbacks from superseded transports cannot trigger another reconnect
- the outage command buffer is bounded
- reconnect fails closed after grace expiry
