/**
 * Authentication message handling and key exchange for WsServer.
 *
 * Extracted from ws-server.js _handleMessage to separate auth/encryption
 * concerns from message routing.
 */
import { createKeyPair, deriveSharedKey } from './crypto.js'
import { AuthSchema, KeyExchangeSchema } from './ws-schemas.js'
import { createLogger } from './logger.js'

const log = createLogger('ws')

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

  // Check rate limit before processing auth
  const ip = client.socketIp
  const failure = authFailures.get(ip)
  if (failure && failure.blockedUntil > Date.now()) {
    log.warn(`Auth rate-limited for IP ${ip} (${failure.count} failures)`)
    send(ws, { type: 'auth_fail', reason: 'rate_limited' })
    ws.close()
    return true
  }

  if (!authRequired || isTokenValid(msg.token)) {
    client.authenticated = true
    client.authTime = Date.now()
    authFailures.delete(ip)

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

    onAuthSuccess(ws, client)
    log.info(`Client ${client.id} authenticated`)
    return true
  }

  // Auth failure — track for rate limiting
  const now = Date.now()
  const existing = authFailures.get(ip) || { count: 0, firstFailure: now, blockedUntil: 0 }
  existing.count++
  const backoff = Math.min(1000 * Math.pow(2, existing.count - 1), 60_000)
  existing.blockedUntil = now + backoff
  authFailures.set(ip, existing)
  log.warn(`Auth failure from IP ${client.ip} (attempt ${existing.count}, blocked for ${backoff}ms)`)
  send(ws, { type: 'auth_fail', reason: 'invalid_token' })
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
    const serverKp = createKeyPair()
    const sharedKey = deriveSharedKey(msg.publicKey, serverKp.secretKey)
    client.encryptionState = { sharedKey, sendNonce: 0, recvNonce: 0 }
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
