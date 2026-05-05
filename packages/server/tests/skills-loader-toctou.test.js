/**
 * Inter-pass TOCTOU detection tests for the two-pass priority-aware tier
 * budget introduced in #3279. Covers the two guards in the pass-2 cache-miss
 * path of `_collectCandidates` / `loadActiveSkills`:
 *
 *   1. Symlink swap detection — `realPath2 !== realPath`: the resolved path
 *      drifted between pass 1 and pass 2, indicating a symlink was redirected.
 *
 *   2. File replacement detection (inode change) — Guard 2:
 *      `fstat2.dev !== fstatSnap.dev || fstat2.ino !== fstatSnap.ino`:
 *      the file at the path was replaced between passes (new inode).
 *
 * Requires: --experimental-test-module-mocks (added to the test script).
 *
 * Mock strategy: call mock.module('fs') BEFORE importing skills-loader.js.
 * Named imports in skills-loader.js (`import { realpathSync } from 'fs'`) are
 * then bound to the mock implementations, letting us return different values on
 * the pass-2 call vs the pass-1 call to simulate the race deterministically.
 *
 * Guard 1 (symlink swap):
 *   On macOS, tmpdir() resolves to /private/var/... but the dir string uses
 *   /var/... (which is a symlink). So realpathSync(dir/s.md) returns
 *   /private/var/.../s.md (resolved), while the original fullPath is
 *   /var/.../s.md. The mock returns fullPath on the pass-2 call, producing
 *   a different string that still refers to the same inode — so all subsequent
 *   guards (inner inode check, Guard 2) pass when Guard 1 is disabled, making
 *   the test causally sensitive to Guard 1.
 *   On Linux where tmpdir() is not a symlink, fullPath and realpathSync(fullPath)
 *   are the same string. In that case the test falls back to returning a
 *   non-existent fabricated path; the skill is still dropped, but through the
 *   subsequent statSync-failure catch rather than Guard 1 exclusively.
 *
 * Guard 2 (inode change):
 *   Both fstatSync (pass 2) and statSync for realPath2 are mocked to return
 *   a consistent but different ino (real_ino + 100000). This lets the inner
 *   fd-vs-realpath guard (fstat2 vs realStat2) PASS while Guard 2
 *   (fstat2 vs fstatSnap) FIRES, making the test causally specific to Guard 2.
 *   A shared `fabricatedIno` variable is set lazily by fstatSync and read by
 *   statSync so they stay in sync.
 *
 * Refs #3286 / #3279 / #3285
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Guard: skip silently if mock.module is not available ──────────────────
// mock.module requires --experimental-test-module-mocks. The test runner
// command passes this flag; if for any reason the tests are run without it,
// we emit a single skip rather than hard-failing the suite.
if (typeof mock.module !== 'function') {
  describe('inter-pass TOCTOU detection (#3286)', () => {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
    })
  })
} else {
  // Capture a reference to the real fs BEFORE the mock is installed.
  const realFs = await import('fs')

  // ─── Mutable state shared by mock functions ───────────────────────────
  // All state is reset in beforeEach for test isolation.

  // Guard 1 controls: path-based interception of realpathSync.
  // On the second call for `realpathInterceptPath`, the mock returns
  // `realpathSwapReturnValue` instead of the real resolved path.
  let realpathInterceptPath = null
  let realpathCallsByPath = Object.create(null)
  let realpathSwapReturnValue = null

  // Guard 2 controls: call-count-based interception of fstatSync.
  // When enabled, the second fstatSync call returns a fabricated ino.
  // `fabricatedIno` is set by fstatSync and read by statSync (for
  // the realPath2 check) so both see the same modified ino — this lets
  // the inner fd-vs-realpath guard pass while Guard 2 fires.
  let fstatSwapEnabled = false
  let fstatCallCount = 0
  let fabricatedIno = null      // set by fstatSync on pass-2 call; read by statSync

  // statSync intercept: when `statSwapPath` is set, return a stat with
  // `fabricatedIno` instead of the real ino.
  let statSwapPath = null

  // Build the mocked fs namespace from the real exports.
  const mockedFs = {}
  for (const key of Object.keys(realFs)) {
    mockedFs[key] = realFs[key]
  }

  mockedFs.realpathSync = (p, ...rest) => {
    if (p === realpathInterceptPath) {
      const count = (realpathCallsByPath[p] || 0) + 1
      realpathCallsByPath[p] = count
      if (count === 1) {
        // Pass 1: return the real resolved path so _collectCandidates builds
        // a valid candidate descriptor with the correct realPath.
        return realFs.realpathSync(p, ...rest)
      }
      // Pass 2+: return the configured drift value to simulate a symlink
      // redirect between passes.
      return realpathSwapReturnValue
    }
    return realFs.realpathSync(p, ...rest)
  }

  mockedFs.fstatSync = (fd, ...rest) => {
    if (!fstatSwapEnabled) return realFs.fstatSync(fd, ...rest)
    fstatCallCount++
    const real = realFs.fstatSync(fd, ...rest)
    if (fstatCallCount === 2) {
      // Pass 2: fabricate a different ino to simulate the file having been
      // replaced between passes. The fabricatedIno variable is shared with
      // the statSync mock so both functions see the same modified ino value,
      // allowing the inner fd-vs-realpath guard (fstat2 vs realStat2) to pass
      // while Guard 2 (fstat2 vs fstatSnap) fires.
      fabricatedIno = real.ino + 100000
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        ino: fabricatedIno,
      })
    }
    return real
  }

  mockedFs.statSync = (p, ...rest) => {
    // When statSwapPath is set AND fabricatedIno has been written by fstatSync,
    // return the fabricated ino for this specific path. This steers the
    // inner guard (fstat2 vs realStat2) to pass so Guard 2 is the only check
    // that fires.
    if (statSwapPath !== null && p === statSwapPath && fabricatedIno !== null) {
      const real = realFs.statSync(p, ...rest)
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        ino: fabricatedIno,
      })
    }
    return realFs.statSync(p, ...rest)
  }

  // Install the mock BEFORE importing skills-loader.js. The unique query
  // string forces a fresh module evaluation, ensuring the named imports
  // (`realpathSync`, `fstatSync`, `statSync`, etc.) bind to our mock
  // implementations rather than the real ones loaded by other test files.
  mock.module('fs', { namedExports: mockedFs })
  const { loadActiveSkills } = await import('../src/skills-loader.js?toctou-3286')

  // ─────────────────────────────────────────────────────────────────────────

  describe('inter-pass TOCTOU detection (#3286)', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-toctou-'))
      realpathInterceptPath = null
      realpathCallsByPath = Object.create(null)
      realpathSwapReturnValue = null
      fstatSwapEnabled = false
      fstatCallCount = 0
      fabricatedIno = null
      statSwapPath = null
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    // ── Baseline ─────────────────────────────────────────────────────────

    it('baseline: skill loads normally when no TOCTOU swap is simulated', () => {
      writeFileSync(join(dir, 's.md'), '# skill\n\nbody content\n')

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024,
      })

      assert.equal(skills.length, 1, 'baseline: skill should load when no swap is simulated')
      assert.equal(skills[0].name, 's')
    })

    // ── Guard 1: symlink swap detection ───────────────────────────────────
    //
    // Scenario: between pass 1 and pass 2, a symlink in the path resolves to
    // a different target. `realPath2 !== realPath` detects this.
    //
    // Mock: on the second realpathSync call for the skill's fullPath, return
    // a different path string than the first call returned.
    //
    // On macOS, fullPath (/var/.../s.md) differs from realpathSync(fullPath)
    // (/private/var/.../s.md) because /var is a symlink to /private/var.
    // Returning fullPath as the pass-2 value gives a different string that
    // still resolves to the same inode — so the inner and Guard-2 inode checks
    // both PASS if Guard 1 is disabled, making the test causally specific to
    // Guard 1 on macOS.
    //
    // On Linux where tmpdir is not a symlink, fullPath === realpathSync(fullPath).
    // The fallback path (fabricated non-existent path) still verifies the skill
    // is dropped — just via the subsequent statSync-catch rather than Guard 1.

    it('Guard 1 (symlink swap): skill skipped when realPath drifts between passes', () => {
      writeFileSync(join(dir, 's.md'), '# skill\n\nbody\n')

      const fullPath = join(dir, 's.md')
      const resolvedPath = realFs.realpathSync(fullPath)
      const symlinkInPath = resolvedPath !== fullPath

      realpathInterceptPath = fullPath
      // On macOS: fullPath and resolvedPath differ → return fullPath as the
      // "drifted" pass-2 result (same inode, different string → Guard 1 fires,
      // inner guard passes → causal isolation confirmed).
      // On Linux: they're the same → use a fabricated non-existent path so
      // the skill is still dropped (via statSync-catch fallback).
      realpathSwapReturnValue = symlinkInPath
        ? fullPath
        : tmpdir() + '/nonexistent-toctou-target.md'

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024,
      })

      assert.equal(
        skills.length, 0,
        'Guard 1 must cause the skill to be skipped when realPath drifts in pass 2',
      )
      assert.ok(
        (realpathCallsByPath[fullPath] || 0) >= 2,
        'realpathSync must have been called for the fullPath in BOTH passes',
      )
    })

    it('Guard 1 causality: skill loads when no path drift occurs (no swap simulated)', () => {
      writeFileSync(join(dir, 's.md'), '# skill\n\nbody\n')
      // realpathInterceptPath = null → both passes return the same realPath.

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024,
      })

      assert.equal(skills.length, 1, 'without path drift, the skill must load')
    })

    it('Guard 1: swap on one skill does not affect sibling skills', () => {
      writeFileSync(join(dir, 's.md'), '# s\n\nbody\n')
      writeFileSync(join(dir, 'other.md'), '# other\n\nbody\n')

      const fullPath = join(dir, 's.md')
      const resolvedPath = realFs.realpathSync(fullPath)
      const symlinkInPath = resolvedPath !== fullPath

      realpathInterceptPath = fullPath
      realpathSwapReturnValue = symlinkInPath
        ? fullPath
        : tmpdir() + '/nonexistent-sibling-target.md'

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024,
      })

      const names = skills.map((sk) => sk.name)
      assert.ok(!names.includes('s'), 'swapped skill must be dropped')
      assert.ok(names.includes('other'), 'unaffected sibling must still load')
    })

    // ── Guard 2: inode change / file replacement ───────────────────────────
    //
    // Scenario: between pass 1 and pass 2, the file was replaced with a new
    // file at the same path (different inode). Guard 2 detects this:
    //   fstat2.dev !== fstatSnap.dev || fstat2.ino !== fstatSnap.ino
    //
    // Mock: fstatSync returns a different ino on the second call (pass 2).
    // statSync for realPath2 also returns the fabricated ino (same as fstat2)
    // so the inner fd-vs-realpath guard (fstat2 vs realStat2) PASSES — leaving
    // Guard 2 as the only active gate. This makes the test causally specific
    // to Guard 2.
    //
    // Causality: `fabricatedIno` is set lazily by fstatSync call #2 (pass 2)
    // and read by statSync for realPath2 in the same pass, so fstat2.ino ===
    // realStat2.ino — the inner fd-vs-realpath guard sees matching inodes and
    // passes. With Guard 2 removed, fstat2.ino would also equal fstatSnap.ino
    // (no drift), so the skill would load. This confirms Guard 2 is the sole
    // active gate in this scenario.

    it('Guard 2 (inode change): skill skipped when fstat ino changes between passes', () => {
      writeFileSync(join(dir, 's.md'), '# skill\n\nbody\n')

      const fullPath = join(dir, 's.md')
      const resolvedPath = realFs.realpathSync(fullPath)

      fstatSwapEnabled = true
      // statSwapPath uses the resolved (canonical) path because realpathSync
      // returns that in pass 2 for an un-swapped (no Guard 1 intercept) run.
      statSwapPath = resolvedPath

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024,
      })

      assert.equal(
        skills.length, 0,
        'Guard 2 must drop the skill when the inode changes between passes',
      )
      assert.ok(
        fstatCallCount >= 2,
        `fstatSync must have been called at least twice (pass 1 + pass 2); got ${fstatCallCount}`,
      )
      assert.ok(
        fabricatedIno !== null,
        'fabricatedIno must have been set (pass-2 fstatSync must have fired)',
      )
    })

    it('Guard 2 causality: skill loads when fstat ino stays the same across passes', () => {
      writeFileSync(join(dir, 's.md'), '# skill\n\nbody\n')
      // fstatSwapEnabled = false → both passes return the same ino.

      const skills = loadActiveSkills(dir, {
        maxSkillBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024,
      })

      assert.equal(skills.length, 1, 'without the inode change, the skill must load')
    })
  })
}
