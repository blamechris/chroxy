import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runProviderPreflight,
  ProviderBinaryNotFoundError,
  ProviderBinaryQuarantinedError,
  ProviderBinaryProvenanceError,
  ProviderCredentialMissingError,
} from '../src/utils/preflight.js'
import { BINARY_STATUS } from '../src/utils/verify-binary.js'
import { PROVENANCE_STATUS } from '../src/utils/verify-provenance.js'

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
    runProviderPreflight(Provider, { env: {}, verifyBinary: fakeVerify })
    assert.equal(verifiedPath, '/custom/spawn/path/codex')
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
