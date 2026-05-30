/**
 * Notification preferences store (#4541).
 *
 * Foundation for user-controllable notification settings (parent #4349).
 * Persists per-category and per-device toggles, plus a quiet-hours window
 * (the window structure is wired through but the time-of-day enforcement
 * is deferred to sub-issue #4544 — `isInQuietHoursIn` is a stub today).
 *
 * On-disk shape (~/.chroxy/notification-prefs.json, mode 0600):
 *
 *   {
 *     "categories": {                  // global defaults — apply to every device
 *       "permission": true,
 *       "result": true,
 *       "activity_update": true,
 *       "activity_waiting": true,
 *       "activity_error": true,
 *       "inactivity_warning": true,
 *       "live_activity": true
 *     },
 *     "devices": {                     // per-device overrides keyed by push token
 *       "ExponentPushToken[abc]": {
 *         "categories": { "result": false }
 *       }
 *     },
 *     "quietHours": { "start": "22:00", "end": "07:00" } | null
 *   }
 *
 * Decision precedence (resolveCategoryDecision):
 *   1. per-device override (if pushToken is known and has an entry)
 *   2. global default (categories.<name>)
 *   3. fail-open `true` (unknown category — defensive lower-bound rate limits
 *      in push.js still apply)
 *
 * The defensive RATE_LIMITS gate in push.js stays in place — user prefs can
 * only further mute notifications, never override the spam ceiling.
 *
 * Atomic writes: temp + rename + cleanup-on-failure, mirroring
 * `byok-mcp-trust.js`. No mutex is needed (a single PushManager owns the
 * file per process), but rename failures still clean up the .tmp file
 * (#4463 pattern).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * Authoritative category list. MUST stay in sync with the keys of
 * `RATE_LIMITS` in `push.js` — these are the categories the server can
 * fire today. The schema-coverage test asserts every category has a
 * default.
 *
 * History: the issue text (#4541) sketches `permission / question / error /
 * result / inactivity` as user-facing labels; the wire-level set below is
 * the actual server-emitted categories (the UI in sub-issues #4542/#4543
 * can map these to friendlier labels without changing the protocol).
 */
export const ALL_CATEGORIES = Object.freeze([
  'permission',
  'result',
  'activity_update',
  'activity_waiting',
  'activity_error',
  'inactivity_warning',
  'live_activity',
])

/**
 * Default category state for a fresh install: every category enabled.
 * Pre-#4541 behaviour was "always fire (modulo RATE_LIMITS)", so defaulting
 * everything to `true` preserves that contract for users who never touch
 * Settings.
 */
export const CATEGORY_DEFAULTS = Object.freeze(
  Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true]))
)

const _ALL_CATEGORIES_SET = new Set(ALL_CATEGORIES)

export function defaultNotificationPrefsPath() {
  return process.env.CHROXY_NOTIFICATION_PREFS_PATH || join(homedir(), '.chroxy', 'notification-prefs.json')
}

/**
 * Build a fresh prefs object using the documented defaults. Pure — never
 * touches disk. Used by loadPrefs (when no file) and as the seed for
 * shallow-merge during setPrefs patches.
 */
export function defaultPrefs() {
  return {
    categories: { ...CATEGORY_DEFAULTS },
    devices: {},
    quietHours: null,
  }
}

/**
 * Strip any keys outside ALL_CATEGORIES and coerce non-boolean values to
 * the default. A hand-edited prefs file with a typo (`resut: false`)
 * should not silently break — drop the unknown key and warn at the
 * read site.
 */
function sanitizeCategoryMap(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!_ALL_CATEGORIES_SET.has(key)) continue
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/**
 * Sanitize the on-disk `devices` map. Drops malformed entries silently —
 * a corrupt per-device override should not break notifications for every
 * other device.
 */
function sanitizeDevices(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [token, entry] of Object.entries(raw)) {
    if (typeof token !== 'string' || token.length === 0) continue
    if (!entry || typeof entry !== 'object') continue
    out[token] = { categories: sanitizeCategoryMap(entry.categories) }
  }
  return out
}

/**
 * Sanitize the quiet-hours window. Foundation only — the deferred sub-issue
 * (#4544) owns the time-of-day enforcement; today this just preserves the
 * shape so the UI can round-trip user input.
 */
function sanitizeQuietHours(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.start !== 'string' || typeof raw.end !== 'string') return null
  // Loose HH:MM format check. Tighten in #4544 once UI lands.
  if (!/^\d{2}:\d{2}$/.test(raw.start) || !/^\d{2}:\d{2}$/.test(raw.end)) return null
  return { start: raw.start, end: raw.end }
}

/**
 * Load and merge prefs from disk over the documented defaults. A missing
 * file is normal (first run) — returns defaults. A malformed file falls
 * back to defaults with a warn log so the user notices but pushes keep
 * working.
 */
export function loadPrefs(filePath = defaultNotificationPrefsPath(), { log } = {}) {
  const base = defaultPrefs()
  if (!existsSync(filePath)) return base
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return {
      categories: { ...base.categories, ...sanitizeCategoryMap(raw?.categories) },
      devices: sanitizeDevices(raw?.devices),
      quietHours: sanitizeQuietHours(raw?.quietHours),
    }
  } catch (err) {
    log?.warn?.(`notification-prefs ${filePath} unreadable: ${err?.message || err}`)
    return base
  }
}

/**
 * Persist a prefs object to disk. Atomic temp+rename so a crashed write
 * cannot corrupt the file. On POSIX the file ends up at mode 0600.
 *
 * #4463 pattern: if renameSync throws (cross-device link, FS quota, ACL),
 * unlink the .tmp file on the failure path and re-throw the ORIGINAL
 * rename error so the caller sees the real failure rather than a
 * cleanup-side ENOENT. The cleanup unlink swallows its own errors so a
 * race that already cleaned the temp doesn't mask the original failure.
 */
export function savePrefs(prefs, filePath = defaultNotificationPrefsPath()) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(prefs, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch {}
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

/**
 * Resolve "should category X fire for device Y given prefs Z?".
 *
 * 1. per-device override wins when present (the user explicitly toggled
 *    this device).
 * 2. otherwise the global default applies.
 * 3. unknown categories fall through to `true` (fail-open). The defensive
 *    RATE_LIMITS gate in push.js still throttles unknowns at the
 *    documented `?? 30_000` default, so a fail-open here doesn't enable
 *    spam.
 */
export function resolveCategoryDecision(prefs, category, pushToken) {
  if (!prefs || typeof prefs !== 'object') return true
  const deviceEntry = pushToken && prefs.devices ? prefs.devices[pushToken] : null
  if (deviceEntry?.categories && typeof deviceEntry.categories[category] === 'boolean') {
    return deviceEntry.categories[category]
  }
  if (prefs.categories && typeof prefs.categories[category] === 'boolean') {
    return prefs.categories[category]
  }
  return true
}

/** Alias surface for PushManager.isCategoryEnabled. */
export function isCategoryEnabledIn(prefs, category, pushToken) {
  return resolveCategoryDecision(prefs, category, pushToken)
}

/**
 * Stub for the deferred quiet-hours enforcement (#4544). Foundation only —
 * always returns false today. The signature is published so callers
 * (push.js `send`, future tests) can wire to it without churn when #4544
 * implements the real check.
 */
// eslint-disable-next-line no-unused-vars
export function isInQuietHoursIn(prefs, now, pushToken) {
  // Window is parsed and persisted, but the actual time check lives in
  // sub-issue #4544 (UI + business logic). Returning false here means
  // pushes are never blocked by quiet-hours until #4544 lands.
  return false
}
