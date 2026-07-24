import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  IDENTITY_KEY_SERVICE,
  IdentityUnavailableError,
  getOrCreateServerIdentity,
  loadServerIdentity,
  persistServerIdentity,
  rotateServerIdentity,
  loadServerRotationCert,
  resolveServerRotationCert,
} from '../src/server-identity.js'
import {
  createKeyPair,
  signExchangeKey,
  verifyExchangeKeySignature,
  verifyIdentityRotation,
} from '@chroxy/store-core/crypto'

/**
 * Tests for the long-lived server identity (#5536). The keychain is an in-memory
 * fake so nothing touches the real OS keychain; the fallback file goes to a temp
 * dir so the real ~/.chroxy/ tree is never written (per the test-state rule).
 */

function fakeKeychain({ available = true, readError = null, broken = false } = {}) {
  const store = new Map()
  return {
    isKeychainAvailable: () => available,
    // #6234 — a BROKEN keychain is present-but-unusable (distinct from disabled).
    // The identity loader fails safe (throws) on broken + no file rather than
    // minting a replacement that would invalidate pinned clients.
    isKeychainBroken: () => broken,
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
      // Mode is owner-only (0600) on POSIX. Windows does not expose the same
      // chmod semantics through stat mode bits, so the permission contract is
      // enforced by writeFileRestricted where the platform supports it.
      if (process.platform !== 'win32') {
        const mode = statSync(filePath).mode & 0o777
        assert.equal(mode, 0o600)
      }
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

    // #6234 — a BROKEN/missing keychain (distinct from disabled). The no-modal
    // fix must NOT trade the modal for a silent rotation.
    it('(d) broken keychain + a valid fallback FILE identity → loads the file (no rotation, no throw)', () => {
      withTempDir((filePath) => {
        // Mint to the FILE (keychain disabled at mint time → file fallback).
        const minted = getOrCreateServerIdentity({ keychain: fakeKeychain({ available: false }), filePath })
        assert.equal(existsSync(filePath), true)
        // Keychain later goes BROKEN: the file is authoritative — load it unchanged.
        const broken = fakeKeychain({ available: false, broken: true })
        const loaded = loadServerIdentity({ keychain: broken, filePath })
        assert.ok(loaded, 'must load the file identity rather than throw')
        assert.equal(loaded.publicKey, minted.publicKey, 'same identity — no rotation')
      })
    })

    it('(d2) unavailable but not broken keychain + NO fallback file → mints file identity', () => {
      withTempDir((filePath) => {
        // Linux with no secret-tool/libsecret is not a broken keychain; it is
        // the documented headless/no-keychain fallback path.
        const unavailable = fakeKeychain({ available: false, broken: false })
        const id = getOrCreateServerIdentity({ keychain: unavailable, filePath })
        assert.equal(id.created, true)
        assert.equal(id.backend, 'file')
        assert.equal(existsSync(filePath), true, 'must write the fallback file identity')
      })
    })

    it('(e) broken keychain + NO fallback file → throws IdentityUnavailableError (refuses to mint)', () => {
      withTempDir((filePath) => {
        const broken = fakeKeychain({ available: false, broken: true })
        // Can't confirm there is no pinned identity in the unreadable keychain →
        // fail safe rather than mint a replacement that false-MITMs pinned clients.
        assert.throws(
          () => loadServerIdentity({ keychain: broken, filePath }),
          (err) => err instanceof IdentityUnavailableError,
        )
        assert.throws(
          () => getOrCreateServerIdentity({ keychain: broken, filePath }),
          IdentityUnavailableError,
        )
        assert.equal(existsSync(filePath), false, 'must not write a fresh file identity')
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

describe('server identity rotation (#5616/#5976)', () => {
  const rotPath = (filePath) => join(dirname(filePath), 'server-identity-rotation.json')

  it('mints a NEW identity, replaces the secret, and writes a verifiable continuity cert', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false }) // file backend → assert on disk
      const rotationFilePath = rotPath(filePath)
      const before = getOrCreateServerIdentity({ keychain: kc, filePath })

      const res = rotateServerIdentity({ keychain: kc, filePath, rotationFilePath })
      assert.equal(res.previousPublicKey, before.publicKey)
      assert.notEqual(res.newPublicKey, before.publicKey)

      // The persisted secret is now the NEW identity.
      const after = loadServerIdentity({ keychain: kc, filePath })
      assert.equal(after.publicKey, res.newPublicKey)

      // The sidecar cert is "old signs new" and verifies against the OLD pin.
      const sidecar = loadServerRotationCert({ rotationFilePath })
      assert.equal(sidecar.newIdentityKey, res.newPublicKey)
      assert.equal(sidecar.previousPublicKey, before.publicKey)
      assert.equal(
        verifyIdentityRotation(sidecar.newIdentityKey, sidecar.rotationCert, sidecar.previousPublicKey),
        true,
      )
      // A cert does NOT verify against an unrelated key (sanity).
      assert.equal(
        verifyIdentityRotation(sidecar.newIdentityKey, sidecar.rotationCert, createKeyPair().publicKey),
        false,
      )
    })
  })

  it('resolveServerRotationCert returns the cert for the current identity, null when stale', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      const rotationFilePath = rotPath(filePath)
      getOrCreateServerIdentity({ keychain: kc, filePath })
      const res = rotateServerIdentity({ keychain: kc, filePath, rotationFilePath })

      // Current identity matches the sidecar's newIdentityKey → cert resolves.
      const resolved = resolveServerRotationCert(res.newPublicKey, { rotationFilePath })
      assert.equal(resolved.previousPublicKey, res.previousPublicKey)
      assert.ok(resolved.rotationCert)

      // A different "current" identity (e.g. clean re-mint) → stale, ignored.
      assert.equal(resolveServerRotationCert(createKeyPair().publicKey, { rotationFilePath }), null)
    })
  })

  it('is single-hop — a second rotation overwrites the sidecar (only the latest hop)', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      const rotationFilePath = rotPath(filePath)
      const gen1 = getOrCreateServerIdentity({ keychain: kc, filePath })
      const r1 = rotateServerIdentity({ keychain: kc, filePath, rotationFilePath })
      const r2 = rotateServerIdentity({ keychain: kc, filePath, rotationFilePath })

      const sidecar = loadServerRotationCert({ rotationFilePath })
      // Bridges gen2 → gen3, NOT gen1 → gen3.
      assert.equal(sidecar.previousPublicKey, r1.newPublicKey)
      assert.equal(sidecar.newIdentityKey, r2.newPublicKey)
      assert.notEqual(sidecar.previousPublicKey, gen1.publicKey)
      // So a client pinned to gen1 cannot verify (the cert was signed by gen2).
      assert.equal(
        verifyIdentityRotation(sidecar.newIdentityKey, sidecar.rotationCert, gen1.publicKey),
        false,
      )
    })
  })

  it('throws when there is no existing identity to rotate from', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      assert.throws(
        () => rotateServerIdentity({ keychain: kc, filePath, rotationFilePath: rotPath(filePath) }),
        /No existing server identity/,
      )
    })
  })

  it('loadServerRotationCert returns null when the sidecar is absent or malformed', () => {
    withTempDir((filePath) => {
      const rotationFilePath = rotPath(filePath)
      assert.equal(loadServerRotationCert({ rotationFilePath }), null)
    })
  })

  it('is fail-safe: a sidecar-write failure leaves the OLD identity un-rotated', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      const before = getOrCreateServerIdentity({ keychain: kc, filePath })
      // Point the sidecar at a path UNDER an existing file → mkdirSync(dirname)
      // throws ENOTDIR, simulating a sidecar-write failure. Because the sidecar
      // is written BEFORE the secret is swapped, the rotation must abort with the
      // OLD identity still persisted (not a rotated identity with no cert).
      const blocker = join(dirname(filePath), 'blocker')
      writeFileSync(blocker, 'x')
      const badRotationPath = join(blocker, 'rotation.json')

      assert.throws(() => rotateServerIdentity({ keychain: kc, filePath, rotationFilePath: badRotationPath }))

      // The persisted secret is UNCHANGED — pinned clients still verify.
      const after = loadServerIdentity({ keychain: kc, filePath })
      assert.equal(after.publicKey, before.publicKey)
    })
  })
})

// #6927 — `chroxy identity rotate` is the compromise-response path: a power-loss
// rollback that resurrects the RETIRED secret is the same acute class as a token
// revoke, so the rotation's secret persist (file fallback) MUST be durable. The
// first-run mint stays non-durable (fail-safe — a lost mint just re-mints), and
// the rotation SIDECAR stays non-durable (its rollback forces a re-pair, an
// availability concern, never a resurrection of the retired key). We observe the
// `{ durable }` opt via the injected `_write` seam.
describe('#6927 rotation secret persist is durable; mint + sidecar are not', () => {
  const rotPath = (filePath) => join(dirname(filePath), 'server-identity-rotation.json')

  it('rotateServerIdentity fsyncs the NEW secret (durable) but not the sidecar', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false }) // force the file backend
      const rotationFilePath = rotPath(filePath)
      getOrCreateServerIdentity({ keychain: kc, filePath })

      const writes = []
      rotateServerIdentity({
        keychain: kc,
        filePath,
        rotationFilePath,
        _write: (path, _data, opts = {}) => { writes.push({ path, durable: opts.durable === true }) },
      })

      const secretWrite = writes.find((w) => w.path === filePath)
      const sidecarWrite = writes.find((w) => w.path === rotationFilePath)
      assert.ok(secretWrite, 'the new secret was persisted to the fallback file')
      assert.equal(secretWrite.durable, true, 'the rotation secret persist is durable')
      assert.ok(sidecarWrite, 'the continuity sidecar was written')
      assert.equal(sidecarWrite.durable, false, 'the sidecar (continuity, not security) is not durable')
    })
  })

  it('first-run mint persists the secret NON-durably (fail-safe)', () => {
    withTempDir((filePath) => {
      const kc = fakeKeychain({ available: false })
      const kp = getOrCreateServerIdentity({ keychain: kc, filePath })

      let observed
      persistServerIdentity(kp, {
        keychain: kc,
        filePath,
        _write: (_path, _data, opts = {}) => { observed = opts.durable === true },
      })
      assert.equal(observed, false, 'a plain persist (mint) does not fsync')
    })
  })
})
