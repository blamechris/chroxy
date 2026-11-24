/**
 * Adapter over the daemon's persisted session-state file
 * (`~/.chroxy/session-state.json`, written by `SessionStatePersistence`).
 *
 * It reads declared-status fields and nothing else. Of each persisted session
 * it takes the `id` and the `declaredStatus` object, and of that object the
 * `state`, `next`, `blockedOn`, `decision`, `updatedAt` and `source` fields.
 * Everything else the file holds (names, working directories, history,
 * usage, `summary` text) is never read into a value this module returns, so
 * it cannot reach the ledger.
 *
 * The file is opened read-only and never written. Every read is shape-checked:
 *
 *   - the file must be a JSON object with `version: 1` and a `sessions` array
 *     whose entries are objects with a unique non-empty string `id`;
 *   - a session's `declaredStatus`, when present, must satisfy the daemon's
 *     own strict `DeclaredStatusSchema` (an unknown key is a changed shape).
 *
 * A file that fails the first check cannot be listed (`list()` is null, and
 * every tracked session's read is `error: shape_changed`). A session whose
 * declaration fails the second reads as `error: shape_changed`. A changed
 * shape is therefore always an error, never `idle`, never `no_report`.
 *
 * `list()` takes one snapshot of the file; the `read()` calls that follow
 * answer from it, so one tick sees one consistent file.
 *
 * Time: the daemon stamps `updatedAt` when the declaration changes, so the
 * report time is a changed-at time (README: `report_time_basis: changed_at`).
 * A decision carried by such a declaration may be inherited from an earlier
 * one, so it is recorded `possibly_inherited`, never `stated`.
 */

import fs from 'node:fs'
import { DeclaredStatusSchema } from '@chroxy/protocol'
import { extractDeclaredStatus } from '../declared-status.js'

/** The source name the reconciler's configuration must give capabilities for. */
export const STATE_FILE_SOURCE = 'chroxy-state-file'

/** The capabilities `coreConfig` registers for the state-file source. */
export const STATE_FILE_CAPS = Object.freeze({ native_in_read: false, activity_read: false, scope: false, can_confirm_gone: true, report_time_basis: 'changed_at' })

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DECLARED_VIA = { marker: 'marker', api: 'api', hook: 'hook' }

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The name after `OWNER:` in a next-step line, or null. */
function ownerOf(next) {
  if (typeof next !== 'string') return null
  const m = /\bOWNER:\s*(\S.*)$/i.exec(next)
  return m ? m[1].trim() : null
}

/**
 * Map one validated declared status (the daemon's own object) to a report.
 * The same mapping serves a declaration parsed from message text with
 * `extractDeclaredStatus`, which yields the same fields.
 */
export function reportFromDeclared(declared, { updatedAt, via }) {
  const relayed = via === 'api' || via === 'hook'
  const decision = typeof declared.decision === 'string' && declared.decision !== '' ? declared.decision : null
  return {
    state: declared.state,
    last_report_at: updatedAt,
    declared_via: via,
    next: declared.next ?? null,
    declared_blocked_on: declared.blockedOn ?? null,
    decision: relayed ? null : decision,
    decision_basis: relayed || decision == null ? 'none' : via === 'transcript' ? 'stated' : 'possibly_inherited',
    owner_named: relayed ? null : ownerOf(declared.next),
    seed_ref: null,
    time_trusted: true,
  }
}

/**
 * Parse a status block from one completed message with the daemon's parser
 * (`extractDeclaredStatus`) and map it to a report timed `updatedAt`, or null
 * when the text carries no valid declaration. Used by sources that hold message
 * text rather than the daemon's parsed object.
 */
export function reportFromText(text, { updatedAt }) {
  const declared = extractDeclaredStatus(text)
  return declared ? reportFromDeclared(declared, { updatedAt, via: 'transcript' }) : null
}

function loadSnapshot(path, maxBytes) {
  let text
  try {
    const st = fs.statSync(path)
    if (!st.isFile()) return { error: 'shape_changed' }
    if (st.size > maxBytes) return { error: 'too_large' }
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    return { error: err?.code === 'ENOENT' ? 'source_missing' : 'unreachable' }
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { error: 'parse_failed' }
  }
  if (!isPlain(doc) || doc.version !== 1 || !Array.isArray(doc.sessions)) return { error: 'shape_changed' }
  const byId = new Map()
  for (const entry of doc.sessions) {
    if (!isPlain(entry) || typeof entry.id !== 'string' || entry.id === '' || entry.id.length > 256 || byId.has(entry.id)) {
      return { error: 'shape_changed' }
    }
    // Only the declaration is carried forward; the rest of the entry is dropped here.
    byId.set(entry.id, entry.declaredStatus)
  }
  return { byId }
}

/**
 * @param {object} opts
 * @param {string} opts.path          path of the daemon's session-state file
 * @param {string} [opts.source]      source name (default `chroxy-state-file`)
 * @param {number} [opts.maxBytes]    refuse a larger file
 */
export function createStateFileAdapter({ path, source = STATE_FILE_SOURCE, maxBytes = DEFAULT_MAX_BYTES }) {
  if (typeof path !== 'string' || path === '') throw new TypeError('createStateFileAdapter: path is required')
  let snapshot = null
  return {
    source,
    list() {
      snapshot = loadSnapshot(path, maxBytes)
      if (snapshot.error) return null
      return [...snapshot.byId.keys()].map((id) => ({ session: { source, native_id: id, incarnation: null }, scope: null }))
    },
    read(session) {
      if (!snapshot) snapshot = loadSnapshot(path, maxBytes)
      if (snapshot.error) return { outcome: 'error', error_code: snapshot.error }
      if (!snapshot.byId.has(session.native_id)) return { listed: false }
      const raw = snapshot.byId.get(session.native_id)
      if (raw === undefined) return { outcome: 'no_report' }
      const parsed = DeclaredStatusSchema.safeParse(raw)
      if (!parsed.success) return { outcome: 'error', error_code: 'shape_changed' }
      const d = parsed.data
      return { outcome: 'ok', report: reportFromDeclared(d, { updatedAt: d.updatedAt, via: DECLARED_VIA[d.source] }) }
    },
  }
}
