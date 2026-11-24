/**
 * Reading the two files a consumer writes: delivery receipts and operator
 * acknowledgements. Both are untrusted input. They are read bounded, line by
 * line, and every line is shape-checked; a line that fails is described by a
 * fixed reason, never by its content, and is ignored.
 *
 * Format of both files: UTF-8 text, one JSON object per line, appended by the
 * consumer. A last line with no newline is a write in flight and is not read
 * until its newline arrives. A line is read once ever: its identity is the hash
 * of its text, recorded in the ledger, so a truncation replays no line. A
 * consumer should rotate its files: a file past the size bound is read only that
 * far, and the lines after it are never seen.
 *
 * Pure of the clock; the only I/O is a read-only read of the named file.
 */

import fs from 'node:fs'
import { sha256 } from './hash.js'
import { HEX_ID } from './render.js'

export const RECEIPT_OUTCOMES = Object.freeze(['delivered', 'failed'])
export const ACK_INTENTS = Object.freeze(['done', 'dismiss', 'defer'])

const RECEIPT_FIELDS = ['v', 'key', 'rec', 'outcome']
const ACK_FIELDS = ['v', 'key', 'rec', 'intent', 'until', 'at']
const MAX_OUTCOME = 40

/** The identity of a line: the hash of its text. */
export function lineId(text) {
  return sha256(text).slice(0, 32)
}

/**
 * Read the lines of one input file, bounded.
 *
 * Returns `{ lines, problem }`. `lines` are `{ id, text | null, tooLong }` in
 * file order; `problem` is null, `unsafe` (not a regular file), `unreadable`,
 * or `oversize` (more than `maxFileBytes`: only the first `maxFileBytes` are
 * read and lines are those wholly inside them). A missing file is no lines.
 */
export function readInput(file, { maxFileBytes, maxLineBytes }, { beforeOpen } = {}) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    return { lines: [], problem: err?.code === 'ENOENT' ? null : 'unreadable' }
  }
  if (!st.isFile()) return { lines: [], problem: 'unsafe' }
  let buf
  let fd = null
  let oversize = false
  try {
    beforeOpen?.(file)
    // Where the platform has them: refuse a link swapped in after the check, and
    // never block on a FIFO swapped in there. (The shared open-nofollow helper is
    // asynchronous and lives outside this directory, which may import nothing
    // from the daemon, so the same two flags are used here.)
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
    const open = fs.fstatSync(fd)
    if (!open.isFile()) return { lines: [], problem: 'unsafe' }
    oversize = open.size > maxFileBytes
    const want = Math.min(open.size, maxFileBytes)
    buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, got)
      if (n <= 0) break
      got += n
    }
    buf = buf.subarray(0, got)
  } catch {
    return { lines: [], problem: 'unreadable' }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // nothing more to do for a read-only descriptor
      }
    }
  }
  // Only lines whose newline has arrived: a cut-off tail is not a line yet.
  const complete = buf.subarray(0, buf.lastIndexOf(0x0a) + 1)
  const lines = []
  let start = 0
  while (start < complete.length) {
    let stop = complete.indexOf(0x0a, start)
    if (stop < 0) stop = complete.length
    let raw = complete.subarray(start, stop)
    start = stop + 1
    if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1)
    if (raw.length === 0) continue
    if (raw.length > maxLineBytes) {
      lines.push({ id: lineId(raw.subarray(0, maxLineBytes + 1).toString('latin1')), text: null, tooLong: true })
      continue
    }
    const text = raw.toString('utf8')
    lines.push({ id: lineId(text), text, tooLong: false })
  }
  return { lines, problem: oversize ? 'oversize' : null }
}

function plainObject(text) {
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return { reason: 'not_json' }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { reason: 'shape' }
  return { value: v }
}

function validIds(v) {
  return typeof v.key === 'string' && HEX_ID.test(v.key) && typeof v.rec === 'string' && HEX_ID.test(v.rec)
}

function onlyFields(v, allowed) {
  return Object.keys(v).every((k) => allowed.includes(k))
}

/** A receipt line: `{ v: 1, key, rec, outcome }`. */
export function parseReceipt(text) {
  const p = plainObject(text)
  if (!p.value) return { reason: p.reason }
  const v = p.value
  if (!onlyFields(v, RECEIPT_FIELDS) || v.v !== 1) return { reason: 'shape' }
  if (!validIds(v)) return { reason: 'shape' }
  if (typeof v.outcome !== 'string' || v.outcome.length < 1 || v.outcome.length > MAX_OUTCOME) return { reason: 'shape' }
  // Anything other than a known outcome is unclear, and is never kept as text.
  return { key: v.key, rec: v.rec, outcome: RECEIPT_OUTCOMES.includes(v.outcome) ? v.outcome : 'unclear' }
}

/** An acknowledgement line: `{ v: 1, key, rec, intent, until?, at? }`. */
export function parseAck(text) {
  const p = plainObject(text)
  if (!p.value) return { reason: p.reason }
  const v = p.value
  if (!onlyFields(v, ACK_FIELDS) || v.v !== 1) return { reason: 'shape' }
  if (!validIds(v)) return { reason: 'shape' }
  if (!ACK_INTENTS.includes(v.intent)) return { reason: 'shape' }
  if (v.at !== undefined && !(Number.isSafeInteger(v.at) && v.at >= 0)) return { reason: 'shape' }
  if (v.intent === 'defer') {
    if (!Number.isSafeInteger(v.until) || v.until < 0) return { reason: 'shape' }
  } else if (v.until !== undefined) {
    return { reason: 'shape' }
  }
  return { key: v.key, rec: v.rec, intent: v.intent, until: v.intent === 'defer' ? v.until : null }
}
