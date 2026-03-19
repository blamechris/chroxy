import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'

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
})
