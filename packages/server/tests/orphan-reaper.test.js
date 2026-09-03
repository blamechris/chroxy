// #7606 — orphaned-child reaper. Every assertion below pairs a "reaps when the
// predicate holds" case with the negative that proves the guard is load-bearing
// (docs/false-safety-guards.md): flip one predicate input and the kill must
// NOT happen, or the test would stay green with the check deleted.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  parseEtime,
  parseProcessTable,
  parseLsofCwd,
  sweepOrphans,
  resolveCwdsViaLsof,
  resolveCwdsViaProcfs,
  maybeReapOrphans,
  startPeriodicOrphanReap,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
} from '../src/orphan-reaper.js'

const BASE = '/home/u/.chroxy/worktrees'
const UID = 501
const SELF = 999

const makeLogger = () => {
  const log = { _info: [], _warn: [] }
  log.info = (m) => log._info.push(m)
  log.warn = (m) => log._warn.push(m)
  return log
}

/** Build a ps table from rows `[pid, ppid, uid, etime, args]`. */
const table = (rows) => rows.map((r) => `${String(r[0]).padStart(6)} ${String(r[1]).padStart(6)} ${String(r[2]).padStart(4)} ${r[3].padStart(11)} ${r[4]}`).join('\n') + '\n'

/** Seams for a single scenario: static ps table, cwd map, recording kill. */
function seams({ rows, cwds, uid = UID, selfPid = SELF, listCalls = null }) {
  const killed = []
  const ps = table(rows)
  return {
    killed,
    deps: {
      listProcesses: () => { if (listCalls) listCalls.push(1); return ps },
      cwdOf: (pids) => new Map(pids.filter((p) => cwds[p] !== undefined).map((p) => [p, cwds[p]])),
      kill: (pid, sig) => { killed.push([pid, sig]) },
      uid,
      selfPid,
      platform: 'darwin',
      realpath: (p) => p,
    },
  }
}

describe('orphan-reaper parsers (#7606)', () => {
  it('parseEtime handles mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    assert.equal(parseEtime('00:05'), 5_000)
    assert.equal(parseEtime('12:34'), (12 * 60 + 34) * 1000)
    assert.equal(parseEtime('01:02:03'), ((1 * 60 + 2) * 60 + 3) * 1000)
    assert.equal(parseEtime('07-11:42:58'), (((7 * 24 + 11) * 60 + 42) * 60 + 58) * 1000)
  })

  it('parseEtime returns null (never a number) for garbage', () => {
    for (const bad of ['', 'abc', '5', '1:2:3:4', undefined, null]) {
      assert.equal(parseEtime(bad), null, `etime ${JSON.stringify(bad)}`)
    }
  })

  it('parseProcessTable keeps args with spaces and drops malformed rows', () => {
    const rows = parseProcessTable(table([
      [11839, 1, 501, '07-11:42:58', 'node --test --test-force-exit tests/x.test.js'],
      [12, 11, 501, '00:01', 'sh'],
    ]) + 'garbage line\n')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], { pid: 11839, ppid: 1, uid: 501, ageMs: parseEtime('07-11:42:58'), args: 'node --test --test-force-exit tests/x.test.js' })
    assert.equal(rows[1].args, 'sh')
  })

  it('parseLsofCwd pairs p/n lines and omits a pid with no n line', () => {
    const m = parseLsofCwd('p11839\nn/a/b\np12\np13\nn/c\n')
    assert.deepEqual([...m.entries()], [[11839, '/a/b'], [13, '/c']])
  })
})

describe('sweepOrphans predicate (#7606)', () => {
  const OLD = '01:00:00'
  const leaked = (over = {}) => ({
    rows: [[11839, 1, UID, OLD, 'node --test tests/x.test.js']],
    cwds: { 11839: join(BASE, '9aa8ab56', 'packages', 'server') },
    ...over,
  })

  it('reaps a ppid-1, own-uid, old process whose cwd is under the worktree base', () => {
    const { killed, deps } = seams(leaked())
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [[11839, 'SIGKILL']])
    assert.equal(r.reaped.length, 1)
    assert.equal(r.reaped[0].args, 'node --test tests/x.test.js')
    assert.equal(r.error, null)
  })

  it('does NOT reap when the parent is alive (ppid != 1)', () => {
    const { killed, deps } = seams(leaked({ rows: [[11839, 4242, UID, OLD, 'node']] }))
    sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
  })

  it('does NOT reap another uid\'s process', () => {
    const { killed, deps } = seams(leaked({ rows: [[11839, 1, UID + 1, OLD, 'node']] }))
    sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
  })

  it('does NOT reap a process younger than minAgeMs', () => {
    const { killed, deps } = seams(leaked({ rows: [[11839, 1, UID, '09:59', 'node']] }))
    sweepOrphans({ worktreeBase: BASE, minAgeMs: 10 * 60 * 1000, deps })
    assert.deepEqual(killed, [])
    // …and exactly at the threshold it does.
    const again = seams(leaked({ rows: [[11839, 1, UID, '10:00', 'node']] }))
    sweepOrphans({ worktreeBase: BASE, minAgeMs: 10 * 60 * 1000, deps: again.deps })
    assert.deepEqual(again.killed, [[11839, 'SIGKILL']])
  })

  it('does NOT reap a process whose cwd is outside the base, including a sibling-prefix dir', () => {
    for (const cwd of ['/home/u/Projects/chroxy', BASE + '-other/x', '/home/u/.chroxy']) {
      const { killed, deps } = seams(leaked({ cwds: { 11839: cwd } }))
      sweepOrphans({ worktreeBase: BASE, deps })
      assert.deepEqual(killed, [], `cwd ${cwd}`)
    }
  })

  it('never signals the daemon itself', () => {
    const { killed, deps } = seams(leaked({ rows: [[SELF, 1, UID, OLD, 'node cli.js start']], cwds: { [SELF]: BASE + '/x' } }))
    sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
  })

  it('skips (never guesses) a candidate whose cwd could not be resolved — counted, not warned', () => {
    const { killed, deps } = seams(leaked({ cwds: {} }))
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
    assert.deepEqual(r.skipped, [])
    assert.equal(r.unresolved, 1)
  })

  it('refuses to sweep as root (uid 0 matches every process)', () => {
    const { killed, deps } = seams(leaked({ uid: 0, rows: [[11839, 1, 0, OLD, 'node']] }))
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
    assert.match(r.error, /running as root/)
  })

  it('compares against the REAL path of the base (lsof/procfs report resolved paths)', () => {
    // Base is a symlink `/tmp/wt` -> `/private/tmp/wt`; the process cwd is the real path.
    const { killed, deps } = seams(leaked({ cwds: { 11839: '/private/tmp/wt/abc' } }))
    deps.realpath = (p) => (p === '/tmp/wt' ? '/private/tmp/wt' : p)
    sweepOrphans({ worktreeBase: '/tmp/wt', deps })
    assert.deepEqual(killed, [[11839, 'SIGKILL']])
    // …and without resolution the same input would NOT match (proves the seam is load-bearing).
    const again = seams(leaked({ cwds: { 11839: '/private/tmp/wt/abc' } }))
    sweepOrphans({ worktreeBase: '/tmp/wt', deps: again.deps })
    assert.deepEqual(again.killed, [])
  })

  it('a base that does not exist yet is used as-is (nothing can be under it)', () => {
    const { killed, deps } = seams(leaked({ cwds: { 11839: '/nope/x' } }))
    deps.realpath = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    const r = sweepOrphans({ worktreeBase: '/nope', deps })
    assert.deepEqual(killed, [[11839, 'SIGKILL']])
    assert.equal(r.error, null)
  })

  it('treats an unavailable cwd mechanism as "cannot check": error, nothing killed', () => {
    const { killed, deps } = seams(leaked())
    deps.cwdOf = () => { throw new Error('spawn lsof ENOENT') }
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
    assert.match(r.error, /cwd lookup unavailable.*ENOENT/)
  })

  it('treats a failed ps as "cannot check": error, nothing killed', () => {
    const { killed, deps } = seams(leaked())
    deps.listProcesses = () => { throw new Error('ps failed') }
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
    assert.match(r.error, /process listing failed/)
  })

  it('re-verifies identity before signalling: a recycled pid (fresh etime) is skipped', () => {
    const { killed, deps } = seams(leaked())
    let call = 0
    deps.listProcesses = () => {
      call += 1
      // First listing: the leak. Second (re-verify): same pid, brand-new process.
      return call === 1
        ? table([[11839, 1, UID, OLD, 'node --test']])
        : table([[11839, 1, UID, '00:01', 'vim']])
    }
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
    assert.equal(call, 2, 'must list twice')
    assert.deepEqual(r.skipped, [{ pid: 11839, reason: 'pid changed identity between listings' }])
  })

  it('re-verify: a target that exited between listings is silently dropped', () => {
    const { killed, deps } = seams(leaked())
    let call = 0
    deps.listProcesses = () => (++call === 1 ? table([[11839, 1, UID, OLD, 'node']]) : '')
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(killed, [])
    assert.deepEqual(r.skipped, [])
    assert.deepEqual(r.reaped, [])
  })

  it('does not re-list at all when no candidate is under the base (cheap tick)', () => {
    const listCalls = []
    const { deps } = seams(leaked({ cwds: { 11839: '/elsewhere' }, listCalls }))
    sweepOrphans({ worktreeBase: BASE, deps })
    assert.equal(listCalls.length, 1)
  })

  it('records a kill failure as skipped rather than throwing', () => {
    const { deps } = seams(leaked())
    deps.kill = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e }
    const r = sweepOrphans({ worktreeBase: BASE, deps })
    assert.deepEqual(r.skipped, [{ pid: 11839, reason: 'kill failed: EPERM' }])
  })

  it('is a no-op on win32 and with no worktree base', () => {
    const { killed, deps } = seams(leaked())
    assert.deepEqual(sweepOrphans({ worktreeBase: BASE, deps: { ...deps, platform: 'win32' } }).reaped, [])
    assert.match(sweepOrphans({ worktreeBase: '', deps }).error, /no worktree base/)
    assert.deepEqual(killed, [])
  })
})

describe('cwd resolvers (#7608 review)', () => {
  it('lsof: a nonzero exit WITH stdout is a partial result, not a failure', () => {
    const err = Object.assign(new Error('Command failed: lsof'), { status: 1, stdout: 'p411\nfcwd\nn/a/b\n' })
    const exec = () => { throw err }
    assert.deepEqual([...resolveCwdsViaLsof([411, 999999], exec).entries()], [[411, '/a/b']])
  })

  it('lsof: ENOENT / timeout (no status, or no stdout) propagates as unavailable', () => {
    for (const e of [Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }), Object.assign(new Error('timeout'), { status: null, signal: 'SIGTERM', stdout: null })]) {
      assert.throws(() => resolveCwdsViaLsof([1], () => { throw e }))
    }
  })

  it('lsof partial failure end-to-end: the resolvable orphan is still reaped', () => {
    const killed = []
    const err = Object.assign(new Error('lsof exit 1'), { status: 1, stdout: 'p11839\nn' + join(BASE, 'abc') + '\n' })
    const r = sweepOrphans({
      worktreeBase: BASE,
      deps: {
        listProcesses: () => table([[11839, 1, UID, '01:00:00', 'node --test'], [999999, 1, UID, '01:00:00', 'gone']]),
        cwdOf: (pids) => resolveCwdsViaLsof(pids, () => { throw err }),
        kill: (pid, sig) => killed.push([pid, sig]),
        uid: UID, selfPid: SELF, platform: 'darwin', realpath: (p) => p,
      },
    })
    assert.deepEqual(killed, [[11839, 'SIGKILL']])
    assert.equal(r.error, null)
    assert.equal(r.unresolved, 1)
  })

  it('procfs: one unreadable pid is skipped, but NOTHING readable is "cannot check"', () => {
    const readlink = (p) => { if (p === '/proc/1/cwd') return '/x'; throw new Error('EACCES') }
    assert.deepEqual([...resolveCwdsViaProcfs([1, 2], readlink).entries()], [[1, '/x']])
    assert.throws(() => resolveCwdsViaProcfs([1, 2], () => { throw new Error('EACCES') }), /procfs unavailable/)
    assert.deepEqual([...resolveCwdsViaProcfs([], () => { throw new Error('x') }).entries()], [])
  })
})

describe('maybeReapOrphans / startPeriodicOrphanReap (#7606)', () => {
  const leakDeps = (killed) => ({
    listProcesses: () => table([[11839, 1, UID, '02:00:00', 'node --test']]),
    cwdOf: () => new Map([[11839, join(BASE, 'abc')]]),
    kill: (pid, sig) => killed.push([pid, sig]),
    uid: UID,
    selfPid: SELF,
    platform: 'darwin',
    realpath: (p) => p,
    worktreeBase: BASE,
  })

  it('is ON by default and OFF only with enabled:false', () => {
    for (const cfg of [undefined, {}, { orphanReap: {} }, { orphanReap: { enabled: true } }]) {
      const killed = []
      const r = maybeReapOrphans(cfg, makeLogger(), leakDeps(killed))
      assert.equal(r.reaped.length, 1, `config ${JSON.stringify(cfg)}`)
      assert.deepEqual(killed, [[11839, 'SIGKILL']])
    }
    const killed = []
    assert.equal(maybeReapOrphans({ orphanReap: { enabled: false } }, makeLogger(), leakDeps(killed)), null)
    assert.deepEqual(killed, [])
  })

  it('logs each kill with pid, age, cwd and args, and a summary', () => {
    const log = makeLogger()
    maybeReapOrphans({}, log, leakDeps([]))
    assert.ok(log._warn.some((m) => /killed pid 11839 \(ppid 1, 120 min, cwd .*abc\): node --test/.test(m)), JSON.stringify(log._warn))
    assert.ok(log._info.some((m) => /reaped 1 orphan\(s\)/.test(m)), JSON.stringify(log._info))
  })

  it('honours orphanReap.minAgeMs and falls back to the default on a bad value', () => {
    const killed = []
    const deps = { ...leakDeps(killed), listProcesses: () => table([[11839, 1, UID, '00:30', 'node']]) }
    maybeReapOrphans({ orphanReap: { minAgeMs: 10_000 } }, makeLogger(), deps)
    assert.deepEqual(killed, [[11839, 'SIGKILL']], '30s old, 10s threshold → reaped')
    killed.length = 0
    maybeReapOrphans({ orphanReap: { minAgeMs: 'soon' } }, makeLogger(), deps)
    assert.deepEqual(killed, [], `bad value → default ${DEFAULT_MIN_AGE_MS}ms → not reaped`)
  })

  it('warns (and reaps nothing) when the sweep cannot check', () => {
    const log = makeLogger()
    const killed = []
    maybeReapOrphans({}, log, { ...leakDeps(killed), cwdOf: () => { throw new Error('ENOENT') } })
    assert.deepEqual(killed, [])
    assert.ok(log._warn.some((m) => /sweep skipped/.test(m)))
  })

  const makeIntervalSeam = () => {
    const calls = []
    const setIntervalFn = (fn, ms) => {
      const handle = { _id: calls.length + 1, unref: () => { handle.unrefed = true } }
      calls.push({ fn, ms, handle })
      return handle
    }
    return { calls, setIntervalFn }
  }

  it('startPeriodicOrphanReap: boot sweep now, unref\'d interval at the default cadence', () => {
    const { calls, setIntervalFn } = makeIntervalSeam()
    let runs = 0
    const timer = startPeriodicOrphanReap({}, makeLogger(), { run: () => { runs++ }, setIntervalFn, platform: 'darwin' })
    assert.equal(runs, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].ms, DEFAULT_SWEEP_INTERVAL_MS)
    assert.equal(timer.unrefed, true)
    calls[0].fn()
    assert.equal(runs, 2)
  })

  it('startPeriodicOrphanReap: honours sweepIntervalMs, is null when disabled or on win32', () => {
    const { calls, setIntervalFn } = makeIntervalSeam()
    startPeriodicOrphanReap({ orphanReap: { sweepIntervalMs: 1234 } }, makeLogger(), { run: () => {}, setIntervalFn, platform: 'darwin' })
    assert.equal(calls[0].ms, 1234)
    const run = () => { throw new Error('must not run') }
    assert.equal(startPeriodicOrphanReap({ orphanReap: { enabled: false } }, makeLogger(), { run, setIntervalFn, platform: 'darwin' }), null)
    assert.equal(startPeriodicOrphanReap({}, makeLogger(), { run, setIntervalFn, platform: 'win32' }), null)
  })

  it('startPeriodicOrphanReap: a throwing sweep is logged and the interval survives', () => {
    const { calls, setIntervalFn } = makeIntervalSeam()
    const log = makeLogger()
    let n = 0
    const run = () => { n++; if (n === 1) throw new Error('boom') }
    startPeriodicOrphanReap({}, log, { run, setIntervalFn, platform: 'darwin' })
    assert.ok(log._warn.some((m) => /orphan-reaper failed: boom/.test(m)))
    calls[0].fn()
    assert.equal(n, 2)
  })
})
