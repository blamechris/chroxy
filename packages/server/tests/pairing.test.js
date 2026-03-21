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

  describe('grace period for refreshed IDs (#1895)', () => {
    it('old pairing ID is still valid within TTL after refresh', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      const oldId = pm.currentPairingId
      pm.refresh()
      const result = pm.validatePairing(oldId)
      assert.equal(result.valid, true, 'old ID should be valid within TTL')
      assert.ok(result.sessionToken)
      pm.destroy()
    })

    it('old pairing ID is rejected after TTL expires', async () => {
      const pm = new PairingManager({ ttlMs: 1 })
      const oldId = pm.currentPairingId
      pm.refresh()
      await delay(10)
      const result = pm.validatePairing(oldId)
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'expired')
      pm.destroy()
    })

    it('old pairing ID is one-time use even during grace period', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      const oldId = pm.currentPairingId
      pm.refresh()
      const first = pm.validatePairing(oldId)
      assert.equal(first.valid, true)
      const second = pm.validatePairing(oldId)
      assert.equal(second.valid, false)
      assert.equal(second.reason, 'already_used')
      pm.destroy()
    })

    it('multiple old IDs can be valid simultaneously', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      const id1 = pm.currentPairingId
      pm.refresh()
      const id2 = pm.currentPairingId
      pm.refresh()
      const id3 = pm.currentPairingId

      // All three should be valid
      const r3 = pm.validatePairing(id3)
      assert.equal(r3.valid, true, 'current should be valid')
      const r1 = pm.validatePairing(id1)
      assert.equal(r1.valid, true, 'oldest should still be valid within TTL')
      const r2 = pm.validatePairing(id2)
      assert.equal(r2.valid, true, 'middle should still be valid within TTL')
      pm.destroy()
    })

    it('expired entries are pruned on refresh', async () => {
      const pm = new PairingManager({ ttlMs: 1 })
      const oldId = pm.currentPairingId
      await delay(10)
      pm.refresh()
      // Old entry should have been pruned (must return invalid_pairing_id, not expired)
      const result = pm.validatePairing(oldId)
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'invalid_pairing_id')
      pm.destroy()
    })
  })

  describe('capacity limits (#1907)', () => {
    it('evicts oldest entry when MAX_ACTIVE_PAIRINGS cap is reached', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      const firstId = pm.currentPairingId

      // Refresh 10 times → 11 total IDs, but cap is 10
      for (let i = 0; i < 10; i++) pm.refresh()

      // First ID should have been evicted
      const result = pm.validatePairing(firstId)
      assert.equal(result.valid, false)
      assert.equal(result.reason, 'invalid_pairing_id')

      // Current (newest) should still be valid
      const current = pm.validatePairing(pm.currentPairingId)
      assert.equal(current.valid, true)
      pm.destroy()
    })

    it('second-oldest ID survives when only one is evicted', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      pm.refresh() // after this, the constructor ID is oldest; secondId is second-oldest
      const secondId = pm.currentPairingId

      // 9 more refreshes → 11 total, evicts only the very first
      for (let i = 0; i < 9; i++) pm.refresh()

      // secondId should still be valid (it was second, only first evicted)
      const result = pm.validatePairing(secondId)
      assert.equal(result.valid, true)
      pm.destroy()
    })
  })

  describe('extendCurrentId grace period (#2599)', () => {
    it('extends current pairing ID expiry', () => {
      const pm = new PairingManager({ ttlMs: 100 })
      const id = pm.currentPairingId
      // Extend to 60s — well beyond the original 100ms TTL
      pm.extendCurrentId(60_000)

      // The ID should still be valid (original 100ms TTL would have been too short)
      const result = pm.validatePairing(id)
      assert.equal(result.valid, true, 'extended ID should be valid')
      pm.destroy()
    })

    it('extended ID still expires after grace period', async () => {
      const pm = new PairingManager({ ttlMs: 100 })
      const id = pm.currentPairingId
      pm.extendCurrentId(1) // 1ms grace
      await delay(10)
      const result = pm.validatePairing(id)
      assert.equal(result.valid, false, 'should expire after grace period')
      assert.equal(result.reason, 'expired')
      pm.destroy()
    })

    it('delays auto-refresh timer during grace period', async () => {
      const pm = new PairingManager({ ttlMs: 10, autoRefresh: true })
      const id = pm.currentPairingId
      // Extend to 5s — auto-refresh should not fire during this time
      pm.extendCurrentId(5000)
      // Wait longer than original ttlMs (10ms) but less than grace period
      await delay(50)
      // The current ID should NOT have changed (auto-refresh was delayed)
      assert.equal(pm.currentPairingId, id, 'should not rotate during grace period')
      pm.destroy()
    })

    it('no-ops when destroyed', () => {
      const pm = new PairingManager({})
      pm.destroy()
      // Should not throw
      pm.extendCurrentId(60_000)
      assert.equal(pm.currentPairingId, null)
    })

    it('updates the _activePairings entry expiry', () => {
      const pm = new PairingManager({ ttlMs: 100 })
      const id = pm.currentPairingId
      pm.extendCurrentId(60_000)
      // Validate the entry is accessible and has the extended expiry
      const result = pm.validatePairing(id)
      assert.equal(result.valid, true)
      assert.ok(result.sessionToken)
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
