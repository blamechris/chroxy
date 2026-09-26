import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'fs/promises'
import { openSync, closeSync, constants as fsConstants } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'

/**
 * Open-and-close a non-blocking READER on `fifo`. A no-op when nothing is
 * waiting; if a regression ever lets a write-open block on the FIFO, this
 * releases the stranded threadpool thread so the run fails on its assertion
 * instead of hanging at exit.
 */
function releaseBlockedWriter(fifo) {
  try { closeSync(openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)) } catch { /* nothing to release */ }
}

describe('writeFile handler', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-write-'))
    fileOps = createFileOps(mockSend)
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a file successfully', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, 'hello.txt', 'Hello, World!', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'write_file_result')
    assert.equal(responses[0].error, null)

    const content = await readFile(join(tmpDir, 'hello.txt'), 'utf-8')
    assert.equal(content, 'Hello, World!')
  })

  it('writes to a subdirectory', async () => {
    responses.length = 0
    await mkdir(join(tmpDir, 'subdir'), { recursive: true })
    await fileOps.writeFile(mockWs, 'subdir/nested.txt', 'nested content', tmpDir)

    assert.equal(responses[0].error, null)
    const content = await readFile(join(tmpDir, 'subdir/nested.txt'), 'utf-8')
    assert.equal(content, 'nested content')
  })

  it('blocks path traversal with ../', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, '../../../etc/passwd', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].type, 'write_file_result')
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /denied|restricted|traversal/i)
  })

  it('blocks absolute paths outside session CWD', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, '/tmp/evil.txt', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })

  it('rejects empty path', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, '', 'content', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /path/i)
  })

  it('rejects content exceeding 5MB', async () => {
    responses.length = 0
    const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1)
    await fileOps.writeFile(mockWs, 'big.txt', bigContent, tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /large|size|limit/i)
  })

  it('returns error when no session CWD', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, 'test.txt', 'content', null)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
  })

  it('creates parent directories if needed', async () => {
    responses.length = 0
    await fileOps.writeFile(mockWs, 'new/deep/dir/file.txt', 'deep content', tmpDir)

    assert.equal(responses[0].error, null)
    const content = await readFile(join(tmpDir, 'new/deep/dir/file.txt'), 'utf-8')
    assert.equal(content, 'deep content')
  })

  it('blocks writing through a symlink that points outside CWD', async () => {
    responses.length = 0
    // Create a symlink inside tmpDir that points to /tmp (outside CWD)
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-'))
    const escapePath = join(tmpDir, 'escape-link.txt')
    const outsideFile = join(outsideDir, 'target.txt')
    await writeFile(outsideFile, 'original', 'utf-8')
    await symlink(outsideFile, escapePath)

    await fileOps.writeFile(mockWs, 'escape-link.txt', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /denied|restricted/i)

    // Verify the target file was NOT modified
    const targetContent = await readFile(outsideFile, 'utf-8')
    assert.equal(targetContent, 'original')

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('allows writing through a symlink that resolves within CWD', async () => {
    responses.length = 0
    // Internal symlink: points to a file within CWD — realpath resolves it,
    // validation passes, and the symlink-refusing open (openNoFollow) writes
    // to the RESOLVED real file, which is not itself a symlink.
    const realFile = join(tmpDir, 'real-target.txt')
    await writeFile(realFile, 'real content', 'utf-8')
    const linkPath = join(tmpDir, 'internal-link.txt')
    await symlink(realFile, linkPath)

    await fileOps.writeFile(mockWs, 'internal-link.txt', 'via symlink', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].error, null)
    // Content was written to the real file (resolved through realpath)
    const content = await readFile(realFile, 'utf-8')
    assert.equal(content, 'via symlink')
  })

  it('overwrites an existing file successfully', async () => {
    responses.length = 0
    await writeFile(join(tmpDir, 'overwrite-me.txt'), 'old content', 'utf-8')
    await fileOps.writeFile(mockWs, 'overwrite-me.txt', 'new content', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].error, null)
    const content = await readFile(join(tmpDir, 'overwrite-me.txt'), 'utf-8')
    assert.equal(content, 'new content')
  })

  it('blocks new-file write through a PARENT directory symlink pointing outside CWD (2026-04-11 audit blocker 4)', async () => {
    // Pre-audit: the symlink-refusing open checks only the FINAL path
    // component (true of O_NOFOLLOW on POSIX and of the win32 lstat +
    // fd-identity emulation added in #7280 alike).
    // `validatePathWithinCwd` fell back to the lexical path on ENOENT for
    // a non-existent target, so it never noticed that a PARENT of the new
    // file was a symlink escaping the workspace. Creating a new file like
    // `.venv/bin/evil.sh` where `.venv` → `/etc` would succeed: ENOENT on
    // evil.sh, lexical path still starts with the workspace prefix, and
    // the open() call follows the `.venv` symlink to `/etc`.
    //
    // The fix walks up to the deepest existing ancestor and realpath()s it
    // (see realpathOfDeepestAncestor in ws-file-ops/common.js), which
    // resolves the parent symlink and reveals the escape.
    responses.length = 0
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-parent-'))
    // Create a symlink INSIDE tmpDir that points to outsideDir (escaping)
    const parentLink = join(tmpDir, 'escape-parent')
    await symlink(outsideDir, parentLink)

    // Try to create a NEW file THROUGH the parent symlink
    await fileOps.writeFile(mockWs, 'escape-parent/new-evil.sh', '#!/bin/sh\necho pwned\n', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error, 'new-file write through symlinked parent must be rejected')
    assert.match(responses[0].error, /denied|restricted/i)

    // Verify the target file was NOT created outside the workspace
    let createdOutside = null
    try {
      createdOutside = await readFile(join(outsideDir, 'new-evil.sh'), 'utf-8')
    } catch {
      // expected — the file should not exist
    }
    assert.equal(createdOutside, null,
      'file must not have been created in the symlink-escape target directory')

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('blocks new-file write through a deep symlinked-parent path escaping CWD', async () => {
    // Variant: real intermediate directories exist on the other side of
    // the symlink, so the deepest-existing-ancestor walk resolves on the
    // first iteration (through the `a` symlink) rather than recursing
    // through multiple non-existent ancestors. Exercises the case where
    // the full path up to the leaf already exists on disk on the other
    // side of the escape link.
    responses.length = 0
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-chain-'))
    const escapeLink = join(tmpDir, 'a')
    await symlink(outsideDir, escapeLink)
    // Inside the (resolved) outside directory, create a real subdir so
    // the middle of the lexical path exists on disk
    await mkdir(join(outsideDir, 'b', 'c'), { recursive: true })

    // Try to create a new file at `a/b/c/evil.sh` — lexical path looks
    // like it's inside tmpDir, but `a` is actually a symlink to outsideDir
    await fileOps.writeFile(mockWs, 'a/b/c/evil.sh', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error)
    assert.match(responses[0].error, /denied|restricted/i)

    let created = null
    try {
      created = await readFile(join(outsideDir, 'b', 'c', 'evil.sh'), 'utf-8')
    } catch {}
    assert.equal(created, null, 'file must not have been created through the multi-level symlink chain')

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('exercises the recursive ancestor walk — leaf AND multiple tail dirs do not exist', async () => {
    // Stronger multi-level test: pushing multiple tail segments onto
    // the walker's `segments` array. `escape` is a symlink escaping
    // the workspace. The walker must realpath `escape`, then
    // reconstruct the target by appending the non-existent tail
    // components `future1/future2/leaf.sh`. This exercises both the
    // segment-push order and the reverse-and-join rebuild.
    responses.length = 0
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-deepwalk-'))
    const escapeLink = join(tmpDir, 'escape')
    await symlink(outsideDir, escapeLink)
    // Do NOT create future1/future2 — they must not exist, forcing
    // the walker to push three ENOENT segments before reaching `escape`.

    await fileOps.writeFile(mockWs, 'escape/future1/future2/leaf.sh', 'pwned', tmpDir)

    assert.equal(responses.length, 1)
    assert.ok(responses[0].error, 'deep non-existent tail through escape symlink must still be rejected')
    assert.match(responses[0].error, /denied|restricted/i)

    // Also verify the expected real target does not exist
    let created = null
    try {
      created = await readFile(join(outsideDir, 'future1', 'future2', 'leaf.sh'), 'utf-8')
    } catch {}
    assert.equal(created, null)

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('allows new-file write through a PARENT symlink that resolves within CWD', async () => {
    // Positive case: internal symlink-as-parent pointing to another
    // directory inside the workspace. The realpathOfDeepestAncestor walk
    // resolves to a path inside cwdReal, so the write is permitted and
    // lands at the real target (via the symlink).
    responses.length = 0
    const realDir = join(tmpDir, 'real-subdir')
    await mkdir(realDir, { recursive: true })
    const internalLink = join(tmpDir, 'link-to-subdir')
    await symlink(realDir, internalLink)

    await fileOps.writeFile(mockWs, 'link-to-subdir/legitimate.txt', 'ok content', tmpDir)

    assert.equal(responses.length, 1)
    assert.equal(responses[0].error, null, 'internal parent symlink must not be blocked')
    const content = await readFile(join(realDir, 'legitimate.txt'), 'utf-8')
    assert.equal(content, 'ok content')
  })

  // #7938 — openNoFollow ORs O_NONBLOCK into WRITE opens as well. A FIFO with
  // no reader now fails the open with ENXIO instead of blocking it forever
  // waiting for one (the behaviour before #7938); this pins that write_file
  // turns that into a prompt error response.
  it('write_file to a planted FIFO returns an error promptly instead of hanging (#7938)', { skip: process.platform === 'win32' ? 'no mkfifo on win32' : false }, async () => {
    responses.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'chroxy-write-fifo-'))
    const fifo = join(dir, 'evil.fifo')
    execFileSync('mkfifo', [fifo])
    try {
      const outcome = await Promise.race([
        fileOps.writeFile(mockWs, 'evil.fifo', 'data', dir).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
      ])
      assert.equal(outcome, 'returned', 'write_file blocked opening a FIFO with no reader — openNoFollow needs O_NONBLOCK (#7938)')
      assert.equal(responses.length, 1)
      assert.equal(responses[0].type, 'write_file_result')
      assert.ok(responses[0].error, 'a FIFO target must produce an error, not a successful write')
    } finally {
      releaseBlockedWriter(fifo)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
