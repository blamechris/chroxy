/**
 * Per-model token pricing for cost estimation.
 *
 * Rates are in USD per 1,000 tokens (to keep numbers human-readable).
 * Sources:
 *   Claude  — https://www.anthropic.com/pricing (accessed 2025-04)
 *   Codex   — https://platform.openai.com/docs/pricing (accessed 2025-04)
 *   Gemini  — https://ai.google.dev/pricing (accessed 2025-04)
 *
 * Prices are conservative public rates; cached/discounted prices are not
 * included. When a model ships tiered pricing (e.g. Gemini 2.5 Pro context
 * window tiers) we use the higher-tier (>200k) rate.
 */

export interface ModelPricing {
  /** USD per 1,000 input tokens */
  inputPer1k: number
  /** USD per 1,000 output tokens */
  outputPer1k: number
  /** Human-readable model display name */
  label: string
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

const CLAUDE_PRICING: Record<string, ModelPricing> = {
  // #5631 — current-generation Claude models, kept correct and consistent
  // with the server's authoritative CLAUDE_PRICING_USD_PER_MTOK table
  // (packages/server/src/models.js), converted from USD/Mtok to USD/1k.
  // NOTE: this table only feeds calculateCost behind CLIENT_ESTIMATED_COST_
  // PROVIDERS, which today is {codex, gemini} — Claude is NOT in it, so these
  // Claude rows are not currently on any live cost path (Claude cost is
  // server-authoritative). They exist to remove the stale 3.x-era data and
  // keep the table right for any future consumer / if Claude is ever added to
  // that set. (opus-4-8 + fable-5 are intentionally absent — the server
  // doesn't price them yet either; tracked under #5631. The drift-warn in
  // calculateCost surfaces any offered-but-unpriced model.)
  'claude-opus-4-7': { inputPer1k: 0.015, outputPer1k: 0.075, label: 'Claude Opus 4.7' },
  'claude-sonnet-4-6': { inputPer1k: 0.003, outputPer1k: 0.015, label: 'Claude Sonnet 4.6' },
  'claude-haiku-4-5': { inputPer1k: 0.001, outputPer1k: 0.005, label: 'Claude Haiku 4.5' },
  // Claude Sonnet 4.5 — previously mislabeled "Claude 3.7 Sonnet" (the rate
  // is the standard Sonnet tier, only the display name was wrong).
  'claude-sonnet-4-5': { inputPer1k: 0.003, outputPer1k: 0.015, label: 'Claude Sonnet 4.5' },
  // Claude 3.7 Sonnet
  'claude-3-7-sonnet-20250219': { inputPer1k: 0.003, outputPer1k: 0.015, label: 'Claude 3.7 Sonnet' },
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet-20241022': { inputPer1k: 0.003, outputPer1k: 0.015, label: 'Claude 3.5 Sonnet' },
  'claude-3-5-sonnet-20240620': { inputPer1k: 0.003, outputPer1k: 0.015, label: 'Claude 3.5 Sonnet (Jun)' },
  // Claude 3.5 Haiku
  'claude-3-5-haiku-20241022': { inputPer1k: 0.0008, outputPer1k: 0.004, label: 'Claude 3.5 Haiku' },
  // Claude 3 Opus
  'claude-3-opus-20240229': { inputPer1k: 0.015, outputPer1k: 0.075, label: 'Claude 3 Opus' },
  // Claude 3 Haiku
  'claude-3-haiku-20240307': { inputPer1k: 0.00025, outputPer1k: 0.00125, label: 'Claude 3 Haiku' },
}

// ---------------------------------------------------------------------------
// Codex / OpenAI
// Source: https://platform.openai.com/docs/pricing
// ---------------------------------------------------------------------------

const CODEX_PRICING: Record<string, ModelPricing> = {
  // GPT-5 Codex (hypothetical future model — conservative placeholder matching GPT-4o scale)
  'gpt-5-codex': { inputPer1k: 0.01, outputPer1k: 0.03, label: 'GPT-5 Codex' },
  // GPT-5
  'gpt-5': { inputPer1k: 0.01, outputPer1k: 0.03, label: 'GPT-5' },
  // GPT-4.1 — https://platform.openai.com/docs/pricing (2025-04)
  'gpt-4.1': { inputPer1k: 0.002, outputPer1k: 0.008, label: 'GPT-4.1' },
  'gpt-4.1-mini': { inputPer1k: 0.0004, outputPer1k: 0.0016, label: 'GPT-4.1 mini' },
  'gpt-4.1-nano': { inputPer1k: 0.0001, outputPer1k: 0.0004, label: 'GPT-4.1 nano' },
  // GPT-4o — https://platform.openai.com/docs/pricing (2025-04)
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01, label: 'GPT-4o' },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006, label: 'GPT-4o mini' },
  // o1 — https://platform.openai.com/docs/pricing (2025-04)
  'o1': { inputPer1k: 0.015, outputPer1k: 0.06, label: 'o1' },
  'o1-mini': { inputPer1k: 0.003, outputPer1k: 0.012, label: 'o1-mini' },
  'o1-pro': { inputPer1k: 0.15, outputPer1k: 0.6, label: 'o1-pro' },
  // o3 — https://platform.openai.com/docs/pricing (2025-04)
  'o3': { inputPer1k: 0.01, outputPer1k: 0.04, label: 'o3' },
  'o3-mini': { inputPer1k: 0.0011, outputPer1k: 0.0044, label: 'o3-mini' },
  'o4-mini': { inputPer1k: 0.0011, outputPer1k: 0.0044, label: 'o4-mini' },
}

// ---------------------------------------------------------------------------
// Gemini (Google)
// Source: https://ai.google.dev/pricing
// ---------------------------------------------------------------------------

const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 2.5 Pro — tiered; using >200k context rate
  // https://ai.google.dev/pricing#2_5pro
  'gemini-2.5-pro': { inputPer1k: 0.00125, outputPer1k: 0.01, label: 'Gemini 2.5 Pro' },
  'gemini-2.5-pro-preview-03-25': { inputPer1k: 0.00125, outputPer1k: 0.01, label: 'Gemini 2.5 Pro Preview' },
  'gemini-2.5-pro-exp-03-25': { inputPer1k: 0.00125, outputPer1k: 0.01, label: 'Gemini 2.5 Pro Exp' },
  // Gemini 2.5 Flash — tiered; using >200k context rate
  // https://ai.google.dev/pricing#2_5flash
  'gemini-2.5-flash': { inputPer1k: 0.0003, outputPer1k: 0.0025, label: 'Gemini 2.5 Flash' },
  'gemini-2.5-flash-preview-04-17': { inputPer1k: 0.0003, outputPer1k: 0.0025, label: 'Gemini 2.5 Flash Preview' },
  // Gemini 2.0 Pro — offered by the Gemini provider (gemini-session.js) but had
  // no GA pricing as an experimental model; use the 2.5 Pro >200k rate as a
  // conservative estimation proxy so its cost badge isn't blank.
  'gemini-2.0-pro': { inputPer1k: 0.00125, outputPer1k: 0.01, label: 'Gemini 2.0 Pro' },
  // Gemini 2.0 Flash — https://ai.google.dev/pricing#2_0flash
  'gemini-2.0-flash': { inputPer1k: 0.0001, outputPer1k: 0.0004, label: 'Gemini 2.0 Flash' },
  'gemini-2.0-flash-001': { inputPer1k: 0.0001, outputPer1k: 0.0004, label: 'Gemini 2.0 Flash 001' },
  'gemini-2.0-flash-exp': { inputPer1k: 0.0001, outputPer1k: 0.0004, label: 'Gemini 2.0 Flash Exp' },
  'gemini-2.0-flash-lite': { inputPer1k: 0.000075, outputPer1k: 0.0003, label: 'Gemini 2.0 Flash-Lite' },
  // Gemini 1.5 Pro — https://ai.google.dev/pricing#1_5pro
  'gemini-1.5-pro': { inputPer1k: 0.00125, outputPer1k: 0.005, label: 'Gemini 1.5 Pro' },
  'gemini-1.5-pro-002': { inputPer1k: 0.00125, outputPer1k: 0.005, label: 'Gemini 1.5 Pro 002' },
  // Gemini 1.5 Flash — https://ai.google.dev/pricing#1_5flash
  'gemini-1.5-flash': { inputPer1k: 0.000075, outputPer1k: 0.0003, label: 'Gemini 1.5 Flash' },
  'gemini-1.5-flash-002': { inputPer1k: 0.000075, outputPer1k: 0.0003, label: 'Gemini 1.5 Flash 002' },
  'gemini-1.5-flash-8b': { inputPer1k: 0.0000375, outputPer1k: 0.00015, label: 'Gemini 1.5 Flash-8B' },
}

// ---------------------------------------------------------------------------
// Merged lookup table
// ---------------------------------------------------------------------------

export const MODEL_PRICING: Record<string, ModelPricing> = {
  ...CLAUDE_PRICING,
  ...CODEX_PRICING,
  ...GEMINI_PRICING,
}

// Drift detection: an offered model that has no pricing row renders a BLANK
// cost badge — silent, so the table quietly falls behind as providers ship new
// models. Warn once per unknown model id (deduped) so the gap is visible in the
// dev console instead of going unnoticed. Module-level so it persists across
// calls; `_resetPricingDriftWarnings` is a test seam.
const _warnedUnknownModels = new Set<string>()

/** @internal test seam — clear the deduped drift-warning set. */
export function _resetPricingDriftWarnings(): void {
  _warnedUnknownModels.clear()
}

/**
 * Calculate the estimated cost in USD for a model invocation.
 *
 * @param modelId    - The model identifier string (e.g. 'gpt-4o', 'gemini-2.5-pro').
 * @param inputTokens  - Number of input/prompt tokens consumed.
 * @param outputTokens - Number of output/completion tokens generated.
 * @returns USD cost, or `null` when the model is not in the pricing table.
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = MODEL_PRICING[modelId]
  if (!pricing) {
    if (modelId && !_warnedUnknownModels.has(modelId)) {
      _warnedUnknownModels.add(modelId)
      console.warn(
        `[model-pricing] no pricing entry for "${modelId}" — its cost estimate will be blank. Add it to model-pricing.ts.`,
      )
    }
    return null
  }
  return (
    (inputTokens / 1000) * pricing.inputPer1k +
    (outputTokens / 1000) * pricing.outputPer1k
  )
}

/**
 * Look up the pricing entry for a model, returning undefined when unknown.
 */
export function getModelPricing(modelId: string): ModelPricing | undefined {
  return MODEL_PRICING[modelId]
}
