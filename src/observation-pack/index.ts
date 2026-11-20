/*
 * ObservationPack — keep large tool results reachable without replaying them.
 *
 * Uses `ctx.session.hook("context", ...)` to rewrite only the outgoing
 * projection (message drafts), never stored history, so exact recall keeps
 * working across compaction and resume.
 */
import { join } from "node:path"
import type { PluginContext } from "../types.ts"
import { runtimeRoot } from "../runtime-paths.ts"
import { createJsonlAppender } from "../jsonl.ts"
import {
  countLines,
  createObservation,
  ensureStored,
  estimateTokens,
  FULL_SENDS,
  isObservationId,
  observationPath,
  placeholderFor,
  readRecallChunk,
} from "./observation.ts"

const RECALL_MAX_BYTES = 16 * 1024
const RECALL_MAX_LINES = 400
const RECALL_HEADER_RESERVE_BYTES = 512
const RECALL_HEADER_LINES = 2
const RECALL_LIMITS = {
  maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
  maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
}

interface TextSlot {
  readonly toolName: string
  readonly toolCallId: string
  read(): string | undefined
  write(text: string): void
}

/** Locate pure-text tool results inside an OpenCode `Message`. */
function textSlots(message: any): TextSlot[] {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const slots: TextSlot[] = []
  for (const part of content) {
    if (!part || part.type !== "tool-result") continue
    const toolName = typeof part.name === "string" ? part.name : "unknown"
    const toolCallId = typeof part.id === "string" ? part.id : ""
    const result = part.result
    if (!result || result.type === "error" || result.type === "json") continue
    if (result.type === "text") {
      if (typeof result.value !== "string") continue
      slots.push({
        toolName,
        toolCallId,
        read: () => result.value as string,
        write: (text) => { result.value = text },
      })
      continue
    }
    if (result.type === "content" && Array.isArray(result.value)) {
      const blocks = result.value as any[]
      if (blocks.some((block) => block?.type !== "text")) continue
      slots.push({
        toolName,
        toolCallId,
        read: () => blocks.map((block) => String(block.text ?? "")).join("\n"),
        write: (text) => {
          blocks.splice(0, blocks.length, { type: "text", text })
        },
      })
    }
  }
  return slots
}

export function registerObservationPack(ctx: PluginContext): void {
  const sentCounts = new Map<string, number>()
  const ledgers = new Map<string, ReturnType<typeof createJsonlAppender>>()
  const ledgerFor = (root: string) => {
    let ledger = ledgers.get(root)
    if (!ledger) {
      ledger = createJsonlAppender(join(root, "observation-pack", "ledger.jsonl"))
      ledgers.set(root, ledger)
    }
    return ledger
  }

  void ctx.tool.transform((editor: any) => {
    editor.add({
      name: "obs_recall",
      description: "Read a stored large tool result by observation id and byte offset.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Observation id from a placeholder" },
          offset: { type: "integer", minimum: 0, description: "Byte offset, default 0" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => {
        const id = String(input.id ?? "")
        if (!isObservationId(id)) throw new Error(`Unknown observation id: ${id}`)
        const offset = Number(input.offset ?? 0)
        let chunk
        try {
          chunk = await readRecallChunk(observationPath(runtimeRoot(context.sessionID), id), offset, RECALL_LIMITS)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            throw new Error(`Unknown observation id: ${id}`)
          }
          throw error
        }
        const header = [
          `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
          `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
        ].join("\n")
        const content = `${header}\n${chunk.text}`
        if (Buffer.byteLength(content, "utf8") > RECALL_MAX_BYTES || countLines(content) > RECALL_MAX_LINES) {
          throw new Error("Recall output exceeded its hard limit")
        }
        await ledgerFor(runtimeRoot(context.sessionID))({
          event: "recall",
          id,
          offset,
          bytes: chunk.bytes,
          lines: chunk.lines,
          nextOffset: chunk.nextOffset,
          eof: chunk.eof,
        })
        return {
          content,
          metadata: {
            id,
            offset,
            bytes: chunk.bytes,
            lines: chunk.lines,
            nextOffset: chunk.nextOffset,
            eof: chunk.eof,
          },
        }
      },
    })
  })

  void ctx.session.hook("context", async (event: any) => {
    let root: string
    try {
      root = runtimeRoot(event.sessionID)
    } catch {
      return
    }
    const messages: any[] = Array.isArray(event.messages) ? event.messages : []
    const priorAssistantCounts = new Array<number>(messages.length)
    let assistantCount = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      priorAssistantCounts[index] = assistantCount
      if (messages[index]?.role === "assistant") assistantCount += 1
    }
    const requestIndex = assistantCount + 1

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const slots = textSlots(message)
      for (const slot of slots) {
        try {
          const text = slot.read()
          if (text === undefined) continue
          const observation = createObservation(
            { toolName: slot.toolName, toolCallId: slot.toolCallId, text },
            root,
          )
          if (!observation) continue
          await ensureStored(observation)

          const sendCountKey = `${root}\0${observation.id}`
          const previousSends = sentCounts.get(sendCountKey) ?? priorAssistantCounts[index] ?? 0
          if (previousSends < FULL_SENDS) {
            await ledgerFor(root)({
              event: "full",
              id: observation.id,
              request: requestIndex,
              tool: observation.toolName,
              originalBytes: observation.bytes,
              originalLines: observation.lines,
              originalTokens: observation.tokens,
              contentHash: observation.contentHash,
            })
            sentCounts.set(sendCountKey, previousSends + 1)
            continue
          }

          const placeholder = placeholderFor(observation)
          const placeholderTokens = estimateTokens(placeholder)
          const removedTokens = Math.max(0, observation.tokens - placeholderTokens)
          await ledgerFor(root)({
            event: "placeholder",
            id: observation.id,
            request: requestIndex,
            sendNumber: previousSends + 1,
            tool: observation.toolName,
            originalBytes: observation.bytes,
            originalLines: observation.lines,
            originalTokens: observation.tokens,
            placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
            placeholderTokens,
            removedTokens,
          })
          // Mutate the same message part in place to preserve the request's
          // cached prefix.
          slot.write(placeholder)
          sentCounts.set(sendCountKey, previousSends + 1)
        } catch (error) {
          // Fail open: packing must never cost the agent its observation.
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`[observationpack] fail-open for tool result: ${reason}`)
        }
      }
    }
  })
}

export { FULL_SENDS } from "./observation.ts"
