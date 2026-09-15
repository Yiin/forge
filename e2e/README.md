# Forge end-to-end tests

Run `bun e2e` from the repository root. Playwright starts Chromium with desktop and phone projects. The helper creates a temporary data directory; tests remove owned evidence directories after cleanup. It never uses the user configuration directory.

Add API or browser specs under `e2e/specs`. Use `launchForge()` in a `beforeEach` or fixture, and call `stop()` in cleanup. The helper returns `baseUrl` and `dataDir` for restart tests.

`launchForge()` starts the normal Node server with an isolated SQLite database, account home, and config file. The config points the `mock` harness at the source-shaped protocol fixture in `apps/server/test/fixtures/acp-mock-agent.ts`.

Pass `fakeAgentEnv` for custom ACP controls such as `FORGE_MOCK_EMIT_TOOL_CALLS` and `FORGE_MOCK_OMIT_LOAD_SESSION_CAPABILITY`.
Use `fakeNative: { kind: 'claude', directory }` with an owned `scenario.json` for native questions, images, steering, and resume.
See `specs/native-claude.spec.ts` and `specs/ask-question.spec.ts` for exact native frames.

Run the real isolated fixture server with `bun e2e/scripts/launch-forge.ts`.
It sets `FORGE_CONFIG` to the temporary config and leaves `FORGE_E2E` unset.
The launcher uses the production request loader, not the in-memory stub.
Run browser tests with `bun e2e`.
