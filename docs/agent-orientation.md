# Agent orientation: Forge

Operational facts for Forge workers. Read this file before you touch code.
The assigned child and injected epic goal define your scope. `docs/DIRECTION.md`
defines the product boundary. Treat `docs/architecture.md` as historical plans,
not current implementation truth.

## Repos and paths

- BEADS + CODE: this Forge checkout. It can be a worker Git worktree.
- Edit only your current checkout. Never edit `/home/yiin/Projects/forge` from another worktree.
- Run `bd` from your current checkout. It uses the shared Dolt server.
- `apps/web`: React, Vite, TanStack Router, Zustand, and the workspace UI.
- `apps/web/src/components/AppShell.tsx`: owns the single mounted route outlet.
- `apps/web/src/components/chat`: timeline, messages, activity, composer, and agent details.
- `apps/web/src/stores/shell.ts`: theme, sidebar, and shell preferences.
- `apps/web/src/styles.css`: shared tokens and layout. Coordinate edits carefully.
- `apps/server`: Hono server and WebSocket transport. Tooling uses Bun.
- `packages/protocol`: Zod wire schemas shared by server, web, and dashboards.
- `e2e`: Playwright fixtures and desktop, phone, and landscape flows.
- `.agents/skills/test-forge-app/SKILL.md`: disposable browser QA and teardown.

The release runtime is Node 24. Bun remains the package, test, and development tool.

## Check commands from the repo root

- Typecheck: `bun run typecheck`
- Focused test: `bunx vitest run <file>`
- Lint: `bun run lint`
- Format: `bun run fmt:check`
- Production web build: `(cd apps/web && bunx vite build)`
- Browser tests: `bun run e2e`
- Full integration gate: `bash scripts/epic-gate.sh`

Use the `test-forge-app` skill for attended browser QA. Always stop its server
and remove its temporary directory through the launcher cleanup path.

## UI and interaction contracts

- Mount one route tree and one `Outlet`. CSS must never hide a second route tree.
- Use one global shortcut registry. Ignore editable, composing, handled, and modal contexts.
- Do not bind Command or Control plus `1` through `9`. Browsers own those keys.
- Keep `Cmd/Ctrl K` for commands, `Cmd/Ctrl \\` for the sidebar, and `G` chords for navigation.
- Use comfortable density. Primary targets are at least `44px` by `44px`.
- Keep Forge mint sparse. Use it for focus, connection, progress, and primary actions.
- Keep Enter to send, Shift Enter for a new line, and IME composition safe.
- Support System, Light, and Dark themes through one preference source.
- Test `320x568`, `390x844`, `844x390`, and `1440x900` layouts.
- Loading, empty, error, saving, and success states need distinct words and controls.
- Modal layers trap focus, close with Escape, and restore focus to their trigger.
- Use text or icons with status colors. Do not use color alone.
- Keep motion between `100ms` and `220ms`. Preserve complete reduced-motion behavior.

The UI redesign is frontend-only unless a child says otherwise. Do not change
backend domain rules or protocol shapes to simplify a view. The local `.lavish/`
review is not available in worker worktrees. Child descriptions contain all
approved values.

## Vocabulary and data contracts

- A harness is configuration with command, arguments, environment, and `acp` or `pty` protocol.
- `seq` is the single global message cursor.
- Session kinds are `chat`, `subagent`, and `epic_worker`.
- Use `epic run` and `iteration` for `epic_runs` and `epic_iterations`.
- `packages/protocol` binds every wire shape. Change schemas and consumers together.

## Do not

- Do not update or delete message rows. Append rows and fold deltas by `item_id`.
- Do not send uploads over WebSocket. Stream them to disk over HTTP.
- Do not query Dolt SQL from the epic runner. Use `bd --json`.
- Do not publish an event before its database row commits.
- Do not spawn epic workers inside an agent turn. `runner.ts` owns them.
- Do not add Effect, event sourcing, projections, or permission modes.
- Do not use Beads IDs in generated session titles.
