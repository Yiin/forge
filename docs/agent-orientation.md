# Agent orientation — forge

Operational card for epic forge-3b7 workers. Read before touching code.
docs/DIRECTION.md is the scope+stack contract; docs/architecture.md is the
planned design. Your child bead's description wins for your own scope.

## Repos & where things live
- BEADS + CODE: /home/yiin/Projects/forge (one repo; run bd from here).
- docs/DIRECTION.md — binding scope and stack. Never relitigate it.
- docs/architecture.md — planned schema, module map, UX map, t3code lessons.
- apps/server — Bun + Hono + one WS. Planned layout in architecture.md §system.
- apps/web — React/Vite/TanStack Router/Zustand/shadcn.
- packages/protocol — zod schemas only; server, web, dashboards import it.
- /home/yiin/Projects/t3code — predecessor, READ-ONLY reference. Mine UX and
  lessons; never port Effect code.

## Check commands (from repo root)
- Typecheck: `pnpm -r typecheck` (exists after core-scaffold lands; before
  that, the spike child defines its own checks).
- Focused tests: `pnpm vitest run <file>` in the touched package.
- Lint/format: `pnpm oxlint` / `pnpm prettier --check .` (after core-scaffold).
- E2e: see delivery-e2e-harness child once landed; browser flows via the
  test-forge-app skill child.

## Vocabulary & contracts
- "harness" = a config entry (command/args/env, protocol acp|pty), not code.
- "seq" = the single global message cursor. "session kinds": chat, subagent,
  epic_worker. "epic run" / "iteration" per epic_runs / epic_iterations tables.
- packages/protocol binds every wire shape. Change schema and consumers in the
  same child.

## Do not
- Do not UPDATE or DELETE rows in messages. Append-only; the UI folds deltas
  by item_id. (2026-08-25 planning)
- Do not send uploads over WebSocket. HTTP streaming to disk only; t3code
  proved the WS path wrong (their commits 8e5cf2d02 -> 08f1ac479). (2026-08-25)
- Do not query the Dolt server SQL from the epic runner. Use `bd --json`; watch
  .beads/last-touched for change signals. (2026-08-25)
- Do not publish an event before its row is committed. Publish-after-append,
  always; reconnect correctness depends on it. (2026-08-25)
- Do not spawn epic worker processes from inside an agent turn. runner.ts owns
  them; headless turns die and orphan children. (2026-08-25, t3code lesson)
- Do not add Effect, event sourcing, projections, or permission modes. Plain
  TS, plain tables, always-yolo. (2026-08-25)
- Do not use bead ids in generated session titles. Plain words. (2026-08-25)
