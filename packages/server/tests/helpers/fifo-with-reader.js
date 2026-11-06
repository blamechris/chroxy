import assert from 'node:assert/strict'
import { openSync, closeSync, readSync, constants as fsConstants } from 'fs'

/**
 * #7957 — a FIFO target WITH a reader attached opens fine under O_NONBLOCK, so
 * only an fstat on the opened handle stops a write to it. Runs `run()` with a
 * non-blocking reader attached to `fifo` and returns whatever the reader could
 * pull out of the pipe afterwards (empty when nothing was written).
 *
 * @param {string} fifo
 * @param {() => Promise<unknown>} run
 * @returns {Promise<string>}
 */
export async function runAgainstFifoWithReader(fifo, run) {
  const readerFd = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  let timer
  try {
    const outcome = await Promise.race([
      run().then(() => 'returned'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('hung'), 3000)
        timer.unref()
      }),
    ])
    assert.equal(outcome, 'returned', 'handler did not return promptly')
    const buf = Buffer.alloc(4096)
    let n = 0
    try {
      n = readSync(readerFd, buf, 0, buf.length, null)
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err
    }
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    clearTimeout(timer)
    closeSync(readerFd)
  }
}
