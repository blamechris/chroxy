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
