import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VALID_USERNAME_RE, HEX64 } from '../src/utils/validation-patterns.js'

/**
 * Contract for the shared validation regexes (#6201). These two patterns were
 * previously copied verbatim across environment-manager.js, docker-sdk-session.js,
 * docker-byok-session.js, environments/backends/docker.js (username) and
 * path-hash-trust-ledger.js, skills-trust.js (hex64). Pinning the contract here
 * guards the single source against a future drift that would silently loosen one
 * call site's input validation.
 */

describe('VALID_USERNAME_RE', () => {
  describe('accepts valid POSIX/container usernames', () => {
    for (const name of ['chroxy', 'root', 'a', '_svc', 'node22', 'user-name', 'a_b-c']) {
      it(`accepts ${JSON.stringify(name)}`, () => {
        assert.equal(VALID_USERNAME_RE.test(name), true)
      })
    }

    it('accepts a 32-char name (1 leading + 31 trailing — the useradd limit)', () => {
      assert.equal(VALID_USERNAME_RE.test('a' + 'b'.repeat(31)), true)
    })
  })

  describe('rejects invalid input', () => {
    for (const bad of [
      '', // empty
      '1user', // leading digit
      '-user', // leading hyphen
      'User', // uppercase
      'a'.repeat(33), // 33 chars — over the 32 limit
      'user name', // space
      'user;rm -rf', // shell metacharacter
      'user\n', // trailing newline (anchors are not multiline)
      '-u', // a smuggled `docker exec` flag
    ]) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        assert.equal(VALID_USERNAME_RE.test(bad), false)
      })
    }
  })
})

describe('HEX64', () => {
  // 64 lowercase hex characters.
  const SHA256 = 'abcdef0123456789'.repeat(4)

  describe('accepts a 64-char lowercase hex digest', () => {
    for (const hex of [SHA256, '0'.repeat(64), 'f'.repeat(64)]) {
      it(`accepts a digest starting ${hex.slice(0, 8)}…`, () => {
        assert.equal(HEX64.test(hex), true)
      })
    }
  })

  describe('rejects invalid input', () => {
    for (const bad of [
      '', // empty
      SHA256.slice(0, 63), // 63 chars — too short
      SHA256 + '0', // 65 chars — too long
      'A'.repeat(64), // uppercase — must be lowercase
      'g'.repeat(64), // non-hex character
      SHA256.slice(0, 63) + ' ', // trailing space
    ]) {
      it(`rejects ${JSON.stringify(bad.length > 16 ? bad.slice(0, 16) + '…' : bad)}`, () => {
        assert.equal(HEX64.test(bad), false)
      })
    }
  })
})
