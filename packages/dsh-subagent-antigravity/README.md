# dsh-subagent-antigravity

One-shot [Antigravity CLI](https://antigravity.google) (`agy`) subagent provider for DeepSeek Harness.

Enabling this bundle registers the provider `antigravity` on `ctx.subagents` and adds the global
tool `subagent_antigravity` to every Agent. Delegating starts a fresh `agy --print` process in the
delegating session's workspace and returns only the final answer or a safe failure diagnostic.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `antigravity` | Registry name on `ctx.subagents`; unique per mounted instance |
| `command` | `agy` (`$AGY_BIN`, `~/.local/bin/agy`) | Antigravity CLI executable |
| `model` | native `agy` default | Optional `--model` override, e.g. `gemini-3.8-flash-high` |
| `effort` | native default | Optional reasoning effort (`low`/`medium`/`high`/`xhigh`/`max`) |
| `mode` | `auto` | Native execution mode: `accept-edits`, `auto`, or `plan` |
| `sandbox` | `true` | Pass `--sandbox` (terminal restrictions) |
| `dangerouslySkipPermissions` | `false` | Pass `--dangerously-skip-permissions`; requires explicit choice |
| `timeoutSeconds` | `0` | `--print-timeout`; `0` waits for the turn to finish |
| `logDir` | OS temp dir | Directory for `--log-file`, keeping `~/.gemini` writes out of the picture |
| `env` | `{}` | Extra child environment entries |

Authentication and account state stay native to Antigravity (`~/.gemini/antigravity-cli`); this
bundle never creates, copies, or rewrites credentials.

## Behavior

- One fresh `agy` process, one turn, one JSON result per delegation — no continuation or resume.
- `--output-format json` documents are parsed for `status` / `response` / `error`.
- `SUCCESS` with a non-empty answer settles as `completed`; everything else settles as `error`
  with a diagnostic limited to 4096 bytes; cancellation settles as `aborted`.
- `agy` logs go to `logDir`, so the provider never needs write access to the user's home directory.

## Notes

The JSON contract is Antigravity CLI's own (no official SDK). Re-verify it after upgrading `agy`.
