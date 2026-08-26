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

npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
git add package.json
git commit -m "chore: release v$version"
git tag "v$version"
git push origin main "v$version"
