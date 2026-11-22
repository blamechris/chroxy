/**
 * Foreign-signal guard for the server test suite (#9288).
 *
 * `killProcessTree` runs `ps` against `child.pid` and `process.kill`s every
 * descendant it finds. A test that gives a mock child a numeric pid therefore
 * signals real processes it does not own. `_setup.mjs` installs
 * `scripts/lib/test-foreign-signal-guard.mjs`, which patches `process.kill` and
 * refuses any pid this test process did not spawn.
 *
 * SAFETY OF THIS FILE: no test here ever delivers a signal to a process it did
 * not spawn. The foreign-pid cases aim at the real parent (`process.ppid`) with
 * `SIGCONT` (harmless to a running process) and assert the guard throws BEFORE
 * sending; the cases that send real signals do so to children this file spawned.
 *
 * The install proof reads the live `process.kill`, so deleting the install line
 * in `_setup.mjs` turns the first describe red.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FOREIGN_SIGNAL_GUARD_INSTALLED, FOREIGN_SIGNAL_GUARD_SKIPPED } from './_setup.mjs'
import {
  FOREIGN_SIGNAL_ERROR_CODE,
  FOREIGN_SIGNAL_MARKER,
  TRACKED_LAUNCHERS,
  UNCONVERTIBLE,
  coercePid,
  createForeignSignalPolicy,
  installForeignSignalGuard,
  parsePsTable,
} from '../../../scripts/lib/test-foreign-signal-guard.mjs'

const POSIX = process.platform !== 'win32'
const skipWin = POSIX ? false : 'guard is skipped on win32 (no ps; killProcessTree uses taskkill)'

// The REAL group of the parent runner (a live group, so it is not 'dead' and must be refused).
const parentGroup = () => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim())

const spawned = []
function sleeper() {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' })
  spawned.push(c)
  return c
}
afterEach(() => {
  // These tests provoke refusals on purpose; the exit hook must not count them.
  if (process.kill[FOREIGN_SIGNAL_MARKER]) process.kill[FOREIGN_SIGNAL_MARKER].acknowledge()
  for (const c of spawned.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
})
const exited = (c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())))

describe('foreign-signal guard is installed (#9288)', () => {
  it('patches process.kill and the launchers on the live process', { skip: skipWin }, () => {
    assert.ok(process.kill[FOREIGN_SIGNAL_MARKER], 'process.kill is not guarded: _setup.mjs no longer installs the guard')
    assert.ok(FOREIGN_SIGNAL_GUARD_INSTALLED.includes('kill'), 'install result does not list kill')
    for (const name of TRACKED_LAUNCHERS) {
      assert.ok(FOREIGN_SIGNAL_GUARD_INSTALLED.includes(name), `launcher ${name} is not tracked`)
    }
    assert.deepEqual(FOREIGN_SIGNAL_GUARD_SKIPPED, [])
  })

  it('on win32 the live install is skipped for the explicit reason, never silently absent', { skip: POSIX ? 'posix runs the install assertion above' : false }, () => {
    assert.deepEqual(FOREIGN_SIGNAL_GUARD_SKIPPED, [{ name: 'kill', reason: 'win32' }])
    assert.deepEqual(FOREIGN_SIGNAL_GUARD_INSTALLED, [])
  })

  it('reports itself skipped (never silently absent) on win32', () => {
    const r = installForeignSignalGuard({ target: { platform: 'win32', proc: {}, cp: {} } })
    assert.deepEqual(r.installed, [])
    assert.deepEqual(r.skipped, [{ name: 'kill', reason: 'win32' }])
  })
})

describe('refuses foreign pids BEFORE sending (#9288)', { skip: skipWin }, () => {
  it('refuses the real parent with no children spawned, with code, pid, signal and call site', () => {
    assert.throws(
      () => process.kill(process.ppid, 'SIGCONT'),
      (err) => {
        assert.equal(err.code, FOREIGN_SIGNAL_ERROR_CODE)
        assert.equal(err.pid, process.ppid)
        assert.equal(err.signal, 'SIGCONT')
        assert.ok(err.message.includes(`process.kill(${process.ppid}, SIGCONT)`), 'message names pid and signal')
        assert.ok(err.message.includes('setup-foreign-signal-guard.test.js'), 'message names the call site')
        return true
      },
    )
  })

  it('refuses the real parent while a child IS tracked (the ps-walk path)', () => {
    const c = sleeper()
    assert.ok(Number.isInteger(c.pid))
    assert.throws(() => process.kill(process.ppid, 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
  })

  it('refuses a mock child pid that is not a real descendant', () => {
    sleeper()
    // pid 1 is launchd/init: never a descendant of a test child.
    assert.throws(() => process.kill(1, 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
  })

  it('refuses the parent process group', () => {
    // pid 0 and -1 are asserted against the policy only (below): were the guard
    // absent they would signal every process this user owns.
    assert.throws(() => process.kill(-parentGroup(), 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
  })

  it('honours the escape hatch only while it is set', () => {
    process.env.CHROXY_TEST_ALLOW_FOREIGN_SIGNALS = '1'
    try {
      // SIGCONT to the running parent is harmless; this proves the hatch bypasses.
      process.kill(process.ppid, 'SIGCONT')
    } finally {
      delete process.env.CHROXY_TEST_ALLOW_FOREIGN_SIGNALS
    }
    assert.throws(() => process.kill(process.ppid, 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
  })
})

describe('allows what the test owns (#9288)', { skip: skipWin }, () => {
  it('allows signal 0 for any pid (liveness probe, delivers nothing)', () => {
    assert.equal(process.kill(process.ppid, 0), true)
  })

  it('allows process.pid', () => {
    assert.equal(process.kill(process.pid, 0), true)
    process.kill(process.pid, 'SIGCONT')
  })

  it('allows a spawned child, and is not defeated by a mixed foreign call', async () => {
    const c = sleeper()
    process.kill(c.pid, 'SIGTERM')
    await exited(c)
    assert.equal(c.signalCode, 'SIGTERM')
  })

  it('allows a grandchild proved by the ps walk', async () => {
    const c = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] })
    spawned.push(c)
    const gpid = await new Promise((r) => c.stdout.once('data', (d) => r(Number(String(d).trim()))))
    assert.notEqual(gpid, c.pid)
    process.kill(gpid, 'SIGTERM')
    c.kill('SIGKILL')
    await exited(c)
  })

  it('allows a REPARENTED grandchild after its parent exited (observed set)', async () => {
    const c = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] })
    spawned.push(c)
    const gpid = await new Promise((r) => c.stdout.once('data', (d) => r(Number(String(d).trim()))))
    // ChildProcess.kill snapshots the subtree first; killing the parent orphans the sleep.
    c.kill('SIGKILL')
    await exited(c)
    try {
      process.kill(gpid, 'SIGTERM')
    } finally {
      try { process.kill(gpid, 'SIGKILL') } catch { /* gone */ }
    }
  })

  it('allows the process group of a detached child, refuses a foreign group', async () => {
    const c = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    spawned.push(c)
    assert.throws(() => process.kill(-parentGroup(), 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
    process.kill(-c.pid, 'SIGTERM')
    await exited(c)
    assert.equal(c.signalCode, 'SIGTERM')
  })
})

describe('dead and recycled pids are not attributable (#9288 review R1)', { skip: skipWin }, () => {
  it('a pid whose child already exited is untracked, and a dead pid is left to report ESRCH', async () => {
    const c = spawn('sleep', ['0.05'], { stdio: 'ignore' })
    const pid = c.pid
    await exited(c)
    assert.ok(!process.kill[FOREIGN_SIGNAL_MARKER].tracked.has(pid), 'exited child is still tracked')
    // Dead: harmless, so not a foreign-signal refusal; Node reports ESRCH.
    assert.throws(() => process.kill(pid, 'SIGCONT'), { code: 'ESRCH' })
  })
})

describe('string pids are decided on the number Node acts on (R2)', { skip: skipWin }, () => {
  it('refuses a numeric-string foreign pid before sending', () => {
    assert.throws(() => process.kill(String(process.ppid), 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
    assert.throws(() => process.kill(` ${process.ppid} `, 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
  })
  it('still allows a numeric-string own pid and signal 0', () => {
    process.kill(String(process.pid), 'SIGCONT')
    assert.equal(process.kill(String(process.ppid), 0), true)
  })
})

describe('coercible non-number pids are decided on the integer Node acts on (R2b)', { skip: skipWin }, () => {
  it('refuses an object with valueOf, an array and a boolean aimed at a foreign pid, before sending', () => {
    assert.throws(() => process.kill({ valueOf() { return process.ppid } }, 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
    assert.throws(() => process.kill([String(process.ppid)], 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE })
    assert.throws(() => process.kill(true, 'SIGCONT'), { code: FOREIGN_SIGNAL_ERROR_CODE }) // true is pid 1
  })
  it('converts once: a valueOf that changes its answer cannot split decision from signal', () => {
    let calls = 0
    const sneaky = { valueOf() { calls++; return calls === 1 ? process.pid : process.ppid } }
    process.kill(sneaky, 'SIGCONT') // the single conversion is our own pid, which is also what is forwarded
    assert.equal(calls, 1)
  })
  it('leaves values Node rejects to Node (TypeError, not a refusal)', () => {
    // `{}` is deliberately absent: Node rejects it, the guard sees pid 0 and refuses it first
    // (stricter, still loud, nothing sent).
    for (const bad of [null, undefined, NaN, 1.5, Symbol('x'), 1n]) {
      assert.throws(() => process.kill(bad, 'SIGCONT'), (e) => e.code !== FOREIGN_SIGNAL_ERROR_CODE, String(typeof bad))
    }
  })
})

describe('promisified launchers keep .child and track it (R3)', { skip: skipWin }, () => {
  it('promisify(execFile) returns a promise with a tracked .child', async () => {
    const pr = promisify(execFile)('sleep', ['0.05'])
    assert.ok(pr.child && Number.isInteger(pr.child.pid), 'promise has no .child')
    assert.ok(process.kill[FOREIGN_SIGNAL_MARKER].tracked.has(pr.child.pid), 'child pid is not tracked')
    await pr
  })
})

describe('node-pty launchers are tracked through Module._load (R5)', { skip: skipWin }, () => {
  it('tracks a pid returned by a (fake) node-pty spawn and untracks it on exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-fake-'))
    try {
      fs.writeFileSync(path.join(dir, 'index.js'),
        'let cb\nexports.spawn = () => ({ pid: 987654, onExit(f) { cb = f } })\nexports.fire = () => cb()\n')
      const fake = createRequire(import.meta.url)(path.join(dir, 'index.js'))
      const policy = process.kill[FOREIGN_SIGNAL_MARKER]
      fake.spawn()
      assert.ok(policy.tracked.has(987654), 'fake pty pid not tracked')
      fake.fire()
      assert.ok(!policy.tracked.has(987654), 'pty pid still tracked after exit')
    } finally {
      process.kill[FOREIGN_SIGNAL_MARKER].untrack(987654)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a swallowed refusal still fails the file (#9288)', { skip: skipWin }, () => {
  const setup = fileURLToPath(new URL('./_setup.mjs', import.meta.url))
  const run = (body) => spawnSync(process.execPath, ['--import', setup, '-e', body], { encoding: 'utf8' })
  // pid 1 with SIGCONT: refused before sending, and were the guard absent the OS would say EPERM.
  const swallowed = "try { process.kill(1, 'SIGCONT') } catch {}"
  it('exits 1 and names the call when production code catches the refusal', () => {
    const r = run(swallowed)
    assert.equal(r.status, 1)
    assert.ok(r.stderr.includes('process.kill(1, SIGCONT)'), 'stderr names the refused call')
  })
  it('exits 0 when the refusal was acknowledged', () => {
    const r = run(`${swallowed}; process.kill[Symbol.for('chroxy.testForeignSignalGuard')].acknowledge()`)
    assert.equal(r.status, 0)
  })
})

describe('the dead-pid probe (EPERM is alive, ESRCH is dead)', { skip: skipWin }, () => {
  function install(code) {
    const sent = []
    const proc = {
      pid: 4242,
      kill(pid, sig) {
        sent.push([pid, sig])
        if (sig === 0) throw Object.assign(new Error(code), { code })
        return true
      },
    }
    const r = installForeignSignalGuard({ target: { proc, cp: {}, platform: 'linux', readTable: () => null, exitHook: false } })
    r.policy.track(777)
    return { proc, sent }
  }
  it('pid 1 answering EPERM to signal 0 is an existing foreign process: refused, signal not sent', () => {
    const { proc, sent } = install('EPERM')
    assert.throws(() => proc.kill(1, 'SIGTERM'), { code: FOREIGN_SIGNAL_ERROR_CODE })
    assert.deepEqual(sent, [[1, 0]])
  })
  it('ESRCH is dead: the signal goes through to report ESRCH itself', () => {
    const { proc, sent } = install('ESRCH')
    proc.kill(1, 'SIGTERM')
    assert.deepEqual(sent, [[1, 0], [1, 'SIGTERM']])
  })
})

describe('without ps (a host lacking procps)', { skip: skipWin }, () => {
  function fakeInstall() {
    const sent = []
    const proc = { pid: 4242, kill(pid, sig) { sent.push([pid, sig]); return true } }
    const cp = {}
    const r = installForeignSignalGuard({ target: { proc, cp, platform: 'linux', readTable: () => null, exitHook: false, probeDead: () => false } })
    return { proc, sent, r }
  }
  it('direct tracked children, process.pid and signal 0 never need ps', () => {
    const { proc, sent, r } = fakeInstall()
    r.policy.track(777)
    proc.kill(777, 'SIGTERM')
    proc.kill(4242, 'SIGTERM')
    proc.kill(31337, 0)
    assert.deepEqual(sent, [[777, 'SIGTERM'], [4242, 'SIGTERM'], [31337, 0]])
  })
  it('an unverifiable descendant is refused and nothing is sent', () => {
    const { proc, sent, r } = fakeInstall()
    r.policy.track(777)
    assert.throws(() => proc.kill(778, 'SIGTERM'), { code: FOREIGN_SIGNAL_ERROR_CODE })
    assert.deepEqual(sent, [])
  })
})

describe('policy (fake process table)', () => {
  const rows = (...r) => () => r.map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))

  it('walks to a descendant through several generations', () => {
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 1], [11, 10, 1], [12, 11, 1], [99, 1, 1]) })
    p.track(10)
    assert.equal(p.decide(12, 'SIGTERM'), null)
    assert.match(p.decide(99, 'SIGTERM'), /not a child/)
  })

  it('keeps an observed descendant after the table forgets its parent (reparenting)', () => {
    let table = [{ pid: 10, ppid: 1, pgid: 1 }, { pid: 11, ppid: 10, pgid: 1 }]
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: () => table })
    p.track(10)
    p.snapshot()
    table = [{ pid: 11, ppid: 1, pgid: 1 }]
    assert.equal(p.decide(11, 'SIGTERM'), null)
  })

  it('REFUSES, rather than allows, when the process table is unavailable', () => {
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: () => null })
    p.track(10)
    assert.match(p.decide(12, 'SIGTERM'), /process table is unavailable/)
  })

  it('negative pid needs a tracked or descendant leader', () => {
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 10], [11, 10, 10]) })
    p.track(10)
    assert.equal(p.decide(-10, 'SIGTERM'), null)
    assert.equal(p.decide(-11, 'SIGTERM'), null)
    assert.match(p.decide(-55, 'SIGTERM'), /not a child/)
    assert.match(p.decide(0, 'SIGTERM'), /whole process group/)
    assert.match(p.decide(-1, 'SIGTERM'), /whole process group/)
  })

  it('attributes a pgid member of a LIVE tracked leader whose parent link is gone', () => {
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 10], [20, 1, 10]) })
    p.track(10)
    assert.equal(p.decide(20, 'SIGTERM'), null)
  })

  it('an omitted signal (default SIGTERM) is refused for a foreign pid', () => {
    // Policy level only: against the real parent, a missing guard would SIGTERM the test runner.
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 1]) })
    p.track(10)
    assert.match(p.decide(99, undefined), /not a child/)
  })

  it('a recycled tracked pid (same number, new start time) is dropped and refused with its child', () => {
    let table = [{ pid: 10, ppid: 1, pgid: 1, start: 'A' }]
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: () => table })
    p.track(10)
    p.snapshot()
    table = [{ pid: 10, ppid: 1, pgid: 1, start: 'B' }, { pid: 11, ppid: 10, pgid: 1, start: 'B2' }]
    p.snapshot()
    assert.match(p.decide(10, 'SIGTERM'), /not a child|spawned none/)
    assert.match(p.decide(11, 'SIGTERM'), /not a child|spawned none/)
  })

  it('a tracked pid untracked on exit, then reissued, is refused along with the new owner\'s child', () => {
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 1], [11, 10, 1]) })
    p.track(10)
    p.untrack(10)
    assert.match(p.decide(10, 'SIGTERM'), /spawned none/)
    assert.match(p.decide(11, 'SIGTERM'), /spawned none/)
  })

  it('an observed pid that left the table is pruned and a reissued number is refused', () => {
    let table = [{ pid: 10, ppid: 1, pgid: 1, start: 'A' }, { pid: 11, ppid: 10, pgid: 1, start: 'A1' }]
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: () => table })
    p.track(10)
    assert.equal(p.decide(11, 'SIGTERM'), null)
    table = [{ pid: 50, ppid: 1, pgid: 50, start: 'Z' }, { pid: 11, ppid: 1, pgid: 50, start: 'Z1' }]
    assert.match(p.decide(11, 'SIGTERM'), /not a child/)
  })

  it('coercePid mirrors Node: coercible values become the integer, the rest are untouched', () => {
    assert.equal(coercePid(' 12 '), 12)
    assert.equal(coercePid('0x10'), 16)
    assert.equal(coercePid(''), 0)
    assert.equal(coercePid(true), 1)
    assert.equal(coercePid(false), 0)
    assert.equal(coercePid(['7']), 7)
    assert.equal(coercePid({ valueOf() { return 9 } }), 9)
    assert.equal(coercePid('1.5'), '1.5')
    assert.equal(coercePid(null), null)
    const sym = Symbol('x')
    assert.equal(coercePid(sym), sym)
    assert.equal(coercePid(1n), 1n)
    assert.equal(coercePid({ valueOf() { throw new Error('boom') } }), UNCONVERTIBLE)
  })

  it('policy: object / array / boolean / Symbol pids', () => {
    const p = createForeignSignalPolicy({ selfPid: 1000, readTable: rows([10, 1, 1]) })
    p.track(10)
    assert.match(p.decide({ valueOf() { return 99 } }, 'SIGTERM'), /not a child/)
    assert.match(p.decide(['99'], 'SIGTERM'), /not a child/)
    assert.match(p.decide(true, 'SIGTERM'), /not a child/)
    assert.match(p.decide(false, 'SIGTERM'), /whole process group/)
    assert.match(p.decide({ valueOf() { throw new Error('x') } }, 'SIGTERM'), /conversion threw/)
    assert.equal(p.decide({ valueOf() { return 10 } }, 'SIGTERM'), null)
    assert.equal(p.decide(Symbol('x'), 'SIGTERM'), null) // Node rejects a Symbol itself
  })

  it('refuses string pids by their numeric value', () => {
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 1]) })
    p.track(10)
    assert.match(p.decide('99', 'SIGTERM'), /not a child/)
    assert.match(p.decide('0', 'SIGTERM'), /whole process group/)
    assert.match(p.decide('', 'SIGTERM'), /whole process group/)
    assert.equal(p.decide('10', 'SIGTERM'), null)
  })

  it('a dead pid is allowed through (ESRCH only); a live untracked one is not', () => {
    const dead = new Set([99])
    const p = createForeignSignalPolicy({ selfPid: 1, readTable: rows([10, 1, 1]), probeDead: (pid) => dead.has(Math.abs(pid)) })
    p.track(10)
    assert.equal(p.decide(99, 'SIGKILL'), null)
    assert.equal(p.decide(-99, 'SIGKILL'), null)
    assert.match(p.decide(98, 'SIGKILL'), /not a child/)
  })

  it('parsePsTable returns null on unparseable output', () => {
    assert.equal(parsePsTable('garbage'), null)
    assert.deepEqual(parsePsTable(' 1 0 1\n'), [{ pid: 1, ppid: 0, pgid: 1, start: null }])
    assert.deepEqual(parsePsTable(' 1 0 1 Sun Nov 22 02:41:10 2026\n'), [{ pid: 1, ppid: 0, pgid: 1, start: 'Sun Nov 22 02:41:10 2026' }])
  })
})
