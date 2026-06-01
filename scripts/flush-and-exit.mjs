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
