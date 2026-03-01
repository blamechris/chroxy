import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyPair, deriveSharedKey, encrypt, decrypt, nonceFromCounter, DIRECTION_SERVER, DIRECTION_CLIENT, safeTokenCompare } from '../src/crypto.js'

describe('crypto', () => {
  it('round-trip encrypt/decrypt', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const original = { type: 'input', text: 'hello world' }
    const envelope = encrypt(JSON.stringify(original), serverShared, 0, DIRECTION_SERVER)

    assert.equal(envelope.type, 'encrypted')
    assert.equal(envelope.n, 0)
    assert.ok(typeof envelope.d === 'string')

    const decrypted = decrypt(envelope, clientShared, 0, DIRECTION_SERVER)
    assert.deepEqual(decrypted, original)
  })

  it('cross-side compatibility (server encrypts, client decrypts)', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    // Server → Client (direction = SERVER)
    const msg1 = { type: 'response', content: 'test message' }
    const enc1 = encrypt(JSON.stringify(msg1), serverShared, 0, DIRECTION_SERVER)
    const dec1 = decrypt(enc1, clientShared, 0, DIRECTION_SERVER)
    assert.deepEqual(dec1, msg1)

    // Client → Server (direction = CLIENT)
    const msg2 = { type: 'input', text: 'reply' }
    const enc2 = encrypt(JSON.stringify(msg2), clientShared, 0, DIRECTION_CLIENT)
    const dec2 = decrypt(enc2, serverShared, 0, DIRECTION_CLIENT)
    assert.deepEqual(dec2, msg2)
  })

  it('direction isolation: same counter + same key but different direction cannot decrypt', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    // Encrypt as server (direction=0), try to decrypt as client (direction=1)
    const msg = { type: 'test' }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0, DIRECTION_SERVER)
    assert.throws(() => decrypt(envelope, clientShared, 0, DIRECTION_CLIENT), /Decryption failed/)
  })

  it('multiple messages with incrementing nonces', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    for (let i = 0; i < 10; i++) {
      const msg = { type: 'test', seq: i }
      const enc = encrypt(JSON.stringify(msg), serverShared, i, DIRECTION_SERVER)
      assert.equal(enc.n, i)
      const dec = decrypt(enc, clientShared, i, DIRECTION_SERVER)
      assert.deepEqual(dec, msg)
    }
  })

  it('tamper detection (modified ciphertext throws)', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)

    // Tamper with ciphertext
    const tampered = { ...envelope, d: envelope.d.slice(0, -4) + 'AAAA' }
    assert.throws(() => decrypt(tampered, clientShared, 0, DIRECTION_SERVER), /Decryption failed/)
  })

  it('wrong nonce rejection', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)
    assert.throws(() => decrypt(envelope, clientShared, 1, DIRECTION_SERVER), /Unexpected nonce/)
  })

  it('key mismatch causes decryption failure', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const wrongKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const wrongShared = deriveSharedKey(wrongKp.publicKey, clientKp.secretKey)

    const envelope = encrypt(JSON.stringify({ type: 'test' }), serverShared, 0, DIRECTION_SERVER)
    assert.throws(() => decrypt(envelope, wrongShared, 0, DIRECTION_SERVER), /Decryption failed/)
  })

  it('nonceFromCounter produces correct 24-byte nonces with direction prefix', () => {
    const n0 = nonceFromCounter(0, DIRECTION_SERVER)
    assert.equal(n0.length, 24)
    assert.equal(n0[0], 0) // direction = server
    assert.ok(n0.slice(1).every(b => b === 0))

    const n1 = nonceFromCounter(1, DIRECTION_CLIENT)
    assert.equal(n1[0], 1) // direction = client
    assert.equal(n1[1], 1) // counter byte 0
    assert.equal(n1[2], 0)

    const n256 = nonceFromCounter(256, DIRECTION_SERVER)
    assert.equal(n256[0], 0) // direction = server
    assert.equal(n256[1], 0) // counter byte 0
    assert.equal(n256[2], 1) // counter byte 1
  })

  it('handles unicode content', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const msg = { type: 'test', content: 'Hello, world! Emoji and special chars' }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0, DIRECTION_SERVER)
    const decrypted = decrypt(envelope, clientShared, 0, DIRECTION_SERVER)
    assert.deepEqual(decrypted, msg)
  })

  it('handles large messages', () => {
    const serverKp = createKeyPair()
    const clientKp = createKeyPair()
    const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
    const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

    const largeContent = 'x'.repeat(100_000)
    const msg = { type: 'response', content: largeContent }
    const envelope = encrypt(JSON.stringify(msg), serverShared, 0, DIRECTION_SERVER)
    const decrypted = decrypt(envelope, clientShared, 0, DIRECTION_SERVER)
    assert.deepEqual(decrypted, msg)
  })
})

describe('safeTokenCompare', () => {
  it('returns true for equal tokens', () => {
    assert.equal(safeTokenCompare('abc123', 'abc123'), true)
  })

  it('returns true for long equal tokens', () => {
    const token = 'a'.repeat(256)
    assert.equal(safeTokenCompare(token, token), true)
  })

  it('returns false for different tokens of same length', () => {
    assert.equal(safeTokenCompare('abc123', 'abc456'), false)
  })

  it('returns false for different length tokens', () => {
    assert.equal(safeTokenCompare('short', 'muchlongertoken'), false)
  })

  it('returns false when first token is longer', () => {
    assert.equal(safeTokenCompare('muchlongertoken', 'short'), false)
  })

  it('returns false for empty string vs non-empty string', () => {
    assert.equal(safeTokenCompare('', 'notempty'), false)
  })

  it('returns false for non-empty string vs empty string', () => {
    assert.equal(safeTokenCompare('notempty', ''), false)
  })

  it('returns false for two empty strings', () => {
    // Two empty strings should return false (maxLen === 0 guard)
    assert.equal(safeTokenCompare('', ''), false)
  })

  it('returns false for non-string inputs (number)', () => {
    assert.equal(safeTokenCompare(123, 'abc'), false)
  })

  it('returns false for non-string inputs (null)', () => {
    assert.equal(safeTokenCompare(null, 'abc'), false)
  })

  it('returns false for non-string inputs (undefined)', () => {
    assert.equal(safeTokenCompare(undefined, 'abc'), false)
  })

  it('returns false for non-string inputs (object)', () => {
    assert.equal(safeTokenCompare({}, 'abc'), false)
  })

  it('returns false when both inputs are non-strings', () => {
    assert.equal(safeTokenCompare(123, 456), false)
  })

  it('returns false for single character difference', () => {
    assert.equal(safeTokenCompare('abcdefg', 'abcdefh'), false)
  })

  it('handles tokens with special characters', () => {
    const token = 'tok-abc_123.xyz/+='
    assert.equal(safeTokenCompare(token, token), true)
    assert.equal(safeTokenCompare(token, token + '!'), false)
  })

  it('handles unicode tokens', () => {
    const token = 'token-with-unicode'
    assert.equal(safeTokenCompare(token, token), true)
  })
})
