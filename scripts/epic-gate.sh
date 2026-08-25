#!/usr/bin/env bash
# cook-epic integration gate (epic forge-3b7).
# Runs once per merge set in the integration worktree. Pre-scaffold trees have
# no workspace scripts yet, so each check runs only after the scaffolding
# child introduces it. The spike child (spike/) is self-contained and gates
# itself.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install

if grep -rl '"typecheck"' --include=package.json apps packages >/dev/null 2>&1; then
  bun run --filter '*' typecheck
fi

if grep -rl '"test"' --include=package.json apps packages >/dev/null 2>&1; then
  bun run --filter '*' test
fi
