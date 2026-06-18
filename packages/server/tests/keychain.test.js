import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

// `tests/_setup.mjs` sets CHROXY_DISABLE_KEYCHAIN=1 suite-wide so server tests
// never shell out to the real OS keychain (modal-prompt spam on a broken login
// keychain — see server_suite_real_keychain_prompts.md). The integration tests
// below are the ONLY ones that exercise a real round-trip; gate them behind an
// explicit opt-in so a deliberate `CHROXY_TEST_REAL_KEYCHAIN=1` run (e.g. a
// known-good CI host) still gets real coverage, while the default run cleanly
// skips them (isKeychainAvailable() → false). The plain export/null/source
// assertions pass either way.
if (process.env.CHROXY_TEST_REAL_KEYCHAIN === '1') {
  delete process.env.CHROXY_DISABLE_KEYCHAIN
}

// Top-level await import to avoid timing issues with before() hooks
const keychain = await import(join(srcDir, 'keychain.js'))

// Helper: run a keychain integration test, skipping when keychain is
// unavailable (CI without secret-tool, or transient ENOENT under load)
function keychainTest(name, fn) {
  it(name, (t) => {
    if (!keychain.isKeychainAvailable()) {
      return t.skip('no keychain available')
    }
    try {
      fn(t)
    } catch (err) {
      if (err.code === 'ENOENT') return t.skip('keychain binary not found (transient)')
      throw err
    }
  })
}

// Probe whether a real secret-service BACKEND is reachable, not just that the
// binary exists. `isKeychainAvailable()` on Linux only checks for the
// `secret-tool` binary; a headless box may have it installed with no running
// keyring daemon / D-Bus session — in which case getTokenStatus correctly
// FAILS SAFE to `error` for an absent item (the #5615 fix). A store/read/delete
// round-trip is the only reliable way to tell "backend works" from "binary
// present but backend down". Returns false on any failure (treat as no backend).
function backendIsFunctional() {
  if (!keychain.isKeychainAvailable()) return false
  const probeService = 'chroxy-test-backend-probe'
  const probeToken = 'probe-' + Date.now()
  try {
    keychain.setToken(probeToken, probeService)
    const ok = keychain.getToken(probeService) === probeToken
    keychain.deleteToken(probeService)
    return ok
  } catch {
    try { keychain.deleteToken(probeService) } catch { /* best-effort cleanup */ }
    return false
  }
}

describe('Keychain token storage (#1838)', () => {

  it('exports getToken, setToken, deleteToken, migrateToken, isKeychainAvailable', () => {
    assert.equal(typeof keychain.getToken, 'function')
    assert.equal(typeof keychain.setToken, 'function')
    assert.equal(typeof keychain.deleteToken, 'function')
    assert.equal(typeof keychain.migrateToken, 'function')
    assert.equal(typeof keychain.isKeychainAvailable, 'function')
  })

  it('isKeychainAvailable returns a boolean', () => {
    const result = keychain.isKeychainAvailable()
    assert.equal(typeof result, 'boolean')
  })

  it('getToken returns null when no token is stored', () => {
    // Use a unique service name to avoid conflicts
    const token = keychain.getToken('chroxy-test-nonexistent')
    assert.equal(token, null)
  })

  keychainTest('setToken and getToken round-trip successfully', () => {
    const testToken = 'test-token-' + Date.now()
    const serviceName = 'chroxy-test-roundtrip'

    keychain.setToken(testToken, serviceName)
    const retrieved = keychain.getToken(serviceName)
    assert.equal(retrieved, testToken)

    // Clean up
    keychain.deleteToken(serviceName)
    assert.equal(keychain.getToken(serviceName), null)
  })

  it('deleteToken is idempotent (no error when nothing to delete)', () => {
    // Should not throw
    keychain.deleteToken('chroxy-test-no-such-service')
  })

  keychainTest('migrateToken moves token from config object to keychain', () => {
    const testToken = 'migrate-test-' + Date.now()
    const serviceName = 'chroxy-test-migrate'
    const fakeConfig = { apiToken: testToken, port: 8765 }

    const result = keychain.migrateToken(fakeConfig, serviceName)
    assert.equal(result.migrated, true)
    assert.equal(result.config.apiToken, undefined, 'token should be removed from config')
    assert.equal(result.config.port, 8765, 'other config keys should be preserved')
    assert.equal(keychain.getToken(serviceName), testToken)

    // Clean up
    keychain.deleteToken(serviceName)
  })

  keychainTest('migrateToken is a no-op when token already in keychain', () => {
    const testToken = 'already-migrated-' + Date.now()
    const serviceName = 'chroxy-test-already'

    // Pre-store in keychain
    keychain.setToken(testToken, serviceName)

    const fakeConfig = { apiToken: testToken, port: 8765 }
    const result = keychain.migrateToken(fakeConfig, serviceName)
    assert.equal(result.migrated, false)

    // Clean up
    keychain.deleteToken(serviceName)
  })

  it('server-cli.js uses keychain for token persistence', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(
      source.includes('keychain'),
      'server-cli.js should import or reference keychain module'
    )
  })
})

describe('getTokenStatus — absent vs read-failure (#5615)', () => {
  it('exports getTokenStatus', () => {
    assert.equal(typeof keychain.getTokenStatus, 'function')
  })

  it('reports {status: absent} for a service that is not stored', (t) => {
    // A genuinely-absent item must report `absent`, never a phantom `found`.
    // BUT distinguishing absent from `error` needs a FUNCTIONAL secret-service
    // backend: macOS `security` returns the clean errSecItemNotFound (44) for a
    // missing item, whereas on Linux `isKeychainAvailable()` only checks the
    // `secret-tool` BINARY exists — not that a keyring daemon / D-Bus session is
    // actually running. On a headless box (or GH's Linux runner) the lookup of a
    // missing item fails at the backend, and getTokenStatus correctly FAILS SAFE
    // to `error` (never silently `absent` — that is the #5615 fix working). So we
    // only assert the strict `absent` mapping when a store/read round-trip proves
    // the backend works; otherwise the weaker-but-still-safe invariant (no
    // phantom `found`) is all we can guarantee — `error` is the intended
    // fail-safe here, not a bug.
    const res = keychain.getTokenStatus('chroxy-test-nonexistent-status')
    assert.notEqual(res.status, 'found', 'an absent item must never report a phantom found')
    assert.equal(res.value, null)
    if (!backendIsFunctional()) {
      return t.skip('no functional keychain backend — `error` is the correct fail-safe for absence')
    }
    assert.equal(res.status, 'absent', 'with a working backend, an absent item is `absent`, not a read failure')
  })

  keychainTest('round-trips a stored value as {status: found}', () => {
    const serviceName = 'chroxy-test-status-found'
    const token = 'status-token-' + Date.now()
    keychain.setToken(token, serviceName)
    try {
      const res = keychain.getTokenStatus(serviceName)
      assert.equal(res.status, 'found')
      assert.equal(res.value, token)
    } finally {
      keychain.deleteToken(serviceName)
    }
  })

  it('macOS distinguishes errSecItemNotFound (44) from other errors in source', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')
    const macStatus = source.match(/function _macGetTokenStatus[\s\S]*?^}/m)
    assert.ok(macStatus, '_macGetTokenStatus should exist')
    // Absence is keyed on exit 44; everything else maps to a read failure.
    assert.ok(
      macStatus[0].includes('MAC_ERR_SEC_ITEM_NOT_FOUND'),
      '_macGetTokenStatus must branch on the not-found exit code',
    )
    assert.ok(
      /status:\s*'error'/.test(macStatus[0]),
      '_macGetTokenStatus must report a read failure as error (not absent)',
    )
  })
})

describe('Keychain failure paths (#1887)', () => {
  it('migrateToken falls back when setToken throws', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // Extract migrateToken function body and verify it has try/catch around setToken
    const migrateBlock = source.match(/export function migrateToken[\s\S]*?^}/m)
    assert.ok(migrateBlock, 'migrateToken function should exist')
    // Use word-boundary regex to avoid matching comments or unrelated identifiers
    assert.ok(
      /\btry\s*\{/.test(migrateBlock[0]) && migrateBlock[0].includes('setToken') && /\bcatch\b/.test(migrateBlock[0]),
      'migrateToken should wrap setToken in try/catch'
    )
    // Verify the catch block returns migrated: false (not some other branch)
    const catchBlock = migrateBlock[0].match(/\bcatch\b[\s\S]*?(?=\n  \}|\n\})/)?.[0] ?? ''
    assert.ok(
      catchBlock.includes('migrated: false'),
      'migrateToken catch block should return migrated: false'
    )
  })

  it('setToken does not catch errors (throws to caller)', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // setToken should NOT have a try/catch — it throws on failure
    // so callers (like migrateToken) can handle the error
    const setTokenBlock = source.match(/export function setToken[\s\S]*?^}/m)
    assert.ok(setTokenBlock, 'setToken function should exist')
    // Use regex with word boundary to avoid false matches from 'try{' (no space) or comments
    assert.ok(
      !/\btry\s*\{/.test(setTokenBlock[0]),
      'setToken should not catch errors — it should throw to caller'
    )
  })

  it('getToken returns null on keychain errors (never throws)', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // Both _macGetToken and _linuxGetToken should have try/catch returning null
    const macGet = source.match(/function _macGetToken[\s\S]*?^}/m)
    assert.ok(macGet, '_macGetToken should exist')
    // Verify try block and that the catch block (not just any path) returns null
    assert.ok(/\btry\s*\{/.test(macGet[0]), '_macGetToken should have a try block')
    const macCatch = macGet[0].match(/\bcatch\b[\s\S]*$/)?.[0] ?? ''
    assert.ok(
      /\breturn null\b/.test(macCatch),
      '_macGetToken catch block should return null'
    )

    const linuxGet = source.match(/function _linuxGetToken[\s\S]*?^}/m)
    assert.ok(linuxGet, '_linuxGetToken should exist')
    assert.ok(/\btry\s*\{/.test(linuxGet[0]), '_linuxGetToken should have a try block')
    const linuxCatch = linuxGet[0].match(/\bcatch\b[\s\S]*$/)?.[0] ?? ''
    assert.ok(
      /\breturn null\b/.test(linuxCatch),
      '_linuxGetToken catch block should return null'
    )
  })

  it('deleteToken is tolerant of errors (never throws)', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // Both _macDeleteToken and _linuxDeleteToken should have try/catch
    const macDel = source.match(/function _macDeleteToken[\s\S]*?^}/m)
    assert.ok(macDel, '_macDeleteToken should exist')
    // Verify try and catch as separate constructs (not just substring matches)
    assert.ok(/\btry\s*\{/.test(macDel[0]), '_macDeleteToken should have a try block')
    assert.ok(/\bcatch\b/.test(macDel[0]), '_macDeleteToken should have a catch block')

    const linuxDel = source.match(/function _linuxDeleteToken[\s\S]*?^}/m)
    assert.ok(linuxDel, '_linuxDeleteToken should exist')
    assert.ok(/\btry\s*\{/.test(linuxDel[0]), '_linuxDeleteToken should have a try block')
    assert.ok(/\bcatch\b/.test(linuxDel[0]), '_linuxDeleteToken should have a catch block')
  })

  it('init-cmd.js falls back to config file when keychain is unavailable', () => {
    const source = readFileSync(join(srcDir, 'cli/init-cmd.js'), 'utf-8')
    assert.ok(
      source.includes('isKeychainAvailable'),
      'init-cmd.js should check keychain availability'
    )
    assert.ok(
      source.includes('config.apiToken'),
      'init-cmd.js should fall back to storing token in config'
    )
  })
})

describe('CHROXY_DISABLE_KEYCHAIN off-switch', () => {
  // The default test run has the flag set (tests/_setup.mjs); under
  // CHROXY_TEST_REAL_KEYCHAIN=1 the top-of-file opt-in clears it. Assert the
  // contract directly against the env so this holds in both modes.
  const disabled = process.env.CHROXY_DISABLE_KEYCHAIN === '1'

  it('reflects the disable flag in isKeychainAvailable()', () => {
    if (disabled) {
      assert.equal(keychain.isKeychainAvailable(), false, 'disabled → no keychain, regardless of binary presence')
    } else {
      // real-keychain opt-in: availability is environment-dependent (binary
      // present or not) — just assert it stays a boolean and never throws.
      assert.equal(typeof keychain.isKeychainAvailable(), 'boolean')
    }
  })

  it('read/write/delete are inert no-ops when disabled (no real keychain access)', () => {
    if (!disabled) return // only meaningful with the flag on
    const svc = 'chroxy-test-disabled-noop'
    assert.equal(keychain.getToken(svc), null)
    assert.deepEqual(keychain.getTokenStatus(svc), { status: 'absent', value: null, error: null })
    // These must NOT throw and must NOT shell out to `security`/`secret-tool`.
    assert.doesNotThrow(() => keychain.setToken('should-be-ignored', svc))
    assert.doesNotThrow(() => keychain.deleteToken(svc))
    // A write that was a real no-op leaves the read still absent.
    assert.equal(keychain.getToken(svc), null)
    // migrateToken short-circuits on isKeychainAvailable() → no migration.
    const res = keychain.migrateToken({ apiToken: 'x' }, svc)
    assert.equal(res.migrated, false)
    assert.equal(res.config.apiToken, 'x')
  })
})
