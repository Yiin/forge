# Forge UI contract

Status: normative for `forge-kcj`. Source audit: Comet/Zeron repository
`zeronsh/comet`, commit `a1adfde23448a0e04256931d64a7c72a95b11db7`, checked in
`/var/tmp/forge-comet-reference`. The source paths below are provenance and
must be rechecked when the pinned commit changes. This document describes
Forge behavior with Forge branding: keep Forge's name and logo. It does not
copy Comet source or rebrand Forge as "Comet".

## Fonts and colors

The measured Comet values below are normative for implementation, not
Forge's prior tokens. They are mapped through the existing shadcn/Tailwind
semantic CSS variable names in `apps/web/src/app.css`, so shadcn components
keep working unchanged; only the variable *values* change.

- Fonts: Geist (interface) and Geist Mono (code/terminal), replacing DM Sans
  and JetBrains Mono. `crates/ui/src/theme.rs:1047-1049` (dark) and
  `:1143-1145` (light). Comet's default interface size is 16px, chosen from
  12/13/14/15/16/18/20px: `crates/ui/src/typography.rs:83-112`. Code, diffs,
  and terminal text keep absolute pixel sizes and do not scale with the
  interface size setting.
- The `geist` font package is not installed in this repo yet
  (`apps/web/src/main.tsx` still imports `@fontsource-variable/dm-sans` and
  `@fontsource/jetbrains-mono`). `--font-sans`/`--font-mono` in
  `apps/web/src/app.css` now point at `Geist`/`Geist Mono` with a system
  fallback, but until the font files are installed the browser renders the
  fallback. Installing Geist is separate follow-up work (see proposed
  follow-up issue below).
- Accent (`--primary`/`--ring`): dark `oklch(0.673 0.182 276.935)`, light
  `oklch(0.511 0.262 276.966)`. `crates/ui/src/theme.rs:92-96`.
- Content plane (`--background`/`--card`): dark `#060606` bg / `#0e0e0e`
  card; light `#ffffff` for both. `crates/ui/src/theme.rs:1000,1003,1077,1088`.
- Shell/dialog/overlay (`--secondary`, `--muted`, `--sidebar`, `--popover`,
  `--accent`): dark shell `#0d0d0d`, dialog `#101010`, overlay/raised
  `#161616`; light shell `oklch(0.968 0 0)`, raised/opaque-plate (user
  message bubbles) `oklch(0.940 0 0)`, dialog/overlay white.
  `crates/ui/src/theme.rs:1000-1005,1077-1090`.
- Text (`--foreground`, `--muted-foreground`): dark
  `oklch(0.922 0 0)`/`oklch(0.708 0 0)`/`oklch(0.556 0 0)` (text/muted/faint);
  light `oklch(0.25 0 0)`/`oklch(0.439 0 0)`/`oklch(0.535 0 0)`.
  `crates/ui/src/theme.rs:1008-1012,1093-1104`.
- Borders (`--border`, `--input`): dark white 8%/14% alpha; light black
  10%/17% alpha. `crates/ui/src/theme.rs:1008-1009,1093-1094`.
- Status colors (`--destructive`, `--success`, `--warning`): dark red-400
  `oklch(0.704 0.191 22.216)`, emerald-400 `oklch(0.765 0.177 163.223)`,
  amber-400 `oklch(0.828 0.189 84.429)`; light red-600
  `oklch(0.577 0.245 27.325)`, emerald-600 `oklch(0.596 0.145 163.225)`,
  amber-700 `oklch(0.555 0.163 48.998)`. `crates/ui/src/theme.rs:1008-1012,
  1093-1104` (surrounding danger/warning/success fields). Comet has no "info"
  role; Forge keeps its existing blue for `--info`.

## Measured shell

Values are source constants, not estimates.

| Surface | Contract | Source provenance |
| --- | --- | --- |
| Sidebar | 208px minimum, 400px maximum, 256px default; 200ms width transition | `crates/ui/src/settings.rs:29-31`; `crates/ui/src/motion.rs:357` (`RESIZE`) |
| Sidebar collapse | Collapses fully to 0px width, not to an icon rail. The titlebar's left cluster gains a 24px "New session" action slot when collapsed | `crates/ui/src/shell.rs:1899-1904` (`sidebar_target`); `:231-233` (`TITLEBAR_ACTION_SLOT_WIDTH`) |
| Sidebar rows | 2px list gap; 13px active / 14px archived harness icon | `crates/ui/src/shell.rs:663,667,669-670` |
| Title bar | 38px high; 2px downward content shift; 28px action centered in the bar | `crates/ui/src/theme.rs:803,805`; `crates/ui/src/shell.rs:225-226` |
| Panel header | 44px high (main-panel/in-card headers, e.g. the changes pane); shares the 38px titlebar with a 2px downward optical shift | `crates/ui/src/theme.rs:799` (`HEADER_HEIGHT`); `:803,805` (`TITLEBAR_HEIGHT`, `TITLEBAR_TOP_PAD`) |
| Right dock | 360px minimum, 520px default; hidden by default; expand-to-takeover collapses the conversation column to zero, never the dock | `crates/ui/src/settings.rs:35-36`; `crates/ui/src/shell.rs:1281-1283` |
| Chat floor | Resizing the right dock preserves a 300px floor for the conversation column instead of letting it collapse to zero | `crates/ui/src/settings.rs:37` (`CHAT_PANEL_MIN`); `crates/ui/src/shell.rs:1937-1946` |
| Shared surfaces | 10px panel radius, 6px control radius; spacing steps 4/8/12/16px | `crates/ui/src/theme.rs:818,820,822-825` |
| Composer | 26px bubble radius elsewhere, 768px max width, 14px text at 22.75px line height; 200px compact-input floor | `crates/ui/src/composer.rs:42` (`COMPOSER_MAX_WIDTH: 768.0`), `:79` (`MIN_COMPACT_INPUT_WIDTH: 200.0`), `:81-82` (`INPUT_LINE_HEIGHT`/`INPUT_TEXT_SIZE`) |
| Composer control height | 32px hysteresis band governs the expanded/compact flip; treat 32px as the minimum tap/control height for composer controls | `crates/ui/src/composer.rs:95` (`COLLAPSE_HYSTERESIS: 32.0`) |
| Composer queue | 16px side inset, 18px overlap behind the composer | `crates/ui/src/composer.rs:44-46` |
| Composer thumbnails | 56px staged-attachment thumbnails; 8px gap; 112x80px user-bubble attachment thumbnails | `crates/ui/src/composer.rs:270-273` (`STRIP_THUMB`, `STRIP_GAP`); `:141` area (user-attachments 112x80) |
| Send/Queue/Stop button | 28px circular button, neutral (not accent) styling | `crates/ui/src/composer.rs:6522,6540,6973` |
| Queue rows | 36px row height, 2px row gap, 12.5px text; single primary action is Send now | `crates/ui/src/queue.rs:74-80` |
| Transcript column | 736px max content width; user prompts collapse past 5 lines / 400 characters | `crates/ui/src/transcript.rs:77` (`MAX_CONTENT_WIDTH`); `:126,133` (`USER_COLLAPSED_LINES`, `USER_COLLAPSE_CHARS`) |
| Diff/changes text | 12px diff text, 21px line height, 28px hunk header; 36px gutter, 28px marker column | `crates/ui/src/changes.rs:73-84` |
| File tree rows | 27px row height | `crates/ui/src/files/tree.rs:16` |
| Terminal panel | 280px default height, 160px minimum, 55% viewport / 2000px absolute maximum | `crates/ui/src/settings.rs:41-46` |
| Motion | Menus 140ms in / 100ms out; dialogs 180ms in; tab drag-reorder 150ms; sidebar/pane resize 200ms | `crates/ui/src/motion.rs:349,352,355,359,357` |

The web client keeps 16px minimum phone input text (iOS zoom-avoidance) and
at least 44px coarse-pointer targets as an explicit web exception to the
above pixel values; it must not shrink source-sized visual glyphs (icons,
avatars) to fit those targets. Code and terminal text sizing stays separate
from the scalable interface text setting.

## Navigation and surfaces

The sidebar is the session list. Selecting a session changes the main surface.
There are no horizontal session tabs. The sidebar contains search, new session,
Runs, project scope, active sessions, settled sessions, archives, and account
settings. Rename, archive, fork, and copy-id actions operate on the selected
session. Runs remain visible as a Run entity, not as raw bead IDs.

The right dock is a session-scoped surface host. Its tab strip can contain
Files, Terminal, Diffs, History, Browser, and child transcript surfaces. A plus
menu opens a surface. Tabs can be reordered and closed. The dock and terminal
are closed by default. A narrow browser cannot hide the chat without an
explicit takeover action. On small screens, dock surfaces become full-screen
routes or an explicit external browser window.

The composer is sticky at the bottom. It supports text, attachments, slash
commands, model and target controls, queue state, Stop, and Send/Queue. It
auto-grows from the measured compact mode to the expanded range. Failed sends
keep draft text and attachments. Opening a draft does not create a provider
session.

### Queue: Send now versus steering

Every provider's queue row exposes exactly one primary action, `Send now`,
which interrupts the active response and delivers the queued prompt before
its turn (`crates/ui/src/queue.rs:7-9,88-108`). This is required, not
optional. Editing a queued row leases it in place and preserves its position
and attachments; delivery is disabled for leased or otherwise conflicting
rows. Native mid-run steering, where the provider supports it, is a separate
capability exposed alongside `Send now`, not a substitute for it. Queue
controls are: Send now, edit/save/cancel, remove, and reorder; steer and
abort by durable prompt ID where the provider supports steering.

## Backend-neutral view data

The web client must not render provider protocol labels as product controls.
It consumes these concepts:

```text
ProviderCatalog { providerInstanceId, adapterKind, accountId, models[] }
ModelTrait { id, label, capabilities, contextTokens, reasoning, modalities }
SessionTarget { sessionId, providerInstanceId, accountId, canonicalCwd, worktree }
TranscriptItem { seq, itemId, turnId, role, kind, status, content, children[] }
PendingRequest { requestId, kind: permission|question, schema, createdAt }
QueueEntry { promptId, state: active|queued|steering|completed|aborted, text }
WorkspaceSurface { surfaceId, kind, title, sessionId, path, state }
ModelPickerState { favoriteModelIds[], providerTabs[], activeTab, query, providerLocked }
TranscriptBlock { blockId, entryId, partId, groupIndex, foldState, isChildTranscript }
PromptRailTick { promptId, previewText, replyPreviewText }
ContextUsage { occupiedTokens, capacityTokens, remainingTokens, status: ok|warning|danger|unavailable }
PlanState { requestId, steps[], activeStepId, recoveredFromRestart }
QuestionWizardState { requestId, pageIndex, pageCount, question, pickedOptionIndexes[], freeText, multiSelect }
```

The server owns provider identity and native bindings. The client sees
normalized transcript kinds for text, thinking, tool call, tool result,
permission, question, child lifecycle, error, and status. A transcript item
may update in place while its `seq` remains replayable. Session event cursors
and provider transcript cursors are separate.

Additional required behaviors, each backed by pinned source:

- **Model picker**: a favorites tab plus one tab per provider across the top
  (not a left rail), tab-scoped search that filters only the active tab, a
  fixed 216px model-list band above the pinned traits tray, and a locked
  provider selector for an existing session (its other tabs stay visible but
  disabled). `crates/ui/src/pickers.rs:2966-2980,3060-3074`.
- **Transcript**: stable virtualized block identity keyed
  `{msgId}#{partId}.{blockIx}` (or `#g{groupIx}` for tool groups) so rows
  never remount while streaming; manual per-block tool-fold state that
  survives scroll; child transcripts render outside ordinary tool folds;
  user messages collapse past 5 lines or 400 characters; text selection is
  preserved across re-renders; the bottom-stick pin re-engages within a 70px
  band of the end; the jump-to-bottom affordance and list overdraw both use a
  320px threshold. `crates/ui/src/transcript.rs:1-24,61-65,77,126-133`.
- **Prompt rail**: a left minimap of user prompts, visible only when the
  container is at least 768px wide, capped at 12 visible ticks regardless of
  viewport height, with keyboard/focus-driven jump-to-row.
  `crates/ui/src/rail.rs:21,124-127`.
- **Context usage**: occupied/capacity/remaining token values read from the
  session snapshot, an explicit "not reported by this harness yet"
  unavailable state, a warning threshold at 75% occupied, and a danger
  threshold at 90%. `crates/ui/src/context_usage.rs:1,14-19,85-106`.
- **Plan/todo state**: the plan surface renders `PlanState` (steps, active
  step, completion) sourced from the provider's native plan/todo updates, and
  restarting a session with a pending plan recovers it instead of discarding
  it; a native request pending at restart (permission, question, plan) must
  reappear as pending, not silently drop. This behavior was previously
  undefined in this document.
- **Question wizard**: request-scoped paged progress ("1/3"), free-text
  answers that override picked option labels, multi-select pages that
  require an explicit advance, Back navigation between pages, number keys
  1-9 to pick an option, and a 220ms auto-advance after a single-select pick.
  `crates/ui/src/composer.rs:87,590-598,6306,6453,6177`.

## Real service actions

The UI maps visible actions to service commands. Prompt submits content and
returns a durable prompt ID. Queue controls send-now, edit, remove, reorder,
steer, or abort by prompt ID. Permission replies carry an explicit allow or
reject decision. Question replies preserve option IDs and typed answers.
Resume requires a proven native binding and reports failure. Fork records its
context method and confidence. Surface actions open, focus, reorder, and
close a workspace surface — but opening a surface's tab does not by itself
satisfy that surface's workflow acceptance; each surface below has its own
required working behavior.

For Kimi-compatible native services, the captured wire baseline is REST under
`/api/v1/sessions` and WebSocket control frames with `{type,id,payload}`.
Forge adapters may use another provider contract, but they must expose the
same neutral actions and states. See the durable Kimi probe in Beads and
`docs/research/` for source capture details.

### Dock surface matrix

Opening a dock tab is necessary but not sufficient; each surface must reach
its listed working state, not just render an empty shell.

| Surface | Required commands | Required state | QA scenario |
| --- | --- | --- | --- |
| Files | Read a workspace file; hash-conditional save; discard | `DocumentPhase` (loading/ready/read-only/error), `revision` vs `saved_revision` dirty flag, `pending_external_reload` on out-of-band change | Edit a real temp file, save, confirm hash-conditional write; edit externally while open and confirm the conflict prompt; close a dirty tab and confirm save/discard/cancel |
| Terminal | Create a user PTY; write input; resize; replay bounded scrollback; detach vs close | Per-tab PTY handle, bounded replay buffer, exit code/status | Spawn a real PTY, run a command, resize the pane, detach (process keeps running) then close (process exits); confirm output survives navigation away and back |
| Diffs | Select scope (working tree / branch+working tree / latest turn); open an immutable per-commit diff from History | `DiffScope` (`WorkingTree`, `Branch`, `LatestTurn`, `History`, `Commit`); `crates/ui/src/changes.rs:837-859` | Make an uncommitted change in a real git repo and confirm it appears under Working tree; confirm Branch scope diffs against `merge-base`; open a commit from History and confirm its diff is pinned and immutable |
| History | Page commit history; open an immutable diff per commit | Paged commit list; commit-pinned `DiffScope::Commit` tab | Page through a real repo's commit history; open two different commits and confirm each keeps its own pinned diff tab |
| Browser | Navigate a registered workspace target; track back/forward/loading/error; fall back to external-open when embedding fails | `PageState { url, title, loading, can_back, can_forward, error }`; host-local ports resolved server-side | Point the browser at a real local preview server; navigate and confirm back/forward and title update; point it at a target that refuses embedding and confirm the external-open fallback, with CSP/X-Frame-Options preserved and no arbitrary header-stripping proxy |
| Child transcripts | Open a child session's transcript as its own dock tab, outside the parent's ordinary tool folds | Child transcript renders with its own `TranscriptBlock` stream, not collapsed into a tool-call fold | Spawn a child session, confirm its transcript opens as a dock tab and streams independently of the parent's fold state |
| Review notes (composer-adjacent) | Attach a note to a file/diff line; note joins the next prompt as plain text | `ReviewComment { id, path, line, source: Diff{side,old_path}\|File }` | Add a note on the old and new side of a diff and on a plain file; send a failed prompt and confirm the note survives; send successfully and confirm it appears in the sent prompt text |

Every surface above resolves its `path`/`cwd` against the session's effective
working directory (worktree if forked, else the session's canonical cwd);
no surface may assume the project root.

## Browser equivalents

Desktop and mobile share the same session data and commands. Desktop uses a
resizable sidebar and dock. Mobile uses a menu button and session drawer, a
full-screen transcript, a safe-area composer, and route-first Files, Runs,
Search, and Settings. Mobile does not use a bottom tab bar. Browser previews
use a separate origin. If embedding is unsupported, show an external-open
action and preserve the surface tab.

## Acceptance scenarios

1. A new draft opens without creating a provider session. Failed send restores
   its text and attachments.
2. Selecting a sidebar session updates the transcript while preserving its
   session-scoped dock tabs. No horizontal session tab appears.
3. A queued prompt's `Send now` interrupts the active response and delivers
   before its turn; this is verified as distinct from native mid-run
   steering. Editing a queued row preserves its position and attachments and
   blocks delivery while leased.
4. A native permission or typed question stays pending until an explicit
   reply; a permission, question, or plan still pending at restart reappears
   as pending rather than being dropped.
5. A tool call, tool result, and child transcript render as typed items after
   REST history load and WebSocket replay; a child transcript renders outside
   its parent's ordinary tool folds.
6. Restart preserves account scope, canonical cwd, native identity, sequence,
   and transcript. Failed resume stays failed and never starts a new session.
7. Each dock surface (Files, Terminal, Diffs, History, Browser, child
   transcripts) reaches its working state per the dock surface matrix above,
   not merely an open tab: a real file save/discard, a real PTY write/resize,
   a real git diff/commit, a real preview navigation.
8. Runs and Epics show live status and completion after their child turns
   complete. Sidebar titles use plain words, not bead IDs.
9. Replay: reloading mid-stream reconstructs the transcript from REST history
   plus WebSocket replay without duplicating or losing an in-flight item.
10. Failed send: a prompt that fails to deliver returns its text, attachments,
    and any staged review notes to the composer draft, and the queue reflects
    no phantom entry.
11. Session switching: switching sessions while one is streaming leaves the
    prior session's stream and dock state intact for when it is reselected.
12. Pending requests: a permission or question raised while a different
    session is focused surfaces on return to the session that owns it and is
    still answerable.
13. Reading history during streaming: scrolling up into older history while a
    reply streams does not break the stick-to-bottom pin's 70px re-engage
    band once the user scrolls back within it.
14. The model picker enforces a provider lock on an existing session: other
    provider tabs remain visible but disabled, and tab-scoped search does not
    cross tabs.
15. The context usage indicator shows "unavailable" for a harness that
    reports no usage, switches to warning styling at 75% occupied, and to
    danger styling at 90%.

## Provenance and stale inventory

Source constants decide both geometry and *behavior*; visual references below
are illustration only and some are stale.

- The pinned repository's `docs/screenshot.png`,
  `apps/landing/public/assets/shots/sessions.png`,
  `apps/landing/public/assets/shots/diff.png`, and
  `apps/landing/public/assets/shots/history.png` are **historical, dated
  marketing/reference captures, not current truth**. `docs/screenshot.png`
  in particular visibly shows horizontal session tabs, which
  `crates/ui/src/shell/tabs.rs:1-5` explicitly documents as removed
  (`wing 2026-08-10`, "the horizontal tab strip is gone"): the activity
  sidebar is the session list, and the titlebar names the selected session.
  This document's prohibition on horizontal session tabs (Navigation and
  surfaces, above) governs; the screenshot does not. Its capture predates
  that removal and should not be used to infer current navigation.
- Light-theme and mobile visual references were inspected during this audit
  from the pinned source's theme construction (`crates/ui/src/theme.rs`
  `light()`/`light_with_accent`) and settings defaults; no separate
  light-mode or mobile screenshot exists in the pinned repository. Treat the
  measured OKLCH light-theme values above, not any screenshot, as the source
  of truth for light mode.
- `docs/research/feature-inventory.md:1-9` is Comet's own pre-rewrite parity
  checklist (dated 2026-07-19) and is **historical**: `:8` explicitly
  excludes token/context-usage display from that inventory
  (`## 8. EXCLUDED (token usage display)`), while the pinned, later source
  (`crates/ui/src/context_usage.rs`) implements exactly that surface — this
  document's Context usage section governs. `:61-66` describes an older
  Send/Steer/Stop composer model; the pinned `queue.rs` Send-now behavior
  above supersedes it. `crates/ui/src/pickers.rs:2966-2975`'s own comment
  documents a superseded left-rail model picker design; the pinned rendering
  at `:3060-3074` (top tabs) governs and is what this document specifies.
- Existing Forge research that says ACP is the only adapter, permissions do
  not exist, or terminal and diff surfaces are out of scope is historical.
  The epic scope supersedes it.
- Do not copy Comet's desktop wallpaper, native window chrome, or OS-specific
  titlebar caption buttons into Forge; those are native-app-shell concerns
  with no web equivalent.

## Provider inventory (unchanged)

`docs/DIRECTION.md` already records the approved, broader Forge provider
scope (native Claude, Codex, OpenCode, Pi, Kimi, Cursor; isolated ACP Grok,
Gemini, Devin, Hermes, and configured custom providers). The pinned Comet
registry (`crates/proto/src/agent.rs:7-24`) is narrower and still drives Pi
over community ACP (`crates/harness/src/lib.rs:9-14`); Forge's native Pi plan
and its Kimi/Gemini additions are intentional scope expansions, not
deviations to reconcile away.
