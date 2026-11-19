/* Reducer decision journal: local JSONL telemetry, never part of model context. */
import { join } from "node:path"
import { createJsonlAppender, type JsonlAppender } from "../jsonl.ts"
import { REDUCER_EVENT_SCHEMA, type ReducerConfig } from "./config.ts"

export type Journal = (kind: string, data?: object) => void

export function createJournal(config: ReducerConfig): Journal {
  const append: JsonlAppender = createJsonlAppender(join(config.storeRoot, "journal.jsonl"))
  return (kind, data = {}) => {
    void append({
      schema: REDUCER_EVENT_SCHEMA,
      runId: config.runId,
      kind,
      ...data,
    }).catch((error) => {
      console.error(`[evidence-reducer] journal write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
