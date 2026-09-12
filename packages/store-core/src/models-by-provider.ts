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
 * ONE fallback survives that rule, and it fires only when the client cannot
 * tell which provider is being asked about — see
 * {@link selectModelsForProvider}: when the session's provider is UNKNOWN and
 * exactly one roster is in play, that roster is served. A KNOWN provider is
 * never served another registry's roster, and never an untagged one either: an
 * untagged broadcast is not evidence about a provider the client can name.
 *
 * That second half is load-bearing rather than pedantic, because a MODERN
 * daemon emits untagged broadcasts: `ws-history.js` sends
 * `provider: activeProvider`, which is null on any post-auth connect with no
 * active session, and `getRegistryForProvider(null)` answers with the CLAUDE
 * default registry. A client in that state holds exactly one roster — an
 * untagged Claude one — and switching to a codex session must render an empty
 * picker for the tunnel round trip before the codex roster arrives, not Claude
 * ids that `set_model` would then send to codex. Tagging those sends
 * server-side is #7759.
 *
 * What the fallback still covers is the pre-provider daemon, which tags neither
 * the roster NOR the session entry: its roster is untagged, its sessions report
 * no provider, so the lookup provider is null and the single-roster rule serves
 * it exactly as it was served before #7728.
 */

import type { ModelInfo } from './types'

/**
 * Bucket key for a broadcast that carries NO provider tag.
 *
 * An untagged roster is NOT the same as an empty one, and it is not evidence
 * about any named provider either. Its own bucket is what keeps both true: no
 * session's provider can ever match this key, so an untagged roster is never
 * served to a provider the client can name, while it still COUNTS as a roster
 * when {@link selectModelsForProvider} asks whether exactly one is in play —
 * which is how a pre-provider daemon (untagged rosters, untagged sessions, so a
 * null lookup provider) keeps getting its one registry served to every session
 * exactly as it did before #7728.
 *
 * The NUL prefix is deliberate: provider names come off the wire, and a plain
 * key like `__untagged__` could in principle collide with one. No provider name
 * the daemon registers contains a NUL byte, so this key is out of reach of a
 * well-formed tag — but the guarantee does NOT rest on that assumption.
 *
 * Two malformed shapes, handled differently, and the reason is what each one
 * can BUY rather than a preference about bucketing:
 *
 * - A tag that exactly SPELLS the sentinel (including one padded with
 *   whitespace, which trimming now makes reachable) is folded into the untagged
 *   bucket by {@link canonicalProviderTag}, and rejected on the read side too.
 *   The fold grants it nothing: an untagged roster is exactly what a broadcast
 *   with `provider: null` already writes, and no session can look that bucket
 *   up by name. Trusting the tag instead would be the difference that matters —
 *   it would let a wire value plant a roster in the slot the selector treats as
 *   the client's own "nobody said", which is authority the sender must not have.
 * - A tag that merely CONTAINS a NUL is left alone: it keys its own bucket, no
 *   session's provider can match it, so it is inert. Folding it into the
 *   untagged bucket would move a malformed roster into the slot that a
 *   provider-less client serves globally — the one place it could be displayed.
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
 * 2. **Provider UNKNOWN + exactly one roster known.** `provider` is null when
 *    there is no active session, or when the server did not report the
 *    session's provider (or the session list has not arrived yet on a
 *    reconnect). That is a cannot-check, not an answer — but with a single
 *    roster in play there is no other provider to leak from, and the client has
 *    no basis to call it wrong, so the pre-#7728 behaviour is kept. With two or
 *    more, the question is genuinely ambiguous and the answer is nothing.
 *
 *    This is the ONLY fallback, and the untagged bucket gets no separate one.
 *    An earlier revision served the untagged roster to a KNOWN provider while
 *    it was the only roster in play; that condition is satisfied by the exact
 *    scenario #7728 names. A client that connects post-auth with no active
 *    session holds one roster — the untagged CLAUDE one `ws-history.js` sends
 *    for `provider: null` — and switching to a codex session then served Claude
 *    ids to codex for a whole tunnel round trip, with `set_model` live on tap.
 *    Requiring `key === null` made that step a strict SUBSET of this one, so it
 *    was deleted rather than narrowed. The pre-provider daemon it existed for
 *    is untouched: it tags neither its rosters nor its session entries, so its
 *    lookup provider is null and this step serves it.
 * 3. **Nothing.** A KNOWN provider with no roster of its own returns empty —
 *    including when the only roster in play is untagged — so the picker renders
 *    nothing rather than another registry's ids. `ws-history.js` sends the
 *    session's own tagged roster right behind the switch; the empty window is
 *    one round trip, and #7759 closes it at source.
 */
export function selectModelsForProvider(
  byProvider: ModelsByProvider | undefined | null,
  provider: string | null | undefined,
): ProviderModelRoster {
  const map = byProvider ?? {}
  const key = canonicalProviderTag(provider)
  const own = selectOwnModelsForProvider(map, key)
  if (own) return own
  if (key === null) {
    const [only, ...rest] = Object.values(map)
    if (only && rest.length === 0) return only
  }
  return EMPTY_MODEL_ROSTER
}
