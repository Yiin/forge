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
- `apps/server`: Hono HTTP, WebSocket, sessions, and uploads. Account logic is in
  `apps/server/src/accounts/`.
- `apps/server/drizzle`: raw SQL migrations. `src/db/migrate.ts` replays every file on each boot, sorted by file name and ledgered by name. Before adding one, run `ls apps/server/drizzle | tail -1` and use the next number after the highest present (two files already share `0017`; never rename a shipped migration).
- `packages/protocol`: Zod wire schemas shared by server, web, and dashboards.
- `packages/protocol/src/status.ts` is vendored into `packages/forge-client` with a drift check. Change it and run the sync.
- `e2e`: Playwright flows. Use `.agents/skills/test-forge-app/SKILL.md` for live QA.
- Account UI: `apps/web/src/components/settings/HarnessAccountCard.tsx`,
  `apps/web/src/components/settings/AccountLoginDialog.tsx`, and
  `apps/web/src/lib/harness-accounts-logic.ts`.
- Account API client: `apps/web/src/lib/accounts-api.ts`.
- T3 reference: `/home/yiin/Projects/t3code/apps/web/src/components/settings` and draft routes. Keep Forge terms.

## Check commands from the repo root

- Typecheck: `bun run typecheck`
- Focused tests: `bunx vitest run <file>`
- Lint: `bun run lint`
- Browser tests: `bun run e2e`
- Full gate: `bash scripts/epic-gate.sh`
- Component tests need `// @vitest-environment jsdom` on line 1. There is no global jsdom.

## Server runtime facts

- Boot loads `~/.forge/forge.toml` (override `FORGE_CONFIG`) via `loadConfigSync`. The file REPLACES the harness map wholesale; new defaults never merge into an existing file, so deployed hosts keep old entries until a reconcile exists.
- The database defaults to `<dataDir>/forge.db` and migrations are ledgered (re-runnable). The deployed unit sets `FORGE_DATA_DIR=~/.local/share/forge`.
- ACP sessions run through `acpHarness` (`apps/server/src/acp/harness.ts`); PTY through `pty/harness.ts`. The per-spawn account overlay (env, and later args) is derived in `startServer`'s factory (`apps/server/src/index.ts:243-259`).
- Accounts: SQLite `harness_accounts` + homes at `~/.forge/accounts/<kind>/<id>` (0700). Login PTY runs the provider CLI (`apps/server/src/accounts/login.ts`), never the harness adapter command.
- Usage sources that exist: Claude `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <accessToken from .credentials.json>` and header `anthropic-beta: oauth-2025-04-20` (buckets `five_hour`, `seven_day_oauth_apps`, plus model-scoped `limits[]` incl. Fable). Codex: spawn `codex -s read-only -a untrusted app-server`, JSON-RPC `account/read` + `account/rateLimits/read` with per-account `CODEX_HOME`. Kimi, grok, gemini, pi, and opencode have no remote usage probe in Forge; their limits are reactive only.
- ACP uses the Forge-pinned `@agentclientprotocol/sdk@0.14.1`. Model selection uses `unstable_setSessionModel`, which sends `session/set_model`. ACP carries no token usage in this SDK. Claude context usage comes from `join(CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g,'-'), providerSessionId + '.jsonl')` and its `message.usage`; each Codex rollout `token_count` event also carries a full `rate_limits` block. Kimi and Gemini remain unsupported for subscription polling.
- Kimi evidence (tested on this Forge host, `/home/yiin/.kimi-code/bin/kimi`, version `0.34.0`): `KIMI_SHARE_DIR`, `~/.kimi`, and `$XDG_DATA_HOME/kimi` were checked. Sessions store local `wire.jsonl` files under `/home/yiin/.kimi-code/sessions/...`, with `usage.record` entries containing `inputOther`, `output`, `inputCacheRead`, and `inputCacheCreation`; these are not ACP frames. A raw `kimi acp` initialize frame returned no usage fields, and the [official Kimi ACP issue](https://github.com/MoonshotAI/kimi-cli/issues/2394) confirms `StatusUpdate.token_usage` is dropped and `PromptResponse.usage` is empty. The same issue records `context_tokens` and `max_context_tokens`, including `262144` for the observed K3 model, but ACP does not expose them. The [Kimi server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html) documents `GET /api/v1/oauth/usage`, but this is a local Kimi server endpoint, not an OAuth endpoint verified against Forge's `credentials/kimi-code.json`; no remote OAuth request was made. Kimi was not installed on the referenced travel-laptop, so no travel-laptop result exists.
- Gemini evidence (tested on this Forge host): `gemini --experimental-acp` is unavailable (`command not found`), so transcript location, ACP `_meta`, and CLI-reported context sizes are not answerable here. No Gemini OAuth usage endpoint was found because no installation exists. [Official Gemini CLI documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) only confirms that `--experimental-acp` starts ACP mode; it does not define a usage frame, transcript path, quota endpoint, or a CLI-reported context size.
- Isolation env vars: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `KIMI_SHARE_DIR`, `XDG_DATA_HOME`(+`OPENCODE_DB`), `GROK_HOME` (grok), `PI_CODING_AGENT_DIR` (pi).
- On laptops, `grok`/`opencode`/`pi` are mise shims under `~/.local/share/mise/shims`; a service PATH without it marks them unavailable.
- The e2e server (`FORGE_E2E=1`) is a separate Bun fake. e2e does not cover `startServer` code; the accounts contract test (`apps/server/test/accounts-contract.test.ts`) covers the real routes. The fake's deltas carry no itemId and are coalesced client-side, so chat streaming, tool-call lifecycle, and composer timing bugs pass e2e; verify those against the real server.
- Chat timeline flow: ACP notification → `AcpNormalizer` (`acp/normalize.ts`) → harness sink → `SessionManager.onItem` → `appendMessage` → EventBus → `ws.ts` → web messages store → `toRenderModel`. The sink must forward itemId/turnId; dropping them orphans tool updates and splits streamed text (forge-d4j).
- `POST /api/sessions/:id/prompt` returns after the harness is spawned and the user rows are persisted; the turn itself runs detached (`manager.ts:453`). The user row is created server-side only (`manager.ts:445`), after spawn. `POST /api/drafts/:id/promote` waits for the same spawn.
- `foldEvent` (`apps/web/src/stores/messages.ts:48`) drops any event with `seq <= lastSeq`. `applyEvent` is unsafe for history replay across sessions; use `loadMessages`.
- The e2e fake never publishes a user `text_delta`; e2e cannot show a user row.

### Worktree lifecycle

- Session delete and discard preserve worktrees and uncommitted files; explicit removal is required (`apps/server/src/http/sessions.ts:212-223`, `apps/server/src/sessions/manager.ts:718-726`).
- Multiple sessions may share a worktree, but removal returns 409 while any active session uses its effective cwd (`apps/server/src/http/workspace.ts:1-80`, `apps/server/src/sessions/manager.ts:202`).
- Forge runs `git worktree prune` once per repository at boot; it never deletes worktree files during pruning (`apps/server/src/index.ts:200-260`, `apps/server/src/git/worktrees.ts:11-25`).
- Forge removes temporary `forge/<8 hex>` branches only after safe worktree removal and proof that the branch is merged into the project default (`apps/server/src/git/worktrees.ts:6-8`, `apps/server/src/git/worktrees.ts:42-59`).
- Settings will list session worktrees and provide an explicit remove action; no other worktree surface exists yet (`apps/web/src/components/settings`, `apps/server/src/http/workspace.ts`).
- Forge allows at most 16 session worktrees per project and rejects the next provision with 409; epic-runner worktrees are outside this cap (`apps/server/src/git/worktrees.ts:20-59`, `apps/server/src/epics/worktrees.ts:42-61`).
- Session worktrees use `<dataDir>/worktrees/<projectId>/<branch>` and differ from the epic runner's in-repository `<repo>/worktrees/epic-<runId>/<childId>` (`apps/server/src/git/worktrees.ts:19-23`, `apps/server/src/epics/worktrees.ts:42-50`).

## Release and deploy

- Release: `bash scripts/release.sh <version>` on a clean `main`. The tag triggers `.github/workflows/release.yml`, which builds, smoke-tests, and publishes `forge-linux-x64.tar.gz`.
- The pack step in `release.yml:51-63` is an explicit file list. New runtime assets must be added there or they do not ship.
- Hosts (`yiin-lt`, `main-laptop`, `travel-laptop`) self-update every 15 min via `forge-update.timer`; force with `systemctl --user start forge-update.service`. Health: `curl -fsS http://127.0.0.1:3900/api/health`.
- The deployed unit (`ops/forge.service`) includes `%h/.local/share/mise/shims` in PATH for `grok`, `opencode`, and `pi`.
- The `pi` PATH entry is a mise wrapper. It runs `mise use -g pi` on each spawn.
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
- Composer pickers use `/api/harnesses/health`, not `/api/status`.
- `/api/status` has no `enabled` or `name` fields for harnesses.
- The harness picker shows enabled harnesses with at least one account.
- If no harness qualifies, it shows a link to `/settings/harnesses`.

## Vocabulary and data contracts

- A harness has command, arguments, environment, and an `acp` or `pty` protocol.
- A harness kind has one or more accounts. Each has a credential home at
  `~/.forge/accounts/<harnessKind>/<accountId>`.
- Child isolation uses one env var per kind: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `KIMI_SHARE_DIR`, or `XDG_DATA_HOME`.
- Rotation follows config key order. Settings renders this order, and arrows rewrite it.
- A rate limit is a structured `AccountLimit`. `resetsAt: null` means no reset time.
  Never invent one.
- Epic fallback tries other accounts in the same harness kind, then the next hop.
- `seq` is the single global message cursor.
- itemId groups one logical timeline item (a tool-call lifecycle, one streamed text run). Web folds strictly by itemId; all rows for one item must share it. toolCallId is the ACP-native key and the client-side fallback.
- Session REST responses are camelCase via `packages/protocol` schemas; raw SQLite rows must not leak from handlers.
- Model selection is session-scoped via ACP `unstable_setSessionModel`, which sends `session/set_model`. `/api/sessions/:id/models` is a RAM map filled from `session/new` (`manager.ts:75-80`); it is empty for idle sessions and after restart. `GET /api/harness-accounts/:id/models` returns `[]` today and is the seam for a durable catalog. Effort overlay in `accounts/store.ts:284-333` only maps grok, opencode, pi.
- The raw config-option channel in `apps/server/src/acp/configOptions.ts` is deliberate. claude-code-acp 0.16.2 has no `session/set_config_option` handler. SDK 1.x removes `session/set_model` and `NewSessionResponse.models` in favor of config-option model selection. Do not upgrade past 0.14.x until the pinned agents support that flow. `extMethod` prefixes `_`. Wrap the `Stream` to add methods. claude-code-acp takes `_meta.claudeCode.options` (effort, model `<slug>[1m]`) on `session/new`; codex-acp 0.16 has no `session/set_model`, only config options.
- `spike/` still references `@zed-industries/agent-client-protocol` through its own lockfile. This workspace is deliberately out of scope.
- Context usage lives on disk, not in ACP: Claude transcript at `$CLAUDE_CONFIG_DIR/projects/<cwd with [^a-zA-Z0-9]→'-'>/<providerSessionId>.jsonl` (`message.usage`); Codex rollout at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`token_count` events with `model_context_window` and `rate_limits`).
- Git: the only git code is `apps/server/src/epics/worktrees.ts` (epic worktrees live INSIDE the repo). `sessions.worktree_path` exists but nothing writes it. Session `cwd` feeds the harness spawn directly (`manager.ts:202`); draft promotion hardcodes `cwd = project.path` (`manager.ts:551`). `apps/server/src/http/projects.ts` still returns raw rows.
- Vocabulary: `branch` is a Git branch only; `path` is a conversation path. `PathSwitcher.tsx` is conversation paths, not filesystem.
- Draft promotion idempotency keys per attempt (`draft.promotionKey` → `Idempotency-Key`), never per draft id. Drafts are one per project and reused across sessions; `draft_promotions.request_id` is the unique key.
- Session kinds are `chat`, `subagent`, and `epic_worker`.
- Change `packages/protocol` schemas and all consumers together.

## Do not

- Do not add a default-project setting. Draft entry owns project recency.
- Do not use native Select for production choices without a documented platform reason.
- Do not change agent runner semantics to implement the draft UI.
- Do not weaken tests. Main can fail `shell storage > clamps sidebar width`; verify the baseline and fix the contract.
