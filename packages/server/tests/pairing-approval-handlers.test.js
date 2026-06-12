/**
 * Pairing-approval primitive (#5510) — WS handler unit tests.
 *
 * Covers the pre-auth `pair_request` handler (ws-auth.js) and the post-auth
 * host-level `pair_approve` / `pair_deny` handlers (pairing-handlers.js), wired
 * to a real PairingManager queue. No running WsServer required.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { handlePairRequestMessage } from '../src/ws-auth.js'
import { pairingHandlers } from '../src/handlers/pairing-handlers.js'
import { PairingManager } from '../src/pairing.js'
import { nsCtx } from './test-helpers.js'

function makeMockWs() {
  const sentRaw = []
  return {
    readyState: 1,
    sentRaw,
    sent: () => sentRaw.map(s => JSON.parse(s)),
    closed: false,
    send(data) { sentRaw.push(typeof data === 'string' ? data : JSON.stringify(data)) },
    close() { this.closed = true },
  }
}

function makeClient({ authenticated = false, boundSessionId = null, ip = '1.2.3.4' } = {}) {
  return { id: 'c1', authenticated, boundSessionId, socketIp: ip, rateLimitKey: ip }
}

// Build a pre-auth ctx for handlePairRequestMessage backed by a real manager,
// recording host fan-out and requester registration.
function makeRequestCtx({ pairingManager } = {}) {
  const ws = makeMockWs()
  const client = makeClient()
  const clients = new Map([[ws, client]])
  const hostFanout = []
  const registered = new Map()
  const ctx = {
    clients,
    pairingManager,
    send: (socket, msg) => socket.send(JSON.stringify(msg)),
    registerPairRequester: (requestId, sock) => registered.set(requestId, sock),
    broadcastPairPending: (msg) => hostFanout.push(msg),
  }
  return { ctx, ws, client, hostFanout, registered }
}

describe('handlePairRequestMessage (#5510 pre-auth)', () => {
  let pm
  beforeEach(() => { pm = new PairingManager({ wsUrl: 'wss://x' }) })

  it('queues a request, replies pair_request_pending, and fans pair_pending to hosts', () => {
    const { ctx, ws, hostFanout, registered } = makeRequestCtx({ pairingManager: pm })
    const consumed = handlePairRequestMessage(ctx, ws, {
      type: 'pair_request', requestId: 'req1', deviceName: 'Pixel 8',
    })
    assert.equal(consumed, true)
    const pending = ws.sent().find(m => m.type === 'pair_request_pending')
    assert.ok(pending, 'requester gets pair_request_pending')
    assert.match(pending.verifyCode, /^\d{6}$/)
    assert.equal(ws.closed, false, 'connection stays open')
    assert.equal(registered.get('req1'), ws, 'requester ws is tracked')

    assert.equal(hostFanout.length, 1)
    assert.equal(hostFanout[0].type, 'pair_pending')
    assert.equal(hostFanout[0].deviceName, 'Pixel 8')
    assert.equal(hostFanout[0].verifyCode, pending.verifyCode, 'same code on both surfaces')
    pm.destroy()
  })

  it('rejects when pairing is disabled', () => {
    const { ctx, ws } = makeRequestCtx({ pairingManager: null })
    handlePairRequestMessage(ctx, ws, { type: 'pair_request', requestId: 'r', deviceName: 'x' })
    const res = ws.sent().find(m => m.type === 'pair_result')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'pairing_not_enabled')
    assert.equal(ws.closed, true)
  })

  it('rejects an invalid message shape', () => {
    const { ctx, ws } = makeRequestCtx({ pairingManager: pm })
    handlePairRequestMessage(ctx, ws, { type: 'pair_request' }) // missing requestId
    const res = ws.sent().find(m => m.type === 'pair_result')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'invalid_message')
    assert.equal(ws.closed, true)
    pm.destroy()
  })

  it('surfaces queue_full as a terminal pair_result and closes', () => {
    // Fill the queue to cap (5) directly on the manager.
    for (let i = 0; i < 5; i++) pm.enqueuePendingRequest({ requestId: `f${i}`, source: `s${i}` })
    const { ctx, ws } = makeRequestCtx({ pairingManager: pm })
    handlePairRequestMessage(ctx, ws, { type: 'pair_request', requestId: 'overflow', deviceName: 'n' })
    const res = ws.sent().find(m => m.type === 'pair_result')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'queue_full')
    assert.equal(ws.closed, true)
    pm.destroy()
  })

  it('ignores an authenticated client (not its job)', () => {
    const { ctx, ws, client } = makeRequestCtx({ pairingManager: pm })
    client.authenticated = true
    assert.equal(handlePairRequestMessage(ctx, ws, { type: 'pair_request', requestId: 'r' }), false)
    pm.destroy()
  })
})

describe('pair_approve / pair_deny (#5510 host-level)', () => {
  let pm
  beforeEach(() => { pm = new PairingManager({ wsUrl: 'wss://x' }) })

  function makeApproveCtx() {
    const resolved = []
    const broadcasts = []
    const ctx = nsCtx({
      pairingManager: pm,
      // #5632: pair_approve / pair_deny errors now route through
      // ctx.transport.send. Mirror the real WsServer._send → ws.send step so the
      // existing `ws.sent()` assertions still observe the error envelopes.
      send: (socket, msg) => { if (socket && typeof socket.send === 'function') socket.send(JSON.stringify(msg)) },
      resolvePairRequester: (requestId, result) => resolved.push({ requestId, result }),
      broadcastPairResolved: (requestId, reason) => broadcasts.push({ requestId, reason }),
    })
    return { ctx, resolved, broadcasts }
  }

  it('approve issues the token to the requester exactly once and retracts banners', async () => {
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    const { ctx, resolved, broadcasts } = makeApproveCtx()
    const ws = makeMockWs()
    const client = makeClient({ authenticated: true })

    await pairingHandlers.pair_approve(ws, client, { type: 'pair_approve', requestId: 'r1' }, ctx)
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].result.ok, true)
    assert.ok(typeof resolved[0].result.token === 'string' && resolved[0].result.token.length > 0)
    assert.equal(pm.isSessionTokenValid(resolved[0].result.token), true)
    assert.deepEqual(broadcasts[0], { requestId: 'r1', reason: 'approved' })

    // Second approve is a no-op error — no second token.
    await pairingHandlers.pair_approve(ws, client, { type: 'pair_approve', requestId: 'r1' }, ctx)
    assert.equal(resolved.length, 1, 'no second token delivered')
    const err = ws.sent().find(m => m.type === 'error')
    assert.ok(err && /already_resolved/.test(err.message))
  })

  it('rejects a session-bound (non-host) client with FORBIDDEN', async () => {
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    const { ctx, resolved } = makeApproveCtx()
    const ws = makeMockWs()
    const client = makeClient({ authenticated: true, boundSessionId: 'sess-A' })

    await pairingHandlers.pair_approve(ws, client, { type: 'pair_approve', requestId: 'r1' }, ctx)
    const err = ws.sent().find(m => m.type === 'error')
    assert.equal(err.code, 'FORBIDDEN')
    assert.equal(resolved.length, 0, 'no token issued for a bound client')
    // The request is still live — a bound client cannot consume it.
    assert.ok(pm.getPendingRequest('r1'))
  })

  it('deny notifies the requester and retracts banners', async () => {
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    const { ctx, resolved, broadcasts } = makeApproveCtx()
    const ws = makeMockWs()
    const client = makeClient({ authenticated: true })

    await pairingHandlers.pair_deny(ws, client, { type: 'pair_deny', requestId: 'r1' }, ctx)
    assert.deepEqual(resolved[0].result, { ok: false, reason: 'denied' })
    assert.deepEqual(broadcasts[0], { requestId: 'r1', reason: 'denied' })
    assert.equal(pm.getPendingRequest('r1'), null)
  })

  it('approve of an unknown request reports the failure reason', async () => {
    const { ctx, resolved } = makeApproveCtx()
    const ws = makeMockWs()
    const client = makeClient({ authenticated: true })
    await pairingHandlers.pair_approve(ws, client, { type: 'pair_approve', requestId: 'ghost' }, ctx)
    const err = ws.sent().find(m => m.type === 'error')
    assert.ok(err && /not_found/.test(err.message))
    assert.equal(resolved.length, 0)
  })
})
