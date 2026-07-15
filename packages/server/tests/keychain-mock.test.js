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
  // These tests drive keychain.js's real code path with a MOCKED child_process,
  // so they never touch the OS keychain. Clear the suite-wide disable flag
  // (`tests/_setup.mjs` sets CHROXY_DISABLE_KEYCHAIN=1) so isKeychainAvailable()
  // / getToken() reach the mocked execFileSync instead of short-circuiting.
  delete process.env.CHROXY_DISABLE_KEYCHAIN

  const cpMock = {
    execFileSync: mock.fn(() => '')
  }
  mock.module('child_process', { namedExports: cpMock })

  // Mock platform detection so tests run on any OS. writeFileRestricted is
  // imported by keychain.js for the Windows DPAPI path (#6644) but never called
  // on the mac/linux paths these tests exercise — stub it so the module mock
  // provides every named export keychain.js imports.
  const platformMock = { isMac: true, isLinux: false, isWindows: false, writeFileRestricted: () => {} }
  mock.module('../src/platform.js', { namedExports: platformMock })

  // Import keychain AFTER mocking
  const keychain = await import('../src/keychain.js')

  describe('Keychain mock-based runtime tests (#1899)', () => {
    beforeEach(() => {
      // Reset both call history and implementation to avoid inter-test leakage
      cpMock.execFileSync.mock.resetCalls()
      cpMock.execFileSync.mock.mockImplementation(() => '')
      // Default: simulate macOS
      platformMock.isMac = true
      platformMock.isLinux = false
      // The usability probe (`security default-keychain`) is cached per-process;
      // clear it so each test re-probes against its own mock (and a throw-all
      // test doesn't poison `usable=false` for the next one).
      keychain._resetKeychainHealthForTests()
    })

    describe('getToken failure handling', () => {
      it('returns null when execFileSync throws (macOS)', () => {
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          // Let the usability probe pass so the op-under-test still runs.
          if (args && args[0] === 'default-keychain') return ''
          throw new Error('security: SecKeychainSearchCopyNext failed')
        })

        const result = keychain.getToken('test-service')
        assert.equal(result, null, 'getToken should return null on keychain error')
      })

      // Note: named ES module imports (isMac/isLinux) are bound at import time;
      // platformMock mutations don't re-route to the Linux code path. This test
      // verifies the same null-return contract with a Linux-style error message.
      // True Linux-path coverage requires a Linux CI environment.
      it('returns null when execFileSync throws (Linux-style error)', () => {
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          // Let the usability probe pass so the op-under-test still runs.
          if (args && args[0] === 'default-keychain') return ''
          throw new Error('secret-tool: No matching items found')
        })

        const result = keychain.getToken('test-service')
        assert.equal(result, null, 'getToken should return null on keychain error')
      })
    })

    describe('setToken error propagation', () => {
      it('throws when execFileSync throws (macOS)', () => {
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          // Let the usability probe pass so the op-under-test still runs.
          if (args && args[0] === 'default-keychain') return ''
          throw new Error('security: permission denied')
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
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          // Let the usability probe pass so the op-under-test still runs.
          if (args && args[0] === 'default-keychain') return ''
          throw new Error('security: item not found')
        })

        // Should not throw
        assert.doesNotThrow(
          () => keychain.deleteToken('test-service'),
          'deleteToken should swallow errors'
        )
      })

      // Note: same binding limitation as getToken — this verifies the error-swallow
      // contract with a Linux-style error message on the macOS code path.
      it('does not throw when execFileSync throws (Linux-style error)', () => {
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          // Let the usability probe pass so the op-under-test still runs.
          if (args && args[0] === 'default-keychain') return ''
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
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
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

    // Broken / missing login keychain: the `security default-keychain` probe
    // reports a path that doesn't exist, so every op must short-circuit to the
    // file fallback WITHOUT shelling out to the prompting find-/add-/delete-
    // generic-password calls (which pop the "keychain cannot be found" modal).
    describe('broken keychain (missing login keychain file) — no prompting ops', () => {
      const MISSING = '/definitely/not/a/real/path/login.keychain-db'
      function brokenMock() {
        cpMock.execFileSync.mock.mockImplementation((cmd, args) => {
          if (args && args[0] === 'default-keychain') return `"${MISSING}"`
          // Any OTHER security call would be a prompting op — fail loudly so the
          // test catches a regression that lets one through.
          throw new Error(`unexpected prompting keychain call: ${args && args[0]}`)
        })
      }
      const promptingCalls = () =>
        cpMock.execFileSync.mock.calls.filter(
          (c) => Array.isArray(c.arguments?.[1]) &&
            ['find-generic-password', 'add-generic-password', 'delete-generic-password'].includes(c.arguments[1][0]),
        )

      it('isKeychainAvailable() is false when the default keychain file is missing', () => {
        brokenMock()
        assert.equal(keychain.isKeychainAvailable(), false)
      })

      it('getToken() returns null without a prompting find call', () => {
        brokenMock()
        assert.equal(keychain.getToken('test-service'), null)
        assert.equal(promptingCalls().length, 0, 'must not call find-generic-password on a broken keychain')
      })

      it('setToken() no-ops (no throw, no prompting add call)', () => {
        brokenMock()
        assert.doesNotThrow(() => keychain.setToken('tok', 'test-service'))
        assert.equal(promptingCalls().length, 0, 'must not call add-generic-password on a broken keychain')
      })

      it('getTokenStatus() returns "error" (fail-safe), not "absent" (#5615)', () => {
        brokenMock()
        const r = keychain.getTokenStatus('test-service')
        assert.equal(r.status, 'error', 'a broken keychain must NOT read as absent (would re-mint identity)')
        assert.equal(promptingCalls().length, 0)
      })

      it('keychainHealth() reports broken + file backend + a repair hint (#6236)', () => {
        brokenMock()
        const h = keychain.keychainHealth()
        assert.equal(h.status, 'broken')
        assert.equal(h.backend, 'file')
        assert.ok(h.detail && h.detail.length > 0, 'detail present')
        assert.ok(h.repairHint && h.repairHint.length > 0, 'broken status carries a repair hint')
        assert.equal(promptingCalls().length, 0, 'keychainHealth must not prompt')
      })
    })

    // #6236 — keychainHealth() is the non-prompting source of truth chroxy doctor
    // uses to surface where credentials live.
    describe('keychainHealth (#6236)', () => {
      it('reports usable + keychain backend when the default keychain exists', () => {
        // Default mock: `security default-keychain` returns '' (inconclusive →
        // usable per the probe), so health is usable.
        cpMock.execFileSync.mock.mockImplementation((cmd, args) =>
          args && args[0] === 'default-keychain' ? '' : '',
        )
        const h = keychain.keychainHealth()
        assert.equal(h.status, 'usable')
        assert.equal(h.backend, 'keychain')
        assert.equal(h.repairHint, undefined)
      })

      it('reports disabled + file backend when CHROXY_DISABLE_KEYCHAIN is set', () => {
        process.env.CHROXY_DISABLE_KEYCHAIN = '1'
        try {
          const h = keychain.keychainHealth()
          assert.equal(h.status, 'disabled')
          assert.equal(h.backend, 'file')
        } finally {
          delete process.env.CHROXY_DISABLE_KEYCHAIN
        }
      })
    })
  })
}
