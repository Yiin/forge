#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.local/bin"
lib_dir="${FORGE_LIB_DIR:-$HOME/.local/lib/forge}"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$bin_dir" "$unit_dir" "$HOME/.local/state/forge" "$(dirname "$lib_dir")"
asset="${FORGE_ASSET:-forge-linux-x64.tar.gz}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download --repo "${FORGE_REPO:-Yiin/forge}" --pattern "$asset" --dir "$tmp"
tar -xzf "$tmp/$asset" -C "$tmp"
source="$(find "$tmp" -type f -path '*/apps/server/src/index.js' -print -quit)"
[[ -n "$source" ]] || { echo 'install: release archive has no server bundle' >&2; exit 1; }
# The bundle loads pty.node, the drizzle migrations, and the web assets from
# paths relative to index.js, so the whole archive tree must stay intact.
tree="${source%/apps/server/src/index.js}"
rm -rf "$lib_dir.new" "$lib_dir.prev"
mv "$tree" "$lib_dir.new"
[[ ! -d "$lib_dir" ]] || mv "$lib_dir" "$lib_dir.prev"
mv "$lib_dir.new" "$lib_dir"
node_bin="${FORGE_NODE:-$(command -v node || true)}"
[[ -n "$node_bin" ]] || { echo 'install: node not found on PATH' >&2; exit 1; }
# systemd has no login PATH; bake the resolved node into the wrapper.
cat > "$bin_dir/forge" <<EOF
#!/usr/bin/env bash
exec "$node_bin" "$lib_dir/apps/server/src/index.js" "\$@"
EOF
chmod 755 "$bin_dir/forge"
install -m 644 "$root/forge.service" "$root/forge-update.service" "$root/forge-update.timer" "$unit_dir/"
install -m 755 "$root/forge-update" "$bin_dir/forge-update"
systemctl --user daemon-reload
systemctl --user enable --now forge.service forge-update.timer
loginctl enable-linger "$USER"
