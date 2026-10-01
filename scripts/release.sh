#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 X.Y.Z" >&2
  exit 2
fi
if [[ "$(git branch --show-current)" != main ]]; then
  echo 'release must run from main' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'release requires a clean tree' >&2
  exit 1
fi

bun pm version "$version" --no-git-tag-version --allow-same-version >/dev/null
git add package.json
git commit -m "chore: release v$version"
git tag "v$version"
git push origin main "v$version"

# e2e runs locally only; CI runs the checks and the build. Install as soon as
# the release is published instead of waiting for the forge-update timer.
echo "waiting for the v$version release workflow"
run=''
for _ in $(seq 30); do
  run="$(gh run list --workflow release.yml --branch "v$version" -L1 --json databaseId -q '.[0].databaseId')"
  [[ -n "$run" ]] && break
  sleep 2
done
[[ -n "$run" ]] || { echo "no release workflow run found for v$version" >&2; exit 1; }
gh run watch "$run" --exit-status --interval 10 >/dev/null
if systemctl --user cat forge-update.service >/dev/null 2>&1; then
  # --no-block: the update restarts Forge, which may be running this script.
  systemctl --user start --no-block forge-update.service
  echo "v$version published; forge-update started"
else
  echo "v$version published; no forge-update.service on this host"
fi
