import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairingManager } from '../src/pairing.js'
import { createSessionTokenStore } from '../src/session-token-store.js'
import { validateConfig } from '../src/config.js'

// A keychain stub that reports "no keychain here" so the store exercises its 0600
// PLAINTEXT fallback — no real macOS keychain access (avoids modal prompts / the
// #4633 sandbox), and the round-trip is still validated.
const noKeychain = { isKeychainAvailable: () => false, getToken: () => null, setToken: () => {}, deleteToken: () => {} }

// An in-memory { load, save } adapter to drive PairingManager persistence without
// touching disk. `_entries()` exposes what was last saved.
function makeMemStore(initial = []) {
  let saved = initial.slice()
  return { load: () => saved.slice(), save: (e) => { saved = e.slice() }, _entries: () => saved }
}

describe('#6598 session-token persistence + sliding TTL', () => {
  it('a minted token survives a simulated restart (persist → a fresh PairingManager loads it)', () => {
    const store = makeMemStore()
    const pm1 = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    const { valid, sessionToken } = pm1.validatePairing(pm1.currentPairingId)
    assert.ok(valid)
    assert.equal(store._entries().length, 1, 'minting the token persisted it')
    pm1.destroy()

    // "Restart": a brand-new PairingManager backed by the same persisted store.
    const pm2 = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    assert.ok(pm2.isSessionTokenValid(sessionToken), 'the restored token is valid after a restart')
    pm2.destroy()
  })

  it('sliding expiry: a successful auth refreshes the token clock', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 10_000 })
    const { sessionToken } = pm.validatePairing(pm.currentPairingId)
    const key = [...pm._sessionTokens.keys()][0]
    // Age the token to near the edge of its window.
    const aged = Date.now() - 9_000
    pm._sessionTokens.get(key).createdAt = aged
    assert.ok(pm.isSessionTokenValid(sessionToken), 'still valid within the window')
    // The successful auth slid createdAt forward to ~now — WITHOUT sliding it would
    // have expired shortly; with it, the device stays paired as long as it connects.
    assert.ok(
      pm._sessionTokens.get(key).createdAt > aged + 8_000,
      'createdAt slid forward on the successful auth',
    )
    pm.destroy()
  })

  it('an EXPIRED persisted token is rejected (and not resurrected across restart)', () => {
    const store = makeMemStore([['stale-token', { createdAt: Date.now() - 200_000, sessionId: null }]])
    const pm = new PairingManager({ sessionTokenTtlMs: 100, sessionTokenStore: store })
    assert.ok(!pm.isSessionTokenValid('stale-token'), 'expired persisted token is rejected')
    pm.destroy()
  })

  it('arms the background sweep timer after restoring persisted tokens', () => {
    // Regression for a restore path that called a non-existent sweep method: the
    // throw was swallowed, so the timer was never armed after a restart.
    const store = makeMemStore([['live-token', { createdAt: Date.now(), sessionId: null }]])
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000, sessionTokenStore: store })
    assert.ok(pm._sessionTokenSweepTimer !== null, 'sweep timer is armed after a restore with tokens')
    pm.destroy()
  })

  it('with no store injected, behaviour is unchanged (in-memory only, no throw)', () => {
    const pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    const { valid, sessionToken } = pm.validatePairing(pm.currentPairingId)
    assert.ok(valid)
    assert.ok(pm.isSessionTokenValid(sessionToken))
    pm.destroy()
  })
})

describe('#6598 createSessionTokenStore', () => {
  it('round-trips entries (0600 plaintext fallback with no keychain)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-stst-'))
    try {
      const store = createSessionTokenStore({ dir, keychain: noKeychain })
      assert.deepEqual(store.load(), [], 'a missing store loads empty')

      const entries = [
        ['tok-a', { createdAt: 123, sessionId: 's1' }],
        ['tok-b', { createdAt: 456, sessionId: null }],
      ]
      store.save(entries)

      const file = join(dir, 'session-tokens.json')
      assert.ok(existsSync(file))
      if (process.platform !== 'win32') {
        assert.equal(statSync(file).mode & 0o777, 0o600, 'store file is 0600')
      }
      assert.deepEqual(store.load(), entries, 'the saved entries round-trip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a durable save (revoke path, #6914) round-trips entries at 0600', () => {
    // The REVOKE snapshot calls save(entries, { durable: true }), which forwards
    // `durable` to writeFileRestricted so the store is fsync'd before success.
    // Exercising the real store through the durable code path here (over a real
    // temp filesystem, no seams) proves the flag is threaded end-to-end and the
    // fsync'd write still lands byte-correct and owner-only.
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-stst-'))
    try {
      const store = createSessionTokenStore({ dir, keychain: noKeychain })
      const entries = [['tok-durable', { createdAt: 789, sessionId: null }]]
      assert.equal(store.save(entries, { durable: true }), true, 'durable save reports success')

      const file = join(dir, 'session-tokens.json')
      assert.ok(existsSync(file))
      if (process.platform !== 'win32') {
        assert.equal(statSync(file).mode & 0o777, 0o600, 'durable store file is 0600')
      }
      assert.deepEqual(store.load(), entries, 'the durably-saved entries round-trip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a corrupt store file loads empty (never throws into the auth path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-stst-'))
    try {
      const file = join(dir, 'session-tokens.json')
      writeFileSync(file, '{ not valid json', { mode: 0o600 })
      chmodSync(file, 0o600)
      const store = createSessionTokenStore({ dir, keychain: noKeychain })
      assert.deepEqual(store.load(), [], 'corrupt → empty, no throw')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a non-0600 (world-readable) store file', () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-stst-'))
    try {
      const file = join(dir, 'session-tokens.json')
      writeFileSync(file, JSON.stringify({ v: 1, entries: [['t', { createdAt: 1, sessionId: null }]] }))
      chmodSync(file, 0o644)
      const store = createSessionTokenStore({ dir, keychain: noKeychain })
      assert.deepEqual(store.load(), [], 'a 0644 file is refused → empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#6598 sessionTokenTtl config validation', () => {
  it('warns on a malformed duration (which would silently default)', () => {
    const { warnings } = validateConfig({ sessionTokenTtl: '30dayz' })
    assert.ok(warnings.some(w => w.includes("sessionTokenTtl") && w.includes('Invalid duration')), warnings.join(' | '))
  })

  it('warns on a sub-floor value', () => {
    const { warnings } = validateConfig({ sessionTokenTtl: '1m' })
    assert.ok(warnings.some(w => w.includes("sessionTokenTtl") && w.includes('too low')), warnings.join(' | '))
  })

  it('accepts a valid duration with no warning', () => {
    const { warnings } = validateConfig({ sessionTokenTtl: '15d' })
    assert.ok(!warnings.some(w => w.includes("sessionTokenTtl")), warnings.join(' | '))
  })
})
