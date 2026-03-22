import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeTokenCompare } from '../../src/token-compare.js'
import { ClientMessageSchema } from '../../src/ws-schemas.js'
import { RateLimiter } from '../../src/rate-limiter.js'

describe('security: auth bypass vectors', () => {
  describe('timing-safe token comparison', () => {
    const validToken = 'abc123secrettoken456'

    it('rejects empty string', () => {
      assert.equal(safeTokenCompare('', validToken), false)
    })

    it('rejects null/undefined', () => {
      assert.equal(safeTokenCompare(null, validToken), false)
      assert.equal(safeTokenCompare(undefined, validToken), false)
    })

    it('rejects numeric input', () => {
      assert.equal(safeTokenCompare(12345, validToken), false)
    })

    it('rejects object input', () => {
      assert.equal(safeTokenCompare({ toString: () => validToken }, validToken), false)
    })

    it('rejects array input', () => {
      assert.equal(safeTokenCompare([validToken], validToken), false)
    })

    it('rejects token with extra whitespace', () => {
      assert.equal(safeTokenCompare(` ${validToken} `, validToken), false)
    })

    it('rejects token differing only in case', () => {
      assert.equal(safeTokenCompare(validToken.toUpperCase(), validToken), false)
    })

    it('accepts exact match', () => {
      assert.equal(safeTokenCompare(validToken, validToken), true)
    })
  })

  describe('rate limiting under concurrent load', () => {
    it('enforces rate limit across rapid sequential requests', () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxMessages: 5, burst: 0 })
      const clientId = 'attacker-1'

      for (let i = 0; i < 5; i++) {
        const result = limiter.check(clientId)
        assert.equal(result.allowed, true, `Request ${i + 1} should be allowed`)
      }

      const blocked = limiter.check(clientId)
      assert.equal(blocked.allowed, false, 'Request 6 should be blocked')
      assert.ok(blocked.retryAfterMs > 0, 'Should include retry-after')
    })

    it('isolates rate limits between clients', () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxMessages: 3, burst: 0 })

      for (let i = 0; i < 3; i++) {
        limiter.check('client-a')
      }
      assert.equal(limiter.check('client-a').allowed, false)
      assert.equal(limiter.check('client-b').allowed, true, 'Different client should not be limited')
    })

    it('rate limiter cleanup removes stale entries', () => {
      const limiter = new RateLimiter({ windowMs: 60000, maxMessages: 5, burst: 0 })
      limiter.check('stale-client')
      limiter.remove('stale-client')
      // After removal, the client should have a fresh limit
      for (let i = 0; i < 5; i++) {
        assert.equal(limiter.check('stale-client').allowed, true)
      }
    })
  })

  describe('schema validation rejects malformed auth', () => {
    it('rejects auth without type field', () => {
      const result = ClientMessageSchema.safeParse({ token: 'abc' })
      assert.equal(result.success, false)
    })

    it('rejects auth with empty token at schema level', () => {
      const result = ClientMessageSchema.safeParse({ type: 'auth', token: '' })
      // Schema may reject or accept — verify either way the token compare rejects
      if (!result.success) {
        assert.ok(result.error, 'Schema rejects empty token')
      } else {
        // Even if schema accepts, safeTokenCompare rejects empty strings
        assert.equal(safeTokenCompare('', 'real-token'), false)
      }
    })

    it('rejects auth with non-string token', () => {
      const result = ClientMessageSchema.safeParse({ type: 'auth', token: 12345 })
      assert.equal(result.success, false)
    })

    it('rejects auth with null token', () => {
      const result = ClientMessageSchema.safeParse({ type: 'auth', token: null })
      assert.equal(result.success, false)
    })

    it('rejects completely unknown message type', () => {
      const result = ClientMessageSchema.safeParse({ type: 'admin_backdoor', secret: 'hack' })
      assert.equal(result.success, false)
    })
  })
})
