import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyPair, deriveSharedKey, encrypt, decrypt, nonceFromCounter } from '../src/crypto.js'

describe('crypto', () => {
  it('round-trip encrypt/decrypt', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const original = { type: 'input', text: 'hello world' }
    const envelope = encrypt(JSON.stringify(original), serverShared, 0)

    assert.equal(envelope.type, 'encrypted')
    assert.equal(envelope.n, 0)
    assert.ok(typeof envelope.d === 'string')

    const decrypted = decrypt(envelope, clientShared, 0)
    assert.deepEqual(decrypted, original)
  })

  it('cross-side compatibility (server encrypts, client decrypts)', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    // Server → Client
    const msg1 = { type: 'response', content: 'test message' }
    const enc1 = encrypt(JSON.stringify(msg1), serverShared, 0)
    const dec1 = decrypt(enc1, clientShared, 0)
    assert.deepEqual(dec1, msg1)

    // Client → Server
    const msg2 = { type: 'input', text: 'reply' }
    const enc2 = encrypt(JSON.stringify(msg2), clientShared, 0)
    const dec2 = decrypt(enc2, serverShared, 0)
    assert.deepEqual(dec2, msg2)
  })

  it('multiple messages with incrementing nonces', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    for (let i = 0; i < 10; i++) {
      const msg = { type: 'test', seq: i }
      const enc = encrypt(JSON.stringify(msg), serverShared, i)
      assert.equal(enc.n, i)
      const dec = decrypt(enc, clientShared, i)
      assert.deepEqual(dec, msg)
    }
  })

  it('tamper detection (modified ciphertext throws)', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0)

    // Tamper with ciphertext
    const tampered = { ...envelope, d: envelope.d.slice(0, -4) + 'AAAA' }
    assert.throws(() => decrypt(tampered, clientShared, 0), /Decryption failed/)
  })

  it('wrong nonce rejection', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0)
    assert.throws(() => decrypt(envelope, clientShared, 1), /Unexpected nonce/)
  })

  it('key mismatch causes decryption failure', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const wrongKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const wrongShared = deriveSharedKey(wrongKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0)
    assert.throws(() => decrypt(envelope, wrongShared, 0), /Decryption failed/)
  })

  it('nonceFromCounter produces correct 24-byte nonces', () => {
    const n0 = nonceFromCounter(0)
    assert.equal(n0.length, 24)
    assert.ok(n0.every(b => b === 0))

    const n1 = nonceFromCounter(1)
    assert.equal(n1[0], 1)
    assert.equal(n1[1], 0)

    const n256 = nonceFromCounter(256)
    assert.equal(n256[0], 0)
    assert.equal(n256[1], 1)
  })

  it('handles unicode content', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const msg = { type: 'test', content: 'Hello, world! Emoji and special chars' }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0)
    const decrypted = decrypt(envelope, clientShared, 0)
    assert.deepEqual(decrypted, msg)
  })

  it('handles large messages', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const largeContent = 'x'.repeat(100_000)
    const msg = { type: 'response', content: largeContent }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0)
    const decrypted = decrypt(envelope, clientShared, 0)
    assert.deepEqual(decrypted, msg)
  })
})
