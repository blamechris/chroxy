import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter, getClientIp, getRateLimitKey } from '../src/rate-limiter.js'

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

describe('RateLimiter bounded map (#3979)', () => {
  it('caps map size at maxEntries when many unique clients hit the limiter', () => {
    const cap = 100
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: cap })
    for (let i = 0; i < cap + 50; i++) {
      limiter.check(`client-${i}`)
    }
    assert.ok(
      limiter._clients.size <= cap,
      `Map size ${limiter._clients.size} should not exceed cap ${cap}`
    )
  })

  it('evicts the oldest entry first (insertion-order LRU)', () => {
    const cap = 3
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: cap })
    limiter.check('oldest')
    limiter.check('middle')
    limiter.check('newest')
    assert.equal(limiter._clients.size, 3)
    // Inserting a 4th unique client should evict the oldest
    limiter.check('overflow')
    assert.equal(limiter._clients.size, 3)
    assert.equal(limiter._clients.has('oldest'), false, 'oldest entry should have been evicted')
    assert.equal(limiter._clients.has('middle'), true)
    assert.equal(limiter._clients.has('newest'), true)
    assert.equal(limiter._clients.has('overflow'), true)
  })

  it('retains the most-recent-N entries under sustained pressure', () => {
    const cap = 10
    const total = 1000
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: cap })
    for (let i = 0; i < total; i++) {
      limiter.check(`client-${i}`)
    }
    assert.equal(limiter._clients.size, cap)
    // Most recent cap entries should be retained
    for (let i = total - cap; i < total; i++) {
      assert.equal(
        limiter._clients.has(`client-${i}`),
        true,
        `client-${i} (one of the most recent ${cap}) should be retained`
      )
    }
    // Oldest should be gone
    for (let i = 0; i < total - cap; i++) {
      assert.equal(
        limiter._clients.has(`client-${i}`),
        false,
        `client-${i} should have been evicted`
      )
    }
  })

  it('does not evict on repeated access by the same client (preserves bucket)', () => {
    const limiter = new RateLimiter({ maxMessages: 100, burst: 0, windowMs: 60_000, maxEntries: 5 })
    for (let i = 0; i < 50; i++) {
      limiter.check('client-1')
    }
    assert.equal(limiter._clients.size, 1)
    // The single client's timestamps must still be tracked
    assert.equal(limiter._clients.get('client-1').length, 50)
  })

  it('defaults to a 10000-entry cap', () => {
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000 })
    for (let i = 0; i < 10_500; i++) {
      limiter.check(`client-${i}`)
    }
    assert.ok(
      limiter._clients.size <= 10_000,
      `Default cap should be 10000, got ${limiter._clients.size}`
    )
  })

  it('eviction is lazy (happens on check(), no separate timer)', () => {
    const cap = 5
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: cap })
    // Fill to cap with no overflow yet
    for (let i = 0; i < cap; i++) {
      limiter.check(`client-${i}`)
    }
    assert.equal(limiter._clients.size, cap)
    // Without any further check() call, size should remain — there's no
    // background timer or async eviction that would mutate state
    assert.equal(limiter._clients.size, cap)
    // The next check() is what triggers eviction
    limiter.check('client-overflow')
    assert.equal(limiter._clients.size, cap)
  })

  it('still enforces rate limits correctly under eviction', () => {
    const limiter = new RateLimiter({ maxMessages: 2, burst: 0, windowMs: 60_000, maxEntries: 3 })
    // Same client hits the limit
    assert.equal(limiter.check('hot-client').allowed, true)
    assert.equal(limiter.check('hot-client').allowed, true)
    assert.equal(limiter.check('hot-client').allowed, false)
    // Adding many other clients should not reset hot-client's bucket as long
    // as it stays in the map. Touch hot-client again to keep it warm, then
    // overflow with new clients up to (but not beyond) what would evict it.
    for (let i = 0; i < 2; i++) {
      limiter.check(`spam-${i}`)
    }
    // hot-client was inserted first; with cap=3, two spam clients fill the
    // remaining slots without evicting it
    assert.equal(limiter._clients.has('hot-client'), true)
    assert.equal(limiter.check('hot-client').allowed, false, 'limit must still apply')
  })

  // Regression guard: pre-fix, `maxEntries || DEFAULT_MAX_ENTRIES` silently
  // accepted 0/NaN/-1, which would either disable the cap (default 10000)
  // or — worse — make the FIFO loop spin forever if some downstream code
  // ever treated 0 as "no cap." Tighten to integer >= 1.
  it('rejects invalid maxEntries and falls back to the default', () => {
    for (const bad of [0, -1, -100, NaN, 0.5, '5', null, undefined]) {
      const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: bad })
      assert.equal(limiter._maxEntries, 10_000, `maxEntries=${bad} must fall back to default 10000`)
    }
  })

  it('accepts a valid positive integer maxEntries override', () => {
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: 42 })
    assert.equal(limiter._maxEntries, 42)
  })
})

describe('RateLimiter lazy stale-reap (#3997)', () => {
  it('reaps stale entries opportunistically when a new client is inserted', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({ maxMessages: 5, burst: 0, windowMs: 1_000, maxEntries: 100 })
      // Seed a stale client whose timestamps will all expire
      limiter.check('stale-client')
      assert.equal(limiter._clients.has('stale-client'), true)

      // Fast-forward well past the window so stale-client's bucket is fully expired
      mock.timers.tick(5_000)

      // A check() for a DIFFERENT, brand-new client should opportunistically
      // sweep stale-client out of the map without needing the FIFO cap.
      limiter.check('fresh-client')
      assert.equal(
        limiter._clients.has('stale-client'),
        false,
        'stale-client should have been reaped on unrelated insert'
      )
      assert.equal(limiter._clients.has('fresh-client'), true)
    } finally {
      mock.timers.reset()
    }
  })

  it('does NOT reap clients whose timestamps are still inside the window', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({ maxMessages: 5, burst: 0, windowMs: 60_000, maxEntries: 100 })
      limiter.check('warm-client')
      assert.equal(limiter._clients.has('warm-client'), true)

      // Advance only a little — warm-client's timestamps are still fresh
      mock.timers.tick(1_000)

      // Many unrelated inserts must not knock warm-client out
      for (let i = 0; i < 20; i++) {
        limiter.check(`unrelated-${i}`)
      }

      assert.equal(
        limiter._clients.has('warm-client'),
        true,
        'warm-client must NOT be reaped while its bucket is still fresh'
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('keeps the caller bucket non-empty after a check that prunes it to []', () => {
    // Edge case: caller's own bucket is found and pruned to empty. The
    // existing flow then pushes `now` so the entry is non-empty; we should
    // not accidentally drop it during the same call.
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 1_000 })
      limiter.check('caller')
      mock.timers.tick(5_000)
      const result = limiter.check('caller') // prunes to [] then pushes now
      assert.equal(result.allowed, true)
      assert.equal(limiter._clients.has('caller'), true)
      assert.equal(limiter._clients.get('caller').length, 1)
    } finally {
      mock.timers.reset()
    }
  })

  it('bounded scan: per-call cost stays O(1) (does not scan the whole map)', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      // Fill many stale entries — far more than any reasonable bounded scan.
      const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 1_000, maxEntries: 5_000 })
      for (let i = 0; i < 1_000; i++) {
        limiter.check(`stale-${i}`)
      }
      assert.equal(limiter._clients.size, 1_000)

      // Expire them all
      mock.timers.tick(5_000)

      // A single insert should reap *some* but not necessarily ALL — bounded.
      const sizeBefore = limiter._clients.size
      limiter.check('fresh-1')
      const sizeAfter = limiter._clients.size

      // We added 1 fresh entry, so net change = (added 1) - (reaped K).
      // Bounded scan means K <= some small constant (the scan budget).
      // Assert we reaped at least one, and at most far less than the full map.
      const reaped = sizeBefore + 1 - sizeAfter
      assert.ok(reaped >= 1, `expected at least one stale entry reaped, got ${reaped}`)
      assert.ok(
        reaped <= 64,
        `bounded scan should reap <=64 per call, got ${reaped} (likely full O(N) scan)`
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('converges to active-IP count under sweep workload', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 1_000, maxEntries: 10_000 })

      // Phase 1: a "sweep" that hits many unique IPs once each
      for (let i = 0; i < 500; i++) {
        limiter.check(`sweep-${i}`)
      }
      assert.equal(limiter._clients.size, 500)

      // Phase 2: time passes, all sweep entries become stale
      mock.timers.tick(5_000)

      // Phase 3: sustained activity from a small, fresh active set should
      // gradually evict the stale sweep entries via the bounded scan.
      // After enough fresh inserts, map size should converge near the active
      // set, not still hold 500 stale entries.
      for (let i = 0; i < 500; i++) {
        limiter.check(`active-${i % 10}`) // 10 active IPs, repeated
      }

      // Final state: at most ~10 active + a small residue of un-scanned
      // stale entries. Strictly less than the original 500 stale + 10 active.
      assert.ok(
        limiter._clients.size < 100,
        `map should converge near active-IP count, got ${limiter._clients.size} (stale entries not reaping)`
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('reaping does not interfere with rate-limit correctness', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({ maxMessages: 2, burst: 0, windowMs: 60_000, maxEntries: 100 })

      // Fill some stale entries then expire
      for (let i = 0; i < 50; i++) {
        limiter.check(`old-${i}`)
      }
      mock.timers.tick(120_000)

      // hot-client comes in fresh and hits the limit
      assert.equal(limiter.check('hot').allowed, true)
      assert.equal(limiter.check('hot').allowed, true)
      assert.equal(limiter.check('hot').allowed, false, 'limit must still apply')

      // Reaping during another insert should not reset hot's bucket
      limiter.check('newcomer')
      assert.equal(limiter.check('hot').allowed, false, 'hot bucket must persist across reap')
    } finally {
      mock.timers.reset()
    }
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

  it('handles array-valued cf-connecting-ip header', () => {
    const req = {
      headers: { 'cf-connecting-ip': ['203.0.113.42', '203.0.113.99'] },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req), '203.0.113.42')
  })

  it('handles array-valued x-forwarded-for header', () => {
    const req = {
      headers: { 'x-forwarded-for': ['198.51.100.7, 10.0.0.1', '198.51.100.8'] },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getClientIp(req), '198.51.100.7')
  })
})

describe('getRateLimitKey (#2688)', () => {
  it('uses CF-Connecting-IP when socketIp is loopback 127.0.0.1', () => {
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.42' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    assert.equal(getRateLimitKey('127.0.0.1', req), '203.0.113.42')
  })

  it('uses CF-Connecting-IP when socketIp is ::1 (IPv6 loopback)', () => {
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.42' },
      socket: { remoteAddress: '::1' },
    }
    assert.equal(getRateLimitKey('::1', req), '203.0.113.42')
  })

  it('uses socketIp for direct connections (ignores CF header)', () => {
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.42' },
      socket: { remoteAddress: '198.51.100.5' },
    }
    // Direct connection — header could be spoofed, use socket address
    assert.equal(getRateLimitKey('198.51.100.5', req), '198.51.100.5')
  })

  it('falls back to unknown for direct connection with no socketIp', () => {
    const req = { headers: {}, socket: {} }
    assert.equal(getRateLimitKey('', req), 'unknown')
  })
})
