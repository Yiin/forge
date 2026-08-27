# Agent orientation: Forge

Read this before edits. The child and epic define scope. `docs/DIRECTION.md`
defines product limits. `docs/architecture.md` is historical.

## Repos and paths

- BEADS + CODE: the current Forge checkout. Run `bd` here.
- Edit only your current checkout. A worker must not edit another worktree.
- `apps/web/src/app.css`: shadcn/ui tokens and the Tailwind theme. Dark is the default, set via `html[data-theme]`. Coordinate edits.
- `apps/web/src/styles.css`: minimal base rules only. Tokens live in `app.css`.
- `apps/web/src/components/ui`: real shadcn/ui components. Do not hand-roll controls; import from `@/components/ui/*`.
- `apps/web/src/components/AppShell.tsx`: one mounted route outlet and global shortcuts.
- `apps/web/src/routes.tsx`: route tree, root entry, draft, session, and Settings paths.
- `apps/server`: Hono HTTP, WebSocket, session promotion, uploads, and Bun tooling.
- `apps/server/drizzle`: raw SQL migrations. `src/db/migrate.ts` replays every file on each boot.
- `packages/protocol`: Zod wire schemas shared by server, web, and dashboards.
- `packages/protocol/src/status.ts` is vendored into `packages/forge-client` with a drift check. Change it and run the sync.
- `e2e`: Playwright flows. Use `.agents/skills/test-forge-app/SKILL.md` for live QA.
- T3 reference: `/home/yiin/Projects/t3code/apps/web/src/components/settings` and draft routes. Keep Forge terms.

## Check commands from the repo root

- Typecheck: `bun run typecheck`
- Focused tests: `bunx vitest run <file>`
- Lint: `bun run lint`
- Browser tests: `bun run e2e`
- Full gate: `bash scripts/epic-gate.sh`
- Component tests need `// @vitest-environment jsdom` on line 1. There is no global jsdom.

## Server runtime facts

- Production boot uses `defaultConfig()` only. `loadConfig` is never called, and `harnessRoutes` gets no `configPath`, so harness and settings edits are memory-only today (`apps/server/src/index.ts:118-121,169`).
- `FORGE_DB` defaults to `:memory:` (`apps/server/src/index.ts:163`). The deployed service never sets it, so all SQLite state dies on restart.
- The production `HarnessFactory` stubs ACP harnesses (`apps/server/src/index.ts:170-182`). `spawnAcpClient` runs only from `POST /api/harnesses/test`.
- `EpicRunner` is never constructed; `/api/epics` routes do not mount in the real server.
- The e2e server (`FORGE_E2E=1`, `apps/server/src/index.ts:262`) is a separate Bun fake. e2e does not cover `startServer` code.

## Release and deploy

- Release: `bash scripts/release.sh <version>` on a clean `main`. The tag triggers `.github/workflows/release.yml`, which builds, smoke-tests, and publishes `forge-linux-x64.tar.gz`.
- The pack step in `release.yml:51-63` is an explicit file list. New runtime assets must be added there or they do not ship.
- Hosts (`yiin-lt`, `main-laptop`, `travel-laptop`) self-update every 15 min via `forge-update.timer`; force with `systemctl --user start forge-update.service`. Health: `curl -fsS http://127.0.0.1:3900/api/health`.
- The deployed unit (`ops/forge.service`) sets PATH entries for `claude`, `codex`, `kimi`, and `opencode`.
- The unit uses option A from `forge-o9o.11`: command lookup stays PATH-based.
- After a release, `ops/install.sh` installs the unit and reloads systemd. For a manual unit update on `yiin-lt`, run `install -m 644 ops/forge.service ~/.config/systemd/user/forge.service` and `systemctl --user daemon-reload`.

## UI and interaction contracts

- Real shadcn/ui components own every control. Routes must not hand-roll controls; import via `@/components/ui/*`.
- Use type roles from the Tailwind scale (`text-xs/sm/base/xl/2xl`) and spacing from `4/8/12/16/24/32px`.
- Fine-pointer controls stay compact. Coarse-pointer targets remain at least `44px`.
- Project recency uses newest visible user-session activity. It falls back to the newest active project.
- One active project has one unpromoted draft. Opening it creates no server session.
- First send promotes once. Failure preserves the prompt, harness, and staged attachments.
- Upload bytes stay on HTTP. Promotion assigns them to the new session.
- One shared project-creation flow serves the hero, sidebar, palette, and Settings.
- Settings uses route pages, vertical navigation, shared sections, and shared rows.
- Theme is one client preference. Do not save `system` to server config.
- Styled Select supports arrows, Home, End, typeahead, Enter, Space, Escape, and focus return.
- Use one shortcut registry. Ignore editable, composing, handled, modal, and capture contexts.
- Add a skip link. Route changes move focus to the new main heading.
- Test `320x568`, `390x844`, `620px`, `844x390`, `920px`, `1280px`, and `1440x900`.
- Loading, empty, error, dirty, saving, saved, and retry states need distinct words and controls.
- Dialogs and popups manage focus, close with Escape, and restore trigger focus.

## Vocabulary and data contracts

- A harness has command, arguments, environment, and an `acp` or `pty` protocol.
- `seq` is the single global message cursor.
- Session kinds are `chat`, `subagent`, and `epic_worker`.
- Change `packages/protocol` schemas and all consumers together.

## Do not

- Do not add a default-project setting. Draft entry owns project recency.
- Do not use native Select for production choices without a documented platform reason.
- Do not change agent runner semantics to implement the draft UI.
- Do not weaken tests. Main can fail `shell storage > clamps sidebar width`; verify the baseline and fix the contract.
