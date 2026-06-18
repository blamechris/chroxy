import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IDENTITY_KEY_SERVICE,
  IdentityUnavailableError,
  getOrCreateServerIdentity,
  loadServerIdentity,
  persistServerIdentity,
} from '../src/server-identity.js'
import {
  createKeyPair,
  signExchangeKey,
  verifyExchangeKeySignature,
} from '@chroxy/store-core/crypto'

/**
 * Tests for the long-lived server identity (#5536). The keychain is an in-memory
 * fake so nothing touches the real OS keychain; the fallback file goes to a temp
 * dir so the real ~/.chroxy/ tree is never written (per the test-state rule).
 */

function fakeKeychain({ available = true, readError = null } = {}) {
  const store = new Map()
  return {
    isKeychainAvailable: () => available,
    getToken: (service) => store.get(service) ?? null,
    // #5615 — distinguishes absent from a read failure. When `readError` is set
    // the read FAILS (simulating a locked keychain) rather than reporting absence.
    getTokenStatus: (service) => {
      if (readError) return { status: 'error', value: null, error: readError }
      const value = store.get(service) ?? null
      return value
        ? { status: 'found', value, error: null }
        : { status: 'absent', value: null, error: null }
    },
    setToken: (token, service) => { store.set(service, token) },
    deleteToken: (service) => { store.delete(service) },
    _store: store,
  }
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-identity-'))
  try {
    return fn(join(dir, 'server-identity.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('server identity (#5536)', () => {
  it('mints a 64-byte Ed25519 keypair on first run', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain()
      const id = getOrCreateServerIdentity({ keychain: kc, filePath })
      assert.equal(id.created, true)
      assert.equal(id.secretKey.length, 64)
      assert.equal(Buffer.from(id.publicKey, 'base64').length, 32)
    })
  })

  it('persists the SAME key across "restarts" (keychain backend)', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: true })
      const first = getOrCreateServerIdentity({ keychain: kc, filePath })
      assert.equal(first.created, true)
      assert.equal(first.backend, 'keychain')
      // Simulate a daemon restart: fresh getOrCreate against the SAME keychain.
      const second = getOrCreateServerIdentity({ keychain: kc, filePath })
      assert.equal(second.created, false, 'restart must not mint a new key')
      assert.equal(second.publicKey, first.publicKey)
      assert.deepEqual(second.secretKey, first.secretKey)
      // Nothing was written to the fallback file when the keychain is available.
      assert.equal(existsSync(filePath), false)
    })
  })

  it('falls back to a 0600 file when no keychain is available, and reloads it', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      const first = getOrCreateServerIdentity({ keychain: kc, filePath })
      assert.equal(first.backend, 'file')
      assert.equal(existsSync(filePath), true)
      // Mode is owner-only (0600). statSync mode masks to the perm bits.
      const mode = statSync(filePath).mode & 0o777
      assert.equal(mode, 0o600)
      // The file is JSON with a base64 secret, NOT a plaintext key on its own.
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
      assert.equal(typeof parsed.secretKey, 'string')
      // Restart: a fresh getOrCreate loads the SAME key from the file.
      const second = getOrCreateServerIdentity({ keychain: kc, filePath })
      assert.equal(second.created, false)
      assert.equal(second.publicKey, first.publicKey)
    })
  })

  it('loadServerIdentity returns null when nothing is stored', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      assert.equal(loadServerIdentity({ keychain: kc, filePath }), null)
    })
  })

  it('treats a malformed stored key as absent (mints fresh)', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: true })
      // Stash a wrong-length value under the identity service.
      kc.setToken(Buffer.from('too short').toString('base64'), IDENTITY_KEY_SERVICE)
      assert.equal(loadServerIdentity({ keychain: kc, filePath }), null)
      const id = getOrCreateServerIdentity({ keychain: kc, filePath })
      assert.equal(id.created, true)
      assert.equal(id.secretKey.length, 64)
    })
  })

  // #5615 — three distinct keychain cases on the identity read.
  describe('#5615 — keychain read failure must not silently rotate', () => {
    it('(a) keychain absent / nothing stored → FIRST RUN mints (correct)', () => {
      withTempDir((filePath) => {
        const kc = fakeKeychain({ available: true }) // present, but empty store
        const id = getOrCreateServerIdentity({ keychain: kc, filePath })
        assert.equal(id.created, true, 'an empty keychain is first-run; minting is correct')
        assert.equal(id.secretKey.length, 64)
      })
    })

    it('(b) keychain present but READ FAILED (locked) → throws IdentityUnavailableError, does NOT mint', () => {
      withTempDir((filePath) => {
        const kc = fakeKeychain({ available: true, readError: 'keychain locked' })
        // loadServerIdentity surfaces the failure distinctly...
        assert.throws(
          () => loadServerIdentity({ keychain: kc, filePath }),
          (err) => err instanceof IdentityUnavailableError && err.code === 'IDENTITY_UNAVAILABLE',
        )
        // ...and getOrCreate propagates it WITHOUT minting a replacement (which
        // would silently rotate the identity and brick every pinned client).
        assert.throws(
          () => getOrCreateServerIdentity({ keychain: kc, filePath }),
          IdentityUnavailableError,
        )
        // Nothing was written anywhere — no rotation occurred.
        assert.equal(kc._store.size, 0, 'must not write a fresh key to the keychain')
        assert.equal(existsSync(filePath), false, 'must not write a fresh key to the fallback file')
      })
    })

    it('(b) a transient lock that later clears loads the SAME pre-existing identity (no rotation)', () => {
      withTempDir((filePath) => {
        // Mint + persist under a healthy keychain.
        const healthy = fakeKeychain({ available: true })
        const original = getOrCreateServerIdentity({ keychain: healthy, filePath })
        // Now the keychain is locked: read fails → refuse, never re-mint.
        const locked = fakeKeychain({ available: true, readError: 'interaction not allowed' })
        locked._store.set(IDENTITY_KEY_SERVICE, healthy._store.get(IDENTITY_KEY_SERVICE))
        assert.throws(() => getOrCreateServerIdentity({ keychain: locked, filePath }), IdentityUnavailableError)
        // Lock clears: the SAME identity loads — pinned clients keep verifying.
        const recovered = getOrCreateServerIdentity({ keychain: healthy, filePath })
        assert.equal(recovered.created, false)
        assert.equal(recovered.publicKey, original.publicKey)
      })
    })

    it('(c) malformed stored value is distinguishable from (b): re-mints, does NOT throw', () => {
      withTempDir((filePath) => {
        const kc = fakeKeychain({ available: true })
        kc.setToken(Buffer.from('garbage').toString('base64'), IDENTITY_KEY_SERVICE)
        // No throw — a malformed value is treated as absent (re-mint), NOT as a
        // read failure. This is the key (b)-vs-(c) distinction.
        const id = getOrCreateServerIdentity({ keychain: kc, filePath })
        assert.equal(id.created, true)
        assert.equal(id.secretKey.length, 64)
      })
    })
  })

  it('the persisted identity can sign an exchange key that verifies under its public half', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain()
      const id = getOrCreateServerIdentity({ keychain: kc, filePath })
      const exchange = createKeyPair()
      const sig = signExchangeKey(exchange.publicKey, id.secretKey)
      assert.equal(verifyExchangeKeySignature(exchange.publicKey, sig, id.publicKey), true)
      // A reload yields a key that verifies the SAME signature (identity stable).
      const reloaded = loadServerIdentity({ keychain: kc, filePath })
      assert.equal(verifyExchangeKeySignature(exchange.publicKey, sig, reloaded.publicKey), true)
    })
  })

  it('persistServerIdentity reports the backend it used', () => {
    withTempDir((filePath) => {
      const kpFromFresh = getOrCreateServerIdentity({ keychain: fakeKeychain(), filePath })
      // keychain path
      assert.equal(persistServerIdentity(kpFromFresh, { keychain: fakeKeychain({ available: true }), filePath }), 'keychain')
      // file fallback path
      assert.equal(persistServerIdentity(kpFromFresh, { keychain: fakeKeychain({ available: false }), filePath }), 'file')
    })
  })
})
