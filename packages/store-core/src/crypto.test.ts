/**
 * Tests for the crypto module (E2E encryption primitives).
 */
import { describe, it, expect, afterEach } from 'vitest'
import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64 } from 'tweetnacl-util'
import {
  initPRNG,
  createKeyPair,
  deriveSharedKey,
  nonceFromCounter,
  encrypt,
  decrypt,
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
} from './crypto'
import type { EncryptedEnvelope } from './crypto'

/** Shared helper: derive a symmetric key from an ephemeral DH exchange. */
function makeSharedKey(): Uint8Array {
  const alice = createKeyPair()
  const bob = createKeyPair()
  return deriveSharedKey(bob.publicKey, alice.secretKey)
}

describe('createKeyPair', () => {
  it('returns publicKey as a base64 string', () => {
    const kp = createKeyPair()
    expect(typeof kp.publicKey).toBe('string')
    expect(kp.publicKey.length).toBeGreaterThan(0)
    // Should be valid base64 — no error on decode
    expect(() => atob(kp.publicKey)).not.toThrow()
  })

  it('returns secretKey as a Uint8Array of correct length', () => {
    const kp = createKeyPair()
    expect(kp.secretKey).toBeInstanceOf(Uint8Array)
    expect(kp.secretKey.length).toBe(nacl.box.secretKeyLength)
  })

  it('generates unique keypairs on each call', () => {
    const a = createKeyPair()
    const b = createKeyPair()
    expect(a.publicKey).not.toBe(b.publicKey)
  })
})

describe('deriveSharedKey', () => {
  it('throws on empty string public key', () => {
    const kp = createKeyPair()
    expect(() => deriveSharedKey('', kp.secretKey)).toThrow(
      'Invalid peer public key: expected a non-empty base64 string'
    )
  })

  it('throws on whitespace-only public key', () => {
    const kp = createKeyPair()
    expect(() => deriveSharedKey('   ', kp.secretKey)).toThrow(
      'Invalid peer public key: expected a non-empty base64 string'
    )
  })

  it('throws on non-base64 public key', () => {
    const kp = createKeyPair()
    expect(() => deriveSharedKey('!!!not-base64!!!', kp.secretKey)).toThrow(
      'Invalid peer public key: not valid base64'
    )
  })

  it('throws on wrong-length decoded key', () => {
    const kp = createKeyPair()
    // 16 bytes encoded as base64 — wrong length for X25519 (expects 32)
    const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)))
    expect(() => deriveSharedKey(shortKey, kp.secretKey)).toThrow(
      /expected length \d+, got 16/
    )
  })

  it('returns Uint8Array for valid key pair', () => {
    const alice = createKeyPair()
    const bob = createKeyPair()
    const shared = deriveSharedKey(alice.publicKey, bob.secretKey)
    expect(shared).toBeInstanceOf(Uint8Array)
    expect(shared.length).toBe(nacl.box.sharedKeyLength)
  })

  it('produces the same shared key from either side', () => {
    const alice = createKeyPair()
    const bob = createKeyPair()
    const sharedAB = deriveSharedKey(bob.publicKey, alice.secretKey)
    const sharedBA = deriveSharedKey(alice.publicKey, bob.secretKey)
    expect(sharedAB).toEqual(sharedBA)
  })
})

describe('nonceFromCounter', () => {
  it('places direction byte at position 0 (DIRECTION_SERVER=0)', () => {
    const nonce = nonceFromCounter(1, DIRECTION_SERVER)
    expect(nonce[0]).toBe(0x00)
  })

  it('places direction byte at position 0 (DIRECTION_CLIENT=1)', () => {
    const nonce = nonceFromCounter(1, DIRECTION_CLIENT)
    expect(nonce[0]).toBe(0x01)
  })

  it('encodes counter in little-endian at positions 1-8', () => {
    // Counter = 0x0102 = 258
    const nonce = nonceFromCounter(258, DIRECTION_SERVER)
    // Little-endian: byte 1 = 0x02, byte 2 = 0x01, rest = 0
    expect(nonce[1]).toBe(0x02)
    expect(nonce[2]).toBe(0x01)
    for (let i = 3; i <= 8; i++) {
      expect(nonce[i]).toBe(0)
    }
  })

  it('returns a 24-byte Uint8Array', () => {
    const nonce = nonceFromCounter(0, DIRECTION_SERVER)
    expect(nonce).toBeInstanceOf(Uint8Array)
    expect(nonce.length).toBe(24)
  })

  it('fills remaining bytes (9-23) with zeros', () => {
    const nonce = nonceFromCounter(999999, DIRECTION_CLIENT)
    for (let i = 9; i < 24; i++) {
      expect(nonce[i]).toBe(0)
    }
  })

  it('handles counter = 0 correctly', () => {
    const nonce = nonceFromCounter(0, DIRECTION_SERVER)
    expect(nonce[0]).toBe(0x00) // direction
    for (let i = 1; i < 24; i++) {
      expect(nonce[i]).toBe(0)
    }
  })
})

describe('encrypt / decrypt round-trip', () => {
  it('basic round-trip works', () => {
    const key = makeSharedKey()
    const original = { hello: 'world', count: 42 }
    const envelope = encrypt(JSON.stringify(original), key, 0, DIRECTION_SERVER)

    expect(envelope.type).toBe('encrypted')
    expect(typeof envelope.d).toBe('string')
    expect(envelope.n).toBe(0)

    const decrypted = decrypt(envelope, key, 0, DIRECTION_SERVER)
    expect(decrypted).toEqual(original)
  })

  it('different directions produce different ciphertext', () => {
    const key = makeSharedKey()
    const msg = JSON.stringify({ test: true })
    const envServer = encrypt(msg, key, 0, DIRECTION_SERVER)
    const envClient = encrypt(msg, key, 0, DIRECTION_CLIENT)
    expect(envServer.d).not.toBe(envClient.d)
  })

  it('decrypt with wrong key fails', () => {
    const key1 = makeSharedKey()
    const key2 = makeSharedKey()
    const envelope = encrypt(JSON.stringify({ secret: true }), key1, 0, DIRECTION_SERVER)

    expect(() => decrypt(envelope, key2, 0, DIRECTION_SERVER)).toThrow(
      'Decryption failed: message tampered or wrong key'
    )
  })

  it('decrypt with tampered ciphertext fails (MAC integrity)', () => {
    const key = makeSharedKey()
    const envelope = encrypt(JSON.stringify({ data: 'safe' }), key, 0, DIRECTION_SERVER)

    // Flip a byte inside the ciphertext (not in base64 padding) to reliably
    // exercise the Poly1305 MAC check rather than a base64 decode error.
    const bytes = decodeBase64(envelope.d)
    bytes[bytes.length - 1] ^= 0xff
    const tampered: EncryptedEnvelope = { ...envelope, d: encodeBase64(bytes) }

    expect(() => decrypt(tampered, key, 0, DIRECTION_SERVER)).toThrow(
      'Decryption failed: message tampered or wrong key'
    )
  })

  it('handles large payloads', () => {
    const key = makeSharedKey()
    const largeObj = { data: 'x'.repeat(10000), nested: { arr: Array.from({ length: 100 }, (_, i) => i) } }
    const envelope = encrypt(JSON.stringify(largeObj), key, 5, DIRECTION_CLIENT)
    const result = decrypt(envelope, key, 5, DIRECTION_CLIENT)
    expect(result).toEqual(largeObj)
  })

  it('different nonce counters produce different ciphertext', () => {
    const key = makeSharedKey()
    const msg = JSON.stringify({ same: 'message' })
    const env0 = encrypt(msg, key, 0, DIRECTION_SERVER)
    const env1 = encrypt(msg, key, 1, DIRECTION_SERVER)
    expect(env0.d).not.toBe(env1.d)
  })
})

describe('decrypt error handling', () => {
  it('throws when envelope.d is not a string', () => {
    const key = makeSharedKey()
    const badEnvelope = { type: 'encrypted' as const, d: 123 as unknown as string, n: 0 }
    expect(() => decrypt(badEnvelope, key, 0, DIRECTION_SERVER)).toThrow(
      'decrypt: envelope.d must be a base64 string'
    )
  })

  it('throws when envelope.n is not a number', () => {
    const key = makeSharedKey()
    const badEnvelope = { type: 'encrypted' as const, d: 'abc', n: 'zero' as unknown as number }
    expect(() => decrypt(badEnvelope, key, 0, DIRECTION_SERVER)).toThrow(
      'decrypt: envelope.n must be a number'
    )
  })

  it('throws on nonce mismatch', () => {
    const key = makeSharedKey()
    const envelope = encrypt(JSON.stringify({ msg: 'test' }), key, 5, DIRECTION_SERVER)

    expect(() => decrypt(envelope, key, 3, DIRECTION_SERVER)).toThrow(
      'Unexpected nonce: got 5, expected 3'
    )
  })
})

const MAX_NONCE_COUNTER = 2 ** 48

describe('nonceFromCounter overflow guard', () => {
  it('accepts counter at the 2^48 boundary', () => {
    expect(() => nonceFromCounter(MAX_NONCE_COUNTER, DIRECTION_SERVER)).not.toThrow()
  })

  it('throws when counter exceeds 2^48', () => {
    expect(() => nonceFromCounter(MAX_NONCE_COUNTER + 1, DIRECTION_SERVER)).toThrow(
      'Nonce counter exhausted'
    )
  })

  it('throws for counter at Number.MAX_SAFE_INTEGER', () => {
    expect(() => nonceFromCounter(Number.MAX_SAFE_INTEGER, DIRECTION_CLIENT)).toThrow(
      'Nonce counter exhausted'
    )
  })

  it('works normally for small counters', () => {
    const nonce = nonceFromCounter(42, DIRECTION_SERVER)
    expect(nonce).toBeInstanceOf(Uint8Array)
    expect(nonce.length).toBe(24)
    expect(nonce[0]).toBe(DIRECTION_SERVER)
    expect(nonce[1]).toBe(42)
  })

  it('works normally for counter 0', () => {
    const nonce = nonceFromCounter(0, DIRECTION_CLIENT)
    expect(nonce[0]).toBe(DIRECTION_CLIENT)
    expect(nonce[1]).toBe(0)
  })
})

describe('encrypt overflow guard', () => {
  it('throws when nonce counter exceeds 2^48', () => {
    const kp = createKeyPair()
    const sharedKey = deriveSharedKey(kp.publicKey, kp.secretKey)

    expect(() =>
      encrypt('{"test":true}', sharedKey, MAX_NONCE_COUNTER + 1, DIRECTION_SERVER)
    ).toThrow('Nonce counter exhausted')
  })
})

describe('decrypt overflow guard', () => {
  it('throws when expected nonce exceeds 2^48', () => {
    const kp = createKeyPair()
    const sharedKey = deriveSharedKey(kp.publicKey, kp.secretKey)

    // Create a valid envelope at counter 0 first
    const envelope = encrypt('{"test":true}', sharedKey, 0, DIRECTION_SERVER)

    // Now try to decrypt expecting a counter beyond the limit
    // The nonce mismatch would fire first, but we set envelope.n to match
    const overflowEnvelope = { ...envelope, n: MAX_NONCE_COUNTER + 1 }

    expect(() =>
      decrypt(overflowEnvelope, sharedKey, MAX_NONCE_COUNTER + 1, DIRECTION_SERVER)
    ).toThrow('Nonce counter exhausted')
  })
})

describe('initPRNG', () => {
  // Restore a non-deterministic PRNG after each test so that a mid-test assertion
  // failure cannot leave the process running on a fixed-value PRNG for subsequent tests.
  afterEach(() => {
    initPRNG((n: number): Uint8Array => {
      const buf = new Uint8Array(n)
      for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256)
      return buf
    })
  })

  it('accepts a valid getRandomBytes function and does not throw', () => {
    const mockGetRandomBytes = (n: number): Uint8Array => {
      return new Uint8Array(n).fill(0xab)
    }
    expect(() => initPRNG(mockGetRandomBytes)).not.toThrow()
  })

  it('subsequent calls do not throw (idempotent registration)', () => {
    const mockGetRandomBytes = (n: number): Uint8Array => new Uint8Array(n).fill(0xcd)
    expect(() => {
      initPRNG(mockGetRandomBytes)
      initPRNG(mockGetRandomBytes)
    }).not.toThrow()
  })

  it('installed PRNG is used by createKeyPair (custom entropy flows through)', () => {
    // After initPRNG with a deterministic source, two keypairs should be identical
    // because they draw from the same fixed-value PRNG.
    // This verifies that the PRNG registration actually takes effect.
    let callCount = 0
    const deterministicPRNG = (n: number): Uint8Array => {
      callCount++
      return new Uint8Array(n).fill(0x42)
    }
    initPRNG(deterministicPRNG)
    const kp1 = createKeyPair()
    const kp2 = createKeyPair()
    expect(kp1.publicKey).toBe(kp2.publicKey)
    expect(callCount).toBeGreaterThan(0)
    // afterEach restores a non-deterministic PRNG unconditionally
  })
})

describe('nonceFromCounter invalid input guard', () => {
  it('rejects negative counter', () => {
    expect(() => nonceFromCounter(-1, DIRECTION_SERVER)).toThrow(RangeError)
    expect(() => nonceFromCounter(-1, DIRECTION_SERVER)).toThrow(
      'Nonce counter must be a non-negative integer'
    )
  })

  it('rejects non-integer counter (float)', () => {
    expect(() => nonceFromCounter(1.5, DIRECTION_SERVER)).toThrow(RangeError)
    expect(() => nonceFromCounter(1.5, DIRECTION_SERVER)).toThrow(
      'Nonce counter must be a non-negative integer'
    )
  })

  it('rejects NaN counter', () => {
    expect(() => nonceFromCounter(NaN, DIRECTION_SERVER)).toThrow(RangeError)
    expect(() => nonceFromCounter(NaN, DIRECTION_SERVER)).toThrow(
      'Nonce counter must be a non-negative integer'
    )
  })

  it('rejects Infinity counter', () => {
    expect(() => nonceFromCounter(Infinity, DIRECTION_SERVER)).toThrow(RangeError)
    expect(() => nonceFromCounter(Infinity, DIRECTION_SERVER)).toThrow(
      'Nonce counter must be a non-negative integer'
    )
  })

  it('rejects -Infinity counter', () => {
    expect(() => nonceFromCounter(-Infinity, DIRECTION_SERVER)).toThrow(RangeError)
    expect(() => nonceFromCounter(-Infinity, DIRECTION_SERVER)).toThrow(
      'Nonce counter must be a non-negative integer'
    )
  })

  it('accepts zero (valid boundary)', () => {
    expect(() => nonceFromCounter(0, DIRECTION_SERVER)).not.toThrow()
  })

  it('accepts exactly MAX_NONCE_COUNTER (2^48)', () => {
    expect(() => nonceFromCounter(MAX_NONCE_COUNTER, DIRECTION_CLIENT)).not.toThrow()
  })
})
