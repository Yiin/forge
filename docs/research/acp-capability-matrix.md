# ACP adapter capability matrix

## Models, modes, and effort

Checked on 2026-08-29 with raw JSON-RPC over piped stdio. The probe used the
default Forge commands and a temporary session in the Forge checkout. The
adapter versions are the versions returned by `initialize`.

| Adapter | Version | availableModels | availableModes | Effort signal |
| --- | --- | --- | --- | --- |
| Claude Code ACP | 0.16.2 | `default`, `sonnet`, `haiku`, `opus[1m]` | `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` | No effort mode. |
| Codex ACP | 0.16.0 | No `models.availableModels` in the response. `configOptions.model`: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2` | `read-only`, `auto`, `full-access` | `configOptions.reasoning_effort`: `low`, `medium`, `high`, `xhigh`. |
| Kimi | 0.34.0 | `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`, `kimi-code/k3`, `kimi-code/k3-256k` | `default`, `plan`, `auto`, `yolo` | `configOptions.thinking`: `low`, `high`, `max`. |
| Grok | 1.0.13 | Initialize metadata lists `grok-4.6` and `grok-4.5` | No modes reported | Model metadata reports reasoning effort. `grok-4.6`: `low`, `medium`, `high`, `xhigh`; `grok-4.5`: `low`, `medium`, `high`. |
| Pi ACP | 0.0.33 | Not available. `session/new` required authentication. | Not available. `session/new` required authentication. | No probe result. Forge currently passes CLI `--thinking`. |

Claude Code, Codex, Kimi, and Grok completed `initialize`. Claude Code,
Codex, Kimi, and Grok returned `session/new` responses or session metadata.
Pi initialized, but its unauthenticated `session/new` returned an authentication
error before it could expose session options. Grok's `session/new` also needed
authentication, so its model data came from `initialize` metadata.

ACP 0.4.x has no effort field in `session/new`, `session/set_model`, or
`session/set_mode`. The typed requests contain `cwd` and `mcpServers` for a
new session, `modelId` for `set_model`, and `modeId` for `set_mode`. Adapter
specific `configOptions` are response data, not a shared ACP request field.

### Recommendation

- Claude Code: expose ACP modes only for permission behavior. Skip effort.
- Codex: add a future ACP config-option bridge for `reasoning_effort`; do not
  respawn for the session-scoped setting.
- Kimi: add a future ACP config-option bridge for `thinking`; do not respawn.
- Grok: use respawn with a changed `--effort` argument. Its effort is CLI-only
  in Forge, and no ACP mode was reported.
- Pi: use respawn with a changed `--thinking` argument after authentication.
  Do not expose a picker until an authenticated probe confirms a session API.

The existing account-scoped effort overlay remains correct for Grok, Pi, and
OpenCode. A future per-session effort control should first model the adapter's
config option or CLI argument. It should not send an invented `effort` field.

Checked on 2026-08-26 with raw JSON-RPC over piped stdio. The probe used the
default Forge commands and a temporary session in the Forge checkout.

| Adapter | initialize and auth | AskUserQuestion | Subagent | Overlap and cancel | Pipe and command |
| --- | --- | --- | --- | --- | --- |
| Claude Code ACP | Not live-tested. `@zed-industries/claude-code-acp` resolves to `0.16.2`, but `npx --yes @zed-industries/claude-code-acp` did not start during the probe window. | No signal captured. | No signal captured. | No live result. | Default: `npx --yes @zed-industries/claude-code-acp`. The configured command omits `--yes`; pin `0.16.2` after a working install check. |
| Codex ACP | Live initialize returned `loadSession: true`, image and embedded-context support, no audio, `list/resume/close` sessions, and auth methods `chatgpt`, `codex-api-key`, `openai-api-key`. Agent version `0.16.0`. `authenticate(chatgpt)` returned `{}`. | No signal before the probe timed out. | No signal before the probe timed out. | Prompt did not settle within 12 seconds. No cancel result. | Piped stdio worked through the cached binary. Default: `npx --yes @zed-industries/codex-acp`, package version `0.16.0`. |
| Kimi | Live initialize returned `loadSession: true`, image and embedded-context support, no audio, `list/resume/close/delete/fork`, and terminal auth method `login`. Agent version `0.34.0`. `authenticate(login)` returned `{}`. | Captured `session/update` with `toolCallUpdate: Asking user questions`, `kind: other`, `rawInput.questions`. A matching `session/request_permission` carried `toolCall.title: AskUserQuestion` and options. | Captured `session/update` with `toolCallUpdate`, title `Launching explore agent: Subagent capability check`, `kind: other`, and `rawInput.subagent_type: explore`. | The prompt stayed active after tool calls and timed out at 12 seconds. No reliable cancel result. Test again with a longer wait and a controlled prompt. | Piped stdio worked. Default: `kimi acp`. |
| Gemini CLI | `gemini` was absent from `PATH`, so no initialize response exists. | No signal captured. | No signal captured. | No live result. | Default: `gemini --experimental-acp`. |

The Kimi AskUserQuestion payload was:

```json
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "title": "Asking user questions",
      "kind": "other",
      "rawInput": {"questions": [{"header": "Task", "question": "What would you like me to work on in this session?", "options": [{"label": "A demo task"}, {"label": "Nothing, just testing"}, {"label": "Pick ready beads work"}]}]}
    }
  }
}
```

The matching Kimi request used `method: "session/request_permission"`,
`toolCall.title: "AskUserQuestion"`, and one `allow_once` option per answer.

The Kimi subagent payload had `title: "Launching explore agent: Subagent capability check"`,
`kind: "other"`, and `rawInput.subagent_type: "explore"`.

These results support capability gating from initialize responses. They do not
support a shared overlap or cancel policy for the four adapters yet.
