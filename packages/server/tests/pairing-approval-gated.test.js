import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

// -- Approval-gated pairing ids (#5513, epic #5509) --
//
// A Discord-delivered pairing link carries a FLAGGED id: redeeming it via the
// normal `pair` path must NOT mint a token (that is QR trust). Instead the id is
// distinguishable so the redemption routes into the #5510 approval primitive —
// host approval is still required. Possession of the channel grants nothing.
describe('PairingManager — approval-gated ids (#5513)', () => {
  let PairingManager

  before(async () => {
    const mod = await import('../src/pairing.js')
    PairingManager = mod.PairingManager
  })

  it('createApprovalGatedPairingId returns a fresh id + chroxy:// url', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const out = pm.createApprovalGatedPairingId()
    assert.ok(out.pairingId, 'returns a pairing id')
    assert.ok(typeof out.pairingId === 'string')
    assert.ok(out.pairingId.length >= 8)
    assert.ok(out.pairingUrl.startsWith('chroxy://example.com?pair='))
    assert.ok(out.pairingUrl.includes(out.pairingId))
    assert.ok(Number.isFinite(out.expiresAt))
    assert.ok(!out.pairingUrl.includes('token='), 'url carries no token material')
    pm.destroy()
  })

  it('a gated id is distinct from the linking-mode current id', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const linking = pm.currentPairingId
    const { pairingId } = pm.createApprovalGatedPairingId()
    assert.notEqual(pairingId, linking, 'gated id is its own one-shot entry')
    // The linking-mode QR must keep working — generating a gated id must not
    // replace _current.
    assert.equal(pm.currentPairingId, linking)
    pm.destroy()
  })

  it('validatePairing on a gated id does NOT mint a token — returns requires_approval', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { pairingId } = pm.createApprovalGatedPairingId()
    const result = pm.validatePairing(pairingId)
    assert.equal(result.valid, false, 'gated id never validates to a token')
    assert.equal(result.reason, 'requires_approval')
    assert.equal(result.sessionToken, undefined, 'no token material leaks')
    pm.destroy()
  })

  it('a gated id is single-use — a second redemption is already_used', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { pairingId } = pm.createApprovalGatedPairingId()
    const first = pm.validatePairing(pairingId)
    assert.equal(first.reason, 'requires_approval')
    const second = pm.validatePairing(pairingId)
    assert.equal(second.valid, false)
    assert.equal(second.reason, 'already_used')
    pm.destroy()
  })

  it('a gated id expires on its TTL', async () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com', ttlMs: 1 })
    const { pairingId } = pm.createApprovalGatedPairingId()
    await delay(10)
    const result = pm.validatePairing(pairingId)
    assert.equal(result.valid, false)
    assert.equal(result.reason, 'expired')
    pm.destroy()
  })

  it('a normal (non-gated) id still mints a token', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const id = pm.currentPairingId
    const result = pm.validatePairing(id)
    assert.equal(result.valid, true)
    assert.ok(result.sessionToken)
    pm.destroy()
  })

  it('returns null url when no wsUrl is configured', () => {
    const pm = new PairingManager({})
    const out = pm.createApprovalGatedPairingId()
    assert.ok(out.pairingId)
    assert.equal(out.pairingUrl, null)
    pm.destroy()
  })

  it('throws when the manager is destroyed', () => {
    const pm = new PairingManager({})
    pm.destroy()
    assert.throws(() => pm.createApprovalGatedPairingId(), /destroyed/)
  })
})
