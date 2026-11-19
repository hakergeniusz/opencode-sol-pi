/*
 * Online Context Compact — completed plan steps become safe, economical
 * points for native compaction, and the parent task is resumed afterwards.
 *
 * OpenCode mapping:
 *  - `update_plan` is a normal registered tool (model-only / codemode:false).
 *  - `pi.on("context")` / request accounting → `ctx.session.hook("context")`.
 *  - `pi.on("input")` correction handling → `ctx.session.hook("prompt")`.
 *  - `pi.on("session_compact")` → `ctx.session.hook("compaction")`.
 *  - `context.compact()` + `pi.sendMessage({triggerTurn:true})` →
 *    `ctx.session.compact({delivery:"queue"})` + `ctx.session.prompt({delivery:"queue"})`,
 *    which preserves the "compact, then continue in a new turn" ordering.
 *  - persisted state moves from session custom entries to a JSON file under
 *    the session's runtime root.
 */
import type { PluginContext } from "../types.ts"
import { runtimeRoot } from "../runtime-paths.ts"
import {
  DEFAULT_COMPACTION_ECONOMICS,
  decideCompaction,
  type CompactionDecision,
} from "./economics.ts"
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts"
import { estimateMessageTokens, estimateProjectedCompactionTokens } from "./projection.ts"
import {
  appendOnlineState,
  recordBoundary,
  recordCompaction,
  recordCompletedPlanHandoff,
  recordCorrection,
  recordProviderRequest,
  restoreOnlineState,
  type OnlineState,
  type ProgressSummary,
} from "./state.ts"
import { registerOnlineTools } from "./tools.ts"

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000
export const BOUNDARY_COMPACTION_INSTRUCTIONS =
  "Preserve completed work, verification results, important decisions, and remaining work."
export const POST_COMPACTION_PLAN_REMINDER =
  "Online context compaction finished. The parent task is still active. " +
  "Continue the remaining work from the current plan. Preserve existing step IDs when updating progress."

export interface OnlineContextCompactOptions {
  readonly cacheWriteReadRatio?: number | null
  readonly keepRecentTokens?: number
}

interface Runtime {
  readonly root: string
  state: OnlineState
  observed: readonly unknown[]
  pendingBoundary: boolean
  compactionRefused: boolean
  lastContextTokens: number | null
  archiveTokens: number
  activeDebt: { debtTokens: number; repaymentTokens: number }
  continuationScheduled: boolean
}

function progressSummary(input: any, completedStepId: string): ProgressSummary | undefined {
  const step = input.steps?.find((item: any) => item.id === completedStepId)
  if (!step || !input.progress) return
  return {
    stepId: step.id,
    goal: step.goal,
    filesChanged: [...(input.progress.files_changed ?? [])],
    verification: [...(input.progress.verification ?? [])],
    decisions: [...(input.progress.decisions ?? [])],
    nextWork: input.steps.filter((item: any) => item.status !== "completed").map((item: any) => item.goal),
  }
}

function resolveKeepRecentTokens(value: number | undefined): number {
  const resolved = value ?? DEFAULT_KEEP_RECENT_TOKENS
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("Online Context Compact keepRecentTokens must be a positive safe integer")
  }
  return resolved
}

function resolveRatio(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Online Context Compact cacheWriteReadRatio must be finite and non-negative")
  }
  return value
}

export function createOnlineContextCompact(options: OnlineContextCompactOptions = {}) {
  const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens)
  const cacheWriteReadRatio = resolveRatio(options.cacheWriteReadRatio)

  return (ctx: PluginContext): void => {
    const runtimes = new Map<string, Runtime>()

    const getRuntime = async (sessionID: string): Promise<Runtime> => {
      let runtime = runtimes.get(sessionID)
      if (!runtime) {
        const root = runtimeRoot(sessionID)
        runtime = {
          root,
          state: await restoreOnlineState(root),
          observed: [],
          pendingBoundary: false,
          compactionRefused: false,
          lastContextTokens: null,
          archiveTokens: 0,
          activeDebt: { debtTokens: 0, repaymentTokens: 0 },
          continuationScheduled: false,
        }
        runtimes.set(sessionID, runtime)
      }
      return runtime
    }

    const save = (runtime: Runtime): void => {
      void appendOnlineState(runtime.root, runtime.state).catch((error) => {
        console.error(`[online-context-compact] state save failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const decide = (runtime: Runtime): CompactionDecision => {
      const contextTokens = runtime.lastContextTokens ?? 0
      const archiveTokens = runtime.archiveTokens
      const priced = decideCompaction({
        writeTokens: contextTokens,
        archiveTokens,
        memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
        contextTokens,
        completedBoundaryRequestCounts: runtime.state.completedBoundaryRequestCounts,
        remainingBoundaries: runtime.state.plan.filter((step) => step.status !== "completed").length,
        averageContextTokenIncrement:
          runtime.state.positiveContextDeltaCount === 0
            ? null
            : runtime.state.positiveContextDeltaTotal / runtime.state.positiveContextDeltaCount,
        // OpenCode V2 hooks do not expose the context-window size or the
        // session's cut-point projection; window protection is therefore
        // disabled here (see README "Known gaps").
        contextWindowTokens: null,
        priorCompactionCount: runtime.state.nativeCompactionCount,
        requestsSinceLastCompaction:
          runtime.state.lastCompactionRequestCount === null
            ? null
            : runtime.state.requestCount - runtime.state.lastCompactionRequestCount,
        carriedDebtTokens: runtime.state.cacheDebtTokens,
        cacheDebtRepaymentTokens: runtime.state.cacheDebtRepaymentTokens,
        cacheWriteReadRatio,
        economics: DEFAULT_COMPACTION_ECONOMICS,
      })
      return priced.compact && archiveTokens === 0
        ? { ...priced, compact: false, reason: "native_not_compactable" }
        : priced
    }

    registerOnlineTools(ctx, {
      updatePlan: async (input) => {
        const sessionID: string = input.sessionID
        const runtime = await getRuntime(sessionID)
        if (input.context?.signal?.aborted) throw new Error("Plan update was aborted")
        const steps = parsePlanSteps(input.steps)
        if (!steps || steps.length === 0) throw new Error("Plan must contain at least one valid step")

        const transition = analyzePlanTransition(runtime.state.plan, steps)
        const completedIds = transition.completedSteps.map((step) => step.id)
        if (completedIds.length > 0) {
          runtime.state = recordBoundary(
            runtime.state,
            steps,
            progressSummary(input, completedIds[0] ?? ""),
          )
          runtime.pendingBoundary = true
        } else {
          runtime.state = { ...runtime.state, plan: [...steps] }
        }
        save(runtime)

        if (runtime.pendingBoundary && !runtime.compactionRefused) {
          const decision = decide(runtime)
          if (decision.compact) {
            runtime.activeDebt = {
              debtTokens: decision.postCompactionTokens * (decision.incrementalCacheCostRatio ?? 0),
              repaymentTokens: Math.max(0, decision.archiveTokens - decision.memoTokens),
            }
            runtime.pendingBoundary = false
            try {
              await ctx.session.compact({ sessionID, delivery: "queue" })
            } catch (error) {
              runtime.activeDebt = { debtTokens: 0, repaymentTokens: 0 }
              console.error(`[online-context-compact] compaction request failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }

        return {
          content: [formatPlanSnapshot(steps), ...transition.advice].join("\n"),
          metadata: {
            boundary: completedIds.length > 0,
            completed_step_ids: completedIds,
            progress_recorded: completedIds.length > 0 && input.progress !== undefined,
            task_status: "active",
            plan: steps,
          },
        }
      },
    })

    void ctx.session.hook("prompt", async (event: any) => {
      const runtime = await getRuntime(event.sessionID)
      runtime.compactionRefused = false
      const text = String(event.prompt?.text ?? "")
      if (text.startsWith("CORRECTION:")) {
        runtime.state = recordCorrection(runtime.state)
        runtime.pendingBoundary = false
      } else {
        const next = recordCompletedPlanHandoff(runtime.state)
        if (next !== runtime.state) runtime.state = next
      }
      save(runtime)
      if (runtime.state.plan.some((step) => step.status !== "completed")) {
        runtime.continuationScheduled = false
      }
    })

    void ctx.session.hook("context", async (event: any) => {
      const runtime = await getRuntime(event.sessionID)
      const messages: readonly unknown[] = Array.isArray(event.messages) ? event.messages : []
      runtime.observed = [...messages]

      let visible = 0
      for (const message of messages) visible += estimateMessageTokens(message)
      let systemTokens = 0
      if (Array.isArray(event.system)) {
        for (const part of event.system) {
          if (typeof (part as any)?.text === "string") systemTokens += Math.ceil((part as any).text.length / 4)
        }
      }
      const contextTokens = visible + systemTokens
      runtime.lastContextTokens = contextTokens
      runtime.archiveTokens = estimateProjectedCompactionTokens(messages, keepRecentTokens)

      runtime.state = recordProviderRequest(runtime.state, contextTokens)
      save(runtime)
    })

    void ctx.session.hook("compaction", async (event: any) => {
      const runtime = await getRuntime(event.sessionID)
      runtime.state = recordCompaction(runtime.state, runtime.activeDebt)
      runtime.activeDebt = { debtTokens: 0, repaymentTokens: 0 }
      runtime.compactionRefused = false
      runtime.pendingBoundary = false
      save(runtime)

      // Resume the still-active parent task in a new turn. Queueing preserves
      // order relative to the compaction that the hook is handling.
      if (!runtime.continuationScheduled && runtime.state.plan.some((step) => step.status !== "completed")) {
        runtime.continuationScheduled = true
        try {
          await ctx.session.prompt({
            sessionID: event.sessionID,
            text: POST_COMPACTION_PLAN_REMINDER,
            delivery: "queue",
          })
        } catch (error) {
          runtime.continuationScheduled = false
          console.error(`[online-context-compact] continuation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })

    return () => {
      runtimes.clear()
    }
  }
}

export {
  analyzePlanTransition,
  formatPlanSnapshot,
  parsePlanSteps,
  type PlanStatus,
  type PlanStep,
} from "./plan.ts"
export {
  DEFAULT_COMPACTION_ECONOMICS,
  decideCompaction,
  estimateRemainingRequests,
  type CompactionDecision,
  type CompactionEconomics,
  type CompactionReason,
} from "./economics.ts"
export {
  initialOnlineState,
  ONLINE_STATE_FILE,
  restoreOnlineState,
  type OnlineState,
  type ProgressSummary,
} from "./state.ts"
export type { PlanProgress, PlanUpdateInput } from "./tools.ts"
export { BOUNDARY_COMPACTION_INSTRUCTIONS as COMPACTION_INSTRUCTIONS }
