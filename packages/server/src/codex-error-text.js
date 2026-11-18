// #8610 — a human-readable message for a Codex request error.
//
// The backend's error often arrives with its message JSON-encoded inside another
// message, e.g. { message: '{"type":"error","status":400,"error":{"type":
// "invalid_request_error","message":"The model is not supported ..."}}' }. Showing
// JSON.stringify(...) of that, cut at 200 characters, prints escaped JSON and can lose
// the message entirely.
//
// Rules:
// - Only the `error` and `message` keys are followed, never other object values.
// - Precedence at each object: the DEEPER source wins. `error` (an object, or a
//   JSON-encoded object) is tried first; only if it yields no readable message is the
//   object's own `message` used. So a wrapper's generic message ("Request failed") does
//   not hide the nested error's real one. A plain-text (non-JSON) `error` string is used
//   only as a LAST resort, when neither of those yields a message, and only when it reads
//   as prose: a bare code-shaped token (e.g. invalid_request_error) is never a message.
// - A string that looks like JSON (starts with `{` or `[`) is never shown as text. One
//   starting with `{` is decoded only when it is at most MAX_CODEX_ERROR_PARSE characters
//   (checked BEFORE parsing) and parses to an object; one starting with `[` (an array,
//   well-formed or not) is never a message source. Either way, otherwise unreadable.
// - The walk is bounded: at most MAX_CODEX_ERROR_DEPTH levels, two branches per level.
// - `status` is kept only as an integer HTTP status 100-599; `type` only as a short
//   identifier. The deepest valid value wins.
// - The final formatted text is at most MAX_CODEX_ERROR_TEXT characters.
// - When nothing readable is found, callers show UNREADABLE_CODEX_ERROR: no raw
//   payload, escaped JSON or other metadata is ever shown.

export const MAX_CODEX_ERROR_DEPTH = 6
export const MAX_CODEX_ERROR_PARSE = 16 * 1024
export const MAX_CODEX_ERROR_TEXT = 2000
export const UNREADABLE_CODEX_ERROR = 'Codex error: the request failed and returned no readable message.'

const PREFIX = 'Codex error: '
const TYPE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
// A single code-like token, with no whitespace: not prose, so not a last-resort message.
const CODE_RE = /^[A-Za-z0-9_.:/-]+$/

function statusOf(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null
}

function typeOf(v) {
  return typeof v === 'string' && v !== 'error' && TYPE_RE.test(v) ? v : null
}

function read(node, depth) {
  if (depth >= MAX_CODEX_ERROR_DEPTH || node == null) return null
  if (typeof node === 'string') {
    const t = node.trim()
    if (!t) return null
    if (t.startsWith('[')) return null // array or array-like text: never a message, never shown
    if (t.startsWith('{')) {
      if (t.length > MAX_CODEX_ERROR_PARSE) return null
      let parsed
      try { parsed = JSON.parse(t) } catch { return null }
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? read(parsed, depth + 1) : null
    }
    return { message: t, status: null, type: null }
  }
  if (typeof node !== 'object' || Array.isArray(node)) return null
  // `error` is a message source only when it is an object or a JSON-encoded object;
  // a plain-text `error` (often just a code) must not outrank a real `message`.
  const e = node.error
  const nested = (e && typeof e === 'object') || (typeof e === 'string' && e.trim().startsWith('{'))
  const prose = typeof e === 'string' && !nested && !CODE_RE.test(e.trim())
  const found = (nested ? read(e, depth + 1) : null)
    ?? (typeof node.message === 'string' ? read(node.message, depth + 1) : null)
    ?? (prose ? read(e, depth + 1) : null) // last resort; `[` text stays unreadable
  if (!found) return null
  return {
    message: found.message,
    status: found.status ?? statusOf(node.status),
    type: found.type ?? typeOf(node.type),
  }
}

/**
 * @param {unknown} err - the error object (usually `params.error`) or a string
 * @returns {{ message: string, status: number|null, type: string|null }|null}
 */
export function describeCodexError(err) {
  return read(err, 0)
}

/**
 * `Codex error: <message> (status 400, invalid_request_error)`, at most MAX_CODEX_ERROR_TEXT chars.
 * Takes ONLY the validated output of describeCodexError (a non-JSON message, an integer
 * HTTP status or null, a short identifier type or null); it does not re-validate.
 */
export function formatCodexError({ message, status, type }) {
  const detail = [status != null ? `status ${status}` : null, type].filter(Boolean).join(', ')
  const suffix = detail ? ` (${detail})` : ''
  const room = MAX_CODEX_ERROR_TEXT - PREFIX.length - suffix.length
  const body = message.length > room ? `${message.slice(0, room - 1)}…` : message
  return `${PREFIX}${body}${suffix}`
}
