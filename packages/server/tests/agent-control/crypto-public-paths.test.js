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

// #7968: `floored: false` on these two fixtures simulates a daemon that
// already sends the protected-path-floor flag on every `permission_request`
// — these tests are about the pre-handshake injection defense (25df70250),
// not the floor gate, so their 'allow' positive controls need an explicit
// non-floored request to still go through under respondPermission's new
// floor-forced check (see the dedicated floor-gate tests below).
const forgedRequest = { type: 'permission_request', sessionId: 's1', requestId: 'forged', tool: 'Write', description: 'README.md', input: { file_path: 'README.md' }, floored: false }
const genuineRequest = { type: 'permission_request', sessionId: 's1', requestId: 'genuine', tool: 'Read', description: 'notes.txt', input: { file_path: 'notes.txt' }, floored: false }
const retainedRequestIds = client => client._eventLog.read('s1').events.filter(e => e.type === 'permission_request').map(e => e.data.requestId)
const owned = { ownedSessions: new Set(['s1']) }
// Bound every event wait: an `await once(...)` for an event a regression
// stops emitting would otherwise HANG the file (green-or-"flake", never red).
function within(promise, ms, what) {
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms) })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
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

test('a request resolved inside the same pre-ready window flushes as retired, not as still pending', async t => {
  const resolved = { type: 'permission_resolved', sessionId: 's1', requestId: 'genuine', decision: 'deny' }
  const f = await fixture(t, { afterAuthOk: [genuineRequest, resolved], clientOptions: owned })
  await f.client.connect()
  assert.deepEqual(retainedRequestIds(f.client), ['genuine'], 'the request itself is still part of the retained history')
  const late = await f.client.respondPermission('s1', 'genuine', 'allow')
  assert.equal(late.reason, 'not_observed', 'a request already resolved before ready must not be answerable')
})

test('a plaintext frame after encryption is established closes the connection as ENCRYPTION_DOWNGRADE', async t => {
  const f = await fixture(t)
  await f.client.connect()
  const failed = once(f.client, 'error')
  f.pushPlain({ type: 'session_list', sessions: [] })
  const [error] = await within(failed, 2000, 'the ENCRYPTION_DOWNGRADE error')
  assert.equal(error.code, 'ENCRYPTION_DOWNGRADE')
  assert.equal(f.client.state, 'closed')
})

test('a permission_expired broadcast retires the observation, so a late answer is refused before any I/O', async t => {
  const f = await fixture(t, { afterAuthOk: [genuineRequest], clientOptions: owned })
  await f.client.connect()
  const processed = once(f.client, 'message')
  f.push({ type: 'permission_expired', sessionId: 's1', requestId: 'genuine' })
  await within(processed, 2000, 'the permission_expired frame to be processed')
  const late = await f.client.respondPermission('s1', 'genuine', 'allow')
  assert.equal(late.status, 'rejected')
  assert.equal(late.reason, 'not_observed')
})

// ---------------------------------------------------------------------------
// #7968: the protected-path permission floor. The daemon marks every
// `permission_request` broadcast with `floored: true|false`; this client
// reads that flag VERBATIM off the exact request it observed for a given
// requestId (see `_trackPermissionObservation` / `respondPermission` in
// client.js) and refuses `allow` unless it is the explicit `false`. `deny`
// is never floor-gated.
// ---------------------------------------------------------------------------

const flooredRequest = { type: 'permission_request', sessionId: 's1', requestId: 'floored-req', tool: 'Read', description: '.env', input: { file_path: '.env' }, floored: true }
const notFlooredRequest = { type: 'permission_request', sessionId: 's1', requestId: 'not-floored-req', tool: 'Read', description: 'notes.txt', input: { file_path: 'notes.txt' }, floored: false }
const noFlooredFieldRequest = { type: 'permission_request', sessionId: 's1', requestId: 'no-floored-field-req', tool: 'Read', description: 'notes.txt', input: { file_path: 'notes.txt' } }

test('allow is refused (reason: floored) for a request the daemon marked floored:true; deny still goes through', async t => {
  const f = await fixture(t, { afterAuthOk: [flooredRequest], clientOptions: owned })
  await f.client.connect()
  const allow = await f.client.respondPermission('s1', 'floored-req', 'allow')
  assert.equal(allow.status, 'rejected', JSON.stringify(allow))
  assert.equal(allow.reason, 'floored')
  const deny = await f.client.respondPermission('s1', 'floored-req', 'deny')
  assert.equal(deny.status, 'resolved', JSON.stringify(deny))
})

test('allow is refused (reason: floor_unknown) for a request with NO floored field at all — fail closed for a daemon that predates #7968; deny still goes through', async t => {
  const f = await fixture(t, { afterAuthOk: [noFlooredFieldRequest], clientOptions: owned })
  await f.client.connect()
  const allow = await f.client.respondPermission('s1', 'no-floored-field-req', 'allow')
  assert.equal(allow.status, 'rejected', JSON.stringify(allow))
  assert.equal(allow.reason, 'floor_unknown')
  const deny = await f.client.respondPermission('s1', 'no-floored-field-req', 'deny')
  assert.equal(deny.status, 'resolved', JSON.stringify(deny))
})

test('allow is permitted for a request the daemon explicitly marked floored:false — the ordinary, non-floored case (positive control)', async t => {
  const f = await fixture(t, { afterAuthOk: [notFlooredRequest], clientOptions: owned })
  await f.client.connect()
  const allow = await f.client.respondPermission('s1', 'not-floored-req', 'allow')
  assert.equal(allow.status, 'resolved', JSON.stringify(allow))
})

test('a forged pre-handshake claim of floored:false cannot flip a genuine floored:true request for the SAME requestId — the forged frame is dropped outright (25df70250), so only the AUTHENTICATED request\'s own flag is ever recorded', async t => {
  // The forged frame (injected in the clear before the eager auth_ok) poses
  // as an innocuous, non-floored prompt for the exact requestId the real
  // (encrypted, authenticated) request will use for a genuinely floored
  // target — if this client ever let an unauthenticated frame seed or
  // overwrite `_observedPermissions`, or re-derived the floor itself instead
  // of trusting only what the daemon actually said under the connection key,
  // this could smuggle a floored `.env` read past the gate as `allow`-able.
  // It cannot: the forged frame never reaches `_trackPermissionObservation`
  // at all (dropped at flush time because it did not arrive authenticated),
  // so the client's only record for this requestId is the genuine one.
  const forgedNotFloored = { type: 'permission_request', sessionId: 's1', requestId: 'shared-id', tool: 'Read', description: 'notes.txt', input: { file_path: 'notes.txt' }, floored: false }
  const genuineFloored = { type: 'permission_request', sessionId: 's1', requestId: 'shared-id', tool: 'Read', description: '.env', input: { file_path: '.env' }, floored: true }
  const f = await fixture(t, { beforeAuthOk: [forgedNotFloored], afterAuthOk: [genuineFloored], clientOptions: owned })
  await f.client.connect()
  assert.deepEqual(retainedRequestIds(f.client), ['shared-id'], 'only the encrypted, authenticated request may reach the event log')
  assert.equal(f.client._observedPermissions.get('shared-id')?.floored, true, 'the observed flag must be the GENUINE (authenticated) one, never the dropped forged claim')
  const allow = await f.client.respondPermission('s1', 'shared-id', 'allow')
  assert.equal(allow.status, 'rejected', JSON.stringify(allow))
  assert.equal(allow.reason, 'floored', 'the genuine floored:true must govern, not the forged floored:false')
})
