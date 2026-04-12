import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { realpathOfDeepestAncestor, validatePathWithinCwd } from '../src/ws-file-ops/common.js'

/**
 * Direct unit tests for the helpers in ws-file-ops/common.js — especially
 * realpathOfDeepestAncestor, which is the core of the 2026-04-11 audit
 * blocker-4 fix. These assert edge cases the integration tests in
 * write-file.test.js don't hit directly.
 */
describe('realpathOfDeepestAncestor', () => {
  let tmpDir
  const cwdRealCache = new Map()
  const cwdCacheTtl = 60_000

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'chroxy-common-'))
  })
  after(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects relative paths with EINVAL', async () => {
    await assert.rejects(
      realpathOfDeepestAncestor('relative/path'),
      (err) => err.code === 'EINVAL'
    )
  })

  it('resolves an existing path to its realpath', async () => {
    const sub = join(tmpDir, 'existing-sub')
    await mkdir(sub)
    const resolved = await realpathOfDeepestAncestor(sub)
    // On macOS /tmp may resolve to /private/tmp; just assert it ends with
    // the last segment since the prefix may be mangled by the OS.
    assert.ok(resolved.endsWith('/existing-sub'))
  })

  it('resolves a non-existent leaf by realpath-ing its parent and appending the leaf', async () => {
    const resolved = await realpathOfDeepestAncestor(join(tmpDir, 'does-not-exist.txt'))
    assert.ok(resolved.endsWith('/does-not-exist.txt'))
  })

  it('walks up through a symlinked parent to reveal an escape', async () => {
    // `escape-parent` is a symlink pointing OUT of tmpDir. The walker
    // should realpath `escape-parent` to the outside location and
    // reconstruct `<outside>/future-leaf.sh`.
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-unit-'))
    const escapeParent = join(tmpDir, 'escape-parent-unit')
    await symlink(outsideDir, escapeParent)
    try {
      const resolved = await realpathOfDeepestAncestor(join(escapeParent, 'future-leaf.sh'))
      // The resolved path must point into outsideDir, not tmpDir — that's
      // the symlink being correctly chased.
      assert.ok(resolved.endsWith('/future-leaf.sh'))
      assert.ok(!resolved.includes('escape-parent-unit'),
        'walker must have replaced the symlink name with its target')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('fails closed (throws ENAMETOOLONG) when the depth ceiling is hit (Copilot review on PR #2807)', async () => {
    // An attacker crafts a path with 300+ non-existent tail components
    // under a symlinked parent. The depth ceiling (256) would otherwise
    // bail out with the lexical path — which the old version of the fix
    // did — re-opening the exact bypass this helper was built to close.
    //
    // Post-fix: the walker throws ENAMETOOLONG and the caller's error
    // branch rejects the operation.
    const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-depthceil-'))
    const escapeParent = join(tmpDir, 'escape-depth-unit')
    await symlink(outsideDir, escapeParent)
    try {
      const tail = new Array(300).fill('x').join('/')
      const pathological = join(escapeParent, tail, 'evil.sh')
      await assert.rejects(
        realpathOfDeepestAncestor(pathological),
        (err) => err.code === 'ENAMETOOLONG'
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  describe('validatePathWithinCwd', () => {
    it('returns valid=false when path points outside CWD', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-vpc-'))
      try {
        const { valid } = await validatePathWithinCwd(
          join(outsideDir, 'file.txt'),
          tmpDir,
          cwdRealCache,
          cwdCacheTtl
        )
        assert.equal(valid, false)
      } finally {
        await rm(outsideDir, { recursive: true, force: true })
      }
    })

    it('returns valid=true when path points inside CWD', async () => {
      const { valid } = await validatePathWithinCwd(
        join(tmpDir, 'legit-file.txt'),
        tmpDir,
        cwdRealCache,
        cwdCacheTtl
      )
      assert.equal(valid, true)
    })

    it('propagates ENAMETOOLONG from the depth-ceiling fail-closed path', async () => {
      // Ensure the helper's throw reaches the caller rather than being
      // swallowed somewhere. (validatePathWithinCwd does not try/catch
      // the helper, so the rejection should escape cleanly.)
      const outsideDir = await mkdtemp(join(tmpdir(), 'chroxy-outside-vpc-ceil-'))
      const escape = join(tmpDir, 'escape-vpc-ceil')
      await symlink(outsideDir, escape)
      try {
        const tail = new Array(300).fill('y').join('/')
        const pathological = join(escape, tail, 'leaf.txt')
        await assert.rejects(
          validatePathWithinCwd(pathological, tmpDir, cwdRealCache, cwdCacheTtl),
          (err) => err.code === 'ENAMETOOLONG'
        )
      } finally {
        await rm(outsideDir, { recursive: true, force: true })
      }
    })
  })
})
