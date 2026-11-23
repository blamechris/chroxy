import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAnthropicCompatibleProviders } from '../src/anthropic-compatible-session.js'
import {
  reloadModelsOverlay,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'
import { _unregisterProviderRegistryForTests } from '../src/models.js'
import { getProvider, registerProvider } from '../src/providers.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { createSpy, createMockSession, nsCtx } from './test-helpers.js'

/**
 * #9139 — a models.json overlay row tagged for an allowlisted config-driven
 * provider is offered by the picker under its short id (`chosen`, fullId
 * `model-one`). set_model must accept that id when the row's TARGET is on the
 * provider's allowlist, hand the TARGET to setModel (the endpoint 404s an
 * alias), and still refuse a target that is off the list.
 */

const PROVIDER = 'smoke-stub-9139'
let dir

function writeOverlay(obj) {
  const path = join(dir, 'models.json')
  writeFileSync(path, JSON.stringify(obj))
  return path
}

function setup(overlay) {
  registerAnthropicCompatibleProviders({
    providers: {
      anthropicCompatible: [{
        id: PROVIDER,
        baseUrl: 'http://127.0.0.1:9',
        defaultModel: 'stub-model',
        models: ['stub-model', 'model-one', 'model-two'],
      }],
    },
  })
  assert.equal(reloadModelsOverlay(writeOverlay(overlay)).reloaded, true)
}

function run(model, provider = PROVIDER) {
  const session = createMockSession()
  const sessions = new Map([['s1', { session, name: 'S', cwd: '/tmp', provider }]])
  const broadcast = createSpy()
  const messages = []
  const ctx = nsCtx({
    send: createSpy((_ws, msg) => { messages.push(msg) }),
    broadcastToSession: broadcast,
    sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
    config: {},
  })
  const ws = { readyState: 1, send: createSpy() }
  settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model, requestId: 'r1' }, ctx)
  return { session, broadcast, messages }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'set-model-overlay-9139-'))
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
})
afterEach(() => {
  _resetProviderRegistryCacheForTests()
  _resetModelsOverlayForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('#9139 set_model with an overlay short id on an allowlisted provider', () => {
  it('accepts a short id whose target is allowlisted; setModel gets the target', () => {
    setup({ 'model-one': { provider: PROVIDER, shortId: 'chosen', label: 'First' } })
    const { session, broadcast, messages } = run('chosen')
    assert.equal(messages.length, 0, 'no error frame')
    assert.equal(session.setModel.callCount, 1)
    assert.equal(session.setModel.lastCall[0], 'model-one')
    assert.equal(broadcast.callCount, 1)
    assert.deepEqual(broadcast.lastCall.slice(1), [{ type: 'model_changed', model: 'model-one' }])
  })

  it('refuses a short id whose target is NOT on the allowlist', () => {
    setup({ 'model-three': { provider: PROVIDER, shortId: 'rogue', label: 'Rogue' } })
    const { session, broadcast, messages } = run('rogue')
    assert.equal(session.setModel.callCount, 0)
    assert.equal(broadcast.callCount, 0)
    assert.equal(messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('refuses an unknown id', () => {
    setup({ 'model-one': { provider: PROVIDER, shortId: 'chosen', label: 'First' } })
    const { session, messages } = run('nope')
    assert.equal(session.setModel.callCount, 0)
    assert.equal(messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('a plain allowlisted id is unchanged', () => {
    setup({ 'model-one': { provider: PROVIDER, shortId: 'chosen', label: 'First' } })
    const { session, broadcast, messages } = run('model-two')
    assert.equal(messages.length, 0)
    assert.equal(session.setModel.lastCall[0], 'model-two')
    assert.deepEqual(broadcast.lastCall.slice(1), [{ type: 'model_changed', model: 'model-two' }])
  })
})

describe('#9153 roster lookup failure and alias collision', () => {
  it('a throwing roster lookup logs a warning naming provider and id, and still refuses', () => {
    setup({ 'model-one': { provider: PROVIDER, shortId: 'chosen', label: 'First' } })
    const Base = getProvider(PROVIDER)
    const THROWING = 'smoke-throwing-9153'
    class Throwing extends Base {
      static getFallbackModels() { throw new Error('roster boom') }
    }
    registerProvider(THROWING, Throwing)
    const entries = []
    const listener = (e) => { entries.push(e) }
    addLogListener(listener)
    try {
      const { session, broadcast, messages } = run('chosen', THROWING)
      assert.equal(session.setModel.callCount, 0)
      assert.equal(broadcast.callCount, 0)
      assert.equal(messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
      const warn = entries.find((e) => e.level === 'warn'
        && e.message.includes('roster lookup failed')
        && e.message.includes(THROWING)
        && e.message.includes('"chosen"'))
      assert.ok(warn, 'expected a roster-lookup warning naming provider and requested id')
      assert.ok(warn.message.includes('roster boom'), 'warning carries the error message')
    } finally {
      removeLogListener(listener)
      _unregisterProviderRegistryForTests(THROWING)
    }
  })

  it('an alias equal to another row\'s fullId: first row wins, allowlist gates the outcome', () => {
    // Row A (target model-one, on the list) is aliased `clash`; row B's own
    // target is `clash` (off the list). getRosterModelRow returns the first
    // match in roster order, so `clash` resolves to model-one and is accepted.
    setup({
      'model-one': { provider: PROVIDER, shortId: 'clash', label: 'A' },
      clash: { provider: PROVIDER, label: 'B' },
    })
    const { session, broadcast, messages } = run('clash')
    assert.equal(messages.length, 0, 'no error frame')
    assert.equal(session.setModel.callCount, 1)
    assert.equal(session.setModel.lastCall[0], 'model-one')
    assert.deepEqual(broadcast.lastCall.slice(1), [{ type: 'model_changed', model: 'model-one' }])
  })

  it('the colliding row alone (target off the list) is still refused', () => {
    setup({ clash: { provider: PROVIDER, label: 'B' } })
    const { session, messages } = run('clash')
    assert.equal(session.setModel.callCount, 0)
    assert.equal(messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('logs a client-supplied model id through loggableValue: newline escaped, one entry', () => {
    setup({ 'model-one': { provider: PROVIDER, shortId: 'chosen', label: 'First' } })
    const entries = []
    const listener = (e) => { entries.push(e) }
    addLogListener(listener)
    try {
      const { messages } = run('bad\n[INFO] forged entry')
      assert.equal(messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
    } finally {
      removeLogListener(listener)
    }
    const rejected = entries.filter((e) => e.message.includes('Rejected model'))
    assert.equal(rejected.length, 1, 'exactly one rejection entry')
    assert.ok(!rejected[0].message.includes('\n'), 'no raw newline in the entry')
    assert.ok(rejected[0].message.includes('bad\\n[INFO] forged entry'), 'newline is escaped')
  })
})
