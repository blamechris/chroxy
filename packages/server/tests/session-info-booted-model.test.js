import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createSpy, createMockSessionManager } from './test-helpers.js'
import { sendSessionInfo, sendPostAuthInfo } from '../src/ws-history.js'
import { SessionManager } from '../src/session-manager.js'
// Side-effect: registers built-in providers so getRegistryForProvider() works
// inside sendPostAuthInfo (it sends `available_models` keyed on provider).
import '../src/providers.js'

/**
 * #3691 — bootedModel fallback coverage for sendSessionInfo + listSessions.
 *
 * Companion to #3687/#3688. The fallback chain `session.model ||
 * session.bootedModel` is what lets the dashboard render the *running*
 * model on a tab switch / reconnect / session_list payload when the
 * session was booted without an explicit override (e.g. Codex/Gemini
 * sessions, or a Claude session that inherited the CLI default).
 *
 * #3688 covered the `ready` handler's normalizer; this file pins the two
 * downstream paths that share the same precedence:
 *   - `sendSessionInfo` in ws-history.js  (tab switch / reconnect replay)
 *   - `listSessions` in session-manager.js (session_list payload)
 *
 * Each path is exercised across all three branches:
 *   1) explicit override present       → wire reports the override
 *   2) override null, bootedModel set  → wire reports the bootedModel (fallback)
 *   3) override null, bootedModel null → wire reports `null`
 */

// ── sendSessionInfo bootedModel fallback (#3691) ───────────────────────────

function makeCtx(overrides = {}) {
  const sends = []
  const ctx = {
    sessionManager: null,
    send: createSpy((ws, msg) => sends.push(msg)),
    ...overrides,
  }
  ctx._sends = sends
  return ctx
}

function makeFakeWs(readyState = 1) {
  return { readyState, send: () => {}, close: () => {} }
}

describe('sendSessionInfo — bootedModel fallback (#3691)', () => {
  it('prefers explicit session.model when both override and bootedModel are set', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // User picked sonnet via the dashboard picker after boot; the session
    // originally booted on opus. Precedence: explicit override wins.
    const session = sessionsMap.get('sess-1').session
    session.model = 'claude-sonnet-4-6'
    session.bootedModel = 'claude-opus-4-8'

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })

    sendSessionInfo(ctx, ws, 'sess-1')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.ok(modelMsg, 'model_changed was not sent')
    assert.equal(modelMsg.sessionId, 'sess-1')
    assert.equal(modelMsg.model, 'sonnet',
      'override must win over bootedModel so a fresh setModel() is not masked')
  })

  it('falls back to bootedModel when session.model is null (#3691 core case)', () => {
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    // Codex / Gemini boot path: BaseSession.model stays null until the user
    // explicitly picks one. The wire must still report the running model
    // so tab switches don't blank out the picker.
    const session = sessionsMap.get('sess-1').session
    session.model = null
    session.bootedModel = 'claude-opus-4-8'

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })

    sendSessionInfo(ctx, ws, 'sess-1')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, 'opus',
      'bootedModel must surface as short id when no explicit override is set')
  })

  it('falls back to bootedModel when session.model is empty string', () => {
    // BaseSession normalises empty to null elsewhere, but defend against
    // a provider class that surfaces '' directly — the `||` chain must
    // treat both as "no override".
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const session = sessionsMap.get('sess-1').session
    session.model = ''
    session.bootedModel = 'claude-opus-4-8'

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })

    sendSessionInfo(ctx, ws, 'sess-1')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, 'opus')
  })

  it('emits model: null when both session.model and bootedModel are absent', () => {
    // Session that hasn't booted yet — the dashboard renders this as
    // "no model" instead of guessing a default that may not match what
    // the eventual `ready` event surfaces.
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
    ])
    const session = sessionsMap.get('sess-1').session
    session.model = null
    session.bootedModel = null

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })

    sendSessionInfo(ctx, ws, 'sess-1')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, null)
  })

  it('passes a non-aliased provider model through unchanged via toShortModelId', () => {
    // Codex/Gemini IDs don't have a short alias in the default registry,
    // so toShortModelId returns the input unchanged. Verifies the fallback
    // works for non-Claude providers without accidentally mapping to null.
    const { manager, sessionsMap } = createMockSessionManager([
      { id: 'sess-codex', name: 'Codex', cwd: '/codex' },
    ])
    const session = sessionsMap.get('sess-codex').session
    session.model = null
    session.bootedModel = 'gpt-5-codex'

    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })

    sendSessionInfo(ctx, ws, 'sess-codex')
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, 'gpt-5-codex',
      'unaliased model ids round-trip via toShortModelId without becoming null')
  })
})

// ── sendPostAuthInfo legacy single-session bootedModel fallback (#3691) ─────

describe('sendPostAuthInfo — legacy cliSession bootedModel fallback (#3691)', () => {
  function makeLegacyCtx(cliSession) {
    const sends = []
    const ctx = {
      clients: new Map(),
      sessionManager: null,
      cliSession,
      defaultSessionId: null,
      serverMode: 'cli',
      serverVersion: '0.0.0-test',
      latestVersion: '0.0.0-test',
      gitInfo: { commit: 'test' },
      encryptionEnabled: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
      protocolVersion: 3,
      minProtocolVersion: 1,
      webTaskManager: { getFeatureStatus: () => ({ available: false, remote: false, teleport: false }) },
      send: createSpy((ws, msg) => sends.push(msg)),
      broadcast: createSpy(),
      getConnectedClientList: createSpy(() => []),
      permissions: { resendPendingPermissions: createSpy() },
    }
    ctx._sends = sends
    return ctx
  }

  function registerLegacyClient(ctx, ws) {
    const client = {
      id: 'legacy-client',
      socketIp: '127.0.0.1',
      activeSessionId: null,
      encryptionPending: false,
      postAuthQueue: null,
      _flushing: false,
      _flushOverflow: null,
    }
    ctx.clients.set(ws, client)
    return client
  }

  it('prefers cliSession.model over bootedModel when both are set', () => {
    const cliSession = {
      cwd: '/tmp',
      isReady: true,
      model: 'claude-sonnet-4-6',
      bootedModel: 'claude-opus-4-8',
      permissionMode: 'approve',
    }
    const ctx = makeLegacyCtx(cliSession)
    const ws = makeFakeWs()
    registerLegacyClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, 'sonnet')
  })

  it('falls back to cliSession.bootedModel when cliSession.model is null', () => {
    const cliSession = {
      cwd: '/tmp',
      isReady: true,
      model: null,
      bootedModel: 'claude-opus-4-8',
      permissionMode: 'approve',
    }
    const ctx = makeLegacyCtx(cliSession)
    const ws = makeFakeWs()
    registerLegacyClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, 'opus',
      'legacy single-session mode must surface bootedModel when no override is set')
  })

  it('emits null when neither cliSession.model nor bootedModel is set', () => {
    const cliSession = {
      cwd: '/tmp',
      isReady: false,
      model: null,
      bootedModel: null,
      permissionMode: 'approve',
    }
    const ctx = makeLegacyCtx(cliSession)
    const ws = makeFakeWs()
    registerLegacyClient(ctx, ws)

    sendPostAuthInfo(ctx, ws)
    const modelMsg = ctx._sends.find(m => m.type === 'model_changed')
    assert.equal(modelMsg.model, null)
  })
})

// ── SessionManager.listSessions bootedModel fallback (#3691) ────────────────

describe('SessionManager.listSessions — bootedModel fallback (#3691)', () => {
  // Each SessionManager MUST use a temp stateFilePath so tests don't
  // overwrite the user's real session-state.json (see test_state_contamination
  // entry in MEMORY.md).
  let _tmpDir
  function tmpStateFile() {
    if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'sm-3691-'))
    return join(_tmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  }

  after(() => {
    if (_tmpDir) rmSync(_tmpDir, { recursive: true, force: true })
  })

  function attachSession(mgr, id, { model, bootedModel, name = 'S', cwd = '/tmp' } = {}) {
    const session = new EventEmitter()
    session.model = model
    session.bootedModel = bootedModel
    session.permissionMode = 'approve'
    session.isRunning = false
    session.promptEvaluator = false
    session.promptEvaluatorSkipPattern = null
    Object.defineProperty(session, 'resumeSessionId', { get: () => null })
    session.destroy = () => {}
    mgr._sessions.set(id, {
      session,
      type: 'cli',
      name,
      cwd,
      createdAt: Date.now(),
    })
  }

  it('reports session.model when an explicit override is set', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    attachSession(mgr, 's-override', { model: 'claude-sonnet-4-6', bootedModel: 'claude-opus-4-8' })

    const [entry] = mgr.listSessions()
    assert.equal(entry.sessionId, 's-override')
    assert.equal(entry.model, 'claude-sonnet-4-6',
      'override wins so a fresh setModel() is not masked by a stale boot value')
  })

  it('falls back to session.bootedModel when session.model is null (#3691 core case)', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    attachSession(mgr, 's-fallback', { model: null, bootedModel: 'claude-opus-4-8' })

    const [entry] = mgr.listSessions()
    assert.equal(entry.model, 'claude-opus-4-8',
      'session_list payload must surface the running model when no override is set')
  })

  it('reports null when neither session.model nor bootedModel is set', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    attachSession(mgr, 's-empty', { model: null, bootedModel: null })

    const [entry] = mgr.listSessions()
    assert.equal(entry.model, null,
      'pre-boot session lists as null instead of guessing a default')
  })

  it('falls back when session.model is an empty string', () => {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    attachSession(mgr, 's-empty-str', { model: '', bootedModel: 'claude-opus-4-8' })

    const [entry] = mgr.listSessions()
    assert.equal(entry.model, 'claude-opus-4-8',
      'empty string is treated as "no override" by the `||` chain')
  })

  it('preserves the fallback distinction across multiple sessions in a single listSessions call', () => {
    // Mixed session list: one with an override, one fallback, one empty.
    // Guards against any future refactor that accidentally folds the
    // fallback into a shared field — every entry must keep its own
    // precedence result.
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpStateFile() })
    attachSession(mgr, 's-a', { model: 'claude-sonnet-4-6', bootedModel: 'claude-opus-4-8', name: 'A' })
    attachSession(mgr, 's-b', { model: null, bootedModel: 'claude-opus-4-8', name: 'B' })
    attachSession(mgr, 's-c', { model: null, bootedModel: null, name: 'C' })

    const list = mgr.listSessions()
    const byId = Object.fromEntries(list.map(e => [e.sessionId, e]))
    assert.equal(byId['s-a'].model, 'claude-sonnet-4-6')
    assert.equal(byId['s-b'].model, 'claude-opus-4-8')
    assert.equal(byId['s-c'].model, null)
  })
})
