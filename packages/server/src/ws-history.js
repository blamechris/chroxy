/**
 * History replay and post-auth state delivery for WsServer.
 *
 * Extracted from ws-server.js to separate the post-authentication
 * handshake and history replay concerns from core server orchestration.
 */
import { toShortModelId, getModels, getDefaultModelId, getRegistryForProvider } from './models.js'
import { PERMISSION_MODES } from './handler-utils.js'
import { listProviders, getProvider } from './providers.js'
import { createLogger } from './logger.js'
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
    encryptionEnabled, localhostBypass, keyExchangeTimeoutMs,
    protocolVersion, minProtocolVersion, webTaskManager,
    send, broadcast, getConnectedClientList, permissions,
    resultTimeoutMs, hardTimeoutMs, streamStallTimeoutMs,
    // #4835: per-device active-session memory. Consulted below before
    // falling back to defaultSessionId / firstSessionId so a reconnect
    // restores whatever session the client was actually viewing instead
    // of silently snapping them back to "session 1" on every WS drop.
    // Optional — older callers (and most tests) leave this undefined and
    // get the legacy default/first behavior.
    devicePreferences,
  } = ctx
  const client = clients.get(ws)

  // Get initial session info for auth_ok payload
  let sessionInfo = {}
  if (sessionManager) {
    let activeId = defaultSessionId
    let entry = activeId ? sessionManager.getSession(activeId) : null
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
    }
  } else if (cliSession) {
    sessionInfo.cwd = cliSession.cwd
  }
  if (!sessionInfo.cwd) {
    sessionInfo.cwd = null
  }

  // Skip encryption for localhost connections
  const isLocalhost = localhostBypass && (client.socketIp === '127.0.0.1' || client.socketIp === '::1' || client.socketIp === '::ffff:127.0.0.1')
  const requireEncryption = encryptionEnabled && !isLocalhost

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

  send(ws, {
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
    resultTimeoutMs: effectiveResultTimeoutMs,
    hardTimeoutMs: effectiveHardTimeoutMs,
    streamStallTimeoutMs: effectiveStreamStallTimeoutMs,
    ...extra,
  })

  // If encryption required, queue all subsequent messages until key exchange completes
  if (requireEncryption) {
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
        ws.close(1008, 'Key exchange timeout')
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

    client.activeSessionId = activeId

    if (entry) {
      send(ws, { type: 'session_switched', sessionId: activeId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
      sendSessionInfo(ctx, ws, activeId)
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
    // #5421: dynamic-discovery refresh (ollama /api/tags) is scheduled by
    // sendSessionInfo above whenever a session is active — scheduling here
    // too would join the same in-flight probe twice and double-push a
    // changed list to this client. With no active session activeProvider
    // is null and there is nothing to refresh.
    send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })
    permissions.resendPendingPermissions(ws, client)
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
    send(ws, { type: 'available_models', models: getModels(), defaultModel: getDefaultModelId() })
    send(ws, {
      type: 'permission_mode_changed',
      mode: cliSession.permissionMode || 'approve',
    })
    send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })
  }

  permissions.resendPendingPermissions(ws)
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
 */
export function sendSessionInfo(ctx, ws, sessionId) {
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
  // Replay permission rules so reconnecting clients have current whitelist
  if (typeof session.getPermissionRules === 'function') {
    const rules = session.getPermissionRules()
    if (rules.length > 0) {
      send(ws, { type: 'permission_rules_updated', rules, sessionId })
    }
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
 * Replay message history for a session to a single client.
 * Sends the full ring buffer in batches to yield the event loop.
 *
 * Marks the replay as `fullHistory: true` so clients clear their per-session
 * messages array before applying the replayed events. Without this, every
 * reconnect (the client re-enters `replayHistory` each time it reconnects to
 * an existing session) appends a fresh copy of the ring buffer on top of
 * whatever the client already had. `isReplayDuplicate` cannot save us when
 * ring-buffer entries and live-broadcast entries have different messageIds —
 * the user-visible failure is duplicated assistant turns and scrambled order
 * (#3743; discovered during the v0.7.16 dogfood smoke-test in #3741).
 */
export function replayHistory(ctx, ws, sessionId) {
  const { sessionManager, send } = ctx
  if (!sessionManager) return
  const history = sessionManager.getHistory(sessionId)
  if (history.length === 0) return

  const truncated = sessionManager.isHistoryTruncated(sessionId)
  send(ws, { type: 'history_replay_start', sessionId, truncated, fullHistory: true })

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
      send(ws, { ...entry, sessionId })
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
      send(ws, { type: 'history_replay_end', sessionId })
    }
  }
  sendChunk(0)
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
