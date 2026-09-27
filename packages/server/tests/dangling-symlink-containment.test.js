import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createReaderOps } from '../src/ws-file-ops/reader.js'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import {
  realpathOfDeepestAncestor,
  resolveSessionCwd,
  validatePathWithinCwd,
} from '../src/ws-file-ops/common.js'
import { isPathWithin } from '../src/utils/path-containment.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

/**
 * #8013 — a DANGLING symlink is a symlink, not a missing file.
 *
 * `realpathOfDeepestAncestor` treated every ENOENT from `realpath()` as "this
 * segment does not exist yet": it stepped up to the parent and re-appended the
 * name lexically. But `realpath()` also throws ENOENT AT a dangling symlink, so
 * a link inside the project pointing at a not-yet-existing path outside it was
 * judged an ordinary missing file inside the project:
 *
 *   project/dangling -> <outside>/missing-dir     (missing)
 *   read_file('dangling')  => 'File not found'
 *   mkdir <outside>/missing-dir
 *   read_file('dangling')  => 'Access denied: …'
 *
 * The answer depended on whether something outside the project exists: an
 * existence oracle. The walk now follows a dangling link to its target, so the
 * answer is the same either way.
 */
describe('realpathOfDeepestAncestor follows a dangling symlink to its target (#8013)', { skip: SKIP_NO_SYMLINK }, () => {
  let root
  let project
  let outside

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8013-')))
    project = join(root, 'project')
    outside = join(root, 'outside')
    mkdirSync(project)
    mkdirSync(outside)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('an ABSOLUTE dangling link to outside resolves outside the project', async () => {
    symlinkSync(join(outside, 'missing-dir'), join(project, 'dangling'), 'dir')
    const resolved = await realpathOfDeepestAncestor(join(project, 'dangling'))
    assert.equal(resolved, join(outside, 'missing-dir'))
  })

  it('a RELATIVE dangling link resolves against the directory the link lives in', async () => {
    symlinkSync(join('..', 'outside', 'missing-dir'), join(project, 'dangling-rel'), 'dir')
    const resolved = await realpathOfDeepestAncestor(join(project, 'dangling-rel'))
    assert.equal(resolved, join(outside, 'missing-dir'))
  })

  it('a RELATIVE dangling link reached through a symlinked directory resolves against its REAL parent', async () => {
    // project/via -> outside/dir, and outside/dir/rel -> ../x. The kernel reads
    // `../x` from outside/dir, so the target is outside/x. Resolving it against
    // the LEXICAL parent (project/via) would give project/x — inside — and turn
    // a path that was already judged outside into an in-project one.
    mkdirSync(join(outside, 'dir'))
    symlinkSync(join(outside, 'dir'), join(project, 'via'), 'dir')
    symlinkSync(join('..', 'x'), join(outside, 'dir', 'rel'), 'dir')
    const resolved = await realpathOfDeepestAncestor(join(project, 'via', 'rel'))
    assert.equal(resolved, join(outside, 'x'))
  })

  it('the tail BELOW a dangling link is re-appended under the link target', async () => {
    symlinkSync(join(outside, 'missing-dir'), join(project, 'dangling'), 'dir')
    const resolved = await realpathOfDeepestAncestor(join(project, 'dangling', 'a', 'leaf.txt'))
    assert.equal(resolved, join(outside, 'missing-dir', 'a', 'leaf.txt'))
  })

  it('a CHAIN of dangling links is followed to its last target', async () => {
    symlinkSync(join(project, 'second'), join(project, 'first'), 'dir')
    symlinkSync(join(outside, 'missing-dir'), join(project, 'second'), 'dir')
    const resolved = await realpathOfDeepestAncestor(join(project, 'first', 'leaf.txt'))
    assert.equal(resolved, join(outside, 'missing-dir', 'leaf.txt'))
  })

  it('a dangling link whose missing target is INSIDE the project stays inside (no over-denial)', async () => {
    symlinkSync(join(project, 'not-built-yet'), join(project, 'dangling-in'), 'dir')
    const resolved = await realpathOfDeepestAncestor(join(project, 'dangling-in', 'leaf.txt'))
    assert.equal(resolved, join(project, 'not-built-yet', 'leaf.txt'))
    assert.ok(isPathWithin(resolved, project))
  })

  it('validatePathWithinCwd judges a dangling link to outside as outside, whether or not its target exists', async () => {
    symlinkSync(join(outside, 'missing-dir'), join(project, 'dangling'), 'dir')
    const before = await validatePathWithinCwd(join(project, 'dangling'), project, new Map(), 60_000)
    mkdirSync(join(outside, 'missing-dir'))
    const after = await validatePathWithinCwd(join(project, 'dangling'), project, new Map(), 60_000)
    assert.equal(before.valid, false, 'target missing: must already be judged outside')
    assert.equal(after.valid, false, 'target present: outside')
  })
})

describe('the dashboard handlers give one answer for a dangling link to outside (#8013)', { skip: SKIP_NO_SYMLINK }, () => {
  let root
  let project
  let outside

  function reader() {
    const sent = []
    const ops = createReaderOps(
      (_ws, msg) => sent.push(msg),
      (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
      (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
    )
    return { ops, sent }
  }

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8013-h-')))
    project = join(root, 'project')
    outside = join(root, 'outside')
    mkdirSync(project)
    mkdirSync(outside)
    symlinkSync(join(outside, 'missing-dir'), join(project, 'dangling'), 'dir')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('read_file answers "Access denied" before AND after the outside target is created', async () => {
    const first = reader()
    await first.ops.readFile(null, 'dangling', project)
    mkdirSync(join(outside, 'missing-dir'))
    const second = reader()
    await second.ops.readFile(null, 'dangling', project)
    assert.equal(first.sent.length, 1)
    assert.equal(second.sent.length, 1)
    assert.match(first.sent[0].error, /^Access denied/, 'target missing: no "File not found" oracle')
    assert.match(second.sent[0].error, /^Access denied/)
  })

  it('read_file of a path BELOW the dangling link answers "Access denied"', async () => {
    const { ops, sent } = reader()
    await ops.readFile(null, join('dangling', 'leaf.txt'), project)
    assert.match(sent[0].error, /^Access denied/)
  })

  it('write_file below the dangling link is refused by containment and creates nothing outside', async () => {
    // Before #8013 this passed validation as an in-project new file and was
    // stopped only incidentally, by `mkdir -p` failing ENOENT on the dangling
    // component — and the reply carried that raw error, server path included.
    const { ops, sent } = reader()
    await ops.writeFile(null, join('dangling', 'new.txt'), 'pwned', project)
    assert.equal(sent.length, 1)
    assert.match(sent[0].error, /^Access denied/)
    assert.equal(existsSync(join(outside, 'missing-dir')), false, 'nothing may be created outside')
  })

  it('write_file AT the dangling link is refused and creates nothing outside', async () => {
    const { ops, sent } = reader()
    await ops.writeFile(null, 'dangling', 'pwned', project)
    assert.equal(sent.length, 1)
    assert.match(sent[0].error, /^Access denied/)
    assert.equal(existsSync(join(outside, 'missing-dir')), false, 'nothing may be created outside')
  })

  it('CONTRAST: a missing file genuinely inside the project still answers "File not found"', async () => {
    const { ops, sent } = reader()
    await ops.readFile(null, 'no-such-file.txt', project)
    assert.equal(sent[0].error, 'File not found')
  })
})

describe('list_directory gives one answer for a dangling in-home link to outside (#8013)', { skip: SKIP_NO_SYMLINK }, () => {
  let base
  let outside

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
    // The link lives inside home and points at a missing directory OUTSIDE it.
    // The outside side is a tmpdir this test owns; on hosts where the tmpdir
    // is itself under home the premise does not hold, so the test says so.
    base = mkdtempSync(join(homedir(), '.chroxy-test-8013-'))
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8013-out-')))
    symlinkSync(join(outside, 'missing-dir'), join(base, 'dangling'), 'dir')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('answers "Access denied" before AND after the outside target is created', async (t) => {
    if (isPathWithin(outside, realpathSync.native(homedir()))) {
      t.skip('tmpdir is inside home on this host, so there is no outside to point at')
      return
    }
    const before = await list(join(base, 'dangling'))
    mkdirSync(join(outside, 'missing-dir'))
    const after = await list(join(base, 'dangling'))
    assert.match(before.error, /^Access denied/, 'target missing: no "Directory not found" oracle')
    assert.match(after.error, /^Access denied/)
  })
})
