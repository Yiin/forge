# Forge end-to-end tests

Run `bun e2e` from the repository root. Playwright starts Chromium with desktop and phone projects. The helper creates a temporary data directory and deletes it when each test ends; it never uses the user configuration directory.

Add API or browser specs under `e2e/specs`. Use `launchForge()` in a `beforeEach` or fixture, and call `stop()` in cleanup. The helper returns `baseUrl` and `dataDir` for restart tests.

`launchForge()` starts the normal Node server with an isolated SQLite database, account home, and config file. The config points the `mock` harness at the source-shaped protocol fixture in `apps/server/test/fixtures/acp-mock-agent.ts`.

Pass `fakeAgentEnv` to enable scenarios such as `FORGE_MOCK_ASK_QUESTION`, `FORGE_MOCK_EMIT_TOOL_CALLS`, `FORGE_MOCK_EMIT_SUBAGENT`, and `FORGE_MOCK_OMIT_LOAD_SESSION_CAPABILITY`.

Run the real isolated fixture server with `bun e2e/scripts/launch-forge.ts`.
It sets `FORGE_CONFIG` to the temporary config and leaves `FORGE_E2E` unset.
The launcher uses the production request loader, not the in-memory stub.
Run browser tests with `bun e2e`.
