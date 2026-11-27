import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { realpath as realRealpath } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { isGitRepo, isGitRepoSync } from '../src/utils/git-repo.js'
import { GIT } from '../src/git.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { CheckGitRepoSchema } from '@chroxy/protocol'
import { OUTSIDE_HOME_DIR } from './helpers/outside-home.js'

/**
 * #8972 — `check_git_repo`: the New Session dialog asks whether a directory is
 * a git repo BEFORE Create so it can refuse the worktree switch up front. The
 * answer is true / false / null; null ("cannot tell") covers every path the
 * home-contained probe will not judge, so the reply is never an existence
 * oracle for paths outside home and the client leaves the switch enabled.
 */
describe('check_git_repo (#8972)', () => {
  let base

  function check(requestedPath, requestId) {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
    )
    return ops.checkGitRepo(null, requestedPath, requestId).then(() => {
      assert.equal(sent.length, 1, 'exactly one git_repo_check_result reply')
      return sent[0]
    })
  }

  beforeEach(() => {
    base = mkdtempSync(join(homedir(), '.chroxy-test-8972-'))
    mkdirSync(join(base, 'plain'))
    mkdirSync(join(base, 'repo', 'sub'), { recursive: true })
    execFileSync(GIT, ['init', '-q', join(base, 'repo')])
    writeFileSync(join(base, 'a-file'), 'x')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('answers true for a git repository root', async () => {
    const reply = await check(join(base, 'repo'), 'r1')
    assert.deepEqual(reply, { type: 'git_repo_check_result', path: join(base, 'repo'), isGitRepo: true, requestId: 'r1' })
  })

  it('answers true for a subdirectory of a repository (the create path accepts it)', async () => {
    assert.equal((await check(join(base, 'repo', 'sub'))).isGitRepo, true)
  })

  it('answers false for an existing directory that is not a repository', async () => {
    const reply = await check(join(base, 'plain'))
    assert.equal(reply.isGitRepo, false)
    assert.equal('requestId' in reply, false, 'no requestId echoed when none was sent')
  })

  it('expands a leading ~', async () => {
    const rel = base.slice(homedir().length + 1)
    assert.equal((await check(`~/${rel}/plain`)).isGitRepo, false)
  })

  it('answers null (cannot tell) for a missing path, a file, an empty path and a non-string', async () => {
    assert.equal((await check(join(base, 'no-such'))).isGitRepo, null)
    assert.equal((await check(join(base, 'a-file'))).isGitRepo, null)
    assert.equal((await check('   ')).isGitRepo, null)
    assert.equal((await check(undefined)).isGitRepo, null)
  })

  it('answers null for a path outside home, so it is not an existence oracle', async () => {
    const existing = await check(OUTSIDE_HOME_DIR)
    const missing = await check(join(OUTSIDE_HOME_DIR, 'no-such-dir-8972'))
    assert.equal(existing.isGitRepo, null)
    assert.equal(missing.isGitRepo, null)
  })
})

describe('the shared git-repo probe (#8972)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(homedir(), '.chroxy-test-8972p-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sync and async probes agree for a plain dir, a repo and a missing dir', async () => {
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    execFileSync(GIT, ['init', '-q', repo])
    for (const [p, expected] of [[repo, true], [dir, false], [join(dir, 'nope'), false]]) {
      assert.equal(isGitRepoSync(p), expected, `sync ${p}`)
      assert.equal(await isGitRepo(p), expected, `async ${p}`)
    }
  })
})

describe('check_git_repo authority (#8972)', () => {
  function run(client) {
    const probes = []
    const refusals = []
    const ctx = {
      services: {
        fileOps: {
          checkGitRepo: (...a) => probes.push(a),
          refuseGitRepoCheck: (...a) => refusals.push(a),
        },
      },
    }
    const ws = {}
    fileHandlers.check_git_repo(ws, client, { type: 'check_git_repo', path: '/p', requestId: 'r9' }, ctx)
    return { probes, refusals, ws }
  }

  it('an unbound client (null or undefined boundSessionId) and a primary client get the real probe', () => {
    for (const client of [{ boundSessionId: null }, {}, { boundSessionId: undefined, isPrimaryToken: true }]) {
      const { probes, refusals, ws } = run(client)
      assert.deepEqual(probes, [[ws, '/p', 'r9', { config: undefined, bound: false }]])
      assert.equal(refusals.length, 0)
    }
  })

  it('a bound client — including boundSessionId "" — is refused and no probe is started', () => {
    for (const client of [{ boundSessionId: 'sess-a' }, { boundSessionId: '' }, null, undefined]) {
      const { probes, refusals, ws } = run(client)
      assert.equal(probes.length, 0, `no probe for ${JSON.stringify(client)}`)
      assert.deepEqual(refusals, [[ws, '/p', 'r9']])
    }
  })

  it('the refusal is the "cannot tell" reply and touches no filesystem', async () => {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      () => { throw new Error('no cwd resolution expected') },
      () => { throw new Error('no path validation expected') },
    )
    // A repo that would answer true if probed.
    const base = mkdtempSync(join(homedir(), '.chroxy-test-8972r-'))
    try {
      execFileSync(GIT, ['init', '-q', base])
      ops.refuseGitRepoCheck({}, base, 'rq')
      assert.deepEqual(sent, [{ type: 'git_repo_check_result', path: base, isGitRepo: null, requestId: 'rq' }])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('check_git_repo spawn budget (#8972)', () => {
  let base

  beforeEach(() => {
    base = mkdtempSync(join(homedir(), '.chroxy-test-8972b-'))
    mkdirSync(join(base, 'repo', 'sub'), { recursive: true })
    execFileSync(GIT, ['init', '-q', join(base, 'repo')])
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function ops(sent) {
    return createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
    )
  }

  it('caps distinct in-flight probes per socket at 4: the rest answer null without probing', async () => {
    const sent = []
    const o = ops(sent)
    const ws = {}
    // Six distinct spellings of the same repo; every one would answer true if probed.
    // (concatenated, not join()ed, so the spellings stay distinct strings)
    const paths = ['repo', 'repo/.', 'repo/sub/..', 'repo/./sub/..', 'repo/sub/../.', 'repo//']
      .map((p) => `${base}/${p}`)
    await Promise.all(paths.map((p, i) => o.checkGitRepo(ws, p, `r${i}`)))
    const byId = Object.fromEntries(sent.map((m) => [m.requestId, m.isGitRepo]))
    assert.deepEqual(['r0', 'r1', 'r2', 'r3'].map((id) => byId[id]), [true, true, true, true])
    assert.deepEqual(['r4', 'r5'].map((id) => byId[id]), [null, null])
  })

  it('deduplicates an identical in-flight path: duplicates share one probe and do not use budget', async () => {
    const sent = []
    const o = ops(sent)
    const ws = {}
    const p = `${base}/repo`
    const distinct = ['repo/.', 'repo/sub/..', 'repo/./sub/..'].map((x) => `${base}/${x}`)
    await Promise.all([p, p, p, p, p, ...distinct, p].map((x, i) => o.checkGitRepo(ws, x, `d${i}`)))
    assert.equal(sent.length, 9)
    assert.ok(sent.every((m) => m.isGitRepo === true), 'every duplicate got the real answer')
  })

  it('the budget frees up after probes settle, and is per socket', async () => {
    const sent = []
    const o = ops(sent)
    const ws = {}
    const wsOther = {}
    const spell = ['repo', 'repo/.', 'repo/sub/..', 'repo/./sub/..', 'repo/sub/../.'].map((x) => `${base}/${x}`)
    await Promise.all(spell.slice(0, 4).map((x, i) => o.checkGitRepo(ws, x, `a${i}`)))
    // Same socket again after settling: budget is free.
    await o.checkGitRepo(ws, spell[4], 'again')
    // A different socket is unaffected by this one's load.
    await o.checkGitRepo(wsOther, spell[0], 'other')
    const byId = Object.fromEntries(sent.map((m) => [m.requestId, m.isGitRepo]))
    assert.equal(byId.again, true)
    assert.equal(byId.other, true)
  })
})

describe('check_git_repo bounds the whole probe (#8998)', () => {
  const SHORT_MS = 40
  const GENEROUS_MS = 5000
  const DEADLINE_MS = 2000
  let base
  let boundMs

  beforeEach(() => {
    boundMs = SHORT_MS
    base = mkdtempSync(join(homedir(), '.chroxy-test-8998-'))
    mkdirSync(join(base, 'repo'), { recursive: true })
    execFileSync(GIT, ['init', '-q', join(base, 'repo')])
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  // `faulty` decides how a path whose basename starts with "bad-8998-" behaves;
  // every other path (including home) goes to the real realpath. The bound is
  // read lazily through `boundMs`, so the real fifth probe on the SAME ops and
  // socket can run under a generous bound while the faulty ones saw the short one.
  function ops(sent, faulty) {
    return createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
      {
        gitProbeTimeoutMs: () => boundMs,
        gitProbeRealpath: (p) => (basename(String(p)).startsWith('bad-8998-') ? faulty(p) : realRealpath(p)),
      },
    )
  }

  // Race a call against a test-side deadline so a missing bound fails red, not hung.
  async function withinDeadline(promise, label) {
    let t
    const deadline = new Promise((resolve) => { t = setTimeout(() => resolve('DEADLINE'), DEADLINE_MS) })
    try {
      const r = await Promise.race([promise, deadline])
      assert.notEqual(r, 'DEADLINE', `${label} did not settle within ${DEADLINE_MS}ms (probe unbounded)`)
    } finally {
      clearTimeout(t)
    }
  }

  const badPaths = (n) => Array.from({ length: n }, (_, i) => `${base}/bad-8998-${i}`)

  it('a never-settling realpath answers null after the bound and frees the slot', async () => {
    const sent = []
    const o = ops(sent, () => new Promise(() => {}))
    const ws = {}
    await withinDeadline(
      Promise.all(badPaths(4).map((p, i) => o.checkGitRepo(ws, p, `h${i}`))),
      'four hung probes',
    )
    const byId = Object.fromEntries(sent.map((m) => [m.requestId, m.isGitRepo]))
    assert.deepEqual(['h0', 'h1', 'h2', 'h3'].map((id) => byId[id]), [null, null, null, null])
    // All four slots were held by hung probes; a fifth distinct path must be probed for real.
    boundMs = GENEROUS_MS
    await withinDeadline(o.checkGitRepo(ws, `${base}/repo`, 'fifth'), 'fifth probe')
    assert.equal(sent.find((m) => m.requestId === 'fifth').isGitRepo, true)
  })

  it('a rejecting realpath answers null and frees its slot', async () => {
    const sent = []
    const o = ops(sent, () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' })))
    const ws = {}
    await withinDeadline(
      Promise.all(badPaths(4).map((p, i) => o.checkGitRepo(ws, p, `f${i}`))),
      'four failing probes',
    )
    const byId = Object.fromEntries(sent.map((m) => [m.requestId, m.isGitRepo]))
    assert.deepEqual(['f0', 'f1', 'f2', 'f3'].map((id) => byId[id]), [null, null, null, null])
    boundMs = GENEROUS_MS
    await withinDeadline(o.checkGitRepo(ws, `${base}/repo`, 'fifth'), 'fifth probe')
    assert.equal(sent.find((m) => m.requestId === 'fifth').isGitRepo, true)
  })

  it('a slow-but-live probe that finishes after the bound is dropped and a fresh probe starts', async () => {
    const sent = []
    let slow = true
    let lateDone = Promise.resolve()
    const o = ops(sent, () => {
      if (!slow) return realRealpath(join(base, 'repo'))
      // Resolves to the real repo, but only ~3x the bound later.
      lateDone = new Promise((resolve) => {
        setTimeout(() => resolve(realRealpath(join(base, 'repo'))), SHORT_MS * 3)
      })
      return lateDone
    })
    const ws = {}
    const p = `${base}/bad-8998-slow`
    await withinDeadline(o.checkGitRepo(ws, p, 'late'), 'slow probe')
    assert.equal(sent.find((m) => m.requestId === 'late').isGitRepo, null, 'bound fired first')
    await lateDone // let the abandoned work finish; no timer outlives the test
    await new Promise((r) => setTimeout(r, SHORT_MS))
    slow = false
    boundMs = GENEROUS_MS
    await withinDeadline(o.checkGitRepo(ws, p, 'again'), 'fresh probe')
    assert.equal(sent.find((m) => m.requestId === 'again').isGitRepo, true, 'a fresh probe ran; the late result was not reused')
  })
})

describe('check_git_repo wiring (#8972)', () => {

  it('the client schema accepts a request and rejects a missing or over-long path', () => {
    assert.ok(CheckGitRepoSchema.safeParse({ type: 'check_git_repo', path: '/p', requestId: 'r' }).success)
    assert.ok(!CheckGitRepoSchema.safeParse({ type: 'check_git_repo' }).success)
    assert.ok(!CheckGitRepoSchema.safeParse({ type: 'check_git_repo', path: 'x'.repeat(4097) }).success)
  })
})
