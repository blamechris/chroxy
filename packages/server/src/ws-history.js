/**
 * History replay and post-auth state delivery for WsServer.
 *
 * Extracted from ws-server.js to separate the post-authentication
 * handshake and history replay concerns from core server orchestration.
 */
import { toShortModelId, getRegistryForProvider } from './models.js'
import { getPermissionModes } from './handler-utils.js'
import { listProviders, getProvider } from './providers.js'
import { createLogger } from './logger.js'
import { createKeyPair, deriveSharedKey, deriveConnectionKey, signExchangeKey } from '@chroxy/store-core/crypto'
import { DEFAULT_RESULT_TIMEOUT_MS, DEFAULT_HARD_TIMEOUT_MS, DEFAULT_STREAM_STALL_TIMEOUT_MS } from './base-session.js'
import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'

const log = createLogger('ws')

// #4833 — back-pressure pause for chunked replay/flush loops.
//
// Both replayHistory and flushPostAuthQueue emit messages in 20-entry chunks
// separated by setImmediate yields. On sessions with fat tool_result payloads
// (200KB+ each), a single chunk can push ws.bufferedAmount past the 1MB
// EVICT_THRESHOLD in ws-client-sender.js, tripping a post-send 4008 close and
// surfacing as a "Reconnecting…" loop in the dashboard.
//
// Before scheduling the next chunk, the loop now polls bufferedAmount and
// pauses (via setTimeout, every BACKPRESSURE_POLL_INTERVAL_MS) until it falls
// back below BACKPRESSURE_PAUSE_THRESHOLD. The threshold (256KB) is well
// below the 1MB eviction line so the next chunk has headroom even on slow
// links. The poll interval (20ms) is short enough to keep the replay
// responsive but long enough to give the socket time to actually flush.
//
// Both helpers abort the poll once ws.readyState leaves OPEN (client
// disconnected while paused), so the poll chain terminates on socket close
// without sending to a closed socket.
//
// #5328 (WP-5.6): the readyState check alone is NOT enough to bound the poll —
// a half-open TCP connection that stays stuck in OPEN, never drains, and never
// errors would keep re-scheduling setTimeout(poll) forever, leaking one timer
// chain per stuck replay/flush. BACKPRESSURE_MAX_WAIT_MS is a hard cap: once a
// drain has been blocked that long we stop polling and close the socket (1013
// "Try Again Later") so the client reconnects cleanly and re-runs the replay
// from scratch, rather than silently leaking a timer against a dead peer. The
// cap is comfortably longer than a healthy slow-link drain but far short of
// "forever".
const BACKPRESSURE_PAUSE_THRESHOLD = 256 * 1024
const BACKPRESSURE_POLL_INTERVAL_MS = 20
const BACKPRESSURE_MAX_WAIT_MS = 30_000

// #5622 — bound the eager X25519 key derivations done SYNCHRONOUSLY per
// event-loop iteration.
//
// The #5590 eager fold concentrates createKeyPair + DH (deriveSharedKey) + HKDF
// (deriveConnectionKey) into the synchronous auth-frame handler (sendPostAuthInfo
// below) for every connect. A reconnect storm delivers N auth frames in a single
// poll phase, so the N scalar-mults run back-to-back on the event loop and can
// delay the timer phase past the 15s keepalive sweep (#5594) — event-loop
// starvation that bites only at fan-out scale (swarm-audit round 3, Tunneler).
//
// A classic async semaphore is meaningless here: the crypto is synchronous, so
// no two derivations ever truly overlap — the cost is serialization within one
// loop iteration, not concurrency. The correct analog of a concurrency cap for
// synchronous work is therefore a per-iteration budget: run at most
// MAX_EAGER_DERIVATIONS_PER_TICK derivations inline, and let any further connects
// in the same iteration fall back to the DISCRETE key_exchange handshake. That
// fallback is already wired (the `!eagerServerPublicKey` branch below engages
// encryptionPending + the post-auth queue) and its derivation lands on a later
// frame/tick, which de-concentrates the work so the timer phase — and the
// keepalive sweep — gets to run between iterations.
//
// The counter resets on each setImmediate (fires once per loop iteration, in the
// check phase, after timers), so the budget is genuinely per-iteration. Under
// normal load (< CAP connects per iteration) the eager path is unchanged; only a
// storm degrades, and only to the pre-#5590 discrete handshake (one extra RTT),
// never to a failed connection.
const MAX_EAGER_DERIVATIONS_PER_TICK = 8
let _eagerDerivationsThisTick = 0
let _eagerResetScheduled = false
let _eagerResetHandle = null

/**
 * Reserve a slot for one synchronous eager key derivation in the current
 * event-loop iteration. Returns true if under the per-iteration budget (caller
 * should derive inline), false if the budget is spent (caller should skip the
 * eager fold and let the client use the discrete handshake). Schedules a
 * one-shot reset of the counter for the next iteration on first use.
 *
 * Exported for direct unit testing of the budget + reset behaviour.
 */
export function _reserveEagerDerivationSlot() {
  if (_eagerDerivationsThisTick >= MAX_EAGER_DERIVATIONS_PER_TICK) return false
  _eagerDerivationsThisTick++
  if (!_eagerResetScheduled) {
    _eagerResetScheduled = true
    // Retain the handle so the test reset helper can cancel a still-pending
    // reset and keep test isolation tight (#5764 review).
    _eagerResetHandle = setImmediate(() => {
      _eagerDerivationsThisTick = 0
      _eagerResetScheduled = false
      _eagerResetHandle = null
    })
  }
  return true
}

/**
 * Reset the per-iteration eager-derivation budget synchronously. Test-only — the
 * module-global counter is reset by setImmediate in production, but node:test can
 * run several synchronous test bodies within one macrotask, so a test that
 * exhausts the budget would otherwise leak into the next. Call in a `beforeEach`.
 */
export function _resetEagerDerivationBudgetForTests() {
  // Cancel any reset still queued from a prior test/tick so it can't fire mid
  // test (after an `await`) and mutate the budget unexpectedly (#5764 review).
  if (_eagerResetHandle) {
    clearImmediate(_eagerResetHandle)
    _eagerResetHandle = null
  }
  _eagerDerivationsThisTick = 0
  _eagerResetScheduled = false
}

/**
 * Schedule `fn` once ws.bufferedAmount falls below BACKPRESSURE_PAUSE_THRESHOLD,
 * or immediately (via setImmediate) if the buffer is already drained. Polls
 * with setTimeout(BACKPRESSURE_POLL_INTERVAL_MS) while paused. Bails out
 * silently if ws.readyState transitions away from OPEN — the caller's first
 * action in `fn` already re-checks readyState so the bailout is safe.
 *
 * If the drain stays blocked for BACKPRESSURE_MAX_WAIT_MS (a half-open socket
 * that never drains), stop polling and close the socket so the client
 * reconnects cleanly — `fn` is then never called (#5328).
 *
 * Exported for direct unit testing of the max-wait cap.
 */
export function scheduleAfterDrain(ws, fn) {
  if (ws.readyState !== 1) return
  const buffered = ws.bufferedAmount || 0
  if (buffered <= BACKPRESSURE_PAUSE_THRESHOLD) {
    setImmediate(fn)
    return
  }
  const start = Date.now()
  const poll = () => {
    if (ws.readyState !== 1) return
    if ((ws.bufferedAmount || 0) <= BACKPRESSURE_PAUSE_THRESHOLD) {
      setImmediate(fn)
      return
    }
    if (Date.now() - start >= BACKPRESSURE_MAX_WAIT_MS) {
      log.warn(`replay/flush drain stalled >${BACKPRESSURE_MAX_WAIT_MS}ms (bufferedAmount=${ws.bufferedAmount}) — closing socket so the client reconnects`)
      try { ws.close(1013, 'Replay backpressure timeout') } catch (_) { /* already closing */ }
      return
    }
    setTimeout(poll, BACKPRESSURE_POLL_INTERVAL_MS)
  }
  setTimeout(poll, BACKPRESSURE_POLL_INTERVAL_MS)
}

/**
 * Send all post-authentication info to a newly authenticated client.
 * This includes auth_ok, server mode, session list, model/permission state,
 * and history replay.
 *
 * @param {object} ctx - Server context
 * @param {WebSocket} ws - The client WebSocket
 */
export function sendPostAuthInfo(ctx, ws, extra = {}) {
  const {
    clients, sessionManager, cliSession, defaultSessionId,
    serverMode, serverVersion, latestVersion, gitInfo,
    encryptionEnabled, localhostBypass, tunnelActive, keyExchangeTimeoutMs,
    protocolVersion, minProtocolVersion, webTaskManager,
    // #5721: `send` MUST be `WsServer._send` (which returns the delivery
    // boolean from the client-sender), NOT a wrapper that drops the return —
    // the eager-handshake gate below reads `authOkDelivered` to decide whether
    // to mark E2E established. A ctx-wiring refactor that swallows the return
    // would silently re-open the swallowed-send wedge this fix closes.
    send, broadcast, getConnectedClientList, permissions,
    resultTimeoutMs, hardTimeoutMs, streamStallTimeoutMs,
    // #5986 (epic #5982): whether the embedded user-shell terminal is enabled,
    // surfaced as the `userShell` capability so the dashboard gates its "New
    // shell" affordance. Optional — absent → false (fail-closed) for old servers.
    userShellEnabled,
    // #6481 (epic #6469): whether the opt-in IDE feature surface is enabled
    // (config.features.ide / CHROXY_ENABLE_IDE). Surfaced as the `ide` capability
    // so clients reveal IDE navigation/editing UI. Optional — absent → false
    // (fail-closed) for old servers / callers.
    ideEnabled,
    // #6691: whether the orchestration harness is enabled on this server,
    // surfaced as the `orchestration` capability so the dashboard reveals the
    // Runs surface. Optional — absent → false (fail-closed) for old servers.
    orchestrationEnabled,
    // #6006: whether the server has a rotating TokenManager (i.e. auth is on),
    // so the operator panic button (`revoke_token`) can fire. Surfaced as the
    // `tokenRevoke` capability, gated to primary-token clients below. Optional —
    // absent → false (fail-closed) for --no-auth servers and old callers.
    tokenRevocable,
    // #4835: per-device active-session memory. Consulted below before
    // falling back to defaultSessionId / firstSessionId so a reconnect
    // restores whatever session the client was actually viewing instead
    // of silently snapping them back to "session 1" on every WS drop.
    // Optional — older callers (and most tests) leave this undefined and
    // get the legacy default/first behavior.
    devicePreferences,
    // #5356: exposure snapshot ({ lanBind, bindHost, quickTunnel }) — null /
    // undefined when the server hasn't bound a socket (test harnesses) or the
    // ctx predates the field; the auth_ok field is omitted in that case.
    exposure,
    // #5821: current billing-canary snapshot ({ eraStarted, defaultProvider,
    // defaultBillingClass, warnings }) — null when no provider is wired; the
    // auth_ok field is omitted in that case.
    billingCanary,
    // #5536: long-lived identity keypair for signing the eager exchange key.
    serverIdentity,
  } = ctx
  const client = clients.get(ws)

  // Get initial session info for auth_ok payload
  let sessionInfo = {}
  // #6638: the active session's provider, captured for the auth_ok permission-mode
  // copy (Codex gets codex-tuned descriptions). `entry` below is block-scoped, so
  // hoist the provider to function scope.
  let authOkProvider = null
  if (sessionManager) {
    // #6687: resolve the active session with the SAME precedence block 2 uses to
    // restore the client — the per-device persisted active session (#4835) first,
    // then defaultSessionId → firstSessionId, then the bound-session override — so
    // auth_ok's cwd + permission-mode copy describe the session the client is
    // actually switched to, not the server default.
    let activeId = null
    let entry = null
    const persistedDeviceId = client.deviceInfo?.deviceId
    if (devicePreferences && persistedDeviceId) {
      const persistedId = devicePreferences.getActiveSessionId(persistedDeviceId)
      if (persistedId) {
        const persistedEntry = sessionManager.getSession(persistedId)
        if (persistedEntry) {
          activeId = persistedId
          entry = persistedEntry
        }
      }
    }
    if (!entry) {
      activeId = defaultSessionId
      entry = activeId ? sessionManager.getSession(activeId) : null
    }
    if (!entry) {
      activeId = sessionManager.firstSessionId
      entry = activeId ? sessionManager.getSession(activeId) : null
    }
    // If client is bound to a specific session, use that session's cwd
    // instead of the server default to avoid leaking unrelated session info.
    if (client.boundSessionId) {
      const boundEntry = sessionManager.getSession(client.boundSessionId)
      if (boundEntry) {
        entry = boundEntry
      } else {
        entry = null
      }
    }
    if (entry) {
      sessionInfo.cwd = entry.cwd
      authOkProvider = entry.provider || null
    }
  } else if (cliSession) {
    sessionInfo.cwd = cliSession.cwd
  }
  if (!sessionInfo.cwd) {
    sessionInfo.cwd = null
  }

  // Skip encryption for localhost connections.
  //
  // #6562: the loopback socket-IP check alone is NOT sufficient — cloudflared
  // forwards tunnel traffic to 127.0.0.1, so a REMOTE client over a Quick Tunnel
  // arrives with socketIp 127.0.0.1 and would be silently downgraded to plaintext,
  // which a paired (identity-pinned) mobile client correctly refuses ("did not
  // negotiate encryption"). Additionally require `client.localPeer` — the
  // upgrade-time locality CLASSIFICATION (unspoofable socket peer + proxy-header
  // ABSENCE), which is FALSE when proxy headers (cf-connecting-ip /
  // x-forwarded-for) are present. So a genuine local dashboard (loopback socket,
  // no proxy headers) is still bypassed, but a tunneled connection to 127.0.0.1 is
  // not — it does the full key_exchange. NB: header absence is a WEAK positive
  // "local" signal (a non-Cloudflare loopback-forwarding proxy that omits these
  // headers would classify local — see #6564), but an attacker cannot STRIP
  // cloudflared's edge-stamped cf-connecting-ip to GAIN the bypass, so the
  // security-relevant direction is safe.
  //
  // #6564: harden the residual operator-misconfiguration hole. When a tunnel is
  // running (`tunnelActive`), an UNKNOWN reverse proxy could be forwarding remote
  // traffic to the loopback listener without setting cf-connecting-ip /
  // x-forwarded-for — which would classify as localPeer and get the plaintext
  // bypass. So the bypass is DEFAULT-OFF while a tunnel is active: a genuine
  // same-host dashboard simply does the (cheap, already-supported) key exchange in
  // that window. With no tunnel there is no unknown edge, so the fast loopback
  // bypass still applies. Operators can force encryption on loopback unconditionally
  // with `encryptLocalhost: true` (CHROXY_ENCRYPT_LOCALHOST=1), which sets
  // `localhostBypass=false`. Trust assumption documented in
  // docs/security/encryption-threat-model.md.
  const isLoopbackSocket = client.socketIp === '127.0.0.1' || client.socketIp === '::1' || client.socketIp === '::ffff:127.0.0.1'
  const isLocalhost = localhostBypass && isLoopbackSocket && client.localPeer === true && !tunnelActive
  const requireEncryption = encryptionEnabled && !isLocalhost

  // #5555 (eager key exchange) — if the client supplied its ephemeral public
  // key + salt in the auth message (stashed as client.eagerKeyExchange in
  // handleAuthMessage), derive the shared key inline NOW and return the
  // server's public key in auth_ok below. This collapses the discrete
  // `key_exchange` round trip: the post-auth queue never has to gate, so
  // replay starts a full RTT earlier.
  //
  // Crypto is identical to handleKeyExchange's discrete path:
  // deriveSharedKey (X25519 DH) → deriveConnectionKey (per-connection sub-key
  // from the client salt, so the nonce counter can restart at 0 safely on
  // reconnect without reusing a (key, nonce) pair). Only the transport timing
  // differs — the eager path folds the second handshake leg into auth_ok
  // instead of a separate frame, so the TOFU exposure (#5536: no server
  // identity pinning) is unchanged: the server's public key still travels in
  // the clear over the same TLS-protected tunnel, just one frame earlier.
  //
  // Any failure to derive (malformed eager public key) falls back to the
  // discrete handshake rather than failing the connection — the client still
  // has its keypair and will send `key_exchange` when auth_ok arrives without
  // a serverPublicKey.
  //
  // IMPORTANT ordering: the derived encryptionState is NOT assigned to the
  // client yet. The auth_ok frame that carries serverPublicKey must go out in
  // PLAINTEXT — the client can't decrypt it because it derives the shared key
  // *from* that serverPublicKey. We assign client.encryptionState only AFTER
  // auth_ok is sent (see below), so the subsequent burst (server_mode, status,
  // session_list, …) is encrypted. This mirrors the discrete path, where
  // key_exchange_ok is plaintext and encryptionState is set right after.
  let eagerServerPublicKey = null
  let eagerServerKeySig = null
  let eagerEncryptionState = null
  if (client.eagerKeyExchange) {
    // #5622: only run the eager derivation inline while under the per-iteration
    // budget. Over budget (reconnect storm) we skip the fold and leave
    // eagerServerPublicKey null, so the `requireEncryption && !eagerServerPublicKey`
    // branch below transparently engages the discrete key_exchange handshake —
    // its scalar-mult lands on a later tick, keeping this iteration short enough
    // for the keepalive sweep to run.
    if (requireEncryption && _reserveEagerDerivationSlot()) {
      try {
        const serverKp = createKeyPair()
        const rawSharedKey = deriveSharedKey(client.eagerKeyExchange.publicKey, serverKp.secretKey)
        const encryptionKey = deriveConnectionKey(rawSharedKey, client.eagerKeyExchange.salt)
        eagerEncryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 }
        eagerServerPublicKey = serverKp.publicKey
        // #5536 — sign the eager exchange key with the long-lived identity so a
        // client that pinned our identity can verify it BEFORE keying off the
        // serverPublicKey in auth_ok. Same crypto binding as the discrete path
        // (key_exchange_ok.serverKeySig); only the carrying frame differs. Absent
        // when pinning is unavailable — old clients ignore it, exchange stays TOFU.
        if (serverIdentity?.secretKey) {
          try {
            eagerServerKeySig = signExchangeKey(serverKp.publicKey, serverIdentity.secretKey, { domainSeparated: true })
          } catch (sigErr) {
            log.warn(`Failed to sign eager exchange key for ${client.id}: ${sigErr.message}`)
            eagerServerKeySig = null
          }
        }
      } catch (err) {
        log.warn(`Eager key exchange failed for ${client.id}, falling back to discrete handshake: ${err.message}`)
        eagerEncryptionState = null
        eagerServerPublicKey = null
        eagerServerKeySig = null
      }
    }
    // Consumed (encryption required), unused (encryption disabled / localhost
    // bypass), or failed — never leave it set so a later discrete key_exchange
    // isn't shadowed by stale eager state and no handshake material lingers on
    // the client object longer than the one auth pass that could use it.
    client.eagerKeyExchange = null
  }

  const providers = listProviders()
  const features = {
    environments: providers.some(p => p.capabilities?.containerized),
  }

  // #3272: server-advertised capability map. Dashboard / app gate UI
  // affordances on these flags so older servers don't silently no-op
  // a click against an unknown WS message type. Add new flags here
  // when shipping a dashboard-facing feature whose handler depends on
  // a specific server build and could run against mixed versions.
  const capabilities = {
    // #3235/#3269 — `skill_trust_accept` handler + `skill_trust_accepted`
    // broadcast. Gates the SkillsPanel 'Accept new content' button (#3270).
    skillTrustAccept: true,
    // #3297 — `skill_trust_grant` handler + `skill_trust_granted` broadcast.
    // Gates the community-skill first-activation trust-grant UI.
    skillTrustGrant: true,
    // #4560 — `notification_prefs_get` / `notification_prefs_set` handlers
    // + `notification_prefs` snapshot broadcast (added in #4541). Gates the
    // Notifications section in SettingsPanel / SettingsScreen so a client
    // connecting to a pre-#4541 server doesn't sit on "Loading
    // preferences…" indefinitely waiting for a snapshot that will never
    // arrive — instead the section either hides itself or surfaces a
    // "not supported on this server" message.
    notificationPrefs: true,
    // #5555 — this server emits an `auth_bootstrap` burst frame carrying the
    // provider / slash-command / agent lists right after auth_ok, so a new
    // client can SKIP its 3-request connect-time round trip (list_providers /
    // list_slash_commands / list_agents). Clients that don't see this flag
    // (older server) fall back to requesting the three lists as before. The
    // request handlers stay live either way for post-connect refreshes.
    authBootstrap: true,
    // #6481 (epic #6469): the opt-in IDE feature surface (file navigator, symbol
    // navigation, go-to-definition, find-references, edit-in-place) is enabled on
    // THIS server (config.features.ide / CHROXY_ENABLE_IDE). Clients gate ALL IDE
    // UI on this flag; absent/false (default, or older servers) → no IDE chrome
    // (fail-closed). A server-wide feature gate, not token-scoped — available to
    // every client when the operator opts in.
    ide: ideEnabled === true,
    // #6691: the opt-in orchestration/delegation harness ("committee") is
    // enabled on THIS server (features.orchestration / CHROXY_ENABLE_ORCHESTRATION).
    // Clients gate the Runs surface on this flag; absent/false (default, or older
    // servers) → no orchestration chrome (fail-closed).
    orchestration: orchestrationEnabled === true,
    // #5986 (epic #5982) — the embedded user-shell terminal is available to THIS
    // client: the server has it enabled (userShell.enabled) AND this connection
    // holds the primary token. Both conditions of the create gate are reflected
    // here (config gate #5985a + primary-token gate #5985b) so a paired
    // (non-primary) device never sees a "New shell" affordance it would only get
    // a PRIMARY_TOKEN_REQUIRED rejection from. The provider is hidden from
    // listProviders(), so this flag is the only signal that creating a
    // `user-shell` session will succeed. Absent / false on servers without it, on
    // hosts with it disabled, or for paired clients → the affordance stays hidden
    // (fail-closed). The server gates remain the authority regardless.
    userShell: userShellEnabled === true && client?.isPrimaryToken === true,
    // #6006 — the operator panic button (revoke_token) is available to THIS
    // client: the server has a rotating TokenManager (auth on) AND this
    // connection holds the primary token. Mirrors the server-side gate in
    // token-handlers.js (isPrimaryToken === true) so a paired (non-primary)
    // device never sees a "Revoke token" affordance it would only get a
    // NOT_AUTHORIZED rejection from. Fail-closed: absent/false otherwise.
    tokenRevoke: tokenRevocable === true && client?.isPrimaryToken === true,
  }

  // #3760, #3905: surface the effective inactivity timeouts so clients
  // (e.g. the ActivityIndicator's "approaching timeout" warning + the check-in
  // chip's countdown to hard kill) can render against the real configured
  // values instead of assuming the BaseSession defaults. Older clients
  // ignore the fields; new clients fall back to a hardcoded 30-min / 2h
  // default when the server omits them (older servers).
  //
  // Require Number.isSafeInteger here — the protocol schema enforces
  // `int().positive().finite()` on both fields, so a fractional config
  // value (e.g. `CHROXY_HARD_TIMEOUT_MS=7200000.5` via `parseFloat`)
  // would silently fail client-side schema validation on the auth_ok
  // payload. Falling back to the default lets the wire stay valid.
  //
  // #4484: also enforce the `<= MAX_SANE_DURATION_MS` (24h) ceiling that the
  // protocol schemas apply via `.max(MAX_SANE_DURATION_MS)`. Without this
  // check an operator value like `CHROXY_HARD_TIMEOUT_MS=99999999999`
  // (>24h) would pass isSafeInteger here, hit the wire, and fail the
  // client-side schema's `.max()` gate — silently breaking the auth_ok
  // parse for every connecting client. Mirroring the ceiling here lets
  // the server degrade gracefully to the default instead.
  const effectiveResultTimeoutMs =
    Number.isSafeInteger(resultTimeoutMs) && resultTimeoutMs > 0 && resultTimeoutMs <= MAX_SANE_DURATION_MS
      ? resultTimeoutMs
      : DEFAULT_RESULT_TIMEOUT_MS
  const effectiveHardTimeoutMs =
    Number.isSafeInteger(hardTimeoutMs) && hardTimeoutMs > 0 && hardTimeoutMs <= MAX_SANE_DURATION_MS
      ? hardTimeoutMs
      : DEFAULT_HARD_TIMEOUT_MS
  // #4477: stream-stall window. Semantics differ from the two timeouts above —
  // 0 is a meaningful operator-set value ("explicitly disabled") that must
  // survive intact to the dashboard so the chip (#4476) can hide instead of
  // rendering against a disabled timer. Use `>= 0` here, not `> 0`.
  // Negative / fractional / NaN / Infinity / string inputs fail
  // isSafeInteger and fall back to the default — they'd otherwise fail the
  // protocol schema's int().nonnegative().max(MAX_SANE_DURATION_MS) gate at
  // the client and silently break dashboard message handling.
  // #4484: ceiling check mirrors the protocol schema's `.max()` gate; see
  // resultTimeoutMs above for the asymmetry rationale.
  const effectiveStreamStallTimeoutMs =
    Number.isSafeInteger(streamStallTimeoutMs) && streamStallTimeoutMs >= 0 && streamStallTimeoutMs <= MAX_SANE_DURATION_MS
      ? streamStallTimeoutMs
      : DEFAULT_STREAM_STALL_TIMEOUT_MS

  const authOkDelivered = send(ws, {
    type: 'auth_ok',
    clientId: client.id,
    serverMode,
    serverVersion,
    latestVersion,
    serverCommit: gitInfo.commit,
    cwd: sessionInfo.cwd,
    defaultCwd: sessionManager?.defaultCwd || null,
    connectedClients: getConnectedClientList(),
    encryption: requireEncryption ? 'required' : 'disabled',
    protocolVersion,
    minProtocolVersion,
    maxProtocolVersion: protocolVersion,
    webFeatures: webTaskManager.getFeatureStatus(),
    features,
    capabilities,
    // #5555 — fold the static permission-mode enum into auth_ok so a new
    // client never has to wait for (or react to) the discrete
    // `available_permission_modes` burst frame. The discrete frame is still
    // sent below for older clients that read the enum only from it.
    availablePermissionModes: getPermissionModes(authOkProvider),
    resultTimeoutMs: effectiveResultTimeoutMs,
    hardTimeoutMs: effectiveHardTimeoutMs,
    streamStallTimeoutMs: effectiveStreamStallTimeoutMs,
    // #5356: exposure snapshot for the dashboard warning banner. Optional on
    // the wire — older servers omit it and clients treat that as "unknown".
    ...(exposure ? { exposure } : {}),
    // #5821: current billing-canary snapshot, so a freshly-connected client
    // renders the billing banner immediately. Optional — omitted when no
    // provider is wired (older servers / tests); live changes arrive via the
    // `billing_canary` broadcast.
    ...(billingCanary ? { billingCanary } : {}),
    // #5555: when the eager handshake succeeded, carry the server's public key
    // so the client derives the shared key immediately. Absent otherwise (no
    // eager fields / encryption disabled / derivation failed) → client falls
    // back to the discrete key_exchange.
    ...(eagerServerPublicKey ? { serverPublicKey: eagerServerPublicKey } : {}),
    // #5536: identity signature over the eager exchange key, so a pinned client
    // can verify it before keying off serverPublicKey. Absent when pinning is
    // unavailable; old clients ignore it.
    ...(eagerServerKeySig ? { serverKeySig: eagerServerKeySig } : {}),
    // #5616/#5976 — identity-rotation continuity cert. Present only alongside a
    // live exchange signature (the consume side needs BOTH the cert AND the new
    // identity's live serverKeySig to chain forward), and only when the daemon
    // was rotated (cert loaded at startup). Absent for un-rotated daemons / old
    // clients ignore it; a pin-mismatched client with no cert still refuses.
    ...(eagerServerKeySig && serverIdentity?.rotationCert
      ? { newIdentityKey: serverIdentity.publicKey, rotationCert: serverIdentity.rotationCert }
      : {}),
    ...extra,
  })

  // #5555: now that the plaintext auth_ok (carrying serverPublicKey) has been
  // flushed, activate encryption for this client so every subsequent frame in
  // the post-auth burst is encrypted. The client derives the same shared key
  // from auth_ok.serverPublicKey + its own secret, so both sides start at
  // nonce 0 in lockstep. This is the un-gated eager path — no postAuthQueue.
  if (eagerEncryptionState) {
    // #5721: gate the crypto activation on the auth_ok ACTUALLY reaching the
    // wire. `send` (_clientSend) swallows a send throw internally, so without
    // this check a failed/half-open auth_ok would still flip encryptionState —
    // the server would then encrypt the whole post-auth burst with a key the
    // client never received (it never got serverPublicKey), wedging the session
    // until the 15–30s heartbeat sweep reaps it. Mirror the discrete-path
    // rollback (#5702 8b / ws-auth.js key_exchange_ok): on non-delivery, do NOT
    // mark E2E established, and close so the client reconnects and retries.
    if (!authOkDelivered) {
      log.error(`Failed to deliver eager auth_ok to ${client.id} — aborting handshake (client never received serverPublicKey)`)
      client.encryptionState = null
      try { ws.close(1011, 'Handshake failed') } catch { /* socket already gone */ }
      return
    }
    client.encryptionState = eagerEncryptionState
    log.info(`E2E encryption established eagerly with ${client.id}`)
  }

  // #5555: the eager handshake already established the shared key above, so
  // the post-auth queue must NOT gate — it's un-gated immediately and the
  // burst frames flow encrypted right after auth_ok. Only fall into the
  // discrete-handshake gating below when encryption is required AND the eager
  // path did not run (old client, or derivation failed).
  // If encryption required, queue all subsequent messages until key exchange completes
  if (requireEncryption && !eagerServerPublicKey) {
    client.encryptionPending = true
    client.postAuthQueue = []
    client._keyExchangeTimeout = setTimeout(() => {
      if (client.encryptionPending) {
        log.error(`Key exchange timeout for ${client.id} — disconnecting (encryption required)`)
        client.encryptionPending = false
        client.postAuthQueue = null
        try {
          ws.send(JSON.stringify({ type: 'server_error', message: 'Encryption required but key exchange timed out. Please reconnect.', recoverable: false }))
        } catch (_) {}
        // Guard close() too: if the socket is already CLOSING/CLOSED when this
        // timer fires (a race with a concurrent client disconnect), a bare
        // ws.close() can throw — and the uncaught error would escape this setTimeout
        // callback. Mirrors the guarded close() at the other timeout/error sites.
        try {
          ws.close(1008, 'Key exchange timeout')
        } catch (_) {}
      }
    }, keyExchangeTimeoutMs)
  }

  send(ws, { type: 'server_mode', mode: serverMode })
  send(ws, { type: 'status', connected: true })

  // Multi-session mode
  if (sessionManager) {
    let sessions = sessionManager.listSessions()
    if (client.boundSessionId) {
      sessions = sessions.filter(s => s.sessionId === client.boundSessionId)
    }
    send(ws, { type: 'session_list', sessions })

    // #5665: send the current monthly programmatic-credit meter snapshot so a
    // freshly-connected dashboard shows it immediately, not only after the next
    // billed turn. Machine-wide, so it's sent regardless of boundSessionId.
    if (typeof sessionManager.getMonthlyBudgetStatus === 'function') {
      send(ws, { type: 'monthly_budget', ...sessionManager.getMonthlyBudgetStatus() })
    }

    // Surface any sessions that failed to restore at startup (#2954) so newly
    // connecting clients see the "needs attention" state without having to
    // reconnect after the event fired.
    if (typeof sessionManager.getFailedRestores === 'function') {
      for (const failed of sessionManager.getFailedRestores()) {
        if (client.boundSessionId && failed.sessionId !== client.boundSessionId) continue
        send(ws, {
          type: 'session_restore_failed',
          sessionId: failed.sessionId,
          name: failed.name,
          provider: failed.provider,
          cwd: failed.cwd,
          model: failed.model,
          permissionMode: failed.permissionMode,
          errorCode: failed.errorCode,
          errorMessage: failed.errorMessage,
          originalHistoryPreserved: true,
          historyLength: failed.historyLength,
        })
      }
    }

    // #4835: prefer the per-device persisted active session over the server
    // default. We only consult this for non-bound clients (boundSessionId
    // remains the security override below). The original snap-to-default
    // behavior was an infinite trap when combined with #4833's
    // backpressure eviction: every retry of the user's actually-active
    // session got bounced back to defaultSessionId.
    //
    // Restore order:
    //   1. devicePreferences[client.deviceInfo.deviceId] — if it still exists
    //   2. defaultSessionId — config-driven server default
    //   3. firstSessionId  — last-resort "any session beats no session"
    //
    // A stale persisted id (session destroyed between connects) falls
    // through to step 2 without throwing — see #4835 acceptance criteria.
    let activeId = null
    let entry = null
    const persistedDeviceId = client.deviceInfo?.deviceId
    if (devicePreferences && persistedDeviceId) {
      const persistedId = devicePreferences.getActiveSessionId(persistedDeviceId)
      if (persistedId) {
        const persistedEntry = sessionManager.getSession(persistedId)
        if (persistedEntry) {
          activeId = persistedId
          entry = persistedEntry
        }
      }
    }
    if (!entry) {
      activeId = defaultSessionId
      entry = activeId ? sessionManager.getSession(activeId) : null
    }
    if (!entry) {
      activeId = sessionManager.firstSessionId
      entry = activeId ? sessionManager.getSession(activeId) : null
    }

    // If the client is bound to a specific session (via session token), enforce
    // that they can only view that session regardless of the server default or
    // any persisted per-device preference. Fail closed: if the bound session
    // no longer exists, clear the active session rather than silently falling
    // back to a different session (or inheriting an unrelated persisted pref).
    if (client.boundSessionId) {
      const boundEntry = sessionManager.getSession(client.boundSessionId)
      if (boundEntry) {
        activeId = client.boundSessionId
        entry = boundEntry
      } else {
        log.warn(`Bound session ${client.boundSessionId} not found for client ${client.id} — clearing active session`)
        activeId = null
        entry = null
      }
    }

    // #5563: route through the index-maintaining helper so the post-auth
    // restore keeps the sessionId→clients reverse index in sync. Falls back to
    // a bare assignment for test fixtures whose ctx predates the helper.
    if (typeof ctx.setActiveSession === 'function') {
      ctx.setActiveSession(client, activeId)
    } else {
      // lint-ignore-ws-index-mutation: guarded fixture fallback. This else-branch
      // only runs for legacy test fixtures whose ctx predates the #5563
      // index-maintaining setActiveSession helper; production always takes the
      // helper path above, so this bare write can't drift the reverse index.
      client.activeSessionId = activeId
    }

    if (entry) {
      send(ws, { type: 'session_switched', sessionId: activeId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
      // #5555: `sendSessionInfo` normally pushes `available_models` (the
      // tab-switch path, #4302). On the connect handshake the post-auth block
      // below already pushes one provider-scoped `available_models` snapshot
      // (and, for the no-active-session case, the ONLY snapshot), so skip the
      // duplicate here to avoid sending `available_models` twice per connect.
      // The post-auth block owns the refresh schedule in this path (below).
      sendSessionInfo(ctx, ws, activeId, { skipModels: true })
      replayHistory(ctx, ws, activeId)
    }

    if (activeId) {
      broadcast(
        { type: 'client_focus_changed', clientId: client.id, sessionId: activeId, timestamp: Date.now() },
        (c) => c.id !== client.id
      )
    }

    // Use the active session's provider to source available models so
    // Codex/Gemini sessions never see Claude-only entries (#2956). Non-
    // Claude providers expose static `getFallbackModels()` via their
    // class — getRegistryForProvider returns a provider-scoped registry
    // seeded from that list. Claude providers share the default registry
    // that is fed by `supportedModels()` on each SDK init.
    const activeProvider = entry?.provider || null
    const activeRegistry = getRegistryForProvider(activeProvider)
    send(ws, { type: 'available_models', models: activeRegistry.getModels(), defaultModel: activeRegistry.getDefaultModelId(), provider: activeProvider })
    // #5421/#5555: dynamic-discovery refresh (ollama /api/tags). `sendSessionInfo`
    // above was told to skip its own `available_models` push (de-dupe on connect),
    // so it also skipped scheduling the refresh — this path now owns the single
    // schedule. With no active session activeProvider is null and there is nothing
    // to refresh (scheduleProviderModelsRefresh no-ops on a null provider).
    scheduleProviderModelsRefresh(ctx, ws, activeProvider)
    send(ws, { type: 'available_permission_modes', modes: getPermissionModes(activeProvider) })
    permissions.resendPendingPermissions(ws, client)
    // #5555: fire the connect-time bootstrap burst (providers + slash commands
    // + agents) so a new client never sends its 3-request list_* round trip.
    // Fire-and-forget — the slash/agent compute is async (disk scans) and the
    // synchronous post-auth burst above must not block on it.
    sendAuthBootstrap(ctx, ws, { cwd: entry?.cwd || null, provider: activeProvider, sessionId: activeId })
    return
  }

  // Legacy single-session mode
  if (cliSession) {
    if (cliSession.isReady) {
      send(ws, { type: 'claude_ready' })
    }
    send(ws, {
      type: 'model_changed',
      // #3687: prefer the user's explicit override (`model`) so a later
      // `setModel()` isn't masked by a stale `bootedModel` (SdkSession's
      // setModel doesn't restart, so bootedModel only refreshes on the
      // next init). Fall back to bootedModel when no override was set so
      // the dashboard sees the real running model, not `null`.
      model: (cliSession.model || cliSession.bootedModel)
        ? toShortModelId(cliSession.model || cliSession.bootedModel)
        : null,
    })
    // #6368: scope the legacy single-session model list to the ACTIVE provider's
    // registry (the cliSession is the default-provider session) instead of the
    // Claude-only module-level getModels(). billingCanary.defaultProvider is the
    // resolved `config.provider || DEFAULT_PROVIDER`; for Claude (or a null/absent
    // canary on old ctx) getRegistryForProvider falls back to the default Claude
    // registry, so behaviour is unchanged today.
    const legacyProvider = billingCanary?.defaultProvider || null
    const legacyRegistry = getRegistryForProvider(legacyProvider)
    send(ws, { type: 'available_models', models: legacyRegistry.getModels(), defaultModel: legacyRegistry.getDefaultModelId(), provider: legacyProvider })
    send(ws, {
      type: 'permission_mode_changed',
      mode: cliSession.permissionMode || 'approve',
    })
    send(ws, { type: 'available_permission_modes', modes: getPermissionModes(legacyProvider) })
  }

  permissions.resendPendingPermissions(ws)
  // #5555: legacy single-session bootstrap burst — providers + slash commands
  // + agents for the cliSession's cwd (no provider scoping in legacy mode).
  sendAuthBootstrap(ctx, ws, { cwd: cliSession?.cwd || null, provider: null, sessionId: null })
}

/**
 * #5555 (auth_bootstrap) — compute the provider / slash-command / agent lists
 * and push them in a single `auth_bootstrap` burst frame right after the
 * post-auth sync block. This is the server half of the round-trip collapse:
 * a new client (one that saw `capabilities.authBootstrap` in auth_ok) consumes
 * these payloads and SKIPS its connect-time `list_providers` /
 * `list_slash_commands` / `list_agents` requests.
 *
 * Fire-and-forget by design: the slash-command and agent computes scan disk
 * (project + user `.claude/{commands,agents}`), so awaiting them inline would
 * stall the synchronous post-auth burst. We compute in the background and emit
 * the frame when ready; if the socket has since closed, the send is a no-op.
 *
 * The payloads are byte-identical to the `provider_list` / `slash_commands` /
 * `agent_list` request responses (same `listProviders()` and the shared
 * `computeSlashCommands` / `computeAgents` used by the request handlers), so
 * the client reuses its existing per-message handlers to consume them.
 *
 * Resilient: each list is computed independently; a failure in one (e.g. an
 * unreadable agents dir) still ships the others. A total failure ships an
 * empty bootstrap so the client doesn't sit waiting for data that never comes
 * — it can always refresh later via the (still-live) list_* request paths.
 *
 * @param {object} ctx
 * @param {WebSocket} ws
 * @param {{ cwd: string|null, provider: string|null, sessionId: string|null }} info
 */
function sendAuthBootstrap(ctx, ws, info = {}) {
  const { send, services } = ctx
  const fileOps = ctx.fileOps || services?.fileOps || null
  const cwd = info.cwd || null
  const provider = info.provider || null

  // providers is a cheap synchronous read off the registry — same source as
  // the list_providers handler.
  let providers = []
  try {
    providers = listProviders()
  } catch (err) {
    log.warn(`auth_bootstrap: listProviders failed: ${err.message}`)
    providers = []
  }

  // slash commands + agents are async disk scans; compute in parallel and
  // tolerate either failing on its own.
  const slashP = fileOps && typeof fileOps.computeSlashCommands === 'function'
    ? fileOps.computeSlashCommands(cwd, provider).catch(err => {
        log.warn(`auth_bootstrap: computeSlashCommands failed: ${err.message}`)
        return []
      })
    : Promise.resolve([])
  const userAgentsDirs = ctx.userAgentsDirs
  const agentsOpts = Array.isArray(userAgentsDirs) && userAgentsDirs.length > 0
    ? { userAgentsDirs }
    : {}
  const agentsP = fileOps && typeof fileOps.computeAgents === 'function'
    ? fileOps.computeAgents(cwd, agentsOpts).catch(err => {
        log.warn(`auth_bootstrap: computeAgents failed: ${err.message}`)
        return []
      })
    : Promise.resolve([])

  Promise.all([slashP, agentsP]).then(([slashCommands, agents]) => {
    // Socket may have closed while the disk scans were in flight — bail out
    // rather than sending to a dead peer.
    if (ws.readyState !== 1) return
    send(ws, {
      type: 'auth_bootstrap',
      providers,
      slashCommands,
      agents,
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      // #5555 (sub-item 7): the live public tunnel URL, so a reconnecting
      // client re-learns it on every connect — durable recovery for the case
      // where a quick-tunnel rotation happened while the client was offline
      // and it could not receive the live `tunnel_url_changed` push. Omitted
      // for LAN / no-tunnel deployments (tunnelUrl is null).
      ...(ctx.tunnelUrl ? { tunnelUrl: ctx.tunnelUrl } : {}),
    })
  }).catch(err => {
    // Defensive: Promise.all here can only reject if one of the .catch handlers
    // above itself threw, which they don't — but never let a bootstrap failure
    // surface as an unhandled rejection.
    log.warn(`auth_bootstrap: burst failed for ${ctx.clients?.get(ws)?.id || 'client'}: ${err.message}`)
  })
}

/**
 * #5421: fire-and-forget dynamic model discovery for providers that opt in
 * via a static `refreshModels()` (currently ollama, which probes GET
 * /api/tags for the locally installed tag list). Called right after an
 * `available_models` snapshot goes out: when the refresh resolves with a
 * CHANGED list (non-null), the registry has already been updated, so we
 * re-push `available_models` to the same client. A null resolution means
 * the snapshot already sent is still accurate (probe failed / no change /
 * TTL-cached) and nothing further is emitted — Ollama being down costs one
 * debug log line, never an error or a retry storm (the provider caches
 * failures for its TTL window).
 *
 * Advisory only — this path feeds the picker; model VALIDATION for ollama
 * stays unrestricted via getAllowedModels() returning null (a user can
 * `ollama pull` mid-session or use an alias the tag list doesn't spell out).
 */
export function scheduleProviderModelsRefresh(ctx, ws, providerName) {
  if (!providerName) return
  let ProviderClass = null
  try {
    ProviderClass = getProvider(providerName)
  } catch {
    return // unknown provider — nothing to refresh
  }
  if (typeof ProviderClass?.refreshModels !== 'function') return
  Promise.resolve()
    .then(() => ProviderClass.refreshModels())
    .then((models) => {
      if (!Array.isArray(models) || models.length === 0) return
      if (ws.readyState !== undefined && ws.readyState !== 1) return // client gone
      const registry = getRegistryForProvider(providerName)
      ctx.send(ws, {
        type: 'available_models',
        models: registry.getModels(),
        defaultModel: registry.getDefaultModelId(),
        provider: providerName,
      })
    })
    .catch((err) => {
      // refreshModels contracts never to throw, but a provider bug must not
      // become an unhandled rejection in the post-auth path.
      log.debug(`model refresh for provider ${providerName} failed: ${err?.message || err}`)
    })
}

/**
 * Send session-specific info (model, permission, ready status) to a client.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipModels] - #5555: skip the `available_models` push
 *   (and its paired refresh schedule). Set by `sendPostAuthInfo` on connect,
 *   where the post-auth block sends a single `available_models` snapshot itself
 *   — without this the same client would receive `available_models` twice per
 *   connect. The tab-switch path (#4302) leaves it false so a switch still
 *   re-tags the dashboard's provider.
 */
export function sendSessionInfo(ctx, ws, sessionId, opts = {}) {
  const { sessionManager, send } = ctx
  const entry = sessionManager?.getSession(sessionId)
  if (!entry) return
  const session = entry.session

  if (session.isReady) {
    send(ws, { type: 'claude_ready', sessionId })
  }
  // #4302: push the new session's provider-scoped model list on every
  // switch. Without this, the dashboard's `availableModelsProvider` stays
  // tagged with whichever provider the client saw last (set on auth via
  // `sendPostAuthInfo`), and `modelsMatchProvider` in App.tsx suppresses
  // the model picker for any session whose provider differs from the
  // initial one — most visibly, a claude-cli session created after a
  // TUI/SDK session loses its picker entirely.
  if (!opts.skipModels) {
    const activeProvider = entry.provider || null
    const activeRegistry = getRegistryForProvider(activeProvider)
    send(ws, {
      type: 'available_models',
      models: activeRegistry.getModels(),
      defaultModel: activeRegistry.getDefaultModelId(),
      provider: activeProvider,
    })
    // #5421: background dynamic-discovery refresh (ollama /api/tags); a
    // changed list is re-pushed to this client when the probe lands.
    scheduleProviderModelsRefresh(ctx, ws, activeProvider)
  }
  send(ws, {
    type: 'model_changed',
    // #3687: prefer the user's explicit override (`model`) so a later
    // `setModel()` isn't masked by a stale `bootedModel` (SdkSession's
    // setModel doesn't restart, so bootedModel only refreshes on the
    // next init). Fall back to bootedModel when no override was set so
    // tab switches / reconnects see the real running model, not `null`.
    model: (session.model || session.bootedModel)
      ? toShortModelId(session.model || session.bootedModel)
      : null,
    sessionId,
  })
  send(ws, {
    type: 'permission_mode_changed',
    mode: session.permissionMode || 'approve',
    sessionId,
  })
  // Always sync thinking level on reconnect so stale dashboard state is overwritten
  const thinkingLevel = session.thinkingLevel
  if (thinkingLevel !== undefined) {
    send(ws, {
      type: 'thinking_level_changed',
      level: thinkingLevel || 'default',
      sessionId,
    })
  }
  // Replay permission rules so reconnecting clients have current whitelist.
  // #6771 — also replay durable per-project rules (persistentRules) so the
  // rules surfaces show standing "always allow" grants on session load, not
  // only after a fresh allowAlways in the current session.
  if (typeof session.getPermissionRules === 'function') {
    const rules = session.getPermissionRules()
    const persistentRules = typeof session.getPersistentPermissionRules === 'function'
      ? session.getPersistentPermissionRules()
      : []
    if (rules.length > 0 || persistentRules.length > 0) {
      send(ws, { type: 'permission_rules_updated', rules, persistentRules, sessionId })
    }
  }

  // #6832: replay the last-known `mcp_servers` list so a client subscribing
  // to an already-warmed session (dashboard reconnect, second client joining
  // a shared session) sees the current server list without waiting on the
  // next emission. `mcp_servers` is a transient event (not recorded in
  // history) — sdk/cli sessions emit it once at the stream-json `system/init`
  // and claude-tui re-derives it on warmup/respawn (#6820/#6831), so a late
  // joiner previously saw "No MCP servers" until the next respawn. The
  // session caches the last payload (BaseSession `getMcpServersSnapshot()`,
  // set via a self-listener on `mcp_servers`); null means this session has
  // never emitted one, so there is nothing to replay.
  if (typeof session.getMcpServersSnapshot === 'function') {
    const mcpSnapshot = session.getMcpServersSnapshot()
    if (mcpSnapshot) {
      send(ws, { ...mcpSnapshot, sessionId })
    }
  }

  // #5731 T5 / #5623 / #5613: re-sync the session's primary owner so the
  // presence badge ("Observing" / "Take over" / driver name) doesn't go
  // stale across a reconnect or tab switch. `session_role` is otherwise only
  // broadcast on an actual primary change (_announcePrimary), so a client
  // that dropped while a role was assigned would never re-learn it — mirroring
  // the model / permission-mode / thinking-level re-sync above. When the ctx
  // exposes getPrimary (always true for production wiring; a legacy/direct
  // caller without it simply skips this), send unconditionally — including the
  // unclaimed case as `primaryClientId: null`, a valid payload the client uses
  // to CLEAR a stale role. Both clients' `session_role` handlers are pure
  // state-setters (no toast), so re-emitting on every reconnect is idempotent.
  if (typeof ctx.getPrimary === 'function') {
    send(ws, {
      type: 'session_role',
      sessionId,
      primaryClientId: ctx.getPrimary(sessionId) ?? null,
    })
  }

  // #5160: snapshot-on-subscribe for the Control Room activity tree. A fresh
  // subscriber (new client, tab switch, reconnect) gets the full current tree
  // in one `activity_snapshot` so it reaches canonical state without replaying
  // the `activity_delta` stream — mirroring the `background_work_changed`
  // full-snapshot philosophy. Always sent (empty `entries` is the valid "no
  // in-flight activity" state) so a client can clear any stale tree from a
  // previous session on switch. We stamp the canonical `sessionId` here
  // (matching the live-broadcast path's normalizer injection) rather than
  // trusting whatever internal id the session held.
  if (typeof session.getActivitySnapshot === 'function') {
    const snapshot = session.getActivitySnapshot()
    send(ws, { ...snapshot, sessionId })
  }
}

/**
 * #5555.3 — resolve a client's history cursor for a session into a replay plan.
 *
 * Given the client's `lastSeq` for this session (the highest `historySeq` it
 * has already applied), decide:
 *   - `fullHistory`: true  → replay the WHOLE retained ring buffer; the client
 *                            must REBUILD (swap) its message set. This is the
 *                            backward-compatible default and the fallback for
 *                            every case we can't honour a cursor.
 *   - `fullHistory`: false → CURSOR replay; replay only entries with
 *                            `_seq > lastSeq`. Naturally append-only on the
 *                            client; near-zero on a quick reconnect.
 *   - `startOffset`: index into `history` of the first entry to send.
 *
 * Fallback to full replay (fullHistory: true, startOffset 0) when:
 *   - no cursor supplied (old client, or first connect),
 *   - cursor <= 0 (client has nothing yet),
 *   - cursor > latestSeq — the client's cursor is numerically AHEAD of the
 *     newest retained entry. This is the server-restart reassignment trap:
 *     `_seq` is server-internal and reassigned 1..N on state restore, so a
 *     client reconnecting after a restart can hold a cursor (e.g. 500) far
 *     above the freshly-reassigned latest (e.g. 300). The trim-gap check below
 *     does NOT catch this (oldest is 1, not `> 501`), and a delta replay would
 *     hand the client an EMPTY slice while it keeps stale messages and never
 *     rebuilds — and the cursor (500) would never recover past latest (300).
 *     Force a full rebuild so the client re-syncs to the authoritative set.
 *   - the oldest RETAINED entry's seq is `> lastSeq + 1` — i.e. the entry the
 *     cursor pointed just-after has been trimmed off the front (or the seqs
 *     reset on a server restart), so a delta replay would leave a gap. The
 *     client can't append across a gap, so it must rebuild.
 *
 * When `lastSeq === latestSeq` the client is already current: cursor replay with
 * an empty slice (startOffset === history.length). The caller still emits the
 * start/end frames so the client clears its `receivingHistoryReplay` flag and
 * resolves any stale prompts — just with nothing to append.
 *
 * @param {object} sessionManager
 * @param {Array} history - the retained ring buffer (already fetched)
 * @param {string} sessionId
 * @param {number|null|undefined} lastSeq - client cursor, if any
 * @param {number} [latestSeq] - seq of the newest retained entry (0 when empty)
 * @returns {{ fullHistory: boolean, startOffset: number }}
 */
export function resolveReplayPlan(sessionManager, history, sessionId, lastSeq, latestSeq) {
  // No cursor / nothing applied yet → full replay (backward compatible).
  if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq) || lastSeq <= 0) {
    return { fullHistory: true, startOffset: 0 }
  }
  // Cursor ahead of the newest retained entry (server-restart seq reassignment,
  // or any seq regression): a delta replay would yield an empty slice and leave
  // the client wedged on stale messages with a cursor that never recovers. Force
  // a full rebuild. `latestSeq` is sourced by the caller from
  // getLatestHistorySeq; fall back to a fetch here so a direct caller / test
  // that omits it still gets the guard.
  const resolvedLatest = typeof latestSeq === 'number' && Number.isFinite(latestSeq)
    ? latestSeq
    : (typeof sessionManager.getLatestHistorySeq === 'function'
        ? sessionManager.getLatestHistorySeq(sessionId)
        : 0)
  if (lastSeq > resolvedLatest) {
    return { fullHistory: true, startOffset: 0 }
  }
  const oldestSeq = typeof sessionManager.getOldestHistorySeq === 'function'
    ? sessionManager.getOldestHistorySeq(sessionId)
    : null
  // Empty history can't happen here (caller guards history.length), but be safe.
  if (oldestSeq === null) return { fullHistory: true, startOffset: 0 }
  // Trim gap (or post-restart seq reset): the entry just after the cursor is
  // gone, so a delta replay would skip entries. Rebuild instead.
  if (oldestSeq > lastSeq + 1) {
    return { fullHistory: true, startOffset: 0 }
  }
  // Cursor honoured — find the first entry strictly newer than lastSeq. The
  // ring buffer is seq-ordered, so a linear scan from the front is fine (and
  // typically lands on the tail for a quick reconnect).
  let startOffset = 0
  while (startOffset < history.length && (history[startOffset]._seq || 0) <= lastSeq) {
    startOffset++
  }
  return { fullHistory: false, startOffset }
}

/**
 * Replay message history for a session to a single client.
 * Sends the retained ring buffer in batches to yield the event loop.
 *
 * #5555.3 — honours an optional per-session client cursor
 * (`client.historyCursors[sessionId]`). When the cursor can be honoured the
 * replay is INCREMENTAL: only entries newer than the cursor are sent and the
 * `history_replay_start` frame carries `fullHistory: false`, telling the client
 * to APPEND (no message wipe, no blank flash). When the cursor can't be honoured
 * (no cursor / trimmed past / seq reset) the replay falls back to FULL, with
 * `fullHistory: true` — the long-standing rebuild path.
 *
 * Each replayed entry carries its `historySeq` (the server-internal monotonic
 * seq) so the client can advance its cursor for the next reconnect.
 *
 * The `fullHistory: true` flag is why every reconnect doesn't stack duplicate
 * ring buffers: without it, the client would append a fresh copy on top of what
 * it already had. `isReplayDuplicate` cannot save us when ring-buffer entries
 * and live-broadcast entries have different messageIds — the user-visible
 * failure is duplicated assistant turns and scrambled order (#3743; discovered
 * during the v0.7.16 dogfood smoke-test in #3741).
 */
export function replayHistory(ctx, ws, sessionId, opts = {}) {
  const { sessionManager, send, clients } = ctx
  if (!sessionManager) return
  const history = sessionManager.getHistory(sessionId)
  if (history.length === 0) return

  const truncated = sessionManager.isHistoryTruncated(sessionId)

  // #5555.3 — resolve the client's cursor into a replay plan. clients map may
  // be absent in some test fixtures → treat as no cursor (full replay).
  //
  // `opts.forceFull` short-circuits the cursor and forces a FULL rebuild. The
  // CONNECT handshake (sendPostAuthInfo) honours the cursor — the client was
  // fully disconnected, so no background live messages arrived to desync it.
  // SESSION SWITCH (session-handlers.js) passes forceFull: a background session
  // streams live broadcasts into the client's per-session messages WHILE it's
  // viewed elsewhere, so the cursor lags behind those live appends and a delta
  // replay would re-send (and, with mismatched ids, duplicate) them. Forcing a
  // full rebuild on switch keeps the long-standing authoritative-replace
  // semantics and the atomic swap (#5555.4) hides the rebuild with no flash.
  const client = clients && typeof clients.get === 'function' ? clients.get(ws) : null
  const lastSeq = opts.forceFull ? undefined : client?.historyCursors?.[sessionId]

  // `latestSeq` rides the start frame so the client can advance its cursor even
  // when the slice is empty (already-current reconnect) — there'd be no entry
  // to read a `historySeq` off otherwise. Defensive against legacy ctx fixtures
  // whose manager predates the seq helper. Computed BEFORE resolveReplayPlan so
  // the cursor-ahead-of-latest guard (#5555.3 server-restart trap) can use it.
  const latestSeq = typeof sessionManager.getLatestHistorySeq === 'function'
    ? sessionManager.getLatestHistorySeq(sessionId)
    : 0
  const { fullHistory, startOffset } = resolveReplayPlan(sessionManager, history, sessionId, lastSeq, latestSeq)

  send(ws, { type: 'history_replay_start', sessionId, truncated, fullHistory, latestSeq })

  const CHUNK_SIZE = 20
  const sendChunk = (offset) => {
    if (ws.readyState !== 1) return
    // #4833 follow-up: gate chunk *entry* on bufferedAmount too, not just
    // chunk *scheduling*. The recursive setImmediate-via-scheduleAfterDrain
    // path is already gated, but the very first sendChunk(0) call can land
    // on a socket that's already congested from the preceding
    // sendPostAuthInfo / session_switched burst. Without this check, the
    // first history entry would be sent unconditionally and the mid-chunk
    // break (which only fires *after* a send) wouldn't trip until i=1 —
    // meaning we still push one fat tool_result onto an already-congested
    // socket and can trip the 1MB EVICT_THRESHOLD.
    if ((ws.bufferedAmount || 0) > BACKPRESSURE_PAUSE_THRESHOLD) {
      scheduleAfterDrain(ws, () => sendChunk(offset))
      return
    }
    const end = Math.min(offset + CHUNK_SIZE, history.length)
    let nextOffset = end
    for (let i = offset; i < end; i++) {
      const entry = history[i]
      // #5555.3 — surface the server-internal `_seq` to the client as
      // `historySeq` (and strip the underscore-prefixed internal field) so the
      // client can advance its per-session cursor as it applies each entry.
      const { _seq, ...wireEntry } = entry
      send(ws, { ...wireEntry, sessionId, ...(typeof _seq === 'number' ? { historySeq: _seq } : {}) })
      // #4628: mirror the live `result → agent_idle` fan-out from
      // event-normalizer.js. The dashboard's handler dispatch table has
      // no `result` entry — only `agent_idle` — so a raw `result` in
      // history-replay is silently dropped, and `handleAgentIdle`
      // (which clears activeTools as the #4308 safety net) never fires.
      // Without this, a session that completed cleanly but had an
      // orphan tool_start in history (e.g. dropped PostToolUse hook,
      // #4628 root cause) shows a zombie "Running X" chip every time
      // the dashboard reconnects, until the next chroxy restart. The
      // companion `_emitResult` sweep in BaseSession prevents new
      // orphans from being persisted; this heals the existing wedged
      // sessions on reconnect without requiring a restart.
      if (entry && entry.type === 'result') {
        send(ws, { type: 'agent_idle', sessionId })
      }
      // #4833: break out of the chunk early if bufferedAmount already
      // crossed the pause threshold mid-burst. The CHUNK_SIZE=20 cap was
      // designed for short messages; a session with fat tool_result
      // payloads (200KB+) can blow past the 1MB EVICT_THRESHOLD inside
      // a single chunk, before the post-chunk scheduleAfterDrain ever
      // gets to inspect bufferedAmount. Pause + resume from the next
      // unsent entry instead.
      if (i + 1 < end && (ws.bufferedAmount || 0) > BACKPRESSURE_PAUSE_THRESHOLD) {
        nextOffset = i + 1
        break
      }
    }
    if (nextOffset < history.length) {
      // #4833: pause if the socket is already congested before scheduling
      // the next chunk. Without this, every setImmediate fires another
      // burst regardless of buffer pressure, blowing past the 1MB
      // EVICT_THRESHOLD in ws-client-sender.js on sessions with fat
      // tool_result payloads.
      scheduleAfterDrain(ws, () => sendChunk(nextOffset))
    } else {
      send(ws, { type: 'history_replay_end', sessionId, latestSeq })
    }
  }
  // #5555.3 — start at the resolved offset: 0 for a full replay, the
  // first-newer-than-cursor index for a delta replay. When the client is
  // already current (startOffset === history.length) this immediately falls
  // through to the empty-slice path and emits start+end with nothing between.
  if (startOffset >= history.length) {
    send(ws, { type: 'history_replay_end', sessionId, latestSeq })
  } else {
    sendChunk(startOffset)
  }
}

/**
 * Flush queued post-auth messages in batches to yield the event loop.
 * Same chunking pattern as replayHistory.
 */
export function flushPostAuthQueue(ctx, ws, queue) {
  const { clients, send } = ctx
  const client = clients.get(ws)
  if (client) client._flushing = true
  const CHUNK_SIZE = 20
  const drainChunk = (offset) => {
    if (ws.readyState !== 1) {
      if (client) {
        client._flushing = false
        client._flushOverflow = null
      }
      return
    }
    // #4833 follow-up: gate chunk *entry* on bufferedAmount too — same
    // rationale as replayHistory.sendChunk above. drainChunk(0) is invoked
    // synchronously from flushPostAuthQueue, so the very first queued
    // message can land on an already-congested socket (e.g. fat post-auth
    // payloads that were queued during the encryption handshake) before the
    // mid-chunk break (which only fires after a send) gets a chance to
    // pause. Keep _flushing = true so any callers using ws-client-sender's
    // _flushing buffer still queue overflow instead of blasting past us.
    if ((ws.bufferedAmount || 0) > BACKPRESSURE_PAUSE_THRESHOLD) {
      if (client) client._flushing = true
      scheduleAfterDrain(ws, () => drainChunk(offset))
      return
    }
    const end = Math.min(offset + CHUNK_SIZE, queue.length)
    if (client) client._flushing = false
    let nextOffset = end
    for (let i = offset; i < end; i++) {
      send(ws, queue[i])
      // #4833: break early if a fat queued message just tipped bufferedAmount
      // past the pause threshold — same rationale as replayHistory above.
      if (i + 1 < end && (ws.bufferedAmount || 0) > BACKPRESSURE_PAUSE_THRESHOLD) {
        nextOffset = i + 1
        break
      }
    }
    if (nextOffset < queue.length) {
      if (client) client._flushing = true
      // #4833: pause if the socket is already congested before scheduling
      // the next chunk — same rationale as replayHistory above.
      scheduleAfterDrain(ws, () => drainChunk(nextOffset))
    } else if (client) {
      if (client._flushOverflow?.length) {
        const overflow = client._flushOverflow
        client._flushOverflow = null
        flushPostAuthQueue(ctx, ws, overflow)
      }
    }
  }
  drainChunk(0)
}
