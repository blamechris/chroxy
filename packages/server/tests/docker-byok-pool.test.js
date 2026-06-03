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
  })

  it('starts empty', () => {
    const pool = new DockerContainerPool({ _execFile: execFileStub() })
    assert.equal(pool.size(), 0)
    assert.equal(pool.sizeOf('any-key'), 0)
    assert.equal(pool.acquire('any-key'), null)
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
    })
    assert.equal(pool._idleTimeoutMs, 15000)
    assert.equal(pool._maxPerKey, 5)
    assert.equal(pool._maxTotal, 20)
  })
})
