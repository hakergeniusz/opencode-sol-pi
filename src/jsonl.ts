/* Append-only JSONL telemetry helper (local files, never part of model context). */
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export type JsonlAppender = (entry: Record<string, unknown>) => Promise<void>

export function createJsonlAppender(path: string): JsonlAppender {
  return async (entry) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8")
  }
}
