# dsh-subagent-workbuddy

One-shot WorkBuddy subagent provider for DeepSeek Harness.

WorkBuddy has no dedicated CLI: its desktop app bundles the CodeBuddy agent CLI
(`codebuddy`, also on npm as `@tencent-ai/codebuddy-code`). This bundle registers
the provider `workbuddy` on `ctx.subagents` and adds the global tool
`subagent_workbuddy` to every Agent. Delegating starts a fresh
`codebuddy --print` process in the delegating session's workspace and returns only
the final answer or a safe failure diagnostic.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `workbuddy` | Registry name on `ctx.subagents`; unique per mounted instance |
| `command` | auto | Executable; falls back to `$CODEBUDDY_BIN`, `$WORKBUDDY_BIN`, then `~/.local/bin`, nvm, Homebrew, and the copy bundled in `WorkBuddy.app` |
| `model` | native default | `--model`, e.g. `deepseek-v4-pro`, `kimi-k3.1-pro`, `glm-5.3` |
| `fallbackModel` | native default | `--fallback-model` when the default is overloaded |
| `permissionMode` | `auto` | `acceptEdits` / `auto` / `plan` / `dontAsk` / `bypassPermissions` / `default` |
| `dangerouslySkipPermissions` | `false` | Pass `-y` |
| `maxTurns` | `0` | `--max-turns`; `0` keeps the CLI default |
| `addDir` | `[]` | Extra directories passed through `--add-dir` |
| `env` | `{}` | Extra child environment entries |

Authentication and account state stay native to the CLI (`~/.codebuddy`); this
bundle never creates, copies, or rewrites credentials.

## Behavior

- One fresh `codebuddy --print --output-format json` process per delegation.
- The JSON array's terminal `type: "result"` message settles the run:
  `subtype: "success"` with `is_error: false` and a non-empty `result` completes
  it; anything else is an `error` with a diagnostic limited to 4096 bytes.
- Cancellation settles as `aborted`; teardown escalates SIGTERM → SIGKILL.

## Notes

The JSON contract is the CLI's own (it mirrors the Claude Code result shape), so
re-verify it after upgrading `@tencent-ai/codebuddy-code` or WorkBuddy.
