/**
 * Open a path for reading only if it turns out to be a regular file.
 *
 * A directory listing and a later open are two steps, and the name can be
 * replaced in between — with a FIFO, say, whose blocking open would hold a
 * libuv threadpool thread until a writer appears. So the open here never
 * blocks (O_NONBLOCK), and the check is made on the DESCRIPTOR that was opened
 * (fstat), not on a separate stat of the path that may no longer name the same
 * object. A symlink to a regular file is followed, as a plain open does.
 */
import { constants as fsConstants, openSync, fstatSync, readSync, closeSync, lstatSync } from 'fs'
import { relative, join, sep, isAbsolute } from 'path'
import { open, lstat } from 'fs/promises'
import { openNoFollow } from '../ws-file-ops/open-nofollow.js'

const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0)

/**
 * @param {string} filePath
 * @returns {Promise<{ handle: import('fs/promises').FileHandle, size: number }>}
 *   the caller closes `handle`
 * @throws {Error} with code 'ENOTREG' when the opened object is not a regular file
 */
export async function openRegularFile(filePath) {
  const handle = await open(filePath, READ_FLAGS)
  try {
    const st = await handle.stat()
    if (!st.isFile()) {
      const err = new Error('Not a regular file')
      err.code = 'ENOTREG'
      throw err
    }
    return { handle, size: st.size }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

/**
 * Read at most `maxBytes` from the start of a regular file as UTF-8.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<{ text: string, size: number }>}
 */
export async function readRegularFileHead(filePath, maxBytes) {
  const { handle, size } = await openRegularFile(filePath)
  try {
    const length = Math.min(size, maxBytes)
    const buf = Buffer.alloc(length)
    let off = 0
    while (off < length) {
      const { bytesRead } = await handle.read(buf, off, length - off, off)
      if (bytesRead === 0) break
      off += bytesRead
    }
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, off)), size }
  } finally {
    await handle.close()
  }
}

/**
 * Synchronous variant for a caller that cannot be async: open without blocking,
 * check the opened descriptor is a regular file no larger than `maxBytes`, and
 * read it whole from that descriptor. A FIFO or device is refused (ENOTREG), not
 * waited on; an oversize file is refused (EFBIG) with its size on the error.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Buffer}
 */
export function readRegularFileSync(filePath, maxBytes) {
  const fd = openSync(filePath, READ_FLAGS)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      const err = new Error('Not a regular file')
      err.code = 'ENOTREG'
      throw err
    }
    if (st.size > maxBytes) {
      const err = new Error('File too large')
      err.code = 'EFBIG'
      err.size = st.size
      throw err
    }
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off)
  } finally {
    closeSync(fd)
  }
}

/**
 * The directory components between `root` and `absPath`, or null when `absPath`
 * is not lexically beneath `root`.
 */
function componentsBelow(root, absPath) {
  const rel = relative(root, absPath)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  return rel.split(sep)
}

/**
 * Read at most `size` bytes from an open handle in bounded steps, never more
 * than `maxBytes`.
 */
async function readHandleBounded(fh, size, maxBytes) {
  const length = Math.min(size, maxBytes)
  const buf = Buffer.alloc(length)
  let off = 0
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, Math.min(length - off, 1024 * 1024), off)
    if (bytesRead === 0) break
    off += bytesRead
  }
  return buf.subarray(0, off)
}

/**
 * Read a file for a walk or lookup that must stay inside `root` (a real path),
 * and consume the very object that was checked.
 *
 * Containment is established from identities, not by resolving the name twice:
 *   1. the file is opened ONCE (no-follow on the final component, non-blocking)
 *      and the descriptor must be a regular file within the cap;
 *   2. AFTER that, every directory between `root` and the file is `lstat`ed and
 *      must be a real directory (not a link), and the file's own `lstat` must be
 *      a regular file with the descriptor's device and inode.
 * A parent swapped to a link before the open yields a descriptor for some other
 * file; that file cannot also be what the name shows once the parent is a real
 * directory again, so the identity comparison fails. What is read is always the
 * descriptor, so nothing swapped in afterwards is read.
 *
 * `deps` is a test seam: `beforeOpen` / `afterOpen` run at those two points so a
 * test can schedule a filesystem change there.
 *
 * @param {string} absPath lexically beneath `root`
 * @param {string} root real path of the containing root
 * @param {number} maxBytes
 * @param {{ head?: boolean, deps?: { beforeOpen?: Function, afterOpen?: Function } }} [opts]
 *   `head`: a larger file is read up to `maxBytes` instead of refused
 * @returns {Promise<Buffer|null>} null when the file is not an in-root regular
 *   file within the cap, or could not be checked
 */
export async function readContainedBytes(absPath, root, maxBytes, { head = false, deps = {} } = {}) {
  const comps = componentsBelow(root, absPath)
  if (!comps) return null
  let fh
  try {
    await deps.beforeOpen?.()
    fh = await openNoFollow(absPath, READ_FLAGS)
    await deps.afterOpen?.()
    const st = await fh.stat({ bigint: true })
    if (!st.isFile()) return null
    if (!head && st.size > BigInt(maxBytes)) return null
    let cur = root
    for (const comp of comps.slice(0, -1)) {
      cur = join(cur, comp)
      const l = await lstat(cur)
      if (!l.isDirectory()) return null
    }
    const fin = await lstat(absPath, { bigint: true })
    if (!fin.isFile() || fin.dev !== st.dev || fin.ino !== st.ino) return null
    return await readHandleBounded(fh, Number(st.size), maxBytes)
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/** UTF-8 text form of {@link readContainedBytes}. */
export async function readContainedTextFile(absPath, root, maxBytes, opts) {
  const buf = await readContainedBytes(absPath, root, maxBytes, opts)
  return buf === null ? null : new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

/**
 * Synchronous {@link readContainedBytes}, for a caller that cannot be async.
 * Same identity-based containment; a FIFO or device is refused, not waited on.
 */
export function readContainedBytesSync(absPath, root, maxBytes, { head = false, report = {} } = {}) {
  const comps = componentsBelow(root, absPath)
  if (!comps) { report.reason = 'outside'; return null }
  let fd
  try {
    fd = openSync(absPath, READ_FLAGS | (fsConstants.O_NOFOLLOW || 0))
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile()) { report.reason = 'not-regular'; return null }
    if (!head && st.size > BigInt(maxBytes)) { report.reason = 'too-large'; report.size = Number(st.size); return null }
    let cur = root
    for (const comp of comps.slice(0, -1)) {
      cur = join(cur, comp)
      if (!lstatSync(cur).isDirectory()) { report.reason = 'outside'; return null }
    }
    const fin = lstatSync(absPath, { bigint: true })
    if (!fin.isFile() || fin.dev !== st.dev || fin.ino !== st.ino) { report.reason = 'changed'; return null }
    const length = Math.min(Number(st.size), maxBytes)
    const buf = Buffer.alloc(length)
    let off = 0
    while (off < length) {
      const n = readSync(fd, buf, off, length - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off)
  } catch (err) {
    report.reason = err?.code === 'ENOENT' ? 'missing' : err?.code === 'EACCES' ? 'denied' : 'error'
    return null
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

/**
 * For a caller that opened the handle itself: confirm the opened object is the
 * regular file `absPath` names inside `root` (same lstat chain and identity
 * check as {@link readContainedBytes}) and read it, never more than `maxBytes`.
 * Throws an Error with `code` 'ENOTREG', 'EFBIG' or 'EACCES' (outside/changed).
 * @param {import('fs/promises').FileHandle} fh
 * @param {string} absPath
 * @param {string} root real path
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readPinnedHandle(fh, absPath, root, maxBytes) {
  const fail = (code, message) => Object.assign(new Error(message), { code })
  const st = await fh.stat({ bigint: true })
  if (!st.isFile()) throw fail('ENOTREG', 'Not a regular file')
  if (st.size > BigInt(maxBytes)) throw fail('EFBIG', 'File too large')
  const comps = componentsBelow(root, absPath)
  if (!comps) throw fail('EACCES', 'outside')
  let cur = root
  for (const comp of comps.slice(0, -1)) {
    cur = join(cur, comp)
    if (!(await lstat(cur)).isDirectory()) throw fail('EACCES', 'outside')
  }
  const fin = await lstat(absPath, { bigint: true })
  if (!fin.isFile() || fin.dev !== st.dev || fin.ino !== st.ino) throw fail('EACCES', 'changed')
  return readHandleBounded(fh, Number(st.size), maxBytes)
}

/**
 * Read an already-opened regular file in bounded steps, never more than
 * `maxBytes`; throws ENOTREG / EFBIG like {@link readPinnedHandle} but without
 * the parent-directory check (for a caller with no containing root).
 */
export async function readFdBounded(fh, maxBytes) {
  const st = await fh.stat({ bigint: true })
  if (!st.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'ENOTREG' })
  if (st.size > BigInt(maxBytes)) throw Object.assign(new Error('File too large'), { code: 'EFBIG' })
  return readHandleBounded(fh, Number(st.size), maxBytes)
}
