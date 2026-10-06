#!/usr/bin/env node
/**
 * deploy-daemon.test.mjs — harness for scripts/deploy-daemon.mjs (#8324).
 *
 * The subject restarts the owner's daily daemon, so the cases that matter are
 * the ones where it must NOT: a busy daemon, an unreachable one, a daemon that
 * predates the idle route, a dirty or diverged checkout, a failed build. Each
 * of those asserts on the ABSENCE of the mutating command (merge / npm /
 * launchctl), not merely on an exit code, because "deferred" and "deployed
 * anyway and exited 0" must not look alike.
 *
 * Everything outside the script is faked: `run` (git, npm, launchctl),
 * `fetch`, the clock and `sleep`. The fake daemon is a small state machine —
 * `launchctl kill` schedules a restart that rewrites connection.json with a new
 * pid after a delay — so "waits for a NEW pid" is exercised for real. The one
 * exception is the final group, which runs the script's real git commands
 * against real temp repositories (a bare "origin" and a clone) to prove the
 * fast-forward check, merge and rollback reset do what the faked git above
 * assumes. Nothing here touches launchd, ~/.chroxy or the daily checkout.
 *
 * Run from anywhere:  node scripts/__tests__/deploy-daemon.test.mjs
 * Exit status: 0 if every case passes, 1 otherwise.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deploy, parseArgs } from '../deploy-daemon.mjs'

// Every case in this file. Bump it when you add one: a case that vanishes
// should break the run rather than quietly shrink it.
const MIN_CASES = 56

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
const realFs = { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync }
const roots = []

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
}
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete GIT_ENV[k]

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
    t: 1_000_000,
    git: {
      head: A, remote: B, branch: 'main', dirty: '', ancestor: true, fetchOk: true, mergeOk: true,
      files: ['packages/server/src/x.js'], subject: 'feat: x', log: 'bbbbbbb feat: x',
    },
    build: { ciFailures: 0, buildOk: true, buildOkAfterRollback: true },
    daemon: {
      pid: 1000,
      livePid: 1000,
      generation: 0,
      ignoreKills: 0, // the first N kills do nothing: the old process lingers
      killOk: true,
      restartDelayMs: 3000,
      nextPids: [2000, 3000, 4000],
      // idle answers consumed in order; the last repeats. A function throws/returns a Response-like.
      idle: [{ status: 200, body: { idle: true, reasons: [] } }],
      idleCalls: 0,
      // local /health status by generation (0 = the original process).
      health: (gen) => (gen === 1 && o.brokenNewBuild ? 500 : 200),
      tunnel: [200], // statuses in order (last repeats), or (generation, call) => status
      tunnelCalls: 0,
      pendingRestart: null,
      // After a restart into generation `crashGen`, the process dies this long after coming up.
      crashGen: null,
      crashAfterMs: 5000,
      dead: false,
      crashKeepsHealth: false, // the pid is gone but something still answers /health
    },
    ...o.override,
  }

  const writeConn = (pid) => writeFileSync(join(configDir, 'connection.json'), JSON.stringify({
    wsUrl: 'wss://tunnel.example', httpUrl: 'https://tunnel.example', apiToken: 'tok',
    tunnelMode: 'cloudflare:named', startedAt: '2026-10-06T00:00:00Z', pid,
  }))
  if (!o.noConn) writeConn(env.daemon.pid)

  const applyDaemon = () => {
    const d = env.daemon
    if (d.pendingRestart && env.t >= d.pendingRestart.at) {
      d.livePid = d.pendingRestart.pid
      d.generation++
      d.dead = false
      d.cameUpAt = d.pendingRestart.at
      writeConn(d.livePid)
      d.pendingRestart = null
    }
    if (d.crashGen === d.generation && !d.dead && d.cameUpAt != null && env.t >= d.cameUpAt + d.crashAfterMs) {
      d.dead = !d.crashKeepsHealth // a crashed process normally refuses connections
      d.livePid = null
    }
  }

  const gitFake = (args) => {
    const g = env.git
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null })
    const bad = (stderr = 'fatal') => ({ status: 1, stdout: '', stderr, error: null })
    const [c0, c1] = args
    if (c0 === 'status') return ok(g.dirty)
    if (c0 === 'rev-parse' && c1 === '--abbrev-ref') return ok(g.branch + '\n')
    if (c0 === 'rev-parse' && c1 === 'HEAD') return ok(g.head + '\n')
    if (c0 === 'rev-parse' && c1 === '--verify') return ok(g.remote + '\n')
    if (c0 === 'fetch') return g.fetchOk ? ok() : bad('could not resolve host')
    if (c0 === 'merge-base') return g.ancestor ? ok() : bad('')
    if (c0 === 'diff') return ok(g.files.join('\n') + '\n')
    if (c0 === 'log' && c1 === '-1') return ok(g.subject + '\n')
    if (c0 === 'log') return ok(g.log + '\n')
    if (c0 === 'merge') { if (!g.mergeOk) return bad('not possible to fast-forward'); g.head = args[2]; return ok() }
    if (c0 === 'reset') { g.head = args[2]; return ok() }
    return bad(`unexpected git ${args.join(' ')}`)
  }

  const deps = {
    run(cmd, args, { cwd } = {}) {
      env.calls.push([cmd, ...args].join(' '))
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
        const rolledBack = env.calls.some((c) => c.startsWith('git reset'))
        const okNow = rolledBack ? env.build.buildOkAfterRollback : env.build.buildOk
        return okNow ? res(0) : res(1, 'vite exploded')
      }
      if (cmd === 'launchctl') {
        if (!env.daemon.killOk) return res(113, 'Could not find service')
        if (env.daemon.ignoreKills > 0) env.daemon.ignoreKills--
        else {
          const pid = env.daemon.nextPids.shift()
          env.daemon.pendingRestart = { at: env.t + env.daemon.restartDelayMs, pid }
        }
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
        const i = Math.min(d.idleCalls++, d.idle.length - 1)
        const r = d.idle[i]
        if (r === 'throw') throw new Error('ECONNREFUSED')
        return resp(r.status, r.body)
      }
      if (url === 'http://127.0.0.1:8765/health') {
        if (d.dead) throw new Error('ECONNREFUSED')
        return resp(d.health(d.generation), { status: 'ok' })
      }
      if (url === 'https://tunnel.example/health') {
        const n = d.tunnelCalls++
        return resp(typeof d.tunnel === 'function' ? d.tunnel(d.generation, n) : d.tunnel[Math.min(n, d.tunnel.length - 1)], {})
      }
      throw new Error(`unexpected fetch ${url}`)
    },
    now: () => env.t,
    async sleep(ms) { env.t += ms; applyDaemon() },
    log: (line) => env.logs.push(line),
    uid: 501,
    pid: 4242,
    isPidAlive: (pid) => pid === env.daemon.livePid || (env.alive || []).includes(pid),
    fs: realFs,
  }
  env.deps = deps
  env.opts = (extra = {}) => ({
    checkout, configDir, label: 'com.chroxy.server', branch: 'main', remote: 'origin', port: null,
    healthTimeoutS: 5, settleS: 15, retry: false, npm: null, dryRun: false, force: false, tunnelCheck: true, ...extra,
  })
  env.run = (extra) => deploy(env.opts(extra), deps)
  env.path = (f) => join(configDir, f)
  env.readLog = () => (existsSync(env.path('logs/deploy.log')) ? readFileSync(env.path('logs/deploy.log'), 'utf8') : '')
  env.last = () => JSON.parse(readFileSync(env.path('last-deploy.json'), 'utf8'))
  env.conn = () => JSON.parse(readFileSync(env.path('connection.json'), 'utf8'))
  return env
}

// The commands that change something, plus the idle probe (its position between
// them is what the re-check tests assert).
const significant = (env) => env.calls.filter((c) =>
  /^(git fetch|git merge |git reset|npm |launchctl|GET .*\/api\/daemon\/idle)/.test(c))
const mutating = (env) => env.calls.filter((c) => /^(git merge |git reset|npm |launchctl)/.test(c))
const kills = (env) => env.calls.filter((c) => c.startsWith('launchctl'))

const KILL = 'launchctl kill SIGTERM gui/501/com.chroxy.server'
const IDLE_URL = 'GET http://127.0.0.1:8765/api/daemon/idle'
const BUILD = 'npm run build -w @chroxy/dashboard'
const CI = 'npm ci --no-audit --no-fund'

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

await test('parseArgs: defaults and every flag', () => {
  const o = parseArgs([], {}, '/home/u')
  eq(o.checkout, '/home/u/Projects/chroxy-daemon')
  eq(o.configDir, '/home/u/.chroxy')
  eq([o.label, o.branch, o.remote, o.healthTimeoutS, o.dryRun, o.force, o.tunnelCheck, o.settleS, o.retry],
    ['com.chroxy.server', 'main', 'origin', 90, false, false, true, 15, false])
  const e = parseArgs([], { CHROXY_CONFIG_DIR: '/x/cfg' }, '/home/u')
  eq(e.configDir, '/x/cfg', 'CHROXY_CONFIG_DIR is honoured')
  const f = parseArgs(['--checkout', '/c', '--config-dir', '/d', '--label', 'l.x', '--branch', 'rel/1', '--remote', 'up',
    '--port', '9000', '--health-timeout', '30', '--npm', '/n/npm', '--dry-run', '--force', '--no-tunnel-check', '--settle', '0', '--retry'], {}, '/h')
  eq([f.checkout, f.configDir, f.label, f.branch, f.remote, f.port, f.healthTimeoutS, f.npm, f.dryRun, f.force, f.tunnelCheck, f.settleS, f.retry],
    ['/c', '/d', 'l.x', 'rel/1', 'up', 9000, 30, '/n/npm', true, true, false, 0, true])
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
  for (const bad of [['--nope'], ['--checkout'], ['--port', 'x'], ['--port', '70000'], ['--health-timeout', '0'], ['--settle', '-1'], ['--settle', 'x']]) {
    let threw = false
    try { parseArgs(bad, {}, '/h') } catch { threw = true }
    assert(threw, `${bad.join(' ')} must be an error`)
  }
})

// ---------------------------------------------------------------------------
// refusals and no-ops
// ---------------------------------------------------------------------------

await test('nothing to do: up to date exits 0, runs nothing, writes no deploy.log line', async () => {
  const env = makeEnv()
  env.git.remote = A
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'up-to-date'])
  eq(mutating(env), [])
  eq(env.readLog(), '', 'a quiet tick must not grow deploy.log')
  assert(!existsSync(env.path('deploy.lock')), 'lock released')
})

await test('non-fast-forward is refused: exit 1, no merge', async () => {
  const env = makeEnv()
  env.git.ancestor = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  eq(mutating(env), [])
  assert(env.readLog().includes('not an ancestor'), 'says why')
})

await test('a dirty tree is refused: exit 1, nothing mutated, daemon never asked', async () => {
  const env = makeEnv()
  env.git.dirty = ' M packages/server/src/x.js\n'
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  eq(mutating(env), [])
  assert(!env.calls.some((c) => c.startsWith('GET')), 'no idle probe on a refused tree')
  assert(env.readLog().includes('uncommitted'), 'says why')
})

await test('a checkout on the wrong branch is refused', async () => {
  const env = makeEnv()
  env.git.branch = 'feature/x'
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  eq(mutating(env), [])
})

await test('a failed fetch is reported and mutates nothing', async () => {
  const env = makeEnv()
  env.git.fetchOk = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'fetch-failed'])
  eq(mutating(env), [])
})

// ---------------------------------------------------------------------------
// idle gating
// ---------------------------------------------------------------------------

await test('a busy daemon defers: exit 0, nothing mutated, reasons logged', async () => {
  const env = makeEnv()
  env.daemon.idle = [{ status: 200, body: { idle: false, reasons: ['session "main" busy: turn'] } }]
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy'])
  eq(mutating(env), [])
  assert(env.readLog().includes('deferred: busy (session "main" busy: turn)'), 'reason is logged')
  eq(env.git.head, A, 'HEAD untouched')
})

await test('the same busy deferral is logged ONCE per target, not once per tick', async () => {
  const env = makeEnv()
  env.daemon.idle = [{ status: 200, body: { idle: false, reasons: ['busy'] } }]
  await env.run()
  await env.run()
  await env.run()
  eq(env.readLog().trim().split('\n').length, 1, 'three ticks, one line')
  // A NEW target is news again.
  env.git.remote = 'c'.repeat(40)
  await env.run()
  eq(env.readLog().trim().split('\n').length, 2, 'a new target logs again')
})

await test('an unreachable daemon does not deploy', async () => {
  const env = makeEnv()
  env.daemon.idle = ['throw']
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-unavailable'])
  eq(mutating(env), [])
  assert(env.readLog().includes('unreachable'), 'says why')
})

await test('a 404 from /api/daemon/idle (an older daemon) does not deploy and says to bootstrap', async () => {
  const env = makeEnv()
  env.daemon.idle = [{ status: 404, body: { error: 'not found' } }]
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-unavailable'])
  eq(mutating(env), [])
  assert(env.readLog().includes('--force'), 'points at the bootstrap')
})

await test('an unreadable idle body does not deploy (not-a-boolean and non-JSON both)', async () => {
  for (const body of [{ idle: 'yes' }, { idle: 1 }, {}, undefined]) {
    const env = makeEnv()
    env.daemon.idle = [{ status: 200, body }]
    const r = await env.run()
    eq(r.outcome, 'deferred-unavailable', `body ${JSON.stringify(body)}`)
    eq(mutating(env), [])
  }
})

await test('a missing connection.json (daemon not running) does not deploy', async () => {
  const env = makeEnv({ noConn: true })
  const r = await env.run()
  eq(r.outcome, 'deferred-unavailable')
  eq(mutating(env), [])
})

await test('--force skips the idle checks entirely, and still deploys', async () => {
  const env = makeEnv()
  env.daemon.idle = [{ status: 200, body: { idle: false, reasons: ['busy'] } }]
  const r = await env.run({ force: true })
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  assert(!env.calls.includes(IDLE_URL), 'the idle route is never asked under --force')
  assert(kills(env).length === 1, 'restarted')
})

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

await test('happy path: fetch, idle, merge, build, idle again, SIGTERM, in that order', async () => {
  const env = makeEnv()
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(significant(env), ['git fetch origin main', IDLE_URL, `git merge --ff-only ${B}`, BUILD, IDLE_URL, KILL])
  eq(env.git.head, B)
  assert(env.readLog().includes(`${A.slice(0, 12)}..${B.slice(0, 12)} ok`), 'success line in deploy.log')
  const last = env.last()
  eq([last.from, last.to, last.result, last.subject], [A, B, 'ok', 'feat: x'])
  assert(typeof last.at === 'string' && last.at.endsWith('Z'), 'UTC timestamp')
  assert(!existsSync(env.path('deploy-pending-restart.json')), 'no pending marker left')
  assert(!existsSync(env.path('deploy.lock')), 'lock released')
})

await test('a lockfile change adds npm ci BEFORE the build; no lockfile change does not', async () => {
  const withLock = makeEnv()
  withLock.git.files = ['package-lock.json', 'packages/server/src/x.js']
  await withLock.run()
  eq(mutating(withLock), [`git merge --ff-only ${B}`, CI, BUILD, KILL])
  for (const f of ['packages/dashboard/package-lock.json']) {
    const e = makeEnv()
    e.git.files = [f]
    await e.run()
    assert(e.calls.includes(CI), `${f} counts as a lockfile`)
  }
  const noLock = makeEnv()
  noLock.git.files = ['packages/server/package.json', 'packages/server/sidecar/package-lock.json']
  await noLock.run()
  assert(!noLock.calls.includes(CI), 'sidecar lockfile and package.json alone do not trigger npm ci')
})

await test('the restart is not accepted until connection.json names a NEW pid', async () => {
  // The daemon is signalled but never restarts: connection.json keeps the old
  // pid while the lingering old process still answers /health with 200.
  const env = makeEnv()
  env.daemon.ignoreKills = 1
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('old pid'), 'the reason names the unchanged pid')
  eq(kills(env).length, 2, 'rolled back and signalled again')
})

await test('the tunnel check retries through 530 and then succeeds', async () => {
  const env = makeEnv()
  env.daemon.tunnel = [530, 530, 530, 200]
  const r = await env.run({ healthTimeoutS: 20 })
  eq(r.outcome, 'deployed')
  eq(env.daemon.tunnelCalls, 4, 'asked until it answered 200')
})

await test('--no-tunnel-check never asks the tunnel', async () => {
  const env = makeEnv()
  env.daemon.tunnel = [530]
  const r = await env.run({ tunnelCheck: false })
  eq(r.outcome, 'deployed')
  eq(env.daemon.tunnelCalls, 0)
})

await test('a tunnel that never recovers is a failed deploy and rolls back', async () => {
  const env = makeEnv()
  env.daemon.tunnel = (gen) => (gen === 1 ? 530 : 200)
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('530'), 'the reason carries the status')
})

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

await test('a failed build rolls back to the old commit and NEVER restarts the daemon', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-build'])
  eq(kills(env), [], 'the running daemon was never touched')
  eq(env.git.head, A, 'checkout reset to the previous commit')
  eq(mutating(env), [`git merge --ff-only ${B}`, BUILD, `git reset --hard ${A}`, BUILD], 'rebuilt the old tree')
  assert(env.readLog().includes('rolled-back (build failed'), 'logged')
  eq(env.last().result, 'rolled-back-build')
})

await test('a failed build after a lockfile change re-runs npm ci on the way back', async () => {
  const env = makeEnv()
  env.git.files = ['package-lock.json']
  env.build.buildOk = false
  const r = await env.run()
  eq(r.outcome, 'rolled-back-build')
  eq(mutating(env), [`git merge --ff-only ${B}`, CI, BUILD, `git reset --hard ${A}`, CI, BUILD])
})

await test('a failed npm ci rolls back too, without building', async () => {
  const env = makeEnv()
  env.git.files = ['package-lock.json']
  env.build.ciFailures = 1
  const r = await env.run()
  eq(r.outcome, 'rolled-back-build')
  eq(kills(env), [])
  assert(!env.calls.slice(0, env.calls.indexOf(`git reset --hard ${A}`)).includes(BUILD), 'no build after a failed ci')
})

await test('a rollback that itself fails is reported loudly', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  env.build.buildOkAfterRollback = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rollback-failed'])
  assert(env.readLog().includes('ROLLBACK-FAILED'), 'loud')
  eq(kills(env), [])
})

await test('a failed health check rolls back, rebuilds and restarts again', async () => {
  const env = makeEnv({ brokenNewBuild: true })
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-health'])
  eq(mutating(env), [`git merge --ff-only ${B}`, BUILD, KILL, `git reset --hard ${A}`, BUILD, KILL])
  eq(env.git.head, A)
  assert(env.readLog().includes('rolled-back (health failed'), 'logged')
  eq(env.last().result, 'rolled-back-health')
  assert(!existsSync(env.path('deploy-pending-restart.json')), 'no marker')
})

await test('a daemon that stays down after rollback is ROLLBACK-FAILED', async () => {
  const env = makeEnv()
  env.daemon.health = () => 500
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rollback-failed'])
  assert(env.readLog().includes('ROLLBACK-FAILED'), 'loud')
})

await test('a failed launchctl kill rolls the checkout back without waiting on health', async () => {
  const env = makeEnv()
  env.daemon.killOk = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'failed-restart'])
  eq(env.git.head, A)
  eq(kills(env).length, 1, 'one attempt, no second kill')
})

// ---------------------------------------------------------------------------
// busy after the build
// ---------------------------------------------------------------------------

const BUSY = { status: 200, body: { idle: false, reasons: ['session "a" busy: turn'] } }
const IDLE = { status: 200, body: { idle: true, reasons: [] } }

await test('busy at the re-check ROLLS BACK: old commit, old build, no restart, exit 0', async () => {
  const env = makeEnv()
  env.daemon.idle = [IDLE, BUSY]
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deferred-busy-after-build'])
  eq(mutating(env), [`git merge --ff-only ${B}`, BUILD, `git reset --hard ${A}`, BUILD], 'merged, built, then put the old tree back and rebuilt it')
  eq(env.git.head, A, 'not left at the new commit')
  eq(kills(env), [], 'never restarted')
  assert(env.readLog().includes('deferred after build: busy (session "a" busy: turn)'), 'logged')
  assert(!existsSync(env.path('deploy-pending-restart.json')), 'no pending marker is written any more')
})

await test('busy at the re-check after a lockfile change re-runs npm ci on the way back', async () => {
  const env = makeEnv()
  env.git.files = ['package-lock.json']
  env.daemon.idle = [IDLE, BUSY]
  const r = await env.run()
  eq(r.outcome, 'deferred-busy-after-build')
  eq(mutating(env), [`git merge --ff-only ${B}`, CI, BUILD, `git reset --hard ${A}`, CI, BUILD])
})

await test('"cannot confirm idle" at the re-check also rolls back', async () => {
  const env = makeEnv()
  env.daemon.idle = [IDLE, 'throw']
  const r = await env.run()
  eq(r.outcome, 'deferred-busy-after-build')
  eq(env.git.head, A)
  eq(kills(env), [])
})

await test('the busy-after-build deferral is deduped per target and is NOT remembered as a failed target', async () => {
  const env = makeEnv()
  env.daemon.idle = [IDLE, BUSY, IDLE, BUSY]
  await env.run()
  env.calls.length = 0
  const r2 = await env.run()
  eq(r2.outcome, 'deferred-busy-after-build', 'a busy daemon is not a bad target: the next tick tries again')
  assert(env.calls.includes(`git merge --ff-only ${B}`), 'retried')
  eq(env.readLog().trim().split('\n').length, 1, 'one log line for two ticks')
})

await test('a rollback that fails after a busy re-check is ROLLBACK-FAILED', async () => {
  const env = makeEnv()
  env.daemon.idle = [IDLE, BUSY]
  env.build.buildOkAfterRollback = false
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rollback-failed'])
  assert(env.readLog().includes('ROLLBACK-FAILED'), 'loud')
  eq(kills(env), [])
})

await test('a leftover deploy-pending-restart.json from the retired design is deleted, and never acted on', async () => {
  const env = makeEnv()
  writeFileSync(env.path('deploy-pending-restart.json'), JSON.stringify({ from: '--hard', to: A }))
  env.git.remote = A
  const r = await env.run()
  eq(r.outcome, 'up-to-date')
  assert(!existsSync(env.path('deploy-pending-restart.json')), 'deleted')
  assert(!env.calls.some((c) => c.includes('--hard')), 'never reached an argv')
})

// ---------------------------------------------------------------------------
// a target that already rolled back is not retried
// ---------------------------------------------------------------------------

const stateOf = (env) => JSON.parse(readFileSync(env.path('deploy-state.json'), 'utf8'))

await test('after a build rollback the same target is SKIPPED on later ticks: no merge, no build, one log line', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  await env.run()
  eq([stateOf(env).failedTarget, stateOf(env).failedOutcome], [B, 'rolled-back-build'])
  env.calls.length = 0
  const r2 = await env.run()
  const r3 = await env.run()
  eq([r2.exitCode, r2.outcome, r3.outcome], [0, 'skipped-failed-target', 'skipped-failed-target'])
  eq(mutating(env), [], 'nothing ran')
  assert(!env.calls.includes(IDLE_URL), 'the daemon was not even asked')
  const lines = env.readLog().trim().split('\n')
  eq(lines.length, 2, 'the rollback line plus ONE skip line')
  assert(lines[1].includes(`skipped: ${B.slice(0, 12)} already rolled back (rolled-back-build); waiting for a newer main or --retry`), 'exact wording')
})

await test('a health rollback (e.g. a tunnel outage) is remembered too, so the daemon is not restarted twice every tick', async () => {
  const env = makeEnv({ brokenNewBuild: true })
  await env.run()
  eq(stateOf(env).failedOutcome, 'rolled-back-health')
  env.calls.length = 0
  const r = await env.run()
  eq(r.outcome, 'skipped-failed-target')
  eq(kills(env), [])
})

await test('a failed restart and a failed rollback are remembered too', async () => {
  const a = makeEnv()
  a.daemon.killOk = false
  await a.run()
  eq(stateOf(a).failedOutcome, 'failed-restart')
  const b = makeEnv()
  b.build.buildOk = false
  b.build.buildOkAfterRollback = false
  await b.run()
  eq(stateOf(b).failedOutcome, 'rollback-failed')
  eq((await b.run()).outcome, 'skipped-failed-target')
})

await test('a newer origin/main clears the remembered failure and is deployed', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  await env.run()
  env.git.head = A
  env.git.remote = 'c'.repeat(40)
  env.build.buildOk = true
  env.calls.length = 0
  const r = await env.run()
  eq(r.outcome, 'deployed')
  eq(stateOf(env).failedTarget, undefined, 'cleared')

  // The clearing must not depend on the new target SUCCEEDING: a newer main
  // that merely defers (busy) has to forget the old failure too.
  const env2 = makeEnv()
  env2.build.buildOk = false
  await env2.run()
  eq(stateOf(env2).failedTarget, B)
  env2.git.head = A
  env2.git.remote = 'c'.repeat(40)
  env2.daemon.idle = [BUSY]
  const r2 = await env2.run()
  eq(r2.outcome, 'deferred-busy')
  eq(stateOf(env2).failedTarget, undefined, 'a newer main clears it even when nothing deploys')
})

await test('--retry tries the failed target once and clears the memory on success; --force does not imply it', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  await env.run()
  env.git.head = A
  env.build.buildOk = true
  const forced = await env.run({ force: true })
  eq(forced.outcome, 'skipped-failed-target', '--force alone still skips')
  const r = await env.run({ retry: true })
  eq(r.outcome, 'deployed')
  eq(stateOf(env).failedTarget, undefined, 'a successful retry clears it')
})

await test('--retry that fails again re-records the failure', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  await env.run()
  env.git.head = A
  env.calls.length = 0 // the fake build keys 'after rollback' off the call log
  const r = await env.run({ retry: true })
  eq(r.outcome, 'rolled-back-build')
  eq(stateOf(env).failedTarget, B)
  eq((await env.run()).outcome, 'skipped-failed-target')
})

await test('--dry-run reports a remembered failure and changes nothing', async () => {
  const env = makeEnv()
  env.build.buildOk = false
  await env.run()
  env.git.head = A
  env.calls.length = 0
  env.logs.length = 0
  const before = readFileSync(env.path('deploy-state.json'), 'utf8')
  const r = await env.run({ dryRun: true })
  eq(r.outcome, 'dry-run')
  assert(env.logs.join('\n').includes('would SKIP this target'), 'says a real run would skip')
  eq(mutating(env), [])
  eq(readFileSync(env.path('deploy-state.json'), 'utf8'), before, 'state untouched')
})

// ---------------------------------------------------------------------------
// settle window after health
// ---------------------------------------------------------------------------

await test('a build that answers /health and then dies inside the settle window is rolled back', async () => {
  const env = makeEnv()
  env.daemon.crashGen = 1
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'rolled-back-health'])
  assert(env.readLog().includes('no longer running') || env.readLog().includes('ECONNREFUSED'), 'says why')
  eq(env.git.head, A)
  eq(kills(env).length, 2, 'restarted onto the old build')
})

await test('settle checks the pid is alive, not only that /health answers', async () => {
  const env = makeEnv()
  env.daemon.crashGen = 1
  env.daemon.crashKeepsHealth = true
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('no longer running'), 'caught by the liveness check')
})

await test('the settle window is waited out before the deploy is called good', async () => {
  const env = makeEnv()
  const t0 = env.t
  const r = await env.run({ settleS: 40 })
  eq(r.outcome, 'deployed')
  assert(env.t - t0 >= 3000 + 40000, `only ${env.t - t0}ms elapsed: the settle sleep was skipped`)
})

await test('a daemon that is relaunched under a different pid during the settle window is not accepted', async () => {
  const env = makeEnv()
  const origSleep = env.deps.sleep
  let relaunched = false
  env.deps.sleep = async (ms) => {
    await origSleep(ms)
    // launchd relaunches a crashing service: connection.json now names yet another pid.
    if (!relaunched && env.daemon.generation === 1 && ms === 15000) {
      relaunched = true
      writeFileSync(env.path('connection.json'), JSON.stringify({ httpUrl: 'https://tunnel.example', wsUrl: 'wss://tunnel.example', apiToken: 'tok', tunnelMode: 'cloudflare:named', pid: 5555 }))
      env.daemon.livePid = 5555
    }
  }
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  assert(env.readLog().includes('5555'), 'names the unexpected pid')
})

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------

await test('--dry-run reports the plan and mutates nothing at all', async () => {
  const env = makeEnv()
  env.git.files = ['package-lock.json']
  env.daemon.idle = [{ status: 200, body: { idle: false, reasons: ['session "x" busy: turn'] } }]
  const r = await env.run({ dryRun: true })
  eq([r.exitCode, r.outcome], [0, 'dry-run'])
  eq(mutating(env), [], 'no merge, npm, reset or launchctl')
  const out = env.logs.join('\n')
  assert(out.includes('bbbbbbb feat: x'), 'lists the commits ahead')
  assert(out.includes('package-lock.json changed: yes'), 'reports the lockfile verdict')
  assert(out.includes('idle verdict: busy') && out.includes('session "x" busy: turn'), 'reports idle and why')
  assert(out.includes(KILL), 'prints the restart command')
  for (const f of ['logs/deploy.log', 'deploy.lock', 'last-deploy.json', 'deploy-state.json', 'deploy-pending-restart.json']) {
    assert(!existsSync(env.path(f)), `${f} must not exist after a dry run`)
  }
  eq(env.git.head, A)
})

// ---------------------------------------------------------------------------
// locking
// ---------------------------------------------------------------------------

await test('a stale lock (dead pid) is reclaimed and released afterwards', async () => {
  const env = makeEnv()
  env.git.remote = A
  writeFileSync(env.path('deploy.lock'), '999999')
  const r = await env.run()
  eq(r.outcome, 'up-to-date', 'ran past the stale lock')
  assert(!existsSync(env.path('deploy.lock')), 'lock released')
})

await test('a live lock blocks, and is left alone', async () => {
  const env = makeEnv()
  env.alive = [777]
  writeFileSync(env.path('deploy.lock'), '777')
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'locked'])
  eq(env.calls.filter((c) => c.startsWith('git')), [], 'did not even look at git')
  eq(readFileSync(env.path('deploy.lock'), 'utf8'), '777', 'the holder\'s lock is untouched')
})

await test('the lock is released even when the deploy throws', async () => {
  const env = makeEnv()
  env.git.remote = B
  const orig = env.deps.run
  env.deps.run = (cmd, args, o) => { if (cmd === 'git' && args[0] === 'diff') throw new Error('exploded') ; return orig(cmd, args, o) }
  const r = await env.run()
  eq(r.outcome, 'failed')
  assert(!existsSync(env.path('deploy.lock')), 'lock released after a throw')
})

// ---------------------------------------------------------------------------
// real git
// ---------------------------------------------------------------------------

const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

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
  const push = (file, content, msg) => {
    writeFileSync(join(dev, file), content)
    g(dev, 'add', file)
    g(dev, 'commit', '-m', msg)
    g(dev, 'push', 'origin', 'main')
    return g(dev, 'rev-parse', 'HEAD')
  }
  return { env, origin, dev, push, head: () => g(env.checkout, 'rev-parse', 'HEAD') }
}

await test('real git: a fast-forward deploy merges the new commit and restarts', async () => {
  const { env, push, head } = makeRepos()
  const old = head()
  const target = push('b.txt', 'two\n', 'second commit')
  const r = await env.run()
  eq([r.exitCode, r.outcome], [0, 'deployed'])
  eq(head(), target, 'HEAD is the pushed commit')
  eq(readFileSync(join(env.checkout, 'b.txt'), 'utf8'), 'two\n', 'working tree updated')
  eq([env.last().from, env.last().to, env.last().subject], [old, target, 'second commit'])
  assert(!env.calls.includes(CI), 'no lockfile change, no npm ci')
  eq(kills(env).length, 1)
})

await test('real git: a lockfile change is detected from the real diff and npm ci runs before the build', async () => {
  const { env, push } = makeRepos()
  push('package-lock.json', '{"v":2}\n', 'bump lock')
  const r = await env.run()
  eq(r.outcome, 'deployed')
  eq(mutating(env).filter((c) => c.startsWith('npm')), [CI, BUILD])
})

await test('real git: a failed build resets the real checkout back to the old commit and tree', async () => {
  const { env, push, head } = makeRepos()
  const old = head()
  push('b.txt', 'two\n', 'second commit')
  env.build.buildOk = false
  const r = await env.run()
  eq(r.outcome, 'rolled-back-build')
  eq(head(), old, 'HEAD back at the old commit')
  assert(!existsSync(join(env.checkout, 'b.txt')), 'the new commit\'s file is gone from the tree')
  eq(kills(env), [])
})

await test('real git: a failed health check resets the real checkout and restarts onto it', async () => {
  const { env, push, head } = makeRepos()
  const old = head()
  push('b.txt', 'two\n', 'second commit')
  env.daemon.health = (gen) => (gen === 1 ? 500 : 200)
  const r = await env.run()
  eq(r.outcome, 'rolled-back-health')
  eq(head(), old)
  eq(kills(env).length, 2)
})

await test('real git: a diverged checkout (local commit not on origin) is refused', async () => {
  const { env, push, head } = makeRepos()
  writeFileSync(join(env.checkout, 'local.txt'), 'x\n')
  g(env.checkout, 'add', 'local.txt')
  g(env.checkout, 'commit', '-m', 'local only')
  const localHead = head()
  push('b.txt', 'two\n', 'second commit')
  const r = await env.run()
  eq([r.exitCode, r.outcome], [1, 'refused'])
  eq(head(), localHead, 'HEAD untouched')
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
// observable outcome (docs/false-safety-guards.md; #7653).
const EXPECTED = pass + fail
if (EXPECTED < MIN_CASES) {
  process.stderr.write(
    `\nHARNESS BROKEN: ran ${EXPECTED} cases, expected at least ${MIN_CASES}. ` +
    'Cases went missing rather than failing.\n',
  )
  process.exit(1)
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  for (const f of failures) process.stderr.write(`\n[FAIL] ${f.name}\n${f.err.stack || f.err.message}\n`)
  process.exit(1)
}
process.exit(0)
