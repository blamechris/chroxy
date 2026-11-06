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
import { constants as fsConstants, openSync, fstatSync, readSync, closeSync } from 'fs'
import { open, realpath } from 'fs/promises'
import { openNoFollow } from '../ws-file-ops/open-nofollow.js'
import { isPathWithin } from './path-containment.js'

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
 * Read a text file for a walk that must stay inside `root` (a real path), and
 * consume the very object that was checked.
 *
 * A walk lists names and reads them later, and a name can be re-pointed in
 * between — a file replaced by a link, or a parent directory swapped for one
 * that leads elsewhere. So the file is opened ONCE (no-follow on the final
 * component, non-blocking), the opened descriptor is required to be a regular
 * file within `maxBytes`, and its identity (device + inode) is compared with
 * the real path the name resolves to NOW, which must itself lie inside `root`.
 * What is read is the descriptor, so nothing swapped in afterwards is read.
 *
 * @param {string} absPath
 * @param {string} root real path of the workspace root
 * @param {number} maxBytes
 * @returns {Promise<string|null>} the text, or null when the file is not an
 *   in-workspace regular file within the cap (or could not be checked)
 */
export async function readContainedTextFile(absPath, root, maxBytes) {
  let fh
  try {
    fh = await openNoFollow(absPath, READ_FLAGS)
    const st = await fh.stat({ bigint: true })
    if (!st.isFile() || st.size > BigInt(maxBytes)) return null
    const real = await realpath(absPath)
    if (!isPathWithin(real, root)) return null
    const now = await open(real, READ_FLAGS)
    let same
    try {
      const rs = await now.stat({ bigint: true })
      same = rs.dev === st.dev && rs.ino === st.ino
    } finally {
      await now.close().catch(() => {})
    }
    if (!same) return null
    const buf = Buffer.alloc(Number(st.size))
    let off = 0
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off)
      if (bytesRead === 0) break
      off += bytesRead
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, off))
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}
