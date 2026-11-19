/* Shared helpers for OpenCode tool results (Tool.Result shape). */

export interface TextContent {
  readonly type: "text"
  readonly text: string
}

export interface FileContent {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

export type ResultContent = TextContent | FileContent

/** The part of `Tool.Result` this plugin relies on. */
export interface SolToolResult {
  output?: unknown
  content?: string | readonly ResultContent[]
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export function resultText(result: SolToolResult | undefined): string {
  if (!result) return ""
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is TextContent => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
  }
  return typeof result.output === "string" ? result.output : ""
}

/** Append a text block to a tool result, keeping its other fields intact. */
export function appendResultText(result: SolToolResult, text: string, extraMetadata: Record<string, unknown> = {}): SolToolResult {
  const content = result.content
  let nextContent: readonly ResultContent[]
  if (typeof content === "string") {
    nextContent = [{ type: "text", text: content }, { type: "text", text }]
  } else if (Array.isArray(content)) {
    nextContent = [...content, { type: "text", text }]
  } else {
    nextContent = [{ type: "text", text }]
  }
  return {
    ...result,
    content: nextContent,
    metadata: { ...(result.metadata ?? {}), ...extraMetadata },
  }
}

/** Replace all text content with `text`, leaving file blocks and other fields intact. */
export function replaceResultText(result: SolToolResult, text: string, extraMetadata: Record<string, unknown> = {}): SolToolResult {
  const content = result.content
  let nextContent: readonly ResultContent[]
  if (Array.isArray(content)) {
    nextContent = content.map((block) => (block.type === "text" ? { type: "text", text } : block))
    if (!nextContent.some((block) => block.type === "text")) {
      nextContent = [...nextContent, { type: "text", text }]
    }
  } else {
    nextContent = [{ type: "text", text }]
  }
  return {
    ...result,
    content: nextContent,
    metadata: { ...(result.metadata ?? {}), ...extraMetadata },
  }
}
