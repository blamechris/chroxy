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
 * provider offer?". Both clients read through that selector, so a roster
 * TAGGED for one provider is never shown to a session of another.
 *
 * Two fallbacks survive that rule, and both are "we cannot tell", never "close
 * enough" — see {@link selectModelsForProvider}: an UNTAGGED roster while it is
 * the only one in play (a single-registry daemon said nothing about providers),
 * and a single roster when the server did not report the session's provider at
 * all. The daemon emits untagged broadcasts today (`ws-history.js` sends
 * `provider: activeProvider`, null on any post-auth connect with no active
 * session); tagging them server-side is #7759.
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
 * key like `__untagged__` could in principle collide with one. No provider name
 * the daemon registers contains a NUL byte, so this key is out of reach of a
 * well-formed tag — but the guarantee does NOT rest on that assumption:
 * {@link canonicalProviderTag} folds any wire value that SPELLS the sentinel
 * (including one padded with whitespace, which trimming now makes reachable)
 * into the untagged bucket rather than trusting it, and rejects it on the read
 * side too. A malformed tag that merely CONTAINS a NUL is not special-cased: it
 * keys its own bucket, which no session's provider can match, so it is inert —
 * routing it to the untagged bucket instead would make a malformed roster
 * global, which is strictly worse.
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
 * Canonicalize a provider tag, or `null` when there is no usable one.
 *
 * `null` means missing, non-string, blank once trimmed, or a value that spells
 * the untagged sentinel (never trusted into the sentinel's slot).
 *
 * The trim is a NORMALIZATION, not merely a test — that is the bug this
 * function exists to make impossible. The write side already decided "blank"
 * with `.trim()` and then stored the RAW string, so a tag of `' codex '` keyed
 * a bucket that no lookup for `'codex'` could ever reach, and the roster was
 * silently invisible. The write and BOTH reads canonicalize through this one
 * function so the two sides cannot drift again.
 */
function canonicalProviderTag(provider: unknown): string | null {
  if (typeof provider !== 'string') return null
  const trimmed = provider.trim()
  if (trimmed === '') return null
  if (trimmed === UNTAGGED_MODELS_PROVIDER) return null
  return trimmed
}

/** Bucket key for a broadcast: its canonical tag, or the untagged sentinel. */
function bucketKey(provider: unknown): string {
  return canonicalProviderTag(provider) ?? UNTAGGED_MODELS_PROVIDER
}

/**
 * Write one broadcast's roster into the provider-keyed map, leaving every other
 * provider's roster intact.
 *
 * Replace-per-provider, never merge-per-provider: a provider's roster is a full
 * list replacement (the same semantics the single slot had), so a model the
 * server dropped disappears.
 *
 * The map is append-or-replace with no cap and no pruning, which is deliberate
 * rather than overlooked. Keys are provider names from the daemon's own
 * registry on an authenticated connection, so the set is bounded by the
 * providers that daemon has ever built — a handful, growing only when an
 * overlay hot-reload introduces a new one, and dropped wholesale at disconnect
 * (`createEmptyConnectionScope`). Pruning against the `providers` broadcast was
 * considered and rejected: it would delete a roster whenever that broadcast is
 * momentarily narrower than the set of live sessions, turning a display
 * fallback into a blank picker — the failure this module exists to prevent —
 * to reclaim a few hundred bytes.
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
  const key = canonicalProviderTag(provider)
  if (key === null) return null
  return (byProvider ?? {})[key] ?? null
}

/**
 * Read the roster the ACTIVE session's provider should offer.
 *
 * Resolution order, and why each step exists:
 *
 * 1. **The provider's own roster.** The whole point: a codex session reads the
 *    codex roster however many Claude broadcasts arrived after it.
 * 2. **The untagged roster, and only while it is the ONLY roster in play.** An
 *    untagged broadcast is a claim that the daemon has one registry, and a
 *    second roster falsifies that claim. The narrowing is load-bearing rather
 *    than pedantic: a MODERN daemon emits untagged broadcasts too —
 *    `ws-history.js` sends `provider: activeProvider`, which is null on any
 *    post-auth connect with no active session, and `getRegistryForProvider(null)`
 *    answers with the CLAUDE default registry. An unconditional untagged
 *    fallback therefore served that Claude roster to a codex session whose own
 *    roster had not arrived — the exact failure #7728 is named for. Tagging
 *    those sends server-side is #7759; until then the client refuses to treat
 *    "nobody said" as "said Claude" once it knows of a second registry.
 * 3. **Provider unknown + exactly one roster known.** `provider` is null when
 *    there is no active session, or when the server did not report the
 *    session's provider (or the session list has not arrived yet on a
 *    reconnect). That is a cannot-check, not an answer — but with a single
 *    roster in play there is no other provider to leak from, and the client has
 *    no basis to call it wrong, so the pre-#7728 behaviour is kept. With two or
 *    more, the question is genuinely ambiguous and the answer is nothing.
 * 4. **Nothing.** A KNOWN provider with no roster of its own returns empty
 *    whenever any other roster is in play, so the picker renders nothing rather
 *    than another provider's ids.
 */
export function selectModelsForProvider(
  byProvider: ModelsByProvider | undefined | null,
  provider: string | null | undefined,
): ProviderModelRoster {
  const map = byProvider ?? {}
  const key = canonicalProviderTag(provider)
  const own = selectOwnModelsForProvider(map, key)
  if (own) return own
  const untagged = map[UNTAGGED_MODELS_PROVIDER]
  if (untagged && Object.keys(map).length === 1) return untagged
  if (key === null) {
    const [only, ...rest] = Object.values(map)
    if (only && rest.length === 0) return only
  }
  return EMPTY_MODEL_ROSTER
}
