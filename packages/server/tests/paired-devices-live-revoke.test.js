import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PairingManager } from '../src/pairing.js'

// In-memory { load, save } adapter (mirrors session-token-persistence.test.js) so
// the PairingManager persists without touching disk. `_entries()` exposes the last
// saved snapshot.
function makeMemStore(initial = []) {
  let saved = initial.slice()
  // save() returns true on success, matching the real session-token-store adapter
  // (session-token-store.js) — revoke is fail-CLOSED and keys off that boolean.
  return { load: () => saved.slice(), save: (e) => { saved = e.slice(); return true }, _entries: () => saved }
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
    assert.deepEqual(removed, { revoked: 1 })

    assert.equal(pm.isSessionTokenValid(t1), false, 'revoked token no longer authenticates (next connect fails)')
    assert.equal(pm.isSessionTokenValid(t2), true, 'the sibling token is untouched')
    assert.equal(store._entries().length, 1, 'the revoke persisted (survives a restart)')
    pm.destroy()
  })

  it('is idempotent / safe: an unknown id revokes nothing (0)', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    mintTokens(pm, 1)
    assert.deepEqual(pm.revokeSessionTokenById('deadbeefdeadbeef'), { revoked: 0 })
    assert.deepEqual(pm.revokeSessionTokenById(''), { revoked: 0 })
    assert.deepEqual(pm.revokeSessionTokenById(undefined), { revoked: 0 })
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
    assert.deepEqual(pm.revokeAllSessionTokens(), { revoked: 3 })
    for (const t of tokens) {
      assert.equal(pm.isSessionTokenValid(t), false)
    }
    assert.equal(pm.listSessionTokens().length, 0)
    assert.deepEqual(store._entries(), [], 'the store was persisted empty')
    pm.destroy()
  })

  it('returns 0 when there is nothing to revoke', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    assert.deepEqual(pm.revokeAllSessionTokens(), { revoked: 0 })
    pm.destroy()
  })
})

// #6902 — revoke must be fail-CLOSED across a crash. The pre-fix path deleted the
// token from the in-memory map FIRST and persisted best-effort, so a crash between
// the two left the revoked token in session-tokens.json → it resurrected on the
// next start. These assert the durable write happens BEFORE the in-memory mutation
// is final, and that a failed write leaves the token valid + reports failure.
describe('#6902 revoke persist-before-delete (fail-closed across a crash)', () => {
  it('persists the removal snapshot BEFORE dropping the token from memory (single)', () => {
    // Instrument the store so it can inspect the world at the instant of the
    // durable write: the token must STILL be in memory, and the persisted
    // snapshot must ALREADY exclude it — so a crash right here leaves it revoked.
    let pm
    let rawToken
    const observed = []
    const store = {
      load: () => [],
      save: (entries) => {
        observed.push({
          tokenStillInMemory: pm._sessionTokens.has(rawToken),
          snapshotHasToken: entries.some(([t]) => t === rawToken),
        })
        return true
      },
    }
    pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    ;[rawToken] = mintTokens(pm, 1) // the mint itself persists — ignore that write
    observed.length = 0

    const res = pm.revokeSessionTokenById(pm._deviceIdForToken(rawToken))
    assert.deepEqual(res, { revoked: 1 })
    assert.equal(observed.length, 1, 'the revoke performed exactly one durable write')
    assert.equal(observed[0].tokenStillInMemory, true, 'persist ran BEFORE the in-memory delete')
    assert.equal(observed[0].snapshotHasToken, false, 'the durable snapshot already excludes the revoked token')
    assert.equal(pm._sessionTokens.has(rawToken), false, 'memory reflects the delete after the call')
    pm.destroy()
  })

  it('persists the emptied snapshot BEFORE clearing memory (revoke-all)', () => {
    let pm
    const observed = []
    const store = {
      load: () => [],
      save: (entries) => {
        observed.push({ mapSizeAtWrite: pm._sessionTokens.size, snapshotSize: entries.length })
        return true
      },
    }
    pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    mintTokens(pm, 3)
    observed.length = 0

    const res = pm.revokeAllSessionTokens()
    assert.deepEqual(res, { revoked: 3 })
    assert.equal(observed.length, 1, 'the revoke-all performed exactly one durable write')
    assert.equal(observed[0].mapSizeAtWrite, 3, 'persist ran BEFORE the in-memory clear')
    assert.equal(observed[0].snapshotSize, 0, 'the durable snapshot is already empty')
    assert.equal(pm._sessionTokens.size, 0, 'memory reflects the clear after the call')
    pm.destroy()
  })

  it('a failed durable write leaves the token valid and reports persistFailed (single)', () => {
    let saveOk = true
    const store = { load: () => [], save: () => saveOk }
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const [t1] = mintTokens(pm, 1)
    saveOk = false // the next durable write fails

    const res = pm.revokeSessionTokenById(pm._deviceIdForToken(t1))
    assert.deepEqual(res, { revoked: 0, persistFailed: true })
    assert.equal(pm.isSessionTokenValid(t1), true, 'a failed persist must NOT drop the token from memory')
    pm.destroy()
  })

  it('a store whose save() THROWS is treated as a failed persist (single)', () => {
    let boom = false
    const store = { load: () => [], save: () => { if (boom) throw new Error('disk full'); return true } }
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const [t1] = mintTokens(pm, 1)
    boom = true

    const res = pm.revokeSessionTokenById(pm._deviceIdForToken(t1))
    assert.deepEqual(res, { revoked: 0, persistFailed: true })
    assert.equal(pm.isSessionTokenValid(t1), true, 'a throwing persist must NOT drop the token from memory')
    pm.destroy()
  })

  it('a failed durable write leaves every token valid and reports persistFailed (revoke-all)', () => {
    let saveOk = true
    const store = { load: () => [], save: () => saveOk }
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const tokens = mintTokens(pm, 3)
    saveOk = false

    const res = pm.revokeAllSessionTokens()
    assert.deepEqual(res, { revoked: 0, persistFailed: true })
    for (const t of tokens) {
      assert.equal(pm.isSessionTokenValid(t), true, 'panic-button persist failure keeps every device paired')
    }
    pm.destroy()
  })

  it('with no store configured, revoke still succeeds (in-memory-only mode, no durability to lose)', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    const [t1, t2] = mintTokens(pm, 2)
    assert.deepEqual(pm.revokeSessionTokenById(pm._deviceIdForToken(t1)), { revoked: 1 })
    assert.equal(pm.isSessionTokenValid(t1), false)
    assert.equal(pm.isSessionTokenValid(t2), true)
    assert.deepEqual(pm.revokeAllSessionTokens(), { revoked: 1 })
    assert.equal(pm.isSessionTokenValid(t2), false)
    pm.destroy()
  })
})
