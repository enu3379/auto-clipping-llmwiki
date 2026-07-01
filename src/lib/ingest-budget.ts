import { computeContextBudget } from "@/lib/context-budget"

const LONG_SOURCE_MIN_BUDGET = 8_000
const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET = 300_000
const INGEST_GENERATION_TOKENS_DEFAULT = 8_192
const INGEST_GENERATION_TOKENS_128K = 16_384
const INGEST_GENERATION_TOKENS_256K = 24_576
const INGEST_GENERATION_TOKENS_512K = 32_768

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function computeIngestSourceBudget(
  maxContextSize: number | undefined,
  stableContextLength: number,
): number {
  const { maxCtx, responseReserve } = computeContextBudget(maxContextSize)
  const stableReserve = Math.min(Math.floor(maxCtx * 0.25), Math.max(12_000, stableContextLength))
  const instructionReserve = Math.max(12_000, Math.floor(maxCtx * 0.08))
  const available = maxCtx - responseReserve - stableReserve - instructionReserve
  const upper = Math.min(LONG_SOURCE_MAX_SINGLE_PASS_BUDGET, Math.max(LONG_SOURCE_MIN_BUDGET, Math.floor(maxCtx * 0.6)))
  return clampNumber(Math.floor(available), LONG_SOURCE_MIN_BUDGET, upper)
}

export function computeIngestGenerationMaxTokens(maxContextSize: number | undefined): number {
  const { maxCtx } = computeContextBudget(maxContextSize)
  if (maxCtx >= 512_000) return INGEST_GENERATION_TOKENS_512K
  if (maxCtx >= 256_000) return INGEST_GENERATION_TOKENS_256K
  if (maxCtx >= 128_000) return INGEST_GENERATION_TOKENS_128K
  return INGEST_GENERATION_TOKENS_DEFAULT
}

export function computeIngestGenerationMaxTokensForSource(
  maxContextSize: number | undefined,
  sourceContextLength: number,
  analysisLength: number,
): number {
  const base = computeIngestGenerationMaxTokens(maxContextSize)
  const signalChars = Math.max(0, sourceContextLength) + Math.max(0, analysisLength)
  if (signalChars <= 20_000) return Math.min(base, INGEST_GENERATION_TOKENS_DEFAULT)
  if (signalChars <= 80_000) return Math.min(base, INGEST_GENERATION_TOKENS_128K)
  if (signalChars <= 180_000) return Math.min(base, INGEST_GENERATION_TOKENS_256K)
  return base
}

export function computeIngestReviewMaxTokensForGeneration(generationMaxTokens: number): number {
  return Math.min(8_192, Math.max(4_096, Math.floor(generationMaxTokens / 2)))
}

export function computeIngestReviewMaxTokens(maxContextSize: number | undefined): number {
  return computeIngestReviewMaxTokensForGeneration(computeIngestGenerationMaxTokens(maxContextSize))
}
