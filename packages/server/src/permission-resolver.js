// permission-resolver.js (#5373) — the single source of truth for the DOMAIN
// decision of a permission response, extracted out of the duplicated HTTP
// (ws-permissions.js) and WS (settings-handlers.js) handlers.
//
// It owns ONLY the decision: the session-binding check (the bearer-token
// authorization boundary — bearer-token-authority.md §3-4; the
// #2806/#4788/#4794/#4820 chain), SDK-before-legacy dispatch, and audit. It
// returns a transport-agnostic descriptor (ResolveResult); each call site maps
// that to its own wire format (HTTP status codes vs WS messages).
//
// It deliberately does NOT own (these STAY at the call sites):
//   - the HTTP body buffering / oversize-413 / parse-400 / crash-guard
//   - the per-transport response shape (403 vs WS error, 200 vs ack, …)
//   - the WS unbound-subscription guard (invariant G) — it has no HTTP analog
//     by design (a primary token has full HTTP session authority), so it must
//     not leak into the shared path and over-restrict HTTP
//   - the per-transport `permission_resolved` broadcast
//
// ResolveResult (discriminated on `kind`):
//   { kind: 'binding_mismatch', boundSessionId }            -> HTTP 403 / WS error  (map NOT consumed)
//   { kind: 'resolved', via: 'sdk'|'legacy', sessionId }    -> HTTP 200 / WS ack    (map consumed)
//   { kind: 'expired', sessionId }                          -> HTTP 410 / WS permission_expired
//   { kind: 'not_found' }                                   -> HTTP 404 / WS permission_expired

/**
 * #6030: the single source of truth for the permission "dispatch origin"
 * session id — the mapped session if the request was registered, else the
 * WS-only legacy `client.activeSessionId` fallback (HTTP passes nothing).
 *
 * Both the WS handler (settings-handlers.js — for its unbound-subscription
 * guard, invariant G) and the resolver below MUST compute this the SAME way, or
 * the handler could authorize against one session while the resolver dispatches
 * to another (issue #6030: the handler previously used `||` here while the
 * resolver used `??`, so they disagreed on an empty-string / 0-ish mapped id).
 * `??` is correct: a mapping is "present" iff it was actually registered
 * (null/undefined absent), so an explicitly-mapped empty-string session id must
 * be honoured, not silently coalesced to the active-session fallback.
 *
 * @param {string|null|undefined} mappedSessionId  the raw permissionSessionMap entry
 * @param {string|null|undefined} fallbackSessionId  WS-only legacy fallback (client.activeSessionId); HTTP passes null
 * @returns {string|null|undefined}
 */
export function resolveOriginSessionId(mappedSessionId, fallbackSessionId) {
  return mappedSessionId ?? fallbackSessionId
}

/**
 * @param {{
 *   permissionSessionMap: Map<string, string>,
 *   pendingPermissions: Map<string, any>,
 *   getSessionManager: () => ({ getSession: Function } | null),
 *   resolveLegacyPermission: (requestId: string, decision: string) => void,
 *   getPermissionAudit: () => ({ logDecision: Function } | null),
 *   onRouteTeardown?: (requestId: string) => void,
 * }} deps
 */
export function createPermissionResolver({
  permissionSessionMap,
  pendingPermissions,
  getSessionManager,
  resolveLegacyPermission,
  getPermissionAudit,
  onRouteTeardown,
}) {
  // #5704: a route is consumed (resolved or expired) here. Route the map delete
  // through the WsServer teardown hook when wired so the permission-induced
  // subscription refcount is decremented in lockstep with the map entry. Falls
  // back to a bare delete for unit-test fixtures that don't provide the hook
  // (no real clients to unsubscribe — behaviour-equivalent).
  function consumeRoute(requestId) {
    if (typeof onRouteTeardown === 'function') onRouteTeardown(requestId)
    else permissionSessionMap.delete(requestId)
  }
  function audit(clientId, sessionId, requestId, decision) {
    // #3059: only user-initiated resolutions reach here (auto-deny is audited by
    // the unified pipeline), hence reason:'user'.
    const a = getPermissionAudit?.()
    if (a) a.logDecision({ clientId, sessionId, requestId, decision, reason: 'user' })
  }

  /**
   * @param {string} requestId
   * @param {string} decision
   * @param {string|null} callerBoundSessionId  token-bound id (HTTP) / client.boundSessionId (WS); null/undefined = unbound
   * @param {{ clientId?: string|null, dispatchFallbackSessionId?: string|null }} [opts]
   *   `dispatchFallbackSessionId` is the WS-only legacy "map wasn't populated"
   *   fallback (client.activeSessionId). It is used ONLY to pick the dispatch
   *   session — NEVER for the binding check (invariant B). HTTP passes nothing.
   * @returns {{ kind: string, [k: string]: any }} ResolveResult
   */
  function resolve(requestId, decision, callerBoundSessionId, opts = {}) {
    const { clientId = null, dispatchFallbackSessionId = null } = opts

    // Invariant B (#2806 residual): the binding check reads the RAW map entry —
    // never an activeSessionId fallback. For a bound caller the request MUST be
    // explicitly mapped to that session, or a missing mapping would let it slip
    // through to the legacy resolver, which has no session check.
    const mappedSessionId = permissionSessionMap.get(requestId)

    // Invariant A: a bound caller may answer only its own bound session's prompts.
    if (callerBoundSessionId) {
      if (!mappedSessionId || mappedSessionId !== callerBoundSessionId) {
        return { kind: 'binding_mismatch', boundSessionId: callerBoundSessionId }
      }
    }

    // Dispatch origin: the mapped session, or the WS-only legacy fallback. NEVER
    // used for the binding check above. #6030: shared with the WS handler's guard
    // via resolveOriginSessionId so both agree on empty-string/0-ish ids.
    const originSessionId = resolveOriginSessionId(mappedSessionId, dispatchFallbackSessionId)

    // Invariant F: SDK-mode (in-process) dispatch is attempted before the legacy
    // store. Uses respondToPermission's RETURN VALUE as the resolved-vs-expired
    // signal (the method's contract) — see the #5373 PR note on the WS
    // _pendingPermissions pre-check this reconciles.
    const sm = getSessionManager?.()
    if (originSessionId && sm) {
      const entry = sm.getSession(originSessionId)
      if (entry && typeof entry.session.respondToPermission === 'function') {
        const resolved = entry.session.respondToPermission(requestId, decision)
        consumeRoute(requestId)
        if (resolved) {
          audit(clientId, originSessionId, requestId, decision)
          return { kind: 'resolved', via: 'sdk', sessionId: originSessionId }
        }
        return { kind: 'expired', sessionId: originSessionId }
      }
    }

    // Legacy HTTP-held / pendingPermissions store.
    if (pendingPermissions.has(requestId)) {
      consumeRoute(requestId)
      resolveLegacyPermission(requestId, decision)
      audit(clientId, originSessionId ?? null, requestId, decision)
      return { kind: 'resolved', via: 'legacy', sessionId: originSessionId ?? null }
    }

    return { kind: 'not_found' }
  }

  return { resolve }
}
