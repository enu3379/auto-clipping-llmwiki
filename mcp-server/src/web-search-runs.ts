import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  ApiClipSearchResponse,
  ApiWebSearchError,
  ApiWebSearchResponse,
  ApiWebSearchResult,
} from "./api-client.js"

export interface WebSearchRunFile extends ApiWebSearchResponse {
  ok: true
}

export function webSearchRunPayload(search: ApiWebSearchResponse): WebSearchRunFile {
  return {
    ok: true,
    projectId: search.projectId,
    runId: search.runId,
    provider: search.provider,
    results: search.results,
    errors: search.errors,
  }
}

export function defaultWebSearchRunPath(runId: string): string {
  const stem = safeFileStem(runId || "web-search")
  return path.join(".llm-wiki", "runs", "web-search", `${stem}.json`)
}

export async function writeWebSearchRunFile(
  search: ApiWebSearchResponse,
  out?: string,
): Promise<string> {
  const filePath = path.resolve(out ?? defaultWebSearchRunPath(search.runId))
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(webSearchRunPayload(search), null, 2)}\n`, "utf8")
  return filePath
}

export async function readWebSearchRunFile(filePath: string): Promise<WebSearchRunFile> {
  const resolved = path.resolve(filePath)
  const raw = await readFile(resolved, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid web-search run file '${resolved}': ${err instanceof Error ? err.message : String(err)}`)
  }
  return parseWebSearchRunFile(parsed, resolved)
}

export function parseIndexes(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined
  const indexes = Array.isArray(value)
    ? value.map((item, index) => parseIndex(item, `indexes[${index}]`))
    : typeof value === "string"
      ? value.split(",").map((item, index) => parseIndex(item.trim(), `indexes[${index}]`))
      : [parseIndex(value, "indexes")]
  if (indexes.length === 0) throw new Error("indexes must contain at least one result index")
  return indexes
}

export function selectWebSearchResults(
  results: ApiWebSearchResult[],
  indexes: number[],
): ApiWebSearchResult[] {
  if (indexes.length === 0) throw new Error("indexes must contain at least one result index")
  return indexes.map((index) => {
    if (index < 1 || index > results.length) {
      throw new Error(`Result index ${index} is out of range; run file has ${results.length} results`)
    }
    return results[index - 1]
  })
}

export function allWebSearchIndexes(results: ApiWebSearchResult[]): number[] {
  return Array.from({ length: results.length }, (_, index) => index + 1)
}

export function webSearchSummary(
  search: ApiWebSearchResponse,
  resultPath: string,
  summaryLimit: number,
  includeResults = false,
): Record<string, unknown> {
  return {
    ok: true,
    command: "web-search",
    projectId: search.projectId,
    runId: search.runId,
    provider: search.provider,
    resultPath,
    resultCount: search.results.length,
    errorCount: search.errors.length,
    results: search.results.slice(0, normalizeLimit(summaryLimit)).map((result, index) => ({
      index: index + 1,
      title: result.title,
      url: result.url,
      source: result.source,
      provider: result.provider,
      rank: result.rank,
      query: result.query,
    })),
    errors: search.errors,
    ...(includeResults ? { fullResults: search.results } : {}),
  }
}

export function clipSearchSummary(
  response: ApiClipSearchResponse,
  meta: {
    runId?: string
    runFile?: string
    selectedIndexes?: number[]
  } = {},
): Record<string, unknown> {
  return {
    ok: true,
    command: "clip-search",
    projectId: response.projectId,
    runId: meta.runId,
    runFile: meta.runFile,
    selectedIndexes: meta.selectedIndexes,
    written: response.written,
    skipped: response.skipped,
    enqueue: response.enqueue,
    enqueueError: response.enqueueError,
  }
}

function parseWebSearchRunFile(value: unknown, context: string): WebSearchRunFile {
  const obj = requireRecord(value, context)
  return {
    ok: true,
    projectId: typeof obj.projectId === "string" ? obj.projectId : undefined,
    runId: String(obj.runId ?? ""),
    provider: typeof obj.provider === "string" ? obj.provider : undefined,
    results: Array.isArray(obj.results) ? obj.results.map(parseWebSearchResult) : [],
    errors: Array.isArray(obj.errors) ? obj.errors.map(parseWebSearchError) : [],
  }
}

function parseWebSearchResult(value: unknown): ApiWebSearchResult {
  const obj = requireRecord(value, "web search result")
  return {
    title: String(obj.title ?? ""),
    url: String(obj.url ?? ""),
    snippet: String(obj.snippet ?? ""),
    source: String(obj.source ?? ""),
    provider: String(obj.provider ?? ""),
    rank: numberOrUndefined(obj.rank) ?? 0,
    score: numberOrUndefined(obj.score),
    query: typeof obj.query === "string" ? obj.query : undefined,
    searchedAt: typeof obj.searchedAt === "string" ? obj.searchedAt : undefined,
    markdown: typeof obj.markdown === "string" ? obj.markdown : undefined,
    content: typeof obj.content === "string" ? obj.content : undefined,
  }
}

function parseWebSearchError(value: unknown): ApiWebSearchError {
  const obj = requireRecord(value, "web search error")
  return {
    query: String(obj.query ?? ""),
    error: String(obj.error ?? ""),
  }
}

function parseIndex(value: unknown, name: string): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return numeric
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected JSON object`)
  }
  return value as Record<string, unknown>
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "web-search"
}
