import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  // ==========================================================================
  // #6921 — RESIDUAL evasion: a `..` AFTER a symlinked component. The #6851
  // symlink pass used `realpathDeepestAncestorSync(resolve(realBase, target))`,
  // and BOTH `path.resolve()` AND Node's `fs.realpathSync` collapse `..`
  // LEXICALLY — so `link/../x` cancelled the symlink textually before it was
  // ever followed. `open(2)` (any raw `fs` write/read) follows `link` FIRST and
  // applies `..` from the TARGET, landing in the protected dir. The two PoCs
  // below build the exact topologies from the issue and PROVE, with real
  // on-disk writes, that (a) the raw path physically lands on the protected
  // file, and (b) the floor now FLAGS it — closing the gap.
  // ==========================================================================

  it('PoC #6921/1: `work/agent-x/../../settings.local.json` from repo root is floored, and a raw write proves it lands on the REAL .claude/settings.local.json', () => {
    // The REAL chroxy topology — no attacker-planted symlink: work -> .claude/worktrees.
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    writeFileSync(join(root, '.claude/settings.local.json'), 'ORIGINAL')
    symlinkSync(join(root, '.claude/worktrees'), join(root, 'work'))
    const cwd = root // session runs at the repo root
    const evasion = 'work/agent-x/../../settings.local.json'

    // path.resolve() still LEXICALLY collapses the `..`s to a benign target —
    // this is exactly why the pre-#6921 (lexical + realpath) floor missed it.
    assert.equal(resolve(cwd, evasion), join(root, 'settings.local.json'))

    // PROOF the target is genuinely dangerous: a raw open(2)-style write through
    // the exact path physically clobbers the REAL .claude/settings.local.json
    // (the file that governs the permission system itself). NOTE: the write path
    // is built by STRING concat, not path.join — path.join would lexically
    // collapse the `..`s (exactly the bug), never traversing the symlink.
    writeFileSync(`${cwd}/${evasion}`, 'PWNED')
    assert.equal(
      readFileSync(join(root, '.claude/settings.local.json'), 'utf8'),
      'PWNED',
      'the raw write really lands on the protected .claude/settings.local.json',
    )

    // The floor now FLAGS it — under BOTH the write floor and the read/credential
    // floor (settings*.json is credential-dense: may hold ANTHROPIC_API_KEY).
    assert.equal(isProtectedPathTarget({ file_path: evasion }, cwd), true, 'write floor must flag the symlink+`..` evasion')
    assert.equal(isSecretReadTarget({ file_path: evasion }, cwd), true, 'read/credential floor must flag settings.local.json')
  })

  it('PoC #6921/2: `glink/../config` where glink -> .git/hooks is floored under BOTH floors, and a raw write proves it lands on the REAL .git/config', () => {
    // glink -> repo/.git/hooks ; `glink/../config` follows glink into .git/hooks,
    // then `..` climbs to .git, landing on .git/config — a credential file (a
    // remote URL can embed a PAT).
    mkdirSync(join(root, 'repo/.git/hooks'), { recursive: true })
    writeFileSync(join(root, 'repo/.git/config'), '[core]\n')
    symlinkSync(join(root, 'repo/.git/hooks'), join(root, 'repo/glink'))
    const cwd = join(root, 'repo')
    const evasion = 'glink/../config'

    // Lexically benign (glink/.. cancels to nothing) — the old floor missed it.
    assert.equal(resolve(cwd, evasion), join(root, 'repo/config'))

    // PROOF: a raw write really lands on the real .git/config (STRING concat, not
    // path.join — join would collapse `glink/..` lexically and miss the symlink).
    writeFileSync(`${cwd}/${evasion}`, 'PWNED')
    assert.equal(readFileSync(join(root, 'repo/.git/config'), 'utf8'), 'PWNED', 'the raw write really lands on .git/config')

    // Floored under BOTH the write floor and the read/credential floor.
    assert.equal(isProtectedPathTarget({ file_path: evasion }, cwd), true, 'write floor')
    assert.equal(isSecretReadTarget({ file_path: evasion }, cwd), true, 'read/credential floor (.git/config embeds PATs)')
  })

  // -- The component walk must NOT over-flag a benign `link/..` that lands safe --

  it('does NOT over-flag a benign `link/..`: a symlink followed by `..` that resolves to a SAFE location stays unfloored', () => {
    // safe/inner -> safe/other ; `inner/../file.js` follows inner into other,
    // then `..` climbs back to safe → safe/file.js. No protected segment: the
    // component walk resolves the symlink correctly but the destination is benign,
    // so the floor must not flag it (proving the fix isn't just "flag anything
    // with a symlink and a `..`").
    mkdirSync(join(root, 'safe/other'), { recursive: true })
    symlinkSync(join(root, 'safe/other'), join(root, 'safe/inner'))
    const cwd = join(root, 'safe')

    assert.equal(isProtectedPathTarget({ file_path: 'inner/../file.js' }, cwd), false)
    // And it genuinely lands where we claim (safe/file.js), not in a protected dir.
    writeFileSync(`${cwd}/inner/../file.js`, 'x')
    assert.equal(readFileSync(join(root, 'safe/file.js'), 'utf8'), 'x')
  })

  it('end-to-end: the PoC #6921/1 evasion falls through handlePermission to a PROMPT under auto mode', async () => {
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    writeFileSync(join(root, '.claude/settings.local.json'), 'ORIGINAL')
    symlinkSync(join(root, '.claude/worktrees'), join(root, 'work'))
    const pm = new PermissionManager({ log: silentLog, cwd: root })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      const promise = pm.handlePermission('Write', { file_path: 'work/agent-x/../../settings.local.json' }, null, 'auto')
      assert.equal(events.length, 1, 'the `..`-after-symlink evasion must prompt even under auto/bypass')

      pm.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    } finally {
      pm.destroy()
    }
  })

  // ==========================================================================
  // PR #6920 review (Copilot) — the SYMLINK pass must NEVER frame the floor
  // against the SERVER process cwd. It resolves the real base via
  // `realpathDeepestAncestorSync(base)`, whose absolute-path guard THROWS on a
  // relative base — so a relative/`..`-laden session cwd (a defensive edge the
  // codebase guards against elsewhere, e.g. audit-key normalization) FAILS
  // CLOSED (the target is treated as protected → prompt) instead of being
  // silently reframed against `process.cwd()` (the WRONG root). Wrapping `base`
  // in `resolve()` would coerce a relative base against process.cwd() and defeat
  // that guard; these tests pin the fail-closed behavior.
  // ==========================================================================

  it('FAILS CLOSED on a RELATIVE base: a lexically-benign target under a relative session cwd is floored, not framed against process.cwd()', () => {
    // The target has no protected segment, so the LEXICAL pass cannot flag it —
    // the flooring here comes purely from the symlink pass fail-closing on the
    // relative base (`realpathDeepestAncestorSync` throws EINVAL on a non-absolute
    // path). A deterministic assertion: it does not depend on process.cwd().
    const relativeCwd = 'relative/session/dir'

    assert.equal(
      isProtectedPathTarget({ file_path: 'foo.js' }, relativeCwd),
      true,
      'a relative base must fail closed (protected), never resolve against process.cwd()',
    )
    // The read/credential floor takes the same base → same fail-closed outcome.
    assert.equal(
      isSecretReadTarget({ file_path: 'foo.js' }, relativeCwd),
      true,
      'the read floor must also fail closed on a relative base',
    )
  })

  it('FAILS CLOSED on a `..`-laden relative base too (still non-absolute → guard throws)', () => {
    assert.equal(
      isProtectedPathTarget({ file_path: 'foo.js' }, '../up/one/dir'),
      true,
      'a `..`-laden relative base is still non-absolute and must fail closed',
    )
  })

  it('CONTRAST: an ABSOLUTE base with the same benign target is NOT floored (proves the relative base is what fails closed)', () => {
    // The same benign target under an absolute, real, existing cwd stays
    // unfloored — the 14 absolute-base fixtures are unaffected by the fix.
    assert.equal(
      isProtectedPathTarget({ file_path: 'foo.js' }, root),
      false,
      'an absolute existing base resolves normally and a benign target is not floored',
    )
  })
})
