import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

  it('passes when the probe dep is in the package-local node_modules', () => {
    // Layout: <tmp>/pkg/node_modules/commander/package.json
    const pkgDir = join(tmpDir, 'pkg')
    const depDir = join(pkgDir, 'node_modules', 'commander')
    mkdirSync(depDir, { recursive: true })
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'commander', version: '0.0.0' }))

    const result = checkDependencies({ startDir: pkgDir, probes: ['commander'] })
    assert.equal(result.ok, true, `expected ok=true, got ${JSON.stringify(result)}`)
    assert.ok(result.foundAt.includes('commander'))
  })

  it('passes when deps are hoisted to a parent node_modules', () => {
    // Layout (workspace hoist):
    //   <tmp>/workspace/node_modules/commander/package.json
    //   <tmp>/workspace/packages/server/package.json
    // No node_modules in packages/server — common npm workspace layout.
    const workspaceRoot = join(tmpDir, 'workspace')
    const pkgDir = join(workspaceRoot, 'packages', 'server')
    const hoistedDep = join(workspaceRoot, 'node_modules', 'commander')
    mkdirSync(hoistedDep, { recursive: true })
    writeFileSync(join(hoistedDep, 'package.json'), JSON.stringify({ name: 'commander', version: '0.0.0' }))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@chroxy/server', version: '0.0.0' }))

    const result = checkDependencies({ startDir: pkgDir, probes: ['commander'] })
    assert.equal(result.ok, true, `expected ok=true, got ${JSON.stringify(result)}`)
    assert.ok(result.foundAt.includes('commander'))
    // Must have walked up to the workspace root
    assert.ok(result.foundAt.startsWith(workspaceRoot), `expected hoisted path under ${workspaceRoot}, got ${result.foundAt}`)
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
    const depDir = join(pkgDir, 'node_modules', 'ws')
    mkdirSync(depDir, { recursive: true })
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'ws', version: '0.0.0' }))

    const result = checkDependencies({
      startDir: pkgDir,
      probes: ['__missing_probe__', 'ws'],
    })
    assert.equal(result.ok, true)
    assert.ok(result.foundAt.endsWith(join('node_modules', 'ws')))
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
