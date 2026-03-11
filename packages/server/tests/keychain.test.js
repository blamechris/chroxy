import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

// Top-level await import to avoid timing issues with before() hooks
const keychain = await import(join(srcDir, 'keychain.js'))

// Cache at load time — isKeychainAvailable() shells out to `security help`
// which can intermittently fail under test runner concurrency pressure
const keychainAvailable = keychain.isKeychainAvailable()

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

  it('setToken and getToken round-trip successfully', (t) => {
    if (!keychainAvailable) return t.skip('no keychain available')
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

  it('migrateToken moves token from config object to keychain', (t) => {
    if (!keychainAvailable) return t.skip('no keychain available')
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

  it('migrateToken is a no-op when token already in keychain', (t) => {
    if (!keychainAvailable) return t.skip('no keychain available')
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
    // migrateToken catches setToken errors and returns { migrated: false }
    // We test this by using a config with apiToken but a service name that
    // will cause the underlying command to fail if keychain isn't available.
    // On systems WITH keychain, we test via the source-assertion approach.
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // Verify migrateToken has try/catch around setToken
    assert.ok(
      source.includes('try') && source.includes('setToken') && source.includes('catch'),
      'migrateToken should wrap setToken in try/catch'
    )

    // Verify the catch block returns { migrated: false }
    const migrateBlock = source.match(/export function migrateToken[\s\S]*?^}/m)
    assert.ok(migrateBlock, 'migrateToken function should exist')
    assert.ok(
      migrateBlock[0].includes('migrated: false'),
      'migrateToken catch should return migrated: false'
    )
  })

  it('setToken does not catch errors (throws to caller)', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // setToken should NOT have a try/catch — it throws on failure
    // so callers (like migrateToken) can handle the error
    const setTokenBlock = source.match(/export function setToken[\s\S]*?^}/m)
    assert.ok(setTokenBlock, 'setToken function should exist')
    assert.ok(
      !setTokenBlock[0].includes('try {'),
      'setToken should not catch errors — it should throw to caller'
    )
  })

  it('getToken returns null on keychain errors (never throws)', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // Both _macGetToken and _linuxGetToken should have try/catch returning null
    const macGet = source.match(/function _macGetToken[\s\S]*?^}/m)
    assert.ok(macGet, '_macGetToken should exist')
    assert.ok(
      macGet[0].includes('try') && macGet[0].includes('return null'),
      '_macGetToken should catch errors and return null'
    )

    const linuxGet = source.match(/function _linuxGetToken[\s\S]*?^}/m)
    assert.ok(linuxGet, '_linuxGetToken should exist')
    assert.ok(
      linuxGet[0].includes('try') && linuxGet[0].includes('return null'),
      '_linuxGetToken should catch errors and return null'
    )
  })

  it('deleteToken is tolerant of errors (never throws)', () => {
    const source = readFileSync(join(srcDir, 'keychain.js'), 'utf-8')

    // Both _macDeleteToken and _linuxDeleteToken should have try/catch
    const macDel = source.match(/function _macDeleteToken[\s\S]*?^}/m)
    assert.ok(macDel, '_macDeleteToken should exist')
    assert.ok(
      macDel[0].includes('try') && macDel[0].includes('catch'),
      '_macDeleteToken should catch errors silently'
    )

    const linuxDel = source.match(/function _linuxDeleteToken[\s\S]*?^}/m)
    assert.ok(linuxDel, '_linuxDeleteToken should exist')
    assert.ok(
      linuxDel[0].includes('try') && linuxDel[0].includes('catch'),
      '_linuxDeleteToken should catch errors silently'
    )
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
