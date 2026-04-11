/**
 * PushManager — sends push notifications via Expo Push API.
 *
 * Stores push tokens registered by connected clients and sends
 * notifications for permission prompts, idle alerts, and activity updates.
 * Rate-limited per category to avoid notification spam.
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
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
        log.warn(`Expo API returned ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      return res
    } catch (err) {
      clearTimeout(timer)

      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
        log.warn(`Fetch failed (${err.name}: ${err.message}), retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`)
        await new Promise(r => setTimeout(r, delay))
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
  live_activity: 5_000,     // Live Activity updates: 5s throttle
}

// Exported for testing
export { fetchWithRetry, FETCH_TIMEOUT_MS, MAX_RETRIES, BACKOFF_BASE_MS }

export class PushManager {
  constructor({ storagePath } = {}) {
    this._storagePath = storagePath || null
    this.tokens = new Set()
    this._liveActivityTokens = new Set()
    this._lastSent = new Map() // category -> timestamp
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
   * Accepts any non-empty string — Expo push tokens (ExponentPushToken[...])
   * and FCM tokens (Firebase Cloud Messaging for Android) both work with
   * the Expo Push API.
   */
  registerToken(token) {
    if (typeof token === 'string' && token.length > 0) {
      if (!this.tokens.has(token)) {
        this.tokens.add(token)
        this._persistToDisk()
      }
      log.info(`Registered push credential ${token.slice(0, 30)}...`)
      return true
    }
    log.warn(`Rejected invalid push credential: ${String(token).slice(0, 40)}`)
    return false
  }

  /** Remove a push token */
  removeToken(token) {
    if (this.tokens.delete(token)) {
      this._persistToDisk()
    }
  }

  /**
   * Register a Live Activity push token (iOS).
   * Stored separately from regular push tokens.
   */
  registerLiveActivityToken(token) {
    if (typeof token === 'string' && token.length > 0) {
      if (!this._liveActivityTokens.has(token)) {
        this._liveActivityTokens.add(token)
        this._persistToDisk()
      }
      log.info(`Registered Live Activity credential ${token.slice(0, 30)}...`)
      return true
    }
    log.warn(`Rejected invalid Live Activity credential: ${String(token).slice(0, 40)}`)
    return false
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
   * @param {string} category - 'permission' | 'result' | 'activity_update' | 'activity_waiting' | 'activity_error'
   * @param {string} title - Notification title
   * @param {string} body - Notification body text
   * @param {object} [data] - Extra data payload
   * @param {string} [categoryId] - iOS notification category for action buttons
   */
  async send(category, title, body, data = {}, categoryId = undefined) {
    if (this.tokens.size === 0) return

    // Rate limit check
    const limit = RATE_LIMITS[category] ?? 30_000
    const lastSent = this._lastSent.get(category) || 0
    if (Date.now() - lastSent < limit) {
      return
    }
    this._lastSent.set(category, Date.now())

    const messages = [...this.tokens].map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data: { ...data, category },
      ...(categoryId && { categoryId }),
    }))

    await this._sendToTokenSet(this.tokens, messages, category, 'notification')
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
   */
  async _sendToTokenSet(tokenSet, messages, category, logLabel) {
    try {
      const res = await fetchWithRetry(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      })

      if (!res.ok) {
        log.error(`Expo Push API returned ${res.status}`)
        return
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

      log.info(`Sent ${category} ${logLabel} to ${messages.length} device(s)`)
    } catch (err) {
      log.error(`Failed to send ${logLabel}: ${err.message}`)
    }
  }
}
