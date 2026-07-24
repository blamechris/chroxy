import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveTargetComponentwiseSync,
  resolveTargetComponentwiseAsync,
  splitPathBelowRoot,
  COMPONENTWISE_MAX_SYMLINKS,
} from '../src/utils/componentwise-resolver.js'

/**
 * #6923/#6928 — the SYNC (protected-path floor) and ASYNC (BYOK confinement)
 * open(2)-faithful resolvers were extracted into one shared module so they can no
 * longer drift (they were introduced as twins and #6928 was a bug present in BOTH).
 * This suite is the DRIFT TRIPWIRE: every case runs the SAME on-disk topology
 * through BOTH entry points and asserts they return the IDENTICAL result (and throw
 * the IDENTICAL error code). If a future edit changes one variant's ordering /
 * fail-closed behaviour but not the other, `assertParity` / `assertBothThrow` fail.
 */
describe('componentwise-resolver: sync ≡ async parity (#6923/#6928)', () => {
  let root
  beforeEach(() => {
    // realpath so the temp root has no symlink prefix of its own (macOS
    // /tmp -> /private/tmp) that would perturb the equality assertions.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-cw-resolver-')))
  })
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  // Run a (base, target) through both resolvers; assert they agree, and (if given)
  // that they resolve to `expected`. Returns the shared resolved value.
  async function assertParity(base, target, expected) {
    const s = resolveTargetComponentwiseSync(base, target)
    const a = await resolveTargetComponentwiseAsync(base, target)
    assert.equal(s, a, `sync and async must resolve IDENTICALLY for target=${JSON.stringify(target)}`)
    if (expected !== undefined) assert.equal(s, expected, `resolved value for target=${JSON.stringify(target)}`)
    return s
  }

  // Assert both resolvers fail closed with the same error code.
  async function assertBothThrow(base, target, code) {
    assert.throws(() => resolveTargetComponentwiseSync(base, target), (e) => e.code === code, `sync must throw ${code} for ${target}`)
    await assert.rejects(resolveTargetComponentwiseAsync(base, target), (e) => e.code === code, `async must throw ${code} for ${target}`)
  }

  it('ordinary relative new-file target', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    await assertParity(root, 'src/new.txt', join(root, 'src/new.txt'))
  })

  it('applies `..` AFTER following a symlink (the open(2) crux)', async () => {
    // link -> real/deep ; link/../sibling: follow link, `..` -> real, -> real/sibling
    mkdirSync(join(root, 'real/deep'), { recursive: true })
    symlinkSync(join(root, 'real/deep'), join(root, 'link'))
    await assertParity(root, 'link/../sibling', join(root, 'real/sibling'))
  })

  it('classic symlinked-parent escape resolves OUT of the base (both agree)', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-cw-outside-')))
    try {
      symlinkSync(outside, join(root, '.venv')) // .venv -> /outside
      const resolved = await assertParity(root, '.venv/bin/evil.sh')
      assert.ok(resolved.startsWith(outside + '/'), 'both chase the symlink to the outside location')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('benign `link/..` that lands back inside the base', async () => {
    mkdirSync(join(root, 'safe/other'), { recursive: true })
    symlinkSync(join(root, 'safe/other'), join(root, 'safe/inner'))
    await assertParity(join(root, 'safe'), 'inner/../file.js', join(root, 'safe/file.js'))
  })

  it('absolute target ignores the base and walks from the fs root', async () => {
    mkdirSync(join(root, 'a/b'), { recursive: true })
    await assertParity(join(root, 'unrelated'), join(root, 'a/b/c.txt'), join(root, 'a/b/c.txt'))
  })

  it('`..` in a to-be-created tail pops the RESOLVED real path', async () => {
    // link -> real ; link/nonexistent/../file: follow link -> real, then the tail
    // (nonexistent, .., file) applies pop/append against `real` -> real/file
    mkdirSync(join(root, 'real'), { recursive: true })
    symlinkSync(join(root, 'real'), join(root, 'link'))
    await assertParity(root, 'link/nonexistent/../file', join(root, 'real/file'))
  })

  // #6928 — separator-agnostic split: `\` and mixed separators must resolve exactly
  // like the forward-slash form (a POSIX `sep='/'` split would treat these as one
  // blob and fall back to a lexical join, reopening the `..`-after-symlink escape).
  it('#6928: backslash and mixed separators resolve identically to `/` (both agree)', async () => {
    mkdirSync(join(root, 'real/deep'), { recursive: true })
    symlinkSync(join(root, 'real/deep'), join(root, 'link'))
    const forms = [
      'link/../sibling',       // POSIX
      'link\\..\\sibling',     // all backslash
      'link/..\\sibling',      // mixed
    ]
    for (const f of forms) {
      await assertParity(root, f, join(root, 'real/sibling'))
    }
  })

  it('#6928: a rooted target strips its root; `..` at the fs root is a no-op', async () => {
    await assertParity(root, '/../..', '/')
  })

  // ==========================================================================
  // Fail-closed parity — both variants must throw the SAME code, never a guess.
  // ==========================================================================
  it('symlink cycle → both throw ELOOP', async () => {
    symlinkSync(join(root, 'b'), join(root, 'a')) // a -> b
    symlinkSync(join(root, 'a'), join(root, 'b')) // b -> a
    await assertBothThrow(root, 'a/x', 'ELOOP')
  })

  it(`a chain longer than COMPONENTWISE_MAX_SYMLINKS (${COMPONENTWISE_MAX_SYMLINKS}) → both throw ELOOP`, async () => {
    // s0 -> s1 -> s2 -> ... -> s(N+1) (a straight chain past the cap; every hop is
    // a distinct symlink so it never cycles, it just exceeds the budget).
    const N = COMPONENTWISE_MAX_SYMLINKS + 1
    for (let k = 0; k <= N; k++) {
      symlinkSync(join(root, `s${k + 1}`), join(root, `s${k}`))
    }
    await assertBothThrow(root, 's0', 'ELOOP')
  })

  it('EACCES on an unreadable directory propagates from both (fail closed)', async (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('root bypasses directory permission bits')
      return
    }
    // A symlink INTO a chmod-000 dir: resolving it must lstat inside the locked
    // dir, which EACCESes — and neither variant may swallow it into an allow.
    mkdirSync(join(root, 'locked'), { recursive: true })
    symlinkSync(join(root, 'locked/inner'), join(root, 'gate')) // gate -> locked/inner
    const { chmodSync } = await import('node:fs')
    chmodSync(join(root, 'locked'), 0o000)
    try {
      await assertBothThrow(root, 'gate/x', 'EACCES')
    } finally {
      chmodSync(join(root, 'locked'), 0o755) // restore so afterEach rm can clean up
    }
  })

  // ==========================================================================
  // splitPathBelowRoot — the #6928 footgun in isolation.
  // ==========================================================================
  it('splitPathBelowRoot splits on BOTH separators and strips the root', () => {
    assert.deepEqual(splitPathBelowRoot('a/b\\c', ''), ['a', 'b', 'c'])
    assert.deepEqual(splitPathBelowRoot('/a/b', '/'), ['a', 'b'])
    // collapses runs of mixed separators
    assert.deepEqual(splitPathBelowRoot('a//b\\\\c', ''), ['a', 'b', 'c'])
  })
})
