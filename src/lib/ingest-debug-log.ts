import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export async function appendIngestDebugLog(
  projectPath: string,
  sourceIdentity: string,
  stage: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!isIngestDebugLogEnabled()) return
  try {
    const dir = `${normalizePath(projectPath)}/.llm-wiki`
    const path = `${dir}/ingest-debug.log`
    await createDirectory(dir)
    const existing = await tryReadFile(path)
    const line = JSON.stringify({
      at: new Date().toISOString(),
      sourceIdentity,
      stage,
      ...details,
    })
    await writeFile(path, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${line}\n`)
  } catch {
    // Debug logging must never affect ingest.
  }
}

function isIngestDebugLogEnabled(): boolean {
  if (import.meta.env?.DEV) return true
  try {
    return globalThis.localStorage?.getItem("llm-wiki:ingest-debug") === "1"
  } catch {
    return false
  }
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}
