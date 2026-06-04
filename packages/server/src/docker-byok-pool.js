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
 *   - Cache key: `image|cwd|memoryLimit|cpuLimit|containerUser` —
 *     extended with `|<devcontainerFingerprint>` when a session opted
 *     into `useDevcontainer` (#5080) so a changed devcontainer.json
 *     overlay invalidates pre-existing pooled containers. Cwd is part
 *     of the key because the host cwd is bind-mounted at /workspace —
 *     reusing a container across cwds would silently leak host paths.
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
 *   - Interaction with snapshot/restore (#5043): the pool exposes
 *     `markSoiled(containerId)` so when docker-byok grows snapshot
 *     support (#5023), a session that took a snapshot can mark its
 *     container so the next `release()` call evicts it inline instead of
 *     pooling. A soiled container's filesystem may have leaked into a
 *     snapshot image layer (or otherwise become coupled to a specific
 *     conversation) — handing it to an unrelated session would silently
 *     surface another conversation's files / auth. Soiling is a property
 *     of the container id, not the session, so it survives across the
 *     release call and is cleared once the container is evicted.
 *
 * Why a separate module
 * ---------------------
 * Keeps the pool side-effect free from the session's start/destroy path:
 * if the pool throws or stalls, the session can fall back to direct
 * container ownership without leaking. Tests can drive the pool with no
 * session involvement.
 */

import { execFile as defaultExecFile } from 'child_process'
import { EventEmitter } from 'events'
import { createLogger } from './logger.js'

const log = createLogger('docker-byok-pool')

/**
 * Structured event names emitted by `DockerContainerPool` (#5044).
 *
 * The pool is opt-in but, when in use, services every session in the
 * server — log scraping isn't a serious observability path. Listeners
 * (dashboard, metrics exporter, debug tooling) subscribe via the
 * standard `EventEmitter` API:
 *
 *   pool.on(POOL_EVENTS.HIT,      ({ key, containerId, timestamp }) => ...)
 *   pool.on(POOL_EVENTS.MISS,     ({ key, timestamp }) => ...)
 *   pool.on(POOL_EVENTS.RELEASED, ({ key, containerId, timestamp }) => ...)
 *   pool.on(POOL_EVENTS.EVICTED,  ({ key, containerId, reason, timestamp }) => ...)
 *   pool.on(POOL_EVENTS.SHUTDOWN, ({ drained, timestamp }) => ...)
 *
 * Eviction reasons:
 *   - 'idle'     — the per-entry idle timer fired
 *   - 'over_cap' — release exceeded per-key or total cap
 *   - 'shutdown' — pool was drained via `shutdown()` (or release after)
 *
 * (Hook for #5043: a future 'soiled' reason will be added when the
 * snapshot/restore work lands. Treat the reason set as open.)
 */
export const POOL_EVENTS = Object.freeze({
  HIT: 'pool:hit',
  MISS: 'pool:miss',
  RELEASED: 'pool:released',
  EVICTED: 'pool:evicted',
  SHUTDOWN: 'pool:shutdown',
})

/** Default idle TTL before an entry is evicted (`docker rm -f`'d). */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Default cap on entries kept per pool key. */
export const DEFAULT_MAX_PER_KEY = 2

/** Default cap on total pool size across all keys. */
export const DEFAULT_MAX_TOTAL = 8

/**
 * Default hard cap on total container lifetime (#5045). Idle TTL alone
 * cannot evict a container that's continuously reused. Max age is checked
 * on both `acquire()` and `release()`. Pass `Infinity` to opt out.
 */
export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000

/**
 * Build the canonical cache key for a session's resource shape. Same
 * shape used by `DockerContainerPool#acquire` / `#release` so the
 * session and the pool can compute keys independently.
 *
 * `devcontainerFingerprint` (#5080) is an optional short hash of the
 * resolved devcontainer.json overlay. When `useDevcontainer: true` is
 * set, the session passes a SHA-1 of the **fully-resolved** overlay
 * (after mount validation + env sanitisation, NOT the raw parsed file)
 * so that a change to `mounts` / `containerEnv` / `forwardPorts` /
 * `postCreateCommand` cache-busts the key — otherwise a pool hit would
 * silently return a container provisioned against a STALE
 * devcontainer.json. `image` and `remoteUser` are deliberately omitted
 * from the fingerprint because they're already first-class segments of
 * the pool key.
 *
 * Non-devcontainer sessions pass `null` (or omit the field), preserving
 * backward compatibility — the joined key remains
 * `image|cwd|memoryLimit|cpuLimit|containerUser`, so pre-fingerprint
 * keys still match and devcontainer + non-devcontainer sessions of the
 * same resource shape never collide (the trailing `|<fp>` is only
 * appended when a fingerprint is supplied).
 *
 * @param {object} spec
 * @param {string} spec.image
 * @param {string} spec.cwd
 * @param {string} spec.memoryLimit
 * @param {string} spec.cpuLimit
 * @param {string} spec.containerUser
 * @param {string|null} [spec.devcontainerFingerprint] — optional short
 *   hash of the resolved devcontainer overlay (#5080)
 * @returns {string}
 */
export function buildPoolKey(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('buildPoolKey: spec is required')
  }
  const { image, cwd, memoryLimit, cpuLimit, containerUser, devcontainerFingerprint } = spec
  if (!image || !cwd || !memoryLimit || !cpuLimit || !containerUser) {
    throw new Error('buildPoolKey: image, cwd, memoryLimit, cpuLimit, containerUser are required')
  }
  const base = [image, cwd, memoryLimit, cpuLimit, containerUser].join('|')
  // Only append the fingerprint segment when one was supplied. A
  // non-devcontainer session keeps the original 5-segment key shape,
  // matching pre-#5080 callers exactly so existing entries still hit.
  if (typeof devcontainerFingerprint === 'string' && devcontainerFingerprint.length > 0) {
    return `${base}|${devcontainerFingerprint}`
  }
  return base
}

/**
 * In-memory idle pool of docker-byok containers, keyed by resource shape.
 *
 * Not thread-safe (Node is single-threaded). All public methods are sync
 * except `shutdown()` and `_evict()` which `docker rm -f` via execFile.
 *
 * Extends `EventEmitter` so callers can observe pool activity via the
 * `POOL_EVENTS.*` events without scraping log lines (#5044).
 */
export class DockerContainerPool extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.idleTimeoutMs=300000] — TTL per idle entry
   * @param {number} [opts.maxPerKey=2]          — cap per resource shape
   * @param {number} [opts.maxTotal=8]           — cap across all shapes
   * @param {Function} [opts._execFile]          — test seam (execFile)
   * @param {Function} [opts._setTimeout]        — test seam (setTimeout)
   * @param {Function} [opts._clearTimeout]      — test seam (clearTimeout)
   * @param {Function} [opts._now]               — test seam (Date.now)
   */
  constructor(opts = {}) {
    super()
    // The pool is process-wide; uncapped listener counts would mask
    // a runaway subscriber bug, so set a generous-but-finite cap.
    this.setMaxListeners(32)
    this._idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs)
      ? opts.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS
    this._maxPerKey = Number.isFinite(opts.maxPerKey)
      ? opts.maxPerKey
      : DEFAULT_MAX_PER_KEY
    this._maxTotal = Number.isFinite(opts.maxTotal)
      ? opts.maxTotal
      : DEFAULT_MAX_TOTAL
    // Accept Infinity (not "finite") as a valid opt-out — Number.isFinite
    // rejects it, which is exactly what we don't want here.
    this._maxAgeMs = typeof opts.maxAgeMs === 'number' && opts.maxAgeMs > 0
      ? opts.maxAgeMs
      : DEFAULT_MAX_AGE_MS
    this._execFile = opts._execFile || defaultExecFile
    this._setTimeout = opts._setTimeout || setTimeout
    this._clearTimeout = opts._clearTimeout || clearTimeout
    this._now = typeof opts._now === 'function' ? opts._now : Date.now
    /** @type {Map<string, Array<{ containerId: string, timer: any }>>} */
    this._entries = new Map()
    /**
     * Container ids marked soiled by `markSoiled()`. A soiled id at
     * `release()` time is evicted inline instead of being pooled — see
     * #5043 and the class docstring's snapshot/restore section.
     * @type {Set<string>}
     */
    this._soiledIds = new Set()
    /**
     * createdAt by container id, kept separate from `_entries` so it
     * survives across acquire/release cycles. Cleared on eviction.
     * @type {Map<string, number>}
     */
    this._createdAt = new Map()
    this._shuttingDown = false
  }

  /**
   * Emit a structured pool event. Wraps `EventEmitter.emit` so the
   * payload always carries a `timestamp` and so an exception in any
   * listener can't tear down the pool — listener errors are logged and
   * dropped. Returns the payload so call sites can chain (e.g. add a
   * debug log of the same shape).
   *
   * @param {string} name
   * @param {object} payload
   * @returns {object}
   */
  _emitPoolEvent(name, payload) {
    const fullPayload = { timestamp: this._now(), ...payload }
    try {
      this.emit(name, fullPayload)
    } catch (err) {
      // Don't let a listener bug crash the pool's acquire/release/
      // shutdown path. A noisy emitter is still better than a wedged
      // pool.
      log.warn(`listener for ${name} threw: ${err && err.message}`)
    }
    return fullPayload
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
    if (this._shuttingDown) {
      this._emitPoolEvent(POOL_EVENTS.MISS, { key, containerId: null, reason: 'shutdown' })
      log.debug(`pool miss (shutting down) for ${key}`)
      return null
    }
    const bucket = this._entries.get(key)
    if (!bucket || bucket.length === 0) {
      this._emitPoolEvent(POOL_EVENTS.MISS, { key, containerId: null, reason: 'empty' })
      log.debug(`pool miss for ${key}`)
      return null
    }
    // Lazily skip + evict any over-age or soiled entries at the head of
    // the bucket. Over-age is #5045; the soiled check (#5049) is
    // defense-in-depth — the documented session lifecycle never lets
    // `markSoiled(id)` race against `release()` (destroy() nulls
    // _containerId before pool.release()), but the public markSoiled(id)
    // API takes any id, so a future non-session caller could mark an
    // already-pooled id. Without this check the next acquire() would
    // silently hand out a soiled container. The soiled marker is
    // consumed on the inline eviction so the same id isn't poisoned
    // forever — matches the release-path semantics.
    const now = this._now()
    while (bucket.length > 0) {
      const head = bucket[0]
      const age = now - (head.createdAt ?? now)
      const overAge = age > this._maxAgeMs
      const soiled = this._soiledIds.has(head.containerId)
      if (!overAge && !soiled) break
      bucket.shift()
      this._clearTimeout(head.timer)
      this._createdAt.delete(head.containerId)
      if (soiled) {
        this._soiledIds.delete(head.containerId)
        this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId: head.containerId, reason: 'soiled' })
        log.info(`pool soiled on acquire: evicting ${head.containerId.slice(0, 12)}`)
      } else {
        this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId: head.containerId, reason: 'over_age' })
        log.info(`pool over-age on acquire (${age}ms > ${this._maxAgeMs}ms): evicting ${head.containerId.slice(0, 12)}`)
      }
      this._evict(head.containerId).catch((err) => {
        log.warn(`acquire-time eviction of ${head.containerId.slice(0, 12)} failed: ${err.message}`)
      })
    }
    if (bucket.length === 0) {
      this._entries.delete(key)
      this._emitPoolEvent(POOL_EVENTS.MISS, { key, containerId: null, reason: 'empty' })
      return null
    }
    const entry = bucket.shift()
    if (bucket.length === 0) this._entries.delete(key)
    this._clearTimeout(entry.timer)
    this._emitPoolEvent(POOL_EVENTS.HIT, { key, containerId: entry.containerId })
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
      this._soiledIds.delete(containerId)
      this._createdAt.delete(containerId)
      this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId, reason: 'shutdown' })
      log.info(`pool release after shutdown; evicting ${containerId.slice(0, 12)}`)
      await this._evict(containerId)
      return false
    }
    // #5043: soiled containers (snapshot taken, or otherwise coupled to a
    // particular conversation) MUST NOT be returned to the pool — the
    // next session of the same shape would silently inherit the previous
    // session's filesystem state. Evict inline and clear the marker so
    // the soiled set doesn't grow unbounded.
    if (this._soiledIds.has(containerId)) {
      this._soiledIds.delete(containerId)
      this._createdAt.delete(containerId)
      this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId, reason: 'soiled' })
      log.info(`pool release: ${containerId.slice(0, 12)} marked soiled; evicting instead of pooling`)
      await this._evict(containerId)
      return false
    }
    // Resolve / record createdAt before any other check so an over-age
    // container that's never been pooled before still gets its real birth
    // time (now) — only re-released containers carry an older createdAt.
    const now = this._now()
    const createdAt = this._createdAt.get(containerId) ?? now
    // Hard max-age cap (#5045): even if the bucket has room, refuse to
    // pool a container that's exceeded total lifetime. Without this, a
    // hot container can survive forever via repeated acquire/release.
    const age = now - createdAt
    if (age > this._maxAgeMs) {
      log.info(`pool over-age on release (${age}ms > ${this._maxAgeMs}ms): evicting ${containerId.slice(0, 12)}`)
      this._createdAt.delete(containerId)
      this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId, reason: 'over_age' })
      await this._evict(containerId)
      return false
    }
    const total = this._totalSize()
    const bucket = this._entries.get(key) || []
    if (bucket.length >= this._maxPerKey || total >= this._maxTotal) {
      this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId, reason: 'over_cap' })
      log.info(`pool over cap (key=${bucket.length}/${this._maxPerKey} total=${total}/${this._maxTotal}); evicting ${containerId.slice(0, 12)}`)
      this._createdAt.delete(containerId)
      await this._evict(containerId)
      return false
    }
    const timer = this._setTimeout(() => {
      this._removeEntry(key, containerId, /*alreadyTimedOut*/ true)
      this._createdAt.delete(containerId)
      this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId, reason: 'idle' })
      this._evict(containerId).catch((err) => {
        log.warn(`idle eviction of ${containerId.slice(0, 12)} failed: ${err.message}`)
      })
    }, this._idleTimeoutMs)
    // setTimeout returns a Timer object on Node; unref so a pooled
    // container doesn't keep the event loop alive on shutdown.
    if (timer && typeof timer.unref === 'function') timer.unref()
    this._createdAt.set(containerId, createdAt)
    bucket.push({ containerId, timer, createdAt })
    this._entries.set(key, bucket)
    this._emitPoolEvent(POOL_EVENTS.RELEASED, { key, containerId })
    log.info(`pool release: ${containerId.slice(0, 12)} → ${key} (idle ${this._idleTimeoutMs}ms, age ${age}ms/${this._maxAgeMs}ms)`)
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
   * Mark a container "soiled" so the next `release()` call evicts it
   * inline instead of returning it to the pool. Used by callers that
   * have done something to the container's filesystem which couples it
   * to the current session — most importantly, taking a Docker snapshot
   * (#5023). A snapshot includes the container's writable layer, so any
   * files the previous session wrote / authenticated would silently leak
   * into the next acquirer of this container.
   *
   * Idempotent — calling twice with the same id is a no-op. Null / empty
   * / non-string ids are silently ignored so callers don't need to
   * branch on whether they actually hold a container. No-ops cleanly
   * when the pool is disabled (the session holds `this._pool = null`
   * and never gets here).
   *
   * @param {string} containerId
   */
  markSoiled(containerId) {
    if (typeof containerId !== 'string' || containerId.length === 0) return
    if (this._soiledIds.has(containerId)) return
    this._soiledIds.add(containerId)
    log.info(`marked container ${containerId.slice(0, 12)} soiled — next release will evict`)
  }

  /**
   * Whether a container has been marked soiled. Exposed for tests and
   * dashboard introspection; production callers use `markSoiled()` and
   * let `release()` handle the eviction.
   *
   * @param {string} containerId
   * @returns {boolean}
   */
  isSoiled(containerId) {
    if (typeof containerId !== 'string' || containerId.length === 0) return false
    return this._soiledIds.has(containerId)
  }

  /**
   * Caller-side escape hatch (#5045 review): the caller has acquired a
   * container and decided NOT to release it back to the pool — e.g. the
   * verify step failed and they're going to docker rm -f themselves. Clear
   * the lifetime-tracking entry so it doesn't leak in `_createdAt`, and
   * run docker rm -f. Silently ignores null/empty/non-string ids.
   *
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async forget(containerId) {
    if (typeof containerId !== 'string' || containerId.length === 0) return
    this._createdAt.delete(containerId)
    this._soiledIds.delete(containerId)
    await this._evict(containerId)
  }

  /**
   * Cancel all idle timers and `docker rm -f` every entry. After
   * shutdown, `acquire()` always returns null and `release()` evicts
   * inline. Idempotent.
   */
  async shutdown() {
    this._shuttingDown = true
    /** @type {Array<{ key: string, containerId: string }>} */
    const toRemove = []
    for (const [key, bucket] of this._entries.entries()) {
      for (const entry of bucket) {
        this._clearTimeout(entry.timer)
        toRemove.push({ key, containerId: entry.containerId })
      }
    }
    this._entries.clear()
    // Clear the soiled-id + createdAt tracking — a future pool instance
    // (lazy singleton, test reset) starts from a clean slate.
    this._soiledIds.clear()
    this._createdAt.clear()
    log.info(`shutdown: evicting ${toRemove.length} pooled container(s)`)
    // Emit per-container eviction BEFORE the final pool:shutdown so a
    // listener that drains counters into a snapshot has all of them
    // accounted for when the "done" event arrives.
    for (const { key, containerId } of toRemove) {
      this._emitPoolEvent(POOL_EVENTS.EVICTED, { key, containerId, reason: 'shutdown' })
    }
    await Promise.all(toRemove.map(({ containerId }) => this._evict(containerId).catch((err) => {
      log.warn(`shutdown eviction of ${containerId.slice(0, 12)} failed: ${err.message}`)
    })))
    this._emitPoolEvent(POOL_EVENTS.SHUTDOWN, { drained: toRemove.length })
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
  const maxAgeRaw = env.CHROXY_DOCKER_BYOK_POOL_MAX_AGE_MS
  const idleTimeoutMs = Number(idleRaw)
  const maxPerKey = Number(perKeyRaw)
  const maxTotal = Number(totalRaw)
  let maxAgeMs
  if (typeof maxAgeRaw === 'string') {
    const trimmed = maxAgeRaw.trim().toLowerCase()
    if (trimmed === 'infinity') {
      maxAgeMs = Infinity
    } else {
      const n = Number(maxAgeRaw)
      if (Number.isFinite(n) && n > 0) maxAgeMs = n
    }
  }
  _sharedPool = new DockerContainerPool({
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : undefined,
    maxPerKey: Number.isFinite(maxPerKey) && maxPerKey > 0 ? maxPerKey : undefined,
    maxTotal: Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : undefined,
    maxAgeMs,
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
