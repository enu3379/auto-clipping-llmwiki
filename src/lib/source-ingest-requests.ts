import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { useWikiStore } from "@/stores/wiki-store"
import { enqueueSourceIngest, isIngestableSourcePath } from "@/lib/source-lifecycle"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { normalizePath } from "@/lib/path-utils"
import { isPathAllowedBySourceWatch, normalizeSourceWatchConfig } from "@/lib/source-watch-config"

export const SOURCE_INGEST_REQUEST_EVENT = "source-ingest://requested"

export interface SourceIngestRequestPayload {
  requestId?: string
  projectId?: string
  projectPath?: string
  sourcePaths?: string[]
  origin?: string
}

let unlisten: UnlistenFn | null = null

export async function startSourceIngestRequestListener(): Promise<void> {
  if (unlisten) return
  unlisten = await listen<SourceIngestRequestPayload>(
    SOURCE_INGEST_REQUEST_EVENT,
    (event) => {
      void handleSourceIngestRequest(event.payload)
    },
  )
}

export function stopSourceIngestRequestListener(): void {
  unlisten?.()
  unlisten = null
}

export async function handleSourceIngestRequest(
  payload: SourceIngestRequestPayload,
): Promise<string[]> {
  const store = useWikiStore.getState()
  const project = store.project
  const requestId = payload.requestId ?? "unknown"
  if (!project) {
    logSkipped(requestId, "no active project")
    return []
  }
  if (payload.projectId && payload.projectId !== project.id) {
    logSkipped(requestId, "project is not active")
    return []
  }
  if (
    payload.projectPath &&
    normalizePath(payload.projectPath) !== normalizePath(project.path)
  ) {
    logSkipped(requestId, "project path is not active")
    return []
  }

  const config = normalizeSourceWatchConfig(store.sourceWatchConfig)
  if (!config.enabled) {
    logSkipped(requestId, "Source Watch is disabled")
    return []
  }
  if (!config.autoIngest) {
    logSkipped(requestId, "Source Watch auto-ingest is disabled")
    return []
  }
  if (!hasUsableLlm(store.llmConfig)) {
    logSkipped(requestId, "LLM config is not usable")
    return []
  }

  const sourcePaths = normalizeRequestedSourcePaths(payload.sourcePaths ?? [])
    .filter((path) => path.startsWith("raw/sources/"))
    .filter(isIngestableSourcePath)
    .filter((path) => isPathAllowedBySourceWatch(path, config))

  if (sourcePaths.length === 0) {
    logSkipped(requestId, "no ingestable source paths")
    return []
  }

  try {
    const taskIds = await enqueueSourceIngest(project, sourcePaths, store.llmConfig)
    console.info(
      `[source-ingest] queued ${taskIds.length} task(s) for request ${requestId}`,
    )
    return taskIds
  } catch (err) {
    console.error(`[source-ingest] failed to queue request ${requestId}:`, err)
    return []
  }
}

function normalizeRequestedSourcePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => normalizePath(path)).filter(Boolean))]
}

function logSkipped(requestId: string, reason: string): void {
  console.info(`[source-ingest] skipped request ${requestId}: ${reason}`)
}
