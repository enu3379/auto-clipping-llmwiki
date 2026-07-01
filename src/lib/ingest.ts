import {
  createDirectory,
  readFile,
  writeFile,
} from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { parseWithMineruResult } from "@/lib/mineru"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import {
  sourceIdentityForPath,
  sourceSummarySlugFromIdentity,
} from "@/lib/source-identity"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { withProjectLock } from "@/lib/project-mutex"
import {
  extractAndSaveSourceImages,
  extractAndSaveMarkdownImages,
  type SavedImage,
} from "@/lib/extract-source-images"
import { captionMarkdownImages } from "@/lib/image-caption-pipeline"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { appendIngestDebugLog } from "@/lib/ingest-debug-log"
export {
  rewriteIngestPathFromTitleForTargetLanguage,
} from "@/lib/ingest-language-guard"
import {
  computeIngestGenerationMaxTokensForSource,
  computeIngestReviewMaxTokensForGeneration,
  computeIngestSourceBudget,
} from "@/lib/ingest-budget"
import {
  buildAggregateRepairPrompt,
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildReviewSuggestionPrompt,
} from "@/lib/ingest-prompts"
import {
  analyzeLongSourceInChunks,
  clearLongSourceCheckpoint,
  trimInlineStatus,
} from "@/lib/ingest-long-source"
import {
  appendSavedImageRefsForCaption,
  hasMineruImageRefs,
  imageExtractionKey,
  injectImagesIntoSourceSummary,
  isSavedImagePromptUrl,
  promptImageUrlToAbs,
  reembedSourceSummary,
  rememberImageExtractionByKey,
  resolveCaptionConfig,
  savedImagesFromMineruMarkdown,
  stripWikiMediaAbsPaths,
} from "@/lib/ingest-images"
import {
  aggregatePathsNeedingRepair,
  countFileBlocks,
  filterAggregateRepairOutput,
  isAggregateRepairSafe,
  migrateLegacySourceSummaryIfSafe,
  parseReviewBlocks,
  shouldRunDedicatedReviewStage,
  writeFileBlocks,
} from "@/lib/ingest-write"
import {
  appendIngestWarningLog,
  throwIfIngestAborted,
  tryReadFile,
  tryReadSourceTextFile,
} from "@/lib/ingest-utils"
export {
  FILE_BLOCK_REGEX,
  isSafeIngestPath,
  parseFileBlocks,
} from "@/lib/ingest-file-blocks"
export type {
  ParsedFileBlock,
  ParseFileBlocksResult,
} from "@/lib/ingest-file-blocks"
export {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildPageMergeSystemPrompt,
} from "@/lib/ingest-prompts"
export {
  splitSourceIntoSemanticChunks,
} from "@/lib/ingest-long-source"
export {
  hasMineruImageRefs,
  sourceSummaryMediaRefsForExternalMarkdown,
} from "@/lib/ingest-images"
export {
  executeIngestWrites,
  startIngest,
} from "@/lib/ingest-manual"
export {
  aggregatePathsNeedingRepair,
  currentWikiDate,
  filterAggregateRepairOutput,
  stampGeneratedFrontmatterDates,
  stampGeneratedLogDate,
} from "@/lib/ingest-write"
export {
  formatIngestWarningLogEntry,
} from "@/lib/ingest-utils"
export {
  computeIngestGenerationMaxTokens,
  computeIngestGenerationMaxTokensForSource,
  computeIngestReviewMaxTokens,
  computeIngestReviewMaxTokensForGeneration,
  computeIngestSourceBudget,
} from "@/lib/ingest-budget"

/** Auto-ingest reads a source, analyzes it, writes wiki pages, and serializes per project. */
export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
): Promise<string[]> {
  return withProjectLock(normalizePath(projectPath), () =>
    autoIngestImpl(projectPath, sourcePath, llmConfig, signal, folderContext, onFileWritten),
  )
}

async function autoIngestImpl(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const sourceIdentity = sourceIdentityForPath(pp, sp)
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  const ingestStartedAt = Date.now()
  await appendIngestDebugLog(pp, sourceIdentity, "start", {
    fileName,
    sourcePath: sp,
    model: llmConfig.model,
    provider: llmConfig.provider,
    maxContextSize: llmConfig.maxContextSize,
  })
  console.log(`[ingest:diag] autoIngestImpl ENTRY for "${fileName}" (project="${pp}", source="${sp}")`)
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })

  // ── MinerU preprocessing for PDF files ──
  const lowerExt = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  const isPdf = lowerExt === "pdf"
  const mineruCfg = useWikiStore.getState().mineruConfig
  let mineruSucceeded = false
  let mineruSavedImages: SavedImage[] = []
  if (isPdf && mineruCfg.enabled && mineruCfg.token) {
    try {
      const cacheDir = sp.substring(0, sp.lastIndexOf("/"))
      const cachePath = `${cacheDir}/.cache/${fileName}.txt`
      activity.updateItem(activityId, { detail: "MinerU: parsing PDF..." })
      console.log(`[ingest:mineru] submitting "${fileName}" to MinerU API`)
      const mineruResult = await parseWithMineruResult(mineruCfg, sp, undefined, (msg) => {
        activity.updateItem(activityId, { detail: `MinerU: ${msg}` })
      }, signal, {
        projectPath: pp,
        sourceSummarySlug,
      })
      await createDirectory(`${cacheDir}/.cache`)
      await writeFile(cachePath, mineruResult.markdown)
      mineruSavedImages = mineruResult.savedImages
      if (mineruSavedImages.length > 0) {
        const extractionKey = await imageExtractionKey(pp, sp, sourceSummarySlug)
        rememberImageExtractionByKey(extractionKey, Promise.resolve(mineruSavedImages))
      }
      mineruSucceeded = true
      console.log(
        `[ingest:mineru] cached MinerU output for "${fileName}" (${mineruResult.markdown.length} chars, images=${mineruSavedImages.length})`,
      )
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      const msg = trimInlineStatus(err instanceof Error ? err.message : String(err))
      console.warn(`[ingest:mineru] MinerU parsing failed, falling back to pdfium: ${msg}`)
      activity.updateItem(activityId, {
        detail: `MinerU failed, falling back to built-in PDF extraction: ${msg}`,
      })
    }
    if (mineruSucceeded && !signal?.aborted) {
      activity.updateItem(activityId, { detail: "Reading source..." })
    }
  }

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadSourceTextFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])
  await appendIngestDebugLog(pp, sourceIdentity, "source_read", {
    elapsedMs: Date.now() - ingestStartedAt,
    sourceChars: sourceContent.length,
    schemaChars: schema.length,
    purposeChars: purpose.length,
    indexChars: index.length,
    overviewChars: overview.length,
  })
  if (isPdf && mineruSavedImages.length === 0 && hasMineruImageRefs(sourceContent, sourceSummarySlug)) {
    mineruSavedImages = await savedImagesFromMineruMarkdown(pp, sourceSummarySlug, sourceContent)
    if (mineruSavedImages.length > 0) {
      const extractionKey = await imageExtractionKey(pp, sp, sourceSummarySlug)
      rememberImageExtractionByKey(extractionKey, Promise.resolve(mineruSavedImages))
    }
  }

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  //
  // Image cascade still runs on cache hits. Reason: a user may have
  // ingested this source on a previous app version that didn't extract
  // images yet, or the media dir may have been deleted out from under
  // us. `extractAndSaveSourceImages` + injection are both idempotent
  // (deterministic output paths, marker-bracketed replacement), so
  // re-running them costs only the extraction time and converges the
  // source-summary page on the current pipeline's contract regardless
  // of when the file was first ingested.
  const cachedFiles = await checkIngestCache(pp, sourceIdentity, sourceContent)
  await appendIngestDebugLog(pp, sourceIdentity, "cache_check", {
    elapsedMs: Date.now() - ingestStartedAt,
    hit: cachedFiles !== null,
    cachedFiles: cachedFiles?.length ?? 0,
  })
  console.log(`[ingest:diag] cache check for "${sourceIdentity}":`, cachedFiles === null ? "MISS (full pipeline)" : `HIT (${cachedFiles.length} cached files)`)
  if (cachedFiles !== null) {
    try {
      console.log(`[ingest:diag] cache-hit branch: starting image extraction for ${sp}`)
      const skipNativePdfImageExtraction = isPdf && hasMineruImageRefs(sourceContent, sourceSummarySlug)
      let savedImages = skipNativePdfImageExtraction
        ? mineruSavedImages
        : await extractAndSaveSourceImages(pp, sp, sourceSummarySlug)
      const markdownImages = await extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)
      savedImages = [...savedImages, ...markdownImages]
      console.log(`[ingest:diag] cache-hit branch: got ${savedImages.length} image(s)`)
      if (savedImages.length > 0) {
        // Caption first (populates the cache), THEN inject — the
        // safety-net section uses the cache to populate alt text.
        // Doing them in this order means cache-hit re-runs (e.g.
        // user re-imports an old PDF after captioning was added)
        // converge: first run grows the cache, second run uses it.
        //
        // Master-toggle gate: when multimodal is OFF the entire
        // image-cascade is skipped here. This matches the
        // full-pipeline branch's strip-and-skip behavior for the
        // cache-hit path, so a user re-importing an old file
        // after disabling captioning sees images disappear from
        // the wiki side. (If a previous ingest had already written
        // a `## Embedded Images` block, it stays — re-import
        // doesn't proactively scrub old wiki content. The user
        // would need to delete the wiki/sources/<slug>.md page
        // to start clean.)
        const mmCfg = useWikiStore.getState().multimodalConfig
        if (!mmCfg.enabled) {
          console.log(
            `[ingest:caption] cache-hit + disabled — skipping caption + safety-net inject (${savedImages.length} image(s) untouched on disk)`,
          )
        } else {
          const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
          if (captionLlm) {
            try {
              await captionMarkdownImages(pp, appendSavedImageRefsForCaption(sourceContent, savedImages), captionLlm, {
                signal,
                shouldCaption: (url) =>
                  isSavedImagePromptUrl(pp, sourceSummarySlug, url),
                urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
                concurrency: mmCfg.concurrency,
                onProgress: (done, total) =>
                  activity.updateItem(activityId, {
                    detail: `Captioning images... ${done}/${total}`,
                  }),
              })
            } catch (err) {
              console.warn(
                `[ingest:caption] cache-hit caption pass failed:`,
                err instanceof Error ? err.message : err,
              )
            }
          }
          await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
          // Re-embed the source-summary page so caption text lands
          // in the search index. Without this step, search by image
          // content stays empty for files ingested before captioning
          // was added — the safety-net section was just rewritten
          // with captions, but the embeddings still reflect the old
          // empty-alt content.
          await reembedSourceSummary(pp, sourceIdentity, sourceSummarySlug)
        }
      } else {
        console.log(`[ingest:diag] cache-hit branch: skipping injection (no images returned from extraction)`)
      }
    } catch (err) {
      console.warn(
        `[ingest:images] cache-hit injection failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
    }
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    return cachedFiles
  }

  // ── Step 0.5: Extract embedded images ─────────────────────────
  // Pulls every embedded image out of PDF / PPTX / DOCX into
  // `wiki/media/<source-slug>/`. We DON'T inject the markdown
  // references into sourceContent here — without VLM captions
  // (Phase 3a) the alt text is empty, which gives the LLM no
  // semantic signal to preserve them. The LLM tends to silently
  // strip empty-alt images when summarizing.
  //
  // Instead, the markdown section is appended to the source-summary
  // page on disk AFTER writeFileBlocks (see Step 5b below). That
  // guarantees images appear in `wiki/sources/<slug>.md` regardless
  // of LLM behavior. Once Phase 3a lands, we'll re-introduce the
  // sourceContent injection because the captioned alt-text gives
  // the LLM something meaningful to work with.
  //
  // Failure here is never fatal — extractAndSaveSourceImages logs
  // and returns [] on any error.
  activity.updateItem(activityId, { detail: "Extracting embedded images..." })
  console.log(`[ingest:diag] full-pipeline branch: starting image extraction for ${sp}`)
  const skipNativePdfImageExtraction = isPdf && (
    hasMineruImageRefs(sourceContent, sourceSummarySlug)
  )
  let savedImages = skipNativePdfImageExtraction
    ? mineruSavedImages
    : await extractAndSaveSourceImages(pp, sp, sourceSummarySlug)
  const markdownImages = await extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)
  savedImages = [...savedImages, ...markdownImages]
  await appendIngestDebugLog(pp, sourceIdentity, "images_extracted", {
    elapsedMs: Date.now() - ingestStartedAt,
    imageCount: savedImages.length,
  })
  console.log(`[ingest:diag] full-pipeline branch: got ${savedImages.length} image(s)`)
  if (savedImages.length > 0) {
    console.log(
      `[ingest:images] saved ${savedImages.length} image(s) for "${sourceIdentity}" → wiki/media/${sourceSummarySlug}/`,
    )
  }

  // ── Step 0.6: Caption embedded images ─────────────────────────
  // Now that read_file's combined extraction has put `![](abs_path)`
  // markers inline in `sourceContent`, walk them and replace the
  // empty alt text with a vision-model-generated factual caption.
  // SHA-256-keyed cache (`<project>/.llm-wiki/image-caption-cache.json`)
  // dedupes across runs and across documents (shared logos / chart
  // templates caption once, not once per document).
  //
  // Why this matters: an empty-alt image gets paraphrased away by
  // text summarization. With a caption, the alt text carries enough
  // semantic load that the generation LLM tends to preserve the
  // image reference inline at the right paragraph.
  //
  // Scope: we only caption images whose absolute path lives under
  // <project>/wiki/media/<source-slug>/ — i.e. images the current
  // ingest produced. User-typed external URLs in markdown source
  // documents are passed through untouched.
  //
  // Master-toggle behavior: when `multimodalConfig.enabled` is
  // false, we don't just skip the caption LLM call — we ALSO
  // strip `![](url)` references from sourceContent before the LLM
  // sees it, AND skip the post-write safety-net injection further
  // down. Net effect: the wiki-side pipeline never references
  // images at all. Without the strip + skip, image references
  // would leak via two paths:
  //   1. The LLM-generation prompt sees them in sourceContent and
  //      can preserve them in the generated wiki pages
  //   2. injectImagesIntoSourceSummary unconditionally appends a
  //      `## Embedded Images` section to wiki/sources/<slug>.md
  // Both paths land image refs into wiki pages, which then get
  // embedded → searchable → visible in the search image grid even
  // though the user disabled captioning. This was the user-
  // surprising behavior that prompted the fix.
  //
  // Rust extraction itself is untouched: images still land on disk
  // under wiki/media/<slug>/ (cheap), and the raw-source preview
  // (which renders read_file output directly) still shows them —
  // that surface is "the source document as-is", separate from
  // "the curated wiki knowledge".
  let enrichedSourceContent = stripWikiMediaAbsPaths(
    pp,
    appendSavedImageRefsForCaption(sourceContent, savedImages),
  )
  const mmCfg = useWikiStore.getState().multimodalConfig
  const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
  if (!mmCfg.enabled && savedImages.length > 0) {
    // Strip `![alt](url)` references — match the same regex shape
    // we use elsewhere for image refs. Preserve a single space
    // where the ref used to sit so adjacent words don't fuse.
    enrichedSourceContent = sourceContent.replace(
      /!\[[^\]]*\]\([^)\s]+\)/g,
      " ",
    )
    console.log(
      `[ingest:caption] disabled — stripped image refs from sourceContent (${savedImages.length} image(s) won't appear in wiki pages)`,
    )
  } else if (
    captionLlm &&
    savedImages.length > 0 &&
    /!\[\]\(/.test(enrichedSourceContent)
  ) {
    activity.updateItem(activityId, { detail: "Captioning images..." })
    const ourMediaPrefix = `${pp}/wiki/media/${sourceSummarySlug}/`
    try {
      const result = await captionMarkdownImages(pp, enrichedSourceContent, captionLlm, {
        signal,
        // Strict filter: only caption images we know we just
        // extracted into this source's media directory. Skips any
        // pre-existing markdown image refs the user may have typed
        // into the source content (e.g. for hand-authored .md
        // sources).
        shouldCaption: (url) => url.startsWith(ourMediaPrefix) || isSavedImagePromptUrl(pp, sourceSummarySlug, url),
        urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
        concurrency: mmCfg.concurrency,
        onProgress: (done, total) =>
          activity.updateItem(activityId, {
            detail: `Captioning images... ${done}/${total}`,
          }),
      })
      enrichedSourceContent = stripWikiMediaAbsPaths(pp, result.enrichedMarkdown)
      console.log(
        `[ingest:caption] images=${savedImages.length} fresh=${result.freshCaptions} cached=${result.cachedCaptions} failed=${result.failed}`,
      )
    } catch (err) {
      console.warn(
        `[ingest:caption] pipeline failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
      // Fall through with original (empty-alt) source content —
      // captioning failure must NEVER break ingest.
    }
  }

  const stableContextLength = schema.length + purpose.length + index.length + overview.length
  const sourceBudget = computeIngestSourceBudget(llmConfig.maxContextSize, stableContextLength)
  let sourceContext = enrichedSourceContent
  let precomputedAnalysis = ""
  let longSourceCheckpointPath: string | undefined

  if (enrichedSourceContent.length > sourceBudget) {
    const longSourcePlan = await analyzeLongSourceInChunks(
      pp,
      llmConfig,
      purpose,
      schema,
      index,
      sourceIdentity,
      sourceSummarySlug,
      folderContext,
      enrichedSourceContent,
      sourceBudget,
      activityId,
      signal,
    )
    if (longSourcePlan.chunked) {
      sourceContext = longSourcePlan.sourceContext
      precomputedAnalysis = longSourcePlan.analysis
      longSourceCheckpointPath = longSourcePlan.checkpointPath
    }
  }

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  activity.updateItem(activityId, {
    detail: precomputedAnalysis
      ? "Step 1/2: Consolidating long-source analysis..."
      : "Step 1/2: Analyzing source...",
  })

  let analysis = precomputedAnalysis

  if (!analysis) {
    const analysisStartedAt = Date.now()
    let analysisSawFirstToken = false
    await appendIngestDebugLog(pp, sourceIdentity, "analysis_start", {
      elapsedMs: analysisStartedAt - ingestStartedAt,
      sourceContextChars: sourceContext.length,
      maxTokens: 4096,
    })
    await streamChat(
      llmConfig,
      [
        { role: "system", content: buildAnalysisPrompt(purpose, index, sourceContext, schema) },
        { role: "user", content: `Analyze this source document:\n\n**File:** ${sourceIdentity}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${sourceContext}` },
      ],
      {
        onToken: (token) => {
          if (!analysisSawFirstToken) {
            analysisSawFirstToken = true
            void appendIngestDebugLog(pp, sourceIdentity, "analysis_first_token", {
              elapsedMs: Date.now() - ingestStartedAt,
              msSinceStageStart: Date.now() - analysisStartedAt,
            })
          }
          analysis += token
        },
        onDone: () => {},
        onError: (err) => {
          activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${err.message}` })
        },
      },
      signal,
      { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: 4096 },
    )
    await appendIngestDebugLog(pp, sourceIdentity, "analysis_done", {
      elapsedMs: Date.now() - ingestStartedAt,
      durationMs: Date.now() - analysisStartedAt,
      analysisChars: analysis.length,
    })
  }

  // A silent `return []` here would look like success to the queue
  // runner and cause the task to be filter()'d out. Throw instead so
  // processNext's catch-block path (retry / mark failed) engages.
  const analysisActivity = useActivityStore.getState().items.find((i) => i.id === activityId)
  if (analysisActivity?.status === "error") {
    throw new Error(analysisActivity.detail || "Analysis stream failed")
  }

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes the analysis as context and produces wiki files + review items
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })

  let generation = ""

  const generationStartedAt = Date.now()
  let generationSawFirstToken = false
  const generationMaxTokens = computeIngestGenerationMaxTokensForSource(
    llmConfig.maxContextSize,
    sourceContext.length,
    analysis.length,
  )
  const reviewMaxTokens = computeIngestReviewMaxTokensForGeneration(generationMaxTokens)
  await appendIngestDebugLog(pp, sourceIdentity, "generation_start", {
    elapsedMs: generationStartedAt - ingestStartedAt,
    analysisChars: analysis.length,
    sourceContextChars: sourceContext.length,
    maxTokens: generationMaxTokens,
  })
  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildGenerationPrompt(schema, purpose, index, sourceIdentity, overview, sourceContext, sourceSummaryPath) },
      {
        role: "user",
        content: [
          `Source document to process: **${sourceIdentity}**`,
          "",
          "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
          "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
          "blocks as specified in the system prompt — nothing else.",
          "",
          "## Stage 1 Analysis (context only — do not repeat)",
          "",
          analysis,
          "",
          "## Source Context",
          "",
          sourceContext,
          "",
          "---",
          "",
          `Now emit the FILE blocks for the wiki files derived from **${sourceIdentity}**.`,
          "Your response MUST begin with `---FILE:` as the very first characters.",
          "No preamble. No analysis prose. Start immediately.",
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => {
        if (!generationSawFirstToken) {
          generationSawFirstToken = true
          void appendIngestDebugLog(pp, sourceIdentity, "generation_first_token", {
            elapsedMs: Date.now() - ingestStartedAt,
            msSinceStageStart: Date.now() - generationStartedAt,
          })
        }
        generation += token
      },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Generation failed: ${err.message}` })
      },
    },
    signal,
    {
      temperature: 0.1,
      reasoning: { mode: "off" },
      max_tokens: generationMaxTokens,
    },
  )
  await appendIngestDebugLog(pp, sourceIdentity, "generation_done", {
    elapsedMs: Date.now() - ingestStartedAt,
    durationMs: Date.now() - generationStartedAt,
    generationChars: generation.length,
    fileBlocks: countFileBlocks(generation),
    reviewStageEligible: shouldRunDedicatedReviewStage(generation),
  })

  const generationActivity = useActivityStore.getState().items.find((i) => i.id === activityId)
  if (generationActivity?.status === "error") {
    throw new Error(generationActivity.detail || "Generation stream failed")
  }
  throwIfIngestAborted(signal, activityId)

  let reviewSuggestionOutput = ""
  const runDedicatedReviewStage = !signal?.aborted && shouldRunDedicatedReviewStage(generation)
  await appendIngestDebugLog(pp, sourceIdentity, runDedicatedReviewStage ? "review_stage_start" : "review_stage_skip", {
    elapsedMs: Date.now() - ingestStartedAt,
    generationChars: generation.length,
    fileBlocks: countFileBlocks(generation),
  })
  if (runDedicatedReviewStage) {
    let reviewStageHadError = false
    const reviewStartedAt = Date.now()
    let reviewSawFirstToken = false
    try {
      await streamChat(
        llmConfig,
        [
          {
            role: "system",
            content: buildReviewSuggestionPrompt(
              purpose,
              index,
              sourceIdentity,
              analysis,
              sourceContext,
              generation,
              llmConfig.maxContextSize,
            ),
          },
          {
            role: "user",
            content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none.",
          },
        ],
        {
          onToken: (token) => {
            if (!reviewSawFirstToken) {
              reviewSawFirstToken = true
              void appendIngestDebugLog(pp, sourceIdentity, "review_stage_first_token", {
                elapsedMs: Date.now() - ingestStartedAt,
                msSinceStageStart: Date.now() - reviewStartedAt,
              })
            }
            reviewSuggestionOutput += token
          },
          onDone: () => {},
          onError: (err) => {
            reviewStageHadError = true
            console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}": ${err.message}`)
          },
        },
        signal,
        {
          temperature: 0.1,
          reasoning: { mode: "off" },
          max_tokens: reviewMaxTokens,
        },
      )
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}":`, err)
    }
    throwIfIngestAborted(signal, activityId)
    if (reviewStageHadError) reviewSuggestionOutput = ""
    await appendIngestDebugLog(pp, sourceIdentity, "review_stage_done", {
      elapsedMs: Date.now() - ingestStartedAt,
      durationMs: Date.now() - reviewStartedAt,
      outputChars: reviewSuggestionOutput.length,
      hadError: reviewStageHadError,
    })
  }

  // ── Step 3: Write files ───────────────────────────────────────
  throwIfIngestAborted(signal, activityId)
  activity.updateItem(activityId, { detail: "Writing files..." })
  await appendIngestDebugLog(pp, sourceIdentity, "write_start", {
    elapsedMs: Date.now() - ingestStartedAt,
    generationChars: generation.length,
    reviewOutputChars: reviewSuggestionOutput.length,
  })
  await migrateLegacySourceSummaryIfSafe(pp, sourceIdentity, sourceSummaryPath)
  const writeResult = await writeFileBlocks(
    pp,
    generation,
    llmConfig,
    sourceIdentity,
    sourceSummaryPath,
    signal,
    activityId,
    onFileWritten,
  )
  throwIfIngestAborted(signal, activityId)
  const writtenPaths = writeResult.writtenPaths
  const writeWarnings = writeResult.warnings
  const hardFailures = writeResult.hardFailures
  await appendIngestDebugLog(pp, sourceIdentity, "write_done", {
    elapsedMs: Date.now() - ingestStartedAt,
    writtenCount: writtenPaths.length,
    warningCount: writeWarnings.length,
    hardFailureCount: hardFailures.length,
    writtenPaths,
  })

  const aggregateRepairPaths = aggregatePathsNeedingRepair(writtenPaths, writeWarnings)
  const repairableAggregatePaths = aggregateRepairPaths.filter((path) =>
    isAggregateRepairSafe(path, index, overview, llmConfig.maxContextSize),
  )
  const skippedAggregatePaths = aggregateRepairPaths.filter((path) =>
    !repairableAggregatePaths.includes(path),
  )
  if (skippedAggregatePaths.length > 0) {
    writeWarnings.push(
      `Skipped aggregate repair for ${skippedAggregatePaths.join(", ")} because the existing file is too large to safely regenerate without truncating existing entries.`,
    )
  }
  if (repairableAggregatePaths.length > 0 && !signal?.aborted) {
    activity.updateItem(activityId, {
      detail: `Repairing aggregate wiki files: ${repairableAggregatePaths.join(", ")}`,
    })
    const aggregateStartedAt = Date.now()
    let aggregateSawFirstToken = false
    await appendIngestDebugLog(pp, sourceIdentity, "aggregate_repair_start", {
      elapsedMs: aggregateStartedAt - ingestStartedAt,
      paths: repairableAggregatePaths,
    })
    let aggregateRepairOutput = ""
    try {
      await streamChat(
        llmConfig,
        [
          {
            role: "system",
            content: buildAggregateRepairPrompt(
              repairableAggregatePaths,
              purpose,
              index,
              overview,
              sourceIdentity,
              analysis,
              sourceContext,
              generation,
              llmConfig.maxContextSize,
            ),
          },
          {
            role: "user",
            content: "Emit the requested aggregate FILE blocks now. Start immediately with `---FILE:`.",
          },
        ],
        {
          onToken: (token) => {
            if (!aggregateSawFirstToken) {
              aggregateSawFirstToken = true
              void appendIngestDebugLog(pp, sourceIdentity, "aggregate_repair_first_token", {
                elapsedMs: Date.now() - ingestStartedAt,
                msSinceStageStart: Date.now() - aggregateStartedAt,
              })
            }
            aggregateRepairOutput += token
          },
          onDone: () => {},
          onError: (err) => {
            writeWarnings.push(`Aggregate repair failed: ${err.message}`)
          },
        },
        signal,
        {
          temperature: 0.1,
          reasoning: { mode: "off" },
          max_tokens: reviewMaxTokens,
        },
      )
      throwIfIngestAborted(signal, activityId)
      if (aggregateRepairOutput.trim()) {
        const filteredRepair = filterAggregateRepairOutput(
          aggregateRepairOutput,
          repairableAggregatePaths,
        )
        writeWarnings.push(...filteredRepair.warnings)
        const repairResult = await writeFileBlocks(
          pp,
          filteredRepair.text,
          llmConfig,
          sourceIdentity,
          sourceSummaryPath,
          signal,
          activityId,
          onFileWritten,
        )
        writtenPaths.push(...repairResult.writtenPaths)
        writeWarnings.push(...repairResult.warnings)
        hardFailures.push(...repairResult.hardFailures)
      }
      await appendIngestDebugLog(pp, sourceIdentity, "aggregate_repair_done", {
        elapsedMs: Date.now() - ingestStartedAt,
        durationMs: Date.now() - aggregateStartedAt,
        outputChars: aggregateRepairOutput.length,
        writtenCount: writtenPaths.length,
        warningCount: writeWarnings.length,
      })
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      writeWarnings.push(
        `Aggregate repair failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      await appendIngestDebugLog(pp, sourceIdentity, "aggregate_repair_error", {
        elapsedMs: Date.now() - ingestStartedAt,
        durationMs: Date.now() - aggregateStartedAt,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Surface parser / writer warnings to the activity panel so users
  // don't have to open devtools to find out a block was dropped.
  // Keeping the base "Writing files..." detail on top and appending the
  // first few warnings; full list is also persisted to .llm-wiki.
  let warningSummary = ""
  if (writeWarnings.length > 0) {
    await appendIngestWarningLog(pp, sourceIdentity, writeWarnings)
    warningSummary = writeWarnings.length === 1
      ? writeWarnings[0]
      : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in .llm-wiki/ingest-warnings.log)` : ""}`
    activity.updateItem(activityId, { detail: `${warningSummary} — saved to .llm-wiki/ingest-warnings.log` })
  }

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  const hasSourceSummary = writtenPaths.some((p) => normalizePath(p) === sourceSummaryPath)

  // If the signal was aborted (e.g. user switched projects / cancelled),
  // skip the fallback summary write — the LLM streams returned empty
  // via the abort fast-path (onDone), and writing a stub file into the
  // old project's wiki would both be noise and mask the error.
  // Returning no files lets processNext's length-0 safety net mark the
  // task for retry rather than "success".
  if (!hasSourceSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = [
      "---",
      `type: source`,
      `title: "Source: ${sourceIdentity}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${sourceIdentity}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${sourceIdentity}`,
      "",
      analysis ? analysis.slice(0, 3000) : "(Analysis not available)",
      "",
    ].join("\n")
    try {
      await writeFile(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
      onFileWritten?.(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  // ── Step 3.5: Append extracted images to the source-summary page ─
  // Skipped when the master toggle is off — see Step 0.6 above for
  // the full rationale. With captioning disabled we also don't
  // want the safety-net section to slip image refs into the wiki
  // through the back door.
  if (mmCfg.enabled && savedImages.length > 0 && !signal?.aborted) {
    await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
  }

  if (writtenPaths.length > 0) {
    try {
      await appendIngestDebugLog(pp, sourceIdentity, "refresh_tree_start", {
        elapsedMs: Date.now() - ingestStartedAt,
        writtenCount: writtenPaths.length,
      })
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
      await appendIngestDebugLog(pp, sourceIdentity, "refresh_tree_done", {
        elapsedMs: Date.now() - ingestStartedAt,
      })
    } catch {
      // ignore
    }
  }

  // ── Step 4: Parse review items ────────────────────────────────
  throwIfIngestAborted(signal, activityId)
  const reviewItems = [
    ...parseReviewBlocks(generation, sp),
    ...parseReviewBlocks(reviewSuggestionOutput, sp),
  ]
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  // Skip cache when ANY block hit a hard FS failure: we'd otherwise
  // freeze the partial-write result into the cache and a future
  // re-ingest of the same source would silently replay only the
  // pages that succeeded the first time, never giving the user a
  // chance to recover the failed ones. Soft drops (language
  // mismatch, path-traversal rejection, empty-path) are NOT failures
  // — they represent deterministic decisions and caching them is
  // safe.
  if (writtenPaths.length > 0 && hardFailures.length === 0) {
    await saveIngestCache(pp, sourceIdentity, sourceContent, writtenPaths)
    if (longSourceCheckpointPath) {
      await clearLongSourceCheckpoint(longSourceCheckpointPath)
    }
  } else if (hardFailures.length > 0) {
    console.warn(
      `[ingest] Skipping cache save for "${sourceIdentity}" — ${hardFailures.length} block(s) failed to write: ${hardFailures.join(", ")}`,
    )
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    try {
      await appendIngestDebugLog(pp, sourceIdentity, "embedding_start", {
        elapsedMs: Date.now() - ingestStartedAt,
        writtenCount: writtenPaths.length,
        model: embCfg.model,
      })
      const { embedPage } = await import("@/lib/embedding")
      for (const wpath of writtenPaths) {
        const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
          const title = titleMatch ? titleMatch[1].trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
      await appendIngestDebugLog(pp, sourceIdentity, "embedding_done", {
        elapsedMs: Date.now() - ingestStartedAt,
      })
    } catch {
      // embedding module not available
    }
  }

  const baseDetail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"
  const detail = warningSummary
    ? `${baseDetail} — ${warningSummary} (saved to .llm-wiki/ingest-warnings.log)`
    : baseDetail

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })
  await appendIngestDebugLog(pp, sourceIdentity, "done", {
    elapsedMs: Date.now() - ingestStartedAt,
    writtenCount: writtenPaths.length,
    reviewCount: reviewItems.length,
    warningCount: writeWarnings.length,
    hardFailureCount: hardFailures.length,
  })

  return writtenPaths
}
