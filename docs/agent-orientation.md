# Forge agent orientation

Read the epic and assigned child before editing. The epic controls migration scope.
Use [comet-ui-contract.md](comet-ui-contract.md) for target appearance, interactions, and web differences.
Comet source: `/var/tmp/forge-comet-reference` at `a1adfde23448a0e04256931d64a7c72a95b11db7`.
Keep Forge branding and the upstream MIT notice.

## Repository map

- `apps/server/src/harnesses`: provider adapters and native contracts.
- `apps/server/src/sessions`: delivery, lifecycle, recovery, forks, and workspace targets.
- `apps/server/src/accounts`: account homes, login, discovery, usage, and limits.
- `apps/server/src/db` and `apps/server/drizzle`: SQLite and migrations.
- `apps/server/src/git`: existing Git services. Planned `workspace`, `terminals`, and `previews` directories hold new workspace services.
- `apps/server/src/epics`: Beads workers, worktrees, completion, and gates.
- `packages/protocol`: shared Zod wire schemas and transcript contracts.
- `apps/web/src/{components,stores,lib}`: UI, state, and replay.
- `e2e` and `scripts/epic-gate.sh`: browser fixtures and the integration gate.

Verify which planned services exist in your checkout.
Keep the Node production server, Bun packages, React, shadcn/ui Base UI, and Tailwind.
Geist assets and complete theme-role mappings belong to `forge-kcj.17`; font-family declarations alone do not deliver them.

## Runtime and data rules

Keep provider instance IDs stable and adapter kind explicit.
Scope native bindings to provider, account, and canonical effective cwd.
Never fall back from native to ACP or replace failed resume with a fresh session.
Confine ACP types to dedicated adapters. Preserve intentional custom ACP and PTY harness configurations.

Separate prompt acceptance, provider delivery, turn completion, cancellation, and process exit.
Use one projection for history and live events, with stable display identities and explicit replay cursors.
Keep session, provider-history, and terminal cursors separate.

Preserve account homes, IDs, sequences, messages, attachments, worktrees, forks, and epic records.
Do not rename shipped migrations. Check the highest migration number before adding one.
Preserve legacy history and expose unavailable resume.
Draft promotion needs an idempotency key. Upload bytes stay on HTTP.

Do not auto-grant native requests. Reject stale-generation replies.
Browser reload can recover a live request; runtime death expires that generation's requests.
Keep expired requests visible with disabled replies. Plans remain progress state unless the provider separately requests approval.
Workspace operations use the effective session target. Review anchors retain workspace and immutable revision identity.
Conditional saves preserve dirty text on conflicts. Preview content uses a separate origin.

## UI rules

Use Base UI `render`, not `asChild`. Dialog bodies use `DialogPanel` or `AlertDialogPanel`.
Scope dark CSS to `html[data-theme='dark']`.
Preserve drafts after failed send. Keep conversation `path` separate from Git `branch`.
Use at least 44px coarse-pointer targets and 16px phone input text.
Keep dock surface tabs separate from session navigation.

## Checks before every commit

From the assigned checkout root:

1. Use `bun install --frozen-lockfile` for dependency setup.
2. Run focused checks and `bun run typecheck`. Use `bunx vitest run <file>` for focused Vitest tests.
3. Format every changed supported file with `bunx prettier --write <changed files>`.
   For ignored docs, pass `--ignore-path /dev/null`.
4. Run `bun run fmt:check`, `bun run lint`, and `git diff --check` before committing.

The coordinator runs `bash scripts/epic-gate.sh` on integrated code.
Read `.agents/skills/test-forge-app/SKILL.md` before browser QA.
Use isolated data/accounts and the real server path. UI fixtures alone do not prove native-provider behavior.
Follow the active epic's checkout and commit rules. This run permits local commits and no pushes.
