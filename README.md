# opencode-sol-pi

A native **OpenCode V2** plugin port of [SoL-Pi](https://github.com/NVlabs/SoL-Pi), the standalone set of
context- and tool-efficiency mechanisms originally written as a Pi coding-agent extension. Four
mechanisms reduce repeated model turns, context replay, oversized observations, and long-log reading
without skipping verification or hiding evidence. **Every mechanism is opt-in and disabled by default.**

This is a clean-room rewrite against the OpenCode V2 plugin SDK (`@opencode/plugin`). It does not
import `@earendil-works/pi-*`, `typebox`, or any Pi runtime package, and it keeps upstream untouched.

## What it does

| Mechanism | Behavior |
|---|---|
| **Action Fusion** | Adds an optional `then_run` field to OpenCode's built-in `edit` and `write` tools. After a successful mutation, the follow-up command runs through OpenCode's `bash` tool and both observations are returned in one tool result. A failing command is reported with `[then_run:failed]` but keeps the edit/write. |
| **ObservationPack** | Large (>10 KiB) pure-text tool results are sent in full for the first two provider requests, then replaced in the outgoing context with a stable placeholder. Originals are archived by content hash and recalled exactly with the `obs_recall` tool (paged by byte offset). Stored history is never edited. |
| **Evidence-Preserving Reducer** | For long diagnostic-log commands (`pytest`, `cargo test/build`, `npm test`, `make`, …), the raw log is archived and sent to a configured reducer model. The returned receipt is accepted only if its schema, source hash, status, and every byte-for-byte quote verify against the archive; otherwise the original output is left untouched. |
| **Online Context Compact** | A `update_plan` tool tracks plan steps. Completing a previously unfinished step marks a safe boundary; if compaction is economical (breakeven vs. remaining requests, cache-write/read ratio, cooldown) a native compaction is requested, then the parent task is resumed in a new turn. |

There is **no TUI part**: the original's savings notices are intentionally no-ops (`showSolPiSavings` is
empty), and its custom tool renderers only delegate to built-ins. All behavior lives in the server part.

## Load it

Add the package to `plugins` in `opencode.json(c)`. Pass options with the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-sol-pi",
      "options": {
        "actionFusion": true,
        "observationPack": true,
        "evidencePreservingReducer": false,
        "onlineContextCompact": false,
        "cacheWriteReadRatio": 12.5
      }
    }
  ]
}
```

A local checkout also works: `"package": "/absolute/path/to/opencode-sol-pi"`.

## Configuration

Effective configuration is, in order of precedence:

1. `options` on the plugin entry in `opencode.json(c)` (the OpenCode-native path);
2. `sol-pi.json` in `<project>/.opencode/` if present (project config **replaces**, never merges with, global);
3. `sol-pi.json` in the OpenCode config home (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`);
4. built-in defaults (everything disabled).

The strict validation and schema are preserved from the original: unknown keys, a `version` other than
`1`, non-boolean feature flags, empty reducer provider/model strings, and a non-finite or negative
`cacheWriteReadRatio` are all fatal errors.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | `1` | Config schema version. |
| `actionFusion` | boolean | `false` | Enable fused `then_run` on `edit`/`write`. |
| `observationPack` | boolean | `false` | Enable paged archival of large tool results. |
| `evidencePreservingReducer` | boolean | `false` | Enable verified log reduction. |
| `evidencePreservingReducerProvider` | string | `openai-codex` | OpenCode provider ID used for the reducer model. |
| `evidencePreservingReducerModel` | string | `gpt-5.6-luna` | OpenCode model ID used for the reducer model. |
| `onlineContextCompact` | boolean | `false` | Enable plan-boundary compaction. |
| `cacheWriteReadRatio` | number ≥ 0 | `12.5` | Pricing input for the compaction breakeven decision only; not a bill estimate. |

The plugin reads no dedicated environment variables for features. Credentials and provider URLs stay
under OpenCode's control. The reducer uses OpenCode-managed authentication via `ctx.experimental.generate.text`.

## Storage and security

Archives are written under a private OS temp directory named
`opencode-sol-pi-<session-id>-<random>/` (shared by ObservationPack and the reducer). This mirrors the
original's `--no-session` fallback: the OpenCode V2 plugin API does not expose a session-scoped
filesystem directory, so exact-recall archives use temp storage and are retained after the session ends
for callers to read; cleanup follows the host's temp-file policy. Ledgers and journals are local JSONL
files under the same root and never enter model context.

The reducer treats the log as untrusted data and verifies every quotation before accepting a summary.
Do not enable remote reduction for logs that must remain local.

## Mapping from the Pi extension

| Pi API / concept | OpenCode V2 API used |
|---|---|
| `pi.registerTool` | `ctx.tool.transform(editor => editor.add(...) / editor.update(...))` |
| built-in `edit`/`write` definition helpers | transform OpenCode's existing `edit`/`write` tools; wrap their executors; delegate commands to the `bash` tool executor |
| `pi.on("context")` projection rewrite | `ctx.session.hook("context")` mutating message-part drafts |
| `pi.on("tool_result")` | `ctx.tool.hook("execute.after")` mutating the result draft |
| `pi.on("prompt" / "input")` | `ctx.session.hook("prompt")` |
| `context.compact()` + `pi.sendMessage({triggerTurn:true})` | `ctx.session.compact({delivery:"queue"})` + `ctx.session.prompt({delivery:"queue"})` |
| session custom entries / `appendEntry` | JSON files under the session runtime root; `ctx.storage` where a durable JSON value fits |
| `sol-pi.json` search order | `ctx.options` + project/global `sol-pi.json` in OpenCode config locations |
| Pi model registry + `pi-ai/compat` `complete()` | `ctx.experimental.generate.text` |
| Pi TUI renderers | none (not needed; savings announcements are silenced in the original) |

## Known gaps and adaptation notes

- **Archive location.** Files live in the OS temp directory instead of `<session-dir>/sol-pi/<id>/`
  because V2 plugins have no session-scoped directory. Recall still works within and across resumes of
  the same session id; temp cleanup policy controls eventual deletion.
- **Bash timeout units.** `then_run.timeout` is documented in seconds (as in the original); it is
  converted to milliseconds when passed to OpenCode's `bash` tool. If a future `bash` tool changes its
  unit, adjust that conversion.
- **Reducer call shape.** `ctx.experimental.generate.text` has no separate system prompt, stop-reason,
  or per-call timeout field. Instructions and the untrusted log are combined into one clearly delimited
  prompt; usage/stop-reason detail in the journal is reduced to what the API returns. Verification of
  the receipt itself is unchanged and still fail-closed.
- **Reducer model defaults.** The original defaults (`openai-codex` / `gpt-5.6-luna`) are Pi route
  names; set `evidencePreservingReducerProvider`/`Model` to valid OpenCode provider/model IDs before
  enabling the reducer.
- **Compaction projection.** Pi's `findCutPoint`/`buildSessionProjection` helpers are not public in V2,
  so the archivable token estimate uses the `context` hook's message drafts (keep the most recent
  `keepRecentTokens`, price the older non-system prefix). The context window size is also unavailable
  to V2 hooks, so economics-based compaction works but the absolute "window protection" branch is
  disabled.
- **Nested/codemode tool calls.** Pi's `parentToolCallId` marker for script-invoked tools has no V2
  equivalent in `execute.after`; those results may be considered for reduction/recall. The reducer is
  conservative (diagnostic-command filter, size caps, secret filter, byte-exact verification), so the
  practical effect is limited, but this is a behavioral difference.
- **Tests.** The original test suite depends on `@earendil-works/pi-*` packages and cannot be ported
  without reintroducing Pi dependencies. Only the dependency-free pure logic (config validation,
  plan parsing, economics decisions, receipt verification) is covered by the included `bun test` file.

## Development

```sh
bun install
bun run typecheck
bun test
```

## License

MIT — Copyright (c) 2026 hakergeniusz.
