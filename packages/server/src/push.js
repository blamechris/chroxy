/**
 * PushManager — sends push notifications via Expo Push API.
 *
 * Stores push tokens registered by connected clients and sends
 * notifications for permission prompts and idle alerts.
 * Rate-limited per category to avoid notification spam.
 *
 * No Expo account or additional infrastructure required — uses the
 * free Expo Push Service (HTTPS POST to exp.host).
 *
 * Currently wired into CLI headless mode only (server-cli.js).
 * PTY/tmux mode (server.js) does not integrate push notifications.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

// Rate limits per category (ms) — prevents notification spam
const RATE_LIMITS = {
  permission: 0,       // Always send permission prompts immediately
  idle: 60_000,        // At most once per minute for idle alerts
  result: 30_000,      // At most once per 30s for task completion
}

export class PushManager {
  constructor() {
    this.tokens = new Set()
    this._lastSent = new Map() // category -> timestamp
  }

  /** Register a push token from a client */
  registerToken(token) {
    if (typeof token === 'string' && token.startsWith('ExponentPushToken[')) {
      this.tokens.add(token)
      console.log(`[push] Registered token: ${token.slice(0, 30)}...`)
      return true
    }
    console.warn(`[push] Rejected invalid token: ${String(token).slice(0, 40)}`)
    return false
  }

  /** Remove a push token */
  removeToken(token) {
    this.tokens.delete(token)
  }

  /** Check if we have any registered tokens */
  get hasTokens() {
    return this.tokens.size > 0
  }

  /**
   * Send a push notification to all registered tokens.
   * @param {string} category - 'permission' | 'idle' | 'result'
   * @param {string} title - Notification title
   * @param {string} body - Notification body text
   * @param {object} [data] - Extra data payload
   */
  async send(category, title, body, data = {}) {
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
      if (result.data) {
        for (let i = 0; i < result.data.length; i++) {
          const ticket = result.data[i]
          if (ticket.status === 'error') {
            const token = messages[i].to
            console.warn(`[push] Removing invalid token: ${token.slice(0, 30)}... (${ticket.message})`)
            this.tokens.delete(token)
          }
        }
      }

      console.log(`[push] Sent ${category} notification to ${messages.length} device(s)`)
    } catch (err) {
      console.error(`[push] Failed to send notification:`, err.message)
    }
  }
}
