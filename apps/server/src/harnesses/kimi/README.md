# Native Kimi adapter

This adapter targets Kimi Code 0.34.0 at `f0614c53e59f7e1e257412063b059b9eb82764cf`.
The production factory does not select it.

Build its guardian with `bun run build:kimi-guardian` before local use.
The release workflow stages that bundle beside the server entry point.
The guardian runs under Node 24, outside the native process group.
It holds the permanent account-home lock until native process-group cleanup is proved.

`index.ts` exports `createKimiHost`, `createKimiAdapter`, `discoverKimi`, and `readKimiHistory`.
Create one host for each backend lifetime and reuse it across adapter replacements.
Supply the selected account, harness, environment, and configured-native credential policy as immutable authority.
One canonical home can serve several sessions with separate workspace paths.
Native resident-session charges remain until the shared native server stops.

The adapter requires `readState`, `commitRecords`, and `storeAttachment`.
The record sink must atomically compare the expected ordinal and checkpoint, then commit records and the event outbox.
Each new ordinal equals the expected ordinal plus one.
The sink returns `disposition: 'committed'` for a new batch and `disposition: 'replayed'` for an identical durable retry.
Each batch carries `contentHash`. The sink rejects conflicting bytes.
When `replayOnly` is true, the sink must find the original batch. It must not create a new batch.
An identical retry returns its original ordinal without replaying events or moving the checkpoint backward.
Checkpoint `transcriptStores` bind each agent sequence to its native transcript store incarnation.
Restore unresolved request records and proved native owners. A new store does not inherit old live owners.
The attachment sink must preserve immutable bytes before their referencing record commits.
The attachment loader must authorize the requested Forge session and attachment ID before returning bytes.

Keep receipt acceptance, delivery, and completion separate.
Completion requires native terminal evidence and the committed final-content barrier.
Native steering adds a user message without exposing its prompt ID bridge.
Proved steering delivery remains available. Missing final-content identity fails Forge completion with `kimi_final_content_unavailable`.
The adapter preserves earlier content and distinct native terminal records.
Reply methods await their committed native outcome.
Unknown mutation results never cause an automatic retry.

Stored `projection.snapshot`, `projection.removal`, and `projection.unavailable` records control the visible native subtree.
Their payloads contain visible record IDs, removed record IDs, and unavailable record IDs.
Resolve visible IDs to immutable native records and return the committed ordinal through `KimiProjectionSnapshot`.
The later storage and session-factory consumers must publish and apply this replacement.
The event timeline alone cannot remove tools, attachments, or native interaction rows.

Main message history loads the full native journal inside Kimi.
HTTP page sizes do not bound that native allocation.
Child message and media history can remain partial even when a child terminal outcome is proved.
Cold display ordinals never replace live engine turn identities.

All numeric ceilings are in `limits.ts`. Overrides can only lower them.
The 1 MiB text and 1 MiB encoded prompt limits intersect. JSON escaping and attachments consume encoded envelope space.
The adapter validates known input before loaders and checks uploaded file IDs before dispatch.
`homeWaiters` and `httpQueue` remain zero.
The approved schema exception uses depth 64 only for owned startup reads of the two captured schema routes.
Ordinary HTTP, WebSocket, IPC, history, and stored data keep depth 32.
The captured OpenAPI document has depth 42. Its exact bytes and hashes remain in `__fixtures__`.
The formatter ignores only the two exact captured schema paths. Fixture tests verify their hashes and parsed content.

Owned JSON responses retain the 8 MiB ceiling. Raw file responses retain the 16 MiB ceiling.
The guardian sends one bounded 64 KiB chunk at a time through JSONL envelopes.
The parent checks length, digest, encoding, and envelope shape before publication.
The guardian releases its JSON blob before the parent decodes or parses it.
For response ceiling `R` and encoded request size `P`, JSON operations reserve `3R + 3P` HTTP storage before admission.
Insufficient shared capacity refuses the operation without lowering its requested response ceiling.
Parsed JSON temporarily reserves twice its encoded response bytes from `hostRetainedBytes`.
These charges bound owned encoded values and conservative string storage. They do not measure total process RSS.
Cancellation retains physical buffer, callback, socket, and process charges until release is proved.
The parent reserves guardian IPC, retained-value, and timer shares before process startup.

Tests use owned synthetic homes, processes, HTTP routes, and WebSocket peers.
They do not test real authentication, billing, model execution, or provider history continuity.
The permanent lock registry is cooperative. Process-group cleanup does not contain helpers that deliberately leave that group.
See `NOTICE.md` for source attribution.
