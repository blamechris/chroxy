import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyBinary,
  isBlockingQuarantine,
  describeBinaryHealth,
  labelBinarySpawnFailure,
  readQuarantineXattr,
  shellQuotePath,
  MACOS_XATTR,
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

describe('labelBinarySpawnFailure — shared spawn-time backstop (#6708)', () => {
  it('verifies the EXACT attempted path (not a re-resolve) and labels quarantine', () => {
    let verifiedPath = null
    const quarantined = (path) => {
      verifiedPath = path
      return { ok: false, status: BINARY_STATUS.QUARANTINED, path, quarantine: '0081;a;b;c' }
    }
    const msg = labelBinarySpawnFailure({
      attemptedPath: '/opt/homebrew/bin/codex',
      binary: 'codex',
      verify: quarantined,
    })
    assert.equal(verifiedPath, '/opt/homebrew/bin/codex', 'must verify the attempted path verbatim')
    assert.ok(msg, 'expected a labeled message')
    assert.match(msg, /^Failed to spawn codex:/)
    assert.match(msg, /Gatekeeper/)
    assert.match(msg, /xattr -d com\.apple\.quarantine \/opt\/homebrew\/bin\/codex/)
  })

  it('labels a vanished-at-spawn binary as not found', () => {
    const gone = (path) => ({ ok: false, status: BINARY_STATUS.NOT_FOUND, path, quarantine: null })
    const msg = labelBinarySpawnFailure({ attemptedPath: 'codex', binary: 'codex', verify: gone })
    assert.match(msg, /Failed to spawn codex:.*not found/)
  })

  it('labels a present-but-not-executable binary (with a chmod fix)', () => {
    const notExec = (path) => ({ ok: false, status: BINARY_STATUS.NOT_EXECUTABLE, path, quarantine: null })
    const msg = labelBinarySpawnFailure({
      attemptedPath: '/opt/homebrew/bin/codex',
      binary: 'codex',
      verify: notExec,
    })
    assert.match(msg, /not executable/)
    assert.match(msg, /chmod \+x \/opt\/homebrew\/bin\/codex/)
  })

  it('honors a custom prefix (PTY / app-server call sites)', () => {
    const gone = (path) => ({ ok: false, status: BINARY_STATUS.NOT_FOUND, path, quarantine: null })
    const msg = labelBinarySpawnFailure({
      attemptedPath: 'claude',
      binary: 'claude',
      prefix: 'Failed to spawn claude under PTY',
      verify: gone,
    })
    assert.match(msg, /^Failed to spawn claude under PTY:/)
  })

  it('returns null when the binary is healthy (caller keeps its own error)', () => {
    const ok = (path) => ({ ok: true, status: BINARY_STATUS.OK, path, quarantine: null })
    assert.equal(labelBinarySpawnFailure({ attemptedPath: '/bin/x', binary: 'x', verify: ok }), null)
  })

  it('returns null for an empty/missing attemptedPath (no verify call)', () => {
    let called = false
    const spy = () => { called = true; return { ok: false, status: BINARY_STATUS.NOT_FOUND, path: '', quarantine: null } }
    assert.equal(labelBinarySpawnFailure({ attemptedPath: '', binary: 'x', verify: spy }), null)
    assert.equal(labelBinarySpawnFailure({ attemptedPath: undefined, binary: 'x', verify: spy }), null)
    assert.equal(called, false, 'verify must not run without a concrete attempted path')
  })

  it('returns null (no crash) when verify itself throws', () => {
    const msg = labelBinarySpawnFailure({
      attemptedPath: '/bin/x',
      binary: 'x',
      verify: () => { throw new Error('boom') },
    })
    assert.equal(msg, null)
  })
})

describe('readQuarantineXattr — invokes the ABSOLUTE system xattr (#6708 security)', () => {
  it('execs /usr/bin/xattr, never a bare PATH-resolved "xattr"', () => {
    let calledCmd = null
    let calledArgs = null
    const execSpy = (cmd, args) => { calledCmd = cmd; calledArgs = args; return '0081;a;b;c\n' }
    const value = readQuarantineXattr('/opt/homebrew/bin/codex', { execFile: execSpy })
    assert.equal(calledCmd, '/usr/bin/xattr', 'must use the absolute system path, not a PATH lookup')
    assert.equal(MACOS_XATTR, '/usr/bin/xattr')
    assert.deepEqual(calledArgs, ['-p', 'com.apple.quarantine', '/opt/homebrew/bin/codex'])
    assert.equal(value, '0081;a;b;c')
  })

  it('returns null when the attribute is absent (xattr exits non-zero)', () => {
    const execThrows = () => { throw Object.assign(new Error('No such xattr'), { status: 1 }) }
    assert.equal(readQuarantineXattr('/bin/x', { execFile: execThrows }), null)
  })
})

describe('shellQuotePath — copy-pasteable remediations for spaced paths (#6708)', () => {
  it('leaves an already-safe path unquoted', () => {
    assert.equal(shellQuotePath('/opt/homebrew/bin/codex'), '/opt/homebrew/bin/codex')
  })

  it('single-quotes a path containing spaces', () => {
    assert.equal(shellQuotePath('/Users/me/My Tools/codex'), "'/Users/me/My Tools/codex'")
  })

  it('escapes embedded single quotes', () => {
    assert.equal(shellQuotePath("/a/b'c/codex"), "'/a/b'\\''c/codex'")
  })

  it('describeBinaryHealth quotes a spaced path in the xattr remediation', () => {
    const { remediation } = describeBinaryHealth(
      { status: BINARY_STATUS.QUARANTINED, path: '/Users/me/My Tools/codex' },
      { binary: 'codex' },
    )
    assert.match(remediation, /xattr -d com\.apple\.quarantine '\/Users\/me\/My Tools\/codex'/)
  })

  it('describeBinaryHealth quotes a spaced path in the chmod remediation', () => {
    const { remediation } = describeBinaryHealth(
      { status: BINARY_STATUS.NOT_EXECUTABLE, path: '/Users/me/My Tools/codex' },
      { binary: 'codex' },
    )
    assert.match(remediation, /chmod \+x '\/Users\/me\/My Tools\/codex'/)
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
