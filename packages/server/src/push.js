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

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Rate limits per category (ms) — prevents notification spam
const RATE_LIMITS = {
  permission: 0,       // Always send permission prompts immediately
  idle: 60_000,        // At most once per minute for idle alerts
  result: 30_000,      // At most once per 30s for task completion
  activity_update: 10_000,  // Throttled: thinking/writing state changes
  activity_waiting: 0,      // Immediate: permission/input waiting
  activity_error: 0,        // Immediate: session errors
  live_activity: 5_000,     // Live Activity updates: 5s throttle
}

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
      console.error(`[push] Failed to persist tokens: ${err.message}`)
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
      console.log(`[push] Registered token: ${token.slice(0, 30)}...`)
      return true
    }
    console.warn(`[push] Rejected invalid token: ${String(token).slice(0, 40)}`)
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
      console.log(`[push] Registered Live Activity token: ${token.slice(0, 30)}...`)
      return true
    }
    console.warn(`[push] Rejected invalid Live Activity token: ${String(token).slice(0, 40)}`)
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
   * @param {string} category - 'permission' | 'idle' | 'result' | 'activity_update' | 'activity_waiting' | 'activity_error'
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

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      })

      if (!res.ok) {
        console.error(`[push] Expo Push API returned ${res.status}`)
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
            console.warn(`[push] Removing invalid token: ${token.slice(0, 30)}... (${ticket.message})`)
            this.tokens.delete(token)
            pruned = true
          }
        }
      }
      if (pruned) this._persistToDisk()

      console.log(`[push] Sent ${category} notification to ${messages.length} device(s)`)
    } catch (err) {
      console.error(`[push] Failed to send notification:`, err.message)
    }
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

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      })

      if (!res.ok) {
        console.error(`[push] Expo Push API returned ${res.status}`)
        return
      }

      const result = await res.json()

      // Prune Live Activity tokens that returned errors (invalid/expired)
      let pruned = false
      if (result.data) {
        for (let i = 0; i < result.data.length; i++) {
          const ticket = result.data[i]
          if (ticket.status === 'error') {
            const token = messages[i].to
            console.warn(`[push] Removing invalid Live Activity token: ${token.slice(0, 30)}... (${ticket.message})`)
            this._liveActivityTokens.delete(token)
            pruned = true
          }
        }
      }
      if (pruned) this._persistToDisk()

      console.log(`[push] Sent live_activity update to ${messages.length} device(s)`)
    } catch (err) {
      console.error(`[push] Failed to send Live Activity update:`, err.message)
    }
  }
}
