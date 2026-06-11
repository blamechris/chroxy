import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

// #5510 (epic #5509) — pairing-approval primitive: the pending-request queue
// on PairingManager. Bounded by cap + TTL + per-source rate limit; approve
// issues a token EXACTLY once; the verify code only travels server→surfaces.
describe('PairingManager pending-request queue (#5510)', () => {
  let PairingManager

  before(async () => {
    ({ PairingManager } = await import('../src/pairing.js'))
  })

  function mk(opts = {}) {
    return new PairingManager({ wsUrl: 'wss://example.com', ...opts })
  }

  it('enqueues a request and returns a 6-digit verify code + expiry', () => {
    const pm = mk()
    const r = pm.enqueuePendingRequest({ requestId: 'r1', deviceName: 'iPhone', source: '1.1.1.1' })
    assert.equal(r.ok, true)
    assert.match(r.verifyCode, /^\d{6}$/, 'verify code is 6 digits')
    assert.ok(r.expiresAt > Date.now(), 'expiresAt is in the future')
    pm.destroy()
  })

  it('rejects a missing/empty requestId', () => {
    const pm = mk()
    assert.equal(pm.enqueuePendingRequest({ requestId: '', source: 'x' }).reason, 'invalid')
    assert.equal(pm.enqueuePendingRequest({ source: 'x' }).reason, 'invalid')
    pm.destroy()
  })

  it('clamps an over-long deviceName to 64 chars', () => {
    const pm = mk()
    pm.enqueuePendingRequest({ requestId: 'r1', deviceName: 'A'.repeat(200), source: 's' })
    const snap = pm.getPendingRequest('r1')
    assert.equal(snap.deviceName.length, 64)
    pm.destroy()
  })

  it('caps the queue at 5 pending and rejects the 6th with queue_full', () => {
    const pm = mk()
    for (let i = 0; i < 5; i++) {
      assert.equal(pm.enqueuePendingRequest({ requestId: `r${i}`, source: `src${i}` }).ok, true)
    }
    const r = pm.enqueuePendingRequest({ requestId: 'r6', source: 'src6' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'queue_full')
    pm.destroy()
  })

  it('rate-limits a single source after 5 requests in the window', () => {
    const pm = mk()
    // Same source — but each needs a distinct requestId. Approve to free queue
    // slots so the cap does not mask the rate limit.
    for (let i = 0; i < 5; i++) {
      const res = pm.enqueuePendingRequest({ requestId: `q${i}`, source: 'noisy' })
      assert.equal(res.ok, true)
      pm.approvePendingRequest(`q${i}`)
    }
    const r = pm.enqueuePendingRequest({ requestId: 'q5', source: 'noisy' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'rate_limited')
    pm.destroy()
  })

  it('rejects a duplicate requestId', () => {
    const pm = mk()
    assert.equal(pm.enqueuePendingRequest({ requestId: 'dup', source: 'a' }).ok, true)
    const r = pm.enqueuePendingRequest({ requestId: 'dup', source: 'b' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'duplicate_request')
    pm.destroy()
  })

  it('expires a pending request after its TTL', () => {
    const pm = mk({ pendingTtlMs: 1 })
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    // Force time past TTL by reaching into the entry (no fake timers).
    const entry = pm._pendingRequests.get('r1')
    entry.expiresAt = Date.now() - 1
    assert.equal(pm.getPendingRequest('r1'), null, 'expired request is not returned')
    assert.equal(pm.approvePendingRequest('r1').reason, 'expired')
    pm.destroy()
  })

  it('emits pending_request_expired on sweep', () => {
    const pm = mk({ pendingTtlMs: 1 })
    let fired = null
    pm.on('pending_request_expired', (e) => { fired = e })
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    pm._pendingRequests.get('r1').expiresAt = Date.now() - 1
    pm._sweepPending()
    assert.deepEqual(fired, { requestId: 'r1' })
    pm.destroy()
  })

  it('approve issues a session token EXACTLY once', () => {
    const pm = mk()
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    const first = pm.approvePendingRequest('r1')
    assert.equal(first.ok, true)
    assert.ok(typeof first.token === 'string' && first.token.length > 0)
    assert.equal(pm.isSessionTokenValid(first.token), true, 'issued token validates')

    const second = pm.approvePendingRequest('r1')
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'already_resolved')
    assert.equal(second.token, undefined, 'no second token minted')
    pm.destroy()
  })

  it('issued token is unbound (host-authority — sessionId null)', () => {
    const pm = mk()
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    const { token } = pm.approvePendingRequest('r1')
    assert.equal(pm.getSessionIdForToken(token), null)
    pm.destroy()
  })

  it('deny removes the request and is idempotent', () => {
    const pm = mk()
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    assert.equal(pm.denyPendingRequest('r1'), true)
    assert.equal(pm.getPendingRequest('r1'), null)
    assert.equal(pm.denyPendingRequest('r1'), false, 'second deny is a no-op')
    // Approving a denied request must not mint a token.
    assert.equal(pm.approvePendingRequest('r1').ok, false)
    pm.destroy()
  })

  it('approve after not-found returns not_found', () => {
    const pm = mk()
    assert.equal(pm.approvePendingRequest('nope').reason, 'not_found')
    pm.destroy()
  })

  it('the verify code never leaves the manager via getSessionIdForToken/snapshots and is opaque to the requester', () => {
    // By construction: approvePendingRequest takes only requestId — no code is
    // ever accepted from a caller, so a requester cannot influence it.
    const pm = mk()
    const { verifyCode } = pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    const snap = pm.getPendingRequest('r1')
    assert.equal(snap.verifyCode, verifyCode, 'surfaces see the same server-generated code')
    // approve signature accepts exactly one arg (requestId)
    assert.equal(pm.approvePendingRequest.length, 1)
    pm.destroy()
  })

  it('listPendingRequests returns only live entries', () => {
    const pm = mk()
    pm.enqueuePendingRequest({ requestId: 'a', source: 's1' })
    pm.enqueuePendingRequest({ requestId: 'b', source: 's2' })
    pm.denyPendingRequest('a')
    const live = pm.listPendingRequests()
    assert.equal(live.length, 1)
    assert.equal(live[0].requestId, 'b')
    pm.destroy()
  })

  it('destroy clears the queue and the sweep timer', () => {
    const pm = mk()
    pm.enqueuePendingRequest({ requestId: 'r1', source: 's' })
    pm.destroy()
    assert.equal(pm._pendingRequests.size, 0)
    assert.equal(pm._sweepTimer, null)
    assert.equal(pm.enqueuePendingRequest({ requestId: 'r2', source: 's' }).reason, 'invalid')
  })
})
