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
  symlinkSync, realpathSync, existsSync, statSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { nsCtx } from './test-helpers.js'
import { createClientSender } from '../src/ws-client-sender.js'
import { createKeyPair, deriveSharedKey, decrypt, DIRECTION_SERVER } from '@chroxy/store-core/crypto'
import {
  validateAttachments,
  resolveFileRefAttachments,
  validateCwdWithinHome,
  validateCwdAllowed,
  FORBIDDEN_HOME_SUBDIRS,
  PERMISSION_MODES,
  getPermissionModes,
  ALLOWED_PERMISSION_MODE_IDS,
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_SIZE,
  MAX_DOCUMENT_SIZE,
  ALLOWED_IMAGE_TYPES,
  broadcastFocusChanged,
  resolveSession,
  resolveSessionOrError,
  requireSessionMethod,
  sendSessionError,
  sendError,
  buildSessionTokenMismatchPayload,
  SESSION_TOKEN_MISMATCH_DEFAULT_MESSAGE,
  isSessionViewer,
  terminalMirrorRecipient,
} from '../src/handler-utils.js'

// audit P1-2: the live-terminal mirror recipient predicate. The delivery filter
// (ws-forwarding) and the coalescer gate (ws-server) must use this same function
// so the gate can never diverge from who actually receives terminal_output.
describe('terminalMirrorRecipient', () => {
  const viewerOpted = { activeSessionId: 's1', subscribedSessionIds: new Set(), terminalSessionIds: new Set(['s1']) }
  const subscribedOpted = { activeSessionId: null, subscribedSessionIds: new Set(['s1']), terminalSessionIds: new Set(['s1']) }
  const viewerNotOpted = { activeSessionId: 's1', subscribedSessionIds: new Set(), terminalSessionIds: new Set() }
  const optedNotViewing = { activeSessionId: 's2', subscribedSessionIds: new Set(), terminalSessionIds: new Set(['s1']) }
  const noTerminalSet = { activeSessionId: 's1', subscribedSessionIds: new Set() }

  it('is true only when opted into the terminal AND viewing the session', () => {
    assert.equal(terminalMirrorRecipient(viewerOpted, 's1'), true)
    assert.equal(terminalMirrorRecipient(subscribedOpted, 's1'), true)
    assert.equal(terminalMirrorRecipient(viewerNotOpted, 's1'), false, 'viewing but not opted in')
    assert.equal(terminalMirrorRecipient(optedNotViewing, 's1'), false, 'opted in but viewing a different session')
    assert.equal(terminalMirrorRecipient(noTerminalSet, 's1'), false, 'no terminalSessionIds set at all')
  })

  it('equals (opted-in AND isSessionViewer) — the contract the gate and filter share', () => {
    for (const client of [viewerOpted, subscribedOpted, viewerNotOpted, optedNotViewing]) {
      const expected = Boolean(client.terminalSessionIds && client.terminalSessionIds.has('s1')) && isSessionViewer(client, 's1')
      assert.equal(terminalMirrorRecipient(client, 's1'), expected)
    }
  })
})

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
// validateCwdAllowed — audit blocker 1 (2026-04-11)
// ============================================================

describe('validateCwdAllowed — credential-directory deny-list (2026-04-11 audit blocker 1)', () => {
  // Hermetic fake-$HOME used by every test in this block. Created once,
  // torn down at the end. No test ever touches the real user home,
  // which means these tests are deterministic across machines and
  // don't silently skip when ~/.ssh / ~/.config don't exist.
  //
  // Pattern found by Copilot review on PR #2808: prior version of
  // these tests created throwaway dirs under the user's real
  // ~/.config, which is undesirable for local runs and flaky in CI.
  let fakeHome
  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'chroxy-fake-home-'))
    // Pre-create the forbidden dirs so each test exercises the deny-list
    // rather than the path-hygiene layer that would fire on nonexistence.
    mkdirSync(join(fakeHome, '.ssh'))
    mkdirSync(join(fakeHome, '.aws'))
    mkdirSync(join(fakeHome, '.config'))
    mkdirSync(join(fakeHome, '.config', 'gcloud'), { recursive: true })
    mkdirSync(join(fakeHome, '.gnupg'))
    mkdirSync(join(fakeHome, '.docker'))
    // Chroxy + Claude own-state dirs, added 2026-04-11 for Adversary A9
    mkdirSync(join(fakeHome, '.chroxy'))
    mkdirSync(join(fakeHome, '.claude'))
    mkdirSync(join(fakeHome, 'ordinary-project'))
  })
  after(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
  })

  it('rejects ~/.ssh — Adversary A1 attack scenario', () => {
    const err = validateCwdAllowed(join(fakeHome, '.ssh'), { homeOverride: fakeHome })
    assert.ok(err, 'must reject fake-home .ssh')
    assert.match(err, /credential.config directories/)
  })

  it('rejects a subdirectory of a forbidden entry (~/.config/gcloud)', () => {
    const err = validateCwdAllowed(join(fakeHome, '.config', 'gcloud'), { homeOverride: fakeHome })
    assert.ok(err, 'must reject .config/gcloud subdirectory')
    assert.match(err, /credential.config directories/)
  })

  it('rejects ~/.aws and ~/.docker and ~/.gnupg consistently', () => {
    for (const name of ['.aws', '.docker', '.gnupg']) {
      const err = validateCwdAllowed(join(fakeHome, name), { homeOverride: fakeHome })
      assert.ok(err, `must reject ${name}`)
      assert.match(err, /credential.config directories/)
    }
  })

  it('FORBIDDEN_HOME_SUBDIRS includes the highest-value credential paths', () => {
    // Sanity: the deny-list must cover the exact paths Adversary A1
    // called out in the audit, plus the common companions + IaC
    // tooling credentials added after agent review on PR #2808.
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.ssh'), '~/.ssh must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.aws'), '~/.aws must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.azure'), '~/.azure must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.config'), '~/.config must be denied (covers gcloud/gh/op)')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.gnupg'), '~/.gnupg must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.docker'), '~/.docker must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.kube'), '~/.kube must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.terraform.d'), '~/.terraform.d must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.helm'), '~/.helm must be denied')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.rclone'), '~/.rclone must be denied')
    // Adversary A9 additions
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.chroxy'), '~/.chroxy must be denied (A9 known-good-ref poisoning)')
    assert.ok(FORBIDDEN_HOME_SUBDIRS.has('.claude'), '~/.claude must be denied (JSONL ring isolation)')
  })

  it('rejects ~/.chroxy — Adversary A9 known-good-ref poisoning scenario', () => {
    const err = validateCwdAllowed(join(fakeHome, '.chroxy'), { homeOverride: fakeHome })
    assert.ok(err, 'must reject fake-home .chroxy')
    assert.match(err, /credential.config directories/)
  })

  it('rejects ~/.claude — Claude Code JSONL directory', () => {
    const err = validateCwdAllowed(join(fakeHome, '.claude'), { homeOverride: fakeHome })
    assert.ok(err, 'must reject fake-home .claude')
    assert.match(err, /credential.config directories/)
  })

  it('case-insensitive match rejects mixed-case variants (agent review on PR #2808)', () => {
    // Critical bypass found by agent review: on macOS APFS (default
    // case-insensitive) and Windows NTFS, ~/.SSH resolves to the same
    // directory as ~/.ssh but a case-sensitive Set lookup would miss
    // it. Attacker sends cwd: ~/.SSH, gets the same access as Adversary
    // A1. One-line fix: lowercase the first segment before the Set
    // lookup in pathTouchesForbiddenSubdir.
    //
    // Hermetic test: create mixed-case forbidden directories directly
    // in the fake home. On case-insensitive FS .SSH maps to the
    // already-created .ssh and mkdirSync will throw EEXIST — we
    // handle that by just querying the existing dir with the mixed
    // casing. On case-sensitive FS the mixed-case dir is distinct
    // and the lowercase compare still catches it.
    // On case-insensitive FS, `.SSH` and `.AwS` are the same directories
    // as `.ssh` and `.aws` already created in before(). We just validate
    // the mixed-case path string and assert the lowercase compare fires.
    // We do NOT delete anything — rmSync on a case-insensitive FS alias
    // would clobber the real lowercase directory and break later tests.
    //
    // On case-sensitive FS, `.SSH` is a distinct directory. To test the
    // lowercase fix we'd need to create one; but the before() block
    // already created `.ssh` and mkdirSync('.SSH') would succeed on
    // case-sensitive FS only. We try it, accept EEXIST on case-
    // insensitive, and proceed either way.
    for (const name of ['.SSH', '.AwS', '.CONFIG']) {
      const mixedPath = join(fakeHome, name)
      try {
        mkdirSync(mixedPath)
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        // Case-insensitive FS: the mixed path resolves to the
        // lowercase dir from before(). Either way validateCwdAllowed
        // should reject it — that's what we assert.
      }
      const result = validateCwdAllowed(mixedPath, { homeOverride: fakeHome })
      assert.ok(result, `mixed-case ${name} must be rejected`)
      assert.match(result, /credential.config directories/)
    }
  })

  it('allows an ordinary home subdir that does NOT touch any forbidden entry', () => {
    const err = validateCwdAllowed(
      join(fakeHome, 'ordinary-project'),
      { homeOverride: fakeHome }
    )
    assert.strictEqual(err, null, `expected null, got: ${err}`)
  })

  it('deny-list fires before the workspaceRoots allowlist check', () => {
    // Even if the user explicitly configured an allowlist that includes
    // a path under a forbidden entry, the deny-list wins. Defense in
    // depth — prevents a user from accidentally whitelisting ~/.ssh.
    const credDir = join(fakeHome, '.config', 'gcloud')
    const err = validateCwdAllowed(credDir, {
      workspaceRoots: [credDir],
      homeOverride: fakeHome,
    })
    assert.ok(err, 'deny-list must override workspaceRoots allowlist')
    assert.match(err, /credential.config directories/)
  })
})

describe('validateCwdAllowed — workspaceRoots allowlist', () => {
  it('rejects a path outside every configured root', () => {
    const homeTemp = mkdtempSync(join(homedir(), '.chroxy-ws-outside-'))
    const otherRoot = mkdtempSync(join(homedir(), '.chroxy-ws-root-'))
    try {
      const err = validateCwdAllowed(homeTemp, { workspaceRoots: [otherRoot] })
      assert.ok(err, 'must reject path not under any configured root')
      assert.match(err, /workspace root/)
    } finally {
      rmSync(homeTemp, { recursive: true, force: true })
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  it('accepts a path that is the configured root itself', () => {
    const root = mkdtempSync(join(homedir(), '.chroxy-ws-exact-'))
    try {
      const err = validateCwdAllowed(root, { workspaceRoots: [root] })
      assert.strictEqual(err, null, `expected null, got: ${err}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a path under one of several configured roots', () => {
    const root1 = mkdtempSync(join(homedir(), '.chroxy-ws-multi-a-'))
    const root2 = mkdtempSync(join(homedir(), '.chroxy-ws-multi-b-'))
    const under2 = mkdtempSync(join(root2, 'nested-'))
    try {
      const err = validateCwdAllowed(under2, { workspaceRoots: [root1, root2] })
      assert.strictEqual(err, null, `expected null, got: ${err}`)
    } finally {
      rmSync(under2, { recursive: true, force: true })
      rmSync(root1, { recursive: true, force: true })
      rmSync(root2, { recursive: true, force: true })
    }
  })

  it('segment-aware matching rejects a sibling prefix ("/home/user/work-other" is not within "/home/user/work")', () => {
    // The naive startsWith check without a separator would accept
    // /home/user/work-other as being inside /home/user/work. The
    // isPathWithin helper must use path separator boundaries.
    const work = mkdtempSync(join(homedir(), '.chroxy-work-'))
    const workOther = mkdtempSync(join(homedir(), '.chroxy-work-other-'))
    try {
      const err = validateCwdAllowed(workOther, { workspaceRoots: [work] })
      assert.ok(err, 'sibling prefix path must be rejected')
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(workOther, { recursive: true, force: true })
    }
  })

  it('an empty workspaceRoots array falls back to the home-dir check', () => {
    const homeTemp = mkdtempSync(join(homedir(), '.chroxy-empty-roots-'))
    try {
      const err = validateCwdAllowed(homeTemp, { workspaceRoots: [] })
      assert.strictEqual(err, null, 'empty array should NOT activate strict allowlist')
    } finally {
      rmSync(homeTemp, { recursive: true, force: true })
    }
  })

  it('silently ignores a configured root that does not exist on disk', () => {
    // Don't fail the whole check just because a stale entry is in the
    // user's config — fall through to other roots and layers.
    const realRoot = mkdtempSync(join(homedir(), '.chroxy-real-root-'))
    const subdir = mkdtempSync(join(realRoot, 'nested-'))
    try {
      const err = validateCwdAllowed(subdir, {
        workspaceRoots: ['/this/path/does/not/exist', realRoot],
      })
      assert.strictEqual(err, null, `stale entry should be skipped; got: ${err}`)
    } finally {
      rmSync(subdir, { recursive: true, force: true })
      rmSync(realRoot, { recursive: true, force: true })
    }
  })
})

describe('validateCwdWithinHome — back-compat alias', () => {
  it('delegates to validateCwdAllowed with no config', () => {
    // The legacy function name should still work and still produce
    // the same "within your home directory" errors as before.
    const err = validateCwdWithinHome('/etc')
    assert.ok(err)
    assert.match(err, /within your home directory/)
  })

  it('inherits the new deny-list layer even from the legacy entry point', () => {
    // Callers that haven't migrated to validateCwdAllowed still get
    // the defense-in-depth check — this is the back-compat safety
    // net for the 2026-04-11 audit blocker 1 fix.
    const configRoot = join(homedir(), '.config')
    if (!existsSync(configRoot)) return
    const fakeCredDir = mkdtempSync(join(configRoot, 'chroxy-test-legacy-'))
    try {
      const err = validateCwdWithinHome(fakeCredDir)
      assert.ok(err, 'legacy entry point must still apply the deny-list')
      assert.match(err, /credential.config directories/)
    } finally {
      rmSync(fakeCredDir, { recursive: true, force: true })
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
  it('calls ctx.transport.broadcast with correct message shape', () => {
    let capturedMsg = null
    const ctx = nsCtx({
      broadcast(msg) {
        capturedMsg = msg
      }
    })
    const client = { id: 'client-1' }
    broadcastFocusChanged(client, 'session-42', ctx)

    assert.strictEqual(capturedMsg.type, 'client_focus_changed')
    assert.strictEqual(capturedMsg.clientId, 'client-1')
    assert.strictEqual(capturedMsg.sessionId, 'session-42')
    assert.ok(typeof capturedMsg.timestamp === 'number')
  })

  it('filter excludes the sending client', () => {
    let capturedFilter = null
    const ctx = nsCtx({
      broadcast(_msg, filter) { capturedFilter = filter }
    })
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

  // #3538: sendError accepts an optional `data` object whose fields are merged
  // into the wire payload so handlers can attach structured context (e.g.
  // actualAuthor on INVALID_AUTHOR) without forcing clients to regex-parse the
  // human-readable `message`. The change is additive — the canonical four
  // fields (type/requestId/code/message) remain.
  it('merges optional data fields into the wire payload (#3538)', () => {
    const sent = []
    const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
    sendError(ws, 'req-5', 'INVALID_AUTHOR', 'wrong author', { actualAuthor: 'alice' })
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].type, 'error')
    assert.strictEqual(sent[0].requestId, 'req-5')
    assert.strictEqual(sent[0].code, 'INVALID_AUTHOR')
    assert.strictEqual(sent[0].message, 'wrong author')
    assert.strictEqual(sent[0].actualAuthor, 'alice')
  })

  it('refuses data fields that would clobber canonical wire fields (#3538)', () => {
    const sent = []
    const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
    // A misbehaving caller passes data keys that overlap canonical fields.
    // Canonical fields must win — the data spread cannot override type/code/etc.
    sendError(ws, 'req-6', 'INVALID_AUTHOR', 'wrong author', {
      type: 'wat',
      requestId: 'spoofed',
      code: 'OTHER',
      message: 'spoofed',
      actualAuthor: 'alice',
    })
    assert.strictEqual(sent[0].type, 'error')
    assert.strictEqual(sent[0].requestId, 'req-6')
    assert.strictEqual(sent[0].code, 'INVALID_AUTHOR')
    assert.strictEqual(sent[0].message, 'wrong author')
    assert.strictEqual(sent[0].actualAuthor, 'alice')
  })

  it('ignores non-object data argument (#3538)', () => {
    const sent = []
    const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
    sendError(ws, 'req-7', 'HANDLER_ERROR', 'oops', null)
    sendError(ws, 'req-8', 'HANDLER_ERROR', 'oops', 'not-an-object')
    sendError(ws, 'req-9', 'HANDLER_ERROR', 'oops', 42)
    for (const m of sent) {
      assert.strictEqual(m.type, 'error')
      assert.strictEqual(m.code, 'HANDLER_ERROR')
      assert.strictEqual(m.message, 'oops')
    }
  })

  // #3578: sendError must block prototype-pollution keys when merging data, so
  // a misbehaving (or partially user-derived) caller cannot mutate
  // Object.prototype via the merge step. event-normalizer.js already treats
  // these as reserved; sendError applies the same hardening.
  it('blocks prototype-pollution keys in data merge (#3578)', () => {
    const sent = []
    const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
    // Use a null-prototype object so we can attach __proto__ as an own key
    // without accidentally setting the actual prototype on the literal.
    const polluted = Object.create(null)
    polluted.__proto__ = { polluted: true }
    polluted.constructor = { polluted: true }
    polluted.prototype = { polluted: true }
    polluted.safeField = 'kept'
    sendError(ws, 'req-10', 'HANDLER_ERROR', 'oops', polluted)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].type, 'error')
    assert.strictEqual(sent[0].code, 'HANDLER_ERROR')
    assert.strictEqual(sent[0].message, 'oops')
    // Reserved keys must not appear on the payload.
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sent[0], 'constructor'), false)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sent[0], 'prototype'), false)
    // Non-reserved fields still merge through.
    assert.strictEqual(sent[0].safeField, 'kept')
    // And global Object.prototype must remain unpolluted.
    assert.strictEqual({}.polluted, undefined)
  })

  // #5632: sendError now accepts an optional handler `ctx` and, when present,
  // routes the error through `ctx.transport.send` (→ WsServer._send → the
  // per-client encrypting sender) instead of the raw `ws.send`. This makes a
  // post-handshake error frame ENCRYPTED so the client's plaintext guard
  // (connection.ts) doesn't reject it as a downgrade. A forged plaintext
  // `error` post-encryption is then correctly rejected client-side.
  describe('encryption-aware routing (#5632)', () => {
    it('routes through ctx.transport.send when a ctx is supplied', () => {
      const sent = []
      const ws = { readyState: 1, send: () => { throw new Error('raw ws.send must not be used when ctx is present') } }
      const ctx = { transport: { send: (targetWs, payload) => sent.push({ targetWs, payload }) } }

      sendError(ws, 'req-1', 'INVALID_MODEL', 'nope', undefined, ctx)

      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0].targetWs, ws)
      assert.strictEqual(sent[0].payload.type, 'error')
      assert.strictEqual(sent[0].payload.code, 'INVALID_MODEL')
      assert.strictEqual(sent[0].payload.message, 'nope')
    })

    it('falls back to raw ws.send when no ctx is supplied (pre-auth call sites)', () => {
      const sent = []
      const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) }
      sendError(ws, 'req-2', 'FORBIDDEN', 'pre-auth')
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0].type, 'error')
      assert.strictEqual(sent[0].code, 'FORBIDDEN')
    })

    it('still merges data fields through the ctx.transport path', () => {
      const sent = []
      const ws = { readyState: 1, send: () => {} }
      const ctx = { transport: { send: (_ws, payload) => sent.push(payload) } }
      sendError(ws, 'req-3', 'INVALID_AUTHOR', 'wrong', { actualAuthor: 'alice' }, ctx)
      assert.strictEqual(sent[0].actualAuthor, 'alice')
      assert.strictEqual(sent[0].type, 'error')
    })

    // End-to-end through the real WsServer send pipeline shape: ctx.transport.send
    // is `(ws, msg) => server._send(ws, msg)` and _send looks the client up by ws
    // and hands off to the per-client encrypting sender. We reconstruct that path
    // here with the real createClientSender to prove the wire frame is `encrypted`
    // when the client's encryptionState is set, and a plaintext `error` when it is
    // not — matching the client guard's expectation either side of the handshake.
    it('produces an ENCRYPTED frame when the client encryptionState is established', () => {
      const serverKp = createKeyPair()
      const clientKp = createKeyPair()
      const serverShared = deriveSharedKey(clientKp.publicKey, serverKp.secretKey)
      const clientShared = deriveSharedKey(serverKp.publicKey, clientKp.secretKey)

      const sent = []
      const ws = { readyState: 1, send: (data) => sent.push(data) }
      const client = { _seq: 0, encryptionState: { sharedKey: serverShared, sendNonce: 0, recvNonce: 0 } }
      const clientSend = createClientSender({ error: () => {}, warn: () => {} })
      // Mirror WsServer._send: (ws, msg) => clientSend(ws, client, msg)
      const ctx = { transport: { send: (targetWs, payload) => clientSend(targetWs, client, payload) } }

      sendError(ws, 'req-enc', 'INVALID_MODEL', 'gpt-9000', undefined, ctx)

      assert.strictEqual(sent.length, 1)
      const envelope = JSON.parse(sent[0])
      // Wire frame is an `encrypted` envelope, NOT a plaintext { type: 'error' }.
      assert.strictEqual(envelope.type, 'encrypted')
      assert.strictEqual(typeof envelope.d, 'string')
      assert.strictEqual(typeof envelope.n, 'number')
      // The client can decrypt it back to the original error frame.
      const plain = decrypt(envelope, clientShared, 0, DIRECTION_SERVER)
      assert.strictEqual(plain.type, 'error')
      assert.strictEqual(plain.code, 'INVALID_MODEL')
      assert.strictEqual(plain.message, 'gpt-9000')
    })

    it('produces a PLAINTEXT error frame when the client has no encryptionState (pre-handshake)', () => {
      const sent = []
      const ws = { readyState: 1, send: (data) => sent.push(data) }
      const client = { _seq: 0 } // no encryptionState
      const clientSend = createClientSender({ error: () => {}, warn: () => {} })
      const ctx = { transport: { send: (targetWs, payload) => clientSend(targetWs, client, payload) } }

      sendError(ws, 'req-plain', 'FORBIDDEN', 'no auth yet', undefined, ctx)

      assert.strictEqual(sent.length, 1)
      const frame = JSON.parse(sent[0])
      assert.strictEqual(frame.type, 'error')
      assert.strictEqual(frame.code, 'FORBIDDEN')
    })
  })
})

describe('resolveSession', () => {
  it('returns session by msg.sessionId', () => {
    const session = { id: 'sess-1', name: 'test' }
    const ctx = nsCtx({
      sessionManager: {
        getSession(id) { return id === 'sess-1' ? session : null }
      }
    })
    const result = resolveSession(ctx, { sessionId: 'sess-1' }, {})
    assert.deepStrictEqual(result, session)
  })

  it('falls back to client.activeSessionId', () => {
    const session = { id: 'sess-2', name: 'fallback' }
    const ctx = nsCtx({
      sessionManager: {
        getSession(id) { return id === 'sess-2' ? session : null }
      }
    })
    const result = resolveSession(ctx, {}, { activeSessionId: 'sess-2' })
    assert.deepStrictEqual(result, session)
  })

  it('prefers msg.sessionId over client.activeSessionId', () => {
    const ctx = nsCtx({
      sessionManager: {
        getSession(id) { return { id, picked: true } }
      }
    })
    const result = resolveSession(
      ctx,
      { sessionId: 'from-msg' },
      { activeSessionId: 'from-client' }
    )
    assert.strictEqual(result.id, 'from-msg')
  })

  it('returns null when session not found', () => {
    const ctx = nsCtx({
      sessionManager: {
        getSession() { return undefined }
      }
    })
    const result = resolveSession(ctx, { sessionId: 'nonexistent' }, {})
    assert.strictEqual(result, null)
  })

  it('returns null when sessionManager is missing', () => {
    const result = resolveSession({}, { sessionId: 'any' }, {})
    assert.strictEqual(result, null)
  })

  it('returns null when client is null', () => {
    const ctx = nsCtx({
      sessionManager: {
        getSession() { return undefined }
      }
    })
    const result = resolveSession(ctx, {}, null)
    assert.strictEqual(result, null)
  })

  it('returns null when client is bound to a different session', () => {
    const session = { id: 'sess-1', name: 'test' }
    const ctx = nsCtx({
      sessionManager: {
        getSession(id) { return id === 'sess-1' ? session : null }
      }
    })
    const client = { activeSessionId: 'sess-1', boundSessionId: 'sess-other' }
    const result = resolveSession(ctx, { sessionId: 'sess-1' }, client)
    assert.strictEqual(result, null)
  })

  it('returns session when client is bound to the same session', () => {
    const session = { id: 'sess-1', name: 'test' }
    const ctx = nsCtx({
      sessionManager: {
        getSession(id) { return id === 'sess-1' ? session : null }
      }
    })
    const client = { activeSessionId: 'sess-1', boundSessionId: 'sess-1' }
    const result = resolveSession(ctx, { sessionId: 'sess-1' }, client)
    assert.deepStrictEqual(result, session)
  })

  it('returns session when client has no bound session', () => {
    const session = { id: 'sess-1', name: 'test' }
    const ctx = nsCtx({
      sessionManager: {
        getSession(id) { return id === 'sess-1' ? session : null }
      }
    })
    const client = { activeSessionId: 'sess-1', boundSessionId: null }
    const result = resolveSession(ctx, { sessionId: 'sess-1' }, client)
    assert.deepStrictEqual(result, session)
  })
})

// ============================================================
// buildSessionTokenMismatchPayload — canonical payload shape (Issue #2912)
// ============================================================

describe('buildSessionTokenMismatchPayload', () => {
  it('returns all four fields with defaults when given no arguments', () => {
    const payload = buildSessionTokenMismatchPayload()
    assert.deepEqual(Object.keys(payload).sort(), [
      'boundSessionId', 'boundSessionName', 'code', 'message',
    ])
    assert.equal(payload.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(payload.message, SESSION_TOKEN_MISMATCH_DEFAULT_MESSAGE)
    assert.equal(payload.boundSessionId, null)
    assert.equal(payload.boundSessionName, null)
  })

  it('looks up boundSessionName via sessionManager when binding is live', () => {
    const sessionManager = {
      getSession(id) { return id === 'sess-1' ? { name: 'MarchBorne' } : null },
    }
    const payload = buildSessionTokenMismatchPayload({
      sessionManager, boundSessionId: 'sess-1',
    })
    assert.equal(payload.boundSessionId, 'sess-1')
    assert.equal(payload.boundSessionName, 'MarchBorne')
  })

  it('returns null boundSessionName when binding is stale', () => {
    const sessionManager = { getSession: () => null }
    const payload = buildSessionTokenMismatchPayload({
      sessionManager, boundSessionId: 'sess-gone',
    })
    assert.equal(payload.boundSessionId, 'sess-gone')
    assert.equal(payload.boundSessionName, null)
  })

  it('tolerates missing sessionManager (null) and returns boundSessionName=null', () => {
    const payload = buildSessionTokenMismatchPayload({
      sessionManager: null, boundSessionId: 'sess-1',
    })
    assert.equal(payload.boundSessionId, 'sess-1')
    assert.equal(payload.boundSessionName, null)
  })

  it('tolerates a session entry without a name field', () => {
    const sessionManager = { getSession: () => ({ cwd: '/tmp' }) }
    const payload = buildSessionTokenMismatchPayload({
      sessionManager, boundSessionId: 'sess-1',
    })
    assert.equal(payload.boundSessionName, null)
  })

  it('uses a custom message when provided', () => {
    const payload = buildSessionTokenMismatchPayload({
      message: 'Not authorized to respond to this permission request',
    })
    assert.equal(payload.message, 'Not authorized to respond to this permission request')
  })

  it('normalises empty-string boundSessionId to null', () => {
    const payload = buildSessionTokenMismatchPayload({ boundSessionId: '' })
    assert.equal(payload.boundSessionId, null)
    assert.equal(payload.boundSessionName, null)
  })
})

// ============================================================
// sendSessionError — issue #4773
// ============================================================
//
// Thin wrapper around ctx.transport.send that emits the canonical `session_error`
// envelope used across handlers. Centralising the shape here means the
// 50+ inline `ctx.transport.send(ws, { type: 'session_error', message })` sites can
// collapse to a one-liner and any future schema tweak (adding `code`,
// `recoverable`, etc.) happens in one place.

describe('sendSessionError (#4773)', () => {
  it('routes the session_error envelope through ctx.transport.send', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    sendSessionError(ws, ctx, 'No active session')
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].ws, ws)
    assert.strictEqual(sent[0].msg.type, 'session_error')
    assert.strictEqual(sent[0].msg.message, 'No active session')
  })

  it('does nothing when ws is null or undefined', () => {
    const ctx = nsCtx({ send: () => assert.fail('should not be called') })
    assert.doesNotThrow(() => sendSessionError(null, ctx, 'oops'))
    assert.doesNotThrow(() => sendSessionError(undefined, ctx, 'oops'))
  })

  it('does nothing when ctx is missing send', () => {
    const ws = { readyState: 1, send: () => {} }
    assert.doesNotThrow(() => sendSessionError(ws, null, 'oops'))
    assert.doesNotThrow(() => sendSessionError(ws, {}, 'oops'))
  })
})

// ============================================================
// resolveSessionOrError — issue #4773
// ============================================================
//
// Wraps resolveSession so the 13 hot sites that do:
//   const entry = resolveSession(ctx, msg, client)
//   if (!entry) {
//     ctx.transport.send(ws, { type: 'session_error', message: 'No active session' })
//     return
//   }
// collapse to:
//   const entry = resolveSessionOrError(ws, ctx, msg, client)
//   if (!entry) return
//
// Returning `null` on miss (after emitting the error) keeps the caller
// idiom dead-simple and identical to the manual pattern it replaces.

describe('resolveSessionOrError (#4773)', () => {
  it('returns the session entry on hit and emits nothing', () => {
    const session = { id: 'sess-1', name: 'test' }
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({
      send: (ws_, msg) => sent.push({ ws: ws_, msg }),
      sessionManager: { getSession: (id) => (id === 'sess-1' ? session : null) },
    })
    const result = resolveSessionOrError(ws, ctx, { sessionId: 'sess-1' }, {})
    assert.deepStrictEqual(result, session)
    assert.strictEqual(sent.length, 0)
  })

  it('returns null on miss and emits a session_error', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({
      send: (ws_, msg) => sent.push({ ws: ws_, msg }),
      sessionManager: { getSession: () => null },
    })
    const result = resolveSessionOrError(ws, ctx, { sessionId: 'nope' }, {})
    assert.strictEqual(result, null)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].msg.type, 'session_error')
    assert.strictEqual(sent[0].msg.message, 'No active session')
  })

  it('falls back to client.activeSessionId when msg lacks sessionId', () => {
    const session = { id: 'sess-2', name: 'fallback' }
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({
      send: (ws_, msg) => sent.push({ ws: ws_, msg }),
      sessionManager: { getSession: (id) => (id === 'sess-2' ? session : null) },
    })
    const result = resolveSessionOrError(ws, ctx, {}, { activeSessionId: 'sess-2' })
    assert.deepStrictEqual(result, session)
    assert.strictEqual(sent.length, 0)
  })

  it('emits the canonical "No active session" message even when sessionManager is missing', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    const result = resolveSessionOrError(ws, ctx, { sessionId: 'any' }, {})
    assert.strictEqual(result, null)
    assert.strictEqual(sent[0].msg.type, 'session_error')
    assert.strictEqual(sent[0].msg.message, 'No active session')
  })

  it('returns null when a bound client requests a different session', () => {
    // Binding violation: do not leak that the session exists.
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({
      send: (ws_, msg) => sent.push({ ws: ws_, msg }),
      sessionManager: { getSession: () => ({ id: 'sess-1' }) },
    })
    const result = resolveSessionOrError(
      ws,
      ctx,
      { sessionId: 'sess-1' },
      { boundSessionId: 'sess-other' }
    )
    assert.strictEqual(result, null)
    assert.strictEqual(sent[0].msg.type, 'session_error')
  })
})

// ============================================================
// requireSessionMethod — issue #4773
// ============================================================
//
// Wraps the "capability gate" pattern (6 occurrences across handlers):
//   if (typeof entry.session.setX !== 'function') {
//     ctx.transport.send(ws, { type: 'session_error', message: 'This provider does
//       not support X' })
//     return
//   }
// → if (!requireSessionMethod(ws, ctx, entry, 'setX',
//      'This provider does not support X')) return

describe('requireSessionMethod (#4773)', () => {
  it('returns true and emits nothing when the method exists', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    const entry = { session: { setX() {} } }
    const ok = requireSessionMethod(ws, ctx, entry, 'setX', 'unsupported')
    assert.strictEqual(ok, true)
    assert.strictEqual(sent.length, 0)
  })

  it('returns false and emits a session_error when the method is missing', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    const entry = { session: {} }
    const ok = requireSessionMethod(
      ws, ctx, entry, 'setX', 'This provider does not support X'
    )
    assert.strictEqual(ok, false)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].msg.type, 'session_error')
    assert.strictEqual(sent[0].msg.message, 'This provider does not support X')
  })

  it('returns false when entry is null', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    const ok = requireSessionMethod(ws, ctx, null, 'setX', 'nope')
    assert.strictEqual(ok, false)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].msg.message, 'nope')
  })

  it('returns false when entry.session is missing', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    const ok = requireSessionMethod(ws, ctx, {}, 'setX', 'nope')
    assert.strictEqual(ok, false)
    assert.strictEqual(sent.length, 1)
  })

  it('returns false when the property exists but is not a function', () => {
    const sent = []
    const ws = { readyState: 1, send: () => {} }
    const ctx = nsCtx({ send: (ws_, msg) => sent.push({ ws: ws_, msg }) })
    const entry = { session: { setX: 'not-a-function' } }
    const ok = requireSessionMethod(ws, ctx, entry, 'setX', 'nope')
    assert.strictEqual(ok, false)
    assert.strictEqual(sent.length, 1)
  })
})

describe('sendError fail-safe send guard (#5702 8a)', () => {
  it('does not throw when ctx.transport.send throws (torn-down socket)', () => {
    const ws = { readyState: 1 }
    const ctx = { transport: { send: () => { throw new Error('socket gone') } } }
    // A throw here would escape an error-reporting path (often a catch block).
    assert.doesNotThrow(() => sendError(ws, 'r1', 'BOOM', 'msg', undefined, ctx))
  })

  it('does not throw when the raw ws.send throws (no ctx / pre-auth)', () => {
    const ws = { readyState: 1, send: () => { throw new Error('socket gone') } }
    assert.doesNotThrow(() => sendError(ws, 'r2', 'BOOM', 'msg'))
  })

  it('still sends normally on the happy path', () => {
    const sent = []
    const ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) }
    sendError(ws, 'r3', 'CODE', 'message')
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].code, 'CODE')
  })
})

describe('getPermissionModes provider-aware copy (#6638)', () => {
  const idsOf = (modes) => modes.map((m) => m.id)
  const byId = (modes, id) => modes.find((m) => m.id === id)

  it('non-codex providers get the default (Claude) modes', () => {
    for (const p of [null, undefined, 'claude-sdk', 'gemini', 'unknown']) {
      assert.deepEqual(getPermissionModes(p), PERMISSION_MODES, `provider ${p} → default modes`)
    }
  })

  it('codex gets codex-tuned descriptions with the SAME mode ids', () => {
    const codex = getPermissionModes('codex')
    // ids are provider-independent (validation must stay uniform)
    assert.deepEqual(idsOf(codex), idsOf(PERMISSION_MODES))
    // but the descriptions are codex-specific — no Claude-only copy
    const joined = codex.map((m) => m.description).join(' ')
    assert.doesNotMatch(joined, /dangerously-skip-permissions/, 'no Claude CLI flag')
    assert.doesNotMatch(joined, /Read\/Write\/Edit/, 'no Claude tool names')
    assert.match(byId(codex, 'acceptEdits').description, /apply_patch/, 'names the codex edit tool')
    assert.match(byId(codex, 'plan').description, /no plan enforcement|behaves like Approve/i, 'plan ≈ approve for codex')
    assert.match(byId(codex, 'auto').description, /approvalPolicy/, 'names the codex bypass mechanism')
  })

  it('every codex mode has a non-empty label + description', () => {
    for (const m of getPermissionModes('codex')) {
      assert.ok(m.label && m.label.length > 0, `${m.id} has a label`)
      assert.ok(m.description && m.description.length > 0, `${m.id} has a description`)
    }
  })
})
