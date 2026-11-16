import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSessionNameAllocator,
  normalizeLabel,
  NAME_FILE,
  MIRROR_FILE,
  LOCK_FILE,
} from '../src/session-name-allocator.js'

const here = dirname(fileURLToPath(import.meta.url))
const CHILD = join(here, 'fixtures', 'session-name-allocator-child.mjs')

const cleanup = []
let savedConfigDir
let savedTmpPrefixes
before(() => {
  savedConfigDir = process.env.CHROXY_CONFIG_DIR
  savedTmpPrefixes = process.env.CHROXY_HOOKS_TMP_PREFIXES
  const cfg = mkdtempSync(join(tmpdir(), 'names-cfg-'))
  cleanup.push(cfg)
  process.env.CHROXY_CONFIG_DIR = cfg
  // Fixtures live under the OS temp dir; on Linux that IS /tmp. Keep them classified by the git rules.
  process.env.CHROXY_HOOKS_TMP_PREFIXES = '/nonexistent-tmp-prefix'
})
after(() => {
  if (savedConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = savedConfigDir
  if (savedTmpPrefixes === undefined) delete process.env.CHROXY_HOOKS_TMP_PREFIXES
  else process.env.CHROXY_HOOKS_TMP_PREFIXES = savedTmpPrefixes
  for (const d of cleanup) {
    if (typeof d === 'string') rmSync(d, { recursive: true, force: true })
    else d.kill()
  }
})

function tmp(prefix = 'names-') {
  const d = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}
/** A directory that canonicalProjectForCwd treats as a git project named `name`. */
function project(name) {
  const d = join(tmp('names-proj-'), name)
  mkdirSync(join(d, '.git'), { recursive: true })
  return d
}
function fresh(opts = {}) {
  const dir = opts.dir ?? tmp('names-dir-')
  const logs = []
  const log = {
    warn: (m, f) => logs.push({ level: 'warn', m, f }),
    error: (m, f) => logs.push({ level: 'error', m, f }),
  }
  const alloc = createSessionNameAllocator({ dir, log, lockTimeoutMs: 200, ...opts })
  return { dir, alloc, logs, A: join(dir, NAME_FILE), B: join(dir, MIRROR_FILE), lock: join(dir, LOCK_FILE) }
}
const nums = (alloc, cwd, n) => Array.from({ length: n }, () => alloc.allocate({ cwd }).number)
const readDoc = (p) => JSON.parse(readFileSync(p, 'utf8'))
const snapshot = (dir) => readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f)).toString('base64'), statSync(join(dir, f)).mtimeMs])
/** writeDurable stand-in that writes plain files (fast) and optionally misbehaves. */
function plainWriter({ failOn, mode = 'throw' } = {}) {
  return (p, data) => {
    if (failOn && p.endsWith(failOn)) {
      if (mode === 'throw') throw new Error('disk full')
      return { durable: false, unconfirmed: 'EIO' }
    }
    writeFileSync(p, data)
    return { durable: true, unconfirmed: null }
  }
}
function waitFor(cond, ms, what) {
  return new Promise((resolve, reject) => {
    const stop = Date.now() + ms
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() > stop) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 5)
    }
    tick()
  })
}
function runChild(args) {
  const proc = spawn(process.execPath, [CHILD, JSON.stringify(args)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const st = { out: '', err: '', exited: false, code: null }
  proc.stdout.on('data', (d) => { st.out += d })
  proc.stderr.on('data', (d) => { st.err += d })
  proc.on('exit', (code) => { st.exited = true; st.code = code })
  cleanup.push({ kill: () => proc.kill('SIGKILL') })
  return { proc, st }
}

/**
 * One allocate in a child process, bounded by a parent-side kill. Anything that must
 * give up on a lock runs here, so a regression that spins forever is a red assertion
 * rather than a hung test runner.
 */
async function allocOnce(args) {
  const { proc, st } = runChild({ mode: 'once', ...args })
  try {
    await waitFor(() => st.exited, 2500, 'child allocate to return')
  } catch {
    proc.kill('SIGKILL')
    assert.fail('allocate did not return within 2.5s of a lockTimeoutMs of ' + args.lockTimeoutMs + ' (unbounded lock wait)')
  }
  assert.equal(st.code, 0, st.err)
  return JSON.parse(st.out.trim())
}

describe('labels, keys and numbering', () => {
  it('numbers are monotonic per key and independent across keys', () => {
    const { alloc } = fresh()
    const a = project('alpha')
    const b = project('beta')
    assert.deepEqual(nums(alloc, a, 3), [1, 2, 3])
    assert.deepEqual(nums(alloc, b, 2), [1, 2])
    const r = alloc.allocate({ cwd: a })
    assert.deepEqual(r, { ok: true, name: 'alpha 4', label: 'alpha', number: 4, key: 'alpha' })
  })

  it('normalizes labels: NFC, control chars, whitespace, 64 code-point cap', () => {
    assert.equal(normalizeLabel('Café'), 'Café')
    assert.equal(normalizeLabel('  a \t\n  b\u0007c  '), 'a bc')
    assert.equal(normalizeLabel('x'.repeat(100)).length, 64)
    const astral = '\u{1F600}'.repeat(80)
    assert.equal(Array.from(normalizeLabel(astral)).length, 64)
    assert.equal(normalizeLabel('\u0007\t '), '')
  })

  it('a label that normalizes to empty is non_project', () => {
    const { alloc } = fresh()
    assert.deepEqual(alloc.allocate({ cwd: project('\u0007\u0008') }), { ok: false, reason: 'non_project' })
  })

  it('case-folded keys share one counter', () => {
    const { alloc } = fresh()
    const base = tmp('names-case-')
    const upper = join(base, 'Chroxy')
    const lower = join(base, 'x', 'chroxy')
    mkdirSync(join(upper, '.git'), { recursive: true })
    mkdirSync(join(lower, '.git'), { recursive: true })
    assert.equal(alloc.allocate({ cwd: upper }).number, 1)
    const r = alloc.allocate({ cwd: lower })
    assert.equal(r.number, 2)
    assert.equal(r.name, 'chroxy 2')
    assert.equal(r.key, 'chroxy')
  })

  it('a non-project cwd (tmp, no git) is non_project', () => {
    const { alloc } = fresh()
    const d = tmp('names-notproj-')
    const saved = process.env.CHROXY_HOOKS_TMP_PREFIXES
    process.env.CHROXY_HOOKS_TMP_PREFIXES = realpathSync(d)
    try {
      assert.deepEqual(alloc.allocate({ cwd: d }), { ok: false, reason: 'non_project' })
    } finally {
      process.env.CHROXY_HOOKS_TMP_PREFIXES = saved
    }
  })

  it('exhausted when the counter would leave the safe-integer range', () => {
    const f = fresh({ liveNames: () => [`big ${Number.MAX_SAFE_INTEGER - 1}`], deps: { writeDurable: plainWriter() } })
    assert.deepEqual(f.alloc.allocate({ cwd: project('big') }), { ok: false, reason: 'exhausted' })
    assert.equal(existsSync(f.A), false)
  })
})

describe('two-copy load matrix', () => {
  it('fresh: both absent starts at 1 and writes both copies', () => {
    const f = fresh()
    assert.equal(f.alloc.allocate({ cwd: project('p') }).number, 1)
    assert.ok(existsSync(f.A) && existsSync(f.B))
    assert.equal(readDoc(f.A).sha256, readDoc(f.B).sha256)
    assert.equal(statSync(f.A).mode & 0o077, process.platform === 'win32' ? statSync(f.A).mode & 0o077 : 0)
  })

  it('A valid / B missing continues and recreates B', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    unlinkSync(f.B)
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4)
    assert.equal(readDoc(f.B).sha256, readDoc(f.A).sha256)
  })

  it('A missing / B valid continues and recreates A', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    unlinkSync(f.A)
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4)
    assert.equal(readDoc(f.B).sha256, readDoc(f.A).sha256)
  })

  it('A at gen g and B at g-1 uses A (the higher generation)', () => {
    const cwd = project('p')
    const dir = tmp('names-dir-')
    nums(createSessionNameAllocator({ dir }), cwd, 2)
    // Third attempt: A is written, B fails -> A = gen 3 (next 4), B = gen 2 (next 3).
    const bad = createSessionNameAllocator({ dir, deps: { writeDurable: (p, d) => { if (p.endsWith(MIRROR_FILE)) throw new Error('boom'); return plainWriter()(p, d) } } })
    assert.deepEqual(bad.allocate({ cwd }), { ok: false, reason: 'write_unconfirmed' })
    assert.ok(readDoc(join(dir, NAME_FILE)).gen > readDoc(join(dir, MIRROR_FILE)).gen)
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 4)
  })

  it('A corrupt / B valid recovers from B and the next allocation rewrites both', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    writeFileSync(f.A, '{ not json')
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 3)
    assert.equal(readDoc(f.A).sha256, readDoc(f.B).sha256)
  })

  it('both corrupt fails closed (evidence_lost) and writes nothing', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    writeFileSync(f.A, 'garbage-a')
    writeFileSync(f.B, 'garbage-b')
    const before = snapshot(f.dir)
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
    assert.deepEqual(f.alloc.bind('k', 's'), { ok: false, reason: 'evidence_lost' })
    assert.deepEqual(snapshot(f.dir), before)
    assert.equal(f.logs.filter((l) => l.level === 'error').length, 1, 'logged once per process per reason')
  })

  it('one copy present but invalid with the other absent is evidence_lost, not fresh', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    unlinkSync(f.B)
    writeFileSync(f.A, '')
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
    assert.equal(existsSync(f.B), false)
  })

  it('same generation with a different sha256 fails closed (inconsistent)', () => {
    const cwd1 = project('one')
    const cwd2 = project('two')
    const d1 = fresh()
    const d2 = fresh()
    nums(d1.alloc, cwd1, 2)
    nums(d2.alloc, cwd2, 2)
    assert.equal(readDoc(d1.A).gen, readDoc(d2.A).gen)
    writeFileSync(d1.B, readFileSync(d2.A))
    const before = snapshot(d1.dir)
    assert.deepEqual(d1.alloc.allocate({ cwd: cwd1 }), { ok: false, reason: 'inconsistent' })
    assert.deepEqual(snapshot(d1.dir), before)
  })

  it('a sha256 mismatch on otherwise valid JSON makes that copy invalid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    const tampered = readDoc(f.A)
    tampered.body.projects.p.next = 1 // would re-issue 1..3 if it were trusted
    writeFileSync(f.A, JSON.stringify(tampered))
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4, 'falls back to the intact B')
    // and with B gone there is nothing valid left
    const g = fresh()
    nums(g.alloc, cwd, 3)
    const t2 = readDoc(g.A)
    t2.body.projects.p.next = 1
    writeFileSync(g.A, JSON.stringify(t2))
    unlinkSync(g.B)
    assert.deepEqual(g.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
  })

  it('an oversized copy (> 256 KiB) is invalid even if its JSON is valid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    writeFileSync(f.A, readFileSync(f.A, 'utf8') + ' '.repeat(300 * 1024))
    unlinkSync(f.B)
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
  })

  it('a wrong version is invalid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    for (const p of [f.A, f.B]) {
      const d = readDoc(p)
      d.version = 2
      writeFileSync(p, JSON.stringify(d))
    }
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
  })
})

describe('fail-closed persistence and the narrowed guarantee', () => {
  it('stays closed across a new instance and recovers only after both files are removed', () => {
    const f = fresh()
    const cwd = project('chroxy')
    nums(f.alloc, cwd, 3)
    writeFileSync(f.A, 'x')
    writeFileSync(f.B, 'y')
    assert.equal(f.alloc.allocate({ cwd }).reason, 'evidence_lost')
    const restarted = createSessionNameAllocator({ dir: f.dir, lockTimeoutMs: 200 })
    assert.equal(restarted.allocate({ cwd }).reason, 'evidence_lost')
    assert.equal(readFileSync(f.A, 'utf8'), 'x')
    unlinkSync(f.A)
    assert.equal(restarted.allocate({ cwd }).reason, 'evidence_lost', 'removing only one file is not recovery')
    unlinkSync(f.B)
    // Narrowed guarantee: both files gone == first use. Restarts above the LIVE floor, may repeat deleted numbers.
    const live = ['chroxy 2']
    const after = createSessionNameAllocator({ dir: f.dir, lockTimeoutMs: 200, liveNames: () => live })
    assert.equal(after.allocate({ cwd }).number, 3, 'above highest live number, not above the lost 3 issued earlier')
  })

  it('never reuses a number across restart; one corrupted copy does not reset it', () => {
    const f = fresh()
    const cwd = project('p')
    assert.deepEqual(nums(f.alloc, cwd, 3), [1, 2, 3])
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4)
    writeFileSync(f.A, 'corrupt')
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 5)
    writeFileSync(f.B, 'corrupt')
    // A was rewritten by the previous allocation, so only B is corrupt now
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 6)
  })
})

describe('write failures never issue a number', () => {
  it('writeDurable throwing on A issues nothing', () => {
    const f = fresh({ deps: { writeDurable: plainWriter({ failOn: NAME_FILE }) } })
    const cwd = project('p')
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'write_unconfirmed' })
    assert.equal(existsSync(f.A), false)
    assert.equal(existsSync(f.lock), false, 'lock released')
  })

  it('throwing on B after A is durable issues nothing; the next success skips the number', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    const bad = createSessionNameAllocator({ dir, deps: { writeDurable: plainWriter({ failOn: MIRROR_FILE }) } })
    assert.deepEqual(bad.allocate({ cwd }), { ok: false, reason: 'write_unconfirmed' })
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 2, 'number 1 became a gap, never reissued')
  })

  it('{durable:false} on either copy issues nothing', () => {
    for (const failOn of [NAME_FILE, MIRROR_FILE]) {
      const f = fresh({ deps: { writeDurable: plainWriter({ failOn, mode: 'unconfirmed' }) } })
      assert.deepEqual(f.alloc.allocate({ cwd: project('p') }), { ok: false, reason: 'write_unconfirmed' }, failOn)
    }
  })

  it('a failed copy write is reported as write_unconfirmed even when the thrown error has no message', () => {
    const f = fresh({ deps: { writeDurable: () => { throw undefined } } })
    assert.equal(f.alloc.allocate({ cwd: project('p') }).reason, 'write_unconfirmed')
  })
})

describe('crash proof', () => {
  it('SIGKILLing an allocating child never lets a printed number repeat', async () => {
    const dir = tmp('names-crash-')
    const cwd = project('crashy')
    const printed = []
    for (let i = 0; i < 12; i++) {
      const { proc, st } = runChild({ mode: 'loop', dir, cwd, lockTimeoutMs: 2000 })
      await waitFor(() => st.out.includes('\n'), 5000, `child ${i} first number`)
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 56)))
      proc.kill('SIGKILL')
      await waitFor(() => st.exited, 3000, `child ${i} exit`)
      for (const line of st.out.split('\n').slice(0, -1)) printed.push(Number(line))
    }
    assert.ok(printed.length >= 12, `children issued numbers (${printed.length})`)
    assert.equal(new Set(printed).size, printed.length, 'no printed number repeats across runs')
    const final = createSessionNameAllocator({ dir, lockTimeoutMs: 2000 }).allocate({ cwd })
    assert.ok(final.ok, JSON.stringify(final))
    assert.ok(final.number > Math.max(...printed), 'final allocation exceeds every printed number')
  })
})

describe('cross-process locking', () => {
  it('a held lock makes a second process time out within bound, then it proceeds past the holder', async () => {
    const dir = tmp('names-lock-')
    const cwd = project('locky')
    const readyFile = join(dir, 'ready')
    const releaseFile = join(dir, 'release')
    const a = runChild({ mode: 'hold', dir, cwd, readyFile, releaseFile })
    await waitFor(() => existsSync(readyFile), 8000, 'holder to take the lock')
    const { elapsedMs: elapsed, ...blocked } = await allocOnce({ dir, cwd, lockTimeoutMs: 50 })
    assert.deepEqual(blocked, { ok: false, reason: 'lock_timeout' })
    assert.ok(elapsed >= 40 && elapsed <= 150, `bounded wait, got ${elapsed}ms`)
    writeFileSync(releaseFile, '1')
    await waitFor(() => a.st.exited, 8000, 'holder to finish')
    const aRes = JSON.parse(a.st.out.trim())
    assert.ok(aRes.ok, a.st.err)
    const bRes = createSessionNameAllocator({ dir, lockTimeoutMs: 1000 }).allocate({ cwd })
    assert.ok(bRes.ok)
    assert.ok(bRes.number > aRes.number, `${bRes.number} > ${aRes.number}`)
  })

  it('soak: 4 processes x 50 allocations on one dir issue 200 unique numbers', async () => {
    const dir = tmp('names-soak-')
    const cwd = project('soaky')
    const kids = Array.from({ length: 4 }, () => runChild({ mode: 'soak', dir, cwd, count: 50, lockTimeoutMs: 20 }))
    await waitFor(() => kids.every((k) => k.st.exited), 60000, 'soak children')
    const all = []
    for (const k of kids) {
      assert.equal(k.st.code, 0, k.st.err)
      all.push(...JSON.parse(k.st.out.trim()))
    }
    assert.equal(all.length, 200)
    assert.equal(new Set(all).size, 200, 'every issued number is unique')
  })

  it('lockTimeoutMs is honoured by a real process (a hang is a failure, not a flake)', async () => {
    const dir = tmp('names-bound-')
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: hostname(), token: 'live' }))
    const res = await allocOnce({ dir, cwd: project('bound'), lockTimeoutMs: 50 })
    assert.equal(res.reason, 'lock_timeout')
    assert.ok(res.elapsedMs <= 250, `gave up in ${res.elapsedMs}ms`)
  })
})

describe('stale locks', () => {
  const writeLock = (dir, info) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ host: hostname(), token: 'foreign', ...info }))
  }
  const deadPid = () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
    return Number(r.stdout.toString())
  }

  it('a lock whose pid is dead (same host) is recovered', () => {
    const f = fresh()
    writeLock(f.dir, { pid: deadPid(), startedAt: Date.now() })
    assert.equal(f.alloc.allocate({ cwd: project('p') }).number, 1)
    assert.equal(existsSync(f.lock), false)
  })

  it('a fresh lock held by a live pid times out within bound and is never evicted', async () => {
    const f = fresh()
    writeLock(f.dir, { pid: process.pid, startedAt: Date.now() })
    const res = await allocOnce({ dir: f.dir, cwd: project('p'), lockTimeoutMs: 50 })
    assert.equal(res.reason, 'lock_timeout')
    assert.ok(res.elapsedMs <= 250, `${res.elapsedMs}ms`)
    assert.ok(existsSync(f.lock))
  })

  it('a lock older than 30 s is recovered even if its pid looks alive', () => {
    const f = fresh()
    writeLock(f.dir, { pid: process.pid, startedAt: Date.now() - 31000 })
    assert.equal(f.alloc.allocate({ cwd: project('p') }).number, 1)
  })

  it('a foreign-host fresh lock is respected', async () => {
    const f = fresh()
    writeLock(f.dir, { pid: deadPid(), startedAt: Date.now(), host: 'some-other-host' })
    assert.equal((await allocOnce({ dir: f.dir, cwd: project('p'), lockTimeoutMs: 30 })).reason, 'lock_timeout')
  })

  it('release only unlinks a lock that is still ours', () => {
    const f = fresh()
    const cwd = project('p')
    const alloc = createSessionNameAllocator({
      dir: f.dir,
      deps: { afterLoad: () => writeFileSync(f.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: hostname(), token: 'usurper' })) },
    })
    assert.equal(alloc.allocate({ cwd }).reason, 'lock_lost')
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).token, 'usurper')
  })
})

describe('live floor', () => {
  it('numbers above the highest live "<key> <n>", even when the store says less', () => {
    const cwd = project('chroxy')
    const f = fresh({ liveNames: () => ['chroxy 7', 'chroxy 3', 'chroxy 7 extra', 'other 99', 'chroxy'] })
    assert.equal(f.alloc.allocate({ cwd }).number, 8)
    assert.equal(f.alloc.allocate({ cwd }).number, 9)
  })

  it('the floor is case-folded', () => {
    const f = fresh({ liveNames: () => ['CHROXY 12'] })
    assert.equal(f.alloc.allocate({ cwd: project('chroxy') }).number, 13)
  })

  it('the store wins when it is ahead of the live names', () => {
    const dir = tmp('names-dir-')
    const cwd = project('chroxy')
    nums(createSessionNameAllocator({ dir }), cwd, 5)
    assert.equal(createSessionNameAllocator({ dir, liveNames: () => ['chroxy 2'] }).allocate({ cwd }).number, 6)
  })

  it('regex metacharacters in a label are matched literally', () => {
    const f = fresh({ liveNames: () => ['a.c 5', 'abc 50'] })
    assert.equal(f.alloc.allocate({ cwd: project('a.c') }).number, 6)
  })
})

describe('idempotency', () => {
  it('an unbound key returns the same number, also from a new instance, without consuming one', () => {
    const f = fresh()
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    assert.equal(f.alloc.allocate({ cwd }).number, 2, 'retries did not burn numbers')
  })

  it('a bound key allocates a fresh number and logs duplicate_create_request', () => {
    const f = fresh()
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    assert.deepEqual(f.alloc.bind('k1', 'sess-1'), { ok: true })
    assert.equal(readDoc(f.A).body.keys.k1.sessionId, 'sess-1')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 2)
    assert.ok(f.logs.some((l) => l.level === 'warn' && /duplicate_create_request/.test(l.m)))
    const entry = readDoc(f.A).body.keys.k1
    assert.equal(entry.n, 2)
    assert.equal(entry.sessionId, null, 'entry replaced by the new unbound one')
  })

  it('an unbound key whose number a live session holds allocates a fresh one', () => {
    const live = []
    const f = fresh({ liveNames: () => live })
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    live.push('P 1')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 2)
  })

  it('the same key for a different project is idempotency_key_conflict and never remapped', () => {
    const f = fresh()
    assert.equal(f.alloc.allocate({ cwd: project('one'), idempotencyKey: 'k' }).number, 1)
    assert.deepEqual(f.alloc.allocate({ cwd: project('two'), idempotencyKey: 'k' }), { ok: false, reason: 'idempotency_key_conflict' })
    assert.equal(readDoc(f.A).body.keys.k.key, 'one')
  })

  it('bind on an unknown key is unknown_key and writes nothing', () => {
    const f = fresh()
    f.alloc.allocate({ cwd: project('p') })
    const before = snapshot(f.dir)
    assert.deepEqual(f.alloc.bind('nope', 's'), { ok: false, reason: 'unknown_key' })
    assert.deepEqual(snapshot(f.dir), before)
  })

  it('bind failure is reported, not thrown, and does not un-issue anything', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    const bad = createSessionNameAllocator({ dir, deps: { writeDurable: plainWriter({ failOn: MIRROR_FILE }) } })
    assert.deepEqual(bad.bind('k', 's'), { ok: false, reason: 'write_unconfirmed' })
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 2)
  })

  it('a retry whose earlier attempt left the mirror behind repairs it before reissuing', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    const bad = createSessionNameAllocator({ dir, deps: { writeDurable: plainWriter({ failOn: MIRROR_FILE }) } })
    assert.equal(bad.allocate({ cwd, idempotencyKey: 'k' }).reason, 'write_unconfirmed')
    assert.equal(existsSync(join(dir, MIRROR_FILE)), false)
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    assert.equal(readDoc(join(dir, MIRROR_FILE)).sha256, readDoc(join(dir, NAME_FILE)).sha256, 'both copies carry it before it is issued')
  })

  it('prunes to 512 entries (oldest first)', () => {
    let t = 1_000_000
    const f = fresh({ now: () => t++, deps: { writeDurable: plainWriter() } })
    const cwd = project('p')
    for (let i = 0; i < 515; i++) assert.ok(f.alloc.allocate({ cwd, idempotencyKey: `k${i}` }).ok)
    const keys = Object.keys(readDoc(f.A).body.keys)
    assert.equal(keys.length, 512)
    assert.ok(!keys.includes('k0') && !keys.includes('k2'))
    assert.ok(keys.includes('k3') && keys.includes('k514'))
  })

  it('prunes entries older than 24 h (injected clock)', () => {
    let t = 5_000_000
    const f = fresh({ now: () => t, deps: { writeDurable: plainWriter() } })
    const cwd = project('p')
    f.alloc.allocate({ cwd, idempotencyKey: 'old' })
    t += 23 * 3600 * 1000
    f.alloc.allocate({ cwd, idempotencyKey: 'mid' })
    assert.ok('old' in readDoc(f.A).body.keys)
    t += 2 * 3600 * 1000
    f.alloc.allocate({ cwd, idempotencyKey: 'new' })
    const keys = Object.keys(readDoc(f.A).body.keys)
    assert.ok(!keys.includes('old'))
    assert.ok(keys.includes('mid') && keys.includes('new'))
  })

  it('a key named __proto__ is stored as data, not as a prototype', () => {
    const f = fresh()
    assert.equal(f.alloc.allocate({ cwd: project('p'), idempotencyKey: '__proto__' }).number, 1)
    assert.equal(f.alloc.allocate({ cwd: project('p'), idempotencyKey: '__proto__' }).number, 1)
    assert.ok(Object.prototype.hasOwnProperty.call(readDoc(f.A).body.keys, '__proto__'))
  })
})

describe('never throws for environment failures', () => {
  it('returns reasons for write, read, lock and live-name failures', () => {
    const cwd = project('p')
    assert.equal(fresh({ deps: { writeDurable: () => { throw new Error('x') } } }).alloc.allocate({ cwd }).reason, 'write_unconfirmed')
    const eacces = Object.assign(new Error('nope'), { code: 'EACCES' })
    assert.equal(fresh({ deps: { readFile: () => { throw eacces } } }).alloc.allocate({ cwd }).reason, 'evidence_lost')
    assert.equal(fresh({ deps: { openLock: () => { throw eacces } } }).alloc.allocate({ cwd }).reason, 'lock_error')
    assert.equal(fresh({ liveNames: () => { throw new Error('boom') } }).alloc.allocate({ cwd }).reason, 'live_names_failed')
    const asFile = join(tmp('names-file-'), 'iamafile')
    writeFileSync(asFile, 'x')
    assert.equal(createSessionNameAllocator({ dir: join(asFile, 'sub') }).allocate({ cwd }).reason, 'lock_error')
  })

  it('a throwing logger cannot break a fail-closed return', () => {
    const f = fresh({ log: { error: () => { throw new Error('logger') } } })
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    writeFileSync(f.A, 'x')
    writeFileSync(f.B, 'y')
    assert.equal(f.alloc.allocate({ cwd }).reason, 'evidence_lost')
  })

  it('bad arguments are programming errors and throw', () => {
    const { alloc } = fresh()
    assert.throws(() => alloc.allocate({}), TypeError)
    assert.throws(() => alloc.allocate({ cwd: project('p'), idempotencyKey: 5 }), TypeError)
    assert.throws(() => alloc.bind('', 's'), TypeError)
  })
})
