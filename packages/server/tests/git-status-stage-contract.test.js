import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { GIT } from '../src/git.js'
import { disableRepoAutoGc, rmDirRobustAsync } from './test-helpers.js'

/**
 * #7292 — `gitStatus` forwards `git status --porcelain=v1` paths verbatim.
 * Those paths are REPO-ROOT-relative and C-quoted/octal-escaped; `gitStage` /
 * `gitUnstage` then resolve whatever they're given against the SESSION CWD.
 * The two bases only coincide when the session cwd IS the repo root — every
 * existing git-status/git-stage fixture uses the repo root, which is why none
 * of them catch this. These tests use a session cwd that is a STRICT
 * SUBDIRECTORY of the repo (plus a repo-root positive control), so the
 * mismatch is visible.
 */
describe('git status -> stage round trip (#7292)', () => {
  let repoDir
  let subDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'chroxy-git-roundtrip-'))
    fileOps = createFileOps(mockSend, repoDir)
    execFileSync(GIT, ['init'], { cwd: repoDir })
    disableRepoAutoGc(repoDir)
    execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
    execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: repoDir })
    subDir = join(repoDir, 'sub')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(repoDir, 'top.txt'), 'top')
    await writeFile(join(subDir, 'f.txt'), 'hello')
    execFileSync(GIT, ['add', '.'], { cwd: repoDir })
    execFileSync(GIT, ['commit', '-m', 'Initial commit'], { cwd: repoDir })
  })

  after(async () => {
    await rmDirRobustAsync(repoDir)
  })

  async function statusFor(sessionCwd) {
    responses.length = 0
    await fileOps.gitStatus(mockWs, sessionCwd)
    assert.equal(responses.length, 1)
    const res = responses[0]
    assert.equal(res.type, 'git_status_result')
    assert.equal(res.error, null, `gitStatus errored: ${res.error}`)
    return res
  }

  async function stageFor(sessionCwd, files) {
    responses.length = 0
    await fileOps.gitStage(mockWs, files, sessionCwd)
    assert.equal(responses.length, 1)
    return responses[0]
  }

  // --- (a) session cwd in a subdirectory stages the right file ---------

  it('POSITIVE CONTROL: at the repo root, status -> stage round-trips', async () => {
    await writeFile(join(repoDir, 'top.txt'), 'top changed')
    const status = await statusFor(repoDir)
    const entry = status.unstaged.find(f => f.path.endsWith('top.txt'))
    assert.ok(entry, `expected an unstaged entry for top.txt, got: ${JSON.stringify(status.unstaged)}`)

    const stageRes = await stageFor(repoDir, [entry.path])
    assert.equal(stageRes.error, null, `stage failed: ${stageRes.error}`)

    const gitStatusOut = execFileSync(GIT, ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
    assert.ok(gitStatusOut.includes('M  top.txt'), `expected top.txt staged, got:\n${gitStatusOut}`)

    execFileSync(GIT, ['reset', 'HEAD', 'top.txt'], { cwd: repoDir })
    execFileSync(GIT, ['checkout', '--', 'top.txt'], { cwd: repoDir })
  })

  it('a session cwd that is a repo SUBDIRECTORY stages the right (subdirectory) file', async () => {
    await writeFile(join(subDir, 'f.txt'), 'hello changed')
    const status = await statusFor(subDir)
    // The entry must identify f.txt relative to the SESSION CWD (subDir), not
    // the repo root — on unfixed code this is 'sub/f.txt' (repo-root-relative).
    const entry = status.unstaged.find(f => f.path.includes('f.txt'))
    assert.ok(entry, `expected an unstaged entry for f.txt, got: ${JSON.stringify(status.unstaged)}`)
    assert.equal(entry.path, 'f.txt', 'gitStatus must emit cwd-relative paths, not repo-root-relative ones')

    const stageRes = await stageFor(subDir, [entry.path])
    assert.equal(stageRes.error, null, `stage failed: ${stageRes.error}`)

    const gitStatusOut = execFileSync(GIT, ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
    assert.ok(gitStatusOut.includes('M  sub/f.txt'), `expected sub/f.txt staged, got:\n${gitStatusOut}`)
    assert.ok(!/^\?\?/m.test(gitStatusOut) || !gitStatusOut.includes('f.txt" ->'), 'no stray file should be created')

    execFileSync(GIT, ['reset', 'HEAD', 'sub/f.txt'], { cwd: repoDir })
    execFileSync(GIT, ['checkout', '--', 'sub/f.txt'], { cwd: repoDir })
  })

  it('a session cwd that is a repo SUBDIRECTORY does not misreport an unrelated top-level file as inside it', async () => {
    // Regression guard for the specific failure mode in #7292: from `sub/`,
    // unfixed gitStatus reports the repo-root file as 'top.txt' (looking
    // cwd-relative already, by coincidence of there being no 'sub/' prefix at
    // the repo root) and gitStage then resolves 'top.txt' against `sub/`,
    // silently targeting a DIFFERENT, nonexistent path rather than the repo
    // root file the status line actually described.
    await writeFile(join(repoDir, 'top.txt'), 'top changed again')
    const status = await statusFor(subDir)
    const entry = status.unstaged.find(f => f.path.includes('top.txt'))
    assert.ok(entry, `expected an unstaged entry for top.txt, got: ${JSON.stringify(status.unstaged)}`)
    // From `sub/`, the repo-root file is OUTSIDE the session cwd — the
    // cwd-relative path must say so (a leading '..'), never a bare 'top.txt'
    // (which would resolve to a nonexistent file inside sub/).
    assert.ok(entry.path.startsWith('..'), `expected a path outside the session cwd (leading '..'), got: ${entry.path}`)

    execFileSync(GIT, ['checkout', '--', 'top.txt'], { cwd: repoDir })
  })

  // --- (b) paths with spaces, unicode, quotes round-trip -----------------

  it('a path with spaces round-trips status -> stage', async () => {
    const name = 'my notes.txt'
    await writeFile(join(repoDir, name), 'untracked')
    const status = await statusFor(repoDir)
    const path = status.untracked.find(p => p.includes('notes'))
    assert.ok(path, `expected an untracked entry for '${name}', got: ${JSON.stringify(status.untracked)}`)
    assert.equal(path, name, 'the path must not carry quotes')

    const stageRes = await stageFor(repoDir, [path])
    assert.equal(stageRes.error, null, `stage failed for '${path}': ${stageRes.error}`)

    const gitStatusOut = execFileSync(GIT, ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
    assert.ok(gitStatusOut.includes(`A  "${name}"`) || gitStatusOut.includes(`A  ${name}`),
      `expected '${name}' staged, got:\n${gitStatusOut}`)

    execFileSync(GIT, ['reset', 'HEAD', '--', name], { cwd: repoDir })
  })

  it('a path with non-ASCII (unicode) characters round-trips status -> stage', async () => {
    const name = 'café.txt' // café.txt
    await writeFile(join(repoDir, name), 'untracked')
    const status = await statusFor(repoDir)
    const path = status.untracked.find(p => p.includes('caf'))
    assert.ok(path, `expected an untracked entry for '${name}', got: ${JSON.stringify(status.untracked)}`)
    assert.equal(path, name, 'the path must not carry octal escapes')

    const stageRes = await stageFor(repoDir, [path])
    assert.equal(stageRes.error, null, `stage failed for '${path}': ${stageRes.error}`)

    const gitStatusOut = execFileSync(GIT, ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
    assert.ok(gitStatusOut.toLowerCase().includes('caf'), `expected '${name}' staged, got:\n${gitStatusOut}`)

    execFileSync(GIT, ['reset', 'HEAD', '--', name], { cwd: repoDir })
  })

  // --- (c) rename entries: unstaging must not leave a stale staged deletion

  it('unstaging a staged rename clears BOTH the destination add and the source delete', async () => {
    execFileSync(GIT, ['mv', 'top.txt', 'top-renamed.txt'], { cwd: repoDir })
    const status = await statusFor(repoDir)
    const entry = status.staged.find(f => f.status === 'renamed')
    assert.ok(entry, `expected a staged renamed entry, got: ${JSON.stringify(status.staged)}`)

    // Unstage using exactly what the status entry reports as its path (what
    // a client naturally sends back). On unfixed code this is ONLY the
    // destination, and `git reset HEAD -- <dest>` leaves the source's staged
    // deletion behind.
    const filesToUnstage = entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]
    responses.length = 0
    await fileOps.gitUnstage(mockWs, filesToUnstage, repoDir)
    assert.equal(responses.length, 1)
    assert.equal(responses[0].error, null, `unstage failed: ${responses[0].error}`)

    const gitStatusOut = execFileSync(GIT, ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' })
    // Nothing may remain STAGED (first column non-blank) for either path.
    assert.ok(!/^[MADRC]/m.test(gitStatusOut), `expected no staged changes after unstaging the rename, got:\n${gitStatusOut}`)

    // Restore to the pre-test committed state.
    execFileSync(GIT, ['add', '-A'], { cwd: repoDir })
    execFileSync(GIT, ['commit', '-m', 'wip: restore fixture', '--allow-empty'], { cwd: repoDir })
    execFileSync(GIT, ['mv', 'top-renamed.txt', 'top.txt'], { cwd: repoDir })
    execFileSync(GIT, ['commit', '-m', 'wip: restore fixture 2'], { cwd: repoDir })
  })
})
