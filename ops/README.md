# Forge host rollout

Run `ops/install.sh` once on each host: `yiin-lt`, `main-laptop`, and `travel-laptop`.

Forge listens on port `3900`. Existing Caddy and tailnet routing already use that port.
The release tree lives in `~/.local/lib/forge`; `~/.local/bin/forge` is a wrapper
that execs node on the server bundle (the bundle loads `pty.node`, migrations,
and web assets relative to itself, so the tree must stay intact).
The 15-minute user timer checks GitHub releases and skips active epic runs.
It verifies checksums and restores the previous tree if health does not recover.

## Local no-release rollout

Use this path to build and install the current checkout without creating a release.
Run it from the repository root. Set `stage` to a temporary directory first.

```bash
stage="$(mktemp -d)/forge"
mkdir -p "$stage/apps/server/src" "$stage/apps/drizzle" "$stage/web"
(cd apps/web && bunx vite build)
bun build --target=node apps/server/src/index.ts --outfile dist/forge-server.js
cp dist/forge-server.js "$stage/apps/server/src/index.js"
cp apps/server/package.json "$stage/apps/server/package.json"
cp -R apps/server/drizzle/. "$stage/apps/drizzle/"
cp -R apps/web/dist/. "$stage/web/"
mkdir -p "$stage/apps/server/src/build/Release"
cp apps/server/node_modules/node-pty/build/Release/pty.node "$stage/apps/server/src/build/Release/"
if [ -f apps/server/node_modules/node-pty/build/Release/spawn-helper ]; then
  cp apps/server/node_modules/node-pty/build/Release/spawn-helper "$stage/apps/server/src/build/Release/"
fi
rm -rf "$HOME/.local/lib/forge.new"
rm -rf "$HOME/.local/lib/forge.prev"
mv "$stage" "$HOME/.local/lib/forge.new"
if [ -d "$HOME/.local/lib/forge" ]; then
  mv "$HOME/.local/lib/forge" "$HOME/.local/lib/forge.prev"
fi
mv "$HOME/.local/lib/forge.new" "$HOME/.local/lib/forge"
systemctl --user restart forge.service
curl -fsS http://127.0.0.1:3900/api/health
```

If health fails, restore the previous tree and restart the service.

```bash
rm -rf "$HOME/.local/lib/forge.failed"
mv "$HOME/.local/lib/forge" "$HOME/.local/lib/forge.failed"
mv "$HOME/.local/lib/forge.prev" "$HOME/.local/lib/forge"
systemctl --user restart forge.service
```
