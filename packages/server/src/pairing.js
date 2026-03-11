/**
 * Ephemeral pairing manager for QR-based device pairing.
 *
 * Generates short-lived pairing IDs that replace permanent API tokens in QR codes.
 * Flow: QR has pairing ID → app sends pair request → server validates → issues session token.
 *
 * Pairing IDs expire after TTL (default 60s) and are single-use.
 */
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'

const DEFAULT_TTL_MS = 60_000
const SESSION_TOKEN_BYTES = 32

export class PairingManager extends EventEmitter {
  constructor({ apiToken, wsUrl = null, ttlMs = DEFAULT_TTL_MS, autoRefresh = false }) {
    super()
    this._apiToken = apiToken
    this._wsUrl = wsUrl
    this._ttlMs = ttlMs
    this._autoRefresh = autoRefresh
    this._current = null
    this._sessionTokens = new Map() // sessionToken → { createdAt }
    this._usedPairings = new Set() // track used pairing IDs
    this._refreshTimer = null
    this._destroyed = false

    this._generatePairing()
    if (autoRefresh) this._scheduleRefresh()
  }

  get currentPairingId() {
    if (this._destroyed) return null
    return this._current?.id || null
  }

  get currentPairingUrl() {
    if (!this._current || !this._wsUrl) return null
    const host = this._wsUrl.replace(/^wss?:\/\//, '')
    return `chroxy://${host}?pair=${this._current.id}`
  }

  /**
   * Validate a pairing ID and issue a session token if valid.
   * @param {string} pairingId
   * @returns {{ valid: boolean, sessionToken?: string, reason?: string }}
   */
  validatePairing(pairingId) {
    if (!this._current) {
      return { valid: false, reason: 'invalid_pairing_id' }
    }

    // Check current pairing first
    if (this._current.id === pairingId) {
      if (this._current.used) {
        return { valid: false, reason: 'already_used' }
      }
      if (Date.now() > this._current.expiresAt) {
        return { valid: false, reason: 'expired' }
      }

      // Mark as used (one-time)
      this._current.used = true
      this._usedPairings.add(pairingId)

      // Issue a session token
      const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
      this._sessionTokens.set(sessionToken, { createdAt: Date.now() })

      return { valid: true, sessionToken }
    }

    // Check recently used pairings
    if (this._usedPairings.has(pairingId)) {
      return { valid: false, reason: 'already_used' }
    }

    return { valid: false, reason: 'invalid_pairing_id' }
  }

  /**
   * Check if a session token (issued during pairing) is valid.
   * Also accepts the permanent API token for backward compatibility.
   */
  isSessionTokenValid(token) {
    if (!token) return false
    if (this._sessionTokens.has(token)) return true
    return false
  }

  /**
   * Manually refresh the current pairing ID.
   */
  refresh() {
    this._generatePairing()
    this.emit('pairing_refreshed', { pairingId: this._current.id })
  }

  /**
   * Update the WebSocket URL (e.g., after tunnel reconnect).
   */
  setWsUrl(wsUrl) {
    this._wsUrl = wsUrl
  }

  destroy() {
    this._destroyed = true
    this._current = null
    this._sessionTokens.clear()
    this._usedPairings.clear()
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer)
      this._refreshTimer = null
    }
    this.removeAllListeners()
  }

  _generatePairing() {
    this._current = {
      id: randomBytes(12).toString('base64url'),
      createdAt: Date.now(),
      expiresAt: Date.now() + this._ttlMs,
      used: false,
    }
  }

  _scheduleRefresh() {
    if (this._destroyed) return
    // Refresh slightly before expiry to ensure there's always a valid ID
    const refreshIn = Math.max(this._ttlMs - 5000, this._ttlMs * 0.9)
    this._refreshTimer = setTimeout(() => {
      if (this._destroyed) return
      this._generatePairing()
      this.emit('pairing_refreshed', { pairingId: this._current.id })
      this._scheduleRefresh()
    }, refreshIn)
    this._refreshTimer.unref?.()
  }
}
