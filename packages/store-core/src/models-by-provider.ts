/**
 * Provider-keyed model rosters (#7728).
 *
 * `available_models` is a GLOBAL broadcast tagged with the provider whose
 * registry produced it (`ws-forwarding.js` — "models_updated is global —
 * broadcast to ALL clients, not per-session"). Both clients used to land every
 * broadcast in ONE `availableModels` slot, so on a machine running a Claude
 * session and a codex session side by side the last broadcast won: the
 * dashboard HID the codex picker whenever the Claude roster arrived last, and
 * the mobile app rendered the Claude chips into the codex session and sent
 * `set_model` with a Claude id on tap.
 *
 * The wire message is unchanged. What changes is the SLOT: one roster per
 * provider, plus a selector that answers "what does the ACTIVE session's
 * provider offer?". Both clients read through that selector, so neither can
 * show a roster that belongs to another provider.
 */

import type { ModelInfo } from './types'

/**
 * Bucket key for a broadcast that carries NO provider tag.
 *
 * An untagged roster is NOT the same as an empty one: a server that never tags
 * its broadcasts (an older daemon) is saying "I have one registry", and its
 * roster must keep applying to every session exactly as it did before. Keeping
 * it as its own bucket is what lets {@link selectModelsForProvider} tell
 * "nobody told us which provider this is for" apart from "we know the provider
 * and it has no roster" — the first falls back, the second must show nothing.
 *
 * The NUL prefix is deliberate: provider names come off the wire, and a plain
 * key like `__untagged__` could in principle collide with one. No registered
 * provider name can contain a NUL byte, so this key is unreachable from the
 * wire; {@link mergeModelsByProvider} additionally folds a literal match into
 * the untagged bucket rather than trusting it.
 */
export const UNTAGGED_MODELS_PROVIDER = '\u0000untagged'

/** One provider's model list plus the default that provider reported. */
export interface ProviderModelRoster {
  /** Cleaned/normalized models, as produced by `handleAvailableModels`. */
  models: ModelInfo[]
  /** That provider's server-default model id, or null when it reported none. */
  defaultModelId: string | null
}

/**
 * Every roster this client has heard, keyed by the provider that sent it (or
 * {@link UNTAGGED_MODELS_PROVIDER} for an untagged broadcast).
 */
export type ModelsByProvider = Record<string, ProviderModelRoster>

/**
 * The roster returned when nothing is known for the requested provider.
 *
 * Frozen and shared so a React `useMemo` over the selector keeps a stable
 * identity across renders while no roster exists.
 */
export const EMPTY_MODEL_ROSTER: ProviderModelRoster = Object.freeze({
  models: Object.freeze([]) as unknown as ModelInfo[],
  defaultModelId: null,
})

/**
 * Normalize a wire `provider` tag into a bucket key.
 *
 * A missing, non-string, blank, or NUL-sentinel-shaped tag is UNTAGGED — the
 * value is never trusted into the sentinel's slot.
 */
function bucketKey(provider: unknown): string {
  if (typeof provider !== 'string') return UNTAGGED_MODELS_PROVIDER
  if (provider.trim() === '') return UNTAGGED_MODELS_PROVIDER
  if (provider === UNTAGGED_MODELS_PROVIDER) return UNTAGGED_MODELS_PROVIDER
  return provider
}

/**
 * Write one broadcast's roster into the provider-keyed map, leaving every other
 * provider's roster intact.
 *
 * Replace-per-provider, never merge-per-provider: a provider's roster is a full
 * list replacement (the same semantics the single slot had), so a model the
 * server dropped disappears.
 */
export function mergeModelsByProvider(
  previous: ModelsByProvider | undefined | null,
  provider: unknown,
  roster: ProviderModelRoster,
): ModelsByProvider {
  return { ...(previous ?? {}), [bucketKey(provider)]: roster }
}

/**
 * Read ONLY the roster that provider itself broadcast — no untagged and no
 * single-roster fallback, `null` when that provider has not been heard from.
 *
 * For the callers that must PROVE a model belongs to a provider rather than
 * merely display the best roster available: the create-session modal applies a
 * saved default model only when the chosen provider's own catalog contains it,
 * and an untagged roster cannot prove that. A cannot-check must not read as a
 * yes — {@link selectModelsForProvider} is the display-side read, this is the
 * evidence-side one.
 */
export function selectOwnModelsForProvider(
  byProvider: ModelsByProvider | undefined | null,
  provider: string | null | undefined,
): ProviderModelRoster | null {
  if (typeof provider !== 'string' || provider.trim() === '') return null
  if (provider === UNTAGGED_MODELS_PROVIDER) return null
  return (byProvider ?? {})[provider] ?? null
}

/**
 * Read the roster the ACTIVE session's provider should offer.
 *
 * Resolution order, and why each step exists:
 *
 * 1. **The provider's own roster.** The whole point: a codex session reads the
 *    codex roster however many Claude broadcasts arrived after it.
 * 2. **The untagged roster.** An older server tags nothing and has one
 *    registry; its roster is global, which is exactly today's behaviour.
 * 3. **Provider unknown + exactly one roster known.** `provider` is null when
 *    there is no active session, or when the server did not report the
 *    session's provider. That is a cannot-check, not an answer — but with a
 *    single roster in play there is no other provider to leak from, so the
 *    pre-#7728 behaviour is kept. With two or more, the question is genuinely
 *    ambiguous and the answer is nothing.
 * 4. **Nothing.** A KNOWN provider with no roster yet returns empty, so the
 *    picker renders nothing rather than another provider's ids.
 */
export function selectModelsForProvider(
  byProvider: ModelsByProvider | undefined | null,
  provider: string | null | undefined,
): ProviderModelRoster {
  const map = byProvider ?? {}
  const key = typeof provider === 'string' && provider.trim() !== '' ? provider : null
  const own = selectOwnModelsForProvider(map, key)
  if (own) return own
  const untagged = map[UNTAGGED_MODELS_PROVIDER]
  if (untagged) return untagged
  if (key === null) {
    const [only, ...rest] = Object.values(map)
    if (only && rest.length === 0) return only
  }
  return EMPTY_MODEL_ROSTER
}
