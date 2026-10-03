# Application conventions adoption

The application audit used baseline
`3437a053793c7d6b604feb1fa8c57fd6a724a326` and resolved the live shared policy
at `sourceRevision` `46d8793bb3034326561f876dcc67dbaa5aa1e432`.
Resolve the policy again for subsequent work; this record is evidence, not a pin
or a copy of the policy.

The audit covered Rust configuration and task ownership, serialization and
physics borrowing, browser storage and session lifetime, untrusted peer and
snapshot admission, React update ownership, keyboard/touch interaction, modal
focus, foundation acquisition, and repository validation. The snapshot and trust
boundary decisions are recorded in [the browser ADR](adr/0001-browser-snapshot-projection.md).

Regression evidence reproduced malformed configuration fallback, repeated
foundation acquisition, unsafe graphics preferences, stalled dedicated setup,
keyboard combat failure, modal focus failure, and blocked-storage startup failure
before the corresponding fixes. New tests also cover sender spoofing, stale
session events, bounded protocol input, cancellation, verified cache repair, and
120 snapshot updates without rerendering the shell.

The lobby HTTP/signaling deadline defect was fixed in its owning foundation:
[multiplayer-setup-service PR 42](https://github.com/moritzbrantner/multiplayer-setup-service/pull/42).
ARPG consumes that immutable source revision with blob verification.

Completion evidence comprises Rust formatting, Clippy, and workspace tests;
browser formatting, lint, and 42 model/script tests; the production build;
21 compiled-WASM replay controls; and six real Chromium workflows running in
parallel. The ordinary gate is documented in `AGENTS.md` and encoded in CI.

Dependency auditing found no Rust advisories. Vite was upgraded from 7.1.5 to
7.3.5 to remove its reported high/moderate advisories. Its compatible esbuild
0.27 dependency still has the low-severity
[Windows development-server advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).
That finding remains visible; no advisory suppression or dependency override was
added. Re-run audits against the current advisory databases.

The production build still reports its existing JavaScript chunk-size advisory
(approximately 808 kB before compression). It is not suppressed. The snapshot
render-count test establishes update isolation, not GPU or download performance.
Browser evidence covers Chromium; other engines and real dedicated-server
acceptance are outside this change's evidence.
