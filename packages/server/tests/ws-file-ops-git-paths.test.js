import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { rmDirRobustAsync } from './test-helpers.js'

const execFileAsync = promisify(execFileCb)

describe('gitStage/gitUnstage path validation (#1958)', () => {
  let tmpDir
  let fileOps
  let lastMessage

  const mockSend = (_ws, msg) => { lastMessage = msg }
  const ws = {} // dummy ws object

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-git-paths-'))
    await execFileAsync('git', ['init'], { cwd: tmpDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    // Create a file inside the repo so git has something to work with
    await writeFile(join(tmpDir, 'valid.txt'), 'hello')
    // Pass tmpDir as workspaceRoot so operations within it are allowed
    fileOps = createFileOps(mockSend, tmpDir)
  })

  after(async () => {
    if (tmpDir) await rmDirRobustAsync(tmpDir)
  })

  it('gitStage rejects path traversal (../../etc/passwd)', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['../../etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitUnstage rejects path traversal (../../etc/passwd)', async () => {
    lastMessage = null
    await fileOps.gitUnstage(ws, ['../../etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitStage rejects absolute paths outside CWD', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['/etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitUnstage rejects absolute paths outside CWD', async () => {
    lastMessage = null
    await fileOps.gitUnstage(ws, ['/etc/passwd'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`)
  })

  it('gitStage accepts valid relative paths within CWD', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['valid.txt'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.equal(lastMessage.error, null, 'should succeed without error')
  })

  it('gitStage fails fast on first invalid file in a batch', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['valid.txt', '../../etc/passwd', 'other.txt'], tmpDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error && lastMessage.error.includes('Access denied'),
      'should reject the batch when any file is outside CWD')
  })
})

describe('git ops workspace root validation (#2690)', () => {
  let workspaceDir
  let outsideDir
  let fileOps
  let lastMessage

  const mockSend = (_ws, msg) => { lastMessage = msg }
  const ws = {}

  before(async () => {
    // Create workspace root and a separate directory outside of it
    workspaceDir = await mkdtemp(join(tmpdir(), 'chroxy-workspace-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-'))

    // Init git in workspace dir
    await execFileAsync('git', ['init'], { cwd: workspaceDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: workspaceDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspaceDir })
    await writeFile(join(workspaceDir, 'file.txt'), 'hello')

    // Init git in outside dir so git commands would succeed if path check were absent
    await execFileAsync('git', ['init'], { cwd: outsideDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: outsideDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: outsideDir })

    // File ops restricted to workspaceDir
    fileOps = createFileOps(mockSend, workspaceDir)
  })

  after(async () => {
    if (workspaceDir) await rmDirRobustAsync(workspaceDir)
    if (outsideDir) await rmDirRobustAsync(outsideDir)
  })

  it('gitStatus rejects a path outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitStatus(ws, outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitBranches rejects a path outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitBranches(ws, outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_branches_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitStage rejects a sessionCwd outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitStage(ws, ['file.txt'], outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitUnstage rejects a sessionCwd outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitUnstage(ws, ['file.txt'], outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitCommit rejects a sessionCwd outside workspace root', async () => {
    lastMessage = null
    await fileOps.gitCommit(ws, 'test commit', outsideDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_commit_result')
    assert.ok(
      lastMessage.error && lastMessage.error.includes('Access denied'),
      `expected Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitStatus rejects a NON-EXISTING path whose parent is a symlink escaping workspace root (2026-04-11 audit blocker 4 sibling)', async (t) => {
    // validateGitPath had the same bug pattern as validatePathWithinCwd:
    // a realpath-or-lexical fallback on ENOENT that missed parent symlinks.
    // Fixed in the same commit as the main blocker-4 fix by routing
    // validateGitPath through realpathOfDeepestAncestor.
    //
    // Scenario: attacker creates an `escape` symlink inside the workspace
    // pointing outside, then asks gitStatus to run on
    // `escape/non-existent-subdir`. Pre-fix, the ENOENT branch returned
    // the lexical path `/workspace/escape/non-existent-subdir`, which
    // passes the `startsWith(workspaceRoot)` check. Post-fix, the walker
    // realpath()s `escape` to the outside directory and the check rejects.
    const escapeLink = join(workspaceDir, 'escape-git-parent')
    try {
      await symlink(outsideDir, escapeLink)
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOTSUP') {
        t.skip(`symlinks not supported in this environment: ${err.code}`)
        return
      }
      if (err.code !== 'EEXIST') throw err
    }
    try {
      lastMessage = null
      await fileOps.gitStatus(ws, join(escapeLink, 'non-existent-subdir'))
      assert.ok(lastMessage, 'should send a response')
      assert.equal(lastMessage.type, 'git_status_result')
      assert.ok(
        lastMessage.error && lastMessage.error.includes('Access denied'),
        `expected Access denied for non-existent path through parent symlink escape, got: ${lastMessage.error}`
      )
    } finally {
      await rm(escapeLink, { force: true })
    }
  })

  it('gitStatus rejects a symlink pointing outside workspace root', async (t) => {
    // Create a symlink inside workspace that points outside
    const symlinkPath = join(workspaceDir, 'outside-link')
    let created = false

    try {
      await symlink(outsideDir, symlinkPath)
      created = true
    } catch (err) {
      if (err.code === 'EEXIST') {
        created = true // symlink from a previous run still exists — fine
      } else if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOTSUP') {
        t.skip(`symlinks not supported in this environment: ${err.code}`)
        return
      } else {
        throw err
      }
    }

    try {
      lastMessage = null
      await fileOps.gitStatus(ws, symlinkPath)
      assert.ok(lastMessage, 'should send a response')
      assert.equal(lastMessage.type, 'git_status_result')
      assert.ok(
        lastMessage.error && lastMessage.error.includes('Access denied'),
        `expected Access denied error for symlink pointing outside, got: ${lastMessage.error}`
      )
    } finally {
      if (created) await rm(symlinkPath, { force: true })
    }
  })

  it('gitStatus allows a valid path within workspace root', async () => {
    lastMessage = null
    await fileOps.gitStatus(ws, workspaceDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    // Should succeed (no Access denied), though may error if no commits yet
    assert.ok(
      !lastMessage.error || !lastMessage.error.includes('Access denied'),
      `should not get Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitBranches allows a valid path within workspace root', async () => {
    lastMessage = null
    await fileOps.gitBranches(ws, workspaceDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_branches_result')
    assert.ok(
      !lastMessage.error || !lastMessage.error.includes('Access denied'),
      `should not get Access denied error, got: ${lastMessage.error}`
    )
  })

  it('gitStatus allows a subdirectory within workspace root', async () => {
    const subDir = join(workspaceDir, 'subdir')
    await mkdir(subDir, { recursive: true })

    lastMessage = null
    await fileOps.gitStatus(ws, subDir)
    assert.ok(lastMessage, 'should send a response')
    assert.equal(lastMessage.type, 'git_status_result')
    assert.ok(
      !lastMessage.error || !lastMessage.error.includes('Access denied'),
      `should not get Access denied error for subdirectory, got: ${lastMessage.error}`
    )
  })
})

describe('gitStage/gitUnstage pathspec magic (#7281)', () => {
  // `git add` takes a PATHSPEC, not a path. gitStage validated a RESOLVED absolute
  // path and then handed git the RAW client string — two different languages. `:/`
  // resolves, as a filesystem path, to a harmless `<cwd>/:` that passes containment;
  // to git it means "from the repo root". Measured pre-fix: every payload below
  // returned `error: null` AND staged a file outside the session cwd *and* outside
  // the workspace root, from a single WebSocket message.
  //
  // Topology matters: the escape needs the session cwd to be a STRICT SUBDIRECTORY
  // of the git repo. Every pre-existing test in this file uses the repo root as the
  // session cwd, where `:/` has nothing to reach — which is why none of them failed.
  let repoDir      // the git repo root — NOT reachable by the session
  let subDir       // session cwd AND workspace root
  let fileOps
  let lastMessage

  const mockSend = (_ws, msg) => { lastMessage = msg }
  const ws = {}

  const OUTSIDE = 'OUTSIDE-THE-WORKSPACE.txt'

  /** Index contents, as repo-root-relative paths. */
  async function stagedPaths() {
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repoDir })
    return stdout.split('\n').map(s => s.trim()).filter(Boolean)
  }

  /** Anything staged that is not under the session cwd is an escape. */
  async function escapedPaths() {
    return (await stagedPaths()).filter(p => !p.startsWith('sub/'))
  }

  async function resetIndex() {
    await execFileAsync('git', ['reset', 'HEAD', '--', '.'], { cwd: repoDir }).catch(() => {})
  }

  before(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'chroxy-pathspec-'))
    subDir = join(repoDir, 'sub')
    await mkdir(subDir, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: repoDir })
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })
    await writeFile(join(subDir, 'inside.txt'), 'original')
    await writeFile(join(repoDir, OUTSIDE), 'original')
    await execFileAsync('git', ['add', '-A'], { cwd: repoDir })
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir })
    // Dirty both, so `git add` has something to stage on either side of the boundary.
    await writeFile(join(subDir, 'inside.txt'), 'modified')
    await writeFile(join(repoDir, OUTSIDE), 'modified')

    // workspaceRoot === subDir: the repo root is outside the workspace entirely.
    fileOps = createFileOps(mockSend, subDir)
  })

  after(async () => {
    if (repoDir) await rmDirRobustAsync(repoDir)
  })

  // POSITIVE CONTROL. Without this, every assertion below would also pass if the
  // implementation simply denied everything — the exact false-green this repo has
  // been bitten by (docs/false-safety-guards.md).
  it('POSITIVE CONTROL: stages an ordinary file inside the session cwd', async () => {
    await resetIndex()
    lastMessage = null
    await fileOps.gitStage(ws, ['inside.txt'], subDir)
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.equal(lastMessage.error, null, `ordinary staging must still work, got: ${lastMessage.error}`)
    assert.deepEqual(await stagedPaths(), ['sub/inside.txt'])
  })

  // Every payload here was MEASURED to escape pre-fix. Two distinct mechanisms:
  //   - root-anchoring  (':/', ':(top)', ':/*', ':/<file>', ':(top,glob)**') re-bases the
  //     pathspec on the REPO root, which sits above the workspace root here;
  //   - exclusion-only  (':!<file>', ':(exclude)<file>') means "everything except", and
  //     that "everything" is resolved repo-wide, not cwd-wide.
  // ':(glob)**' is deliberately NOT in this list: it stays cwd-relative and does not
  // escape, so it would be a test that cannot fail.
  for (const payload of [':/', ':(top)', ':/*', `:/${OUTSIDE}`, ':(top,glob)**', ':!inside.txt', ':(exclude)nothing']) {
    it(`does not stage outside the workspace root via pathspec magic ${JSON.stringify(payload)}`, async () => {
      await resetIndex()
      lastMessage = null
      await fileOps.gitStage(ws, [payload], subDir)
      assert.ok(lastMessage, 'should send a response')
      assert.equal(lastMessage.type, 'git_stage_result')
      // The invariant, asserted on the filesystem rather than on the reply: whatever
      // the server chose to report, nothing outside the session cwd may be staged.
      assert.deepEqual(
        await escapedPaths(), [],
        `pathspec ${JSON.stringify(payload)} escaped the workspace root and staged files above it`
      )
    })
  }

  it('gitUnstage does not reach outside the workspace root via pathspec magic', async () => {
    await resetIndex()
    // Stage the outside file directly, so a successful escape would be VISIBLE as an
    // unstage. Without this the assertion could pass simply because nothing was staged.
    await execFileAsync('git', ['add', '--', OUTSIDE], { cwd: repoDir })
    assert.deepEqual(await stagedPaths(), [OUTSIDE], 'fixture precondition')

    lastMessage = null
    await fileOps.gitUnstage(ws, [':/'], subDir)
    assert.equal(lastMessage.type, 'git_unstage_result')
    assert.deepEqual(
      await stagedPaths(), [OUTSIDE],
      'gitUnstage reached outside the workspace root and unstaged a file above it'
    )
    await resetIndex()
  })

  // POSITIVE CONTROL that --literal-pathspecs is actually ARMED, rather than the
  // escape merely being blocked by something else. A filename beginning with ':' is
  // UNSTAGEABLE without the flag (git reads it as magic and errors) and stageable
  // with it, so this assertion fails if the flag is ever dropped.
  //
  // POSIX-only: NTFS forbids ':' in a filename (it is the alternate-data-stream
  // separator), so the fixture cannot be created on Windows at all.
  it('POSITIVE CONTROL: stages a file whose name begins with ":" (proves --literal-pathspecs is armed)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('NTFS forbids ":" in filenames — the fixture cannot exist on Windows')
      return
    }
    const weird = ':weird.txt'
    await writeFile(join(subDir, weird), 'colon')
    await resetIndex()
    lastMessage = null
    await fileOps.gitStage(ws, [weird], subDir)
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.equal(lastMessage.error, null, `expected the colon-named file to stage, got: ${lastMessage.error}`)
    assert.deepEqual(await stagedPaths(), [`sub/${weird}`])
    await resetIndex()
  })

  // Guards the OTHER wrong fix: deriving the pathspec from the validator's
  // symlink-resolved `realPath` rather than the lexically-resolved `absPath`. For a
  // symlink inside the repo, realPath names its TARGET, so staging it would record a
  // different object than the client asked for.
  it('stages a symlink itself, not the file it points at', async (t) => {
    const linkPath = join(subDir, 'link.txt')
    try {
      await symlink('inside.txt', linkPath)
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOTSUP') {
        // The Windows CI runner is NETWORK SERVICE and lacks SeCreateSymbolicLinkPrivilege.
        t.skip(`symlinks not supported in this environment: ${err.code}`)
        return
      }
      if (err.code !== 'EEXIST') throw err
    }
    await resetIndex()
    lastMessage = null
    await fileOps.gitStage(ws, ['link.txt'], subDir)
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.equal(lastMessage.error, null, `expected the symlink to stage, got: ${lastMessage.error}`)
    assert.deepEqual(await stagedPaths(), ['sub/link.txt'], 'must stage the link, not its target')
    const { stdout } = await execFileAsync('git', ['ls-files', '-s', 'sub/link.txt'], { cwd: repoDir })
    assert.ok(stdout.startsWith('120000'), `expected symlink mode 120000, got: ${stdout.trim()}`)
    await resetIndex()
  })

  it('rejects an empty pathspec rather than widening it to the whole cwd', async () => {
    await resetIndex()
    lastMessage = null
    await fileOps.gitStage(ws, [''], subDir)
    assert.equal(lastMessage.type, 'git_stage_result')
    assert.ok(lastMessage.error, 'an empty pathspec must be an error')
    assert.deepEqual(await stagedPaths(), [], 'an empty pathspec must not stage anything')
  })
})
