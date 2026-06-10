/**
 * #5424 — context-window resolution shared by the mobile SettingsBar and the
 * dashboard header/footer meters.
 *
 * `DEFAULT_CONTEXT_WINDOW` (200k) is a *Claude* default. The server's claude
 * registry always ships a real `contextWindow` per model, so the fallback
 * only fires for legacy servers that predate the field — which only ran
 * claude. Other providers can legitimately report no window at all: ollama
 * deliberately sends `contextWindow: null` (the effective window is the
 * local model file's `num_ctx` — the server never fabricates a number).
 * Rendering "% of 200k" for a local model whose real window may be 8k–32k
 * is misleading in the dangerous direction (looks fine while the model is
 * already truncating), so unknown stays unknown: callers get `null` and
 * must render an "unknown window" presentation (raw token count, no
 * percentage / progress bar) instead of a fabricated fraction.
 */
import { DEFAULT_CONTEXT_WINDOW } from './types'
import type { ModelInfo } from './types'

/**
 * Providers whose sessions are backed by Claude models and therefore
 * genuinely have the 200k default: the claude-* family plus the docker-*
 * wrappers (docker-cli / docker-sdk / docker-byok / docker all run a Claude
 * session inside the container — see provider-labels.ts).
 */
const CLAUDE_BACKED_PREFIXES = ['claude', 'docker'] as const

/**
 * Whether `provider` runs Claude models (and so may assume the Claude
 * 200k default when a model's `contextWindow` is missing).
 *
 * `null`/`undefined` counts as Claude-backed: servers that predate
 * per-session provider reporting only ran claude, so the legacy fallback
 * behaviour is preserved for them.
 */
export function isClaudeBackedProvider(provider: string | null | undefined): boolean {
  if (provider == null) return true
  return CLAUDE_BACKED_PREFIXES.some(
    (prefix) => provider === prefix || provider.startsWith(`${prefix}-`),
  )
}

/**
 * Resolve the context window (in tokens) to meter against for a model.
 *
 * - When the model reports a positive numeric `contextWindow`, that value
 *   wins — provider is irrelevant.
 * - When it's missing, the Claude 200k default applies ONLY to
 *   Claude-backed providers (see `isClaudeBackedProvider`).
 * - Otherwise returns `null`: the window is genuinely unknown and callers
 *   must not render a percentage against a made-up total.
 */
export function resolveContextWindow(
  modelInfo: Pick<ModelInfo, 'contextWindow'> | null | undefined,
  provider?: string | null,
): number | null {
  const cw = modelInfo?.contextWindow
  if (typeof cw === 'number' && Number.isFinite(cw) && cw > 0) return cw
  return isClaudeBackedProvider(provider) ? DEFAULT_CONTEXT_WINDOW : null
}
