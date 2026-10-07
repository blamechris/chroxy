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
 *  - READS go through `_openTrustedFdSync` (the same open the credential reader uses):
 *    `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` on POSIX, so a FIFO cannot block the open and
 *    a symlink is refused atomically; on win32 (no `O_NOFOLLOW`) a pre-open `lstat`
 *    plus a post-open fd/path identity check (fresh `lstat`, BigInt dev/ino), refusing
 *    when identity cannot be established. The descriptor is then required to be a
 *    REGULAR FILE, and the read ACCUMULATES from that one descriptor until EOF or
 *    cap + 1 bytes (a short read is legal, so one `read` is never taken for the whole
 *    file).
 *  - The result says WHY a file was not usable, because callers act differently:
 *      `none`   no such file
 *      `bad`    the CONTENT or kind is refused (a symlink, a FIFO, a directory, an
 *               oversized file, not a JSON object): reads as absent
 *      `error`  an I/O error (EAGAIN, EIO, EACCES, …) or a read that did not complete:
 *               the file may be perfectly valid and MUST NOT be treated as corrupt
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
import { _openTrustedFdSync, defaultTrustedFileReadDeps } from '../trusted-file-read.js'

/** Every file here is a few hundred bytes. A bigger one is not ours. */
export const SMALL_FILE_CAP = 4096

const C = realFs.constants
const HAS_O_NOFOLLOW = typeof C.O_NOFOLLOW === 'number' && C.O_NOFOLLOW !== 0

/**
 * @param {string} file
 * @param {{ fs?: object, cap?: number, platform?: string, hasONoFollow?: boolean }} [o]
 *   `platform` / `hasONoFollow` are test seams to drive the win32 path anywhere.
 * @returns {{ state: 'none' } | { state: 'bad', reason: string } | { state: 'error', reason: string } | { state: 'ok', raw: string }}
 */
export function readBoundedFile(file, { fs = realFs, cap = SMALL_FILE_CAP, platform = process.platform, hasONoFollow = HAS_O_NOFOLLOW } = {}) {
  // The credential reader's own deps (its O_NOFOLLOW constant included), with only the
  // filesystem calls and the platform seams swapped for ours.
  const deps = {
    ...defaultTrustedFileReadDeps,
    hasONoFollow,
    platform,
    openSync: (p, flags) => fs.openSync(p, flags),
    closeSync: (fd) => fs.closeSync(fd),
    fstatSync: (fd) => fs.fstatSync(fd, { bigint: true }),
    lstatSync: (p) => fs.lstatSync(p, { bigint: true }),
  }
  let opened
  try {
    opened = _openTrustedFdSync(file, deps)
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'none' }
    // ELOOP is a symlink, or an identity check that could not prove the open.
    if (e.code === 'ELOOP') return { state: 'bad', reason: 'is a symlink or could not be proven to be the file at its path' }
    return { state: 'error', reason: e.code || String(e.message || e) }
  }
  const { fd, stat } = opened
  try {
    if (!stat.isFile()) return { state: 'bad', reason: 'is not a regular file' }
    const limit = cap + 1
    const buf = Buffer.alloc(limit)
    let total = 0
    while (total < limit) {
      const n = fs.readSync(fd, buf, total, limit - total, total)
      if (n === 0) break
      total += n
    }
    if (total > cap) return { state: 'bad', reason: `is larger than ${cap} bytes` }
    return { state: 'ok', raw: buf.toString('utf8', 0, total) }
  } catch (e) {
    return { state: 'error', reason: e.code || String(e.message || e) }
  } finally {
    try { fs.closeSync(fd) } catch { /* nothing to close */ }
  }
}

/**
 * `readBoundedFile` + parse. A value that is not a plain JSON object is `bad`; an I/O
 * error stays an `error` and is never reported as unparseable content.
 * @returns {{ state: 'none' } | { state: 'bad' | 'error', reason: string } | { state: 'ok', raw: string, value: object }}
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
    fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0), mode)
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
