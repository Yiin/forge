# Harness model and reasoning matrix

Research date: 2026-08-29. Probes used ACP JSON-RPC over stdio.
Each probe used a 15,000 ms timeout and an absolute `/tmp` working directory.
Raw replay captures are in [`spike/`](../spike/).

## Summary

| Harness | Model discovery | Reasoning option | Set call | Context-window knob | Fallback |
|---|---|---|---|---|---|
| claude-code-acp | Yes, `session/new` `models.availableModels` | None in ACP; `_meta.claudeCode.options.effort` | No ACP config method | Model id suffix `[1m]` | ACP model list; effort in `_meta` |
| codex-acp | Could not verify; probe timed out | `configOptions` reported by binary scan, not live | `session/set_config_option` reported by binary scan, not live | `model_context_window` in rollout | Probe after auth; no model picker until then |
| kimi | Yes, `session/new` `configOptions[id=model]` | `thinking`, `low | high | max` | Raw `session/set_config_option` | No live field | ACP config options |
| gemini | No, command not installed | Could not verify | Could not verify | Could not verify | Hide picker |
| opencode | Yes, `session/new` `configOptions[id=model]` | No live thought option | No live thought option | Not advertised | ACP model config option |
| grok | Yes, `initialize._meta.modelState.availableModels` | Spawn metadata, `reasoningEfforts` | ACP set call not advertised | Model metadata `totalContextTokens: 500000` | Spawn args and model metadata |
| pi | Could not verify; session requires authentication | Could not verify | Could not verify | Could not verify | Probe after auth; hide picker until then |

The recommended source values are `acp`, `static`, `custom`, and `none`.

## claude-code-acp

Command: `npx @zed-industries/claude-code-acp`.

The raw capture is [`spike/claude-acp.ndjson`](../spike/claude-acp.ndjson).
`initialize` returned `agentInfo.version: "0.16.2"`.
`session/new` returned `models.availableModels` with `default`, `opus`, `opus[1m]`, and `haiku`.
The response set `currentModelId` to `default`.

The probe sent this request field:

```json
{"_meta":{"claudeCode":{"options":{"effort":"high","model":"opus[1m]"}}}}
```

The adapter accepted `session/new` and returned the model list.
The capture does not prove that a later turn used the requested effort.
The adapter returned `-32603 Method not implemented` for `authenticate`.
The adapter has no live `configOptions` or `config_option_update` evidence.

Strategy: use the ACP model list from a throwaway `session/new` probe.
Send Claude effort and model overrides in `_meta.claudeCode.options`.
Treat `[1m]` as a model id returned by the adapter, not a local suffix.

## codex-acp

Command: `npx @zed-industries/codex-acp`.

The live probe did not produce a response within 15,000 ms.
It was stopped after `initialize` failed to complete.
The installed binary is `codex-acp 0.16.0`.

Static inspection found `SetSessionConfigOptionRequest`, `SessionConfigOption`,
`SessionConfigSelectGroup`, `session/set_config_option`, `modes`, and
`configOptions`. It found no `availableModels`, `currentModelId`, or
`session/set_model` strings. These are binary facts, not live response facts.

Strategy: do not expose a model picker from the current ACP client.
Add a later authenticated probe or a Codex-specific CLI catalog.
Use raw `session/set_config_option` after an ACP schema upgrade.
Read context from rollout `token_count` events.

## kimi

Command: `kimi acp`. Raw capture: [`spike/kimi-acp.ndjson`](../spike/kimi-acp.ndjson).
The adapter returned `Kimi Code CLI 0.34.0`.

The live `session/new` response included these options:

```json
{"type":"select","id":"model","category":"model","currentValue":"kimi-code/k3-256k","options":["kimi-code/kimi-for-coding","kimi-code/kimi-for-coding-highspeed","kimi-code/k3","kimi-code/k3-256k"]}
{"type":"select","id":"thinking","category":"thought_level","currentValue":"high","options":["low","high","max"]}
```

The probe sent raw `session/set_config_option` for `thinking`.
The adapter returned success with an empty object.
No `config_option_update` notification appeared before shutdown.

Strategy: cache the model select option from an on-demand ACP probe.
Use `thinking` as the generic reasoning option id.

## gemini

The configured command is `gemini --experimental-acp`.
`command -v gemini` returned no path on this machine.
No live JSON exists to capture.

Strategy: use `none` and hide model and reasoning controls until a probe succeeds.

## opencode

Command: `opencode acp`. Raw capture: [`spike/opencode-acp.ndjson`](../spike/opencode-acp.ndjson).
The adapter returned `OpenCode 1.18.25`.

The live `session/new` response included a model select option.
It contained `opencode/big-pickle` and ten other model values.
It also included a `mode` select option with `build` and `plan`.
It did not include a `thought_level` option.

Strategy: cache the `category: "model"` select from an on-demand ACP probe.
Do not show a reasoning pill until a future adapter exposes one.

## grok

Command: `grok agent stdio`. Raw capture: [`spike/grok-acp.ndjson`](../spike/grok-acp.ndjson).
The live `initialize` response put model data in `_meta.modelState`.
It returned `grok-4.6` and `grok-4.5`.
Each model reported `totalContextTokens: 500000`.
Each model reported reasoning effort values in its metadata.

The ACP response did not advertise `session/set_model` or config options.
Grok's configured model and effort are spawn arguments.

Strategy: use the spawn-argument path and parse `_meta.modelState` when available.
Use `static` or `custom` catalog entries when the metadata is absent.

## pi

Command: `npx -y pi-acp`. The installed adapter was `pi-acp 0.0.33`.
Raw capture: [`spike/pi-acp.ndjson`](../spike/pi-acp.ndjson).

`initialize` returned a terminal login method.
`session/new` returned `-32000 Authentication required`.
No models or config options were returned.

Strategy: use `none` until an authenticated probe succeeds.
Do not create a fake static model list.

## ACP dependency decision

Forge uses `@zed-industries/agent-client-protocol@0.4.5`.
The npm release list ends at `0.4.5` on this research date.
That package has no `configOptions`, `session/set_config_option`, or
`config_option_update` types. Therefore no published npm version currently
ships the required surface. Do not bump the dependency in this epic.

The first future package containing the ACP config-option schema must be named
when it is published. A bump will require changes in `apps/server/src/acp/client.ts`
for request and response types, and in `apps/server/src/acp/normalize.ts` for
`config_option_update` notifications. It may also change `Stream` method names,
request parameter types, and exhaustive update handling. Keep that work in a
separate dependency-upgrade child.

## Proposed Forge protocol shape

```ts
type ModelSource = 'acp' | 'static' | 'custom' | 'none'

type HarnessModel = {
  id: string
  displayName: string
  description?: string
  isDefault?: boolean
  source: ModelSource
}

type HarnessModelCatalog = {
  accountId: string
  harnessKey: string
  models: HarnessModel[]
  source: ModelSource
  fetchedAt: number
}
```

`description` is optional because several adapters omit it.
`isDefault` is optional because ACP uses a current id, not a default flag.
The server can derive `isDefault` from the adapter's current id.
`source: "none"` represents an intentional empty catalog.

## Probe policy and reference patterns

A throwaway `session/new` starts a real agent process with the account's
credential home. It can consume quota and can refresh provider state.
The probe is acceptable only on explicit demand or account creation.
Do not run real probes at server boot. Cache successful results and keep the
15,000 ms timeout. On timeout or auth failure, retain the last catalog and
return an empty result for a first probe.

The t3code Cursor provider shows the right timeout, warning, and empty-result
fallback around an ACP probe. Its Claude provider shows a static catalog.
Its Codex provider shows CLI parsing, preferred defaults, and custom slugs.
Forge should copy those failure and fallback rules while keeping the protocol
shape above.
