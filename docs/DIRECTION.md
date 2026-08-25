# Direction

Decided 2026-08-25 with Yiin. This file is the source of truth for scope and stack.
The epic planners must follow it. Change it only with Yiin's approval.

## What forge is

A personal agent workspace. It replaces the t3code fork (~600k lines) with a
purpose-built app (target 30k-50k lines). One instance per machine on the
tailnet. The web client is the only UI. Phones are first-class.

## Stack (decided, do not relitigate)

- Runtime: Bun. Single compiled binary with embedded web assets. Spike
  `bun build --compile` + node-pty first; fall back to Node 24 + build-on-host
  only if the spike fails.
- Language: plain TypeScript. No Effect. Async functions, thrown errors,
  small interfaces.
- Harness layer: ACP (Agent Client Protocol) as the one adapter. A harness is
  a config entry (command, args, env), not code. A `pty` protocol entry covers
  non-ACP CLIs headlessly. No terminal UI.
- Storage: SQLite, plain tables, append-only messages. Drizzle migrations,
  raw SQL queries. No event sourcing, no projections.
- Transport: Hono for HTTP commands, one WebSocket per client for events.
  Cursor-based replay (`messages where id > last_seen`) so reconnect is
  lossless by construction.
- Web: React, Vite, TanStack Router, Zustand, shadcn/ui (heavily), xterm-free.
- Schemas: zod, in a shared `packages/protocol` package that dashboards import.
- Search: SQLite FTS5 over sessions, messages, epic runs.
- Tooling: pnpm workspace, oxlint, prettier, vitest. Integration tests against
  a real server with a fake ACP agent.
- Reuse open-source libraries wherever one exists (chat rendering, pdf.js for
  viewing, file-tree components). Do not hand-roll solved problems.

## Scope (features)

- Projects: add/remove, t3code sidebar-v2 style.
- Epic runner: first-party, polished. Subagent/model configuration like t3code.
- Chat: great interface; fixes t3code's reconnection and subagent/epic UX issues.
- Uploads: any file type, up to 1GB, stored next to the session, linked in chat
  as reference paths. AskUserQuestion support.
- File browser + viewer (pdf, images, etc).
- Auto-resume in-progress sessions and epic runs on restart.
- Great search.
- In-chat-input skills UX like t3code.
- Always full access (yolo), always build mode. No permission modes, no plan mode.
- Intelligent title generation: describe what the session is about in plain
  words; never surface bead/epic ids as titles.
- First-class /btw and chat forks (t3code has a good epic to copy).
- Worktrees; harness configs easily addable.
- Dashboard integration: /api/health, /api/status, SSE events, a small client
  package with the zod types.
- Update story: GitHub release binary + systemd timer per host; update once,
  it lands everywhere.

## Non-goals

- No terminal UI. No Electron/desktop. No cloud relay. No multi-user auth
  (tailnet + bearer token for dashboards). No migration of t3code history.

## Quality bar

Every feature gets a polish pass: "we did X - is this the best
implementation/UX, or is there something to improve, and how?" The result must
be working, coherent, polished, and a joy to use.
