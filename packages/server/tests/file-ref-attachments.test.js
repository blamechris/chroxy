/**
 * Tests for file_ref attachment handling — server reads file content
 * from project tree and converts to standard attachment format.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateAttachments, resolveFileRefAttachments } from '../src/ws-message-handlers.js'

// Create a temp dir for test files
let testDir

before(() => {
  testDir = mkdtempSync(join(tmpdir(), 'chroxy-fileref-'))
  mkdirSync(join(testDir, 'src'), { recursive: true })
  writeFileSync(join(testDir, 'src', 'hello.ts'), 'export const hello = "world"\n')
  writeFileSync(join(testDir, 'readme.md'), '# Test Project\n')
})

after(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('validateAttachments with file_ref', () => {
  it('accepts file_ref type with path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/hello.ts', name: 'hello.ts' }
    ])
    assert.strictEqual(err, null)
  })

  it('rejects file_ref without path', () => {
    const err = validateAttachments([
      { type: 'file_ref', name: 'hello.ts' }
    ])
    assert.ok(err)
    assert.match(err, /path/)
  })

  it('rejects file_ref with non-string path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 123, name: 'hello.ts' }
    ])
    assert.ok(err)
  })

  it('rejects path traversal attempts', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '../../../etc/passwd', name: 'passwd' }
    ])
    assert.ok(err)
    assert.match(err, /traversal/)
  })

  it('rejects absolute paths', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '/etc/passwd', name: 'passwd' }
    ])
    assert.ok(err)
    assert.match(err, /absolute/)
  })

  it('allows mixed file_ref and standard attachments', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/hello.ts', name: 'hello.ts' },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'screenshot.png' }
    ])
    assert.strictEqual(err, null)
  })

  it('allows paths with double-dot filenames (not traversal)', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/foo..bar.ts', name: 'foo..bar.ts' }
    ])
    assert.strictEqual(err, null)
  })
})

describe('resolveFileRefAttachments', () => {
  it('reads file content and returns base64 document', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'src/hello.ts', name: 'hello.ts' }],
      testDir
    )
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].type, 'document')
    assert.strictEqual(result[0].mediaType, 'text/plain')
    assert.strictEqual(result[0].name, 'hello.ts')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.strictEqual(decoded, 'export const hello = "world"\n')
  })

  it('returns error document for file not found', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'nonexistent.ts' }],
      testDir
    )
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /file not found/)
  })

  it('returns error document for file exceeding 1MB limit', () => {
    const bigPath = join(testDir, 'big.txt')
    writeFileSync(bigPath, Buffer.alloc(1.5 * 1024 * 1024, 'x'))
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'big.txt', name: 'big.txt' }],
      testDir
    )
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /too large/)
  })

  it('returns error for symlink escaping project directory', () => {
    const linkPath = join(testDir, 'src', 'escape-link')
    try { symlinkSync('/etc/hosts', linkPath) } catch { return }
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'src/escape-link' }],
      testDir
    )
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /cannot read file outside project/)
  })

  it('passes through non-file_ref attachments unchanged', () => {
    const img = { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' }
    const result = resolveFileRefAttachments([img], testDir)
    assert.deepStrictEqual(result[0], img)
  })

  it('returns original array when cwd is null', () => {
    const atts = [{ type: 'file_ref', path: 'src/hello.ts' }]
    const result = resolveFileRefAttachments(atts, null)
    assert.deepStrictEqual(result, atts)
  })

  it('returns original array when attachments is empty', () => {
    const result = resolveFileRefAttachments([], testDir)
    assert.deepStrictEqual(result, [])
  })

  it('returns error document for binary files', () => {
    const binPath = join(testDir, 'image.png')
    // Write binary content with null bytes
    const buf = Buffer.alloc(256)
    buf[0] = 0x89 // PNG magic
    buf[1] = 0x50
    buf[2] = 0x4e
    buf[3] = 0x47
    buf[10] = 0x00 // null byte
    buf[20] = 0x00
    writeFileSync(binPath, buf)
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'image.png', name: 'image.png' }],
      testDir
    )
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /binary/)
  })

  it('uses att.path as fallback name when att.name is missing', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'readme.md' }],
      testDir
    )
    assert.strictEqual(result[0].name, 'readme.md')
  })
})
