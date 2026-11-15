/**
 * Encrypted handshake and raw transport sends for an agent principal, observed at the
 * real wire sink (a WebSocket client of a real WsServer with encryption required).
 *
 * The principal stamp is applied BEFORE sendPostAuthInfo runs (the server's bootstrap
 * hook is wrapped to stamp the client first), so the eager auth_ok, the key-exchange
 * replies and the raw server_error timeouts are all produced for a principal.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createKeyPair, deriveSharedKey, deriveConnectionKey, generateConnectionSalt, encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT } from '@chroxy/store-core/crypto'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { principalClient } from './principal-test-helpers.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super(opts) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const HOST_FIELDS = ['cwd', 'defaultCwd', 'serverVersion', 'latestVersion', 'serverCommit', 'connectedClients', 'capabilities', 'features', 'webFeatures', 'exposure', 'billingCanary', 'availablePermissionModes', 'resultTimeoutMs', 'hardTimeoutMs']

describe('principal encrypted handshake and raw transport frames', () => {
  let server
  afterEach(() => { if (server) { server.close(); server = null } })

  async function boot({ stamp, keyExchangeTimeoutMs = 60_000 }) {
    const { manager } = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/project-1' }])
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, localhostBypass: false, keyExchangeTimeoutMs })
    const original = server._sendPostAuthInfo.bind(server)
    server._sendPostAuthInfo = (ws, extra) => {
      if (stamp) {
        const record = server.clients.get(ws)
        const stampClient = principalClient()
        record.isPrimaryToken = false
        record.boundSessionId = stampClient.boundSessionId
        record.principal = stampClient.principal
      }
      return original(ws, extra)
    }
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  async function connect(port, { eager }) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const raw = []
    let closeCode = null
    ws.on('message', (d) => { try { raw.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    ws.on('close', (code) => { closeCode = code })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const kp = createKeyPair()
    const salt = generateConnectionSalt()
    ws.send(JSON.stringify({ type: 'auth', token: 'primary-tok', ...(eager ? { eagerPublicKey: kp.publicKey, eagerSalt: salt } : {}) }))
    const authOk = await waitFor(() => raw.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return { ws, raw, kp, salt, authOk, closeCode: () => closeCode }
  }

  describe('eager encrypted auth', () => {
    it('a principal stamped before bootstrap derives the key and exchanges an encrypted frame', async () => {
      const port = await boot({ stamp: true })
      const c = await connect(port, { eager: true })
      assert.equal(c.authOk.encryption, 'required')
      assert.ok(c.authOk.serverPublicKey, 'the eager public key must survive the principal whitelist')
      // Host-wide content is still stripped.
      for (const f of HOST_FIELDS) assert.equal(f in c.authOk, false, `auth_ok must not carry ${f}`)
      assert.equal('sessions' in c.authOk, false)
      // The client derives its key exactly as it would against any daemon.
      const key = deriveConnectionKey(deriveSharedKey(c.authOk.serverPublicKey, c.kp.secretKey), c.salt)
      // Encrypted ping -> encrypted pong, decrypted with the derived key.
      c.ws.send(JSON.stringify(encrypt(JSON.stringify({ type: 'ping' }), key, 0, DIRECTION_CLIENT)))
      const envelope = await waitFor(() => c.raw.find((m) => m.type === 'encrypted'), { label: 'encrypted frame' })
      const pong = decrypt(envelope, key, envelope.n, DIRECTION_SERVER)
      assert.equal(pong.type, 'pong')
      // The burst that follows auth_ok is withheld (a principal gets no replay): only the pong was sent.
      assert.equal(c.raw.filter((m) => m.type === 'encrypted').length, 1)
      c.ws.close()
    })

    it('positive control: the same flow for a host client carries the host fields and the key', async () => {
      const port = await boot({ stamp: false })
      const c = await connect(port, { eager: true })
      assert.ok(c.authOk.serverPublicKey)
      assert.ok('serverVersion' in c.authOk)
      c.ws.close()
    })
  })

  describe('discrete key exchange: raw sends', () => {
    async function discrete(stamp) {
      const port = await boot({ stamp, keyExchangeTimeoutMs: 300 })
      return connect(port, { eager: false })
    }
    const frameOf = (c, type) => waitFor(() => c.raw.find((m) => m.type === type), { label: type })

    for (const stamp of [true, false]) {
      const who = stamp ? 'principal' : 'host client'

      it(`${who}: a valid exchange gets key_exchange_ok in plaintext, then works encrypted`, async () => {
        const c = await discrete(stamp)
        const kp = createKeyPair()
        const salt = generateConnectionSalt()
        c.ws.send(JSON.stringify({ type: 'key_exchange', publicKey: kp.publicKey, salt }))
        const ok = await frameOf(c, 'key_exchange_ok')
        assert.ok(ok.publicKey)
        const allowed = new Set(['type', 'publicKey', 'serverKeySig', 'newIdentityKey', 'rotationCert'])
        assert.deepEqual(Object.keys(ok).filter((k) => !allowed.has(k)), [])
        const key = deriveConnectionKey(deriveSharedKey(ok.publicKey, kp.secretKey), salt)
        c.ws.send(JSON.stringify(encrypt(JSON.stringify({ type: 'ping' }), key, 0, DIRECTION_CLIENT)))
        // A host client also receives the encrypted bootstrap burst, so look for the pong.
        const pong = await waitFor(() => c.raw
          .filter((m) => m.type === 'encrypted')
          .map((env) => decrypt(env, key, env.n, DIRECTION_SERVER))
          .find((m) => m.type === 'pong'), { label: 'encrypted pong' })
        assert.equal(pong.type, 'pong')
        c.ws.close()
      })

      it(`${who}: a malformed exchange gets INVALID_MESSAGE${stamp ? ' without the schema details' : ' with details (unchanged)'}`, async () => {
        const c = await discrete(stamp)
        c.ws.send(JSON.stringify({ type: 'key_exchange', publicKey: 5, salt: 'x' }))
        const err = await frameOf(c, 'error')
        assert.equal(err.code, 'INVALID_MESSAGE')
        assert.equal('details' in err, !stamp)
        if (stamp) assert.deepEqual(Object.keys(err).sort(), ['code', 'message', 'type'])
      })

      it(`${who}: a missing salt gets KEY_EXCHANGE_SALT_REQUIRED${stamp ? ' without details' : ' with details (unchanged)'}`, async () => {
        const c = await discrete(stamp)
        c.ws.send(JSON.stringify({ type: 'key_exchange', publicKey: createKeyPair().publicKey }))
        const err = await frameOf(c, 'error')
        assert.equal(err.code, 'KEY_EXCHANGE_SALT_REQUIRED')
        assert.equal('details' in err, !stamp)
        if (stamp) assert.deepEqual(Object.keys(err).sort(), ['code', 'message', 'type'])
      })

      it(`${who}: the wrong next message gets the fixed server_error and a 1008 close`, async () => {
        const c = await discrete(stamp)
        c.ws.send(JSON.stringify({ type: 'ping' }))
        const err = await frameOf(c, 'server_error')
        assert.equal(err.message, 'Encryption required but client did not initiate key exchange.')
        assert.equal(err.recoverable, false)
        assert.deepEqual(Object.keys(err).sort(), ['message', 'recoverable', 'type'])
        await waitFor(() => c.closeCode() === 1008, { label: 'close 1008' })
      })

      it(`${who}: a timeout gets the fixed server_error and a 1008 close`, async () => {
        const c = await discrete(stamp)
        const err = await waitFor(() => c.raw.find((m) => m.type === 'server_error'), { timeoutMs: 3000, label: 'timeout server_error' })
        assert.equal(err.message, 'Encryption required but key exchange timed out. Please reconnect.')
        assert.deepEqual(Object.keys(err).sort(), ['message', 'recoverable', 'type'])
        await waitFor(() => c.closeCode() === 1008, { label: 'close 1008' })
      })
    }
  })
})
