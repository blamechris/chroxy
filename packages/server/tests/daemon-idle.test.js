import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { computeDaemonIdleState, PROVIDER_QUIET_WINDOW_MS } from '../src/daemon-idle-state.js'
import { createHttpHandler } from '../src/http-routes.js'
import { WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { BaseSession, PROVIDER_ACTIVITY_EVENTS } from '../src/base-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { PROXIED_SESSION_EVENTS } from '../src/session-manager.js'
import { CliSession } from '../src/cli-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { busyStateOf } from '../src/session-busy-state.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DAEMON_COMMIT, isSameDirectory, resolveRepoCommit } from '../src/daemon-commit.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #8324 — GET /api/daemon/idle, the probe the idle-only auto-deploy asks before
// it restarts the daily daemon. The verdict must be "idle" ONLY when nothing
// would be lost, and every inability to check must read as NOT idle.

function row(over = {}) {
  return {
    sessionId: 's1',
    name: 'main',
    isBusy: false,
    busyReason: null,
    backgroundShellCount: 0,
    ...over,
  }
}

function fakeManager(rows, sessionById = {}) {
  const sessions = new Map()
  for (const r of rows) {
    sessions.set(r.sessionId, {
      session: {
        getPendingPermissionCount: () => 0,
        getPendingQuestions: () => [],
        getRestartBlockers: () => [],
        providerActivityAgeMs: null,
        ...(sessionById[r.sessionId] || {}),
      },
    })
  }
  return {
    listSessions: () => rows,
    getSession: (id) => sessions.get(id) ?? null,
  }
}

describe('computeDaemonIdleState (#8324)', () => {
  it('is idle with no sessions and no hook permissions', () => {
    const out = computeDaemonIdleState({ sessionManager: fakeManager([]), getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, true)
    assert.deepEqual(out.reasons, [])
    assert.deepEqual(out.sessions, [])
    assert.equal(out.hookPendingPermissions, 0)
  })

  it('is idle when sessions exist but none is busy or waiting on a human', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row(), row({ sessionId: 's2', name: 'two' })]),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, true)
    assert.equal(out.sessions.length, 2)
    assert.deepEqual(Object.keys(out.sessions[0]).sort(), [
      'backgroundShellCount', 'busyReason', 'isBusy', 'name', 'pendingPermissions', 'pendingQuestions', 'providerActivityAgeMs', 'restartBlockers', 'sessionId',
    ])
  })

  it('a mid-turn session is not idle and says why', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row({ isBusy: true, busyReason: 'turn' })]),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.includes('session "main" busy: turn'))
  })

  it('a session held busy by a background shell is not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row({ isBusy: true, busyReason: 'background-shells', backgroundShellCount: 2 })]),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.includes('session "main" busy: background-shells'))
    assert.equal(out.sessions[0].backgroundShellCount, 2)
  })

  it('a pending permission makes it not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row()], { s1: { getPendingPermissionCount: () => 1 } }),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.equal(out.sessions[0].pendingPermissions, 1)
  })

  it('a pending AskUserQuestion makes it not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row()], { s1: { getPendingQuestions: () => [{ toolUseId: 't', questions: [] }] } }),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.equal(out.sessions[0].pendingQuestions, 1)
  })

  it('a hook-routed pending permission makes it not idle', () => {
    const out = computeDaemonIdleState({ sessionManager: fakeManager([row()]), getHookPendingPermissionCount: () => 2 })
    assert.equal(out.idle, false)
    assert.equal(out.hookPendingPermissions, 2)
  })

  it('FAIL SAFE: a missing session manager is not idle', () => {
    for (const sessionManager of [null, undefined, {}]) {
      const out = computeDaemonIdleState({ sessionManager })
      assert.equal(out.idle, false)
      assert.ok(out.reasons.length > 0)
    }
  })

  it('FAIL SAFE: listSessions() throwing is not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: { listSessions: () => { throw new Error('boom') } },
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('boom')))
  })

  it('FAIL SAFE: an accessor throwing is not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row()], { s1: { getPendingQuestions: () => { throw new Error('q-broke') } } }),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('q-broke')))
  })

  it('FAIL SAFE: a provider with no accessor (cannot say) is not idle', () => {
    const mgr = fakeManager([row()])
    mgr.getSession = () => ({ session: {} })
    const out = computeDaemonIdleState({ sessionManager: mgr, getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, false)
  })

  it('FAIL SAFE: a row whose session vanished is not idle', () => {
    const mgr = fakeManager([row()])
    mgr.getSession = () => null
    const out = computeDaemonIdleState({ sessionManager: mgr, getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, false)
  })

  it('FAIL SAFE: the hook-permission accessor throwing or returning junk is not idle', () => {
    for (const fn of [() => { throw new Error('hook-broke') }, () => NaN, () => -1, () => '0']) {
      const out = computeDaemonIdleState({ sessionManager: fakeManager([row()]), getHookPendingPermissionCount: fn })
      assert.equal(out.idle, false)
    }
  })
})

// A manager over ONE real session. `isBusy` / `busyReason` come from the real
// session through the same `busyStateOf` the real listSessions() uses, so these
// cases cannot be satisfied by hand-setting a flag the probe reads.
function realManager(session) {
  return {
    listSessions: () => [{ sessionId: 'r1', name: 'real', isBusy: !!session.isRunning, ...busyStateOf(session) }],
    getSession: (id) => (id === 'r1' ? { session } : null),
  }
}
const probe = (session) => computeDaemonIdleState({ sessionManager: realManager(session), getHookPendingPermissionCount: () => 0 })

describe('restart blockers: real session lifecycles (#8324)', () => {
  it('a background agent that outlives a cleanly ended turn blocks the restart while isBusy reads idle', () => {
    const s = new BaseSession()
    let clock = 0
    s._providerActivityClock = () => clock
    assert.equal(probe(s).idle, true, 'a fresh session is idle')
    s._trackAgent({ toolUseId: 'agent-1', description: 'research', background: true, authoritative: true })
    // #8743: the spawn is provider activity; step past its quiet window so the
    // agent is the only thing that can block.
    clock += PROVIDER_QUIET_WINDOW_MS
    s._clearMessageState({ turnEndedCleanly: true })
    assert.equal(s.isRunning, false, 'premise: the turn is over and isBusy is false')
    assert.equal(s._activeAgents.size, 1, 'premise: the agent survived the turn end')
    const out = probe(s)
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('restart blocked') && r.includes('background agent')), out.reasons.join('|'))
    s._activeAgents.clear()
    assert.equal(probe(s).idle, true, 'idle again once the agent is gone')
  })

  it('input accepted into the outgoing queue but not yet dispatched blocks the restart', () => {
    const s = new BaseSession()
    assert.ok(s.enqueueOutgoingMessage({ prompt: 'follow-up' }))
    const out = probe(s)
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('queued message')))
    s.clearOutgoingQueue({ emit: false })
    assert.equal(probe(s).idle, true)
  })

  describe('CliSession', () => {
    const made = []
    afterEach(() => {
      for (const c of made) { c._child = null; try { const r = c.destroy(); if (r?.catch) r.catch(() => {}) } catch {} }
      made.length = 0
    })

    it('a message acknowledged as queued while the CLI is not ready blocks the restart', () => {
      const c = new CliSession({ cwd: '/tmp' })
      made.push(c)
      c._processReady = false
      c.sendMessage('hello while warming up')
      assert.equal(c._pendingQueue.length, 1, 'premise: it landed in _pendingQueue')
      assert.equal(c.isRunning, false, 'premise: not busy')
      assert.equal(c._outgoingQueue.length, 0, 'premise: NOT in the base queue the base blocker reads')
      const out = probe(c)
      assert.equal(out.idle, false)
      assert.ok(out.reasons.some((r) => r.includes('queued while the CLI is not ready')), out.reasons.join('|'))
    })

    it('an empty CliSession is idle', () => {
      const c = new CliSession({ cwd: '/tmp' })
      made.push(c)
      assert.equal(probe(c).idle, true)
    })
  })

  describe('ClaudeTuiSession', () => {
    let skills
    let tui
    let clock
    beforeEach(() => {
      skills = mkdtempSync(join(tmpdir(), 'chroxy-idle-skills-'))
      clock = 1_000_000
      tui = new ClaudeTuiSession({ cwd: '/tmp', skillsDir: skills, repoSkillsDir: null, monotonicNow: () => clock })
      tui.on('error', () => {})
    })
    afterEach(async () => {
      try { await tui.destroy() } catch { /* ignore */ }
      rmSync(skills, { recursive: true, force: true })
    })

    it('terminal INPUT blocks for 10 minutes even after the PTY has been silent for over 30s', () => {
      tui._term = { write: () => {} } // the narrowest real PTY: writeTerminalInput only needs write()
      assert.equal(tui.writeTerminalInput('hello\r'), true)
      assert.equal(tui.isRunning, false, 'premise: isBusy never saw this turn')
      assert.equal(tui._sawFirstOutput, false, 'premise: no output stamp at all, so output silence cannot be what blocks')
      let out = probe(tui)
      assert.equal(out.idle, false)
      assert.ok(out.reasons.some((r) => r.includes('terminal input in the last 10m')), out.reasons.join('|'))
      clock += 5 * 60_000
      assert.equal(probe(tui).idle, false, 'still inside the window after 5m')
      clock += 5 * 60_000 - 1000
      assert.equal(probe(tui).idle, false, '9m59s')
      clock += 2000
      assert.equal(probe(tui).idle, true, 'quiet and past 10m')
    })

    it('a REJECTED terminal write does not start the window', () => {
      assert.equal(tui.writeTerminalInput('x'), false, 'no PTY')
      assert.equal(probe(tui).idle, true)
    })

    it('keeps the base blockers: a background agent on a TUI still blocks', () => {
      tui._trackAgent({ toolUseId: 'agent-t', background: true, authoritative: true })
      tui._clearMessageState({ turnEndedCleanly: true })
      const out = probe(tui)
      assert.equal(out.idle, false)
      assert.ok(out.reasons.some((r) => r.includes('background agent')), out.reasons.join('|'))
    })

    it('recent terminal output (a turn typed straight into the PTY) blocks the restart; 30s of quiet clears it', () => {
      assert.equal(probe(tui).idle, true, 'no output yet: nothing to lose')
      tui._appendToOutputTail('\x1b[2K working...\r\n') // the real PTY-output hook, stamps _lastOutputMs
      assert.equal(tui.isRunning, false, 'premise: isBusy never saw this turn')
      const out = probe(tui)
      assert.equal(out.idle, false)
      assert.ok(out.reasons.some((r) => r.includes('terminal output in the last 30s')), out.reasons.join('|'))
      clock += 29_000
      assert.equal(probe(tui).idle, false, 'still inside the window')
      clock += 2_000
      assert.equal(probe(tui).idle, true, 'quiet for 31s')
    })
  })
})

describe('daemon commit (#8324)', () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[k]
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-commit-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a real checkout reports its HEAD', () => {
    g(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'f'), 'x')
    g(dir, 'add', 'f')
    g(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one')
    const head = g(dir, 'rev-parse', 'HEAD')
    assert.match(head, /^[0-9a-f]{40}$/)
    assert.equal(resolveRepoCommit(dir), head)
  })

  it('a directory that is not a git checkout is null', () => {
    assert.equal(resolveRepoCommit(dir), null)
  })

  it('a subdirectory of someone else\'s checkout is null, not that checkout\'s HEAD', () => {
    g(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'f'), 'x')
    g(dir, 'add', 'f')
    g(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one')
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    assert.equal(resolveRepoCommit(join(dir, 'node_modules', 'pkg')), null)
  })

  it('a checkout with no commit yet is null', () => {
    g(dir, 'init', '-q', '-b', 'main')
    assert.equal(resolveRepoCommit(dir), null)
  })

  it('the git environment carries no GIT_* variable (any case) and none of the daemon\'s own secrets (any case)', () => {
    const secrets = ['API_TOKEN', 'CHROXY_HOOK_SECRET', 'CHROXY_PORT', 'CHROXY_INGEST_SECRET', 'Api_Token', 'chroxy_ingest_secret', 'Git_Work_Tree', 'git_config_count']
    const saved = Object.fromEntries(secrets.map((k) => [k, process.env[k]]))
    for (const k of secrets) process.env[k] = 'x'
    let seen
    try {
      resolveRepoCommit(dir, { spawn: (c, a, o) => { seen = o.env; return { status: 1, stdout: '' } } })
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
    for (const k of Object.keys(seen)) {
      assert.ok(!k.toUpperCase().startsWith('GIT_'), `${k} must not reach git`)
      assert.ok(!['API_TOKEN', 'CHROXY_HOOK_SECRET', 'CHROXY_PORT', 'CHROXY_INGEST_SECRET'].includes(k.toUpperCase()), `${k} must not reach git`)
    }
    // Windows spells it `Path`; a plain-object copy keeps that spelling.
    assert.ok(Object.keys(seen).some((k) => k.toUpperCase() === 'PATH'), 'but the rest of the environment is intact')
  })

  it('isSameDirectory: Windows-shaped inputs (forward vs back slashes, drive-letter case, 8.3 short names)', () => {
    const win = { path: path.win32, windows: true }
    const longOf = (p) => p.replace(/RUNNER~1/i, 'runners') // a stand-in for realpath.native expanding a short name
    const same = (a, b, extra = {}) => isSameDirectory(a, b, { ...win, realpath: longOf, ...extra })
    assert.equal(same('A:/runners/_work/repo', 'A:\\runners\\_work\\repo'), true, 'git prints / and the runner has \\')
    assert.equal(same('a:/runners/_work/repo', 'A:\\runners\\_work\\repo'), true, 'drive-letter case')
    assert.equal(same('A:/Runners/_Work/Repo', 'a:\\runners\\_work\\repo'), true, 'case-insensitive on Windows')
    assert.equal(same('A:/runners/_work/repo', 'A:\\RUNNER~1\\_work\\repo'), true, '8.3 short name vs long name')
    assert.equal(same('A:/runners/_work/repo/', 'A:\\runners\\_work\\repo'), true, 'trailing slash')
    assert.equal(same('A:/runners/_work/repo', 'A:\\runners\\_work\\repo\\sub'), false, 'a subdirectory is NOT the same directory')
    assert.equal(same('A:/runners/_work/other', 'A:\\runners\\_work\\repo'), false, 'a different directory')
    assert.equal(same('B:/runners/_work/repo', 'A:\\runners\\_work\\repo'), false, 'a different drive')
    // POSIX: exact, and case-SENSITIVE.
    const posix = { path: path.posix, windows: false, realpath: (p) => p }
    assert.equal(isSameDirectory('/a/b', '/a/b/', posix), true)
    assert.equal(isSameDirectory('/a/B', '/a/b', posix), false, 'case matters off Windows')
    assert.equal(isSameDirectory('/a/b/c', '/a/b', posix), false)
    // A path that cannot be resolved is simply "not the same", never a throw.
    assert.equal(isSameDirectory('/x', '/y', { ...posix, realpath: () => { throw new Error('ENOENT') } }), false)
  })

  it('retries once: a first attempt that fails (a CPU-starved timeout) does not make a good build report null', () => {
    g(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'f'), 'x')
    g(dir, 'add', 'f')
    g(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one')
    const head = g(dir, 'rev-parse', 'HEAD')
    let calls = 0
    const spawn = (cmd, args, opts) => {
      calls++
      if (calls === 1) return { status: null, stdout: '', error: new Error('ETIMEDOUT') }
      return spawnSync(cmd, args, opts)
    }
    assert.equal(resolveRepoCommit(dir, { spawn }), head)
    assert.equal(calls, 2)
    let seen
    resolveRepoCommit(dir, { spawn: (c, a, o) => { seen = o; return spawnSync(c, a, o) } })
    assert.equal(seen.timeout, 5000, 'a 5s timeout per attempt')
    let n = 0
    assert.equal(resolveRepoCommit(dir, { spawn: () => { n++; return { status: 1, stdout: '' } } }), null)
    assert.equal(n, 2, 'one retry, not an endless loop')
  })

  it('no GIT_* variable reaches git: GIT_DIR pointing at ANOTHER repo cannot change the answer', () => {
    const other = mkdtempSync(join(tmpdir(), 'chroxy-commit-other-'))
    try {
      g(other, 'init', '-q', '-b', 'main')
      writeFileSync(join(other, 'f'), 'y')
      g(other, 'add', 'f')
      g(other, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'other')
      const otherHead = g(other, 'rev-parse', 'HEAD')
      g(dir, 'init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'f'), 'x')
      g(dir, 'add', 'f')
      g(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one')
      const mine = g(dir, 'rev-parse', 'HEAD')
      assert.notEqual(otherHead, mine)
      const saved = { GIT_DIR: process.env.GIT_DIR, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }
      process.env.GIT_DIR = join(other, '.git')
      process.env.GIT_COMMON_DIR = join(other, '.git')
      process.env.GIT_CEILING_DIRECTORIES = dir
      let seenEnv
      try {
        const got = resolveRepoCommit(dir, { spawn: (c, a, o) => { seenEnv = o.env; return spawnSync(c, a, o) } })
        assert.equal(got, mine, 'this repo\'s sha, never the other repo\'s')
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      }
      assert.deepEqual(Object.keys(seenEnv).filter((k) => k.startsWith('GIT_')), [], 'not one GIT_* key was passed through')
    } finally { rmSync(other, { recursive: true, force: true }) }
  })

  it('every failure shape is null and never throws', () => {
    const sha = 'a'.repeat(40)
    const cases = {
      'non-zero exit': () => ({ status: 128, stdout: '', error: null }),
      'spawn error (git missing / timeout)': () => ({ status: null, stdout: '', error: new Error('ENOENT') }),
      'throws': () => { throw new Error('boom') },
      'no result': () => undefined,
      'empty output': () => ({ status: 0, stdout: '' }),
      'short sha': () => ({ status: 0, stdout: `${dir}\n${'a'.repeat(39)}\n` }),
      'uppercase sha': () => ({ status: 0, stdout: `${dir}\n${'A'.repeat(40)}\n` }),
      'extra output lines': () => ({ status: 0, stdout: `${dir}\n${sha}\nmore\n` }),
      'only the sha (no toplevel)': () => ({ status: 0, stdout: `${sha}\n` }),
      'toplevel is a different directory': () => ({ status: 0, stdout: `${tmpdir()}\n${sha}\n` }),
      'toplevel does not exist': () => ({ status: 0, stdout: `/nonexistent-${process.pid}\n${sha}\n` }),
      'non-string stdout': () => ({ status: 0, stdout: Buffer.from('x') }),
    }
    for (const [name, spawn] of Object.entries(cases)) {
      assert.equal(resolveRepoCommit(dir, { spawn }), null, name)
    }
  })

  it('/api/daemon/idle reports the daemon commit (a 40-hex sha or null)', async () => {
    assert.ok(DAEMON_COMMIT === null || /^[0-9a-f]{40}$/.test(DAEMON_COMMIT), String(DAEMON_COMMIT))
    const server = {
      apiToken: 't', authRequired: true, _startedAt: Date.now(), sessionManager: fakeManager([row()]), getHookPendingPermissionCount: () => 0,
      _validatePrimaryBearerAuth: () => true,
    }
    const srv = createServer(createHttpHandler(server))
    srv.listen(0, '127.0.0.1')
    await once(srv, 'listening')
    try {
      const body = await (await globalThis.fetch(`http://127.0.0.1:${srv.address().port}/api/daemon/idle`)).json()
      assert.ok('commit' in body, 'the field is always present')
      assert.equal(body.commit, DAEMON_COMMIT)
    } finally { srv.close() }
  })
})

describe('restart blockers fail closed (#8324)', () => {
  const withSession = (session) => computeDaemonIdleState({
    sessionManager: { listSessions: () => [row()], getSession: () => ({ session }) },
    getHookPendingPermissionCount: () => 0,
  })
  const base = { getPendingPermissionCount: () => 0, getPendingQuestions: () => [], providerActivityAgeMs: null }

  it('a missing accessor is not idle', () => {
    assert.equal(withSession({ ...base }).idle, false)
  })
  it('a throwing accessor is not idle', () => {
    const out = withSession({ ...base, getRestartBlockers: () => { throw new Error('rb-broke') } })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('rb-broke')))
  })
  it('a non-array result is not idle; any entry at all is a reason and blocks too', () => {
    for (const v of [undefined, null, 'none', 0, {}, [''], [1], [null]]) {
      assert.equal(withSession({ ...base, getRestartBlockers: () => v }).idle, false, JSON.stringify(v))
    }
  })
  it('an empty array is idle and a non-empty one is not, with the reasons relayed', () => {
    assert.equal(withSession({ ...base, getRestartBlockers: () => [] }).idle, true)
    const out = withSession({ ...base, getRestartBlockers: () => ['thing A', 'thing B'] })
    assert.equal(out.idle, false)
    assert.deepEqual(out.sessions[0].restartBlockers, ['thing A', 'thing B'])
    assert.ok(out.reasons.includes('session "main" restart blocked: thing A'))
  })
})

describe('BaseSession.getPendingPermissionCount (#8324)', () => {
  it('counts hook-routed ids and in-process pending permissions together', () => {
    const s = new BaseSession()
    assert.equal(s.getPendingPermissionCount(), 0)
    s.notifyPermissionPending('hook-1')
    assert.equal(s.getPendingPermissionCount(), 1)
    s._pendingPermissions = new Map([['p1', {}], ['p2', {}]])
    assert.equal(s.getPendingPermissionCount(), 3)
    s.notifyPermissionResolved('hook-1')
    assert.equal(s.getPendingPermissionCount(), 2)
  })
})

describe('GET /api/daemon/idle route (#8324)', () => {
  let httpServer
  let pm
  afterEach(() => {
    httpServer?.close()
    httpServer = null
    pm?.destroy()
    pm = null
  })

  // The REAL auth methods, bound to a minimal stand-in, so the gate under test
  // is the shipped one rather than a mock that agrees with the test.
  function makeServer(overrides = {}) {
    pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    const server = {
      apiToken: 'test-token',
      authRequired: true,
      serverMode: 'multi',
      _startedAt: Date.parse('2026-10-06T00:00:00Z'),
      _gitInfo: { commit: 'abc', branch: 'main' },
      _pairingManager: pm,
      sessionManager: fakeManager([row()]),
      getHookPendingPermissionCount: () => 0,
      _isTokenValid(token) { return token === this.apiToken || pm.isSessionTokenValid(token) },
      ...overrides,
    }
    server._validatePrimaryBearerAuth = WsServer.prototype._validatePrimaryBearerAuth.bind(server)
    server._validateBearerAuth = WsServer.prototype._validateBearerAuth.bind(server)
    return server
  }

  async function start(server) {
    httpServer = createServer(createHttpHandler(server))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    return httpServer.address().port
  }

  const get = (port, headers = {}) => globalThis.fetch(`http://127.0.0.1:${port}/api/daemon/idle`, { headers })

  it('primary token over loopback: 200 with the documented shape', async () => {
    const port = await start(makeServer())
    const res = await get(port, { Authorization: 'Bearer test-token' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.idle, true)
    assert.deepEqual(body.reasons, [])
    assert.equal(body.sessions.length, 1)
    assert.equal(body.sessions[0].providerActivityAgeMs, null, 'each session says how long its provider has been silent (#8743)')
    assert.equal(body.hookPendingPermissions, 0)
    assert.equal(typeof body.version, 'string')
    assert.equal(body.pid, process.pid)
    assert.equal(body.startedAt, '2026-10-06T00:00:00.000Z')
  })

  it('a busy session answers idle:false with the reason', async () => {
    const port = await start(makeServer({ sessionManager: fakeManager([row({ isBusy: true, busyReason: 'turn' })]) }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
    assert.ok(body.reasons.includes('session "main" busy: turn'))
  })

  it('a pending permission or question answers idle:false', async () => {
    let port = await start(makeServer({
      sessionManager: fakeManager([row()], { s1: { getPendingPermissionCount: () => 1 } }),
    }))
    assert.equal((await (await get(port, { Authorization: 'Bearer test-token' })).json()).idle, false)
    httpServer.close()
    port = await start(makeServer({
      sessionManager: fakeManager([row()], { s1: { getPendingQuestions: () => [{ toolUseId: 't', questions: [] }] } }),
    }))
    assert.equal((await (await get(port, { Authorization: 'Bearer test-token' })).json()).idle, false)
  })

  it('a hook-routed pending permission answers idle:false', async () => {
    const port = await start(makeServer({ getHookPendingPermissionCount: () => 3 }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
    assert.equal(body.hookPendingPermissions, 3)
  })

  it('FAIL SAFE: a throwing accessor still answers 200 with idle:false', async () => {
    const port = await start(makeServer({
      sessionManager: { listSessions: () => { throw new Error('manager exploded') } },
    }))
    const res = await get(port, { Authorization: 'Bearer test-token' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.idle, false)
    assert.ok(body.reasons.some((r) => r.startsWith('idle state unavailable')))
  })

  it('FAIL SAFE: the route-level guard answers idle:false when reading the manager itself throws', async () => {
    const server = makeServer()
    Object.defineProperty(server, 'sessionManager', { get() { throw new Error('getter exploded') } })
    const port = await start(server)
    const res = await get(port, { Authorization: 'Bearer test-token' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.idle, false)
    assert.ok(body.reasons.some((r) => r.includes('getter exploded')))
  })

  it('FAIL SAFE: a server with no hook-permission accessor answers idle:false', async () => {
    const port = await start(makeServer({ getHookPendingPermissionCount: undefined }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
  })

  it('FAIL SAFE: no session manager answers idle:false', async () => {
    const port = await start(makeServer({ sessionManager: null }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
  })

  it('rejects a pairing-bound token with primary_token_required', async () => {
    const server = makeServer()
    const { pairingId } = pm.generateBoundPairing('s1')
    const bound = pm.validatePairing(pairingId).sessionToken
    const port = await start(server)
    const res = await get(port, { Authorization: `Bearer ${bound}` })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'primary_token_required')
  })

  it('rejects a missing or wrong token (403, matching every other bearer route)', async () => {
    const port = await start(makeServer())
    assert.equal((await get(port)).status, 403)
    assert.equal((await get(port, { Authorization: 'Bearer nope' })).status, 403)
  })

  it('a loopback peer carrying cf-connecting-ip (the tunnel) is refused even with the right token', async () => {
    const port = await start(makeServer())
    const res = await get(port, { Authorization: 'Bearer test-token', 'cf-connecting-ip': '203.0.113.7' })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'forbidden')
  })

  it('a loopback peer carrying x-forwarded-for is refused even with the right token', async () => {
    const port = await start(makeServer())
    const res = await get(port, { Authorization: 'Bearer test-token', 'x-forwarded-for': '203.0.113.7' })
    assert.equal(res.status, 403)
  })

  it('the locality refusal reveals nothing about the token', async () => {
    const port = await start(makeServer())
    const good = await get(port, { Authorization: 'Bearer test-token', 'cf-connecting-ip': '1.2.3.4' })
    const bad = await get(port, { Authorization: 'Bearer wrong', 'cf-connecting-ip': '1.2.3.4' })
    assert.equal(good.status, bad.status)
    assert.deepEqual(await good.json(), await bad.json())
  })

  it('a non-loopback socket (LAN peer) is refused even with the right token', async () => {
    // Drive the handler directly: a real socket from this test is always loopback.
    const handler = createHttpHandler(makeServer())
    let status = null
    let body = ''
    const res = {
      writeHead(s) { status = s },
      setHeader() {},
      end(b) { body = b ?? '' },
    }
    const req = {
      method: 'GET',
      url: '/api/daemon/idle',
      headers: { authorization: 'Bearer test-token' },
      socket: { remoteAddress: '192.168.1.50' },
      on() {},
    }
    await handler(req, res)
    assert.equal(status, 403)
    assert.equal(JSON.parse(body).error, 'forbidden')
  })

  it('with auth disabled, locality still applies', async () => {
    const port = await start(makeServer({ authRequired: false }))
    assert.equal((await get(port)).status, 200)
    assert.equal((await get(port, { 'cf-connecting-ip': '1.2.3.4' })).status, 403)
  })
})

// #8743 — trial run B2-cy-codex: the daemon took a Codex app-server turn as
// over while codex kept emitting every few seconds for 17 minutes, the deploy
// tick read `idle: true`, and the SIGTERM cut the run off. `isBusy` is the
// daemon's own turn bookkeeping; the provider-activity window reads what the
// provider SAID, so a wrong turn state can no longer make a working session idle.
describe('provider activity holds a restart off (#8743)', () => {
  const W = PROVIDER_QUIET_WINDOW_MS
  const withAge = (age) => computeDaemonIdleState({
    sessionManager: fakeManager([row()], { s1: { providerActivityAgeMs: age } }),
    getHookPendingPermissionCount: () => 0,
  })

  it('activity inside the quiet window is not idle and says how long ago; at the window it is idle', () => {
    const out = withAge(42_000)
    assert.equal(out.idle, false)
    assert.ok(out.reasons.includes(`session "main" provider active 42s ago (quiet window ${W / 60000}m)`), out.reasons.join('|'))
    assert.equal(out.sessions[0].providerActivityAgeMs, 42_000)
    assert.equal(withAge(0).idle, false, 'this instant')
    assert.equal(withAge(W - 1).idle, false, 'one ms inside the window')
    assert.equal(withAge(W).idle, true, 'quiet for the whole window')
    assert.equal(withAge(null).idle, true, 'a provider that has produced nothing')
  })

  it('FAIL SAFE: an age that is missing, throws or is not a duration is not idle', () => {
    for (const [name, session] of Object.entries({
      missing: { providerActivityAgeMs: undefined },
      NaN: { providerActivityAgeMs: NaN },
      negative: { providerActivityAgeMs: -1 },
      fractional: { providerActivityAgeMs: 1.5 },
      string: { providerActivityAgeMs: '600000' },
      Infinity: { providerActivityAgeMs: Infinity },
    })) {
      const out = computeDaemonIdleState({ sessionManager: fakeManager([row()], { s1: session }), getHookPendingPermissionCount: () => 0 })
      assert.equal(out.idle, false, name)
      assert.ok(out.reasons.some((r) => r.includes('provider activity')), `${name}: ${out.reasons.join('|')}`)
    }
    const mgr = fakeManager([row()])
    Object.defineProperty(mgr.getSession('s1').session, 'providerActivityAgeMs', { get() { throw new Error('age-broke') } })
    const out = computeDaemonIdleState({ sessionManager: mgr, getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('age-broke')), out.reasons.join('|'))
  })

  // `ready` is a boot or respawn handshake and `error` is often the daemon's own
  // failure, repeatable in a crash/respawn loop: neither is evidence of work.
  const EXCLUDED = ['ready', 'error']

  it('every proxied session event is either provider activity or named here as excluded', () => {
    for (const ev of PROXIED_SESSION_EVENTS) {
      const inRoster = PROVIDER_ACTIVITY_EVENTS.includes(ev)
      const excluded = EXCLUDED.includes(ev)
      assert.ok(inRoster !== excluded, `${ev}: add it to PROVIDER_ACTIVITY_EVENTS or to EXCLUDED, exactly one`)
    }
  })

  it('a real BaseSession stamps on every activity event and on no excluded one', () => {
    for (const ev of [...PROVIDER_ACTIVITY_EVENTS, ...EXCLUDED]) {
      const s = new BaseSession()
      s.on('error', () => {})
      let clock = 50_000
      s._providerActivityClock = () => clock
      assert.equal(s.providerActivityAgeMs, null, `${ev}: premise, nothing yet`)
      s.emit(ev, {})
      clock += 1500
      assert.equal(s.providerActivityAgeMs, PROVIDER_ACTIVITY_EVENTS.includes(ev) ? 1500 : null, ev)
    }
  })

  it('a stream that keeps going holds the window open, and the window closes after it stops', () => {
    const s = new BaseSession()
    let clock = 0
    s._providerActivityClock = () => clock
    s.emit('stream_delta', { messageId: 'm', delta: 'a' })
    for (let i = 0; i < 20; i++) {
      clock += 60_000
      assert.equal(probe(s).idle, false, `minute ${i + 1}: still inside the window of the last delta`)
      s.emit('stream_delta', { messageId: 'm', delta: 'b' })
    }
    clock += W - 1
    assert.equal(probe(s).idle, false)
    clock += 1
    assert.equal(probe(s).idle, true)
  })

  describe('a real CodexAppServerSession', () => {
    // codex-cli 0.163.0 notification shapes, as in the #8710 tests in
    // codex-app-server-session.test.js: a sub-agent's thread is relayed on the
    // parent's connection and names its own `threadId`.
    const PARENT = 'th-parent'
    const PARENT_TURN = 'turn-parent'
    const CHILD = 'th-worker'
    const CHILD_TURN = 'turn-worker'
    const turnStarted = (threadId, id) => ({ method: 'turn/started', params: { threadId, turn: { id, items: [], status: 'inProgress' } } })
    const turnCompleted = (threadId, id) => ({ method: 'turn/completed', params: { threadId, turn: { id, items: [], status: 'completed', error: null, durationMs: 1 } } })
    const delta = (threadId, turnId, text) => ({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg', delta: text } })
    const itemStarted = (threadId, turnId, item) => ({ method: 'item/started', params: { threadId, turnId, item, startedAtMs: 0 } })
    const itemCompleted = (threadId, turnId, item) => ({ method: 'item/completed', params: { threadId, turnId, item, completedAtMs: 0 } })

    let s
    let skills
    let clock
    beforeEach(() => {
      skills = mkdtempSync(join(tmpdir(), 'chroxy-idle-codex-'))
      s = new CodexAppServerSession({ cwd: '/tmp', skillsDir: skills, repoSkillsDir: null })
      s.on('error', () => {})
      clock = 1_000_000
      s._providerActivityClock = () => clock
      s._processReady = true
      s._threadId = PARENT
      s._client = { request: async () => ({ turn: { id: PARENT_TURN } }) }
    })
    afterEach(() => {
      try { s.destroy() } catch { /* ignore */ }
      rmSync(skills, { recursive: true, force: true })
    })

    it('mid-turn it is not idle', async () => {
      await s.sendMessage('run the trial')
      s._onNotification(turnStarted(PARENT, PARENT_TURN))
      s._onNotification(delta(PARENT, PARENT_TURN, 'working'))
      const out = probe(s)
      assert.equal(out.idle, false)
      assert.ok(out.reasons.includes('session "real" busy: turn'), out.reasons.join('|'))
    })

    it('B2-cy-codex: codex keeps working after the daemon took the turn as over, and the daemon does not read idle', async () => {
      await s.sendMessage('run the trial')
      s._onNotification(turnStarted(PARENT, PARENT_TURN))
      s._onNotification(delta(PARENT, PARENT_TURN, 'spawning a worker'))
      s._onNotification(turnCompleted(PARENT, PARENT_TURN))
      assert.equal(s.isRunning, false, 'premise: the daemon holds no turn open')
      clock += W
      assert.equal(probe(s).idle, true, 'premise: past the window, a silent session is idle')

      // The worker the turn spawned is still running on the same connection.
      // None of this maps to an event, and none of it opens a turn on the parent.
      s._onNotification(turnStarted(CHILD, CHILD_TURN))
      s._onNotification(itemStarted(CHILD, CHILD_TURN, { type: 'commandExecution', id: 'worker-cmd', command: 'npm test', cwd: '/trial' }))
      assert.equal(s.isRunning, false, 'premise: isBusy still reads idle')
      clock += 30_000
      let out = probe(s)
      assert.equal(out.idle, false, 'a sub-agent emitting 30s ago holds the restart off')
      assert.ok(out.reasons.includes(`session "real" provider active 30s ago (quiet window ${W / 60000}m)`), out.reasons.join('|'))

      // Minutes later a background exec from the ended parent turn reports: a
      // straggler, dropped without an event, and still codex at work.
      clock += W - 1000
      s._onNotification(itemCompleted(PARENT, PARENT_TURN, { type: 'commandExecution', id: 'bg-suite', aggregatedOutput: '', status: 'completed' }))
      assert.equal(s.isRunning, false, 'premise: the straggler does not reopen the turn')
      out = probe(s)
      assert.equal(out.idle, false, 'a straggler is activity too')

      clock += W
      assert.equal(probe(s).idle, true, 'once codex has been silent for the whole window, the daemon is idle again')
    })

    it('a deprecation notice is not activity', () => {
      s._onNotification({ method: 'deprecationNotice', params: { summary: 'x', details: null } })
      assert.equal(s.providerActivityAgeMs, null)
      assert.equal(probe(s).idle, true)
    })
  })
})
