import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PairingManager } from '../src/pairing.js'

/**
 * #5536 — the daemon's pinned E2E identity public key rides every pairing URL as
 * `?idk=`, so a client that scans the QR / pastes the pairing URL captures it
 * over the trusted pairing channel. Old clients (no `idk` awareness) ignore it.
 */

const IDK = 'aGVsbG8td29ybGQtaWRlbnRpdHkta2V5LWJhc2U2NA==' // arbitrary base64

describe('PairingManager identity key (#5536)', () => {
  it('appends ?idk= to the linking-mode currentPairingUrl', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.test', identityPublicKey: IDK })
    const url = pm.currentPairingUrl
    assert.ok(url.includes(`pair=${pm.currentPairingId}`))
    assert.ok(url.includes(`idk=${encodeURIComponent(IDK)}`))
    pm.destroy()
  })

  it('exposes the identity key on currentPairingCode', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.test', identityPublicKey: IDK })
    const snap = pm.currentPairingCode
    assert.equal(snap.identityPublicKey, IDK)
    assert.ok(snap.url.includes('idk='))
    pm.destroy()
  })

  it('appends ?idk= to a session-bound share pairing URL', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.test', identityPublicKey: IDK })
    const { pairingUrl } = pm.generateBoundPairing('sess-1')
    assert.ok(pairingUrl.includes('idk='))
    pm.destroy()
  })

  it('appends ?idk= to an approval-gated pairing URL', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.test', identityPublicKey: IDK })
    const { pairingUrl } = pm.createApprovalGatedPairingId()
    assert.ok(pairingUrl.includes('idk='))
    pm.destroy()
  })

  it('omits ?idk= entirely when there is no identity key (old daemon / no-encrypt)', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.test', identityPublicKey: null })
    assert.ok(!pm.currentPairingUrl.includes('idk='))
    assert.equal(pm.currentPairingCode.identityPublicKey, null)
    assert.ok(!pm.generateBoundPairing('s').pairingUrl.includes('idk='))
    pm.destroy()
  })

  it('setIdentityPublicKey updates the key surfaced on later URLs', () => {
    const pm = new PairingManager({ wsUrl: 'wss://example.test' })
    assert.ok(!pm.currentPairingUrl.includes('idk='))
    pm.setIdentityPublicKey(IDK)
    assert.ok(pm.currentPairingUrl.includes(`idk=${encodeURIComponent(IDK)}`))
    assert.equal(pm.identityPublicKey, IDK)
    pm.destroy()
  })
})
