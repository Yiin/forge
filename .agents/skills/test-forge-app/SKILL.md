---
name: test-forge-app
description: Launch and test Forge in an isolated browser session.
---

# Test Forge

Run commands from the Forge repository root.

## Start an isolated real server

Run the supported real-server launcher:

```sh
bun e2e/scripts/launch-forge.ts
```

Keep the process open. It prints `FORGE_URL` and `FORGE_DATA_DIR`.
Use the printed `FORGE_URL` as the first URL in the controlled browser.
The launcher uses a new directory below the system temporary directory.
The values are on one line for easy capture.
It starts the normal Node server through the production request loader.
It sets `FORGE_CONFIG` to the isolated config file.
It does not set `FORGE_E2E`, so the in-memory stub is not used.
Native fixtures seed an isolated selected account. Explicit custom ACP fixtures use the native-default scope.

Specs that call `launchForge()` use the same real-server path.
Do not use `FORGE_E2E=1` for browser QA.

## Browser checks

Open the printed URL in the controlled browser. Do not use a system browser.
Use the desktop and phone viewport projects for responsive checks.
Create a project, open a session, and send a prompt from the composer.
The fake ACP agent returns three streamed text chunks.
Reload during the turn and verify the complete reply remains visible.

## Production fixture scenarios

`launchForge()` defaults to the source-shaped custom ACP peer in `apps/server/test/fixtures/acp-mock-agent.ts`.
Pass fixture controls through `fakeAgentEnv`; ambient server environment flags do not configure the peer.
For example:

```ts
await launchForge({
  fakeAgentEnv: {
    FORGE_MOCK_HANG_PROMPT: '1',
    FORGE_MOCK_REQUEST_LOG_PATH: '/tmp/owned-fixture/requests.jsonl',
  },
})
```

The fixture also supports `FORGE_MOCK_PROMPT_DELAY_MS`, `FORGE_MOCK_EMIT_TOOL_CALLS`, and `FORGE_MOCK_OMIT_LOAD_SESSION_CAPABILITY`.
Custom ACP approvals remain permissions. Tool-name guessing does not convert them into native questions or child sessions.

For native questions, images, steering, and resume, use:

```ts
await launchForge({ fakeNative: { kind: 'claude', directory: peerDirectory } })
```

Create `scenario.json` inside the owned peer directory before launch.
Use the source-shaped frames in `e2e/specs/native-claude.spec.ts` and `ask-question.spec.ts`.
The peer records original stdin frames for exact request and binding assertions.
The specs cover typed answers, queued requests, phone layout, reload, tool output, images, and postrestart prompts.
These peers do not call live providers. Their success does not prove live authentication or model availability.

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

Send SIGINT to the launcher and wait for its original child to close.
Programmatic specs must await `stopProxiedForge(page, forge)` in `finally`.
This joins in-flight proxy work and the original server cleanup.
Do not signal a process based only on its name or a reused PID.
Remove only the owned temporary directory after cleanup succeeds, unless evidence must remain.
