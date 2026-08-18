/**
 * Test helpers for proving an `isEntryPoint()` CALL SITE actually runs (#7254).
 *
 * The guard itself is well covered — three copies, a drift gate in
 * scripts/__tests__/is-entry-point.test.mjs, a lint in
 * scripts/lint-entry-point-guard.mjs, and tests/is-entry-point.test.js. What
 * these support is the other half: that at a given call site `node <module>`
 * really does reach `main()`, and that importing the same module really does
 * not.
 *
 * Why every assertion built on these is about an OBSERVABLE SIDE EFFECT and
 * never about exit status: the failure this area exists to catch (#7198) is a
 * guard that reads false, so the module body never runs and the process exits
 * 0 having done nothing. Exit 0 is what the bug looks like AND what success
 * looks like, so a test that checks it distinguishes nothing. A bound port, an
 * IPC message, a JSON-RPC frame on stdout — those are absent when the body did
 * not run.
 *
 * Both directions need covering, and they fail differently:
 *   - stuck FALSE: `node <module>` does nothing. Caught by waiting for the side
 *     effect and timing out.
 *   - stuck TRUE:  importing the module runs `main()` as a side effect of any
 *     test that imports it. Caught by {@link expectNeverListening} and friends
 *     — and those are NEGATIVE assertions, so they are worth something only
 *     next to a positive control proving the same observation can see the
 *     effect when it IS present (#7251 shipped a hole by covering only the
 *     direction the bug arrived from).
 */
import net from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOOPBACK = '127.0.0.1'

/**
 * Reserve a free TCP port by binding :0 and immediately releasing it.
 *
 * Inherently racy — the port can be taken between the close and the child's
 * bind — but it is the same race every `listen(0, '127.0.0.1')` test in this
 * suite already runs, and a fixed port is worse: it collides with a developer's
 * own running instance every time instead of with a 1-in-60000 stranger.
 *
 * Port 0 is deliberately not usable as the CHILD's port. `chroxy-channel-server`
 * resolves its port as `Number(process.env.CHROXY_CHANNEL_PORT) || DEFAULT_PORT`,
 * and `0` is falsy — so passing 0 does not mean "pick one for me", it silently
 * means 8788, the real default, on whatever machine is running the suite.
 * Allocating a concrete port is what keeps the test off it.
 *
 * @returns {Promise<number>}
 */
export function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** One connect attempt. Resolves true if something accepted, false otherwise. */
function tryConnect(port, host = LOOPBACK) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    // Every exit path destroys the socket. The server suite runs WITHOUT
    // `--test-force-exit` since #6042 — leaked handles do not truncate the run,
    // they HANG it — so a helper that strands a socket wedges CI rather than
    // failing it.
    const done = (answer) => {
      sock.destroy()
      resolve(answer)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * Poll `predicate` until it holds or the deadline passes. This is the one
 * polling loop in this file; everything else is expressed in terms of it, so
 * there is a single place where a deadline, an interval or an early return can
 * be wrong. `predicate` may be async and is awaited each tick.
 *
 * @returns {Promise<boolean>} true if it held before the deadline.
 */
export async function waitUntil(predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * Poll until something is listening on `port`, or the deadline passes.
 * @returns {Promise<boolean>} true if it bound within the window.
 */
export function waitForListening(port, { host = LOOPBACK, ...opts } = {}) {
  return waitUntil(() => tryConnect(port, host), opts)
}

/**
 * Watch `port` for `windowMs` and report whether it stayed unbound throughout.
 *
 * A NEGATIVE assertion: on its own it passes for every wrong reason there is —
 * a module that failed to import, a typo in the staged path, a child that died
 * on startup all leave the port just as unbound as correct behaviour does.
 * Pair it with a positive control that reaches the same observation through the
 * same harness.
 *
 * Returns as soon as something DOES bind, so only the passing case waits out
 * the window.
 *
 * @returns {Promise<boolean>} true if nothing ever bound.
 */
export async function expectNeverListening(port, { windowMs = 1500, host = LOOPBACK, intervalMs = 50 } = {}) {
  const bound = await waitUntil(() => tryConnect(port, host), { timeoutMs: windowMs, intervalMs })
  return !bound
}

/**
 * Accumulate a child stream into a string later assertions can read.
 * Returns a getter rather than a live binding so callers cannot read it stale.
 * Internal: reached through {@link attach}, which is what tests use.
 */
function collect(stream) {
  let buf = ''
  if (stream) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { buf += chunk })
  }
  return () => buf
}

/**
 * Wire up output collection, IPC collection and exit tracking on an
 * already-spawned child.
 *
 * Takes a child rather than spawning one because the two call sites under test
 * need different launchers: the channel server is `spawn`ed, the supervised
 * child is `fork`ed for its IPC channel.
 *
 * `exited` is captured HERE, at attach time, rather than awaited on demand
 * later. That ordering is the whole reason this exists: a child that has
 * already exited never emits `exit` again, so an `await once(child, 'exit')`
 * written after a polling loop waits for an event that already fired, and the
 * runner reports the unhelpful "Promise resolution is still pending but the
 * event loop has already resolved". The staged-importer children here exit in
 * milliseconds while the tests watching them deliberately wait over a second,
 * so that race is the normal case, not a rare one.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function attach(child) {
  const messages = []
  child.on('message', (m) => { messages.push(m) })
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve([child.exitCode, child.signalCode])
      return
    }
    child.once('exit', (code, signal) => resolve([code, signal]))
  })
  return { child, stdout: collect(child.stdout), stderr: collect(child.stderr), messages, exited }
}

/**
 * Wait for `predicate(text)` to hold over an accumulating stream, or time out.
 * @returns {Promise<boolean>}
 */
export function waitForOutput(getText, predicate, opts = {}) {
  return waitUntil(() => predicate(getText()), opts)
}

/**
 * The child's exit code, or the string `'TIMEOUT'` if it is still running.
 *
 * Every wait on a child's exit in these tests goes through this, and that is
 * deliberate. The stuck-TRUE failure direction turns an importer into a
 * long-lived server, so an unbounded `await exited` does not fail — it HANGS,
 * and the server suite has neither a default per-test timeout (node:test's is
 * Infinity) nor `--test-force-exit` (retired in #6042). A hang is a CI job
 * timeout with no assertion and no diagnostic, which is the same "the failure
 * is silence" shape this whole area exists to eliminate. Bounded, the same
 * condition reports itself as a named assertion instead.
 *
 * The timer is always cleared: a stray one keeps the runner's event loop alive,
 * and without force-exit that wedges the suite rather than truncating it.
 *
 * @param {Promise<[number|null, string|null]>} exited from {@link attach}
 * @returns {Promise<number|null|'TIMEOUT'>}
 */
export async function exitCodeWithin(exited, ms = 10000) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(['TIMEOUT', null]), ms) })
  try {
    const [code] = await Promise.race([exited, timeout])
    return code
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Terminate a spawned child and wait for it to actually go away.
 *
 * SIGTERM first, never SIGKILL as the opening move — these modules install
 * flush-on-shutdown handlers and SIGKILL bypasses them. SIGKILL is only the
 * fallback after a grace period, so a wedged child cannot hang the suite.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 */
export async function terminate(child, { graceMs = 2000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try { child.kill('SIGTERM') } catch { return }
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, graceMs)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A temp directory under the REAL tmpdir, for the caller to clean up.
 *
 * `realpathSync` matters: on macOS `os.tmpdir()` resolves through a symlink
 * (`/var` -> `/private/var`), and staging a script under a non-realpath'd path
 * is precisely the #7198 shape. A test that means to exercise the ordinary
 * direct run must not accidentally exercise the symlink case too — when a test
 * wants that case it should build the symlink deliberately.
 */
export function makeTempDir(prefix) {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix))
}

/** Best-effort recursive removal, for `after()` hooks. */
export function removeTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
