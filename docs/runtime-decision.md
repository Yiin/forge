# Runtime decision

Date: 2026-08-25

The runtime spike uses Bun 1.3.9 and ACP 0.4.5.

## Results

- Embedded asset: pass in the source run. Bun's `text` import returns the HTML content.
- `node-pty`: pass in the initial source run. `bash -lc "echo pty-ok"` returned `pty-ok`.
- ACP handshake: pass in the initial source run. The server completed initialize, session/new, session/prompt, session/update, and `end_turn` with `fake-agent.ts`.
- Repeat source run: `node-pty` timed out before producing output. This is another reason to reject Bun for the production runtime.
- Compiled clean-directory run: fail at startup. Bun's compiled module filesystem does not contain `node-pty/prebuilds/linux-x64/pty.node`, which `node-pty` loads dynamically. The exact error was `Failed to load native module: pty.node ... Cannot find module './prebuilds/linux-x64//pty.node'`.

The chosen runtime is Node 24 with build-on-host. Bun single-binary is rejected because the clean-directory binary cannot load `node-pty`.

## Delivery build

```sh
bun build --target=node spike/server.ts --outfile dist/server.js
node dist/server.js
```

The delivery module must run the build on each host, then ship `node_modules/node-pty/prebuilds/linux-x64/pty.node` and `spawn-helper` beside the built server. It must also compile or ship each ACP harness executable. Do not assume `process.execPath` can run a source fixture in the release bundle.
