import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyBinary,
  isBlockingQuarantine,
  describeBinaryHealth,
  BINARY_STATUS,
} from '../src/utils/verify-binary.js'

/**
 * Unit tests for pre-spawn binary integrity + quarantine verification (#6708).
 *
 * Every filesystem / xattr touchpoint is injected, so these run identically on
 * macOS, Linux, and Windows CI with NO real quarantined binary — the exact
 * "detection logic over a mocked fs/xattr layer" the issue calls for.
 */

// A stub seam bag that makes an absolute, existing, executable, clean binary.
function healthySeams(overrides = {}) {
  return {
    platform: 'darwin',
    isAbsolute: () => true,
    existsSync: () => true,
    accessSync: () => {}, // no throw = executable
    readQuarantineXattr: () => null, // no xattr = not quarantined
    ...overrides,
  }
}

describe('verifyBinary — existence + executability', () => {
  it('returns ok for an absolute, existing, executable, unquarantined binary', () => {
    const health = verifyBinary('/opt/homebrew/bin/codex', healthySeams())
    assert.equal(health.status, BINARY_STATUS.OK)
    assert.equal(health.ok, true)
    assert.equal(health.path, '/opt/homebrew/bin/codex')
    assert.equal(health.quarantine, null)
  })

  it('returns not_found for a non-absolute path (bare-name resolver fallback)', () => {
    // resolveBinary returns the bare name when nothing matched on PATH/candidates.
    const health = verifyBinary('codex', healthySeams({ isAbsolute: () => false }))
    assert.equal(health.status, BINARY_STATUS.NOT_FOUND)
    assert.equal(health.ok, false)
  })

  it('returns not_found when the path does not exist', () => {
    const health = verifyBinary('/opt/homebrew/bin/codex', healthySeams({ existsSync: () => false }))
    assert.equal(health.status, BINARY_STATUS.NOT_FOUND)
  })

  it('returns not_found for an empty/undefined path', () => {
    assert.equal(verifyBinary('', healthySeams()).status, BINARY_STATUS.NOT_FOUND)
    assert.equal(verifyBinary(undefined, healthySeams()).status, BINARY_STATUS.NOT_FOUND)
  })

  it('returns not_executable when access(X_OK) throws', () => {
    const health = verifyBinary('/opt/homebrew/bin/codex', healthySeams({
      accessSync: () => { throw new Error('EACCES') },
    }))
    assert.equal(health.status, BINARY_STATUS.NOT_EXECUTABLE)
    assert.equal(health.ok, false)
  })
})

describe('verifyBinary — macOS quarantine detection', () => {
  it('flags a present+executable binary carrying a blocking quarantine xattr', () => {
    let probedPath = null
    const health = verifyBinary('/opt/homebrew/bin/codex', healthySeams({
      readQuarantineXattr: (p) => { probedPath = p; return '0081;66a1b2c3;Safari;ABC-123' },
    }))
    assert.equal(health.status, BINARY_STATUS.QUARANTINED)
    assert.equal(health.ok, false)
    assert.equal(health.quarantine, '0081;66a1b2c3;Safari;ABC-123')
    // Only probed after existence + executable passed (the exact "passes preflight
    // then fails at exec" gap the issue describes).
    assert.equal(probedPath, '/opt/homebrew/bin/codex')
  })

  it('does NOT flag a quarantine xattr whose ASSESSMENT_OK (0x40) bit is set', () => {
    // 0x00c1 has 0x40 set → Gatekeeper-approved → launches normally.
    const health = verifyBinary('/opt/homebrew/bin/codex', healthySeams({
      readQuarantineXattr: () => '00c1;66a1b2c3;Safari;ABC-123',
    }))
    assert.equal(health.status, BINARY_STATUS.OK)
    assert.equal(health.quarantine, null)
  })

  it('treats an unparseable flags field as blocking (conservative)', () => {
    const health = verifyBinary('/opt/homebrew/bin/codex', healthySeams({
      readQuarantineXattr: () => 'not-hex;whatever',
    }))
    assert.equal(health.status, BINARY_STATUS.QUARANTINED)
  })
})

describe('verifyBinary — cross-platform safety', () => {
  it('skips the xattr probe entirely on linux', () => {
    let probed = false
    const health = verifyBinary('/usr/bin/codex', healthySeams({
      platform: 'linux',
      readQuarantineXattr: () => { probed = true; return '0081;x;y;z' },
    }))
    assert.equal(health.status, BINARY_STATUS.OK)
    assert.equal(probed, false, 'xattr must not be probed off darwin')
  })

  it('skips the xattr probe entirely on win32', () => {
    let probed = false
    const health = verifyBinary('C:/tools/codex.exe', healthySeams({
      platform: 'win32',
      readQuarantineXattr: () => { probed = true; return '0081;x;y;z' },
    }))
    assert.equal(health.status, BINARY_STATUS.OK)
    assert.equal(probed, false, 'xattr must not be probed off darwin')
  })
})

describe('isBlockingQuarantine', () => {
  it('returns false for empty/absent xattr', () => {
    assert.equal(isBlockingQuarantine(null), false)
    assert.equal(isBlockingQuarantine(undefined), false)
    assert.equal(isBlockingQuarantine(''), false)
  })

  it('returns true when the ASSESSMENT_OK bit is clear', () => {
    assert.equal(isBlockingQuarantine('0081;t;a;u'), true) // 0x81, no 0x40
    assert.equal(isBlockingQuarantine('0002;t;a;u'), true) // sandbox only
  })

  it('returns false when the ASSESSMENT_OK bit is set', () => {
    assert.equal(isBlockingQuarantine('0040;t;a;u'), false)
    assert.equal(isBlockingQuarantine('00c1;t;a;u'), false)
  })

  it('returns true for an unparseable flags field', () => {
    assert.equal(isBlockingQuarantine('zzzz;t;a;u'), true)
  })
})

describe('describeBinaryHealth', () => {
  it('produces a quarantine remediation naming the xattr command and path', () => {
    const { message, remediation } = describeBinaryHealth(
      { status: BINARY_STATUS.QUARANTINED, path: '/opt/homebrew/bin/codex' },
      { binary: 'codex', installHint: 'install Codex CLI' },
    )
    assert.match(message, /codex/)
    assert.match(message, /Gatekeeper/)
    assert.match(remediation, /xattr -d com\.apple\.quarantine \/opt\/homebrew\/bin\/codex/)
  })

  it('produces a not-found remediation using the install hint', () => {
    const { message } = describeBinaryHealth(
      { status: BINARY_STATUS.NOT_FOUND, path: '' },
      { binary: 'codex', installHint: 'install Codex CLI' },
    )
    assert.match(message, /not found/)
    assert.match(message, /install Codex CLI/)
  })

  it('produces a chmod remediation for a non-executable binary', () => {
    const { remediation } = describeBinaryHealth(
      { status: BINARY_STATUS.NOT_EXECUTABLE, path: '/opt/homebrew/bin/codex' },
      { binary: 'codex' },
    )
    assert.match(remediation, /chmod \+x \/opt\/homebrew\/bin\/codex/)
  })
})
