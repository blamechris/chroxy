/**
 * The agent principal's session roster snapshot (docs/security/agent-principals.md
 * sections 4 and 7.3; #9120, S5 of #9112).
 *
 * `collectSessionsSnapshot` returns one minimal row per session asked about: its observed
 * status, what the agent declared, which model was requested and which is running, and the
 * reasons a handoff must not start from it right now (#8281).
 *
 * Every row is read from THAT session's own entry and from `getHandoffBlockers`. Nothing here
 * calls `listSessions()`: it runs provider getters for EVERY session, so a session the
 * principal is not granted could change (or break) the reply. The caller has already checked
 * every id against the principal's grant; this module reads what it is told to and knows
 * nothing about who is asking.
 *
 *   - FAIL SAFE, never open. A row whose read throws still appears, with its unreadable fields
 *     null and `blockers: [{ code: 'unavailable' }]`. An EMPTY blocker list means "safe to hand
 *     off", so it is never what a failed read produces. Other rows are unaffected.
 *   - A session `getHandoffBlockers` does not know (`not_found`) is omitted.
 *   - Blockers are projected through a per-code detail whitelist (the same table the outgoing
 *     frame is rebuilt from, principal-policy.js). A code this module does not know is
 *     delivered as `{ code }` with no detail: it is still a blocker.
 *   - `leaseHolder` is always null here and is filled by S8 (leases), so the wire shape is
 *     stable. No cwd, history, cost, billing or capability field exists in a row.
 *   - Bounded: at most `PRINCIPAL_SESSIONS_SNAPSHOT_MAX` rows, in the order of `sessionIds`
 *     (the caller's order), with `truncated` when more existed.
 */
import { DeclaredStatusSchema } from '@chroxy/protocol'
import { busyStateOf } from './session-busy-state.js'
import { redactBounded } from './redaction.js'
import { PRINCIPAL_BLOCKER_DETAIL_FIELDS, PRINCIPAL_DECLARED_STATUS_FIELDS } from './principal-policy.js'

/** The most rows one reply carries (the protocol schema's `.max()`). */
export const PRINCIPAL_SESSIONS_SNAPSHOT_MAX = 100

const NAME_MAX = 200
const PROVIDER_MAX = 64
const MODEL_MAX = 200
const DECLARED_TEXT_MAX = 280
const BLOCKER_CODE_MAX = 64
const REQUEST_IDS_MAX = 100
const REQUEST_ID_MAX = 256

const UNAVAILABLE = Object.freeze({ code: 'unavailable' })

const boundedString = (value, max) => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null)

/** One blocker, projected through the detail whitelist. Anything that is not a blocker is `unavailable`. */
function projectBlocker(blocker) {
  if (blocker === null || typeof blocker !== 'object' || typeof blocker.code !== 'string' || blocker.code.length === 0) {
    return { ...UNAVAILABLE }
  }
  const out = { code: blocker.code.slice(0, BLOCKER_CODE_MAX) }
  const spec = Object.hasOwn(PRINCIPAL_BLOCKER_DETAIL_FIELDS, blocker.code) ? PRINCIPAL_BLOCKER_DETAIL_FIELDS[blocker.code] : null
  const detail = blocker.detail
  if (spec === null || detail === null || typeof detail !== 'object') return out
  const kept = {}
  for (const [field, kind] of Object.entries(spec)) {
    const value = detail[field]
    if (kind === 'count') {
      if (Number.isSafeInteger(value) && value >= 0) kept[field] = value
    } else if (kind === 'bool') {
      if (typeof value === 'boolean') kept[field] = value
    } else if (kind === 'string') {
      if (typeof value === 'string' && value.length > 0) kept[field] = value.slice(0, REQUEST_ID_MAX)
    } else if (kind === 'strings') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        kept[field] = value.slice(0, REQUEST_IDS_MAX).map((v) => v.slice(0, REQUEST_ID_MAX))
      }
    }
  }
  if (Object.keys(kept).length > 0) out.detail = kept
  return out
}

/**
 * The declared status of an entry, validated against the daemon's own schema and with its
 * free text redacted, or null when there is none (or it does not validate: nothing unvalidated
 * is relayed).
 */
function projectDeclaredStatus(declared) {
  if (declared === undefined || declared === null) return null
  const parsed = DeclaredStatusSchema.safeParse(declared)
  if (!parsed.success) return null
  const out = {}
  for (const key of Object.keys(PRINCIPAL_DECLARED_STATUS_FIELDS)) {
    const value = parsed.data[key]
    if (value === undefined) continue
    if (typeof value === 'string' && key !== 'state' && key !== 'source') {
      const text = redactBounded(value, DECLARED_TEXT_MAX)
      if (text.length > 0) out[key] = text
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * One row, or null when the session is not there. Every read of the session is guarded: one
 * that throws marks the row `unavailable` and leaves the others untouched.
 */
function buildRow(sessionId, sessionManager, evaluatorPending) {
  let failed = false
  const read = (fn, fallback = null) => {
    try { return fn() } catch { failed = true; return fallback }
  }

  let entry
  try {
    entry = typeof sessionManager?.getSession === 'function' ? sessionManager.getSession(sessionId) : null
  } catch {
    // The entry itself cannot be read: the session is there (the grant check saw it), its row is not.
    return {
      sessionId, name: null, provider: null, status: null, declaredStatus: null, model: null,
      blockers: [{ ...UNAVAILABLE }], leaseHolder: null, lastActivityAt: null,
    }
  }
  if (entry === null || entry === undefined) return null

  // `evaluatorPending` is WS-layer state the accessor cannot see (its own doc says the
  // caller must pass it); it is asked per session, and a failure to ask is a failed read.
  const evaluatorFlag = read(() => evaluatorPending(sessionId) === true)
  const rawBlockers = read(() => sessionManager.getHandoffBlockers(sessionId, { evaluatorPending: evaluatorFlag === true }))
  let blockers = null
  if (Array.isArray(rawBlockers)) {
    if (rawBlockers.length === 1 && rawBlockers[0]?.code === 'not_found') return null
    blockers = rawBlockers.map(projectBlocker)
  } else {
    failed = true
  }

  const session = entry.session
  const status = read(() => {
    const busy = busyStateOf(session)
    return {
      isBusy: busy.busyReason !== null,
      busyReason: busy.busyReason,
      starting: entry._starting === true,
    }
  })
  const model = read(() => ({
    // `requested` is the explicit override (null follows the default); `observed` is what is running.
    requested: boundedString(session?.model, MODEL_MAX),
    observed: boundedString(session?.bootedModel, MODEL_MAX),
  }))
  const name = read(() => (typeof entry.name === 'string' ? redactBounded(entry.name, NAME_MAX) : null))
  const provider = read(() => boundedString(entry.provider || sessionManager.providerType, PROVIDER_MAX))
  const declaredStatus = read(() => projectDeclaredStatus(entry.declaredStatus))
  const activity = read(() => (typeof sessionManager.getLastActivityAt === 'function' ? sessionManager.getLastActivityAt(sessionId) : null))

  return {
    sessionId,
    name,
    provider,
    status,
    declaredStatus,
    model,
    // An empty list means "safe to hand off": a failed read must never produce one.
    blockers: failed || blockers === null ? [{ ...UNAVAILABLE }] : blockers,
    leaseHolder: null, // filled by S8 (leases)
    lastActivityAt: Number.isFinite(activity) && activity >= 0 ? Math.trunc(activity) : null,
  }
}

/**
 * @param {object} opts
 * @param {string[]} opts.sessionIds   granted, de-duplicated session ids, in reply order
 * @param {object|null} opts.sessionManager  needs `getSession`, `getHandoffBlockers`
 * @param {(sessionId: string) => boolean} opts.evaluatorPending  does the prompt evaluator hold this session's draft
 * @param {number} [opts.now]
 * @param {number} [opts.max]
 * @returns {{ generatedAt: number, sessions: object[], truncated: boolean }}
 */
export function collectSessionsSnapshot({
  sessionIds, sessionManager, evaluatorPending, now = Date.now(), max = PRINCIPAL_SESSIONS_SNAPSHOT_MAX,
}) {
  const sessions = []
  let truncated = false
  for (const sessionId of sessionIds) {
    if (sessions.length >= max) {
      // Past the cap only existence is asked, so a further row is never built.
      let present = false
      try { present = sessionManager?.getSession?.(sessionId) != null } catch { present = true }
      if (present) { truncated = true; break }
      continue
    }
    const row = buildRow(sessionId, sessionManager, evaluatorPending)
    if (row !== null) sessions.push(row)
  }
  return { generatedAt: now, sessions, truncated }
}
