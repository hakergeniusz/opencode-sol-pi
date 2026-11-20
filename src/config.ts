/*
 * Configuration for opencode-sol-pi.
 *
 * The schema, defaults, and strict validation are preserved. Configuration is
 * read from OpenCode config locations and can be overlaid by plugin `options`.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5

export interface SolPiConfig {
  readonly version: 1
  readonly actionFusion: boolean
  readonly observationPack: boolean
  readonly evidencePreservingReducer: boolean
  readonly evidencePreservingReducerModel: string
  readonly evidencePreservingReducerProvider: string
  readonly onlineContextCompact: boolean
  readonly cacheWriteReadRatio: number
}

/** Defaults chosen by the original — every mechanism is opt-in. */
export const DEFAULT_REDUCER_PROVIDER = "openai-codex"
export const DEFAULT_REDUCER_MODEL = "gpt-5.6-luna"

export const DEFAULT_CONFIG: SolPiConfig = Object.freeze({
  version: 1,
  actionFusion: false,
  observationPack: false,
  evidencePreservingReducer: false,
  evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
  evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
  onlineContextCompact: false,
  cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
})

const FEATURE_KEYS = [
  "actionFusion",
  "observationPack",
  "evidencePreservingReducer",
  "onlineContextCompact",
] as const
const STRING_KEYS = ["evidencePreservingReducerModel", "evidencePreservingReducerProvider"] as const
const CONFIG_KEYS = new Set<string>([
  "version",
  ...FEATURE_KEYS,
  ...STRING_KEYS,
  "cacheWriteReadRatio",
])

function configHome(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "opencode")
}

/**
 * OpenCode keeps project config in `.opencode/` and global config under the
 * config home. Project config replaces — and is not merged with — the global
 * file.
 */
export function findConfigPath(cwd = process.cwd(), allowProjectConfig = true): string | undefined {
  if (allowProjectConfig) {
    const projectPath = join(cwd, ".opencode", "sol-pi.json")
    if (existsSync(projectPath)) return projectPath
  }
  const globalPath = join(configHome(), "sol-pi.json")
  return existsSync(globalPath) ? globalPath : undefined
}

function parseAndValidate(parsed: unknown, path: string): SolPiConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`opencode-sol-pi config must be a JSON object: ${path}`)
  }
  const record = parsed as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown opencode-sol-pi config key: ${key}`)
  }
  if (record.version !== undefined && record.version !== 1) {
    throw new Error(`opencode-sol-pi config version must be 1: ${path}`)
  }
  for (const key of FEATURE_KEYS) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`opencode-sol-pi config ${key} must be boolean: ${path}`)
    }
  }
  const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
    ? record.cacheWriteReadRatio
    : DEFAULT_CACHE_WRITE_READ_RATIO
  if (
    typeof cacheWriteReadRatio !== "number" ||
    !Number.isFinite(cacheWriteReadRatio) ||
    cacheWriteReadRatio < 0
  ) {
    throw new Error(`opencode-sol-pi config cacheWriteReadRatio must be a finite non-negative number: ${path}`)
  }
  const evidencePreservingReducerModel = stringConfigValue(
    record,
    "evidencePreservingReducerModel",
    DEFAULT_REDUCER_MODEL,
    path,
  )
  const evidencePreservingReducerProvider = stringConfigValue(
    record,
    "evidencePreservingReducerProvider",
    DEFAULT_REDUCER_PROVIDER,
    path,
  )

  return Object.freeze({
    ...DEFAULT_CONFIG,
    ...record,
    version: 1,
    cacheWriteReadRatio,
    evidencePreservingReducerModel,
    evidencePreservingReducerProvider,
  }) as SolPiConfig
}

function stringConfigValue(
  record: Record<string, unknown>,
  key: (typeof STRING_KEYS)[number],
  defaultValue: string,
  path: string,
): string {
  const value = Object.hasOwn(record, key) ? record[key] : defaultValue
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`opencode-sol-pi config ${key} must be a non-empty string: ${path}`)
  }
  return value.trim()
}

/** Load the file, then overlay `ctx.options` (OpenCode-native configuration). */
export function loadSolPiConfig(
  cwd = process.cwd(),
  options: Record<string, unknown> = {},
): SolPiConfig {
  const path = findConfigPath(cwd)
  let fromFile: Partial<SolPiConfig> = {}
  if (path) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Unable to read opencode-sol-pi config ${path}: ${reason}`)
    }
    fromFile = parseAndValidate(parsed, path)
  }
  const merged = { ...fromFile, ...options } as Record<string, unknown>
  // Validate the merged result under the same strict rules.
  return parseAndValidate(merged, path ?? "ctx.options")
}
