/*
 * Session-derived storage roots for local archives.
 *
 * The V2 plugin API does not expose a session-scoped filesystem directory, so a
 * private OS temp directory is used per session. Archives are retained for exact
 * recall after the session ends (cleanup follows host temp-file policy).
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const temporaryRoots = new Map<string, string>()

export function runtimeRoot(sessionID: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(sessionID)) {
    throw new Error("opencode-sol-pi requires a safe OpenCode session id")
  }
  let root = temporaryRoots.get(sessionID)
  if (!root) {
    root = mkdtempSync(join(tmpdir(), `opencode-sol-pi-${sessionID}-`))
    temporaryRoots.set(sessionID, root)
  }
  return root
}
