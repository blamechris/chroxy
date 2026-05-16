import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter, getClientIp, getRateLimitKey } from '../src/rate-limiter.js'
import { addLogListener, removeLogListener, setLogLevel, getLogLevel } from '../src/logger.js'

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

describe('RateLimiter cursor stability (#4003)', () => {
  // #4003: regression guard for the persistent _scanCursor (a live
  // Map.keys() iterator) introduced in #4002/#3997. The implementation
  // relies on Map iterator spec guarantees:
  //   - Deleting an already-yielded key has no effect on the cursor
  //   - Deleting a not-yet-yielded key silently skips it on the next .next()
  //   - Calling .next() on an iterator whose Map has been cleared returns
  //     { done: true }
  // These tests lock that contract in so a future refactor (e.g. swapping
  // Map.keys() for a [...map.keys()] snapshot) can't silently regress it.
  //
  // Cursors only advance via _reapStaleEntries inside check(), so each
  // scenario alternates external mutation with check() calls and asserts
  // the limiter neither throws nor double-visits a key.

  it('survives remove() of an already-yielded key between check() calls', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      // STALE_SCAN_BUDGET is 8; seed enough stale entries that a single
      // check() advances the cursor partway through the map without
      // exhausting it.
      const limiter = new RateLimiter({
        maxMessages: 5, burst: 0, windowMs: 1_000, maxEntries: 100,
      })
      for (let i = 0; i < 20; i++) {
        limiter.check(`seed-${i}`)
      }
      // Expire all seeds so the reap loop will actually delete them as it
      // walks the cursor.
      mock.timers.tick(5_000)

      // First check() advances the cursor across some keys (the exact
      // count depends on the scan-budget knob, which is intentionally not
      // pinned here — a refactor that tunes that knob shouldn't break a
      // cursor-stability regression test). Just call check() once to give
      // the cursor a chance to be primed.
      limiter.check('fresh-a')

      // Externally remove one of the seeds. We don't know whether it was
      // already yielded by the cursor or not — both branches must work
      // (Map spec). Use limiter.remove() (the public API, which delegates
      // to _clients.delete()) to mimic a disconnect handler firing
      // between check()s.
      limiter.remove('seed-0')
      limiter.remove('seed-19')

      // Continue calling check() — must not throw, must keep walking the
      // cursor and reaping the remaining stale entries until convergence.
      assert.doesNotThrow(() => {
        for (let i = 0; i < 50; i++) {
          limiter.check(`fresh-${i}`)
        }
      })

      // Sanity: the bounded scan + repeated calls should have reaped the
      // surviving stale entries; only fresh-* and the last fresh caller
      // should remain.
      for (let i = 0; i < 20; i++) {
        assert.equal(
          limiter._clients.has(`seed-${i}`),
          false,
          `seed-${i} should be reaped by now`,
        )
      }
    } finally {
      mock.timers.reset()
    }
  })

  it('survives _clients.clear() mid-scan (cursor rebuilds on next pull)', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        maxMessages: 5, burst: 0, windowMs: 1_000, maxEntries: 100,
      })
      for (let i = 0; i < 20; i++) {
        limiter.check(`seed-${i}`)
      }
      mock.timers.tick(5_000)

      // Prime the cursor so it's pointing into the map.
      limiter.check('fresh-a')
      assert.ok(limiter._scanCursor, 'cursor should be live after first reap pass')

      // Simulate an external mutation that bypasses limiter.clear() — e.g.
      // a test fixture or future code path that touches _clients directly.
      // Capture the cursor before clear() so we can prove it was actually
      // replaced (not the same object reused).
      const cursorBeforeClear = limiter._scanCursor

      // Per Map spec, the existing iterator now returns { done: true } on
      // its next .next() call. The reap loop must detect this, null the
      // cursor, and rebuild on the subsequent call rather than throw.
      limiter._clients.clear()

      assert.doesNotThrow(() => {
        const result = limiter.check('after-clear')
        assert.equal(result.allowed, true)
      })
      assert.equal(limiter._clients.has('after-clear'), true)

      // After enough check()s, the cursor should have been re-created over
      // the new map contents (rather than stuck on the dead iterator).
      for (let i = 0; i < 5; i++) {
        limiter.check(`post-${i}`)
      }
      // Every post-* key must be present — none silently skipped or lost.
      for (let i = 0; i < 5; i++) {
        assert.equal(limiter._clients.has(`post-${i}`), true)
      }
      // CORE REGRESSION ASSERTION: the cursor MUST have been detected as
      // done and replaced — a stale iterator over a cleared Map would
      // yield done=true on every call, making the round-robin scan a
      // permanent no-op for the rest of the limiter's life. Pre-fix
      // (snapshot iterator over old keys) would re-use the same object
      // indefinitely; the fix must observably replace it. Object identity
      // is the tightest check that distinguishes the two implementations.
      assert.notStrictEqual(
        limiter._scanCursor, cursorBeforeClear,
        'cursor must be detected as done over the cleared map and replaced — a stuck iterator would silently break future stale-reaps'
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('survives entries added to _clients between check() calls (cursor sees them on rebuild)', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        maxMessages: 5, burst: 0, windowMs: 1_000, maxEntries: 100,
      })
      // Seed a few entries that are already stale.
      for (let i = 0; i < 5; i++) {
        limiter.check(`seed-${i}`)
      }
      mock.timers.tick(5_000)

      // Prime the cursor.
      limiter.check('fresh-a')

      // Inject a new key directly into _clients with a stale timestamp —
      // simulates any future code path that pre-populates buckets outside
      // the check() flow. Cursor either visits it on a future round-robin
      // or skips this round and picks it up after rebuild — both are spec.
      limiter._clients.set('injected-stale', [0])

      // Drive the cursor through several full rotations.
      assert.doesNotThrow(() => {
        for (let i = 0; i < 100; i++) {
          limiter.check(`fresh-${i}`)
        }
      })

      // injected-stale should have been reaped by one of the subsequent
      // bounded scans — the cursor rebuilds when exhausted, so it will
      // eventually see and drop the stale injection.
      assert.equal(
        limiter._clients.has('injected-stale'),
        false,
        'cursor should eventually visit and reap a key injected mid-iteration',
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('survives interleaved remove() + check() with no map corruption (oracle compare)', () => {
    // Stress: random sequence of insert (check) and remove operations.
    // Track an oracle (Set of currently-removed clients) and assert the
    // limiter's _clients map never holds a key the oracle has explicitly
    // removed (and that has not been re-checked since). We don't compare
    // sizes — the bounded-scan reap is allowed to lag — only that remove()
    // always wins against the cursor.
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        maxMessages: 100, burst: 0, windowMs: 60_000, maxEntries: 1_000,
      })
      const removed = new Set()
      // Deterministic LCG so the sequence is reproducible across runs.
      let seed = 1
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 0x100000000
      }

      assert.doesNotThrow(() => {
        for (let i = 0; i < 500; i++) {
          const key = `client-${Math.floor(rand() * 50)}`
          if (rand() < 0.3 && limiter._clients.has(key)) {
            limiter.remove(key)
            removed.add(key)
          } else {
            limiter.check(key)
            removed.delete(key) // re-inserted
          }
        }
      })

      // Any key still in `removed` (i.e. not later re-checked) must be
      // absent from the limiter — remove() is the contract; the cursor
      // must never re-introduce a key it's iterating over.
      for (const key of removed) {
        assert.equal(
          limiter._clients.has(key),
          false,
          `${key} was removed and never re-checked; limiter must not hold it`,
        )
      }
    } finally {
      mock.timers.reset()
    }
  })
})

describe('RateLimiter eviction metering (#3996)', () => {
  // Capture rate-limit log lines emitted via createLogger('rate-limit'). The
  // global addLogListener bus is shared across tests, so each test installs
  // and removes its own listener to keep them isolated.
  //
  // Pin the log level to 'debug' before each test so the WARN emits we
  // assert on aren't filtered out by an inherited LOG_LEVEL=error from
  // another test or the env. Restore in afterEach so other suites that
  // depend on the inherited level still work.
  let logEntries
  let listener
  let savedLevel

  beforeEach(() => {
    savedLevel = getLogLevel()
    setLogLevel('debug')
    logEntries = []
    listener = (entry) => {
      if (entry.component === 'rate-limit') logEntries.push(entry)
    }
    addLogListener(listener)
  })

  afterEach(() => {
    removeLogListener(listener)
    setLogLevel(savedLevel)
  })

  it('starts with zero evictions and null lastEvictionAt', () => {
    const limiter = new RateLimiter({ maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: 5 })
    const stats = limiter.getEvictionStats()
    assert.equal(stats.evictionCount, 0)
    assert.equal(stats.lastEvictionAt, null)
    assert.equal(stats.mapSize, 0)
    assert.equal(stats.maxEntries, 5)
    assert.equal(stats.name, 'unnamed')
  })

  it('exposes the configured name in eviction stats', () => {
    const limiter = new RateLimiter({ name: 'http-permission', maxMessages: 1, burst: 0, windowMs: 60_000, maxEntries: 2 })
    assert.equal(limiter.getEvictionStats().name, 'http-permission')
  })

  it('counter matches the number of entries evicted under overflow', () => {
    const cap = 10
    const overflow = 25
    const limiter = new RateLimiter({
      name: 'test',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: cap,
      // Disable throttle so log assertions in other tests stay deterministic;
      // counter is what we're checking here, log behaviour is asserted below.
      evictionLogThrottleMs: 0,
    })
    // First `cap` inserts fill the map without evicting; every subsequent
    // unique-key insert evicts exactly one entry.
    for (let i = 0; i < cap + overflow; i++) {
      limiter.check(`client-${i}`)
    }
    const stats = limiter.getEvictionStats()
    assert.equal(stats.evictionCount, overflow, `expected ${overflow} evictions, got ${stats.evictionCount}`)
    assert.equal(stats.mapSize, cap)
    assert.ok(stats.lastEvictionAt !== null && stats.lastEvictionAt > 0, 'lastEvictionAt should be set after eviction')
  })

  it('does not increment counter when no eviction occurs (under cap)', () => {
    const limiter = new RateLimiter({ name: 'test', maxMessages: 100, burst: 0, windowMs: 60_000, maxEntries: 50 })
    for (let i = 0; i < 25; i++) {
      limiter.check(`client-${i}`)
    }
    assert.equal(limiter.getEvictionStats().evictionCount, 0)
    assert.equal(limiter.getEvictionStats().lastEvictionAt, null)
  })

  it('does not increment counter on repeated access by the same client', () => {
    const limiter = new RateLimiter({ name: 'test', maxMessages: 100, burst: 0, windowMs: 60_000, maxEntries: 5 })
    for (let i = 0; i < 50; i++) {
      limiter.check('client-1')
    }
    assert.equal(limiter.getEvictionStats().evictionCount, 0)
  })

  it('emits a WARN log line on the first eviction', () => {
    const limiter = new RateLimiter({
      name: 'first-evict',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 2,
      evictionLogThrottleMs: 60_000,
    })
    limiter.check('a')
    limiter.check('b')
    assert.equal(logEntries.length, 0, 'no log before first eviction')
    limiter.check('c') // triggers first eviction
    assert.equal(logEntries.length, 1, 'first eviction emits one log')
    assert.equal(logEntries[0].level, 'warn')
    assert.match(logEntries[0].message, /name=first-evict/)
    assert.match(logEntries[0].message, /cumulative=1/)
  })

  it('throttles subsequent rapid evictions to a single log line per window', () => {
    const limiter = new RateLimiter({
      name: 'throttled',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 5,
      // 60s window — well above what 100 synchronous check() calls take. If
      // throttle is broken we'll see a flood of log lines.
      evictionLogThrottleMs: 60_000,
    })
    // Fill + overflow with 100 unique keys to force 95 evictions.
    for (let i = 0; i < 100; i++) {
      limiter.check(`client-${i}`)
    }
    assert.equal(limiter.getEvictionStats().evictionCount, 95, 'all evictions counted')
    assert.equal(logEntries.length, 1, 'throttle suppressed every eviction log after the first')
  })

  it('counter still increments even when the log line is throttled', () => {
    // Regression guard: throttle must NOT short-circuit the counter — that
    // would defeat /diagnostics observability under attack.
    const limiter = new RateLimiter({
      name: 'counter-vs-throttle',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 3,
      evictionLogThrottleMs: 60_000,
    })
    for (let i = 0; i < 1000; i++) {
      limiter.check(`client-${i}`)
    }
    assert.equal(limiter.getEvictionStats().evictionCount, 997)
    assert.equal(logEntries.length, 1, 'log throttle held to a single line')
  })

  it('emits a fresh log line once the throttle window has elapsed', () => {
    // Use a 0ms throttle to simulate "throttle window has fully elapsed."
    // Real production runs at 60_000ms; tests can't realistically wait that
    // long, and using fake timers across the createLogger import boundary is
    // brittle. Throttle=0 still exercises the gate (the `<` comparison).
    const limiter = new RateLimiter({
      name: 'unthrottled',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 2,
      evictionLogThrottleMs: 0,
    })
    for (let i = 0; i < 5; i++) {
      limiter.check(`client-${i}`)
    }
    // 3 unique inserts past cap = 3 evictions = 3 log lines (no throttle).
    assert.equal(limiter.getEvictionStats().evictionCount, 3)
    assert.equal(logEntries.length, 3)
  })

  it('reports the burst count on a single check() call that evicts multiple entries', () => {
    // Hard to trigger naturally — check() only ever inserts one new key, so
    // the inner while-loop normally evicts exactly one entry. Construct the
    // scenario by pre-stuffing the map past its cap (shrinking maxEntries
    // under us is the realistic path: reload with a smaller cap).
    const limiter = new RateLimiter({
      name: 'burst',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 10,
      evictionLogThrottleMs: 60_000,
    })
    // Fill to cap.
    for (let i = 0; i < 10; i++) limiter.check(`client-${i}`)
    // Mutate the cap downward; the next insert must shed multiple at once.
    limiter._maxEntries = 3
    limiter.check('overflow') // expect 8 evictions in one go
    const stats = limiter.getEvictionStats()
    assert.equal(stats.evictionCount, 8)
    assert.equal(stats.mapSize, 3)
    assert.equal(logEntries.length, 1)
    assert.match(logEntries[0].message, /evicted 8 oldest entries/)
  })

  // #4005: windowed eviction rate. Cumulative count answers "has this ever
  // happened?"; the windowed count answers "is it happening RIGHT NOW?"
  // which is what alerting hooks need.

  it('reports zero evictionsInWindow when no evictions have occurred', () => {
    const limiter = new RateLimiter({
      name: 'no-evict',
      maxMessages: 100,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 50,
    })
    for (let i = 0; i < 25; i++) limiter.check(`client-${i}`)
    const stats = limiter.getEvictionStats()
    assert.equal(stats.evictionsInWindow, 0)
    assert.equal(stats.evictionWindowSaturated, false)
    // Default window is 60s.
    assert.equal(stats.evictionWindowMs, 60_000)
  })

  it('counts every recent eviction in evictionsInWindow', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const cap = 5
      const overflow = 12
      const limiter = new RateLimiter({
        name: 'window-count',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: cap,
        evictionWindowMs: 60_000,
        evictionLogThrottleMs: 0,
      })
      for (let i = 0; i < cap + overflow; i++) {
        limiter.check(`client-${i}`)
      }
      const stats = limiter.getEvictionStats()
      assert.equal(stats.evictionCount, overflow, 'cumulative')
      assert.equal(stats.evictionsInWindow, overflow, 'windowed')
      assert.equal(stats.evictionWindowSaturated, false)
    } finally {
      mock.timers.reset()
    }
  })

  it('rolls evictions out of evictionsInWindow once they age past the window', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        name: 'window-rollover',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: 2,
        evictionWindowMs: 60_000,
        evictionLogThrottleMs: 0,
      })
      // Fill + force 3 evictions at t=0
      limiter.check('a')
      limiter.check('b')
      limiter.check('c') // evicts a
      limiter.check('d') // evicts b
      limiter.check('e') // evicts c
      assert.equal(limiter.getEvictionStats().evictionsInWindow, 3, 'all three at t=0')

      // Just before the window expires: still all three.
      mock.timers.tick(59_999)
      assert.equal(limiter.getEvictionStats().evictionsInWindow, 3, 'still in window')

      // Cross the window boundary: the t=0 evictions roll off.
      mock.timers.tick(2)
      const stats = limiter.getEvictionStats()
      assert.equal(stats.evictionsInWindow, 0, 'rolled out of window')
      // Cumulative is monotonic — must NOT decay.
      assert.equal(stats.evictionCount, 3, 'cumulative untouched')
    } finally {
      mock.timers.reset()
    }
  })

  it('tracks a sliding window: old evictions roll off as new ones arrive', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        name: 'sliding',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: 1,
        evictionWindowMs: 10_000,
        evictionLogThrottleMs: 0,
      })
      // Two evictions at t=0
      limiter.check('a')
      limiter.check('b') // evicts a
      limiter.check('c') // evicts b
      assert.equal(limiter.getEvictionStats().evictionsInWindow, 2)

      // Advance 8s, add one more eviction
      mock.timers.tick(8_000)
      limiter.check('d') // evicts c at t=8000
      assert.equal(limiter.getEvictionStats().evictionsInWindow, 3, '3 evictions still in 10s window')

      // Advance 3s more (t=11_000): the t=0 evictions are now outside the
      // 10s window but the t=8_000 one is still inside.
      mock.timers.tick(3_000)
      const stats = limiter.getEvictionStats()
      assert.equal(stats.evictionsInWindow, 1, 'only the t=8s eviction remains')
      assert.equal(stats.evictionCount, 3, 'cumulative untouched')
    } finally {
      mock.timers.reset()
    }
  })

  it('respects the configured evictionWindowMs override', () => {
    const limiter = new RateLimiter({
      name: 'custom-window',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 10,
      evictionWindowMs: 300_000,
    })
    assert.equal(limiter.getEvictionStats().evictionWindowMs, 300_000)
  })

  it('falls back to the default window when evictionWindowMs is invalid', () => {
    // Negative, zero, NaN, non-integer, non-number all coerce to default.
    for (const bad of [-1, 0, NaN, 1.5, 'sixty', null]) {
      const limiter = new RateLimiter({
        name: 'invalid-window',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: 10,
        evictionWindowMs: bad,
      })
      assert.equal(
        limiter.getEvictionStats().evictionWindowMs,
        60_000,
        `evictionWindowMs=${String(bad)} must fall back to 60_000`,
      )
    }
  })

  it('caps the eviction-timestamp buffer to bound memory under attack', () => {
    // Attacker rotating IPs at line rate must not OOM the limiter via the
    // eviction-rate history. Past the cap we degrade to a saturated flag
    // rather than holding unbounded timestamps.
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        name: 'saturated',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: 1,
        evictionWindowMs: 60_000,
        evictionLogThrottleMs: 60_000,
      })
      // Force well over 1024 evictions in a single window.
      for (let i = 0; i < 5_000; i++) {
        limiter.check(`flood-${i}`)
      }
      const stats = limiter.getEvictionStats()
      // Cumulative is unaffected — operators still see the magnitude.
      assert.equal(stats.evictionCount, 4_999)
      // Buffer capped → saturated flag set.
      assert.equal(stats.evictionWindowSaturated, true, 'saturated under flood')
      // Internal buffer must not exceed the documented cap.
      assert.ok(
        limiter._evictionTimestamps.length <= 1024,
        `buffer length ${limiter._evictionTimestamps.length} must stay <=1024`,
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('clears the saturated flag once the window drains', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        name: 'saturate-then-drain',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: 1,
        evictionWindowMs: 60_000,
        evictionLogThrottleMs: 60_000,
      })
      for (let i = 0; i < 5_000; i++) {
        limiter.check(`flood-${i}`)
      }
      assert.equal(limiter.getEvictionStats().evictionWindowSaturated, true)
      // Advance past the eviction window — buffer drains.
      mock.timers.tick(60_001)
      const stats = limiter.getEvictionStats()
      assert.equal(stats.evictionWindowSaturated, false, 'flag clears after drain')
      assert.equal(stats.evictionsInWindow, 0)
    } finally {
      mock.timers.reset()
    }
  })

  // Regression for the post-#4005 review hazard: pre-fix the saturated
  // flag only cleared when the eviction-rate buffer emptied. Low-rate
  // evictions following a saturation burst keep the buffer non-empty
  // indefinitely, so the flag would stay true forever — misleading
  // /diagnostics long after the actual saturation event aged out. Fix
  // tracks _lastSaturationAt and clears the flag once that timestamp
  // ages past the window cutoff (regardless of buffer occupancy).
  it('clears the saturated flag once the LAST saturation event ages out, even under continuing low-rate evictions', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const limiter = new RateLimiter({
        name: 'saturate-then-trickle',
        maxMessages: 1,
        burst: 0,
        windowMs: 60_000,
        maxEntries: 1,
        evictionWindowMs: 60_000,
        evictionLogThrottleMs: 60_000,
      })
      // Saturate the eviction-rate buffer at t=0.
      for (let i = 0; i < 2_000; i++) {
        limiter.check(`flood-${i}`)
      }
      assert.equal(limiter.getEvictionStats().evictionWindowSaturated, true,
        'should saturate after a 2k-eviction burst')
      // Trickle at t=5..55s — each call re-saturates because the t=0
      // flood is still occupying the entire buffer (no headroom). After
      // the t=60s mark, the flood drops out, headroom appears, and
      // trickles stop saturating. The last saturating event was the
      // t=55s trickle.
      for (let i = 1; i <= 11; i++) {
        mock.timers.tick(5_000)
        limiter.check(`trickle-${i}`)
      }
      // Trickle out to t=120s — none of these saturate, but they keep
      // the buffer non-empty. Pre-fix this would have kept the flag
      // stuck true forever. Post-fix: at t=55s + 60s = 115s, the last
      // saturation event ages out and the flag clears.
      for (let i = 12; i <= 24; i++) {
        mock.timers.tick(5_000)
        limiter.check(`trickle-${i}`)
      }
      const stats = limiter.getEvictionStats()
      assert.equal(stats.evictionWindowSaturated, false,
        'saturated flag must clear once the LAST saturation event ages out, even if newer non-saturating evictions keep the buffer non-empty')
      assert.ok(stats.evictionsInWindow > 0,
        'recent trickle evictions are still recorded after the saturation event ages out')
    } finally {
      mock.timers.reset()
    }
  })

  it('clear() also clears the eviction-rate window', () => {
    const limiter = new RateLimiter({
      name: 'clear',
      maxMessages: 1,
      burst: 0,
      windowMs: 60_000,
      maxEntries: 2,
      evictionWindowMs: 60_000,
      evictionLogThrottleMs: 0,
    })
    for (let i = 0; i < 10; i++) limiter.check(`client-${i}`)
    assert.ok(limiter.getEvictionStats().evictionsInWindow > 0)
    limiter.clear()
    const stats = limiter.getEvictionStats()
    assert.equal(stats.evictionsInWindow, 0, 'clear() drains the window')
    assert.equal(stats.evictionWindowSaturated, false)
    // clear() leaves the cumulative counter alone — that's the long-lived
    // diagnostic. (See existing #3996 contract: cumulative resets only on
    // process restart.)
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
