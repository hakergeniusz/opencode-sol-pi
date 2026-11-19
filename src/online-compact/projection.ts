/*
 * Estimate the tokens a native compaction would archive.
 *
 * Pi's original used private session-entry projection helpers (`findCutPoint`,
 * `buildSessionProjection`, `sessionEntryToContextMessages`). Those are not
 * exposed by the OpenCode V2 plugin API, so this port uses the message drafts
 * from the `context` hook: it keeps the most recent `keepRecentTokens` of token
 * traffic (system messages survive compaction) and prices the older prefix as
 * removable. This is a conservative approximation, documented in the README.
 */
export function estimateMessageTokens(message: unknown): number {
  try {
    return Math.ceil(Buffer.byteLength(JSON.stringify(message ?? {}), "utf8") / 4)
  } catch {
    return 0
  }
}

export function estimateProjectedCompactionTokens(
  messages: readonly unknown[],
  keepRecentTokens: number,
): number {
  const removable: number[] = []
  for (const message of messages) {
    const record = message as { role?: string } | undefined
    // System/checkpoint instructions survive compaction and are never summarized.
    if (record?.role === "system") continue
    removable.push(estimateMessageTokens(message))
  }
  let recent = 0
  let cut = 0
  for (let index = removable.length - 1; index >= 0; index -= 1) {
    if (recent >= keepRecentTokens) break
    recent += removable[index] ?? 0
    cut = index
  }
  let archived = 0
  for (let index = 0; index < cut; index += 1) archived += removable[index] ?? 0
  return archived
}
