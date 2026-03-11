import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

describe('Keychain token storage (#1838)', () => {
  let keychain

  before(async () => {
    keychain = await import(join(srcDir, 'keychain.js'))
  })

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

  it('setToken and getToken round-trip successfully', () => {
    if (!keychain.isKeychainAvailable()) {
      // Skip if no keychain available (CI)
      return
    }
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

  it('migrateToken moves token from config object to keychain', () => {
    if (!keychain.isKeychainAvailable()) return

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

  it('migrateToken is a no-op when token already in keychain', () => {
    if (!keychain.isKeychainAvailable()) return

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

  it('config.js loadTokenFromKeychain function exists in source', () => {
    const source = readFileSync(join(srcDir, 'config.js'), 'utf-8')
    assert.ok(
      source.includes('loadTokenFromKeychain') || source.includes('keychain'),
      'config.js should reference keychain for token loading'
    )
  })

  it('server-cli.js uses keychain for token persistence', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(
      source.includes('keychain'),
      'server-cli.js should import or reference keychain module'
    )
  })
})
