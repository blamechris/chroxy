import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runProviderPreflight,
  ProviderBinaryNotFoundError,
  ProviderBinaryQuarantinedError,
  ProviderBinaryProvenanceError,
  ProviderBinaryUnsupportedError,
  ProviderBinaryVersionError,
  ProviderCredentialMissingError,
} from '../src/utils/preflight.js'
import { BINARY_STATUS } from '../src/utils/verify-binary.js'
import { PROVENANCE_STATUS } from '../src/utils/verify-provenance.js'
import { SdkSession } from '../src/sdk-session.js'

/**
 * Tests for runProviderPreflight — verifies binary + credential checks
 * run BEFORE provider session construction so missing tooling surfaces
 * as a clean error rather than a cryptic ENOENT at spawn time. (#2962)
 */

// Helper to build a synthetic provider class with the minimum surface
// runProviderPreflight inspects.
function makeProvider({ preflight, capabilities } = {}) {
  class FakeSession {
    static get preflight() { return preflight }
    static get capabilities() { return capabilities || {} }
  }
  // Drop the getter when caller passes undefined so the behaviour matches a
  // provider that simply doesn't declare preflight at all.
  if (preflight === undefined) {
    Object.defineProperty(FakeSession, 'preflight', { get: () => undefined })
  }
  return FakeSession
}

describe('runProviderPreflight — binary checks', () => {
  it('throws ProviderBinaryNotFoundError when binary cannot be located', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Codex',
        binary: {
          name: '__chroxy_definitely_not_a_real_binary__',
          candidates: ['/var/empty/nope-1', '/var/empty/nope-2'],
          installHint: 'install Codex CLI',
        },
      },
    })

    assert.throws(
      () => runProviderPreflight(Provider, { env: {} }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryNotFoundError, 'expected ProviderBinaryNotFoundError')
        assert.equal(err.code, 'PROVIDER_BINARY_NOT_FOUND')
        assert.equal(err.binary, '__chroxy_definitely_not_a_real_binary__')
        assert.match(err.message, /Codex/)
        assert.match(err.message, /install Codex CLI/)
        // Message must enumerate where we looked so the user can fix PATH.
        assert.match(err.message, /\/var\/empty\/nope-1/)
        return true
      },
    )
  })

  it('passes when binary exists on PATH', () => {
    // `node` is always on PATH for the test runner.
    const Provider = makeProvider({
      preflight: {
        label: 'Node',
        binary: { name: 'node', candidates: [], installHint: 'install Node' },
      },
    })
    assert.doesNotThrow(() => runProviderPreflight(Provider, { env: {} }))
  })

  it('passes when binary is found via candidate path', async () => {
    // Resolve the real node path from PATH then pass it as a candidate
    // under a fake name. resolveBinary returns the absolute path of
    // whichever candidate exists first, so this validates the fallback path.
    const { resolveBinary } = await import('../src/utils/resolve-binary.js')
    const { isAbsolute } = await import('node:path')
    const nodePath = resolveBinary('node', [])
    // Cross-platform: an absolute path on POSIX (/usr/bin/node) or Windows
    // (C:\...\node.exe) — resolveBinary uses `which`/`where` respectively.
    assert.ok(isAbsolute(nodePath), `precondition: node must be on PATH (got: ${nodePath})`)

    const Provider = makeProvider({
      preflight: {
        label: 'Fake',
        binary: {
          name: '__chroxy_fake_name_for_test__',
          candidates: [nodePath],
          installHint: 'install fake',
        },
      },
    })
    assert.doesNotThrow(() => runProviderPreflight(Provider, { env: {} }))
  })
})

describe('runProviderPreflight — quarantine detection (#6708)', () => {
  it('throws ProviderBinaryQuarantinedError when the binary is present but quarantined', () => {
    // `node` resolves to a real absolute path; the injected verifyBinary reports
    // it as QUARANTINED so we exercise the branch with no real quarantined file.
    const Provider = makeProvider({
      preflight: {
        label: 'Codex',
        binary: { name: 'node', candidates: [], installHint: 'install Codex CLI' },
      },
    })
    const fakeVerify = (path) => ({
      ok: false,
      status: BINARY_STATUS.QUARANTINED,
      path,
      quarantine: '0081;66a1;Safari;uuid',
    })
    assert.throws(
      () => runProviderPreflight(Provider, { env: {}, verifyBinary: fakeVerify }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryQuarantinedError, `got ${err?.name}`)
        assert.equal(err.code, 'PROVIDER_BINARY_QUARANTINED')
        assert.equal(err.binary, 'node')
        assert.equal(err.quarantine, '0081;66a1;Safari;uuid')
        assert.match(err.message, /Gatekeeper/)
        assert.match(err.message, /xattr -d com\.apple\.quarantine/)
        return true
      },
    )
  })

  it('verifies the provider\'s live resolvedBinary path when it exposes one', () => {
    // Preflight must check the SAME path the spawn will use (not a stale const),
    // so a provider with a resolvedBinary getter has THAT path handed to verify.
    let verifiedPath = null
    class Provider {
      static get preflight() {
        return { label: 'Codex', binary: { name: 'codex', candidates: [] } }
      }
      static get capabilities() { return {} }
      static get resolvedBinary() { return '/custom/spawn/path/codex' }
    }
    const fakeVerify = (path) => {
      verifiedPath = path
      return { ok: true, status: BINARY_STATUS.OK, path, quarantine: null }
    }
    const result = runProviderPreflight(Provider, { env: {}, verifyBinary: fakeVerify })
    assert.equal(verifiedPath, '/custom/spawn/path/codex')
    assert.deepEqual(result, { binaryPath: '/custom/spawn/path/codex' },
      'the exact verified path must be returned to the session spawn path')
  })

  it('a not-found result (ok:false) throws ProviderBinaryNotFoundError, not the quarantine error', () => {
    const Provider = makeProvider({
      preflight: { label: 'X', binary: { name: 'node', candidates: [] } },
    })
    const notFound = () => ({ ok: false, status: BINARY_STATUS.NOT_FOUND, path: 'node', quarantine: null })
    assert.throws(
      () => runProviderPreflight(Provider, { env: {}, verifyBinary: notFound }),
      ProviderBinaryNotFoundError,
    )
  })

  it('a not-executable result (ok:false) also throws ProviderBinaryNotFoundError', () => {
    const Provider = makeProvider({
      preflight: { label: 'X', binary: { name: 'node', candidates: [] } },
    })
    const notExec = (path) => ({ ok: false, status: BINARY_STATUS.NOT_EXECUTABLE, path, quarantine: null })
    assert.throws(
      () => runProviderPreflight(Provider, { env: {}, verifyBinary: notExec }),
      ProviderBinaryNotFoundError,
    )
  })
})

describe('runProviderPreflight — opt-in provenance gate (#6858)', () => {
  // A healthy binary so we always reach the provenance step.
  const okVerify = (path) => ({ ok: true, status: BINARY_STATUS.OK, path, quarantine: null })
  const Provider = makeProvider({
    preflight: { label: 'Codex', binary: { name: 'node', candidates: [] } },
  })

  // Minimal in-memory pin ledger (getRecord + approve) for end-to-end tests.
  function fakeLedger(seed = {}) {
    const records = new Map(Object.entries(seed))
    return {
      getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
      approve: (p, h) => { records.set(p, { sha256: h, firstSeen: 'x', approvedAt: 'x' }); return true },
      _records: records,
    }
  }

  it('is SKIPPED entirely when no provenance config is supplied (default)', () => {
    // Inject a provenance checker that would explode if called — it must not be.
    const boom = () => { throw new Error('provenance must not run when disabled') }
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, { env: {}, verifyBinary: okVerify, verifyProvenance: boom }),
    )
  })

  it('is SKIPPED when provenance mode is off and the signature gate is off', () => {
    const boom = () => { throw new Error('provenance must not run when off') }
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        verifyProvenance: boom,
        provenance: { mode: 'off', signatureGate: false, ledger: fakeLedger() },
      }),
    )
  })

  it('block mode + a blocked verdict throws ProviderBinaryProvenanceError (fail-safe)', () => {
    const blockedVerdict = () => ({
      ok: false,
      status: PROVENANCE_STATUS.HASH_MISMATCH,
      blocked: true,
      path: '/usr/bin/node',
      hash: 'b'.repeat(64),
      pinnedHash: 'a'.repeat(64),
      message: 'binary hash changed since it was pinned',
      remediation: 're-approve it',
    })
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        verifyProvenance: blockedVerdict,
        provenance: { mode: 'block', signatureGate: false, ledger: fakeLedger() },
      }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryProvenanceError, `got ${err?.name}`)
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        assert.equal(err.binary, 'node')
        assert.equal(err.provenanceStatus, PROVENANCE_STATUS.HASH_MISMATCH)
        assert.equal(err.pinnedHash, 'a'.repeat(64))
        assert.match(err.message, /changed/i)
        return true
      },
    )
  })

  it('warn mode + a non-blocked mismatch does NOT throw (surfaced, allowed)', () => {
    const warnVerdict = () => ({
      ok: true,
      status: PROVENANCE_STATUS.HASH_MISMATCH,
      blocked: false,
      path: '/usr/bin/node',
      hash: 'b'.repeat(64),
      pinnedHash: 'a'.repeat(64),
      message: 'binary hash changed since it was pinned',
    })
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        verifyProvenance: warnVerdict,
        provenance: { mode: 'warn', signatureGate: false, ledger: fakeLedger() },
      }),
    )
  })

  it('returns the same binary path only after the configured provenance gate allows it', () => {
    const calls = []
    const checkedPath = '/verified/provider/binary'
    const ledger = fakeLedger()
    const result = runProviderPreflight(Provider, {
      env: {},
      verifyBinary: () => {
        calls.push('binary')
        return { ok: true, status: BINARY_STATUS.OK, path: checkedPath, quarantine: null }
      },
      verifyProvenance: (options) => {
        calls.push('provenance')
        assert.equal(options.resolvedPath, checkedPath)
        assert.equal(options.mode, 'block')
        assert.equal(options.signatureGate, true)
        assert.equal(options.ledger, ledger)
        return { ok: true, status: PROVENANCE_STATUS.PINNED, blocked: false, path: options.resolvedPath }
      },
      provenance: { mode: 'block', signatureGate: true, ledger },
    })
    assert.deepEqual(calls, ['binary', 'provenance'])
    assert.deepEqual(result, { binaryPath: checkedPath })
  })

  it('end-to-end: real verifyProvenance pins on first sight, then blocks a swapped hash', () => {
    // First sight over the REAL node binary + a fresh ledger: pins + allows.
    const led = fakeLedger()
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        provenance: { mode: 'block', signatureGate: false, ledger: led },
      }),
    )
    assert.equal(led._records.size, 1, 'first sight pinned exactly one binary')

    // Now simulate an in-place swap: overwrite the pinned hash with a bogus one.
    for (const [p, rec] of led._records) led._records.set(p, { ...rec, sha256: 'c'.repeat(64) })

    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        provenance: { mode: 'block', signatureGate: false, ledger: led },
      }),
      ProviderBinaryProvenanceError,
    )
  })
})

describe('runProviderPreflight — minimum version gate (#7986)', () => {
  // A healthy, non-quarantined, provenance-agnostic binary so every test in
  // this block reaches the version gate.
  const okVerify = (path) => ({ ok: true, status: BINARY_STATUS.OK, path, quarantine: null })

  function makeVersionedProvider(minVersion) {
    return makeProvider({
      preflight: {
        label: 'Claude SDK',
        binary: { name: 'claude', args: ['--version'], candidates: [], minVersion },
      },
    })
  }

  it('throws ProviderBinaryVersionError with found/required when the installed binary is too old', () => {
    const Provider = makeVersionedProvider('2.1.141')
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        probeVersion: () => '2.1.80',
      }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryVersionError, `got ${err?.name}`)
        assert.equal(err.code, 'PROVIDER_BINARY_VERSION')
        assert.equal(err.reason, 'too_old')
        assert.equal(err.found, '2.1.80')
        assert.equal(err.required, '2.1.141')
        // makeVersionedProvider declares no updateHint/installHint, so the
        // remediation falls back to the generic `update <name>` (#7986 review S2).
        assert.match(err.message, /update claude/)
        return true
      },
    )
  })

  it('passes when the installed version equals the required minimum exactly', () => {
    const Provider = makeVersionedProvider('2.1.141')
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, { env: {}, verifyBinary: okVerify, probeVersion: () => '2.1.141' }),
    )
  })

  it('passes when the installed version is newer than the required minimum', () => {
    const Provider = makeVersionedProvider('2.1.141')
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, { env: {}, verifyBinary: okVerify, probeVersion: () => '2.1.283' }),
    )
  })

  it('throws with reason "unreadable" when the probe cannot determine a version', () => {
    const Provider = makeVersionedProvider('2.1.141')
    assert.throws(
      () => runProviderPreflight(Provider, { env: {}, verifyBinary: okVerify, probeVersion: () => null }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryVersionError, `got ${err?.name}`)
        assert.equal(err.reason, 'unreadable')
        assert.equal(err.found, null)
        return true
      },
    )
  })

  it('a null minVersion (thunk) skips the check without throwing', () => {
    const Provider = makeVersionedProvider(() => null)
    let probeCalled = false
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        probeVersion: () => { probeCalled = true; return '9.9.9' },
      }),
    )
    assert.equal(probeCalled, false, 'the probe must not run when minVersion resolves to null')
  })

  it('an invalid (unparseable) minVersion string skips the check without throwing', () => {
    const Provider = makeVersionedProvider('not-a-real-version')
    let probeCalled = false
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        probeVersion: () => { probeCalled = true; return '9.9.9' },
      }),
    )
    assert.equal(probeCalled, false)
  })

  it('a provider with no minVersion key at all never calls the probe', () => {
    const Provider = makeProvider({
      preflight: { label: 'X', binary: { name: 'node', candidates: [] } },
    })
    let probeCalled = false
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        probeVersion: () => { probeCalled = true; return '1.0.0' },
      }),
    )
    assert.equal(probeCalled, false, 'minVersion is optional — no key means no probe at all')
  })

  it('resolves a thunk minVersion once per call (e.g. sdkClaudeCodeVersion())', () => {
    let thunkCalls = 0
    const Provider = makeVersionedProvider(() => { thunkCalls += 1; return '2.1.141' })
    runProviderPreflight(Provider, { env: {}, verifyBinary: okVerify, probeVersion: () => '2.1.200' })
    assert.equal(thunkCalls, 1)
  })

  it('the probe is NOT called when the binary is not found', () => {
    const Provider = makeVersionedProvider('2.1.141')
    let probeCalled = false
    const notFound = () => ({ ok: false, status: BINARY_STATUS.NOT_FOUND, path: 'claude', quarantine: null })
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: notFound,
        probeVersion: () => { probeCalled = true; return '9.9.9' },
      }),
      ProviderBinaryNotFoundError,
    )
    assert.equal(probeCalled, false, 'a missing binary must never reach the version probe')
  })

  it('the probe is NOT called when the binary is quarantined', () => {
    const Provider = makeVersionedProvider('2.1.141')
    let probeCalled = false
    const quarantined = (path) => ({ ok: false, status: BINARY_STATUS.QUARANTINED, path, quarantine: '0081;x;x;x' })
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: quarantined,
        probeVersion: () => { probeCalled = true; return '9.9.9' },
      }),
      ProviderBinaryQuarantinedError,
    )
    assert.equal(probeCalled, false, 'a quarantined binary must never reach the version probe')
  })

  it('the probe is NOT called when block-mode provenance fails', () => {
    const Provider = makeVersionedProvider('2.1.141')
    let probeCalled = false
    const blockedVerdict = () => ({
      ok: false,
      status: PROVENANCE_STATUS.HASH_MISMATCH,
      blocked: true,
      path: '/fake/claude',
      hash: 'b'.repeat(64),
      pinnedHash: 'a'.repeat(64),
      message: 'binary hash changed since it was pinned',
      remediation: 're-approve it',
    })
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        verifyProvenance: blockedVerdict,
        provenance: { mode: 'block', signatureGate: false, ledger: {} },
        probeVersion: () => { probeCalled = true; return '9.9.9' },
      }),
      ProviderBinaryProvenanceError,
    )
    assert.equal(probeCalled, false, 'a block-mode provenance failure must never reach the version probe')
  })

  it('the probe IS called after a warn-mode provenance issue (that gate does not block)', () => {
    const Provider = makeVersionedProvider('2.1.141')
    let probeCalled = false
    const warnVerdict = () => ({
      ok: true,
      status: PROVENANCE_STATUS.HASH_MISMATCH,
      blocked: false,
      path: '/fake/claude',
      hash: 'b'.repeat(64),
      pinnedHash: 'a'.repeat(64),
      message: 'hash changed',
    })
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        verifyProvenance: warnVerdict,
        provenance: { mode: 'warn', signatureGate: false, ledger: {} },
        probeVersion: () => { probeCalled = true; return '2.1.200' },
      }),
    )
    assert.equal(probeCalled, true, 'warn-mode does not block, so the version gate still runs')
  })

  it('passes the healthy verified path (not a stale candidate) to the probe', () => {
    const Provider = makeVersionedProvider('2.1.141')
    let probedPath = null
    runProviderPreflight(Provider, {
      env: {},
      verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: '/verified/claude', quarantine: null }),
      probeVersion: (path) => { probedPath = path; return '2.1.200' },
    })
    assert.equal(probedPath, '/verified/claude')
  })

  it('passes spec.binary.args through to the probe', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Claude SDK',
        binary: { name: 'claude', args: ['version', '--json'], candidates: [], minVersion: '2.1.141' },
      },
    })
    let probedArgs = null
    runProviderPreflight(Provider, {
      env: {},
      verifyBinary: okVerify,
      probeVersion: (_path, args) => { probedArgs = args; return '2.1.200' },
    })
    assert.deepEqual(probedArgs, ['version', '--json'])
  })

  it('defaults probe args to ["--version"] when spec.binary.args is absent', () => {
    const Provider = makeVersionedProvider('2.1.141')
    let probedArgs = null
    runProviderPreflight(Provider, {
      env: {},
      verifyBinary: okVerify,
      probeVersion: (_path, args) => { probedArgs = args; return '2.1.200' },
    })
    assert.deepEqual(probedArgs, ['--version'])
  })

  it('with no updateHint/installHint declared, the remediation falls back to `update <name>`', () => {
    const Provider = makeVersionedProvider('2.1.141')
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        probeVersion: () => '2.1.80',
      }),
      (err) => {
        assert.match(err.remediation, /update claude/)
        return true
      },
    )
  })

  it('prefers the provider-declared updateHint over installHint and the generic fallback', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Claude SDK',
        binary: {
          name: 'claude',
          candidates: [],
          minVersion: '2.1.141',
          installHint: 'install Claude Code',
          updateHint: 'run `claude update`',
        },
      },
    })
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        probeVersion: () => '2.1.80',
      }),
      (err) => {
        assert.match(err.remediation, /claude update/)
        return true
      },
    )
  })

  it('falls back to installHint when updateHint is absent', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Codex',
        binary: {
          name: 'codex',
          candidates: [],
          minVersion: '2.1.141',
          installHint: 'install Codex CLI',
        },
      },
    })
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        verifyBinary: okVerify,
        probeVersion: () => '2.1.80',
      }),
      (err) => {
        assert.equal(err.remediation, 'install Codex CLI')
        return true
      },
    )
  })
})

describe('runProviderPreflight — direct-exec shim refusal (#7986 review S2)', () => {
  function makeDirectExecProvider({ requiresDirectExec = true, minVersion } = {}) {
    return makeProvider({
      preflight: {
        label: 'Claude SDK',
        binary: {
          name: 'claude',
          candidates: [],
          requiresDirectExec,
          ...(minVersion !== undefined ? { minVersion } : {}),
        },
      },
    })
  }

  it('on win32, a .cmd path throws ProviderBinaryUnsupportedError, and neither probeVersion nor provenance runs', () => {
    const Provider = makeDirectExecProvider({ minVersion: '2.1.141' })
    let probeCalled = false
    let provenanceCalled = false
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        platform: 'win32',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: 'C:\\npm\\claude.cmd', quarantine: null }),
        probeVersion: () => { probeCalled = true; return '2.1.200' },
        verifyProvenance: () => { provenanceCalled = true; return { ok: true, blocked: false, status: PROVENANCE_STATUS.PINNED } },
        provenance: { mode: 'block', signatureGate: false, ledger: {} },
      }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryUnsupportedError, `got ${err?.name}`)
        assert.equal(err.code, 'PROVIDER_BINARY_UNSUPPORTED')
        assert.equal(err.binary, 'claude')
        assert.equal(err.path, 'C:\\npm\\claude.cmd')
        assert.match(err.remediation, /without a shell/)
        assert.match(err.remediation, /native/)
        assert.match(err.remediation, /claude\.exe/)
        return true
      },
    )
    assert.equal(probeCalled, false, 'a shim refusal must never reach the version probe')
    assert.equal(provenanceCalled, false, 'a shim refusal must never reach the provenance gate')
  })

  it('a bare .bat path on win32 is refused the same way', () => {
    const Provider = makeDirectExecProvider()
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        platform: 'win32',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: 'C:\\npm\\claude.bat', quarantine: null }),
      }),
      ProviderBinaryUnsupportedError,
    )
  })

  it('on darwin (or any non-win32), a .cmd-suffixed path is NOT refused', () => {
    const Provider = makeDirectExecProvider()
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        platform: 'darwin',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: '/weird/but/darwin/claude.cmd', quarantine: null }),
      }),
    )
  })

  it('a provider WITHOUT requiresDirectExec is not refused on win32 with a .cmd path', () => {
    const Provider = makeProvider({
      preflight: { label: 'Claude Channel', binary: { name: 'claude', candidates: [] } },
    })
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        platform: 'win32',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: 'C:\\npm\\claude.cmd', quarantine: null }),
      }),
    )
  })

  it('the shim refusal fires even when minVersion resolves to null (the version gate alone would have skipped)', () => {
    const Provider = makeDirectExecProvider({ minVersion: () => null })
    let probeCalled = false
    assert.throws(
      () => runProviderPreflight(Provider, {
        env: {},
        platform: 'win32',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: 'C:\\npm\\claude.cmd', quarantine: null }),
        probeVersion: () => { probeCalled = true; return '2.1.200' },
      }),
      ProviderBinaryUnsupportedError,
    )
    assert.equal(probeCalled, false)
  })

  it('a healthy native .exe path on win32 is not refused', () => {
    const Provider = makeDirectExecProvider({ minVersion: '2.1.141' })
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, {
        env: {},
        platform: 'win32',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: 'C:\\Users\\chris\\.local\\bin\\claude.exe', quarantine: null }),
        probeVersion: () => '2.1.200',
      }),
    )
  })
})

describe('runProviderPreflight — credential checks', () => {
  it('throws ProviderCredentialMissingError when required env var is absent', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Codex',
        binary: { name: 'node', candidates: [] }, // node exists on PATH
        credentials: {
          envVars: ['OPENAI_API_KEY'],
          hint: 'set OPENAI_API_KEY',
          optional: false,
        },
      },
    })

    assert.throws(
      () => runProviderPreflight(Provider, { env: {} }),
      (err) => {
        assert.ok(err instanceof ProviderCredentialMissingError, 'expected ProviderCredentialMissingError')
        assert.equal(err.code, 'PROVIDER_CREDENTIAL_MISSING')
        assert.deepEqual(err.envVars, ['OPENAI_API_KEY'])
        assert.match(err.message, /OPENAI_API_KEY/)
        assert.match(err.message, /Codex/)
        return true
      },
    )
  })

  it('passes when at least one required env var is set', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Codex',
        binary: { name: 'node', candidates: [] },
        credentials: {
          envVars: ['OPENAI_API_KEY'],
          hint: 'set OPENAI_API_KEY',
          optional: false,
        },
      },
    })
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, { env: { OPENAI_API_KEY: 'sk-test' } }),
    )
  })

  it('does NOT throw when credentials are marked optional', () => {
    // Mirrors Claude SDK: subscription auth via `claude login` is valid even
    // when ANTHROPIC_API_KEY is unset.
    const Provider = makeProvider({
      preflight: {
        label: 'Claude SDK',
        binary: { name: 'node', candidates: [] },
        credentials: {
          envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
          hint: 'run `claude login` or set ANTHROPIC_API_KEY',
          optional: true,
        },
      },
    })
    assert.doesNotThrow(() => runProviderPreflight(Provider, { env: {} }))
  })

  it('accepts the second env var when the first is unset', () => {
    const Provider = makeProvider({
      preflight: {
        label: 'Claude',
        binary: { name: 'node', candidates: [] },
        credentials: {
          envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
          optional: false,
        },
      },
    })
    assert.doesNotThrow(() =>
      runProviderPreflight(Provider, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } }),
    )
  })
})

describe('runProviderPreflight — opt-out cases', () => {
  it('is a no-op when the provider has no preflight spec', () => {
    const Provider = makeProvider({})
    assert.doesNotThrow(() => runProviderPreflight(Provider, { env: {} }))
  })

  it('skips containerised providers entirely', () => {
    // Even if the spec demands an impossible binary + missing credential,
    // a containerised provider must still pass — the binary lives inside
    // the container, not on the host.
    const Provider = makeProvider({
      preflight: {
        label: 'Docker SDK',
        binary: {
          name: '__chroxy_does_not_exist__',
          candidates: ['/var/empty/nope'],
        },
        credentials: { envVars: ['DEFINITELY_UNSET_VAR'], optional: false },
      },
      capabilities: { containerized: true },
    })
    assert.doesNotThrow(() => runProviderPreflight(Provider, { env: {} }))
  })

  it('handles a provider class with no static surfaces gracefully', () => {
    // A truly minimal class (no preflight, no capabilities) must not throw.
    class Minimal {}
    assert.doesNotThrow(() => runProviderPreflight(Minimal, { env: {} }))
  })

  it('does nothing when ProviderClass is null/undefined', () => {
    assert.doesNotThrow(() => runProviderPreflight(null))
    assert.doesNotThrow(() => runProviderPreflight(undefined))
  })
})

// #7986 round-2 review S-B: the shim refusal is only as good as the flag on the
// provider that needs it. Without these, flipping SdkSession's
// requiresDirectExec to false left every suite green.
describe('SdkSession declares and enforces requiresDirectExec (#7986)', () => {
  it('its preflight spec sets requiresDirectExec: true', () => {
    assert.equal(SdkSession.preflight.binary.requiresDirectExec, true)
  })

  it('the real SdkSession spec refuses a Windows .cmd shim before the version probe runs', () => {
    let probeCalled = false
    assert.throws(
      () => runProviderPreflight(SdkSession, {
        env: {},
        platform: 'win32',
        verifyBinary: () => ({ ok: true, status: BINARY_STATUS.OK, path: 'C:\\npm\\claude.cmd', quarantine: null }),
        probeVersion: () => { probeCalled = true; return '9.9.9' },
      }),
      (err) => err instanceof ProviderBinaryUnsupportedError && err.code === 'PROVIDER_BINARY_UNSUPPORTED',
    )
    assert.equal(probeCalled, false)
  })
})
