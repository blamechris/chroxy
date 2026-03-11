import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

describe('PairingManager (#1836)', () => {
  let PairingManager

  before(async () => {
    const mod = await import('../src/pairing.js')
    PairingManager = mod.PairingManager
  })

  it('exports PairingManager class', () => {
    assert.equal(typeof PairingManager, 'function')
  })

  describe('pairing ID generation', () => {
    it('generates a pairing ID on creation', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      assert.ok(id, 'should have a pairing ID')
      assert.ok(typeof id === 'string')
      assert.ok(id.length >= 8, 'pairing ID should be at least 8 chars')
      pm.destroy()
    })

    it('regenerates pairing ID via refresh()', () => {
      const pm = new PairingManager({})
      const first = pm.currentPairingId
      pm.refresh()
      const second = pm.currentPairingId
      assert.notEqual(first, second, 'refresh should produce a new ID')
      pm.destroy()
    })

    it('currentPairingUrl returns chroxy:// URL with pair= param', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const url = pm.currentPairingUrl
      assert.ok(url.startsWith('chroxy://example.com?pair='))
      assert.ok(!url.includes('token='), 'URL must not contain the API token')
      pm.destroy()
    })
  })

  describe('pairing validation', () => {
    it('validates a current pairing ID', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const result = pm.validatePairing(id)
      assert.equal(result.valid, true)
      assert.ok(result.sessionToken, 'should return a session token')
      pm.destroy()
    })

    it('rejects an unknown pairing ID', () => {
      const pm = new PairingManager({})
      const result = pm.validatePairing('bogus-id-12345')
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'invalid_pairing_id')
      pm.destroy()
    })

    it('rejects a pairing ID after it has been used (one-time use)', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const first = pm.validatePairing(id)
      assert.equal(first.valid, true)
      const second = pm.validatePairing(id)
      assert.equal(second.valid, false)
      assert.equal(second.reason, 'already_used')
      pm.destroy()
    })

    it('rejects an expired pairing ID', async () => {
      const pm = new PairingManager({ ttlMs: 1 })
      const id = pm.currentPairingId
      // Wait for expiry
      await delay(10)
      const result = pm.validatePairing(id)
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'expired')
      pm.destroy()
    })

    it('session token from validation is accepted by isTokenValid', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const result = pm.validatePairing(id)
      assert.equal(pm.isSessionTokenValid(result.sessionToken), true)
      pm.destroy()
    })
  })

  describe('refresh boundary behavior (#1892)', () => {
    it('old pairing ID is invalid after refresh (no grace period)', () => {
      const pm = new PairingManager({})
      const oldId = pm.currentPairingId
      pm.refresh()
      const result = pm.validatePairing(oldId)
      assert.equal(result.valid, false, 'old pairing ID should be rejected after refresh')
      assert.equal(result.reason, 'invalid_pairing_id')
      pm.destroy()
    })

    it('new pairing ID is valid after refresh', () => {
      const pm = new PairingManager({})
      pm.refresh()
      const newId = pm.currentPairingId
      const result = pm.validatePairing(newId)
      assert.equal(result.valid, true)
      assert.ok(result.sessionToken)
      pm.destroy()
    })

    it('session tokens from before refresh remain valid', () => {
      const pm = new PairingManager({})
      const id1 = pm.currentPairingId
      const result1 = pm.validatePairing(id1)
      assert.equal(result1.valid, true)

      pm.refresh()
      // Old session token should still work for reconnection
      assert.equal(pm.isSessionTokenValid(result1.sessionToken), true)
      pm.destroy()
    })

    it('multiple refreshes invalidate all previous IDs', () => {
      const pm = new PairingManager({})
      const ids = [pm.currentPairingId]
      for (let i = 0; i < 3; i++) {
        pm.refresh()
        ids.push(pm.currentPairingId)
      }
      // All old IDs should be invalid
      for (let i = 0; i < ids.length - 1; i++) {
        const result = pm.validatePairing(ids[i])
        assert.equal(result.valid, false, `ID from refresh ${i} should be invalid`)
      }
      // Current ID should be valid
      const current = pm.validatePairing(ids[ids.length - 1])
      assert.equal(current.valid, true)
      pm.destroy()
    })
  })

  describe('auto-refresh', () => {
    it('refresh() emits pairing_refreshed event', () => {
      const pm = new PairingManager({})
      const firstId = pm.currentPairingId
      let emitted = null
      pm.on('pairing_refreshed', (event) => { emitted = event })
      pm.refresh()
      assert.ok(emitted, 'should have emitted pairing_refreshed')
      assert.ok(emitted.pairingId, 'event should contain new pairing ID')
      assert.notEqual(emitted.pairingId, firstId)
      pm.destroy()
    })
  })

  describe('cleanup', () => {
    it('destroy() stops auto-refresh and clears state', () => {
      const pm = new PairingManager({ autoRefresh: true })
      pm.destroy()
      assert.equal(pm.currentPairingId, null)
    })
  })
})
