/**
 * Tests for file_ref attachment handling — server reads file content
 * from project tree and converts to standard attachment format.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateAttachments } from '../src/ws-message-handlers.js'

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
})
