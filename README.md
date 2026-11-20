# opencode-sol-pi

An OpenCode V2 plugin providing context- and tool-efficiency mechanisms for long-running coding sessions. It implements four independent mechanisms:

| Mechanism | Config key | What it does |
|---|---|---|
| **ActionFusion** | `actionFusion` | Adds an optional `then_run` field to `edit`/`write` so a follow-up bash command can run in the same fused mutation. |
| **ObservationPack** | `observationPack` | Replaces large tool results in the outgoing context with a placeholder + paged `obs_recall`, keeping exact artifacts for recall. |
| **EvidencePreservingReducer** | `evidencePreservingReducer` | Reduces oversized diagnostic `bash` output (and fused `then_run` output) to a verified evidence receipt backed by an on-disk archive. |
| **Online Context Compact** | `onlineContextCompact` | Registers `update_plan` and can compact context at economical completed-step boundaries, then resume the parent task. |

Every mechanism is **off by default** and fails open: a malfunctioning mechanism must never prevent the agent from observing its work.

## Install / load

Add the plugin to your OpenCode config (global or project). A local checkout works as a path, or use a published package name when available:

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "opencode-sol-pi",
      "options": {
        "actionFusion": true,
        "observationPack": true
      }
    }
  ]
}
```

A local checkout can also be referenced by absolute path:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-sol-pi"]
}
```

## Configuration

`loadSolPiConfig` resolves configuration in this order (later does not override earlier except `ctx.options` overlays file config as documented below):

1. `ctx.options` (plugin options object in OpenCode config).
2. `sol-pi.json` in `<project>/.opencode/` if present (project config **replaces** global file config).
3. `sol-pi.json` in the OpenCode config home (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`).

Project config replaces (and is not merged with) the global file; plugin `options` are then applied on top. Unknown keys are fatal.

```jsonc
// .opencode/sol-pi.json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerModel": "gpt-5.6-luna",
  "evidencePreservingReducerProvider": "openai-codex",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

`cacheWriteReadRatio` models the relative price of cache writes to cache reads for Online Context Compact's economics (default `12.5`).

## Runtime storage

Large observations, reducer archives/journals/receipts, and online-compaction state live under a per-session runtime root in the OS temp directory:
`opencode-sol-pi-<session-id>-<random>/`. This keeps bulky artifacts out of the model context while remaining reachable for recall/readback.

## Notes and limitations

- **Reducer model call.** The evidence reducer uses `ctx.experimental.generate.text`. Provider/model availability depends on the host environment and configuration.
- **Compaction projection.** Online Context Compact estimates archive/removable context from available hook data; it does not have access to internal cut-point projection helpers.
- **Nested/codemode tool calls.** `then_run` is not attached to edit/write tools when invoked through codemode script execution paths.
- **Tests.** Dependency-free pure logic tests can be run with `bun test` in this package.

## Development

```bash
cd opencode-sol-pi
bun install
bun test
bun run typecheck
```

## License

MIT — see [`LICENSE`](LICENSE).
