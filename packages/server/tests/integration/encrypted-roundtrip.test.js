/**
 * Integration tests for E2E encrypted WebSocket sessions.
 *
 * Exercises the full encrypt → transmit → decrypt path against a real WsServer
 * instance. Catches crypto regressions (e.g. nonce reuse across reconnects)
 * that unit-level crypto tests cannot catch alone.
 *
 * Relates to: #2702
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { setLogListener } from '../../src/logger.js'
import { createMockSession, waitFor } from '../test-helpers.js'
import {
  createKeyPair,
  deriveSharedKey,
  encrypt,
  decrypt,
  DIRECTION_CLIENT,
  DIRECTION_SERVER,
} from '@chroxy/store-core/crypto'
import WebSocket from 'ws'

/**
 * WsServer wrapper with encryption ENABLED.
 *
 * localhostBypass is disabled so that connections from 127.0.0.1 still
 * go through the key-exchange path — otherwise the server skips encryption
 * for loopback addresses and key_exchange_ok is never sent.
 */
class EncryptedWsServer extends _WsServer {
  constructor(opts = {}) {
    super({ localhostBypass: false, ...opts })
  }

  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await new Promise((resolve, reject) => {
    function onListening() { server.httpServer.removeListener('error', onError); resolve() }
    function onError(err) { server.httpServer.removeListener('listening', onListening); reject(err) }
    server.httpServer.once('listening', onListening)
    server.httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

/**
 * Open a raw WS connection.  Does NOT automatically send auth — callers
 * must drive the handshake themselves so tests can observe each step.
 */
async function openRawClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 2000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
  return { ws, messages }
}

function send(ws, msg) { ws.send(JSON.stringify(msg)) }

async function waitForType(messages, type, timeoutMs = 3000) {
  return waitFor(() => messages.find(m => m.type === type), {
    timeoutMs,
    label: `message type: ${type}`,
  })
}

/**
 * Perform the full auth → key_exchange handshake on `ws`.
 *
 * Returns { sharedKey } so the caller can encrypt/decrypt.
 */
async function doKeyExchange(ws, messages, token = 'test-token') {
  // 1. Authenticate
  send(ws, { type: 'auth', token })
  await waitForType(messages, 'auth_ok')

  // 2. Generate client keypair and send key_exchange
  const clientKp = createKeyPair()
  send(ws, { type: 'key_exchange', publicKey: clientKp.publicKey })

  // 3. Wait for server's key_exchange_ok
  const keOk = await waitForType(messages, 'key_exchange_ok')
  assert.ok(typeof keOk.publicKey === 'string' && keOk.publicKey.length > 0,
    'key_exchange_ok must carry server public key')

  // 4. Derive shared key from server's public key + client's secret key
  const sharedKey = deriveSharedKey(keOk.publicKey, clientKp.secretKey)

  return { sharedKey }
}

describe('integration: encrypted WebSocket roundtrip', () => {
  let server

  afterEach(async () => {
    if (server) {
      try { server.close() } catch {}
      server = null
    }
  })

  it('key_exchange handshake completes and server returns its public key', async () => {
    const mockSession = createMockSession()
    server = new EncryptedWsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await openRawClient(port)

    const { sharedKey } = await doKeyExchange(ws, messages)

    // We should have a valid 32-byte shared key (XSalsa20 secretbox key size)
    assert.ok(sharedKey instanceof Uint8Array, 'sharedKey must be Uint8Array')
    assert.equal(sharedKey.length, 32, 'sharedKey must be 32 bytes')

    ws.close()
  })

  it('encrypted envelope is accepted and decryptable on client side', async () => {
    const mockSession = createMockSession()
    server = new EncryptedWsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await openRawClient(port)
    const { sharedKey } = await doKeyExchange(ws, messages)

    // Snapshot the count of encrypted messages already received (post-auth queue flush)
    const preCount = messages.filter(m => m.type === 'encrypted').length

    // Send an encrypted 'ping' — server responds with encrypted 'pong'
    const plainMsg = JSON.stringify({ type: 'ping' })
    const envelope = encrypt(plainMsg, sharedKey, 0, DIRECTION_CLIENT)
    send(ws, envelope)

    // Wait for a new encrypted envelope to arrive after our request
    const encryptedReply = await waitFor(
      () => messages.filter(m => m.type === 'encrypted').length > preCount
        ? messages.filter(m => m.type === 'encrypted').slice(preCount)[0]
        : null,
      { timeoutMs: 3000, label: 'encrypted pong reply' }
    )

    assert.equal(encryptedReply.type, 'encrypted', 'reply must be an encrypted envelope')
    assert.ok(typeof encryptedReply.d === 'string', 'encrypted reply must have ciphertext field d')
    assert.ok(typeof encryptedReply.n === 'number', 'encrypted reply must have nonce counter n')

    // Decrypt using DIRECTION_SERVER (server encrypts with server direction)
    const decrypted = decrypt(encryptedReply, sharedKey, encryptedReply.n, DIRECTION_SERVER)
    assert.ok(decrypted && typeof decrypted === 'object', 'decrypted payload must be an object')
    assert.equal(decrypted.type, 'pong', `expected pong, got ${decrypted.type}`)

    ws.close()
  })

  it('nonce counter advances between consecutive encrypted messages', async () => {
    const mockSession = createMockSession()
    server = new EncryptedWsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await openRawClient(port)
    const { sharedKey } = await doKeyExchange(ws, messages)

    // Wait for the post-auth queue flush to settle so the nonce counter is stable
    await new Promise(r => setTimeout(r, 50))
    const preCount = messages.filter(m => m.type === 'encrypted').length

    // First ping (nonce 0)
    send(ws, encrypt(JSON.stringify({ type: 'ping' }), sharedKey, 0, DIRECTION_CLIENT))
    const reply0 = await waitFor(
      () => messages.filter(m => m.type === 'encrypted').length > preCount
        ? messages.filter(m => m.type === 'encrypted').slice(preCount)[0]
        : null,
      { timeoutMs: 3000, label: 'first ping reply' }
    )

    // Second ping (nonce 1)
    send(ws, encrypt(JSON.stringify({ type: 'ping' }), sharedKey, 1, DIRECTION_CLIENT))
    const reply1 = await waitFor(
      () => messages.filter(m => m.type === 'encrypted' && m.n > reply0.n).pop(),
      { timeoutMs: 3000, label: 'second ping reply with advanced nonce' }
    )

    assert.ok(reply1.n > reply0.n,
      `second reply nonce (${reply1.n}) must be greater than first (${reply0.n})`)

    // Same plaintext content ('pong') encrypted with different nonces must produce
    // different ciphertexts — this is the core nonce-advance property.
    assert.notEqual(reply0.d, reply1.d, 'ciphertexts at nonce 0 and 1 must differ')

    ws.close()
  })

  it('different connections produce different ciphertexts at nonce 0 (nonce reuse regression)', async () => {
    // Regression test for issue #2684: nonce must not be reused across reconnects.
    // Each connection performs a fresh key exchange, so even at counter 0 the
    // ciphertext for an identical plaintext must differ because the shared key
    // (and therefore effective nonce bytes) differs per-session.
    const mockSession = createMockSession()
    server = new EncryptedWsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)

    // --- First connection ---
    const conn1 = await openRawClient(port)
    const { sharedKey: sharedKey1 } = await doKeyExchange(conn1.ws, conn1.messages)
    // Wait for post-auth queue to flush, then snapshot count
    await new Promise(r => setTimeout(r, 50))
    const preCount1 = conn1.messages.filter(m => m.type === 'encrypted').length
    send(conn1.ws, encrypt(JSON.stringify({ type: 'ping' }), sharedKey1, 0, DIRECTION_CLIENT))
    const encReply1 = await waitFor(
      () => conn1.messages.filter(m => m.type === 'encrypted').length > preCount1
        ? conn1.messages.filter(m => m.type === 'encrypted').slice(preCount1)[0]
        : null,
      { timeoutMs: 3000, label: 'first connection ping reply' }
    )
    conn1.ws.close()

    // Wait for clean disconnect before reconnecting
    await new Promise(r => setTimeout(r, 100))

    // --- Second connection (fresh key pair, different shared key) ---
    const conn2 = await openRawClient(port)
    const { sharedKey: sharedKey2 } = await doKeyExchange(conn2.ws, conn2.messages)
    await new Promise(r => setTimeout(r, 50))
    const preCount2 = conn2.messages.filter(m => m.type === 'encrypted').length
    send(conn2.ws, encrypt(JSON.stringify({ type: 'ping' }), sharedKey2, 0, DIRECTION_CLIENT))
    const encReply2 = await waitFor(
      () => conn2.messages.filter(m => m.type === 'encrypted').length > preCount2
        ? conn2.messages.filter(m => m.type === 'encrypted').slice(preCount2)[0]
        : null,
      { timeoutMs: 3000, label: 'second connection ping reply' }
    )
    conn2.ws.close()

    // Both connections receive their first ping reply at the same server nonce counter
    // (server sends the same number of post-auth queue messages before the ping).
    // The ciphertexts must differ even at the same counter because each connection
    // derives a unique shared key from a fresh ephemeral keypair.
    assert.equal(encReply1.n, encReply2.n,
      `both connections should see the same nonce counter for the first post-handshake message (got ${encReply1.n} vs ${encReply2.n})`)
    assert.notEqual(encReply1.d, encReply2.d,
      'ciphertexts at the same nonce counter must differ across reconnects (each connection has a unique shared key)')
  })

  it('auth_ok includes encryption field when encryption is enabled', async () => {
    const mockSession = createMockSession()
    server = new EncryptedWsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await openRawClient(port)

    send(ws, { type: 'auth', token: 'test-token' })
    const authOk = await waitForType(messages, 'auth_ok')

    assert.equal(authOk.encryption, 'required',
      'auth_ok.encryption must be "required" when noEncrypt is not set')

    ws.close()
  })
})
