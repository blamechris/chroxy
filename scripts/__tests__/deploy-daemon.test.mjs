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
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDeps, deploy, parseArgs } from '../deploy-daemon.mjs'

// Every case in this file. Bump it when you add one: a case that vanishes
// should break the run rather than quietly shrink it.
const MIN_CASES = 68

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
const realFs = { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync }
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

  const writeConn = (pid) => writeFileSync(join(configDir, 'connection.json'), JSON.stringify({
    wsUrl: 'wss://tunnel.example', httpUrl: 'https://tunnel.example', apiToken: 'tok',
    tunnelMode: 'cloudflare:named', startedAt: '2026-10-06T00:00:00Z', pid,
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
      if (cmd === 'npm' && args[0] === 'run') return env.build.failShas.has(headNow()) ? res(1, 'vite exploded') : res(0)
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
        if (r.body && typeof r.body === 'object' && !('commit' in r.body)) {
          return resp(r.status, { ...r.body, commit: d.noCommitCommits.has(d.commit) ? null : d.commit, pid: d.livePid })
        }
        return resp(r.status, r.body)
      }
      if (url === 'http://127.0.0.1:8765/health') {
        if (d.dead) throw new Error('ECONNREFUSED')
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
  eq([r.exitCode, r.outcome], [0, 'rollback-completed'])
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
// state is safety-critical: a write that cannot be kept aborts the run
// ---------------------------------------------------------------------------

function failRenameWhen(env, predicate) {
  const written = {}
  env.deps.fs = {
    ...realFs,
    writeFileSync(f, content, ...rest) { written[f] = String(content); return realFs.writeFileSync(f, content, ...rest) },
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
  env.deps.fs = { ...realFs, readFileSync(f, ...rest) { if (f === env.path('deploy-state.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return realFs.readFileSync(f, ...rest) } }
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'state-write-failed'])
  untouched(env)
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
