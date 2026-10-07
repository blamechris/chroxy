/**
 * Bounded reads and atomic writes for the small JSON files the idle-only
 * auto-deploy exchanges through the config directory (#8331): `pending-update.json`,
 * `deploy-postpone.json`, `deploy-request.json`, `last-deploy.json` and the
 * script's own state. One implementation, imported by BOTH the daemon
 * (`daemon-update-status.js`) and `scripts/deploy-daemon.mjs`, so the two sides
 * cannot disagree about what a hostile file looks like.
 *
 * The config directory is writable by other local processes, so every one of these
 * files is untrusted input:
 *
 *  - READS open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat` the descriptor
 *    and require a REGULAR FILE, and read at most `cap + 1` bytes from that
 *    descriptor. A FIFO therefore cannot block the open, a symlink is refused, a
 *    directory or device is refused, and an oversized file is never loaded.
 *    Anything refused reads as ABSENT to the caller (`state: 'bad'`), never as a
 *    partial object. Where the platform has no `O_NOFOLLOW` (win32) a `lstat`
 *    before the open refuses a symlink.
 *  - WRITES go to a RANDOM temp name opened with `O_EXCL` (so a planted file or
 *    symlink at that name cannot be followed or truncated), are written through
 *    that descriptor, and are renamed into place; the temp file is removed on
 *    failure.
 *
 * Every filesystem call goes through the injected `fs` so the deploy script's
 * tests can drive it.
 */

import * as realFs from 'node:fs'
import { randomBytes } from 'node:crypto'

/** Every file here is a few hundred bytes. A bigger one is not ours. */
export const SMALL_FILE_CAP = 4096

const C = realFs.constants

/**
 * @param {string} file
 * @param {{ fs?: object, cap?: number }} [o]
 * @returns {{ state: 'none' } | { state: 'bad', reason: string } | { state: 'ok', raw: string }}
 */
export function readBoundedFile(file, { fs = realFs, cap = SMALL_FILE_CAP } = {}) {
  const noFollow = C.O_NOFOLLOW ?? 0
  if (noFollow === 0) {
    // No O_NOFOLLOW on this platform: refuse a symlink with an lstat first.
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return { state: 'bad', reason: 'is a symlink' }
    } catch (e) {
      return e.code === 'ENOENT' ? { state: 'none' } : { state: 'bad', reason: e.code || String(e.message || e) }
    }
  }
  let fd
  try {
    fd = fs.openSync(file, C.O_RDONLY | noFollow | (C.O_NONBLOCK ?? 0))
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'none' }
    return { state: 'bad', reason: e.code === 'ELOOP' ? 'is a symlink' : (e.code || String(e.message || e)) }
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { state: 'bad', reason: 'is not a regular file' }
    const buf = Buffer.alloc(cap + 1)
    const n = fs.readSync(fd, buf, 0, cap + 1, 0)
    if (n > cap) return { state: 'bad', reason: `is larger than ${cap} bytes` }
    return { state: 'ok', raw: buf.toString('utf8', 0, n) }
  } catch (e) {
    return { state: 'bad', reason: e.code || String(e.message || e) }
  } finally {
    try { fs.closeSync(fd) } catch { /* nothing to close */ }
  }
}

/**
 * `readBoundedFile` + parse. A value that is not a plain JSON object is `bad`.
 * @returns {{ state: 'none' } | { state: 'bad', reason: string } | { state: 'ok', raw: string, value: object }}
 */
export function readBoundedJson(file, o) {
  const r = readBoundedFile(file, o)
  if (r.state !== 'ok') return r
  try {
    const value = JSON.parse(r.raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return { state: 'ok', raw: r.raw, value }
  } catch { /* fall through */ }
  return { state: 'bad', reason: 'is not a JSON object' }
}

/**
 * Write `text` to `file` atomically: random temp name, `O_EXCL`, through the
 * descriptor, rename, and the temp file removed on any failure.
 * @param {string} file
 * @param {string} text
 * @param {{ fs?: object, mode?: number }} [o]
 */
export function writeFileAtomic(file, text, { fs = realFs, mode = 0o600 } = {}) {
  const tmp = `${file}.tmp-${randomBytes(8).toString('hex')}`
  let fd
  try {
    fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), mode)
    const data = Buffer.from(text, 'utf8')
    for (let off = 0; off < data.length;) off += fs.writeSync(fd, data, off, data.length - off)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp) } catch { /* never created, or already gone */ }
    throw err
  }
}
