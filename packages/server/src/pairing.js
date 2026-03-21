/**
 * Ephemeral pairing manager for QR-based device pairing.
 *
 * Generates short-lived pairing IDs that replace permanent API tokens in QR codes.
 * Flow: QR has pairing ID → app sends pair request → server validates → issues session token.
 *
 * Pairing IDs expire after TTL (default 60s) and are single-use.
 * Recently-refreshed IDs remain valid until their TTL expires (grace period).
 */
import { EventEmitter } from 'events'
import { randomBytes, timingSafeEqual } from 'crypto'

const DEFAULT_TTL_MS = 60_000
const DEFAULT_GRACE_PERIOD_MS = 3 * 60_000 // 3 minutes after first QR display
const DEFAULT_SESSION_TOKEN_TTL_MS = 24 * 60 * 60_000 // 24 hours
const SESSION_TOKEN_BYTES = 32
const MAX_SESSION_TOKENS = 100
const MAX_ACTIVE_PAIRINGS = 10

export class PairingManager extends EventEmitter {
  constructor({ wsUrl = null, ttlMs = DEFAULT_TTL_MS, sessionTokenTtlMs = DEFAULT_SESSION_TOKEN_TTL_MS, autoRefresh = false } = {}) {
    super()
    this._wsUrl = wsUrl
    this._ttlMs = ttlMs
    this._sessionTokenTtlMs = sessionTokenTtlMs
    this._autoRefresh = autoRefresh
    this._current = null
    this._activePairings = new Map() // id → { expiresAt, used }
    this._sessionTokens = new Map() // sessionToken → { createdAt }
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
   * Accepts any active pairing ID (current or recently-refreshed within TTL).
   * @param {string} pairingId
   * @returns {{ valid: boolean, sessionToken?: string, reason?: string }}
   */
  validatePairing(pairingId) {
    // Look up in active pairings (includes current + grace period entries)
    const entry = this._activePairings.get(pairingId)
    if (!entry) {
      return { valid: false, reason: 'invalid_pairing_id' }
    }

    if (entry.used) {
      return { valid: false, reason: 'already_used' }
    }
    if (Date.now() > entry.expiresAt) {
      this._activePairings.delete(pairingId)
      return { valid: false, reason: 'expired' }
    }

    // Mark as used (one-time)
    entry.used = true

    // Issue a session token (with FIFO eviction at cap)
    const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    if (this._sessionTokens.size >= MAX_SESSION_TOKENS) {
      const oldest = this._sessionTokens.keys().next().value
      this._sessionTokens.delete(oldest)
    }
    this._sessionTokens.set(sessionToken, { createdAt: Date.now() })

    return { valid: true, sessionToken }
  }

  /**
   * Check if a session token (issued during pairing) is valid.
   * Uses constant-time comparison to prevent timing attacks.
   */
  isSessionTokenValid(token) {
    if (!token) return false
    const now = Date.now()
    const tokenBuf = Buffer.from(token)
    for (const [stored, meta] of this._sessionTokens.entries()) {
      // Prune expired tokens on access
      if (now - meta.createdAt > this._sessionTokenTtlMs) {
        this._sessionTokens.delete(stored)
        continue
      }
      const storedBuf = Buffer.from(stored)
      if (tokenBuf.length === storedBuf.length && timingSafeEqual(tokenBuf, storedBuf)) {
        return true
      }
    }
    return false
  }

  /**
   * Extend the current pairing ID's validity and pause auto-refresh for a grace period.
   * Call after displaying the QR code to give the user time to scan before rotation.
   * @param {number} [durationMs] - Grace period in ms (default 3 minutes)
   */
  extendCurrentId(durationMs = DEFAULT_GRACE_PERIOD_MS) {
    if (this._destroyed || !this._current) return

    // Extend the expiry of the current pairing entry
    const newExpiry = Date.now() + durationMs
    this._current.expiresAt = newExpiry
    const entry = this._activePairings.get(this._current.id)
    if (entry) entry.expiresAt = newExpiry

    // Reschedule auto-refresh to fire after the grace period
    if (this._autoRefresh) {
      if (this._refreshTimer) clearTimeout(this._refreshTimer)
      this._refreshTimer = setTimeout(() => {
        if (this._destroyed) return
        this._generatePairing()
        this.emit('pairing_refreshed', { pairingId: this._current.id })
        this._scheduleRefresh()
      }, durationMs)
      this._refreshTimer.unref?.()
    }
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
    this._activePairings.clear()
    this._sessionTokens.clear()
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer)
      this._refreshTimer = null
    }
    this.removeAllListeners()
  }

  _generatePairing() {
    // Prune expired entries
    const now = Date.now()
    for (const [id, entry] of this._activePairings) {
      if (now > entry.expiresAt) {
        this._activePairings.delete(id)
      }
    }

    // Cap active pairings to prevent unbounded growth
    if (this._activePairings.size >= MAX_ACTIVE_PAIRINGS) {
      const oldest = this._activePairings.keys().next().value
      this._activePairings.delete(oldest)
    }

    const id = randomBytes(12).toString('base64url')
    const expiresAt = now + this._ttlMs
    this._current = { id, createdAt: now, expiresAt }
    this._activePairings.set(id, { expiresAt, used: false })
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
