# Forge UI contract

Forge follows Comet's appearance and session workflows while keeping Forge's name, logo, and existing product features.
This contract defines the target for epic `forge-kcj`; it does not claim that every target is implemented.
Keep TypeScript, the Node production server, Bun packages, React, shadcn/ui Base UI, and Tailwind.
Keep projects, worktrees, accounts, Runs, Epics, search, archives, forks, uploads, and durable history.

The source is [zeronsh/comet at a1adfde23448a0e04256931d64a7c72a95b11db7](https://github.com/zeronsh/comet/tree/a1adfde23448a0e04256931d64a7c72a95b11db7).
The reference checkout is `/var/tmp/forge-comet-reference`.
All `crates/...` paths and screenshot paths below refer to that pinned checkout.
Source code controls behavior and dimensions when comments or screenshots disagree.
Recheck citations when the source pin changes.
Retain the full Comet MIT notice in `THIRD_PARTY_NOTICES.md` when translating or copying substantial source.

## Appearance

Use the measured values below through shadcn/Tailwind semantic variables.
Keep distinct roles for shell, content, raised plates, cards, dialogs, and overlays.
Add a semantic variable when an existing variable cannot express the required role.
Do not use a translucent card color as the opaque user-bubble plate.

| Role                                        | Dark                                   | Light                                   | Comet source                                                           |
| ------------------------------------------- | -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| Content background                          | `#060606`                              | `#ffffff`                               | `crates/ui/src/theme.rs:1000`, `crates/ui/src/theme.rs:1077`           |
| Shell/sidebar                               | `#0d0d0d`                              | `oklch(0.968 0 0)`                      | `crates/ui/src/theme.rs:1001`, `crates/ui/src/theme.rs:1081`           |
| Raised opaque plate, including user bubbles | `oklch(0.235 0 0)`                     | `oklch(0.940 0 0)`                      | `crates/ui/src/theme.rs:1002`, `crates/ui/src/theme.rs:1082-1087`      |
| Card                                        | `#0e0e0e`                              | `#ffffff`                               | `crates/ui/src/theme.rs:1003`, `crates/ui/src/theme.rs:1088`           |
| Dialog                                      | `#101010`                              | `#ffffff`                               | `crates/ui/src/theme.rs:1004`, `crates/ui/src/theme.rs:1089`           |
| Overlay/popover                             | `#161616`                              | `#ffffff`                               | `crates/ui/src/theme.rs:1005`, `crates/ui/src/theme.rs:1090`           |
| Text / muted / faint                        | `oklch(0.922 0 0)` / `0.708` / `0.556` | `oklch(0.25 0 0)` / `0.439` / `0.535`   | `crates/ui/src/theme.rs:1010-1012`, `crates/ui/src/theme.rs:1099-1104` |
| Border / strong border                      | White at 8% / 14%                      | Black at 10% / 17%                      | `crates/ui/src/theme.rs:1008-1009`, `crates/ui/src/theme.rs:1093-1094` |
| Accent                                      | `oklch(0.673 0.182 276.935)`           | `oklch(0.511 0.262 276.966)`            | `crates/ui/src/theme.rs:92-96`                                         |
| Solid plate / on-solid label                | `oklch(0.922 0 0)` / `#0e0e0e`         | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | `crates/ui/src/theme.rs:1014-1015`, `crates/ui/src/theme.rs:1106-1107` |
| Danger                                      | `oklch(0.704 0.191 22.216)`            | `oklch(0.577 0.245 27.325)`             | `crates/ui/src/theme.rs:1020`, `crates/ui/src/theme.rs:1112`           |
| Warning                                     | `oklch(0.828 0.189 84.429)`            | `oklch(0.555 0.163 48.998)`             | `crates/ui/src/theme.rs:1022`, `crates/ui/src/theme.rs:1114`           |
| Success                                     | `oklch(0.765 0.177 163.223)`           | `oklch(0.596 0.145 163.225)`            | `crates/ui/src/theme.rs:1024`, `crates/ui/src/theme.rs:1116`           |

The shortened neutral entries in the text row also mean `oklch(lightness 0 0)`.
Map content to `--background`, shell to `--app-chrome-background` and `--sidebar`, and opaque plates to `--surface-raised`.
Map cards to `--card`, overlays to `--popover`, and keep a separate dialog role.
Map text, muted text, and faint text to separate variables.
Keep border, stronger input border, accent, and focus-ring roles consistent.
Forge can retain its existing informational blue where Comet has no corresponding role.

Use Geist for interface text and Geist Mono for code and terminals.
The source assigns both families in `crates/ui/src/theme.rs:1047-1051` and `crates/ui/src/theme.rs:1143-1147`.
The default interface size is 16px, with choices of 12, 13, 14, 15, 16, 18, and 20px.
Scale interface dimensions from the 16px baseline. Code, diff, and terminal text retain their own sizes.
See `crates/ui/src/typography.rs:83-118`.

Theme delivery belongs to `forge-kcj.17`.
Revision `665d564` changes some CSS values and names the Geist families, but it does not install their font files.
That revision also leaves shell and raised-surface mappings incomplete.
The theme child must install licensed fonts, complete role mappings, and check actual component use in both themes.
Naming a font family or declaring a token does not prove its rendered appearance.

## Measured geometry

These values use the default interface scale.
The web exceptions below apply to touch targets, phone input text, and narrow-screen layout.

| Surface                             | Required geometry                                                                                                     | Comet source                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Sidebar                             | 208px minimum, 256px default, 400px maximum. Collapse to zero.                                                        | `crates/ui/src/settings.rs:29-31`; `crates/ui/src/shell.rs:1899-1904`                                          |
| Sidebar rhythm                      | 2px list gap; 8px inline edge; 12px section gap; 28px disclosure header; 4px disclosure-body inset.                   | `crates/ui/src/shell.rs:663`; `crates/ui/src/shell/spaces.rs:118-126`                                          |
| Sidebar harness marks               | Active: 13px icon with 8px title gap. Archived: 14px icon with 10px title gap.                                        | `crates/ui/src/shell.rs:664-670`                                                                               |
| Titlebar                            | 38px height, 2px downward content shift; 8px group gap and 12px identity gap.                                         | `crates/ui/src/theme.rs:803-805`; `crates/ui/src/shell.rs:218-224`                                             |
| Titlebar left controls              | 24px button visuals. The additional new-session slot occupies 32px, including its 8px gap.                            | `crates/ui/src/shell.rs:228-233`                                                                               |
| Dock toolbars and diff file headers | 38px height. Shared toolbar controls are 24px, icons 14px, gaps 4px, edge inset 8px.                                  | `crates/ui/src/surface_chrome.rs:7-12`; `crates/ui/src/surface_chrome.rs:29-37`; `crates/ui/src/changes.rs:66` |
| Right dock                          | Preferred minimum 360px, default 520px. Resize cap is viewport minus sidebar minus a 300px chat floor.                | `crates/ui/src/settings.rs:33-39`; `crates/ui/src/shell.rs:422-427`                                            |
| Dock takeover                       | Explicit takeover can consume the full width remaining after the sidebar. Restore the prior split afterward.          | `crates/ui/src/shell.rs:430-433`                                                                               |
| Status/fade band                    | Reserve a 24px status strip. Keep settled transcript content clear of the 24px bottom fade.                           | `crates/ui/src/theme.rs:806-814`                                                                               |
| Surface radii and spacing           | Message bubble 16px, panel 10px, control 6px. Base spacing: 4/8/12/16px.                                              | `crates/ui/src/theme.rs:815-825`                                                                               |
| Transcript column                   | Maximum 736px. User prompts collapse after five wrapped lines; 400 characters provide the initial long-text estimate. | `crates/ui/src/transcript.rs:76-77`; `crates/ui/src/transcript.rs:127-137`                                     |
| Composer                            | Maximum 768px width; 26px radius; 14px text and 22.75px line height.                                                  | `crates/ui/src/composer.rs:60-71`; `crates/ui/src/composer.rs:81-83`                                           |
| Composer height                     | Compact: 49px. Expanded: 76px to 260px textarea, 46px controls, and 2px borders; total 124px to 308px.                | `crates/ui/src/composer.rs:47-69`                                                                              |
| Composer mode changes               | Expand below 200px input capacity. Collapse uses 32px width hysteresis and a 150ms resize-settle delay.               | `crates/ui/src/composer.rs:79-99`                                                                              |
| Composer queue                      | 16px side inset and 18px overlap behind the composer. Rows: 36px height, 2px gap, 12.5px text.                        | `crates/ui/src/composer.rs:72-76`; `crates/ui/src/queue.rs:74-80`                                              |
| Send/Queue/Stop                     | Neutral 28px circle. Stop uses an 11px square with 3px radius inside that circle.                                     | `crates/ui/src/composer.rs:6517-6543`                                                                          |
| Attachment previews                 | Composer: 56px thumbnails with 8px gaps. Transcript: 112px by 80px thumbnails. Both wrap.                             | `crates/ui/src/composer.rs:270-275`; `crates/ui/src/transcript.rs:140-144`                                     |
| Diff                                | 12px mono text, 21px lines, 28px hunk headers, 36px gutters, 28px markers, 3px accent bars. Split markers use 18px.   | `crates/ui/src/changes.rs:73-88`                                                                               |
| File tree/editor                    | Tree rows: 27px. Editor font: 13px default, configurable from 9px to 24px.                                            | `crates/ui/src/files/tree.rs:16`; `crates/ui/src/settings.rs:55-57`                                            |
| History                             | 36px rows, 12px lane spacing, 3px graph-node radius.                                                                  | `crates/ui/src/history.rs:36-41`                                                                               |
| Terminal panel                      | 280px default height, 160px minimum, 55vh runtime cap; 40px tab bar.                                                  | `crates/ui/src/settings.rs:41-47`; `crates/ui/src/terminal/panel.rs:40-42`                                     |

The dock's preferred minimum yields when the viewport cannot also retain the chat floor.
On phones, use an explicit full-screen surface instead of squeezing both columns.
The terminal's 2000px settings constant repairs stored values; it does not replace the 55vh runtime cap.

`Theme::HEADER_HEIGHT` remains 44px at `crates/ui/src/theme.rs:799`.
Current dock toolbars use `surface_chrome::HEADER_HEIGHT`, which resolves to the 38px titlebar height.
The 44px constant is not the dock measurement.
The composer's 32px hysteresis controls width decisions; it does not define a control's height.

| Motion               | Duration                              | Comet source                      |
| -------------------- | ------------------------------------- | --------------------------------- |
| Menu entrance / exit | 140ms / 100ms                         | `crates/ui/src/motion.rs:347-351` |
| Dialog entrance      | 180ms                                 | `crates/ui/src/motion.rs:352-353` |
| Sidebar/pane resize  | 200ms                                 | `crates/ui/src/motion.rs:356-357` |
| Tab reorder          | 150ms                                 | `crates/ui/src/motion.rs:358-359` |
| Fold / chevron       | 180ms / 200ms                         | `crates/ui/src/motion.rs:360-364` |
| Hover color          | 150ms, `cubic-bezier(0.4, 0, 0.2, 1)` | `crates/ui/src/motion.rs:369-374` |

Use interruptible transitions. Respect reduced motion and keep keyboard navigation immediate.

## Navigation and composer

Sessions live in the sidebar. The titlebar names the selected session with its provider icon, title, and muted workspace target.
Horizontal session tabs are absent: `crates/ui/src/shell/tabs.rs:1-5`.
Keep sidebar toggle, back/forward navigation, new session, and dock controls available through visible buttons.
Do not copy native window caption buttons.

The sidebar starts with a searchable project scope and view options.
Rows show project/host, title, state, and optional provider, branch, or pull-request details.
Support created/updated sorting, metadata toggles, and an archived disclosure.
These options follow `crates/ui/src/shell/spaces.rs:82-111`.
Use the same visible session order for keyboard navigation and the sidebar.
Keep rename, archive/unarchive, delete, fork, and copy-ID actions accessible.
Archiving does not change a session's running or failure state.
Place Forge's Runs, search, settings, and project controls in a quiet footer or command palette.
Preserve their routes and existing workflows.

Dock tabs belong to each session and can contain files, diffs, History, terminals, browsers, and child transcripts.
The source surface host is `crates/ui/src/shell.rs:436-451`.
Both dock and terminal start closed. Remember open flags during session navigation; keep saved dimensions separate.
Comet's open flags last for the process lifetime: `crates/ui/src/shell.rs:466-485`.
Hiding the dock preserves its tabs and terminal processes. Closing a terminal explicitly closes its process.
The dock remains useful in non-Git workspaces; disable only unavailable Git surfaces.
See `crates/ui/src/shell.rs:1933-1939`.

Keep one composer editor mounted across compact and expanded layouts.
Preserve caret, selection, IME composition, undo, paste, and focus during resize.
Use Send while idle, Queue while running with content, and Stop while running without content.
Attachments and review notes count as content without typed text.
The source distinguishes these states in `crates/ui/src/composer.rs:460-494`.
Failed delivery preserves draft text, attachments, and review notes.
Opening a draft does not create a provider session. Projectless drafts remain supported.
Show the actual workspace target and preserve account selection.

The model picker has favorites and provider tabs across the top, tab-scoped search, and a pinned traits area.
Its model-list band is 216px: `crates/ui/src/pickers.rs:2976-2980`.
The current tab rendering is `crates/ui/src/pickers.rs:3060-3074`.
For an existing session, other provider tabs stay visible but disabled.
Models, reasoning levels, and options come from the selected provider/account catalog.
Show detection, authentication, loading, empty, error, and retry states honestly.
Repair stale model options using catalog defaults. Do not infer capabilities from ACP or PTY labels.
Changing an existing session's account must respect its native binding.

Slash completion applies to the first `/` token. Commands come from the selected provider and workspace.
The source command contract is `crates/proto/src/agent.rs:278-284`.
File mentions retain workspace/path identity and preserve the current selection when inserted.
Uploads, paste, drop, and preview strips preserve attachment ownership across navigation and failed sends.

## Queue and delivery

Every provider's queue uses Send now as its primary delivery action.
Send now interrupts the active response before delivering the selected prompt.
Native steering is a separate capability and never substitutes for Send now.
See `crates/ui/src/queue.rs:7-9` and `crates/ui/src/queue.rs:88-108`.

Support edit/save/cancel, remove, reorder, and Send now by durable prompt ID.
Editing leases the original row and preserves its position, text, attachments, and staged review notes.
Block delivery while a row is leased or conflicts with another edit.
Honor explicit server acknowledgements; failed mutations preserve recoverable content.
Keep queued content outside the transcript until the engine promotes it.
Distinguish prompt acceptance, provider delivery, turn completion, cancellation, and process exit.
An acknowledgement does not prove completion. Reconnect must not resend accepted content blindly.

## Neutral view data

The protocol package defines the wire schemas. The concepts below specify required information, not a second wire format.
Keep provider-native IDs inside the adapter/runtime boundary when the UI does not need them.

| Concept           | Required information                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider catalog  | Stable provider instance, adapter kind, account, detection/authentication state, version, supported actions, and discovery errors.           |
| Model catalog     | Model identity/label, reasoning/options/defaults, supported modalities, context capacity, favorites, and discovery provenance.               |
| Session target    | Session ID, workspace identity, canonical effective cwd, worktree identity, provider/account, and native-resume availability.                |
| Transcript        | Durable event sequence, run/turn/item identity, stable display-block identity, content version, role, typed content, and child relationship. |
| Queue entry       | Prompt ID, version, order, content/attachments/review anchors, model/options, edit lease, delivery state, and error.                         |
| Native request    | Request/session identity, owning runtime generation, typed permission or question payload, reply rules, status, expiry, and answerability.   |
| Question progress | Request/question IDs, page, selected option IDs, free text, and multi-select state.                                                          |
| Plan              | Plan/item identity, ordered steps and status, source turn, and last update. Link an approval request only when one exists.                   |
| Context usage     | Reported occupied tokens, capacity, remaining tokens, observation state, and explicit unavailable values.                                    |
| Workspace surface | Surface/session/workspace identity, kind, target path or revision, active tab/order, loading/error state, and dirty/connected state.         |
| Review note       | Note ID/body and the workspace/revision/path/side/line anchor defined below.                                                                 |

Use one deterministic projection for REST history and streamed events.
Keep durable event sequence separate from mutable display-block versions.
Keep session event cursors separate from provider transcript cursors and terminal replay cursors.
Switching sessions or loading one snapshot must not discard another session's unseen events.

## Transcript, requests, and plans

Use a 736px text column with right-aligned neutral user bubbles and plain assistant markdown.
Virtualize stable blocks and update only changed content.
Streaming completion must preserve block identity, fold choices, selection, and viewport position.
Comet documents this model in `crates/ui/src/transcript.rs:1-24`.
Group ordinary tools into quiet summaries with typed invocation, output, diff, and truncation details.
Keep failures local to the failed tool. Child-agent cards remain outside ordinary tool folds.
Show child task/model/status and open its independent transcript in the dock.
Tool paths open real file or diff surfaces.

User wheel/touch input releases automatic following. Sending a prompt can restore following.
Re-engage within 70px of the bottom; show the jump control beyond 320px.
See `crates/ui/src/transcript.rs:17-24` and `crates/ui/src/transcript.rs:61-65`.
The prompt rail appears at 768px container width and shows at most 12 ticks.
Provide previews, keyboard focus, and jump-to-prompt behavior.
See `crates/ui/src/rail.rs:21` and `crates/ui/src/rail.rs:119-127`.
The reserved status strip shows actual pending delivery or live work and clears on settlement.
Retain partial content after errors and cancellation.

Context usage comes from the session snapshot.
Show occupied/capacity/remaining values, warning at 75%, danger at 90%, and an explicit unavailable state.
Missing usage is not zero. See `crates/ui/src/context_usage.rs:1-19` and `crates/ui/src/context_usage.rs:85-106`.

Questions use request-scoped paged progress, Back navigation, and option number keys 1 through 9.
Single-select advances after 220ms. Multi-select and typed answers require explicit advance.
Allow a free-text override when the provider's request permits free input.
Preserve option IDs rather than deriving replies from display labels.
See `crates/ui/src/composer.rs:87` and `crates/ui/src/composer.rs:590-715`.
The web client preserves answer drafts across reload and session switching.
Focus and IME rules prevent option shortcuts from stealing ordinary text input.

Permissions retain their exact tool context, allowed choices, and request identity.
Use separate permission and question reply operations. Do not auto-grant native requests.
Duplicate replies are idempotent; replies cannot cross sessions or runtime generations.
These are Forge runtime requirements from `forge-kcj.14`, beyond Comet's current approval visuals.

Reloading the web client may recover an answerable request while its owning runtime remains alive.
Runtime death expires requests owned by that generation.
Keep expired questions, saved answers, and permission decisions visible in history with their actual status.
Show an explicit unavailable/restart action when recovery cannot restore the provider request.
A provider must establish a valid current request before reply controls become active again.
Never replay an old answer into a new runtime or display an expired request as answerable.

Plans are provider-authored progress state. They survive replay as progress state and do not automatically become approval requests.
Comet exposes todo items through `crates/proto/src/agent.rs:193-195` and `crates/proto/src/view.rs:425-427`.
Forge renders richer normalized plan updates when a provider supplies them.
If a provider separately requests plan approval, apply the same request lifetime and expiry rules.

## Workspace actions and acceptance

Every workspace operation uses the session's effective cwd and workspace identity.
That target may be an isolated worktree or a projectless directory.
Never substitute the project root or another session's target.
Loading, empty, error/retry, disconnected, stale, and unsupported states must remain explicit.
Opening a tab alone does not satisfy a surface's acceptance.

| Surface          | Required working behavior                                                                                                                                                                                                                                                                                                                 | Acceptance scenario                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files            | Read/search the workspace tree; reveal paths; open file tabs. Show syntax, selection, line numbers, dirty state, and supported previews. Save conditionally against workspace identity and the loaded content hash. Reload clean external changes; preserve dirty text on conflict. Offer save/discard/cancel when closing dirty content. | Edit a real file in a separate worktree. Change it externally before save. Verify conflict preserves both versions. Test save, discard, cancel, binary/size limits, and a target change during an outstanding read.                |
| Diffs            | Working tree compares against HEAD. Branch scope includes working-tree changes against the selected merge-base. Latest turn uses its actual pre-dispatch snapshot. Support unified/split views, wrapping, file folds, line numbers, totals, and binary/rename/truncation notices.                                                         | Create commits, staged/unstaged edits, untracked files, a rename, and a binary file. Verify each scope differs correctly and the latest-turn snapshot survives restart. Report a missing snapshot as unavailable.                  |
| History          | Page commits with parent links, lane graph, refs, author/date, subject, search/filter, and refresh. Open separate immutable commit-diff tabs.                                                                                                                                                                                             | Page a repository with merges and changing refs. Verify no duplicate/missing commits. Open two commits and confirm later commits do not change those diffs.                                                                        |
| Terminal         | Create independent user PTYs in the session target. Support input, clipboard, resize, tab names/order, bounded replay, and explicit exit state. Hide/detach preserves the process; close ends it. User terminals are separate from PTY harness sessions.                                                                                  | Run a command that prints known output. Resize, switch sessions, disconnect/reconnect, and verify output continuity. Close the terminal and verify its owned process exits.                                                        |
| Browser          | Open registered workspace preview targets. Keep per-tab address and known navigation state, reload, connection errors, external-open, and takeover/restore. Use the browser limits below.                                                                                                                                                 | Use a real preview server. Verify navigations initiated through Forge, unavailable navigation controls, failed connection, frame-blocked fallback, and preserved security headers. Test a server-local target from a phone client. |
| Child transcript | Open a read-only child transcript with its own identity, stream, status, and viewport. Parent tool completion must not imply child completion.                                                                                                                                                                                            | Stream parent and child concurrently. Change the parent's fold state and switch sessions. Verify the child continues and settles independently.                                                                                    |
| Review notes     | Stage notes with immutable anchors. Include them in the next agent prompt while retaining structured identity. Keep notes on failed send.                                                                                                                                                                                                 | Add old-side, new-side, and file notes. Rename/edit the file or refresh the diff. Verify each note still cites its original workspace/revision. Test failed send and successful prompt delivery.                                   |

The Files source retains hashes, revisions, and external-change state in `crates/ui/src/files/document.rs:48-65`.
Dirty reload confirmation appears in `crates/ui/src/files/preview.rs:403-416`.
Clean versus dirty external updates differ at `crates/ui/src/files/preview.rs:1539-1542`.
File autosave defaults to 900ms, configurable from 100ms to 10000ms: `crates/ui/src/settings.rs:52-54`.
Keep hidden/ignored-file controls and exclude `.git` from the explorer's ordinary file tree.
Unsupported encodings, binaries, and size limits must have readable reasons.

Diff scopes and immutable commit views follow `crates/ui/src/changes.rs:837-859`.
History owns a separate surface despite the older comment in `crates/ui/src/history.rs:1-4`.
Forge's `forge-kcj.26` requires stable snapshot identity and preservation of the real Git index and worktree.
Latest-turn capture occurs before the provider can edit files.
Do not relabel a branch diff as Latest turn after snapshot failure.
Terminal detach, input, resize, and replay follow `crates/ui/src/terminal/panel.rs:1-14`.

### Review anchor identity

Use one shared anchor schema for Git, file tabs, and composer notes, as required by `forge-kcj.26`.
An anchor contains the workspace identity, immutable revision identity, old/new path, side, and line.
The revision identifies a commit, turn snapshot, captured diff revision, or the cited file content hash/document revision.
Retain the note's body and stable ID alongside that anchor.
Old-side notes on renamed files cite the old path.
Refreshing a diff must not silently move a note to a different revision or workspace.
Show stale anchors and let the user explicitly re-anchor them.

Comet's note behavior is in `crates/ui/src/comments.rs:1-5` and `crates/ui/src/comments.rs:22-39`.
Forge adds workspace and revision identity to that behavior.
Serialize notes into the agent prompt with their citation context, while keeping structured anchors in durable content.
These notes do not post comments to GitHub or change repository files by themselves.

### Browser limits

Accept HTTP/HTTPS addresses only; reject embedded credentials and control characters.
Default bare external hosts to HTTPS and loopback hosts to HTTP.
See `crates/ui/src/browser/model.rs:37-77`.
Resolve host-local preview ports on the Forge server, not on the user's phone.
Expose only registered session/workspace targets through the scoped preview service.
Keep preview content on a separate origin and preserve CSP and X-Frame-Options.
Do not create an arbitrary proxy that strips those headers.

Native Comet owns browser navigation/title state in `crates/ui/src/browser/model.rs:4-12`.
A web iframe cannot promise the same access to arbitrary cross-origin pages.
Forge tracks navigation it initiated and enables back/forward only for known entries.
Use titles and internal navigation state only when the preview service or a supported integration reports them reliably.
Otherwise display the known URL/host and the unsupported state.
An iframe `load` event alone does not prove that embedding succeeded.
Always offer external-open and preserve the surface tab when embedding is unavailable.
Use real managed-target connection state; do not invent success or indefinite fake loading.

## Settings and browser adaptation

Comet's settings labels are Devices, Agents, Accounts, Appearance, Files, Notifications, Shortcuts, and Archived sessions.
See `crates/ui/src/shell.rs:399-410`.
Keep Forge's Projects, Epics, role policies, provider-account workflows, and general settings reachable.
Do not add a decorative Devices page when the server exposes only one host.
Local Forge use does not require a Comet cloud account.

Agent settings show actual detection, enablement, install hints, and authentication state.
Unavailable providers cannot appear runnable. Existing sessions retain their provider identity when that provider becomes disabled.
Accounts retain login, switch/forget, plan/email, usage windows, reset times, and target-specific errors.
Account quota warnings use 80% and 95%, separately from context occupancy's 75% and 90% thresholds.
See `crates/ui/src/settings/accounts.rs:40-54`.
Test two accounts and confirm credentials, models, requests, and pending login actions remain separate.

Appearance exposes light/dark/system, supported palette/accent choices, font family/size, and supported CSS surface treatments.
Offer bundled Geist, Geist Mono, and system fonts. Browsers cannot enumerate arbitrary installed fonts or blur desktop wallpaper.
Files settings control actual autosave and editor size.
Notifications require user-initiated browser permission and persisted preferences.
Shortcuts support conflict detection, reset, and complete visible-button equivalents.
Native shortcuts at `crates/ui/src/settings.rs:580-606` include browser-reserved combinations.
Choose browser-safe defaults rather than assuming Ctrl+Tab, Mod+N, or Mod+R can control Forge reliably.

On phones, use a separate session list/drawer and conversation with a compact header and safe-area composer.
Use route-first Files, Runs, Search, and Settings, with explicit full-screen dock surfaces and a return to the conversation.
Do not add a bottom tab bar.
Keep phone input text at least 16px and coarse-pointer targets at least 44px.
Preserve the desktop glyph dimensions inside the larger touch targets.
Pickers must fit the viewport and scroll internally.
Code, diff, and terminal content can scroll inside their surfaces; the page must not scroll horizontally.
Handle keyboard viewport shrink, landscape, and safe-area changes without losing drafts or selected targets.

Use Base UI `render`, not `asChild`, and use `DialogPanel` or `AlertDialogPanel` for dialog bodies.
Select dark CSS through `html[data-theme='dark']`.
Give controls hover, active, focus-visible, disabled, and accessible-name states.
Restore focus after dialogs and menus close. Keep tree and tab navigation keyboard accessible.
Do not let global shortcuts override a focused editor, picker, question, or modal.
Enter/Shift+Enter must respect IME composition. Preserve the skip link and reduced-motion behavior.

## Source images and stale references

These real captures are available in the pinned repository.
They show useful visual detail, but their capture versions do not all match the source pin.

| Reference                                                                                      | Useful evidence                                                                        | Provenance limit                                                                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `docs/screenshots/context-usage/near-capacity-light.png`                                       | Light shell, sidebar, neutral bubble, compact composer, context indicator.             | 1320px by 880px fixture capture. Exact capture commit is not stated here. Use current source for colors and behavior. |
| `docs/screenshots/mobile-polish/home-glass.png`                                                | Native phone session list, project/host metadata, state, archived disclosure.          | Native iOS layout reference. Its pixels are not CSS dimensions or a required web breakpoint.                          |
| `docs/screenshots/mobile-tool-disclosure/tool-group-expanded.png`                              | Phone conversation, tool guide rail, neutral group summary, local failed-tool styling. | Native fixture capture. Visible sample prose is not a specification.                                                  |
| `docs/screenshots/browser/macos-preview-dark.png`                                              | Browser dock, address bar, live local preview, collapsed sidebar.                      | Capture commit `d5c08649`, CI run `34308828299`, 1024px desktop. See `docs/screenshots/browser/README.md:18-22`.      |
| `docs/screenshot.png`                                                                          | Dark transcript density, composer, prompt rail.                                        | Historical image with horizontal session tabs. Do not copy that navigation.                                           |
| `apps/landing/public/assets/shots/sessions.png`                                                | Session-row hierarchy and metadata.                                                    | Historical marketing crop with desktop wallpaper tint.                                                                |
| `apps/landing/public/assets/shots/diff.png` and `apps/landing/public/assets/shots/history.png` | Review and history surface detail.                                                     | Historical marketing captures; verify current scopes and controls in source.                                          |

The browser fixture uses synthetic chat data and a loopback website without launching an agent.
See `docs/screenshots/browser/README.md:1-3`.
Keep native wallpaper, blur over desktop content, and window caption buttons out of Forge's web shell.

The following upstream references are historical:

- `docs/research/feature-inventory.md:3-4` and `docs/research/feature-inventory.md:241-245` exclude usage that current source now implements.
- `docs/research/feature-inventory.md:65-66` describes older Send/Steer/Stop behavior.
- `crates/ui/src/composer.rs:465` calls Stop red; current rendering at `crates/ui/src/composer.rs:6520-6532` uses a neutral circle.
- `crates/ui/src/pickers.rs:2966-2975` describes a left rail. Current rendering uses top tabs.
- `crates/ui/src/history.rs:1-4` describes future dock tabs that current scope handling already supports.
- `crates/ui/src/theme.rs:799` declares a 44px generic header; current dock toolbars resolve through `crates/ui/src/surface_chrome.rs:7`.

Old Forge ACP-only, no-terminal, no-diff, no-permission, and no-plan limits do not constrain this epic.

## Provider scope

Keep the provider scope in `docs/DIRECTION.md`.
Forge uses native Claude, Codex, OpenCode, Pi, Kimi, and Cursor adapters.
Dedicated first-party/custom ACP transports support Grok, Gemini, Devin, Hermes, and configured custom providers.
Keep intentional PTY harness configurations as a separate supported mode.
ACP types do not belong in shared runtime or UI contracts.
Never substitute ACP after native-adapter failure or silently create a new session after failed native resume.

The pinned Comet registry contains ClaudeCode, Codex, Cursor, Devin, Grok, Hermes, Pi, OpenCode, and test-only Mock.
See `crates/proto/src/agent.rs:7-24`.
Its Pi adapter still uses community ACP: `crates/harness/src/lib.rs:9-10`.
Forge's native Pi and Kimi/Gemini coverage are intentional requirements.

## Integration acceptance

Each surface must pass its real-service scenario above.
The integration checks also require:

1. Compare desktop captures at 1320px by 880px in both themes against the source values and listed references.
   Check actual font loading, distinct surface roles, dimensions, controls, and closed-by-default panels.
2. Check 390px by 844px, 768px width, landscape, and keyboard-like viewport shrink.
   Include long model names, ten attachments, many tools, and more than 600 turns.
3. Open a projectless draft without a provider session. Send attachments or review notes without typed text.
   Fail delivery and verify all draft content survives.
4. Verify provider/account selection, model traits, favorites, tab-scoped search, and existing-session provider lock.
   Exercise detection/authentication errors and unavailable capabilities.
5. Queue, edit, reorder, remove, and Send now during a live response.
   Verify interruption before delivery, retained row position, lease protection, and separate native steering where supported.
6. Reload during streaming and switch sessions while another remains active.
   REST history and replay must preserve content, identities, viewport, dock state, and other sessions' unseen events.
7. Read old history while a reply streams. Preserve selection and manual fold choices without forced scrolling.
   Verify the follow band, jump control, prompt rail, child transcripts, and actual usage/unavailable states.
8. Answer a three-page single-select, multi-select, and free-text request. Test Back, option keys, reload, and duplicate replies.
   Kill its runtime and verify expiry disables replies while retaining history and saved answer text.
   Test a separately reissued request and reject replies addressed to its retired generation.
9. Exercise explicit approval allow/deny and plan updates. Plan progress must not create an invented approval request.
   Failed resume remains visible and preserves the existing transcript and native identity.
10. Verify Runs/Epics settle after authoritative worker completion.
    Keep accounts, projects, worktrees, global search, archives, forks, and session branch history reachable and functional.
11. Test settings persistence, account isolation, notification permission, shortcut conflicts, keyboard access, and reduced motion.
    Report unsupported browser behavior explicitly.

Use the production server path with deterministic native-provider fixtures and real temporary workspace services.
A synthetic UI server, static screenshot, or successful tab open cannot prove provider or workspace acceptance.
Retain browser evidence and any source/native-to-web differences with the final parity review.
