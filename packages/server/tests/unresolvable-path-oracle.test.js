import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, chmodSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createReaderOps } from '../src/ws-file-ops/reader.js'
import { createBrowserOps } from '../src/ws-file-ops/browser.js'
import {
  isUnresolvablePathWithin,
  resolveSessionCwd,
  validatePathWithinCwd,
} from '../src/ws-file-ops/common.js'
import { isPathWithin } from '../src/utils/path-containment.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { OUTSIDE_HOME_DIR } from './helpers/outside-home.js'

/**
 * #8012 — a `realpath()` failure other than ENOENT must not tell the client
 * anything about a path outside the boundary.
 *
 * `read_file`, `browse_files` and `list_directory` handled only ENOENT from
 * their first `realpath()`. Every other error skipped the containment check
 * and reached the generic outer catch, which
 *   - sent ELOOP's raw Node message, server-side absolute path included:
 *     "ELOOP: too many symbolic links encountered, realpath '/…/loop-a'";
 *   - mapped EACCES to "Permission denied" and ENOTDIR to "Not a directory"
 *     (or, in read_file, the raw ENOTDIR message).
 * So for a path OUTSIDE the boundary the client could tell apart "outside and
 * readable" ("Access denied: …"), "outside and missing", and "outside and
 * permission-blocked" / "outside and a file": an oracle.
 *
 * Now: outside the boundary, or a check that cannot be answered, is always
 * "Access denied: …". Inside it the specific message stays, since it is useful
 * there. Raw error text is never sent for these cases.
 */

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const SKIP_NO_CHMOD_DENY = process.platform === 'win32'
  ? 'chmod cannot deny directory search on win32'
  : IS_ROOT
    ? 'root bypasses directory permission bits'
    : false

function readerFor(sent) {
  return createReaderOps(
    (_ws, msg) => sent.push(msg),
    (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
    (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
  )
}

function browserFor(sent) {
  return createBrowserOps(
    (_ws, msg) => sent.push(msg),
    (cwd) => resolveSessionCwd(cwd, new Map(), 60_000),
    (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000),
  )
}

async function readFileReply(project, requested) {
  const sent = []
  await readerFor(sent).readFile(null, requested, project)
  assert.equal(sent.length, 1, 'exactly one file_content reply')
  return sent[0]
}

async function browseReply(project, requested) {
  const sent = []
  await browserFor(sent).browseFiles(null, requested, project)
  assert.equal(sent.length, 1, 'exactly one file_listing reply')
  return sent[0]
}

async function listReply(requested) {
  const sent = []
  await browserFor(sent).listDirectory(null, requested)
  assert.equal(sent.length, 1, 'exactly one directory_listing reply')
  return sent[0]
}

function assertNoRawError(reply, serverPath) {
  assert.ok(!/E[A-Z]{3,}:/.test(reply.error), `no raw Node error code in the reply: ${reply.error}`)
  assert.ok(!reply.error.includes(serverPath), `no server path in the reply: ${reply.error}`)
}

describe('project-bounded handlers: non-ENOENT realpath failures (#8012)', { skip: SKIP_NO_SYMLINK }, () => {
  let root
  let project
  let outside

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8012-')))
    project = join(root, 'project')
    outside = join(root, 'outside')
    mkdirSync(project)
    mkdirSync(outside)
    writeFileSync(join(project, 'present.txt'), 'hello\n')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(outside, join(project, 'escape'), 'dir')
    // A symlink cycle inside the project.
    symlinkSync(join(project, 'loop-b'), join(project, 'loop-a'), 'dir')
    symlinkSync(join(project, 'loop-a'), join(project, 'loop-b'), 'dir')
  })

  afterEach(() => {
    for (const dir of [join(outside, 'locked'), join(project, 'locked-in')]) {
      try { chmodSync(dir, 0o755) } catch { /* not created by this test */ }
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('read_file: a symlink cycle inside the project answers the generic denial, with no raw ELOOP text or server path', async () => {
    const reply = await readFileReply(project, 'loop-a')
    assert.match(reply.error, /^Access denied/)
    assertNoRawError(reply, root)
  })

  it('read_file: a link whose text leads back to itself answers the denial, with no raw text', async () => {
    // self -> missing/../self. POSIX realpath reports ENOENT (the helper then
    // throws ELOOP on its restart budget); win32 collapses the `..` and
    // reports ELOOP from realpath itself. Both must read the same.
    symlinkSync(['missing', '..', 'self'].join(sep), join(project, 'self'), 'dir')
    const reply = await readFileReply(project, 'self')
    assert.match(reply.error, /^Access denied/)
    assertNoRawError(reply, root)
  })

  it('read_file: a path through a FILE outside the project (ENOTDIR) answers "Access denied"', async () => {
    const reply = await readFileReply(project, join('escape', 'secret.txt', 'x'))
    assert.match(reply.error, /^Access denied/)
  })

  it('read_file: an in-project LINK whose own target cannot be resolved outside answers "Access denied"', async () => {
    // The walk stops AT the link (its target fails ENOTDIR). Stepping up past
    // it would land on the project and answer as if the path were inside.
    symlinkSync(join(outside, 'secret.txt', 'x'), join(project, 'to-file-child'), 'file')
    const reply = await readFileReply(project, 'to-file-child')
    assert.match(reply.error, /^Access denied/)
  })

  it('read_file: a path through a FILE inside the project answers "File not found", with no raw text', async () => {
    const reply = await readFileReply(project, join('present.txt', 'x'))
    assert.equal(reply.error, 'File not found')
  })

  it('read_file: an EACCES-blocked path OUTSIDE the project answers "Access denied", like an accessible one', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    mkdirSync(join(outside, 'locked'))
    chmodSync(join(outside, 'locked'), 0o000)
    const blocked = await readFileReply(project, join('escape', 'locked', 'x'))
    const readable = await readFileReply(project, join('escape', 'secret.txt'))
    assert.match(blocked.error, /^Access denied/)
    assert.equal(blocked.error, readable.error, 'blocked and readable outside paths must be indistinguishable')
  })

  it('CONTRAST read_file: an EACCES-blocked path INSIDE the project keeps "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    mkdirSync(join(project, 'locked-in'))
    chmodSync(join(project, 'locked-in'), 0o000)
    const reply = await readFileReply(project, join('locked-in', 'x'))
    assert.equal(reply.error, 'Permission denied')
  })

  it('browse_files: a symlink cycle answers the generic denial, with no raw ELOOP text or server path', async () => {
    const reply = await browseReply(project, 'loop-a')
    assert.match(reply.error, /^Access denied/)
    assertNoRawError(reply, root)
  })

  it('browse_files: an EACCES-blocked path OUTSIDE the project answers "Access denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    mkdirSync(join(outside, 'locked'))
    chmodSync(join(outside, 'locked'), 0o000)
    const reply = await browseReply(project, join('escape', 'locked', 'x'))
    assert.match(reply.error, /^Access denied/)
  })

  it('CONTRAST browse_files: an EACCES-blocked path INSIDE the project keeps "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    mkdirSync(join(project, 'locked-in'))
    chmodSync(join(project, 'locked-in'), 0o000)
    const reply = await browseReply(project, join('locked-in', 'x'))
    assert.equal(reply.error, 'Permission denied')
  })

  it('isUnresolvablePathWithin: the visible part of the path decides, and a cycle is never "within"', async () => {
    assert.equal(await isUnresolvablePathWithin(join(project, 'present.txt', 'x'), project), true)
    assert.equal(await isUnresolvablePathWithin(join(project, 'escape', 'secret.txt', 'x'), project), false)
    symlinkSync(join(outside, 'secret.txt', 'x'), join(project, 'to-file-child'), 'file')
    assert.equal(await isUnresolvablePathWithin(join(project, 'to-file-child'), project), false)
    assert.equal(await isUnresolvablePathWithin(join(project, 'loop-a'), project), false)
    assert.equal(await isUnresolvablePathWithin(join(project, 'loop-a', 'x'), project), false)
    // A boundary that could not be resolved is never "within".
    assert.equal(await isUnresolvablePathWithin(join(project, 'present.txt', 'x'), null), false)
  })

  it('read_file: a session cwd that cannot itself be resolved answers the denial, not "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    // The whole session cwd sits under a locked directory: realpath of the
    // target fails EACCES, and so does resolving the boundary it is judged by.
    mkdirSync(join(outside, 'locked'))
    mkdirSync(join(outside, 'locked', 'proj'))
    chmodSync(join(outside, 'locked'), 0o000)
    const reply = await readFileReply(join(outside, 'locked', 'proj'), 'x.txt')
    assert.match(reply.error, /^Access denied/)
  })
})

describe('list_directory: non-ENOENT realpath failures (#8012)', { skip: SKIP_NO_SYMLINK }, () => {
  let base
  let outside

  beforeEach(() => {
    base = mkdtempSync(join(homedir(), '.chroxy-test-8012-'))
    // OUTSIDE_HOME_DIR is /etc on POSIX and %SystemRoot% on Windows.
    symlinkSync(OUTSIDE_HOME_DIR, join(base, 'link-to-etc'), 'dir')
    symlinkSync(join(base, 'loop-b'), join(base, 'loop-a'), 'dir')
    symlinkSync(join(base, 'loop-a'), join(base, 'loop-b'), 'dir')
    outside = null
  })

  afterEach(() => {
    for (const dir of [outside && join(outside, 'locked'), join(base, 'locked-in')]) {
      if (!dir) continue
      try { chmodSync(dir, 0o755) } catch { /* not created by this test */ }
    }
    rmSync(base, { recursive: true, force: true })
    if (outside) rmSync(outside, { recursive: true, force: true })
  })

  it('a symlink cycle inside home answers the generic denial, with no raw ELOOP text or server path', async () => {
    const reply = await listReply(join(base, 'loop-a'))
    assert.match(reply.error, /^Access denied/)
    assertNoRawError(reply, base)
  })

  it('a path through a FILE outside home answers "Access denied", not "Not a directory"', async () => {
    const hostsDir = process.platform === 'win32' ? join('System32', 'drivers', 'etc', 'hosts') : 'hosts'
    const reply = await listReply(join(base, 'link-to-etc', hostsDir, 'x'))
    assert.match(reply.error, /^Access denied/)
  })

  it('an EACCES-blocked path OUTSIDE home answers "Access denied", not "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async (t) => {
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8012-out-')))
    if (isPathWithin(outside, realpathSync.native(homedir()))) {
      t.skip('tmpdir is inside home on this host, so there is no outside to lock')
      return
    }
    mkdirSync(join(outside, 'locked'))
    chmodSync(join(outside, 'locked'), 0o000)
    symlinkSync(outside, join(base, 'link-to-outside'), 'dir')
    const reply = await listReply(join(base, 'link-to-outside', 'locked', 'x'))
    assert.match(reply.error, /^Access denied/)
  })

  it('CONTRAST: an EACCES-blocked path INSIDE home keeps "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    mkdirSync(join(base, 'locked-in'))
    chmodSync(join(base, 'locked-in'), 0o000)
    const reply = await listReply(join(base, 'locked-in', 'x'))
    assert.equal(reply.error, 'Permission denied')
  })
})
