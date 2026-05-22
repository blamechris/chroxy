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
  let stdoutBytes = 0
  let stderrBytes = 0
  let truncated = false
  let timedOut = false
  let aborted = false

  const child = spawn('bash', ['-c', command], {
    cwd,
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const appendOut = (chunk) => {
    if (stdoutBytes >= maxOutputBytes) return
    const text = chunk.toString('utf8')
    const remaining = maxOutputBytes - stdoutBytes
    if (text.length > remaining) {
      stdout += text.slice(0, remaining)
      stdoutBytes += remaining
      truncated = true
      // Soft-kill — output cap is itself a failure mode.
      killChild('SIGTERM', 'output_cap')
    } else {
      stdout += text
      stdoutBytes += text.length
    }
  }

  const appendErr = (chunk) => {
    if (stderrBytes >= maxOutputBytes) return
    const text = chunk.toString('utf8')
    const remaining = maxOutputBytes - stderrBytes
    if (text.length > remaining) {
      stderr += text.slice(0, remaining)
      stderrBytes += remaining
      truncated = true
      killChild('SIGTERM', 'output_cap')
    } else {
      stderr += text
      stderrBytes += text.length
    }
  }

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
          if (!child.killed && child.exitCode === null) child.kill('SIGKILL')
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
