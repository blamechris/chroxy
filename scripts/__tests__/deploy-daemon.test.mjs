#!/usr/bin/env node
/**
 * deploy-daemon.test.mjs — harness for scripts/deploy-daemon.mjs (#8324).
 *
 * The subject restarts the owner's daily daemon, so the cases that matter are
 * the ones where it must NOT: a busy daemon, an unreachable one, one that cannot
 * say what commit it runs, a dirty or diverged checkout, a failed build. Each of
 * those asserts on the ABSENCE of the mutating command (merge / reset / npm /
 * launchctl) and on the build stamp, not merely on an exit code, because
 * "deferred" and "deployed anyway and exited 0" must not look alike.
 *
 * The script converges on a desired state each tick instead of keeping a
 * journal, so the interruption cases here do not test "recovery code": they
 * crash a run at a chosen command, then run the NEXT tick and assert where the
 * system ends up.
 *
 * Everything outside the script is faked: `run` (git, npm, launchctl), `fetch`,
 * the clock, `sleep` and the lock. The fake daemon is a small state machine —
 * `launchctl kill` schedules a restart that rewrites connection.json with a new
 * pid after a delay, and the restarted daemon REPORTS the commit of the checkout
 * at that moment, exactly as the real one does — so "the daemon itself says it
 * runs the desired commit" is exercised for real. Two groups use the real thing
 * instead: the final group runs the script's real git commands against real temp
 * repositories, and the lock group takes a real TCP port. Nothing here touches
 * launchd, ~/.chroxy or the daily checkout.
 *
 * Run from anywhere:  node scripts/__tests__/deploy-daemon.test.mjs
 * Exit status: 0 if every case passes, 1 otherwise.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDeps, deploy, parseArgs, POSTPONE_MAX_MS, REQUEST_SKEW_MS } from '../deploy-daemon.mjs'

// Every case in this file. Bump it when you add one: a case that vanishes
// should break the run rather than quietly shrink it.
const MIN_CASES = 131

let pass = 0
let fail = 0
const failures = []

const test = async (name, fn) => {
  try {
    await fn()
    pass++
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    fail++
    failures.push({ name, err })
    process.stdout.write(`  FAIL ${name}: ${err.message}\n`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed') }
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'not equal'}\n    got:      ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`)
  }
}

const A = 'a'.repeat(40) // the commit the daemon runs
const B = 'b'.repeat(40) // origin/main
const C = 'c'.repeat(40) // a later origin/main
const realFs = {
  appendFileSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, unlinkSync, writeFileSync, writeSync,
}
const roots = []

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
}
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete GIT_ENV[k]
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// The same hash the script computes: sha256 over `path NUL content NUL` for every lockfile, sorted.
const lockHashOf = (files) => {
  const h = createHash('sha256')
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    h.update(path); h.update('\0'); h.update(content); h.update('\0')
  }
  return h.digest('hex')
}

// In-memory stand-in for the kernel lock, keyed by port.
const heldPorts = new Set()
const fakeLock = async (port) => {
  if (heldPorts.has(port)) return { ok: false, inUse: true, reason: 'EADDRINUSE' }
  heldPorts.add(port)
  return { ok: true, release: async () => { heldPorts.delete(port) } }
}

const IDLE = { status: 200, body: { idle: true, reasons: [] } }
const BUSY = { status: 200, body: { idle: false, reasons: ['session "a" busy: turn'] } }

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

function makeEnv(o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-deploy-test-'))
  roots.push(root)
  const checkout = join(root, 'checkout')
  const configDir = join(root, 'cfg')
  mkdirSync(configDir, { recursive: true })
  if (!o.realGit) mkdirSync(join(checkout, '.git'), { recursive: true })

  const env = {
    root, checkout, configDir,
    calls: [],
    logs: [],
    t: Date.now(), // real-time base: nothing here compares against file mtimes any more, but keep timestamps sane
    t0: 0,
    git: {
      head: A, remote: B, branch: 'main', dirty: '', fetchOk: true, mergeOk: true, diverged: false,
      order: [A, B, C], subject: 'feat: x', log: 'bbbbbbb feat: x',
      lsFiles: ['package-lock.json', 'packages/server/sidecar/package-lock.json', 'README.md'],
    },
    // The working tree's lockfile content, by commit.
    locks: {},
    build: { ciFailures: 0, failShas: new Set() },
    daemon: {
      pid: 1000, livePid: 1000, commit: A, generation: 0,
      ignoreKills: 0, killOk: true, keepPid: 0, // keepPid: the next N restarts keep the old pid
      restartDelayMs: 3000,
      nextPids: [2000, 3000, 4000, 5000, 6000, 7000],
      idleFn: () => IDLE, // (n, env) => { status, body }; `commit` and `pid` are filled in from the daemon
      idleCalls: 0,
      brokenCommits: new Set(), // /health answers 500 while it runs one of these
      noCommitCommits: new Set(), // reports commit:null while it runs one of these
      crashCommit: null, crashAfterMs: 5000, // the process dies this long after coming up on this commit
      tunnel: () => 200, // (daemon, n) => status
      tunnelCalls: 0, pendingRestart: null, dead: false, cameUpAt: null,
    },
  }
  env.t0 = env.t

  const headNow = () => (o.realGit ? g(checkout, 'rev-parse', 'HEAD') : env.git.head)
  env.headNow = headNow

  env.conn = {} // overrides for connection.json (e.g. { tunnelMode: undefined })
  const writeConn = (pid) => writeFileSync(join(configDir, 'connection.json'), JSON.stringify({
    wsUrl: 'wss://tunnel.example', httpUrl: 'https://tunnel.example', apiToken: 'tok',
    tunnelMode: 'cloudflare:named', startedAt: '2026-10-06T00:00:00Z', pid, ...env.conn,
  }))
  env.writeConn = writeConn

  const writeTree = (sha) => {
    if (o.realGit) return
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package-lock.json'), env.locks[sha] ?? 'lock-v1')
    writeFileSync(join(checkout, 'packages-sidecar-lock'), 'x')
  }
  const treeLocks = () => {
    const out = {}
    out['package-lock.json'] = readFileSync(join(checkout, 'package-lock.json'), 'utf8')
    return out
  }
  env.seedStamp = (sha) => writeFileSync(join(configDir, 'deploy-build.json'), JSON.stringify({ sha, lockHash: lockHashOf(treeLocks()) }))
  env.stamp = () => (existsSync(join(configDir, 'deploy-build.json')) ? JSON.parse(readFileSync(join(configDir, 'deploy-build.json'), 'utf8')) : null)

  const applyDaemon = () => {
    const d = env.daemon
    if (d.pendingRestart && env.t >= d.pendingRestart.at) {
      d.commit = headNow()
      if (d.keepPid > 0) d.keepPid--
      else d.livePid = d.pendingRestart.pid
      d.generation++
      d.dead = false
      d.cameUpAt = d.pendingRestart.at
      d.pendingRestart = null
      writeConn(d.livePid)
    }
    if (d.crashCommit && d.commit === d.crashCommit && !d.dead && d.cameUpAt != null && env.t >= d.cameUpAt + d.crashAfterMs) {
      d.dead = true
      d.livePid = null
    }
  }
  env.applyDaemon = applyDaemon

  const gitFake = (args) => {
    const g0 = env.git
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null })
    const bad = (stderr = 'fatal', status = 1) => ({ status, stdout: '', stderr, error: null })
    const [c0, c1] = args
    const idx = (sha) => g0.order.indexOf(sha)
    if (c0 === 'status') return ok(g0.dirty)
    if (c0 === 'rev-parse' && c1 === '--abbrev-ref') return ok(g0.branch + '\n')
    if (c0 === 'rev-parse' && c1 === 'HEAD') return ok(g0.head + '\n')
    if (c0 === 'rev-parse' && c1 === '--verify') return ok(g0.remote + '\n')
    if (c0 === 'fetch') return g0.fetchOk ? ok() : bad('could not resolve host')
    if (c0 === 'ls-files') return ok(g0.lsFiles.join('\n') + '\n')
    if (c0 === 'merge-base') {
      const [x, y] = [args[2], args[3]]
      if (g0.diverged && x !== y) return bad('', 1)
      return idx(x) <= idx(y) ? ok() : bad('', 1)
    }
    if (c0 === 'log' && c1 === '-1') return ok(g0.subject + '\n')
    if (c0 === 'log') return ok(g0.log + '\n')
    if (c0 === 'merge') { if (!g0.mergeOk) return bad('not possible to fast-forward'); g0.head = args[2]; writeTree(args[2]); return ok() }
    if (c0 === 'reset') { g0.head = args[2]; writeTree(args[2]); return ok() }
    return bad(`unexpected git ${args.join(' ')}`)
  }

  const deps = {
    run(cmd, args, { cwd } = {}) {
      env.calls.push([cmd, ...args].join(' '))
      if (env.onRun) env.onRun(cmd, args)
      if (env.crashOn && env.crashOn(cmd, args)) { env.crashOn = null; throw new Error('simulated crash') }
      if (cmd === 'git') {
        if (o.realGit) {
          const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
          return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error ? String(r.error) : null }
        }
        return gitFake(args)
      }
      const res = (status, stderr = '') => ({ status, stdout: '', stderr, error: null })
      if (cmd === 'npm' && args[0] === 'ci') return env.build.ciFailures-- > 0 ? res(1, 'ci exploded') : res(0)
      if (cmd === 'npm' && args[0] === 'run') {
        if (!env.build.failShas.has(headNow())) return res(0)
        return env.build.error ? { status: null, stdout: '', stderr: '', error: env.build.error } : res(1, env.build.stderr || 'vite exploded')
      }
      if (cmd === 'launchctl') {
        if (!env.daemon.killOk) return res(113, 'Could not find service')
        if (env.daemon.ignoreKills > 0) env.daemon.ignoreKills--
        else env.daemon.pendingRestart = { at: env.t + env.daemon.restartDelayMs, pid: env.daemon.nextPids.shift() }
        if (env.crashAfterKill) { env.crashAfterKill = false; throw new Error('simulated crash after the signal') }
        return res(0)
      }
      return res(127, `unexpected ${cmd}`)
    },
    async fetch(url) {
      applyDaemon()
      const d = env.daemon
      const resp = (status, body) => ({ status, json: async () => { if (body === undefined) throw new Error('not json'); return body } })
      if (url.endsWith('/api/daemon/idle')) {
        env.calls.push(`GET ${url}`)
        if (d.dead) throw new Error('ECONNREFUSED')
        const n = d.idleCalls++
        const r = d.idleFn(n, env)
        if (r === 'throw') throw new Error('ECONNREFUSED')
        if (r === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        if (r.throwErr) throw r.throwErr
        if (r.body && typeof r.body === 'object' && !('commit' in r.body)) {
          return resp(r.status, { ...r.body, commit: d.noCommitCommits.has(d.commit) ? null : d.commit, pid: d.livePid })
        }
        return resp(r.status, r.body)
      }
      if (url === 'http://127.0.0.1:8765/health') {
        if (d.dead) throw new Error('ECONNREFUSED')
        if (d.healthThrows) throw d.healthThrows
        return resp(d.brokenCommits.has(d.commit) ? 500 : 200, { status: 'ok' })
      }
      if (url === 'https://tunnel.example/health') {
        const n = d.tunnelCalls++
        env.calls.push('GET tunnel')
        return resp(d.tunnel(d, n), {})
      }
      throw new Error(`unexpected fetch ${url}`)
    },
    now: () => env.t,
    async sleep(ms) { env.t += ms; applyDaemon() },
    log: (line) => env.logs.push(line),
    uid: 501,
    pid: 4242,
    isPidAlive: (pid) => pid === env.daemon.livePid,
    fs: realFs,
    acquireLock: fakeLock,
  }
  env.deps = deps
  env.opts = (extra = {}) => ({
    checkout, configDir, label: 'com.chroxy.server', branch: 'main', remote: 'origin', port: null, lockPort: 47651,
    healthTimeoutS: 5, settleS: 15, retry: false, npm: null, dryRun: false, force: false, tunnelCheck: true, ...extra,
  })
  env.run = (extra) => deploy(env.opts(extra), deps)
  env.path = (f) => join(configDir, f)
  env.readLog = () => (existsSync(env.path('logs/deploy.log')) ? readFileSync(env.path('logs/deploy.log'), 'utf8') : '')
  env.last = () => JSON.parse(readFileSync(env.path('last-deploy.json'), 'utf8'))
  env.state = () => (existsSync(env.path('deploy-state.json')) ? JSON.parse(readFileSync(env.path('deploy-state.json'), 'utf8')) : {})

  if (!o.noConn) writeConn(env.daemon.pid)
  if (!o.realGit) { writeTree(A); env.seedStamp(A) }
  return env
}

const KILL = 'launchctl kill SIGTERM gui/501/com.chroxy.server'
const IDLE_URL = 'GET http://127.0.0.1:8765/api/daemon/idle'
const BUILD = 'npm run build -w @chroxy/dashboard'
const CI = 'npm ci --no-audit --no-fund'
const mutating = (env) => env.calls.filter((c) => /^(git merge |git reset|npm |launchctl)/.test(c))
const kills = (env) => env.calls.filter((c) => c.startsWith('launchctl'))
const probes = (env) => env.calls.filter((c) => c === IDLE_URL).length
// Any mutation of tree, build or daemon at all.
const untouched = (env) => { eq(mutating(env), [], 'nothing was mutated'); eq(env.stamp()?.sha, A, 'the build stamp is intact') }

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FIFO child mode. A FIFO at a control-file name must read as ABSENT without
// blocking. A reader that blocks cannot be failed from inside its own process,
// so each case runs in a child with a timeout: a regression is a legible
// "timed out", not a hung test run. (`node <this file> --fifo-child <file> <busy|idle>`)
// ---------------------------------------------------------------------------
if (process.argv[2] === '--fifo-child') {
  const env = makeEnv()
  execFileSync('mkfifo', [env.path(process.argv[3])])
  if (process.argv[4] === 'busy') env.daemon.idleFn = () => BUSY
  const r = await env.run()
  process.stdout.write(JSON.stringify({ outcome: r.outcome, exitCode: r.exitCode }))
  process.exit(0)
}

await test('parseArgs: defaults and every flag', () => {
  const o = parseArgs([], {}, '/home/u')
  eq(o.checkout, '/home/u/Projects/chroxy-daemon')
  eq(o.configDir, '/home/u/.chroxy')
  eq([o.label, o.branch, o.remote, o.healthTimeoutS, o.dryRun, o.force, o.tunnelCheck, o.settleS, o.retry, o.lockPort],
    ['com.chroxy.server', 'main', 'origin', 90, false, false, true, 15, false, 47651])
  eq(parseArgs([], { CHROXY_CONFIG_DIR: '/x/cfg' }, '/home/u').configDir, '/x/cfg', 'CHROXY_CONFIG_DIR is honoured')
  const f = parseArgs(['--checkout', '/c', '--config-dir', '/d', '--label', 'l.x', '--branch', 'rel/1', '--remote', 'up',
    '--port', '9000', '--lock-port', '4000', '--health-timeout', '30', '--npm', '/n/npm', '--dry-run', '--force', '--no-tunnel-check',
    '--settle', '0', '--retry'], {}, '/h')
  eq([f.checkout, f.configDir, f.label, f.branch, f.remote, f.port, f.lockPort, f.healthTimeoutS, f.npm, f.dryRun, f.force, f.tunnelCheck, f.settleS, f.retry],
    ['/c', '/d', 'l.x', 'rel/1', 'up', 9000, 4000, 30, '/n/npm', true, true, false, 0, true])
})

await test('parseArgs: refuses a branch/remote/label git or launchctl would read as an option', () => {
  for (const bad of [['--branch', '--upload-pack=x'], ['--branch', 'a..b'], ['--branch', '-f'], ['--remote', '--foo'],
    ['--remote', 'a b'], ['--label', '-x'], ['--label', 'a/b']]) {
    let threw = false
    try { parseArgs(bad, {}, '/h') } catch { threw = true }
    assert(threw, `${bad.join(' ')} must be refused`)
  }
})

await test('parseArgs: unknown flag, missing value and bad numbers are errors', () => {
  for (const bad of [['--nope'], ['--checkout'], ['--port', 'x'], ['--port', '70000'], ['--lock-port', '0'], ['--lock-port', 'x'],
    ['--health-timeout', '0'], ['--settle', '-1'], ['--settle', 'x']]) {
    let threw = false
    try { parseArgs(bad, {}, '/h') } catch { threw = true }
    assert(threw, `${bad.join(' ')} must be an error`)
  }
})

await test('--help says --port is required for a tunnelled daemon on a non-default port', async () => {
  const { USAGE } = await import('../deploy-daemon.mjs')
  assert(/--port[\s\S]{0,200}REQUIRED[\s\S]{0,200}tunnel/.test(USAGE), 'documented in --help')
})

await test('the default runner sets GIT_TERMINAL_PROMPT=0 so an unattended fetch cannot wait for a credential', () => {
  const r = defaultDeps().run(process.execPath, ['-e', 'process.stdout.write(process.env.GIT_TERMINAL_PROMPT || "unset")'])
  eq(r.stdout, '0')
})

// ---------------------------------------------------------------------------
// refusals and no-ops
// ---------------------------------------------------------------------------

await test('up to date: exit 0, nothing mutated, deploy.log untouched, lock released', async () => {
  const env = makeEnv()
  env.git.remote = A
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'up-to-date'])
  untouched(env)
  eq(env.readLog(), '', 'a quiet tick must not grow deploy.log')
  assert(!heldPorts.has(47651), 'lock released')
})

await test('a diverged or ahead checkout is refused before anything is touched', async () => {
  const env = makeEnv()
  env.git.diverged = true
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  untouched(env)
  assert(env.readLog().includes('fast-forward only'), 'says why')
})

await test('a dirty tree is refused, and the daemon is never asked', async () => {
  const env = makeEnv()
  env.git.dirty = ' M packages/server/src/x.js\n'
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  untouched(env)
  eq(probes(env), 0)
  assert(env.readLog().includes('uncommitted'), 'says why')
})

await test('a checkout on the wrong branch is refused', async () => {
  const env = makeEnv()
  env.git.branch = 'feature/x'
  eq((await env.run()).outcome, 'refused')
  untouched(env)
})

await test('a failed fetch is reported and mutates nothing', async () => {
  const env = makeEnv()
  env.git.fetchOk = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'fetch-failed'])
  untouched(env)
})

// ---------------------------------------------------------------------------
// gating: nothing is mutated unless the daemon can say it is idle AND what it runs
// ---------------------------------------------------------------------------

await test('a busy daemon defers: exit 0, nothing mutated, reasons logged', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy'])
  untouched(env)
  assert(env.readLog().includes('deferred: busy (session "a" busy: turn)'), 'reason is logged')
  eq(env.git.head, A, 'HEAD untouched')
})

await test('the same deferral is logged ONCE per target, and a new target is news again', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  await env.run(); await env.run(); await env.run()
  eq(env.readLog().trim().split('\n').length, 1, 'three ticks, one line')
  env.git.remote = C
  await env.run()
  eq(env.readLog().trim().split('\n').length, 2, 'a new target logs again')
})

await test('an unreachable daemon, a 404, an unreadable body and a missing connection.json each defer without mutating', async () => {
  const variants = {
    unreachable: (e) => { e.daemon.idleFn = () => 'throw' },
    '404 (predates the route)': (e) => { e.daemon.idleFn = () => ({ status: 404, body: { error: 'x' } }) },
    'idle is not a boolean': (e) => { e.daemon.idleFn = () => ({ status: 200, body: { idle: 'yes' } }) },
    'non-JSON body': (e) => { e.daemon.idleFn = () => ({ status: 200, body: undefined }) },
    '500': (e) => { e.daemon.idleFn = () => ({ status: 500, body: {} }) },
  }
  for (const [name, setup] of Object.entries(variants)) {
    const env = makeEnv()
    setup(env)
    const r = await env.run()
    eq([r.exitCode, r.outcome], [0, 'deferred-unavailable'], name)
    untouched(env)
  }
  const none = makeEnv({ noConn: true })
  eq((await none.run()).outcome, 'deferred-unavailable')
  untouched(none)
  const old = makeEnv()
  old.daemon.idleFn = () => ({ status: 404, body: {} })
  await old.run()
  assert(old.readLog().includes('--force'), 'a 404 points at the bootstrap')
})

await test('a daemon that does not report its commit is not certified: no mutation without --force', async () => {
  const env = makeEnv()
  env.daemon.noCommitCommits.add(A)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-unavailable'])
  untouched(env)
  assert(env.readLog().includes('does not report the commit'), 'says why')
})

await test('--force bootstraps onto a daemon that reports no commit, and still verifies the new one by commit', async () => {
  const env = makeEnv()
  env.daemon.noCommitCommits.add(A)
  const r = await env.run({ force: true })
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(env.daemon.commit, B)
})

await test('--force skips the idle checks entirely', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  const r = await env.run({ force: true })
  eq(r.outcome, 'deployed')
})

// ---------------------------------------------------------------------------
// the forward deploy
// ---------------------------------------------------------------------------

await test('forward deploy: probe, delete stamp, merge, build, re-check, SIGTERM — and the daemon is the judge', async () => {
  const env = makeEnv()
  const seen = {}
  env.onRun = (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    if (key.startsWith('git merge --ff-only')) seen.stampAtMerge = env.stamp()
    if (key === BUILD) seen.stampAtBuild = env.stamp()
    if (key === KILL) { seen.stampAtKill = env.stamp(); seen.stateAtKill = env.state() }
  }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(env.calls.filter((c) => /^(git fetch|git merge --ff-only|npm |launchctl|GET .*idle)/.test(c)).slice(0, 6),
    ['git fetch origin main', IDLE_URL, `git merge --ff-only ${B}`, BUILD, IDLE_URL, KILL])
  eq(seen.stampAtMerge, null, 'the stamp is deleted BEFORE the tree changes')
  eq(seen.stampAtBuild, null, 'and is absent during the build')
  eq(seen.stampAtKill.sha, B, 'and written only after the build succeeded')
  eq(seen.stateAtKill.rollbackTo, A, 'a rollback to the running commit is owed BEFORE the signal')
  eq(env.state().rollbackTo, undefined, 'and cleared once the restart is verified')
  eq(env.stamp().sha, B)
  eq(env.daemon.commit, B)
  const last = env.last()
  eq([last.from, last.to, last.result, last.subject], [A, B, 'ok', 'feat: x'])
  assert(env.readLog().includes(`${A.slice(0, 12)}..${B.slice(0, 12)} ok`), 'one success line')
})

await test('npm ci runs only when the lockfile hash differs from the stamp (or there is no stamp); the sidecar lockfile is not counted', async () => {
  const same = makeEnv()
  await same.run()
  assert(!same.calls.includes(CI), 'same lockfile content: no npm ci')
  const changed = makeEnv()
  changed.locks[B] = 'lock-v2'
  await changed.run()
  eq(mutating(changed).filter((c) => c.startsWith('npm')), [CI, BUILD], 'ci before build')
  const noStamp = makeEnv()
  unlinkSync(noStamp.path('deploy-build.json'))
  await noStamp.run()
  assert(noStamp.calls.includes(CI), 'no stamp: install')
  eq(changed.stamp().lockHash, lockHashOf({ 'package-lock.json': 'lock-v2' }), 'the stamp records the NEW lock hash')
})

await test('the restart is judged by the daemon: a lingering OLD process (same commit, same pid) is not a success', async () => {
  const env = makeEnv()
  env.daemon.ignoreKills = 1 // the first SIGTERM is not honoured; the old process keeps answering
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-health'])
  assert(env.readLog().includes('expected'), 'names the commit mismatch')
  eq(env.daemon.commit, A, 'the daemon ended on the old commit')
  eq(env.state().rollbackTo, undefined)
  eq(env.state().failedTarget, B)
})

await test('a daemon that reports the new commit under the SAME pid is not a success', async () => {
  const env = makeEnv()
  env.daemon.keepPid = 1
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('pre-signal pid'), 'says why')
})

await test('a daemon whose commit is null after the restart is not certified', async () => {
  const env = makeEnv()
  env.daemon.noCommitCommits.add(B)
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
})

await test('the settle window is waited out before a deploy is called good', async () => {
  const env = makeEnv()
  const t0 = env.t
  eq((await env.run({ settleS: 40 })).outcome, 'deployed')
  assert(env.t - t0 >= 3000 + 40000, `only ${env.t - t0}ms elapsed: the settle sleep was skipped`)
})

await test('a build that reports the right commit and dies inside the settle window is rolled back', async () => {
  const env = makeEnv()
  env.daemon.crashCommit = B
  const askedAbout = []
  env.daemon.tunnel = (d) => { askedAbout.push(d.commit); return 200 }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-health'])
  eq(env.git.head, A)
  eq(env.daemon.commit, A, 'the daemon ended on the old commit')
  assert(!askedAbout.includes(B), 'the settle verdict comes BEFORE the tunnel: a daemon that died settling is never asked about')
})

await test('the tunnel check retries through 530 and then succeeds; --no-tunnel-check never asks', async () => {
  const env = makeEnv()
  env.daemon.tunnel = (_d, n) => (n < 3 ? 530 : 200)
  eq((await env.run({ healthTimeoutS: 20 })).outcome, 'deployed')
  eq(env.daemon.tunnelCalls, 4)
  const off = makeEnv()
  off.daemon.tunnel = () => 530
  eq((await off.run({ tunnelCheck: false })).outcome, 'deployed')
  eq(off.daemon.tunnelCalls, 0)
})

await test('a TUNNEL-only failure is not rolled back: deployed-tunnel-unverified, exit 1, loud, not a failed target', async () => {
  const env = makeEnv()
  env.daemon.tunnel = () => 530
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'deployed-tunnel-unverified'])
  eq(kills(env).length, 1, 'no second restart: the daemon is serving locally')
  eq(env.git.head, B)
  assert(env.readLog().includes('DEPLOYED-TUNNEL-UNVERIFIED') && env.readLog().includes('530'), 'loud, with the reason')
  eq(env.last().result, 'deployed-tunnel-unverified')
  eq([env.state().failedTarget, env.state().rollbackTo], [undefined, undefined], 'neither a failed target nor an owed rollback')
  eq((await env.run()).outcome, 'up-to-date')
})

await test('a daemon that DIES during the tunnel wait is a local failure and is rolled back, not "tunnel-unverified"', async () => {
  const env = makeEnv()
  env.daemon.tunnel = (d) => { if (d.commit === B) { d.dead = true; d.livePid = null } return 530 }
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('after the tunnel check'), 'caught by the check AFTER the tunnel wait')
  eq(env.daemon.commit, A)
})

// ---------------------------------------------------------------------------
// build failures
// ---------------------------------------------------------------------------

await test('a failed forward build marks the target failed, converges the tree back, and never restarts', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-build'])
  eq(kills(env), [], 'the running daemon was never touched')
  eq(env.git.head, A)
  eq(env.stamp().sha, A, 'the stamp describes the restored build')
  eq([env.state().failedTarget, env.state().failedOutcome, env.state().rollbackTo], [B, 'rolled-back-build', undefined])
  eq(env.last().result, 'rolled-back-build')
  assert(env.readLog().includes('rolled-back (build failed'), 'logged')
})

await test('a failed npm ci rolls back too, installing the old tree again', async () => {
  const env = makeEnv()
  env.locks[B] = 'lock-v2'
  env.build.ciFailures = 1
  const r = await env.run()
  eq(r.outcome, 'rolled-back-build')
  eq(kills(env), [])
  eq(mutating(env).filter((c) => c.startsWith('npm')), [CI, CI, BUILD], 'the failed install, then the old tree installed and built')
})

await test('a rollback that itself fails leaves the rollback OWED, and the next tick completes it', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  env.build.failShas.add(A) // restoring the old build fails too
  const r1 = await env.run()
  eq([r1.exitCode, r1.outcome], [1, 'rollback-failed'])
  eq(env.state().rollbackTo, A, 'owed, and persisted')
  eq(env.stamp(), null, 'no stamp: nothing certifies the half-built tree')
  assert(env.readLog().includes('ROLLBACK-FAILED'), 'loud')
  env.build.failShas.delete(A)
  const r2 = await env.run()
  eq(r2.outcome, 'repaired', 'the daemon still runs A, so only the checkout is behind')
  eq([env.git.head, env.stamp().sha, env.state().rollbackTo], [A, A, undefined])
  eq(kills(env), [])
})

// ---------------------------------------------------------------------------
// a target that already failed
// ---------------------------------------------------------------------------

await test('after a build rollback the same target is SKIPPED on later ticks: nothing runs, one log line', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  await env.run()
  env.calls.length = 0
  const r2 = await env.run()
  const r3 = await env.run()
  eq([r2.exitCode, r2.outcome, r3.outcome], [0, 'skipped-failed-target', 'skipped-failed-target'])
  eq(mutating(env), [])
  const lines = env.readLog().trim().split('\n')
  eq(lines.length, 2, 'the rollback line plus ONE skip line')
  assert(lines[1].includes(`skipped: ${B.slice(0, 12)} already rolled back (rolled-back-build); waiting for a newer main or --retry`), 'exact wording')
})

await test('a newer origin/main clears the failure even when nothing deploys; --retry retries once; --force does not imply it', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  await env.run()
  eq((await env.run({ force: true })).outcome, 'skipped-failed-target', '--force alone still skips')
  env.build.failShas.delete(B)
  const r = await env.run({ retry: true })
  eq(r.outcome, 'deployed')
  eq(env.state().failedTarget, undefined, 'a successful retry clears it')

  const env2 = makeEnv()
  env2.build.failShas.add(B)
  await env2.run()
  env2.git.remote = C
  env2.daemon.idleFn = () => BUSY
  eq((await env2.run()).outcome, 'deferred-busy')
  eq(env2.state().failedTarget, undefined, 'a newer main clears it even when it only defers')
})

await test('a failed health check marks the target failed too, so the daemon is not restarted twice every tick', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  await env.run()
  eq(env.state().failedOutcome, 'rolled-back-health')
  env.calls.length = 0
  eq((await env.run()).outcome, 'skipped-failed-target')
  eq(kills(env), [])
})

// ---------------------------------------------------------------------------
// the busy re-check
// ---------------------------------------------------------------------------

await test('busy at the re-check converges the tree BACK to what the daemon runs, no restart, exit 0, not a failed target', async () => {
  const env = makeEnv()
  env.daemon.idleFn = (n) => (n === 1 ? BUSY : IDLE)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy-after-build'])
  eq(mutating(env).filter((c) => !c.startsWith('npm')), [`git merge --ff-only ${B}`, `git reset --hard ${A}`])
  eq([env.git.head, env.stamp().sha], [A, A])
  eq(kills(env), [])
  eq([env.state().failedTarget, env.state().rollbackTo], [undefined, undefined])
  assert(env.readLog().includes('deferred after build: busy'), 'logged')
})

await test('"cannot confirm idle" at the re-check also converges back; the deferral is logged once per target', async () => {
  const env = makeEnv()
  env.daemon.idleFn = (n) => (n % 2 === 1 ? 'throw' : IDLE)
  eq((await env.run()).outcome, 'deferred-busy-after-build')
  eq(env.git.head, A)
  await env.run()
  eq(env.readLog().trim().split('\n').length, 1, 'one line for two ticks')
})

await test('a failed converge-back after a busy re-check leaves a rollback owed', async () => {
  const env = makeEnv()
  env.daemon.idleFn = (n) => (n === 1 ? BUSY : IDLE)
  env.build.failShas.add(A)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rollback-failed'])
  eq(env.state().rollbackTo, A)
})

// ---------------------------------------------------------------------------
// rollback after a failed verify, and the owed rollback on later ticks
// ---------------------------------------------------------------------------

await test('a failed health check rolls back in the SAME run: failed target, tree and daemon back on the old commit, owed cleared', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-health'])
  eq(kills(env).length, 2)
  eq([env.git.head, env.stamp().sha, env.daemon.commit], [A, A, A])
  eq([env.state().failedTarget, env.state().rollbackTo], [B, undefined])
  eq(env.last().result, 'rolled-back')
  assert(env.readLog().includes('health failed'), 'logged')
})

await test('a rollback waits for a busy daemon, and restarts once it is idle', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  const until = env.t + 45_000
  env.daemon.idleFn = (n, e) => (e.daemon.commit === B && e.t < until ? BUSY : IDLE)
  const r = await env.run({ healthTimeoutS: 30 })
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('rollback waited'), 'logged that it waited')
  eq(kills(env).length, 2)
})

await test('a rollback that finds the daemon STILL busy after the timeout restarts nothing and leaves the rollback owed; a later idle tick finishes it', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  const until = env.t + 10 * 60_000
  env.daemon.idleFn = (n, e) => (e.daemon.commit === B && e.t < until ? BUSY : IDLE)
  const r1 = await env.run({ healthTimeoutS: 30 })
  eq([r1.exitCode, r1.outcome], [1, 'rollback-owed'])
  eq(kills(env).length, 1, 'no second SIGTERM into a busy daemon')
  eq(env.git.head, B, 'and the tree was not touched: restoring it is a mutation too')
  eq(env.state().rollbackTo, A)
  assert(env.readLog().includes('ROLLBACK-OWED'), 'loud')
  // still busy: the next tick defers without mutating
  env.calls.length = 0
  eq((await env.run({ healthTimeoutS: 30 })).outcome, 'deferred-busy')
  eq(mutating(env), [])
  // now idle
  env.t = until + 1000
  const r3 = await env.run({ healthTimeoutS: 30 })
  eq([r3.exitCode, r3.outcome], [0, 'rollback-completed'])
  eq([env.git.head, env.daemon.commit, env.state().rollbackTo], [A, A, undefined])
})

await test('an owed rollback against a DOWN daemon proceeds (there is nothing to lose); against a busy one it waits', async () => {
  const down = makeEnv()
  writeFileSync(down.path('deploy-state.json'), JSON.stringify({ rollbackTo: A }))
  down.git.head = B
  down.daemon.commit = B
  down.daemon.dead = true
  down.daemon.livePid = null
  const r = await down.run()
  eq([r.exitCode, r.outcome], [0, 'rollback-completed'])
  eq(down.daemon.commit, A)
  assert(down.calls.includes(KILL), 'restarted')

  const busy = makeEnv()
  writeFileSync(busy.path('deploy-state.json'), JSON.stringify({ rollbackTo: A }))
  busy.git.head = B
  busy.daemon.commit = B
  busy.daemon.idleFn = () => BUSY
  const r2 = await busy.run()
  eq([r2.exitCode, r2.outcome], [0, 'deferred-busy'])
  eq(mutating(busy), [], 'a busy daemon is not touched, not even its checkout')
  eq(busy.state().rollbackTo, A, 'still owed')
})

await test('a failed rollback verify keeps rollbackTo owed', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  env.daemon.brokenCommits.add(A) // the old build will not come back healthy either
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rollback-failed'])
  eq(env.state().rollbackTo, A)
  assert(env.readLog().includes('ROLLBACK-FAILED') && env.readLog().includes('stays owed'), 'loud')
})

// ---------------------------------------------------------------------------
// interruption: the next tick closes whatever gap is left
// ---------------------------------------------------------------------------

await test('interrupted DURING THE BUILD (after the merge): the next tick is not "up to date", it rebuilds and deploys', async () => {
  const env = makeEnv()
  env.crashOn = (cmd, args) => cmd === 'npm' && args[0] === 'run'
  eq((await env.run()).outcome, 'failed')
  eq(env.git.head, B, 'premise: HEAD already moved')
  eq(env.stamp(), null, 'premise: no stamp survives a half-done build')
  const r2 = await env.run()
  eq([r2.exitCode, r2.outcome], [0, 'deployed'])
  eq([env.stamp().sha, env.daemon.commit], [B, B])
})

await test('interrupted BEFORE the SIGTERM: a rollback is owed, the daemon still runs the old commit, so the next tick only repairs the checkout', async () => {
  const env = makeEnv()
  env.crashOn = (cmd) => cmd === 'launchctl'
  await env.run()
  eq(env.state().rollbackTo, A, 'premise: owed before the signal')
  env.calls.length = 0
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'repaired'])
  eq(kills(env), [], 'no restart: the daemon already runs the desired commit')
  eq([env.git.head, env.stamp().sha, env.state().rollbackTo], [A, A, undefined])
})

await test('interrupted AFTER the SIGTERM: the daemon came back on the NEW commit, but the rollback is still owed, so it is rolled back rather than trusted', async () => {
  const env = makeEnv()
  env.crashAfterKill = true
  await env.run()
  eq(env.state().rollbackTo, A, 'premise: owed')
  env.t += 10_000 // the daemon has restarted by now, on B
  env.deps.fetch('http://127.0.0.1:8765/health') // let the fake apply the pending restart
  env.calls.length = 0
  const r2 = await env.run()
  eq([r2.exitCode, r2.outcome], [0, 'rollback-completed'])
  eq([env.git.head, env.daemon.commit, env.state().rollbackTo], [A, A, undefined])
  eq(env.state().failedTarget, undefined, 'an interruption is not a verdict on the target')
  const r3 = await env.run()
  eq(r3.outcome, 'deployed', 'and the next tick deploys it properly')
})

await test('verify after an interrupted SIGTERM does not accept the OLD commit as success', async () => {
  const env = makeEnv()
  env.daemon.ignoreKills = 1 // the signal never lands: the daemon keeps reporting A
  const r = await env.run()
  assert(r.outcome !== 'deployed', 'the old commit is not a success')
  eq(env.daemon.commit, A)
})

await test('interrupted MID-ROLLBACK (after the reset): the next tick finishes the rollback', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  env.crashOn = (cmd, args) => cmd === 'npm' && args[0] === 'run' && env.calls.some((c) => c.startsWith('git reset'))
  eq((await env.run()).outcome, 'failed')
  eq([env.state().rollbackTo, env.state().failedTarget], [A, B])
  eq([env.git.head, env.stamp()], [A, null], 'premise: HEAD reset, build not finished')
  const r2 = await env.run()
  eq([r2.exitCode, r2.outcome], [0, 'rollback-completed'])
  eq([env.stamp().sha, env.daemon.commit, env.state().rollbackTo], [A, A, undefined])
})

await test('rollback verification runs the tunnel check too (every path that restarts uses the same verifier)', async () => {
  const env = makeEnv()
  writeFileSync(env.path('deploy-state.json'), JSON.stringify({ rollbackTo: A }))
  env.git.head = B
  env.daemon.commit = B
  env.daemon.tunnel = () => 530
  const r = await env.run()
  eq(r.outcome, 'rollback-completed')
  assert(env.daemon.tunnelCalls > 0, 'the tunnel was asked')
  assert(env.readLog().includes('tunnel is unverified'), 'and its failure is reported')
})

await test('an owed rollback to a daemon that reports no commit restores the tree and does not restart blindly', async () => {
  const env = makeEnv()
  writeFileSync(env.path('deploy-state.json'), JSON.stringify({ rollbackTo: A }))
  env.git.head = B
  env.daemon.commit = B
  env.daemon.noCommitCommits.add(B)
  env.seedStamp(B)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rollback-manual-restart'])
  eq(env.last().result, 'rollback-manual-restart')
  eq(kills(env), [])
  eq([env.git.head, env.state().rollbackTo], [A, undefined])
  assert(env.readLog().includes('could not be certified'), 'says so')
})

await test('the repair path: the daemon already runs the right commit but the stamp is missing → rebuild, no restart', async () => {
  const env = makeEnv()
  env.git.remote = A
  unlinkSync(env.path('deploy-build.json'))
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'repaired'])
  eq(kills(env), [])
  eq(env.stamp().sha, A)
  assert(env.readLog().includes('repaired checkout to'), 'logged')
})

await test('a repeated failure is logged again after a healthy tick in between', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  await env.run()
  eq(env.readLog().trim().split('\n').length, 1)
  env.daemon.idleFn = () => IDLE
  env.git.remote = A
  eq((await env.run()).outcome, 'up-to-date') // a healthy tick forgets the last condition
  env.git.remote = B
  env.daemon.idleFn = () => BUSY
  await env.run()
  eq(env.readLog().trim().split('\n').length, 2, 'the same condition is news again')
})

// ---------------------------------------------------------------------------
// down vs unknown: only a daemon with NOTHING listening has nothing to lose
// ---------------------------------------------------------------------------

const oweA = (env, extra = {}) => {
  writeFileSync(env.path('deploy-state.json'), JSON.stringify({ rollbackTo: A, ...extra }))
  env.git.head = B
  env.daemon.commit = B
  env.seedStamp(B)
}

await test('an owed rollback against an alive daemon that answers 404 is NEVER signalled, over five ticks, and cannot loop', async () => {
  const env = makeEnv()
  oweA(env)
  env.daemon.idleFn = () => ({ status: 404, body: { error: 'not found' } })
  const first = await env.run()
  eq([first.exitCode, first.outcome], [1, 'rollback-manual-restart'], 'the tree is restored once, but this is NOT a success')
  eq(env.last().result, 'rollback-manual-restart')
  eq([env.git.head, env.stamp().sha, env.state().rollbackTo], [A, A, undefined], 'and the owed rollback is cleared')
  assert(env.readLog().includes('restart it by hand'), 'tells the operator a manual restart is needed')
  for (let i = 0; i < 4; i++) eq((await env.run()).outcome, 'deferred-unavailable', `tick ${i + 2}: not owed any more, so it only defers`)
  eq(kills(env), [], 'no SIGTERM, ever')
})

await test('a --force bootstrap onto a daemon that never answers the route kills at most on that tick, then never again', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => ({ status: 404, body: {} })
  const forced = await env.run({ force: true })
  assert(forced.outcome !== 'deployed', 'the restarted daemon cannot be certified without a commit')
  const killsAfterFirst = kills(env).length
  for (let i = 0; i < 4; i++) await env.run()
  eq(kills(env).length, killsAfterFirst, 'ticks 2-5 never signal the daemon')
  eq(env.state().rollbackTo, undefined, 'and no rollback is left owed to loop on')
})

await test('an owed rollback against a daemon that answers 500, or times out, is not signalled and not touched', async () => {
  for (const [name, fn] of [['500', () => ({ status: 500, body: {} })], ['timeout', () => 'timeout']]) {
    const env = makeEnv()
    oweA(env)
    env.daemon.idleFn = fn
    const r = await env.run()
    eq([r.exitCode, r.outcome], [0, 'deferred-busy'], name)
    eq(mutating(env), [], `${name}: nothing mutated, 0 kills`)
    eq(env.state().rollbackTo, A, `${name}: still owed`)
    assert(env.readLog().includes('cannot confirm idle'), `${name}: says why`)
  }
})

await test('a health-failure rollback against a daemon whose probe TIMES OUT does not restart it: the rollback stays owed', async () => {
  const env = makeEnv()
  env.daemon.idleFn = (n, e) => (e.daemon.commit === B ? 'timeout' : IDLE)
  const r = await env.run({ healthTimeoutS: 12 })
  eq([r.exitCode, r.outcome], [1, 'rollback-owed'])
  eq(kills(env).length, 1, 'only the forward signal; no rollback SIGTERM into a daemon that may be busy')
  eq(env.git.head, B, 'the tree is untouched too')
  eq(env.state().rollbackTo, A)
  assert(env.readLog().includes('ROLLBACK-OWED'), 'loud')
})

await test('down when the tick began, relaunched and BUSY during the build: the rollback re-probes and does not signal it', async () => {
  const env = makeEnv()
  oweA(env)
  env.daemon.dead = true
  env.daemon.livePid = null
  env.onRun = (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'run' && env.daemon.dead) {
      // launchd's KeepAlive brings it back during the build, with a turn already running.
      env.daemon.dead = false
      env.daemon.livePid = 2000
      env.writeConn(2000)
      env.daemon.idleFn = () => BUSY
    }
  }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy'])
  eq(kills(env), [], 'a busy daemon was not signalled')
  eq(env.state().rollbackTo, A, 'still owed')
  assert(env.readLog().includes('rollback restart deferred'), 'logged')
})

await test('only a REFUSED loopback connection is DOWN; a reset is unknown and an owed rollback leaves the daemon alone', async () => {
  const shape = (code) => ({ throwErr: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }) })
  const refused = makeEnv()
  oweA(refused)
  refused.daemon.idleFn = (n) => (n === 0 ? shape('ECONNREFUSED') : IDLE)
  eq((await refused.run()).outcome, 'rollback-completed')
  assert(kills(refused).length === 1, 'refused: restarted')
  const reset = makeEnv()
  oweA(reset)
  reset.daemon.idleFn = () => shape('ECONNRESET')
  const r = await reset.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy'])
  eq(kills(reset), [], 'a reset proves something is there')
  eq(reset.state().rollbackTo, A)
})

await test('a stale connection.json (dead pid) with NOTHING listening on the port is DOWN: an owed rollback proceeds', async () => {
  const env = makeEnv()
  oweA(env)
  env.daemon.livePid = null // isPidAlive(1000) is now false...
  env.daemon.dead = true //    ...and the port refuses
  const r = await env.run()
  eq(r.outcome, 'rollback-completed')
})

await test('F1: no connection.json but the daemon\'s port answers (busy) — an owed rollback does NOT signal it', async () => {
  const env = makeEnv({ noConn: true })
  oweA(env)
  env.daemon.idleFn = () => BUSY
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy'])
  eq(kills(env), [], 'a second chroxy process deleted connection.json; the real daemon is alive and busy')
  eq(env.state().rollbackTo, A)
  assert(env.readLog().includes('something answers on port 8765'), 'says why')
})

await test('F1: connection.json names a dead pid but the port still answers — not down, not signalled', async () => {
  const env = makeEnv()
  oweA(env)
  env.daemon.livePid = 4321 // connection.json (pid 1000) is stale; the port belongs to a live daemon
  env.daemon.idleFn = () => BUSY
  env.writeConn(1000)
  const r = await env.run()
  eq(r.outcome, 'deferred-busy')
  eq(kills(env), [])
})

await test('F1: an unreadable or corrupt connection.json is not "absent": the port decides, and an answering port means unknown', async () => {
  for (const content of ['{ not json', '']) {
    const env = makeEnv()
    oweA(env)
    writeFileSync(env.path('connection.json'), content)
    env.daemon.idleFn = () => BUSY
    const r = await env.run()
    eq(r.outcome, 'deferred-busy', JSON.stringify(content))
    eq(kills(env), [])
  }
})

await test('F1: with no connection.json, a port that TIMES OUT or RESETS is unknown (not down): nothing is signalled', async () => {
  for (const err of [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })]) {
    const env = makeEnv({ noConn: true })
    oweA(env)
    env.daemon.healthThrows = err
    const r = await env.run()
    eq([r.exitCode, r.outcome], [0, 'deferred-busy'], err.message)
    eq(kills(env), [])
  }
})

await test('F1: no connection.json AND nothing listening is still DOWN, so an owed rollback proceeds', async () => {
  const env = makeEnv({ noConn: true })
  oweA(env)
  env.daemon.dead = true
  env.daemon.livePid = null
  const r = await env.run()
  eq(r.outcome, 'rollback-completed')
  assert(kills(env).length === 1, 'restarted')
})

await test('confirmLocal checks the pid: a daemon relaunched during settle under a NEW pid, same commit, healthy, is not certified', async () => {
  const env = makeEnv()
  const orig = env.deps.sleep
  let done = false
  env.deps.sleep = async (ms) => {
    await orig(ms)
    if (!done && ms === 15000 && env.daemon.commit === B) {
      done = true
      env.daemon.livePid = 5555 // launchd relaunched it: same commit, healthy
      env.writeConn(5555)
    }
  }
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('daemon pid is 5555'), 'the pid mismatch is what failed it')
})

// ---------------------------------------------------------------------------
// log lines
// ---------------------------------------------------------------------------

await test('a success line says when the tunnel was NOT checked, and why', async () => {
  const cases = {
    '--no-tunnel-check': [(e) => {}, { tunnelCheck: false }],
    'connection.json has no tunnelMode': [(e) => { e.conn = { tunnelMode: undefined }; e.writeConn(1000) }, {}],
    'tunnel mode is none': [(e) => { e.conn = { tunnelMode: 'none' }; e.writeConn(1000) }, {}],
    'a local URL': [(e) => { e.conn = { httpUrl: 'http://127.0.0.1:8765' }; e.writeConn(1000) }, {}],
  }
  for (const [reason, [setup, extra]] of Object.entries(cases)) {
    const env = makeEnv()
    setup(env)
    eq((await env.run(extra)).outcome, 'deployed', reason)
    assert(env.readLog().includes('ok (tunnel not checked:') && env.readLog().includes(reason.replace('a local URL', 'a local URL')), `${reason}: ${env.readLog().trim()}`)
  }
  const checked = makeEnv()
  await checked.run()
  assert(/ ok\n$/.test(checked.readLog()), 'a checked tunnel stays a plain "ok"')
})

await test('a deferral that lasts over 24h re-logs once per 24h, and a healthy tick ends the streak', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  const lines = () => env.readLog().trim().split('\n')
  await env.run()
  eq(lines().length, 1)
  env.t += 12 * 3600_000
  await env.run()
  eq(lines().length, 1, 'still deduped inside 24h')
  env.t += 13 * 3600_000
  await env.run()
  eq(lines().length, 2)
  assert(lines()[1].includes('still deferred since') && lines()[1].includes('busy'), lines()[1])
  await env.run()
  eq(lines().length, 2, 'once per 24h, not once per tick')
  env.t += 25 * 3600_000
  await env.run()
  eq(lines().length, 3, 'and again after another day')
  env.daemon.idleFn = () => IDLE
  env.git.remote = A
  await env.run()
  eq(env.state().deferredSince, undefined, 'a tick that does not defer ends the streak')
})

await test('a fetch-failed (or refused) tick does not end a deferral streak; only a tick that clears the condition does', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  await env.run()
  const since = env.state().deferredSince
  assert(since, 'premise: a streak started')
  env.git.fetchOk = false
  eq((await env.run()).outcome, 'fetch-failed')
  eq(env.state().deferredSince, since, 'fetch-failed says nothing about the busy daemon')
  env.git.fetchOk = true
  env.git.dirty = ' M x\n'
  eq((await env.run()).outcome, 'refused')
  eq(env.state().deferredSince, since, 'nor does a refusal')
  env.git.dirty = ''
  env.daemon.idleFn = () => IDLE
  await env.run() // deploys
  eq(env.state().deferredSince, undefined, 'a deploy does')
})

await test('a failed command that has an ERROR (a timeout, a spawn error) says so in the log line', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  env.build.error = 'spawnSync npm ETIMEDOUT'
  await env.run()
  assert(env.readLog().includes('ETIMEDOUT'), env.readLog())
})

await test('a failed build line carries the ERROR, not the stack frames that follow it', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  env.build.stderr = 'vite v5\n    at Socket.emit (node:events:518:28)\nError: Could not resolve "./missing" from "src/main.tsx"\n    at async build (file:///x.js:1:1)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)'
  await env.run()
  const log = env.readLog()
  assert(log.includes('Could not resolve "./missing"'), log)
  assert(!log.includes('Socket.emit'), 'the stack frames are not what is reported')
})

await test('a rollback line reads bad..good, never good..good', async () => {
  const env = makeEnv()
  env.daemon.brokenCommits.add(B)
  await env.run()
  assert(env.readLog().includes(`${B.slice(0, 12)}..${A.slice(0, 12)} rolled-back to ${A.slice(0, 12)}`), env.readLog())
  const owed = makeEnv()
  oweA(owed)
  await owed.run()
  assert(owed.readLog().includes(`${B.slice(0, 12)}..${A.slice(0, 12)} rollback completed to ${A.slice(0, 12)}`), owed.readLog())
})

// ---------------------------------------------------------------------------
// state is safety-critical: a write that cannot be kept aborts the run
// ---------------------------------------------------------------------------

function failRenameWhen(env, predicate) {
  const written = {}
  const paths = {}
  env.deps.fs = {
    ...realFs,
    // Atomic writes go through an O_EXCL temp file written by descriptor: remember which path each fd is.
    openSync(f, ...rest) { const fd = realFs.openSync(f, ...rest); paths[fd] = f; return fd },
    writeSync(fd, buf, ...rest) { written[paths[fd]] = (written[paths[fd]] || '') + Buffer.from(buf).toString('utf8'); return realFs.writeSync(fd, buf, ...rest) },
    renameSync(from, to) {
      if (to === env.path('deploy-state.json') && predicate(written[from] || '')) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
      return realFs.renameSync(from, to)
    },
  }
}

await test('if rollbackTo cannot be written, the run aborts BEFORE the signal: exit 1, loud, no restart', async () => {
  const env = makeEnv()
  failRenameWhen(env, (c) => c.includes('rollbackTo'))
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'state-write-failed'])
  eq(kills(env), [], 'the daemon was not signalled')
  assert(env.logs.some((l) => l.includes('ABORTED') && l.includes('ENOSPC')), 'loud on the console')
})

await test('if failedTarget cannot be written, the run aborts before it touches the tree again', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  failRenameWhen(env, (c) => c.includes('failedTarget'))
  const r = await env.run()
  eq(r.outcome, 'state-write-failed')
  assert(!env.calls.some((c) => c.startsWith('git reset')), 'no converge-back after the abort')
  eq(kills(env), [])
})

await test('an unreadable (not absent) deploy-state.json aborts: rollbackTo might be in it', async () => {
  const env = makeEnv()
  env.deps.fs = { ...realFs, openSync(f, ...rest) { if (f === env.path('deploy-state.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return realFs.openSync(f, ...rest) } }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'state-write-failed'])
  untouched(env)
})

await test('a state file that PARSES but has a malformed rollbackTo or failedTarget aborts instead of becoming "empty"', async () => {
  for (const bad of [{ rollbackTo: 'not-a-sha' }, { failedTarget: 'abc' }, { rollbackTo: 12345 }, { rollbackTo: '' }]) {
    const env = makeEnv()
    writeFileSync(env.path('deploy-state.json'), JSON.stringify(bad))
    const r = await env.run()
    eq([r.exitCode, r.outcome], [1, 'state-write-failed'], JSON.stringify(bad))
    untouched(env)
    eq(JSON.parse(readFileSync(env.path('deploy-state.json'), 'utf8')), bad, 'left for the operator, not quarantined')
    assert(env.logs.some((l) => l.includes('ABORTED') && l.includes('malformed')), 'loud')
  }
})

await test('if the stale build stamp cannot be deleted, the run aborts before changing the tree', async () => {
  const env = makeEnv()
  env.deps.fs = { ...realFs, unlinkSync(f, ...rest) { if (f === env.path('deploy-build.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return realFs.unlinkSync(f, ...rest) } }
  const r = await env.run()
  eq(r.outcome, 'state-write-failed')
  eq(mutating(env), [], 'nothing moved')
  eq(env.git.head, A)
})

await test('a corrupt deploy-state.json is quarantined with a log line and then treated as empty', async () => {
  const env = makeEnv()
  env.git.remote = A
  writeFileSync(env.path('deploy-state.json'), '{ not json')
  eq((await env.run()).outcome, 'up-to-date')
  const kept = readdirSync(env.configDir).filter((f) => f.startsWith('deploy-state.json.corrupt-'))
  eq(kept.length, 1)
  eq(readFileSync(join(env.configDir, kept[0]), 'utf8'), '{ not json')
  assert(env.readLog().includes('deploy-state.json unreadable; keeping a copy at'), 'logged')
})

await test('state, last-deploy.json and the build stamp are written by rename, never in place, and leave no tmp files', async () => {
  const env = makeEnv()
  const written = []
  const renamed = []
  env.deps.fs = {
    ...realFs,
    writeFileSync(f, ...rest) { written.push(f); return realFs.writeFileSync(f, ...rest) },
    renameSync(from, to) { renamed.push(to); return realFs.renameSync(from, to) },
  }
  eq((await env.run()).outcome, 'deployed')
  for (const f of ['deploy-state.json', 'last-deploy.json', 'deploy-build.json']) {
    assert(renamed.includes(env.path(f)), `${f} renamed into place`)
    assert(!written.includes(env.path(f)), `${f} not written in place`)
  }
  eq(readdirSync(env.configDir).filter((f) => f.includes('.tmp-')), [], 'no tmp leftovers')
})

await test('leftover files from the old lock and journal designs are deleted', async () => {
  const env = makeEnv()
  env.git.remote = A
  for (const f of ['deploy.lock', 'deploy.lock.reclaim', 'deploy-pending-restart.json']) writeFileSync(env.path(f), '1')
  await env.run()
  for (const f of ['deploy.lock', 'deploy.lock.reclaim', 'deploy-pending-restart.json']) assert(!existsSync(env.path(f)), f)
})

// ---------------------------------------------------------------------------
// the lock
// ---------------------------------------------------------------------------

await test('a run that loses the lock exits 0 with outcome locked and touches NO state, stamp or log', async () => {
  const env = makeEnv()
  heldPorts.add(47651)
  try {
    writeFileSync(env.path('deploy-state.json'), '{ not json')
    const r = await env.run()
    eq([r.exitCode, r.outcome], [0, 'locked'])
    eq(readFileSync(env.path('deploy-state.json'), 'utf8'), '{ not json', 'not even quarantined')
    eq(env.readLog(), '')
    eq(env.calls, [], 'not even git')
    assert(env.logs.some((l) => l.includes('another deploy is running (or port 47651 is in use)')), 'says so on the console')
  } finally { heldPorts.delete(47651) }
})

await test('the REAL lock: two concurrent runs, one proceeds and one reports locked', async () => {
  const free = await new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const a = makeEnv()
  const b = makeEnv()
  a.git.remote = A
  b.git.remote = A
  delete a.deps.acquireLock // use the real, default one
  delete b.deps.acquireLock
  const [ra, rb] = await Promise.all([a.run({ lockPort: free }), b.run({ lockPort: free })])
  eq([ra.outcome, rb.outcome].sort(), ['locked', 'up-to-date'])
  // and it is free again afterwards
  const again = await a.run({ lockPort: free })
  eq(again.outcome, 'up-to-date')
})

await test('the lock is released even when the run throws', async () => {
  const env = makeEnv()
  const orig = env.deps.run
  env.deps.run = (cmd, args, o) => { if (cmd === 'git' && args[0] === 'fetch') throw new Error('exploded'); return orig(cmd, args, o) }
  eq((await env.run()).outcome, 'failed')
  assert(!heldPorts.has(47651), 'released')
})

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------

await test('--dry-run reports running/HEAD/stamp/desired, the owed rollback and the failed target, and writes nothing', async () => {
  const env = makeEnv()
  env.build.failShas.add(B)
  await env.run() // leaves failedTarget B
  writeFileSync(env.path('deploy-state.json'), JSON.stringify({ failedTarget: B, failedOutcome: 'rolled-back-build', rollbackTo: A }))
  env.calls.length = 0
  env.logs.length = 0
  const snapshot = (f) => (existsSync(env.path(f)) ? readFileSync(env.path(f), 'utf8') : null)
  const before = ['deploy-state.json', 'deploy-build.json', 'last-deploy.json', 'logs/deploy.log'].map(snapshot)
  const r = await env.run({ dryRun: true })
  eq([r.exitCode, r.outcome], [0, 'dry-run'])
  const out = env.logs.join('\n')
  assert(out.includes(`daemon runs: ${A.slice(0, 12)}`), 'the running commit')
  assert(out.includes('checkout HEAD') && out.includes('build stamp'), 'HEAD and stamp')
  assert(out.includes(`owed rollback: ${A.slice(0, 12)}`), 'the owed rollback')
  assert(out.includes(`failed target: ${B.slice(0, 12)}`), 'the failed target')
  assert(out.includes('desired:'), 'the desired commit')
  eq(mutating(env), [])
  eq(['deploy-state.json', 'deploy-build.json', 'last-deploy.json', 'logs/deploy.log'].map(snapshot), before, 'no file changed')
  assert(!heldPorts.has(47651))
})

await test('--dry-run of a plain forward deploy lists the commits and the steps, and mutates nothing', async () => {
  const env = makeEnv()
  const r = await env.run({ dryRun: true })
  eq(r.outcome, 'dry-run')
  const out = env.logs.join('\n')
  assert(out.includes('bbbbbbb feat: x'), 'the commits ahead')
  assert(out.includes(KILL), 'the restart command')
  eq(mutating(env), [])
  eq(env.stamp().sha, A)
})

// ---------------------------------------------------------------------------
// real git
// ---------------------------------------------------------------------------

function makeRepos() {
  const env = makeEnv({ realGit: true })
  const origin = join(env.root, 'origin.git')
  const dev = join(env.root, 'dev')
  mkdirSync(origin)
  g(origin, 'init', '--bare', '-b', 'main')
  mkdirSync(dev)
  g(dev, 'init', '-b', 'main')
  g(dev, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dev, 'a.txt'), 'one\n')
  writeFileSync(join(dev, 'package-lock.json'), '{"v":1}\n')
  g(dev, 'add', 'a.txt', 'package-lock.json')
  g(dev, 'commit', '-m', 'first')
  g(dev, 'remote', 'add', 'origin', origin)
  g(dev, 'push', 'origin', 'main')
  g(env.root, 'clone', origin, env.checkout)
  g(env.checkout, 'config', 'commit.gpgsign', 'false')
  const first = g(env.checkout, 'rev-parse', 'HEAD')
  env.daemon.commit = first
  env.seedStamp(first)
  const push = (file, content, msg) => {
    writeFileSync(join(dev, file), content)
    g(dev, 'add', file)
    g(dev, 'commit', '-m', msg)
    g(dev, 'push', 'origin', 'main')
    return g(dev, 'rev-parse', 'HEAD')
  }
  return { env, origin, dev, push, first, head: () => g(env.checkout, 'rev-parse', 'HEAD') }
}

await test('real git: a fast-forward deploy merges the pushed commit, builds, and the daemon reports it', async () => {
  const { env, push, head, first } = makeRepos()
  const target = push('b.txt', 'two\n', 'second commit')
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(head(), target)
  eq(readFileSync(join(env.checkout, 'b.txt'), 'utf8'), 'two\n', 'working tree updated')
  eq([env.last().from, env.last().to, env.last().subject], [first, target, 'second commit'])
  eq(env.stamp().sha, target)
  assert(!env.calls.includes(CI), 'the lockfile did not change, so no npm ci')
})

await test('real git: a lockfile change is seen in the real working tree and npm ci runs before the build', async () => {
  const { env, push } = makeRepos()
  push('package-lock.json', '{"v":2}\n', 'bump lock')
  eq((await env.run()).outcome, 'deployed')
  eq(mutating(env).filter((c) => c.startsWith('npm')), [CI, BUILD])
})

await test('real git: a failed build resets the real checkout to the old commit and tree, and rebuilds it', async () => {
  const { env, push, head, first } = makeRepos()
  const target = push('b.txt', 'two\n', 'second commit')
  env.build.failShas.add(target)
  const r = await env.run()
  eq(r.outcome, 'rolled-back-build')
  eq(head(), first)
  assert(!existsSync(join(env.checkout, 'b.txt')), 'the new commit\'s file is gone')
  eq(env.stamp().sha, first)
  eq(kills(env), [])
})

await test('real git: a health failure rolls the real checkout and the daemon back to the old commit', async () => {
  const { env, push, head, first } = makeRepos()
  const target = push('b.txt', 'two\n', 'second commit')
  env.daemon.brokenCommits.add(target)
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  eq([head(), env.daemon.commit], [first, first])
})

await test('real git: a checkout with a local commit (ahead/diverged) is refused and keeps its commit', async () => {
  const { env, push, head } = makeRepos()
  writeFileSync(join(env.checkout, 'local.txt'), 'x\n')
  g(env.checkout, 'add', 'local.txt')
  g(env.checkout, 'commit', '-m', 'local only')
  const localHead = head()
  push('b.txt', 'two\n', 'second commit')
  env.daemon.commit = localHead
  env.seedStamp(localHead)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  eq(head(), localHead, 'the local commit was not reset away')
  eq(mutating(env), [])
})

await test('real git: a modified tracked file or an untracked file makes the tree dirty and is refused', async () => {
  for (const dirty of [(c) => writeFileSync(join(c, 'a.txt'), 'edited\n'), (c) => writeFileSync(join(c, 'stray.txt'), 's\n')]) {
    const { env, push, head } = makeRepos()
    push('b.txt', 'two\n', 'second commit')
    const old = head()
    dirty(env.checkout)
    const r = await env.run()
    eq([r.exitCode, r.outcome], [1, 'refused'])
    eq(head(), old)
    eq(mutating(env), [])
  }
})

await test('real git: up to date against a real origin is a no-op', async () => {
  const { env } = makeRepos()
  const r = await env.run()
  eq(r.outcome, 'up-to-date')
  eq(mutating(env), [])
})

// ---------------------------------------------------------------------------
// the dashboard banner's files (#8331): pending-update.json, deploy-postpone.json,
// deploy-request.json
// ---------------------------------------------------------------------------

const isoAt = (ms) => new Date(ms).toISOString()
const readIf = (env, f) => (existsSync(env.path(f)) ? JSON.parse(readFileSync(env.path(f), 'utf8')) : null)
const writeReq = (env, o = {}) => {
  const r = { action: 'restart-now', target: B, force: true, requestedAt: isoAt(env.t), nonce: 'n1', ...o }
  writeFileSync(env.path('deploy-request.json'), JSON.stringify(r))
  return r
}
const writePostpone = (env, o = {}) => writeFileSync(env.path('deploy-postpone.json'), JSON.stringify({ target: B, until: isoAt(env.t + 3600e3), requestedAt: isoAt(env.t), ...o }))
const writePending = (env, o = {}) => writeFileSync(env.path('pending-update.json'), JSON.stringify({ target: B, from: A, subject: 's', commitsAhead: 1, queuedAt: isoAt(env.t), reason: 'busy', ...o }))

await test('pending-update.json: written when a forward deploy is deferred busy, with a stable queuedAt until the target changes', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  eq((await env.run()).outcome, 'deferred-busy')
  const p1 = readIf(env, 'pending-update.json')
  eq([p1.target, p1.from, p1.subject, p1.commitsAhead, p1.reason], [B, A, 'feat: x', 1, 'busy'])
  assert(Number.isFinite(Date.parse(p1.queuedAt)), 'queuedAt is a timestamp')
  env.t += 5 * 60e3
  await env.run()
  eq(readIf(env, 'pending-update.json').queuedAt, p1.queuedAt, 'the same target keeps its queuedAt across ticks')
  env.git.remote = C
  env.t += 5 * 60e3
  await env.run()
  const p3 = readIf(env, 'pending-update.json')
  eq(p3.target, C)
  assert(p3.queuedAt !== p1.queuedAt, 'a new target starts a new clock')
})

await test('pending-update.json: reason is unknown when the daemon cannot say whether it is idle', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => 'throw'
  eq((await env.run()).outcome, 'deferred-unavailable')
  eq(readIf(env, 'pending-update.json').reason, 'unknown')
})

await test('pending-update.json: removed by a verified deploy, an up-to-date tick and a skipped failed target', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  await env.run()
  assert(readIf(env, 'pending-update.json'), 'queued')
  env.daemon.idleFn = () => IDLE
  eq((await env.run()).outcome, 'deployed')
  eq(readIf(env, 'pending-update.json'), null, 'deployed: gone')

  const upToDate = makeEnv()
  upToDate.git.remote = A
  writePending(upToDate)
  eq((await upToDate.run()).outcome, 'up-to-date')
  eq(readIf(upToDate, 'pending-update.json'), null, 'up to date: gone')

  const skipped = makeEnv()
  writeFileSync(skipped.path('deploy-state.json'), JSON.stringify({ failedTarget: B, failedOutcome: 'rolled-back-build' }))
  writePending(skipped)
  eq((await skipped.run()).outcome, 'skipped-failed-target')
  eq(readIf(skipped, 'pending-update.json'), null, 'a target that rolled back is not waiting')

  const failed = makeEnv()
  failed.daemon.idleFn = () => BUSY
  await failed.run()
  failed.daemon.idleFn = () => IDLE
  failed.build.failShas.add(B)
  eq((await failed.run()).outcome, 'rolled-back-build')
  eq(readIf(failed, 'pending-update.json'), null, 'a failed build: gone')
})

await test('a pending/request/postpone file that cannot be written or removed never aborts or changes a deploy', async () => {
  const busy = makeEnv()
  mkdirSync(busy.path('pending-update.json')) // a directory where the file belongs: write and unlink both fail
  busy.daemon.idleFn = () => BUSY
  eq((await busy.run()).outcome, 'deferred-busy')
  const idle = makeEnv()
  mkdirSync(idle.path('pending-update.json'))
  mkdirSync(idle.path('deploy-postpone.json'))
  mkdirSync(idle.path('deploy-request.json'))
  const r = await idle.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(idle.daemon.commit, B)
})

await test('--dry-run writes none of the banner files and consumes none of them', async () => {
  const fresh = makeEnv()
  fresh.daemon.idleFn = () => BUSY
  eq((await fresh.run({ dryRun: true })).outcome, 'dry-run')
  for (const f of ['pending-update.json', 'deploy-postpone.json', 'deploy-request.json']) eq(readIf(fresh, f), null, `${f} not created`)

  const seeded = makeEnv()
  writeReq(seeded)
  writePostpone(seeded, { target: C })
  writePending(seeded)
  const before = ['pending-update.json', 'deploy-postpone.json', 'deploy-request.json'].map((f) => readFileSync(seeded.path(f), 'utf8'))
  await seeded.run({ dryRun: true })
  const after = ['pending-update.json', 'deploy-postpone.json', 'deploy-request.json'].map((f) => readFileSync(seeded.path(f), 'utf8'))
  eq(after, before, 'byte-identical: nothing was deleted or rewritten')
})

await test('postpone: a matching target waits out its deadline even on an IDLE daemon, then deploys and removes the file', async () => {
  const env = makeEnv()
  writePostpone(env)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'postponed'])
  untouched(env)
  eq(readIf(env, 'pending-update.json').reason, 'postponed')
  assert(env.readLog().includes('postponed until'), 'logged')
  assert(readIf(env, 'deploy-postpone.json'), 'the postpone stays until it expires')
  env.t += 2 * 3600e3
  eq((await env.run()).outcome, 'deployed')
  eq(readIf(env, 'deploy-postpone.json'), null, 'expired: removed')
})

await test('postpone: a postpone for another target, a malformed one, and --force do not defer', async () => {
  const other = makeEnv()
  writePostpone(other, { target: C })
  eq((await other.run()).outcome, 'deployed')
  eq(readIf(other, 'deploy-postpone.json'), null, 'a postpone for a commit main moved past is removed')

  const bad = makeEnv()
  writeFileSync(bad.path('deploy-postpone.json'), '{"target":"nope"}')
  eq((await bad.run()).outcome, 'deployed')
  eq(readIf(bad, 'deploy-postpone.json'), null)

  const forced = makeEnv()
  writePostpone(forced)
  eq((await forced.run({ force: true })).outcome, 'deployed')
})

await test('postpone never gates a rollback or a repair', async () => {
  const env = makeEnv()
  oweA(env)
  env.git.remote = C // the postponed target is the remote tip, and not what the daemon runs
  writePostpone(env, { target: C })
  const r = await env.run()
  eq(r.outcome, 'rollback-completed')
  eq(env.daemon.commit, A)

  const repair = makeEnv()
  repair.git.remote = B
  repair.git.head = A
  repair.daemon.commit = B // the daemon already runs the tip, only the checkout is behind
  writePostpone(repair, { target: B })
  const r2 = await repair.run()
  eq(r2.outcome, 'repaired')
  eq(kills(repair), [])
})

await test('request: force:true skips the BUSY gates for the forward deploy, and the request file is consumed', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env)
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(env.daemon.commit, B)
  eq(readIf(env, 'deploy-request.json'), null, 'consumed')
  assert(env.readLog().includes('deploy request n1 accepted'), 'logged')
})

await test('request: force:false does not skip the idle gate (but is still consumed)', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { force: false })
  eq((await env.run()).outcome, 'deferred-busy')
  untouched(env)
  eq(readIf(env, 'deploy-request.json'), null)
})

await test('request: a force request does not skip an unreachable daemon (only --force does)', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => ({ status: 500, body: {} })
  writeReq(env)
  eq((await env.run()).outcome, 'deferred-unavailable')
  untouched(env)
})

await test('request: a stale request is ignored and deleted, and buys nothing', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { requestedAt: isoAt(env.t - 21 * 60e3) })
  eq((await env.run()).outcome, 'deferred-busy')
  untouched(env)
  eq(readIf(env, 'deploy-request.json'), null)
  assert(env.readLog().includes('stale deploy request'), 'says why')
  const fresh = makeEnv()
  fresh.daemon.idleFn = () => BUSY
  writeReq(fresh, { requestedAt: isoAt(fresh.t - 19 * 60e3) })
  eq((await fresh.run()).outcome, 'deployed') // 19 minutes is inside the window
})

await test('request: a request for a different target, or when there is nothing to deploy, is ignored and deleted', async () => {
  const mismatch = makeEnv()
  mismatch.daemon.idleFn = () => BUSY
  writeReq(mismatch, { target: C })
  eq((await mismatch.run()).outcome, 'deferred-busy')
  untouched(mismatch)
  eq(readIf(mismatch, 'deploy-request.json'), null)

  const failedTip = makeEnv()
  failedTip.daemon.idleFn = () => BUSY
  writeFileSync(failedTip.path('deploy-state.json'), JSON.stringify({ failedTarget: B, failedOutcome: 'rolled-back-build' }))
  writeReq(failedTip)
  eq((await failedTip.run()).outcome, 'skipped-failed-target')
  untouched(failedTip)
  eq(readIf(failedTip, 'deploy-request.json'), null, 'a request is not --retry')
})

await test('request: a malformed or oversized request is ignored and deleted', async () => {
  for (const content of ['not json', '[]', JSON.stringify({ action: 'restart-now', target: B, force: true, requestedAt: isoAt(Date.now()), nonce: 'n1', pad: 'x'.repeat(5000) }),
    JSON.stringify({ action: 'restart-now', target: B, force: 'yes', requestedAt: isoAt(Date.now()), nonce: 'n1' }),
    // Valid JSON padded past the cap: the bounded read still PARSES, so only the size check refuses it.
    JSON.stringify({ action: 'restart-now', target: B, force: true, requestedAt: isoAt(Date.now()), nonce: 'n1' }) + ' '.repeat(5000)]) {
    const env = makeEnv()
    env.daemon.idleFn = () => BUSY
    writeFileSync(env.path('deploy-request.json'), content)
    eq((await env.run()).outcome, 'deferred-busy', content.slice(0, 20))
    untouched(env)
    eq(readIf(env, 'deploy-request.json'), null)
  }
})

await test('request: any accepted request overrides a postpone and removes it', async () => {
  const env = makeEnv()
  writePostpone(env)
  writeReq(env, { force: false })
  eq((await env.run()).outcome, 'deployed')
  eq(readIf(env, 'deploy-postpone.json'), null)
  const stale = makeEnv()
  writePostpone(stale)
  writeReq(stale, { requestedAt: isoAt(stale.t - 21 * 60e3) })
  eq((await stale.run()).outcome, 'postponed', 'a stale request does not override')
})

await test('request: a NEWER request written while the tick ran cannot be deleted by it (the tick CLAIMED its own), and is drained by one more tick', async () => {
  const env = makeEnv()
  writeReq(env, { nonce: 'n1', force: false })
  env.onRun = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'merge') {
      env.onRun = null
      writeReq(env, { nonce: 'n2', force: false })
    }
  }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(r.drained, 'up-to-date', 'the second tick ran and found nothing to deploy')
  assert(env.readLog().includes('ignored a deploy request'), 'and consumed n2 as having nothing to apply')
  eq(readIf(env, 'deploy-request.json'), null)
  eq(kills(env).length, 1, 'one restart only')
  eq(readdirSync(env.configDir).filter((n) => n.includes('.claimed-')), [], 'no claim left behind')
})

await test('request: a newer request that lands between the tick\'s READ of its request and its DELETE survives (the claim is atomic)', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { nonce: 'n1', force: false })
  const paths = {}
  let fired = false
  env.deps.fs = {
    ...realFs,
    openSync(f, ...rest) { const fd = realFs.openSync(f, ...rest); paths[fd] = f; return fd },
    // The moment the tick has finished READING its request file, the daemon renames a newer one into place.
    closeSync(fd) {
      const p = paths[fd]
      if (!fired && p && p.startsWith(env.path('deploy-request.json'))) { fired = true; writeReq(env, { nonce: 'n2', force: true }) }
      return realFs.closeSync(fd)
    },
  }
  const r = await env.run()
  assert(fired, 'the interleaving happened')
  // n2 is force:true on a busy daemon: it can only be seen by the drain tick, which then deploys.
  eq(r.drained, 'deployed', 'the newer request was drained, not deleted')
  eq(readIf(env, 'deploy-request.json'), null)
})

await test('request: no drain without a newer request, and it never loops', async () => {
  const env = makeEnv()
  writeReq(env)
  const r = await env.run()
  eq(r.drained, undefined)
  eq(kills(env).length, 1)
})

await test('request: a claim a crashed tick left behind is removed once older than the TTL, a fresh one is not', async () => {
  const env = makeEnv()
  const old = env.path('deploy-request.json.claimed-aaaa')
  const fresh = env.path('deploy-request.json.claimed-bbbb')
  writeFileSync(old, '{}'); writeFileSync(fresh, '{}')
  const longAgo = new Date(Date.now() - 21 * 60e3)
  utimesSync(old, longAgo, longAgo)
  env.git.remote = A // nothing to do: the cleanup runs regardless
  await env.run()
  assert(!existsSync(old), 'the stale claim is removed')
  assert(existsSync(fresh), 'a fresh one is left alone')
})

await test('dry-run leaves a live request exactly where it is (it is read, never claimed)', async () => {
  const env = makeEnv()
  writeReq(env)
  await env.run({ dryRun: true })
  assert(existsSync(env.path('deploy-request.json')), 'still there')
  eq(readdirSync(env.configDir).filter((n) => n.includes('.claimed-')), [])
})

await test('postpone: a year-9999 deadline, a far-future requestedAt and a missing requestedAt are ignored and deleted', async () => {
  for (const [why, post] of [
    ['year 9999', { until: '9999-12-31T00:00:00.000Z' }],
    ['far-future requestedAt', { requestedAt: isoAt(Date.now() + 400 * 864e5), until: isoAt(Date.now() + 400 * 864e5 + 3600e3) }],
    ['two hours', { until: isoAt(Date.now() + 2 * 3600e3) }],
  ]) {
    const env = makeEnv()
    writePostpone(env, post)
    eq((await env.run()).outcome, 'deployed', why)
    eq(readIf(env, 'deploy-postpone.json'), null, `${why}: deleted`)
  }
  const missing = makeEnv()
  writeFileSync(missing.path('deploy-postpone.json'), JSON.stringify({ target: B, until: isoAt(missing.t + 3600e3) }))
  eq((await missing.run()).outcome, 'deployed', 'no requestedAt')
})

await test('postpone: the daemon\'s own hour is honoured, and so is a minute of slack; a second more is not', async () => {
  const ok = makeEnv()
  writePostpone(ok, { requestedAt: isoAt(ok.t), until: isoAt(ok.t + POSTPONE_MAX_MS) })
  eq((await ok.run()).outcome, 'postponed')
  const over = makeEnv()
  writePostpone(over, { requestedAt: isoAt(over.t), until: isoAt(over.t + POSTPONE_MAX_MS + 1000) })
  eq((await over.run()).outcome, 'deployed')
  const skewed = makeEnv()
  writePostpone(skewed, { requestedAt: isoAt(skewed.t + REQUEST_SKEW_MS - 1000), until: isoAt(skewed.t + REQUEST_SKEW_MS + 3600e3) })
  eq((await skewed.run()).outcome, 'postponed', 'a few minutes of clock skew is tolerated')
})

await test('postpone: one that lands DURING the build holds — the tree goes back, nothing restarts, outcome postponed', async () => {
  const env = makeEnv()
  env.onRun = (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'run') { env.onRun = null; writePostpone(env, { requestedAt: isoAt(env.t), until: isoAt(env.t + 3600e3) }) }
  }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'postponed'])
  eq(kills(env), [], 'never signalled')
  eq([env.git.head, env.stamp().sha], [A, A], 'the checkout and build are back on what the daemon runs')
  eq(readIf(env, 'pending-update.json').reason, 'postponed')
  eq(env.state().rollbackTo, undefined, 'nothing owed')
})

await test('postpone: one that lands during the build does NOT hold against an accepted restart request, or --force', async () => {
  const req = makeEnv()
  writeReq(req, { force: false })
  req.onRun = (cmd, args) => { if (cmd === 'npm' && args[0] === 'run') { req.onRun = null; writePostpone(req) } }
  eq((await req.run()).outcome, 'deployed')
  const forced = makeEnv()
  forced.onRun = (cmd, args) => { if (cmd === 'npm' && args[0] === 'run') { forced.onRun = null; writePostpone(forced) } }
  eq((await forced.run({ force: true })).outcome, 'deployed')
})

await test('hostile files: a symlink, a directory or an oversized file at each control-file name reads as absent', async () => {
  for (const name of ['deploy-request.json', 'deploy-postpone.json']) {
    for (const plant of ['symlink', 'directory', 'oversize']) {
      const env = makeEnv()
      const target = name === 'deploy-request.json' ? { action: 'restart-now', target: B, force: true, requestedAt: isoAt(env.t), nonce: 'n1' } : { target: B, until: isoAt(env.t + 3600e3), requestedAt: isoAt(env.t) }
      env.daemon.idleFn = () => BUSY
      const real = env.path('real.json')
      if (plant === 'symlink') { writeFileSync(real, JSON.stringify(target)); symlinkSync(real, env.path(name)) }
      else if (plant === 'directory') mkdirSync(env.path(name))
      else writeFileSync(env.path(name), JSON.stringify(target) + ' '.repeat(5000))
      const r = await env.run()
      const why = `${name} as ${plant}`
      // A forced request or an honoured postpone would change the outcome from "busy, deferred".
      eq(r.outcome, 'deferred-busy', why)
      eq(kills(env), [], why)
    }
  }
  const state = makeEnv()
  writeFileSync(state.path('real-state.json'), JSON.stringify({ rollbackTo: A }))
  symlinkSync(state.path('real-state.json'), state.path('deploy-state.json'))
  eq((await state.run()).outcome, 'state-write-failed', 'a symlinked state file is unreadable, which aborts rather than reading as empty')
})

await test('hostile files: a FIFO at each file the script reads never blocks it (run in a child with a timeout)', () => {
  for (const [file, mode, outcome] of [
    ['deploy-request.json', 'idle', 'deployed'],
    ['deploy-postpone.json', 'idle', 'deployed'],
    ['pending-update.json', 'busy', 'deferred-busy'],
    ['deploy-state.json', 'idle', 'state-write-failed'],
  ]) {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--fifo-child', file, mode], { encoding: 'utf8', timeout: 20000 })
    assert(!r.error, `${file}: the script blocked on a FIFO (${r.error && r.error.code})`)
    eq(JSON.parse(r.stdout).outcome, outcome, `${file} as a FIFO`)
  }
})

await test('writes use unpredictable temp names: a symlink planted at the old pid-based name is never followed', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeFileSync(env.path('victim.txt'), 'precious')
  for (const f of ['pending-update.json', 'deploy-state.json', 'last-deploy.json']) symlinkSync(env.path('victim.txt'), env.path(`${f}.tmp-4242`))
  eq((await env.run()).outcome, 'deferred-busy')
  eq(readFileSync(env.path('victim.txt'), 'utf8'), 'precious')
  assert(readIf(env, 'pending-update.json'), 'and the pending file was still written')
  const ok = makeEnv()
  writeFileSync(ok.path('victim.txt'), 'precious')
  for (const f of ['pending-update.json', 'deploy-state.json', 'last-deploy.json', 'deploy-build.json']) symlinkSync(ok.path('victim.txt'), ok.path(`${f}.tmp-4242`))
  eq((await ok.run()).outcome, 'deployed')
  eq(readFileSync(ok.path('victim.txt'), 'utf8'), 'precious')
  eq(readdirSync(ok.configDir).filter((n) => /\.tmp-[0-9a-f]{16}$/.test(n)), [], 'no temp file is left behind')
})

// -- round 2 (#8331) ---------------------------------------------------------

// A filesystem whose reads come back SHORT, the way a network filesystem may return them.
const shortReadFs = (env, { match, chunk }) => {
  const paths = {}
  return {
    ...realFs,
    openSync(f, ...rest) { const fd = realFs.openSync(f, ...rest); paths[fd] = f; return fd },
    readSync(fd, buf, off, len, pos) { return realFs.readSync(fd, buf, off, paths[fd] && match(paths[fd]) ? Math.min(len, chunk) : len, pos) },
  }
}

await test('a SHORT read of deploy-state.json is completed, never mistaken for corrupt state: the owed rollback still happens', async () => {
  const env = makeEnv()
  oweA(env)
  env.deps.fs = shortReadFs(env, { match: (p) => p === env.path('deploy-state.json'), chunk: 8 })
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'rollback-completed'])
  eq([env.daemon.commit, env.state().rollbackTo], [A, undefined])
  assert(!readdirSync(env.configDir).some((n) => n.includes('.corrupt-')), 'the state file was not quarantined')
})

await test('an oversized request split across reads is still refused', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeFileSync(env.path('deploy-request.json'), JSON.stringify({ action: 'restart-now', target: B, force: true, requestedAt: isoAt(env.t), nonce: 'n1' }) + ' '.repeat(5000))
  env.deps.fs = shortReadFs(env, { match: (p) => p.includes('deploy-request.json'), chunk: 1000 })
  eq((await env.run()).outcome, 'deferred-busy', 'the padded request did not force a deploy')
})

await test('an I/O error reading the state file aborts the tick and leaves it in place (read error is not corruption)', async () => {
  const env = makeEnv()
  oweA(env)
  const before = readFileSync(env.path('deploy-state.json'), 'utf8')
  const paths = {}
  env.deps.fs = {
    ...realFs,
    openSync(f, ...rest) { const fd = realFs.openSync(f, ...rest); paths[fd] = f; return fd },
    readSync(fd, ...rest) { if (paths[fd] === env.path('deploy-state.json')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return realFs.readSync(fd, ...rest) },
  }
  const r = await env.run()
  eq(r.outcome, 'state-write-failed')
  eq(readFileSync(env.path('deploy-state.json'), 'utf8'), before, 'untouched, not quarantined')
  eq(kills(env), [])
})

await test('request: a transient read error does not consume the request: it is put back and a later tick applies it', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { nonce: 'n1', force: true })
  let failed = false
  env.deps.fs = {
    ...realFs,
    openSync(f, ...rest) {
      if (!failed && f.includes('deploy-request.json.claimed-')) { failed = true; throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }) }
      return realFs.openSync(f, ...rest)
    },
  }
  const first = await env.run()
  assert(failed, 'the error was injected')
  eq(first.outcome, 'deferred-busy', 'this tick did not act on it')
  eq(first.drained, undefined, 'and did not drain it into the same error')
  assert(existsSync(env.path('deploy-request.json')), 'the request is back at the live path')
  eq(readdirSync(env.configDir).filter((n) => n.includes('.claimed-')), [], 'no claim left behind')
  assert(env.readLog().includes('could not read deploy-request.json'), 'logged')
  env.deps.fs = realFs
  eq((await env.run()).outcome, 'deployed', 'the next tick applies the very same request')
})

await test('request: a put-back never clobbers a NEWER request that arrived meanwhile (no-clobber link)', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { nonce: 'n1', force: false })
  let failed = false
  env.deps.fs = {
    ...realFs,
    openSync(f, ...rest) {
      if (!failed && f.includes('deploy-request.json.claimed-')) { failed = true; writeReq(env, { nonce: 'n2', force: false }); throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }) }
      return realFs.openSync(f, ...rest)
    },
  }
  await env.run()
  eq(readIf(env, 'deploy-request.json').nonce, 'n2', 'the newer request survived')
  eq(readdirSync(env.configDir).filter((n) => n.includes('.claimed-')), [], 'and the old claim was dropped')
})

await test('applying: from the moment a forward deploy starts building, pending-update.json says reason "applying"; it is gone once deployed', async () => {
  const env = makeEnv()
  const seen = []
  env.onRun = (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    if (key === BUILD || key === KILL) seen.push([key === BUILD ? 'build' : 'kill', readIf(env, 'pending-update.json')?.reason])
  }
  eq((await env.run()).outcome, 'deployed')
  eq(seen, [['build', 'applying'], ['kill', 'applying']])
  eq(readIf(env, 'pending-update.json'), null)
})

await test('applying: a failed build clears it, and a daemon that turns busy during the build goes back to "busy"', async () => {
  const failed = makeEnv()
  failed.build.failShas.add(B)
  await failed.run()
  eq(readIf(failed, 'pending-update.json'), null)
  const busy = makeEnv()
  let probes = 0
  busy.daemon.idleFn = () => (probes++ === 0 ? IDLE : BUSY)
  eq((await busy.run()).outcome, 'deferred-busy-after-build')
  eq(readIf(busy, 'pending-update.json').reason, 'busy')
})

await test('postpone: one that lands during the FINAL asynchronous idle probe still holds (checked immediately before the signal)', async () => {
  const env = makeEnv()
  let probes = 0
  env.daemon.idleFn = () => {
    // probe 0 = the tick's own, probe 1 = the post-build re-check
    if (probes++ === 1) writePostpone(env, { requestedAt: isoAt(env.t), until: isoAt(env.t + 3600e3) })
    return IDLE
  }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'postponed'])
  eq(kills(env), [], 'never signalled')
  eq([env.git.head, env.stamp().sha], [A, A])
})

await test('last-deploy.json: a long commit subject is capped at 200 characters', async () => {
  const env = makeEnv()
  env.git.subject = 'x'.repeat(500)
  await env.run()
  eq(env.last().subject.length, 200)
})

await test('postpone: a deadline outside years 1970-9999 (the extended-year form) is ignored and deleted', async () => {
  for (const until of ['+275760-09-13T00:00:00.000Z', '0001-01-01T00:00:00.000Z']) {
    const env = makeEnv()
    writePostpone(env, { until, requestedAt: until })
    eq((await env.run()).outcome, 'deployed', until)
    eq(readIf(env, 'deploy-postpone.json'), null, `${until}: deleted`)
  }
})

// -- round 3 (#8331) ---------------------------------------------------------

await test('request: an UNREADABLE request is retried within the TTL and dropped (logged) once it is older than the TTL', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { nonce: 'n1', force: true })
  const alwaysDenied = {
    ...realFs,
    openSync(f, ...rest) {
      if (f.includes('deploy-request.json.claimed-')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return realFs.openSync(f, ...rest)
    },
  }
  env.deps.fs = alwaysDenied
  for (let i = 0; i < 2; i++) {
    eq((await env.run()).outcome, 'deferred-busy')
    assert(existsSync(env.path('deploy-request.json')), `tick ${i + 1}: put back, still within the TTL`)
    env.t += 5 * 60e3
  }
  env.t += 20 * 60e3 // now well past the TTL since the request was written
  eq((await env.run()).outcome, 'deferred-busy')
  assert(!existsSync(env.path('deploy-request.json')), 'dropped, not put back')
  eq(readdirSync(env.configDir).filter((n) => n.includes('.claimed-')), [], 'and no claim left')
  assert(env.readLog().includes('dropped an unreadable deploy-request.json'), 'logged')
  eq(env.readLog().split('dropped an unreadable').length - 1, 1, 'logged once')
  eq((await env.run()).outcome, 'deferred-busy', 'and nothing is left to retry')
})

await test('applying from ACCEPTANCE: the moment a request is accepted, a Postpone is already refused (APPLYING)', async () => {
  const { DaemonUpdateStatus } = await import('../../packages/server/src/daemon-update-status.js')
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { force: true })
  let refused = null
  const real = env.deps.fs
  env.deps.fs = {
    ...real,
    // The acceptance line is logged right after the marker is written, before any probe or build.
    appendFileSync(f, content, ...rest) {
      if (refused === null && String(content).includes('accepted for')) {
        refused = new DaemonUpdateStatus({ dir: env.configDir, running: A, now: () => env.t }).postpone({ target: B })
        eq(readIf(env, 'pending-update.json').reason, 'applying')
      }
      return real.appendFileSync(f, content, ...rest)
    },
  }
  eq((await env.run()).outcome, 'deployed')
  eq(refused?.code, 'APPLYING')
  eq(existsSync(env.path('deploy-postpone.json')), false, 'the refused postpone wrote nothing')
})

await test('applying from acceptance: a request that is accepted but then deferred leaves the update waiting again, not stuck "applying"', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writeReq(env, { force: false })
  eq((await env.run()).outcome, 'deferred-busy')
  eq(readIf(env, 'pending-update.json').reason, 'busy')
})

await test('applying carries applyingSince, and a stale one (a crashed tick) is cleared by a tick that does not converge', async () => {
  const seen = []
  const env = makeEnv()
  env.onRun = (cmd, args) => { if ([cmd, ...args].join(' ') === BUILD) seen.push(readIf(env, 'pending-update.json')) }
  await env.run()
  assert(Number.isFinite(Date.parse(seen[0].applyingSince)), 'applyingSince is a timestamp')
  assert(Math.abs(Date.parse(seen[0].applyingSince) - env.t) < 5 * 60e3, 'and recent')

  const upToDate = makeEnv()
  upToDate.git.remote = A
  writePending(upToDate, { reason: 'applying', applyingSince: isoAt(upToDate.t - 31 * 60e3) })
  eq((await upToDate.run()).outcome, 'up-to-date')
  eq(readIf(upToDate, 'pending-update.json'), null, 'a stale applying marker is gone')

  const noSince = makeEnv()
  noSince.git.remote = A
  writePending(noSince, { reason: 'applying' })
  await noSince.run()
  eq(readIf(noSince, 'pending-update.json'), null, 'one with no applyingSince counts as stale')

  const live = makeEnv()
  live.git.remote = A
  writePending(live, { reason: 'applying', applyingSince: isoAt(live.t - 5 * 60e3) })
  await live.run()
  eq(readIf(live, 'pending-update.json'), null, 'nothing waits any more, so even a fresh marker goes at up-to-date')

  const deferred = makeEnv()
  deferred.daemon.idleFn = () => BUSY
  writePending(deferred, { reason: 'applying', applyingSince: isoAt(deferred.t - 31 * 60e3) })
  await deferred.run()
  eq(readIf(deferred, 'pending-update.json').reason, 'busy', 'a tick that defers rewrites it as the waiting state')
})

await test('a stale applying marker is cleared even by a tick that only defers an OWED ROLLBACK (it sets no pending state of its own)', async () => {
  const env = makeEnv()
  oweA(env)
  env.daemon.idleFn = () => BUSY
  writePending(env, { reason: 'applying', applyingSince: isoAt(env.t - 31 * 60e3) })
  eq((await env.run()).outcome, 'deferred-busy')
  eq(readIf(env, 'pending-update.json'), null)
})

await test('a stale applying marker is logged as cleared', async () => {
  const env = makeEnv()
  env.daemon.idleFn = () => BUSY
  writePending(env, { reason: 'applying', applyingSince: isoAt(env.t - 31 * 60e3) })
  await env.run()
  assert(env.readLog().includes('cleared a stale "applying" marker'), 'logged')
})

// ---------------------------------------------------------------------------

for (const r of roots) rmSync(r, { recursive: true, force: true })

// A count floor. "Every case passed" and "no case ran" must not be the same
// observable outcome (docs/false-safety-guards.md; #7653). MIN_CASES is the
// exact number of cases above; the check below also fails if a case is ADDED
// without bumping it, so the floor cannot drift low.
const EXPECTED = pass + fail
if (EXPECTED !== MIN_CASES) {
  process.stderr.write(
    `\nHARNESS BROKEN: ran ${EXPECTED} cases, expected at least ${MIN_CASES}. ` +
    `Cases went missing rather than failing, or were added without updating MIN_CASES (${MIN_CASES}).\n`,
  )
  process.exit(1)
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  process.exit(1)
}
process.exit(0)
