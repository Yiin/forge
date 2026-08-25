# Forge end-to-end tests

Run `bun e2e` from the repository root. Playwright starts Chromium with desktop and phone projects. The helper creates a temporary data directory and deletes it when each test ends; it never uses the user configuration directory.

Add API or browser specs under `e2e/specs`. Use `launchForge()` in a `beforeEach` or fixture, and call `stop()` in cleanup. The helper returns `baseUrl` and `dataDir` for restart tests.
