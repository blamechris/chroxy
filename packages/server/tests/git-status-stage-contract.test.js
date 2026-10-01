import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, symlink, readFile } from 'fs/promises'
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

    // #8183 review (S5) — `gitStatusOut.includes('caf')` cannot fail: the
    // UNTRACKED line for this file would contain that substring whether or
    // not staging actually happened (quoted or not). Check the staged set
    // directly instead — `git diff --cached --name-only -z` is unambiguous
    // (no quoting at all) and only lists what is ACTUALLY staged.
    const stagedNames = execFileSync(GIT, ['diff', '--cached', '--name-only', '-z'], { cwd: repoDir, encoding: 'utf-8' })
    assert.deepEqual(
      stagedNames.split('\0').filter(Boolean),
      [name],
      `expected exactly '${name}' staged, got: ${JSON.stringify(stagedNames)}`,
    )

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

  // --- Copilot finding on PR #8183 (comment 4150321154): `oldPath` leaked
  // onto the UNSTAGED half of a record whenever the STAGED half (x) was a
  // rename/copy, because `if (oldPath !== null) entry.oldPath = oldPath` in
  // the `y` branch used the same `oldPath` variable gated only on `x`. An
  // "RM" record (staged rename, destination further modified in the worktree)
  // therefore produced an unstaged `{ status: 'modified', oldPath }` entry,
  // contradicting the documented contract ("present only on a renamed/copied
  // entry") and making expandRenamePathsForStaging fold the rename source
  // into a plain worktree-modification stage.

  it('an "RM" record (staged rename + worktree-modified destination) attaches oldPath to the RENAMED half only', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-rm-record-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'old.txt'), 'hello world\n')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })

      // Stage the rename, then modify the destination WITHOUT staging that —
      // `git status --porcelain=v1 -z` reports this as a single "RM" record:
      // X='R' (staged rename), Y='M' (further worktree modification).
      execFileSync(GIT, ['mv', 'old.txt', 'new.txt'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'new.txt'), 'hello world\nextra line\n')
      const rawStatus = execFileSync(GIT, ['status', '--porcelain=v1'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^RM /m.test(rawStatus), `test setup didn't produce an RM record, got:\n${rawStatus}`)

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)

      const stagedEntry = res.staged.find(f => f.path === 'new.txt')
      const unstagedEntry = res.unstaged.find(f => f.path === 'new.txt')
      assert.ok(stagedEntry, `expected a staged entry for new.txt, got: ${JSON.stringify(res.staged)}`)
      assert.ok(unstagedEntry, `expected an unstaged entry for new.txt, got: ${JSON.stringify(res.unstaged)}`)

      assert.equal(stagedEntry.status, 'renamed')
      assert.equal(stagedEntry.oldPath, 'old.txt', 'the STAGED (renamed) half must carry oldPath')

      assert.equal(unstagedEntry.status, 'modified')
      assert.equal(unstagedEntry.oldPath, undefined, 'the UNSTAGED (modified) half must NOT carry oldPath')

      // Staging the unstaged entry's path must touch only the destination —
      // folding the (nonexistent) rename source in would error or no-op it.
      responses.length = 0
      await fileOps.gitStage(mockWs, [unstagedEntry.path], tmpDir)
      assert.equal(responses[0].error, null, `stage failed: ${responses[0].error}`)
      // A clean staged rename (X='R', Y=' ') — the worktree modification is
      // fully absorbed, with no residual 'M' left unstaged.
      const afterStage = execFileSync(GIT, ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^R  old\.txt -> new\.txt$/m.test(afterStage), `expected the rename+modification fully staged, got:\n${afterStage}`)
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })

  it('a Y-side (worktree-only) rename via intent-to-add is not misparsed, and later records stay intact', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-yside-rename-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'old.txt'), 'line one\nline two\nline three\nline four\nline five\n')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })

      // Worktree-only rename (nothing staged) — a plain filesystem rename,
      // NOT `git mv` (which stages it immediately, X='R'). Then `add -N`
      // (intent-to-add): this git reports a Y-side rename (' R', not 'R ').
      // A record AFTER it (the untracked sentinel) proves the old-path field
      // was consumed and didn't desync the rest of the parse.
      await rename(join(tmpDir, 'old.txt'), join(tmpDir, 'new.txt'))
      execFileSync(GIT, ['add', '-N', 'new.txt'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'zzz-sentinel.txt'), 'sentinel')
      const rawStatus = execFileSync(GIT, ['status', '--porcelain=v1'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^ R /m.test(rawStatus), `test setup didn't produce a Y-side rename record on this git, got:\n${rawStatus}`)

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)

      assert.equal(res.staged.length, 0, `expected no staged entries, got: ${JSON.stringify(res.staged)}`)
      const unstagedEntry = res.unstaged.find(f => f.path === 'new.txt')
      assert.ok(unstagedEntry, `expected an unstaged entry for new.txt, got: ${JSON.stringify(res.unstaged)}`)
      assert.equal(unstagedEntry.status, 'renamed')
      assert.equal(unstagedEntry.oldPath, 'old.txt')

      // The record immediately after the rename must be intact — not the
      // rename's source path misread as its own bogus status line.
      assert.deepEqual(res.untracked, ['zzz-sentinel.txt'], `later records were desynced, got: ${JSON.stringify(res)}`)
      assert.equal(res.unstaged.length, 1, `expected exactly one unstaged entry, got: ${JSON.stringify(res.unstaged)}`)
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })

  // #8183 review (CRITICAL 2) — a copy's source is NOT removed (both index
  // entries stand independently, unlike a rename), so folding it into a
  // stage/unstage of the destination would touch the source's own,
  // unrelated changes. Requires `status.renames=copies` — copy detection is
  // off by default.
  it('a staged COPY never carries oldPath, and acting on the destination leaves the source untouched', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-copy-mode-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'status.renames', 'copies'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'src.txt'), 'line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })

      // Copy src.txt -> copy.txt, THEN give the source its OWN independent
      // edit, and stage both together — this is what makes git associate
      // them as a copy (X='C') rather than reporting copy.txt as a plain add.
      const srcContent = await readFile(join(tmpDir, 'src.txt'), 'utf8')
      await writeFile(join(tmpDir, 'copy.txt'), srcContent)
      await writeFile(join(tmpDir, 'src.txt'), srcContent + 'modified in source only\n')
      execFileSync(GIT, ['add', 'src.txt', 'copy.txt'], { cwd: tmpDir })
      const rawStatus = execFileSync(GIT, ['status', '--porcelain=v1'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^C  /m.test(rawStatus), `test setup didn't produce a staged copy (need status.renames=copies), got:\n${rawStatus}`)

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)

      const copyEntry = res.staged.find(f => f.path === 'copy.txt')
      assert.ok(copyEntry, `expected a staged entry for copy.txt, got: ${JSON.stringify(res.staged)}`)
      assert.equal(copyEntry.status, 'copied')
      assert.equal(copyEntry.oldPath, undefined, 'a COPIED entry must never carry oldPath')

      // The source's own independent modification is its own separate entry.
      const srcEntry = res.staged.find(f => f.path === 'src.txt')
      assert.ok(srcEntry, `expected a staged entry for src.txt, got: ${JSON.stringify(res.staged)}`)
      assert.equal(srcEntry.status, 'modified')

      // Unstaging ONLY the copy destination must leave the source's staged
      // modification untouched.
      responses.length = 0
      await fileOps.gitUnstage(mockWs, [copyEntry.path], tmpDir)
      assert.equal(responses[0].error, null, `unstage failed: ${responses[0].error}`)
      const afterUnstage = execFileSync(GIT, ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^M  src\.txt$/m.test(afterUnstage), `expected src.txt's modification to remain staged, got:\n${afterUnstage}`)
      assert.ok(/^\?\? copy\.txt$/m.test(afterUnstage), `expected copy.txt unstaged (now untracked), got:\n${afterUnstage}`)
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })

  // #8183 review (S3, CRITICAL 3 robustness) — a worktree-column rename via
  // intent-to-add whose pre-rename path happens to start with a character
  // the parser treats as a status code ('R'/'C'), followed by another
  // changed file. Confirms the old-path field is consumed as opaque DATA,
  // never re-interpreted, and the following record is intact regardless of
  // what the old path's text looks like.
  it('a Y-side rename whose old name starts with "R" does not desync the parser, and the next record is intact', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-tricky-oldname-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'Readme-old.txt'), 'line one\nline two\nline three\nline four\nline five\n')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })

      await rename(join(tmpDir, 'Readme-old.txt'), join(tmpDir, 'renamed.txt'))
      execFileSync(GIT, ['add', '-N', 'renamed.txt'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'other-changed.txt'), 'unrelated change')
      const rawStatus = execFileSync(GIT, ['status', '--porcelain=v1'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^ R /m.test(rawStatus), `test setup didn't produce a Y-side rename, got:\n${rawStatus}`)

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)

      assert.equal(res.staged.length, 0)
      assert.equal(res.unstaged.length, 1, `expected exactly one unstaged entry, got: ${JSON.stringify(res.unstaged)}`)
      assert.equal(res.unstaged[0].path, 'renamed.txt')
      assert.equal(res.unstaged[0].oldPath, 'Readme-old.txt')
      assert.deepEqual(res.untracked, ['other-changed.txt'])
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })

  // #8183 review (S6) — `--show-toplevel`'s output must have only its
  // trailing newline stripped, not `.trim()`-ed: a repo root whose directory
  // name genuinely ends in a space is a rare but real path, and trimming it
  // would rebase every path against the WRONG root.
  it('a repo root directory name ending in a space is not mis-rebased', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'chroxy-git-trailing-space-'))
    const tmpDir = join(parent, 'repo ') // trailing space in the repo root's own name
    try {
      await mkdir(tmpDir)
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'f.txt'), 'hello')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'f.txt'), 'hello changed')

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)
      assert.equal(res.unstaged.length, 1, `expected exactly one unstaged entry, got: ${JSON.stringify(res.unstaged)}`)
      assert.equal(res.unstaged[0].path, 'f.txt', 'a trailing space in the repo root name must not corrupt path rebasing')
    } finally {
      await rmDirRobustAsync(parent)
    }
  })

  // #8183 review (S7) — the repo-root rebasing fix (#7292 defect 1) must
  // hold even when the SESSION CWD itself is reached through a symlink, not
  // just when the host's own tmpdir happens to be one (macOS: /tmp ->
  // /private/tmp, which already exercises this path incidentally — this
  // test makes the symlink explicit so it holds on hosts where it is not).
  it('a session cwd reached through an explicit symlink still rebases correctly', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'chroxy-git-symlink-real-'))
    const linkParent = await mkdtemp(join(tmpdir(), 'chroxy-git-symlink-link-'))
    const linkPath = join(linkParent, 'via-symlink')
    try {
      execFileSync(GIT, ['init'], { cwd: realRoot })
      disableRepoAutoGc(realRoot)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: realRoot })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: realRoot })
      await mkdir(join(realRoot, 'sub'))
      await writeFile(join(realRoot, 'sub', 'f.txt'), 'hello')
      execFileSync(GIT, ['add', '.'], { cwd: realRoot })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: realRoot })
      await symlink(join(realRoot, 'sub'), linkPath)
      await writeFile(join(realRoot, 'sub', 'f.txt'), 'hello changed')

      const fileOps = createFileOps(mockSend, realRoot)
      responses.length = 0
      // sessionCwd is the SYMLINK path, not realRoot/sub directly.
      await fileOps.gitStatus(mockWs, linkPath)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)
      assert.equal(res.unstaged.length, 1, `expected exactly one unstaged entry, got: ${JSON.stringify(res.unstaged)}`)
      assert.equal(res.unstaged[0].path, 'f.txt', 'a symlinked session cwd must still rebase to a plain cwd-relative path')
    } finally {
      await rmDirRobustAsync(realRoot)
      await rmDirRobustAsync(linkParent)
    }
  })

  // #8183 review (S2) — an entirely-untracked directory reported by git as
  // e.g. "newdir/" (git never expands into its contents) must keep its
  // trailing slash on the wire, so it stays distinguishable from an
  // untracked FILE of the same name.
  it('an untracked directory keeps its trailing slash', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-untracked-dir-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'f.txt'), 'hello')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })
      await mkdir(join(tmpDir, 'newdir'))
      await writeFile(join(tmpDir, 'newdir', 'a.txt'), 'x')

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)
      assert.deepEqual(res.untracked, ['newdir/'], `expected the trailing slash preserved, got: ${JSON.stringify(res.untracked)}`)
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })

  // #8183 review (S2) — a session cwd that IS itself an entirely-untracked
  // directory rebases to '' (the untracked entry names the cwd itself);
  // nothing a client could show or act on, so it is dropped rather than sent.
  it('a session cwd that is itself untracked does not emit an empty untracked entry', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-untracked-cwd-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'f.txt'), 'hello')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })
      const untrackedCwd = join(tmpDir, 'newdir')
      await mkdir(untrackedCwd)
      await writeFile(join(untrackedCwd, 'a.txt'), 'x')

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, untrackedCwd)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)
      assert.deepEqual(res.untracked, [], `expected no untracked entries (not '' or '..'), got: ${JSON.stringify(res.untracked)}`)
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })

  // #8183 review (S4) — a rename whose OLD path is recreated as a new,
  // untracked file (`git mv old new` then a fresh `old` written to disk):
  // the rename's oldPath field and the recreated file's own untracked
  // record are adjacent on the wire. Confirms the parser keeps them as two
  // distinct entries (no desync) and that each is independently actionable.
  it('a rename whose old name is recreated keeps the rename and the new untracked file distinct', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-recreated-oldname-'))
    try {
      execFileSync(GIT, ['init'], { cwd: tmpDir })
      disableRepoAutoGc(tmpDir)
      execFileSync(GIT, ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
      execFileSync(GIT, ['config', 'user.name', 'Test'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'old.txt'), 'hello')
      execFileSync(GIT, ['add', '.'], { cwd: tmpDir })
      execFileSync(GIT, ['commit', '-m', 'init'], { cwd: tmpDir })

      execFileSync(GIT, ['mv', 'old.txt', 'new.txt'], { cwd: tmpDir })
      await writeFile(join(tmpDir, 'old.txt'), 'recreated')
      const rawStatus = execFileSync(GIT, ['status', '--porcelain=v1'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^R  old\.txt -> new\.txt$/m.test(rawStatus) && /^\?\? old\.txt$/m.test(rawStatus),
        `test setup didn't produce the expected shape, got:\n${rawStatus}`)

      const fileOps = createFileOps(mockSend, tmpDir)
      responses.length = 0
      await fileOps.gitStatus(mockWs, tmpDir)
      const res = responses[0]
      assert.equal(res.error, null, `gitStatus errored: ${res.error}`)

      assert.equal(res.staged.length, 1, `expected exactly one staged entry, got: ${JSON.stringify(res.staged)}`)
      assert.equal(res.staged[0].path, 'new.txt')
      assert.equal(res.staged[0].status, 'renamed')
      assert.equal(res.staged[0].oldPath, 'old.txt')
      assert.deepEqual(res.untracked, ['old.txt'], `expected the recreated file as its own untracked entry, got: ${JSON.stringify(res.untracked)}`)

      // Each is independently actionable: staging the untracked recreation
      // must not unstage or otherwise disturb the (already-staged) rename's
      // destination — both must remain fully staged afterward. (Staging
      // old.txt gives git's own rename-pairing a second look — since old.txt
      // is no longer "deleted", it re-reports as "A new.txt" + "M old.txt"
      // rather than "R old.txt -> new.txt"; that relabeling is git's, not
      // this code's, and both files staying staged is the actual invariant.)
      responses.length = 0
      await fileOps.gitStage(mockWs, ['old.txt'], tmpDir)
      assert.equal(responses[0].error, null, `stage failed: ${responses[0].error}`)
      const afterStage = execFileSync(GIT, ['status', '--porcelain'], { cwd: tmpDir, encoding: 'utf-8' })
      assert.ok(/^[MAR]  old\.txt$/m.test(afterStage), `expected old.txt to remain staged, got:\n${afterStage}`)
      assert.ok(/^[MAR]  new\.txt$/m.test(afterStage), `expected new.txt to remain staged, got:\n${afterStage}`)
    } finally {
      await rmDirRobustAsync(tmpDir)
    }
  })
})
