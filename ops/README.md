# Forge host rollout

Run `ops/install.sh` once on each host: `yiin-lt`, `main-laptop`, and `travel-laptop`.

Forge listens on port `3900`. Existing Caddy and tailnet routing already use that port.
The release tree lives in `~/.local/lib/forge`; `~/.local/bin/forge` is a wrapper
that execs node on the server bundle (the bundle loads `pty.node`, migrations,
and web assets relative to itself, so the tree must stay intact).
The 15-minute user timer checks GitHub releases and skips active epic runs.
It verifies checksums and restores the previous tree if health does not recover.
