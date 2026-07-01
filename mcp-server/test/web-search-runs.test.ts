import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { ApiClipSearchResponse, ApiWebSearchResponse } from "../src/api-client.js"
import {
  allWebSearchIndexes,
  clipSearchSummary,
  defaultWebSearchRunPath,
  parseIndexes,
  readWebSearchRunFile,
  selectWebSearchResults,
  webSearchSummary,
  writeWebSearchRunFile,
} from "../src/web-search-runs.js"

const search: ApiWebSearchResponse = {
  projectId: "p1",
  runId: "run/unsafe id",
  provider: "tavily",
  results: [
    {
      title: "First",
      url: "https://example.com/1",
      snippet: "One",
      source: "example.com",
      provider: "tavily",
      rank: 1,
      query: "rust",
    },
    {
      title: "Second",
      url: "https://example.com/2",
      snippet: "Two",
      source: "example.com",
      provider: "tavily",
      rank: 2,
      query: "rust",
      markdown: "# Large extracted body",
    },
  ],
  errors: [],
}

test("web search run files round-trip normalized responses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llm-wiki-web-search-"))
  try {
    const out = path.join(dir, "runs", "search.json")
    const written = await writeWebSearchRunFile(search, out)
    const read = await readWebSearchRunFile(written)

    assert.equal(written, out)
    assert.equal(read.ok, true)
    assert.equal(read.runId, "run/unsafe id")
    assert.equal(read.results[1]?.markdown, "# Large extracted body")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("default run path sanitizes unsafe run ids", () => {
  assert.equal(
    defaultWebSearchRunPath("run/unsafe id"),
    path.join(".llm-wiki", "runs", "web-search", "run-unsafe-id.json"),
  )
})

test("parseIndexes accepts arrays, strings, and single numbers", () => {
  assert.deepEqual(parseIndexes([1, 3]), [1, 3])
  assert.deepEqual(parseIndexes("1, 3"), [1, 3])
  assert.deepEqual(parseIndexes(2), [2])
  assert.throws(() => parseIndexes("0"))
})

test("selectWebSearchResults uses one-based indexes", () => {
  assert.deepEqual(
    selectWebSearchResults(search.results, [2]).map((result) => result.title),
    ["Second"],
  )
  assert.deepEqual(allWebSearchIndexes(search.results), [1, 2])
  assert.throws(() => selectWebSearchResults(search.results, [3]))
})

test("webSearchSummary omits full results by default", () => {
  const summary = webSearchSummary(search, "/tmp/run.json", 1)

  assert.equal(summary.resultPath, "/tmp/run.json")
  assert.equal(summary.resultCount, 2)
  assert.equal((summary.results as Array<Record<string, unknown>>).length, 1)
  assert.equal("fullResults" in summary, false)
})

test("clipSearchSummary includes async ingest pipeline status", () => {
  const response: ApiClipSearchResponse = {
    projectId: "p1",
    written: [],
    skipped: [],
    enqueue: true,
    enqueueError: null,
    sourceWatchRescan: { requested: true, ok: true, changedCount: 1 },
    ingestRequest: { requested: true, emitted: true, status: "requested" },
    pipeline: { rawSourcesWritten: 1 },
  }

  const summary = clipSearchSummary(response)

  assert.deepEqual(summary.sourceWatchRescan, response.sourceWatchRescan)
  assert.deepEqual(summary.ingestRequest, response.ingestRequest)
  assert.deepEqual(summary.pipeline, response.pipeline)
})
