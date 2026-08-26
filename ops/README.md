# Forge host rollout

Run `ops/install.sh` once on each host: `yiin-lt`, `main-laptop`, and `travel-laptop`.

Forge listens on port `3900`. Existing Caddy and tailnet routing already use that port.
The hourly user timer checks GitHub releases and skips active epic runs.
It verifies checksums and restores the previous binary if health does not recover.
