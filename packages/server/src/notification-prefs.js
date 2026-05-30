/**
 * Notification preferences store (#4541, extended in #4544).
 *
 * Foundation for user-controllable notification settings (parent #4349).
 * Persists per-category and per-device toggles, plus a quiet-hours window
 * with timezone enforcement and a bypass-category list (#4544 — the actual
 * time-of-day check; #4541 only persisted the window).
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
 *         "categories": { "result": false },
 *         "quietHours": { "start": "23:00", "end": "06:00", "timezone": "America/Los_Angeles" },
 *         "bypassCategories": ["permission"]
 *       }
 *     },
 *     "quietHours": { "start": "22:00", "end": "07:00", "timezone": "America/Los_Angeles" } | null,
 *     "bypassCategories": ["permission", "activity_error"]   // categories that fire even during quiet hours
 *   }
 *
 * Decision precedence (resolveCategoryDecision):
 *   1. per-device override (if pushToken is known and has an entry)
 *   2. global default (categories.<name>)
 *   3. fail-open `true` (unknown category — defensive lower-bound rate limits
 *      in push.js still apply)
 *
 * Quiet-hours precedence (resolveQuietHoursWindow / resolveBypassCategories):
 *   - Per-device REPLACES the global value entirely. A device with
 *     `quietHours: null` opts out of muting even if the global window is set;
 *     a device with `bypassCategories: []` opts out of every bypass even if
 *     the global list includes them.
 *   - Rationale (per #4544 design notes): replace is simpler than shadow
 *     because the user can express "this phone is special — here is its
 *     entire policy" without having to mentally diff against the global
 *     window.
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

/**
 * Categories that bypass quiet hours when no explicit override is set (#4544).
 *
 * Rationale: `permission` blocks the agent until the operator decides — if it
 * gets muted by quiet hours the agent stalls indefinitely. `activity_error`
 * surfaces crashes/tunnel drops/fatal session failures and demands operator
 * attention in the same way. Anything else (completion pings, activity
 * updates, inactivity warnings) is exactly what quiet hours is for, so it
 * stays muted by default.
 *
 * Users can opt out per-device (`bypassCategories: []`) or extend the
 * global list to silence even errors if they want.
 */
export const DEFAULT_BYPASS_CATEGORIES = Object.freeze(['permission', 'activity_error'])

const _ALL_CATEGORIES_SET = new Set(ALL_CATEGORIES)
const _HHMM_RE = /^\d{2}:\d{2}$/

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
    // Default to the documented bypass list. `setPrefs` accepts an empty
    // array to override (user explicitly says "nothing bypasses, even
    // errors"), and a missing key keeps the default.
    bypassCategories: [...DEFAULT_BYPASS_CATEGORIES],
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
 *
 * #4544: per-device entries may now carry `quietHours` and
 * `bypassCategories` in addition to `categories`. `quietHours` retains
 * its tri-state semantics: `undefined` = inherit global, `null` = opt out
 * of muting on this device, `{ start, end, timezone }` = device-specific
 * window.
 */
function sanitizeDevices(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [token, entry] of Object.entries(raw)) {
    if (typeof token !== 'string' || token.length === 0) continue
    if (!entry || typeof entry !== 'object') continue
    const cleaned = { categories: sanitizeCategoryMap(entry.categories) }
    // Tri-state: present-as-null means "explicitly disable muting on this
    // device"; present-as-window means "use this window"; absent means
    // "fall back to global". hasOwnProperty distinguishes absent from null.
    if (Object.prototype.hasOwnProperty.call(entry, 'quietHours')) {
      cleaned.quietHours = sanitizeQuietHours(entry.quietHours)
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'bypassCategories')) {
      const bypass = sanitizeBypassList(entry.bypassCategories)
      if (bypass !== null) cleaned.bypassCategories = bypass
    }
    out[token] = cleaned
  }
  return out
}

/**
 * Sanitize the quiet-hours window (#4544).
 *
 * Requires `start`, `end`, AND `timezone` to all be present and well-formed
 * — a window without a timezone cannot be evaluated at the gate (see
 * `isInQuietHoursIn`'s fail-open behaviour), so we refuse to load a
 * half-shape that would silently mis-mute later.
 *
 * The IANA timezone is validated by constructing a `DateTimeFormat` with
 * the requested zone — Node throws `RangeError` for unknown zones, which
 * we catch and treat as a malformed window.
 */
function sanitizeQuietHours(raw) {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.start !== 'string' || typeof raw.end !== 'string') return null
  if (!_HHMM_RE.test(raw.start) || !_HHMM_RE.test(raw.end)) return null
  if (typeof raw.timezone !== 'string' || raw.timezone.length === 0) return null
  try {
    // Throws if the timezone is unrecognised.
    new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone })
  } catch {
    return null
  }
  return { start: raw.start, end: raw.end, timezone: raw.timezone }
}

/**
 * Sanitize the bypass-categories list (#4544).
 *
 * Returns `null` when the input is missing entirely (caller distinguishes
 * absent from empty-array via `null`). Returns an array of unique
 * non-empty strings otherwise — non-string entries are dropped silently
 * so a corrupted file doesn't break the gate. We intentionally do NOT
 * whitelist against `ALL_CATEGORIES` here so a forward-compatible install
 * (older binary, newer prefs file mentioning a category the binary hasn't
 * shipped yet) preserves the stored value.
 */
function sanitizeBypassList(raw) {
  if (raw == null) return null
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    seen.add(trimmed)
  }
  return [...seen]
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
    // bypassCategories: explicit on-disk array overrides defaults; absent
    // key keeps defaults. A read-side `null` (corruption / hand-edit) is
    // coerced to defaults so the gate never misbehaves.
    let bypass = base.bypassCategories
    if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'bypassCategories')) {
      const cleaned = sanitizeBypassList(raw.bypassCategories)
      bypass = cleaned ?? [...DEFAULT_BYPASS_CATEGORIES]
    }
    return {
      categories: { ...base.categories, ...sanitizeCategoryMap(raw?.categories) },
      devices: sanitizeDevices(raw?.devices),
      quietHours: sanitizeQuietHours(raw?.quietHours),
      bypassCategories: bypass,
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
 * Resolve the effective quiet-hours window for a device (#4544).
 *
 * Per-device entry REPLACES the global window when the device entry
 * carries the `quietHours` key — including the `null` case (which means
 * "this device is never muted by quiet hours"). When the device entry
 * does NOT carry the key, the global window applies.
 */
export function resolveQuietHoursWindow(prefs, pushToken) {
  if (!prefs || typeof prefs !== 'object') return null
  if (pushToken && prefs.devices) {
    const entry = prefs.devices[pushToken]
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'quietHours')) {
      return entry.quietHours
    }
  }
  return prefs.quietHours || null
}

/**
 * Resolve the effective bypass-category list for a device (#4544).
 *
 * Same REPLACE semantics as quiet-hours: per-device list (when present,
 * including empty array) wins entirely. When absent, the global list
 * (or `DEFAULT_BYPASS_CATEGORIES` when the global is also absent)
 * applies.
 */
export function resolveBypassCategories(prefs, pushToken) {
  if (!prefs || typeof prefs !== 'object') return [...DEFAULT_BYPASS_CATEGORIES]
  if (pushToken && prefs.devices) {
    const entry = prefs.devices[pushToken]
    if (entry && Array.isArray(entry.bypassCategories)) {
      return [...entry.bypassCategories]
    }
  }
  if (Array.isArray(prefs.bypassCategories)) return [...prefs.bypassCategories]
  return [...DEFAULT_BYPASS_CATEGORIES]
}

/**
 * Quick predicate: does this category bypass quiet hours for this device?
 * Pure composition over `resolveBypassCategories`.
 */
export function shouldBypassQuietHours(prefs, category, pushToken) {
  const list = resolveBypassCategories(prefs, pushToken)
  return list.includes(category)
}

/**
 * Format `now` (epoch ms) in the given IANA timezone and return its
 * minute-of-day (0..1439). Uses `Intl.DateTimeFormat` with a 24-hour
 * `h23` cycle so DST transitions and non-Pacific zones are handled
 * correctly without re-implementing zone math.
 *
 * Returns `null` when the timezone is unrecognised (Node throws
 * `RangeError` from the constructor; we treat that as a malformed window
 * and let the caller fail open).
 */
function _wallClockMinutes(now, timezone) {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
  } catch {
    return null
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return hour * 60 + minute
}

/** Parse "HH:MM" → minutes since midnight, or null on malformed input. */
function _parseHHMM(s) {
  if (typeof s !== 'string' || !_HHMM_RE.test(s)) return null
  const [h, m] = s.split(':').map(Number)
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/**
 * Real quiet-hours enforcement (#4544).
 *
 * Returns true when `now` falls inside the device's effective quiet-hours
 * window (per-device override beats global). The window is interpreted
 * with start INCLUSIVE and end EXCLUSIVE — i.e. [start, end) — so a
 * window of 22:00-07:00 includes 22:00:00.000 but excludes 07:00:00.000.
 *
 * Midnight wrap: when start > end the window spans midnight, so it
 * matches `minutes >= start OR minutes < end`. When start === end the
 * window has zero duration and never matches (defensive — a UI that
 * accidentally writes start=end shouldn't lock out all notifications).
 *
 * Defensive fail-open: any structural error (no window, no timezone,
 * unparseable times, unrecognised IANA zone) returns false. The
 * alternative — fail-CLOSED — would silently swallow every push for a
 * misconfigured user, which is the worst possible outcome for a
 * notification system. The companion checkers (`isCategoryEnabledIn`,
 * `RATE_LIMITS`) provide layered protection regardless.
 */
export function isInQuietHoursIn(prefs, now, pushToken) {
  // Defensive: `now` must be a finite epoch-ms. Without this guard a caller
  // passing `null`/`undefined`/`NaN` would coerce through `new Date(now)`
  // (e.g. `new Date(null)` → 1970-01-01T00:00:00Z) and silently activate
  // quiet hours for every push that happens to fall inside a window
  // overlapping 00:00 UTC. Fail-open (return false) matches the rest of
  // the function's posture — better to deliver a push than to silently
  // suppress all of them on a caller bug. (#4567)
  if (!Number.isFinite(now)) return false
  const window = resolveQuietHoursWindow(prefs, pushToken)
  if (!window) return false
  if (typeof window.timezone !== 'string' || window.timezone.length === 0) return false
  const startMin = _parseHHMM(window.start)
  const endMin = _parseHHMM(window.end)
  if (startMin == null || endMin == null) return false
  // Zero-duration window: never matches (defensive).
  if (startMin === endMin) return false
  const nowMin = _wallClockMinutes(now, window.timezone)
  if (nowMin == null) return false
  if (startMin < endMin) {
    // Same-day window.
    return nowMin >= startMin && nowMin < endMin
  }
  // Midnight-wrap window: [start, 24:00) ∪ [00:00, end).
  return nowMin >= startMin || nowMin < endMin
}
