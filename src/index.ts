/*
 * opencode-sol-pi — native OpenCode V2 port of the SoL-Pi Pi extension.
 *
 * Four opt-in efficiency mechanisms, all disabled by default:
 *   - Action Fusion: edit/write with an optional `then_run` validation command.
 *   - ObservationPack: large tool results become paged, content-addressed handles.
 *   - Evidence-Preserving Reducer: verified reduction of long diagnostic logs.
 *   - Online Context Compact: compact at completed plan boundaries when
 *     economical, then resume the parent task in a new turn.
 */
import { Plugin } from "@opencode/plugin"
import { loadSolPiConfig } from "./config.ts"
import { registerActionFusion } from "./action-fusion.ts"
import { registerObservationPack } from "./observation-pack/index.ts"
import { registerEvidencePreservingReducer } from "./evidence-reducer/index.ts"
import { createOnlineContextCompact } from "./online-compact/index.ts"

export default Plugin.define({
  id: "sol-pi",
  setup(ctx) {
    const directory = (ctx.location?.directory as string | undefined) ?? process.cwd()
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const config = loadSolPiConfig(directory, options)

    const cleanups: Array<() => void> = []
    const guard = (name: string, register: () => void | (() => void)) => {
      try {
        const cleanup = register()
        if (typeof cleanup === "function") cleanups.push(cleanup)
      } catch (error) {
        console.error(`[sol-pi] failed to register ${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (config.actionFusion) {
      guard("Action Fusion", () => registerActionFusion(ctx, directory))
    }
    if (config.observationPack) {
      guard("ObservationPack", () => registerObservationPack(ctx))
    }
    if (config.evidencePreservingReducer) {
      guard("Evidence-Preserving Reducer", () =>
        registerEvidencePreservingReducer(ctx, {
          reducerModel: config.evidencePreservingReducerModel,
          reducerProvider: config.evidencePreservingReducerProvider,
        }),
      )
    }
    if (config.onlineContextCompact) {
      guard("Online Context Compact", () =>
        createOnlineContextCompact({ cacheWriteReadRatio: config.cacheWriteReadRatio })(ctx),
      )
    }

    return () => {
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          // best effort
        }
      }
    }
  },
})

export type { SolPiConfig } from "./config.ts"
export { DEFAULT_CONFIG, DEFAULT_CACHE_WRITE_READ_RATIO } from "./config.ts"
