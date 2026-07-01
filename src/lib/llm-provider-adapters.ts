import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"

export function isDeepSeekEndpoint(config: LlmConfig): boolean {
  return /deepseek/i.test(config.model) || /deepseek/i.test(config.customEndpoint)
}

export function supportsDeepSeekThinkingParam(config: LlmConfig): boolean {
  return /deepseek[-_]?v4/i.test(config.model)
}

export function isQwenThinkingModel(model: string): boolean {
  return /qwen[-_]?3/i.test(model)
}

function isKimiEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])kimi([/:.-]|$)/i.test(config.model)
    || /moonshot/i.test(config.model)
    || /api\.moonshot\.(ai|cn)/i.test(config.customEndpoint)
}

export function isBillingAiEndpoint(config: LlmConfig): boolean {
  return /(?:^|\/\/)billing-ai\.doublezero\.kr(?:[:/]|$)/i.test(config.customEndpoint)
}

function isXiaomiMimoEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])mimo([/:.-]|$)/i.test(config.model)
    || /\.?xiaomimimo\.com(?::|\/|$)/i.test(config.customEndpoint)
}

function isOpenAiStrictCompletionModel(config: LlmConfig): boolean {
  if ((config.provider === "azure" || (config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)))
    && config.azureModelFamily === "gpt5") {
    return true
  }

  const model = config.model.trim().toLowerCase()
  const strictModel =
    /^gpt-5(?:[.\-_]|$)/.test(model) || /^o\d+(?:[.\-_]|$)/.test(model)
  if (!strictModel) return false
  if (config.provider === "openai" || config.provider === "azure") return true
  return config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)
}

export function adaptOpenAiStrictCompletionBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isOpenAiStrictCompletionModel(config)) return

  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  // GPT-5 / o-series Chat Completions deployments reject non-default
  // sampling knobs. Structured ingest passes temperature=0.1, so strip
  // these only on the strict OpenAI path; custom/OpenRouter-compatible
  // routes keep their existing behavior.
  delete body.temperature
  delete body.top_p
  delete body.top_k
}

export function adaptKimiBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isKimiEndpoint(config)) return

  // Moonshot/Kimi OpenAI-compatible endpoints reject non-default
  // temperature values for several current models ("only 1 is allowed").
  // Structured ingest/dedup pass temperature=0.1 for determinism, so
  // omit it and let the endpoint use its required default.
  delete body.temperature
}

export function adaptBillingAiBody(
  config: LlmConfig,
  body: Record<string, unknown>,
  reasoning: ReasoningConfig,
): void {
  if (!isBillingAiEndpoint(config)) return

  // Billing AI exposes multi-vendor models through an OpenAI-compatible
  // gateway. Several current flagship ids (claude-opus-4-8, gpt-5-5)
  // reject explicit temperature even though older ids accept it, so omit
  // caller-provided deterministic sampling knobs for this gateway.
  delete body.temperature

  // Smoke-tested against Billing AI: none/low/medium/high/max are accepted.
  // Their API also accepts "xhigh", but LLM Wiki's global reasoning UI
  // does not currently expose that provider-specific level.
  if (reasoning.mode === "off") {
    body.reasoning_effort = "none"
  } else if (
    reasoning.mode === "low" ||
    reasoning.mode === "medium" ||
    reasoning.mode === "high" ||
    reasoning.mode === "max"
  ) {
    body.reasoning_effort = reasoning.mode
  }
}

export function adaptXiaomiMimoBody(
  config: LlmConfig,
  body: Record<string, unknown>,
  reasoning: ReasoningConfig,
): void {
  if (!isXiaomiMimoEndpoint(config)) return

  // Xiaomi MiMo's OpenAI-compatible examples use
  // `max_completion_tokens`. Accept callers' provider-agnostic
  // `max_tokens` override but send the documented field on the wire.
  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  // Official thinking-mode control documents `thinking.type=disabled`.
  // Do not invent an enabled/budget shape here; omitting the field lets
  // the server apply the model default.
  if (reasoning.mode === "off") {
    body.thinking = { type: "disabled" }
  } else {
    // MiMo v2.5 thinking mode forces temperature=1.0 and rejects
    // custom temperature. Structured ingest passes temperature=0.1,
    // but it also passes reasoning off above, so keep deterministic
    // non-thinking requests intact while protecting thinking requests.
    delete body.temperature
  }
}
