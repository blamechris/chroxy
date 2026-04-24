import { describe, it, afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { addLogListener, getLogLevel, removeLogListener, setLogLevel } from '../src/logger.js'

/**
 * ws-forwarding.js unit tests (#1732, #2376)
 *
 * Tests cover:
 * - onFlush wiring: normalizer delta flush → broadcast
 * - models_updated: broadcasts available_models to ALL clients
 * - stream_start: broadcasts session_activity with isBusy=true
 * - result: broadcasts session_activity with isBusy=false + cost
 * - session_updated: broadcasts session name change
 * - Normal session_event: routes to broadcastToSession
 * - setupCliForwarding: forwards events through normalizer, models_updated broadcast
 * - executeSideEffects: session_list refresh, push notification trigger, flush_deltas
 * - executeRegistrations: permissionSessionMap/questionSessionMap population
 */

function makeCtx(overrides = {}) {
  const sm = new EventEmitter()
  sm.getSession = mock.fn(() => null)
  sm.listSessions = mock.fn(() => [])
  sm.getSessionContext = mock.fn(() => Promise.resolve(null))
  const normalizer = new EventNormalizer()
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = mock.fn()
  devPreview.closeSession = mock.fn()

  return {
    normalizer,
    sessionManager: sm,
    cliSession: null,
    devPreview,
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    ...overrides,
  }
}

describe('setupForwarding', () => {
  describe('normalizer flush wiring', () => {
    it('wires onFlush to broadcastToSession for session deltas', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      // Simulate normalizer flush with session delta
      ctx.normalizer._onFlush([
        { sessionId: 'sess-1', messageId: 'msg-1', delta: 'hello' },
      ])

      assert.equal(ctx.broadcastToSession.mock.calls.length, 1)
      const [sessionId, msg] = ctx.broadcastToSession.mock.calls[0].arguments
      assert.equal(sessionId, 'sess-1')
      assert.equal(msg.type, 'stream_delta')
      assert.equal(msg.messageId, 'msg-1')
      assert.equal(msg.delta, 'hello')
    })

    it('wires onFlush to broadcast for non-session deltas', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.normalizer._onFlush([
        { sessionId: null, messageId: 'msg-2', delta: 'world' },
      ])

      assert.equal(ctx.broadcast.mock.calls.length, 1)
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'stream_delta')
    })
  })

  describe('models_updated event', () => {
    it('broadcasts available_models to all clients', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'models_updated',
        data: { models: [{ id: 'claude-opus-4-6' }] },
      })

      assert.equal(ctx.broadcast.mock.calls.length, 1)
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'available_models')
      assert.deepEqual(msg.models, [{ id: 'claude-opus-4-6' }])
      // Must NOT call broadcastToSession (session-specific) for models
      assert.equal(ctx.broadcastToSession.mock.calls.length, 0)
    })
  })

  describe('session_activity', () => {
    it('broadcasts isBusy=true on stream_start', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'stream_start',
        data: {},
      })

      const activityCall = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_activity'
      )
      assert.ok(activityCall, 'Expected session_activity broadcast')
      assert.equal(activityCall.arguments[0].isBusy, true)
      assert.equal(activityCall.arguments[0].sessionId, 'sess-1')
    })

    it('broadcasts isBusy=false with cost on result', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'result',
        data: { cost: 0.0012 },
      })

      const activityCall = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_activity'
      )
      assert.ok(activityCall)
      assert.equal(activityCall.arguments[0].isBusy, false)
      assert.equal(activityCall.arguments[0].lastCost, 0.0012)
    })
  })

  describe('session_updated event', () => {
    it('broadcasts session name change to all clients', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_updated', { sessionId: 'sess-1', name: 'New Name' })

      const call = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_updated'
      )
      assert.ok(call)
      assert.equal(call.arguments[0].name, 'New Name')
      assert.equal(call.arguments[0].sessionId, 'sess-1')
    })
  })

  describe('session_restore_failed event (#2954)', () => {
    it('broadcasts restore failure to all clients with full payload', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_restore_failed', {
        sessionId: 'sess-bad',
        name: 'Gemini',
        provider: 'gemini-cli',
        errorCode: 'RESTORE_FAILED',
        errorMessage: 'GEMINI_API_KEY environment variable is not set',
        originalHistoryPreserved: true,
      })

      const call = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_restore_failed'
      )
      assert.ok(call, 'should broadcast session_restore_failed')
      const msg = call.arguments[0]
      assert.equal(msg.sessionId, 'sess-bad')
      assert.equal(msg.name, 'Gemini')
      assert.equal(msg.provider, 'gemini-cli')
      assert.equal(msg.errorCode, 'RESTORE_FAILED')
      assert.equal(msg.errorMessage, 'GEMINI_API_KEY environment variable is not set')
      assert.equal(msg.originalHistoryPreserved, true)
    })
  })

  describe('setupForwarding with cliSession', () => {
    it('sets up CLI forwarding when cliSession provided (no sessionManager)', () => {
      const cliSession = new EventEmitter()
      const devPreview = new EventEmitter()
      devPreview.handleToolResult = mock.fn()
      devPreview.closeSession = mock.fn()
      const normalizer = new EventNormalizer()
      const ctx = {
        normalizer,
        sessionManager: null,
        cliSession,
        devPreview,
        pushManager: null,
        permissionSessionMap: new Map(),
        questionSessionMap: new Map(),
        broadcast: mock.fn(),
        broadcastToSession: mock.fn(),
      }
      // Should not throw
      assert.doesNotThrow(() => setupForwarding(ctx))
    })
  })
})

function makeCliCtx(overrides = {}) {
  const cliSession = new EventEmitter()
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = mock.fn()
  devPreview.closeSession = mock.fn()
  const normalizer = new EventNormalizer()

  return {
    normalizer,
    sessionManager: null,
    cliSession,
    devPreview,
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    ...overrides,
  }
}

describe('setupCliForwarding', () => {
  it('forwards a ready event through the normalizer and broadcasts claude_ready', () => {
    const ctx = makeCliCtx()
    // Provide a minimal cliSession entry for the normalizer's getSessionEntry
    ctx.cliSession.model = null
    ctx.cliSession.permissionMode = 'approve'
    setupForwarding(ctx)

    ctx.cliSession.emit('ready', {})

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const readyMsg = calls.find(m => m.type === 'claude_ready')
    assert.ok(readyMsg, 'expected claude_ready broadcast')
  })

  it('forwards a message event through the normalizer and broadcasts message', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('message', {
      type: 'assistant',
      content: 'Hello',
      tool: null,
      options: null,
      timestamp: 1000,
    })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const msgCall = calls.find(m => m.type === 'message')
    assert.ok(msgCall, 'expected message broadcast')
    assert.equal(msgCall.content, 'Hello')
  })

  it('buffers stream_delta and does not immediately broadcast', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('stream_delta', { messageId: 'msg-1', delta: 'chunk' })

    // Buffered — no broadcast yet
    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const deltaCall = calls.find(m => m.type === 'stream_delta')
    assert.equal(deltaCall, undefined, 'stream_delta should be buffered, not immediately broadcast')
  })

  it('broadcasts models_updated as available_models bypassing the normalizer', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('models_updated', {
      models: [{ id: 'claude-opus-4-6', label: 'Claude Opus' }],
    })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const modelsMsg = calls.find(m => m.type === 'available_models')
    assert.ok(modelsMsg, 'expected available_models broadcast')
    assert.deepEqual(modelsMsg.models, [{ id: 'claude-opus-4-6', label: 'Claude Opus' }])
    assert.ok('defaultModel' in modelsMsg, 'expected defaultModel field')
  })

  it('does not broadcast available_models when models_updated has no models field', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('models_updated', {})

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const modelsMsg = calls.find(m => m.type === 'available_models')
    assert.equal(modelsMsg, undefined)
  })

  it('does not forward unrecognised events', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    // 'custom_internal' is not in FORWARDED_EVENTS — should be silently dropped
    ctx.cliSession.emit('custom_internal', { foo: 'bar' })

    assert.equal(ctx.broadcast.mock.calls.length, 0)
  })
})

describe('executeSideEffects (via setupCliForwarding)', () => {
  it('session_list side-effect: broadcasts session_list when sessionManager present', () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [{ id: 's1' }])
    sm.getSessionContext = mock.fn(() => Promise.resolve(null))
    const normalizer = new EventNormalizer()
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = mock.fn()
    devPreview.closeSession = mock.fn()
    const ctx = {
      normalizer,
      sessionManager: sm,
      cliSession: null,
      devPreview,
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)

    // stream_start triggers a session_list side-effect
    sm.emit('session_event', {
      sessionId: 'sess-1',
      event: 'stream_start',
      data: { messageId: 'msg-1' },
    })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const listMsg = calls.find(m => m.type === 'session_list')
    assert.ok(listMsg, 'expected session_list broadcast')
    assert.deepEqual(listMsg.sessions, [{ id: 's1' }])
    assert.equal(sm.listSessions.mock.calls.length >= 1, true)
  })

  it('session_list side-effect: skipped when sessionManager is null (CLI mode)', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    // stream_start via CLI; normalizer returns session_list side-effect but sessionManager is null
    ctx.cliSession.emit('stream_start', { messageId: 'msg-1' })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const listMsg = calls.find(m => m.type === 'session_list')
    assert.equal(listMsg, undefined, 'session_list must not broadcast without sessionManager')
  })

  it('push side-effect: calls pushManager.send with correct args', () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [])
    sm.getSessionContext = mock.fn(() => Promise.resolve(null))
    const pushManager = { send: mock.fn() }
    const normalizer = new EventNormalizer()
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = mock.fn()
    devPreview.closeSession = mock.fn()
    const ctx = {
      normalizer,
      sessionManager: sm,
      cliSession: null,
      devPreview,
      pushManager,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)

    // permission_request triggers a push side-effect
    sm.emit('session_event', {
      sessionId: 'sess-1',
      event: 'permission_request',
      data: {
        requestId: 'req-1',
        tool: 'bash',
        description: 'run a script',
        input: { command: 'ls' },
        remainingMs: 30000,
      },
    })

    assert.equal(pushManager.send.mock.calls.length, 1)
    const [category, title, body] = pushManager.send.mock.calls[0].arguments
    assert.equal(category, 'permission')
    assert.equal(title, 'Permission needed')
    assert.match(body, /bash/)
  })

  it('push side-effect: skipped when pushManager is null', () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [])
    sm.getSessionContext = mock.fn(() => Promise.resolve(null))
    const normalizer = new EventNormalizer()
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = mock.fn()
    devPreview.closeSession = mock.fn()
    const ctx = {
      normalizer,
      sessionManager: sm,
      cliSession: null,
      devPreview,
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)

    // Should not throw even though pushManager is null
    assert.doesNotThrow(() => {
      sm.emit('session_event', {
        sessionId: 'sess-1',
        event: 'permission_request',
        data: {
          requestId: 'req-1',
          tool: 'bash',
          description: 'run',
          input: {},
          remainingMs: 30000,
        },
      })
    })
  })

  it('flush_deltas side-effect: flushes buffered deltas before stream_end broadcast', () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [])
    sm.getSessionContext = mock.fn(() => Promise.resolve(null))
    const normalizer = new EventNormalizer()
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = mock.fn()
    devPreview.closeSession = mock.fn()
    const ctx = {
      normalizer,
      sessionManager: sm,
      cliSession: null,
      devPreview,
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)

    // Buffer a delta manually
    normalizer.bufferDelta('sess-1', 'msg-1', 'accumulated text')

    // stream_end triggers flush_deltas side-effect
    sm.emit('session_event', {
      sessionId: 'sess-1',
      event: 'stream_end',
      data: { messageId: 'msg-1' },
    })

    const sessionCalls = ctx.broadcastToSession.mock.calls
    const deltaCall = sessionCalls.find(c => c.arguments[1]?.type === 'stream_delta')
    assert.ok(deltaCall, 'expected stream_delta broadcast from flush_deltas')
    assert.equal(deltaCall.arguments[0], 'sess-1')
    assert.equal(deltaCall.arguments[1].delta, 'accumulated text')
    assert.equal(deltaCall.arguments[1].messageId, 'msg-1')
  })

  it('flush_deltas in CLI mode broadcasts without sessionId', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    // Buffer a delta in legacy (null sessionId) mode
    ctx.normalizer.bufferDelta(null, 'msg-99', 'legacy delta')

    // stream_end triggers flush_deltas
    ctx.cliSession.emit('stream_end', { messageId: 'msg-99' })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const deltaMsg = calls.find(m => m.type === 'stream_delta')
    assert.ok(deltaMsg, 'expected stream_delta broadcast in CLI mode')
    assert.equal(deltaMsg.delta, 'legacy delta')
    assert.equal(deltaMsg.messageId, 'msg-99')
  })
})

describe('custom event type forwarding (registerEventType)', () => {
  it('forwards a provider-registered event type through the normalizer to broadcastToSession', () => {
    const ctx = makeCtx()
    setupForwarding(ctx)

    // Register a custom event type on the normalizer
    ctx.normalizer.registerEventType('provider_health', (data) => ({
      messages: [{ msg: { type: 'provider_health', status: data.status } }],
    }))

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'provider_health',
      data: { status: 'ok' },
    })

    const call = ctx.broadcastToSession.mock.calls.find(c =>
      c.arguments[1]?.type === 'provider_health'
    )
    assert.ok(call, 'expected provider_health to be broadcast to session')
    assert.equal(call.arguments[0], 'sess-1')
    assert.equal(call.arguments[1].status, 'ok')

    // Clean up
    delete ctx.normalizer._onFlush
    ctx.normalizer.destroy()
  })

  it('unknown custom events with no registered handler are silently dropped', () => {
    const ctx = makeCtx()
    setupForwarding(ctx)

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'totally_unknown_event',
      data: { foo: 'bar' },
    })

    // Should not throw, and no broadcast should happen for this unknown event
    // (session_activity for certain events may fire, but not broadcastToSession
    //  with type 'totally_unknown_event')
    const call = ctx.broadcastToSession.mock.calls.find(c =>
      c.arguments[1]?.type === 'totally_unknown_event'
    )
    assert.equal(call, undefined)
  })
})

describe('executeRegistrations (via setupCliForwarding)', () => {
  it('registers permission requestId in permissionSessionMap', () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [])
    sm.getSessionContext = mock.fn(() => Promise.resolve(null))
    const normalizer = new EventNormalizer()
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = mock.fn()
    devPreview.closeSession = mock.fn()
    const permissionSessionMap = new Map()
    const questionSessionMap = new Map()
    const ctx = {
      normalizer,
      sessionManager: sm,
      cliSession: null,
      devPreview,
      pushManager: null,
      permissionSessionMap,
      questionSessionMap,
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)

    sm.emit('session_event', {
      sessionId: 'sess-42',
      event: 'permission_request',
      data: {
        requestId: 'req-abc',
        tool: 'bash',
        description: 'run',
        input: {},
        remainingMs: 30000,
      },
    })

    assert.equal(permissionSessionMap.has('req-abc'), true)
    assert.equal(permissionSessionMap.get('req-abc'), 'sess-42')
  })

  it('registers question toolUseId in questionSessionMap', () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [])
    sm.getSessionContext = mock.fn(() => Promise.resolve(null))
    const normalizer = new EventNormalizer()
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = mock.fn()
    devPreview.closeSession = mock.fn()
    const permissionSessionMap = new Map()
    const questionSessionMap = new Map()
    const ctx = {
      normalizer,
      sessionManager: sm,
      cliSession: null,
      devPreview,
      pushManager: null,
      permissionSessionMap,
      questionSessionMap,
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
    }
    setupForwarding(ctx)

    sm.emit('session_event', {
      sessionId: 'sess-99',
      event: 'user_question',
      data: {
        toolUseId: 'tool-xyz',
        questions: ['Are you sure?'],
      },
    })

    assert.equal(questionSessionMap.has('tool-xyz'), true)
    assert.equal(questionSessionMap.get('tool-xyz'), 'sess-99')
  })

  it('registers question in CLI mode (sessionId stored as null)', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('user_question', {
      toolUseId: 'tool-cli-1',
      questions: ['Proceed?'],
    })

    assert.equal(ctx.questionSessionMap.has('tool-cli-1'), true)
    assert.equal(ctx.questionSessionMap.get('tool-cli-1'), null)
  })

  it('does not throw when both maps are empty and no registrations needed', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    assert.doesNotThrow(() => {
      ctx.cliSession.emit('message', {
        type: 'assistant',
        content: 'Hi',
        tool: null,
        options: null,
        timestamp: 0,
      })
    })

    assert.equal(ctx.permissionSessionMap.size, 0)
    assert.equal(ctx.questionSessionMap.size, 0)
  })
})

describe('[session-binding-create] diagnostic log (#2832, #2855, #2854)', () => {
  let currentListener = null
  let priorLogLevel = null
  beforeEach(() => {
    // Capture the level configured at suite start (typically from
    // process.env.LOG_LEVEL, but may have been changed by another suite)
    // so afterEach can round-trip it — never hard-code 'info'. (#2889)
    priorLogLevel = getLogLevel()
  })
  afterEach(() => {
    if (currentListener) {
      removeLogListener(currentListener)
      currentListener = null
    }
    // Restore the prior level so unrelated suites are unaffected.
    setLogLevel(priorLogLevel)
  })

  it('emits [session-binding-create] when SDK permission_request is registered with the event sessionId', () => {
    // #2854: gated at debug level — enable for this assertion.
    setLogLevel('debug')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCtx()
    setupForwarding(ctx)

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-create-1',
      event: 'permission_request',
      data: {
        requestId: 'req-create-1',
        tool: 'Write',
        description: '/tmp/foo',
        input: {},
        remainingMs: 300_000,
      },
    })

    const createLog = entries.find((e) =>
      e.level === 'debug' && e.message.includes('[session-binding-create]'),
    )
    assert.ok(createLog, 'expected a [session-binding-create] debug log entry')
    // Correlation key (requestId) and origin session must both be present for
    // grep-based triage of #2832 SESSION_TOKEN_MISMATCH rejections.
    assert.match(createLog.message, /permission req-create-1 created/)
    assert.match(createLog.message, /sessionId=sess-create-1/)
    // The map must also reflect the registration so downstream
    // [session-binding-resend] uses the same origin session id.
    assert.equal(ctx.permissionSessionMap.get('req-create-1'), 'sess-create-1')
  })

  it('emits [session-binding-create] with registration-provided value when the normalizer overrides sessionId', () => {
    setLogLevel('debug')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCtx()
    setupForwarding(ctx)

    // Register a custom event type whose registration carries an explicit
    // sessionId value — the create log must honour that override, because
    // the permission actually belongs to that nested session.
    ctx.normalizer.registerEventType('nested_perm', (data) => ({
      messages: [{ msg: { type: 'permission_request', requestId: data.requestId } }],
      registrations: [{ map: 'permission', key: data.requestId, value: data.originSessionId }],
    }))

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-outer',
      event: 'nested_perm',
      data: { requestId: 'req-nested-1', originSessionId: 'sess-inner' },
    })

    const createLog = entries.find((e) =>
      e.level === 'debug' && e.message.includes('[session-binding-create]'),
    )
    assert.ok(createLog, 'expected a [session-binding-create] debug log entry for nested registration')
    assert.match(createLog.message, /sessionId=sess-inner/)
    assert.equal(ctx.permissionSessionMap.get('req-nested-1'), 'sess-inner')

    ctx.normalizer.destroy()
  })

  it('does not emit [session-binding-create] for question registrations', () => {
    setLogLevel('debug')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCtx()
    setupForwarding(ctx)

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-q-1',
      event: 'user_question',
      data: {
        toolUseId: 'tool-q-1',
        questions: ['Go ahead?'],
      },
    })

    const createLog = entries.find((e) =>
      e.level === 'debug' && e.message.includes('[session-binding-create]'),
    )
    assert.equal(createLog, undefined,
      'question registrations must not emit the permission-scoped diagnostic log')
    // Sanity: the question registration itself still happened
    assert.equal(ctx.questionSessionMap.get('tool-q-1'), 'sess-q-1')
  })

  it('does NOT emit [session-binding-create] at default (info) log level (#2854)', () => {
    // Default log level is 'info' — debug-gated diagnostic log must be silent.
    // This is the whole point of #2854: high-volume permission traffic in
    // auto/accept-all sessions must not spam prod logs.
    setLogLevel('info')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCtx()
    setupForwarding(ctx)

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-silent',
      event: 'permission_request',
      data: {
        requestId: 'req-silent',
        tool: 'Bash',
        description: 'ls',
        input: {},
        remainingMs: 300_000,
      },
    })

    const createLog = entries.find((e) => e.message.includes('[session-binding-create]'))
    assert.equal(createLog, undefined,
      '[session-binding-create] must be silent at info level to avoid spamming prod logs')
    // Sanity: the registration itself still happened — only the log is gated.
    assert.equal(ctx.permissionSessionMap.get('req-silent'), 'sess-silent')
  })
})
