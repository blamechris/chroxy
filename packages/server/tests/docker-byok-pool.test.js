import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  DockerContainerPool,
  buildPoolKey,
  isPoolEnabled,
  getSharedPool,
  _resetSharedPool,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PER_KEY,
  DEFAULT_MAX_TOTAL,
  DEFAULT_MAX_AGE_MS,
} from '../src/docker-byok-pool.js'

/**
 * Tests for the docker-byok idle container pool (#5022).
 *
 * The pool itself does only two things: bucket idle containers by key,
 * and `docker rm -f` evicted ones. All shellouts are stubbed via
 * `_execFile` so no real Docker daemon is required.
 */

/**
 * Build a stub `execFile` that records `docker rm -f` calls and returns
 * canned results. Same shape as the session-test stub but trimmed to
 * the `rm` subcommand.
 */
function execFileStub({ rmError = null } = {}) {
  const calls = []
  const fn = (cmd, args, _opts, callback) => {
    calls.push({ cmd, args: [...args] })
    if (typeof callback !== 'function') return
    if (rmError) {
      const err = rmError instanceof Error ? rmError : new Error(rmError)
      callback(err)
      return
    }
    callback(null, '', '')
  }
  fn.calls = calls
  return fn
}

/**
 * Inline timer stubs so a 5-minute idle timeout doesn't actually block
 * the test runner. The fake `setTimeout` returns a token; the test fires
 * the callback manually via `runTimer(token)`.
 */
function timerStubs() {
  const timers = new Map()
  let nextId = 1
  const setT = (cb, _ms) => {
    const id = nextId++
    timers.set(id, { cb, cleared: false })
    return id
  }
  const clearT = (id) => {
    const t = timers.get(id)
    if (t) t.cleared = true
  }
  return {
    setT,
    clearT,
    runTimer(id) {
      const t = timers.get(id)
      if (!t || t.cleared) throw new Error(`timer ${id} cleared or unknown`)
      timers.delete(id)
      t.cb()
    },
    pending() {
      return [...timers.entries()].filter(([, t]) => !t.cleared).map(([id]) => id)
    },
  }
}

describe('buildPoolKey()', () => {
  it('joins the five shape fields with |', () => {
    const key = buildPoolKey({
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    })
    assert.equal(key, 'node:22-slim|/host/cwd|2g|2|chroxy')
  })

  it('throws when any required field is missing', () => {
    assert.throws(() => buildPoolKey({ image: 'x', cwd: '/y' }), /required/)
  })

  it('throws when spec is not an object', () => {
    assert.throws(() => buildPoolKey(null), /required/)
  })

  // #5080: optional devcontainer-overlay fingerprint
  it('omits the fingerprint segment when devcontainerFingerprint is null', () => {
    const key = buildPoolKey({
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      devcontainerFingerprint: null,
    })
    // Backward compat: pre-#5080 callers (no fingerprint at all) and
    // explicit null both produce the same 5-segment key.
    assert.equal(key, 'node:22-slim|/host/cwd|2g|2|chroxy')
  })

  it('omits the fingerprint segment when devcontainerFingerprint is undefined', () => {
    const key = buildPoolKey({
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      devcontainerFingerprint: undefined,
    })
    assert.equal(key, 'node:22-slim|/host/cwd|2g|2|chroxy')
  })

  it('omits the fingerprint segment when devcontainerFingerprint is empty string', () => {
    const key = buildPoolKey({
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      devcontainerFingerprint: '',
    })
    assert.equal(key, 'node:22-slim|/host/cwd|2g|2|chroxy')
  })

  it('appends the fingerprint as a trailing segment when supplied', () => {
    const key = buildPoolKey({
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      devcontainerFingerprint: 'abcdef1234567890',
    })
    assert.equal(key, 'node:22-slim|/host/cwd|2g|2|chroxy|abcdef1234567890')
  })

  it('two different fingerprints produce two different keys (cache-bust on devcontainer.json change)', () => {
    const base = {
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    }
    const oldKey = buildPoolKey({ ...base, devcontainerFingerprint: 'oldfingerprint01' })
    const newKey = buildPoolKey({ ...base, devcontainerFingerprint: 'newfingerprint02' })
    assert.notEqual(oldKey, newKey)
  })

  it('same fingerprint produces the same key (warm pool hit on unchanged devcontainer.json)', () => {
    const base = {
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
      devcontainerFingerprint: 'samefingerprint1',
    }
    assert.equal(buildPoolKey(base), buildPoolKey({ ...base }))
  })

  it('devcontainer session and non-devcontainer session produce DIFFERENT keys for the same resource shape', () => {
    // Otherwise a non-devcontainer session could acquire a container
    // provisioned with a devcontainer overlay (different env / mounts),
    // which would silently surface the overlay state.
    const base = {
      image: 'node:22-slim',
      cwd: '/host/cwd',
      memoryLimit: '2g',
      cpuLimit: '2',
      containerUser: 'chroxy',
    }
    const plain = buildPoolKey(base)
    const dc = buildPoolKey({ ...base, devcontainerFingerprint: 'feedfacedeadbeef' })
    assert.notEqual(plain, dc)
  })
})

describe('isPoolEnabled()', () => {
  it('returns false for undefined / empty', () => {
    assert.equal(isPoolEnabled({}), false)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: '' }), false)
  })

  it('returns true for truthy string values', () => {
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: '1' }), true)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: 'true' }), true)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: 'yes' }), true)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: 'on' }), true)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: 'TRUE' }), true)
  })

  it('returns false for falsy strings', () => {
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: '0' }), false)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: 'false' }), false)
    assert.equal(isPoolEnabled({ CHROXY_DOCKER_BYOK_POOL: 'off' }), false)
  })
})

describe('DockerContainerPool — defaults', () => {
  it('exports stable default constants', () => {
    assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 5 * 60 * 1000)
    assert.equal(DEFAULT_MAX_PER_KEY, 2)
    assert.equal(DEFAULT_MAX_TOTAL, 8)
    assert.equal(DEFAULT_MAX_AGE_MS, 30 * 60 * 1000)
  })

  it('starts empty', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    assert.equal(pool.size(), 0)
    assert.equal(pool.sizeOf('any-key'), 0)
    assert.equal(pool.acquire('any-key'), null)
  })

  it('#6135 limits() reports the configured bounds (read-only)', () => {
    const pool = new DockerContainerPool({
      _execFile: execFileStub(),
      idleTimeoutMs: 1000,
      maxPerKey: 3,
      maxTotal: 9,
      maxAgeMs: 60000,
    })
    assert.deepEqual(pool.limits(), { idleTimeoutMs: 1000, maxPerKey: 3, maxTotal: 9, maxAgeMs: 60000 })
  })

  it('#6135 limits() reports maxAgeMs:null when unbounded (Infinity)', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub(), maxAgeMs: Infinity })
    assert.equal(pool.limits().maxAgeMs, null)
  })
})

describe('DockerContainerPool acquire / release', () => {
  let timers
  let execFile
  let pool

  beforeEach(() => {
    timers = timerStubs()
    execFile = execFileStub()
    pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
  })

  it('release puts a container into the pool, acquire pulls it back out', async () => {
    const key = 'shape-a'
    const kept = await pool.release(key, 'CONTAINER_A')
    assert.equal(kept, true)
    assert.equal(pool.size(), 1)
    assert.equal(pool.sizeOf(key), 1)

    const acquired = pool.acquire(key)
    assert.equal(acquired, 'CONTAINER_A')
    assert.equal(pool.size(), 0, 'acquire removes the entry from the pool')
    // The idle timer for the acquired entry must be cleared so it
    // doesn't fire after the session has the container.
    assert.equal(timers.pending().length, 0)
  })

  it('acquire returns null on a miss', () => {
    assert.equal(pool.acquire('nothing-here'), null)
  })

  it('different keys do not collide', async () => {
    await pool.release('shape-a', 'CONTAINER_A')
    await pool.release('shape-b', 'CONTAINER_B')
    assert.equal(pool.size(), 2)
    assert.equal(pool.acquire('shape-a'), 'CONTAINER_A')
    assert.equal(pool.acquire('shape-b'), 'CONTAINER_B')
    assert.equal(pool.size(), 0)
  })

  it('release over per-key cap evicts immediately', async () => {
    const small = new DockerContainerPool({
      maxPerKey: 1,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    assert.equal(await small.release('k', 'C1'), true)
    assert.equal(await small.release('k', 'C2'), false, 'second release over cap must evict')
    assert.equal(small.size(), 1)
    // The evicted container was docker-rm-f'd.
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('C2'))
  })

  it('release over total cap evicts immediately', async () => {
    const small = new DockerContainerPool({
      maxTotal: 1,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    assert.equal(await small.release('k1', 'C1'), true)
    assert.equal(await small.release('k2', 'C2'), false)
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('C2'))
  })

  it('FIFO order: first released is first acquired', async () => {
    await pool.release('shape', 'C1')
    await pool.release('shape', 'C2')
    assert.equal(pool.acquire('shape'), 'C1')
    assert.equal(pool.acquire('shape'), 'C2')
  })
})

describe('DockerContainerPool — idle eviction', () => {
  it('fires docker rm -f when the idle timer fires', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('k', 'CONTAINER_IDLE')
    assert.equal(pool.size(), 1)

    const pending = timers.pending()
    assert.equal(pending.length, 1, 'release schedules exactly one idle timer')

    // Fire the timer.
    timers.runTimer(pending[0])

    // Drain microtasks so the async _evict() resolves.
    await new Promise((r) => setImmediate(r))

    assert.equal(pool.size(), 0, 'expired entry removed from pool')
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('CONTAINER_IDLE'))
  })

  it('eviction in the middle of a session does not affect held containers', async () => {
    // Cache-eviction-mid-session: a session has already ACQUIRED the
    // container, so there is no entry in the pool — the idle timer
    // doesn't apply. New release with the same id starts a fresh timer.
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('k', 'CONTAINER_X')
    assert.equal(pool.acquire('k'), 'CONTAINER_X')
    // While the session holds the container, no idle timer is active.
    assert.equal(timers.pending().length, 0)
    // Releasing again starts a fresh timer.
    await pool.release('k', 'CONTAINER_X')
    assert.equal(timers.pending().length, 1)
  })
})

describe('DockerContainerPool — shutdown', () => {
  it('drains all entries via docker rm -f', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('k1', 'C1')
    await pool.release('k2', 'C2')
    assert.equal(pool.size(), 2)

    await pool.shutdown()
    assert.equal(pool.size(), 0)
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 2)
    const ids = rmCalls.map((c) => c.args[c.args.length - 1]).sort()
    assert.deepEqual(ids, ['C1', 'C2'])
  })

  it('acquire returns null after shutdown', async () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    await pool.release('k', 'C1')
    await pool.shutdown()
    assert.equal(pool.acquire('k'), null)
  })

  it('release after shutdown evicts inline', async () => {
    const execFile = execFileStub()
    const pool = new DockerContainerPool({ _execFile: execFile })
    await pool.shutdown()
    const kept = await pool.release('k', 'C_LATE')
    assert.equal(kept, false)
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('C_LATE'))
  })
})

describe('DockerContainerPool — markSoiled() (#5043)', () => {
  /**
   * A "soiled" container is one whose filesystem may have leaked into a
   * snapshot image layer (or otherwise become coupled to a specific
   * conversation). It MUST NOT be returned to the pool for another
   * session to acquire. The session marks the container soiled when it
   * takes a snapshot, then calls release() as normal — the pool
   * intercepts the release and evicts inline instead of pooling.
   *
   * This is the design hook for #5023 (docker-byok snapshot/restore).
   */
  it('release after markSoiled evicts instead of pooling', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    pool.markSoiled('CONTAINER_SOILED')
    const kept = await pool.release('k', 'CONTAINER_SOILED')
    assert.equal(kept, false, 'soiled container must NOT be retained')
    assert.equal(pool.size(), 0)
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('CONTAINER_SOILED'))
    // After eviction the soiled tracking entry is cleared so the same
    // container id (if docker recycles ids in a future run) isn't
    // poisoned forever.
    assert.equal(pool.isSoiled('CONTAINER_SOILED'), false)
  })

  it('markSoiled is idempotent — calling twice is a no-op', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    pool.markSoiled('CONTAINER_DUP')
    pool.markSoiled('CONTAINER_DUP')
    assert.equal(pool.isSoiled('CONTAINER_DUP'), true)
  })

  it('markSoiled ignores null / empty container ids', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    pool.markSoiled(null)
    pool.markSoiled('')
    pool.markSoiled(undefined)
    assert.equal(pool.isSoiled(null), false)
    assert.equal(pool.isSoiled(''), false)
  })

  it('soiled marker only affects the specific container id', async () => {
    const pool = new DockerContainerPool({
      _execFile: execFileStub(),
      _setTimeout: timerStubs().setT,
      _clearTimeout: timerStubs().clearT,
    })
    pool.markSoiled('CONTAINER_A')
    // Releasing a DIFFERENT id with the same key still works normally.
    const kept = await pool.release('k', 'CONTAINER_B')
    assert.equal(kept, true)
    assert.equal(pool.size(), 1)
  })

  it('shutdown clears the soiled set', async () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    pool.markSoiled('CONTAINER_X')
    assert.equal(pool.isSoiled('CONTAINER_X'), true)
    await pool.shutdown()
    assert.equal(pool.isSoiled('CONTAINER_X'), false)
  })

  /**
   * Defense-in-depth check (#5049): the documented session lifecycle
   * never lets `markSoiled(id)` race against `release()` — `destroy()`
   * nulls `_containerId` before calling `pool.release()`, so the marker
   * can only fire while the container is acquired (not pooled). But the
   * public `markSoiled(id)` API takes any id, and a future non-session
   * caller (dashboard endpoint, admin tool, snapshot helper that bypasses
   * the session) could mark an already-pooled id. Without this check the
   * next `acquire()` would silently hand it out before the soiled marker
   * fires on release.
   *
   * Fix: in `acquire()`, after popping an entry from the bucket, check
   * `this._soiledIds.has(entry.containerId)`. If so, evict it inline and
   * continue draining the bucket until a non-soiled entry surfaces (or
   * the bucket is empty, returning null).
   */
  it('acquire skips a soiled container in the pool and evicts it inline', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    // Seed the bucket the normal way, then mark the pooled id soiled
    // out-of-band — simulating a future caller that bypasses the session.
    await pool.release('k', 'POOLED_THEN_SOILED')
    assert.equal(pool.size(), 1)
    pool.markSoiled('POOLED_THEN_SOILED')
    const got = pool.acquire('k')
    assert.equal(got, null, 'soiled pool entry must NOT be returned to caller')
    assert.equal(pool.size(), 0, 'soiled pool entry must be removed from the pool')
    // Drain microtasks so the async _evict() runs.
    await new Promise((r) => setImmediate(r))
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1, 'soiled pool entry must be docker rm -f')
    assert.ok(rmCalls[0].args.includes('POOLED_THEN_SOILED'))
    // The soiled marker is consumed on the inline acquire-time eviction
    // so the same id doesn't stay poisoned forever (matches the
    // release-path semantics).
    assert.equal(pool.isSoiled('POOLED_THEN_SOILED'), false)
  })

  it('acquire skips a soiled head entry and returns the next clean one in the bucket', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      maxPerKey: 5,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('k', 'SOILED_HEAD')
    await pool.release('k', 'CLEAN_NEXT')
    pool.markSoiled('SOILED_HEAD')
    const got = pool.acquire('k')
    assert.equal(got, 'CLEAN_NEXT', 'must skip past soiled entry to reach a clean one')
    await new Promise((r) => setImmediate(r))
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('SOILED_HEAD'))
    // The clean entry is now held by the caller, pool is empty.
    assert.equal(pool.size(), 0)
  })
})

describe('DockerContainerPool — max age (#5045)', () => {
  it('acquire evicts and reports miss when the head entry is over max age', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      maxAgeMs: 1000,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    await pool.release('k', 'OLD_CONTAINER')
    assert.equal(pool.size(), 1)
    // Advance past the max-age threshold.
    now += 1500
    const got = pool.acquire('k')
    assert.equal(got, null, 'over-age entry must NOT be returned to caller')
    assert.equal(pool.size(), 0, 'over-age entry must be removed from the pool')
    // Drain microtasks so the async _evict() runs.
    await new Promise((r) => setImmediate(r))
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1, 'over-age entry must be docker rm -f')
    assert.ok(rmCalls[0].args.includes('OLD_CONTAINER'))
  })

  it('acquire skips over-age entries and returns the next valid one in the bucket', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      maxAgeMs: 1000,
      maxPerKey: 5,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    await pool.release('k', 'OLD_1')
    await pool.release('k', 'OLD_2')
    // Both entries are now over age.
    now += 2000
    await pool.release('k', 'FRESH')
    const got = pool.acquire('k')
    assert.equal(got, 'FRESH', 'must skip past over-age entries to reach a fresh one')
    await new Promise((r) => setImmediate(r))
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    const evicted = rmCalls.map((c) => c.args[c.args.length - 1]).sort()
    assert.deepEqual(evicted, ['OLD_1', 'OLD_2'])
  })

  it('release rejects an over-age container and evicts inline', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      maxAgeMs: 1000,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    // First release happens at t=0; second-acquire/release simulates a
    // session that held the container for longer than maxAgeMs.
    await pool.release('k', 'C1')
    assert.equal(pool.acquire('k'), 'C1')
    now += 2000
    const kept = await pool.release('k', 'C1')
    assert.equal(kept, false, 'release of over-age container must NOT pool it')
    assert.equal(pool.size(), 0)
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('C1'))
  })

  it('release tracks createdAt from the FIRST release, not the most recent', async () => {
    // A container that's been bounced through the pool many times is
    // still "old" for max-age purposes — we cap total lifetime, not
    // time-since-last-release.
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      maxAgeMs: 1000,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    await pool.release('k', 'C1') // createdAt recorded here at t=1_000_000
    assert.equal(pool.acquire('k'), 'C1')
    now += 500 // still under max age
    await pool.release('k', 'C1')
    assert.equal(pool.acquire('k'), 'C1')
    now += 600 // now total age > 1000ms
    const kept = await pool.release('k', 'C1')
    assert.equal(kept, false, 'lifetime exceeds cap even though the latest hold was short')
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('C1'))
  })
})

describe('DockerContainerPool — structured events (#5044)', () => {
  /**
   * The pool exposes an EventEmitter surface so ops/dashboards can
   * count hits, misses, releases and evictions without scraping log
   * lines. Every event carries a `{ key, containerId, timestamp, ... }`
   * payload; evictions additionally tag a `reason` so the caller can
   * break the count down by cause (idle / over_cap / shutdown).
   *
   * The pool is opt-in (CHROXY_DOCKER_BYOK_POOL=1) so the emitter only
   * needs to behave sanely when actually in use — but it must always
   * be present (no listener-side null checks).
   */

  function collect(pool, events) {
    const seen = []
    for (const name of events) {
      pool.on(name, (payload) => seen.push({ name, payload }))
    }
    return seen
  }

  it('emits pool:miss on acquire miss and pool:hit on acquire hit', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    const seen = collect(pool, ['pool:hit', 'pool:miss', 'pool:released'])

    // First acquire — bucket is empty → miss.
    assert.equal(pool.acquire('shape-a'), null)
    // Release fills the bucket.
    await pool.release('shape-a', 'CONTAINER_A')
    // Second acquire — hit.
    assert.equal(pool.acquire('shape-a'), 'CONTAINER_A')

    const miss = seen.find((e) => e.name === 'pool:miss')
    const hit = seen.find((e) => e.name === 'pool:hit')
    const released = seen.find((e) => e.name === 'pool:released')

    assert.ok(miss, 'pool:miss must fire on empty acquire')
    assert.equal(miss.payload.key, 'shape-a')
    assert.equal(miss.payload.containerId, null)
    assert.equal(typeof miss.payload.timestamp, 'number')

    assert.ok(released, 'pool:released must fire when a container is handed back')
    assert.equal(released.payload.key, 'shape-a')
    assert.equal(released.payload.containerId, 'CONTAINER_A')
    assert.equal(typeof released.payload.timestamp, 'number')

    assert.ok(hit, 'pool:hit must fire on successful acquire')
    assert.equal(hit.payload.key, 'shape-a')
    assert.equal(hit.payload.containerId, 'CONTAINER_A')
    assert.equal(typeof hit.payload.timestamp, 'number')
  })

  it('tags eviction reason as over_cap when release exceeds the per-key cap', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      maxPerKey: 1,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    const seen = collect(pool, ['pool:evicted'])
    await pool.release('k', 'C1')
    await pool.release('k', 'C2')

    assert.equal(seen.length, 1)
    assert.equal(seen[0].payload.key, 'k')
    assert.equal(seen[0].payload.containerId, 'C2')
    assert.equal(seen[0].payload.reason, 'over_cap')
    assert.equal(typeof seen[0].payload.timestamp, 'number')
  })

  it('tags eviction reason as idle when the idle timer fires', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    const seen = collect(pool, ['pool:evicted'])
    await pool.release('k', 'C_IDLE')
    const pending = timers.pending()
    timers.runTimer(pending[0])
    await new Promise((r) => setImmediate(r))

    assert.equal(seen.length, 1)
    assert.equal(seen[0].payload.reason, 'idle')
    assert.equal(seen[0].payload.containerId, 'C_IDLE')
    assert.equal(seen[0].payload.key, 'k')
  })

  it('shutdown emits pool:evicted{reason:shutdown} per container then a final pool:shutdown', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    const seen = collect(pool, ['pool:evicted', 'pool:shutdown'])
    await pool.release('k1', 'C1')
    await pool.release('k2', 'C2')
    await pool.shutdown()

    const evictions = seen.filter((e) => e.name === 'pool:evicted')
    assert.equal(evictions.length, 2)
    for (const ev of evictions) {
      assert.equal(ev.payload.reason, 'shutdown')
      assert.ok(['C1', 'C2'].includes(ev.payload.containerId))
    }
    const shutdownEvents = seen.filter((e) => e.name === 'pool:shutdown')
    assert.equal(shutdownEvents.length, 1)
    assert.equal(typeof shutdownEvents[0].payload.timestamp, 'number')
    assert.equal(shutdownEvents[0].payload.drained, 2)
    // Ordering: every per-container eviction must precede the final
    // pool:shutdown so a listener that aggregates can drain its
    // counters before the "done" signal.
    const lastIdx = seen.length - 1
    assert.equal(seen[lastIdx].name, 'pool:shutdown')
  })

  it('release after shutdown emits pool:evicted{reason:shutdown}', async () => {
    const execFile = execFileStub()
    const pool = new DockerContainerPool({ _execFile: execFile })
    await pool.shutdown()
    const seen = collect(pool, ['pool:evicted'])
    await pool.release('k', 'C_LATE')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].payload.reason, 'shutdown')
    assert.equal(seen[0].payload.containerId, 'C_LATE')
  })

  it('is an EventEmitter — .on / .off / .removeAllListeners work', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    assert.equal(typeof pool.on, 'function')
    assert.equal(typeof pool.off, 'function')
    assert.equal(typeof pool.emit, 'function')
    assert.equal(typeof pool.removeAllListeners, 'function')
  })
})

describe('getSharedPool() — singleton + env wiring', () => {
  beforeEach(() => _resetSharedPool())
  afterEach(() => _resetSharedPool())

  it('returns null when pooling is disabled', () => {
    assert.equal(getSharedPool({}), null)
    assert.equal(getSharedPool({ CHROXY_DOCKER_BYOK_POOL: '0' }), null)
  })

  it('returns a singleton when enabled', () => {
    const a = getSharedPool({ CHROXY_DOCKER_BYOK_POOL: '1' })
    const b = getSharedPool({ CHROXY_DOCKER_BYOK_POOL: '1' })
    assert.ok(a instanceof DockerContainerPool)
    assert.equal(a, b)
  })

  it('honors override env vars', () => {
    const pool = getSharedPool({
      CHROXY_DOCKER_BYOK_POOL: '1',
      CHROXY_DOCKER_BYOK_POOL_IDLE_MS: '15000',
      CHROXY_DOCKER_BYOK_POOL_MAX_PER_KEY: '5',
      CHROXY_DOCKER_BYOK_POOL_MAX_TOTAL: '20',
      CHROXY_DOCKER_BYOK_POOL_MAX_AGE_MS: '120000',
    })
    assert.equal(pool._idleTimeoutMs, 15000)
    assert.equal(pool._maxPerKey, 5)
    assert.equal(pool._maxTotal, 20)
    assert.equal(pool._maxAgeMs, 120000)
  })

  it('defaults max-age when env var is unset', () => {
    const pool = getSharedPool({ CHROXY_DOCKER_BYOK_POOL: '1' })
    assert.equal(pool._maxAgeMs, DEFAULT_MAX_AGE_MS)
  })

  it('honors CHROXY_DOCKER_BYOK_POOL_MAX_AGE_MS=Infinity as an opt-out', () => {
    // Documented opt-out path: pass `Infinity` to disable the cap.
    // Constructor accepts `Infinity` directly; env wiring has to parse
    // the string `'Infinity'` because `isFinite(Infinity) === false`
    // and would otherwise silently fall back to the 30-min default.
    const pool = getSharedPool({
      CHROXY_DOCKER_BYOK_POOL: '1',
      CHROXY_DOCKER_BYOK_POOL_MAX_AGE_MS: 'Infinity',
    })
    assert.equal(pool._maxAgeMs, Infinity)
  })

  it('honors lowercase `infinity` env value as an opt-out', () => {
    const pool = getSharedPool({
      CHROXY_DOCKER_BYOK_POOL: '1',
      CHROXY_DOCKER_BYOK_POOL_MAX_AGE_MS: 'infinity',
    })
    assert.equal(pool._maxAgeMs, Infinity)
  })
})

describe('DockerContainerPool — forget() (#5045 review)', () => {
  it('clears _createdAt and docker rm -f s the container', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('k', 'C1')
    // After release, _createdAt has the entry.
    assert.equal(pool._createdAt.has('C1'), true)
    assert.equal(pool.acquire('k'), 'C1')
    // After acquire, _createdAt STILL has the entry (preserved across
    // hold so a follow-up release keeps lifetime). forget() is the path
    // the caller uses when they decide NOT to release.
    assert.equal(pool._createdAt.has('C1'), true)
    await pool.forget('C1')
    assert.equal(pool._createdAt.has('C1'), false)
    const rmCalls = execFile.calls.filter((c) => c.args[0] === 'rm')
    assert.equal(rmCalls.length, 1)
    assert.ok(rmCalls[0].args.includes('C1'))
  })

  it('is idempotent on an unknown container id', async () => {
    const execFile = execFileStub()
    const pool = new DockerContainerPool({ _execFile: execFile })
    await pool.forget('NEVER_SEEN')
    // Still runs docker rm -f — that's the contract; the pool can't
    // tell whether the id is real or stale, and the caller is asserting
    // it is. rm -f's "no such container" path is already swallowed in
    // _evict.
    assert.equal(execFile.calls.filter((c) => c.args[0] === 'rm').length, 1)
  })

  it('silently ignores null/empty container id', async () => {
    const execFile = execFileStub()
    const pool = new DockerContainerPool({ _execFile: execFile })
    await pool.forget('')
    await pool.forget(null)
    await pool.forget(undefined)
    assert.equal(execFile.calls.length, 0, 'must not call docker rm -f with an empty id')
  })
})

describe('DockerContainerPool — inspect() (#5052)', () => {
  /**
   * `inspect()` is a read-only snapshot of what's currently parked in the
   * pool. The event stream (#5044) answers "what did the pool do in the
   * last 60s?"; `inspect()` answers "what's parked right now, and for how
   * long?" — feeding the dashboard pool-health panel (#5053).
   *
   * Contract per #5052:
   *   - Returns an Array of `{ key, size, oldestIdleMs }` — one entry per
   *     non-empty bucket.
   *   - Sorted by `key` ascending so the output is stable for tests and
   *     dashboard diffs.
   *   - `oldestIdleMs` = `now - min(releasedAt for entry in bucket)`, i.e.
   *     `max(now - releasedAt)` — the idle age of the OLDEST parked entry.
   *   - SHALLOW snapshot: caller mutations to the returned array MUST NOT
   *     leak back into pool state (no live Map / array references).
   *   - `release()` stamps `releasedAt` on every entry so `oldestIdleMs`
   *     can be computed without iterating timers.
   */

  it('returns an empty array on an empty pool', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    const snap = pool.inspect()
    assert.ok(Array.isArray(snap))
    assert.equal(snap.length, 0)
  })

  it('returns one entry per non-empty bucket with key, size, oldestIdleMs', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    await pool.release('shape-a', 'C1')
    now += 250
    const snap = pool.inspect()
    assert.equal(snap.length, 1)
    assert.equal(snap[0].key, 'shape-a')
    assert.equal(snap[0].size, 1)
    assert.equal(snap[0].oldestIdleMs, 250)
  })

  it('computes oldestIdleMs from the OLDEST entry in the bucket (highest age)', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      maxPerKey: 5,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    await pool.release('shape', 'OLD') // releasedAt = 1_000_000
    now += 1000
    await pool.release('shape', 'NEW') // releasedAt = 1_001_000
    now += 500 // inspect at 1_001_500
    const snap = pool.inspect()
    assert.equal(snap.length, 1)
    assert.equal(snap[0].key, 'shape')
    assert.equal(snap[0].size, 2)
    // OLD's idle age: 1_001_500 - 1_000_000 = 1500
    // NEW's idle age: 1_001_500 - 1_001_000 = 500
    // oldestIdleMs picks the larger one — the oldest entry.
    assert.equal(snap[0].oldestIdleMs, 1500)
  })

  it('returns buckets sorted by key ascending (stable output)', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    // Release in non-alphabetical order; inspect() must still sort asc.
    await pool.release('shape-c', 'C_C')
    await pool.release('shape-a', 'C_A')
    await pool.release('shape-b', 'C_B')
    const snap = pool.inspect()
    assert.deepEqual(snap.map((b) => b.key), ['shape-a', 'shape-b', 'shape-c'])
  })

  it('omits empty buckets — only non-empty buckets appear in the snapshot', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('shape-keep', 'C_KEEP')
    await pool.release('shape-drain', 'C_DRAIN')
    // Drain shape-drain so its bucket is empty.
    assert.equal(pool.acquire('shape-drain'), 'C_DRAIN')
    const snap = pool.inspect()
    assert.equal(snap.length, 1)
    assert.equal(snap[0].key, 'shape-keep')
  })

  it('reflects state after eviction (over-cap release does not appear in snapshot)', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      maxPerKey: 1,
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('k', 'C1')
    await pool.release('k', 'C2') // evicted over cap
    const snap = pool.inspect()
    assert.equal(snap.length, 1)
    assert.equal(snap[0].size, 1)
  })

  it('reflects state after markSoiled+release (soiled-evicted entry does not appear)', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    pool.markSoiled('C_SOILED')
    await pool.release('k', 'C_SOILED')
    const snap = pool.inspect()
    assert.equal(snap.length, 0)
  })

  it('returns a SHALLOW snapshot — mutating the returned array must not affect pool state', async () => {
    const timers = timerStubs()
    const execFile = execFileStub()
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
    })
    await pool.release('shape-a', 'C1')
    await pool.release('shape-b', 'C2')
    const snap = pool.inspect()
    // Mutate the array and the entry objects.
    snap.length = 0
    const snap2 = pool.inspect()
    assert.equal(snap2.length, 2, 'pool must still report both buckets')
    snap2[0].size = 999
    snap2[0].key = 'tampered'
    const snap3 = pool.inspect()
    assert.notEqual(snap3[0].size, 999, 'pool state must not have been mutated')
    assert.notEqual(snap3[0].key, 'tampered')
  })

  it('release stamps releasedAt on every pooled entry', async () => {
    // The pool needs releasedAt to compute oldestIdleMs without
    // iterating timers. Verify the stamp lands on the internal entry.
    const timers = timerStubs()
    const execFile = execFileStub()
    let now = 1_000_000
    const pool = new DockerContainerPool({
      _execFile: execFile,
      _setTimeout: timers.setT,
      _clearTimeout: timers.clearT,
      _now: () => now,
    })
    await pool.release('k', 'C1')
    const bucket = pool._entries.get('k')
    assert.ok(bucket && bucket.length === 1)
    assert.equal(bucket[0].releasedAt, 1_000_000)
    // A second release of the same id resets releasedAt to "now".
    assert.equal(pool.acquire('k'), 'C1')
    now += 5000
    await pool.release('k', 'C1')
    const bucket2 = pool._entries.get('k')
    assert.equal(bucket2[0].releasedAt, 1_005_000)
  })

  it('inspect after shutdown returns an empty array', async () => {
    const execFile = execFileStub()
    const pool = new DockerContainerPool({ _execFile: execFile })
    await pool.release('k', 'C1')
    await pool.shutdown()
    const snap = pool.inspect()
    assert.equal(snap.length, 0)
  })
})
