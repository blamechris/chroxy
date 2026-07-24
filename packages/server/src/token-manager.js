import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { safeTokenCompare } from './token-compare.js'
import { parseDuration } from './duration.js'
import { createLogger } from './logger.js'

const log = createLogger('token-manager')

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
 *   token_rotated { oldToken, newToken, expiresAt, reason }
 *
 * `reason` distinguishes a scheduled/periodic rotation ('scheduled') from an
 * operator revoke ('revoke', via `revoke()`). A revoke is the panic button:
 * the old token is invalidated immediately (no grace window) and downstream
 * (WsServer) severs privileged sessions and forces every connection to
 * re-authenticate (#6006). A scheduled rotation re-keys gracefully — the old
 * token stays valid through the grace period and live sessions survive.
 */

// Default grace period: 5 minutes
const DEFAULT_GRACE_MS = 5 * 60 * 1000

// Rotate 10% before expiry (min 60s, max 10min before)
function rotationLeadTime(expiryMs) {
  const lead = Math.max(60_000, Math.min(expiryMs * 0.1, 10 * 60 * 1000))
  return lead
}

// Re-export so existing `import { parseDuration } from './token-manager.js'` keeps working
export { parseDuration }

export class TokenManager extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.token - Current API token
   * @param {string|null} opts.tokenExpiry - Expiry duration (e.g. '24h', '7d') or null
   * @param {number} opts.graceMs - Grace period in ms (default: 5 min)
   * @param {Function} opts.onPersist - Callback to save new token:
   *   `async (newToken, { reason }) => {}`. `reason` is 'scheduled' | 'revoke'
   *   (#6927) so the persist site can make the panic-button revoke DURABLE while
   *   leaving the routine scheduled rotation non-durable.
   */
  constructor({ token, tokenExpiry, graceMs, onPersist } = {}) {
    super()
    this._currentToken = token
    this._previousToken = null
    this._graceMs = graceMs ?? DEFAULT_GRACE_MS
    this._onPersist = onPersist || null
    this._rotationTimer = null
    this._graceTimer = null
    this._expiryMs = parseDuration(tokenExpiry)
    // Minimum expiry floor: 5 minutes (prevents excessive rotation spam)
    const MIN_EXPIRY_MS = 5 * 60 * 1000
    if (this._expiryMs != null && this._expiryMs < MIN_EXPIRY_MS) {
      log.warn(`tokenExpiry ${tokenExpiry} (${this._expiryMs}ms) is below minimum ${MIN_EXPIRY_MS}ms — clamping to 5 minutes`)
      this._expiryMs = MIN_EXPIRY_MS
    }
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
   * #6004 — whether a token is the CURRENT token specifically (NOT the previous
   * token honored during the grace window). Used to gate user-shell creation so
   * a connection authed with a just-rotated (now grace-period) token can't
   * create a NEW shell during the grace window. Constant-time.
   */
  isCurrentToken(token) {
    if (!token) return false
    return safeTokenCompare(token, this._currentToken)
  }

  /**
   * Start the rotation schedule. Call after server startup.
   * No-op if tokenExpiry is not configured.
   */
  start() {
    if (!this.rotationEnabled) return
    this._expiresAt = Date.now() + this._expiryMs
    this._scheduleRotation()
    log.info(`Token rotation enabled (every ${formatDuration(this._expiryMs)}, grace: ${formatDuration(this._graceMs)})`)
  }

  /**
   * Immediately revoke the current token — the operator panic button (#6006).
   *
   * Unlike a scheduled rotation this (a) invalidates the old token at once,
   * with NO grace window, so a leaked token can't ride out the (default 5min)
   * grace, and (b) carries `reason: 'revoke'` so WsServer severs privileged
   * (user-shell) sessions and forces every connection to re-authenticate with
   * the new token rather than transparently re-keying. Returns the new token.
   */
  revoke() {
    return this.rotate('revoke')
  }

  /**
   * Perform an immediate rotation. `reason` defaults to 'scheduled' (the
   * graceful periodic path used by the rotation timer); pass 'revoke' (via
   * `revoke()`) for the panic-button behavior described above.
   * Returns the new token.
   */
  rotate(reason = 'scheduled') {
    const isRevoke = reason === 'revoke'
    const oldToken = this._currentToken
    const newToken = randomBytes(32).toString('base64url')

    this._currentToken = newToken
    this._expiresAt = this._expiryMs ? Date.now() + this._expiryMs : null

    if (isRevoke) {
      // Panic button: the old token is compromised. Kill it NOW — drop it as
      // the previous-token and tear down any in-flight grace timer so
      // validate() rejects it immediately.
      this._previousToken = null
      if (this._graceTimer) {
        clearTimeout(this._graceTimer)
        this._graceTimer = null
      }
      log.warn(`Token REVOKED (old token invalidated immediately, no grace)`)
    } else {
      this._previousToken = oldToken
      log.info(`Token rotated`)
    }

    // Emit event for WsServer to broadcast to clients
    this.emit('token_rotated', {
      oldToken,
      newToken,
      expiresAt: this._expiresAt,
      reason,
    })

    // Persist the new token. #6927 — forward `reason` so the persist site can
    // fsync a 'revoke' (the operator panic button killing a compromised token)
    // while leaving a routine 'scheduled' rotation non-durable.
    if (this._onPersist) {
      Promise.resolve(this._onPersist(newToken, { reason })).catch(err => {
        log.error(`Failed to persist new token: ${err.message}`)
      })
    }

    // Start grace period for the old token — scheduled rotations only. A revoke
    // killed the old token above and must not resurrect it via a grace window.
    if (!isRevoke) {
      if (this._graceTimer) clearTimeout(this._graceTimer)
      this._graceTimer = setTimeout(() => {
        this._graceTimer = null
        this._previousToken = null
        log.info(`Grace period expired, old token invalidated`)
      }, this._graceMs)
    }

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
