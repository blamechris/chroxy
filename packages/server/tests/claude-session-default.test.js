import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { SdkSession } from '../src/sdk-session.js'
import { createModelsRegistry, updateModels, resetModels } from '../src/models.js'

const SONNET = 'claude-sonnet-5-5'
const managers = []
const dirs = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroyAll()
  mock.restoreAll()
  resetModels()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function manager(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-default-8603-'))
  dirs.push(dir)
  const result = new SessionManager({ skipPreflight: true, defaultCwd: dir, stateFilePath: join(dir, 'state.json'), ...opts })
  managers.push(result)
  return result
}

describe('Claude new-session default', () => {
  for (const provider of ['claude-sdk', 'claude-cli', 'claude-tui']) {
    it(`${provider} pins a fresh omitted model to Sonnet 5.5`, () => {
      assert.equal(manager()._resolveCreateSessionPlan({ provider }).resolvedModel, SONNET)
    })
    it(`${provider} preserves null and omitted restore markers`, () => {
      const m = manager()
      assert.equal(m._resolveCreateSessionPlan({ provider, model: null }).resolvedModel, null)
      assert.equal(m._resolveCreateSessionPlan({ provider, isRestore: true }).resolvedModel, null)
    })
  }
  it('preserves explicit server and user choices, including legacy aliases', () => {
    updateModels([{ value: 'default', displayName: 'Default (Fable 5.1)' }])
    const m = manager({ defaultModel: 'claude-fable-5-1' })
    assert.equal(m._resolveCreateSessionPlan({}).resolvedModel, 'claude-fable-5-1')
    for (const model of ['claude-haiku-5-5', 'sonnet', 'claude-fable-5-1', 'default', null]) {
      assert.equal(m._resolveCreateSessionPlan({ model }).resolvedModel, model)
    }
  })
  it('retains the stale Claude model fallback for fresh and restored choices', () => {
    const m = manager()
    for (const isRestore of [false, true]) {
      assert.equal(m._resolveCreateSessionPlan({ model: 'retired-unsupported-model', isRestore }).resolvedModel, null)
    }
  })
  it('leaves non-Claude default and configured model choices intact', () => {
    const m = manager()
    for (const provider of ['codex', 'gemini', 'ollama']) {
      assert.equal(m._resolveCreateSessionPlan({ provider }).resolvedModel, null)
    }
    assert.equal(manager({ defaultModel: 'gemini-2.5-pro' })._resolveCreateSessionPlan({ provider: 'gemini' }).resolvedModel, 'gemini-2.5-pro')
  })
  it('applies the default after resolving the connection runtime', () => {
    const m = manager()
    m._agentConnectionRegistry.resolve = () => ({ definition: { runtime: 'codex' } })
    assert.equal(m._resolveCreateSessionPlan({ connectionId: 'fixture' }).resolvedModel, null)
    m._agentConnectionRegistry.resolve = () => ({ definition: { runtime: 'claude-sdk' } })
    assert.equal(m._resolveCreateSessionPlan({ connectionId: 'fixture' }).resolvedModel, SONNET)
  })
  it('keeps Default pointed at the runtime target through refresh, cache, overlay and reset', () => {
    const r = createModelsRegistry()
    const check = () => {
      assert.equal(r.resolveModelId(r.getDefaultModelId()), SONNET)
      const row = r.getModels().find(m => m.id === r.getDefaultModelId())
      assert.equal(row.fullId, SONNET)
      assert.equal(row.label, 'Sonnet 5.5')
      assert.ok(r.getModels().some(m => m.fullId === 'claude-fable-5-1'))
    }
    check()
    r.updateModels([{ value: 'default', displayName: 'Default (Fable 5.1)' }, { value: 'claude-fable-5-1', displayName: 'Fable 5.1' }])
    check()
    assert.equal(r.resolveModelId('default'), 'default', 'explicit upstream sentinel retains its identity')
    r.applyOverlay(new Map())
    check()
    const m = manager()
    const cache = join(m._defaultCwd, 'models.json')
    assert.equal(r.saveCache(cache), true)
    r.resetModels()
    check()
    assert.equal(r.loadCache(cache), true)
    check()
    r.applyOverlay(new Map())
    check()
  })
  it('preserves effective booted models and null on actual restored session construction', () => {
    mock.method(SdkSession.prototype, 'start', () => {})
    const m = manager()
    const fresh = m.getSession(m.createSession({})).session
    assert.equal(fresh.model, SONNET)
    const old = m.getSession(m.createSession({ model: null, bootedModel: 'claude-fable-5-1', isRestore: true })).session
    assert.equal(old.model, null)
    assert.equal(old.bootedModel, 'claude-fable-5-1')
    assert.equal(fresh.model, SONNET, 'creating another session never alters an existing session')
    assert.equal(old.setModel(createModelsRegistry().getDefaultModelId()), true)
    assert.equal(old.model, SONNET, 'selecting the advertised Default reaches the runtime setter')
    assert.equal(old.setModel('claude-fable-5-1'), true)
    assert.equal(old.model, 'claude-fable-5-1', 'Fable stays an explicit runtime choice')
  })
  it('non-Claude registries retain their producer default', () => {
    const r = createModelsRegistry({ fallbackModels: [{ id: 'other', fullId: 'other', label: 'Other', contextWindow: 100 }] })
    assert.equal(r.getDefaultModelId(), null)
    r.updateModels([{ value: 'other', displayName: 'Default (Other)' }])
    assert.equal(r.getDefaultModelId(), 'other')
  })
})
