/**
 * PushManager — sends push notifications via Expo Push API.
 *
 * Stores push tokens registered by connected clients and sends
 * notifications for permission prompts, user questions, session errors,
 * and unattended query completions. Categories and their rate limits are
 * declared in RATE_LIMITS below.
 *
 * No Expo account or additional infrastructure required — uses the
 * free Expo Push Service (HTTPS POST to exp.host).
 *
 * Wired into server-cli.js via SessionManager event listeners.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'
import { metrics } from './metrics.js'
import { sleep, backoffDelay } from './utils/sleep.js'
import {
  loadPrefs as loadNotificationPrefs,
  savePrefs as saveNotificationPrefs,
  defaultPrefs as defaultNotificationPrefs,
  isCategoryEnabledIn,
  isInQuietHoursIn,
  shouldBypassQuietHours,
} from './notification-prefs.js'

const log = createLogger('push')

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Fetch timeout and retry configuration
const FETCH_TIMEOUT_MS = 10_000
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 1_000

/**
 * Fetch with timeout and exponential backoff retry.
 * Retries on 5xx responses and timeout/network errors.
 * Does NOT retry on 4xx client errors.
 */
async function fetchWithRetry(url, options) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timer)

      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res
      }

      // 5xx — retry if attempts remain
      if (attempt < MAX_RETRIES) {
        const delay = backoffDelay(attempt, BACKOFF_BASE_MS)
        log.warn(`Expo API returned ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
        await sleep(delay)
        continue
      }

      return res
    } catch (err) {
      clearTimeout(timer)

      if (attempt < MAX_RETRIES) {
        const delay = backoffDelay(attempt, BACKOFF_BASE_MS)
        log.warn(`Fetch failed (${err.name}: ${err.message}), retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
        await sleep(delay)
        continue
      }

      throw err
    }
  }
}

// Rate limits per category (ms) — prevents notification spam.
//
// History:
// - PR #2621 removed stream_start / tool_start → activity_update pushes,
//   so 'activity_update' now fires only on unattended 'result' events (the
//   noActiveViewers gate in server-cli.js prevents spam structurally, not
//   via this rate limit).
// - The 'idle' category was removed from the server's event-handling in
//   2026-04-11's notification audit after it was found to be firing in
//   duplicate with 'activity_update' for the same unattended-completion
//   case, producing two OS-level notifications per query. Left out of this
//   map so a future resurrection has to be deliberate.
const RATE_LIMITS = {
  permission: 0,       // Always send permission prompts immediately
  result: 30_000,      // At most once per 30s for task completion
  activity_update: 0,       // Immediate: one push per unattended completion (noActiveViewers gate is the real dedupe)
  activity_waiting: 0,      // Immediate: permission/input waiting
  activity_error: 0,        // Immediate: session errors
  inactivity_warning: 0,    // #3899: immediate — naturally rate-limited by the soft warning window (default 30 min between fires per session)
  live_activity: 5_000,     // Live Activity updates: 5s throttle
}

// Exported for testing
export { fetchWithRetry, FETCH_TIMEOUT_MS, MAX_RETRIES, BACKOFF_BASE_MS }

export class PushManager {
  constructor({ storagePath, prefsPath } = {}) {
    this._storagePath = storagePath || null
    // #4541: notification-prefs path. Optional — when omitted PushManager
    // operates entirely in-memory (callers like one-off tests don't need
    // to write to disk). When set, getPrefs / setPrefs round-trip
    // ~/.chroxy/notification-prefs.json with atomic temp+rename writes.
    this._prefsPath = prefsPath || null
    this._prefs = this._prefsPath
      ? loadNotificationPrefs(this._prefsPath, { log })
      : defaultNotificationPrefs()
    this.tokens = new Set()
    this._liveActivityTokens = new Set()
    this._lastSent = new Map() // category -> timestamp
    // Owner tracking for session-binding + prune-on-disconnect (audit
    // blocker 6). `_tokenOwners` maps token -> Set<ownerId> so that when
    // a client disconnects we can decrement its ownership and only
    // actually prune the token from `this.tokens` when the last owner
    // goes away. Without ref-counting, two connections registering the
    // same token would cause the first disconnect to strip the token
    // even though the second connection is still active (found by Copilot
    // review on PR #2806). Owner IDs are client connection IDs in
    // production; tests can use any unique string.
    this._tokenOwners = new Map()
    this._loadFromDisk()
  }

  /** Load tokens from disk if storagePath is set */
  _loadFromDisk() {
    if (!this._storagePath) return
    try {
      const data = JSON.parse(readFileSync(this._storagePath, 'utf-8'))
      // Support legacy format (plain array) and new format (object with keys)
      const pushTokens = Array.isArray(data) ? data : (data.tokens || [])
      const laTokens = Array.isArray(data) ? [] : (data.liveActivityTokens || [])
      for (const token of pushTokens) {
        if (typeof token === 'string' && token.length > 0) {
          this.tokens.add(token)
        }
      }
      for (const token of laTokens) {
        if (typeof token === 'string' && token.length > 0) {
          this._liveActivityTokens.add(token)
        }
      }
    } catch {
      // File missing or corrupt — start with empty set
    }
  }

  /** Persist current tokens to disk if storagePath is set */
  _persistToDisk() {
    if (!this._storagePath) return
    try {
      mkdirSync(dirname(this._storagePath), { recursive: true })
      writeFileRestricted(this._storagePath, JSON.stringify({
        tokens: [...this.tokens],
        liveActivityTokens: [...this._liveActivityTokens],
      }))
    } catch (err) {
      log.error(`Failed to persist tokens: ${err.message}`)
    }
  }

  /**
   * Return the current notification preferences (#4541). Returns a deep
   * clone so callers can read freely without aliasing internal state.
   * Categories not yet declared on disk fall through to documented
   * defaults via the loadPrefs merge.
   */
  getPrefs() {
    // Structured clone preserves nested categories / devices objects so
    // callers patching the returned object can't accidentally mutate
    // this._prefs.
    return JSON.parse(JSON.stringify(this._prefs))
  }

  /**
   * Patch preferences. Shallow-merge at the top level (`categories`,
   * `devices`, `quietHours`, `bypassCategories`); the categories map
   * itself is shallow-merged so an inbound patch that only mentions
   * `result` does not wipe the `permission` toggle the user set earlier.
   * Per-device entries are field-merged so the caller can patch one
   * device's quiet-hours window without wiping its category overrides.
   * Persists to disk when a `prefsPath` was configured at construction
   * time.
   *
   * #4544: `quietHours` now carries an IANA `timezone`; `bypassCategories`
   * is a list of category names that fire even during quiet hours
   * (defaults to permission + activity_error). Both fields accept the
   * same per-device override shape as the existing `categories` map.
   *
   * #4587: per-device entries are stamped with `lastSeenAt = Date.now()`
   * on every touch (create + modify; not on `null` delete). When the
   * caller supplies a `platform` (e.g. WS handler passing
   * `client.deviceInfo?.platform`) it's persisted with the entry — a
   * patch-supplied `platform` wins over the caller-supplied default so a
   * future client carrying richer info can still override the
   * auth-derived value.
   *
   * @param {object} patch - Partial prefs ({ categories?, devices?, quietHours?, bypassCategories? })
   * @param {object} [opts]
   * @param {string|null} [opts.platform] - Caller-supplied platform hint
   *   (from `client.deviceInfo.platform` in the WS auth context) used to
   *   stamp NEW per-device entries when the patch itself doesn't carry one.
   */
  setPrefs(patch, { platform = null } = {}) {
    if (!patch || typeof patch !== 'object') return this.getPrefs()
    const next = {
      categories: { ...this._prefs.categories },
      devices: { ...this._prefs.devices },
      quietHours: this._prefs.quietHours,
      bypassCategories: Array.isArray(this._prefs.bypassCategories)
        ? [...this._prefs.bypassCategories]
        : [],
    }
    if (patch.categories && typeof patch.categories === 'object') {
      // Shallow-merge into the existing categories map so unmentioned
      // toggles survive (per-category UI sends one category at a time).
      for (const [k, v] of Object.entries(patch.categories)) {
        if (typeof v === 'boolean') next.categories[k] = v
      }
    }
    if (patch.devices && typeof patch.devices === 'object') {
      // Per-device: shallow-merge the inner fields per device key. The
      // caller may patch one field (e.g. just `quietHours`) without
      // wiping the rest (e.g. an existing `categories` mute). A device
      // key not mentioned in the patch survives.
      for (const [token, entry] of Object.entries(patch.devices)) {
        if (entry === null) {
          // Explicit null deletes the entry.
          delete next.devices[token]
          continue
        }
        if (!entry || typeof entry !== 'object') continue
        const existing = next.devices[token] || { categories: {} }
        const merged = { ...existing }
        if (entry.categories && typeof entry.categories === 'object') {
          const mergedCategories = { ...(existing.categories || {}) }
          for (const [k, v] of Object.entries(entry.categories)) {
            if (typeof v === 'boolean') mergedCategories[k] = v
          }
          merged.categories = mergedCategories
        } else {
          merged.categories = existing.categories || {}
        }
        // Tri-state: present `quietHours` key (including null) is honoured;
        // absent key leaves the existing value alone. Matches the loader
        // semantics — `null` means "this device opts out of muting" while
        // `undefined` means "inherit global".
        if (Object.prototype.hasOwnProperty.call(entry, 'quietHours')) {
          merged.quietHours = entry.quietHours
        }
        // Same tri-state for bypassCategories. An explicit `null` resets
        // the device to inheriting the global list; an array (including
        // empty) records an override.
        if (Object.prototype.hasOwnProperty.call(entry, 'bypassCategories')) {
          if (entry.bypassCategories === null) {
            delete merged.bypassCategories
          } else if (Array.isArray(entry.bypassCategories)) {
            merged.bypassCategories = entry.bypassCategories.filter((c) => typeof c === 'string' && c.length > 0)
          }
        }
        // #4587: stamp lastSeenAt on every touch. The per-device list UI
        // uses this to render "Last seen X ago" so operators can tell
        // recently-active devices apart from stale orphans without having
        // to hand-read the prefs file.
        merged.lastSeenAt = Date.now()
        // Allow the caller to inject the canonical platform (from auth
        // deviceInfo). Patch-supplied platform wins over caller-supplied
        // (forward-compat: a future client could send a more specific value
        // than auth carries). Both paths clamp to 32 chars to match the
        // wire schema bound.
        if (typeof entry.platform === 'string' && entry.platform.length > 0) {
          merged.platform = entry.platform.slice(0, 32)
        } else if (typeof platform === 'string' && platform.length > 0) {
          merged.platform = platform.slice(0, 32)
        }
        next.devices[token] = merged
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'quietHours')) {
      // Allow explicit null to clear the window; the loader sanitises
      // shape on re-read so we don't need to validate here.
      next.quietHours = patch.quietHours || null
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'bypassCategories')) {
      // Replace the bypass list wholesale. An empty array is a legitimate
      // value (user says "nothing bypasses, not even errors") so we
      // intentionally do NOT default-fill here — that distinction is
      // preserved by `resolveBypassCategories` on the read path.
      if (Array.isArray(patch.bypassCategories)) {
        next.bypassCategories = patch.bypassCategories.filter((c) => typeof c === 'string' && c.length > 0)
      } else if (patch.bypassCategories === null) {
        // Explicit null restores defaults.
        next.bypassCategories = [...defaultNotificationPrefs().bypassCategories]
      }
    }
    // #4550: persist FIRST, swap in-memory state only after the save
    // succeeds. Pre-#4550 we assigned `this._prefs = next` unconditionally
    // and then tried to save; a failed rename (EACCES / EXDEV / quota)
    // re-threw out to the WS handler but left `_prefs` already mutated,
    // so `isCategoryEnabled` answered based on a value the user thought
    // failed to save — and the next process restart silently reverted
    // the change because disk never received it.
    if (this._prefsPath) {
      try {
        saveNotificationPrefs(next, this._prefsPath)
      } catch (err) {
        log.error(`Failed to persist notification prefs: ${err?.message || err}`)
        // Re-throw so the WS handler can surface a CREDENTIALS_WRITE_FAILED-
        // style error rather than silently lying about persistence. The
        // in-memory `_prefs` is intentionally left untouched here so the
        // next isCategoryEnabled / getPrefs call reflects the pre-patch
        // state, matching what's actually on disk.
        throw err
      }
    }
    this._prefs = next
    return this.getPrefs()
  }

  /**
   * Stamp `lastSeenAt` (and optionally `platform`) on an EXISTING device
   * entry without otherwise modifying it (#4587).
   *
   * No-op when the device has no entry — `register_push_token` calls this
   * on every reconnect, but we don't want to create empty per-device
   * entries for devices that have never muted anything. Empty entries
   * would clutter the per-device list with rows that have no overrides to
   * clear, defeating the purpose of the orphan-clearing UI in #4564.
   *
   * Called from `handleRegisterPushToken` so the per-device list reflects
   * the last CONNECT time of each device, not just the last time its
   * prefs were patched — without this, a device that registers but never
   * mutes a category would show a `lastSeenAt` from the first mute
   * forever.
   */
  touchDevice(token, platform = null) {
    if (typeof token !== 'string' || token.length === 0) return
    const existing = this._prefs.devices?.[token]
    if (!existing) return
    existing.lastSeenAt = Date.now()
    if (typeof platform === 'string' && platform.length > 0) {
      existing.platform = platform.slice(0, 32)
    }
    if (this._prefsPath) {
      try {
        saveNotificationPrefs(this._prefs, this._prefsPath)
      } catch (err) {
        // Metadata write failure is non-critical (push delivery still
        // works), so log and continue rather than throwing — unlike
        // setPrefs, which surfaces a write failure to the WS handler so
        // the client knows their patch didn't persist.
        log.error(`Failed to persist notification prefs: ${err?.message || err}`)
      }
    }
  }

  /**
   * Resolve "should category X fire for this device?" — composes the
   * global default and any per-device override. See `notification-prefs.js`
   * for the precedence rules. The defensive RATE_LIMITS gate in send()
   * still applies on top of this check, so user prefs can only mute
   * further than the server's rate limits already permit.
   */
  isCategoryEnabled(category, pushToken = null) {
    return isCategoryEnabledIn(this._prefs, category, pushToken)
  }

  /**
   * Resolve "is `now` inside this device's quiet-hours window?" (#4544).
   *
   * Honours per-device override precedence and timezone-aware boundary
   * math (including midnight wrap + DST). See `notification-prefs.js`
   * `isInQuietHoursIn` for the full evaluation rules and fail-open
   * defensive cases.
   */
  isInQuietHours(now = Date.now(), pushToken = null) {
    return isInQuietHoursIn(this._prefs, now, pushToken)
  }

  /**
   * Resolve "does this category bypass quiet hours for this device?"
   * (#4544). Operator-blocking categories (`permission`,
   * `activity_error`) bypass by default; users can extend or override
   * this list globally and per-device.
   */
  shouldBypassQuietHours(category, pushToken = null) {
    return shouldBypassQuietHours(this._prefs, category, pushToken)
  }

  /**
   * Register a push token from a client.
   *
   * Accepts Expo push tokens (`ExponentPushToken[...]`) and FCM tokens
   * (Firebase Cloud Messaging for Android) — both work with the Expo
   * Push API. Rejects obviously-malformed values.
   *
   * Per the 2026-04-11 production readiness audit (blocker 6), the old
   * implementation accepted ANY non-empty string, which let an
   * authenticated attacker register their own `ExponentPushToken[attacker]`
   * and intercept every future permission-prompt push notification. This
   * method now validates the format and (via the caller) binds each
   * registered token to the connection that registered it, so tokens get
   * pruned on client disconnect.
   */
  registerToken(token, ownerId = null) {
    if (typeof token !== 'string' || token.length === 0) {
      log.warn(`Rejected invalid push credential: ${String(token).slice(0, 40)}`)
      return false
    }
    if (!PushManager.isValidPushTokenFormat(token)) {
      log.warn(`Rejected malformed push credential (unrecognized format): ${token.slice(0, 40)}`)
      return false
    }
    if (!this.tokens.has(token)) {
      this.tokens.add(token)
      this._persistToDisk()
    }
    // Track ownership for ref-counted prune-on-disconnect (2026-04-11
    // audit blocker 6 + Copilot review on PR #2806). Multiple clients
    // may register the same token (reconnect race, multi-device); the
    // token is only pruned when the last owner disconnects.
    if (ownerId != null) {
      let owners = this._tokenOwners.get(token)
      if (!owners) {
        owners = new Set()
        this._tokenOwners.set(token, owners)
      }
      owners.add(ownerId)
    }
    log.info(`Registered push credential ${token.slice(0, 30)}...`)
    return true
  }

  /**
   * Release one owner's claim on a token. If the last owner goes away,
   * the token is removed from the registry entirely. Returns true if
   * the token was actually pruned (last owner), false if it's still
   * held by someone else.
   *
   * Used by WsServer._handleClientDeparture to prune on disconnect
   * without breaking legitimate multi-connection scenarios.
   */
  releaseTokenOwner(token, ownerId) {
    const owners = this._tokenOwners.get(token)
    if (!owners) {
      // No owner tracking — legacy / test path. Remove unconditionally.
      return this.removeToken(token)
    }
    owners.delete(ownerId)
    if (owners.size === 0) {
      this._tokenOwners.delete(token)
      return this.removeToken(token)
    }
    return false
  }

  /**
   * Validate a push-token string. This is a soft defense — it rejects
   * obviously-malformed input (empty strings, whitespace, JSON
   * punctuation, URLs) so typos and automated fuzzers don't land in
   * the token set. The REAL defense against push-token hijack is the
   * session-binding + prune-on-disconnect added in the same audit fix
   * (blocker 6): any token registered by a client is tracked on that
   * client's _ownedPushTokens and removed on disconnect.
   *
   * Policy: any non-empty string that is >= 20 characters, free of
   * whitespace/control characters, and free of JSON/URL punctuation
   * that would never appear in a real Expo or FCM token. Real tokens:
   *
   * - Expo: `ExponentPushToken[...]` (50+ chars)
   * - FCM: base64url-ish, ~150 chars typically but as short as 40 in
   *   some SDKs
   * - Legacy device tokens via the Firebase-Expo passthrough: variable
   */
  static isValidPushTokenFormat(token) {
    if (typeof token !== 'string') return false
    if (token.length < 20) return false
    // Reject whitespace (including tabs/newlines), quotes, braces,
    // angle brackets, forward slashes, and shell metacharacters that
    // signal the caller sent garbage (a URL, a JSON blob, an error
    // message, a shell-injection attempt) rather than a real push
    // token. Real Expo/FCM push tokens use only alphanumerics + a
    // restricted set of punctuation ([_-.:~%]) — the characters in
    // this reject list never appear in them.
    if (/[\s"'`<>{}&|;/\\?#]/.test(token)) return false
    return true
  }

  /**
   * Remove a push token unconditionally. Most callers should use
   * releaseTokenOwner() instead so multi-owner tokens aren't stripped
   * when one connection drops.
   */
  removeToken(token) {
    if (this.tokens.delete(token)) {
      this._tokenOwners.delete(token)
      this._persistToDisk()
      return true
    }
    return false
  }

  /**
   * Register a Live Activity push token (iOS).
   * Stored separately from regular push tokens.
   *
   * Applies the same format check as registerToken so the Live Activity
   * path can't be used as a bypass for the 2026-04-11 audit blocker 6
   * hardening. No WS handler currently exposes this path (verified on
   * PR #2806) but the check is cheap regression prevention.
   */
  registerLiveActivityToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
      log.warn(`Rejected invalid Live Activity credential: ${String(token).slice(0, 40)}`)
      return false
    }
    if (!PushManager.isValidPushTokenFormat(token)) {
      log.warn(`Rejected malformed Live Activity credential (unrecognized format): ${token.slice(0, 40)}`)
      return false
    }
    if (!this._liveActivityTokens.has(token)) {
      this._liveActivityTokens.add(token)
      this._persistToDisk()
    }
    log.info(`Registered Live Activity credential ${token.slice(0, 30)}...`)
    return true
  }

  /** Remove a Live Activity push token */
  unregisterLiveActivityToken(token) {
    if (this._liveActivityTokens.delete(token)) {
      this._persistToDisk()
    }
  }

  /** Check if we have any registered tokens */
  get hasTokens() {
    return this.tokens.size > 0
  }

  /**
   * Send a push notification to all registered tokens.
   *
   * Category names listed here are the only ones with explicit RATE_LIMITS
   * entries. Any other string still works but falls through to the
   * `?? 30_000` default inside send() — if you're adding a new category,
   * declare its rate limit explicitly in RATE_LIMITS. Note that `'idle'`
   * was intentionally removed during the 2026-04-11 notification audit
   * (it was firing in duplicate with activity_update); resurrecting it
   * should be a deliberate, documented decision.
   *
   * @param {string} category - 'permission' | 'result' | 'activity_update' | 'activity_waiting' | 'activity_error'
   * @param {string} title - Notification title
   * @param {string} body - Notification body text
   * @param {object} [data] - Extra data payload
   * @param {string} [categoryId] - iOS notification category for action buttons
   * @returns {Promise<boolean>} `true` when no hard delivery failure occurred
   *   (Expo accepted the post, or there was nothing to send / we were
   *   rate-limited — both of which are "no error" from the caller's view).
   *   `false` ONLY when the Expo API hard-failed (non-2xx, network throw).
   *   Callers like the idle-push dedupe in server-cli.js (#3870) use this
   *   to decide whether to release a latch so a transient failure doesn't
   *   permanently suppress future notifications.
   */
  async send(category, title, body, data = {}, categoryId = undefined) {
    if (this.tokens.size === 0) return true

    // Rate limit check — the FIRST line of defence. Stays in place
    // ahead of the #4542 per-category mute and the #4544 quiet-hours
    // gate so a single shared throttle still applies regardless of
    // per-device prefs. See RATE_LIMITS history comments above.
    const limit = RATE_LIMITS[category] ?? 30_000
    const lastSent = this._lastSent.get(category) || 0
    if (Date.now() - lastSent < limit) {
      return true
    }
    this._lastSent.set(category, Date.now())

    // #4542 per-category mute + #4544 quiet-hours gate, evaluated PER
    // TOKEN so a desktop and a phone with different prefs both get the
    // right behaviour from a single send() call. The quiet-hours gate
    // is conditional: a category in the device's bypass list (default
    // permission + activity_error) still fires even at 3am.
    const now = Date.now()
    const eligibleTokens = []
    for (const token of this.tokens) {
      if (!this.isCategoryEnabled(category, token)) continue
      if (this.isInQuietHours(now, token) && !this.shouldBypassQuietHours(category, token)) continue
      eligibleTokens.push(token)
    }
    if (eligibleTokens.length === 0) {
      // Every token filtered — no Expo POST. Returning `true` matches the
      // existing "nothing to send is not a failure" contract.
      return true
    }

    const messages = eligibleTokens.map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data: { ...data, category },
      ...(categoryId && { categoryId }),
    }))

    return await this._sendToTokenSet(this.tokens, messages, category, 'notification')
  }

  /**
   * Send a Live Activity update to all registered Live Activity tokens.
   * @param {string} state - Current activity state (e.g. 'thinking', 'writing', 'idle')
   * @param {string} detail - Human-readable detail text
   */
  async sendLiveActivityUpdate(state, detail) {
    if (this._liveActivityTokens.size === 0) return

    // Rate limit check (live_activity category: 5s)
    const category = 'live_activity'
    const limit = RATE_LIMITS[category]
    const lastSent = this._lastSent.get(category) || 0
    if (Date.now() - lastSent < limit) {
      return
    }
    this._lastSent.set(category, Date.now())

    const messages = [...this._liveActivityTokens].map((token) => ({
      to: token,
      sound: 'default',
      title: 'Live Activity',
      body: detail,
      data: { state, detail, category },
    }))

    await this._sendToTokenSet(this._liveActivityTokens, messages, category, 'update')
  }

  /**
   * Post messages to the Expo Push API and prune any tokens that come back
   * with an error status. Shared by send() and sendLiveActivityUpdate().
   *
   * @param {Set<string>} tokenSet - The Set to prune invalid tokens from
   * @param {object[]} messages - Pre-built Expo push message objects
   * @param {string} category - Category label used in log output
   * @param {string} logLabel - Human-readable label for log messages (e.g. 'notification', 'Live Activity update')
   * @returns {Promise<boolean>} `true` if Expo accepted the post (even when
   *   individual tokens came back with per-message errors — those are
   *   handled by pruning, not by reporting hard failure). `false` when the
   *   HTTPS POST itself failed (non-2xx, network/timeout caught here).
   *   Surfacing this lets callers (#3870) release per-session dedupe
   *   latches on real delivery failure so the next idle cycle can retry.
   */
  async _sendToTokenSet(tokenSet, messages, category, logLabel) {
    try {
      const res = await fetchWithRetry(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      })

      if (!res.ok) {
        metrics.inc('push.failures')
        log.error(`Expo Push API returned ${res.status}`)
        return false
      }

      const result = await res.json()

      // Prune tokens that returned errors (invalid/expired)
      let pruned = false
      if (result.data) {
        for (let i = 0; i < result.data.length; i++) {
          const ticket = result.data[i]
          if (ticket.status === 'error') {
            const token = messages[i].to
            log.warn(`Removing invalid push credential ${token.slice(0, 30)}... (${ticket.message})`)
            tokenSet.delete(token)
            pruned = true
          }
        }
      }
      if (pruned) this._persistToDisk()

      metrics.inc('push.sent')
      log.info(`Sent ${category} ${logLabel} to ${messages.length} device(s)`)
      return true
    } catch (err) {
      metrics.inc('push.failures')
      log.error(`Failed to send ${logLabel}: ${err.message}`)
      return false
    }
  }
}
