import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PairingManager } from '../src/pairing.js'

// In-memory { load, save } adapter (mirrors session-token-persistence.test.js) so
// the PairingManager persists without touching disk. `_entries()` exposes the last
// saved snapshot.
function makeMemStore(initial = []) {
  let saved = initial.slice()
  return { load: () => saved.slice(), save: (e) => { saved = e.slice() }, _entries: () => saved }
}

// Mint N linking-mode session tokens on a fresh PairingManager and return the raw
// token strings (validatePairing auto-refreshes _current, so each call consumes a
// fresh linking id).
function mintTokens(pm, n) {
  const tokens = []
  for (let i = 0; i < n; i++) {
    const { valid, sessionToken } = pm.validatePairing(pm.currentPairingId)
    assert.ok(valid, `mint ${i} should succeed`)
    tokens.push(sessionToken)
  }
  return tokens
}

describe('#6678 PairingManager.listSessionTokens', () => {
  it('returns a wire-safe view per live token, never the token itself', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    const [t1, t2] = mintTokens(pm, 2)
    const devices = pm.listSessionTokens()
    assert.equal(devices.length, 2)
    for (const d of devices) {
      assert.equal(typeof d.id, 'string')
      assert.ok(d.id.length > 0)
      assert.equal(typeof d.createdAt, 'number')
      assert.ok(d.ageMs >= 0)
      assert.equal(d.deviceName, null, 'no device label captured yet (follow-up)')
      // The wire id must NOT be the raw token or a prefix of it.
      assert.notEqual(d.id, t1)
      assert.notEqual(d.id, t2)
      assert.ok(!t1.startsWith(d.id) && !t2.startsWith(d.id), 'id discloses no token bytes')
    }
    pm.destroy()
  })

  it('surfaces the bound sessionId (null for unbound/full-access tokens)', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    // Bound share-a-session token.
    const { pairingId } = pm.generateBoundPairing('sess-abc')
    const bound = pm.validatePairing(pairingId)
    assert.ok(bound.valid)
    // Unbound linking-mode token.
    pm.validatePairing(pm.currentPairingId)

    const devices = pm.listSessionTokens()
    assert.equal(devices.length, 2)
    const boundEntry = devices.find((d) => d.sessionId === 'sess-abc')
    const unboundEntry = devices.find((d) => d.sessionId === null)
    assert.ok(boundEntry, 'the bound token reports its sessionId')
    assert.ok(unboundEntry, 'the linking-mode token reports sessionId=null')
    pm.destroy()
  })

  it('id is deterministic across calls (a list → revoke round-trip resolves)', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    mintTokens(pm, 1)
    const a = pm.listSessionTokens()[0].id
    const b = pm.listSessionTokens()[0].id
    assert.equal(a, b)
    pm.destroy()
  })
})

describe('#6678 PairingManager.revokeSessionTokenById (live)', () => {
  it('revokes a single device live: its token stops authenticating, others survive', () => {
    const store = makeMemStore()
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const [t1, t2] = mintTokens(pm, 2)
    assert.ok(pm.isSessionTokenValid(t1) && pm.isSessionTokenValid(t2))

    const target = pm.listSessionTokens().find((d) => d.id === pm._deviceIdForToken(t1))
    const removed = pm.revokeSessionTokenById(target.id)
    assert.equal(removed, 1)

    assert.equal(pm.isSessionTokenValid(t1), false, 'revoked token no longer authenticates (next connect fails)')
    assert.equal(pm.isSessionTokenValid(t2), true, 'the sibling token is untouched')
    assert.equal(store._entries().length, 1, 'the revoke persisted (survives a restart)')
    pm.destroy()
  })

  it('is idempotent / safe: an unknown id revokes nothing (0)', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    mintTokens(pm, 1)
    assert.equal(pm.revokeSessionTokenById('deadbeefdeadbeef'), 0)
    assert.equal(pm.revokeSessionTokenById(''), 0)
    assert.equal(pm.revokeSessionTokenById(undefined), 0)
    assert.equal(pm.listSessionTokens().length, 1, 'the live token is preserved')
    pm.destroy()
  })

  it('a persisted-then-revoked token does not resurrect across a restart', () => {
    const store = makeMemStore()
    const pm1 = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const [t1] = mintTokens(pm1, 1)
    pm1.revokeSessionTokenById(pm1._deviceIdForToken(t1))
    pm1.destroy()

    const pm2 = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    assert.equal(pm2.isSessionTokenValid(t1), false, 'revoked token stays revoked after a restart')
    pm2.destroy()
  })
})

describe('#6678 PairingManager.revokeAllSessionTokens (panic button)', () => {
  it('revokes every device live and persists an empty store', () => {
    const store = makeMemStore()
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const tokens = mintTokens(pm, 3)
    assert.equal(pm.revokeAllSessionTokens(), 3)
    for (const t of tokens) {
      assert.equal(pm.isSessionTokenValid(t), false)
    }
    assert.equal(pm.listSessionTokens().length, 0)
    assert.deepEqual(store._entries(), [], 'the store was persisted empty')
    pm.destroy()
  })

  it('returns 0 when there is nothing to revoke', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    assert.equal(pm.revokeAllSessionTokens(), 0)
    pm.destroy()
  })
})
