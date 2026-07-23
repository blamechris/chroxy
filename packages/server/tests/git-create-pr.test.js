import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createGitOps } from '../src/ws-file-ops/git.js'
import { GIT } from '../src/git.js'
import { rmDirRobustAsync } from './test-helpers.js'

/**
 * #6876 — in-app PR creation (`git_create_pr`).
 *
 * The git/gh exec seam is INJECTED (createGitOps' 5th arg) so no real branch is
 * pushed and no real PR is opened. A real temp dir is used only to satisfy the
 * workspace-root path validation (`validateGitPath` realpaths it — the dir need
 * not be a git repo since every git/gh call is mocked). Each test asserts the
 * exact command/args issued and that success returns the URL while every failure
 * surfaces a clear, actionable error (never a false success).
 */

// Resolve a mock exec route to the { stdout, stderr } execFile shape, or throw.
function resolveOrThrow(x) {
  if (x && x.throw) throw x.throw
  return { stdout: x?.stdout ?? '', stderr: x?.stderr ?? '' }
}

// Build an injectable exec that routes git/gh commands per `spec` and records
// every call for assertion.
function router(spec = {}) {
  const calls = { all: [], push: null, gh: null }
  const exec = async (file, args) => {
    calls.all.push({ file, args })
    if (file === GIT && args[0] === 'rev-parse' && args[2] === 'HEAD') {
      return resolveOrThrow(spec.revParseHead ?? { stdout: 'feat/pr\n' })
    }
    if (file === GIT && args[0] === 'rev-parse' && args[2] === 'origin/HEAD') {
      return resolveOrThrow(spec.originHead ?? { stdout: 'origin/main\n' })
    }
    if (file === GIT && args[0] === 'push') {
      calls.push = args
      return resolveOrThrow(spec.push ?? { stdout: '' })
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      calls.gh = args
      return resolveOrThrow(spec.gh ?? { stdout: 'https://github.com/o/r/pull/1\n' })
    }
    return { stdout: '', stderr: '' }
  }
  return { exec, calls }
}

describe('gitCreatePR (#6876)', () => {
  let tmpDir
  let cwdReal

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-pr-'))
    cwdReal = await realpath(tmpDir)
  })

  after(async () => {
    await rmDirRobustAsync(tmpDir)
  })

  function makeGit(exec) {
    const responses = []
    const send = (_ws, m) => responses.push(m)
    const resolveSessionCwd = async (p) => realpath(p)
    const validatePathWithinCwd = async () => ({ valid: true })
    const git = createGitOps(send, resolveSessionCwd, validatePathWithinCwd, tmpDir, exec)
    return { git, responses }
  }

  it('pushes the branch and opens a PR against the resolved default base', async () => {
    const { exec, calls } = router()
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 'feat: add thing', body: 'the description' }, tmpDir)

    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_create_pr_result')
    assert.equal(res.error, null)
    assert.equal(res.url, 'https://github.com/o/r/pull/1')
    assert.equal(res.number, 1)
    assert.equal(res.branch, 'feat/pr')
    assert.equal(res.base, 'main')

    // Branch was pushed with an explicit upstream.
    assert.deepEqual(calls.push, ['push', '--set-upstream', 'origin', 'feat/pr'])
    // gh received the title/body/head/base.
    assert.deepEqual(calls.gh, [
      'pr', 'create',
      '--title', 'feat: add thing',
      '--body', 'the description',
      '--head', 'feat/pr',
      '--base', 'main',
    ])
  })

  it('honours an explicit base and the draft flag (skips default-base lookup)', async () => {
    const { exec, calls } = router({ gh: { stdout: 'https://github.com/o/r/pull/9\n' } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't', base: 'develop', draft: true }, tmpDir)

    assert.equal(responses[0].error, null)
    assert.equal(responses[0].number, 9)
    assert.equal(responses[0].base, 'develop')
    // origin/HEAD must NOT have been consulted when base is explicit.
    assert.ok(!calls.all.some(c => c.args[2] === 'origin/HEAD'))
    assert.deepEqual(calls.gh, [
      'pr', 'create', '--title', 't', '--body', '', '--head', 'feat/pr', '--base', 'develop', '--draft',
    ])
  })

  it('rejects an empty title without touching git/gh', async () => {
    const { exec, calls } = router()
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: '   ' }, tmpDir)

    assert.equal(responses[0].type, 'git_create_pr_result')
    assert.match(responses[0].error, /title/i)
    assert.equal(responses[0].url, null)
    assert.equal(calls.all.length, 0)
  })

  it('returns an error when there is no session CWD', async () => {
    const { exec, calls } = router()
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, null)

    assert.match(responses[0].error, /not available in this mode/i)
    assert.equal(calls.all.length, 0)
  })

  it('rejects a detached HEAD (no push/gh)', async () => {
    const { exec, calls } = router({ revParseHead: { stdout: 'HEAD\n' } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.match(responses[0].error, /detached HEAD/i)
    assert.equal(calls.push, null)
    assert.equal(calls.gh, null)
  })

  it('reports "not a git repository" when the branch lookup fails', async () => {
    const err = Object.assign(new Error('fatal: not a git repository'), { code: 128 })
    const { exec } = router({ revParseHead: { throw: err } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.match(responses[0].error, /not a git repository/i)
  })

  it('rejects when the current branch IS the base branch', async () => {
    const { exec, calls } = router({ revParseHead: { stdout: 'main\n' } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't', base: 'main' }, tmpDir)

    assert.match(responses[0].error, /base branch/i)
    assert.equal(calls.push, null)
    assert.equal(calls.gh, null)
  })

  it('surfaces "gh not installed" on ENOENT', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    const { exec } = router({ gh: { throw: err } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.match(responses[0].error, /not installed/i)
    assert.equal(responses[0].url, null)
  })

  it('surfaces "not authenticated" when gh reports an auth error', async () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    })
    const { exec } = router({ gh: { throw: err } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.match(responses[0].error, /not authenticated/i)
  })

  it('surfaces the existing PR URL when one already exists', async () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stderr: 'a pull request for branch "feat/pr" into branch "main" already exists:\nhttps://github.com/o/r/pull/7',
    })
    const { exec } = router({ gh: { throw: err } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.match(responses[0].error, /already exists/i)
    assert.match(responses[0].error, /pull\/7/)
    assert.equal(responses[0].url, null)
  })

  it('surfaces a push failure (no origin) without calling gh', async () => {
    const err = Object.assign(new Error('exit 128'), {
      code: 128,
      stderr: "fatal: 'origin' does not appear to be a git repository",
    })
    const { exec, calls } = router({ push: { throw: err } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.match(responses[0].error, /origin/i)
    assert.equal(calls.gh, null)
  })

  it('errors when gh succeeds but returns no PR URL (no false success)', async () => {
    const { exec } = router({ gh: { stdout: 'Warning: some notice with no url\n' } })
    const { git, responses } = makeGit(exec)

    await git.gitCreatePR({}, { title: 't' }, tmpDir)

    assert.equal(responses[0].url, null)
    assert.match(responses[0].error, /no pull-request URL/i)
  })
})
