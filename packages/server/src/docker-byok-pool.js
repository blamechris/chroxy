/**
 * DockerContainerPool — opt-in idle pool for docker-byok containers (#5022).
 *
 * Background
 * ----------
 * Each `DockerByokSession` already reuses ONE container across every turn
 * in its session — `_startContainer()` is called once in `start()` and
 * the same container id services every tool dispatch until `destroy()`.
 * That's the per-session reuse baseline and is unconditional.
 *
 * What this module adds
 * ---------------------
 * A small ACROSS-SESSION idle pool. When a session calls `destroy()` and
 * the pool is enabled, the container (if still healthy) is released back
 * to the pool instead of being `docker rm -f`'d. The next session whose
 * acquire-key matches picks it up — skipping the `docker run` + `useradd`
 * + `chown` cold-start path (~500ms-2s, or ~10-30s on image pull).
 *
 * Design decisions (matches issue #5022 AC)
 * -----------------------------------------
 *   - Default OFF: opt-in via `CHROXY_DOCKER_BYOK_POOL=1` or pool option
 *     so today's per-session behaviour is preserved unless asked for.
 *   - Cache key: `image|cwd|memoryLimit|cpuLimit|containerUser`. Cwd is
 *     part of the key because the host cwd is bind-mounted at /workspace
 *     — reusing a container across cwds would silently leak host paths.
 *     Resource limits are part of the key so a session that asked for
 *     `--memory 4g` doesn't pick up a 1g container.
 *   - Eviction: per-entry idle timeout (default 5 minutes) — a setTimeout
 *     fires `docker rm -f` and drops the entry. Caps on pool size per
 *     key (default 2) and total pool size (default 8) keep the daemon
 *     load bounded; over-cap releases trigger immediate eviction.
 *   - Lifecycle:
 *       - acquire(key)  → first available entry, or null on miss.
 *                          Removes from pool (a session OWNS it while held).
 *       - release(key, containerId)
 *                       → put back into the pool with a fresh idle timer.
 *                          Over-cap releases evict instead.
 *       - shutdown()    → cancel all timers and `docker rm -f` everything.
 *   - Health: pool returns containers AS-IS. DockerByokSession is
 *     responsible for `_verifyContainer()` after acquire — if the
 *     container died while idle (docker daemon restart, OOM kill, host
 *     reboot), the session falls back to `_startContainer()`.
 *   - Interaction with snapshot/restore: deferred — pooled containers do
 *     NOT participate in snapshot/restore yet (a snapshot of a pooled
 *     container could be acquired by an unrelated session). When a
 *     snapshot is taken, the session must mark the container "soiled" so
 *     it goes to eviction on release.
 *
 * Why a separate module
 * ---------------------
 * Keeps the pool side-effect free from the session's start/destroy path:
 * if the pool throws or stalls, the session can fall back to direct
 * container ownership without leaking. Tests can drive the pool with no
 * session involvement.
 */

import { execFile as defaultExecFile } from 'child_process'
import { createLogger } from './logger.js'

const log = createLogger('docker-byok-pool')

/** Default idle TTL before an entry is evicted (`docker rm -f`'d). */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Default cap on entries kept per pool key. */
export const DEFAULT_MAX_PER_KEY = 2

/** Default cap on total pool size across all keys. */
export const DEFAULT_MAX_TOTAL = 8

/**
 * Build the canonical cache key for a session's resource shape. Same
 * shape used by `DockerContainerPool#acquire` / `#release` so the
 * session and the pool can compute keys independently.
 *
 * @param {object} spec
 * @param {string} spec.image
 * @param {string} spec.cwd
 * @param {string} spec.memoryLimit
 * @param {string} spec.cpuLimit
 * @param {string} spec.containerUser
 * @returns {string}
 */
export function buildPoolKey(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('buildPoolKey: spec is required')
  }
  const { image, cwd, memoryLimit, cpuLimit, containerUser } = spec
  if (!image || !cwd || !memoryLimit || !cpuLimit || !containerUser) {
    throw new Error('buildPoolKey: image, cwd, memoryLimit, cpuLimit, containerUser are required')
  }
  return [image, cwd, memoryLimit, cpuLimit, containerUser].join('|')
}

/**
 * In-memory idle pool of docker-byok containers, keyed by resource shape.
 *
 * Not thread-safe (Node is single-threaded). All public methods are sync
 * except `shutdown()` and `_evict()` which `docker rm -f` via execFile.
 */
export class DockerContainerPool {
  /**
   * @param {object} [opts]
   * @param {number} [opts.idleTimeoutMs=300000] — TTL per idle entry
   * @param {number} [opts.maxPerKey=2]          — cap per resource shape
   * @param {number} [opts.maxTotal=8]           — cap across all shapes
   * @param {Function} [opts._execFile]          — test seam (execFile)
   * @param {Function} [opts._setTimeout]        — test seam (setTimeout)
   * @param {Function} [opts._clearTimeout]      — test seam (clearTimeout)
   */
  constructor(opts = {}) {
    this._idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs)
      ? opts.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS
    this._maxPerKey = Number.isFinite(opts.maxPerKey)
      ? opts.maxPerKey
      : DEFAULT_MAX_PER_KEY
    this._maxTotal = Number.isFinite(opts.maxTotal)
      ? opts.maxTotal
      : DEFAULT_MAX_TOTAL
    this._execFile = opts._execFile || defaultExecFile
    this._setTimeout = opts._setTimeout || setTimeout
    this._clearTimeout = opts._clearTimeout || clearTimeout
    /** @type {Map<string, Array<{ containerId: string, timer: any }>>} */
    this._entries = new Map()
    this._shuttingDown = false
  }

  /**
   * Try to claim an idle container for `key`. Returns the container id
   * on hit, `null` on miss. The entry is REMOVED from the pool — the
   * caller now owns the container until they call `release()` (to hand
   * it back) or `docker rm -f` it themselves. There is no public
   * `evict()` — eviction is internal (`_evict`); a caller that wants to
   * forcibly destroy an acquired container just runs `docker rm -f` and
   * never calls `release()`.
   *
   * @param {string} key
   * @returns {string|null}
   */
  acquire(key) {
    if (this._shuttingDown) return null
    const bucket = this._entries.get(key)
    if (!bucket || bucket.length === 0) return null
    const entry = bucket.shift()
    if (bucket.length === 0) this._entries.delete(key)
    this._clearTimeout(entry.timer)
    log.info(`pool hit: ${entry.containerId.slice(0, 12)} for ${key}`)
    return entry.containerId
  }

  /**
   * Hand a container back to the pool for reuse. If over the per-key or
   * total cap, or if the pool is shutting down, the container is evicted
   * (`docker rm -f`) instead of being kept. Returns `true` if the
   * container was retained, `false` if it was evicted.
   *
   * @param {string} key
   * @param {string} containerId
   * @returns {Promise<boolean>}
   */
  async release(key, containerId) {
    // Guard a null/empty id before any eviction work — a shutdown release
    // with no id was calling `docker rm -f` with an empty argument.
    if (!containerId) return false
    if (this._shuttingDown) {
      await this._evict(containerId)
      return false
    }
    const total = this._totalSize()
    const bucket = this._entries.get(key) || []
    if (bucket.length >= this._maxPerKey || total >= this._maxTotal) {
      log.info(`pool over cap (key=${bucket.length}/${this._maxPerKey} total=${total}/${this._maxTotal}); evicting ${containerId.slice(0, 12)}`)
      await this._evict(containerId)
      return false
    }
    const timer = this._setTimeout(() => {
      this._removeEntry(key, containerId, /*alreadyTimedOut*/ true)
      this._evict(containerId).catch((err) => {
        log.warn(`idle eviction of ${containerId.slice(0, 12)} failed: ${err.message}`)
      })
    }, this._idleTimeoutMs)
    // setTimeout returns a Timer object on Node; unref so a pooled
    // container doesn't keep the event loop alive on shutdown.
    if (timer && typeof timer.unref === 'function') timer.unref()
    bucket.push({ containerId, timer })
    this._entries.set(key, bucket)
    log.info(`pool release: ${containerId.slice(0, 12)} → ${key} (idle ${this._idleTimeoutMs}ms)`)
    return true
  }

  /**
   * Snapshot the current entry count. Useful for tests / dashboards.
   * @returns {number}
   */
  size() {
    return this._totalSize()
  }

  /**
   * Snapshot the entry count for a specific key.
   * @param {string} key
   * @returns {number}
   */
  sizeOf(key) {
    const bucket = this._entries.get(key)
    return bucket ? bucket.length : 0
  }

  /**
   * Cancel all idle timers and `docker rm -f` every entry. After
   * shutdown, `acquire()` always returns null and `release()` evicts
   * inline. Idempotent.
   */
  async shutdown() {
    this._shuttingDown = true
    const toRemove = []
    for (const bucket of this._entries.values()) {
      for (const entry of bucket) {
        this._clearTimeout(entry.timer)
        toRemove.push(entry.containerId)
      }
    }
    this._entries.clear()
    log.info(`shutdown: evicting ${toRemove.length} pooled container(s)`)
    await Promise.all(toRemove.map((id) => this._evict(id).catch((err) => {
      log.warn(`shutdown eviction of ${id.slice(0, 12)} failed: ${err.message}`)
    })))
  }

  // ─────────────────────────────────────────────────────────────────
  // internals
  // ─────────────────────────────────────────────────────────────────

  _totalSize() {
    let n = 0
    for (const bucket of this._entries.values()) n += bucket.length
    return n
  }

  /**
   * Remove an entry from the bucket without evicting. Used by the idle
   * timer callback (which then evicts separately) so the pool's view of
   * "what's idle" stays in sync.
   */
  _removeEntry(key, containerId, alreadyTimedOut = false) {
    const bucket = this._entries.get(key)
    if (!bucket) return
    const idx = bucket.findIndex((e) => e.containerId === containerId)
    if (idx === -1) return
    const [entry] = bucket.splice(idx, 1)
    if (!alreadyTimedOut) this._clearTimeout(entry.timer)
    if (bucket.length === 0) this._entries.delete(key)
  }

  /**
   * `docker rm -f` a container, swallowing the "no such container"
   * error so we don't crash on a container that died on its own.
   */
  _evict(containerId) {
    return new Promise((resolve) => {
      // `execFile` ignores `stdio`; cap the buffer so a misbehaving
      // docker(8) can't OOM us on stderr. 64 KiB is plenty for an error
      // path that should produce a one-line "no such container" at most.
      this._execFile('docker', ['rm', '-f', containerId], { maxBuffer: 64 * 1024 }, (err) => {
        if (err) {
          log.warn(`docker rm -f ${containerId.slice(0, 12)} failed: ${err.message}`)
        }
        resolve()
      })
    })
  }
}

/**
 * Process-wide singleton (lazy). Most callers should go through this so
 * sessions across the server share one pool. Tests inject their own
 * pool via the `_pool` constructor seam.
 *
 * @type {DockerContainerPool|null}
 */
let _sharedPool = null

/**
 * Lazily-construct the shared pool. Returns `null` when pooling is
 * disabled — callers check the return value before using it.
 *
 * Enabled when `CHROXY_DOCKER_BYOK_POOL` is truthy (1, true, yes, on).
 * Optional knobs:
 *   - CHROXY_DOCKER_BYOK_POOL_IDLE_MS — override idle TTL (ms)
 *   - CHROXY_DOCKER_BYOK_POOL_MAX_PER_KEY — override per-key cap
 *   - CHROXY_DOCKER_BYOK_POOL_MAX_TOTAL — override total cap
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {DockerContainerPool|null}
 */
export function getSharedPool(env = process.env) {
  if (!isPoolEnabled(env)) return null
  if (_sharedPool) return _sharedPool
  const idleRaw = env.CHROXY_DOCKER_BYOK_POOL_IDLE_MS
  const perKeyRaw = env.CHROXY_DOCKER_BYOK_POOL_MAX_PER_KEY
  const totalRaw = env.CHROXY_DOCKER_BYOK_POOL_MAX_TOTAL
  const idleTimeoutMs = Number(idleRaw)
  const maxPerKey = Number(perKeyRaw)
  const maxTotal = Number(totalRaw)
  _sharedPool = new DockerContainerPool({
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : undefined,
    maxPerKey: Number.isFinite(maxPerKey) && maxPerKey > 0 ? maxPerKey : undefined,
    maxTotal: Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : undefined,
  })
  return _sharedPool
}

/**
 * Whether the docker-byok pool is enabled in the given env. Exposed so
 * the session constructor can short-circuit pool work entirely when
 * disabled (no map lookups, no allocations).
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function isPoolEnabled(env = process.env) {
  const raw = env.CHROXY_DOCKER_BYOK_POOL
  if (typeof raw !== 'string') return false
  const norm = raw.trim().toLowerCase()
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on'
}

/**
 * Reset the shared singleton. Tests use this to keep state from leaking
 * across cases. Production code never calls this.
 */
export function _resetSharedPool() {
  _sharedPool = null
}
