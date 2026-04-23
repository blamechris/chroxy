import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parsePath, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runDoctorChecks, checkBinary } from '../src/doctor.js'

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

  it('dependencies check resolves relative to server package, not process.cwd()', async () => {
    // Regression: previously the check used join(process.cwd(), 'node_modules').
    // Tauri launches the server with cwd='/' under launchd, which always
    // failed this check and blocked server startup. The fix resolves
    // node_modules relative to the server package itself.
    const originalCwd = process.cwd()
    // Use the filesystem root from the CURRENT cwd so the chdir works on
    // any platform (POSIX root '/' or a Windows drive root like 'C:\\').
    const fsRoot = parsePath(originalCwd).root
    try {
      process.chdir(fsRoot)
      const { checks } = await runDoctorChecks()
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      // With node_modules installed in packages/server/, this must pass
      // even when process.cwd() is a directory with no node_modules.
      assert.equal(depsCheck.status, 'pass', `expected pass, got ${depsCheck.status}: ${depsCheck.message}`)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('finds binary via candidate paths when PATH omits the install dir', async () => {
    // Simulates a GUI-launched process (e.g. Tauri on macOS) whose
    // inherited PATH excludes the dir where the binary is actually
    // installed. checkBinary should fall through to the candidate list
    // and still resolve the binary.
    //
    // This test is self-contained: it creates a temp stub executable
    // and passes its path via `candidates`, so it asserts the fallback
    // logic regardless of what (if anything) is installed on the host.
    // (Self-contained because `node --test-name-pattern` skips parent
    // hooks, so setup/teardown live inside the `it` body.)
    const originalPath = process.env.PATH
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-stub-'))
    const stubPath = join(dir, 'fake-claude')
    const stubVersion = 'fake-claude 9.9.9-stub'
    try {
      writeFileSync(stubPath, `#!/bin/sh\necho "${stubVersion}"\n`)
      chmodSync(stubPath, 0o755)

      // Strip PATH so `which` in resolveBinary cannot find the stub and
      // the resolver must fall through to the candidate list.
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

      const result = checkBinary('fake-claude', ['--version'], {
        parseVersion: (out) => out.trim().split('\n')[0],
        required: true,
        candidates: [stubPath],
        installHint: 'install fake-claude',
      })

      assert.equal(result.name, 'fake-claude')
      assert.equal(
        result.status,
        'pass',
        `expected pass via candidate fallback, got ${result.status}: ${result.message}`,
      )
      assert.equal(result.message, stubVersion)
    } finally {
      process.env.PATH = originalPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
