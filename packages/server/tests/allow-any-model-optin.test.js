import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { getAllowAnyModelProviders, isProviderModelUnrestricted } from '../src/config.js'
import { validateProvidersConfigBlock } from '../src/anthropic-compatible-config.js'
import { SessionManager, ProviderModelNotSupportedError } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { createSpy, createMockSession, nsCtx } from './test-helpers.js'

/**
 * #6378 — `config.providers.allowAnyModel` opt-in. A static-allowlist provider
 * (gemini/codex/deepseek) listed here serves an unlisted-but-API-valid model id
 * verbatim (like ollama, #5418) instead of hard-rejecting it — so a new model
 * the upstream API already exposes needs no chroxy release. Covers the config
 * helpers, the providers-block validation, and BOTH validation seams
 * (create-time preflight + set_model).
 */

// --- A. config helpers --------------------------------------------------------

describe('#6378 config helpers', () => {
  it('getAllowAnyModelProviders defaults to an empty Set (OFF) for missing/non-array', () => {
    assert.equal(getAllowAnyModelProviders(undefined).size, 0)
    assert.equal(getAllowAnyModelProviders({}).size, 0)
    assert.equal(getAllowAnyModelProviders({ providers: {} }).size, 0)
    assert.equal(getAllowAnyModelProviders({ providers: { allowAnyModel: 'gemini' } }).size, 0)
    assert.equal(getAllowAnyModelProviders({ providers: { allowAnyModel: true } }).size, 0)
  })

  it('getAllowAnyModelProviders parses an array and drops non-string / empty entries', () => {
    const set = getAllowAnyModelProviders({ providers: { allowAnyModel: ['gemini', 'codex', '', 7, null, 'deepseek'] } })
    assert.deepEqual([...set].sort(), ['codex', 'deepseek', 'gemini'])
  })

  it('isProviderModelUnrestricted is fail-closed and matches membership', () => {
    const config = { providers: { allowAnyModel: ['gemini'] } }
    assert.equal(isProviderModelUnrestricted(config, 'gemini'), true)
    assert.equal(isProviderModelUnrestricted(config, 'codex'), false)
    assert.equal(isProviderModelUnrestricted(config, ''), false)
    assert.equal(isProviderModelUnrestricted(config, undefined), false)
    assert.equal(isProviderModelUnrestricted(undefined, 'gemini'), false)
  })
})

// --- B. providers-block validation -------------------------------------------

describe('#6378 providers.allowAnyModel validation', () => {
  it('accepts a well-formed string array with no warnings', () => {
    const warnings = []
    validateProvidersConfigBlock({ allowAnyModel: ['gemini', 'codex'] }, warnings)
    assert.deepEqual(warnings, [])
  })

  it('warns on a non-array value (and never as a fatal "Invalid type")', () => {
    const warnings = []
    validateProvidersConfigBlock({ allowAnyModel: 'gemini' }, warnings)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /providers\.allowAnyModel/)
    assert.match(warnings[0], /^Invalid value/)
  })

  it('warns on a non-string / empty array entry', () => {
    const warnings = []
    validateProvidersConfigBlock({ allowAnyModel: ['gemini', 42, ''] }, warnings)
    assert.equal(warnings.length, 2)
    assert.ok(warnings.every((w) => /providers\.allowAnyModel/.test(w)))
  })

  it('does not flag allowAnyModel as an unknown provider-block key', () => {
    const warnings = []
    validateProvidersConfigBlock({ allowAnyModel: ['gemini'] }, warnings)
    assert.ok(!warnings.some((w) => /unknown key/i.test(w)))
  })
})

// --- C. create-time seam (SessionManager.createSession preflight) -------------

class Limited6378Session extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model
    this.isRunning = false
    this.resumeSessionId = null
  }
  static get capabilities() {
    return { permissions: false, inProcessPermissions: false, modelSwitch: true, permissionModeSwitch: true, planMode: false, resume: false, terminal: false }
  }
  static getAllowedModels() { return ['allowed-x'] }
  start() { this.isRunning = true }
  destroy() { this.isRunning = false }
  sendMessage() {}
  interrupt() {}
  setModel() { return false }
  setPermissionMode() { return false }
}
registerProvider('test-6378-limited', Limited6378Session)

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'sm-6378-'))
  return join(_tmp, `state-${process.hrtime.bigint()}.json`)
}
after(() => { if (_tmp) rmSync(_tmp, { recursive: true, force: true }) })

describe('#6378 create-time seam', () => {
  it('opted-in provider serves an unlisted model verbatim (no ProviderModelNotSupportedError)', () => {
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      allowAnyModelProviders: new Set(['test-6378-limited']),
    })
    const id = mgr.createSession({ provider: 'test-6378-limited', model: 'brand-new-2099', skipPersist: true })
    assert.ok(id)
    // Passed through verbatim — NOT softened to null, NOT rejected.
    assert.equal(mgr.getSession(id).session.model, 'brand-new-2099')
  })

  it('without the opt-in, an unlisted model still hard-rejects (strict default preserved)', () => {
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      allowAnyModelProviders: new Set(),
    })
    assert.throws(
      () => mgr.createSession({ provider: 'test-6378-limited', model: 'brand-new-2099', skipPersist: true }),
      (err) => err instanceof ProviderModelNotSupportedError,
    )
    assert.equal(mgr.listSessions().length, 0)
  })

  it('a listed model is accepted regardless of the opt-in', () => {
    const mgr = new SessionManager({
      maxSessions: 5,
      stateFilePath: tmpStateFile(),
      defaultCwd: tmpdir(),
      allowAnyModelProviders: new Set(),
    })
    const id = mgr.createSession({ provider: 'test-6378-limited', model: 'allowed-x', skipPersist: true })
    assert.equal(mgr.getSession(id).session.model, 'allowed-x')
  })
})

// --- D. set_model seam (handleSetModel) --------------------------------------

function setModelCtx(sessions, config) {
  const sent = []
  return nsCtx({
    send: createSpy((ws, msg) => { sent.push(msg); if (ws?.send && ws.readyState === 1) ws.send(JSON.stringify(msg)) }),
    broadcastToSession: createSpy(),
    sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
    config,
    _sent: sent,
  })
}
function makeWs() {
  const messages = []
  return { readyState: 1, send: createSpy((raw) => messages.push(JSON.parse(raw))), _messages: messages }
}

describe('#6378 set_model seam', () => {
  it('rejects an unlisted Gemini model when NOT opted in', () => {
    const sessions = new Map()
    const session = createMockSession()
    sessions.set('s1', { session, name: 'Gem', cwd: '/tmp', provider: 'gemini' })
    const ctx = setModelCtx(sessions, {})
    const ws = makeWs()
    settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model: 'gemini-9.9-ultra', requestId: 'r1' }, ctx)
    assert.equal(session.setModel.callCount, 0)
    assert.equal(ws._messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('passes an unlisted Gemini model through when the provider is opted in', () => {
    const sessions = new Map()
    const session = createMockSession()
    sessions.set('s1', { session, name: 'Gem', cwd: '/tmp', provider: 'gemini' })
    const ctx = setModelCtx(sessions, { providers: { allowAnyModel: ['gemini'] } })
    const ws = makeWs()
    settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model: 'gemini-9.9-ultra' }, ctx)
    assert.equal(session.setModel.callCount, 1)
    assert.equal(session.setModel.lastCall[0], 'gemini-9.9-ultra')
    assert.equal(ctx.transport.broadcastToSession.callCount, 1)
  })

  it('the opt-in is per-provider: opting in gemini does not loosen codex', () => {
    const sessions = new Map()
    const session = createMockSession()
    sessions.set('s1', { session, name: 'Cx', cwd: '/tmp', provider: 'codex' })
    const ctx = setModelCtx(sessions, { providers: { allowAnyModel: ['gemini'] } })
    const ws = makeWs()
    settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model: 'gpt-9.9-codex', requestId: 'r2' }, ctx)
    assert.equal(session.setModel.callCount, 0)
    assert.equal(ws._messages[0].code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
  })

  it('still rejects an empty model id even when opted in', () => {
    const sessions = new Map()
    const session = createMockSession()
    sessions.set('s1', { session, name: 'Gem', cwd: '/tmp', provider: 'gemini' })
    const ctx = setModelCtx(sessions, { providers: { allowAnyModel: ['gemini'] } })
    const ws = makeWs()
    settingsHandlers.set_model(ws, { id: 'c1', activeSessionId: 's1' }, { model: '   ', requestId: 'r3' }, ctx)
    assert.equal(session.setModel.callCount, 0)
    assert.equal(ws._messages[0].code, 'INVALID_MODEL')
  })
})
