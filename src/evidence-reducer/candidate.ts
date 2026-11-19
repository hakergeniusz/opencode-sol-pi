/*
 * Identify the reducible log inside a tool result.
 * Ported from candidate.ts for OpenCode's `tool.execute.after` event.
 */
import { readFile, lstat, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname } from "node:path"
import { recordValue } from "./config.ts"
import { resultText, type SolToolResult } from "../tool-result.ts"

const THEN_RUN_SUCCEEDED = "[then_run:succeeded]"
const THEN_RUN_FAILED = "[then_run:failed]"
const EXIT_STATUS_LINE = /(?:^|\n)Command exited with code (-?\d+)\s*$/u

export interface ReducibleToolResult {
  readonly command: string
  readonly body: string
  readonly exitFailed: boolean | undefined
  readonly projectReceipt: (receipt: string) => SolToolResult
}

export interface ToolResultEventLike {
  readonly tool: string
  readonly input: unknown
  readonly result: SolToolResult
  readonly isError?: boolean
}

export function detailsFullOutputPath(details: unknown): string | undefined {
  const value = recordValue(details, "fullOutputPath")
  return typeof value === "string" ? value : undefined
}

async function safeTempPath(path: string | undefined): Promise<boolean> {
  if (!path || !/^pi-bash-[^/\\]+\.log$/u.test(basename(path))) return false
  try {
    const [candidate, root, status] = await Promise.all([realpath(path), realpath(tmpdir()), lstat(path)])
    return status.isFile() && !status.isSymbolicLink() && dirname(candidate) === root
  } catch {
    return false
  }
}

function inlineExitFailed(inline: string): boolean | undefined {
  const match = inline.match(EXIT_STATUS_LINE)
  return match ? Number(match[1]) !== 0 : undefined
}

function structuredExitCode(event: ToolResultEventLike): number | undefined {
  const value = recordValue((event.result as any)?.structuredContent ?? event.result?.metadata, "exit_code")
  return typeof value === "number" ? value : undefined
}

async function exactBodyFromInline(inline: string, details: unknown): Promise<string> {
  const detailsPath = detailsFullOutputPath(details)
  const inlineMatch = inline.match(/Full output:\s*([^\]\r\n]+)/u)
  const candidate = detailsPath ?? inlineMatch?.[1]?.trim()
  if (!candidate || !(await safeTempPath(candidate))) return inline
  try {
    return await readFile(candidate, "utf8")
  } catch {
    return inline
  }
}

function firstIndex(left: number, right: number): number {
  return left < 0 ? right : right < 0 ? left : Math.min(left, right)
}

export async function reducibleToolResult(event: ToolResultEventLike): Promise<ReducibleToolResult | undefined> {
  if (event.tool === "bash") {
    const command = typeof recordValue(event.input, "command") === "string" ? String(recordValue(event.input, "command")) : ""
    if (!command) return undefined
    const inline = resultText(event.result)
    const exitCode = structuredExitCode(event)
    return {
      command,
      body: await exactBodyFromInline(inline, event.result.metadata),
      exitFailed: exitCode !== undefined ? exitCode !== 0 : inlineExitFailed(inline),
      projectReceipt: (receipt) => ({
        ...event.result,
        content: [{ type: "text", text: receipt }],
      }),
    }
  }
  if (event.tool !== "write" && event.tool !== "edit") return undefined
  const thenRun = recordValue(event.input, "then_run")
  const commandValue = recordValue(thenRun, "command")
  if (typeof commandValue !== "string" || !commandValue) return undefined

  const inline = resultText(event.result)
  const markerIndex = firstIndex(inline.indexOf(THEN_RUN_SUCCEEDED), inline.indexOf(THEN_RUN_FAILED))
  if (markerIndex < 0) return undefined
  const marker = inline.startsWith(THEN_RUN_FAILED, markerIndex) ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED
  const suffixStart = markerIndex + marker.length
  const suffix = inline.slice(suffixStart)
  const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n"
  const bodyStart = separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length
  const bodyInline = suffix.slice(bodyStart)
  return {
    command: commandValue,
    body: await exactBodyFromInline(bodyInline, event.result.metadata),
    exitFailed: marker === THEN_RUN_FAILED || inlineExitFailed(bodyInline) === true,
    projectReceipt: (receipt) => ({
      ...event.result,
      content: `${inline.slice(0, suffixStart)}${separator}${receipt}`,
    }),
  }
}
