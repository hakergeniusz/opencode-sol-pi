/* update_plan tool registration for OpenCode V2. */
import type { PluginContext } from "../types.ts"
import { PLAN_STATUSES, type PlanStep } from "./plan.ts"

export type PlanProgress = {
  readonly files_changed: readonly string[]
  readonly verification: readonly string[]
  readonly decisions: readonly string[]
}

export interface PlanUpdateInput {
  readonly steps: readonly PlanStep[]
  readonly progress: PlanProgress | undefined
  readonly sessionID: string
  readonly context: any
}

export type OnlineToolHandlers = {
  readonly updatePlan: (input: PlanUpdateInput) => Promise<any>
}

const progressSchema = {
  type: "object" as const,
  properties: {
    files_changed: { type: "array" as const, items: { type: "string" as const, maxLength: 1000 }, maxItems: 128 },
    verification: { type: "array" as const, items: { type: "string" as const, maxLength: 1000 }, maxItems: 64 },
    decisions: { type: "array" as const, items: { type: "string" as const, maxLength: 1000 }, maxItems: 64 },
  },
  additionalProperties: false as const,
}

const planStepSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const, minLength: 1, maxLength: 16_384 },
    goal: { type: "string" as const, minLength: 1, maxLength: 16_384 },
    status: { type: "string" as const, enum: [...PLAN_STATUSES] },
  },
  required: ["id", "goal", "status"],
  additionalProperties: false as const,
}

export function registerOnlineTools(ctx: PluginContext, handlers: OnlineToolHandlers): void {
  void ctx.tool.transform((editor: any) => {
    editor.add({
      name: "update_plan",
      description:
        "Replace the complete working plan. Completing a previously registered unfinished step becomes a safe point where SoL-Pi may compact context if doing so is economical. Newly introduced completed steps are recorded as history.",
      input: {
        type: "object",
        properties: {
          steps: { type: "array", items: planStepSchema, minItems: 1, maxItems: 128 },
          progress: progressSchema,
        },
        required: ["steps"],
        additionalProperties: false,
      },
      // `codemode: false` keeps the tool model-callable but out of codemode
      // scripts, mirroring the Pi original's model-only exposure.
      options: { codemode: false },
      execute: async (input: any, context: any) =>
        handlers.updatePlan({
          steps: input.steps,
          progress: input.progress,
          sessionID: context.sessionID,
          context,
        }),
    })
  })
}
