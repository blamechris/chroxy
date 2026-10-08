/**
 * Usage-limit / rate-limit / overload classification for claude-tui (#8400).
 *
 * Pure: text (or one structured transcript entry) in, a classified result out.
 * No session state, no I/O, so the PTY paths and the transcript scanner share
 * ONE definition of "what claude prints when it cannot answer" and the
 * diagnostics rework (#8252 / #8387) can call it without depending on anything
 * in `claude-tui-session.js`.
 *
 * Why this exists. A turn that hits the account's usage limit never reaches the
 * Stop hook: claude renders "You've hit your session limit · resets 11:30pm
 * (America/Los_Angeles)" and returns to its prompt. Chroxy saw silence, so the
 * user got "No response from claude TUI within 90s. Try sending again." (and,
 * since #8387 keeps the terminal tail out of the chat, no trace of the real
 * reason at all). Retrying cannot help until the limit resets.
 *
 * Wording below is taken from real claude transcripts (the structured
 * `isApiErrorMessage` entries claude writes next to the screen text):
 *
 *   rate_limit  429  You've hit your session limit · resets 11:30pm (America/Los_Angeles)
 *   rate_limit  429  You've hit your weekly limit · resets Jul 22 at 4pm (America/Los_Angeles)
 *   rate_limit  429  Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.
 *   server_error 529 API Error: 529 Overloaded. This is a server-side issue, usually temporary ...
 *
 * and from earlier claude releases / the API (no capture on this machine, kept
 * because the same user hits them on an older CLI):
 *
 *   5-hour limit reached ∙ resets 3pm
 *   Claude AI usage limit reached|1760000000
 *   API Error: 429 {"type":"error","error":{"type":"rate_limit_error",...}}
 *
 * FALSE POSITIVES. Every pattern is claude's own sentence, not a bare "limit":
 * "the rate limit is 100/min", "set a limit of 5", "usage limit docs" and
 * "resets the counter" must not match. They are still matched against rendered
 * output, so a model QUOTING one of these sentences during a stalled turn would
 * be classified; callers therefore consult the PTY text only where a turn has
 * already failed (stall / first-output timeout), exactly as the auth scans do,
 * and prefer the structured transcript entry, which does not depend on text.
 *
 * Whitespace. Matching tolerates NO whitespace between words (`\s*`): the PTY
 * tail the scans read has had its cursor-move escapes deleted, so at a narrow
 * terminal "You've hit your session limit" arrives as "You'vehityoursessionlimit"
 * (the same squeeze AUTH_FAILURE_COMPACT_PATTERNS exists for, #8223). The reset
 * time is rebuilt from its parts rather than copied, so it reads the same either
 * way.
 */

/** Error `code` carried on the chat error for a quota-style limit. */
export const USAGE_LIMIT_CODE = 'usage_limit'
export const API_RATE_LIMIT_CODE = 'api_rate_limit'
export const API_OVERLOADED_CODE = 'api_overloaded'

/**
 * @typedef {'session'|'weekly'|'usage'|'credits'|'rate_limit'|'overloaded'} UsageLimitKind
 *
 * @typedef {object} UsageLimit
 * @property {UsageLimitKind} kind
 * @property {string} code - the error `code` for the chat message
 * @property {string|null} resetsAt - human text, e.g. `11:30pm (America/Los_Angeles)`
 * @property {string} message - one plain sentence for the chat
 * @property {string|null} episodeKey - same value for repeats within one limit
 *   window; `null` for a transient failure that has no window (rate limit,
 *   overload), where every failed request is its own event
 */

const APOS = "['’]?"

// "You've hit your session limit" / "...your limit" / "...your Opus limit".
const HIT_YOUR_LIMIT = new RegExp(
  `you${APOS}ve\\s*hit\\s*your\\s*(?:(session|weekly|monthly|opus|sonnet|usage)\\s*)?limit`,
  'i',
)
// "5-hour limit reached", "Weekly limit reached", "Opus weekly limit reached".
const LIMIT_REACHED = /(?:(\d+\s*-?\s*hour|weekly|session|opus\s*weekly|opus)\s*limit\s*reached)/i
// Pre-2.x wording: "Claude AI usage limit reached|<epoch>".
const CLAUDE_USAGE_LIMIT_REACHED = /claude\s*(?:ai\s*)?usage\s*limit\s*reached(?:\s*\|\s*(\d{9,13}))?/i
const REQUIRES_CREDITS = /requires\s*usage\s*credits/i
const HTTP_429 = /api\s*error:?\s*429|rate_limit_error/i
const HTTP_529 = /api\s*error:?\s*529|529\s*overloaded|overloaded_error/i

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*'
// "11:30pm (America/Los_Angeles)", "Jul 22 at 4pm (America/Los_Angeles)", "3pm".
const RESETS_AT = new RegExp(
  `\\bresets?\\s*(?:at\\s*)?(?:(${MONTHS})\\s*(\\d{1,2})\\s*(?:at)?\\s*)?(\\d{1,2}(?::\\d{2})?\\s*[ap]m)\\s*(?:\\(([A-Za-z][A-Za-z_/+\\-0-9]*)\\))?`,
  'i',
)
// "resets in 2 hours 10 minutes".
const RESETS_IN = /\bresets?\s*in\s*(\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*\d+\s*(?:minutes?|mins?|m)\b)?)/i

/**
 * Rebuild the reset time as readable text from whichever form the screen used.
 * @param {string} text
 * @param {string|null} epoch - seconds or milliseconds since the epoch, when the
 *   line carried one instead of a clock time
 * @returns {string|null}
 */
function extractResetsAt(text, epoch) {
  if (epoch) {
    const n = Number(epoch)
    const ms = epoch.length >= 13 ? n : n * 1000
    const d = new Date(ms)
    if (Number.isFinite(d.getTime())) return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
  const at = RESETS_AT.exec(text)
  if (at) {
    const [, month, day, time, zone] = at
    const date = month ? `${month.charAt(0).toUpperCase()}${month.slice(1, 3).toLowerCase()} ${day} at ` : ''
    const clock = time.replace(/\s+/g, '').toLowerCase()
    return `${date}${clock}${zone ? ` (${zone})` : ''}`
  }
  const rel = RESETS_IN.exec(text)
  if (rel) return `in ${rel[1].replace(/\s+/g, ' ').trim()}`
  return null
}

function quotaMessage(kind, resetsAt) {
  const label = kind === 'session' ? 'session ' : kind === 'weekly' ? 'weekly ' : ''
  const head = `Claude's ${label}usage limit was reached.`
  return resetsAt
    ? `${head} It resets ${resetsAt}; messages will not go through until then.`
    : `${head} Messages will not go through until it resets.`
}

/** @returns {UsageLimit} */
function quota(kind, text, epoch) {
  const resetsAt = extractResetsAt(text, epoch)
  return {
    kind,
    code: USAGE_LIMIT_CODE,
    resetsAt,
    message: quotaMessage(kind, resetsAt),
    episodeKey: `${kind}|${resetsAt ?? ''}`,
  }
}

function kindOf(label) {
  const l = (label || '').toLowerCase().replace(/\s+/g, '')
  if (l === 'weekly' || l === 'opusweekly') return 'weekly'
  if (l === 'session' || l.endsWith('hour')) return 'session'
  return 'usage'
}

/**
 * Classify a stretch of claude output (or the text of a transcript entry).
 *
 * @param {unknown} text
 * @returns {UsageLimit|null} `null` when the text is not one of claude's
 *   limit / rate-limit / overload messages
 */
export function classifyUsageLimit(text) {
  if (typeof text !== 'string' || text.length === 0) return null

  const hit = HIT_YOUR_LIMIT.exec(text)
  if (hit) return quota(kindOf(hit[1]), text, null)

  const reached = LIMIT_REACHED.exec(text)
  if (reached) return quota(kindOf(reached[1]), text, null)

  const legacy = CLAUDE_USAGE_LIMIT_REACHED.exec(text)
  if (legacy) return quota('usage', text, legacy[1] || null)

  if (REQUIRES_CREDITS.test(text)) {
    return {
      kind: 'credits',
      code: USAGE_LIMIT_CODE,
      resetsAt: null,
      message: 'Claude cannot run this model without usage credits. Switch to another model, or add usage credits, then send your message again.',
      episodeKey: 'credits|',
    }
  }

  if (HTTP_529.test(text)) {
    return {
      kind: 'overloaded',
      code: API_OVERLOADED_CODE,
      resetsAt: null,
      message: "Claude's API is overloaded (HTTP 529). Wait a moment, then send your message again.",
      episodeKey: null,
    }
  }

  if (HTTP_429.test(text)) {
    return {
      kind: 'rate_limit',
      code: API_RATE_LIMIT_CODE,
      resetsAt: null,
      message: "Claude's API rate limit was hit (HTTP 429). Wait a moment, then send your message again.",
      episodeKey: null,
    }
  }

  return null
}

/**
 * Classify one structured transcript entry's error marker. The `error` /
 * `apiErrorStatus` fields are claude's own classification, so they decide
 * WHETHER this is a limit; the text only refines WHICH one and supplies the
 * reset time.
 *
 * @param {{ error?: unknown, apiErrorStatus?: unknown, text?: unknown }} entry
 * @returns {UsageLimit|null}
 */
export function classifyApiErrorEntry({ error, apiErrorStatus, text } = {}) {
  const fromText = classifyUsageLimit(text)
  if (apiErrorStatus === 529) return fromText?.kind === 'overloaded' ? fromText : classifyUsageLimit('API Error: 529')
  if (error === 'rate_limit' || apiErrorStatus === 429) {
    return fromText ?? classifyUsageLimit('API Error: 429')
  }
  if (error === 'server_error' && fromText?.kind === 'overloaded') return fromText
  return null
}
