/**
 * flush-and-exit.mjs — wait for a writable stream's `finish` event before
 * exiting the process so buffered writes are not truncated.
 *
 * Background (#4729): tui-form-recorder.mjs originally called
 * `recording.end()` and then `process.exit()` in the same tick. `process.exit`
 * does not wait for the stream to flush, so under load — especially in the
 * Ctrl+D path where the child PTY is also killed with SIGTERM the same tick —
 * the final bytes of the captured JSONL were truncated, silently corrupting
 * the byte fixtures we pin in the multi-question form handler.
 *
 * Usage:
 *   import { flushAndExit } from './flush-and-exit.mjs'
 *   recording.write(lastLine)
 *   flushAndExit(recording, exitCode)   // returns immediately, exits async
 *
 * The exit happens whichever fires first:
 *   1. the stream's `finish` event (preferred, guarantees all bytes drained), or
 *   2. a fallback `fallbackMs` timeout so a misbehaving stream cannot hang
 *      the recorder forever.
 *
 * The fallback timer is `.unref()`-ed so it never keeps node alive on its own.
 */

/**
 * @param {import('node:stream').Writable} stream - the writable to flush
 * @param {number} exitCode - process exit code
 * @param {{ exitFn?: (code: number) => void, fallbackMs?: number }} [options]
 *   - exitFn: override for process.exit (test seam)
 *   - fallbackMs: max ms to wait for `finish` before forcing exit (default 1000)
 */
export const flushAndExit = (stream, exitCode, options = {}) => {
  const exitFn = options.exitFn || ((code) => process.exit(code))
  const fallbackMs = options.fallbackMs ?? 1000

  let exited = false
  const exitOnce = () => {
    if (exited) return
    exited = true
    exitFn(exitCode)
  }

  stream.once('finish', exitOnce)
  stream.once('error', exitOnce)
  stream.end()

  const timer = setTimeout(exitOnce, fallbackMs)
  // Don't let the fallback timer alone keep the event loop alive.
  if (typeof timer.unref === 'function') timer.unref()
}

/**
 * Wait for process.stdout AND process.stderr to drain, then exit (#9164).
 *
 * `process.exit()` drops whatever Node still has queued for a stream. When
 * stdout is a pipe whose reader lags, anything beyond the pipe buffer is still
 * queued inside Node, so a harness that prints its summary / floor line and
 * then calls `process.exit(code)` can lose exactly those last lines.
 *
 * Mechanism: writes on a stream complete in order, so the callback of a
 * zero-length write on each stream fires only after every earlier queued write
 * on that stream has been handed to the OS. We wait for both callbacks, then
 * exit. (Verified in scripts/__tests__/flush-and-exit.test.mjs: a bare
 * `process.exit` loses the sentinel under a lagging reader, this does not.)
 *
 * Bounded wait: if a stream never calls back (reader gone, broken stream), we
 * exit anyway after `fallbackMs` (default 10000 ms). The timer is unref'd, so
 * it never keeps the process alive, and a stream that errors also counts as
 * done. The bound means a reader that stalls for longer than `fallbackMs` can
 * still lose output; this reduces the loss window, it does not eliminate it.
 *
 * Usage (ES modules): `await drainStdioAndExit(code)`. The returned promise
 * never resolves, so nothing after the await runs.
 *
 * @param {number} code - process exit code
 * @param {{ exitFn?: (code: number) => void, fallbackMs?: number }} [options]
 *   - exitFn: override for process.exit (test seam)
 *   - fallbackMs: max ms to wait before exiting regardless (default 10000)
 * @returns {Promise<never>}
 */
export const drainStdioAndExit = (code, options = {}) => {
  const exitFn = options.exitFn || ((c) => process.exit(c))
  const fallbackMs = options.fallbackMs ?? 10000
  return new Promise(() => {
    let exited = false
    const exitOnce = () => {
      if (exited) return
      exited = true
      exitFn(code)
    }
    // If the loop ever empties before we exit (unref'd timer, no handles), node
    // would end with this code instead of silently turning a failure into 0.
    process.exitCode = code
    let pending = 2
    for (const stream of [process.stdout, process.stderr]) {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        if (--pending === 0) exitOnce()
      }
      try {
        stream.once('error', done)
        stream.write('', done)
      } catch {
        done()
      }
    }
    const timer = setTimeout(exitOnce, fallbackMs)
    // Do not let the fallback alone keep node alive; the pending write
    // callbacks / stream handles do that for as long as there is output.
    if (typeof timer.unref === 'function') timer.unref()
  })
}
