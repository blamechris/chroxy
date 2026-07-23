import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager, isProtectedPathTarget, isSecretReadTarget } from '../src/permission-manager.js'

/**
 * #6851 — the protected-path floor resolves SYMLINKS before the segment scan.
 *
 * The #6794/#6806/#6803 floor was LEXICAL-only: it string-resolved targets with
 * `path.resolve`/`path.relative` and never touched the filesystem. A symlink in
 * the session cwd's PREFIX (the chroxy agent worktree can live under a *symlink*
 * to a real `.claude/`), or a symlinked COMPONENT of the target, could make a
 * path that lexically looks OUTSIDE a protected dir RESOLVE INTO `.git`/`.claude`
 * (or a secret/credential file), escaping the floor.
 *
 * #6851 adds a second pass that resolves the REAL (symlink-followed) paths of
 * both the base and the target and re-runs the same scan. These tests build
 * REAL on-disk symlink topologies under a temp dir (the synthetic string-only
 * fixtures in the sibling floor suites can't exercise fs symlink resolution),
 * and assert the evasions are now caught — via the exported pure matchers AND
 * end-to-end through handlePermission (a floor forces a PROMPT, never a deny).
 *
 * Fail-closed: an unresolvable path (symlink cycle → ELOOP) is treated as
 * protected, never as safe.
 */

const silentLog = { info() {}, warn() {} }

/** Make a fresh temp root and return its REAL path (macOS tmpdir is itself
 *  under a `/var → /private/var` firmlink; realpath gives a stable base). */
function mkRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-floor-sym-')))
}

describe('protected-path floor resolves symlinks (#6851)', () => {
  let root
  const roots = []

  beforeEach(() => {
    root = mkRoot()
    roots.push(root)
  })

  afterEach(() => {
    while (roots.length) {
      const r = roots.pop()
      try { rmSync(r, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  // -- The exact issue repro: a symlinked cwd PREFIX + `..` into the real .claude --

  it('floors a `..` traversal through a SYMLINKED cwd prefix into the real .claude', () => {
    // work -> .claude/worktrees ; the session runs in work/agent-x, whose REAL
    // location is .claude/worktrees/agent-x. `../../foo.js` lexically resolves to
    // <root>/foo.js (benign — NOT floored lexically), but the real target is
    // <root>/.claude/foo.js (inside the REAL .claude).
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    symlinkSync(join(root, '.claude/worktrees'), join(root, 'work'))
    const symCwd = join(root, 'work/agent-x')

    assert.equal(
      isProtectedPathTarget({ file_path: '../../foo.js' }, symCwd),
      true,
      'a symlinked-prefix `..` into the real .claude must be floored',
    )
  })

  it('CONTRAST: the same `..` from a NON-symlinked prefix is NOT floored (proves the symlink is what triggers it)', () => {
    // work2 is a REAL directory (no symlink). `../../foo.js` resolves to
    // <root>/foo.js both lexically AND really — no protected segment.
    mkdirSync(join(root, 'work2/agent-x'), { recursive: true })
    const realCwd = join(root, 'work2/agent-x')

    assert.equal(
      isProtectedPathTarget({ file_path: '../../foo.js' }, realCwd),
      false,
      'without a prefix symlink the same traversal stays benign',
    )
  })

  it('preserves the #6794 worktree guard: a benign in-workspace write through the symlinked cwd is NOT floored', () => {
    mkdirSync(join(root, '.claude/worktrees/agent-x/packages/server'), { recursive: true })
    symlinkSync(join(root, '.claude/worktrees'), join(root, 'work'))
    const symCwd = join(root, 'work/agent-x')

    assert.equal(isProtectedPathTarget({ file_path: 'packages/server/foo.js' }, symCwd), false)
    // Also holds when addressed via the session's REAL cwd (the real worktree topology).
    const realCwd = join(root, '.claude/worktrees/agent-x')
    assert.equal(isProtectedPathTarget({ file_path: 'packages/server/foo.js' }, realCwd), false)
  })

  // -- A symlinked directory COMPONENT of the target pointing into a protected dir --

  it('floors a target whose SYMLINKED component resolves into .claude', () => {
    // proj/logs -> .claude ; `logs/x.json` lexically has no `.claude` segment,
    // but resolves to <root>/.claude/x.json.
    mkdirSync(join(root, 'proj'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    symlinkSync(join(root, '.claude'), join(root, 'proj/logs'))
    const cwd = join(root, 'proj')

    assert.equal(isProtectedPathTarget({ file_path: 'logs/x.json' }, cwd), true)
  })

  it('floors a symlinked .git DIRECTORY component under BOTH the write floor and the read (credential) floor', () => {
    // repo/gitlink -> repo/.git ; `gitlink/config` lexically has no `.git`
    // segment, but resolves to repo/.git/config — a credential-dense file the
    // READ floor must catch too (a remote URL can embed a PAT).
    mkdirSync(join(root, 'repo/.git'), { recursive: true })
    writeFileSync(join(root, 'repo/.git/config'), '[remote]\n')
    symlinkSync(join(root, 'repo/.git'), join(root, 'repo/gitlink'))
    const cwd = join(root, 'repo')

    assert.equal(isProtectedPathTarget({ file_path: 'gitlink/config' }, cwd), true, 'write floor')
    assert.equal(isSecretReadTarget({ file_path: 'gitlink/config' }, cwd), true, 'read/credential floor')
  })

  // -- The ENOENT / to-be-created-file path (deepest existing ancestor) --

  it('floors a NOT-YET-CREATED file under a symlinked-into-.claude dir (deepest existing ancestor)', () => {
    // proj/logs -> .claude ; the leaf and intermediate dirs do NOT exist yet, so
    // a naive "realpath the whole target, fall back to lexical on ENOENT" would
    // miss the `logs` symlink. Walking to the deepest existing ancestor (logs →
    // .claude) closes it.
    mkdirSync(join(root, 'proj'), { recursive: true })
    mkdirSync(join(root, '.claude'), { recursive: true })
    symlinkSync(join(root, '.claude'), join(root, 'proj/logs'))
    const cwd = join(root, 'proj')

    assert.equal(isProtectedPathTarget({ file_path: 'logs/new/deep/created.js' }, cwd), true)
  })

  // -- Reverse direction: a symlink pointing OUT must NOT be over-blocked --

  it('does NOT over-block: an in-cwd symlink pointing OUT to a benign location stays unfloored', () => {
    // The session's real cwd is under .claude/worktrees; `outlink` inside it
    // points OUT to a plain sibling dir. Writing through it lands on a benign
    // path — must not be floored just because cwd sits under a `.claude`.
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    mkdirSync(join(root, 'plain'), { recursive: true })
    symlinkSync(join(root, 'plain'), join(root, '.claude/worktrees/agent-x/outlink'))
    const cwd = join(root, '.claude/worktrees/agent-x')

    assert.equal(isProtectedPathTarget({ file_path: 'outlink/a.js' }, cwd), false)
  })

  // -- Fail-closed: an unresolvable path (symlink cycle) is treated as protected --

  it('FAILS CLOSED on a symlink cycle (ELOOP): an unresolvable target is floored, not assumed safe', () => {
    // a -> b, b -> a ; realpath'ing a/x throws ELOOP. The floor treats a
    // resolution error as protected (force the prompt), never as safe.
    symlinkSync('b', join(root, 'a'))
    symlinkSync('a', join(root, 'b'))
    const cwd = root

    // Sanity: the target is lexically benign (a/x has no protected segment), so
    // the flooring here comes purely from the fail-closed resolution error.
    assert.equal(isProtectedPathTarget({ file_path: 'a/x' }, cwd), true)
  })

  // -- End-to-end: the evasion falls through handlePermission to a PROMPT --

  it('end-to-end: auto mode + a symlink-evasion write falls through to the prompt (not auto-approved)', async () => {
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    symlinkSync(join(root, '.claude/worktrees'), join(root, 'work'))
    const symCwd = join(root, 'work/agent-x')
    const pm = new PermissionManager({ log: silentLog, cwd: symCwd })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const promise = pm.handlePermission('Write', { file_path: '../../foo.js' }, null, 'auto')
      assert.equal(events.length, 1, 'a symlink evasion into the real .claude must prompt even under auto/bypass')

      pm.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    } finally {
      pm.destroy()
    }
  })

  it('end-to-end: a benign in-workspace write through the symlinked cwd stays auto-approved', async () => {
    mkdirSync(join(root, '.claude/worktrees/agent-x/src'), { recursive: true })
    symlinkSync(join(root, '.claude/worktrees'), join(root, 'work'))
    const symCwd = join(root, 'work/agent-x')
    const pm = new PermissionManager({ log: silentLog, cwd: symCwd })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const result = await pm.handlePermission('Write', { file_path: 'src/foo.js' }, null, 'auto')
      assert.equal(result.behavior, 'allow', 'a benign in-workspace write must not be floored by the symlink pass')
      assert.equal(events.length, 0)
    } finally {
      pm.destroy()
    }
  })
})
