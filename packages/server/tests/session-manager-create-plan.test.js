import { describe, it, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import {
  SessionManager,
  SessionLimitError,
  SessionDirectoryError,
  ProviderModelNotSupportedError,
} from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'

/**
 * Unit tests for `_resolveCreateSessionPlan` (#6036) — the front-half SRP
 * extraction from `createSession`. Each case asserts the plan the resolver
 * returns equals exactly what the previous inline createSession front-half
 * computed for the same inputs (id shape, name counter, cwd/model/permission/
 * provider resolution, and the model soft-fallback / strict-reject fork).
 *
 * Every SessionManager MUST use a temp stateFilePath (see CLAUDE.md "Test
 * state contamination").
 */

let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'sm-create-plan-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

class PlanFakeSession extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.cwd = opts.cwd
  }
  start() {}
  destroy() {}
  sendMessage() {}
  interrupt() {}
  setModel() { return false }
  setPermissionMode() { return false }
}

// Non-Claude provider with a small static allowlist — exercises the strict
// model rejection fork (no soft fallback).
class PlanModelLimitedProvider extends PlanFakeSession {
  static getAllowedModels() {
    return ['allowed-model']
  }
}

// Claude-family provider with a dynamic allowlist — exercises the #3403 soft
// fallback (resolvedModel → null) instead of a hard reject.
class PlanFakeClaudeProvider extends PlanFakeSession {
  static claudeFamily = true
  static getAllowedModels() {
    return ['sonnet', 'opus']
  }
}

registerProvider('test-plan-fake-6036', PlanFakeSession)
registerProvider('test-plan-model-limited-6036', PlanModelLimitedProvider)
registerProvider('test-plan-fake-claude-6036', PlanFakeClaudeProvider)

describe('SessionManager._resolveCreateSessionPlan (#6036)', () => {
  let mgr
  beforeEach(() => {
    mgr = new SessionManager({
      maxSessions: 3,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      defaultModel: 'default-model',
      defaultPermissionMode: 'approve',
      providerType: 'test-plan-fake-6036',
      skipPreflight: true,
    })
  })

  it('resolves a baseline plan: hex id, counter name, defaults applied', () => {
    const plan = mgr._resolveCreateSessionPlan({})
    assert.match(plan.sessionId, /^[a-f0-9]{32}$/)
    assert.equal(plan.sessionName, 'Session 1')
    assert.equal(plan.resolvedCwd, tmpdir())
    assert.equal(plan.resolvedModel, 'default-model')
    assert.equal(plan.resolvedPermissionMode, 'approve')
    assert.equal(plan.resolvedProvider, 'test-plan-fake-6036')
    assert.equal(typeof plan.ProviderClass, 'function')
    assert.equal(plan.worktreePath, null)
    assert.equal(plan.worktreeRepoDir, null)
    // No .chroxy/session.json in tmpdir → no preset descriptor.
    assert.equal(plan.presetDescriptor, null)
  })

  it('per-call name / cwd / model / permissionMode override the defaults', () => {
    const plan = mgr._resolveCreateSessionPlan({
      name: 'My Session',
      cwd: tmpdir(),
      model: 'allowed-model',
      permissionMode: 'plan',
      provider: 'test-plan-model-limited-6036',
    })
    assert.equal(plan.sessionName, 'My Session')
    assert.equal(plan.resolvedModel, 'allowed-model')
    assert.equal(plan.resolvedPermissionMode, 'plan')
    assert.equal(plan.resolvedProvider, 'test-plan-model-limited-6036')
  })

  it('falls back to _defaultModel ONLY for an omitted (undefined) model; null survives (#6064/#3403)', () => {
    // #6064 ruling: `model === undefined ? this._defaultModel : model`.
    //  - omitted (undefined) → server-config default (the normal create path).
    //  - explicit `null` → SURVIVES as the #3403 "use the provider's own default"
    //    marker. `null` is not valid on the WS wire (create_session.model is
    //    z.string().optional() — a remote client sends a string or omits it,
    //    never null); it arrives mainly via restoreState (a persisted soft-
    //    fallback) or an explicit internal/test caller like this one. Re-pinning a
    //    persisted provider-default to _defaultModel would re-introduce the
    //    staleness #3403 avoids.
    //  - empty string → kept as-is (unchanged).
    assert.equal(mgr._resolveCreateSessionPlan({}).resolvedModel, 'default-model')
    assert.equal(mgr._resolveCreateSessionPlan({ model: null }).resolvedModel, null)
    assert.equal(mgr._resolveCreateSessionPlan({ model: '' }).resolvedModel, '')
    assert.equal(mgr._resolveCreateSessionPlan({ model: 'allowed-model', provider: 'test-plan-model-limited-6036' }).resolvedModel, 'allowed-model')
  })

  it('increments the session-name counter on each call', () => {
    assert.equal(mgr._resolveCreateSessionPlan({}).sessionName, 'Session 1')
    assert.equal(mgr._resolveCreateSessionPlan({}).sessionName, 'Session 2')
  })

  it('honors a valid preserveId (32 hex), else generates a fresh id', () => {
    const id = 'a'.repeat(32)
    assert.equal(mgr._resolveCreateSessionPlan({ preserveId: id }).sessionId, id)
    // Invalid format → fresh random id, not the bad value.
    const plan = mgr._resolveCreateSessionPlan({ preserveId: 'not-hex' })
    assert.notEqual(plan.sessionId, 'not-hex')
    assert.match(plan.sessionId, /^[a-f0-9]{32}$/)
  })

  it('throws SessionDirectoryError when the cwd does not exist', () => {
    assert.throws(
      () => mgr._resolveCreateSessionPlan({ cwd: join(tmpdir(), '__chroxy_missing_dir_6036__') }),
      SessionDirectoryError,
    )
  })

  it('throws SessionLimitError once the live session map is full', () => {
    // Fill the map directly so the guard fires without spawning sessions.
    for (let i = 0; i < 3; i++) mgr._sessions.set(`s${i}`, {})
    assert.throws(() => mgr._resolveCreateSessionPlan({}), SessionLimitError)
  })

  it('strict-rejects an unsupported model on a non-Claude provider', () => {
    assert.throws(
      () =>
        mgr._resolveCreateSessionPlan({
          model: 'no-such-model',
          provider: 'test-plan-model-limited-6036',
        }),
      ProviderModelNotSupportedError,
    )
  })

  it('soft-falls-back to null for an unsupported model on a Claude provider (#3403)', () => {
    const plan = mgr._resolveCreateSessionPlan({
      model: 'retired-model',
      provider: 'test-plan-fake-claude-6036',
    })
    assert.equal(plan.resolvedModel, null)
  })
})
