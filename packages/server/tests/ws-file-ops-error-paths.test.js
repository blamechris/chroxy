import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'

describe('ws-file-ops error paths', () => {
  let tmp
  let sent
  const ws = {}
  let ops

  beforeEach(() => {
    // Use realpathSync to resolve macOS /var -> /private/var symlink
    // so path-within-CWD checks work correctly
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fileops-err-')))
    sent = []
    ops = createFileOps((_, msg) => sent.push(msg))
  })

  afterEach(() => {
    try { chmodSync(join(tmp, 'noperm'), 0o755) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  })

  it('browseFiles returns Permission denied for EACCES', async () => {
    const noRead = join(tmp, 'noperm')
    mkdirSync(noRead)
    chmodSync(noRead, 0o000)

    await ops.browseFiles(ws, 'noperm', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_listing')
    assert.equal(sent[0].error, 'Permission denied')
    assert.deepEqual(sent[0].entries, [])
  })

  it('browseFiles returns Not a directory for ENOTDIR', async () => {
    const filePath = join(tmp, 'afile.txt')
    writeFileSync(filePath, 'hello')

    await ops.browseFiles(ws, 'afile.txt/subdir', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_listing')
    assert.equal(sent[0].error, 'Not a directory')
  })

  it('readFile returns File not found for nonexistent path', async () => {
    await ops.readFile(ws, 'does-not-exist.txt', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.equal(sent[0].error, 'File not found')
    assert.equal(sent[0].content, null)
  })

  it('readFile rejects path traversal outside session CWD', async () => {
    // Use an absolute path to a real file outside the workspace so that
    // realpath() succeeds but the path-within-CWD check still fires.
    await ops.readFile(ws, '/etc/passwd', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.match(sent[0].error, /Access denied/)
    assert.equal(sent[0].content, null)
  })

  it('writeFile rejects path traversal outside session CWD', async () => {
    await ops.writeFile(ws, '../../../tmp/evil.txt', 'pwned', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'write_file_result')
    assert.match(sent[0].error, /Access denied/)
  })

  it('readFile reads a valid file within the workspace root', async () => {
    const filePath = join(tmp, 'hello.txt')
    writeFileSync(filePath, 'hello world')

    await ops.readFile(ws, 'hello.txt', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.equal(sent[0].error, null)
    assert.equal(sent[0].content, 'hello world')
  })

  it('readFile rejects a symlink pointing outside the workspace root', async () => {
    // Create a file outside the workspace
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'fileops-outside-')))
    const outsideFile = join(outsideDir, 'secret.txt')
    writeFileSync(outsideFile, 'secret contents')

    // Create a symlink inside the workspace pointing to the outside file
    const symlinkPath = join(tmp, 'escape.txt')
    symlinkSync(outsideFile, symlinkPath)

    try {
      await ops.readFile(ws, 'escape.txt', tmp)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'file_content')
      assert.match(sent[0].error, /Access denied/)
      assert.equal(sent[0].content, null)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('readFile returns File not found for a dangling symlink', async () => {
    // Create a symlink pointing to a nonexistent target
    const symlinkPath = join(tmp, 'dangling.txt')
    symlinkSync(join(tmp, 'nonexistent-target.txt'), symlinkPath)

    await ops.readFile(ws, 'dangling.txt', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.equal(sent[0].error, 'File not found')
    assert.equal(sent[0].content, null)
  })

  it('readFile returns Access denied for a nonexistent path outside the workspace root', async () => {
    // A nonexistent outside-root path must not leak existence information —
    // it should return Access denied, not File not found.
    await ops.readFile(ws, '/etc/this-file-does-not-exist-xyzzy', tmp)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'file_content')
    assert.match(sent[0].error, /Access denied/)
    assert.equal(sent[0].content, null)
  })
})
