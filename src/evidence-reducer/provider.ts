/*
 * Reducer model call.
 *
 * Uses `ctx.experimental.generate.text({ model, prompt })`, which keeps
 * provider routing and authentication under OpenCode. The reducer instructions
 * and the untrusted log are combined into one prompt because this API has no
 * separate system-prompt parameter.
 */
import type { ArchiveObject } from "./archive.ts"
import type { ReducerConfig } from "./config.ts"
import { reducerInput, reducerInstructions } from "./receipt.ts"
import type { PluginContext } from "../types.ts"

export interface NormalizedUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
}

export interface ProviderResult {
  readonly errorMessage: string | undefined
  readonly model: string
  readonly ok: boolean
  readonly outputText: string
  readonly provider: string
  readonly stopReason: string
  readonly usage: NormalizedUsage
}

export class ReducerModelUnavailableError extends Error {
  override readonly name = "ReducerModelUnavailableError"
}

function usageFrom(generated: any): NormalizedUsage {
  const tokens = generated?.tokens ?? {}
  return {
    input: Number(tokens.input ?? 0),
    output: Number(tokens.output ?? 0),
    cacheRead: Number(tokens.cacheRead ?? 0),
    cacheWrite: Number(tokens.cacheWrite ?? 0),
    totalTokens: Number(tokens.totalTokens ?? 0),
  }
}

export async function callReducer(
  ctx: PluginContext,
  config: ReducerConfig,
  command: string,
  isError: boolean,
  archive: ArchiveObject,
  body: string,
): Promise<ProviderResult> {
  const generate = ctx.experimental?.generate?.text
  if (typeof generate !== "function") {
    throw new ReducerModelUnavailableError("OpenCode generate API is unavailable")
  }
  const prompt = [
    reducerInstructions(),
    "",
    reducerInput(command, isError, archive, body),
  ].join("\n")

  let generated: any
  try {
    generated = await generate.call(ctx.experimental.generate, {
      model: { providerID: config.reducerProvider, id: config.reducerModel },
      prompt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unavailable|not found|unknown model|no model/i.test(message)) {
      throw new ReducerModelUnavailableError(message)
    }
    throw error
  }

  const text = typeof generated?.text === "string" ? generated.text : ""
  return {
    errorMessage: generated?.errorMessage,
    model: config.reducerModel,
    ok: text.length > 0,
    outputText: text,
    provider: config.reducerProvider,
    stopReason: generated?.finish ?? generated?.stopReason ?? "stop",
    usage: usageFrom(generated),
  }
}
