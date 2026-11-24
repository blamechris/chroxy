/**
 * The read-only adapter contract.
 *
 * An adapter is a reader for one source of session status. It has a `source`
 * name and exactly two methods:
 *
 *   list()          -> [{ session: { source, native_id, incarnation? }, scope? }] | null
 *                      (null: the source cannot be listed right now)
 *   read(session, now) -> a read, below
 *
 * There is no send method and no way to add one: `sealAdapter` accepts only a
 * plain object whose own keys are `source`, `list` and `read`, and hands the
 * reconciler a frozen view with nothing else on it. An adapter that carries a
 * `send`, `post`, `notify` or any other member is refused, not trimmed, so the
 * mistake is visible where it is made.
 *
 * A read is the data the model's `planRead` consumes:
 *
 *   { listed?, outcome?: 'ok' | 'no_report' | 'error' | 'blocked',
 *     error_code?, not_read_reason?, source_now?, remote_without_clock?,
 *     report?: { state, last_report_at, declared_via, next?, declared_blocked_on?,
 *                decision?, decision_basis?, owner_named?, seed_ref?, time_trusted?,
 *                later_unfootered_messages? },
 *     native?: { turn_in_flight?, busy_background?, pending?, events? } }
 *
 * The adapter reports what it found: `source`, the time of the report
 * (`last_report_at`) and its `state`. It never grades. The reconciler stamps
 * `checked_at` and computes `freshness` (grade.js), so an adapter cannot
 * vouch for its own report's age.
 *
 * `validateRead` shape-checks whatever an adapter returns. A read that does
 * not have the shape, or an adapter that throws, becomes an `error` read with
 * a fixed code. It is never turned into `no_report`, and never into a state.
 */

export class AdapterContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdapterContractError'
  }
}

export const ADAPTER_MEMBERS = Object.freeze(['source', 'list', 'read'])

const MAX_STRING = 2000
const REPORT_STATES = new Set(['running', 'idle', 'blocked', 'stalled', 'done', 'unknown'])
const DECLARED_VIA = new Set(['marker', 'transcript', 'api', 'hook'])
const DECISION_BASIS = new Set(['none', 'stated', 'possibly_inherited'])
const OUTCOMES = new Set(['ok', 'no_report', 'error', 'blocked'])
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Accept an adapter only if it is the read-only shape, and return a frozen
 * view that carries `source`, `list` and `read` and nothing else.
 */
export function sealAdapter(adapter) {
  if (!isPlain(adapter)) throw new AdapterContractError('adapter must be a plain object')
  const extra = Reflect.ownKeys(adapter).filter((k) => !ADAPTER_MEMBERS.includes(k))
  if (extra.length) {
    throw new AdapterContractError(`adapter exposes ${extra.map(String).join(', ')}; the contract is read-only (${ADAPTER_MEMBERS.join(', ')})`)
  }
  for (const k of ADAPTER_MEMBERS) {
    const d = Object.getOwnPropertyDescriptor(adapter, k)
    if (!d || 'get' in d || 'set' in d) throw new AdapterContractError(`adapter.${k} must be a plain data member`)
  }
  if (typeof adapter.source !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(adapter.source)) {
    throw new AdapterContractError('adapter.source must be a short lowercase name')
  }
  if (typeof adapter.list !== 'function' || typeof adapter.read !== 'function') {
    throw new AdapterContractError('adapter.list and adapter.read must be functions')
  }
  const { source, list, read } = adapter
  return Object.freeze({ source, list: () => list.call(adapter), read: (session, now) => read.call(adapter, session, now) })
}

function str(v) {
  return typeof v === 'string' && v.length <= MAX_STRING
}
function strOrNull(v) {
  return v === undefined || v === null || str(v)
}
function onlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k))
}

const REPORT_FIELDS = ['state', 'last_report_at', 'declared_via', 'next', 'declared_blocked_on', 'decision', 'decision_basis', 'owner_named', 'seed_ref', 'time_trusted', 'later_unfootered_messages']

function validReport(r) {
  if (!isPlain(r) || !onlyKeys(r, REPORT_FIELDS)) return false
  if (!REPORT_STATES.has(r.state)) return false
  if (!DECLARED_VIA.has(r.declared_via)) return false
  if (!Number.isSafeInteger(r.last_report_at) || r.last_report_at < 0) return false
  if (!strOrNull(r.next) || !strOrNull(r.declared_blocked_on) || !strOrNull(r.decision) || !strOrNull(r.owner_named)) return false
  if (r.decision_basis !== undefined && !DECISION_BASIS.has(r.decision_basis)) return false
  if (r.seed_ref !== undefined && r.seed_ref !== null && !str(r.seed_ref) && !isPlain(r.seed_ref)) return false
  if (r.time_trusted !== undefined && typeof r.time_trusted !== 'boolean') return false
  if (r.later_unfootered_messages !== undefined && typeof r.later_unfootered_messages !== 'boolean') return false
  return true
}

const NATIVE_FIELDS = ['turn_in_flight', 'busy_background', 'pending', 'events']

function validNative(n) {
  if (!isPlain(n) || !onlyKeys(n, NATIVE_FIELDS)) return false
  for (const k of ['turn_in_flight', 'busy_background']) if (n[k] !== undefined && typeof n[k] !== 'boolean') return false
  if (n.pending !== undefined) {
    if (!Array.isArray(n.pending)) return false
    for (const p of n.pending) {
      if (!isPlain(p) || !onlyKeys(p, ['ref', 'raised_at', 'deadline']) || !str(p.ref)) return false
      for (const k of ['raised_at', 'deadline']) if (p[k] != null && !Number.isFinite(p[k])) return false
    }
  }
  if (n.events !== undefined) {
    if (!Array.isArray(n.events)) return false
    for (const e of n.events) {
      if (!isPlain(e) || !onlyKeys(e, ['id', 'basis', 'ref', 'activity_at']) || !str(e.basis)) return false
      if (e.id != null && !(typeof e.id === 'string' || Number.isSafeInteger(e.id))) return false
      if (e.ref != null && !str(e.ref)) return false
      if (e.activity_at != null && !Number.isFinite(e.activity_at)) return false
    }
  }
  return true
}

const SHAPE_ERROR = Object.freeze({ outcome: 'error', error_code: 'adapter_shape' })
const FAULT_ERROR = Object.freeze({ outcome: 'error', error_code: 'adapter_fault' })

/**
 * Shape-check one read. Returns a read the model can plan from: the read
 * itself if it is well-formed, else an `error` read with a fixed code. The
 * code is never taken from the offending read, so nothing it carried can
 * reach the ledger through the error path.
 */
export function validateRead(read) {
  if (!isPlain(read)) return SHAPE_ERROR
  if (!onlyKeys(read, ['listed', 'outcome', 'error_code', 'not_read_reason', 'source_now', 'remote_without_clock', 'report', 'native'])) return SHAPE_ERROR
  if (read.listed !== undefined && typeof read.listed !== 'boolean') return SHAPE_ERROR
  if (read.outcome !== undefined && !OUTCOMES.has(read.outcome)) return SHAPE_ERROR
  for (const k of ['error_code', 'not_read_reason']) {
    if (read[k] !== undefined && read[k] !== null && !(typeof read[k] === 'string' && CODE_RE.test(read[k]))) return SHAPE_ERROR
  }
  if (read.source_now != null && !Number.isFinite(read.source_now)) return SHAPE_ERROR
  if (read.remote_without_clock !== undefined && typeof read.remote_without_clock !== 'boolean') return SHAPE_ERROR
  if (read.report !== undefined && read.report !== null && !validReport(read.report)) return SHAPE_ERROR
  if (read.native !== undefined && read.native !== null && !validNative(read.native)) return SHAPE_ERROR
  if (read.outcome === 'ok' && !read.report && read.listed !== false) return SHAPE_ERROR
  if (read.report && read.outcome !== 'ok') return SHAPE_ERROR
  return read
}

/** Shape-check a listing. Returns the list, or null when it is not a listing. */
export function validateList(list, source) {
  if (list === null) return null
  if (!Array.isArray(list)) return null
  const out = []
  for (const e of list) {
    if (!isPlain(e) || !onlyKeys(e, ['session', 'scope']) || !isPlain(e.session)) return null
    const s = e.session
    if (!onlyKeys(s, ['source', 'native_id', 'incarnation'])) return null
    if (s.source !== source || !str(s.native_id) || s.native_id === '') return null
    if (s.incarnation != null && !str(s.incarnation) && !Number.isSafeInteger(s.incarnation)) return null
    if (e.scope != null && !str(e.scope)) return null
    out.push({ session: { source: s.source, native_id: s.native_id, incarnation: s.incarnation ?? null }, scope: e.scope ?? null })
  }
  return out
}

/** Call an adapter's `read`, turning a throw or a malformed answer into an `error` read. */
export function safeRead(sealed, session, now) {
  try {
    return validateRead(sealed.read(session, now))
  } catch {
    return FAULT_ERROR
  }
}

/** Call an adapter's `list`; a throw or a malformed answer is `null`, a source that cannot be listed. */
export function safeList(sealed) {
  try {
    return validateList(sealed.list(), sealed.source)
  } catch {
    return null
  }
}
