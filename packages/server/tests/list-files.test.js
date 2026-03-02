import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops.js'

describe('listFiles', () => {
  let tmpDir
  let fileOps
  let sent

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'list-files-'))
    sent = []
    const sendFn = (_ws, msg) => sent.push(msg)
    fileOps = createFileOps(sendFn)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns files from session CWD', async () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Hello')
    writeFileSync(join(tmpDir, 'index.js'), 'console.log("hi")')

    await fileOps.listFiles({}, tmpDir, null)

    assert.equal(sent.length, 1)
    const msg = sent[0]
    assert.equal(msg.type, 'file_list')
    assert.ok(Array.isArray(msg.files))
    const names = msg.files.map(f => f.path)
    assert.ok(names.includes('README.md'))
    assert.ok(names.includes('index.js'))
  })

  it('walks directories recursively up to max depth', async () => {
    mkdirSync(join(tmpDir, 'src'))
    mkdirSync(join(tmpDir, 'src', 'utils'))
    writeFileSync(join(tmpDir, 'src', 'app.js'), '')
    writeFileSync(join(tmpDir, 'src', 'utils', 'helper.js'), '')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const paths = msg.files.map(f => f.path)
    assert.ok(paths.includes('src/app.js'))
    assert.ok(paths.includes('src/utils/helper.js'))
  })

  it('respects max depth limit', async () => {
    // Create depth 4 nesting: a/b/c/d/deep.txt
    mkdirSync(join(tmpDir, 'a'))
    mkdirSync(join(tmpDir, 'a', 'b'))
    mkdirSync(join(tmpDir, 'a', 'b', 'c'))
    mkdirSync(join(tmpDir, 'a', 'b', 'c', 'd'))
    writeFileSync(join(tmpDir, 'a', 'b', 'c', 'd', 'deep.txt'), '')
    writeFileSync(join(tmpDir, 'a', 'b', 'c', 'shallow.txt'), '')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const paths = msg.files.map(f => f.path)
    // depth 3 (a/b/c/shallow.txt) should be included
    assert.ok(paths.includes('a/b/c/shallow.txt'))
    // depth 4 (a/b/c/d/deep.txt) should NOT be included
    assert.ok(!paths.includes('a/b/c/d/deep.txt'))
  })

  it('skips hidden files and directories', async () => {
    writeFileSync(join(tmpDir, '.env'), 'SECRET=x')
    mkdirSync(join(tmpDir, '.git'))
    writeFileSync(join(tmpDir, '.git', 'config'), '')
    writeFileSync(join(tmpDir, 'visible.js'), '')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const paths = msg.files.map(f => f.path)
    assert.ok(!paths.some(p => p.includes('.env')))
    assert.ok(!paths.some(p => p.includes('.git')))
    assert.ok(paths.includes('visible.js'))
  })

  it('skips node_modules', async () => {
    mkdirSync(join(tmpDir, 'node_modules'))
    mkdirSync(join(tmpDir, 'node_modules', 'express'))
    writeFileSync(join(tmpDir, 'node_modules', 'express', 'index.js'), '')
    writeFileSync(join(tmpDir, 'app.js'), '')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const paths = msg.files.map(f => f.path)
    assert.ok(!paths.some(p => p.includes('node_modules')))
    assert.ok(paths.includes('app.js'))
  })

  it('respects .gitignore patterns', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'dist/\n*.log\n')
    mkdirSync(join(tmpDir, 'dist'))
    writeFileSync(join(tmpDir, 'dist', 'bundle.js'), '')
    writeFileSync(join(tmpDir, 'error.log'), '')
    writeFileSync(join(tmpDir, 'app.js'), '')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const paths = msg.files.map(f => f.path)
    assert.ok(!paths.some(p => p.includes('dist')))
    assert.ok(!paths.some(p => p.includes('error.log')))
    assert.ok(paths.includes('app.js'))
  })

  it('filters by query param (substring match)', async () => {
    writeFileSync(join(tmpDir, 'README.md'), '')
    writeFileSync(join(tmpDir, 'index.js'), '')
    writeFileSync(join(tmpDir, 'utils.js'), '')

    await fileOps.listFiles({}, tmpDir, 'index')

    const msg = sent[0]
    assert.equal(msg.files.length, 1)
    assert.equal(msg.files[0].path, 'index.js')
  })

  it('query filter is case-insensitive', async () => {
    writeFileSync(join(tmpDir, 'README.md'), '')
    writeFileSync(join(tmpDir, 'index.js'), '')

    await fileOps.listFiles({}, tmpDir, 'readme')

    const msg = sent[0]
    assert.equal(msg.files.length, 1)
    assert.equal(msg.files[0].path, 'README.md')
  })

  it('returns file metadata (path, type, size)', async () => {
    mkdirSync(join(tmpDir, 'src'))
    writeFileSync(join(tmpDir, 'hello.txt'), 'hello world')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const file = msg.files.find(f => f.path === 'hello.txt')
    assert.ok(file)
    assert.equal(file.type, 'file')
    assert.equal(file.size, 11) // 'hello world'.length
  })

  it('returns error when session CWD is null', async () => {
    await fileOps.listFiles({}, null, null)

    const msg = sent[0]
    assert.equal(msg.type, 'file_list')
    assert.deepEqual(msg.files, [])
    assert.ok(msg.error)
  })

  it('returns empty list for empty directory', async () => {
    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    assert.equal(msg.type, 'file_list')
    assert.deepEqual(msg.files, [])
    assert.equal(msg.error, null)
  })

  it('sorts files alphabetically by path', async () => {
    writeFileSync(join(tmpDir, 'zebra.js'), '')
    writeFileSync(join(tmpDir, 'alpha.js'), '')
    mkdirSync(join(tmpDir, 'mid'))
    writeFileSync(join(tmpDir, 'mid', 'beta.js'), '')

    await fileOps.listFiles({}, tmpDir, null)

    const msg = sent[0]
    const paths = msg.files.map(f => f.path)
    const sorted = [...paths].sort()
    assert.deepEqual(paths, sorted)
  })

  it('includes sessionId in response when provided', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), '')

    await fileOps.listFiles({}, tmpDir, null, 'session-123')

    const msg = sent[0]
    assert.equal(msg.sessionId, 'session-123')
  })
})
