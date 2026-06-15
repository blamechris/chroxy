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
 * Claude-backed docker provider ids — an EXPLICIT allowlist, not a `docker-*`
 * prefix (#5448). Every id here runs a Claude session inside the container
 * (docker-cli / docker-sdk / docker-byok, plus the `docker` alias for docker-cli
 * — see provider-labels.ts and the server's registerDockerProvider). It is an
 * allowlist so a FUTURE non-Claude containerized provider registered under a
 * `docker-*` name (e.g. `docker-ollama`) FAILS CLOSED — it does NOT inherit the
 * Claude 200k default and instead resolves to a real `null` meter (the failure
 * mode #5424 fixed for ollama). The server pins its own DOCKER_PROVIDER_IDS to
 * this same set (providers.js) — each side's test fails if its list drifts — so
 * adding a docker provider trips a test and forces a conscious "is it
 * Claude-backed?" decision in both packages, instead of silently regressing the
 * context-window meter. (The two lists can't share an import: the server loads
 * only @chroxy/store-core/crypto, not this TS main entry.)
 */
export const CLAUDE_BACKED_DOCKER_IDS: ReadonlySet<string> = new Set([
  'docker', 'docker-cli', 'docker-sdk', 'docker-byok',
])

/**
 * Whether `provider` runs Claude models (and so may assume the Claude
 * 200k default when a model's `contextWindow` is missing).
 *
 * The claude-* family is matched by prefix (open-ended — every claude-* is
 * Claude). The docker family is matched by the EXPLICIT CLAUDE_BACKED_DOCKER_IDS
 * allowlist (#5448), NOT a `docker-*` prefix, so an unknown `docker-*` fails
 * closed rather than fabricating a 200k meter.
 *
 * `null`/`undefined` counts as Claude-backed: servers that predate
 * per-session provider reporting only ran claude, so the legacy fallback
 * behaviour is preserved for them.
 */
export function isClaudeBackedProvider(provider: string | null | undefined): boolean {
  if (provider == null) return true
  if (provider === 'claude' || provider.startsWith('claude-')) return true
  return CLAUDE_BACKED_DOCKER_IDS.has(provider)
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
