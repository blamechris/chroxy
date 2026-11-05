import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { fileOpErrorMessage, clientSafeError } from '../src/ws-file-ops/common.js'
import { readResolvedMemoryFile } from '../src/ws-file-ops/memory.js'
import { GIT } from '../src/git.js'
import { POSIX_PERM_SKIP } from './test-helpers.js'

// #8018 — a failure AFTER containment has passed (open, write, mkdir, git
// itself) used to send `err.message` to the client: "EISDIR: illegal operation
// on a directory, open '<absolute server path>'", or an execFile "Command
// failed: <git binary> ..." line. The client now gets a short reason by error
// code; the raw text goes to the server log only.

// Windows reports different error codes for some of these operations (a file
// used as a directory is ENOENT there, writing onto a directory is not EISDIR),
// so the mapped text differs. The property under test, that no server path or
// raw Node error text reaches the client, is asserted on every platform; the
// exact POSIX wording only off win32.
const IS_WIN = process.platform === 'win32'

describe('ws-file-ops in-project failures carry no absolute server path (#8018)', () => {
  let tmp
  let sent
  const ws = {}
  let ops

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fileops-8018-')))
    sent = []
    ops = createFileOps((_, msg) => sent.push(msg), tmp)
  })

  afterEach(() => {
    try { chmodSync(join(tmp, 'locked.txt'), 0o644) } catch {}
    try { chmodSync(join(tmp, 'locked-dir'), 0o755) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  })

  /** The text a client sees, with every leak marker checked. */
  function assertNoServerPaths(text, label) {
    assert.equal(typeof text, 'string', `${label}: error must be a string`)
    assert.ok(!text.includes(tmp), `${label}: leaks the temp root: ${text.slice(0, 200)}`)
    assert.ok(!text.includes(homedir()), `${label}: leaks the home dir: ${text.slice(0, 200)}`)
    assert.ok(!text.includes(GIT), `${label}: leaks the git binary path: ${text.slice(0, 200)}`)
    assert.ok(!/\bE[A-Z]{3,}:/.test(text), `${label}: carries a raw Node error code prefix: ${text.slice(0, 200)}`)
  }

  it('write_file onto an existing directory answers a short message (EISDIR)', async () => {
    mkdirSync(join(tmp, 'adir'))
    await ops.writeFile(ws, 'adir', 'x', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'write_file_result')
    if (!IS_WIN) assert.equal(sent[0].error, 'Is a directory')
    assertNoServerPaths(sent[0].error, 'write_file')
  })

  it('write_file through an in-project file as a directory answers a short message (ENOTDIR)', async () => {
    writeFileSync(join(tmp, 'present.txt'), 'hello')
    await ops.writeFile(ws, 'present.txt/child.txt', 'x', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'write_file_result')
    assertNoServerPaths(sent[0].error, 'write_file ENOTDIR')
  })

  it('write_file into a read-only directory keeps "Permission denied" (EACCES)', { skip: POSIX_PERM_SKIP }, async () => {
    mkdirSync(join(tmp, 'locked-dir'))
    chmodSync(join(tmp, 'locked-dir'), 0o555)
    await ops.writeFile(ws, 'locked-dir/new.txt', 'x', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].error, 'Permission denied')
    assertNoServerPaths(sent[0].error, 'write_file EACCES')
  })

  it('read_file on an unreadable file keeps "Permission denied" (EACCES)', { skip: POSIX_PERM_SKIP }, async () => {
    writeFileSync(join(tmp, 'locked.txt'), 'secret')
    chmodSync(join(tmp, 'locked.txt'), 0o000)
    await ops.readFile(ws, 'locked.txt', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.equal(sent[0].error, 'Permission denied')
    assertNoServerPaths(sent[0].error, 'read_file EACCES')
  })

  it('read_file on a directory carries no server path', async () => {
    mkdirSync(join(tmp, 'adir'))
    await ops.readFile(ws, 'adir', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.ok(sent[0].error, 'a directory read must fail')
    assertNoServerPaths(sent[0].error, 'read_file dir')
  })

  it('append_memory with a directory in the memory file slot answers a short message (EISDIR)', async () => {
    mkdirSync(join(tmp, 'CLAUDE.md'))
    await ops.appendMemory(ws, 'remember this', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'append_memory_result')
    assert.ok(sent[0].error, 'append must fail')
    assertNoServerPaths(sent[0].error, 'append_memory')
  })

  it('browse_files / list_directory on a file keep short messages', async () => {
    writeFileSync(join(tmp, 'afile.txt'), 'x')
    await ops.browseFiles(ws, 'afile.txt/sub', tmp)
    if (!IS_WIN) assert.equal(sent[0].error, 'Not a directory')
    assertNoServerPaths(sent[0].error, 'browse_files')
  })

  it('memory stack for a missing session directory carries no server path', async () => {
    await ops.readMemory(ws, join(tmp, 'gone'))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'memory_stack_result')
    assert.ok(sent[0].error, 'a missing cwd must fail')
    assertNoServerPaths(sent[0].error, 'memory_stack cwd')
  })

  it('memory file stat through a file-as-directory carries no server path (ENOTDIR)', async () => {
    writeFileSync(join(tmp, 'present.txt'), 'x')
    const res = await readResolvedMemoryFile(join(tmp, 'present.txt', 'CLAUDE.md'))
    if (IS_WIN) {
      // ENOENT on Windows: the reader treats it as a missing file, no error.
      if (res.error !== undefined) assertNoServerPaths(res.error, 'memory stat')
    } else {
      assert.equal(res.error, 'Not a directory')
      assertNoServerPaths(res.error, 'memory stat')
    }
  })

  it('memory file open failure keeps "Permission denied" (EACCES)', { skip: POSIX_PERM_SKIP }, async () => {
    writeFileSync(join(tmp, 'locked.txt'), 'secret')
    chmodSync(join(tmp, 'locked.txt'), 0o000)
    const res = await readResolvedMemoryFile(join(tmp, 'locked.txt'))
    assert.equal(res.error, 'Permission denied')
    assertNoServerPaths(res.error, 'memory open')
  })

  describe('git', () => {
    beforeEach(() => {
      execFileSync(GIT, ['init', '-q'], { cwd: tmp })
    })

    it('git_stage of a pathspec git rejects carries no git binary or temp path', async () => {
      await ops.gitStage(ws, ['missing.txt'], tmp)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'git_stage_result')
      assert.ok(sent[0].error, 'staging a missing file must fail')
      assertNoServerPaths(sent[0].error, 'git_stage')
    })

    it('git_unstage failure (index.lock held) carries no git binary or temp path', async () => {
      writeFileSync(join(tmp, 'tracked.txt'), 'x')
      execFileSync(GIT, ['add', 'tracked.txt'], { cwd: tmp })
      execFileSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: tmp })
      writeFileSync(join(tmp, '.git', 'index.lock'), '')
      await ops.gitUnstage(ws, ['tracked.txt'], tmp)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'git_unstage_result')
      assert.ok(sent[0].error, 'a held index.lock must fail the unstage')
      assertNoServerPaths(sent[0].error, 'git_unstage')
    })

    it('git_stage failure (index.lock held) carries no git binary or temp path', async () => {
      writeFileSync(join(tmp, 'a.txt'), 'x')
      writeFileSync(join(tmp, '.git', 'index.lock'), '')
      await ops.gitStage(ws, ['a.txt'], tmp)
      assert.equal(sent.length, 1)
      assert.ok(sent[0].error, 'a held index.lock must fail the stage')
      assertNoServerPaths(sent[0].error, 'git_stage lock')
    })
  })
})

describe('fileOpErrorMessage (#8018)', () => {
  it('maps the codes a post-containment stage produces to short text', () => {
    const cases = {
      EISDIR: 'Is a directory',
      ENOTDIR: 'Not a directory',
      EEXIST: 'Already exists',
      ENOSPC: 'No space left on device',
      EROFS: 'Read-only file system',
      EBUSY: 'Resource busy',
      EPERM: 'Operation not permitted',
      EACCES: 'Permission denied',
      ENOENT: 'Not found',
    }
    for (const [code, text] of Object.entries(cases)) {
      assert.equal(fileOpErrorMessage(Object.assign(new Error(`${code}: boom, open '/srv/secret/x'`), { code })), text)
    }
  })

  it('never falls back to err.message', () => {
    const leaky = Object.assign(new Error("EWEIRD: nope, open '/Users/someone/x'"), { code: 'EWEIRD' })
    assert.equal(fileOpErrorMessage(leaky), 'Operation failed')
    assert.equal(fileOpErrorMessage(new Error('/Users/someone/x'), 'Failed to stage files'), 'Failed to stage files')
    assert.equal(fileOpErrorMessage(Object.assign(new Error('x'), { code: 128 })), 'Operation failed')
    assert.equal(fileOpErrorMessage(null), 'Operation failed')
  })

  it('honours handler overrides, including over the shared table', () => {
    const err = Object.assign(new Error('x'), { code: 'ENOENT' })
    assert.equal(fileOpErrorMessage(err, 'Operation failed', { ENOENT: 'File not found' }), 'File not found')
  })

  it('passes a clientSafeError message through, whatever its code', () => {
    const err = clientSafeError('Access denied: restricted to the workspace directory', { code: 'EACCES' })
    assert.equal(fileOpErrorMessage(err), 'Access denied: restricted to the workspace directory')
    // An ordinary error that merely CLAIMS to be safe by message is not.
    assert.equal(fileOpErrorMessage(Object.assign(new Error('Access denied: x'), { code: 'EACCES' })), 'Permission denied')
  })

  it('a hand-set or copied clientSafe marker does not pass the message through', () => {
    const handSet = Object.assign(new Error("EISDIR: x, open '/srv/secret'"), { code: 'EISDIR', clientSafe: true })
    assert.equal(fileOpErrorMessage(handSet), 'Is a directory')
    const marked = clientSafeError('Fixed text', { code: 'EACCES' })
    const copied = Object.assign(new Error("EACCES: x, open '/srv/secret'"), marked)
    assert.equal(fileOpErrorMessage(copied), 'Permission denied')
    const spread = Object.assign(new Error('/srv/secret'), { ...marked, code: 'EWEIRD' })
    assert.equal(fileOpErrorMessage(spread), 'Operation failed')
    assert.equal(fileOpErrorMessage(marked), 'Fixed text')
  })

  it('does not read inherited keys as codes', () => {
    const err = Object.assign(new Error('x'), { code: 'constructor' })
    assert.equal(fileOpErrorMessage(err), 'Operation failed')
  })
})
