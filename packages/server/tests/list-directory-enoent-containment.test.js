import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { OUTSIDE_HOME_DIR } from './helpers/outside-home.js'

/**
 * #8011 — `list_directory` on a MISSING target must decide the home boundary
 * canonically, like every existing target already is.
 *
 * Its ENOENT fallback used `realAbsPath = absPath`, the raw lexical path, so
 * `~/link-to-outside/missing` (where `link-to-outside` points OUT of home)
 * looked like a path inside home, passed the check, and answered
 * "Directory not found" — while the same request for a subdirectory that DOES
 * exist out there resolved, failed the check, and answered "Access denied".
 * Two answers for one request, keyed on whether something outside home exists:
 * an existence oracle. Same class as #8000 in read_file.
 */
describe('list_directory: missing targets are contained canonically (#8011)', { skip: SKIP_NO_SYMLINK }, () => {
  let base

  function list(requestedPath) {
    const sent = []
    const ops = createBrowserOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
    )
    return ops.listDirectory(null, requestedPath).then(() => {
      assert.equal(sent.length, 1, 'exactly one directory_listing reply')
      return sent[0]
    })
  }

  beforeEach(() => {
    base = mkdtempSync(join(homedir(), '.chroxy-test-8011-'))
    mkdirSync(join(base, 'real-child'))
    // OUTSIDE_HOME_DIR is /etc on POSIX and %SystemRoot% on Windows: it exists,
    // it is outside every account's home, and nothing here writes into it.
    symlinkSync(OUTSIDE_HOME_DIR, join(base, 'link-to-outside'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('a MISSING target through an in-home link to outside answers "Access denied", not "Directory not found"', async () => {
    const reply = await list(join(base, 'link-to-outside', 'no-such-dir-8011'))
    assert.match(reply.error, /^Access denied/)
    assert.deepEqual(reply.entries, [])
  })

  it('CONTRAST: an EXISTING target through the same link also answers "Access denied" (the answer no longer depends on existence)', async () => {
    const reply = await list(join(base, 'link-to-outside'))
    assert.match(reply.error, /^Access denied/)
  })

  it('a missing target genuinely inside home still answers "Directory not found"', async () => {
    const reply = await list(join(base, 'no-such-dir-8011'))
    assert.equal(reply.error, 'Directory not found')
  })

  it('a missing target whose ancestor walk cannot finish answers "Access denied" (fails closed)', async () => {
    // 300 missing levels exceed realpathOfDeepestAncestor's 256-level ceiling,
    // so the walk throws ENAMETOOLONG. That is "could not check", which must
    // deny rather than surface the walk's own error text.
    const deep = join(base, ...Array.from({ length: 300 }, () => 'x'))
    const reply = await list(deep)
    assert.match(reply.error, /^Access denied/)
  })

  it('an existing directory inside home is still listed', async () => {
    const reply = await list(base)
    assert.equal(reply.error, null)
    assert.ok(reply.entries.some((e) => e.name === 'real-child'), 'real-child must be listed')
  })
})
