import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../../src/ws-file-ops.js'

describe('security: path traversal', () => {
  let tmpDir
  let fileOps
  const responses = []
  const mockSend = (_ws, msg) => responses.push(msg)
  const mockWs = {}

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-sec-path-'))
    fileOps = createFileOps(mockSend)
    // Create test fixtures
    await mkdir(join(tmpDir, 'safe'), { recursive: true })
    await writeFile(join(tmpDir, 'safe', 'file.txt'), 'safe content')
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('dot-dot traversal variants', () => {
    const traversalPaths = [
      '../../../etc/passwd',
      'safe/../../etc/passwd',
      'safe/../../../etc/passwd',
      './../../../etc/passwd',
      'safe/./../../etc/passwd',
    ]

    for (const path of traversalPaths) {
      it(`blocks: ${path}`, async () => {
        responses.length = 0
        await fileOps.writeFile(mockWs, path, 'pwned', tmpDir)
        assert.equal(responses.length, 1)
        assert.ok(responses[0].error, `Expected error for path: ${path}`)
      })
    }
  })

  describe('unicode normalization attacks', () => {
    it('blocks unicode dot-dot (\\u002e\\u002e resolves to literal ../..)', async () => {
      // \u002e is '.', so this resolves to 'safe/../../etc/passwd' — a real traversal
      responses.length = 0
      await fileOps.writeFile(mockWs, 'safe/\u002e\u002e/\u002e\u002e/etc/passwd', 'pwned', tmpDir)
      assert.equal(responses.length, 1)
      assert.ok(responses[0].error, 'Expected error for unicode dot-dot traversal')
    })

    it('treats percent-encoded dots as literal filename characters', async () => {
      // '%2e%2e' is a literal string — Node does NOT decode it, so it creates
      // a directory literally named '%2e%2e' inside CWD. This is safe behavior.
      responses.length = 0
      await fileOps.writeFile(mockWs, 'safe/%2e%2e/file.txt', 'content', tmpDir)
      assert.equal(responses.length, 1)
      // No error — file created safely within CWD
      assert.equal(responses[0].error, null)
    })
  })

  describe('symlink escape prevention', () => {
    let outsideDir

    before(async () => {
      outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-'))
      await writeFile(join(outsideDir, 'secret.txt'), 'secret data')
      // Create symlink inside tmpDir pointing outside
      await symlink(outsideDir, join(tmpDir, 'escape-link'))
    })

    after(async () => {
      await rm(outsideDir, { recursive: true, force: true })
    })

    it('blocks read through symlink pointing outside CWD', async () => {
      responses.length = 0
      await fileOps.readFile(mockWs, 'escape-link/secret.txt', tmpDir)
      assert.equal(responses.length, 1)
      // readFile resolves symlinks via realpath, detects escape
      assert.ok(responses[0].error, 'Expected error for symlink escape read')
    })

    it('blocks write to existing file through symlink outside CWD', async () => {
      // Write a file outside CWD through the symlink first (to make it exist)
      // Then try to overwrite via the symlink — realpath will resolve it
      responses.length = 0
      await fileOps.writeFile(mockWs, 'escape-link/secret.txt', 'overwritten', tmpDir)
      assert.equal(responses.length, 1)
      // The file exists → realpath resolves to outsideDir → blocked
      assert.ok(responses[0].error, 'Expected error for symlink escape write to existing file')
    })
  })

  describe('double-encoding attempts', () => {
    it('blocks double-encoded dot-dot (%252e%252e)', async () => {
      responses.length = 0
      // This is a literal string "%252e%252e" — Node resolve won't decode it,
      // but we verify it doesn't bypass validation
      await fileOps.writeFile(mockWs, 'safe/%252e%252e/%252e%252e/etc/passwd', 'pwned', tmpDir)
      assert.equal(responses.length, 1)
      // Either it errors (good) or the file stays within tmpDir (also safe)
      if (responses[0].error === null) {
        // If no error, verify the file was created inside tmpDir
        const { readFile: rf } = await import('fs/promises')
        const written = join(tmpDir, 'safe/%252e%252e/%252e%252e/etc/passwd')
        const content = await rf(written, 'utf-8')
        assert.equal(content, 'pwned')
      }
    })
  })

  describe('null byte injection', () => {
    it('handles null bytes in path gracefully', async () => {
      responses.length = 0
      await fileOps.writeFile(mockWs, 'safe/file\x00.txt', 'pwned', tmpDir)
      assert.equal(responses.length, 1)
      // Should error or create within CWD — either is acceptable
    })
  })

  describe('absolute path outside CWD', () => {
    it('blocks /etc/passwd', async () => {
      responses.length = 0
      await fileOps.writeFile(mockWs, '/etc/passwd', 'pwned', tmpDir)
      assert.equal(responses.length, 1)
      assert.ok(responses[0].error)
    })

    it('blocks /tmp/evil.txt', async () => {
      responses.length = 0
      await fileOps.writeFile(mockWs, '/tmp/evil.txt', 'pwned', tmpDir)
      assert.equal(responses.length, 1)
      assert.ok(responses[0].error)
    })

    it('blocks home directory escape via readFile', async () => {
      responses.length = 0
      await fileOps.readFile(mockWs, '/etc/hosts', tmpDir)
      assert.equal(responses.length, 1)
      assert.ok(responses[0].error)
    })
  })
})
