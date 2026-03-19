/**
 * token-crypto tests (#1655)
 *
 * Tests obfuscation round-trip, plaintext fallback,
 * and migration safety (de-obfuscating unencrypted values).
 */
import { describe, it, expect } from 'vitest'
import { obfuscateToken, deobfuscateToken, isProtected } from './token-crypto'

describe('token-crypto', () => {
  it('round-trips a token through obfuscate/deobfuscate', () => {
    const token = 'sk-test-abc123-very-secret'
    const obfuscated = obfuscateToken(token)
    expect(obfuscated).not.toBe(token)
    expect(isProtected(obfuscated)).toBe(true)
    const restored = deobfuscateToken(obfuscated)
    expect(restored).toBe(token)
  })

  it('obfuscates with the obf:v1: prefix', () => {
    const obfuscated = obfuscateToken('test-token')
    expect(obfuscated.startsWith('obf:v1:')).toBe(true)
  })

  it('returns empty string as-is', () => {
    expect(obfuscateToken('')).toBe('')
    expect(deobfuscateToken('')).toBe('')
  })

  it('returns plaintext token when deobfuscating unencrypted value (migration safe)', () => {
    const plaintext = 'old-token-stored-plaintext'
    expect(isProtected(plaintext)).toBe(false)
    const result = deobfuscateToken(plaintext)
    expect(result).toBe(plaintext)
  })

  it('handles special characters in tokens', () => {
    const token = 'tok_+/=abc123!@#$%'
    const obfuscated = obfuscateToken(token)
    expect(deobfuscateToken(obfuscated)).toBe(token)
  })

  it('handles long tokens', () => {
    const token = 'a'.repeat(500)
    const obfuscated = obfuscateToken(token)
    expect(deobfuscateToken(obfuscated)).toBe(token)
  })

  it('isProtected detects obfuscated prefix', () => {
    expect(isProtected('obf:v1:abc')).toBe(true)
    expect(isProtected('enc:v1:abc')).toBe(true)
    expect(isProtected('plaintext-token')).toBe(false)
    expect(isProtected('')).toBe(false)
  })
})
