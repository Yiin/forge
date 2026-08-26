#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.local/bin"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$bin_dir" "$unit_dir" "$HOME/.local/state/forge"
asset="${FORGE_ASSET:-forge-linux-x64.tar.gz}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download --repo "${FORGE_REPO:-Yiin/forge}" --pattern "$asset" --dir "$tmp"
tar -xzf "$tmp/$asset" -C "$tmp"
source="$(find "$tmp" -type f -path '*/apps/server/src/index.js' -print -quit)"
[[ -n "$source" ]] || { echo 'install: release archive has no server bundle' >&2; exit 1; }
install -m 755 "$source" "$bin_dir/forge"
install -m 644 "$root/forge.service" "$root/forge-update.service" "$root/forge-update.timer" "$unit_dir/"
install -m 755 "$root/forge-update" "$bin_dir/forge-update"
systemctl --user daemon-reload
systemctl --user enable --now forge.service forge-update.timer
loginctl enable-linger "$USER"
