# Forge agent orientation

Read the epic and assigned child before editing. The epic is the migration
authority. The pinned Comet source is `/var/tmp/forge-comet-reference` at
`a1adfde23448a0e04256931d64a7c72a95b11db7`. The normative UI contract is
[`comet-ui-contract.md`](comet-ui-contract.md).

## Repository map

- `apps/server/src/harnesses`: provider adapters and neutral runtime contract.
- `apps/server/src/sessions`: prompts, lifecycle, recovery, forks, workspaces.
- `apps/server/src/accounts`: account homes, login, discovery, usage, limits.
- `apps/server/src/db` and `apps/server/drizzle`: SQLite and migrations.
- `apps/server/src/git`: git/diff services (exists). `apps/server/src/
  {workspace,terminals,previews}` are target locations for workspace,
  terminal (currently `pty`), and preview services; they do not exist yet.
- `apps/server/src/epics`: Beads workers, effects, worktrees, gates.
- `packages/protocol`: shared Zod wire schemas.
- `apps/web/src/{components,stores,lib}`: UI, state, and replay.
- `e2e` and `scripts/epic-gate.sh`: isolated browser fixtures and gate.

## Rules

Keep provider instance IDs stable. Add an explicit adapter kind. Scope native
identity to provider, account, and canonical cwd. Never fall back from native
to ACP or replace failed resume with a new session. Keep ACP imports inside
dedicated adapters. Separate prompt acceptance, delivery, completion, and
process exit. Use one reducer and cursor for history and live events.

Preserve account homes, IDs, sequence, messages, attachments, worktrees, forks,
and epic records. Do not rename shipped migrations. Read the highest migration
number before adding one. Draft promotion needs an idempotency key. Upload
bytes stay on HTTP. Do not auto-grant native requests.

Use shadcn/ui controls built on Base UI. Use `render`, not `asChild`. Put
dialog bodies in `DialogPanel` or `AlertDialogPanel`. Preserve drafts after a
failed send. Keep conversation `path` separate from Git `branch`. Dark theme
is selected by `html[data-theme='dark']`, not a `prefers-color-scheme` media
query; scope dark-only CSS to that attribute selector.

## Checks

From the checkout root, use `bun install --frozen-lockfile`, `bun run typecheck`,
`bunx vitest run <file>`, `bun run lint`, and `bash scripts/epic-gate.sh`.
Read `.agents/skills/test-forge-app/SKILL.md` before live browser QA.
