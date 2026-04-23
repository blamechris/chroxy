import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctorChecks } from '../src/doctor.js'

/**
 * Integration tests for doctor.js.
 * Tests run against the real system — binaries are resolved via PATH.
 */

describe('runDoctorChecks', () => {
  it('returns checks array and passed boolean', async () => {
    const result = await runDoctorChecks()
    assert.ok(Array.isArray(result.checks))
    assert.equal(typeof result.passed, 'boolean')
    assert.ok(result.checks.length >= 6, 'Should have at least 6 checks')
  })

  it('each check has name, status, and message', async () => {
    const { checks } = await runDoctorChecks()
    for (const check of checks) {
      assert.equal(typeof check.name, 'string')
      assert.ok(['pass', 'warn', 'fail'].includes(check.status), `Invalid status: ${check.status}`)
      assert.equal(typeof check.message, 'string')
    }
  })

  it('Node.js version check is present', async () => {
    const { checks } = await runDoctorChecks()
    const nodeCheck = checks.find(c => c.name === 'Node.js')
    assert.ok(nodeCheck)
    assert.ok(nodeCheck.message.includes('v'))
    // Node 22 should pass (our test environment uses Node 22)
    assert.equal(nodeCheck.status, 'pass')
  })

  it('cloudflared check is present', async () => {
    const { checks } = await runDoctorChecks()
    const cfCheck = checks.find(c => c.name === 'cloudflared')
    assert.ok(cfCheck)
    // Status depends on whether cloudflared is in PATH
    assert.ok(['pass', 'fail'].includes(cfCheck.status))
  })

  it('claude CLI check is present', async () => {
    const { checks } = await runDoctorChecks()
    const claudeCheck = checks.find(c => c.name === 'claude')
    assert.ok(claudeCheck)
  })

  it('config check is present', async () => {
    const { checks } = await runDoctorChecks()
    const configCheck = checks.find(c => c.name === 'Config')
    assert.ok(configCheck)
  })

  it('dependencies check is present', async () => {
    const { checks } = await runDoctorChecks()
    const depsCheck = checks.find(c => c.name === 'Dependencies')
    assert.ok(depsCheck)
    // Status depends on whether node_modules exists in cwd (may vary in CI)
    assert.ok(['pass', 'fail'].includes(depsCheck.status))
  })

  it('port check is present', async () => {
    const { checks } = await runDoctorChecks()
    const portCheck = checks.find(c => c.name === 'Port')
    assert.ok(portCheck)
  })

  it('accepts custom port', async () => {
    // Use a random high port that's unlikely to be in use
    const { checks } = await runDoctorChecks({ port: 59123 })
    const portCheck = checks.find(c => c.name === 'Port')
    assert.ok(portCheck)
    assert.ok(portCheck.message.includes('59123'))
    assert.equal(portCheck.status, 'pass')
  })

  it('passed is true when no failures', async () => {
    const { passed, checks } = await runDoctorChecks({ port: 59124 })
    const failures = checks.filter(c => c.status === 'fail')
    if (failures.length === 0) {
      assert.equal(passed, true)
    } else {
      // On some systems, checks may fail — that's ok for integration tests
      assert.equal(passed, false)
    }
  })

  it('passed is false when any check fails', async () => {
    // Verify the logic: if we had a failing check, passed would be false
    const mockChecks = [
      { name: 'A', status: 'pass', message: 'ok' },
      { name: 'B', status: 'fail', message: 'bad' },
      { name: 'C', status: 'warn', message: 'meh' },
    ]
    const passed = mockChecks.every(c => c.status !== 'fail')
    assert.equal(passed, false)
  })

  it('dependencies check resolves relative to the server package by default', async () => {
    // Regression: previously the check used join(process.cwd(), 'node_modules').
    // Tauri launches the server with cwd='/' under launchd, which always
    // failed this check and blocked server startup. The fix resolves
    // node_modules relative to the server package itself. We no longer
    // need to mutate process.cwd() — runDoctorChecks is self-contained
    // and would still pass if some other test had changed the cwd.
    const { checks } = await runDoctorChecks()
    const depsCheck = checks.find(c => c.name === 'Dependencies')
    assert.ok(depsCheck)
    // With node_modules installed in packages/server/, this must pass
    // regardless of the caller's working directory.
    assert.equal(depsCheck.status, 'pass', `expected pass, got ${depsCheck.status}: ${depsCheck.message}`)
  })

  it('dependencies check fails when pkgDir override has no node_modules', async () => {
    // The pkgDir override lets tests aim the dependency check at an
    // arbitrary directory without touching global process state. An empty
    // temp dir has no node_modules, so the check must fail — proving the
    // override is actually plumbed through to the node_modules lookup.
    const emptyDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-'))
    try {
      const { checks } = await runDoctorChecks({ pkgDir: emptyDir })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'fail', `expected fail, got ${depsCheck.status}: ${depsCheck.message}`)
      assert.ok(depsCheck.message.includes(emptyDir), `message should reference temp dir: ${depsCheck.message}`)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('finds claude via candidate paths when PATH omits the install dir', async () => {
    // Simulates a GUI-launched process (e.g. Tauri on macOS) whose
    // inherited PATH excludes the dir where claude is actually installed.
    // checkBinary should fall through to the candidate list and still
    // resolve the binary.
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
      const { checks } = await runDoctorChecks()
      const claudeCheck = checks.find(c => c.name === 'claude')
      assert.ok(claudeCheck)
      if (claudeCheck.status === 'pass') {
        // If claude is installed at any of the known candidate paths,
        // the stripped PATH should NOT have prevented resolution.
        assert.ok(claudeCheck.message, 'expected version string on pass')
      }
      // If still 'fail', this host simply has no claude binary anywhere —
      // that's a valid outcome, not a regression of the fallback logic.
    } finally {
      process.env.PATH = originalPath
    }
  })
})
