/**
 * The outbox: what the reconciler has to say, as a file any consumer may read
 * and deliver. The reconciler writes it and sends nothing.
 *
 * Schema, version 1. `outbox.jsonl` is UTF-8, one JSON object per line, ended
 * by "\n", append-only: a line is never changed or removed by the reconciler.
 * A consumer reads it from the start or from where it stopped, ignores a last
 * line with no newline (a write in flight) and any line it cannot parse, and
 * may rotate or truncate the file between ticks. It may be read from another
 * machine: a line holds only the fields below, never a path, a secret or the
 * body of a session.
 *
 *   v        1
 *   at       ISO time the line was written
 *   rec      this line's id (32 hex); a receipt or an acknowledgement names it
 *   key      the message this line is about (32 hex); every line of one item
 *            has the same key, so a consumer edits one message in place
 *   op       "post"     the first delivery of the key
 *            "repost"   a further delivery of the same key (a reminder, a
 *                       return, a show after a deferral): send it again
 *            "updated"  the key's content changed: edit the message in place
 *   class    "item" | "digest" | "echo" | "alert"
 *   status   "open" | "closed" | "info"
 *   step     "shown" | "reminded" | "returned" for an item delivery, else null
 *   n        the item's presentation number, else null
 *   origin   "owner" | "attention" | "gone" | "outage" | "seed", else null
 *   source   the adapter's source name, else null
 *   text     what to show, made by a template (render.js)
 *
 * Writes are one `write` and an `fsync` per line, so a crash leaves at most one
 * cut-off tail, which the next write starts after with a newline. `rec` is
 * deterministic, so a line the reconciler writes again after a crash is found in
 * the file's tail and not written twice.
 */

import fs from 'node:fs'
import path from 'node:path'

export const OUTBOX_VERSION = 1
export const OUTBOX_FIELDS = Object.freeze(['v', 'at', 'rec', 'key', 'op', 'class', 'status', 'step', 'n', 'origin', 'source', 'text'])
export const OUTBOX_OPS = Object.freeze(['post', 'repost', 'updated'])
export const OUTBOX_CLASSES = Object.freeze(['item', 'digest', 'echo', 'alert'])
export const MAX_TEXT = 2000
const TAIL_BYTES = 256 * 1024

/** One outbox line from named values; any field not in the schema is dropped. */
export function outboxRecord({ at, rec, key, op, cls, status, step = null, n = null, origin = null, source = null, text }) {
  return {
    v: OUTBOX_VERSION,
    at: new Date(at).toISOString(),
    rec,
    key,
    op,
    class: cls,
    status,
    step,
    n,
    origin,
    source,
    text: String(text).length > MAX_TEXT ? String(text).slice(0, MAX_TEXT - 1) + '…' : String(text),
  }
}

/** The ids of the lines in the last part of the file, and whether it ends mid-line. */
function readTail(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')
    const open = len > 0 && text[text.length - 1] !== '\n'
    const recs = new Set()
    for (const line of text.split('\n')) {
      try {
        const v = JSON.parse(line)
        if (v && typeof v.rec === 'string') recs.add(v.rec)
      } catch {
        // a cut-off or foreign line is not a record
      }
    }
    return { recs, open }
  } catch (err) {
    if (err?.code === 'ENOENT') return { recs: new Set(), open: false }
    throw err
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** An append-only outbox file. `append` returns 'written' or 'duplicate' and throws if it cannot write. */
export function openOutbox(file) {
  let tail = null
  let known = null
  return {
    file,
    append(record) {
      for (const k of Object.keys(record)) if (!OUTBOX_FIELDS.includes(k)) throw new Error(`outbox: field ${k} is not in the schema`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        if (!fs.lstatSync(file).isFile()) throw new Error('outbox: the file is not a regular file')
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err
      }
      // A consumer that rotated or truncated the file: what was read of it is stale.
      let seen = null
      try {
        seen = fs.statSync(file)
      } catch {
        seen = null
      }
      if (tail && (!seen || !known || seen.ino !== known.ino || seen.size < known.size)) tail = null
      tail ??= readTail(file)
      if (tail.recs.has(record.rec)) return 'duplicate'
      const fd = fs.openSync(file, 'a', 0o644)
      try {
        fs.writeSync(fd, (tail.open ? '\n' : '') + JSON.stringify(record) + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      tail.open = false
      tail.recs.add(record.rec)
      const after = fs.statSync(file)
      known = { ino: after.ino, size: after.size }
      return 'written'
    },
  }
}
