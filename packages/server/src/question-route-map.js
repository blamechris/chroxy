import { createHash } from 'node:crypto'

/**
 * #8470: toolUseId -> owning sessionId for AskUserQuestion routing
 * (`WsServer._questionSessionMap`), plus a short, bounded memory of the routes
 * that were just removed.
 *
 * A late answer finds its route gone, and the handler needs two facts about it
 * that the live map no longer holds: WHICH session owned the question (so the
 * "not delivered" notice goes only to a client entitled to that session, never
 * to one probing another session's ids), and WHAT answer landed (so a duplicate of
 * an answer that was delivered is not reported as lost). Both are recorded when a
 * route is deleted.
 *
 * Bounded three ways, because a client can mint questions (by superseding its own):
 * `ttlMs` each; at most `maxPerOwner` per owning session, so one session's churn
 * can only evict its OWN records (a shared FIFO would let session A's activity
 * decide whether session B's late answer is reported: an activity oracle, and a
 * silenced notice for the other user); and a global hard cap of `maxRecent` that
 * evicts from the session holding the most records. An id that was never routed has
 * no entry, so "unknown" and "evicted" are the same silence.
 */
const DEFAULT_MAX_RECENT = 512
const DEFAULT_MAX_PER_OWNER = 64
const DEFAULT_TTL_MS = 15 * 60 * 1000

/** Key-order-independent JSON, so two clients' equal answers hash equal. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * A digest of what a `user_question_response` says. The answer text is never kept,
 * only this: the history deliberately stores no user answers.
 * @param {{ answer?: unknown, answers?: unknown, freeformText?: unknown }} msg
 */
export function answerDigest(msg) {
  const body = stableStringify({ answer: msg?.answer ?? null, answers: msg?.answers ?? null, freeformText: msg?.freeformText ?? null })
  return createHash('sha256').update(body).digest('hex')
}

export class QuestionRouteMap extends Map {
  /**
   * @param {{ maxRecent?: number, maxPerOwner?: number, ttlMs?: number, now?: () => number }} [opts]
   */
  constructor({ maxRecent = DEFAULT_MAX_RECENT, maxPerOwner = DEFAULT_MAX_PER_OWNER, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    super()
    this._maxRecent = maxRecent
    this._maxPerOwner = maxPerOwner
    this._ttlMs = ttlMs
    this._now = now
    /** @type {Map<string, { sessionId: string|null, at: number, answerDigest?: string }>} */
    this._recent = new Map()
    /** owner -> its record keys, oldest first @type {Map<string|null, Set<string>>} */
    this._byOwner = new Map()
  }

  _forget(key) {
    const entry = this._recent.get(key)
    if (!entry) return
    this._recent.delete(key)
    const keys = this._byOwner.get(entry.sessionId)
    if (keys) {
      keys.delete(key)
      if (keys.size === 0) this._byOwner.delete(entry.sessionId)
    }
  }

  /** Drop every record past its TTL. Oldest first: records are inserted in time order. */
  _expire() {
    const now = this._now()
    for (const [key, entry] of this._recent) {
      if (now - entry.at <= this._ttlMs) break
      this._forget(key)
    }
  }

  /** Remove a route and remember who owned it. */
  delete(key) {
    if (!super.has(key)) return false
    const sessionId = super.get(key)
    this._expire()
    this._forget(key)
    this._recent.set(key, { sessionId, at: this._now() })
    let keys = this._byOwner.get(sessionId)
    if (!keys) this._byOwner.set(sessionId, (keys = new Set()))
    keys.add(key)
    // This owner pays for its own churn first.
    while (keys.size > this._maxPerOwner) this._forget(keys.values().next().value)
    // The hard cap takes from whoever holds the most, never from the oldest record
    // overall (which may be a quiet session's only one).
    while (this._recent.size > this._maxRecent) {
      let biggest = null
      for (const set of this._byOwner.values()) if (!biggest || set.size > biggest.size) biggest = set
      this._forget(biggest.values().next().value)
    }
    return super.delete(key)
  }

  /** Server stop: forget the live routes AND the recent owners. */
  clear() {
    this._recent.clear()
    this._byOwner.clear()
    super.clear()
  }

  /** The delivered answer's digest, attached to the route just removed for it. */
  noteAnswered(key, digest) {
    const entry = this._recent.get(key)
    if (entry) entry.answerDigest = digest
  }

  /**
   * Who owned this question, if its route was removed within the TTL.
   * @returns {{ sessionId: string|null, answerDigest?: string }|undefined}
   */
  recentOwner(key) {
    const entry = this._recent.get(key)
    if (!entry) return undefined
    if (this._now() - entry.at > this._ttlMs) {
      this._forget(key)
      return undefined
    }
    return entry
  }
}
