import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

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
