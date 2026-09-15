#!/usr/bin/env bash
# Cook Epic integration gate.
set -euo pipefail
cd "$(dirname "$0")/.."
export BUN_INSTALL_CACHE_DIR="$PWD/.native-build/bun-cache"
node scripts/isolate-gate-dependencies.mjs

bun install --frozen-lockfile --ignore-scripts --backend=copyfile
node scripts/build-node-pty.mjs
node scripts/check-node-pty.mjs
bun run build:cursor-sidecar
bun run check
bun run build
bun run e2e
