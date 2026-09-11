# Native Pi adapter

Forge implements the Pi 0.84.0 JSONL RPC contract independently.
The wire definitions follow `@earendil-works/pi-coding-agent` and its `pi-ai` package.
The source captures identify the exact files, package version, and SHA-256 hashes.
Pi is maintained at https://github.com/earendil-works/pi.
The upstream MIT notice is in `PI-LICENSE`.
The notice comes from the repository's `v0.84.0` tag.
`fixtures/responses-0.84.0.json` preserves four responses from the supplied no-model probe capture.
The source capture was `/var/tmp/forge-comet-pi-reference/responses.json`.
The fixture omits the unsupported `switch_session` request and its no-session starting state.

Comet a1adfde23448a0e04256931d64a7c72a95b11db7 used `pi-acp`.
Comet did not provide this native Pi adapter.

The synthetic process fixture contains no provider or authentication implementation.
Its checks prove Forge behavior against captured protocol shapes.
They do not prove live provider authentication or continuity of real native history.
