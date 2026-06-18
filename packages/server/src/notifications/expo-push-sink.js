/**
 * ExpoPushSink — Expo Push API delivery channel (#5413 Phase 1).
 *
 * Extracted from push.js: everything Expo-specific lives here — the push
 * token registry (with disk persistence and owner ref-counting), token
 * format validation, the HTTPS POST to exp.host with timeout/backoff
 * retry, ticket-based pruning of invalid tokens, and the iOS Live
 * Activity token path.
 *
 * Sink-agnostic gating (category prefs, quiet hours, rate limits) stays
 * upstream in PushManager; the one per-DEVICE concern — "is this category
 * muted on this specific phone?" — is evaluated here per token via the
 * `context` evaluators the pipeline passes to send() (see sink.js for the
 * contract).
 *
 * No Expo account or additional infrastructure required — uses the free
 * Expo Push Service (HTTPS POST to exp.host).
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileRestricted } from '../platform.js'
import { createLogger } from '../logger.js'
import { metrics } from '../metrics.js'
import { sleep, backoffDelay } from '../utils/sleep.js'
import { NotificationSink } from './sink.js'

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

// Exported for testing (re-exported from push.js for existing importers)
export { fetchWithRetry, FETCH_TIMEOUT_MS, MAX_RETRIES, BACKOFF_BASE_MS }

export class ExpoPushSink extends NotificationSink {
  constructor({ storagePath } = {}) {
    super({ name: 'expo-push' })
    this._storagePath = storagePath || null
    this.tokens = new Set()
    this._liveActivityTokens = new Set()
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
    if (!ExpoPushSink.isValidPushTokenFormat(token)) {
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
    if (!ExpoPushSink.isValidPushTokenFormat(token)) {
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

  /** Check if we have any registered Live Activity tokens */
  get hasLiveActivityTokens() {
    return this._liveActivityTokens.size > 0
  }

  /** Sink contract: configured iff at least one push token is registered */
  isConfigured() {
    return this.tokens.size > 0
  }

  /**
   * Sink contract: deliver one approved notification to every registered
   * token, applying the per-DEVICE prefs evaluators from `context` (#4542
   * per-category mute + #4544 quiet-hours gate, evaluated PER TOKEN so a
   * desktop and a phone with different prefs both get the right behaviour
   * from a single pipeline call). The quiet-hours gate is conditional: a
   * category in the device's bypass list (default permission +
   * activity_error) still fires even at 3am. Missing evaluators fail open
   * (see sink.js).
   */
  async send(notification, context = {}) {
    const { category, title, body, data = {}, categoryId } = notification
    const now = context.now ?? Date.now()
    const isCategoryEnabled = context.isCategoryEnabled ?? (() => true)
    const isInQuietHours = context.isInQuietHours ?? (() => false)
    const shouldBypassQuietHours = context.shouldBypassQuietHours ?? (() => false)

    const eligibleTokens = []
    for (const token of this.tokens) {
      if (!isCategoryEnabled(category, token)) continue
      if (isInQuietHours(now, token) && !shouldBypassQuietHours(category, token)) continue
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
   * Expo-only side channel — not part of the NotificationSink contract
   * (rate limiting for it stays upstream in PushManager).
   * @param {string} state - Current activity state (e.g. 'thinking', 'writing', 'idle')
   * @param {string} detail - Human-readable detail text
   */
  async sendLiveActivityUpdate(state, detail) {
    const messages = [...this._liveActivityTokens].map((token) => ({
      to: token,
      sound: 'default',
      title: 'Live Activity',
      body: detail,
      data: { state, detail, category: 'live_activity' },
    }))

    await this._sendToTokenSet(this._liveActivityTokens, messages, 'live_activity', 'update')
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
