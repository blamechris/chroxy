import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter, getClientIp } from '../src/rate-limiter.js'

describe('RateLimiter (#1828)', () => {
  it('allows messages under the limit', () => {
    const limiter = new RateLimiter({ maxMessages: 5, burst: 2, windowMs: 1000 })
    for (let i = 0; i < 7; i++) {
      const result = limiter.check('client-1')
      assert.equal(result.allowed, true, `Message ${i} should be allowed`)
    }
  })

  it('blocks messages over the limit', () => {
    const limiter = new RateLimiter({ maxMessages: 3, burst: 0, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.check('client-1').allowed, true)
    }
    const result = limiter.check('client-1')
    assert.equal(result.allowed, false)
    assert.ok(result.retryAfterMs > 0, 'Should include retryAfterMs')
  })

  it('tracks clients independently', () => {
    const limiter = new RateLimiter({ maxMessages: 2, burst: 0, windowMs: 60_000 })
    assert.equal(limiter.check('client-1').allowed, true)
    assert.equal(limiter.check('client-1').allowed, true)
    assert.equal(limiter.check('client-1').allowed, false)
    // Different client should still be allowed
    assert.equal(limiter.check('client-2').allowed, true)
  })

  it('removes client tracking data', () => {
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000 })
    assert.equal(limiter.check('client-1').allowed, true)
    assert.equal(limiter.check('client-1').allowed, false)
    limiter.remove('client-1')
    // After removal, client gets a fresh window
    assert.equal(limiter.check('client-1').allowed, true)
  })

  it('clears all tracking data', () => {
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000 })
    limiter.check('client-1')
    limiter.check('client-2')
    limiter.clear()
    assert.equal(limiter.check('client-1').allowed, true)
    assert.equal(limiter.check('client-2').allowed, true)
  })

  it('uses default values', () => {
    const limiter = new RateLimiter()
    // Should allow 120 messages (100 + 20 burst) without blocking
    for (let i = 0; i < 120; i++) {
      assert.equal(limiter.check('client-1').allowed, true, `Message ${i} should be allowed`)
    }
    assert.equal(limiter.check('client-1').allowed, false)
  })

  it('includes burst in the limit', () => {
    const limiter = new RateLimiter({ maxMessages: 5, burst: 3, windowMs: 60_000 })
    // Should allow 8 (5 + 3)
    for (let i = 0; i < 8; i++) {
      assert.equal(limiter.check('client-1').allowed, true)
    }
    assert.equal(limiter.check('client-1').allowed, false)
  })
})

describe('getClientIp (#2688)', () => {
  it('uses CF-Connecting-IP header when present', () => {
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.42' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req), '203.0.113.42')
  })

  it('falls back to X-Forwarded-For when CF header is absent', () => {
    const req = {
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req), '198.51.100.7')
  })

  it('falls back to socket remoteAddress when proxy headers are absent', () => {
    const req = {
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    }
    assert.equal(getClientIp(req), '10.0.0.1')
  })

  it('returns unknown when all sources are missing', () => {
    const req = { headers: {}, socket: {} }
    assert.equal(getClientIp(req), 'unknown')
  })

  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const req = {
      headers: {
        'cf-connecting-ip': '203.0.113.42',
        'x-forwarded-for': '198.51.100.7',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req), '203.0.113.42')
  })
})
