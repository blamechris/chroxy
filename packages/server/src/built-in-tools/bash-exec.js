/**
 * Run a shell command in a child process, capture stdout/stderr, enforce
 * a timeout and an output size cap. Used by the claude-byok provider's
 * Bash tool — chroxy is the agent, so the BYOK provider runs tools
 * locally rather than letting the claude binary do it.
 *
 * Design notes:
 * - Uses `spawn('bash', ['-c', command])` rather than `exec()` so we get
 *   streaming output + AbortSignal support, and the user's full shell
 *   syntax (pipes, redirection, heredocs) just works.
 * - Output is captured incrementally and capped at `maxOutputBytes` to
 *   keep a runaway producer from OOMing chroxy. When the cap is hit, the
 *   stream is truncated with a clear marker; the child is sent SIGTERM
 *   followed by SIGKILL after a 2s grace.
 * - Timeout sends SIGTERM first, SIGKILL after 2s if the child ignores
 *   the term. Returns `timedOut: true` so the caller can surface that
 *   distinctly from an exit-code failure.
 * - Aborting via the optional signal does the same as a timeout — clean
 *   SIGTERM, SIGKILL after grace. The returned `aborted: true` flag
 *   distinguishes it from a timeout for caller telemetry.
 *
 * Returns:
 *   {
 *     stdout: string,
 *     stderr: string,
 *     exitCode: number | null,   // null when killed before exit
 *     signal: string | null,     // signal that killed the process
 *     timedOut: boolean,
 *     aborted: boolean,
 *     truncated: boolean,        // true if output cap was hit
 *     durationMs: number,
 *   }
 */

import { spawn } from 'node:child_process'

export const DEFAULT_BASH_TIMEOUT_MS = 30_000
export const DEFAULT_BASH_MAX_OUTPUT_BYTES = 1_000_000 // 1 MB
export const HARD_KILL_GRACE_MS = 2_000

export async function executeBash({
  command,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_BASH_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_BASH_MAX_OUTPUT_BYTES,
  env,
  signal,
} = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('executeBash: command must be a non-empty string')
  }
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    throw new TypeError('executeBash: timeoutMs must be a positive number')
  }

  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  // Single counter shared across both streams. Pre-fix, stdout and
  // stderr each had their own counter so total captured output could
  // be up to ~2×maxOutputBytes — Copilot review on #4060. Now the cap
  // is a true total cap, counting actual UTF-8 BYTES of the chunk
  // buffer (chunk.length), not JS string code units (text.length)
  // which is UTF-16 and undercounts non-ASCII output.
  let totalBytes = 0
  let truncated = false
  let timedOut = false
  let aborted = false

  const child = spawn('bash', ['-c', command], {
    cwd,
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const capture = (chunk, which) => {
    if (totalBytes >= maxOutputBytes) return
    const chunkBytes = chunk.length
    const remaining = maxOutputBytes - totalBytes
    if (chunkBytes > remaining) {
      // Slice the BUFFER (byte-accurate), then decode. Slicing the
      // decoded string would be UTF-16 indexed and could split a
      // surrogate pair, producing replacement chars.
      const sliced = chunk.subarray(0, remaining).toString('utf8')
      if (which === 'stdout') stdout += sliced
      else stderr += sliced
      totalBytes += remaining
      truncated = true
      killChild('SIGTERM', 'output_cap')
    } else {
      const text = chunk.toString('utf8')
      if (which === 'stdout') stdout += text
      else stderr += text
      totalBytes += chunkBytes
    }
  }

  const appendOut = (chunk) => capture(chunk, 'stdout')
  const appendErr = (chunk) => capture(chunk, 'stderr')

  child.stdout.on('data', appendOut)
  child.stderr.on('data', appendErr)

  let hardKillTimer = null
  const killChild = (sig, _reason) => {
    if (child.killed || child.exitCode !== null) return
    try {
      child.kill(sig)
    } catch {
      // ignore — process already gone
    }
    if (sig === 'SIGTERM' && hardKillTimer === null) {
      hardKillTimer = setTimeout(() => {
        try {
          // #4067: `child.killed` is set when WE called child.kill(SIGTERM)
          // above — it does NOT indicate process liveness. To actually
          // skip the redundant SIGKILL when the child cleanly exited
          // under SIGTERM within the grace window, test for an actual
          // exit signal: exitCode set (normal exit) or signalCode set
          // (received a signal). Either means the process is gone.
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
        } catch {}
      }, HARD_KILL_GRACE_MS)
    }
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    killChild('SIGTERM', 'timeout')
  }, timeoutMs)

  let abortListener = null
  if (signal) {
    if (signal.aborted) {
      aborted = true
      killChild('SIGTERM', 'aborted_at_start')
    } else {
      abortListener = () => {
        aborted = true
        killChild('SIGTERM', 'aborted')
      }
      signal.addEventListener('abort', abortListener, { once: true })
    }
  }

  const { code, sig } = await new Promise((resolve) => {
    child.on('exit', (code, signalName) => resolve({ code, sig: signalName }))
    child.on('error', () => resolve({ code: null, sig: null }))
  })

  clearTimeout(timeoutHandle)
  if (hardKillTimer !== null) clearTimeout(hardKillTimer)
  if (signal && abortListener) signal.removeEventListener('abort', abortListener)

  return {
    stdout,
    stderr,
    exitCode: code,
    signal: sig,
    timedOut,
    aborted,
    truncated,
    durationMs: Date.now() - startedAt,
  }
}
