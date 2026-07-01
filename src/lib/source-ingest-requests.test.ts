import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  enqueueSourceIngest: vi.fn(),
}))

vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  isIngestableSourcePath: (path: string) => path.endsWith(".md"),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}))

import { handleSourceIngestRequest } from "./source-ingest-requests"
import { useWikiStore } from "@/stores/wiki-store"

const project = {
  id: "project-1",
  name: "Project",
  path: "/Users/me/wiki",
}

const sourceWatchConfig = {
  enabled: true,
  autoIngest: true,
  includeExtensions: ["md"],
  excludeExtensions: [],
  excludeDirs: [],
  excludeGlobs: [],
  maxFileSizeMb: 100,
}

describe("source ingest requests", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enqueueSourceIngest.mockResolvedValue(["task-1"])
    useWikiStore.getState().setProject(project)
    useWikiStore.getState().setSourceWatchConfig(sourceWatchConfig)
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-test",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
  })

  it("queues ingest for active project raw source paths", async () => {
    await expect(handleSourceIngestRequest({
      requestId: "req-1",
      projectId: "project-1",
      projectPath: "/Users/me/wiki",
      sourcePaths: [
        "raw/sources/search/result.md",
        "wiki/ignored.md",
      ],
    })).resolves.toEqual(["task-1"])

    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["raw/sources/search/result.md"],
      expect.objectContaining({ provider: "openai" }),
    )
  })

  it("skips requests for inactive projects", async () => {
    await handleSourceIngestRequest({
      requestId: "req-2",
      projectId: "other-project",
      projectPath: "/Users/me/wiki",
      sourcePaths: ["raw/sources/search/result.md"],
    })

    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("skips requests without usable llm config", async () => {
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "",
      model: "gpt-test",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    await handleSourceIngestRequest({
      requestId: "req-3",
      projectId: "project-1",
      projectPath: "/Users/me/wiki",
      sourcePaths: ["raw/sources/search/result.md"],
    })

    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })
})
