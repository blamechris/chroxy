/**
 * Helper for spawning the chroxy CLI as a subprocess.
 *
 * Every spawn isolates HOME (and CHROXY_CONFIG_DIR) into a temp directory so
 * tests can never touch the real ~/.chroxy/. The helper captures stdout,
 * stderr, and the exit code and resolves once the process exits or the
 * timeout fires.
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const HERE = resolve(__filename, '..')
// tests/cli/__helpers -> tests/cli -> tests -> packages/server
const SERVER_PKG = resolve(HERE, '..', '..', '..')
export const CLI_PATH = join(SERVER_PKG, 'src', 'cli.js')

/**
 * Create a temp HOME directory. Returns the path and a cleanup function.
 *
 * @returns {{ home: string, cleanup: () => void }}
 */
export function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'chroxy-cli-test-'))
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {}
    },
  }
}

/**
 * Pick a high random port unlikely to collide. We avoid the canonical 8765
 * Chroxy port because parallel test runs would step on each other.
 */
export function pickPort() {
  return 40000 + Math.floor(Math.random() * 20000)
}

/**
 * Spawn the chroxy CLI with isolated HOME and capture all output.
 *
 * @param {string[]} args - CLI arguments
 * @param {object} [opts]
 * @param {string} [opts.home] - Override HOME (default: fresh tmpdir, leaked — pass home for cleanup)
 * @param {object} [opts.env] - Extra env vars merged on top of base env
 * @param {string} [opts.cwd] - Working directory
 * @param {string|Buffer} [opts.input] - Data piped to stdin
 * @param {boolean} [opts.keepStdinOpen] - Write input but don't close stdin
 *   afterwards. Necessary for commands that use readline.question, which
 *   does not invoke its callback on stdin EOF — the promise would never
 *   resolve and the child would exit silently.
 * @param {string[]} [opts.lines] - Send one line at a time, separated by
 *   small delays. Required for commands (like `chroxy init`) that build a
 *   fresh readline interface per prompt — a single bulk write loses
 *   buffered bytes between interface lifetimes.
 * @param {number} [opts.lineDelayMs] - Delay between lines (default: 200ms)
 * @param {number} [opts.timeoutMs] - Kill the child if it hasn't exited by then (default: 15000)
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null, signal: string|null, timedOut: boolean }>}
 */
export function runCli(args, opts = {}) {
  // If the caller didn't provide a HOME, mint one here and tear it down
  // on child exit so ad-hoc callers don't silently leak tmpdirs.
  const ownsHome = !opts.home
  const home = opts.home || mkdtempSync(join(tmpdir(), 'chroxy-cli-test-'))
  const timeoutMs = opts.timeoutMs ?? 15000

  // The child runs under `process.execPath`, i.e. whichever Node binary
  // ran this test. We do not modify PATH to select a different Node;
  // callers are expected to invoke the test runner with Node 22 already.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    // Sandbox every persistent path that has an env override available so
    // tests can't accidentally write into real config/state directories.
    CHROXY_CONFIG_DIR: join(home, '.chroxy'),
    NODE_ENV: 'test',
    ...(opts.env || {}),
  }

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: opts.cwd || home,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {}
      // Hard kill after another second if SIGTERM didn't take.
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 1000).unref()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const tearDownTempHome = () => {
      if (!ownsHome) return
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {}
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      tearDownTempHome()
      resolvePromise({
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        code: null,
        signal: null,
        timedOut,
      })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      tearDownTempHome()
      resolvePromise({ stdout, stderr, code, signal, timedOut })
    })

    if (Array.isArray(opts.lines) && opts.lines.length > 0) {
      // Drip-feed lines so each readline.createInterface invocation in
      // the child captures its own line. Keep stdin open the whole
      // time; the child exits on its own when its prompts complete.
      const delay = opts.lineDelayMs ?? 200
      const lines = [...opts.lines]
      const drip = () => {
        if (lines.length === 0 || child.exitCode != null) return
        const next = lines.shift()
        try {
          child.stdin.write(next.endsWith('\n') ? next : next + '\n')
        } catch {}
        setTimeout(drip, delay).unref()
      }
      setTimeout(drip, delay).unref()
    } else if (opts.input != null) {
      if (opts.keepStdinOpen) {
        // readline.question() doesn't fire its callback on stdin EOF, so
        // for interactive commands we write the answers and leave the
        // pipe open. The child exits when its own logic completes.
        child.stdin.write(opts.input)
      } else {
        child.stdin.end(opts.input)
      }
    } else if (!opts.keepStdinOpen) {
      child.stdin.end()
    }
  })
}
