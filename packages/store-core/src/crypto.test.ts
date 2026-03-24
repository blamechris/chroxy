/**
 * Tests for nonce counter overflow guard in crypto module.
 */
import { describe, it, expect } from 'vitest'
import {
  nonceFromCounter,
  encrypt,
  decrypt,
  createKeyPair,
  deriveSharedKey,
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
} from './crypto'

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
