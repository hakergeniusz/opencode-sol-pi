/*
 * Action Fusion — fuse a file mutation and its follow-up validation command
 * into one tool call.
 *
 * Transforms OpenCode's existing `edit`/`write` tools in place, adding an
 * optional `then_run` field and wrapping their executors. The command itself is
 * delegated to OpenCode's `bash` tool executor, so permissions and shell
 * settings remain under OpenCode's control.
 */
import { createHash } from "node:crypto"
import { realpath, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { appendResultText, resultText, type SolToolResult } from "./tool-result.ts"
import type { PluginContext } from "./types.ts"

/* Tool executor/context types are structural to avoid coupling to SDK internals. */
interface ToolExecuteContext {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  progress?: (update: Record<string, unknown>) => Promise<void>
  [key: string]: unknown
}
type ToolExecutor = (input: any, context: ToolExecuteContext) => Promise<SolToolResult>

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]"
export const THEN_RUN_FAILED = "[then_run:failed]"
export const THEN_RUN_SKIPPED = "[then_run:skipped]"
const THEN_RUN_SKIPPED_REASON = "The file mutation did not complete successfully; the command was not run."

export interface ThenRunInput {
  command: string
  timeout?: number
}

const THEN_RUN_DESCRIPTION = (verb: string) =>
  `Command to run next on this file after the ${verb} succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the ${verb} fails; a non-zero exit is reported but keeps the ${verb}.`

export function createThenRunSchema(description: string) {
  return {
    type: "object" as const,
    description,
    properties: {
      command: { type: "string" as const, description: "Bash command to run" },
      timeout: { type: "number" as const, description: "Timeout in seconds (optional, no default timeout)" },
    },
    required: ["command"],
    additionalProperties: false as const,
  }
}

/* ------------------------------------------------------------------ */
/* Per-file serialization queue (ported from file-queue.ts)             */
/* ------------------------------------------------------------------ */
const queueTails = new Map<string, Promise<void>>()
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu
const WINDOWS_SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i

function normalizeToolPath(filePath: string): string {
  const normalized = filePath.replace(UNICODE_SPACES, " ")
  return normalized.startsWith("@") ? normalized.slice(1) : normalized
}

function normalizeWindowsShellPath(filePath: string): string {
  if (process.platform !== "win32") return filePath
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath
  const match = WINDOWS_SHELL_DRIVE.exec(filePath)
  if (!match?.[1]) return filePath
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`
}

export function resolveToolPath(cwd: string, filePath: string): string {
  const stripped = normalizeWindowsShellPath(normalizeToolPath(filePath))
  const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped
  if (expanded === "~") return homedir()
  if (expanded.startsWith("~/") || (process.platform === "win32" && expanded.startsWith("~\\"))) {
    return resolve(homedir(), expanded.slice(2))
  }
  return resolve(cwd, expanded)
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  )
}

async function canonicalQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath)
  let current = resolvedPath
  const missingSegments: string[] = []
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(current)
      if (parent === current) return resolvedPath
      missingSegments.unshift(basename(current))
      current = parent
    }
  }
}

async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const key = await canonicalQueueKey(filePath)
  const previous = queueTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const owned = new Promise<void>((resolveOwned) => {
    release = resolveOwned
  })
  const tail = previous.then(() => owned)
  queueTails.set(key, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (queueTails.get(key) === tail) queueTails.delete(key)
  }
}

/* ------------------------------------------------------------------ */
/* Mutation + then_run (ported from then-run.ts)                        */
/* ------------------------------------------------------------------ */
async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function assertUnchangedBeforeCommand(path: string): Promise<void> {
  try {
    const mutationHash = await fileSha256(path)
    await new Promise<void>((done) => setImmediate(done))
    const commandHash = await fileSha256(path)
    if (mutationHash !== commandHash) {
      throw new Error("target content changed after the fused mutation")
    }
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface FusedOptions {
  absolutePath: string
  thenRun: ThenRunInput | undefined
  mutate: () => Promise<SolToolResult>
  runCommand: (command: ThenRunInput, context: ToolExecuteContext) => Promise<SolToolResult>
  context: ToolExecuteContext
}

async function runFusedMutation(options: FusedOptions): Promise<{ result: SolToolResult; status: "none" | "succeeded" | "failed" | "skipped" }> {
  return withFusedFileQueue(options.absolutePath, async () => {
    let mutationResult: SolToolResult
    try {
      mutationResult = await options.mutate()
    } catch (error) {
      if (options.thenRun !== undefined) throw new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} ${THEN_RUN_SKIPPED_REASON}`)
      throw error
    }
    if (options.thenRun === undefined) return { result: mutationResult, status: "none" }

    await assertUnchangedBeforeCommand(options.absolutePath)
    let output: string
    let failed: boolean
    try {
      const bashResult = await options.runCommand(options.thenRun, options.context)
      output = resultText(bashResult)
      failed = false
    } catch (error) {
      throw new Error([resultText(mutationResult), THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"))
    }
    const marker = failed ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED
    const text = output ? `${marker}\n${output}` : marker
    return {
      result: appendResultText(mutationResult, text, { solPiThenRunStatus: failed ? "failed" : "succeeded" }),
      status: failed ? "failed" : "succeeded",
    }
  })
}

/** Exposed for tests and for the Rust-style fallback discussion in the original. */
export { runFusedMutation, assertUnchangedBeforeCommand }

const WRAPPED = Symbol.for("opencode-sol-pi.action-fusion.wrapped")

interface ToolLike {
  readonly id: string
  readonly name: string
  description: string
  input: any
  execute: ToolExecutor
  options?: { codemode?: boolean; namespace?: string; permission?: string }
  [key: string]: unknown
}

export function registerActionFusion(ctx: PluginContext, workingDirectory: string): void {
  void ctx.tool.transform((editor) => {
    const bash = editor.get("bash")
    const bashExecute = bash?.execute as ToolExecutor | undefined
    for (const toolName of ["edit", "write"] as const) {
      const base = editor.get(toolName) as ToolLike | undefined
      if (!base || typeof base.execute !== "function") continue
      if ((base.execute as any)[WRAPPED]) continue
      const baseExecute = base.execute
      const description = base.description || `Modify a file (${toolName})`

      const wrapped = (async (input: any, context: ToolExecuteContext) => {
        const { then_run, ...mutationInput } = input ?? {}
        const thenRun = then_run as ThenRunInput | undefined
        if (!thenRun || typeof thenRun.command !== "string") {
          return baseExecute(mutationInput, context)
        }
        if (!bashExecute) {
          return appendResultText(
            await baseExecute(mutationInput, context),
            `${THEN_RUN_SKIPPED} OpenCode bash tool is unavailable; the command was not run.`,
            { solPiThenRunStatus: "skipped" },
          )
        }
        const fused = await runFusedMutation({
          absolutePath: resolveToolPath(workingDirectory, String(mutationInput.path ?? "")),
          thenRun,
          mutate: () => baseExecute(mutationInput, context),
          runCommand: (command) =>
            bashExecute(
              {
                command: command.command,
                ...(typeof command.timeout === "number"
                  ? { timeout: Math.max(1, Math.round(command.timeout * 1000)) }
                  : {}),
              },
              context,
            ),
          context,
        })
        return fused.result
      }) as ToolExecutor
      ;(wrapped as any)[WRAPPED] = true

      editor.update(toolName, (tool: any) => {
        const schema = tool.input ?? { type: "object", properties: {} }
        tool.input = {
          ...schema,
          properties: {
            ...(schema.properties ?? {}),
            then_run: createThenRunSchema(THEN_RUN_DESCRIPTION(toolName === "edit" ? "edit" : "write")),
          },
        }
        tool.description = `${description} Optionally run a follow-up command on the changed file with \`then_run\`.`
        tool.execute = wrapped
      })
    }
  })
}
