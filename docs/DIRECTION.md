# Forge direction

Updated 2026-09-10 for epic `forge-kcj`. This file defines product scope. The
measured visual and interaction contract is in [comet-ui-contract.md](comet-ui-contract.md).

## Product

Forge is a tailnet-only web workspace for provider-native agent sessions. It
keeps Forge branding, projects, worktrees, accounts, Runs, Epics, search,
archives, forks, uploads, and durable history. It supports Claude, Codex,
OpenCode, Pi, Kimi, and Cursor through native adapters. Dedicated first-party
or custom ACP transports remain supported for Grok, Gemini, Devin, Hermes, and
other configured harnesses. ACP is not the shared runtime contract.

The session model separates provider instance, adapter kind, runtime generation,
run, turn, item, native binding, account, and workspace target. A native
binding is scoped to provider, account, and canonical cwd. Failed resume is
visible. It never silently creates a fresh session.

## UI and stack

The web UI follows the pinned Comet source contract. Sessions live in one
sidebar. The main area has no horizontal session tabs. Workspace surfaces use
session-scoped dock tabs for files, terminal, diffs, history, browser, and
child transcripts. Panels are closed by default. The composer preserves drafts,
attachments, queue state, and pending permission or question requests.

Use TypeScript, Node production server, Bun, React, shadcn/ui Base UI, and
Tailwind. Use Base UI `render`, not `asChild`. Keep protocol schemas provider
neutral. Keep PTY for configured terminal processes. Keep bytes on HTTP.

Desktop uses a resizable sidebar and optional right dock. Mobile uses a full
screen session with a drawer for the sidebar, route-first files, Runs, search,
and settings, plus a safe-area composer. Browser previews use separate-origin
web behavior with an explicit external-open fallback.

## Service contract

The UI reads provider catalogs and model traits, session target and status,
normalized transcript items, pending native requests, queue entries, and
workspace surfaces. Commands include prompt, steer, abort, permission reply,
question reply, resume, fork, surface open, and surface close. Every loaded
history and live event uses one reducer and a replay cursor. Prompt acceptance,
provider delivery, turn completion, and process exit remain separate states.

## Stale decisions

The former ACP-only harness, always-yolo policy, no-terminal rule, no-diff rule,
no-permission rule, and no-plan rule are stale. They do not limit this epic.
The old claim that Forge has no mobile or browser surface is also stale. The
old “single compiled Bun binary” spike is not a product requirement; preserve
the current Node production runtime and release workflow.

## Quality bar

Test provider wire behavior with fake subprocesses or servers. Test real-server
browser flows with isolated accounts and data. Preserve user IDs, messages,
attachments, worktrees, forks, credentials, and epic history. Run focused tests,
typecheck, lint, and the merged epic gate. Do not push or deploy from this epic.
