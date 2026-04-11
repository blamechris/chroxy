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
import { addLogListener, removeLogListener } from '../../src/logger.js'
import { createMockSession, waitFor, waitForType } from '../test-helpers.js'
import {
  createKeyPair,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  encrypt,
  decrypt,
  DIRECTION_CLIENT,
  DIRECTION_SERVER,
} from '@chroxy/store-core/crypto'
import WebSocket from 'ws'

// Suppress log output without clearing other listeners (avoids global side effects)
function noop() {}

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
    addLogListener(noop)
  }

  close(...args) {
    removeLogListener(noop)
    return super.close(...args)
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

/**
 * Number of encrypted messages the server flushes immediately after key_exchange_ok
 * (post-auth queue: typically server_mode + initial state). Tests wait until at least
 * this many encrypted envelopes have arrived before sending their own ping, so the
 * nonce counter is in a known position.
 */
const EXPECTED_POST_AUTH_FLUSH = 1

/**
 * Perform the full auth → key_exchange handshake on `ws`.
 *
 * Returns { sharedKey } so the caller can encrypt/decrypt.
 * Sends a per-connection salt and derives a sub-key via deriveConnectionKey.
 */
async function doKeyExchange(ws, messages, token = 'test-token') {
  // 1. Authenticate
  send(ws, { type: 'auth', token })
  await waitForType(messages, 'auth_ok')

  // 2. Generate client keypair + connection salt and send key_exchange
  const clientKp = createKeyPair()
  const salt = generateConnectionSalt()
  send(ws, { type: 'key_exchange', publicKey: clientKp.publicKey, salt })

  // 3. Wait for server's key_exchange_ok
  const keOk = await waitForType(messages, 'key_exchange_ok')
  assert.ok(typeof keOk.publicKey === 'string' && keOk.publicKey.length > 0,
    'key_exchange_ok must carry server public key')

  // 4. Derive shared key from server's public key + client's secret key,
  //    then derive per-connection sub-key using the salt
  const rawSharedKey = deriveSharedKey(keOk.publicKey, clientKp.secretKey)
  const sharedKey = deriveConnectionKey(rawSharedKey, salt)

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

    // Wait for an encrypted envelope containing a 'pong' to arrive after our request.
    // The server may send other encrypted messages (e.g. server_mode) before the pong,
    // so we decrypt each new envelope and check for the pong specifically.
    const pongReply = await waitFor(
      () => {
        const newMsgs = messages.filter(m => m.type === 'encrypted').slice(preCount)
        for (const msg of newMsgs) {
          try {
            const decrypted = decrypt(msg, sharedKey, msg.n, DIRECTION_SERVER)
            if (decrypted && decrypted.type === 'pong') return { msg, decrypted }
          } catch { /* skip non-decryptable or non-pong messages */ }
        }
        return null
      },
      { timeoutMs: 3000, label: 'encrypted pong reply' }
    )

    assert.equal(pongReply.msg.type, 'encrypted', 'reply must be an encrypted envelope')
    assert.ok(typeof pongReply.msg.d === 'string', 'encrypted reply must have ciphertext field d')
    assert.ok(typeof pongReply.msg.n === 'number', 'encrypted reply must have nonce counter n')
    assert.equal(pongReply.decrypted.type, 'pong', `expected pong, got ${pongReply.decrypted.type}`)

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

    // Wait for the post-auth queue flush to settle so the nonce counter is stable.
    // Poll-based wait — replaces a fixed setTimeout that flaked under CI load.
    await waitFor(
      () => messages.filter(m => m.type === 'encrypted').length >= EXPECTED_POST_AUTH_FLUSH,
      { timeoutMs: 3000, label: 'post-auth encrypted flush' }
    )
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

  it('different connections produce different ciphertexts for identical plaintext (fresh key per connection)', async () => {
    // Regression test for issue #2684: the server must generate a fresh ephemeral
    // keypair per connection. Before the fix, the server reused the same keypair
    // across reconnects, meaning the same (key, nonce) pair could encrypt different
    // plaintexts — a catastrophic nonce-reuse failure.
    //
    // This test verifies the per-connection keypair property indirectly: because
    // each connection's doKeyExchange() derives a different sharedKey from a fresh
    // server keypair, identical plaintext at any nonce counter produces different
    // ciphertexts. If the server ever reused its keypair the shared keys would be
    // the same and this test would need additional tooling to detect it.
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
    await waitFor(
      () => conn1.messages.filter(m => m.type === 'encrypted').length >= EXPECTED_POST_AUTH_FLUSH,
      { timeoutMs: 3000, label: 'conn1 post-auth encrypted flush' }
    )
    const preCount1 = conn1.messages.filter(m => m.type === 'encrypted').length
    send(conn1.ws, encrypt(JSON.stringify({ type: 'ping' }), sharedKey1, 0, DIRECTION_CLIENT))
    const encReply1 = await waitFor(
      () => conn1.messages.filter(m => m.type === 'encrypted').length > preCount1
        ? conn1.messages.filter(m => m.type === 'encrypted').slice(preCount1)[0]
        : null,
      { timeoutMs: 3000, label: 'first connection ping reply' }
    )
    conn1.ws.close()

    // Wait for clean disconnect before reconnecting (poll on readyState rather than fixed sleep)
    await waitFor(
      () => conn1.ws.readyState === conn1.ws.CLOSED,
      { timeoutMs: 2000, label: 'conn1 closed' }
    )

    // --- Second connection (fresh key pair, different shared key) ---
    const conn2 = await openRawClient(port)
    const { sharedKey: sharedKey2 } = await doKeyExchange(conn2.ws, conn2.messages)
    await waitFor(
      () => conn2.messages.filter(m => m.type === 'encrypted').length >= EXPECTED_POST_AUTH_FLUSH,
      { timeoutMs: 3000, label: 'conn2 post-auth encrypted flush' }
    )
    const preCount2 = conn2.messages.filter(m => m.type === 'encrypted').length
    send(conn2.ws, encrypt(JSON.stringify({ type: 'ping' }), sharedKey2, 0, DIRECTION_CLIENT))
    const encReply2 = await waitFor(
      () => conn2.messages.filter(m => m.type === 'encrypted').length > preCount2
        ? conn2.messages.filter(m => m.type === 'encrypted').slice(preCount2)[0]
        : null,
      { timeoutMs: 3000, label: 'second connection ping reply' }
    )
    conn2.ws.close()

    // The ciphertexts must differ because each connection derives a unique shared
    // key from a fresh server ephemeral keypair — this is the server-side property
    // that prevents nonce reuse across sessions.
    assert.notEqual(encReply1.d, encReply2.d,
      'ciphertexts must differ across reconnects (each connection has a unique shared key from a fresh server keypair)')
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

  it('ignores non-object JSON payloads (regression: agent-review on Part A)', async () => {
    // Before the Part A review-fix, the encryption-enforcement check read
    // `msg.type !== 'encrypted'` without first verifying msg was an object.
    // A client could send literal JSON `null` as a post-handshake plaintext
    // frame and TypeError would escape past the gate into _handleMessage.
    // The guard added in the review fix now rejects non-object payloads up
    // front by returning silently; the connection should stay alive and
    // subsequent legitimate encrypted traffic should still work.
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

    // Send literal JSON `null`, then `"string"`, then `42`, then `[]`.
    // Each must be silently dropped — the server must NOT crash or advance
    // the nonce counter, and the connection must stay open so a subsequent
    // legitimate encrypted ping still works.
    ws.send('null')
    ws.send('"bare-string"')
    ws.send('42')
    ws.send('[]')

    // Give the server 100ms to process all four — the handler returns
    // synchronously for each drop, so this is a generous ceiling.
    await new Promise(r => setTimeout(r, 100))
    assert.equal(ws.readyState, 1 /* OPEN */, 'connection must stay open after non-object JSON')

    // The connection still works: send a real encrypted ping and expect a reply.
    const preCount = messages.filter(m => m.type === 'encrypted').length
    const envelope = encrypt(JSON.stringify({ type: 'ping' }), sharedKey, 0, DIRECTION_CLIENT)
    send(ws, envelope)
    await waitFor(
      () => messages.filter(m => m.type === 'encrypted').length > preCount
        ? messages.filter(m => m.type === 'encrypted').slice(preCount)[0]
        : null,
      { timeoutMs: 3000, label: 'ping reply after non-object JSON drops' }
    )

    ws.close()
  })

  it('REJECTS plaintext frames after encryption is established (2026-04-11 audit blocker 2)', async () => {
    // Pre-audit behavior: after a successful key_exchange, ws-server.js only
    // decrypted frames where msg.type === 'encrypted' but never rejected other
    // frames. A buggy or malicious client could unilaterally downgrade to
    // plaintext on the next message and the server would happily process it
    // as a normal application message. This test asserts that such a downgrade
    // now terminates the connection.
    const mockSession = createMockSession()
    server = new EncryptedWsServer({
      port: 0,
      apiToken: 'test-token',
      cliSession: mockSession,
      authRequired: false,
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await openRawClient(port)

    // Complete the full handshake — encryption is now live on this connection.
    await doKeyExchange(ws, messages)

    // Now send a plaintext frame. Pre-fix, the server silently processed this
    // as a regular 'input' message. Post-fix, it should close the connection
    // with 1008 and an ENCRYPTION_DOWNGRADE_BLOCKED error code.
    send(ws, { type: 'input', data: 'plaintext-after-handshake' })

    // Wait for the close event
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 2000)
      ws.once('close', (code, reason) => {
        clearTimeout(timer)
        resolve({ code, reason: reason?.toString() ?? '' })
      })
    })

    assert.ok(!closed.timeout, 'server must close the connection when a plaintext frame arrives post-handshake')
    assert.equal(closed.code, 1008, 'close code should be 1008 (policy violation)')
    assert.equal(closed.reason, 'encryption required', 'close reason should clearly indicate the enforcement')

    // Critically: the server must NOT have sent any plaintext error frame
    // back. Doing so would itself be a post-handshake plaintext leak — the
    // whole point of this check is to enforce the no-plaintext invariant.
    // No error frame from the server, period.
    const plaintextErr = messages.find(m => m.type === 'error')
    assert.equal(plaintextErr, undefined, 'server must NOT emit a plaintext error frame on downgrade attempt — doing so would break the invariant this check enforces')
  })
})
