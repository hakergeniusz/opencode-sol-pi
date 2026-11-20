/*
 * Evidence-Preserving Reducer — delegate the first read of a long build/test
 * log to a configured model, but accept its receipt only when every quoted
 * line is found byte-for-byte in the archived source.
 *
 * Uses `ctx.tool.hook("execute.after")`, where a completed tool result can be
 * inspected and replaced in place.
 */
import { Buffer } from "node:buffer"
import type { PluginContext } from "../types.ts"
import { runtimeRoot } from "../runtime-paths.ts"
import { archiveBody, archiveRoot } from "./archive.ts"
import { reducibleToolResult } from "./candidate.ts"
import {
  DIAGNOSTIC_COMMAND,
  isRecord,
  LIKELY_SECRET,
  loadReducerConfig,
  REDUCER_RECEIPT_SCHEMA,
  type ReducerConfig,
  type ReducerConfigOptions,
  sha256,
} from "./config.ts"
import { createJournal, type Journal } from "./journal.ts"
import { callReducer, type ProviderResult } from "./provider.ts"
import { receiptText, validateReceipt } from "./receipt.ts"

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" ? error.name : undefined
}

export async function reduceToolResult(
  ctx: PluginContext,
  journal: Journal,
  config: ReducerConfig,
  event: any,
): Promise<any | undefined> {
  const reducible = await reducibleToolResult(event)
  if (!reducible || !DIAGNOSTIC_COMMAND.test(reducible.command)) return undefined
  const { body, command } = reducible
  if (Buffer.byteLength(body, "utf8") < config.minBytes) return undefined
  if (reducible.exitFailed !== undefined && reducible.exitFailed === true && !event.isError) {
    journal("fallback", { toolCallId: event.id, reason: "exit-state-mismatch" })
    return undefined
  }
  if (body.length > config.maxChars) {
    journal("fallback", { reason: "source-over-max-chars", sourceChars: body.length, maxChars: config.maxChars })
    return undefined
  }
  if (LIKELY_SECRET.test(body)) {
    journal("fallback", { reason: "likely-secret" })
    return undefined
  }

  const archive = await archiveBody(archiveRoot(config), body)
  journal("candidate", {
    toolCallId: event.id,
    commandSha256: sha256(command),
    isError: event.isError ?? false,
    sourceSha256: archive.hash,
    sourceBytes: archive.bytes,
    sourceLines: archive.lines,
    sourcePath: archive.path,
  })

  let provider: ProviderResult
  try {
    provider = await callReducer(ctx, config, command, event.isError ?? false, archive, body)
  } catch (error) {
    const name = errorName(error)
    journal("fallback", {
      toolCallId: event.id,
      sourceSha256: archive.hash,
      reason:
        name === "AbortError"
          ? "model-call-timeout"
          : name === "ReducerModelUnavailableError"
            ? "reducer-model-unavailable"
            : "model-call-exception",
    })
    return undefined
  }

  journal("provider_response", {
    toolCallId: event.id,
    sourceSha256: archive.hash,
    provider: provider.provider,
    model: provider.model,
    stopReason: provider.stopReason,
    errorMessage: provider.errorMessage,
    usage: provider.usage,
  })
  if (!provider.ok) {
    journal("fallback", {
      toolCallId: event.id,
      sourceSha256: archive.hash,
      reason: "model-response-error",
      stopReason: provider.stopReason,
      errorMessage: provider.errorMessage,
    })
    return undefined
  }

  const checked = validateReceipt(provider.outputText, archive, body, event.isError ?? false)
  if (!checked.ok) {
    journal("fallback", { toolCallId: event.id, sourceSha256: archive.hash, reason: checked.reason, usage: provider.usage })
    return undefined
  }
  const receipt = receiptText(command, archive, checked.value, provider)
  const receiptBytes = Buffer.byteLength(receipt, "utf8")
  if (receiptBytes >= archive.bytes) {
    journal("fallback", {
      toolCallId: event.id,
      sourceSha256: archive.hash,
      reason: "receipt-not-smaller",
      receiptBytes,
      sourceBytes: archive.bytes,
      usage: provider.usage,
    })
    return undefined
  }
  journal("applied", {
    toolCallId: event.id,
    commandSha256: sha256(command),
    sourceSha256: archive.hash,
    sourceBytes: archive.bytes,
    receiptSha256: sha256(receipt),
    receiptBytes,
    evidenceCount: checked.value.evidence.length,
    uncertain: checked.value.uncertain,
    usage: provider.usage,
  })
  return {
    ...reducible.projectReceipt(receipt),
    metadata: {
      ...(isRecord(event.result?.metadata) ? event.result.metadata : {}),
      evidencePreservingReducer: {
        schema: REDUCER_RECEIPT_SCHEMA,
        sourceSha256: archive.hash,
        sourceBytes: archive.bytes,
        receiptSha256: sha256(receipt),
        receiptBytes,
        evidenceCount: checked.value.evidence.length,
        uncertain: checked.value.uncertain,
      },
    },
  }
}

export function registerEvidencePreservingReducer(ctx: PluginContext, options: ReducerConfigOptions = {}): void {
  const states = new Map<string, { config: ReducerConfig; journal: Journal }>()

  void ctx.tool.hook("execute.after", async (event: any) => {
    if (event.status !== "completed" || !event.result) return
    let root: string
    try {
      root = runtimeRoot(event.sessionID)
    } catch {
      return
    }
    let state = states.get(root)
    if (!state) {
      const config = loadReducerConfig(root, options)
      state = { config, journal: createJournal(config) }
      states.set(root, state)
    }
    let reduced: any
    try {
      reduced = await reduceToolResult(ctx, state.journal, state.config, event)
    } catch (error) {
      console.error(`[evidence-reducer] fail-open: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (reduced) {
      // Mutate the hook's result draft so the model sees the receipt.
      event.result.content = reduced.content
      event.result.metadata = reduced.metadata
    }
  })
}

export {
  DIAGNOSTIC_COMMAND,
  loadReducerConfig,
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  type ReducerConfig,
  type ReducerConfigOptions,
} from "./config.ts"
export { validateReceipt } from "./receipt.ts"
