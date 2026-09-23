# Forge host rollout

Run `ops/install.sh` once on each host: `yiin-lt`, `main-laptop`, and `travel-laptop`.

Forge listens on port `3900`. Existing Caddy and tailnet routing already use that port.
The release tree lives in `~/.local/lib/forge`; `~/.local/bin/forge` is a wrapper
that execs node on the server bundle (the bundle loads `pty.node`, migrations,
and web assets relative to itself, so the tree must stay intact).
The 15-minute user timer checks GitHub releases and skips active epic runs.
It verifies checksums and restores the previous tree if health does not recover.

`ops/forge.service` sets no PATH, so Forge uses the PATH of the systemd user
manager. If that PATH lacks a host's harness CLIs, set PATH in a host drop-in.
`install.sh` never overwrites it. `yiin-lt` has one. Example:

```ini
# ~/.config/systemd/user/forge.service.d/path.conf
[Service]
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

Run `systemctl --user daemon-reload` and restart `forge.service` after you edit it.

## Local no-release rollout

Use this path to build and install the current checkout without creating a release.
Run it from the repository root. Set `stage` to a temporary directory first.

```bash
stage="$(mktemp -d)/forge"
bun run package:release "$stage"
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
