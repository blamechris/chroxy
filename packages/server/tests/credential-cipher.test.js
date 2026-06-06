import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  CRED_KEY_SERVICE,
  ENVELOPE_VERSION,
  isEncryptedEnvelope,
  encryptJson,
  decryptEnvelope,
  getMasterKey,
  getOrCreateMasterKey,
} from '../src/credential-cipher.js'

/**
 * Tests for credential-cipher.js (#5154) — the envelope crypto + keychain
 * data-key helpers. Pure crypto is exercised directly; the keychain is a tiny
 * in-memory fake so nothing touches the real OS keychain.
 */

// In-memory keychain fake mirroring keychain.js's (getToken/setToken) shape.
function fakeKeychain({ available = true } = {}) {
  const store = new Map()
  return {
    isKeychainAvailable: () => available,
    getToken: (service) => store.get(service) ?? null,
    setToken: (token, service) => { store.set(service, token) },
    _store: store,
  }
}

const key32 = () => new Uint8Array(randomBytes(32))

describe('credential-cipher: envelope shape', () => {
  it('isEncryptedEnvelope accepts a well-formed envelope and rejects others', () => {
    const env = encryptJson({ a: 1 }, key32())
    assert.equal(isEncryptedEnvelope(env), true)
    assert.equal(env.v, ENVELOPE_VERSION)
    assert.equal(env.alg, 'nacl-secretbox')

    assert.equal(isEncryptedEnvelope(null), false)
    assert.equal(isEncryptedEnvelope({}), false)
    assert.equal(isEncryptedEnvelope({ ANTHROPIC_API_KEY: 'sk-ant-x' }), false) // plaintext store
    assert.equal(isEncryptedEnvelope([]), false)
    assert.equal(isEncryptedEnvelope({ v: 1, alg: 'nacl-secretbox', nonce: 'x' }), false) // no data
  })
})

describe('credential-cipher: encrypt/decrypt round-trip', () => {
  it('round-trips an object', () => {
    const key = key32()
    const plain = { ANTHROPIC_API_KEY: 'sk-ant-abc', OPENAI_API_KEY: 'sk-openai-xyz' }
    const env = decryptEnvelope(encryptJson(plain, key), key)
    assert.deepEqual(env, plain)
  })

  it('uses a fresh nonce each call (ciphertext differs for the same input)', () => {
    const key = key32()
    const a = encryptJson({ x: 1 }, key)
    const b = encryptJson({ x: 1 }, key)
    assert.notEqual(a.nonce, b.nonce)
    assert.notEqual(a.data, b.data)
  })

  it('fails to decrypt with the wrong key', () => {
    const env = encryptJson({ secret: 'v' }, key32())
    assert.throws(() => decryptEnvelope(env, key32()), /decryption failed/)
  })

  it('fails to decrypt tampered ciphertext (Poly1305 auth)', () => {
    const key = key32()
    const env = encryptJson({ secret: 'v' }, key)
    // Flip a byte in the base64 ciphertext.
    const buf = Buffer.from(env.data, 'base64')
    buf[0] ^= 0xff
    const tampered = { ...env, data: buf.toString('base64') }
    assert.throws(() => decryptEnvelope(tampered, key), /decryption failed/)
  })

  it('rejects a bad key length on both encrypt and decrypt', () => {
    assert.throws(() => encryptJson({}, new Uint8Array(16)), /32-byte/)
    const env = encryptJson({}, key32())
    assert.throws(() => decryptEnvelope(env, new Uint8Array(16)), /32-byte/)
  })

  it('rejects decrypting a non-envelope', () => {
    assert.throws(() => decryptEnvelope({ not: 'an envelope' }, key32()), /not a valid encrypted envelope/)
  })

  it('fails predictably on a malformed nonce (no tweetnacl "bad nonce size" leak)', () => {
    const key = key32()
    const env = encryptJson({ x: 1 }, key)
    // A too-short nonce would make tweetnacl throw 'bad nonce size'; we must
    // surface the friendly decryption-failed error instead.
    const badNonce = { ...env, nonce: Buffer.from('short').toString('base64') }
    assert.throws(() => decryptEnvelope(badNonce, key), /decryption failed/)
  })

  it('fails predictably on truncated ciphertext', () => {
    const key = key32()
    const env = encryptJson({ x: 1 }, key)
    const truncated = { ...env, data: Buffer.from('xx').toString('base64') }
    assert.throws(() => decryptEnvelope(truncated, key), /decryption failed/)
  })
})

describe('credential-cipher: master key via keychain', () => {
  it('getMasterKey returns null when no keychain is available', () => {
    assert.equal(getMasterKey(fakeKeychain({ available: false })), null)
  })

  it('getMasterKey returns null when no key is stored yet', () => {
    assert.equal(getMasterKey(fakeKeychain()), null)
  })

  it('getOrCreateMasterKey creates, persists, and is stable across calls', () => {
    const kc = fakeKeychain()
    const k1 = getOrCreateMasterKey(kc)
    assert.ok(k1 instanceof Uint8Array)
    assert.equal(k1.length, 32)
    // Persisted under the credential-key service (distinct from the api-token).
    assert.ok(kc._store.has(CRED_KEY_SERVICE))
    // Second call returns the SAME key (read back, not regenerated).
    const k2 = getOrCreateMasterKey(kc)
    assert.deepEqual([...k1], [...k2])
    // getMasterKey now finds it too.
    assert.deepEqual([...getMasterKey(kc)], [...k1])
  })

  it('getOrCreateMasterKey returns null (no creation) without a keychain', () => {
    const kc = fakeKeychain({ available: false })
    assert.equal(getOrCreateMasterKey(kc), null)
    assert.equal(kc._store.size, 0)
  })

  it('a stored-but-malformed key is replaced', () => {
    const kc = fakeKeychain()
    kc.setToken(Buffer.from('too-short').toString('base64'), CRED_KEY_SERVICE)
    const k = getOrCreateMasterKey(kc)
    assert.equal(k.length, 32)
  })
})
