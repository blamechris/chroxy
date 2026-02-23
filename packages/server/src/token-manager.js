import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { safeTokenCompare } from './crypto.js'

/**
 * Manages token lifecycle with optional rotation and expiry.
 *
 * When tokenExpiry is set, the manager:
 * 1. Schedules a rotation before the current token expires
 * 2. Generates a new token and emits 'token_rotated'
 * 3. Keeps the old token valid for a grace period
 * 4. Calls the persist callback to save the new token
 *
 * Events:
 *   token_rotated { oldToken, newToken, expiresAt }
 */

// Default grace period: 5 minutes
const DEFAULT_GRACE_MS = 5 * 60 * 1000

// Rotate 10% before expiry (min 60s, max 10min before)
function rotationLeadTime(expiryMs) {
  const lead = Math.max(60_000, Math.min(expiryMs * 0.1, 10 * 60 * 1000))
  return lead
}

/**
 * Parse a duration string like '24h', '7d', '1h30m' into milliseconds.
 * Supported units: s (seconds), m (minutes), h (hours), d (days).
 * Returns null for invalid or empty input.
 */
export function parseDuration(str) {
  if (!str || typeof str !== 'string') return null
  const cleaned = str.trim().toLowerCase()
  if (!cleaned) return null

  // Try plain number (treated as seconds)
  if (/^\d+$/.test(cleaned)) {
    return parseInt(cleaned, 10) * 1000
  }

  let total = 0
  const regex = /(\d+)\s*(s|m|h|d)/g
  let match
  let found = false
  while ((match = regex.exec(cleaned)) !== null) {
    found = true
    const value = parseInt(match[1], 10)
    switch (match[2]) {
      case 's': total += value * 1000; break
      case 'm': total += value * 60 * 1000; break
      case 'h': total += value * 60 * 60 * 1000; break
      case 'd': total += value * 24 * 60 * 60 * 1000; break
    }
  }

  return found && total > 0 ? total : null
}

export class TokenManager extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.token - Current API token
   * @param {string|null} opts.tokenExpiry - Expiry duration (e.g. '24h', '7d') or null
   * @param {number} opts.graceMs - Grace period in ms (default: 5 min)
   * @param {Function} opts.onPersist - Callback to save new token: async (newToken) => {}
   */
  constructor({ token, tokenExpiry, graceMs, onPersist } = {}) {
    super()
    this._currentToken = token
    this._previousToken = null
    this._graceMs = graceMs || DEFAULT_GRACE_MS
    this._onPersist = onPersist || null
    this._rotationTimer = null
    this._graceTimer = null
    this._expiryMs = parseDuration(tokenExpiry)
    this._expiresAt = null
  }

  /** The current valid token */
  get currentToken() {
    return this._currentToken
  }

  /** When the current token expires (ms epoch), or null */
  get expiresAt() {
    return this._expiresAt
  }

  /** Whether rotation is enabled */
  get rotationEnabled() {
    return this._expiryMs != null && this._expiryMs > 0
  }

  /**
   * Validate a token. Returns true if the token matches the current
   * token or the previous token (during grace period).
   */
  validate(token) {
    if (!token) return false
    if (safeTokenCompare(token, this._currentToken)) return true
    if (this._previousToken && safeTokenCompare(token, this._previousToken)) return true
    return false
  }

  /**
   * Start the rotation schedule. Call after server startup.
   * No-op if tokenExpiry is not configured.
   */
  start() {
    if (!this.rotationEnabled) return
    this._expiresAt = Date.now() + this._expiryMs
    this._scheduleRotation()
    console.log(`[token-manager] Token rotation enabled (every ${formatDuration(this._expiryMs)}, grace: ${formatDuration(this._graceMs)})`)
  }

  /**
   * Perform immediate rotation (e.g. manual trigger).
   * Returns the new token.
   */
  rotate() {
    const oldToken = this._currentToken
    const newToken = randomUUID()

    this._previousToken = oldToken
    this._currentToken = newToken
    this._expiresAt = this._expiryMs ? Date.now() + this._expiryMs : null

    console.log(`[token-manager] Token rotated: ${oldToken.slice(0, 8)}... → ${newToken.slice(0, 8)}...`)

    // Emit event for WsServer to broadcast to clients
    this.emit('token_rotated', {
      oldToken,
      newToken,
      expiresAt: this._expiresAt,
    })

    // Persist the new token
    if (this._onPersist) {
      Promise.resolve(this._onPersist(newToken)).catch(err => {
        console.error(`[token-manager] Failed to persist new token: ${err.message}`)
      })
    }

    // Start grace period for old token
    if (this._graceTimer) clearTimeout(this._graceTimer)
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null
      this._previousToken = null
      console.log(`[token-manager] Grace period expired, old token invalidated`)
    }, this._graceMs)

    // Schedule next rotation
    if (this.rotationEnabled) {
      this._scheduleRotation()
    }

    return newToken
  }

  /** Schedule the next automatic rotation */
  _scheduleRotation() {
    if (this._rotationTimer) clearTimeout(this._rotationTimer)
    const delay = this._expiryMs - rotationLeadTime(this._expiryMs)
    this._rotationTimer = setTimeout(() => {
      this._rotationTimer = null
      this.rotate()
    }, Math.max(1000, delay))
  }

  /** Clean up timers */
  destroy() {
    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer)
      this._rotationTimer = null
    }
    if (this._graceTimer) {
      clearTimeout(this._graceTimer)
      this._graceTimer = null
    }
    this.removeAllListeners()
  }
}

function formatDuration(ms) {
  if (ms >= 86400000) return `${Math.round(ms / 86400000)}d`
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`
  return `${Math.round(ms / 1000)}s`
}
