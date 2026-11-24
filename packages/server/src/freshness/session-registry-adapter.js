/**
 * Adapter over the Claude Code command-line tool's local registry of live
 * sessions: a directory holding one JSON file per live process, named for the
 * process id (`<pid>.json`). It is activity evidence only.
 *
 * A registry row says a session is live and whether it is busy. It is not a
 * status report: this adapter never returns a report, so a session it reads is
 * graded `unknown` (no status line) and can never be `fresh`, whatever the
 * row's time. What it does return is native activity: whether a turn is in
 * flight, and a `registry_busy` or `registry_idle` event timed at the row's
 * `statusUpdatedAt`, with the host application in the event's `ref`.
 *
 * The registry is not a documented interface, so every read is shape-checked
 * and a shape it does not know is `error`, never `idle` and never `no_report`:
 *
 *   - only files named `<digits>.json` are read; every other file in the
 *     directory is ignored without being opened;
 *   - such a file must be a regular file of bounded size holding a JSON object
 *     with a `sessionId` (a short token), a `cwd` string, a `status` of `busy`
 *     or `idle`, a `statusUpdatedAt` in epoch milliseconds and an `entrypoint`
 *     string. Any other value in those fields, an unreadable file or a
 *     duplicate `sessionId` makes the whole registry unreadable for that tick;
 *   - extra keys are expected (the format is not ours) and ignored.
 *
 * Only `sessionId`, the last path segment of `cwd` (the project), `status`,
 * `statusUpdatedAt` and `entrypoint` are carried out of a row. The session
 * title (`name`) and every other field are never read into a value this module
 * returns, so they cannot reach the ledger. An `entrypoint` that is not a short
 * lowercase token is recorded as `other`; the raw string is not kept.
 *
 * The directory is only read, never written. `list()` takes one snapshot and
 * the `read()` calls that follow answer from it. An empty directory is a
 * registry with no live sessions.
 *
 * Time: `statusUpdatedAt` is the time the row's status last changed
 * (`report_time_basis` is `none`: there is no report). A row dated further in
 * the future than `MAX_FUTURE_MS` is `error: clock_skew`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { validSourceName } from './adapter.js'

/** The source name the reconciler's configuration must give capabilities for. */
export const REGISTRY_SOURCE = 'claude-session-registry'

/** The capabilities `coreConfig` registers for the registry source: native activity and scope, no report. */
export const REGISTRY_CAPS = Object.freeze({ native_in_read: true, activity_read: false, scope: true, can_confirm_gone: true, report_time_basis: 'none' })

export const REGISTRY_BASES = Object.freeze({ busy: 'registry_busy', idle: 'registry_idle' })

const DEFAULT_MAX_FILES = 2000
const DEFAULT_MAX_FILE_BYTES = 64 * 1024
const MAX_FUTURE_MS = 5 * 60 * 1000
// Epoch milliseconds are far above this; epoch seconds are far below it.
const MIN_EPOCH_MS = 1e11
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ROW_FILE_RE = /^[0-9]{1,10}\.json$/

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The project a working directory maps to: its last path segment, made safe to store. */
function projectOf(cwd) {
  const seg = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const safe = seg.replace(/[^A-Za-z0-9._@+ -]/g, '_').slice(0, 64)
  return safe === '' ? 'root' : safe
}

/** The host application an entrypoint names, or `other`. */
function appOf(entrypoint) {
  const t = entrypoint.toLowerCase()
  return validSourceName(t) ? t : 'other'
}

/** One row, validated and cut down to the fields this module uses, or null when the shape is not known. */
function parseRow(doc) {
  if (!isPlain(doc)) return null
  const { sessionId, cwd, status, statusUpdatedAt, entrypoint } = doc
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (typeof cwd !== 'string' || cwd === '' || cwd.length > 4096) return null
  if (status !== 'busy' && status !== 'idle') return null
  if (!Number.isSafeInteger(statusUpdatedAt) || statusUpdatedAt < MIN_EPOCH_MS) return null
  if (typeof entrypoint !== 'string' || entrypoint === '' || entrypoint.length > 200) return null
  return { id: sessionId, project: projectOf(cwd), busy: status === 'busy', since: statusUpdatedAt, app: appOf(entrypoint) }
}

/**
 * Take one snapshot of the registry directory: `{ rows }` (a Map from session
 * id to `{ id, project, busy, since, app }`) or `{ error }` with a code.
 */
export function loadRegistry(dir, { maxFiles = DEFAULT_MAX_FILES, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOTDIR') return { error: 'shape_changed' }
    return { error: err?.code === 'ENOENT' ? 'source_missing' : 'unreachable' }
  }
  const candidates = entries.filter((e) => ROW_FILE_RE.test(e.name))
  if (candidates.length > maxFiles) return { error: 'too_large' }
  const rows = new Map()
  for (const e of candidates.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile()) return { error: 'shape_changed' }
    let text
    try {
      const file = path.join(dir, e.name)
      if (fs.statSync(file).size > maxFileBytes) return { error: 'too_large' }
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      // The process ended between the listing and the read: the row is gone.
      if (err?.code === 'ENOENT') continue
      return { error: 'unreachable' }
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      return { error: 'parse_failed' }
    }
    const row = parseRow(doc)
    if (row === null || rows.has(row.id)) return { error: 'shape_changed' }
    rows.set(row.id, row)
  }
  return { rows }
}

/**
 * @param {object} opts
 * @param {string} opts.dir           the registry directory
 * @param {string} [opts.source]      source name (default `claude-session-registry`)
 * @param {number} [opts.maxFiles]    refuse a registry with more rows than this
 * @param {number} [opts.maxFileBytes] refuse a larger row file
 */
export function createSessionRegistryAdapter({ dir, source = REGISTRY_SOURCE, maxFiles, maxFileBytes }) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createSessionRegistryAdapter: dir is required')
  if (!validSourceName(source)) throw new TypeError('createSessionRegistryAdapter: source must be a short lowercase name')
  const limits = { maxFiles, maxFileBytes }
  let snapshot = null
  return {
    source,
    list() {
      snapshot = loadRegistry(dir, limits)
      if (snapshot.error) return null
      return [...snapshot.rows.values()].map((r) => ({ session: { source, native_id: r.id, incarnation: null }, scope: r.project }))
    },
    read(session, now) {
      if (!snapshot) snapshot = loadRegistry(dir, limits)
      if (snapshot.error) return { outcome: 'error', error_code: snapshot.error }
      const row = snapshot.rows.get(session.native_id)
      if (!row) return { listed: false }
      if (Number.isFinite(now) && row.since - now > MAX_FUTURE_MS) return { outcome: 'error', error_code: 'clock_skew' }
      const basis = row.busy ? REGISTRY_BASES.busy : REGISTRY_BASES.idle
      return { outcome: 'no_report', native: { turn_in_flight: row.busy, events: [{ basis, ref: row.app, activity_at: row.since }] } }
    },
  }
}
