/**
 * Authentication message handling and key exchange for WsServer.
 *
 * Extracted from ws-server.js _handleMessage to separate auth/encryption
 * concerns from message routing.
 */
import { createKeyPair, deriveSharedKey, deriveConnectionKey } from '@chroxy/store-core/crypto'
import { AuthSchema, KeyExchangeSchema, PairSchema } from './ws-schemas.js'
import { createLogger } from './logger.js'

const log = createLogger('ws')

/** Maximum number of IP entries tracked in the auth-failure rate-limit map.
 *  When the cap is reached the oldest entry is evicted before inserting. */
export const MAX_AUTH_FAILURE_ENTRIES = 10_000

/** Evict the oldest entry from a Map if it has reached the size cap. */
function evictOldestIfFull(map) {
  if (map.size >= MAX_AUTH_FAILURE_ENTRIES) {
    const oldestKey = map.keys().next().value
    map.delete(oldestKey)
  }
}

/**
 * Handle an auth message from an unauthenticated client.
 * Returns true if the message was consumed (caller should return).
 *
 * @param {object} ctx - Server context
 * @param {WebSocket} ws
 * @param {object} msg - The parsed message
 * @returns {boolean}
 */
export function handleAuthMessage(ctx, ws, msg) {
  const {
    clients, authRequired, isTokenValid,
    authFailures, send, onAuthSuccess,
    minProtocolVersion, serverProtocolVersion,
    pairingManager,
  } = ctx
  const client = clients.get(ws)
  if (!client || client.authenticated) return false
  if (msg.type !== 'auth') return false

  // Validate auth message shape
  const authParsed = AuthSchema.safeParse(msg)
  if (!authParsed.success) {
    send(ws, { type: 'auth_fail', reason: 'invalid_message' })
    ws.close()
    return true
  }
  const authData = authParsed.data

  // Check rate limit before processing auth.
  //
  // Must use client.rateLimitKey (CF-Connecting-IP when behind a Cloudflare
  // tunnel, socketIp otherwise) — NOT client.socketIp. Cloudflare tunnels
  // deliver every request with socketIp=127.0.0.1, so keying off socketIp
  // would lump every real caller into one shared bucket and let a single
  // unauthenticated attacker lock out every legitimate client by flooding
  // failed-auth attempts.
  //
  // See 88f54dc39 for the equivalent fix in the main WS rate limiter; this
  // call site was missed at the time.
  const rateLimitKey = client.rateLimitKey || client.socketIp
  const failure = authFailures.get(rateLimitKey)
  if (failure && failure.blockedUntil > Date.now()) {
    log.warn(`Auth rate-limited for ${rateLimitKey} (${failure.count} failures)`)
    send(ws, { type: 'auth_fail', reason: 'rate_limited' })
    ws.close()
    return true
  }

  if (!authRequired || isTokenValid(msg.token)) {
    client.authenticated = true
    client.authTime = Date.now()
    authFailures.delete(rateLimitKey)

    const hasVersion = typeof msg.protocolVersion === 'number' && Number.isInteger(msg.protocolVersion)
    const clientVersion = hasVersion ? msg.protocolVersion : null

    if (clientVersion !== null && clientVersion < minProtocolVersion) {
      send(ws, { type: 'auth_fail', reason: `unsupported protocol version ${clientVersion} (minimum: ${minProtocolVersion})` })
      ws.close()
      return true
    }

    client.protocolVersion = clientVersion !== null
      ? Math.min(clientVersion, serverProtocolVersion)
      : minProtocolVersion

    if (msg.deviceInfo && typeof msg.deviceInfo === 'object') {
      client.deviceInfo = {
        deviceId: typeof msg.deviceInfo.deviceId === 'string' ? msg.deviceInfo.deviceId : null,
        deviceName: typeof msg.deviceInfo.deviceName === 'string' ? msg.deviceInfo.deviceName : null,
        deviceType: ['phone', 'tablet', 'desktop', 'unknown'].includes(msg.deviceInfo.deviceType) ? msg.deviceInfo.deviceType : 'unknown',
        platform: typeof msg.deviceInfo.platform === 'string' ? msg.deviceInfo.platform : 'unknown',
      }
    }

    // If this token was issued via pairing, bind the client to the session
    // that was active at pairing time (if any). This prevents a valid
    // session token from being used to attach to an unrelated session.
    if (pairingManager && msg.token) {
      const boundSessionId = pairingManager.getSessionIdForToken(msg.token)
      if (boundSessionId) {
        client.boundSessionId = boundSessionId
      }
    }

    client.clientCapabilities = new Set(authData.capabilities ?? [])

    onAuthSuccess(ws, client)
    log.info(`Client ${client.id} authenticated`)
    return true
  }

  // Auth failure — track for rate limiting, keyed by rateLimitKey (the
  // trusted CF-Connecting-IP identity, not the TLS socket peer).
  const now = Date.now()
  const existing = authFailures.get(rateLimitKey) || { count: 0, firstFailure: now, blockedUntil: 0 }
  if (!authFailures.has(rateLimitKey)) evictOldestIfFull(authFailures)
  existing.count++
  const backoff = Math.min(1000 * Math.pow(2, existing.count - 1), 60_000)
  existing.blockedUntil = now + backoff
  authFailures.set(rateLimitKey, existing)
  log.warn(`Auth failure from ${rateLimitKey} (attempt ${existing.count}, blocked for ${backoff}ms)`)
  send(ws, { type: 'auth_fail', reason: 'invalid_token' })
  ws.close()
  return true
}

/**
 * Handle a pair message from an unauthenticated client.
 * Validates the pairing ID and issues a session token.
 * Returns true if the message was consumed (caller should return).
 *
 * @param {object} ctx - Server context (includes pairingManager)
 * @param {WebSocket} ws
 * @param {object} msg - The parsed message
 * @returns {boolean}
 */
export function handlePairMessage(ctx, ws, msg) {
  const {
    clients, pairingManager, send, onAuthSuccess,
    authFailures, minProtocolVersion, serverProtocolVersion,
    activeSessionId,
  } = ctx
  const client = clients.get(ws)
  if (!client || client.authenticated) return false
  if (msg.type !== 'pair') return false
  if (!pairingManager) {
    send(ws, { type: 'pair_fail', reason: 'pairing_not_enabled' })
    ws.close()
    return true
  }

  // Validate pair message shape
  const pairParsed = PairSchema.safeParse(msg)
  if (!pairParsed.success) {
    send(ws, { type: 'pair_fail', reason: 'invalid_message' })
    ws.close()
    return true
  }
  const pairData = pairParsed.data

  // Check rate limit
  const ip = client.socketIp
  const failure = authFailures.get(ip)
  if (failure && failure.blockedUntil > Date.now()) {
    log.warn(`Pair rate-limited for IP ${ip} (${failure.count} failures)`)
    send(ws, { type: 'pair_fail', reason: 'rate_limited' })
    ws.close()
    return true
  }

  // Pass the current active session ID so the issued token is bound to that session.
  const result = pairingManager.validatePairing(msg.pairingId, activeSessionId || null)
  if (result.valid) {
    // Check protocol version BEFORE marking authenticated
    const hasVersion = typeof msg.protocolVersion === 'number' && Number.isInteger(msg.protocolVersion)
    const clientVersion = hasVersion ? msg.protocolVersion : null

    if (clientVersion !== null && clientVersion < minProtocolVersion) {
      send(ws, { type: 'pair_fail', reason: `unsupported protocol version ${clientVersion} (minimum: ${minProtocolVersion})` })
      ws.close()
      return true
    }

    client.authenticated = true
    client.authTime = Date.now()
    client.pairedWith = msg.pairingId
    authFailures.delete(ip)

    client.protocolVersion = clientVersion !== null
      ? Math.min(clientVersion, serverProtocolVersion)
      : minProtocolVersion

    if (msg.deviceInfo && typeof msg.deviceInfo === 'object') {
      client.deviceInfo = {
        deviceId: typeof msg.deviceInfo.deviceId === 'string' ? msg.deviceInfo.deviceId : null,
        deviceName: typeof msg.deviceInfo.deviceName === 'string' ? msg.deviceInfo.deviceName : null,
        deviceType: ['phone', 'tablet', 'desktop', 'unknown'].includes(msg.deviceInfo.deviceType) ? msg.deviceInfo.deviceType : 'unknown',
        platform: typeof msg.deviceInfo.platform === 'string' ? msg.deviceInfo.platform : 'unknown',
      }
    }

    client.clientCapabilities = new Set(pairData.capabilities ?? [])

    // Attach sessionToken so onAuthSuccess can include it in the auth_ok payload
    // (client stores this for future reconnections)
    client._sessionToken = result.sessionToken
    onAuthSuccess(ws, client)
    log.info(`Client ${client.id} paired via pairing ID`)
    return true
  }

  // Pairing failure — track for rate limiting
  const now = Date.now()
  const existing = authFailures.get(ip) || { count: 0, firstFailure: now, blockedUntil: 0 }
  if (!authFailures.has(ip)) evictOldestIfFull(authFailures)
  existing.count++
  const backoff = Math.min(1000 * Math.pow(2, existing.count - 1), 60_000)
  existing.blockedUntil = now + backoff
  authFailures.set(ip, existing)
  log.warn(`Pair failure from IP ${ip}: ${result.reason} (attempt ${existing.count})`)
  send(ws, { type: 'pair_fail', reason: result.reason })
  ws.close()
  return true
}

/**
 * Handle key exchange for E2E encryption.
 * Returns true if the message was consumed (caller should return).
 *
 * @param {object} ctx - Server context
 * @param {WebSocket} ws
 * @param {object} msg
 * @returns {boolean}
 */
export function handleKeyExchange(ctx, ws, msg) {
  const { clients, flushPostAuthQueue } = ctx
  const client = clients.get(ws)

  if (!client?.encryptionPending) return false

  if (msg.type === 'key_exchange') {
    clearTimeout(client._keyExchangeTimeout)
    const keParsed = KeyExchangeSchema.safeParse(msg)
    if (!keParsed.success) {
      const details = keParsed.error.issues.map(i => i.message).join(', ')
      log.warn(`Invalid key_exchange message from ${client.id}: ${details}`)
      try {
        ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', details }))
      } catch (err) {
        log.error(`Failed to send key_exchange error: ${err.message}`)
      }
      ws.close(1008, 'Invalid key_exchange message')
      return true
    }
    // Require a client-supplied salt. Without one, we would fall back to the
    // raw DH shared key with nonce=0 on every reconnect — the exact
    // nonce-reuse-on-reconnect vulnerability fixed in 1fa8eda5e, and the
    // per-connection key derivation wired in 600612649 was never actually
    // enforced: a downgraded or pre-600612649 client that omitted `salt`
    // silently got the old broken behavior. Required unconditionally now;
    // older clients fail with a clear error.
    if (!msg.salt) {
      log.warn(`key_exchange from ${client.id} missing required 'salt' field; client likely predates 600612649 (chroxy >= v0.6.8). Rejecting to avoid nonce reuse on reconnect.`)
      try {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'KEY_EXCHANGE_SALT_REQUIRED',
          details: 'key_exchange requires a client-supplied salt for per-connection key derivation. Please upgrade to a client build that includes commit 600612649 (Chroxy v0.6.8 or later).',
        }))
      } catch (err) {
        log.error(`Failed to send salt-required error: ${err.message}`)
      }
      ws.close(1008, 'key_exchange salt required')
      return true
    }
    const serverKp = createKeyPair()
    const rawSharedKey = deriveSharedKey(msg.publicKey, serverKp.secretKey)
    // Derive a per-connection sub-key so the nonce counter can safely restart
    // at 0 on each reconnect without reusing (key, nonce) pairs from a prior
    // session. This is the enforced path after the 2026-04-11 audit.
    const encryptionKey = deriveConnectionKey(rawSharedKey, msg.salt)
    client.encryptionState = { sharedKey: encryptionKey, sendNonce: 0, recvNonce: 0 }
    client.encryptionPending = false
    try {
      ws.send(JSON.stringify({ type: 'key_exchange_ok', publicKey: serverKp.publicKey }))
    } catch (err) {
      log.error(`Failed to send key_exchange_ok: ${err.message}`)
    }
    log.info(`E2E encryption established with ${client.id}`)
    const queue = client.postAuthQueue
    client.postAuthQueue = null
    flushPostAuthQueue(ws, queue)
    return true
  }

  // Non-key_exchange message while pending — disconnect
  clearTimeout(client._keyExchangeTimeout)
  log.error(`Client ${client.id} sent ${msg.type} instead of key_exchange — disconnecting (encryption required)`)
  client.encryptionPending = false
  client.postAuthQueue = null
  try {
    ws.send(JSON.stringify({ type: 'server_error', message: 'Encryption required but client did not initiate key exchange.', recoverable: false }))
  } catch (_) {}
  ws.close(1008, 'Key exchange required')
  return true
}
