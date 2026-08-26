# ACP adapter capability matrix

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
