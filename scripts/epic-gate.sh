#!/usr/bin/env bash
# Cook Epic integration gate.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile
bun run check
bun run build
bun run e2e
