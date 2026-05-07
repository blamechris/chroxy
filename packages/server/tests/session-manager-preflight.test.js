import { describe, it, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import {
  SessionManager,
  ProviderBinaryNotFoundError,
  ProviderCredentialMissingError,
  ProviderModelNotSupportedError,
} from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'

/**
 * Pre-flight check integration tests for SessionManager.createSession.
 *
 * Verifies that when a provider's required binary or credential is missing,
 * createSession() throws BEFORE the session is constructed/spawned and
 * BEFORE the session is added to the live session map. This prevents the
 * "session created in UI then crashes with ENOENT" bug from #2962.
 *
 * NOTE: Every SessionManager here MUST use a temp stateFilePath. Tests that
 * forget this contaminate the user's real ~/.chroxy/session-state.json
 * (see CLAUDE.md "Test state contamination").
 */

let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'sm-preflight-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

// --- Fake providers for isolation ---------------------------------------------

class BaseFakeSession extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model
    this.permissionMode = opts.permissionMode
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() {
    return {
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: false,
      resume: false,
      terminal: false,
    }
  }
  start() { this.isRunning = true }
  destroy() { this.isRunning = false }
  sendMessage() {}
  interrupt() {}
  setModel() { return false }
  setPermissionMode() { return false }
}

class MissingBinaryProvider extends BaseFakeSession {
  static get preflight() {
    return {
      label: 'FakeMissingBin',
      binary: {
        name: '__chroxy_definitely_missing_binary_2962__',
        candidates: ['/var/empty/missing-a', '/var/empty/missing-b'],
        installHint: 'install fake provider',
      },
    }
  }
}

class MissingCredentialProvider extends BaseFakeSession {
  static get preflight() {
    return {
      label: 'FakeMissingCred',
      // node is reliably on PATH so the binary check passes and the
      // credential check is the one that fires.
      binary: { name: 'node', candidates: [] },
      credentials: {
        envVars: ['__CHROXY_FAKE_API_KEY_2962__'],
        hint: 'set __CHROXY_FAKE_API_KEY_2962__',
        optional: false,
      },
    }
  }
}

class HappyProvider extends BaseFakeSession {
  static get preflight() {
    return {
      label: 'HappyFake',
      binary: { name: 'node', candidates: [] },
      credentials: {
        envVars: ['__CHROXY_FAKE_API_KEY_2962__'],
        optional: true,
      },
    }
  }
}

class ModelLimitedProvider extends BaseFakeSession {
  static getAllowedModels() {
    return ['allowed-model']
  }
}

// Register once — these are stable test-only provider names that won't clash
// with built-ins.
registerProvider('test-missing-binary-2962', MissingBinaryProvider)
registerProvider('test-missing-credential-2962', MissingCredentialProvider)
registerProvider('test-happy-2962', HappyProvider)
registerProvider('test-model-limited-2962', ModelLimitedProvider)

describe('SessionManager.createSession — preflight', () => {
  let mgr
  let originalEnvVar

  beforeEach(() => {
    originalEnvVar = process.env.__CHROXY_FAKE_API_KEY_2962__
    delete process.env.__CHROXY_FAKE_API_KEY_2962__
    mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
    })
  })

  afterEach(() => {
    if (originalEnvVar === undefined) delete process.env.__CHROXY_FAKE_API_KEY_2962__
    else process.env.__CHROXY_FAKE_API_KEY_2962__ = originalEnvVar
  })

  it('throws ProviderBinaryNotFoundError before constructing the session', () => {
    assert.throws(
      () => mgr.createSession({ provider: 'test-missing-binary-2962', skipPersist: true }),
      (err) => {
        assert.ok(err instanceof ProviderBinaryNotFoundError, `got ${err?.name}: ${err?.message}`)
        assert.equal(err.code, 'PROVIDER_BINARY_NOT_FOUND')
        assert.match(err.message, /FakeMissingBin/)
        assert.match(err.message, /__chroxy_definitely_missing_binary_2962__/)
        assert.match(err.message, /install fake provider/)
        return true
      },
    )
    // Critically, no session should have been added to the live map — the
    // UI must not show a phantom session for a failed preflight.
    assert.equal(mgr.listSessions().length, 0)
  })

  it('throws ProviderCredentialMissingError when required env var is unset', () => {
    assert.throws(
      () => mgr.createSession({ provider: 'test-missing-credential-2962', skipPersist: true }),
      (err) => {
        assert.ok(err instanceof ProviderCredentialMissingError, `got ${err?.name}: ${err?.message}`)
        assert.equal(err.code, 'PROVIDER_CREDENTIAL_MISSING')
        assert.match(err.message, /__CHROXY_FAKE_API_KEY_2962__/)
        return true
      },
    )
    assert.equal(mgr.listSessions().length, 0)
  })

  it('proceeds when credentials are marked optional even if env var is unset', () => {
    // HappyProvider has an optional credential; absence of the env var must
    // not block creation. This protects the Claude SDK subscription path.
    const id = mgr.createSession({ provider: 'test-happy-2962', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    assert.equal(mgr.listSessions().length, 1)
    mgr.destroySession(id)
  })

  it('proceeds when the required env var is set', () => {
    process.env.__CHROXY_FAKE_API_KEY_2962__ = 'fake-value'
    const id = mgr.createSession({ provider: 'test-missing-credential-2962', skipPersist: true })
    assert.ok(id)
    mgr.destroySession(id)
  })

  it('throws ProviderModelNotSupportedError when initial model is not valid for the provider', () => {
    assert.throws(
      () => mgr.createSession({ provider: 'test-model-limited-2962', model: 'claude-opus-4-6', skipPersist: true }),
      (err) => {
        assert.ok(err instanceof ProviderModelNotSupportedError, `got ${err?.name}: ${err?.message}`)
        assert.equal(err.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
        assert.equal(err.provider, 'test-model-limited-2962')
        assert.equal(err.model, 'claude-opus-4-6')
        assert.deepEqual(err.supported, ['allowed-model'])
        assert.match(err.message, /allowed-model/)
        return true
      },
    )
    assert.equal(mgr.listSessions().length, 0)
  })

  it('falls back to provider default when stale Claude SDK model is supplied (#3403)', () => {
    const noBinaryPreflightMgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      skipPreflight: true,
    })
    // A retired model id ('opus-4-6' after opus-4-7 ships) gets soft-cleared
    // to null so the underlying SdkSession picks the SDK's own default,
    // rather than crashing the create flow with a hard rejection that
    // surfaces as the unhelpful "There's an issue with the selected model"
    // message in the dashboard.
    const id = noBinaryPreflightMgr.createSession({ provider: 'claude-sdk', model: 'opus-4-6', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    const entry = noBinaryPreflightMgr.getSession(id)
    assert.equal(entry.session.model, null, 'stale model must be cleared to null (use provider default)')
    noBinaryPreflightMgr.destroySession(id)
  })

  it('falls back to provider default when stale Claude CLI model is supplied (#3403)', () => {
    const noBinaryPreflightMgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      skipPreflight: true,
    })
    const id = noBinaryPreflightMgr.createSession({ provider: 'claude-cli', model: 'opus-4-6', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    const entry = noBinaryPreflightMgr.getSession(id)
    assert.equal(entry.session.model, null, 'stale model must be cleared to null (use provider default)')
    noBinaryPreflightMgr.destroySession(id)
  })

  it('keeps a valid Claude model on the session when it is in the registry (#3403)', () => {
    const noBinaryPreflightMgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      skipPreflight: true,
    })
    // 'opus' is a short alias seeded by FALLBACK_MODELS — must pass through.
    const id = noBinaryPreflightMgr.createSession({ provider: 'claude-sdk', model: 'opus', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    const entry = noBinaryPreflightMgr.getSession(id)
    assert.ok(entry.session.model && typeof entry.session.model === 'string', `expected a resolved model string, got ${entry.session.model}`)
    noBinaryPreflightMgr.destroySession(id)
  })

  it('proceeds when initial model is valid for the provider', () => {
    const id = mgr.createSession({ provider: 'test-model-limited-2962', model: 'allowed-model', skipPersist: true })
    assert.ok(id)
    const entry = mgr.getSession(id)
    assert.equal(entry.session.model, 'allowed-model')
    mgr.destroySession(id)
  })
})
