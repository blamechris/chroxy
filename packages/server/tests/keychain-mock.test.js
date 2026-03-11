/**
 * Runtime behavior tests for keychain failure paths using mock.module.
 *
 * Requires: --experimental-test-module-mocks flag
 * These tests mock child_process.execFileSync to simulate keychain binary
 * failures and verify the error handling contracts at runtime.
 *
 * Refs #1899
 */
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Skip entire suite if mock.module is unavailable (Node < 22.x without flag)
if (typeof mock.module !== 'function') {
  describe('Keychain mock-based runtime tests (#1899)', () => {
    it('skipped: mock.module not available (needs --experimental-test-module-mocks)', (t) => {
      t.skip('mock.module requires --experimental-test-module-mocks')
    })
  })
} else {
  // Mock child_process before importing keychain
  const cpMock = {
    execFileSync: mock.fn(() => '')
  }
  mock.module('child_process', { namedExports: cpMock })

  // Mock platform detection so tests run on any OS
  const platformMock = { isMac: true, isLinux: false, isWindows: false }
  mock.module('../src/platform.js', { namedExports: platformMock })

  // Import keychain AFTER mocking
  const keychain = await import('../src/keychain.js')

  describe('Keychain mock-based runtime tests (#1899)', () => {
    beforeEach(() => {
      cpMock.execFileSync.mock.resetCalls()
      // Default: simulate macOS
      platformMock.isMac = true
      platformMock.isLinux = false
    })

    describe('getToken failure handling', () => {
      it('returns null when execFileSync throws (macOS)', () => {
        cpMock.execFileSync.mock.mockImplementation(() => {
          throw new Error('security: SecKeychainSearchCopyNext failed')
        })

        const result = keychain.getToken('test-service')
        assert.equal(result, null, 'getToken should return null on keychain error')
      })

      it('returns null when execFileSync throws (Linux)', () => {
        platformMock.isMac = false
        platformMock.isLinux = true
        cpMock.execFileSync.mock.mockImplementation(() => {
          throw new Error('secret-tool: No matching items found')
        })

        const result = keychain.getToken('test-service')
        assert.equal(result, null, 'getToken should return null on keychain error')
      })
    })

    describe('setToken error propagation', () => {
      it('throws when execFileSync throws (macOS)', () => {
        // isKeychainAvailable needs to work first
        let callCount = 0
        cpMock.execFileSync.mock.mockImplementation(() => {
          callCount++
          // First call might be isKeychainAvailable check, subsequent is setToken
          if (callCount > 0) {
            throw new Error('security: permission denied')
          }
          return ''
        })

        assert.throws(
          () => keychain.setToken('test-token', 'test-service'),
          /permission denied/,
          'setToken should propagate the error to caller'
        )
      })
    })

    describe('deleteToken error tolerance', () => {
      it('does not throw when execFileSync throws (macOS)', () => {
        cpMock.execFileSync.mock.mockImplementation(() => {
          throw new Error('security: item not found')
        })

        // Should not throw
        assert.doesNotThrow(
          () => keychain.deleteToken('test-service'),
          'deleteToken should swallow errors'
        )
      })

      it('does not throw when execFileSync throws (Linux)', () => {
        platformMock.isMac = false
        platformMock.isLinux = true
        cpMock.execFileSync.mock.mockImplementation(() => {
          throw new Error('secret-tool: item not found')
        })

        assert.doesNotThrow(
          () => keychain.deleteToken('test-service'),
          'deleteToken should swallow errors'
        )
      })
    })

    describe('migrateToken fallback behavior', () => {
      it('returns migrated:false when setToken throws', () => {
        let callCount = 0
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          callCount++
          // isKeychainAvailable → success (security help)
          if (args && args[0] === 'help') return ''
          // getToken (find-generic-password) → not found (throw)
          if (args && args[0] === 'find-generic-password') {
            throw new Error('not found')
          }
          // setToken (add-generic-password) → fail
          if (args && args[0] === 'add-generic-password') {
            throw new Error('keychain locked')
          }
          return ''
        })

        const config = { apiToken: 'my-secret-token', port: 8765 }
        const result = keychain.migrateToken(config, 'test-service')

        assert.equal(result.migrated, false, 'should return migrated:false on setToken failure')
        assert.equal(result.config.apiToken, 'my-secret-token', 'original config should be unchanged')
        assert.equal(result.config.port, 8765, 'other config keys preserved')
      })

      it('returns migrated:true when keychain write succeeds', () => {
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          // isKeychainAvailable → success
          if (args && args[0] === 'help') return ''
          // getToken → not found
          if (args && args[0] === 'find-generic-password') {
            throw new Error('not found')
          }
          // setToken → success
          return ''
        })

        const config = { apiToken: 'my-secret-token', port: 8765 }
        const result = keychain.migrateToken(config, 'test-service')

        assert.equal(result.migrated, true, 'should return migrated:true on success')
        assert.equal(result.config.apiToken, undefined, 'token removed from config')
        assert.equal(result.config.port, 8765, 'other config keys preserved')
      })
    })
  })
}
