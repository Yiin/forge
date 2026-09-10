# Forge UI contract

Status: normative for `forge-kcj`. Source audit: Comet/Zeron repository
`zeronsh/comet`, commit `a1adfde23448a0e04256931d64a7c72a95b11db7`, checked in
`/var/tmp/forge-comet-reference`. The source paths below are provenance and
must be rechecked when the pinned commit changes. This document describes
Forge behavior with Forge branding. It does not copy Comet source.

## Measured shell

Values are source constants, not estimates.

| Surface | Contract | Source provenance |
| --- | --- | --- |
| Sidebar | 208px minimum, 256px default, 400px maximum; 200ms width transition | `crates/ui/src/settings.rs:29-31`; `crates/ui/src/shell.rs:5` |
| Sidebar rows | 2px list gap; 28px disclosure header; 12px section gap; 8px gutter | `crates/ui/src/shell.rs:663-670`; `crates/ui/src/shell/spaces.rs:122-126` |
| Title bar | 38px high; 8px group gap; 12px identity gap | `crates/ui/src/theme.rs:803`; `crates/ui/src/shell.rs:222-224` |
| Right dock | 360px minimum, 520px default; hidden by default | `crates/ui/src/settings.rs:35-37`; `crates/ui/src/shell.rs:1-7`, `466-476` |
| Shared surfaces | 10px panel radius, 6px control radius; spacing 4/8/12/16px | `crates/ui/src/theme.rs:818-825` |
| Composer | 26px radius, 768px max width, 14px text, 22.75px line height; 49px compact height; 124-308px expanded height | `crates/ui/src/composer.rs:42-92`, tests at `7735-7756` |
| Composer queue | 16px side inset and 18px overlap behind the composer | `crates/ui/src/composer.rs:74-76`; `crates/ui/src/queue.rs:81-83` |

The current Forge Tailwind tokens remain authoritative for implementation
colors and fonts. Source-derived layout does not require Comet branding.

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
```

The server owns provider identity and native bindings. The client sees
normalized transcript kinds for text, thinking, tool call, tool result,
permission, question, child lifecycle, error, and status. A transcript item
may update in place while its `seq` remains replayable. Session event cursors
and provider transcript cursors are separate.

## Real service actions

The UI maps visible actions to service commands. Prompt submits content and
returns a durable prompt ID. Queue controls steer, reorder, or abort by prompt
ID. Permission replies carry an explicit allow or reject decision. Question
replies preserve option IDs and typed answers. Resume requires a proven native
binding and reports failure. Fork records its context method and confidence.
Surface actions open, focus, reorder, and close a workspace surface.

For Kimi-compatible native services, the captured wire baseline is REST under
`/api/v1/sessions` and WebSocket control frames with `{type,id,payload}`.
Forge adapters may use another provider contract, but they must expose the
same neutral actions and states. See the durable Kimi probe in Beads and
`docs/research/` for source capture details.

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
3. A queued prompt can be steered or aborted by durable prompt ID. Completion
   is distinct from process exit.
4. A native permission or typed question stays pending until an explicit reply.
5. A tool call, tool result, and child transcript render as typed items after
   REST history load and WebSocket replay.
6. Restart preserves account scope, canonical cwd, native identity, sequence,
   and transcript. Failed resume stays failed and never starts a new session.
7. Files, terminal, diff, history, browser, and child surfaces open from the
   dock. Mobile opens the documented route or external browser fallback.
8. Runs and Epics show live status and completion after their child turns
   complete. Sidebar titles use plain words, not bead IDs.

## Provenance and stale inventory

The measured values and behavior map to the pinned source paths above. No
generated screenshot is treated as a source of truth. The pinned repository
also contains visual provenance at `docs/screenshot.png`,
`apps/landing/public/assets/shots/sessions.png`,
`apps/landing/public/assets/shots/diff.png`, and
`apps/landing/public/assets/shots/history.png`. These images illustrate the
shell and surfaces. The source constants above decide geometry.

Existing Forge research that says ACP is the only adapter, permissions do not
exist, or terminal and diff surfaces are out of scope is historical. The epic
scope supersedes it.
