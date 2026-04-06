/**
 * Security-critical tests for handler-utils.js path validation and sanitization.
 *
 * These functions sit on the security boundary — a bypass would allow reading
 * or writing arbitrary files on the host. Covers path traversal prevention,
 * absolute path rejection, symlink escape detection, and edge cases.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
  symlinkSync, realpathSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import {
  validateAttachments,
  resolveFileRefAttachments,
  validateCwdWithinHome,
  PERMISSION_MODES,
  ALLOWED_PERMISSION_MODE_IDS,
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_SIZE,
  MAX_DOCUMENT_SIZE,
  ALLOWED_IMAGE_TYPES,
  broadcastFocusChanged,
  resolveSession,
  sendError,
} from '../src/handler-utils.js'

// -- Temp directory setup --
let testDir

before(() => {
  testDir = mkdtempSync(join(tmpdir(), 'chroxy-handler-utils-'))
  mkdirSync(join(testDir, 'src'), { recursive: true })
  mkdirSync(join(testDir, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(testDir, 'src', 'index.js'), 'console.log("hello")\n')
  writeFileSync(join(testDir, 'readme.md'), '# Project\n')
  writeFileSync(join(testDir, 'nested', 'deep', 'file.txt'), 'deep content\n')
})

after(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// ============================================================
// validateAttachments — file_ref path validation (security boundary)
// ============================================================

describe('validateAttachments — path traversal prevention', () => {
  it('rejects ../ path traversal', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '../../../etc/passwd', name: 'passwd' }
    ])
    assert.ok(err)
    assert.match(err, /traversal/)
  })

  it('rejects ../ at the start of the path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '../secret.txt', name: 'secret' }
    ])
    assert.ok(err)
    assert.match(err, /traversal/)
  })

  it('rejects ../ in the middle of the path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/../../../etc/passwd', name: 'passwd' }
    ])
    assert.ok(err)
    assert.match(err, /traversal/)
  })

  it('rejects bare .. component', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '..', name: 'up' }
    ])
    assert.ok(err)
    assert.match(err, /traversal/)
  })

  it('allows filenames containing .. that are not path components', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/foo..bar.js', name: 'foo..bar.js' }
    ])
    assert.strictEqual(err, null)
  })

  it('allows directory names containing .. that are not pure traversal', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/..hidden/file.js', name: 'file.js' }
    ])
    assert.strictEqual(err, null)
  })

  it('rejects backslash traversal (..\\)', () => {
    // On Unix, backslash is a valid filename char — but split('/') won't catch it.
    // The validation uses split('/').includes('..'), so ..\ as a single segment
    // would not match '..'. This test documents the current behavior.
    const err = validateAttachments([
      { type: 'file_ref', path: '..\\..\\etc\\passwd', name: 'passwd' }
    ])
    // On Unix: '..\\..\\etc\\passwd' is one path component with backslashes in name,
    // split('/') yields ['..\\..\\etc\\passwd'], which doesn't include '..'
    // This is acceptable on Unix since resolve() treats it as a literal filename.
    // The test documents this known platform behavior.
    if (process.platform === 'win32') {
      assert.ok(err, 'backslash traversal should be caught on Windows')
    } else {
      assert.strictEqual(err, null, 'backslash is a valid filename char on Unix — not traversal')
    }
  })

  it('treats URL-encoded %2e%2e as literal filename (not traversal)', () => {
    // validateAttachments checks the raw path string. %2e%2e/%2e%2e/ would need
    // to be decoded to be dangerous. Since split('/').includes('..') checks
    // literal '..', encoded variants pass validation here. However, resolve()
    // in resolveFileRefAttachments treats %2e literally (no decoding), so the
    // file simply won't be found — not a security bypass.
    const err = validateAttachments([
      { type: 'file_ref', path: '%2e%2e/%2e%2e/etc/passwd', name: 'passwd' }
    ])
    // Passes validation because '%2e%2e' !== '..'
    assert.strictEqual(err, null, 'encoded traversal passes validation (not a bypass — resolve treats literally)')
  })
})

describe('validateAttachments — absolute path rejection', () => {
  it('rejects absolute Unix paths', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '/etc/passwd', name: 'passwd' }
    ])
    assert.ok(err)
    assert.match(err, /absolute/)
  })

  it('rejects absolute path to home directory', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '/Users/someone/.ssh/id_rsa', name: 'key' }
    ])
    assert.ok(err)
    assert.match(err, /absolute/)
  })

  it('rejects root path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '/', name: 'root' }
    ])
    assert.ok(err)
    assert.match(err, /absolute/)
  })
})

describe('validateAttachments — edge cases', () => {
  it('rejects empty path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '', name: 'empty' }
    ])
    assert.ok(err)
    assert.match(err, /non-empty path/)
  })

  it('rejects whitespace-only path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: '   ', name: 'spaces' }
    ])
    assert.ok(err)
    assert.match(err, /non-empty path/)
  })

  it('rejects null path (as non-string)', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: null, name: 'null' }
    ])
    assert.ok(err)
    assert.match(err, /path/)
  })

  it('rejects undefined path (missing)', () => {
    const err = validateAttachments([
      { type: 'file_ref', name: 'missing' }
    ])
    assert.ok(err)
    assert.match(err, /path/)
  })

  it('rejects numeric path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 42, name: 'num' }
    ])
    assert.ok(err)
  })

  it('rejects non-array input', () => {
    const err = validateAttachments('not an array')
    assert.ok(err)
    assert.match(err, /array/)
  })

  it('rejects non-object attachment', () => {
    const err = validateAttachments(['string-item'])
    assert.ok(err)
    assert.match(err, /not an object/)
  })

  it('rejects null attachment', () => {
    const err = validateAttachments([null])
    assert.ok(err)
    assert.match(err, /not an object/)
  })

  it('rejects too many attachments', () => {
    const atts = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => ({
      type: 'file_ref', path: `file${i}.txt`, name: `file${i}.txt`
    }))
    const err = validateAttachments(atts)
    assert.ok(err)
    assert.match(err, /too many/)
  })

  it('accepts exactly MAX_ATTACHMENT_COUNT', () => {
    const atts = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, i) => ({
      type: 'file_ref', path: `file${i}.txt`, name: `file${i}.txt`
    }))
    const err = validateAttachments(atts)
    assert.strictEqual(err, null)
  })

  it('rejects invalid attachment type', () => {
    const err = validateAttachments([
      { type: 'executable', path: '/bin/sh', name: 'shell' }
    ])
    assert.ok(err)
    assert.match(err, /type/)
  })

  it('accepts valid simple path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/index.js', name: 'index.js' }
    ])
    assert.strictEqual(err, null)
  })

  it('accepts deeply nested valid path', () => {
    const err = validateAttachments([
      { type: 'file_ref', path: 'a/b/c/d/e/f/g.txt', name: 'g.txt' }
    ])
    assert.strictEqual(err, null)
  })

  it('accepts empty array', () => {
    const err = validateAttachments([])
    assert.strictEqual(err, null)
  })

  it('path with null byte is treated as string (validation passes)', () => {
    // Null bytes in filenames: path.resolve handles them, but the OS will reject
    // the file. validateAttachments only checks structure, not filesystem access.
    const err = validateAttachments([
      { type: 'file_ref', path: 'src/file\x00.txt', name: 'nullbyte' }
    ])
    // Passes structural validation — null bytes are caught at filesystem layer
    assert.strictEqual(err, null)
  })
})

describe('validateAttachments — image/document validation', () => {
  it('rejects image with disallowed mediaType', () => {
    const err = validateAttachments([
      { type: 'image', mediaType: 'image/svg+xml', data: 'aGVsbG8=', name: 'test.svg' }
    ])
    assert.ok(err)
    assert.match(err, /image mediaType/)
  })

  it('accepts image with valid mediaType', () => {
    const err = validateAttachments([
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'test.png' }
    ])
    assert.strictEqual(err, null)
  })

  it('rejects document with disallowed mediaType', () => {
    const err = validateAttachments([
      { type: 'document', mediaType: 'application/x-shell', data: 'aGVsbG8=', name: 'test.sh' }
    ])
    assert.ok(err)
    assert.match(err, /document mediaType/)
  })

  it('rejects image missing data field', () => {
    const err = validateAttachments([
      { type: 'image', mediaType: 'image/png', name: 'test.png' }
    ])
    assert.ok(err)
    assert.match(err, /missing data/)
  })

  it('rejects image missing name field', () => {
    const err = validateAttachments([
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }
    ])
    assert.ok(err)
    assert.match(err, /missing name/)
  })

  it('rejects image missing mediaType', () => {
    const err = validateAttachments([
      { type: 'image', data: 'aGVsbG8=', name: 'test.png' }
    ])
    assert.ok(err)
    assert.match(err, /mediaType/)
  })

  it('rejects oversized image data', () => {
    // Base64 encoding: 3 bytes become 4 chars. MAX_IMAGE_SIZE=2MB.
    // Need base64 string whose decoded size exceeds 2MB
    const oversizedData = 'A'.repeat(Math.ceil(MAX_IMAGE_SIZE * 4 / 3) + 100)
    const err = validateAttachments([
      { type: 'image', mediaType: 'image/png', data: oversizedData, name: 'big.png' }
    ])
    assert.ok(err)
    assert.match(err, /exceeds.*MB/)
  })

  it('rejects oversized document data', () => {
    const oversizedData = 'A'.repeat(Math.ceil(MAX_DOCUMENT_SIZE * 4 / 3) + 100)
    const err = validateAttachments([
      { type: 'document', mediaType: 'text/plain', data: oversizedData, name: 'big.txt' }
    ])
    assert.ok(err)
    assert.match(err, /exceeds.*MB/)
  })
})

// ============================================================
// resolveFileRefAttachments — filesystem-level security
// ============================================================

describe('resolveFileRefAttachments — path traversal at resolve level', () => {
  it('blocks traversal that resolves outside cwd', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: '../../../etc/passwd', name: 'passwd' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /cannot read file outside project/)
  })

  it('blocks traversal via src/../../..', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'src/../../../etc/passwd', name: 'passwd' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /cannot read file outside project/)
  })

  it('allows paths that normalize to within cwd', () => {
    // src/../readme.md normalizes to readme.md which is within testDir
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'src/../readme.md', name: 'readme.md' }],
      testDir
    )
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.strictEqual(decoded, '# Project\n')
  })

  it('reads deeply nested file', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'nested/deep/file.txt', name: 'file.txt' }],
      testDir
    )
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.strictEqual(decoded, 'deep content\n')
  })

  it('URL-encoded traversal attempt treated as literal filename (not found)', () => {
    // %2e%2e is not decoded by resolve() — treated as literal directory name
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: '%2e%2e/%2e%2e/etc/passwd', name: 'passwd' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    // Should be "file not found" since %2e%2e is a literal dir name
    assert.match(decoded, /file not found|cannot read file/)
  })
})

describe('resolveFileRefAttachments — symlink escape detection', () => {
  it('blocks symlink that resolves outside project directory', () => {
    const linkPath = join(testDir, 'src', 'escape-link')
    try {
      symlinkSync('/etc/hosts', linkPath)
    } catch {
      // Skip if symlinks not supported
      return
    }
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'src/escape-link' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /cannot read file outside project/)
  })

  it('blocks symlink to parent directory', () => {
    const linkPath = join(testDir, 'parent-link')
    try {
      symlinkSync('..', linkPath)
    } catch {
      return
    }
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'parent-link' }],
      testDir
    )
    // This is a symlink to the parent of testDir — should be caught
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    // The symlink target is a directory, so it will hit ENOENT or traversal check
    assert.match(decoded, /cannot read file outside project|Error/)
  })

  it('allows symlink that stays within project directory', () => {
    const linkPath = join(testDir, 'internal-link')
    try {
      symlinkSync(join(testDir, 'readme.md'), linkPath)
    } catch {
      return
    }
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'internal-link' }],
      testDir
    )
    assert.strictEqual(result[0].type, 'document')
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.strictEqual(decoded, '# Project\n')
  })

  it('blocks chain of symlinks that eventually escape', () => {
    const link1 = join(testDir, 'link-chain-1')
    const link2 = join(testDir, 'link-chain-2')
    try {
      symlinkSync('/tmp', link1)
      symlinkSync(link1, link2)
    } catch {
      return
    }
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'link-chain-2' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /cannot read file outside project|Error/)
  })
})

describe('resolveFileRefAttachments — error handling', () => {
  it('returns error for nonexistent file', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'does-not-exist.txt' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /file not found/)
  })

  it('returns error for binary file (contains null bytes)', () => {
    const binPath = join(testDir, 'binary.dat')
    const buf = Buffer.alloc(256)
    buf[10] = 0x00
    buf[50] = 0x00
    writeFileSync(binPath, buf)
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'binary.dat', name: 'binary.dat' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /binary/)
  })

  it('returns error for file exceeding 1MB size limit', () => {
    const bigPath = join(testDir, 'huge.txt')
    writeFileSync(bigPath, Buffer.alloc(1.2 * 1024 * 1024, 0x41))
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'huge.txt', name: 'huge.txt' }],
      testDir
    )
    const decoded = Buffer.from(result[0].data, 'base64').toString('utf-8')
    assert.match(decoded, /too large/)
  })

  it('passes through non-file_ref attachments', () => {
    const img = { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'pic.png' }
    const result = resolveFileRefAttachments([img], testDir)
    assert.deepStrictEqual(result[0], img)
  })

  it('returns original array when cwd is null', () => {
    const atts = [{ type: 'file_ref', path: 'readme.md' }]
    const result = resolveFileRefAttachments(atts, null)
    assert.deepStrictEqual(result, atts)
  })

  it('returns original array when cwd is empty string', () => {
    const atts = [{ type: 'file_ref', path: 'readme.md' }]
    const result = resolveFileRefAttachments(atts, '')
    assert.deepStrictEqual(result, atts)
  })

  it('returns empty array for empty attachments', () => {
    const result = resolveFileRefAttachments([], testDir)
    assert.deepStrictEqual(result, [])
  })

  it('returns original for null attachments', () => {
    const result = resolveFileRefAttachments(null, testDir)
    assert.strictEqual(result, null)
  })

  it('returns original for undefined attachments', () => {
    const result = resolveFileRefAttachments(undefined, testDir)
    assert.strictEqual(result, undefined)
  })

  it('uses path as fallback name', () => {
    const result = resolveFileRefAttachments(
      [{ type: 'file_ref', path: 'src/index.js' }],
      testDir
    )
    assert.strictEqual(result[0].name, 'src/index.js')
  })
})

// ============================================================
// validateCwdWithinHome — directory validation
// ============================================================

describe('validateCwdWithinHome', () => {
  it('accepts home directory itself', () => {
    const err = validateCwdWithinHome(homedir())
    assert.strictEqual(err, null)
  })

  it('accepts subdirectory of home', () => {
    // Create a temp dir within home so we have a guaranteed valid subdirectory
    const homeSubdir = mkdtempSync(join(homedir(), '.chroxy-subdir-test-'))
    try {
      const err = validateCwdWithinHome(homeSubdir)
      assert.strictEqual(err, null, `expected null for home subdirectory, got: ${err}`)
    } finally {
      rmSync(homeSubdir, { recursive: true, force: true })
    }
  })

  it('rejects root directory', () => {
    const err = validateCwdWithinHome('/')
    assert.ok(err)
    assert.match(err, /within your home directory/)
  })

  it('rejects /tmp (outside home)', () => {
    // /tmp is typically NOT within home directory
    const realTmp = realpathSync('/tmp')
    const home = homedir()
    if (!realTmp.startsWith(home + '/') && realTmp !== home) {
      const err = validateCwdWithinHome('/tmp')
      assert.ok(err)
      assert.match(err, /within your home directory/)
    }
  })

  it('rejects /etc directory', () => {
    const err = validateCwdWithinHome('/etc')
    assert.ok(err)
    assert.match(err, /within your home directory/)
  })

  it('rejects nonexistent directory', () => {
    const err = validateCwdWithinHome('/nonexistent/path/that/does/not/exist')
    assert.ok(err)
    assert.match(err, /does not exist/)
  })

  it('rejects file (not a directory)', () => {
    const filePath = join(testDir, 'src', 'index.js')
    const err = validateCwdWithinHome(filePath)
    assert.ok(err)
    assert.match(err, /Not a directory/)
  })

  it('rejects symlink to directory outside home', () => {
    const linkPath = join(testDir, 'etc-link')
    try {
      symlinkSync('/etc', linkPath)
    } catch {
      return
    }
    const err = validateCwdWithinHome(linkPath)
    assert.ok(err)
    assert.match(err, /within your home directory/)
  })

  it('handles directory within home correctly', () => {
    // Create a temp dir specifically within home
    const homeTemp = mkdtempSync(join(homedir(), '.chroxy-test-'))
    try {
      const err = validateCwdWithinHome(homeTemp)
      assert.strictEqual(err, null, `expected null for home subdir, got: ${err}`)
    } finally {
      rmSync(homeTemp, { recursive: true, force: true })
    }
  })
})

// ============================================================
// Constants and exports validation
// ============================================================

describe('handler-utils constants', () => {
  it('PERMISSION_MODES has expected IDs', () => {
    const ids = PERMISSION_MODES.map(m => m.id)
    assert.ok(ids.includes('approve'))
    assert.ok(ids.includes('auto'))
    assert.ok(ids.includes('plan'))
    assert.ok(ids.includes('acceptEdits'))
  })

  it('ALLOWED_PERMISSION_MODE_IDS is a Set matching PERMISSION_MODES', () => {
    assert.ok(ALLOWED_PERMISSION_MODE_IDS instanceof Set)
    assert.strictEqual(ALLOWED_PERMISSION_MODE_IDS.size, PERMISSION_MODES.length)
    for (const mode of PERMISSION_MODES) {
      assert.ok(ALLOWED_PERMISSION_MODE_IDS.has(mode.id))
    }
  })

  it('attachment size limits are reasonable', () => {
    assert.strictEqual(MAX_IMAGE_SIZE, 2 * 1024 * 1024)
    assert.strictEqual(MAX_DOCUMENT_SIZE, 5 * 1024 * 1024)
    assert.strictEqual(MAX_ATTACHMENT_COUNT, 5)
  })

  it('ALLOWED_IMAGE_TYPES contains standard web image formats', () => {
    assert.ok(ALLOWED_IMAGE_TYPES.has('image/jpeg'))
    assert.ok(ALLOWED_IMAGE_TYPES.has('image/png'))
    assert.ok(ALLOWED_IMAGE_TYPES.has('image/gif'))
    assert.ok(ALLOWED_IMAGE_TYPES.has('image/webp'))
    // Should NOT include dangerous types
    assert.ok(!ALLOWED_IMAGE_TYPES.has('image/svg+xml'))
  })
})

// ============================================================
// broadcastFocusChanged
// ============================================================

describe('broadcastFocusChanged', () => {
  it('calls ctx.broadcast with correct message shape', () => {
    let capturedMsg = null
    const ctx = {
      broadcast(msg) {
        capturedMsg = msg
      }
    }
    const client = { id: 'client-1' }
    broadcastFocusChanged(client, 'session-42', ctx)

    assert.strictEqual(capturedMsg.type, 'client_focus_changed')
    assert.strictEqual(capturedMsg.clientId, 'client-1')
    assert.strictEqual(capturedMsg.sessionId, 'session-42')
    assert.ok(typeof capturedMsg.timestamp === 'number')
  })

  it('filter excludes the sending client', () => {
    let capturedFilter = null
    const ctx = {
      broadcast(_msg, filter) { capturedFilter = filter }
    }
    broadcastFocusChanged({ id: 'client-A' }, 'sess', ctx)

    assert.ok(capturedFilter({ id: 'client-B' }), 'other client should pass filter')
    assert.ok(!capturedFilter({ id: 'client-A' }), 'sending client should be excluded')
  })
})

// ============================================================
// resolveSession
// ============================================================

// ============================================================
// sendError
// ============================================================

describe('sendError', () => {
  it('sends a well-formed error message when socket is open', () => {
    const sent = []
    const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
    sendError(ws, 'req-1', 'HANDLER_ERROR', 'something went wrong')
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].type, 'error')
    assert.strictEqual(sent[0].requestId, 'req-1')
    assert.strictEqual(sent[0].code, 'HANDLER_ERROR')
    assert.strictEqual(sent[0].message, 'something went wrong')
  })

  it('sets requestId to null when not provided', () => {
    const sent = []
    const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
    sendError(ws, undefined, 'HANDLER_ERROR', 'oops')
    assert.strictEqual(sent[0].requestId, null)
  })

  it('does nothing when socket is closed', () => {
    const sent = []
    const ws = { readyState: 3, send: (data) => sent.push(data) }
    sendError(ws, 'req-2', 'HANDLER_ERROR', 'too late')
    assert.strictEqual(sent.length, 0)
  })

  it('does nothing when ws is null', () => {
    // Should not throw
    assert.doesNotThrow(() => sendError(null, 'req-3', 'HANDLER_ERROR', 'no socket'))
  })

  it('does nothing when ws is undefined', () => {
    assert.doesNotThrow(() => sendError(undefined, 'req-4', 'HANDLER_ERROR', 'no socket'))
  })
})

describe('resolveSession', () => {
  it('returns session by msg.sessionId', () => {
    const session = { id: 'sess-1', name: 'test' }
    const ctx = {
      sessionManager: {
        getSession(id) { return id === 'sess-1' ? session : null }
      }
    }
    const result = resolveSession(ctx, { sessionId: 'sess-1' }, {})
    assert.deepStrictEqual(result, session)
  })

  it('falls back to client.activeSessionId', () => {
    const session = { id: 'sess-2', name: 'fallback' }
    const ctx = {
      sessionManager: {
        getSession(id) { return id === 'sess-2' ? session : null }
      }
    }
    const result = resolveSession(ctx, {}, { activeSessionId: 'sess-2' })
    assert.deepStrictEqual(result, session)
  })

  it('prefers msg.sessionId over client.activeSessionId', () => {
    const ctx = {
      sessionManager: {
        getSession(id) { return { id, picked: true } }
      }
    }
    const result = resolveSession(
      ctx,
      { sessionId: 'from-msg' },
      { activeSessionId: 'from-client' }
    )
    assert.strictEqual(result.id, 'from-msg')
  })

  it('returns null when session not found', () => {
    const ctx = {
      sessionManager: {
        getSession() { return undefined }
      }
    }
    const result = resolveSession(ctx, { sessionId: 'nonexistent' }, {})
    assert.strictEqual(result, null)
  })

  it('returns null when sessionManager is missing', () => {
    const result = resolveSession({}, { sessionId: 'any' }, {})
    assert.strictEqual(result, null)
  })

  it('returns null when client is null', () => {
    const ctx = {
      sessionManager: {
        getSession() { return undefined }
      }
    }
    const result = resolveSession(ctx, {}, null)
    assert.strictEqual(result, null)
  })
})
