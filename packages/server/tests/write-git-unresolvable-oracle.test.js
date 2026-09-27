import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, chmodSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { POSIX_PERM_SKIP } from './test-helpers.js'

/**
 * #8016 — the write-side and git handlers had the #8012 residual: a
 * `realpath()` failure other than ENOENT skipped the containment answer and
 * reached a generic catch, which sent "Permission denied" for EACCES and
 * `err.message` — raw Node text with the server's absolute path — for the rest.
 * For a path OUTSIDE the project, "blocked" and "a file" were therefore
 * distinguishable from "readable or missing", which all answer "Access denied".
 *
 * Now: outside the project, or a check that cannot be answered, gets each
 * handler's usual denial; an in-project path keeps a short specific reason,
 * and no reply carries raw error text or a server path for these cases.
 */

// chmod cannot deny directory search on win32, and root bypasses it.
const SKIP_NO_CHMOD_DENY = POSIX_PERM_SKIP

describe('write_file / append_memory / git_stage / git_unstage: non-ENOENT realpath failures (#8016)', { skip: SKIP_NO_SYMLINK }, () => {
  let root
  let project
  let outside
  let sent
  let ops

  async function reply(call) {
    sent.length = 0
    await call()
    assert.equal(sent.length, 1, 'exactly one reply')
    return sent[0]
  }

  function assertNoRawError(msg) {
    assert.ok(!/E[A-Z]{3,}:/.test(msg.error), `no raw Node error code in the reply: ${msg.error}`)
    assert.ok(!msg.error.includes(root), `no server path in the reply: ${msg.error}`)
  }

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-8016-')))
    project = join(root, 'project')
    outside = join(root, 'outside')
    mkdirSync(project)
    mkdirSync(outside)
    writeFileSync(join(project, 'present.txt'), 'hello\n')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(outside, join(project, 'escape'), 'dir')
    symlinkSync(join(project, 'loop-b'), join(project, 'loop-a'), 'dir')
    symlinkSync(join(project, 'loop-a'), join(project, 'loop-b'), 'dir')
    sent = []
    // workspaceRoot = root, so the project passes validateGitPath and every
    // answer below comes from the per-file check.
    ops = createFileOps((_ws, msg) => sent.push(msg), root)
  })

  afterEach(() => {
    for (const dir of [project, join(outside, 'locked'), join(project, 'locked-in')]) {
      try { chmodSync(dir, 0o755) } catch { /* not created by this test */ }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function lockOutside() {
    mkdirSync(join(outside, 'locked'))
    chmodSync(join(outside, 'locked'), 0o000)
  }

  function lockInside() {
    mkdirSync(join(project, 'locked-in'))
    chmodSync(join(project, 'locked-in'), 0o000)
  }

  // ── write_file ─────────────────────────────────────────────────────────────

  it('write_file: a symlink cycle answers the denial, with no raw ELOOP text or server path', async () => {
    const msg = await reply(() => ops.writeFile(null, 'loop-a', 'x', project))
    assert.match(msg.error, /^Access denied/)
    assertNoRawError(msg)
  })

  it('write_file: a path through a FILE outside the project answers "Access denied"', async () => {
    const msg = await reply(() => ops.writeFile(null, join('escape', 'secret.txt', 'x'), 'x', project))
    assert.match(msg.error, /^Access denied/)
    assertNoRawError(msg)
  })

  it('write_file: a path through a FILE inside the project keeps a specific reason, with no raw text', {
    skip: process.platform === 'win32'
      ? 'win32 realpath reports ENOENT through a file, so this is the new-file route, not a realpath failure'
      : false,
  }, async () => {
    const msg = await reply(() => ops.writeFile(null, join('present.txt', 'x'), 'x', project))
    assert.equal(msg.error, 'Not a directory')
    assertNoRawError(msg)
  })

  it('write_file: a link whose text leads back to itself answers the denial, at and below it', async () => {
    // self -> missing/../self. POSIX realpath says ENOENT, so this is the
    // new-file route and its validation throws ELOOP; win32 says ELOOP from
    // realpath. Both must deny without the helper's own text.
    symlinkSync(['missing', '..', 'self'].join(sep), join(project, 'self'), 'dir')
    for (const target of ['self', join('self', 'new.txt')]) {
      const msg = await reply(() => ops.writeFile(null, target, 'x', project))
      assert.match(msg.error, /^Access denied/, target)
      assert.ok(!msg.error.includes('realpathOfDeepestAncestor'), `no helper text: ${msg.error}`)
    }
  })

  it('write_file: an EACCES-blocked path OUTSIDE the project answers like an accessible one', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    lockOutside()
    const blocked = await reply(() => ops.writeFile(null, join('escape', 'locked', 'x'), 'x', project))
    const open = await reply(() => ops.writeFile(null, join('escape', 'new.txt'), 'x', project))
    assert.match(blocked.error, /^Access denied/)
    assert.equal(blocked.error, open.error)
    assert.equal(existsSync(join(outside, 'new.txt')), false)
  })

  it('CONTRAST write_file: an EACCES-blocked path INSIDE the project keeps "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    lockInside()
    const msg = await reply(() => ops.writeFile(null, join('locked-in', 'x'), 'x', project))
    assert.equal(msg.error, 'Permission denied')
  })

  // ── append_memory (the fixed CLAUDE.md name) ───────────────────────────────

  it('append_memory: a CLAUDE.md symlink cycle answers the denial, with no raw ELOOP text or server path', async () => {
    symlinkSync('CLAUDE.md', join(project, 'CLAUDE.md'), 'file')
    const msg = await reply(() => ops.appendMemory(null, 'note', project))
    assert.match(msg.error, /^Access denied/)
    assertNoRawError(msg)
  })

  it('append_memory: a CLAUDE.md whose link text leads back to itself answers the denial', async () => {
    symlinkSync(['missing', '..', 'CLAUDE.md'].join(sep), join(project, 'CLAUDE.md'), 'file')
    const msg = await reply(() => ops.appendMemory(null, 'note', project))
    assert.match(msg.error, /^Access denied/)
    assert.ok(!msg.error.includes('realpathOfDeepestAncestor'), `no helper text: ${msg.error}`)
  })

  it('CONTRAST append_memory: a project directory that cannot be searched keeps "Permission denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    // realpath(project/CLAUDE.md) fails EACCES, but the project itself is the
    // deepest ancestor that resolves, so the path is inside: the reason stays.
    chmodSync(project, 0o000)
    const msg = await reply(() => ops.appendMemory(null, 'note', project))
    assert.equal(msg.error, 'Permission denied')
  })

  it('append_memory: CLAUDE.md linked into an EACCES-blocked OUTSIDE dir answers "Access denied"', { skip: SKIP_NO_CHMOD_DENY }, async () => {
    lockOutside()
    symlinkSync(join(outside, 'locked', 'CLAUDE.md'), join(project, 'CLAUDE.md'), 'file')
    const msg = await reply(() => ops.appendMemory(null, 'note', project))
    assert.match(msg.error, /^Access denied/)
  })

  // ── git_stage / git_unstage ────────────────────────────────────────────────

  for (const [name, call] of [
    ['git_stage', (o, file, cwd) => o.gitStage(null, [file], cwd)],
    ['git_unstage', (o, file, cwd) => o.gitUnstage(null, [file], cwd)],
  ]) {
    it(`${name}: a symlink cycle answers the denial, with no raw ELOOP text or server path`, async () => {
      const msg = await reply(() => call(ops, 'loop-a', project))
      assert.equal(msg.error, 'Access denied: path outside project directory — loop-a')
      assertNoRawError(msg)
    })

    it(`${name}: a path through a FILE outside the project answers "Access denied"`, async () => {
      const file = join('escape', 'secret.txt', 'x')
      const msg = await reply(() => call(ops, file, project))
      assert.equal(msg.error, `Access denied: path outside project directory — ${file}`)
    })

    it(`${name}: an EACCES-blocked path OUTSIDE the project answers like an accessible one`, { skip: SKIP_NO_CHMOD_DENY }, async () => {
      lockOutside()
      const file = join('escape', 'locked', 'x')
      const msg = await reply(() => call(ops, file, project))
      assert.equal(msg.error, `Access denied: path outside project directory — ${file}`)
      assertNoRawError(msg)
    })

    it(`CONTRAST ${name}: an EACCES-blocked path INSIDE the project keeps a specific reason`, { skip: SKIP_NO_CHMOD_DENY }, async () => {
      lockInside()
      const file = join('locked-in', 'x')
      const msg = await reply(() => call(ops, file, project))
      assert.equal(msg.error, `Permission denied — ${file}`)
    })
  }
})
