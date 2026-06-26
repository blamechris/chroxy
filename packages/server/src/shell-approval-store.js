import { randomBytes } from 'crypto'

// #6277 — host-local per-spawn user-shell approval store.
//
// When `userShell.requireApproval` is on, a user-shell create is HELD here as a
// pending approval instead of spawning immediately. The host operator reads the
// one-time approval id from the daemon log and approves it out-of-band via the
// loopback-only `/api/shell/*` routes (or `chroxy shell approve <id>`); only then
// is the session actually created. This is the defense-in-depth control from
// `docs/security/bearer-token-authority.md §12`: a leaked primary token can no
// longer spawn an unmediated host shell over the tunnel without a host-side OK.
//
// Design (user-decided):
//   - PER-SPAWN: every create needs its own approval; an approval is single-use
//     and there is NO trust window.
//   - SHORT TTL: a held approval expires (default 60s) so a stale id can't be
//     redeemed later.
//   - PURE STATE: this store holds no side effects — `approve()`/`deny()` just
//     resolve the entry; the WS layer runs the deferred `createSession` + notify.
//     That keeps it trivially unit-testable and keeps the create logic in one
//     place (the same `finalizeShellCreate` the synchronous path uses).

/** Default time a held approval stays redeemable. */
export const DEFAULT_APPROVAL_TTL_MS = 60_000

/** Cap on simultaneously-pending approvals; oldest is evicted FIFO past this so
 *  a spammy client can't grow the map unbounded (mirrors MAX_ACTIVE_PAIRINGS). */
export const DEFAULT_MAX_PENDING = 32

/** Short, operator-typeable approval id (8 hex chars). Collisions within a
 *  handful of pending entries are astronomically unlikely; we retry anyway. */
function defaultGenerateId() {
  return randomBytes(4).toString('hex')
}

export class ShellApprovalStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] - approval lifetime (default 60s)
   * @param {number} [opts.maxPending] - FIFO cap (default 32)
   * @param {() => number} [opts.now] - clock (injectable for tests)
   * @param {() => string} [opts.generateId] - id generator (injectable for tests)
   */
  constructor({ ttlMs = DEFAULT_APPROVAL_TTL_MS, maxPending = DEFAULT_MAX_PENDING, now = () => Date.now(), generateId = defaultGenerateId } = {}) {
    this._ttlMs = ttlMs
    this._maxPending = maxPending
    this._now = now
    this._generateId = generateId
    // Insertion-ordered Map → the first key is the oldest (FIFO eviction).
    this._pending = new Map()
  }

  get size() {
    return this._pending.size
  }

  /**
   * Hold a user-shell create as a pending approval. Returns the one-time
   * `approvalId` (log this for the host operator) and `expiresAt`.
   *
   * `createSessionOptions` is the FULL options object destined for
   * SessionManager.createSession — stored, NOT executed. createSession has
   * side effects (worktree, event wiring) and must run exactly once, only after
   * approval; running it here would duplicate the session.
   *
   * @param {object} req
   * @param {string} req.clientId - the requesting WS client (to notify on approve)
   * @param {object} req.createSessionOptions - replayed to createSession on approve
   * @param {string} [req.tokenClass] - for the post-create audit record
   * @param {string} [req.deviceName] - for the audit + `shell list`
   * @param {string} [req.hint] - human-facing label surfaced to the client/log
   * @returns {{ approvalId: string, expiresAt: number }}
   */
  createPendingApproval({ clientId, createSessionOptions, tokenClass = null, deviceName = null, hint = null } = {}) {
    this._sweepExpired()
    // FIFO-evict the oldest while at/over the cap (a fresh request shouldn't be
    // refused; the oldest held approval is the most likely to be abandoned).
    while (this._pending.size >= this._maxPending) {
      const oldest = this._pending.keys().next().value
      if (oldest === undefined) break
      this._pending.delete(oldest)
    }
    const requestedAt = this._now()
    const expiresAt = requestedAt + this._ttlMs
    let approvalId = this._generateId()
    // Defend against an id collision (or a deterministic test generator).
    let guard = 0
    while (this._pending.has(approvalId) && guard < 1000) {
      approvalId = this._generateId()
      guard += 1
    }
    this._pending.set(approvalId, {
      approvalId,
      clientId,
      createSessionOptions,
      tokenClass,
      deviceName,
      hint,
      requestedAt,
      expiresAt,
    })
    return { approvalId, expiresAt }
  }

  /**
   * Resolve a pending approval. Single-use: a present, unexpired entry is
   * removed and returned; a second call on the same id is `not_found`.
   * @returns {{ ok: true, entry: object } | { ok: false, reason: 'not_found'|'expired' }}
   */
  approve(approvalId) {
    return this._consume(approvalId)
  }

  /**
   * Reject a pending approval (host operator declines the spawn). Same
   * lookup/removal as approve; the caller notifies the requester.
   * @returns {{ ok: true, entry: object } | { ok: false, reason: 'not_found'|'expired' }}
   */
  deny(approvalId) {
    return this._consume(approvalId)
  }

  _consume(approvalId) {
    if (typeof approvalId !== 'string' || approvalId.length === 0) {
      return { ok: false, reason: 'not_found' }
    }
    const entry = this._pending.get(approvalId)
    if (!entry) return { ok: false, reason: 'not_found' }
    // Check expiry on the looked-up entry BEFORE any sweep so a just-expired id
    // returns the specific `expired` reason rather than a generic `not_found`.
    if (this._now() > entry.expiresAt) {
      this._pending.delete(approvalId)
      return { ok: false, reason: 'expired' }
    }
    this._pending.delete(approvalId) // single-use — no trust window
    return { ok: true, entry }
  }

  /**
   * Non-secret snapshot of currently-pending approvals for `chroxy shell list`.
   * Deliberately omits createSessionOptions internals beyond the cwd.
   * @returns {Array<{approvalId:string, clientId:string, cwd:string|null, deviceName:string|null, requestedAt:number, expiresAt:number}>}
   */
  list() {
    this._sweepExpired()
    return [...this._pending.values()].map((e) => ({
      approvalId: e.approvalId,
      clientId: e.clientId,
      cwd: e.createSessionOptions?.cwd ?? null,
      deviceName: e.deviceName,
      requestedAt: e.requestedAt,
      expiresAt: e.expiresAt,
    }))
  }

  /** Drop entries past their TTL (lazy GC; runs on create + list). */
  _sweepExpired() {
    const now = this._now()
    for (const [id, entry] of this._pending) {
      if (now > entry.expiresAt) this._pending.delete(id)
    }
  }
}
