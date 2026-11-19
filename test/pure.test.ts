/* Dependency-free port of the original's pure-logic tests (bun test). */
import { describe, expect, test } from "bun:test"
import { decideCompaction, DEFAULT_COMPACTION_ECONOMICS, estimateRemainingRequests } from "../src/online-compact/economics.ts"
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "../src/online-compact/plan.ts"
import { loadSolPiConfig, DEFAULT_CONFIG } from "../src/config.ts"
import {
  loadReducerConfig,
  REDUCER_RECEIPT_SCHEMA,
  sha256,
} from "../src/evidence-reducer/config.ts"
import { validateReceipt, receiptText } from "../src/evidence-reducer/receipt.ts"
import type { ArchiveObject } from "../src/evidence-reducer/archive.ts"

describe("config", () => {
  test("defaults disable every mechanism", () => {
    const config = loadSolPiConfig(process.cwd(), {})
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config.actionFusion).toBe(false)
    expect(config.observationPack).toBe(false)
    expect(config.evidencePreservingReducer).toBe(false)
    expect(config.onlineContextCompact).toBe(false)
  })

  test("options override defaults and are validated", () => {
    const config = loadSolPiConfig(process.cwd(), { actionFusion: true, observationPack: true })
    expect(config.actionFusion).toBe(true)
    expect(config.observationPack).toBe(true)
  })

  test("unknown keys and bad types are fatal", () => {
    expect(() => loadSolPiConfig(process.cwd(), { nope: true })).toThrow()
    expect(() => loadSolPiConfig(process.cwd(), { actionFusion: "yes" })).toThrow()
    expect(() => loadSolPiConfig(process.cwd(), { cacheWriteReadRatio: -1 })).toThrow()
    expect(() => loadSolPiConfig(process.cwd(), { version: 2 })).toThrow()
  })
})

describe("plan", () => {
  test("parses steps and rejects bad input", () => {
    const steps = parsePlanSteps([
      { id: "a", goal: "do a", status: "pending" },
      { id: "b", goal: "do b", status: "in_progress" },
    ])
    expect(steps?.length).toBe(2)
    expect(parsePlanSteps([{ id: "a", goal: "x", status: "bogus" }])).toBeUndefined()
    expect(parsePlanSteps([{ id: "a", goal: "x", status: "pending" }, { id: "a", goal: "y", status: "pending" }])).toBeUndefined()
  })

  test("detects a completed transition and emits advice", () => {
    const previous = parsePlanSteps([{ id: "a", goal: "do a", status: "in_progress" }])!
    const next = parsePlanSteps([{ id: "a", goal: "do a", status: "completed" }])!
    const transition = analyzePlanTransition(previous, next)
    expect(transition.completedSteps.map((step) => step.id)).toEqual(["a"])
    expect(formatPlanSnapshot(next)).toContain("sol-pi-plan")
  })
})

describe("economics", () => {
  test("horizon grows with remaining boundaries", () => {
    const base = {
      scale: 1, standardDeviationK: 0, contextTokens: 1000,
      contextWindowTokens: null, averageContextTokenIncrement: 100,
    }
    const one = estimateRemainingRequests({ ...base, completedBoundaryRequestCounts: [3], remainingBoundaries: 1 })
    const many = estimateRemainingRequests({ ...base, completedBoundaryRequestCounts: [3], remainingBoundaries: 4 })
    expect(many.expectedRemainingRequests).toBeGreaterThan(one.expectedRemainingRequests)
  })

  test("non-positive saving never compacts", () => {
    const decision = decideCompaction({
      writeTokens: 1000, archiveTokens: 100, memoTokens: 1000, contextTokens: 1000,
      completedBoundaryRequestCounts: null, remainingBoundaries: 1,
      averageContextTokenIncrement: null, contextWindowTokens: null,
      priorCompactionCount: 0, carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0,
      cacheWriteReadRatio: 12.5, economics: DEFAULT_COMPACTION_ECONOMICS,
    })
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe("non_positive_saving")
  })

  test("window protection compacts near the limit", () => {
    const decision = decideCompaction({
      writeTokens: 90_000, archiveTokens: 40_000, memoTokens: 1_000, contextTokens: 90_000,
      completedBoundaryRequestCounts: [5], remainingBoundaries: 2,
      averageContextTokenIncrement: 100, contextWindowTokens: 100_000,
      priorCompactionCount: 1, requestsSinceLastCompaction: 5,
      carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0,
      cacheWriteReadRatio: 12.5, economics: DEFAULT_COMPACTION_ECONOMICS,
    })
    expect(decision.compact).toBe(true)
    expect(decision.reason).toBe("window_protection")
  })
})

describe("evidence receipt verification", () => {
  const body = "building...\nerror: fatal thing happened\n Building done\n"
  const archive: ArchiveObject = {
    hash: sha256(body), bytes: Buffer.byteLength(body), chars: body.length,
    lines: body.split("\n").length, path: "/tmp/archive.txt",
  }
  const valid = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: archive.hash,
    status: "failure",
    uncertain: false,
    evidence: [{ kind: "fatal", quote: "error: fatal thing happened" }],
  })

  test("accepts a receipt with exact quotes", () => {
    const checked = validateReceipt(valid, archive, body, true)
    expect(checked.ok).toBe(true)
  })

  test("rejects unverifiable quotes and schema mismatches", () => {
    expect(validateReceipt(valid.replace("fatal thing", "made up thing"), archive, body, true).ok).toBe(false)
    expect(validateReceipt(valid.replace(REDUCER_RECEIPT_SCHEMA, "wrong"), archive, body, true).ok).toBe(false)
    expect(validateReceipt("not json", archive, body, true).ok).toBe(false)
  })

  test("failing logs require failure evidence", () => {
    const noFailure = JSON.stringify({
      schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash,
      status: "failure", uncertain: false,
      evidence: [{ kind: "summary", quote: "building..." }],
    })
    expect(validateReceipt(noFailure, archive, body, true)).toEqual({ ok: false, reason: "missing-failure-evidence" })
  })
})

describe("reducer config", () => {
  test("run id is derived from the store root", () => {
    const a = loadReducerConfig("/tmp/session-a")
    const b = loadReducerConfig("/tmp/session-b")
    expect(a.runId).not.toBe(b.runId)
    expect(a.storeRoot).toContain("evidence-preserving-reducer")
  })
})
