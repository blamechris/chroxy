import { getRegistryForProvider } from '../models.js'

/**
 * Shared context-window learn-loop helper (#3857, #4414).
 *
 * Providers ship static `contextWindow` values in their per-model metadata
 * (see `*-session.js` `*_MODEL_METADATA` tables). Those values drift — the
 * original 272k → 400k drift on `gpt-5` / `gpt-5-codex` is the canonical
 * example, but the same exposure exists for every provider that publishes a
 * fixed window: Gemini 2.5 Pro can grow past its current 2M cap, etc.
 *
 * This helper watches the per-turn `input_tokens` reported by the provider's
 * end-of-turn JSONL event. When the observed value exceeds the registered
 * window for the active model, it ratchets the registry entry upward to
 * `inputTokens * HEADROOM` (rounded up to the nearest 1k for a clean meter
 * reading) and emits `models_updated` so connected dashboards refresh.
 *
 * Only ratchets *up* — a single small turn must never shrink the registered
 * window (the model didn't change, only the prompt size for this one turn).
 */

/**
 * Headroom multiplier applied to the observed input_tokens before writing
 * it back to the registry. Gives the next turn a bit of slack before it
 * pegs the meter again. Exported so tests can verify the exact ratchet
 * target without recomputing the magic number.
 */
export const CONTEXT_WINDOW_HEADROOM = 1.1

/**
 * Per-provider sanity cap on the ratchet target. A single `input_tokens`
 * value with a corrupt or malicious payload (overflow, JSONL parse glitch,
 * future CLI bug) must not be able to balloon the registered window to an
 * absurd number. Each cap is set well above the largest currently published
 * window for that provider — any legit future model that exceeds it should
 * bump the cap, not silently leak through.
 *
 *   codex  → 2,000,000 (today's max is 1M for gpt-4.1 / certain 1M GPT-5
 *            variants on plan tiers)
 *   gemini → 4,000,000 (today's max is 2M for gemini-2.5-pro / gemini-2.0-pro
 *            / gemini-1.5-pro; doubling leaves room for the next-gen bump
 *            without needing another source change)
 */
export const CONTEXT_WINDOW_RATCHET_CAPS = Object.freeze({
  codex: 2_000_000,
  gemini: 4_000_000,
})

/**
 * Default cap used when a provider isn't listed in CONTEXT_WINDOW_RATCHET_CAPS.
 * Picked to match Codex's original 2M ceiling so existing callers see no
 * behaviour change if they happen to pass an unknown providerName.
 */
export const DEFAULT_CONTEXT_WINDOW_RATCHET_CAP = 2_000_000

/**
 * Look up the configured cap for a given provider, falling back to the
 * default if the provider isn't in the table.
 *
 * @param {string} providerName
 * @returns {number}
 */
export function getRatchetCap(providerName) {
  // `Object.hasOwn` so a prototype-key lookup (`'constructor'`, `'toString'`,
  // etc.) doesn't return the inherited member and NaN-poison the ratchet math
  // downstream (`Math.min(n * 1.1, Object)` → NaN). In practice providerName
  // only ever comes from registered names, but this closes the theoretical
  // hole for ~one extra line.
  if (Object.hasOwn(CONTEXT_WINDOW_RATCHET_CAPS, providerName)) {
    return CONTEXT_WINDOW_RATCHET_CAPS[providerName]
  }
  return DEFAULT_CONTEXT_WINDOW_RATCHET_CAP
}

/**
 * Shared learn-loop helper. Ratchets the registered context window for
 * `modelId` upward when `inputTokens` exceeds the current entry. No-ops on:
 *
 *   - unknown model id (an unknown providerName falls through to the default
 *     Claude registry via `getRegistryForProvider`, so the no-op fires at the
 *     entry lookup — not at the registry lookup)
 *   - inputTokens not a finite positive number (corrupt JSONL — NaN * 1.1 =
 *     NaN; Infinity * 1.1 = Infinity → unbounded growth)
 *   - inputTokens at or below the registered window (no drift signal)
 *
 * Emits `models_updated` on the provided `emit` callback when the registry
 * was updated, so connected dashboards pick up the corrected window without
 * waiting for the next refresh. Mirrors the Claude SDK path in sdk-session.js
 * which has an explicit `contextWindow` field — here we infer it from the
 * observed token count.
 *
 * @param {string} providerName  Provider key (e.g. 'codex', 'gemini')
 * @param {string} modelId  Short id or fullId of the active model
 * @param {number} inputTokens  `usage.input_tokens` from the end-of-turn event
 * @param {(eventName: string, payload: object) => void} emit  Callback used to
 *   broadcast `models_updated` when the registry was updated. Typically
 *   `session.emit.bind(session)`.
 * @returns {boolean}  true when the registry was updated, false when no-op
 */
export function maybeRatchetContextWindow(providerName, modelId, inputTokens, emit) {
  // Defensive guard against corrupt/malicious JSONL — a non-finite or
  // negative `input_tokens` must not feed the ratchet math.
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return false

  const registry = getRegistryForProvider(providerName)
  if (!registry) return false

  // Look up the active model in the registry to read its current window.
  // Match on either short id or fullId — the registry stores both.
  const models = registry.getModels()
  const entry = models.find(m => m.id === modelId || m.fullId === modelId)
  if (!entry) return false
  if (typeof entry.contextWindow !== 'number' || entry.contextWindow <= 0) return false

  if (inputTokens <= entry.contextWindow) return false

  const cap = getRatchetCap(providerName)

  // Round the bumped value up to the nearest 1k so the meter shows a clean
  // number ("440k" not "440231") and we don't write a fresh cache entry on
  // every single turn for sub-1k variation. Capped at the per-provider
  // ratchet cap so a single corrupt turn can't balloon the registry.
  const raw = Math.min(inputTokens * CONTEXT_WINDOW_HEADROOM, cap)
  const bumped = Math.ceil(raw / 1000) * 1000

  const changed = registry.updateContextWindow(modelId, bumped)
  if (!changed) return false

  // #4413 — persist the bumped registry to the provider-scoped cache file
  // (e.g. `~/.chroxy/models-cache.codex.json`) so a server restart doesn't
  // lose the learned window. `saveCache()` is idempotent (snapshot-deduped)
  // and logs a warn on disk failure rather than throwing, so the in-memory
  // ratchet always succeeds even when the disk path is unwritable. Each
  // provider's registry routes to its own cache path via
  // `getRegistryForProvider`'s `cachePath` hook — the default Claude cache
  // is unaffected by non-Claude ratchets.
  if (typeof registry.saveCache === 'function') {
    registry.saveCache()
  }

  // Broadcast the corrected registry so the dashboard's `availableModels`
  // (and therefore the footer meter) picks up the new window without
  // waiting for the next refresh.
  if (typeof emit === 'function') {
    emit('models_updated', { models: registry.getModels() })
  }
  return true
}
