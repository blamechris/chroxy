/**
 * Per-device preferences persisted to disk so dashboard reconnects can restore
 * what the user was actually looking at — not blindly snap them back to
 * `defaultSessionId || firstSessionId`. See #4835.
 *
 * Why this exists separately from `connection.json`:
 * - `connection.json` describes the running server (pid, tunnel URL, port). It
 *   is rewritten by the server start-up handshake and removed on shutdown.
 * - Device preferences are per-deviceId state owned by the *user* and must
 *   survive server restarts intact. Keeping them in a sibling file keeps the
 *   two lifecycles independent.
 *
 * Storage format (`~/.chroxy/device-preferences.json`):
 *   {
 *     "version": 1,
 *     "devices": {
 *       "<deviceId>": { "activeSessionId": "<id>", "updatedAt": <ms> },
 *       ...
 *     }
 *   }
 *
 * File is written with `0600` perms via `writeFileRestricted` — the active
 * session is sensitive enough (it leaks which projects a user is working on)
 * that other local users should not be able to read it.
 *
 * The store is intentionally tiny: a single `getActiveSessionId` /
 * `setActiveSessionId` API. We do not validate that the sessionId still
 * exists at write time — `sendPostAuthInfo` re-checks against
 * `sessionManager.getSession()` before consuming it, so a stale entry is
 * harmless (we fall back to `firstSessionId`).
 */

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('device-prefs')

function getConfigDir() {
  return process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

export function getDevicePreferencesPath() {
  return join(getConfigDir(), 'device-preferences.json')
}

/**
 * Create a device-preferences store. The store loads lazily on first read
 * and re-writes synchronously on every mutation — preference state is small
 * (a handful of devices, one line each) so the write cost is negligible
 * and the simpler synchronous flush avoids losing the most recent switch
 * if the server is killed mid-write-debounce. See #4835.
 *
 * @param {object} [opts]
 * @param {string} [opts.filePath] - override the default path (tests).
 */
export function createDevicePreferences({ filePath } = {}) {
  const path = filePath || getDevicePreferencesPath()
  let cache = null

  function load() {
    if (cache) return cache
    if (!existsSync(path)) {
      cache = { version: 1, devices: {} }
      return cache
    }
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw)
      // Tolerate older / malformed files: any shape that isn't the expected
      // { devices: {} } resets to empty so the server keeps booting. The
      // worst case is one user loses their per-device active-session memory,
      // which is the same as never having set it.
      if (parsed && typeof parsed === 'object' && parsed.devices && typeof parsed.devices === 'object') {
        cache = { version: 1, devices: { ...parsed.devices } }
      } else {
        cache = { version: 1, devices: {} }
      }
    } catch (err) {
      log.warn(`Failed to read ${path}: ${err.message} — starting fresh`)
      cache = { version: 1, devices: {} }
    }
    return cache
  }

  function persist() {
    try {
      mkdirSync(getConfigDir(), { recursive: true })
      writeFileRestricted(path, JSON.stringify(cache, null, 2))
    } catch (err) {
      // A failed write should never crash the server. The in-memory cache is
      // still valid, so per-process behavior is unaffected; the user will
      // simply revert to firstSessionId on the next restart.
      log.warn(`Failed to persist device preferences to ${path}: ${err.message}`)
    }
  }

  return {
    /**
     * Return the persisted active sessionId for `deviceId`, or null if no
     * preference is recorded (or `deviceId` is falsy / not a string).
     *
     * Does NOT check whether the session still exists — callers must
     * re-validate via `sessionManager.getSession()` before using the result.
     */
    getActiveSessionId(deviceId) {
      if (!deviceId || typeof deviceId !== 'string') return null
      const state = load()
      const entry = state.devices[deviceId]
      return entry && typeof entry.activeSessionId === 'string'
        ? entry.activeSessionId
        : null
    },

    /**
     * Record `sessionId` as the active session for `deviceId`. No-op when
     * either argument is missing — bound-session clients and pre-deviceId
     * clients should never hit this path, but we silently ignore rather
     * than throw so the handler stays infallible.
     */
    setActiveSessionId(deviceId, sessionId) {
      if (!deviceId || typeof deviceId !== 'string') return
      if (!sessionId || typeof sessionId !== 'string') return
      const state = load()
      const existing = state.devices[deviceId]
      if (existing && existing.activeSessionId === sessionId) {
        // No-op: avoid touching the file when nothing changed. Tab clicks
        // can repeat the same target during reconnect flapping.
        return
      }
      state.devices[deviceId] = {
        activeSessionId: sessionId,
        updatedAt: Date.now(),
      }
      persist()
    },

    /**
     * Drop entries that are no longer useful and persist the result. See
     * #4849. Two prune criteria are applied in this order:
     *
     *   1. Stale-session: `activeSessionId` is not a string OR
     *      `sessionExists(activeSessionId)` returns false AND the entry's
     *      `updatedAt` is older than `staleSessionGraceMs` (default `0` —
     *      remove immediately). The grace window exists so a brief
     *      restart-induced gap, where the SessionManager has not yet
     *      restored the session the device was viewing, does not nuke a
     *      perfectly valid preference. Callers that have a fully-restored
     *      SessionManager can leave `staleSessionGraceMs` at its default.
     *
     *   2. Age-based: `updatedAt` is older than `maxAgeMs`. Skipped when
     *      `maxAgeMs` is null/undefined.
     *
     * Malformed entries (missing or non-string `activeSessionId`, missing
     * `updatedAt`) are always pruned — they cannot do anything useful and
     * carrying them forward would propagate the malformation.
     *
     * The file is only re-written when at least one entry is removed —
     * the no-op case is free (no disk I/O), so this method is safe to
     * call eagerly on startup even when the store is empty.
     *
     * @param {object} [opts]
     * @param {(sessionId: string) => boolean} [opts.sessionExists]
     *   Predicate that returns true iff the SessionManager still knows
     *   about `sessionId`. When omitted, the stale-session check is
     *   skipped entirely (only the age-based check applies).
     * @param {number} [opts.maxAgeMs]
     *   Drop entries older than this many ms regardless of session
     *   existence. Default null — no age cap.
     * @param {number} [opts.staleSessionGraceMs]
     *   Don't drop stale-session entries younger than this many ms.
     *   Default 0 — drop stale-session entries immediately.
     * @returns {number} Number of entries removed.
     */
    prune({ sessionExists, maxAgeMs, staleSessionGraceMs } = {}) {
      const state = load()
      const deviceIds = Object.keys(state.devices)
      if (deviceIds.length === 0) return 0

      const now = Date.now()
      const grace = typeof staleSessionGraceMs === 'number' ? staleSessionGraceMs : 0
      let removed = 0

      for (const deviceId of deviceIds) {
        const entry = state.devices[deviceId]
        const activeSessionId = entry && typeof entry.activeSessionId === 'string'
          ? entry.activeSessionId
          : null
        const updatedAt = entry && typeof entry.updatedAt === 'number'
          ? entry.updatedAt
          : null

        // Malformed: cannot use this entry, evict.
        if (!activeSessionId || updatedAt == null) {
          delete state.devices[deviceId]
          removed += 1
          continue
        }

        // Age-based: hard cap regardless of session existence.
        if (typeof maxAgeMs === 'number' && now - updatedAt > maxAgeMs) {
          delete state.devices[deviceId]
          removed += 1
          continue
        }

        // Stale-session: drop if the SessionManager no longer knows about
        // the persisted id AND the entry is older than the grace window.
        if (typeof sessionExists === 'function' && !sessionExists(activeSessionId)) {
          if (now - updatedAt >= grace) {
            delete state.devices[deviceId]
            removed += 1
            continue
          }
        }
      }

      if (removed > 0) {
        log.info(`Pruned ${removed} stale device-preferences entr${removed === 1 ? 'y' : 'ies'}`)
        persist()
      }
      return removed
    },

    /**
     * Clear the recorded preference for `deviceId`. Currently unused by
     * production code, but exposed so future "forget this device" UI
     * doesn't have to reach into the cache shape.
     */
    clear(deviceId) {
      if (!deviceId || typeof deviceId !== 'string') return
      const state = load()
      if (!state.devices[deviceId]) return
      delete state.devices[deviceId]
      persist()
    },

    /**
     * Test-only escape hatch — drop the in-memory cache so the next read
     * reloads from disk. Production callers never need this.
     */
    _resetCacheForTest() {
      cache = null
    },
  }
}
