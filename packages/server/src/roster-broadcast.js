import { getRegisteredProviderNames } from './providers.js'
import { isClaudeProvider, usesDefaultModelsRegistry, resolveRosterProvider } from './models.js'

/**
 * #7722 — the provider a client is currently looking at, or null when it has no
 * active session. Null is NOT an error signal: it is the "no session yet" case,
 * which `overlayBroadcastReachesProvider` routes to the default roster exactly
 * as the pre-#7722 broadcast did.
 *
 * Deliberately fail-OPEN toward that default: a session lookup that throws (or a
 * SessionManager torn down mid-reload) yields null, so the client still receives
 * the Claude roster it would have received before this change rather than
 * silently receiving nothing.
 *
 * @param {{ activeSessionId?: string|null }} client
 * @param {{ getSession?: (id: string) => ({ provider?: string|null }|undefined) }} sessionManager
 * @returns {string|null}
 */
export function clientActiveProvider(client, sessionManager) {
  try {
    const sessionId = client?.activeSessionId
    if (!sessionId) return null
    return sessionManager?.getSession?.(sessionId)?.provider || null
  } catch {
    return null
  }
}

/**
 * #7722 — the recipient rule for ONE `available_models` roster broadcast: does
 * a client whose ACTIVE session runs `activeProvider` receive this message?
 *
 * The rule:
 *   - the DEFAULT (Claude) roster reaches every client whose active provider
 *     shares the default registry — Claude-family, an unknown/unregistered
 *     name, and no active session at all.
 *   - every other tag names a PER-PROVIDER registry, and those are keyed by
 *     name (`providerRegistryCache`), so only that exact provider matches.
 *
 * `usesDefaultModelsRegistry` is imported rather than re-derived: it is the same
 * predicate `reloadModelsOverlay` uses to decide which rosters are worth
 * reporting, and a second copy here would be free to disagree about the
 * unknown-name and docker-* edges that motivate it.
 *
 * A throw resolves to the default roster (fail-open) — see `clientActiveProvider`'s
 * docstring for why: `WsBroadcaster._broadcast`'s filter SKIPS a client whose
 * filter threw, which would deliver *nothing* to a client that received the
 * `claude-sdk` roster before #7722.
 *
 * @param {{ provider?: string|null }} message  one roster broadcast (this
 *   module's `message` shape, or one entry from `buildOverlayReloadBroadcasts`)
 * @param {string|null|undefined} activeProvider  the client's active session provider
 * @param {boolean} [tagIsDefault]  precomputed `usesDefaultModelsRegistry(message.provider)`.
 *   Omit it and the same value is derived here — callers that route many clients
 *   through one message pass it so the tag is resolved once.
 * @returns {boolean}
 */
export function overlayBroadcastReachesProvider(message, activeProvider, tagIsDefault) {
  const tag = message?.provider ?? null
  const isDefaultTag = tagIsDefault === undefined ? usesDefaultModelsRegistry(tag) : tagIsDefault
  if (!isDefaultTag) return activeProvider === tag
  try {
    return usesDefaultModelsRegistry(activeProvider)
  } catch {
    // Fail OPEN toward the default roster — see the paragraph above.
    return true
  }
}

/**
 * #7895 — the single per-recipient tagging routine for an `available_models`
 * roster broadcast.
 *
 * #7756's `createOverlayReloadBroadcaster` (server-cli.js) first solved this
 * for the models-overlay hot-reload path: `claude-sdk`, `claude-cli`,
 * `claude-tui` and `claude-byok` all share ONE registry, so
 * `overlayBroadcastReachesProvider` correctly decides all four should receive
 * a default-registry roster — but the client keys each roster by the EXACT tag
 * it arrived under (`modelsByProvider`, store-core/src/models-by-provider.ts),
 * so a single literal tag never refreshes the other three clients' OWN bucket
 * even though routing already decided they should receive something. #7895
 * found two MORE `available_models` send sites with the identical hardcoded-tag
 * shape (`ws-forwarding.js`'s `models_updated` forward and its legacy
 * single-session path) — this function is the ONE place all of them now
 * resolve a recipient's tag, instead of a third hand-rolled copy of the same
 * per-recipient loop.
 *
 * Given ONE roster message (whatever its `provider` tag), sends it to every
 * relevant client:
 *   - a NON-default tag (a real per-provider registry, e.g. `codex`) reaches
 *     only the exact-match clients, tag unchanged — `overlayBroadcastReachesProvider`
 *     already decided that's correct and no re-tagging is needed.
 *   - the DEFAULT (Claude-family) tag is instead RE-SENT once per known
 *     Claude-family provider name, each copy re-tagged with that name and
 *     filtered to the clients `resolveRosterProvider` resolves to it — so a
 *     reload/refresh and a reconnect agree on what a session's roster is
 *     called. A residual broadcast (tagged with the message's own literal)
 *     covers whatever does not resolve to a known tag — an unregistered/custom
 *     provider name, or one whose own registry build throws — preserving
 *     fail-open delivery for that edge case.
 *
 * The concrete known-tag set is derived from the provider REGISTRY
 * (`getRegisteredProviderNames` + `isClaudeProvider`, #5858's single source of
 * truth), never a hand-maintained name literal — the exact defect class #5855
 * fixed for `isClaudeProvider` itself.
 *
 * @param {object} deps
 * @param {(msg: object, filter?: (client: object) => boolean) => void} deps.broadcast
 *   the caller's broadcast primitive — `wsServer._broadcast` /
 *   `ctx.broadcast`, both already `(msg, filter) => void`.
 * @param {object} deps.sessionManager
 * @param {string|null} [deps.defaultProvider] - this daemon's resolved default
 *   (`config.provider || DEFAULT_PROVIDER`) — the same value `ws-history.js`
 *   feeds `resolveRosterProvider` via `billingCanary.defaultProvider`. Omitted,
 *   `resolveRosterProvider` falls back to `DEFAULT_PROVIDER` itself.
 * @param {{ type: string, models: Array, defaultModel?: string|null, provider?: string|null }} deps.message
 * @returns {void}
 */
export function broadcastRosterPerRecipient({ broadcast, sessionManager, defaultProvider = null, message }) {
  const tagIsDefault = usesDefaultModelsRegistry(message?.provider ?? null)

  if (!tagIsDefault) {
    // Per-provider (non-default) roster: the tag already names the exact
    // registry it came from, so the recipient's own provider must match it
    // exactly. No re-tagging needed: a codex roster is never right for anyone
    // but a codex session.
    broadcast(message, (client) => overlayBroadcastReachesProvider(
      message,
      clientActiveProvider(client, sessionManager),
      tagIsDefault,
    ))
    return
  }

  // The concrete Claude-family names this daemon currently has registered
  // (built-ins + docker-* once registerDockerProvider() has run + any
  // config-driven endpoint), INCLUDING claude-byok — same registry as
  // claude-sdk/cli/tui. Read fresh on every call rather than cached, so a
  // provider registered after this module was first imported (docker-*,
  // hot-registered endpoints) is still covered.
  const knownTags = new Set(
    getRegisteredProviderNames().filter((name) => isClaudeProvider(name)),
  )
  // The tag a client with no active session — or a session reporting no
  // provider — is served. Same resolution `ws-history.js` uses on connect, so
  // an idle client's bucket key matches whichever of the two sent last.
  knownTags.add(resolveRosterProvider(null, defaultProvider))

  for (const tag of knownTags) {
    broadcast({ ...message, provider: tag }, (client) => resolveRosterProvider(
      clientActiveProvider(client, sessionManager),
      defaultProvider,
    ) === tag)
  }

  // Residual fallback — see the docstring above. `claude-byok` IS in
  // `knownTags`, so it is excluded from the residual by the same generic
  // `knownTags.has(...)` check every other known Claude-family provider is —
  // no separate byok guard needed or wanted.
  broadcast(message, (client) => {
    const activeProvider = clientActiveProvider(client, sessionManager)
    if (knownTags.has(resolveRosterProvider(activeProvider, defaultProvider))) return false
    return overlayBroadcastReachesProvider(message, activeProvider, tagIsDefault)
  })
}
