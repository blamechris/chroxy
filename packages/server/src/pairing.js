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
import { randomBytes, timingSafeEqual, createHash } from 'crypto'
import { createLogger } from './logger.js'

const log = createLogger('pairing')

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
// #5555: cadence for the background session-token TTL sweep. Mirrors the
// _pendingRequests sweep so expired tokens are reaped even when no lookup or
// new issuance touches them — without this they linger to the cap and trigger
// eviction of a still-valid (longest-paired) token, silently logging out a
// device. Hourly is ample against a multi-day TTL (default 30d, #6598); unref'd
// so it never holds the process open.
const SESSION_TOKEN_SWEEP_INTERVAL_MS = 60 * 60_000 // 1 hour
// #6598: a sliding-expiry refresh moves a token's clock on every reconnect, but
// with a multi-day TTL there's no need to hit disk each time — persist a slide at
// most this often. Structural changes (mint / sweep) persist immediately.
const SLIDE_PERSIST_THROTTLE_MS = 60 * 60_000 // 1 hour
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

/**
 * Append the daemon's pinned E2E identity public key to a pairing URL as the
 * `idk` (IDentity Key) query param (#5536). The pairing channel is the trust
 * root — it already conveys the URL + pairing id out-of-band — so it is the
 * sound place to convey the identity key the client pins. Old clients ignore
 * the extra param. No-op when there is no identity key (encryption disabled /
 * older daemon) or no base URL.
 * @param {string|null} url - base chroxy:// pairing URL
 * @param {string|null} identityPublicKey - base64 Ed25519 identity public key
 * @returns {string|null}
 */
function appendIdentityKey(url, identityPublicKey) {
  if (!url || !identityPublicKey) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}idk=${encodeURIComponent(identityPublicKey)}`
}

export class PairingManager extends EventEmitter {
  constructor({ wsUrl = null, ttlMs = DEFAULT_TTL_MS, sessionTokenTtlMs = DEFAULT_SESSION_TOKEN_TTL_MS, autoRefresh = false, pendingTtlMs = DEFAULT_PENDING_TTL_MS, identityPublicKey = null, sessionTokenStore = null } = {}) {
    super()
    this._wsUrl = wsUrl
    // #5536 — the daemon's long-lived E2E identity public key (base64 Ed25519),
    // pinned by clients at pairing time. Rides every pairing URL as `?idk=`.
    this._identityPublicKey = identityPublicKey
    this._ttlMs = ttlMs
    this._sessionTokenTtlMs = sessionTokenTtlMs
    this._autoRefresh = autoRefresh
    this._current = null
    this._activePairings = new Map() // id → { expiresAt, used }
    this._sessionTokens = new Map() // sessionToken → { createdAt, sessionId }
    this._refreshTimer = null
    // #5555: background TTL sweep for _sessionTokens (started lazily on first
    // token issuance, cleared on destroy — no leaked timer).
    this._sessionTokenSweepTimer = null
    this._destroyed = false
    // #6598: optional { load, save } adapter so paired tokens survive a daemon
    // restart. When absent, behaviour is exactly as before (in-memory only).
    this._sessionTokenStore = sessionTokenStore
    // Throttle slide-refresh persistence: a sliding-expiry refresh moves createdAt
    // on every reconnect, but with a multi-day TTL we don't need to hit disk each
    // time. Structural changes (mint / sweep / revoke) always persist immediately;
    // a slide persists at most once per SLIDE_PERSIST_THROTTLE_MS.
    this._lastSlidePersistMs = 0
    // Restore persisted tokens (expired ones are dropped lazily on first lookup,
    // and by the background sweep once it's armed below).
    if (this._sessionTokenStore) {
      try {
        for (const [token, meta] of this._sessionTokenStore.load()) {
          if (typeof token === 'string' && meta && typeof meta.createdAt === 'number') {
            // Coerce sessionId to string|null — a hand-edited / corrupt store must
            // not inject a non-string binding that downstream handlers assume.
            const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : null
            this._sessionTokens.set(token, { createdAt: meta.createdAt, sessionId })
          }
        }
        // Arm the background TTL sweep so restored-but-expired tokens are reaped
        // even if nothing looks them up after a restart.
        if (this._sessionTokens.size > 0) this._ensureSessionTokenSweepTimer()
      } catch (err) {
        // Never let a restore failure break construction — start empty so devices
        // re-pair. Logged (not silent) so a genuine programming error surfaces.
        log.warn(`could not restore persisted session tokens (${err.message}) — devices will re-pair`)
      }
    }

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
    return appendIdentityKey(`chroxy://${host}?pair=${this._current.id}`, this._identityPublicKey)
  }

  /** The daemon's pinned E2E identity public key (base64 Ed25519), or null. */
  get identityPublicKey() {
    return this._identityPublicKey
  }

  /** Update the identity public key (e.g. after the keypair is minted late). */
  setIdentityPublicKey(key) {
    this._identityPublicKey = key || null
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
      identityPublicKey: this._identityPublicKey,
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
      ? appendIdentityKey(`chroxy://${this._wsUrl.replace(/^wss?:\/\//, '')}?pair=${id}`, this._identityPublicKey)
      : null
    return { pairingId: id, pairingUrl }
  }

  /**
   * Generate a NEW pairing id flagged `requiresApproval: true` (#5513, epic
   * #5509) — the Discord-delivery path. Unlike `generateBoundPairing`, a gated
   * id NEVER mints a token on redemption: `validatePairing` returns
   * `requires_approval` so the WsServer routes the redemption into the #5510
   * pending-request approval flow (verify-code + host approve). Possession of
   * the Discord channel therefore grants nothing on its own — a leaked link
   * still needs an out-of-band host approval to connect.
   *
   * Like `generateBoundPairing`, this does NOT replace `_current` (the
   * linking-mode QR keeps auto-refreshing); it adds an additional one-shot,
   * single-use, TTL'd entry. Each trigger surface (CLI / dashboard button)
   * calls this fresh so every Discord post carries its own ephemeral id.
   *
   * @returns {{ pairingId: string, pairingUrl: string|null, expiresAt: number }}
   * @throws {Error} If the manager is destroyed.
   */
  createApprovalGatedPairingId() {
    if (this._destroyed) {
      throw new Error('PairingManager is destroyed')
    }

    // Cap active pairings to prevent unbounded growth. Skip _current.id when
    // picking the eviction victim — dropping the linking-mode QR's entry would
    // silently invalidate the main /qr (same rationale as generateBoundPairing).
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
    this._activePairings.set(id, { expiresAt, used: false, requiresApproval: true })

    const pairingUrl = this._wsUrl
      ? appendIdentityKey(`chroxy://${this._wsUrl.replace(/^wss?:\/\//, '')}?pair=${id}`, this._identityPublicKey)
      : null
    return { pairingId: id, pairingUrl, expiresAt }
  }

  /**
   * Validate a pairing ID and issue a session token if valid.
   * Accepts any active pairing ID (current or recently-refreshed within TTL).
   *
   * If the pairing entry was created via `generateBoundPairing(sessionId)`,
   * the binding is taken from the entry — `sessionId` param is ignored.
   * Otherwise (linking-mode pairings), the param controls the binding.
   *
   * Approval-gated entries (#5513, `createApprovalGatedPairingId`) are consumed
   * (marked used) but NEVER mint a token: the call returns
   * `{ valid: false, reason: 'requires_approval' }` so the caller routes the
   * redemption into the host-approval flow instead.
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

    // Approval-gated id (#5513): consume it but mint NO token. The caller
    // (WsServer / handlePairMessage) maps `requires_approval` into the #5510
    // pending-request flow — host approval is still required, so possession of
    // the Discord-delivered link grants nothing on its own.
    if (entry.requiresApproval) {
      return { valid: false, reason: 'requires_approval' }
    }

    // Issue a session token (with FIFO eviction at cap). Entry-bound pairings
    // (#3070) take precedence — the param is only honored for linking-mode
    // pairings that didn't fix a binding at creation time.
    const effectiveSessionId = entry.boundSessionId || sessionId || null
    const sessionToken = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    this._storeSessionToken(sessionToken, { createdAt: Date.now(), sessionId: effectiveSessionId })

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
    const meta = this._lookupToken(token)
    if (meta === null) return false
    // #6598 sliding expiry: a successful auth (this is called on the auth path,
    // NOT on every per-message getSessionIdForToken lookup) refreshes the token's
    // clock, so only a device that hasn't connected within the TTL window expires.
    // `meta` is the live map value, so mutating it slides the stored entry.
    meta.createdAt = Date.now()
    this._maybePersistSlide()
    return true
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
   * A stable, non-reversible identifier for a session token, safe to put on the
   * wire — the operator UI needs a handle to name a device for revoke, but the
   * token itself must never leave the daemon (#6678). Deterministic (so a
   * list → revoke round-trip resolves the same token) and one-way (a SHA-256
   * digest discloses nothing about the token). 16 hex chars ≈ 64 bits — no
   * collision risk across the ≤100-token cap.
   * @param {string} token
   * @returns {string}
   */
  _deviceIdForToken(token) {
    return createHash('sha256').update(token).digest('hex').slice(0, 16)
  }

  /**
   * Live snapshot of the paired-device session tokens for an operator surface
   * (#6678 — the dashboard Paired Devices panel). Sweeps expired tokens first so
   * the roster is current, then maps each surviving token to a wire-safe view:
   * a stable non-reversible id (NEVER the token itself), its bound sessionId
   * (null = unbound / full-access, like a linking-mode QR pairing), when it was
   * minted or last refreshed (createdAt slides on each connect), the derived age,
   * and an optional device label (not captured yet — the deviceName follow-up).
   * @returns {Array<{ id: string, sessionId: string|null, createdAt: number|null, ageMs: number|null, deviceName: string|null }>}
   */
  listSessionTokens() {
    this._sweepSessionTokens()
    const now = Date.now()
    const out = []
    for (const [token, meta] of this._sessionTokens) {
      const createdAt = typeof meta.createdAt === 'number' ? meta.createdAt : null
      out.push({
        id: this._deviceIdForToken(token),
        sessionId: (typeof meta.sessionId === 'string' && meta.sessionId) || null,
        createdAt,
        ageMs: createdAt !== null ? now - createdAt : null,
        deviceName: typeof meta.deviceName === 'string' ? meta.deviceName : null,
      })
    }
    return out
  }

  /**
   * Live-revoke a single paired device by its wire id (from listSessionTokens).
   * Drops the token from the RUNNING daemon's in-memory map and persists, so the
   * device's next auth fails immediately — no restart required. This closes the
   * gap the `chroxy tokens revoke` CLI left (it edits the persisted store only,
   * which a running daemon overwrites from memory until restarted). Comparing
   * derived ids (not the token) needs no constant-time guard — the id is not
   * secret.
   *
   * #6902: durably persist the POST-removal snapshot BEFORE dropping the token
   * from memory, so a crash between the two can never resurrect the revoked token
   * on the next start (fail-CLOSED, mirroring how mint is fail-safe). If the
   * durable write fails, the token stays valid AND persisted (memory + disk
   * agree) and we report `persistFailed` rather than a false success — the
   * operator can retry instead of believing a revoke that a crash would undo.
   *
   * @param {string} id
   * @returns {{ revoked: number, persistFailed?: boolean }} `revoked` is 1 on
   *   success, 0 if no device matched OR the durable write failed; `persistFailed`
   *   is set only in the write-failed case (the device exists but stays valid).
   */
  revokeSessionTokenById(id) {
    if (this._destroyed || typeof id !== 'string' || id.length === 0) return { revoked: 0 }
    for (const token of this._sessionTokens.keys()) {
      if (this._deviceIdForToken(token) === id) {
        // Persist the map WITHOUT this token first; only drop it from memory once
        // that durable write has landed (see _persistSessionTokensSnapshot).
        const remaining = [...this._sessionTokens.entries()].filter(([t]) => t !== token)
        if (!this._persistSessionTokensSnapshot(remaining)) return { revoked: 0, persistFailed: true }
        this._sessionTokens.delete(token)
        return { revoked: 1 }
      }
    }
    return { revoked: 0 }
  }

  /**
   * Live-revoke EVERY paired device — the operator panic button (#6678). Clears
   * the in-memory map and persists, so all paired devices must re-pair; effective
   * on the running daemon (their next auth fails), no restart.
   *
   * #6902: durably persist the EMPTIED snapshot BEFORE clearing memory, so a
   * crash mid-revoke can't resurrect the whole roster on restart (fail-CLOSED).
   * If the durable write fails, every token stays valid (memory + disk agree) and
   * we report `persistFailed` rather than a false success.
   *
   * @returns {{ revoked: number, persistFailed?: boolean }} `revoked` is the count
   *   removed (0 when nothing was paired OR the durable write failed);
   *   `persistFailed` is set only in the write-failed case (all tokens stay valid).
   */
  revokeAllSessionTokens() {
    if (this._destroyed) return { revoked: 0 }
    const n = this._sessionTokens.size
    if (n === 0) return { revoked: 0 }
    // Persist the emptied store first; only clear memory once it has landed.
    if (!this._persistSessionTokensSnapshot([])) return { revoked: 0, persistFailed: true }
    this._sessionTokens.clear()
    return { revoked: n }
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
   * #5555: drop every expired session token. Used both before cap-eviction
   * (so we never evict a still-valid token while expired ones occupy slots)
   * and by the background sweep timer. Constant-key iteration, no allocation.
   * @returns {number} count of tokens removed
   */
  _sweepSessionTokens() {
    if (this._destroyed) return 0
    const now = Date.now()
    let removed = 0
    for (const [stored, meta] of this._sessionTokens) {
      if (now - meta.createdAt > this._sessionTokenTtlMs) {
        this._sessionTokens.delete(stored)
        removed++
      }
    }
    // Stop the timer once the map is empty — re-armed on the next issuance.
    if (this._sessionTokens.size === 0 && this._sessionTokenSweepTimer) {
      clearInterval(this._sessionTokenSweepTimer)
      this._sessionTokenSweepTimer = null
    }
    // #6598: a sweep that dropped an expired token is a structural change —
    // persist so the reaped token doesn't reappear on the next restart.
    if (removed > 0) this._persistSessionTokens()
    return removed
  }

  _ensureSessionTokenSweepTimer() {
    if (this._destroyed || this._sessionTokenSweepTimer) return
    this._sessionTokenSweepTimer = setInterval(() => this._sweepSessionTokens(), SESSION_TOKEN_SWEEP_INTERVAL_MS)
    this._sessionTokenSweepTimer.unref?.()
  }

  /**
   * #6598: persist the current session-token map through the injected store, if
   * any. Best-effort — the store swallows + logs I/O errors, never throwing into
   * token issuance or the auth path. Used for STRUCTURAL changes (mint / sweep).
   */
  _persistSessionTokens() {
    if (!this._sessionTokenStore) return
    try {
      this._sessionTokenStore.save([...this._sessionTokens.entries()])
    } catch { /* store logs; a failed persist just means a restart may re-pair */ }
  }

  /**
   * #6902: persist an explicit entries SNAPSHOT and REPORT whether the durable
   * write succeeded. This is the fail-CLOSED counterpart to `_persistSessionTokens`
   * (fire-and-forget, used for the fail-SAFE structural changes — mint / sweep /
   * slide — where a lost persist merely forces a harmless re-pair).
   *
   * A REVOKE is the asymmetric case: dropping the token from the in-memory map
   * FIRST and persisting best-effort is fail-OPEN — a crash between the in-memory
   * delete and the durable write leaves the revoked token in `session-tokens.json`,
   * so it RESURRECTS and authenticates on the next start. The revoke callers use
   * this helper to persist the post-removal snapshot BEFORE they mutate the map,
   * and only proceed if it durably landed — so a crash at any point either keeps
   * the token fully valid (memory + disk agree, operator can retry) or leaves it
   * revoked on disk. It can never resurrect.
   *
   * The store's `save()` is atomic (temp file + rename via `writeFileRestricted`),
   * so the on-disk file is always either the pre- or the post-removal state, never
   * a torn write. With no store configured (in-memory-only mode) there is no
   * durability to lose — a restart wipes every token regardless — so we report
   * success and let the caller mutate memory.
   *
   * @param {Array<[string, object]>} entries - the target `[token, meta]` snapshot
   * @returns {boolean} true iff the snapshot is durably persisted (or no store)
   */
  _persistSessionTokensSnapshot(entries) {
    if (!this._sessionTokenStore) return true
    try {
      return this._sessionTokenStore.save(entries) === true
    } catch {
      // A store whose save() throws (rather than returning false) is a failed
      // persist just the same — report it so the revoke reports failure.
      return false
    }
  }

  /**
   * #6598: persist a sliding-expiry refresh, throttled to at most once per
   * SLIDE_PERSIST_THROTTLE_MS so a reconnect-happy client doesn't churn the disk.
   * A slide missed by the throttle is at most SLIDE_PERSIST_THROTTLE_MS stale on
   * disk, negligible against the multi-day TTL.
   */
  _maybePersistSlide() {
    if (!this._sessionTokenStore) return
    const now = Date.now()
    if (now - this._lastSlidePersistMs < SLIDE_PERSIST_THROTTLE_MS) return
    this._lastSlidePersistMs = now
    this._persistSessionTokens()
  }

  /**
   * #5555: issue a new session token under the cap, sweeping expired tokens
   * BEFORE evicting any still-valid one. The pre-fix path evicted the oldest
   * Map entry by insertion order — the longest-paired (and likely still-valid)
   * device — even when expired tokens were sitting in the map ready to be
   * reaped. Only after the sweep, if still at cap, do we evict the oldest
   * remaining (now guaranteed all-valid) token.
   * @param {string} token
   * @param {object} meta - token metadata ({ createdAt, sessionId })
   */
  _storeSessionToken(token, meta) {
    if (this._sessionTokens.size >= MAX_SESSION_TOKENS) {
      this._sweepSessionTokens()
      if (this._sessionTokens.size >= MAX_SESSION_TOKENS) {
        const oldest = this._sessionTokens.keys().next().value
        this._sessionTokens.delete(oldest)
      }
    }
    this._sessionTokens.set(token, meta)
    this._ensureSessionTokenSweepTimer()
    // #6598: a freshly minted token is a structural change — persist immediately
    // so a device paired right before a restart stays paired after it.
    this._persistSessionTokens()
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
    // Unbound (host-authority) token — sessionId: null, like linking-mode QR.
    this._storeSessionToken(token, { createdAt: Date.now(), sessionId: null })
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
    if (this._sessionTokenSweepTimer) {
      clearInterval(this._sessionTokenSweepTimer)
      this._sessionTokenSweepTimer = null
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
