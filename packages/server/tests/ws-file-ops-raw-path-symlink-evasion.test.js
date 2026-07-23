import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateRawPathWithinCwd, resolveTargetComponentwiseAsync } from '../src/ws-file-ops/common.js'
import { executeBuiltinTool } from '../src/byok-tool-executor.js'

/**
 * #6923 — async parity for the `..`-after-symlink evasion, on the BYOK file-ops
 * confinement path (the async sibling of the sync protected-path floor closed in
 * #6921 / #6920). The old confinement pre-computed `absPath = resolve(cwd, path)`
 * and ran `realpathOfDeepestAncestor` over it — but BOTH `path.resolve()` AND
 * Node's `realpath` collapse `..` LEXICALLY, so a `..` that FOLLOWS a symlinked
 * component was cancelled textually before any symlink was followed. `open(2)`
 * (any raw `fs` write) follows the symlink FIRST and applies `..` from the target.
 *
 * The fix hands the RAW target (its `..` intact) to a COMPONENT-BY-COMPONENT walk
 * (`resolveTargetComponentwiseAsync`) via `validateRawPathWithinCwd`, so a symlink
 * that (with a trailing `..`) escapes the workspace is now resolved to its true
 * destination and rejected. Both PoCs below build the exact issue topologies on
 * REAL disk and PROVE (a) the raw path physically lands on the protected file, and
 * (b) the async confinement now FLAGS it (valid=false / the BYOK executor errors).
 */
describe('BYOK raw-path symlink-`..` evasion (#6923)', () => {
  let root
  const cwdRealCache = () => new Map()
  const cwdCacheTtl = 30_000

  beforeEach(() => {
    // realpath so the temp root has no symlink prefix of its own (macOS /tmp ->
    // /private/tmp) that would confuse the startsWith() containment assertions.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-raw-evasion-')))
  })
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  // ==========================================================================
  // PoC 1 — symlinked cwd-prefix + `..`. The REAL chroxy topology: the session
  // runs inside the worktree (.claude/worktrees/agent-x), and the protected
  // .claude/settings.local.json lives ABOVE it. `work -> .claude/worktrees`
  // (a plausible convenience symlink inside the worktree) plus a trailing `..`
  // climbs back up into the parent .claude, escaping the worktree cwd.
  // ==========================================================================
  it('PoC 1: `work/agent-x/../../settings.local.json` (work -> .claude/worktrees) resolves to the REAL .claude/settings.local.json and is flagged', async () => {
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    writeFileSync(join(root, '.claude/settings.local.json'), 'ORIGINAL')
    const cwd = join(root, '.claude/worktrees/agent-x') // session cwd = the worktree
    symlinkSync(join(root, '.claude/worktrees'), join(cwd, 'work'))
    const evasion = 'work/agent-x/../../settings.local.json'

    // path.resolve() LEXICALLY collapses the `..`s to a benign IN-cwd target —
    // exactly why the pre-fix (pre-`resolve()` + realpath) confinement missed it.
    assert.equal(resolve(cwd, evasion), join(cwd, 'settings.local.json'))
    assert.ok(resolve(cwd, evasion).startsWith(cwd + '/'), 'lexical resolve stays inside the worktree — the blind spot')

    // PROOF the target is genuinely dangerous: a raw open(2)-style write through
    // the exact path physically clobbers the REAL .claude/settings.local.json
    // (the file that governs the permission system itself). The write path is
    // built by STRING concat, NOT path.join — path.join would lexically collapse
    // the `..`s and never traverse the symlink.
    writeFileSync(`${cwd}/${evasion}`, 'PWNED')
    assert.equal(
      readFileSync(join(root, '.claude/settings.local.json'), 'utf8'),
      'PWNED',
      'the raw write really lands on the protected .claude/settings.local.json',
    )
    writeFileSync(join(root, '.claude/settings.local.json'), 'ORIGINAL') // reset

    // The async confinement now resolves the RAW path open(2)-faithfully to the
    // real protected file (ABOVE the worktree cwd) and FLAGS it as an escape.
    const { valid, realPath } = await validateRawPathWithinCwd(evasion, cwd, cwdRealCache(), cwdCacheTtl)
    assert.equal(valid, false, 'the symlink+`..` escape must be flagged (valid=false)')
    assert.equal(realPath, join(root, '.claude/settings.local.json'), 'realPath reflects the TRUE destination, not the lexical collapse')
  })

  it('PoC 1 end-to-end: the BYOK Write executor rejects the evasion and does NOT clobber the protected file', async () => {
    mkdirSync(join(root, '.claude/worktrees/agent-x'), { recursive: true })
    writeFileSync(join(root, '.claude/settings.local.json'), 'ORIGINAL')
    const cwd = join(root, '.claude/worktrees/agent-x')
    symlinkSync(join(root, '.claude/worktrees'), join(cwd, 'work'))

    const r = await executeBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'work/agent-x/../../settings.local.json', content: 'PWNED' },
      cwd,
      cwdRealCache: cwdRealCache(),
      cwdCacheTtl,
    })
    assert.equal(r.isError, true, 'the executor must reject the escape')
    assert.match(r.content, /outside workspace/)
    assert.equal(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'), 'ORIGINAL', 'protected file untouched')
  })

  // ==========================================================================
  // PoC 2 — symlinked TARGET component + `..`. glink -> repo/.git/hooks ;
  // `glink/../config` follows glink INTO .git/hooks, then `..` climbs to .git,
  // landing on .git/config (a credential file — a remote URL can embed a PAT),
  // which sits ABOVE the session cwd (repo/work).
  // ==========================================================================
  it('PoC 2: `glink/../config` (glink -> .git/hooks) resolves to the REAL .git/config and is flagged', async () => {
    mkdirSync(join(root, 'repo/.git/hooks'), { recursive: true })
    mkdirSync(join(root, 'repo/work'), { recursive: true })
    writeFileSync(join(root, 'repo/.git/config'), '[core]\n')
    const cwd = join(root, 'repo/work') // session runs in a repo subdir
    symlinkSync(join(root, 'repo/.git/hooks'), join(cwd, 'glink'))
    const evasion = 'glink/../config'

    // Lexically benign (glink/.. cancels) and IN-cwd — the old confinement missed it.
    assert.equal(resolve(cwd, evasion), join(cwd, 'config'))

    // PROOF: a raw write (STRING concat, not path.join) lands on the real .git/config.
    writeFileSync(`${cwd}/${evasion}`, 'PWNED')
    assert.equal(readFileSync(join(root, 'repo/.git/config'), 'utf8'), 'PWNED', 'the raw write really lands on .git/config')

    const { valid, realPath } = await validateRawPathWithinCwd(evasion, cwd, cwdRealCache(), cwdCacheTtl)
    assert.equal(valid, false, 'the glink+`..` escape must be flagged')
    assert.equal(realPath, join(root, 'repo/.git/config'), 'realPath reflects the TRUE .git/config destination')
  })

  // ==========================================================================
  // The component walk must NOT over-flag a benign `link/..` that lands safe.
  // ==========================================================================
  it('does NOT over-flag a benign `link/..` that resolves back INSIDE the cwd', async () => {
    // safe/inner -> safe/other ; `inner/../file.js` follows inner into other,
    // then `..` climbs back to safe -> safe/file.js. No escape: the walk resolves
    // the symlink correctly but the destination stays inside cwd, so valid=true.
    mkdirSync(join(root, 'safe/other'), { recursive: true })
    symlinkSync(join(root, 'safe/other'), join(root, 'safe/inner'))
    const cwd = join(root, 'safe')

    const { valid, realPath } = await validateRawPathWithinCwd('inner/../file.js', cwd, cwdRealCache(), cwdCacheTtl)
    assert.equal(valid, true, 'a symlink+`..` that lands back inside cwd must NOT be flagged')
    assert.equal(realPath, join(cwd, 'file.js'))

    // And it genuinely lands where we claim (safe/file.js).
    writeFileSync(`${cwd}/inner/../file.js`, 'x')
    assert.equal(readFileSync(join(root, 'safe/file.js'), 'utf8'), 'x')
  })

  it('accepts an ordinary relative new-file target under the cwd', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    const cwd = root
    const { valid, realPath } = await validateRawPathWithinCwd('src/new.txt', cwd, cwdRealCache(), cwdCacheTtl)
    assert.equal(valid, true)
    assert.equal(realPath, join(root, 'src/new.txt'))
  })

  // ==========================================================================
  // Fail-closed: a symlink CYCLE (or a chain past MAXSYMLINKS) must THROW so the
  // caller rejects the operation — never a lexical guess.
  // ==========================================================================
  it('fails closed (throws ELOOP) on a symlink cycle', async () => {
    symlinkSync(join(root, 'b'), join(root, 'a')) // a -> b
    symlinkSync(join(root, 'a'), join(root, 'b')) // b -> a
    await assert.rejects(
      validateRawPathWithinCwd('a/x', root, cwdRealCache(), cwdCacheTtl),
      (err) => err.code === 'ELOOP',
    )
  })

  it('BYOK executor surfaces the symlink cycle as a tool error (fail closed)', async () => {
    symlinkSync(join(root, 'b'), join(root, 'a'))
    symlinkSync(join(root, 'a'), join(root, 'b'))
    const r = await executeBuiltinTool({
      toolName: 'Read',
      input: { file_path: 'a/x' },
      cwd: root,
      cwdRealCache: cwdRealCache(),
      cwdCacheTtl,
    })
    assert.equal(r.isError, true)
  })

  // ==========================================================================
  // No regression: the classic symlinked-PARENT escape (no `..`) that the
  // original realpath-of-deepest-ancestor guard already caught stays rejected.
  // ==========================================================================
  it('still rejects the classic symlinked-parent escape (`.venv -> /outside`, `.venv/bin/evil.sh`)', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-raw-outside-')))
    try {
      symlinkSync(outside, join(root, '.venv'))
      const { valid, realPath } = await validateRawPathWithinCwd('.venv/bin/evil.sh', root, cwdRealCache(), cwdCacheTtl)
      assert.equal(valid, false, 'a symlinked parent pointing out of the workspace must be flagged')
      assert.ok(realPath.startsWith(outside + '/'), 'the walk chases the symlink to the outside location')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // ==========================================================================
  // resolveTargetComponentwiseAsync unit coverage — the open(2)-faithful crux.
  // ==========================================================================
  it('resolveTargetComponentwiseAsync applies `..` AFTER following a symlink (kernel order)', async () => {
    mkdirSync(join(root, 'real/deep'), { recursive: true })
    symlinkSync(join(root, 'real/deep'), join(root, 'link')) // link -> real/deep
    // link/../sibling: follow link -> real/deep, `..` -> real, sibling -> real/sibling
    const resolved = await resolveTargetComponentwiseAsync(root, 'link/../sibling')
    assert.equal(resolved, join(root, 'real/sibling'), '`..` must pop the symlink TARGET, not its lexical parent')
  })

  it('resolveTargetComponentwiseAsync walks an absolute target from the fs root, ignoring the base', async () => {
    mkdirSync(join(root, 'a/b'), { recursive: true })
    const resolved = await resolveTargetComponentwiseAsync(join(root, 'unrelated'), join(root, 'a/b/c.txt'))
    assert.equal(resolved, join(root, 'a/b/c.txt'))
  })
})
