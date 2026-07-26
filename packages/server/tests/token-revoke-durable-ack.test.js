import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { TokenManager } from '../src/token-manager.js'
import { WsServer } from '../src/ws-server.js'

/**
 * #6965 — the primary-token revoke ack must not precede its durable write.
 *
 * #6963 made the panic-revoke's token write durable (`{ durable: true }`), but
 * `onPersist` was fire-and-forget and the `token_rotated{reason:'revoke'}` ack
 * was emitted BEFORE it. That is false safety of the most consequential kind: the
 * operator is told the highest-authority token is dead while a power loss inside
 * the OS writeback window brings the daemon back still honouring it.
 *
 * The contract pinned here:
 *   1. ENFORCEMENT is immediate and unconditional — shells severed and every live
 *      connection de-authed before any disk I/O is awaited (a slow or failing
 *      fsync must never leave a compromised connection privileged).
 *   2. The client-facing ACK is sent strictly AFTER the persist settles.
 *   3. A durability FAILURE produces an explicit `REVOKE_NOT_DURABLE` error and
 *      NEVER the success ack.
 *   4. Scheduled rotations stay non-blocking (only the acute revoke is gated).
 *
 * No sockets are opened: `WsServer`'s constructor creates no handles, so the real
 * `token_rotated` wiring is driven with a fake client map and a `_send` spy.
 */

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Let N rounds of microtasks (and one macrotask) drain. */
async function drain(rounds = 5) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
}

function makeServer(tokenManager) {
  const server = new WsServer({
    port: 0,
    apiToken: 'token-old',
    authRequired: true,
    noEncrypt: true,
    tokenManager,
  })
  const sent = []
  server._send = (ws, msg) => { sent.push({ ws, msg }) }
  const severed = []
  server.sessionManager = {
    destroyAllUserShellSessions: (reason) => { severed.push(reason); return 2 },
  }
  const ws = { readyState: 1 }
  const client = { id: 'c1', authenticated: true, isPrimaryToken: true }
  server.clients = new Map([[ws, client]])
  return { server, sent, severed, ws, client }
}

describe('primary-token revoke: durable-write ack gating (#6965)', () => {
  let managers = []
  afterEach(() => {
    for (const m of managers) m.destroy()
    managers = []
  })
  function track(m) { managers.push(m); return m }

  it('token_rotated carries an awaitable `persisted` promise for the persist', async () => {
    const gate = deferred()
    const manager = track(new TokenManager({ token: 'token-old', onPersist: () => gate.promise }))
    const events = []
    manager.on('token_rotated', (e) => events.push(e))

    const newToken = manager.revoke()
    assert.equal(manager.currentToken, newToken, 'revoke still returns the new token synchronously')
    assert.equal(events.length, 1)
    assert.ok(events[0].persisted && typeof events[0].persisted.then === 'function',
      'the revoke event must expose the persist as an awaitable seam')

    let settled = false
    events[0].persisted.then(() => { settled = true })
    await drain()
    assert.equal(settled, false, 'persisted must not settle before the write does')
    gate.resolve()
    await events[0].persisted
    assert.equal(settled, true)
  })

  it('a throwing onPersist becomes a rejected `persisted` (never a sync throw or a silent success)', async () => {
    const manager = track(new TokenManager({
      token: 'token-old',
      onPersist: () => { const err = new Error('simulated fsync I/O failure'); err.code = 'EIO'; throw err },
    }))
    let event = null
    manager.on('token_rotated', (e) => { event = e })
    assert.doesNotThrow(() => manager.revoke())
    await assert.rejects(event.persisted, /simulated fsync I\/O failure/)
  })

  it('carries a null `persisted` when no persist hook is configured', () => {
    const manager = track(new TokenManager({ token: 'token-old' }))
    let event = null
    manager.on('token_rotated', (e) => { event = e })
    manager.revoke()
    assert.equal(event.persisted, null)
  })

  it('severs + de-auths immediately, but withholds the ack until the durable write lands', async () => {
    const gate = deferred()
    const manager = track(new TokenManager({ token: 'token-old', onPersist: () => gate.promise }))
    const { server, sent, severed, client } = makeServer(manager)

    manager.revoke()

    // (1) enforcement is immediate — it must NOT wait on the disk.
    assert.deepEqual(severed, ['revoked'], 'user-shell sessions severed at once')
    assert.equal(client.authenticated, false, 'connection de-authed at once')
    assert.equal(client.isPrimaryToken, false, 'primary authority stripped at once')

    // (2) the ack is withheld while the durable write is in flight.
    await drain()
    assert.deepEqual(sent, [], 'no revoke ack may be sent before the durable write completes')

    gate.resolve()
    const outcome = await server._lastRevokeAck
    assert.deepEqual(outcome, { ok: true })
    assert.equal(sent.length, 1, 'exactly one ack per connection, after the write')
    assert.deepEqual(sent[0].msg, { type: 'token_rotated', expiresAt: null, reason: 'revoke' })
  })

  it('a durability failure sends REVOKE_NOT_DURABLE *and* the revoke transition, in that order', async () => {
    const gate = deferred()
    const manager = track(new TokenManager({ token: 'token-old', onPersist: () => gate.promise }))
    const { server, sent, client } = makeServer(manager)

    manager.revoke()
    const err = new Error('simulated fsync I/O failure')
    err.code = 'EIO'
    gate.reject(err)
    const outcome = await server._lastRevokeAck

    assert.equal(outcome.ok, false)
    assert.equal(client.authenticated, false, 'enforcement still holds in-process')
    assert.equal(sent.length, 2, 'the diagnostic AND the state transition, one of each per connection')

    // The operator diagnostic goes FIRST: `token_rotated{reason:'revoke'}` makes the
    // mobile client tear the socket down, so a frame queued after it can be lost.
    assert.equal(sent[0].msg.type, 'error')
    assert.equal(sent[0].msg.code, 'REVOKE_NOT_DURABLE')
    assert.match(sent[0].msg.message, /durabl|restart/i)

    // ...and the transition is NOT withheld. It is this connection's ONLY automatic
    // trigger for clearing the now-dead credential and prompting re-auth
    // (packages/app/src/store/message-handler.ts `case 'token_rotated'` with no
    // token → clearSavedConnection() + disconnect() + re-scan alert). The `error`
    // envelope reaches neither the socket nor secure storage, so withholding this
    // left every mobile client "connected" holding a REVOKED token with server-side
    // authority already stripped — every privileged op failing opaquely, nothing
    // prompting a re-pair. The message carries no token and makes no durability
    // claim; "your authority is gone" is TRUE on this branch.
    assert.deepEqual(
      sent[1].msg,
      { type: 'token_rotated', expiresAt: null, reason: 'revoke' },
      'the revoke transition must still be delivered when the write was not durable',
    )
  })

  it('sends the ack synchronously when no persist hook is configured (unchanged path)', () => {
    const manager = track(new TokenManager({ token: 'token-old' }))
    const { server, sent } = makeServer(manager)
    manager.revoke()
    assert.equal(sent.length, 1, 'nothing to wait for — ack stays synchronous')
    assert.equal(sent[0].msg.reason, 'revoke')
    assert.equal(server._lastRevokeAck, null)
  })

  it('does NOT gate a scheduled rotation on its persist (routine rotations stay non-blocking)', () => {
    const gate = deferred()
    const manager = track(new TokenManager({ token: 'token-old', graceMs: 50, onPersist: () => gate.promise }))
    const { sent } = makeServer(manager)
    manager.rotate() // scheduled
    assert.equal(sent.length, 1, 'a scheduled rotation broadcasts immediately')
    assert.equal(sent[0].msg.reason, 'scheduled')
    gate.resolve()
  })

  // ---------------------------------------------------------------------------
  // #7053 — the gate must be BOUNDED. Contract 2 above ("ack strictly after the
  // persist settles") has a failure mode of its own: if the persist NEVER
  // settles, the operator gets nothing at all — no ack, no error — while
  // enforcement has silently already happened in-process. A panic button that
  // appears to do nothing is its own kind of false safety.
  // ---------------------------------------------------------------------------

  it('a never-settling onPersist still produces a client-facing message (bounded gate)', async () => {
    const manager = track(new TokenManager({ token: 'token-old', onPersist: () => new Promise(() => {}) }))
    const { server, sent } = makeServer(manager)
    server._revokeAckTimeoutMs = 40 // keep the test fast; production default is seconds

    manager.revoke()
    await drain()
    assert.deepEqual(sent.map((s) => s.msg.type), [], 'nothing before the bound elapses — the gate still gates')

    await new Promise((r) => setTimeout(r, 80))
    await drain()

    const types = sent.map((s) => s.msg.type)
    assert.ok(types.length > 0, 'a hung persist must NOT swallow the revoke silently')

    // Same shape as the rejection branch: diagnostic first, then the transition.
    assert.equal(sent[0].msg.type, 'error')
    assert.equal(
      sent[0].msg.code, 'REVOKE_DURABILITY_UNKNOWN',
      'a timeout is UNKNOWN, not known-failed — it must not claim REVOKE_NOT_DURABLE',
    )
    assert.match(sent[0].msg.message, /did not report|timed out|unknown/i)

    const transition = sent.find((s) => s.msg.type === 'token_rotated')
    assert.ok(transition, 'the revoke transition must still be sent — it is the client\'s only trigger to drop the dead token')
    assert.equal(transition.msg.reason, 'revoke')
    assert.equal(transition.msg.token, undefined, 'the transition carries NO token and makes no durability claim')
  })

  it('a persist that settles AFTER the timeout does not double-send', async () => {
    const gate = deferred()
    const manager = track(new TokenManager({ token: 'token-old', onPersist: () => gate.promise }))
    const { server, sent } = makeServer(manager)
    server._revokeAckTimeoutMs = 40

    manager.revoke()
    await new Promise((r) => setTimeout(r, 80))
    await drain()
    const afterTimeout = sent.length
    assert.ok(afterTimeout > 0, 'the timeout path fired')

    gate.resolve() // the storage layer finally comes back
    await drain()

    assert.equal(sent.length, afterTimeout, 'a late persist must not emit a second ack or error')
  })

  it('a persist that settles BEFORE the bound behaves exactly as before (no timeout frame)', async () => {
    const gate = deferred()
    const manager = track(new TokenManager({ token: 'token-old', onPersist: () => gate.promise }))
    const { server, sent } = makeServer(manager)
    server._revokeAckTimeoutMs = 5000

    manager.revoke()
    await drain()
    gate.resolve()
    await drain()

    assert.deepEqual(sent.map((s) => s.msg.type), ['token_rotated'], 'success path is unchanged: the ack only')
    assert.equal(sent.filter((s) => s.msg.code === 'REVOKE_DURABILITY_UNKNOWN').length, 0)
  })
})
