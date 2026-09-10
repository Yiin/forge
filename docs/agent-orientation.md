# Forge agent orientation

Read the child and epic before edits. The epic defines migration contracts.
Comet reference: `/var/tmp/forge-comet-reference`, commit `a1adfde23448a0e04256931d64a7c72a95b11db7`.

## Paths

- BEADS + CODE: the current Forge checkout. Run `bd` here. Edit only your assigned checkout.
- `apps/server/src/index.ts`: server wiring and adapter factory.
- `apps/server/src/sessions`: prompts, lifecycle, recovery, forks, and workspaces.
- `apps/server/src/accounts`: account homes, login, discovery, usage, and limits.
- `apps/server/src/db` + `apps/server/drizzle`: SQLite queries and numbered SQL migrations.
- `apps/server/src/epics`: Beads workers, provider fallback, worktrees, gates, and effects checks.
- `packages/protocol`: Zod wire schemas shared by server and web. `packages/forge-client` vendors the status schema.
- `apps/web/src/stores` + `apps/web/src/lib/socket.ts`: client state and replay.
- `apps/web/src/components/ui`: shadcn/ui controls built on Base UI. Import these controls.
- `apps/web/src/app.css`: Tailwind tokens. `styles.css` holds base rules. Dark defaults through `html[data-theme]`.
- `e2e`: browser tests. `.agents/skills/test-forge-app/SKILL.md` defines isolated live QA.

## Commands from the checkout root

- Install: `bun install --frozen-lockfile`
- Typecheck: `bun run typecheck`
- Focused tests: `bunx vitest run <file>`
- Lint: `bun run lint`
- Full integration gate: `bash scripts/epic-gate.sh`
- Browser tests: `bun run e2e`
- Status-client build: `bun run --filter forge-client build`

Bun owns packages and builds. Production runs Node with `node:sqlite` and Hono. Preserve this runtime.
Component tests require `// @vitest-environment jsdom` on line 1.

## Current runtime facts

- Config path: `FORGE_CONFIG`, otherwise `~/.forge/forge.toml`. Startup currently reconciles missing default harnesses.
- Data path: `FORGE_DATA_DIR`, otherwise `data`. SQLite path: `FORGE_DB`, otherwise `<dataDir>/forge.db`.
- Account root: `FORGE_ACCOUNTS_DIR`, otherwise `~/.forge/accounts`.
- Harness defaults: `claude-code-acp`, `codex-acp`, `kimi`, `gemini`, `opencode`, `grok`, `pi`.

## Migration requirements

- Preserve account IDs/homes, project/session IDs, sequence, messages, attachments, worktrees, forks, and epic history. Map stored harness references explicitly.
- Preserve native session identity across process reap and restart. Never silently replace failed resume with a fresh session.
- Scope native identity to provider, account, and canonical cwd.
- Separate prompt acceptance, turn completion, and process exit. Make epic workers await completion.
- Use one item reducer for REST history and live events. Preserve the global `seq` replay cursor.
- Durable request, queue, usage, and discovery state needs hydration after reconnect.
- Upload bytes stay on HTTP. Draft promotion uses an idempotency key for each promotion attempt.
- SQL migrations sort and ledger by filename. Read the highest number before adding one. Never rename shipped migrations.
- Test pre-ledger upgrades. Never mark unapplied schema changes as applied.
- Update server, web, fixtures, and vendored status schemas together.

## UI and QA

- Keep shadcn/ui and Tailwind. Base UI uses `render`, not `asChild`. Use `DialogPanel` and `AlertDialogPanel`.
- Preserve draft text and attachments after failed send. Opening a draft creates no provider session.
- Keep conversation `path` distinct from Git `branch`.
- Browser fixtures currently select an alternate `FORGE_E2E` server. Replace it with ordinary server wiring during this epic.
- Test native adapters with protocol-speaking fake subprocesses and isolated data/account homes.
- Add runtime assets to the explicit release file list in `.github/workflows/release.yml`.
- Isolate required ACP transport inside provider adapters. Runtime and UI types stay neutral. Preserve PTY and stored user data.
