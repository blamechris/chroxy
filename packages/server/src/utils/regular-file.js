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
import { constants as fsConstants } from 'fs'
import { open } from 'fs/promises'

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
