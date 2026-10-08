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
 * Bounded twice, because a client can mint ids: at most `maxRecent` entries (oldest
 * evicted first) and `ttlMs` each. An id that was never routed has no entry, so
 * "unknown" and "evicted" are the same silence.
 */
const DEFAULT_MAX_RECENT = 512
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
   * @param {{ maxRecent?: number, ttlMs?: number, now?: () => number }} [opts]
   */
  constructor({ maxRecent = DEFAULT_MAX_RECENT, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    super()
    this._maxRecent = maxRecent
    this._ttlMs = ttlMs
    this._now = now
    /** @type {Map<string, { sessionId: string|null, at: number, answerDigest?: string }>} */
    this._recent = new Map()
  }

  /** Remove a route and remember who owned it. */
  delete(key) {
    if (!super.has(key)) return false
    this._recent.delete(key)
    this._recent.set(key, { sessionId: super.get(key), at: this._now() })
    while (this._recent.size > this._maxRecent) this._recent.delete(this._recent.keys().next().value)
    return super.delete(key)
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
      this._recent.delete(key)
      return undefined
    }
    return entry
  }
}
