import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { AgentControlClient, redactToken } from '../../src/agent-control/client.js'
import { createKeyPair, createSigningKeyPair, deriveSharedKey, deriveConnectionKey, signExchangeKey, decrypt, encrypt, DIRECTION_CLIENT, DIRECTION_SERVER } from '@chroxy/store-core/crypto'

const TOKEN = 'fixture-bearer-token'
const KEY = 'sk-ant-api03-' + 'a'.repeat(48)
test('exact bearer redaction also covers short configured tokens', () => {
  assert.equal(redactToken('short-abc-value', 'abc'), 'short-[REDACTED_TOKEN]-value')
})
async function fixture(t, options = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const identity = createSigningKeyPair()
  let exchanges = 0
  let push = null
  let pushPlain = null
  server.on('connection', socket => {
    let key
    let received = 0
    let sent = 0
    const exchange = createKeyPair()
    const respond = message => socket.send(JSON.stringify(key ? encrypt(JSON.stringify(message), key, sent++, DIRECTION_SERVER) : message))
    const plain = message => socket.send(JSON.stringify(message))
    push = respond
    pushPlain = plain
    const signature = () => options.unsigned ? {} : { serverKeySig: signExchangeKey(exchange.publicKey, identity.secretKey, { domainSeparated: true }) }
    socket.on('message', raw => {
      let message = JSON.parse(raw)
      if (message.type === 'encrypted') message = decrypt(message, key, received++, DIRECTION_CLIENT)
      if (message.type === 'auth') {
        if (options.authFailure) {
          socket.send(JSON.stringify({ type: 'auth_fail', reason: `Rejected ${TOKEN} ${KEY}` }))
          return
        }
        // Frames an on-path attacker could inject in the clear BEFORE the
        // daemon's auth_ok (and therefore before any key exists).
        for (const injected of options.beforeAuthOk || []) plain(injected)
        const metadata = { type: 'auth_ok', encryption: options.plaintext ? 'disabled' : 'required', capabilities: { inputContextV1: true }, serverVersion: options.secretMetadata ? `${TOKEN} ${KEY}` : 'fixture' }
        if (!options.discrete && !options.plaintext) {
          key = deriveConnectionKey(deriveSharedKey(message.eagerPublicKey, exchange.secretKey), message.eagerSalt)
          metadata.serverPublicKey = exchange.publicKey
          Object.assign(metadata, signature())
        }
        socket.send(JSON.stringify(metadata))
        // Discrete path: the window between auth_ok and key_exchange_ok is
        // still plaintext on the wire.
        if (options.discrete) for (const injected of options.betweenDiscrete || []) plain(injected)
        // Eager/plaintext path: the daemon's own post-auth burst, sent (under
        // the connection key when one exists) before the client's fence pong.
        if (!options.discrete) for (const genuine of options.afterAuthOk || []) respond(genuine)
      } else if (message.type === 'key_exchange') {
        exchanges++
        key = deriveConnectionKey(deriveSharedKey(message.publicKey, exchange.secretKey), message.salt)
        socket.send(JSON.stringify({ type: 'key_exchange_ok', publicKey: exchange.publicKey, ...signature() }))
        for (const genuine of options.afterAuthOk || []) respond(genuine)
      } else if (message.type === 'ping') {
        respond({ type: 'pong' })
      } else if (message.type === 'permission_response') {
        respond({ type: 'permission_resolved', requestId: message.requestId, decision: message.decision, sessionId: 's1' })
      }
    })
  })
  const client = new AgentControlClient({ url: `ws://127.0.0.1:${server.address().port}`, token: TOKEN, silent: true, connectTimeoutMs: 400, requestTimeoutMs: 400, ...options.clientOptions, identityPublicKey: options.pin === false ? undefined : options.wrongPin ? createSigningKeyPair().publicKey : identity.publicKey })
  t.after(async () => {
    await client.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  return { client, exchanges: () => exchanges, push: msg => push(msg), pushPlain: msg => pushPlain(msg) }
}

const forgedRequest = { type: 'permission_request', sessionId: 's1', requestId: 'forged', tool: 'Write', description: 'README.md', input: { file_path: 'README.md' } }
const genuineRequest = { type: 'permission_request', sessionId: 's1', requestId: 'genuine', tool: 'Read', description: 'notes.txt', input: { file_path: 'notes.txt' } }
const retainedRequestIds = client => client._eventLog.read('s1').events.filter(e => e.type === 'permission_request').map(e => e.data.requestId)
const owned = { ownedSessions: new Set(['s1']) }
test('a signed matching identity pin connects', async t => {
  const { client } = await fixture(t)
  await client.connect()
  assert.equal(client.state, 'ready')
})
test('a wrong identity pin refuses the connection', async t => {
  const { client } = await fixture(t, { wrongPin: true })
  await assert.rejects(client.connect(), { code: 'IDENTITY_MISMATCH' })
})
test('an unsigned pinned exchange refuses the connection', async t => {
  const { client } = await fixture(t, { unsigned: true })
  await assert.rejects(client.connect(), { code: 'IDENTITY_UNSIGNED' })
})
test('a pinned plaintext downgrade refuses the connection', async t => {
  const { client } = await fixture(t, { plaintext: true })
  await assert.rejects(client.connect(), { code: 'IDENTITY_PIN_REQUIRES_ENCRYPTION' })
})
test('the discrete fallback derives the key and completes an encrypted ping', async t => {
  const f = await fixture(t, { discrete: true })
  await f.client.connect()
  assert.equal(f.client.state, 'ready')
  assert.equal(f.exchanges(), 1)
})
test('daemon metadata redacts bearer and other provider keys', async t => {
  const { client } = await fixture(t, { secretMetadata: true })
  await client.connect()
  const value = JSON.stringify(client.daemonInfo)
  assert.ok(!value.includes(TOKEN))
  assert.ok(!value.includes(KEY))
  const bounded = client._buildDaemonMeta({ serverVersion: 'x'.repeat(10000), latestVersion: { token: TOKEN } })
  assert.equal(bounded.serverVersion.length, 512)
  assert.equal(bounded.latestVersion, null)
})
test('auth failure redacts bearer and provider keys on the actual connect path', async t => {
  const { client } = await fixture(t, { authFailure: true })
  await assert.rejects(client.connect(), error => {
    assert.equal(error.code, 'AUTH_FAILED')
    assert.ok(!error.message.includes(TOKEN))
    assert.ok(!error.message.includes(KEY))
    return true
  })
})
test('logger and public socket error redact provider keys', async t => {
  const logged = []
  const { client } = await fixture(t, { clientOptions: { log: (...args) => logged.push(args.join(' ')) } })
  await client.connect()
  client._log(`Other key ${KEY}`)
  let error
  client.on('error', value => { error = value })
  client._onSocketError(new Error(`Socket ${TOKEN} ${KEY}`))
  assert.ok(!logged.join(' ').includes(KEY))
  assert.ok(!error.message.includes(TOKEN))
  assert.ok(!error.message.includes(KEY))
  assert.ok(!error.stack.includes(KEY))
})

test('public close reasons redact bearer and other provider keys', async t => {
  const { client } = await fixture(t)
  await client.connect()
  let closed
  client.on('close', value => { closed = value })
  client._onSocketClosed(1000, Buffer.from(`${TOKEN} ${KEY}`))
  assert.equal(closed.code, 1000)
  assert.ok(!closed.reason.includes(TOKEN))
  assert.ok(!closed.reason.includes(KEY))
})

// ---------------------------------------------------------------------------
// Pre-handshake integrity. When the daemon requires encryption, every
// application frame it sends is encrypted (eager: from the frame after
// auth_ok; discrete: nothing is sent until key_exchange_ok). A PLAINTEXT
// application frame that arrives before the handshake completes is therefore
// unauthenticated — an on-path injection, not daemon state — and must never
// become an "observed" permission this client will answer, nor an event the
// planner reads. Identity pinning authenticates the exchange key; it says
// nothing about frames that were never under that key.
// ---------------------------------------------------------------------------

test('a plaintext permission_request injected before the eager auth_ok is neither observed nor retained', async t => {
  const f = await fixture(t, { beforeAuthOk: [forgedRequest], afterAuthOk: [genuineRequest], clientOptions: owned })
  await f.client.connect()
  assert.deepEqual(retainedRequestIds(f.client), ['genuine'], 'only the encrypted, authenticated request may reach the event log')
  const forged = await f.client.respondPermission('s1', 'forged', 'allow')
  assert.equal(forged.status, 'rejected')
  assert.equal(forged.reason, 'not_observed')
  // Positive control: the authenticated pre-ready request IS answerable, so
  // the refusal above is not a fixture that denies everything.
  const genuine = await f.client.respondPermission('s1', 'genuine', 'allow')
  assert.equal(genuine.status, 'resolved', JSON.stringify(genuine))
})

test('a plaintext permission_request injected in the discrete key-exchange window is neither observed nor retained', async t => {
  const f = await fixture(t, { discrete: true, betweenDiscrete: [forgedRequest], afterAuthOk: [genuineRequest], clientOptions: owned })
  await f.client.connect()
  assert.equal(f.exchanges(), 1)
  assert.deepEqual(retainedRequestIds(f.client), ['genuine'])
  const forged = await f.client.respondPermission('s1', 'forged', 'allow')
  assert.equal(forged.reason, 'not_observed')
})

test('an unencrypted daemon (no pin) still has its pre-ready permission_request observed — the drop is keyed on encryption, not on timing', async t => {
  const f = await fixture(t, { plaintext: true, pin: false, afterAuthOk: [genuineRequest], clientOptions: owned })
  await f.client.connect()
  assert.deepEqual(retainedRequestIds(f.client), ['genuine'])
  const genuine = await f.client.respondPermission('s1', 'genuine', 'allow')
  assert.equal(genuine.status, 'resolved', JSON.stringify(genuine))
})

test('a plaintext frame after encryption is established closes the connection as ENCRYPTION_DOWNGRADE', async t => {
  const f = await fixture(t)
  await f.client.connect()
  const failed = once(f.client, 'error')
  f.pushPlain({ type: 'session_list', sessions: [] })
  const [error] = await failed
  assert.equal(error.code, 'ENCRYPTION_DOWNGRADE')
  assert.equal(f.client.state, 'closed')
})

test('a permission_expired broadcast retires the observation, so a late answer is refused before any I/O', async t => {
  const f = await fixture(t, { afterAuthOk: [genuineRequest], clientOptions: owned })
  await f.client.connect()
  const processed = once(f.client, 'message')
  f.push({ type: 'permission_expired', sessionId: 's1', requestId: 'genuine' })
  await processed
  const late = await f.client.respondPermission('s1', 'genuine', 'allow')
  assert.equal(late.status, 'rejected')
  assert.equal(late.reason, 'not_observed')
})
