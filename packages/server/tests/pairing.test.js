import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
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
    it('extends current pairing ID expiry past original TTL', async () => {
      const pm = new PairingManager({ ttlMs: 50 })
      const id = pm.currentPairingId
      // Extend to 5s — well beyond the original 50ms TTL
      pm.extendCurrentId(5000)

      // Wait past the original TTL — without extension this would expire
      await delay(100)

      // The ID should still be valid because we extended it
      const result = pm.validatePairing(id)
      assert.equal(result.valid, true, 'extended ID should survive past original TTL')
      pm.destroy()
    })

    it('extended ID still expires after grace period', async () => {
      const pm = new PairingManager({ ttlMs: 1 })
      const id = pm.currentPairingId
      pm.extendCurrentId(5) // 5ms grace (clamped won't exceed this since TTL is 1ms)
      await delay(30)
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

    it('updates the _activePairings entry expiry', async () => {
      const pm = new PairingManager({ ttlMs: 50 })
      const id = pm.currentPairingId
      pm.extendCurrentId(5000)

      // Wait past the original TTL — the _activePairings entry must have
      // the extended expiry for this validation to succeed
      await delay(100)

      const result = pm.validatePairing(id)
      assert.equal(result.valid, true, 'map entry should have extended expiry')
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

  describe('session token binding (#2693)', () => {
    it('validatePairing stores session binding when sessionId is provided', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const result = pm.validatePairing(id, 'session-abc')
      assert.equal(result.valid, true)
      assert.ok(result.sessionToken)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), 'session-abc')
      pm.destroy()
    })

    it('validatePairing without sessionId stores null binding', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      const result = pm.validatePairing(id)
      assert.equal(result.valid, true)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), null)
      pm.destroy()
    })

    it('getSessionIdForToken returns null for unknown token', () => {
      const pm = new PairingManager({})
      assert.equal(pm.getSessionIdForToken('not-a-real-token'), null)
      pm.destroy()
    })

    it('getSessionIdForToken returns null for null/undefined input', () => {
      const pm = new PairingManager({})
      assert.equal(pm.getSessionIdForToken(null), null)
      assert.equal(pm.getSessionIdForToken(undefined), null)
      assert.equal(pm.getSessionIdForToken(''), null)
      pm.destroy()
    })

    it('getSessionIdForToken returns null after token TTL expires', async () => {
      const pm = new PairingManager({ sessionTokenTtlMs: 5 })
      const id = pm.currentPairingId
      const result = pm.validatePairing(id, 'session-xyz')
      assert.equal(result.valid, true)
      // Wait for expiry
      await delay(20)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), null)
      pm.destroy()
    })

    it('different pairings can bind to different sessions', () => {
      const pm = new PairingManager({ ttlMs: 60_000 })
      const id1 = pm.currentPairingId
      pm.refresh()
      const id2 = pm.currentPairingId

      const r1 = pm.validatePairing(id1, 'session-1')
      const r2 = pm.validatePairing(id2, 'session-2')

      assert.equal(pm.getSessionIdForToken(r1.sessionToken), 'session-1')
      assert.equal(pm.getSessionIdForToken(r2.sessionToken), 'session-2')
      pm.destroy()
    })
  })

  // #5555: at the session-token cap the pre-fix code evicted the OLDEST
  // still-valid token (Map insertion order) — silently logging out the
  // longest-paired device — even when expired tokens sat in the map ready to
  // be reaped. Now we sweep expired tokens before evicting any valid one, plus
  // run a periodic TTL sweep so tokens don't linger to the cap untouched.
  describe('session token eviction — sweep before evict (#5555)', () => {
    it('sweeps expired tokens instead of evicting a valid one at the cap', async () => {
      const pm = new PairingManager({ sessionTokenTtlMs: 30 })
      // The oldest 5 tokens we insert NOW; they will expire after the TTL.
      const now = Date.now()
      for (let i = 0; i < 5; i++) {
        pm._sessionTokens.set(`old-${i}`, { createdAt: now, sessionId: `old-sess-${i}` })
      }
      // Let those 5 expire.
      await delay(50)
      // Top up to exactly the cap with FRESH (valid) tokens (indices 5..99).
      const fresh = Date.now()
      for (let i = pm._sessionTokens.size; i < 100; i++) {
        pm._sessionTokens.set(`fresh-${i}`, { createdAt: fresh, sessionId: `fresh-sess-${i}` })
      }
      assert.equal(pm._sessionTokens.size, 100, 'at cap before next issuance')
      // Issue one more — must sweep the 5 expired, NOT evict a valid token.
      pm._storeSessionToken('brand-new', { createdAt: Date.now(), sessionId: 'new-sess' })
      // The 5 expired are gone; every fresh token survived; new one stored.
      for (let i = 0; i < 5; i++) {
        assert.equal(pm._sessionTokens.has(`old-${i}`), false, `expired old-${i} swept`)
      }
      assert.equal(pm._sessionTokens.has('brand-new'), true, 'new token stored')
      // The longest-paired VALID token must still be present (not evicted).
      assert.equal(pm._sessionTokens.has('fresh-5'), true, 'longest-paired valid token survives')
      pm.destroy()
    })

    it('evicts the oldest valid token only when still at cap after sweeping', () => {
      // No expired tokens to reclaim → must fall back to evicting the oldest.
      const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
      pm._sessionTokens.clear()
      const now = Date.now()
      for (let i = 0; i < 100; i++) {
        pm._sessionTokens.set(`v-${i}`, { createdAt: now, sessionId: `s-${i}` })
      }
      assert.equal(pm._sessionTokens.size, 100)
      pm._storeSessionToken('overflow', { createdAt: Date.now(), sessionId: 's-new' })
      assert.equal(pm._sessionTokens.size, 100, 'stays at cap')
      assert.equal(pm._sessionTokens.has('v-0'), false, 'oldest valid evicted as last resort')
      assert.equal(pm._sessionTokens.has('overflow'), true)
      pm.destroy()
    })

    it('_sweepSessionTokens removes only expired tokens', async () => {
      const pm = new PairingManager({ sessionTokenTtlMs: 30 })
      pm._sessionTokens.clear()
      pm._sessionTokens.set('expired', { createdAt: Date.now(), sessionId: null })
      await delay(50)
      pm._sessionTokens.set('alive', { createdAt: Date.now(), sessionId: null })
      const removed = pm._sweepSessionTokens()
      assert.equal(removed, 1)
      assert.equal(pm._sessionTokens.has('expired'), false)
      assert.equal(pm._sessionTokens.has('alive'), true)
      pm.destroy()
    })

    it('arms a periodic sweep timer on issuance and clears it on destroy (no leak)', () => {
      const pm = new PairingManager({})
      assert.equal(pm._sessionTokenSweepTimer, null, 'no timer before any token issued')
      pm._storeSessionToken('t', { createdAt: Date.now(), sessionId: null })
      assert.notEqual(pm._sessionTokenSweepTimer, null, 'sweep timer armed on first issuance')
      pm.destroy()
      assert.equal(pm._sessionTokenSweepTimer, null, 'sweep timer cleared on destroy')
    })

    it('periodic sweep stops itself once the token map drains', async () => {
      const pm = new PairingManager({ sessionTokenTtlMs: 30 })
      pm._storeSessionToken('solo', { createdAt: Date.now(), sessionId: null })
      assert.notEqual(pm._sessionTokenSweepTimer, null)
      // Manually drain via the sweep after expiry; the helper should null the timer.
      await delay(50)
      pm._sweepSessionTokens()
      assert.equal(pm._sessionTokens.size, 0)
      assert.equal(pm._sessionTokenSweepTimer, null, 'timer stops when map empties')
      pm.destroy()
    })
  })

  describe('auto-regen on consumption (#2916)', () => {
    it('emits pairing_refreshed after a pairing ID is consumed', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      let emitted = null
      pm.on('pairing_refreshed', (event) => { emitted = event })
      pm.validatePairing(id)
      assert.ok(emitted, 'should emit pairing_refreshed after consumption')
      assert.ok(emitted.pairingId, 'event should contain new pairing ID')
      assert.notEqual(emitted.pairingId, id, 'new ID should differ from consumed one')
      pm.destroy()
    })

    it('new pairing ID is valid after consumption regeneration', () => {
      const pm = new PairingManager({})
      const oldId = pm.currentPairingId
      pm.validatePairing(oldId)
      const newId = pm.currentPairingId
      assert.notEqual(newId, oldId, 'pairing ID should change after consumption')
      const result = pm.validatePairing(newId)
      assert.equal(result.valid, true, 'new ID should be valid')
      assert.ok(result.sessionToken)
      pm.destroy()
    })

    it('does NOT regen when validation fails (already_used, expired, invalid)', () => {
      const pm = new PairingManager({})
      const id = pm.currentPairingId
      // Consume successfully — this WILL regen
      pm.validatePairing(id)
      const idAfterFirstConsume = pm.currentPairingId
      let extraEmit = 0
      pm.on('pairing_refreshed', () => { extraEmit++ })
      // Failing attempts should not trigger another regen
      pm.validatePairing(id) // already_used
      pm.validatePairing('bogus') // invalid
      assert.equal(extraEmit, 0, 'failed validations must not trigger pairing_refreshed')
      assert.equal(pm.currentPairingId, idAfterFirstConsume, 'ID should remain stable on failures')
      pm.destroy()
    })
  })

  describe('autoRefresh timer reset on validatePairing (#3020)', () => {
    beforeEach(() => {
      mock.timers.reset()
    })

    afterEach(() => {
      // Defensive reset: if an assertion fails mid-test after mock.timers were
      // enabled, ensure subsequent tests/suites see real timers (otherwise
      // mocked timers leak across the file and cause hard-to-debug failures).
      mock.timers.reset()
    })

    it('resets the autoRefresh timer after consumption-triggered regen', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      const ttlMs = 60_000
      const pm = new PairingManager({ ttlMs, autoRefresh: true })

      // Refresh fires at max(ttlMs - 5000, ttlMs * 0.9) = 55_000ms
      const refreshDelay = Math.max(ttlMs - 5000, ttlMs * 0.9)

      const refreshedEvents = []
      pm.on('pairing_refreshed', (e) => { refreshedEvents.push(e.pairingId) })

      const originalId = pm.currentPairingId

      // Advance partway through the refresh window, then consume the pairing.
      mock.timers.tick(50_000)
      const result = pm.validatePairing(originalId)
      assert.equal(result.valid, true)
      assert.equal(refreshedEvents.length, 1, 'consumption should emit exactly one pairing_refreshed')
      const idAfterConsume = pm.currentPairingId
      assert.notEqual(idAfterConsume, originalId)

      // The OLD timer would have fired 5_000ms later (50_000 + 5_000 = 55_000
      // since manager creation). If the timer wasn't reset, it would emit a
      // second pairing_refreshed here.
      mock.timers.tick(5_000)
      assert.equal(refreshedEvents.length, 1, 'old timer must not fire after reset')
      assert.equal(pm.currentPairingId, idAfterConsume, 'ID should not have rotated yet')

      // The NEW timer should fire ~refreshDelay after the consumption regen.
      // We've already ticked 5_000ms post-consume, so advance the rest.
      mock.timers.tick(refreshDelay - 5_000 + 1)
      assert.equal(refreshedEvents.length, 2, 'new timer should fire on its own schedule')
      assert.notEqual(pm.currentPairingId, idAfterConsume, 'ID should rotate on new timer')

      pm.destroy()
    })

    it('does not crash when validatePairing runs without an active timer', () => {
      // autoRefresh: false → no _refreshTimer; the reset branch must be a no-op
      const pm = new PairingManager({ autoRefresh: false })
      const id = pm.currentPairingId
      const result = pm.validatePairing(id)
      assert.equal(result.valid, true)
      pm.destroy()
    })
  })

  // ---------------------------------------------------------------------------
  // Per-session "Share this session" pairings (#3070)
  // ---------------------------------------------------------------------------
  describe('generateBoundPairing (#3070)', () => {
    it('creates a fresh pairing entry that does not replace _current', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const linkingId = pm.currentPairingId
      const { pairingId, pairingUrl } = pm.generateBoundPairing('sess-A')
      assert.ok(pairingId)
      assert.notEqual(pairingId, linkingId, 'bound pairing must have its own id')
      assert.equal(pm.currentPairingId, linkingId, '_current (linking) must not change')
      assert.ok(pairingUrl.startsWith('chroxy://example.com?pair='))
      pm.destroy()
    })

    it('issues a session-bound token when validatePairing consumes the bound id', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const { pairingId } = pm.generateBoundPairing('sess-A')
      const result = pm.validatePairing(pairingId)
      assert.equal(result.valid, true)
      assert.ok(result.sessionToken)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), 'sess-A')
      pm.destroy()
    })

    it('the entry-level binding overrides any sessionId param at consume time', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const { pairingId } = pm.generateBoundPairing('sess-bound')
      // The handlePairMessage path passes a sessionId from the auth-context
      // shim — it's null in linking mode but could be non-null. The bound
      // entry must win.
      const result = pm.validatePairing(pairingId, 'sess-from-param')
      assert.equal(result.valid, true)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), 'sess-bound')
      pm.destroy()
    })

    it('linking-mode pairings still honor the param-based binding (back-compat)', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const linkingId = pm.currentPairingId
      const result = pm.validatePairing(linkingId, 'sess-from-param')
      assert.equal(result.valid, true)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), 'sess-from-param')
      pm.destroy()
    })

    it('linking-mode pairings issue an unbound token when no sessionId is passed', () => {
      const pm = new PairingManager({})
      const linkingId = pm.currentPairingId
      const result = pm.validatePairing(linkingId)
      assert.equal(result.valid, true)
      assert.equal(pm.getSessionIdForToken(result.sessionToken), null)
      pm.destroy()
    })

    it('consuming a bound pairing does NOT rotate the linking-mode _current id', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const linkingId = pm.currentPairingId
      const { pairingId } = pm.generateBoundPairing('sess-A')
      pm.validatePairing(pairingId)
      assert.equal(pm.currentPairingId, linkingId, 'linking ID must not rotate after bound consume')
      pm.destroy()
    })

    it('a consumed bound pairing cannot be reused (one-time)', () => {
      const pm = new PairingManager({ wsUrl: 'wss://example.com' })
      const { pairingId } = pm.generateBoundPairing('sess-A')
      const first = pm.validatePairing(pairingId)
      const second = pm.validatePairing(pairingId)
      assert.equal(first.valid, true)
      assert.equal(second.valid, false)
      assert.equal(second.reason, 'already_used')
      pm.destroy()
    })

    it('rejects empty / non-string sessionId', () => {
      const pm = new PairingManager({})
      assert.throws(() => pm.generateBoundPairing(''), /non-empty sessionId/)
      assert.throws(() => pm.generateBoundPairing(null), /non-empty sessionId/)
      assert.throws(() => pm.generateBoundPairing(undefined), /non-empty sessionId/)
      assert.throws(() => pm.generateBoundPairing(42), /non-empty sessionId/)
      pm.destroy()
    })

    it('throws after destroy', () => {
      const pm = new PairingManager({})
      pm.destroy()
      assert.throws(() => pm.generateBoundPairing('sess-A'), /destroyed/)
    })
  })
})
