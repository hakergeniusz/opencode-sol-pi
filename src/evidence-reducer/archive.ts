/* Archive storage for reducer source bodies. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord, type ReducerConfig, sha256 } from "./config.ts"

export interface ArchiveObject {
  readonly hash: string
  readonly bytes: number
  readonly chars: number
  readonly lines: number
  readonly path: string
}

export function archiveRoot(config: ReducerConfig): string {
  return config.storeRoot
}

export async function archiveBody(root: string, body: string): Promise<ArchiveObject> {
  const hash = sha256(body)
  const objectDir = join(root, "objects", hash.slice(0, 2))
  const path = join(objectDir, `${hash}.txt`)
  await mkdir(objectDir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 })
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error
    const existing = await readFile(path, "utf8")
    if (existing !== body || sha256(existing) !== hash) {
      throw new Error(`Reducer archive integrity failure: ${path}`)
    }
  }
  return {
    hash,
    bytes: Buffer.byteLength(body, "utf8"),
    chars: body.length,
    lines: body.length === 0 ? 0 : body.split("\n").length,
    path,
  }
}
