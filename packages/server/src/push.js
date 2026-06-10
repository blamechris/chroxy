/**
 * PushManager — the shared notification pipeline (#5413 Phase 1).
 *
 * Owns everything that must behave identically for every delivery channel:
 * notification preferences (#4541/#4544), the per-category RATE_LIMITS
 * throttle, and the fan-out to configured sinks via SinkRegistry. The
 * Expo-specific delivery (token registry, exp.host POST, ticket pruning,
 * Live Activity) lives in ExpoPushSink (notifications/expo-push-sink.js) —
 * extracted from this file so #5413 Phase 2 can register a
 * DiscordWebhookSink alongside it with no pipeline changes. See
 * notifications/sink.js for the sink contract.
 *
 * For now PushManager keeps its full pre-extraction public surface
 * (registerToken, releaseTokenOwner, Live Activity registration, the
 * `tokens` set, ...) by delegating to the Expo sink, so callers
 * (server-cli.js, supervisor.js, ws handlers) and existing tests are
 * untouched. Per-sink wiring/config is a Phase 2 concern.
 *
 * Wired into server-cli.js via SessionManager event listeners.
 */

import { createLogger } from './logger.js'
import {
  loadPrefs as loadNotificationPrefs,
  savePrefs as saveNotificationPrefs,
  defaultPrefs as defaultNotificationPrefs,
  isCategoryEnabledIn,
  isInQuietHoursIn,
  shouldBypassQuietHours,
} from './notification-prefs.js'
import { SinkRegistry } from './notifications/sink-registry.js'
import {
  ExpoPushSink,
  fetchWithRetry,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  BACKOFF_BASE_MS,
} from './notifications/expo-push-sink.js'

const log = createLogger('push')

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

// Re-exported for existing importers/tests — the implementation moved to
// notifications/expo-push-sink.js with the rest of the Expo delivery code.
export { fetchWithRetry, FETCH_TIMEOUT_MS, MAX_RETRIES, BACKOFF_BASE_MS }

export class PushManager {
  constructor({ storagePath, prefsPath } = {}) {
    // #4541: notification-prefs path. Optional — when omitted PushManager
    // operates entirely in-memory (callers like one-off tests don't need
    // to write to disk). When set, getPrefs / setPrefs round-trip
    // ~/.chroxy/notification-prefs.json with atomic temp+rename writes.
    this._prefsPath = prefsPath || null
    this._prefs = this._prefsPath
      ? loadNotificationPrefs(this._prefsPath, { log })
      : defaultNotificationPrefs()
    this._lastSent = new Map() // category -> timestamp
    // #5413 Phase 1: delivery channels live behind the sink registry. The
    // Expo sink owns the token registry + persistence; it's also kept on a
    // named field because PushManager's legacy public surface (registerToken,
    // Live Activity, the `tokens` set) delegates to it directly.
    this._expoSink = new ExpoPushSink({ storagePath })
    this._sinks = new SinkRegistry({ logger: log })
    this._sinks.register(this._expoSink)
  }

  /**
   * Registered push tokens (delegates to the Expo sink — same live Set,
   * so existing callers/tests that mutate it directly keep working).
   */
  get tokens() {
    return this._expoSink.tokens
  }

  /** Live Activity tokens (delegates to the Expo sink — same live Set). */
  get _liveActivityTokens() {
    return this._expoSink._liveActivityTokens
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
   * Register a push token from a client. Delegates to the Expo sink —
   * see ExpoPushSink.registerToken for format validation and the
   * 2026-04-11 audit (blocker 6) history.
   */
  registerToken(token, ownerId = null) {
    return this._expoSink.registerToken(token, ownerId)
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
    return this._expoSink.releaseTokenOwner(token, ownerId)
  }

  /**
   * Validate a push-token string. Implementation lives on ExpoPushSink
   * (it's an Expo/FCM token format concern); kept on PushManager because
   * the WS prefs handler validates device keys through this surface.
   */
  static isValidPushTokenFormat(token) {
    return ExpoPushSink.isValidPushTokenFormat(token)
  }

  /**
   * Remove a push token unconditionally. Most callers should use
   * releaseTokenOwner() instead so multi-owner tokens aren't stripped
   * when one connection drops.
   */
  removeToken(token) {
    return this._expoSink.removeToken(token)
  }

  /** Register a Live Activity push token (iOS). Delegates to the Expo sink. */
  registerLiveActivityToken(token) {
    return this._expoSink.registerLiveActivityToken(token)
  }

  /** Remove a Live Activity push token */
  unregisterLiveActivityToken(token) {
    return this._expoSink.unregisterLiveActivityToken(token)
  }

  /** Check if we have any registered tokens */
  get hasTokens() {
    return this._expoSink.hasTokens
  }

  /**
   * Send a notification through the pipeline: shared rate limit, then fan
   * out to every configured sink (per-device category/quiet-hours prefs
   * are evaluated inside each sink via the context evaluators below).
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
   *   (the sinks accepted it, or there was nothing to send / we were
   *   rate-limited — both of which are "no error" from the caller's view).
   *   `false` ONLY when a configured sink hard-failed (for Expo: non-2xx,
   *   network throw). Callers like the idle-push dedupe in server-cli.js
   *   (#3870) use this to decide whether to release a latch so a transient
   *   failure doesn't permanently suppress future notifications.
   */
  async send(category, title, body, data = {}, categoryId = undefined) {
    // No sink has anywhere to deliver to — silent no-op, and intentionally
    // BEFORE the rate-limit stamp (matching the pre-extraction
    // `tokens.size === 0` early return) so a tokenless send doesn't burn
    // the category's rate-limit window.
    if (!this._sinks.hasConfigured()) return true

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

    return await this._sinks.fanOut(
      { category, title, body, data, categoryId },
      {
        now: Date.now(),
        isCategoryEnabled: (cat, deviceId) => this.isCategoryEnabled(cat, deviceId),
        isInQuietHours: (now, deviceId) => this.isInQuietHours(now, deviceId),
        shouldBypassQuietHours: (cat, deviceId) => this.shouldBypassQuietHours(cat, deviceId),
      }
    )
  }

  /**
   * Send a Live Activity update to all registered Live Activity tokens.
   * Expo-only side channel — goes straight to the Expo sink rather than
   * through the registry fan-out (no other sink has a Live Activity
   * concept). The shared rate-limit map still applies here so the
   * `live_activity` throttle and notification categories share one clock.
   * @param {string} state - Current activity state (e.g. 'thinking', 'writing', 'idle')
   * @param {string} detail - Human-readable detail text
   */
  async sendLiveActivityUpdate(state, detail) {
    if (!this._expoSink.hasLiveActivityTokens) return

    // Rate limit check (live_activity category: 5s)
    const category = 'live_activity'
    const limit = RATE_LIMITS[category]
    const lastSent = this._lastSent.get(category) || 0
    if (Date.now() - lastSent < limit) {
      return
    }
    this._lastSent.set(category, Date.now())

    await this._expoSink.sendLiveActivityUpdate(state, detail)
  }
}
