/**
 * Windows DPAPI keychain backend (#6644). Real DPAPI Protect/Unprotect via
 * PowerShell — so this suite is win32-only, and each test additionally skips at
 * runtime when DPAPI isn't usable for the running account (e.g. a service
 * account with no loaded user profile on a CI runner). Where it DOES run it
 * proves the acceptance criteria: a stored secret is encrypted at rest,
 * round-trips, reports `backend: 'dpapi'`, and is not group-readable.
 *
 * LOCALAPPDATA is redirected to a temp dir so the suite never pollutes the real
 * %LOCALAPPDATA%\Chroxy.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

const skip = process.platform === 'win32' ? false : 'Windows-only (real DPAPI)'

describe('keychain — Windows DPAPI backend (#6644)', { skip }, () => {
  let tmpDir
  let prevLocalAppData
  let prevDisable
  let keychain

  before(async () => {
    keychain = await import('../src/keychain.js')
  })

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dpapi-test-'))
    prevLocalAppData = process.env.LOCALAPPDATA
    prevDisable = process.env.CHROXY_DISABLE_KEYCHAIN
    process.env.LOCALAPPDATA = tmpDir
    delete process.env.CHROXY_DISABLE_KEYCHAIN // the sandbox sets this suite-wide
    keychain._resetKeychainHealthForTests()
  })

  afterEach(() => {
    if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = prevLocalAppData
    if (prevDisable === undefined) delete process.env.CHROXY_DISABLE_KEYCHAIN
    else process.env.CHROXY_DISABLE_KEYCHAIN = prevDisable
    keychain._resetKeychainHealthForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Skip a test when the running account can't actually use DPAPI (returns true
  // when it skipped, so callers `return` immediately).
  const skipUnlessDpapi = (t) => {
    if (keychain.keychainHealth().backend !== 'dpapi') {
      t.skip('DPAPI not usable for this account (e.g. no loaded user profile)')
      return true
    }
    return false
  }

  it('reports backend "dpapi" when DPAPI is usable', (t) => {
    if (skipUnlessDpapi(t)) return
    const h = keychain.keychainHealth()
    assert.equal(h.backend, 'dpapi')
    assert.equal(h.status, 'usable')
  })

  it('stores a secret encrypted at rest and round-trips it', (t) => {
    if (skipUnlessDpapi(t)) return
    const SVC = 'chroxy-test-6644'
    const SECRET = 'master-key-abc123=='
    keychain.setToken(SECRET, SVC)

    const file = join(tmpDir, 'Chroxy', 'chroxy-test-6644__api-token.dpapi')
    assert.ok(existsSync(file), 'ciphertext file written')
    assert.ok(!readFileSync(file, 'utf-8').includes(SECRET), 'file is DPAPI ciphertext, not plaintext')

    assert.equal(keychain.getToken(SVC), SECRET, 'round-trip get')
    assert.deepEqual(keychain.getTokenStatus(SVC), { status: 'found', value: SECRET, error: null })

    keychain.deleteToken(SVC)
    assert.equal(existsSync(file), false, 'file removed on delete')
    assert.equal(keychain.getToken(SVC), null, 'absent after delete')
  })

  it('the ciphertext file is not group-readable (no inherited ACEs)', (t) => {
    if (skipUnlessDpapi(t)) return
    const SVC = 'chroxy-test-6644-acl'
    keychain.setToken('secret', SVC)
    const file = join(tmpDir, 'Chroxy', 'chroxy-test-6644-acl__api-token.dpapi')
    const acl = String(execFileSync('icacls', [file], { encoding: 'utf-8' }))
    const aceLines = acl.split(/\r?\n/).filter((l) => l.includes(':('))
    assert.ok(aceLines.length > 0, 'icacls returned ACEs')
    // `/inheritance:r` stripped every inherited ACE (the audit's secondary-group
    // read access), leaving only the explicit owner + SYSTEM grants.
    assert.ok(aceLines.every((l) => !l.includes('(I)')), `expected no inherited ACEs, got:\n${acl}`)
    keychain.deleteToken(SVC)
  })

  it('reports "absent" when nothing is stored', (t) => {
    if (skipUnlessDpapi(t)) return
    assert.deepEqual(
      keychain.getTokenStatus('chroxy-test-6644-none'),
      { status: 'absent', value: null, error: null },
    )
  })
})
