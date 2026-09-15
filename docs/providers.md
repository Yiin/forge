# Provider routes and validation

Forge uses direct native adapters for Claude, Codex, Pi, OpenCode, Kimi, and Cursor.
Grok, Gemini, Devin, Hermes, and explicit custom ACP entries use the dedicated ACP runtime.
PTY entries retain their terminal route. Native failures never fall back to ACP.
Provider instance IDs remain stable through configuration conversion.

## Supported boundaries

Native adapters retain their provider, account, workspace, and original session binding during resume.
A failed resume does not start a replacement conversation.
Each adapter advertises its supported model controls, images, steering, and request types.
Unsupported operations fail explicitly. A provider label alone does not promise every operation.

The dedicated ACP runtime owns its journal, artifacts, filesystem access, terminals, and request callbacks.
Load requires the provider's advertised support. Gemini's dedicated profile does not support load.
ACP runtimes retire after 256 roots or 24 hours.
Load-capable profiles resume the saved binding after original cleanup finishes.
Profiles without load support stop with an explicit resume error.
Selected accounts are unsupported for Devin and custom ACP profiles.
Grok questions use its original question protocol. Generic tool approvals do not become questions by guessing tool names.
Plans remain progress events and do not create approval requests.

Browser request routes use `NativeInteractions` for both native and dedicated ACP handles.
Reload retains request state. A server restart expires old callbacks and keeps their durable rows visible.
A reply cannot restore an expired callback.

## Discovery

The harness Test action reports native entries as unverified without a selected account.
Use account model refresh for native catalog discovery.
Custom ACP executable presence also remains unverified. It does not prove protocol support or authentication.
Dedicated first-party ACP discovery uses provider-specific checks; authentication remains unknown.
Discovery does not create a persisted provider conversation.

## Validation and packaging

Synthetic peers exercise production Node routes, native wire replies, images, steering, and exact resume bindings.
These tests do not prove live credentials, remote models, billing, or every installed provider version.
The browser fixtures use isolated data directories and account homes.

`bun run package:release` bundles the server, web assets, migrations, native terminal binary, Kimi guardian, and Cursor sidecar.
The package retains provider and dependency notices.
`bun run smoke:packed-native` checks the package outside the checkout with synthetic peers.
It verifies a synthetic Claude turn, exact original resume binding, and a second turn after restart.
It loads the packaged terminal addon and Cursor modules without calling SDK methods.
This proves asset loading, not a live Cursor run or terminal execution.
The smoke joins each original server shutdown and keeps evidence when a check or cleanup fails.
The integration coordinator reruns this smoke after the final merge.
