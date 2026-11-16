import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionNameAllocator, normalizeLabel } from '../src/session-name-allocator.js'

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
function project(name, parent = tmp('names-proj-')) {
  const d = join(parent, name)
  mkdirSync(join(d, '.git'), { recursive: true })
  writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n') // a `.git` without HEAD is not a git dir
  return d
}
const genFile = (dir, g, mirror = false) => join(dir, `session-names.g${String(g).padStart(12, '0')}${mirror ? '.mirror' : ''}.json`)
const gensOf = (dir) => readdirSync(dir).map((f) => /^session-names\.g(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b)
const top = (dir) => {
  const gen = gensOf(dir).at(-1)
  return { gen, A: genFile(dir, gen), B: genFile(dir, gen, true) }
}
function fresh(opts = {}) {
  const dir = opts.dir ?? tmp('names-dir-')
  const logs = []
  const log = {
    warn: (m, f) => logs.push({ level: 'warn', m, f }),
    error: (m, f) => logs.push({ level: 'error', m, f }),
  }
  const alloc = createSessionNameAllocator({ dir, log, ...opts })
  return { dir, alloc, logs, top: () => top(dir) }
}
const nums = (alloc, cwd, n) => Array.from({ length: n }, () => alloc.allocate({ cwd }).number)
const readDoc = (p) => JSON.parse(readFileSync(p, 'utf8'))
const snapshot = (dir) => readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f)).toString('base64'), statSync(join(dir, f)).mtimeMs])
/** linkSync that fails (EIO) for the mirror name only, i.e. after the primary was created. */
const failMirrorLink = (a, b) => {
  if (/\.mirror\.json$/.test(b)) throw Object.assign(new Error('EIO'), { code: 'EIO' })
  return linkSync(a, b)
}
const noSync = () => {}
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v))
/** A checksum-VALID envelope, built independently of the module under test. */
const sign = ({ version = 1, gen, body = { projects: {}, keys: {}, seq: 0 } }) => ({
  version, gen, body, sha256: createHash('sha256').update(canon({ version, gen, body })).digest('hex'),
})
const putStore = (dir, doc) => {
  for (const mirror of [false, true]) writeFileSync(genFile(dir, doc.gen, mirror), JSON.stringify(doc))
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
 * One allocate in a child process, bounded by a parent-side kill. Anything that could
 * block or spin runs here, so a regression is a red assertion, not a hung test runner.
 */
async function allocOnce(args) {
  const { proc, st } = runChild({ mode: 'once', ...args })
  try {
    await waitFor(() => st.exited, 3000, 'child allocate to return')
  } catch {
    proc.kill('SIGKILL')
    assert.fail('allocate did not return within 3s (blocked or spinning)')
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
    assert.deepEqual(alloc.allocate({ cwd: a }), { ok: true, name: 'alpha 4', label: 'alpha', number: 4, key: 'alpha' })
  })

  it('normalizes labels: NFC, control chars, whitespace, 64 code-point cap', () => {
    assert.equal(normalizeLabel('Café'), 'Café')
    assert.equal(normalizeLabel('  a \t\n  b\u0007c  '), 'a bc')
    assert.equal(normalizeLabel('x'.repeat(100)).length, 64)
    assert.equal(Array.from(normalizeLabel('\u{1F600}'.repeat(80))).length, 64)
    assert.equal(normalizeLabel('\u0007\t '), '')
  })

  it('a label that normalizes to empty is non_project (control-character folder name)', { skip: process.platform === 'win32' && 'Windows paths cannot contain control characters' }, () => {
    const { alloc } = fresh()
    assert.deepEqual(alloc.allocate({ cwd: project('\u0007\u0008') }), { ok: false, reason: 'non_project' })
  })

  it('a label that normalizes to empty is non_project (whitespace-only folder name, valid on every filesystem)', () => {
    const { alloc } = fresh()
    assert.equal(normalizeLabel('\u2028\u00a0'), '')
    assert.deepEqual(alloc.allocate({ cwd: project('\u2028\u00a0') }), { ok: false, reason: 'non_project' })
  })

  it('case-folded keys share one counter', () => {
    const { alloc } = fresh()
    const base = tmp('names-case-')
    const upper = join(base, 'Chroxy')
    const lower = join(base, 'x', 'chroxy')
    for (const d of [upper, lower]) {
      mkdirSync(join(d, '.git'), { recursive: true })
      writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    }
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

  it('a forged huge `next` cannot be injected without the digest', () => {
    const f = fresh()
    const cwd = project('big')
    f.alloc.allocate({ cwd })
    const t = top(f.dir)
    const doc = readDoc(t.A)
    doc.body.projects.big.next = Number.MAX_SAFE_INTEGER - 1
    writeFileSync(t.A, JSON.stringify(doc))
    unlinkSync(t.B)
    assert.equal(f.alloc.allocate({ cwd }).reason, 'evidence_lost')
  })
})

describe('generation load matrix', () => {
  it('fresh: both copies of gen 1 are written, owner-only', () => {
    const f = fresh()
    assert.equal(f.alloc.allocate({ cwd: project('p') }).number, 1)
    const t = f.top()
    assert.equal(t.gen, 1)
    assert.ok(existsSync(t.A) && existsSync(t.B))
    assert.equal(readDoc(t.A).sha256, readDoc(t.B).sha256)
    if (process.platform !== 'win32') assert.equal(statSync(t.A).mode & 0o077, 0)
  })

  it('primary valid / mirror missing continues and writes a new generation', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    unlinkSync(f.top().B)
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4)
    assert.equal(readDoc(f.top().B).sha256, readDoc(f.top().A).sha256)
  })

  it('primary missing / mirror valid continues', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    unlinkSync(f.top().A)
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4)
  })

  it('primary corrupt / mirror valid recovers from the mirror', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    writeFileSync(f.top().A, '{ not json')
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 3)
    assert.equal(readDoc(f.top().B).sha256, readDoc(f.top().A).sha256)
  })

  it('both copies of the highest generation corrupt fails closed and writes nothing', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    writeFileSync(f.top().A, 'garbage-a')
    writeFileSync(f.top().B, 'garbage-b')
    const before = snapshot(f.dir)
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
    assert.deepEqual(f.alloc.bind('k', 's', { number: 1 }), { ok: false, reason: 'evidence_lost' })
    assert.deepEqual(snapshot(f.dir), before)
    assert.equal(f.logs.filter((l) => l.level === 'error').length, 1, 'logged once per process per reason')
  })

  it('never falls back to an older generation when the highest is invalid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    assert.ok(existsSync(genFile(f.dir, 2)) && existsSync(genFile(f.dir, 2, true)), 'older valid generation exists')
    writeFileSync(f.top().A, 'x')
    writeFileSync(f.top().B, 'y')
    const before = snapshot(f.dir)
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
    assert.deepEqual(snapshot(f.dir), before)
  })

  it('same generation with a different sha256 fails closed (inconsistent) and writes nothing', () => {
    const d1 = fresh()
    const d2 = fresh()
    nums(d1.alloc, project('one'), 2)
    nums(d2.alloc, project('two'), 2)
    writeFileSync(d1.top().B, readFileSync(d2.top().A))
    const before = snapshot(d1.dir)
    assert.deepEqual(d1.alloc.allocate({ cwd: project('one') }), { ok: false, reason: 'inconsistent' })
    assert.deepEqual(snapshot(d1.dir), before)
  })

  it('a sha256 mismatch on otherwise valid JSON makes that copy invalid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    const doc = readDoc(f.top().A)
    doc.body.projects.p.next = 1 // would re-issue 1..3 if it were trusted
    writeFileSync(f.top().A, JSON.stringify(doc))
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4, 'falls back to the intact mirror')
    const g = fresh()
    nums(g.alloc, cwd, 3)
    const d2 = readDoc(g.top().A)
    d2.body.projects.p.next = 1
    writeFileSync(g.top().A, JSON.stringify(d2))
    unlinkSync(g.top().B)
    assert.deepEqual(g.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
  })

  it('an oversized copy (> 1 MiB) is invalid even if its JSON is valid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    writeFileSync(f.top().A, readFileSync(f.top().A, 'utf8') + ' '.repeat(1024 * 1024 + 10))
    unlinkSync(f.top().B)
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
  })

  it('a checksum-valid envelope with an unsupported version is invalid', () => {
    const dir = tmp('names-ver-')
    const cwd = project('p')
    const body = { projects: { p: { label: 'p', root: '/x', next: 5 } }, keys: {}, seq: 0 }
    putStore(dir, sign({ version: 2, gen: 1, body }))
    assert.deepEqual(createSessionNameAllocator({ dir }).allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
    // control: the same envelope at version 1 is accepted, so the helper itself is sound
    const ok = tmp('names-ver-')
    putStore(ok, sign({ gen: 1, body }))
    assert.equal(createSessionNameAllocator({ dir: ok }).allocate({ cwd }).number, 5)
  })

  it('a gen field that disagrees with the file name is invalid', () => {
    const f = fresh()
    const cwd = project('p')
    nums(f.alloc, cwd, 2)
    const t = f.top()
    writeFileSync(t.A, readFileSync(genFile(f.dir, t.gen - 1)))
    writeFileSync(t.B, readFileSync(genFile(f.dir, t.gen - 1, true)))
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'evidence_lost' })
  })

  it('generation file names are exactly 12 digits; other spellings are ignored', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    putStore(f.dir, sign({ gen: 7 })) // valid content under a 12-digit name would count...
    for (const mirror of [false, true]) {
      unlinkSync(genFile(f.dir, 7, mirror))
      writeFileSync(join(f.dir, `session-names.g7${mirror ? '.mirror' : ''}.json`), 'garbage')
      writeFileSync(join(f.dir, `session-names.g0000000007${mirror ? '.mirror' : ''}.json`), 'garbage')
    }
    assert.equal(f.alloc.allocate({ cwd }).number, 2)
  })

  it('a generation past 999999999999 is exhausted and nothing is written', () => {
    const dir = tmp('names-gen-')
    putStore(dir, sign({ gen: 999_999_999_999 }))
    const before = snapshot(dir)
    assert.deepEqual(createSessionNameAllocator({ dir }).allocate({ cwd: project('p') }), { ok: false, reason: 'exhausted' })
    assert.deepEqual(snapshot(dir), before)
  })

  it('a pruned-under-us generation is re-listed, not treated as corruption', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    const y = createSessionNameAllocator({ dir: f.dir })
    let first = true
    const x = createSessionNameAllocator({
      dir: f.dir,
      log: { error: (m) => f.logs.push({ level: 'error', m }) },
      deps: {
        readFile: (path) => {
          if (first) {
            first = false
            nums(y, cwd, 4) // gens 2..5; gen 1 is pruned before X reads it
          }
          return readFileSync(path, 'utf8')
        },
      },
    })
    const r = x.allocate({ cwd })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.number, 6)
    assert.equal(f.logs.filter((l) => l.level === 'error').length, 0)
  })

  it('a transient read error is io_error: non-closing, never logged as fail-closed', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    const flaky = createSessionNameAllocator({
      dir: f.dir,
      log: { error: (m) => f.logs.push({ level: 'error', m }) },
      deps: { readFile: () => { throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) } },
    })
    assert.deepEqual(flaky.allocate({ cwd }), { ok: false, reason: 'io_error' })
    assert.equal(f.logs.filter((l) => l.level === 'error').length, 0)
    assert.equal(f.alloc.allocate({ cwd }).number, 2)
  })

  it('anything else in the directory is ignored and never parsed', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    for (const name of ['session-names.json', 'session-names.mirror.json', 'session-names.lock', 'session-names.gabc.json', 'session-names.g000000000099.json.bak', 'session-names.g1.json', 'notes.txt']) {
      writeFileSync(join(f.dir, name), 'garbage')
    }
    assert.equal(f.alloc.allocate({ cwd }).number, 2)
  })

  it('a FIFO planted at a naming path never blocks: the mirror carries on, or it fails closed', { skip: process.platform === 'win32' }, async () => {
    const dir = tmp('names-fifo-')
    const cwd = project('p')
    nums(createSessionNameAllocator({ dir }), cwd, 2)
    const t = top(dir)
    unlinkSync(t.A)
    execFileSync('mkfifo', [t.A])
    const r = await allocOnce({ dir, cwd })
    assert.equal(r.ok, true)
    assert.equal(r.number, 3)
    // now both copies of the new top are real; replace BOTH with FIFOs
    const t2 = top(dir)
    unlinkSync(t2.A)
    unlinkSync(t2.B)
    execFileSync('mkfifo', [t2.A])
    execFileSync('mkfifo', [t2.B])
    const closed = await allocOnce({ dir, cwd })
    assert.equal(closed.reason, 'evidence_lost')
  })
})

describe('compare-and-swap by generation', () => {
  it('creates no lock artifact, ever', () => {
    const seen = []
    const f = fresh({ deps: { afterLoad: () => seen.push(...readdirSync(dirOf())) } })
    const dirOf = () => f.dir
    const cwd = project('p')
    nums(f.alloc, cwd, 3)
    f.alloc.bind('k', 's', { number: 1 })
    for (const name of [...seen, ...readdirSync(f.dir)]) assert.ok(!/lock/i.test(name), `unexpected ${name}`)
    assert.ok(!readdirSync(f.dir).some((n) => n.startsWith('session-names.tmp.')), 'temp files cleaned up')
  })

  it('two allocators that both loaded generation g: exactly one wins g+1, the loser retries to the next number', () => {
    const dir = tmp('names-race-')
    const cwd = project('race')
    const y = createSessionNameAllocator({ dir })
    let yResult = null
    let nested = false
    const x = createSessionNameAllocator({
      dir,
      deps: {
        afterLoad: () => {
          if (nested) return
          nested = true
          yResult = y.allocate({ cwd }) // Y loads the SAME generation X just loaded, and wins
        },
      },
    })
    const xResult = x.allocate({ cwd })
    assert.equal(yResult.number, 1)
    assert.equal(xResult.number, 2)
    assert.deepEqual(gensOf(dir), [1, 2])
    assert.equal(readDoc(genFile(dir, 1)).body.projects.race.next, 2, "Y's generation 1 was not overwritten by the loser")
    assert.equal(readDoc(genFile(dir, 2)).body.projects.race.next, 3)
  })

  it('a stale writer whose target generation was pruned (ABA) is aborted by the post-link check', () => {
    const dir = tmp('names-aba-')
    const cwd = project('aba')
    const y = createSessionNameAllocator({ dir })
    let nested = false
    const x = createSessionNameAllocator({
      dir,
      deps: {
        afterLoad: () => {
          if (nested) return
          nested = true
          assert.deepEqual(nums(y, cwd, 4), [1, 2, 3, 4]) // gen 1..4; gen 1 is pruned
          assert.equal(existsSync(genFile(dir, 1)), false)
        },
      },
    })
    const r = x.allocate({ cwd })
    assert.equal(r.number, 5, 'X must not re-issue a number from its stale view')
    assert.equal(existsSync(genFile(dir, 1)), false, 'its stale gen-1 link was removed')
    assert.deepEqual(gensOf(dir).filter((g) => g < 3), [])
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 6)
  })

  it('constant EEXIST returns contended after the attempt bound, in a child, without hanging', async () => {
    const dir = tmp('names-contend-')
    const r = await allocOnce({ mode: 'contend', dir, cwd: project('c') })
    assert.equal(r.reason, 'contended')
    assert.equal(r.links, 8)
    assert.ok(r.elapsedMs < 1500)
    assert.deepEqual(gensOf(dir), [])
    assert.ok(!readdirSync(dir).some((n) => n.startsWith('session-names.tmp.')))
  })

  it('a filesystem without hard links is unsupported_fs: non-closing, nothing issued', () => {
    const dir = tmp('names-nolink-')
    const cwd = project('p')
    const x = createSessionNameAllocator({ dir, deps: { linkSync: () => { throw Object.assign(new Error('no'), { code: 'EPERM' }) } } })
    assert.deepEqual(x.allocate({ cwd }), { ok: false, reason: 'unsupported_fs' })
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 1)
  })

  it('prunes to the last three generations', () => {
    const f = fresh()
    nums(f.alloc, project('p'), 6)
    assert.deepEqual(gensOf(f.dir), [4, 5, 6])
  })
})

describe('writes never issue an unconfirmed number', () => {
  it('a failing primary publish issues nothing and leaves nothing', () => {
    const f = fresh({ deps: { linkSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }) } } })
    assert.deepEqual(f.alloc.allocate({ cwd: project('p') }), { ok: false, reason: 'write_unconfirmed' })
    assert.deepEqual(readdirSync(f.dir), [])
  })

  it('a non-EEXIST mirror-link failure issues nothing and LEAVES the primary: the number is a gap, never reused', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    nums(createSessionNameAllocator({ dir }), cwd, 2)
    const bad = createSessionNameAllocator({ dir, deps: { linkSync: failMirrorLink } })
    assert.deepEqual(bad.allocate({ cwd }), { ok: false, reason: 'write_unconfirmed' })
    assert.ok(existsSync(genFile(dir, 3)), 'a possibly-visible generation is never retracted')
    assert.ok(!existsSync(genFile(dir, 3, true)))
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 4, 'number 3 was persisted: a gap')
  })

  it('a throwing post-publish listing leaves both files in place and the number is not reused', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    let calls = 0
    const bad = createSessionNameAllocator({ dir, deps: { readdir: (d) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) // load=1, post-publish=2
      return readdirSync(d)
    } } })
    assert.deepEqual(bad.allocate({ cwd }), { ok: false, reason: 'write_unconfirmed' })
    assert.ok(existsSync(genFile(dir, 1)) && existsSync(genFile(dir, 1, true)))
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 2)
  })

  it('an unconfirmed directory fsync issues nothing; the persisted number is a gap, never reissued', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    const bad = createSessionNameAllocator({ dir, deps: { syncDir: () => { throw new Error('EIO') } } })
    assert.deepEqual(bad.allocate({ cwd }), { ok: false, reason: 'write_unconfirmed' })
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 2)
  })

  it('an idempotent retry is never answered without a confirmed write, even when the copies already match', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    const genBefore = top(dir).gen
    const bad = createSessionNameAllocator({ dir, deps: { syncDir: () => { throw new Error('EIO') } } })
    assert.deepEqual(bad.allocate({ cwd, idempotencyKey: 'k' }), { ok: false, reason: 'write_unconfirmed' })
    const good = createSessionNameAllocator({ dir }).allocate({ cwd, idempotencyKey: 'k' })
    assert.equal(good.number, 1, 'same number, no new one consumed')
    assert.ok(top(dir).gen > genBefore, 'a new generation carries it')
    assert.ok(existsSync(top(dir).A) && existsSync(top(dir).B))
  })

  it('a short write is completed, not mistaken for a whole file', () => {
    const f = fresh({ deps: { writeSync: (fd, buf, off, len) => writeSync(fd, buf, off, Math.min(len, 7)) } })
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd }).number, 1)
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 2, 'the stored file parses')
    assert.equal(readDoc(f.top().A).sha256, readDoc(f.top().B).sha256)
  })

  it('a failure after partial progress, or zero progress, issues nothing and leaves no files', () => {
    let calls = 0
    const partial = fresh({ deps: { writeSync: (fd, buf, off) => {
      calls += 1
      if (calls === 1) return writeSync(fd, buf, off, 10)
      throw Object.assign(new Error('EIO'), { code: 'EIO' })
    } } })
    assert.deepEqual(partial.alloc.allocate({ cwd: project('p') }), { ok: false, reason: 'write_unconfirmed' })
    assert.deepEqual(readdirSync(partial.dir), [])
    const stuck = fresh({ deps: { writeSync: () => 0 } })
    assert.deepEqual(stuck.alloc.allocate({ cwd: project('p') }), { ok: false, reason: 'write_unconfirmed' })
    assert.deepEqual(readdirSync(stuck.dir), [])
  })

  it('a thrown non-Error is still reported, not propagated', () => {
    const f = fresh({ deps: { linkSync: () => { throw undefined } } })
    assert.equal(f.alloc.allocate({ cwd: project('p') }).reason, 'write_unconfirmed')
  })
})

describe('a generation is owned only by the writer that creates both names', () => {
  for (const lost of ['primary', 'mirror']) {
    it(`stale writer + loss of the ${lost} of the generation it missed never re-issues the number`, () => {
      const dir = tmp('names-b1-')
      const cwd = project('p')
      const y = createSessionNameAllocator({ dir })
      let yResult = null
      let nested = false
      const x = createSessionNameAllocator({
        dir,
        deps: {
          afterLoad: () => {
            if (nested) return
            nested = true
            yResult = y.allocate({ cwd }) // publishes BOTH copies of g1 and returns "p 1"
            unlinkSync(genFile(dir, 1, lost === 'mirror'))
          },
        },
      })
      const xResult = x.allocate({ cwd })
      assert.equal(yResult.number, 1)
      assert.equal(xResult.number, 2, 'X must not reclaim g1 and answer "p 1" again')
      assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 3)
    })
  }
})

describe('store budget', () => {
  it('store_full when projects fill the budget: non-closing, nothing written, existing projects still allocate, reload works', () => {
    const dir = tmp('names-full-')
    const deps = { maxBytes: 6000 }
    const alloc = createSessionNameAllocator({ dir, deps })
    const parent = tmp('names-many-')
    const first = project('first', parent)
    assert.equal(alloc.allocate({ cwd: first }).number, 1)
    let full = null
    for (let i = 0; i < 100 && !full; i++) {
      const r = alloc.allocate({ cwd: project(`proj-${i}`, parent) })
      if (!r.ok) full = r
    }
    assert.deepEqual(full, { ok: false, reason: 'store_full' })
    const genAtFull = top(dir).gen
    assert.equal(alloc.allocate({ cwd: first }).number, 2, 'an existing project still allocates')
    assert.ok(statSync(top(dir).A).size <= 6000)
    assert.equal(top(dir).gen, genAtFull + 1)
    assert.equal(createSessionNameAllocator({ dir, deps }).allocate({ cwd: first }).number, 3, 'a later reload still works')
  })

  it('over budget evicts the oldest idempotency records, never the current one', () => {
    const dir = tmp('names-evict-')
    const alloc = createSessionNameAllocator({ dir, deps: { maxBytes: 3500 } })
    const cwd = project('evict')
    for (let i = 0; i < 60; i++) assert.ok(alloc.allocate({ cwd, idempotencyKey: `key-${String(i).padStart(3, '0')}-${'x'.repeat(40)}` }).ok)
    const t = top(dir)
    assert.ok(statSync(t.A).size <= 3500)
    const keys = Object.keys(readDoc(t.A).body.keys)
    assert.ok(keys.length < 60 && keys.length > 0)
    assert.ok(keys.some((k) => k.startsWith('key-059-')), 'current record kept')
    assert.ok(!keys.some((k) => k.startsWith('key-000-')), 'oldest record evicted')
  })

  it('sessionId over 128 chars is a TypeError; root is capped at 512 code points', () => {
    const { alloc } = fresh()
    assert.throws(() => alloc.bind('k', 's'.repeat(129), { number: 1 }), TypeError)
    const deep = project('d', join(tmp('names-deep-'), 'a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120), 'e'.repeat(120), 'f'.repeat(120)))
    const f = fresh()
    assert.equal(f.alloc.allocate({ cwd: deep }).ok, true)
    assert.ok(Array.from(readDoc(f.top().A).body.projects.d.root).length <= 512)
  })
})

describe('eviction cost near the cap', () => {
  it('trimming hundreds of idempotency records near the budget re-serializes the store a bounded number of times', () => {
    const dir = tmp('names-evictcost-')
    const body = { projects: {}, keys: {}, seq: 0 }
    for (let i = 0; i < 2000; i++) body.projects[`proj-${i}`] = { label: `proj-${i}`, root: 'x'.repeat(300), next: 5 }
    for (let i = 0; i < 512; i++) {
      body.seq += 1
      body.keys[`k-${i}`] = { key: 'proj-0', rootId: 'a'.repeat(64), n: 1, sessionId: null, at: Date.now(), seq: body.seq }
    }
    const doc = sign({ gen: 1, body })
    putStore(dir, doc)
    const size = Buffer.byteLength(JSON.stringify(doc))
    assert.ok(size < 1024 * 1024)
    const budget = size - 60_000 // about 260 records must go
    let serializations = 0
    const alloc = createSessionNameAllocator({ dir, deps: { maxBytes: budget, syncDir: noSync, onSerialize: () => { serializations += 1 } } })
    const r = alloc.allocate({ cwd: project('proj-0-fresh'), idempotencyKey: 'new-key' })
    assert.equal(r.ok, true, JSON.stringify(r))
    const stored = readDoc(top(dir).A)
    assert.ok(statSync(top(dir).A).size <= budget)
    assert.ok(Object.keys(stored.body.keys).length < 300)
    assert.ok('new-key' in stored.body.keys, 'the current record is kept')
    assert.ok(!('k-0' in stored.body.keys) && 'k-511' in stored.body.keys, 'oldest by seq went first')
    assert.ok(serializations <= 3, `the store was re-serialized ${serializations} times for one batch of evictions`)
  })
})

describe('log dedupe is per allocator instance', () => {
  it('two allocators on one closed store each log their own fail-closed error', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    writeFileSync(f.top().A, 'x')
    writeFileSync(f.top().B, 'y')
    const logsB = []
    const other = createSessionNameAllocator({ dir: f.dir, log: { error: (m) => logsB.push(m) } })
    for (let i = 0; i < 3; i++) {
      f.alloc.allocate({ cwd })
      other.allocate({ cwd })
    }
    assert.equal(f.logs.filter((l) => l.level === 'error').length, 1)
    assert.equal(logsB.length, 1)
  })

  it('a write budget larger than the read cap is clamped to it (a store never outgrows what a load accepts)', () => {
    const dir = tmp('names-clamp-')
    const body = { projects: {}, keys: {}, seq: 0 }
    for (let i = 0; i < 2600; i++) body.projects[`proj-${i}`] = { label: `proj-${i}`, root: 'x'.repeat(300), next: 5 }
    const LIMIT = 1024 * 1024
    const size = () => Buffer.byteLength(JSON.stringify(sign({ gen: 1, body })))
    body.projects['proj-0'].root += 'x'.repeat(Math.max(0, LIMIT - 200 - size()))
    assert.ok(size() < LIMIT && size() > LIMIT - 300)
    putStore(dir, sign({ gen: 1, body }))
    const alloc = createSessionNameAllocator({ dir, deps: { maxBytes: 50 * 1024 * 1024, syncDir: noSync } })
    assert.deepEqual(alloc.allocate({ cwd: project('a-brand-new-project-with-a-long-enough-name-to-overflow') }), { ok: false, reason: 'store_full' })
    assert.ok(statSync(top(dir).A).size <= LIMIT)
    assert.equal(alloc.allocate({ cwd: project('proj-5') }).ok, true, 'an existing project still allocates')
  })
})

describe('refused git config visibility', () => {
  it('logs one warning per process per root, with the reason and no config contents', () => {
    const f = fresh()
    const cwd = project('weirdcfg')
    writeFileSync(join(cwd, '.git', 'config'), '[include]\n\tpath = SECRET-MARKER-path\n')
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'non_project' })
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'non_project' })
    const warns = f.logs.filter((l) => l.level === 'warn')
    assert.equal(warns.length, 1)
    assert.ok(/legacy naming/.test(warns[0].m) && /config_unsupported_syntax/.test(warns[0].m))
    assert.ok(!JSON.stringify(warns).includes('SECRET-MARKER'))
  })
})

describe('fail-closed persistence and the narrowed guarantee', () => {
  it('stays closed across a new instance and recovers only after every naming file is removed', () => {
    const f = fresh()
    const cwd = project('chroxy')
    nums(f.alloc, cwd, 3)
    for (const g of gensOf(f.dir)) {
      writeFileSync(genFile(f.dir, g), 'x')
      writeFileSync(genFile(f.dir, g, true), 'y')
    }
    assert.equal(f.alloc.allocate({ cwd }).reason, 'evidence_lost')
    const restarted = createSessionNameAllocator({ dir: f.dir })
    assert.equal(restarted.allocate({ cwd }).reason, 'evidence_lost')
    for (const g of gensOf(f.dir).slice(0, -1)) {
      unlinkSync(genFile(f.dir, g))
      unlinkSync(genFile(f.dir, g, true))
    }
    assert.equal(restarted.allocate({ cwd }).reason, 'evidence_lost', 'removing older generations is not recovery')
    for (const n of readdirSync(f.dir)) unlinkSync(join(f.dir, n))
    // Narrowed guarantee: all files gone == first use. Restarts above the LIVE floor, may repeat deleted numbers.
    const after = createSessionNameAllocator({ dir: f.dir, liveNames: () => ['chroxy 2'] })
    assert.equal(after.allocate({ cwd }).number, 3)
  })

  it('never reuses a number across restart; one corrupted copy does not reset it', () => {
    const f = fresh()
    const cwd = project('p')
    assert.deepEqual(nums(f.alloc, cwd, 3), [1, 2, 3])
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 4)
    writeFileSync(f.top().A, 'corrupt')
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 5)
    writeFileSync(f.top().B, 'corrupt')
    assert.equal(createSessionNameAllocator({ dir: f.dir }).allocate({ cwd }).number, 6)
  })
})

describe('crash proof and cross-process soak', () => {
  it('SIGKILLing an allocating child never lets a printed number repeat', async () => {
    const dir = tmp('names-crash-')
    const cwd = project('crashy')
    const printed = []
    for (let i = 0; i < 12; i++) {
      const { proc, st } = runChild({ mode: 'loop', dir, cwd })
      await waitFor(() => st.out.includes('\n'), 5000, `child ${i} first number`)
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 56)))
      proc.kill('SIGKILL')
      await waitFor(() => st.exited, 3000, `child ${i} exit`)
      for (const line of st.out.split('\n').slice(0, -1)) printed.push(Number(line))
    }
    assert.ok(printed.length >= 12, `children issued numbers (${printed.length})`)
    assert.equal(new Set(printed).size, printed.length, 'no printed number repeats across runs')
    const final = createSessionNameAllocator({ dir }).allocate({ cwd })
    assert.ok(final.ok, JSON.stringify(final))
    assert.ok(final.number > Math.max(...printed), 'final allocation exceeds every printed number')
  })

  it('soak: 4 processes x 50 allocations on one dir issue 200 unique numbers', async () => {
    const dir = tmp('names-soak-')
    const cwd = project('soaky')
    const kids = Array.from({ length: 4 }, () => runChild({ mode: 'soak', dir, cwd, count: 50 }))
    await waitFor(() => kids.every((k) => k.st.exited), 90000, 'soak children')
    const all = []
    for (const k of kids) {
      assert.equal(k.st.code, 0, k.st.err)
      all.push(...JSON.parse(k.st.out.trim()))
    }
    assert.equal(all.length, 200)
    assert.equal(new Set(all).size, 200, 'every issued number is unique')
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
    assert.equal(fresh({ liveNames: () => ['CHROXY 12'] }).alloc.allocate({ cwd: project('chroxy') }).number, 13)
  })

  it('the store wins when it is ahead of the live names', () => {
    const dir = tmp('names-dir-')
    const cwd = project('chroxy')
    nums(createSessionNameAllocator({ dir }), cwd, 5)
    assert.equal(createSessionNameAllocator({ dir, liveNames: () => ['chroxy 2'] }).allocate({ cwd }).number, 6)
  })

  it('regex metacharacters in a label are matched literally', () => {
    assert.equal(fresh({ liveNames: () => ['a.c 5', 'abc 50'] }).alloc.allocate({ cwd: project('a.c') }).number, 6)
  })

  it('live numbers that are huge or above 1,000,000 are ignored; 1,000,000 itself counts', () => {
    const cwd = project('chroxy')
    const huge = fresh({ liveNames: () => ['chroxy 99999999999', `chroxy ${Number.MAX_SAFE_INTEGER}`, 'chroxy 99999999999999999999', 'chroxy 1000001'] })
    assert.equal(huge.alloc.allocate({ cwd }).number, 1, 'a user-typed huge name does not exhaust the project')
    assert.equal(fresh({ liveNames: () => ['chroxy 1000000'] }).alloc.allocate({ cwd }).number, 1000001)
  })
})

describe('live collisions', () => {
  it('never allocates a name a live session already holds, even above the floor cutoff', () => {
    const cwd = project('p')
    assert.equal(fresh({ liveNames: () => ['p 1000000', 'p 1000001'] }).alloc.allocate({ cwd }).number, 1000002)
  })

  it('past 64 consecutive collisions it fails non-closing with live_collision', () => {
    const cwd = project('p')
    const live = ['p 1000000']
    for (let i = 1000001; i < 1000001 + 80; i++) live.push(`p ${i}`)
    const f = fresh({ liveNames: () => live })
    assert.deepEqual(f.alloc.allocate({ cwd }), { ok: false, reason: 'live_collision' })
    assert.deepEqual(readdirSync(f.dir), [])
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

  it('a retry publishes a new generation with both copies before returning', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd, idempotencyKey: 'k' })
    const g1 = f.top().gen
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    assert.equal(f.top().gen, g1 + 1)
    assert.equal(readDoc(f.top().A).sha256, readDoc(f.top().B).sha256)
  })

  it('a bound key allocates a fresh number and logs duplicate_create_request', () => {
    const f = fresh()
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    assert.deepEqual(f.alloc.bind('k1', 'sess-1', { number: 1 }), { ok: true })
    assert.equal(readDoc(f.top().A).body.keys.k1.sessionId, 'sess-1')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 2)
    assert.ok(f.logs.some((l) => l.level === 'warn' && /duplicate_create_request/.test(l.m)))
    const entry = readDoc(f.top().A).body.keys.k1
    assert.equal(entry.n, 2)
    assert.equal(entry.sessionId, null)
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
    assert.equal(readDoc(f.top().A).body.keys.k.key, 'one')
  })

  it('the same key and label under a different root is also a conflict; the label counter is still shared', () => {
    const f = fresh()
    const a = project('same')
    const b = project('same')
    assert.notEqual(a, b)
    assert.equal(f.alloc.allocate({ cwd: a, idempotencyKey: 'k' }).number, 1)
    assert.deepEqual(f.alloc.allocate({ cwd: b, idempotencyKey: 'k' }), { ok: false, reason: 'idempotency_key_conflict' })
    assert.equal(f.alloc.allocate({ cwd: b }).number, 2, 'both roots share the label counter')
  })

  it('a BOUND record under the same key for another project or root is replaced, not a conflict (agent-control retries across reconnects)', () => {
    const f = fresh()
    const one = project('one')
    const two = project('two')
    assert.equal(f.alloc.allocate({ cwd: one, idempotencyKey: 'k' }).number, 1)
    assert.deepEqual(f.alloc.bind('k', 'sess-1', { number: 1 }), { ok: true })
    const other = f.alloc.allocate({ cwd: two, idempotencyKey: 'k' })
    assert.equal(other.ok, true, JSON.stringify(other))
    assert.equal(other.number, 1)
    assert.equal(readDoc(f.top().A).body.keys.k.key, 'two', 'the record now belongs to the new project')
    assert.equal(readDoc(f.top().A).body.keys.k.sessionId, null)
    // the same label under another root
    const a = project('same')
    const b = project('same')
    assert.equal(f.alloc.allocate({ cwd: a, idempotencyKey: 'k2' }).number, 1)
    assert.deepEqual(f.alloc.bind('k2', 's2', { number: 1 }), { ok: true })
    assert.equal(f.alloc.allocate({ cwd: b, idempotencyKey: 'k2' }).number, 2)
    // while an UNBOUND reservation under the key still refuses another project
    assert.equal(f.alloc.allocate({ cwd: one, idempotencyKey: 'k3' }).ok, true)
    assert.equal(f.alloc.allocate({ cwd: two, idempotencyKey: 'k3' }).reason, 'idempotency_key_conflict')
  })

  it('bind: unknown key writes nothing; already_bound to a different session; the same session is idempotent', () => {
    const f = fresh()
    f.alloc.allocate({ cwd: project('p'), idempotencyKey: 'k' })
    const before = snapshot(f.dir)
    assert.deepEqual(f.alloc.bind('nope', 's', { number: 1 }), { ok: false, reason: 'unknown_key' })
    assert.deepEqual(snapshot(f.dir), before)
    assert.deepEqual(f.alloc.bind('k', 'sess-a', { number: 1 }), { ok: true })
    assert.deepEqual(f.alloc.bind('k', 'sess-b', { number: 1 }), { ok: false, reason: 'already_bound' })
    assert.deepEqual(f.alloc.bind('k', 'sess-a', { number: 1 }), { ok: true })
    assert.equal(readDoc(f.top().A).body.keys.k.sessionId, 'sess-a')
  })

  it('bind failure is reported, not thrown, and does not un-issue anything', () => {
    const dir = tmp('names-dir-')
    const cwd = project('p')
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    const bad = createSessionNameAllocator({ dir, deps: { linkSync: failMirrorLink } })
    assert.deepEqual(bad.bind('k', 's', { number: 1 }), { ok: false, reason: 'write_unconfirmed' })
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 2)
  })

  it('prunes to 512 records by persisted seq, even when the clock runs backwards', () => {
    let t = 9_000_000_000
    const f = fresh({ now: () => t--, deps: { syncDir: noSync } })
    const cwd = project('p')
    for (let i = 0; i < 515; i++) assert.ok(f.alloc.allocate({ cwd, idempotencyKey: `k${i}` }).ok)
    const keys = Object.keys(readDoc(f.top().A).body.keys)
    assert.equal(keys.length, 512)
    assert.ok(!keys.includes('k0') && !keys.includes('k2'), 'oldest by seq evicted')
    assert.ok(keys.includes('k3') && keys.includes('k514'), 'newest kept although its `at` is the smallest')
  })

  it('a backward clock change never drops a fresh record', () => {
    let t = 1_000_000_000
    const f = fresh({ now: () => t, deps: { syncDir: noSync } })
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1)
    t -= 500_000_000
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k2' }).number, 2)
    const keys = Object.keys(readDoc(f.top().A).body.keys)
    assert.ok(keys.includes('k1') && keys.includes('k2'))
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k1' }).number, 1, 'k1 is still a live record')
  })

  it('TTL (24 h) is applied before lookup: a retry of an expired key is a new key', () => {
    let t = 5_000_000
    const f = fresh({ now: () => t, deps: { syncDir: noSync } })
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'old' }).number, 1)
    t += 23 * 3600 * 1000
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'old' }).number, 1, 'still inside the TTL: same number')
    t += 25 * 3600 * 1000
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'old' }).number, 2, 'expired: treated as a brand-new key')
    assert.deepEqual(f.alloc.bind('gone', 's', { number: 1 }), { ok: false, reason: 'unknown_key' })
  })

  it('a key named __proto__ is stored as data, not as a prototype', () => {
    const f = fresh()
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: '__proto__' }).number, 1)
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: '__proto__' }).number, 1)
    assert.ok(Object.prototype.hasOwnProperty.call(readDoc(f.top().A).body.keys, '__proto__'))
  })
})

describe('idempotency identity, binds and failed-publication hygiene', () => {
  it('two roots that share their first 512 code points are different projects', () => {
    const f = fresh()
    const long = join(tmp('names-long-'), 'x'.repeat(200), 'y'.repeat(200), 'z'.repeat(200))
    const a = project('same', join(long, 'a'))
    const b = project('same', join(long, 'b'))
    assert.ok(a.length > 560 && a.slice(0, 512) === b.slice(0, 512))
    assert.equal(f.alloc.allocate({ cwd: a, idempotencyKey: 'k' }).number, 1)
    assert.deepEqual(f.alloc.allocate({ cwd: b, idempotencyKey: 'k' }), { ok: false, reason: 'idempotency_key_conflict' })
  })

  it('a same-session bind retry is only ok behind a confirmed write', () => {
    const dir = tmp('names-bind-')
    const cwd = project('p')
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    const bad = createSessionNameAllocator({ dir, deps: { syncDir: () => { throw new Error('EIO') } } })
    assert.equal(bad.bind('k', 's', { number: 1 }).reason, 'write_unconfirmed') // published, but unconfirmed
    assert.equal(bad.bind('k', 's', { number: 1 }).reason, 'write_unconfirmed', 'the retry must not report ok')
    assert.deepEqual(createSessionNameAllocator({ dir }).bind('k', 's', { number: 1 }), { ok: true })
  })

  it('a delayed bind after a replacement reservation is stale_reservation; after expiry it is unknown_key', () => {
    let t = 1_000
    const f = fresh({ now: () => t, deps: { syncDir: noSync } })
    const cwd = project('p')
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k' }).number, 1)
    assert.deepEqual(f.alloc.bind('k', 's1', { number: 1 }), { ok: true })
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k' }).number, 2, 'replacement reservation')
    assert.deepEqual(f.alloc.bind('k', 's0', { number: 1 }), { ok: false, reason: 'stale_reservation' })
    assert.equal(readDoc(f.top().A).body.keys.k.sessionId, null)
    t += 25 * 3600 * 1000
    assert.deepEqual(f.alloc.bind('k', 's0', { number: 2 }), { ok: false, reason: 'unknown_key' })
    assert.equal(f.alloc.allocate({ cwd, idempotencyKey: 'k' }).number, 3, 'a new reservation after expiry')
    assert.deepEqual(f.alloc.bind('k', 's0', { number: 2 }), { ok: false, reason: 'stale_reservation' })
  })

  it('sustained mirror-link failure leaves a bounded number of files', () => {
    const dir = tmp('names-fail-')
    const cwd = project('p')
    createSessionNameAllocator({ dir }).allocate({ cwd })
    const bad = createSessionNameAllocator({ dir, deps: { linkSync: failMirrorLink } })
    for (let i = 0; i < 40; i++) assert.equal(bad.allocate({ cwd }).reason, 'write_unconfirmed')
    assert.ok(readdirSync(dir).length <= 6, readdirSync(dir).join(','))
  })

  it('sustained unconfirmed publications (both names created) never pile up generations', () => {
    const dir = tmp('names-pile-')
    const cwd = project('p')
    const bad = createSessionNameAllocator({ dir, deps: { syncDir: () => { throw new Error('EIO') } } })
    for (let i = 0; i < 40; i++) assert.equal(bad.allocate({ cwd }).reason, 'write_unconfirmed')
    assert.ok(gensOf(dir).length <= 3, gensOf(dir).join(','))
    assert.ok(readdirSync(dir).length <= 6)
    assert.equal(createSessionNameAllocator({ dir }).allocate({ cwd }).number, 41, 'every persisted number stayed a gap')
  })

  it('crash-leftover temp files: old ones are reclaimed, fresh ones kept', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    const oldTmp = join(f.dir, 'session-names.tmp.99999.deadbeef.a')
    const freshTmp = join(f.dir, 'session-names.tmp.99999.cafef00d.b')
    writeFileSync(oldTmp, 'x')
    writeFileSync(freshTmp, 'x')
    const hourAgo = new Date(Date.now() - 3600 * 1000)
    utimesSync(oldTmp, hourAgo, hourAgo)
    f.alloc.allocate({ cwd })
    assert.equal(existsSync(oldTmp), false, 'stale temp reclaimed')
    assert.equal(existsSync(freshTmp), true, 'a fresh temp (maybe a live writer) is kept')
  })

  it('SIGKILL leftovers are temp files of the one naming scheme and get reclaimed', () => {
    const f = fresh()
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    const tmpNames = (dir) => readdirSync(dir).filter((n) => n.startsWith('session-names.tmp.'))
    assert.deepEqual(tmpNames(f.dir), [], 'a normal publish leaves none')
  })
})

describe('never throws for environment failures', () => {
  it('returns reasons for write, read, directory and live-name failures', () => {
    const cwd = project('p')
    assert.equal(fresh({ deps: { linkSync: () => { throw new Error('x') } } }).alloc.allocate({ cwd }).reason, 'write_unconfirmed')
    const eacces = Object.assign(new Error('nope'), { code: 'EACCES' })
    const seeded = fresh()
    seeded.alloc.allocate({ cwd })
    assert.equal(createSessionNameAllocator({ dir: seeded.dir, deps: { readFile: () => { throw eacces } } }).allocate({ cwd }).reason, 'io_error')
    assert.equal(fresh({ liveNames: () => { throw new Error('boom') } }).alloc.allocate({ cwd }).reason, 'live_names_failed')
    const asFile = join(tmp('names-file-'), 'iamafile')
    writeFileSync(asFile, 'x')
    assert.equal(createSessionNameAllocator({ dir: join(asFile, 'sub') }).allocate({ cwd }).reason, 'io_error')
  })

  it('a throwing logger cannot break a fail-closed return', () => {
    const f = fresh({ log: { error: () => { throw new Error('logger') } } })
    const cwd = project('p')
    f.alloc.allocate({ cwd })
    writeFileSync(f.top().A, 'x')
    writeFileSync(f.top().B, 'y')
    assert.equal(f.alloc.allocate({ cwd }).reason, 'evidence_lost')
  })

  it('bad arguments are programming errors and throw', () => {
    const { alloc } = fresh()
    assert.throws(() => alloc.allocate({}), TypeError)
    assert.throws(() => alloc.allocate({ cwd: project('p'), idempotencyKey: 5 }), TypeError)
    assert.throws(() => alloc.bind('', 's', { number: 1 }), TypeError)
    assert.throws(() => alloc.bind('k', 's'), TypeError)
    assert.throws(() => alloc.bind('k', 's', { number: 0 }), TypeError)
  })
})
