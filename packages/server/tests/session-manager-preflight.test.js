import { describe, it, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
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
import { addLogListener, removeLogListener } from '../src/logger.js'
import { GeminiSession } from '../src/gemini-session.js'
import { CodexSession } from '../src/codex-session.js'
import { waitFor } from './test-helpers.js'

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

// Fake Claude-family provider for #3403 fallback tests. Mirrors the dynamic
// allowlist shape of the real claude-sdk/claude-cli (a list that does NOT
// include 'opus-4-6') and opts into Claude-family treatment via the
// `claudeFamily` static flag — without spawning the real `claude` binary that
// would crash CI runners with ENOENT.
class FakeClaudeProvider extends BaseFakeSession {
  static claudeFamily = true
  static getAllowedModels() {
    return ['sonnet', 'claude-sonnet-4-6', 'opus', 'claude-opus-4-7', 'haiku', 'claude-haiku-4-5']
  }
}

// #8030 — a real, hashable, always-present binary (the running Node
// executable) so the opt-in provenance gate can run its REAL sha256File
// against it with no fixture file to manage. Mirrors agent-connections.test.js's
// VerifiedConnectionFixtureSession pattern: captures whatever SessionManager
// passes as `opts.spawnPreflight` so a test can invoke it directly.
class SpawnGateFixtureProvider extends BaseFakeSession {
  // Tests re-point this after create to prove the spawn gate stays pinned.
  static resolvedOverride = null
  static get resolvedBinary() { return SpawnGateFixtureProvider.resolvedOverride || process.execPath }
  static get preflight() {
    return { label: 'Fixture SDK', binary: { name: 'node', candidates: [] } }
  }
  constructor(opts = {}) {
    super(opts)
    SpawnGateFixtureProvider.lastSpawnPreflight = typeof opts.spawnPreflight === 'function' ? opts.spawnPreflight : null
  }
}

// Register once — these are stable test-only provider names that won't clash
// with built-ins.
registerProvider('test-missing-binary-2962', MissingBinaryProvider)
registerProvider('test-missing-credential-2962', MissingCredentialProvider)
registerProvider('test-happy-2962', HappyProvider)
registerProvider('test-model-limited-2962', ModelLimitedProvider)
registerProvider('test-fake-claude-3403', FakeClaudeProvider)
registerProvider('test-spawn-gate-8030', SpawnGateFixtureProvider)

// #8030 review — declares a soft floor the running Node can never meet, so
// every preflight of it produces a #8031 advisory.
class AdvisoryFixtureProvider extends SpawnGateFixtureProvider {
  static get resolvedBinary() { return process.execPath }
  static get preflight() {
    return { label: 'Advisory fixture', binary: { name: 'node', candidates: [], args: ['--version'], recommendedVersion: '999.0.0' } }
  }
}
registerProvider('test-spawn-gate-advisory-8030', AdvisoryFixtureProvider)

// #8030 review — a throwaway executable, so a test can delete the pinned
// binary out from under a live session.
class DisposableBinaryProvider extends SpawnGateFixtureProvider {
  static binaryPath = null
  static get resolvedBinary() { return DisposableBinaryProvider.binaryPath }
  static get preflight() {
    return { label: 'Disposable fixture', binary: { name: 'fixture-claude', candidates: [] } }
  }
}
registerProvider('test-spawn-gate-disposable-8030', DisposableBinaryProvider)

// #8035 — end-to-end fixtures for the REAL Gemini/Codex per-turn spawn gate,
// exercised through actual GeminiSession/CodexSession subclasses (not a
// hand-rolled fake) so the test goes red if `spawnPreflight` is ever dropped
// from BASE_SESSION_OPT_KEYS or the middle layer stops forwarding it. Mirrors
// SpawnGateFixtureProvider above: a mutable `resolvedOverride` proves pinning
// survives a PATH change, and `preflight` drops credentials/version fields so
// create-time preflight needs nothing beyond the always-present `node`.
class TestGeminiSpawnGate extends GeminiSession {
  static resolvedOverride = null
  static shimPath = null
  static get resolvedBinary() { return TestGeminiSpawnGate.resolvedOverride || process.execPath }
  static get preflight() {
    return {
      label: 'Test Gemini Spawn Gate',
      binary: { name: 'node', candidates: [] },
      // GeminiSession.resolveAuth() (inherited, unchanged) reads
      // `this.preflight.credentials` unconditionally — an empty-but-present
      // block keeps that call from throwing without requiring any real key.
      credentials: { envVars: [], hint: '', optional: true },
    }
  }
  // Bypass the real Gemini CLI argv shape — just run the shim under node.
  _buildArgs(text) { return [TestGeminiSpawnGate.shimPath, text] }
  _buildChildEnv() { return process.env }
}
registerProvider('test-gemini-spawn-gate-8035', TestGeminiSpawnGate)

class TestCodexSpawnGate extends CodexSession {
  static resolvedOverride = null
  static shimPath = null
  static get resolvedBinary() { return TestCodexSpawnGate.resolvedOverride || process.execPath }
  static get preflight() {
    return {
      label: 'Test Codex Spawn Gate',
      binary: { name: 'node', candidates: [] },
      // CodexSession.resolveAuth() (inherited, unchanged) reads
      // `this.preflight.credentials` unconditionally — see the identical note
      // on TestGeminiSpawnGate above.
      credentials: { envVars: [], hint: '', optional: true },
    }
  }
  _buildArgs(text) { return [TestCodexSpawnGate.shimPath, text] }
  _buildChildEnv() { return process.env }
}
registerProvider('test-codex-spawn-gate-8035', TestCodexSpawnGate)

// A shim that writes a MARKER the instant it actually runs, so a refused turn
// can be proven to have never spawned (marker absent) rather than only
// inferred. No JSONL output needed — JsonlSubprocessSession's default
// `_emitFallbackResult` fires a `result` on a clean close with no parsed
// `done`-equivalent event, which is enough to prove the turn completed.
function makeGateShim() {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-8035-shim-'))
  const shimPath = join(dir, 'gate-shim.mjs')
  const markerPath = join(dir, 'marker.txt')
  const body = [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
    'process.exit(0)',
  ].join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
  return { dir, shimPath, markerPath }
}

// #8030 — in-memory pin ledger (the surface verifyProvenance consults:
// getRecord + approve), matching the shape used in agent-connections.test.js.
function fakeProvenanceLedger(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    getRecord: (p) => (records.has(p) ? { ...records.get(p) } : null),
    approve: (p, sha256) => { records.set(p, { sha256 }); return true },
    _records: records,
  }
}

// The REAL hash of the running Node binary — used to seed a "matching" pin,
// and deliberately never used as the "wrong" hash below.
const SPAWN_GATE_REAL_HASH = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
const SPAWN_GATE_WRONG_HASH = 'f'.repeat(64)

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

  it('falls back to provider default when a stale Claude-family model is supplied (#3403)', () => {
    // Uses the fake Claude-family provider (claudeFamily=true) so this runs
    // on CI without the real `claude` binary. A retired model id
    // ('opus-4-6' after opus-4-7 ships) gets soft-cleared to null so the
    // underlying session picks the upstream default, rather than crashing
    // the create flow with a hard rejection that surfaces as the unhelpful
    // "There's an issue with the selected model" message in the dashboard.
    const id = mgr.createSession({ provider: 'test-fake-claude-3403', model: 'opus-4-6', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    const entry = mgr.getSession(id)
    assert.equal(entry.session.model, null, 'stale model must be cleared to null (use provider default)')
    mgr.destroySession(id)
  })

  it('keeps a valid Claude model on the session when it is in the registry (#3403)', () => {
    // 'opus' is a short alias the fake provider's allowlist accepts — must
    // pass through unchanged.
    const id = mgr.createSession({ provider: 'test-fake-claude-3403', model: 'opus', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    const entry = mgr.getSession(id)
    assert.equal(entry.session.model, 'opus', 'valid model must NOT be cleared to null')
    mgr.destroySession(id)
  })

  it('keeps strict rejection on a non-Claude provider with a stale model (#3403)', () => {
    // Belt-and-braces: the asymmetric Claude/non-Claude branch must keep
    // throwing for non-Claude providers. ModelLimitedProvider has no
    // `claudeFamily` flag, so its static allowlist is authoritative and
    // a mismatch surfaces as ProviderModelNotSupportedError instead of
    // silently falling back.
    assert.throws(
      () => mgr.createSession({ provider: 'test-model-limited-2962', model: 'opus-4-6', skipPersist: true }),
      (err) => {
        assert.ok(err instanceof ProviderModelNotSupportedError, `got ${err?.name}: ${err?.message}`)
        assert.equal(err.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
        return true
      },
    )
    assert.equal(mgr.listSessions().length, 0)
  })

  it('proceeds when initial model is valid for the provider', () => {
    const id = mgr.createSession({ provider: 'test-model-limited-2962', model: 'allowed-model', skipPersist: true })
    assert.ok(id)
    const entry = mgr.getSession(id)
    assert.equal(entry.session.model, 'allowed-model')
    mgr.destroySession(id)
  })

  it('preserves explicit null model on restore even when defaultModel is configured (#3403)', () => {
    // Regression: nullish coalescing in createSession means an explicit
    // `null` (the soft-fallback marker for a stale Claude model) survives
    // restoreState() instead of being clobbered by the server config's
    // _defaultModel. Without `??`, every previously-soft-cleared session
    // would silently re-acquire the stale config default on restart.
    const restoredMgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      defaultModel: 'opus-4-6', // a stale config default
    })
    const id = restoredMgr.createSession({ provider: 'test-fake-claude-3403', model: null, skipPersist: true })
    assert.ok(id, 'session id should be returned')
    const entry = restoredMgr.getSession(id)
    assert.equal(entry.session.model, null, 'explicit null must NOT fall back to _defaultModel')
    restoredMgr.destroySession(id)
  })
})

describe('SessionManager.createSession — per-spawn binary provenance gate (#8030)', () => {
  it('a block-mode ledger mismatch at create time throws PROVIDER_BINARY_PROVENANCE', () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      binaryProvenanceMode: 'block',
      binaryProvenanceLedger: ledger,
    })
    assert.throws(
      () => mgr.createSession({ provider: 'test-spawn-gate-8030', skipPersist: true }),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
    )
    assert.equal(mgr.listSessions().length, 0, 'no phantom session for a failed preflight')
  })

  it('a matching seed succeeds; the captured spawnPreflight re-verifies and returns the pinned path, then fails closed once the ledger is mutated', () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_REAL_HASH } })
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      binaryProvenanceMode: 'block',
      binaryProvenanceLedger: ledger,
    })
    SpawnGateFixtureProvider.lastSpawnPreflight = null
    const id = mgr.createSession({ provider: 'test-spawn-gate-8030', skipPersist: true })
    assert.ok(id, 'session id should be returned')
    assert.equal(typeof SpawnGateFixtureProvider.lastSpawnPreflight, 'function', 'providerOpts.spawnPreflight must be forwarded to the constructor')
    assert.equal(SpawnGateFixtureProvider.lastSpawnPreflight(), process.execPath)

    // Mutate the ledger to a wrong hash — the pinned path re-verify must now
    // fail closed, exactly as create-time preflight would for a fresh session.
    ledger._records.set(process.execPath, { sha256: SPAWN_GATE_WRONG_HASH })
    assert.throws(
      () => SpawnGateFixtureProvider.lastSpawnPreflight(),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
    )
    mgr.destroySession(id)
  })
})

describe('SessionManager per-spawn gate — pinning (#8030 review)', () => {
  afterEach(() => { SpawnGateFixtureProvider.resolvedOverride = null })

  it('keeps verifying the create-time path when the provider would now resolve somewhere else', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile(), defaultCwd: tmpdir() })
    SpawnGateFixtureProvider.lastSpawnPreflight = null
    const id = mgr.createSession({ provider: 'test-spawn-gate-8030', skipPersist: true })
    // A PATH change after create: a fresh resolve would now land on a path that
    // does not exist. The pinned gate must not look there.
    SpawnGateFixtureProvider.resolvedOverride = join(tmpdir(), `chroxy-8030-elsewhere-${process.pid}`)
    assert.equal(SpawnGateFixtureProvider.lastSpawnPreflight(), process.execPath)
    mgr.destroySession(id)
  })

  it('names the vanished pinned path and says to start a new session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-8030-pin-'))
    const bin = join(dir, 'fixture-claude')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    DisposableBinaryProvider.binaryPath = bin
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile(), defaultCwd: tmpdir() })
    SpawnGateFixtureProvider.lastSpawnPreflight = null
    const id = mgr.createSession({ provider: 'test-spawn-gate-disposable-8030', skipPersist: true })
    const gate = SpawnGateFixtureProvider.lastSpawnPreflight
    assert.equal(gate(), bin)
    rmSync(dir, { recursive: true, force: true })
    assert.throws(() => gate(), (err) => {
      assert.equal(err.code, 'PROVIDER_BINARY_NOT_FOUND')
      assert.ok(err.message.includes(bin), 'the message must name the pinned path')
      assert.ok(err.message.includes('start a new session'), 'the remedy is a new session, not an install')
      assert.ok(!err.message.includes('checked PATH'), 'only the pinned path was checked')
      return true
    })
    mgr.destroySession(id)
  })

  it('does not re-log the #8031 soft-floor advisory on per-turn re-verification', () => {
    const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile(), defaultCwd: tmpdir() })
    SpawnGateFixtureProvider.lastSpawnPreflight = null
    const id = mgr.createSession({ provider: 'test-spawn-gate-advisory-8030', skipPersist: true })
    const warns = []
    const listener = (entry) => {
      if (entry.component === 'preflight' && entry.level === 'warn' && entry.message.includes('recommended')) warns.push(entry)
    }
    addLogListener(listener)
    try {
      SpawnGateFixtureProvider.lastSpawnPreflight()
      SpawnGateFixtureProvider.lastSpawnPreflight()
    } finally {
      removeLogListener(listener)
    }
    assert.equal(warns.length, 0, 'the per-turn gate must pass warnAdvisory:false')
    mgr.destroySession(id)
  })
})

describe('SessionManager.verifyOneShotExecutable (#8030)', () => {
  it('throws PROVIDER_BINARY_PROVENANCE on a block-mode hash mismatch against the fixture oneShotProviderClass', () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_WRONG_HASH } })
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      binaryProvenanceMode: 'block',
      binaryProvenanceLedger: ledger,
      oneShotProviderClass: SpawnGateFixtureProvider,
    })
    assert.throws(
      () => mgr.verifyOneShotExecutable(),
      (err) => {
        assert.equal(err.code, 'PROVIDER_BINARY_PROVENANCE')
        return true
      },
    )
  })

  it('throws PROVIDER_BINARY_UNVERIFIED when preflight yields no binary path (#8030 review)', () => {
    class NoBinaryFixture extends SpawnGateFixtureProvider {
      static get preflight() { return { label: 'No binary' } }
    }
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      oneShotProviderClass: NoBinaryFixture,
    })
    assert.throws(() => mgr.verifyOneShotExecutable(), (err) => err.code === 'PROVIDER_BINARY_UNVERIFIED')
  })

  it('returns the path on a matching hash', () => {
    const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_REAL_HASH } })
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      binaryProvenanceMode: 'block',
      binaryProvenanceLedger: ledger,
      oneShotProviderClass: SpawnGateFixtureProvider,
    })
    assert.equal(mgr.verifyOneShotExecutable(), process.execPath)
  })

  it('with skipPreflight:true returns the UNVERIFIED resolvedBinary (documented test-only meaning)', () => {
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      skipPreflight: true,
      oneShotProviderClass: SpawnGateFixtureProvider,
    })
    assert.equal(mgr.verifyOneShotExecutable(), process.execPath)
  })

  it('falls back to getProvider(\'claude-sdk\') when no oneShotProviderClass is configured', async () => {
    const { getProvider } = await import('../src/providers.js')
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      skipPreflight: true,
    })
    const ClaudeSdk = getProvider('claude-sdk')
    assert.equal(mgr.verifyOneShotExecutable(), ClaudeSdk.resolvedBinary)
  })
})

describe('SessionManager._binaryProvenanceOptions (#8030 review)', () => {
  const ledger = fakeProvenanceLedger()
  const make = (opts) => new SessionManager({
    maxSessions: 5,
    stateFilePath: tmpStateFile(),
    defaultCwd: tmpdir(),
    binaryProvenanceLedger: ledger,
    ...opts,
  })

  it('is null when pinning is off and the signature gate is off', () => {
    assert.equal(make({})._binaryProvenanceOptions(), null)
  })

  it('is ON when only the signature gate is enabled — every spawn gate reads this one condition', () => {
    assert.deepEqual(make({ binarySignatureGate: true })._binaryProvenanceOptions(), { mode: 'off', signatureGate: true, ledger })
  })

  it('is ON for warn and block pinning', () => {
    assert.equal(make({ binaryProvenanceMode: 'warn' })._binaryProvenanceOptions().mode, 'warn')
    assert.equal(make({ binaryProvenanceMode: 'block' })._binaryProvenanceOptions().mode, 'block')
  })
})

describe('SessionManager end-to-end — per-turn subprocess spawn gate, Gemini + Codex-exec (#8035)', () => {
  let savedGeminiKey
  let savedOpenaiKey

  beforeEach(() => {
    savedGeminiKey = process.env.GEMINI_API_KEY
    savedOpenaiKey = process.env.OPENAI_API_KEY
    // start() only checks the REAL apiKeyEnv static (GEMINI_API_KEY /
    // OPENAI_API_KEY, inherited unchanged from GeminiSession/CodexSession).
    // The fixture's `preflight` credentials block is empty and optional, so
    // preflight never asks for a key; only start() does.
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    process.env.OPENAI_API_KEY = 'test-openai-key'
    TestGeminiSpawnGate.resolvedOverride = null
    TestCodexSpawnGate.resolvedOverride = null
  })

  afterEach(() => {
    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = savedGeminiKey
    if (savedOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedOpenaiKey
  })

  const PROVIDERS = [
    { label: 'GeminiSession', ProviderClass: TestGeminiSpawnGate, providerId: 'test-gemini-spawn-gate-8035' },
    { label: 'CodexSession (codex exec)', ProviderClass: TestCodexSpawnGate, providerId: 'test-codex-spawn-gate-8035' },
  ]

  for (const { label, ProviderClass, providerId } of PROVIDERS) {
    it(`${label}: turn 1 spawns and completes on a matching ledger hash; turn 2 is refused after the ledger is mutated`, async () => {
      const { dir, shimPath, markerPath } = makeGateShim()
      ProviderClass.shimPath = shimPath
      const ledger = fakeProvenanceLedger({ [process.execPath]: { sha256: SPAWN_GATE_REAL_HASH } })
      const mgr = new SessionManager({
        maxSessions: 5,
        stateFilePath: tmpStateFile(),
        defaultCwd: tmpdir(),
        binaryProvenanceMode: 'block',
        binaryProvenanceLedger: ledger,
      })
      let id = null
      try {
        id = mgr.createSession({ provider: providerId, skipPersist: true })
        assert.ok(id, 'session id should be returned')
        const session = mgr.getSession(id).session

        const errors = []
        session.on('error', (e) => errors.push(e))

        // Turn 1 — the ledger matches the pinned path: spawns and completes.
        const results = []
        session.on('result', (d) => results.push(d))
        const admissions = []
        await session.sendMessage('turn one', [], { onInputAdmission: (a) => admissions.push(a) })
        await waitFor(() => results.length >= 1 || errors.length >= 1, { label: 'turn 1 settle' })
        assert.equal(errors.length, 0, 'turn 1 must not error')
        assert.equal(existsSync(markerPath), true, 'turn 1 actually spawned the pinned binary')
        assert.equal(admissions[0]?.status, 'accepted')
        // _isBusy only clears once the child's `close` fires (can land after
        // the marker write above) — wait for it before sending turn 2.
        await waitFor(() => !session.isRunning, { label: 'turn 1 fully closed' })

        // Mutate the ledger — turn 2 must now be refused BEFORE any spawn.
        unlinkSync(markerPath)
        ledger._records.set(process.execPath, { sha256: SPAWN_GATE_WRONG_HASH })
        await session.sendMessage('turn two', [], { onInputAdmission: (a) => admissions.push(a) })

        assert.equal(errors.length, 1, 'turn 2 produced exactly one refusal error')
        assert.equal(errors[0].code, 'PROVIDER_BINARY_PROVENANCE')
        assert.equal(existsSync(markerPath), false, 'turn 2 never spawned a child — no marker written')
        const rejected = admissions[admissions.length - 1]
        assert.equal(rejected.status, 'rejected')
        assert.equal(rejected.delivery, 'not_dispatched')
        assert.equal(rejected.reason, 'PROVIDER_BINARY_PROVENANCE')

      } finally {
        if (id) mgr.destroySession(id)
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it(`${label}: a PATH change after create never redirects the spawn away from the create-time-pinned path`, async () => {
      const { dir, shimPath, markerPath } = makeGateShim()
      ProviderClass.shimPath = shimPath
      const mgr = new SessionManager({ maxSessions: 5, stateFilePath: tmpStateFile(), defaultCwd: tmpdir() })
      let id = null
      try {
        id = mgr.createSession({ provider: providerId, skipPersist: true })
        const session = mgr.getSession(id).session
        const errors = []
        session.on('error', (e) => errors.push(e))
        const results = []
        session.on('result', (d) => results.push(d))

        // Simulate the provider now resolving to a path that does not exist —
        // a fresh Klass.resolvedBinary read would ENOENT; the pinned gate must
        // not look there.
        ProviderClass.resolvedOverride = join(tmpdir(), `chroxy-8035-elsewhere-${process.pid}`)

        await session.sendMessage('hi')
        await waitFor(() => results.length >= 1 || errors.length >= 1, { label: 'turn settle' })

        assert.equal(errors.length, 0, 'the turn must not fail even though resolvedBinary now points nowhere')
        assert.equal(existsSync(markerPath), true, 'the pinned process.execPath was spawned, not the new (nonexistent) resolve')

      } finally {
        if (id) mgr.destroySession(id)
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
