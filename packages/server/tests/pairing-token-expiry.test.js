import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PairingManager } from '../src/pairing.js'

describe('session token expiry (#1967)', () => {
  it('accepts valid session token within TTL', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 10_000 })
    const pairingId = pm.currentPairingId
    const { valid, sessionToken } = pm.validatePairing(pairingId)
    assert.ok(valid)
    assert.ok(pm.isSessionTokenValid(sessionToken))
    pm.destroy()
  })

  it('rejects expired session token after TTL', () => {
    // Use a very short TTL so we can test expiry
    const pm = new PairingManager({ sessionTokenTtlMs: 1 })
    const pairingId = pm.currentPairingId
    const { valid, sessionToken } = pm.validatePairing(pairingId)
    assert.ok(valid)

    // Wait for token to expire
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait 5ms */ }

    assert.ok(!pm.isSessionTokenValid(sessionToken),
      'Session token should be rejected after TTL expires')
    pm.destroy()
  })

  it('prunes expired tokens from map during validation', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 1 })
    const pairingId = pm.currentPairingId
    pm.validatePairing(pairingId)

    // Wait for expiry
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait 5ms */ }

    // Access triggers cleanup
    pm.isSessionTokenValid('nonexistent')
    assert.equal(pm._sessionTokens.size, 0,
      'Expired tokens should be pruned from map')
    pm.destroy()
  })

  it('defaults to 24-hour session token TTL', () => {
    const pm = new PairingManager()
    assert.equal(pm._sessionTokenTtlMs, 24 * 60 * 60_000)
    pm.destroy()
  })
})
