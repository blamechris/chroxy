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
import { constants as fsConstants, openSync, fstatSync, readSync, closeSync, lstatSync, readlinkSync, existsSync } from 'fs'
import { relative, join, sep, isAbsolute, parse } from 'path'
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
 * Every directory that must be a real directory (not a link) for `absPath` to be
 * the file it appears to be: the filesystem root, each ancestor of `root`, `root`
 * itself, and each directory between `root` and the file. The chain starts at the
 * top, not at `root`: a swap of the root or of one of its ancestors changes what
 * every name beneath it denotes.
 */
function directoryChain(root, comps) {
  const dirs = []
  const { root: top } = parse(root)
  let cur = top
  dirs.push(cur)
  for (const part of root.slice(top.length).split(sep).filter(Boolean)) {
    cur = join(cur, part)
    dirs.push(cur)
  }
  for (const comp of comps.slice(0, -1)) {
    cur = join(cur, comp)
    dirs.push(cur)
  }
  return dirs
}

/**
 * Where the kernel exposes the path an open descriptor was resolved to
 * (`/proc/self/fd/<fd>`, Linux), that is an EXACT answer to "is this descriptor
 * the file at the expected real path": it needs no second resolution of the name.
 * Elsewhere (macOS, Windows) there is no such primitive in plain Node.
 */
const PROC_FD_AVAILABLE = process.platform === 'linux' && existsSync('/proc/self/fd')

/**
 * Does the descriptor's resolved path equal `target`? Always true where the
 * platform offers no way to ask; fails closed if it offers one and it errors.
 * `deps.procFd` is a test seam: `{ available, readlink(fd) }`.
 */
function procPathMatches(fd, target, deps) {
  const seam = deps.procFd
  const available = seam ? seam.available : PROC_FD_AVAILABLE
  if (!available) return true
  try {
    return (seam ? seam.readlink(fd) : readlinkSync(`/proc/self/fd/${fd}`)) === target
  } catch {
    return false
  }
}

/**
 * The pinning checks, shared by every contained reader. They run on the opened
 * descriptor's `st` (from fstat):
 *   1. every directory from the filesystem root through `root` to the file's
 *      parent is a real directory, and the file's own lstat is a regular file with
 *      the descriptor's device and inode;
 *   2. the same, a SECOND time (so a link swapped in and out of a directory
 *      between two looks has to be timed across both passes);
 *   3. where the platform can say which path the descriptor was resolved to
 *      (Linux /proc), that path equals `target`.
 * On Linux this is exact. On macOS and Windows it is NOT: a directory swapped
 * between a link and a real directory fast enough to be a link when the file is
 * opened and real at each of the checks is narrowed (the two passes and the
 * identity compare must all be beaten) but not ruled out. It also needs local
 * write access to the store's own directories.
 * `deps.betweenChecks` is a test seam that runs between the two passes.
 */
async function verifyPinned(fh, target, rootReal, comps, st, deps) {
  const pass = async () => {
    for (const dir of directoryChain(rootReal, comps)) {
      if (!(await lstat(dir)).isDirectory()) return false
    }
    const fin = await lstat(target, { bigint: true })
    return fin.isFile() && fin.dev === st.dev && fin.ino === st.ino
  }
  if (!(await pass())) return false
  await deps.betweenChecks?.()
  if (!(await pass())) return false
  return procPathMatches(fh.fd, target, deps)
}

function verifyPinnedSync(fd, target, rootReal, comps, st, deps) {
  const pass = () => {
    for (const dir of directoryChain(rootReal, comps)) {
      if (!lstatSync(dir).isDirectory()) return false
    }
    const fin = lstatSync(target, { bigint: true })
    return fin.isFile() && fin.dev === st.dev && fin.ino === st.ino
  }
  if (!pass()) return false
  deps.betweenChecks?.()
  if (!pass()) return false
  return procPathMatches(fd, target, deps)
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
 * Read a file for a walk or lookup that must stay inside `root`, and consume the
 * very object that was checked.
 *
 * `root` MUST ALREADY BE A REAL PATH (the caller resolved it, e.g. with
 * `realpath`/`realpathSync.native`): a root that is a link, or that sits under a
 * link, is REFUSED (the call returns null), not followed. `absPath` must lie
 * lexically beneath it. The file is opened ONCE (no-follow on the final component,
 * non-blocking) and the descriptor must be a regular file within the cap. Containment is then
 * established from identities rather than by resolving the name again: see
 * `verifyPinned` for the checks (directory chain from the filesystem root, the
 * file's device and inode, repeated twice, plus the descriptor's own resolved path
 * where the platform reports it). What is read is always the descriptor.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE. A root or ancestor that is already a
 * link is refused. A parent swapped to a link and left there, or swapped for the
 * open and restored before the checks, is refused. On Linux, where /proc/self/fd
 * is mounted, the descriptor's resolved path is compared and the answer is exact;
 * where /proc is absent it falls back to the two passes. On macOS and Windows a
 * directory toggled between link and real fast enough to be a link at the open and
 * real at every check is narrowed, not ruled out (measured: see the PR notes and
 * the platform-limits paragraph of docs/security/bearer-token-authority.md);
 * exploiting it needs local write access inside the store. A hard link inside the root to a file elsewhere is the same
 * object and is not distinguishable by identity.
 *
 * `deps` is a test seam: `beforeOpen` / `afterOpen` / `betweenChecks` run at those
 * points so a test can schedule a filesystem change there; `procFd` stands in for
 * /proc.
 *
 * @param {string} absPath lexically beneath `root`
 * @param {string} root the containing root (any spelling; resolved here)
 * @param {number} maxBytes
 * @param {{ head?: boolean, deps?: object }} [opts]
 *   `head`: a larger file is read up to `maxBytes` instead of refused
 * @returns {Promise<Buffer|null>} null when the file is not an in-root regular
 *   file within the cap, or could not be checked
 */
export async function readContainedBytes(absPath, root, maxBytes, { head = false, deps = {} } = {}) {
  const comps = componentsBelow(root, absPath)
  if (!comps) return null
  let fh
  try {
    // The chain below runs over `root` AS GIVEN: a root that is itself a link, or
    // sits under a link, fails the directory check (the root must be a real path).
    const target = join(root, ...comps)
    await deps.beforeOpen?.()
    fh = await openNoFollow(target, READ_FLAGS)
    await deps.afterOpen?.()
    const st = await fh.stat({ bigint: true })
    if (!st.isFile()) return null
    if (!head && st.size > BigInt(maxBytes)) return null
    if (!(await verifyPinned(fh, target, root, comps, st, deps))) return null
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
 * Same requirement that `root` already be a real path, identity checks, `deps`
 * seam and guarantees (including the macOS/Windows limit); a FIFO or device is refused, not waited on.
 */
export function readContainedBytesSync(absPath, root, maxBytes, { head = false, report = {}, deps = {} } = {}) {
  const comps = componentsBelow(root, absPath)
  if (!comps) { report.reason = 'outside'; return null }
  let fd
  try {
    const target = join(root, ...comps)
    deps.beforeOpen?.()
    fd = openSync(target, READ_FLAGS | (fsConstants.O_NOFOLLOW || 0))
    deps.afterOpen?.()
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile()) { report.reason = 'not-regular'; return null }
    if (!head && st.size > BigInt(maxBytes)) { report.reason = 'too-large'; report.size = Number(st.size); return null }
    if (!verifyPinnedSync(fd, target, root, comps, st, deps)) { report.reason = 'changed'; return null }
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
 * regular file `absPath` names inside `root` (the same `verifyPinned` checks as
 * {@link readContainedBytes}, with the same limits on macOS and Windows) and read
 * it, never more than `maxBytes`. `absPath` must be the real path the handle was
 * opened by; `root` must already be a real path (a linked root is refused).
 * Throws an Error with `code` 'ENOTREG', 'EFBIG' or 'EACCES' (outside/changed).
 * @param {import('fs/promises').FileHandle} fh
 * @param {string} absPath
 * @param {string} root
 * @param {number} maxBytes
 * @param {object} [deps] test seam (see readContainedBytes)
 * @returns {Promise<Buffer>}
 */
export async function readPinnedHandle(fh, absPath, root, maxBytes, deps = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code })
  const st = await fh.stat({ bigint: true })
  if (!st.isFile()) throw fail('ENOTREG', 'Not a regular file')
  if (st.size > BigInt(maxBytes)) throw fail('EFBIG', 'File too large')
  const comps = componentsBelow(root, absPath)
  if (!comps) throw fail('EACCES', 'outside')
  const target = join(root, ...comps)
  if (!(await verifyPinned(fh, target, root, comps, st, deps))) throw fail('EACCES', 'changed')
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
