import { randomUUID } from 'crypto'
import { createLogger } from './logger.js'
import { RateLimiter, getRateLimitKey } from './rate-limiter.js'
import { buildSessionTokenMismatchPayload } from './handler-utils.js'
import { settlePush } from './push.js'
import { createPermissionResolver } from './permission-resolver.js'
import { sendOversizeResponse } from './http-oversize.js'
import { redactValue, sanitizeToolInput } from './redaction.js'
import { buildPermissionRequestMessage } from '@chroxy/protocol'

const log = createLogger('ws')

// -- Permission TTL --
const PERMISSION_TTL_MS = 300_000 // 5 minutes

// -- Broadcast safety --
// `sanitizeToolInput` (key-name + recursive value-shape redaction) lives in
// redaction.js (#6038) so the SDK/TUI provider path (permission-manager.js)
// shares the exact same sanitizer as this hook path. Imported above and
// re-exported below for back-compat with existing importers/tests.

/**
 * Build the human-readable `description` broadcast alongside a permission
 * request. #6029: the description is derived from RAW toolInput and broadcast
 * next to the sanitized `input`, so a secret in command/url/etc. would leak here
 * even though `input` is clean. The final string is run through `redactValue` so
 * the broadcast description can never carry a secret-shaped value.
 *
 * @param {object} toolInput
 * @returns {string}
 */
function buildPermissionDescription(toolInput) {
  const raw = toolInput.description
    || toolInput.command
    || toolInput.file_path
    || toolInput.pattern
    || toolInput.query
    || JSON.stringify(toolInput).slice(0, 200)
  return redactValue(raw)
}

/**
 * #5372 — single JSON response helper for the permission HTTP handlers. The
 * `writeHead(status, {'Content-Type':'application/json'})` + `end(JSON.stringify(...))`
 * pattern was hand-written 12+ times across the two handlers, which let the
 * content-type and error-body shape drift between sites. Centralizing it gives
 * one place to set the header; `extraHeaders` covers the one site (rate-limit)
 * that also emits `Retry-After`. The `Content-Type` is merged AFTER
 * `extraHeaders` so a caller can never accidentally override it (#5389 review).
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status - HTTP status code.
 * @param {object} body - JSON-serializable response body.
 * @param {object} [extraHeaders] - additional response headers to merge.
 */
function sendJson(res, status, body, extraHeaders) {
  res.writeHead(status, { ...extraHeaders, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Create a permission handler for the WsServer.
 * Manages HTTP permission lifecycle (hook requests, responses, resend, resolve).
 *
 * @param {Object} opts
 * @param {Function} opts.sendFn - (ws, message) => void
 * @param {Function} opts.broadcastFn - (message) => void
 * @param {Function} opts.validateBearerAuth - (req, res) => boolean — validates main API token (used by /permission-response)
 * @param {Function} opts.validateHookAuth - (req, res) => boolean — validates per-session hook secret (used by /permission)
 * @param {Object|null} opts.pushManager - PushManager instance (nullable)
 * @param {Map} opts.pendingPermissions - requestId -> { resolve, timer } (owned by WsServer)
 * @param {Map} opts.permissionSessionMap - requestId -> sessionId (owned by WsServer)
 * @param {Function} [opts.registerPermissionRoute] - (requestId, sessionId) => void. Optional WsServer-provided helper that records the permissionSessionMap entry AND auto-subscribes every currently-eligible authenticated client to sessionId, keeping the settings-handler's unbound-client subscription guard (#4798) symmetric with the _broadcastToSession recipient filter. When omitted (unit-test fixtures constructing the handler directly), all three dispatch paths (HTTP request, HTTP resend on reconnect, and any future direct map writes) fall back to a bare permissionSessionMap.set() — security-equivalent for tests because there are no real WS clients to auto-subscribe.
 * @param {Function} [opts.unregisterPermissionRoute] - (requestId) => void. Optional WsServer-provided teardown counterpart to registerPermissionRoute (#5704): on resolve/expire it deletes the permissionSessionMap entry AND decrements the permission-induced subscription refcount, removing the auto-subscription once no permission still holds it (and the client is neither active on nor explicitly subscribed to the session). Omitted in unit-test fixtures (which use bare permissionSessionMap semantics).
 * @param {Function} opts.getSessionManager - () => sessionManager (late-bound for test compat)
 * @param {Object|null} opts.pairingManager - PairingManager instance used to look up token→sessionId bindings for the HTTP permission-response fallback. Optional — when null, HTTP responses skip the binding check (single-token mode).
 * @param {Function} [opts.findSessionByHookSecret] - (hookSecret) => session|null. Optional session lookup used during /permission handling to resolve the session associated with a per-session hook secret (#2831 — pause that session's inactivity timer while a hook permission is outstanding).
 * @param {Function} [opts.getPermissionAudit] - () => PermissionAuditLog or null (late-bound). When present, HTTP user-initiated permission responses are audited with `clientId: 'http'` and `reason: 'user'` (#3059). Optional for backwards compat with existing test fixtures.
 * @param {Object} [opts.rateLimit] - Override RateLimiter config for POST /permission. Mainly for tests; production uses the 30+10 default below.
 * @returns {Object} Permission handler methods
 */
export function createPermissionHandler({ sendFn, broadcastFn, validateBearerAuth, validateHookAuth, pushManager, pendingPermissions, permissionSessionMap, registerPermissionRoute, unregisterPermissionRoute, getSessionManager, pairingManager, findSessionByHookSecret, getPermissionAudit, rateLimit }) {
  let _permissionCounter = 0

  // Rate limiter for HTTP permission requests (per source IP)
  // #3996: name='http-permission' so eviction logs and /diagnostics can
  // identify this limiter distinctly from the WS-side _permissionRateLimiter.
  // name comes AFTER the spread so a stray `name` in the override (e.g.
  // from a test fixture) can't displace the canonical 'http-permission'
  // tag that operators rely on in eviction logs and /diagnostics.
  const _httpPermissionLimiter = new RateLimiter({ ...(rateLimit || { windowMs: 60_000, maxMessages: 30, burst: 10 }), name: 'http-permission' })

  // Fall back to validateBearerAuth if validateHookAuth is not provided (backwards compat for tests)
  const _validateHookAuth = validateHookAuth || validateBearerAuth

  // #5704: tear down a permission route's map entry AND its permission-induced
  // subscription refcount together. Prefer the WsServer-provided hook (which
  // drops the refcount and unsubscribes idle clients); fall back to a bare
  // delete for unit-test fixtures that construct the handler without it (no real
  // WS clients to unsubscribe — behaviour-equivalent).
  function tearDownRoute(requestId) {
    if (typeof unregisterPermissionRoute === 'function') unregisterPermissionRoute(requestId)
    else permissionSessionMap.delete(requestId)
  }

  // #5373: the session-binding check + SDK-vs-legacy dispatch + audit live in
  // the shared permission-resolver (also used by the WS handler in
  // settings-handlers.js), so the binding rule lives in ONE place. The HTTP
  // handler below maps the resolver's transport-agnostic ResolveResult to HTTP
  // status codes; the body buffering / oversize / crash-guard stay here.
  // `resolvePermission` is a hoisted function declaration below.
  const permissionResolver = createPermissionResolver({
    permissionSessionMap,
    pendingPermissions,
    getSessionManager,
    resolveLegacyPermission: resolvePermission,
    getPermissionAudit,
    onRouteTeardown: tearDownRoute,
  })

  /** Handle POST /permission from the hook script */
  function handlePermissionRequest(req, res) {
    // Rate limit by source IP. Use getRateLimitKey so that when the request
    // arrived via the local cloudflared process (TCP peer = 127.0.0.1) we key
    // off the forwarded CF-Connecting-IP / X-Forwarded-For header instead of
    // the loopback address. Without this every tunneled client collapses into
    // one bucket and a single noisy mobile can rate-limit everyone (#3980).
    // For direct (non-loopback) peers the helper falls back to the kernel-
    // supplied socket address so the header cannot be spoofed to share or
    // exhaust another IP's bucket — same approach #3978 took for /diagnostics.
    const socketIp = req.socket?.remoteAddress || ''
    const clientIp = getRateLimitKey(socketIp, req)
    const { allowed, retryAfterMs } = _httpPermissionLimiter.check(clientIp)
    if (!allowed) {
      log.warn(`Rate limited POST /permission from ${clientIp}`)
      sendJson(res, 429, { error: 'rate limited', retryAfterMs }, { 'Retry-After': Math.ceil(retryAfterMs / 1000) })
      return
    }

    if (!_validateHookAuth(req, res)) {
      log.warn('Rejected unauthenticated POST /permission')
      return
    }

    const MAX_BODY = 65536
    // utf8 decoding + byte-accurate cap (Buffer.byteLength, not UTF-16 code
    // units), checked BEFORE append so the violating chunk is never buffered.
    req.setEncoding('utf8')
    let body = ''
    let bodyBytes = 0
    let oversized = false
    req.on('data', (chunk) => {
      if (oversized) return
      bodyBytes += Buffer.byteLength(chunk, 'utf8')
      if (bodyBytes > MAX_BODY) {
        oversized = true
        // #5433: respond BEFORE teardown — req.destroy() here suppressed
        // 'end' (the 413 branch below was dead code) and the hook saw a
        // socket reset instead of the documented 413 deny. The helper stops
        // consumption without buffering past the cap and closes the
        // connection after the response flushes.
        sendOversizeResponse(req, res, { decision: 'deny' })
        return
      }
      body += chunk
    })
    req.on('end', () => {
      // #5313 (WP-1.3): this callback fires on a later tick, after the HTTP
      // dispatch that registered it has already returned — so a throw here is
      // NOT caught by the route handler's wrapper and escapes to
      // uncaughtException → process.exit(1), crashing the daemon. The inner
      // JSON.parse is already guarded; this wraps the WHOLE body (res.writeHead
      // on a torn-down socket, downstream session/broadcast calls) so any other
      // throw is contained and returns a 500 to the client when possible.
      try {
      // #5433: the 413 deny was already sent from the 'data' handler.
      if (oversized) return

      let hookData
      try {
        hookData = JSON.parse(body)
      } catch {
        sendJson(res, 400, { decision: 'deny' })
        return
      }

      const requestId = `perm-${randomUUID()}`

      log.info(`Permission request ${requestId}: ${hookData.tool_name || 'unknown tool'}`)

      const tool = hookData.tool_name || 'Unknown tool'
      const toolInput = hookData.tool_input || {}
      const sanitizedInput = sanitizeToolInput(toolInput)
      const description = buildPermissionDescription(toolInput)

      // #2831: find the CliSession this hook permission belongs to (via
      // the per-session hook secret from the Authorization header) so we
      // can pause its inactivity timer while the user decides.
      // #2832: also use the chroxy-managed sessionId to populate
      // permissionSessionMap so paired clients (boundSessionId set) can
      // approve hook-originated permissions for their bound session.
      // Without this entry, the binding check in permission_response
      // rejects every approval with SESSION_TOKEN_MISMATCH.
      const authHeader = (req.headers && req.headers['authorization']) || ''
      const hookToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
      const ownerLookup = (hookToken && typeof findSessionByHookSecret === 'function')
        ? findSessionByHookSecret(hookToken)
        : null
      const ownerSession = ownerLookup?.session ?? null
      const ownerSessionId = ownerLookup?.sessionId ?? null
      if (ownerSession && typeof ownerSession.notifyPermissionPending === 'function') {
        ownerSession.notifyPermissionPending(requestId)
      }
      if (ownerSessionId) {
        // #4798: prefer the WsServer-provided helper so dispatch also auto-
        // subscribes eligible clients to the permission's session — keeps the
        // settings-handler subscription guard symmetric with the broadcast
        // filter. Fall back to a bare Map.set when the helper isn't wired
        // (unit-test fixtures construct the handler directly).
        if (typeof registerPermissionRoute === 'function') {
          registerPermissionRoute(requestId, ownerSessionId)
        } else {
          permissionSessionMap.set(requestId, ownerSessionId)
        }
      }
      // Diagnostic correlation log for #2832 — paired with
      // [session-binding-resend] and [session-binding-reject]. The
      // requestId is the stable correlation key across the permission
      // lifecycle; sessionId reflects the chroxy session that owns the
      // hook secret (or `none` when the hook secret is unattributable).
      // Gated at debug level (#2854) to avoid spamming prod logs — enable
      // with `LOG_LEVEL=debug` when triangulating SESSION_TOKEN_MISMATCH.
      log.debug(`[session-binding-create] permission ${requestId} created via HTTP (sessionId=${ownerSessionId ?? 'none'}, sourceIp=${clientIp})`)

      broadcastFn(buildPermissionRequestMessage({
        requestId,
        tool,
        description,
        input: sanitizedInput,
        remainingMs: 300_000,
        // #5667: carry the owning session so clients route the prompt to the
        // session that actually asked, instead of falling back to whatever tab
        // is focused. Matches the resend-on-reconnect (line ~485) and SDK
        // (line ~406) paths, which already include sessionId. The builder omits
        // `sessionId` entirely (absent, not null) when undefined — the request
        // maps to no chroxy session and clients fall back to the active one.
        sessionId: ownerSessionId || undefined,
      }))

      if (pushManager) {
        // #5702 (8d): settle the fire-and-forget send so a failed phone
        // notification is logged (named), not silently dropped while the
        // dashboard card still appears.
        settlePush(
          pushManager.send('permission', 'Permission needed', `Claude wants to use: ${tool}`, { requestId, tool }, 'permission'),
          `permission requested: ${tool}`,
          log,
        )
      }

      let closed = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        pendingPermissions.delete(requestId)
        // #5704: tear down the map entry + permission-induced subscription
        // refcount together (resolve / timeout-auto-deny / connection-close all
        // land here). Was a bare permissionSessionMap.delete that left the
        // auto-subscription dangling for the permission's lifetime + forever.
        tearDownRoute(requestId)
        // #2831: release the inactivity-timer pause, regardless of
        // whether we're cleaning up from a resolve, timeout, or abort.
        if (ownerSession && typeof ownerSession.notifyPermissionResolved === 'function') {
          ownerSession.notifyPermissionResolved(requestId)
        }
      }

      const onClose = () => {
        if (closed) return
        closed = true
        log.info(`Permission ${requestId} connection closed by client`)
        cleanup()
      }

      req.on('aborted', onClose)
      res.on('close', onClose)

      const timer = setTimeout(() => {
        if (closed) return
        closed = true
        log.info(`Permission ${requestId} timed out, auto-denying`)
        cleanup()
        sendJson(res, 200, { decision: 'deny' })
      }, 300_000)

      pendingPermissions.set(requestId, {
        resolve: (decision) => {
          if (closed) return
          closed = true
          cleanup()
          log.info(`Permission ${requestId} resolved: ${decision}`)
          sendJson(res, 200, { decision })
        },
        timer,
        data: { requestId, tool, description, input: sanitizedInput, remainingMs: 300_000, createdAt: Date.now() },
      })
      } catch (err) {
        // #5313 (WP-1.3): see the try at the top of this end callback.
        const message = err?.message || String(err)
        log.error(`POST /permission end handler threw: ${message}${err?.stack ? '\n' + err.stack : ''}`)
        // #5313 review — the recovery response can ITSELF throw if the original
        // failure was a torn-down socket (res.writeHead/res.end raising). Guard
        // it so the catch can't re-crash the daemon; nothing more we can do.
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'Internal server error' })
          } else {
            res.end()
          }
        } catch { /* socket already torn down */ }
      }
    })
  }

  /** Handle POST /permission-response from iOS notification actions (HTTP fallback) */
  function handlePermissionResponseHttp(req, res) {
    if (!validateBearerAuth(req, res)) {
      log.warn('Rejected unauthenticated POST /permission-response')
      return
    }

    // Look up whether the presented Bearer token is bound to a specific
    // session via pairing. If it is, the caller may ONLY respond to
    // permission requests belonging to that bound session. Without this,
    // a session-bound pairing token could approve/deny permission
    // requests from other sessions via the HTTP fallback — discovered
    // in the 2026-04-11 production readiness audit (blocker 5). The
    // 616aeaf62 / 2c0ac7d2d session-binding sweep missed the HTTP path.
    const authHeader = (req.headers && req.headers['authorization']) || ''
    const presentedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    const callerBoundSessionId = (pairingManager && presentedToken)
      ? pairingManager.getSessionIdForToken(presentedToken)
      : null

    // SECURITY (swarm-audit): reject an UNBOUND PAIRING token — a pairing-ISSUED
    // token with no bound session, e.g. one a device obtained from the auto-
    // refreshing linking-mode QR, which is handed out PRE host-approval. Such a
    // token resolves to callerBoundSessionId=null, which the resolver treats as
    // unrestricted, so without this guard it could answer ANY session's permission
    // over this HTTP fallback. This PRESERVES the #5373 "invariant G": the PRIMARY
    // API token is NOT a pairing token (isSessionTokenValid=false) so it keeps full
    // HTTP authority, and bound pairing tokens are binding-checked by the resolver
    // below — only unbound *pairing* tokens are rejected. The typeof guard keeps
    // single-token / partial-pairingManager modes working (no isSessionTokenValid →
    // treated as the primary token, i.e. not rejected).
    const tokenIsPairingToken = !!(
      pairingManager &&
      typeof pairingManager.isSessionTokenValid === 'function' &&
      presentedToken &&
      pairingManager.isSessionTokenValid(presentedToken)
    )
    if (tokenIsPairingToken && callerBoundSessionId === null) {
      log.warn('Rejected HTTP /permission-response: an unbound pairing token cannot answer permission requests')
      sendJson(res, 403, { error: 'unbound token cannot answer cross-session permissions' })
      return
    }

    const MAX_BODY = 4096
    // utf8 decoding + byte-accurate cap, checked BEFORE append — see
    // handlePermissionRequest above; the three capped readers stay in lockstep.
    req.setEncoding('utf8')
    let body = ''
    let bodyBytes = 0
    let oversized = false
    req.on('data', (chunk) => {
      if (oversized) return
      bodyBytes += Buffer.byteLength(chunk, 'utf8')
      if (bodyBytes > MAX_BODY) {
        oversized = true
        // #5433: same shared rejection as handlePermissionRequest /
        // /api/events — this site already responded before teardown, but the
        // helper also stops consumption (pause + listener removal, so an
        // attacker can't keep streaming into a live connection) and closes
        // the socket after the 413 flushes (Connection: close). It contains
        // torn-down-socket throws internally (#5389 guard preserved).
        sendOversizeResponse(req, res, { error: 'body too large' })
        return
      }
      body += chunk
    })
    req.on('end', () => {
      // #5313 (WP-1.3): same crash shape as handlePermissionRequest's end
      // callback — fires on a later tick, escapes the route wrapper, and an
      // uncaught throw (res.writeHead on a torn-down socket, getSessionManager
      // / respondToPermission / broadcast downstream) crashes the daemon.
      // Wrap the whole body; the inner JSON.parse guard is preserved.
      try {
      if (oversized) return

      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }

      const { requestId, decision } = parsed
      if (!requestId || typeof requestId !== 'string') {
        sendJson(res, 400, { error: 'missing requestId' })
        return
      }

      const validDecisions = ['allow', 'deny', 'allowAlways']
      if (!validDecisions.includes(decision)) {
        sendJson(res, 400, { error: `invalid decision, must be one of: ${validDecisions.join(', ')}` })
        return
      }

      // #5373: delegate the binding check + SDK-vs-legacy dispatch + audit to
      // the shared resolver. clientId 'http' distinguishes these from auto-deny
      // entries (clientId=null) in forensic queries. HTTP passes NO dispatch
      // fallback — it has no per-connection activeSessionId, so the dispatch
      // session is the raw mapping only (unchanged from the prior inline code).
      const result = permissionResolver.resolve(requestId, decision, callerBoundSessionId, { clientId: 'http' })
      switch (result.kind) {
        case 'binding_mismatch': {
          // For a bound caller the requestId MUST be explicitly mapped to that
          // session (no fallback bypass — the #2806 residual, enforced in the
          // resolver). Reject cross-session responses with the unified payload.
          log.warn(`HTTP /permission-response rejected: token bound to ${result.boundSessionId} tried to respond to ${requestId}`)
          // Issue #2912: enrich the HTTP body with the same fields as the WS
          // SESSION_TOKEN_MISMATCH payload so clients handle both surfaces
          // identically (legacy `error` key preserved for old clients).
          const unified = buildSessionTokenMismatchPayload({
            sessionManager: getSessionManager(),
            boundSessionId: result.boundSessionId,
            message: 'not authorized for this permission request',
          })
          sendJson(res, 403, { error: unified.message, ...unified })
          return
        }
        case 'resolved': {
          // #3048: the SDK branch's broadcast is handled by the unified pipeline
          // (PermissionManager → SdkSession → SessionManager → broadcast). The
          // legacy branch has no PermissionManager, so it keeps the inline
          // broadcast (#2905) — sessionId included only when the request was mapped.
          if (result.via === 'legacy') {
            broadcastFn({
              type: 'permission_resolved',
              requestId,
              decision,
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            })
          }
          // #6771 — an allowAlways over the HTTP fallback (iOS notification
          // action) just persisted a durable project rule on the in-process
          // session. Broadcast the updated rule sets so clients' rules surfaces
          // refresh, mirroring the WS handler (settings-handlers.js).
          if (decision === 'allowAlways' && result.via === 'sdk' && result.sessionId) {
            const rulesSession = getSessionManager()?.getSession?.(result.sessionId)?.session
            if (rulesSession && typeof rulesSession.getPersistentPermissionRules === 'function') {
              broadcastFn({
                type: 'permission_rules_updated',
                sessionId: result.sessionId,
                rules: typeof rulesSession.getPermissionRules === 'function' ? rulesSession.getPermissionRules() : [],
                persistentRules: rulesSession.getPersistentPermissionRules(),
              })
            }
          }
          log.info(`Permission ${requestId} resolved via HTTP: ${decision} (${result.via})`)
          sendJson(res, 200, { ok: true })
          return
        }
        case 'expired':
          // UX landmine #5: auto-denied (timed out) before the user tapped the
          // notification — tell the app so it shows "expired", not "approved".
          log.info(`Permission ${requestId} already expired when HTTP response arrived (SDK)`)
          sendJson(res, 410, { error: 'expired', message: 'This permission request has already expired or been resolved' })
          return
        case 'not_found':
        default:
          sendJson(res, 404, { error: 'unknown or expired requestId' })
          return
      }
      } catch (err) {
        // #5313 (WP-1.3): see the try at the top of this end callback.
        const message = err?.message || String(err)
        log.error(`POST /permission-response end handler threw: ${message}${err?.stack ? '\n' + err.stack : ''}`)
        // #5313 review — guard the recovery response so a torn-down-socket
        // throw in writeHead/end can't re-crash the daemon from the catch.
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'Internal server error' })
          } else {
            res.end()
          }
        } catch { /* socket already torn down */ }
      }
    })
  }

  /**
   * Re-send any pending permission requests to a newly connected/reconnected client.
   * @param {WebSocket} ws
   * @param {Object} [client] - Optional client descriptor for diagnostic logging (#2832)
   */
  function resendPendingPermissions(ws, client) {
    // SDK-mode: check all sessions for pending permissions
    const sm = getSessionManager()
    if (sm?._sessions instanceof Map) {
      for (const [sessionId, entry] of sm._sessions) {
        if (entry.session?._pendingPermissions instanceof Map) {
          for (const [requestId] of entry.session._pendingPermissions) {
            const permData = entry.session._lastPermissionData?.get(requestId)
            if (permData) {
              const elapsed = Math.max(0, Date.now() - (permData.createdAt ?? Date.now()))
              const ttl = permData.remainingMs ?? PERMISSION_TTL_MS
              const remainingMs = Math.min(ttl, Math.max(0, ttl - elapsed))
              if (remainingMs <= 0) {
                log.debug(`Skipping expired permission ${requestId}`)
                continue
              }
              log.info(`Re-sending pending permission ${requestId} to reconnected client (${Math.round(remainingMs / 1000)}s remaining)`)
              // Diagnostic correlation log for #2832 — grep by requestId
              // to see whether the recipient's boundSessionId matches the
              // origin session recorded at [session-binding-create]. Gated
              // at debug level (#2854) to avoid spamming prod logs on every
              // post-auth reconnection — enable with `LOG_LEVEL=debug`.
              if (client) {
                log.debug(`[session-binding-resend] permission ${requestId} resent to client ${client.id} (sessionId=${sessionId}, activeSession=${client.activeSessionId ?? 'none'}, boundSession=${client.boundSessionId ?? 'none'})`)
              } else {
                log.debug(`[session-binding-resend] permission ${requestId} resent (sessionId=${sessionId}, client=unknown)`)
              }
              // #4798: prefer the auto-subscribing helper so re-sending a
              // pending permission also seeds subscribedSessionIds on
              // eligible clients — matches the dispatch-time behaviour and
              // keeps the settings-handler subscription guard symmetric
              // across the reconnect path. The bare Map.set fallback covers
              // unit-test fixtures that construct the handler directly.
              if (typeof registerPermissionRoute === 'function') {
                registerPermissionRoute(requestId, sessionId)
              } else {
                permissionSessionMap.set(requestId, sessionId)
              }
              // #6054: buildPermissionRequestMessage throws on field drift (the
              // intended #6031 fail-loud guard). Isolate it per-permission so one
              // malformed pending entry can't abort the loop and strand the
              // remaining valid prompts for this reconnecting client.
              try {
                sendFn(ws, buildPermissionRequestMessage({
                  requestId: permData.requestId ?? requestId,
                  tool: permData.tool,
                  description: permData.description,
                  input: permData.input,
                  remainingMs,
                  sessionId,
                }))
              } catch (err) {
                log.warn(`Skipping malformed pending permission ${requestId} on resend: ${err?.message ?? err}`)
                continue
              }
            }
          }
        }
      }
    }

    // Legacy HTTP-held permissions
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.data) {
        const elapsed = Math.max(0, Date.now() - (pending.data.createdAt ?? Date.now()))
        const ttl = pending.data.remainingMs ?? PERMISSION_TTL_MS
        const remainingMs = Math.min(ttl, Math.max(0, ttl - elapsed))
        if (remainingMs <= 0) {
          log.debug(`Skipping expired legacy permission ${requestId}`)
          continue
        }
        log.info(`Re-sending pending legacy permission ${requestId} to reconnected client (${Math.round(remainingMs / 1000)}s remaining)`)
        // Gated at debug level (#2854) — see comment above.
        if (client) {
          log.debug(`[session-binding-resend] legacy permission ${requestId} resent to client ${client.id} (activeSession=${client.activeSessionId ?? 'none'}, boundSession=${client.boundSessionId ?? 'none'})`)
        } else {
          log.debug(`[session-binding-resend] legacy permission ${requestId} resent (client=unknown)`)
        }
        // #6054: isolate the per-permission build+send so a single drifted
        // legacy entry can't abort the loop (see SDK path above).
        try {
          sendFn(ws, buildPermissionRequestMessage({
            requestId: pending.data.requestId ?? requestId,
            tool: pending.data.tool,
            description: pending.data.description,
            input: pending.data.input,
            remainingMs,
          }))
        } catch (err) {
          log.warn(`Skipping malformed pending legacy permission ${requestId} on resend: ${err?.message ?? err}`)
          continue
        }
      }
    }
  }

  /** Resolve a pending permission request */
  function resolvePermission(requestId, decision) {
    const pending = pendingPermissions.get(requestId)
    if (pending) {
      pending.resolve(decision)
    } else {
      log.warn(`No pending permission for ${requestId}`)
    }
  }

  /**
   * #5731 T7: auto-deny + clear any pending HTTP-hook permissions belonging to
   * a single session. Called when that session is destroyed. Without it, the
   * hook's POST /permission stays parked on a held response with a 5-min
   * auto-deny timer: the tool call blocks for the full timeout, then the timer
   * fires against a session that no longer exists, and the held `res` +
   * resolve closure leak until then. `resolve('deny')` runs the shared
   * cleanup() (clears the timer, deletes both maps, sends the deny response,
   * releases the #2831 inactivity-pause). Collect the ids first so the
   * resolve→cleanup→delete doesn't mutate permissionSessionMap mid-iteration.
   * @param {string} sessionId
   * @returns {number} how many pending permissions were drained
   */
  function drainSessionPermissions(sessionId) {
    if (!sessionId) return 0
    const toDeny = []
    for (const [requestId, sid] of permissionSessionMap) {
      if (sid === sessionId) toDeny.push(requestId)
    }
    let drained = 0
    for (const requestId of toDeny) {
      const pending = pendingPermissions.get(requestId)
      if (!pending) continue
      // Count before resolving: resolve() runs cleanup() (clears the timer +
      // deletes both maps + releases the inactivity pause) FIRST and only then
      // writes the HTTP deny response. So even if that response write throws on
      // an already torn-down socket, the entry IS drained — the leak is gone.
      // Treat such a throw as a debug-level note (the drain succeeded; only the
      // best-effort response write failed) rather than a misleading warning on
      // a mass session-destroy. A pending entry is never already-closed here:
      // cleanup() deletes it from pendingPermissions, so a closed one wouldn't
      // be in the map for us to fetch.
      drained++
      try {
        pending.resolve('deny')
      } catch (err) {
        log.debug(`Pending permission ${requestId} drained for destroyed session ${sessionId}, but the deny response write failed (socket likely gone): ${err?.message || err}`)
      }
    }
    if (drained > 0) {
      log.info(`Drained ${drained} pending HTTP permission(s) for destroyed session ${sessionId}`)
    }
    return drained
  }

  /** Clean up: auto-deny all pending permissions */
  function destroy() {
    for (const [, pending] of pendingPermissions) {
      clearTimeout(pending.timer)
      try { pending.resolve('deny') } catch {}
    }
    pendingPermissions.clear()
    // #5704: each resolve('deny') above ran cleanup()→tearDownRoute(), so most
    // entries are already gone. Tear down any remainder (e.g. SDK-routed entries
    // with no HTTP pending) through the same hook so the subscription refcount
    // is released, not just the map — then clear to drop any helper-less leftovers.
    for (const requestId of [...permissionSessionMap.keys()]) {
      tearDownRoute(requestId)
    }
    permissionSessionMap.clear()
  }

  return {
    handlePermissionRequest,
    handlePermissionResponseHttp,
    resendPendingPermissions,
    resolvePermission,
    drainSessionPermissions,
    destroy,
    // #3996: expose the HTTP-permission limiter so /diagnostics can include
    // its eviction stats alongside the three WsServer-owned limiters.
    // Read-only handle — callers must only invoke getEvictionStats() on it.
    _httpPermissionLimiter,
  }
}

// Exported for testing
export { sanitizeToolInput, buildPermissionDescription }
