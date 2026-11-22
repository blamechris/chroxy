// test-foreign-signal-guard.mjs — refuse to signal a process the test run did
// not spawn (#9288).
//
// The hazard. `killProcessTree` (packages/server/src/platform.js) enumerates the
// REAL descendants of `child.pid` with `ps` and `process.kill`s each one. A test
// that hands it a mock child with a numeric pid (`pid: 12345`) therefore runs
// `ps` against a pid it does not own and can SIGTERM that pid's real children.
// The fs sandbox (test-fs-sandbox.mjs) guards writes; nothing guarded signals.
//
// What this guards. `process.kill(pid, signal)` itself — the one choke point
// every real signal goes through. Verified: `killProcessTree`,
// `killRecordedTree`, `orphan-reaper.js` and `user-shell-registry.js` reach a
// real pid only via `process.kill` or a `deps.kill` seam that defaults to it
// (`const kill = deps.kill || process.kill`, evaluated at CALL time, so the
// patched function is the one captured). `ChildProcess.prototype.kill` goes
// through the handle (`this._handle.kill`), not `process.kill`; it can only
// reach its own child and is deliberately not refused.
//
// A signal is ALLOWED when its target is:
//   - `process.pid`;
//   - signal 0 for ANY pid. It delivers nothing, so it cannot harm a process;
//     it only reveals existence, and production liveness probes
//     (`isProcessAlive`) legitimately run it against stale or mock pids;
//   - a pid returned by a `child_process` async launcher (spawn, exec,
//     execFile, fork) or node-pty `spawn` in THIS process;
//   - a DESCENDANT of one of those, proved at signal time by walking the
//     `ps -axo pid=,ppid=,pgid=` table up from the target to a tracked pid;
//   - a descendant already OBSERVED under a tracked parent. Every check and
//     every `ChildProcess.prototype.kill` takes a snapshot first and records
//     the tracked subtree, so a grandchild stays attributable after its parent
//     exits and it is reparented to launchd (ppid 1);
//   - a member of a process group led by a LIVE tracked pid (pgid match), which
//     covers reparented grandchildren of a `detached: true` child while the
//     leader runs (once it exits, only the observed set covers them);
//   - a negative pid (process group) only when its leader satisfies the above.
// Everything else — pid 0, -1, foreign pids, a mock child's invented pid —
// throws CHROXY_TEST_FOREIGN_SIGNAL BEFORE the signal is sent.
//
// Recycled pids (macOS wraps): a tracked pid is dropped when its child exits,
// and every snapshot drops tracked/observed pids that left the table or whose
// `lstart` text changed. An observed pid is re-verified against a fresh table
// on every signal; only a LIVE tracked child skips `ps`. A string pid is
// coerced the way Node coerces it before the decision.
//
// Limits, stated so nobody mistakes them for cover: a signal sent to a tracked
// child in the instant between its death and the 'exit' event is still allowed;
// after a detached leader
// exits its own `-pgid` form is refused even while observed members live (the
// member pids still work); the lstart identity has one-second granularity, so a
// pid reissued within the same second to a process with the same start text is
// indistinguishable; a grandchild whose parent
// exited BEFORE any snapshot (and which is not in the tracked pgid) cannot be
// attributed and is refused — the fix is for the test to snapshot via a kill of
// its own child, or to record the pid while the parent lives. With no `ps`
// result the descendant proof is unavailable and the signal is REFUSED, never
// allowed. win32 has no `ps`; `killProcessTree` uses `taskkill` there, so the
// guard reports itself skipped on win32 rather than guessing.
//
// #7262 rule: this module MUST NOT ESM-import `node:child_process`. It reaches
// it through `createRequire` so the patch lands before any named-import
// snapshot is taken, exactly as test-spawn-home-sandbox.mjs does.

import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { isMainThread } from 'node:worker_threads'

const require = createRequire(import.meta.url)

export const FOREIGN_SIGNAL_ERROR_CODE = 'CHROXY_TEST_FOREIGN_SIGNAL'
export const FOREIGN_SIGNAL_MARKER = Symbol.for('chroxy.testForeignSignalGuard')

/** Async launchers that return a ChildProcess whose pid becomes tracked. */
export const TRACKED_LAUNCHERS = ['spawn', 'exec', 'execFile', 'fork']

/**
 * Parse `ps -axo pid=,ppid=,pgid=,lstart=` into rows; null when nothing parsed.
 * `start` is the locale-formatted `lstart` text, compared only for equality: it
 * tells a recycled pid from the process we first saw under that number.
 */
export function parsePsTable(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?(?:\s+(\S.*?))?\s*$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: m[3] === undefined ? null : Number(m[3]), start: m[4] === undefined ? null : m[4] })
  }
  return rows.length > 0 ? rows : null
}

/**
 * The pid Node's `process.kill` will act on. Node 22 accepts any value with
 * `pid == (pid | 0)` — numeric strings (' 12 ', '0x10', ''), booleans (true is
 * pid 1, false is pid 0), `[String(pid)]`, `{ valueOf() { return pid } }` — then
 * hands the integer to the binding. Checked against Node 22: number-likes above
 * are accepted; null, undefined, NaN, 1.5, `{}`, a Date, a BigInt and a Symbol
 * are rejected by Node itself, so they are returned untouched for Node to reject.
 * The guard decides on, AND forwards, this ONE converted integer, so a `valueOf`
 * that answers differently per call cannot split the decision from the signal.
 * UNCONVERTIBLE means a non-primitive whose conversion threw: the guard refuses it rather
 * than let Node convert it again.
 */
export const UNCONVERTIBLE = Symbol('chroxy.unconvertiblePid')

export function coercePid(raw) {
  const t = typeof raw
  if (t === 'number') return raw
  if (t === 'string' || t === 'boolean') {
    const n = raw | 0
    return raw == n ? n : raw // eslint-disable-line eqeqeq
  }
  if ((t === 'object' && raw !== null) || t === 'function') {
    try { return raw | 0 } catch { return UNCONVERTIBLE }
  }
  return raw
}

/**
 * The decision logic, free of any patching, so the suite can drive it with a
 * fake process table. `readTable()` returns rows or null (unavailable).
 */
export function createForeignSignalPolicy({ selfPid, readTable, probeDead = () => false }) {
  // pid -> start-time text once a snapshot has seen it (null until then).
  // `tracked` holds LIVE children only: it is pruned on the child's exit, and a
  // pid whose row vanishes or whose start time changes is dropped by observe().
  // A stale entry is how a recycled pid (macOS wraps) would be mistaken for ours.
  const tracked = new Map()
  const observed = new Map()

  function prune(map, byPid) {
    for (const [p, st] of [...map]) {
      const row = byPid.get(p)
      if (!row || (st && row.start && st !== row.start)) map.delete(p)
      else if (!st && row.start) map.set(p, row.start)
    }
  }

  function observe(rows) {
    if (!rows) return
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    prune(tracked, byPid)
    prune(observed, byPid)
    const kids = new Map()
    for (const r of rows) {
      if (!kids.has(r.ppid)) kids.set(r.ppid, [])
      kids.get(r.ppid).push(r)
    }
    const queue = [...tracked.keys(), ...observed.keys()]
    const seen = new Set(queue)
    while (queue.length) {
      const p = queue.pop()
      for (const k of kids.get(p) || []) {
        if (seen.has(k.pid)) continue
        seen.add(k.pid)
        observed.set(k.pid, k.start)
        queue.push(k.pid)
      }
    }
  }

  function snapshot() {
    if (tracked.size === 0 && observed.size === 0) return null
    const rows = readTable()
    observe(rows)
    return rows
  }

  /** @returns {null | string} null when allowed, otherwise the reason. */
  function decide(rawPid, signal) {
    if (signal === 0 || signal === '0') return null
    // Decide on the integer Node will act on (see coercePid); a value Node itself
    // rejects is left for Node's own TypeError.
    const pid = coercePid(rawPid)
    if (pid === UNCONVERTIBLE) return 'the pid is an object whose conversion threw, so it cannot be attributed'
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return null
    if (pid === selfPid) return null
    const target = pid < 0 ? -pid : pid
    if (pid === 0 || pid === -1) return `pid ${pid} addresses the whole process group or every process`
    if (target === selfPid && pid < 0) return `process group ${target} is this test process's own group`
    // A tracked pid is a LIVE child (pruned on exit): no ps needed for it.
    if (tracked.has(target)) return null
    // A pid (or group) that no longer exists cannot be harmed: the signal can only
    // report ESRCH. Tests and node-pty routinely signal a child after it exited.
    // A LIVE pid that is not ours (a recycled number, a foreign process) still
    // reaches the checks below.
    if (probeDead(pid)) return null
    if (tracked.size === 0 && observed.size === 0) return `pid ${pid} is not a child this test process spawned (it has spawned none)`
    // An observed pid is re-verified against a fresh table every time.
    const rows = snapshot()
    if (rows === null) return `pid ${pid} cannot be attributed to a spawned child: the process table is unavailable`
    if (tracked.has(target) || observed.has(target)) return null
    const row = rows.find((r) => r.pid === target)
    if (row && row.pgid !== null && tracked.has(row.pgid)) return null
    return `pid ${pid} is not a child, or a descendant of a child, that this test process spawned`
  }

  // Refusals nobody has acknowledged. A refusal THROWS, but production teardown
  // code wraps `kill()` in try/catch (`killProcessTree`), which swallows it: the
  // signal is still prevented, yet the test would go green. The exit hook below
  // fails the test file while any refusal is unacknowledged. A test that
  // deliberately provokes one calls `acknowledge()`.
  const refusals = []
  return { tracked, observed, refusals, acknowledge() { refusals.length = 0 }, observe, snapshot, decide,
    track(pid) { if (Number.isInteger(pid) && pid > 0 && !tracked.has(pid)) tracked.set(pid, null) },
    untrack(pid) { tracked.delete(pid) } }
}

function callSite() {
  const lines = (new Error().stack || '').split('\n').slice(1)
  const own = import.meta.url.replace(/^file:\/\//, '')
  const frame = lines.find((l) => !l.includes(own) && !l.includes('node:internal')) || lines[lines.length - 1] || ''
  return frame.trim().replace(/^at\s+/, '')
}

function realReadTable(execFileSync) {
  return () => {
    try {
      const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      return parsePsTable(out)
    } catch {
      return null
    }
  }
}

/**
 * Install onto the live `process` and `node:child_process`.
 * `target` is the test seam: `{ proc, cp, platform, readTable }`.
 */
export function installForeignSignalGuard({ allowEnv, target = {} } = {}) {
  const proc = target.proc || process
  const cp = target.cp || require('node:child_process')
  const platform = target.platform || process.platform
  if (platform === 'win32') return { installed: [], skipped: [{ name: 'kill', reason: 'win32' }], policy: null }
  if (proc.kill && proc.kill[FOREIGN_SIGNAL_MARKER]) return { installed: [], skipped: [{ name: 'kill', reason: 'already-guarded' }], policy: proc.kill[FOREIGN_SIGNAL_MARKER] }

  const realExecFileSync = cp.execFileSync
  const originalKillFn = proc.kill
  const policy = createForeignSignalPolicy({
    selfPid: proc.pid,
    readTable: target.readTable || realReadTable(realExecFileSync),
    probeDead: target.probeDead || ((pid) => {
      try { originalKillFn.call(proc, pid, 0); return false } catch (e) { return e && e.code === 'ESRCH' }
    }),
  })
  const installed = []
  const originalKill = proc.kill

  const guardedKill = function guardedProcessKill(pid, signal) {
    // ONE conversion: decide on it and forward it (a valueOf must not get a second say).
    pid = coercePid(pid)
    if (!(allowEnv && process.env[allowEnv] === '1')) {
      const reason = policy.decide(pid, signal)
      if (reason !== null) {
        const site = callSite()
        const sig = signal === undefined ? 'SIGTERM(default)' : String(signal)
        const err = new Error(
          `[chroxy-test-sandbox] BLOCKED process.kill(${pid}, ${sig}): ${reason}.\n` +
          `  Call site: ${site}\n` +
          `  A test may only signal processes it spawned (or their descendants). A mock child with a numeric pid\n` +
          `  (\`pid: 12345\`) makes killProcessTree run \`ps\` against a pid the test does not own and SIGTERM its real\n` +
          `  children. Give the mock \`pid: undefined\`, inject the kill seam (deps.kill), or spawn a real child.\n` +
          `  Set process.env.${allowEnv || 'CHROXY_TEST_ALLOW_FOREIGN_SIGNALS'} = '1' scoped to the test if intentional. See issue #9288.`,
        )
        err.code = FOREIGN_SIGNAL_ERROR_CODE
        err.pid = pid
        err.signal = signal
        policy.refusals.push(`process.kill(${pid}, ${sig}) at ${site}`)
        throw err
      }
    }
    return originalKill.call(this, pid, signal)
  }
  guardedKill[FOREIGN_SIGNAL_MARKER] = policy
  // Main thread only: a worker's `process.exitCode` does not reach the runner. The
  // hook (and this guard) are inherited by fork/--import children, each judging its
  // OWN refusals; CHROXY_TEST_ALLOW_FOREIGN_SIGNALS is inherited through the env.
  if (target.exitHook !== false && isMainThread) {
    proc.on('exit', () => {
      if (policy.refusals.length === 0) return
      process.stderr.write(
        `[chroxy-test-sandbox] ${policy.refusals.length} foreign signal(s) were refused and swallowed (#9288):\n  ` +
        `${policy.refusals.join('\n  ')}\n`)
      process.exitCode = 1
    })
  }
  proc.kill = guardedKill
  installed.push('kill')

  function trackChild(child) {
    if (!child || typeof child.pid !== 'number') return
    const pid = child.pid
    policy.track(pid)
    // Dead pids must not stay attributable: the OS recycles them.
    if (typeof child.once === 'function') {
      const drop = () => policy.untrack(pid)
      child.once('exit', drop)
      child.once('close', drop)
    }
  }

  // Track pids of children this process launches.
  function wrap(original) {
    const patched = function trackingLauncher(...args) {
      const child = original.apply(this, args)
      trackChild(child)
      return child
    }
    // Composition: keep every OTHER guard's marker symbol visible on the wrapper
    // (the spawn-home sandbox and the real-binary tripwire each prove themselves
    // by reading their marker off the live export).
    for (const sym of Object.getOwnPropertySymbols(original)) {
      if (sym !== promisify.custom) patched[sym] = original[sym]
    }
    if (original[promisify.custom]) {
      patched[promisify.custom] = function trackingPromisified(...args) {
        let child
        const promise = new Promise((resolvePromise, rejectPromise) => {
          child = patched.call(this, ...args, (err, stdout, stderr) => {
            if (err) {
              if (stdout !== undefined) err.stdout = stdout
              if (stderr !== undefined) err.stderr = stderr
              rejectPromise(err)
            } else {
              resolvePromise({ stdout, stderr })
            }
          })
        })
        // Real Node attaches the ChildProcess as `.child` on the promisified result.
        promise.child = child
        return promise
      }
    }
    return patched
  }
  for (const name of TRACKED_LAUNCHERS) {
    const original = cp[name]
    if (typeof original !== 'function' || original[FOREIGN_SIGNAL_MARKER]) continue
    const patched = wrap(original)
    patched[FOREIGN_SIGNAL_MARKER] = name
    cp[name] = patched
    installed.push(name)
  }

  // Snapshot the subtree before a tracked child is killed, so a grandchild stays
  // attributable once its parent is gone and it has been reparented.
  const proto = cp.ChildProcess && cp.ChildProcess.prototype
  if (proto && typeof proto.kill === 'function' && !proto.kill[FOREIGN_SIGNAL_MARKER]) {
    const originalChildKill = proto.kill
    const snapshotting = function snapshotBeforeChildKill(...args) {
      try { if (typeof this.pid === 'number') { if (this.exitCode === null && this.signalCode === null) policy.track(this.pid); policy.snapshot() } } catch { /* best effort */ }
      return originalChildKill.apply(this, args)
    }
    snapshotting[FOREIGN_SIGNAL_MARKER] = 'ChildProcess.prototype.kill'
    proto.kill = snapshotting
    installed.push('ChildProcess.prototype.kill')
  }

  // node-pty's native spawn bypasses child_process, and its `kill()` signals the
  // pty pid through `process.kill` — track those pids too (lazy: only if a test
  // loads node-pty). Same Module._load shape as test-pty-home-sandbox.mjs.
  if (!target.cp) {
    const Module = require('node:module')
    if (!Module._load[FOREIGN_SIGNAL_MARKER]) {
      const inner = Module._load
      const hooked = function chroxyForeignSignalPtyLoad(request, parent, ...rest) {
        const exp = inner.call(this, request, parent, ...rest)
        if (exp && typeof exp === 'object' && typeof request === 'string' && request.includes('node-pty')) {
          for (const name of ['spawn', 'fork', 'createTerminal']) {
            const original = exp[name]
            if (typeof original !== 'function' || original[FOREIGN_SIGNAL_MARKER]) continue
            const tracking = function trackingPtyLauncher(...a) {
              const term = original.apply(this, a)
              if (term && typeof term.pid === 'number') {
                const pid = term.pid
                policy.track(pid)
                if (typeof term.onExit === 'function') term.onExit(() => policy.untrack(pid))
                else if (typeof term.once === 'function') term.once('exit', () => policy.untrack(pid))
              }
              return term
            }
            for (const sym of Object.getOwnPropertySymbols(original)) tracking[sym] = original[sym]
            tracking[FOREIGN_SIGNAL_MARKER] = name
            exp[name] = tracking
          }
        }
        return exp
      }
      hooked[FOREIGN_SIGNAL_MARKER] = true
      Module._load = hooked
      installed.push('node-pty (lazy)')
    }
  }

  return { installed, skipped: [], policy }
}
