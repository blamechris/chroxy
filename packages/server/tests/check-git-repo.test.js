import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

describe('check_git_repo wiring (#8972)', () => {
  it('the handler forwards path and requestId to fileOps.checkGitRepo', () => {
    const calls = []
    const ctx = { services: { fileOps: { checkGitRepo: (...a) => calls.push(a) } } }
    const ws = {}
    fileHandlers.check_git_repo(ws, {}, { type: 'check_git_repo', path: '/p', requestId: 'r9' }, ctx)
    assert.deepEqual(calls, [[ws, '/p', 'r9']])
  })

  it('the client schema accepts a request and rejects a missing or over-long path', () => {
    assert.ok(CheckGitRepoSchema.safeParse({ type: 'check_git_repo', path: '/p', requestId: 'r' }).success)
    assert.ok(!CheckGitRepoSchema.safeParse({ type: 'check_git_repo' }).success)
    assert.ok(!CheckGitRepoSchema.safeParse({ type: 'check_git_repo', path: 'x'.repeat(4097) }).success)
  })
})
