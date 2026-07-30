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
  // #5413 Phase 3: external-session categories fed by POST /api/events.
  // Listed here so they are mutable in prefs and visible in snapshots —
  // sanitizeCategoryMap strips unknown keys, so omitting them would make
  // external-session pushes permanently un-mutable (#5432 review C1).
  'session_online',
  'session_offline',
  'session_activity',
  // #5828: billing-canary warnings (silent metered default; reclassification
  // trip; opt-in datacenter egress). Listed so they are mutable in prefs and
  // visible in snapshots; sanitizeCategoryMap would otherwise strip them as unknown.
  'billing_warning',
  // Mailbox live-interrupt: "new mail" pings fed by POST /api/mailbox
  // (mailbox-route.js). Listed so the category is mutable in prefs and visible
  // in snapshots (sanitizeCategoryMap strips unknown keys otherwise).
  'mailbox',
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

/**
 * #7080 — wire bounds mirroring `ServerNotificationPrefsSchema` in @chroxy/protocol
 * (schemas/server/billing.ts): a bypass entry is `min(1).max(64)`, the list is
 * `.max(64)` items, and a device token is a record key of `min(1).max(512)`.
 *
 * The loader used to enforce TYPE only (`typeof s === 'string' && s.length > 0`)
 * while the schema constrains RANGE, so a hand-edited prefs file produced a
 * message the clients could not parse. The failure is unusually bad for a
 * "cosmetic" cap: the client safeParses the WHOLE message, so `notificationPrefs`
 * stays null and the dashboard renders "Loading preferences…" indefinitely on both
 * clients — and `push.js` re-persists the offending value on the next patch, so it
 * never self-heals. Refusing the value here is what keeps the panel alive.
 *
 * Pinned by a test that safeParses the REAL schema, so these cannot drift silently.
 * (#7085 tracks exporting these from @chroxy/protocol so loaders stop retyping them.)
 */
const MAX_BYPASS_CATEGORY_CHARS = 64
const MAX_BYPASS_CATEGORIES = 64
const MAX_DEVICE_TOKEN_CHARS = 512

const _ALL_CATEGORIES_SET = new Set(ALL_CATEGORIES)
// Two-digit zero-padded HH:MM with HH in 00-23 and MM in 00-59 (#4566).
// The narrower regex replaces the older `/^\d{2}:\d{2}$/`, which accepted
// out-of-range values like `25:99` and let a hand-edited typo land in the
// in-memory prefs before fail-opening at gate-eval time.
const _HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/

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
function sanitizeDevices(raw, { log } = {}) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [token, entry] of Object.entries(raw)) {
    if (typeof token !== 'string' || token.length === 0) continue
    // #7080: DROP an over-cap token, symmetric with the non-string/empty cases
    // above. A push token is an ADDRESS: truncating it to 512 yields a token that
    // addresses nothing and is then re-persisted by the next patch, permanently
    // corrupting the file. Dropping self-heals on the next register_push_token.
    if (token.length > MAX_DEVICE_TOKEN_CHARS) {
      // NOTE this is DESTRUCTIVE on the next write: loadPrefs' output is also what
      // savePrefs persists, and push.js `touchDevice` re-persists the whole
      // sanitized object on every register_push_token — so one phone reconnecting
      // erases this entry from disk. Accepted deliberately: a >512-char key cannot
      // be a real push token, so nothing addressable is lost, and the alternative
      // (preserving it) needs a load-for-wire / load-for-persistence split that
      // does not exist here. Unlike a scheduled task (#7050), there is no operator
      // data in an unrouteable token worth keeping.
      log?.warn?.(`notification-prefs: dropped a device entry whose token exceeds ${MAX_DEVICE_TOKEN_CHARS} chars (unrepresentable on the wire; it will not survive the next save)`)
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const cleaned = { categories: sanitizeCategoryMap(entry.categories) }
    // Tri-state: present-as-null means "explicitly disable muting on this
    // device"; present-as-window means "use this window"; absent means
    // "fall back to global". hasOwnProperty distinguishes absent from null.
    if (Object.prototype.hasOwnProperty.call(entry, 'quietHours')) {
      cleaned.quietHours = sanitizeQuietHours(entry.quietHours)
      // #4566: surface a typo on a per-device window — the original block
      // existed on disk but failed range/shape validation, so the device
      // silently inherits "no muting" (null). Warn so the operator notices
      // rather than discovering it the next time a notification fires
      // outside their expected window.
      if (cleaned.quietHours === null && entry.quietHours !== null) {
        log?.warn?.(`notification-prefs: device ${token} quietHours rejected (invalid shape or out-of-range HH:MM)`)
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'bypassCategories')) {
      const bypass = sanitizeBypassList(entry.bypassCategories, { log, context: `device ${token} bypassCategories` })
      if (bypass !== null) cleaned.bypassCategories = bypass
    }
    // #4587: non-critical metadata for the per-device list UI. Operators
    // need to tell orphan entries apart before clicking Clear — the truncated
    // token alone is opaque. Strict type/range guards; no log warns
    // because a malformed metadata field should never affect notification
    // delivery (it just degrades the UI hint).
    if (typeof entry.lastSeenAt === 'number' && Number.isFinite(entry.lastSeenAt) && entry.lastSeenAt > 0) {
      cleaned.lastSeenAt = entry.lastSeenAt
    }
    if (typeof entry.platform === 'string' && entry.platform.length > 0 && entry.platform.length <= 32) {
      cleaned.platform = entry.platform
    }
    out[token] = cleaned
  }
  return out
}

/**
 * Sanitize the quiet-hours window (#4544, tightened #4566).
 *
 * Requires `start`, `end`, AND `timezone` to all be present and well-formed
 * — a window without a timezone cannot be evaluated at the gate (see
 * `isInQuietHoursIn`'s fail-open behaviour), so we refuse to load a
 * half-shape that would silently mis-mute later.
 *
 * `start`/`end` must match the two-digit zero-padded `HH:MM` form with
 * `HH` in 00-23 and `MM` in 00-59 (#4566). The previous regex
 * (`/^\d{2}:\d{2}$/`) accepted out-of-range values like `25:99`, which
 * survived the loader and silently fail-opened at gate-eval time; the
 * stricter pattern in `_HHMM_RE` rejects those at load. Returning `null`
 * here triggers a `log.warn` in `loadPrefs` so the typo surfaces.
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
function sanitizeBypassList(raw, { log, context = 'bypassCategories' } = {}) {
  if (raw == null) return null
  if (!Array.isArray(raw)) return []
  // Retain KNOWN categories (a fixed set of ALL_CATEGORIES.length) and at most
  // MAX_BYPASS_CATEGORIES unknowns, so a hostile file with a huge array cannot make
  // the loader hold the whole thing. Deliberately NOT "keep the first N while
  // iterating": that bounds memory but is positional, which is exactly what dropped
  // a real `permission` entry past the cap (see the clamp comment below).
  const knownSeen = new Set()
  const unknownSeen = new Set()
  let droppedLong = 0
  let droppedOverflow = 0
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    // #7080: REJECT the element rather than truncating it. A category name is an
    // identifier matched against ALL_CATEGORIES, so a truncated name matches
    // nothing AND gets re-persisted — strictly worse than dropping it. This does
    // narrow the forward-compat intent above: a future category longer than the
    // wire cap will not be preserved by an older binary. That trade is
    // deliberate — one un-bypassed category beats a dead notification panel.
    if (trimmed.length > MAX_BYPASS_CATEGORY_CHARS) {
      droppedLong += 1
      continue
    }
    if (ALL_CATEGORIES.includes(trimmed)) {
      knownSeen.add(trimmed)
      continue
    }
    // Unknowns are the only unbounded input, so they are the only thing capped
    // during iteration. A known category can never be lost this way.
    if (unknownSeen.size >= MAX_BYPASS_CATEGORIES) {
      droppedOverflow += 1
      continue
    }
    unknownSeen.add(trimmed)
  }
  if (droppedLong > 0) {
    log?.warn?.(`notification-prefs: dropped ${droppedLong} ${context} entr${droppedLong === 1 ? 'y' : 'ies'} longer than ${MAX_BYPASS_CATEGORY_CHARS} chars (unrepresentable on the wire)`)
  }
  const list = [...knownSeen, ...unknownSeen]
  if (list.length <= MAX_BYPASS_CATEGORIES && droppedOverflow === 0) return list
  // CLAMP the length — but NOT positionally. A plain slice(0, N) drops whatever
  // sits past the cap, which can be a REAL category: losing `permission` from the
  // bypass list suppresses a blocking permission prompt during quiet hours and the
  // agent stalls indefinitely (the #4544 rationale above). That is a worse failure
  // than the unparseable snapshot this bound exists to prevent.
  //
  // So keep every RECOGNISED category first, then fill the remaining slots with
  // unrecognised ones (preserving their relative order). This also serves the
  // forward-compat intent better than a slice: the entries at risk of being
  // dropped are now exactly the ones this binary cannot act on anyway.
  const kept = list.slice(0, MAX_BYPASS_CATEGORIES)
  const dropped = (list.length - kept.length) + droppedOverflow
  log?.warn?.(`notification-prefs: ${context} exceeded ${MAX_BYPASS_CATEGORIES} entries; keeping ${kept.length} (recognised categories first, ${dropped} unrecognised dropped)`)
  return kept
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
      const cleaned = sanitizeBypassList(raw.bypassCategories, { log })
      bypass = cleaned ?? [...DEFAULT_BYPASS_CATEGORIES]
    }
    const cleanedQuietHours = sanitizeQuietHours(raw?.quietHours)
    // #4566: warn when the on-disk file carried a quietHours block but it
    // failed validation. The pre-#4566 behaviour silently dropped the bad
    // window and the operator believed quiet-hours were active. We skip
    // the warn for `null` (explicit "no quiet hours") and for "key absent"
    // — only a present, non-null, rejected block deserves the signal.
    const rawQuietHours = raw?.quietHours
    if (
      cleanedQuietHours === null &&
      rawQuietHours !== null &&
      rawQuietHours !== undefined
    ) {
      log?.warn?.(`notification-prefs ${filePath} quietHours rejected (invalid shape or out-of-range HH:MM)`)
    }
    return {
      categories: { ...base.categories, ...sanitizeCategoryMap(raw?.categories) },
      devices: sanitizeDevices(raw?.devices, { log }),
      quietHours: cleanedQuietHours,
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
 * Memoized `Intl.DateTimeFormat` instances keyed by IANA timezone (#4568).
 *
 * The quiet-hours gate runs once per registered push token per
 * `PushManager.send()` call. Each `Intl.DateTimeFormat` instance carries a
 * few KB of locale data, so re-allocating on every call wastes work in a hot
 * path that scales with token count.
 *
 * Bounded memory: the set of timezones in real prefs is tiny (one global
 * window plus at most one per device) and stable for the process lifetime,
 * so a plain `Map` with no eviction is safe — no LRU bookkeeping needed.
 * If a future feature lets users construct ad-hoc timezone strings (e.g.
 * from untrusted input), revisit this; today every timezone arrives via
 * `sanitizeQuietHours`, which only persists strings the constructor accepts.
 *
 * Failure-cache policy: we only cache SUCCESSFUL constructions. A
 * `RangeError` from an unrecognised IANA zone returns `null` upstream so
 * the gate fail-opens; never caching the failure means a later prefs reload
 * that fixes the typo will reconstruct cleanly with the same key.
 */
const _dtfCache = new Map()

/**
 * Test-only escape hatch: clear the cached formatters so a test can
 * deterministically count constructor invocations (e.g. by spying on
 * `Intl.DateTimeFormat`). Production code never needs this — the cache is
 * correct for the process lifetime.
 */
export function _resetDateTimeFormatCacheForTests() {
  _dtfCache.clear()
}

function _getDateTimeFormat(timezone) {
  let dtf = _dtfCache.get(timezone)
  if (dtf) return dtf
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    return null
  }
  _dtfCache.set(timezone, dtf)
  return dtf
}

/**
 * Format `now` (epoch ms) in the given IANA timezone and return its
 * minute-of-day (0..1439). Uses `Intl.DateTimeFormat` with a 24-hour
 * `h23` cycle so DST transitions and non-Pacific zones are handled
 * correctly without re-implementing zone math.
 *
 * Returns `null` when the timezone is unrecognised (Node throws
 * `RangeError` from the constructor; we treat that as a malformed window
 * and let the caller fail open). Formatter instances are memoized in
 * `_dtfCache` to avoid re-allocating locale data on every call (#4568).
 */
function _wallClockMinutes(now, timezone) {
  const dtf = _getDateTimeFormat(timezone)
  if (!dtf) return null
  const parts = dtf.formatToParts(new Date(now))
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
