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

// -- Typeable short pairing code (#5512, epic #5509) --
//
// Pairing ids double as a human-typable code read off the host's own screen (the
// TV-app pattern: display-on-host = physical presence, so no extra approval — same
// trust as a scanned QR). The QR carries the SAME id, so this is one mechanism, not
// two. Codes delivered via any OTHER channel must use the #5510 approval primitive
// instead — possession of a code is only sufficient when it was read off the host.
//
// Alphabet: uppercase, ambiguity-free (no 0/O, 1/I/L). 8 chars over a 31-symbol
// alphabet ≈ 31^8 ≈ 8.5e11 combinations — paired with a 60s single-use TTL this is
// not brute-forceable. Entry is case-insensitive and tolerant of spaces/dashes;
// inputs are normalized (uppercased, separators stripped) before lookup.
export const TYPEABLE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TYPEABLE_CODE_LENGTH = 8

/**
 * Generate a crypto-random typeable pairing code. Rejection-samples bytes so the
 * alphabet is unbiased (no modulo skew toward the first 256 % N symbols).
 * @returns {string}
 */
function generateTypeableCode() {
  const n = TYPEABLE_ALPHABET.length
  const max = Math.floor(256 / n) * n // largest multiple of n ≤ 256 (rejection bound)
  let out = ''
  while (out.length < TYPEABLE_CODE_LENGTH) {
    const buf = randomBytes(TYPEABLE_CODE_LENGTH)
    for (let i = 0; i < buf.length && out.length < TYPEABLE_CODE_LENGTH; i++) {
      const b = buf[i]
      if (b >= max) continue // reject to keep the distribution uniform
      out += TYPEABLE_ALPHABET[b % n]
    }
  }
  return out
}

/**
 * Normalize a user-typed pairing code: uppercase, strip whitespace and dashes.
 * Makes entry case-insensitive and tolerant of the spaces/dashes people add when
 * reading a code aloud. Returns '' for non-string / nullish input.
 * @param {string} raw
 * @returns {string}
 */
export function normalizePairingCode(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\s-]+/g, '').toUpperCase()
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_GRACE_PERIOD_MS = 3 * 60_000 // 3 minutes after first QR display
const DEFAULT_SESSION_TOKEN_TTL_MS = 24 * 60 * 60_000 // 24 hours
const SESSION_TOKEN_BYTES = 32
const MAX_SESSION_TOKENS = 100
const MAX_ACTIVE_PAIRINGS = 10

// -- Pairing-approval primitive (#5510, epic #5509) --
//
// A camera-less device requests pairing without a QR; the user approves it from
// a host-level surface. The pending queue is an UNAUTHENTICATED-fed DoS surface,
// so it is hard-bounded on three axes: a global cap, a per-request TTL, and a
// per-source rate limit. Expired entries are swept on an unref'd timer.
const DEFAULT_PENDING_TTL_MS = 120_000 // 120s — a pending request expires
const MAX_PENDING_REQUESTS = 5 // global cap on outstanding pending requests
const PENDING_SWEEP_INTERVAL_MS = 5_000 // sweep cadence for expired entries
// Per-source rate limit: at most N new requests in a rolling window.
const PENDING_RATE_MAX = 5
const PENDING_RATE_WINDOW_MS = 60_000
const MAX_RATE_SOURCES = 1_000 // cap the rate-limit map cardinality

export class PairingManager extends EventEmitter {
  constructor({ wsUrl = null, ttlMs = DEFAULT_TTL_MS, sessionTokenTtlMs = DEFAULT_SESSION_TOKEN_TTL_MS, autoRefresh = false, pendingTtlMs = DEFAULT_PENDING_TTL_MS } = {}) {
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

    // -- Pairing-approval primitive (#5510) --
    this._pendingTtlMs = pendingTtlMs
    this._pendingRequests = new Map() // requestId → { deviceName, verifyCode, expiresAt, resolved }
    this._pendingRateBuckets = new Map() // source → { count, windowStart }
    this._sweepTimer = null

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
   * Snapshot of the current linking-mode pairing code for host display surfaces
   * (#5512): the typeable code, its chroxy:// URL (QR carries the same id), and the
   * absolute expiry so a CLI/dashboard can render "expires in NNs". Null when
   * destroyed or no pairing exists.
   * @returns {{ code: string, url: string|null, expiresAtMs: number, ttlMs: number }|null}
   */
  get currentPairingCode() {
    if (this._destroyed || !this._current) return null
    return {
      code: this._current.id,
      url: this.currentPairingUrl,
      expiresAtMs: this._current.expiresAt,
      ttlMs: this._ttlMs,
    }
  }

  /**
   * Generate a NEW pairing ID bound at creation time to a specific session
   * (#3070). Unlike `_generatePairing()`, this does NOT replace `_current`
   * (the linking-mode QR keeps auto-refreshing for general device pairing);
   * it adds an additional one-shot entry with `boundSessionId` stored on it.
   *
   * The returned URL goes into a "Share this session" QR. When the scanner
   * pairs, the issued sessionToken is bound to the specified sessionId, so
   * the paired client can chat into that session but cannot list/switch/
   * destroy others.
   *
   * @param {string} sessionId - Session to bind the issued token to
   * @returns {{ pairingId: string, pairingUrl: string|null }}
   * @throws {Error} If sessionId is empty / non-string
   */
  generateBoundPairing(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('generateBoundPairing requires a non-empty sessionId')
    }
    if (this._destroyed) {
      throw new Error('PairingManager is destroyed')
    }

    // Cap active pairings to prevent unbounded growth. Skip _current.id
    // when picking the eviction victim — the linking-mode QR's id is in
    // _activePairings too, and dropping it would silently invalidate the
    // main /qr (validatePairing on the linking id would return
    // invalid_pairing_id even though currentPairingId still reports it).
    // Falls back to evicting _current as a last resort if it's the only
    // entry, which can only happen with a misconfigured cap.
    if (this._activePairings.size >= MAX_ACTIVE_PAIRINGS) {
      const linkingId = this._current?.id || null
      let victim = null
      for (const id of this._activePairings.keys()) {
        if (id !== linkingId) {
          victim = id
          break
        }
      }
      this._activePairings.delete(victim ?? this._activePairings.keys().next().value)
    }

    const id = generateTypeableCode()
    const expiresAt = Date.now() + this._ttlMs
    this._activePairings.set(id, { expiresAt, used: false, boundSessionId: sessionId })

    const pairingUrl = this._wsUrl
      ? `chroxy://${this._wsUrl.replace(/^wss?:\/\//, '')}?pair=${id}`
      : null
    return { pairingId: id, pairingUrl }
  }

  /**
   * Validate a pairing ID and issue a session token if valid.
   * Accepts any active pairing ID (current or recently-refreshed within TTL).
   *
   * If the pairing entry was created via `generateBoundPairing(sessionId)`,
   * the binding is taken from the entry — `sessionId` param is ignored.
   * Otherwise (linking-mode pairings), the param controls the binding.
   *
   * @param {string} pairingId
   * @param {string|null} [sessionId] - Session ID to bind to the issued token
   *   (only honored when the entry has no boundSessionId of its own).
   * @returns {{ valid: boolean, sessionToken?: string, reason?: string }}
   */
  validatePairing(pairingId, sessionId = null) {
    // Normalize typed/scanned input so a code read off the host screen validates
    // regardless of case or the spaces/dashes a user adds (#5512). Stored keys are
    // already canonical (uppercase, separator-free) so this is a no-op for QR ids.
    pairingId = normalizePairingCode(pairingId)

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

    // Issue a session token (with FIFO eviction at cap). Entry-bound pairings
    // (#3070) take precedence — the param is only honored for linking-mode
    // pairings that didn't fix a binding at creation time.
    const effectiveSessionId = entry.boundSessionId || sessionId || null
    const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    if (this._sessionTokens.size >= MAX_SESSION_TOKENS) {
      const oldest = this._sessionTokens.keys().next().value
      this._sessionTokens.delete(oldest)
    }
    this._sessionTokens.set(sessionToken, { createdAt: Date.now(), sessionId: effectiveSessionId })

    // Auto-regenerate so the dashboard always shows a fresh QR (#2916), but
    // only when the just-consumed ID was the linking-mode `_current`. Bound
    // share-pairings shouldn't trigger a linking-mode rotation.
    if (this._current && this._current.id === pairingId) {
      // Emit after issuing the token so the sessionToken return value is
      // ready before any pairing_refreshed listener queries currentPairingId.
      this._generatePairing()
      this.emit('pairing_refreshed', { pairingId: this._current.id })

      // Reset the auto-refresh timer so it counts from the newly-generated ID,
      // not from when the consumed ID was created. Without this, the pending
      // timer fires on the old schedule and emits a spurious second
      // pairing_refreshed seconds later (#3020).
      if (this._autoRefresh && this._refreshTimer) {
        clearTimeout(this._refreshTimer)
        this._refreshTimer = null
        this._scheduleRefresh()
      }
    }

    return { valid: true, sessionToken }
  }

  /**
   * Check if a session token (issued during pairing) is valid.
   * Uses constant-time comparison to prevent timing attacks.
   */
  isSessionTokenValid(token) {
    return this._lookupToken(token) !== null
  }

  /**
   * Return the session ID bound to a session token, or null if the token is
   * invalid / expired / not bound to any session.
   * Uses constant-time comparison to prevent timing attacks.
   * @param {string} token
   * @returns {string|null}
   */
  getSessionIdForToken(token) {
    const meta = this._lookupToken(token)
    return meta ? (meta.sessionId || null) : null
  }

  /**
   * Look up a session token using constant-time comparison.
   * Prunes expired tokens on access.
   * @param {string} token
   * @returns {object|null} Token metadata if found, null otherwise
   */
  _lookupToken(token) {
    if (!token) return null
    const now = Date.now()
    const tokenBuf = Buffer.from(token)
    for (const [stored, meta] of this._sessionTokens.entries()) {
      if (now - meta.createdAt > this._sessionTokenTtlMs) {
        this._sessionTokens.delete(stored)
        continue
      }
      const storedBuf = Buffer.from(stored)
      if (tokenBuf.length === storedBuf.length && timingSafeEqual(tokenBuf, storedBuf)) {
        return meta
      }
    }
    return null
  }

  /**
   * Extend the current pairing ID's validity and pause auto-refresh for a grace period.
   * Call after displaying the QR code to give the user time to scan before rotation.
   * @param {number} [durationMs] - Grace period in ms (default 3 minutes)
   */
  extendCurrentId(durationMs = DEFAULT_GRACE_PERIOD_MS) {
    if (this._destroyed || !this._current) return

    // Extend the expiry — never shorten below the existing remaining TTL
    const requestedExpiry = Date.now() + durationMs
    const newExpiry = Math.max(this._current.expiresAt, requestedExpiry)
    this._current.expiresAt = newExpiry
    const entry = this._activePairings.get(this._current.id)
    if (entry) entry.expiresAt = newExpiry

    // Reschedule auto-refresh to fire after the (possibly extended) grace period
    if (this._autoRefresh) {
      if (this._refreshTimer) clearTimeout(this._refreshTimer)
      const delayMs = Math.max(0, newExpiry - Date.now())
      this._refreshTimer = setTimeout(() => {
        if (this._destroyed) return
        this._generatePairing()
        this.emit('pairing_refreshed', { pairingId: this._current.id })
        this._scheduleRefresh()
      }, delayMs)
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

  // ===================================================================
  //  Pairing-approval primitive (#5510, epic #5509)
  //
  //  A new device sends `pair_request`; the daemon queues it with a 6-digit
  //  verify code and a TTL, fans the request out to host-level surfaces, and
  //  issues a session token only when an approver confirms it. The queue is an
  //  unauthenticated-fed DoS surface — bounded by cap + TTL + per-source rate.
  // ===================================================================

  /**
   * Queue a new pending pair request.
   *
   * The verify code is generated SERVER-SIDE and returned to the caller only so
   * the WsServer can relay it to the requester (display) and to host surfaces
   * (compare). The requester never sends it back, so a mismatch is impossible by
   * construction.
   *
   * @param {object} args
   * @param {string} args.requestId - client-generated correlation id
   * @param {string} [args.deviceName] - attacker-controlled label (already
   *   length-capped at the schema; re-clamped here defensively)
   * @param {string} args.source - rate-limit key (CF-Connecting-IP / socket ip)
   * @returns {{ ok: true, verifyCode: string, expiresAt: number }
   *           | { ok: false, reason: 'rate_limited'|'queue_full'|'duplicate_request'|'invalid' }}
   */
  enqueuePendingRequest({ requestId, deviceName = '', source = '' } = {}) {
    if (this._destroyed) return { ok: false, reason: 'invalid' }
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { ok: false, reason: 'invalid' }
    }

    this._sweepPending()

    // Per-source rate limit (rolling window). Checked BEFORE the cap so a
    // single noisy source cannot starve the cap-rejection path for others.
    if (this._isRateLimited(source)) {
      return { ok: false, reason: 'rate_limited' }
    }

    // Duplicate requestId — the caller should mint a fresh id. Reject rather
    // than overwrite so an in-flight approval can never be hijacked by a
    // collision.
    if (this._pendingRequests.has(requestId)) {
      return { ok: false, reason: 'duplicate_request' }
    }

    // Global cap. Reject newest-on-full (fail closed) rather than evicting an
    // existing entry — evicting would silently drop a request the user may be
    // mid-approval on.
    if (this._pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return { ok: false, reason: 'queue_full' }
    }

    // Count this request against the source's bucket only after it is accepted.
    this._recordRateAttempt(source)

    const verifyCode = this._generateVerifyCode()
    const expiresAt = Date.now() + this._pendingTtlMs
    const cleanName = typeof deviceName === 'string' ? deviceName.slice(0, 64) : ''
    this._pendingRequests.set(requestId, {
      deviceName: cleanName,
      verifyCode,
      expiresAt,
      resolved: false,
    })

    this._ensureSweepTimer()
    return { ok: true, verifyCode, expiresAt }
  }

  /**
   * Snapshot of a pending request for fan-out to host surfaces. Never includes
   * the issued token (none exists yet). Returns null if absent/expired/resolved.
   */
  getPendingRequest(requestId) {
    const entry = this._pendingRequests.get(requestId)
    if (!entry || entry.resolved) return null
    if (Date.now() > entry.expiresAt) return null
    return {
      requestId,
      deviceName: entry.deviceName,
      verifyCode: entry.verifyCode,
      expiresAt: entry.expiresAt,
    }
  }

  /** All live (unresolved, unexpired) pending requests — for surface replay. */
  listPendingRequests() {
    this._sweepPending()
    const out = []
    for (const [requestId, entry] of this._pendingRequests) {
      if (entry.resolved) continue
      out.push({
        requestId,
        deviceName: entry.deviceName,
        verifyCode: entry.verifyCode,
        expiresAt: entry.expiresAt,
      })
    }
    return out
  }

  /**
   * Approve a pending request and issue a session token EXACTLY once. A second
   * approve of the same requestId is a no-op error (`already_resolved`).
   *
   * The issued token is an unbound (host-authority) session token — same class
   * and TTL as a linking-mode QR pairing. The verify code is never consulted
   * here: the approver confirmed the requestId out-of-band by eyeballing the
   * code on both screens.
   *
   * @param {string} requestId
   * @returns {{ ok: true, token: string }
   *           | { ok: false, reason: 'not_found'|'expired'|'already_resolved' }}
   */
  approvePendingRequest(requestId) {
    if (this._destroyed) return { ok: false, reason: 'not_found' }
    const entry = this._pendingRequests.get(requestId)
    if (!entry) return { ok: false, reason: 'not_found' }
    if (entry.resolved) return { ok: false, reason: 'already_resolved' }
    if (Date.now() > entry.expiresAt) {
      entry.resolved = true
      return { ok: false, reason: 'expired' }
    }

    // Mark resolved BEFORE issuing the token so a concurrent re-entrant approve
    // (same tick) cannot mint a second token for the same request. The resolved
    // entry stays in the map as a tombstone (reaped on the next sweep) so a
    // second approve returns `already_resolved`, not `not_found`.
    entry.resolved = true

    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    if (this._sessionTokens.size >= MAX_SESSION_TOKENS) {
      const oldest = this._sessionTokens.keys().next().value
      this._sessionTokens.delete(oldest)
    }
    // Unbound (host-authority) token — sessionId: null, like linking-mode QR.
    this._sessionTokens.set(token, { createdAt: Date.now(), sessionId: null })
    return { ok: true, token }
  }

  /**
   * Deny / cancel a pending request. Returns true if a live entry was denied.
   * Idempotent: denying an already-resolved/absent request returns false. The
   * resolved tombstone is reaped on the next sweep.
   */
  denyPendingRequest(requestId) {
    const entry = this._pendingRequests.get(requestId)
    if (!entry || entry.resolved) return false
    entry.resolved = true
    return true
  }

  /** Generate a zero-padded 6-digit verification code (0-999999). */
  _generateVerifyCode() {
    // rejection-sampling-free: 4 bytes → uint32 → mod 1_000_000. The tiny modulo
    // bias (2^32 % 1e6) is irrelevant for a 120s human-comparison code.
    const n = randomBytes(4).readUInt32BE(0) % 1_000_000
    return String(n).padStart(6, '0')
  }

  _isRateLimited(source) {
    if (!source) return false
    const bucket = this._pendingRateBuckets.get(source)
    if (!bucket) return false
    const now = Date.now()
    if (now - bucket.windowStart > PENDING_RATE_WINDOW_MS) return false
    return bucket.count >= PENDING_RATE_MAX
  }

  _recordRateAttempt(source) {
    if (!source) return
    const now = Date.now()
    let bucket = this._pendingRateBuckets.get(source)
    if (!bucket || now - bucket.windowStart > PENDING_RATE_WINDOW_MS) {
      // Cap cardinality before inserting a fresh source.
      if (!this._pendingRateBuckets.has(source) && this._pendingRateBuckets.size >= MAX_RATE_SOURCES) {
        const oldest = this._pendingRateBuckets.keys().next().value
        this._pendingRateBuckets.delete(oldest)
      }
      bucket = { count: 0, windowStart: now }
      this._pendingRateBuckets.set(source, bucket)
    }
    bucket.count++
  }

  /**
   * Remove expired pending requests, emitting `pending_request_expired` for
   * each so the WsServer can notify the requester and retract host banners.
   */
  _sweepPending() {
    if (this._destroyed) return
    const now = Date.now()
    for (const [requestId, entry] of this._pendingRequests) {
      if (entry.resolved || now > entry.expiresAt) {
        this._pendingRequests.delete(requestId)
        if (!entry.resolved) {
          this.emit('pending_request_expired', { requestId })
        }
      }
    }
    // Prune stale rate buckets opportunistically.
    for (const [source, bucket] of this._pendingRateBuckets) {
      if (now - bucket.windowStart > PENDING_RATE_WINDOW_MS) {
        this._pendingRateBuckets.delete(source)
      }
    }
    if (this._pendingRequests.size === 0 && this._sweepTimer) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = null
    }
  }

  _ensureSweepTimer() {
    if (this._destroyed || this._sweepTimer) return
    this._sweepTimer = setInterval(() => this._sweepPending(), PENDING_SWEEP_INTERVAL_MS)
    this._sweepTimer.unref?.()
  }

  destroy() {
    this._destroyed = true
    this._current = null
    this._activePairings.clear()
    this._sessionTokens.clear()
    this._pendingRequests.clear()
    this._pendingRateBuckets.clear()
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer)
      this._refreshTimer = null
    }
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = null
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

    const id = generateTypeableCode()
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
