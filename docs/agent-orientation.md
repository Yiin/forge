# Agent orientation: Forge

Read this before edits. The child and epic define scope. `docs/DIRECTION.md`
defines product limits. `docs/architecture.md` is historical.

## Repos and paths

- BEADS + CODE: the current Forge checkout. Run `bd` here.
- Edit only your current checkout. A worker must not edit another worktree.
- `apps/web/src/styles.css`: semantic tokens and shared layout rules. Coordinate edits.
- `apps/web/src/components/ui`: shared fields, buttons, menus, and selectors.
- `apps/web/src/components/AppShell.tsx`: one mounted route outlet and global shortcuts.
- `apps/web/src/routes.tsx`: route tree, root entry, draft, session, and Settings paths.
- `apps/server`: Hono HTTP, WebSocket, session promotion, uploads, and Bun tooling.
- `packages/protocol`: Zod wire schemas shared by server, web, and dashboards.
- `e2e`: Playwright flows. Use `.agents/skills/test-forge-app/SKILL.md` for live QA.
- T3 reference: `/home/yiin/Projects/t3code/apps/web/src/components/settings` and draft routes. Keep Forge terms.

## Check commands from the repo root

- Typecheck: `bun run typecheck`
- Focused tests: `bunx vitest run <file>`
- Lint: `bun run lint`
- Browser tests: `bun run e2e`
- Full gate: `bash scripts/epic-gate.sh`

## UI and interaction contracts

- Shared tokens and `components/ui` own common field visuals. Routes must not fork them.
- Use type roles from `12/13/14/16/20/24px` and spacing from `4/8/12/16/24/32px`.
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

- For `forge-lnm`, `.1` owns tokens, feature children scope local CSS, and `.13` owns cross-surface cleanup.
- Do not add a default-project setting. Draft entry owns project recency.
- Do not use native Select for production choices without a documented platform reason.
- Do not change agent runner semantics to implement the draft UI.
- Do not weaken tests. Main can fail `shell storage > clamps sidebar width`; verify the baseline and fix the contract.
