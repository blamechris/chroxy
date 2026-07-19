import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runProviderPreflight,
  ProviderBinaryNotFoundError,
  ProviderBinaryQuarantinedError,
  ProviderCredentialMissingError,
} from '../src/utils/preflight.js'
import { BINARY_STATUS } from '../src/utils/verify-binary.js'

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
