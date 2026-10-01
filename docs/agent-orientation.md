# Forge agent orientation

Read the epic and assigned child before editing.
UI target: [comet-ui-contract.md](comet-ui-contract.md). Keep Forge branding and the upstream MIT notice.

## Repository map

- `apps/server/src/harnesses`: provider adapters and native contracts.
- `apps/server/src/sessions`: delivery, lifecycle, recovery, forks, and workspace targets.
- `apps/server/src/accounts`: account homes, login, discovery, usage, and limits.
- `apps/server/src/db` and `apps/server/drizzle`: one synchronous `node:sqlite` handle (`src/index.ts`) and plain SQL migrations. `db/client.ts` and `db/schema.ts` are dead.
- `apps/server/src/{git,workspace,terminals,previews}`: Git, descriptor-backed files, owned terminals, and isolated previews.
- `apps/server/src/epics`: Beads workers, worktrees, completion, and gates.
- `packages/protocol`: shared Zod wire schemas and transcript contracts.
- `apps/web/src/{components,stores,lib}`: UI, state, and replay.
- `e2e` and `scripts/epic-gate.sh`: browser fixtures and the integration gate.
- `ops/forge-update`: systemd timer updater; it defers on `/api/status`. Release tarballs do not ship `ops/` yet.

## Runtime and data rules

Keep provider instance IDs stable and adapter kind explicit.
Scope native bindings to provider, account, and canonical effective cwd.
Never fall back from native to ACP or replace failed resume with a fresh session.
Confine ACP types to `harnesses/acp` and `sessions/acp-*`. Read [providers.md](providers.md) for provider limits.
Request routes use `NativeInteractions`; do not restore the removed universal ACP question manager.

Separate prompt acceptance, provider delivery, turn completion, cancellation, and process exit.
Keep session, provider-history, and terminal cursors separate.

Do not rename shipped migrations. Check the highest migration number before adding one; some numbers repeat on purpose.
A table rebuild drops that table's triggers. Recreate them in the same migration.
Every message append writes `sessions.last_activity_at`.
Preserve legacy history and expose unavailable resume.
Boot recovery (`sessions/recovery.ts`) marks running turns `turn_interrupted`; only `auto_resume = 1` chat rows resume.
Draft promotion needs an idempotency key. Upload bytes stay on HTTP.

Do not auto-grant native requests. Reject stale-generation replies. Runtime death and boot expire pending requests.

## UI rules

Use Base UI `render`, not `asChild`. Dialog bodies use `DialogPanel` or `AlertDialogPanel`.
Scope dark CSS to `html[data-theme='dark']`.
Preserve drafts after failed send. Use 44px coarse-pointer targets and 16px phone input text.

## Checks before every commit

From the assigned checkout root:

1. Isolate dependencies before setup:

   ```bash
   node scripts/isolate-gate-dependencies.mjs
   BUN_INSTALL_CACHE_DIR="$PWD/.native-build/bun-cache" bun install --frozen-lockfile --ignore-scripts --backend=copyfile
   node scripts/build-node-pty.mjs
   node scripts/check-node-pty.mjs
   bun run build:cursor-sidecar
   ```

2. Run focused checks and `bun run typecheck`. Use `bunx vitest run <file>` for focused Vitest tests.
3. Format every changed supported file with `bunx prettier --write <changed files>`.
   For ignored docs, pass `--ignore-path /dev/null`.
4. Run `bun run fmt:check`, `bun run lint`, and `git diff --check` before committing.

The coordinator runs `bash scripts/epic-gate.sh` on integrated code.
Read `.agents/skills/test-forge-app/SKILL.md` before browser QA.
Use isolated data and accounts.
Follow the active epic's checkout and commit rules.
Never restart `forge.service` or run `forge-update` on the host that runs the live server.
Release: `bash scripts/release.sh X.Y.Z` from clean `main`. `apps/server/package.json` stays `0.1.0`.
CI runs `bun run check` only. Build and e2e run only in `scripts/epic-gate.sh`. Nothing typechecks `e2e/` specs.
