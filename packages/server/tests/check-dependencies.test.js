import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDependencies } from '../src/utils/check-dependencies.js'

/**
 * Unit tests for checkDependencies — the hoisted/workspace-aware
 * dependency probe used by doctor.js preflight.
 *
 * Scenarios to cover (see issue #2899):
 *   1. Package-local node_modules with the probe dep present
 *   2. Hoisted node_modules at a parent dir, package-local missing
 *   3. Neither present — genuine "forgot to run npm install" state
 */
describe('checkDependencies', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-check-deps-'))
  })

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Create a resolvable fake dep at <root>/node_modules/<name>/ with a
   * minimal package.json + index.js so both createRequire().resolve() and
   * the walk-up fallback will succeed.
   */
  function createResolvableDep(root, name) {
    const depDir = join(root, 'node_modules', name)
    mkdirSync(depDir, { recursive: true })
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({ name, version: '0.0.0', main: 'index.js' }),
    )
    writeFileSync(join(depDir, 'index.js'), 'module.exports = {}\n')
    return depDir
  }

  it('passes via createRequire when the probe dep is in the package-local node_modules', () => {
    // Layout: <tmp>/pkg/node_modules/commander/{package.json,index.js}
    const pkgDir = join(tmpDir, 'pkg')
    createResolvableDep(pkgDir, 'commander')

    const result = checkDependencies({ startDir: pkgDir, probes: ['commander'] })
    assert.equal(result.ok, true, `expected ok=true, got ${JSON.stringify(result)}`)
    // createRequire resolves to the main file (index.js), not the dir —
    // proves the primary resolution path was exercised, not the fallback.
    assert.ok(
      result.foundAt.endsWith(join('commander', 'index.js')),
      `expected createRequire path to end with commander/index.js, got ${result.foundAt}`,
    )
  })

  it('passes via createRequire when deps are hoisted to a parent node_modules', () => {
    // Layout (workspace hoist):
    //   <tmp>/workspace/node_modules/commander/{package.json,index.js}
    //   <tmp>/workspace/packages/server/package.json
    // No node_modules in packages/server — common npm workspace layout.
    const workspaceRoot = join(tmpDir, 'workspace')
    const pkgDir = join(workspaceRoot, 'packages', 'server')
    createResolvableDep(workspaceRoot, 'commander')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@chroxy/server', version: '0.0.0' }))

    const result = checkDependencies({ startDir: pkgDir, probes: ['commander'] })
    assert.equal(result.ok, true, `expected ok=true, got ${JSON.stringify(result)}`)
    // Proves createRequire walked up to the hoisted node_modules.
    assert.ok(
      result.foundAt.endsWith(join('commander', 'index.js')),
      `expected createRequire path to end with commander/index.js, got ${result.foundAt}`,
    )
    // realpathSync collapses macOS /var → /private/var symlink so the
    // prefix comparison matches createRequire's resolved path.
    const realWorkspaceRoot = realpathSync(workspaceRoot)
    assert.ok(result.foundAt.startsWith(realWorkspaceRoot), `expected hoisted path under ${realWorkspaceRoot}, got ${result.foundAt}`)
  })

  it('fails when neither package-local nor any parent node_modules has the dep', () => {
    // Genuine "forgot to run npm install" — no node_modules anywhere up-tree.
    const pkgDir = join(tmpDir, 'fresh-clone')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }))

    // Use a sentinel dep name that cannot exist in any real node_modules
    // above tmpDir (defensive — tmpdir can be anywhere on disk).
    const result = checkDependencies({
      startDir: pkgDir,
      probes: ['__chroxy_nonexistent_probe_dep__'],
    })
    assert.equal(result.ok, false, `expected ok=false, got ${JSON.stringify(result)}`)
  })

  it('passes if any probe resolves (multi-probe fallback)', () => {
    // Only one of the probes exists — helper must tolerate missing entries.
    const pkgDir = join(tmpDir, 'pkg')
    createResolvableDep(pkgDir, 'ws')

    const result = checkDependencies({
      startDir: pkgDir,
      probes: ['__missing_probe__', 'ws'],
    })
    assert.equal(result.ok, true)
    assert.ok(
      result.foundAt.endsWith(join('ws', 'index.js')),
      `expected createRequire path, got ${result.foundAt}`,
    )
  })

  it('falls back to walk-up when createRequire throws but node_modules/<probe>/package.json exists', () => {
    // Create a dep with a package.json (for the fallback) but no resolvable
    // entry file — createRequire().resolve() will throw ENOENT on main.
    // Helper should fall through to the walk-up and return the dir path.
    const pkgDir = join(tmpDir, 'pkg')
    const depDir = join(pkgDir, 'node_modules', 'commander')
    mkdirSync(depDir, { recursive: true })
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({ name: 'commander', version: '0.0.0', main: 'does-not-exist.js' }),
    )

    const result = checkDependencies({ startDir: pkgDir, probes: ['commander'] })
    assert.equal(result.ok, true, `expected ok=true, got ${JSON.stringify(result)}`)
    // Walk-up returns the directory, not a resolved file path.
    assert.ok(
      result.foundAt.endsWith(join('node_modules', 'commander')),
      `expected walk-up dir path, got ${result.foundAt}`,
    )
  })

  it('does not false-positive on empty node_modules/<probe>/ dir (no package.json)', () => {
    // Stray/empty directory — Node resolution would fail here, so the
    // walk-up fallback must not report ok.
    const pkgDir = join(tmpDir, 'pkg')
    const emptyDep = join(pkgDir, 'node_modules', 'commander')
    mkdirSync(emptyDep, { recursive: true })
    // No package.json written.

    const result = checkDependencies({ startDir: pkgDir, probes: ['commander'] })
    assert.equal(result.ok, false, `expected ok=false for empty probe dir, got ${JSON.stringify(result)}`)
  })

  it('does not walk above the filesystem root', () => {
    // Use startDir that is literally the tmp dir — walking up should stop
    // cleanly at the fs root without throwing.
    const result = checkDependencies({
      startDir: tmpDir,
      probes: ['__chroxy_nonexistent_probe_dep__'],
    })
    assert.equal(result.ok, false)
    // Should not throw, and should return cleanly
    assert.ok(result.message || result.ok === false)
  })
})
