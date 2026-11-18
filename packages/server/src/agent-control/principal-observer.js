/**
 * agent-control principal mode: the read side of an agent principal (#9121, S6 of
 * #9112; docs/security/agent-principals.md sections 4.1 and 7).
 *
 * A thin layer over an `AgentControlClient` constructed with `principal: true` (which
 * owns the handshake, encryption, identity pin, deep redaction of every inbound frame
 * and the outbound type allowlist). Every read goes to a daemon-side `principal_*`
 * request; the daemon is the authority for scope (`principalMaySee`), redaction,
 * bounds, cursors and gaps. Nothing here widens or re-derives any of it:
 *
 *   roster       principal_sessions_snapshot      (S5)
 *   events       principal_events_read            (S3, paged, limit <= 200)
 *   permissions  principal_pending_permissions    (S4, read only, no decision authority)
 *   wait         principal_subscribe as a DOORBELL, then principal_events_read from
 *                the caller's cursor as the source of truth for what is returned
 *
 * The cursor handed to the MCP caller is an opaque, versioned encoding of the
 * daemon's own `{ sessionId, journalId, seq }`; it carries no authority (the daemon
 * re-checks scope on every read) and a stale or forged one is answered by the
 * daemon with a gap, never honoured blindly.
 *
 * Memory is bounded: live events are never buffered here. A wait holds one doorbell
 * listener and one subscription, both released on every exit path, and only one wait
 * runs at a time per connection (a second is refused `WAIT_IN_PROGRESS`).
 */
import { randomUUID } from 'node:crypto'

/** Upper bound for `chroxy_wait_events`' `timeoutMs` (the issue's 60 s). */
export const MAX_WAIT_EVENTS_MS = 60_000
/** The daemon's per-read page cap (contract section 7.2). */
export const MAX_PAGE_LIMIT = 200
export const DEFAULT_PAGE_LIMIT = 50
/** The daemon's `principal_subscribe` / snapshot `sessionIds` cap. */
export const MAX_SESSION_IDS = 32
export const MAX_CURSOR_CHARS = 1024
/**
 * A wait's whole call is bounded by `timeoutMs + WAIT_READ_GRACE_MS`: the grace covers
 * the reads that build the reply after a ring (or at the deadline). No single request
 * inside a wait gets more than what is left of that ceiling, nor more than
 * REQUEST_CEILING_MS.
 */
export const WAIT_READ_GRACE_MS = 5_000
export const REQUEST_CEILING_MS = 15_000

const CURSOR_PREFIX = 'pjc1_'
const REFUSAL_TYPES = ['session_error']

/** A caller-side argument problem the MCP layer reports as INVALID_ARGUMENTS. */
export class ObserverArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ObserverArgumentError'
    this.code = 'INVALID_ARGUMENTS'
  }
}

/**
 * Encode the daemon's journal cursor as an opaque string.
 * @param {{ sessionId: string, journalId: string, seq: number }} cursor
 * @returns {string}
 */
export function encodeCursor(cursor) {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify([cursor.sessionId, cursor.journalId, cursor.seq]), 'utf8').toString('base64url')
}

/**
 * Decode an opaque cursor back to the daemon's shape, validated against the wire
 * schema's bounds (`PrincipalJournalCursorSchema`). Returns null for anything else.
 * @param {unknown} value
 * @returns {{ sessionId: string, journalId: string, seq: number } | null}
 */
export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > MAX_CURSOR_CHARS || !value.startsWith(CURSOR_PREFIX)) return null
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null
  const [sessionId, journalId, seq] = parsed
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128) return null
  if (typeof journalId !== 'string' || journalId.length < 1 || journalId.length > 64) return null
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  return { sessionId, journalId, seq }
}

function boundLimit(limit) {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ObserverArgumentError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`)
  }
  return limit
}

function pickGap(gap) {
  if (!gap || typeof gap !== 'object') return null
  const out = { reason: typeof gap.reason === 'string' ? gap.reason.slice(0, 32) : 'unknown' }
  if (Number.isSafeInteger(gap.fromSeq)) out.fromSeq = gap.fromSeq
  if (Number.isSafeInteger(gap.toSeq)) out.toSeq = gap.toSeq
  if (gap.ended === true) out.ended = true
  return out
}

export class PrincipalObserver {
  /**
   * @param {import('./client.js').AgentControlClient} client - must be `principal: true`
   * @param {{ now?: () => number }} [opts] - clock seam for deterministic tests
   */
  constructor(client, { now = Date.now } = {}) {
    if (!client || client.principal !== true) {
      throw new Error('PrincipalObserver requires an AgentControlClient constructed with principal: true')
    }
    this._client = client
    this._now = now
    this._waiting = false
  }

  /** The client's bounded daemon metadata (shared `chroxy_daemon_info` tool). */
  get daemonInfo() {
    return this._client.daemonInfo
  }

  /**
   * @param {string} type
   * @param {object} fields
   * @param {string} replyType
   * @param {{ timeoutMs?: number, requestId?: string }} [extra] - a wait passes the
   *   remaining share of its own ceiling, so no single request can outlive it
   */
  _request(type, fields, replyType, extra = {}) {
    return this._client.request(type, fields, { replyType, refusalTypes: REFUSAL_TYPES, ...extra })
  }

  /** Granted sessions with observed and declared status, blockers and model (S5). */
  async sessionsSnapshot(sessionIds, extra) {
    const reply = await this._request('principal_sessions_snapshot', sessionIds ? { sessionIds } : {}, 'principal_sessions_snapshot_result', extra)
    return { generatedAt: reply.generatedAt ?? null, sessions: Array.isArray(reply.sessions) ? reply.sessions : [], truncated: reply.truncated === true }
  }

  /** Pending permission requests of the granted sessions (S4). Grants no decision authority. */
  async pendingPermissions(sessionIds) {
    const reply = await this._request('principal_pending_permissions', sessionIds ? { sessionIds } : {}, 'principal_pending_permissions_result')
    return { generatedAt: reply.generatedAt ?? null, permissions: Array.isArray(reply.permissions) ? reply.permissions : [], truncated: reply.truncated === true }
  }

  /**
   * One page of a session's journal after `cursor` (S3).
   * @param {string} sessionId
   * @param {{ cursor?: string, limit?: number }} [opts]
   */
  async readEvents(sessionId, opts = {}) {
    const limit = boundLimit(opts.limit)
    let daemonCursor
    if (opts.cursor !== undefined) {
      daemonCursor = decodeCursor(opts.cursor)
      if (!daemonCursor) throw new ObserverArgumentError('cursor is not a cursor this tool issued')
      if (daemonCursor.sessionId !== sessionId) throw new ObserverArgumentError('cursor belongs to a different session')
    }
    return this._readPage(sessionId, daemonCursor, limit)
  }

  async _readPage(sessionId, daemonCursor, limit, extra) {
    const page = await this._request('principal_events_read', { sessionId, limit, ...(daemonCursor ? { cursor: daemonCursor } : {}) }, 'principal_events_page', extra)
    const events = (Array.isArray(page.events) ? page.events : []).map((e) => ({
      sessionId,
      journalId: page.journalId,
      seq: e.seq,
      ts: e.ts,
      eventType: e.eventType,
      data: e.data,
      ...(e.truncated === true ? { truncated: true } : {}),
    }))
    const offered = page.cursor && typeof page.cursor === 'object'
      ? { sessionId, journalId: page.cursor.journalId, seq: page.cursor.seq }
      : null
    // Only a cursor inside the wire schema's bounds is kept and handed back; anything
    // else falls back to the cursor this read started from, so a malformed daemon
    // value is never re-sent (and never silently rewinds to the start of the window).
    const nextCursor = (offered && decodeCursor(encodeCursor(offered))) || daemonCursor || null
    const gap = pickGap(page.gap)
    return {
      sessionId,
      journalId: page.journalId ?? null,
      events,
      headSeq: Number.isSafeInteger(page.headSeq) ? page.headSeq : null,
      cursor: nextCursor ? encodeCursor(nextCursor) : null,
      more: page.more === true,
      ...(gap ? { gap } : {}),
      _daemonCursor: nextCursor,
    }
  }

  /**
   * Block until any of `sessionIds` has journal events past its cursor, a gap, or
   * the timeout. Returns `{ events, cursors, gaps, more, timedOut, sessionIds }`, where
   * `cursors` is an array in the same shape the `cursors` argument takes.
   * `timedOut: true` with no events means nothing new arrived, never "the work is
   * done". Permission requests are journaled, so a pending prompt wakes a waiter.
   * The whole call is bounded by `timeoutMs + WAIT_READ_GRACE_MS`.
   *
   * @param {{ sessionIds?: string[], cursors?: string[], timeoutMs?: number, limit?: number }} [opts]
   */
  async waitEvents(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30_000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_EVENTS_MS) {
      throw new ObserverArgumentError(`timeoutMs must be an integer from 0 to ${MAX_WAIT_EVENTS_MS}`)
    }
    const limit = boundLimit(opts.limit)
    if (this._waiting) {
      throw Object.assign(new Error('another chroxy_wait_events call is already waiting on this connection; wait for it to return'), { code: 'WAIT_IN_PROGRESS' })
    }
    this._waiting = true
    try {
      return await this._wait(opts, timeoutMs, limit)
    } finally {
      this._waiting = false
    }
  }

  async _wait(opts, timeoutMs, limit) {
    const now = this._now
    const deadline = now() + timeoutMs
    // One aggregate ceiling for the whole call: the wait itself, plus a bounded grace
    // for the reads that build the reply. Every request in this call gets only what is
    // left of it, so a slow daemon cannot stretch a 60 s wait into minutes.
    const ceiling = deadline + WAIT_READ_GRACE_MS
    const budget = () => {
      const left = ceiling - now()
      if (left <= 0) throw Object.assign(new Error(`chroxy_wait_events ran past its ${timeoutMs + WAIT_READ_GRACE_MS} ms ceiling`), { code: 'TIMEOUT' })
      return { timeoutMs: Math.min(left, REQUEST_CEILING_MS) }
    }

    let sessionIds = opts.sessionIds
    let sessionsTruncated = false
    if (!sessionIds) {
      const roster = await this.sessionsSnapshot(undefined, budget())
      const ids = roster.sessions.map((s) => s.sessionId).filter((id) => typeof id === 'string')
      sessionsTruncated = roster.truncated || ids.length > MAX_SESSION_IDS
      sessionIds = ids.slice(0, MAX_SESSION_IDS)
    }
    const extras = sessionsTruncated ? { sessionsTruncated } : {}
    if (sessionIds.length === 0) {
      return { sessionIds: [], events: [], cursors: [], gaps: [], more: false, timedOut: false, ...extras }
    }
    if (new Set(sessionIds).size !== sessionIds.length) throw new ObserverArgumentError('sessionIds must not repeat')

    /** @type {Map<string, object|undefined>} */
    const cursors = new Map(sessionIds.map((id) => [id, undefined]))
    const given = new Set()
    for (const raw of opts.cursors ?? []) {
      const c = decodeCursor(raw)
      if (!c) throw new ObserverArgumentError('a cursor is not a cursor this tool issued')
      if (!cursors.has(c.sessionId)) throw new ObserverArgumentError('a cursor names a session that is not in sessionIds')
      if (given.has(c.sessionId)) throw new ObserverArgumentError('at most one cursor per session')
      given.add(c.sessionId)
      cursors.set(c.sessionId, c)
    }

    // Gaps delivered as frames (and at subscribe time) during this call. A session
    // whose subscription the daemon ENDED (`ended: true`: removed, scope, overflow,
    // backpressure) is not read again in this call: re-reading a removed or no
    // longer granted session is refused, which would throw the gap away.
    const frameGaps = []
    const ended = new Set()
    const readAll = async () => {
      const events = []
      const gaps = [...frameGaps]
      let more = false
      let room = limit
      for (const sid of sessionIds) {
        if (ended.has(sid)) continue
        if (room <= 0) { more = true; break }
        const page = await this._readPage(sid, cursors.get(sid), Math.min(room, MAX_PAGE_LIMIT), budget())
        if (page._daemonCursor) cursors.set(sid, page._daemonCursor)
        events.push(...page.events)
        room -= page.events.length
        if (page.more) more = true
        if (page.gap) gaps.push({ sessionId: sid, ...page.gap })
      }
      // An ARRAY of opaque cursors, in sessionIds order: exactly the shape the
      // `cursors` argument takes, so a caller passes it straight back.
      const out = sessionIds.map((sid) => cursors.get(sid)).filter(Boolean).map(encodeCursor)
      return { sessionIds, events, cursors: out, gaps, more, ...extras }
    }
    const isNews = (r) => r.events.length > 0 || r.gaps.length > 0

    // Read first: anything already past the cursors returns at once, no subscription.
    let result = await readAll()
    if (isNews(result) || now() >= deadline) return { ...result, timedOut: !isNews(result) }

    const idSet = new Set(sessionIds)
    const subscribeId = randomUUID()
    // Correlated: the daemon stamps every principal_event and principal_gap of a
    // subscription with that subscribe's requestId, so a late frame from an earlier
    // subscription on this connection can never ring this call's bell.
    const rings = (msg) => (msg?.type === 'principal_event' || msg?.type === 'principal_gap')
      && msg.requestId === subscribeId && idSet.has(msg.sessionId)
    const arm = () => {
      const bell = this._client.waitForMessage(rings, Math.max(0, deadline - now()))
      // A teardown rejects the bell at once, possibly while this call is still
      // awaiting the subscribe or a read. Mark the rejection handled here; the
      // `await bell.promise` below still sees it, and the read's own rejection
      // carries the same teardown error out.
      bell.promise.catch(() => {})
      return bell
    }
    // Arm BEFORE subscribing, so a replayed or live event that lands while the
    // subscribe is in flight cannot be missed.
    let bell = arm()
    let attempted = false
    try {
      const daemonCursors = [...cursors.values()].filter(Boolean)
      // Set before the send: a subscribe whose ack is lost (timeout) or refused may
      // still have been registered, so the unsubscribe below runs for it too.
      // Unsubscribing something that was never subscribed is a no-op.
      attempted = true
      const reply = await this._request('principal_subscribe', { sessionIds, ...(daemonCursors.length ? { cursors: daemonCursors } : {}) }, 'principal_subscribed', {
        requestId: subscribeId, ...budget(),
      })
      // A subscribe-time gap (an evicted or unknown cursor) is news by itself.
      for (const s of Array.isArray(reply.sessions) ? reply.sessions : []) {
        const gap = s && idSet.has(s.sessionId) ? pickGap(s.gap) : null
        if (gap) frameGaps.push({ sessionId: s.sessionId, ...gap })
      }
      if (frameGaps.length > 0) {
        result = await readAll()
        return { ...result, timedOut: false }
      }
      for (;;) {
        const msg = await bell.promise
        if (msg === null) return { ...result, timedOut: true }
        if (msg.type === 'principal_gap') {
          const gap = pickGap(msg)
          if (gap) frameGaps.push({ sessionId: msg.sessionId, ...gap })
          if (msg.ended === true) ended.add(msg.sessionId)
        }
        // Re-arm BEFORE re-reading: an event that arrives during the read rings the
        // new bell, and the read itself covers everything before it.
        bell = arm()
        result = await readAll()
        if (isNews(result)) return { ...result, timedOut: false }
        if (now() >= deadline) return { ...result, timedOut: true }
      }
    } finally {
      bell.cancel()
      if (attempted && this._client.state === 'ready') {
        // principal_unsubscribe has no reply frame. If the connection is going away
        // the daemon drops the subscription with the socket.
        try { this._client.notify('principal_unsubscribe', { sessionIds }) } catch { /* closing */ }
      }
    }
  }
}

/** Strip the internal field before a page goes out as a tool result. */
export function publicPage(page) {
  const { _daemonCursor: _omit, ...rest } = page
  return rest
}
