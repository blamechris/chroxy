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
//   { kind: 'resolved', via: 'sdk'|'legacy', sessionId, mapped }  -> HTTP 200 / WS ack  (map consumed)
//     `mapped` (#8359): true when `sessionId` came from the request's own mapping, false when it is
//     only the WS dispatch fallback (or null). A caller deciding whether a frame may NAME the session
//     reads this, never `sessionId`: the fallback fills `sessionId` for an unmapped prompt too.
//   { kind: 'edit_refused', sessionId, message }            -> WS error (#8446); the request was DENIED, nothing ran
//   { kind: 'expired', sessionId }                          -> HTTP 410 / WS permission_expired
//   { kind: 'not_found' }                                   -> HTTP 404 / WS permission_expired

// #6842 review (Copilot) — audit `projectKey` must be the PermissionRuleStore's
// NORMALIZED key (path.resolve semantics), not the raw session cwd, so an
// auditor can correlate the entry with the persisted rule's key in
// permission-rules.json even when the session was started with a relative or
// `..`-laden cwd. Reused, not duplicated.
import { normalizeProjectKey } from './permission-rule-store.js'
import { EditedInputRefusedError } from './edited-input.js'

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
  function audit(clientId, sessionId, requestId, decision, extra = {}) {
    // #3059: only user-initiated resolutions reach here (auto-deny is audited by
    // the unified pipeline), hence reason:'user'.
    // #6830 — `extra` carries tool/persist/projectKey when known (see the two
    // call sites below). Keys are OMITTED entirely (not passed as null) when
    // unknown, so a caller/fixture with no tool info produces the exact same
    // 5-field call shape audit consumers already assert on.
    const a = getPermissionAudit?.()
    if (a) a.logDecision({ clientId, sessionId, requestId, decision, reason: 'user', ...extra })
  }

  /**
   * @param {string} requestId
   * @param {string} decision
   * @param {string|null} callerBoundSessionId  token-bound id (HTTP) / client.boundSessionId (WS); null/undefined = unbound
   * @param {{ clientId?: string|null, dispatchFallbackSessionId?: string|null, editedInput?: any, reason?: string }} [opts]
   *   `dispatchFallbackSessionId` is the WS-only legacy "map wasn't populated"
   *   fallback (client.activeSessionId). It is used ONLY to pick the dispatch
   *   session — NEVER for the binding check (invariant B). HTTP passes nothing.
   *   `editedInput` (#6543) and `reason` (#6773) flow only to the in-process
   *   (SDK/BYOK) respondToPermission — the legacy pendingPermissions path ignores
   *   both (the CLI tool executes / denies with its own fixed message).
   * @returns {{ kind: string, [k: string]: any }} ResolveResult
   */
  function resolve(requestId, decision, callerBoundSessionId, opts = {}) {
    const { clientId = null, dispatchFallbackSessionId = null, editedInput = undefined, reason = undefined } = opts

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
    // #8359: an UNMAPPED request that sits in the legacy store is an HTTP-held
    // prompt (POST /permission whose bearer matched no session hook secret). The
    // WS dispatch fallback names the answering client's active session, and if that
    // is an in-process session its respondToPermission returns false for an id it
    // never issued -- so the SDK attempt below ended in `expired` and the held
    // request was never released. Go straight to the legacy store instead.
    //
    // Order when an id is in BOTH stores (not expected: legacy ids are minted by
    // the HTTP handler, SDK ids by a PermissionManager): a MAPPED request always
    // tries its session first (invariant F), so only an unmapped one is routed here;
    // unmapped + legacy-pending resolves legacy because the mapping is the only
    // evidence an in-process session owns it, and its absence plus a held HTTP
    // request is evidence of the opposite. The binding check above is untouched.
    const legacyHeldUnmapped = mappedSessionId == null && pendingPermissions.has(requestId)
    if (originSessionId && sm && !legacyHeldUnmapped) {
      const entry = sm.getSession(originSessionId)
      if (entry && typeof entry.session.respondToPermission === 'function') {
        // #6830 — read the tool name BEFORE respondToPermission runs: it deletes
        // the _lastPermissionData entry as part of resolving (permission-manager.js
        // stashes it there precisely so the editedInput whitelist can read it
        // pre-delete; the audit trail needs the same pre-delete read). Back-compat
        // accessor — absent on a fixture/provider with no PermissionManager wiring,
        // in which case toolName stays undefined and is simply omitted below.
        const toolName = entry.session._lastPermissionData?.get(requestId)?.tool
        // #6543 (feature B): editedInput flows ONLY to the in-process (SDK/BYOK)
        // path — the legacy HTTP path below ignores it (CLI tool executes as-is).
        // #6773: a deny `reason` rides the same in-process path and becomes the
        // agent-facing denial message (permission-manager.js buildDenyMessage).
        let resolved
        try {
          resolved = entry.session.respondToPermission(requestId, decision, editedInput, reason)
        } catch (err) {
          if (!(err instanceof EditedInputRefusedError)) throw err
          // #8446 — the operator's edit cannot be applied without writing a
          // redaction placeholder (or guessing), and the manager refused it with the
          // request still pending. FAIL CLOSED: deny it, with the reason as the
          // agent's tool result, so nothing is written and the prompt does not
          // outlive an answer the client already shows as given (a client marks it
          // answered when it sends). The caller tells the operator why.
          entry.session.respondToPermission(requestId, 'deny', undefined, err.message)
          consumeRoute(requestId)
          audit(clientId, originSessionId, requestId, 'deny', { ...(toolName ? { tool: toolName } : {}), reason: 'edit_refused' })
          return { kind: 'edit_refused', sessionId: originSessionId, message: err.message }
        }
        consumeRoute(requestId)
        if (resolved) {
          const extra = {}
          if (toolName) extra.tool = toolName
          // #6830 — an `allowAlways` that persisted a DURABLE project rule
          // (permission-manager.js respondToPermission) is reflected
          // synchronously in getPersistentPermissionRules() by the time we get
          // here. A tool that degrades to a one-shot allow (NEVER_AUTO_ALLOW /
          // non-ELIGIBLE, e.g. Bash) never appears there, so persist stays
          // unset — exactly the "not actually durable" signal an auditor needs.
          if (decision === 'allowAlways' && toolName && typeof entry.session.getPersistentPermissionRules === 'function') {
            const persistentRules = entry.session.getPersistentPermissionRules()
            if (persistentRules.some((r) => r.tool === toolName && r.decision === 'allow')) {
              extra.persist = 'project'
              // #6842 review — normalize to the store's key (see header import
              // note); null for an unkeyable cwd, in which case the field is
              // simply omitted (same as the tool-unknown case).
              const projectKey = normalizeProjectKey(entry.session.cwd)
              if (projectKey) extra.projectKey = projectKey
            }
          }
          audit(clientId, originSessionId, requestId, decision, extra)
          return { kind: 'resolved', via: 'sdk', sessionId: originSessionId, mapped: mappedSessionId != null }
        }
        return { kind: 'expired', sessionId: originSessionId }
      }
    }

    // Legacy HTTP-held / pendingPermissions store.
    if (pendingPermissions.has(requestId)) {
      // #6830 — capture tool BEFORE resolveLegacyPermission runs: it synchronously
      // deletes the pendingPermissions entry (ws-permissions.js resolvePermission
      // -> pending.resolve -> cleanup()), so the `.data.tool` read must happen first.
      const toolName = pendingPermissions.get(requestId)?.data?.tool
      consumeRoute(requestId)
      resolveLegacyPermission(requestId, decision)
      // #8348: a hook-routed prompt (claude-tui, claude-cli) has no
      // PermissionManager to announce its end, so the answer is journaled here --
      // the one place both transports (WS and HTTP) pass through. The manager
      // remembers what the prompt was from the moment it was raised, so only the
      // outcome is passed; an unknown id (an unattributed prompt) records nothing.
      try {
        sm?.recordPermissionOutcome?.(requestId, decision === 'deny' ? 'denied' : 'allowed')
      } catch { /* the answer already went out; journaling is best-effort */ }
      // Legacy (non-SDK) sessions have no PermissionManager/rule store, so
      // 'allowAlways' here is never durable — tool is the only enrichment.
      // #8359: attributed to the request's own mapping, never to the dispatch
      // fallback. For an unmapped request `originSessionId` is only the session the
      // answering client happens to be on, a hint for where to dispatch; it says
      // nothing about whom the request belongs to. Matches the HTTP path, which
      // passes no fallback and so records null. (The SDK branch above keeps
      // `originSessionId`: there that session's own `respondToPermission` accepted
      // the id, which is what makes it the owner.)
      audit(clientId, mappedSessionId ?? null, requestId, decision, toolName ? { tool: toolName } : {})
      return { kind: 'resolved', via: 'legacy', sessionId: originSessionId ?? null, mapped: mappedSessionId != null }
    }

    return { kind: 'not_found' }
  }

  return { resolve }
}
