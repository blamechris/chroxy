import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { GIT, disableRepoAutoGc, rmDirRobust } from './test-helpers.js'

// Two sessions can work in directories of ONE repository. A session-scoped
// connection's git views describe its own directory, not the sibling's.

describe('git views for a session-scoped connection', () => {
  let root, repo, fileOps
  const out = []
  const send = (_ws, msg) => out.push(msg)
  const git = (...args) => execFileSync(GIT, args, { cwd: repo, stdio: 'pipe' })
  const put = (rel, text) => {
    const abs = join(repo, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
  }
  const mine = () => join(repo, 'mine')
  const last = () => out[out.length - 1]

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-scoped-git-')))
    repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    git('init', '-b', 'main')
    disableRepoAutoGc(repo)
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'Test')
    put('mine/a.txt', 'a1\n')
    put('mine/sub/b.txt', 'b1\n')
    put('theirs/secret.txt', 's1\n')
    put('theirs/moved.txt', 'm1\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    git('branch', 'sibling-feature')
    // Working-tree changes in both directories, one staged rename out of `theirs`.
    put('mine/a.txt', 'a2\n')
    put('mine/sub/b.txt', 'b2\n')
    put('theirs/secret.txt', 'SIBLING-CONTENT\n')
    git('mv', 'theirs/moved.txt', 'mine/moved-in.txt')
    put('theirs/untracked-secret.txt', 'UNTRACKED-SIBLING\n')
    put('mine/untracked-mine.txt', 'mine\n')
    fileOps = createFileOps(send, root)
  })
  after(() => { rmDirRobust(root) })

  const diffPaths = (reply) => reply.files.map((f) => f.path).sort()

  it('an unconfined diff still covers the whole repository (control)', async () => {
    out.length = 0
    await fileOps.getDiff({}, undefined, mine())
    assert.ok(diffPaths(last()).includes('theirs/secret.txt'), 'the control must see the sibling file, or the next test proves nothing')
  })

  it('a confined diff holds only files inside the session directory', async () => {
    out.length = 0
    await fileOps.getDiff({}, undefined, mine(), { confineToCwd: true })
    const reply = last()
    assert.equal(reply.error, null)
    const paths = diffPaths(reply)
    assert.ok(paths.includes('mine/a.txt'))
    assert.ok(paths.includes('mine/sub/b.txt'))
    assert.equal(JSON.stringify(reply).includes('SIBLING-CONTENT'), false)
    assert.equal(paths.some((p) => p.startsWith('theirs/')), false, paths.join(','))
  })

  it('a confined diff does not carry a rename whose source is outside', async () => {
    out.length = 0
    await fileOps.getDiff({}, undefined, mine(), { confineToCwd: true })
    const text = JSON.stringify(last())
    assert.equal(text.includes('theirs/moved.txt'), false)
  })

  it('a confined status lists only paths inside the session directory', async () => {
    out.length = 0
    await fileOps.gitStatus({}, mine(), { confineToCwd: true })
    const reply = last()
    assert.equal(reply.error, null)
    const all = [...reply.staged, ...reply.unstaged].map((e) => e.path).concat(reply.untracked)
    assert.ok(all.some((p) => p.endsWith('a.txt')), all.join(','))
    assert.equal(all.some((p) => p.startsWith('..') || p.includes('theirs')), false, all.join(','))
    assert.equal(reply.staged.some((e) => e.oldPath), false, 'no rename source from outside')
  })

  it('an unconfined status still rebases outside paths (control)', async () => {
    out.length = 0
    await fileOps.gitStatus({}, mine())
    const all = [...last().staged, ...last().unstaged].map((e) => e.path).concat(last().untracked)
    assert.ok(all.some((p) => p.startsWith('..')), 'control: the sibling directory shows up')
  })

  it('confined branches name only the checked-out branch', async () => {
    out.length = 0
    await fileOps.gitBranches({}, mine(), { confineToCwd: true })
    assert.deepEqual(last().branches.map((b) => b.name), ['main'])
    out.length = 0
    await fileOps.gitBranches({}, mine())
    assert.ok(last().branches.some((b) => b.name === 'sibling-feature'), 'control: unconfined lists the roster')
  })

  describe('the handlers choose confinement from the connection', () => {
    function ctxWith(calls) {
      return {
        sessions: { sessionManager: { getSession: () => ({ cwd: '/work/x' }) } },
        services: {
          fileOps: {
            getDiff: (...a) => calls.push(['getDiff', a[3]]),
            gitStatus: (...a) => calls.push(['gitStatus', a[2]]),
            gitBranches: (...a) => calls.push(['gitBranches', a[2]]),
          },
        },
      }
    }
    for (const [type, name] of [['get_diff', 'getDiff'], ['git_status', 'gitStatus'], ['git_branches', 'gitBranches']]) {
      it(`${type}: confined for a scoped connection, not for an unscoped one`, () => {
        const calls = []
        fileHandlers[type]({}, { activeSessionId: 's', boundSessionId: 's' }, { sessionId: 's' }, ctxWith(calls))
        fileHandlers[type]({}, { activeSessionId: 's' }, { sessionId: 's' }, ctxWith(calls))
        fileHandlers[type]({}, { activeSessionId: 's', boundSessionId: '' }, { sessionId: '' }, ctxWith(calls))
        assert.deepEqual(calls.map((c) => c[1]), [{ confineToCwd: true }, { confineToCwd: false }, { confineToCwd: true }], name)
      })
    }
  })
})
