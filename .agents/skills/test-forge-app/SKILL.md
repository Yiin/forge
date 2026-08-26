---
name: test-forge-app
description: Launch and test Forge in an isolated browser session.
---

# Test Forge

Run commands from the Forge repository root.

## Start an isolated server

Run:

```sh
bun e2e/scripts/launch-forge.ts
```

Keep the process open. It prints `FORGE_URL` and `FORGE_DATA_DIR`.
Use the printed `FORGE_URL` as the first URL in the controlled browser.
The launcher uses a new directory below the system temporary directory.

## Browser checks

Open the printed URL in the controlled browser. Do not use a system browser.
Use the desktop and phone viewport projects for responsive checks.
Create a project, open a session, and send a prompt from the composer.
The fake ACP agent returns three streamed text chunks.
Reload during the turn and verify the complete reply remains visible.

## Fake agent controls

The e2e helper starts the fake agent for the test server.
Set these environment flags before launching when needed:

- `FORGE_FAKE_HANG=1` keeps a turn open for reconnect tests.
- `FORGE_FAKE_NO_LOAD_SESSION=1` removes load-session capability.

## Inspect SQLite safely

The disposable server stores its state below `FORGE_DATA_DIR`.
For a SQLite database named `forge.db`, run:

```sh
bun e2e/scripts/forge-sqlite.ts query "$FORGE_DATA_DIR/forge.db" 'SELECT name FROM sqlite_master'
```

The helper rejects paths outside the system temporary directory.
It also rejects files not named `forge.db`.
Pass `--allow-real` only for an intentional real database operation.
Before `exec`, the helper copies the database to `forge.db.bak`.
Stop the Forge server before writing database state.

## Teardown

Send SIGINT to the launcher and wait for it to exit.
Check for orphan agents:

```sh
pgrep -af fake-acp-agent || true
```

Kill only orphan fake-agent processes from this test.
Remove only the printed temporary data directory when no evidence is needed.
