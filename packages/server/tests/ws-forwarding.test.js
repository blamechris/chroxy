import { describe, it, afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { addLogListener, getLogLevel, removeLogListener, setLogLevel } from '../src/logger.js'
import { registerProviderRegistry, getRegistryForProvider, updateModels, resetModels } from '../src/models.js'

/**
 * ws-forwarding.js unit tests (#1732, #2376)
 *
 * Tests cover:
 * - onFlush wiring: normalizer delta flush → broadcast
 * - models_updated: broadcasts available_models to ALL clients
 * - models_updated: provider-aware registry lookup (#2993)
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
  const checkpointManager = new EventEmitter()

  return {
    normalizer,
    sessionManager: sm,
    cliSession: null,
    devPreview,
    checkpointManager,
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

    // #6818: a flushed THINKING entry stamps `thinking: true` back onto the wire
    // so the coalesced frame routes to the reasoning bubble; a response entry
    // carries no such flag.
    it('stamps thinking:true on a flushed thinking delta and omits it for response deltas', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.normalizer._onFlush([
        { sessionId: 'sess-1', messageId: 'm1-thinking-0', delta: 'reason', thinking: true },
        { sessionId: 'sess-1', messageId: 'm1', delta: 'answer' },
      ])

      const byId = Object.fromEntries(
        ctx.broadcastToSession.mock.calls.map(c => [c.arguments[1].messageId, c.arguments[1]]),
      )
      assert.equal(byId['m1-thinking-0'].thinking, true, 'thinking frame carries the flag on the wire')
      assert.equal(byId['m1'].thinking, undefined, 'response frame carries no thinking flag')
    })

    // #6818 end-to-end: a thinking stream_delta is buffered (coalesced), then the
    // thinking stream_end flushes it as a `thinking: true` frame BEFORE the
    // stream_end finalisation — preserving the "Thinking… → Thought" ordering.
    it('coalesces thinking deltas and flushes them (thinking:true) before the thinking stream_end', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1', event: 'stream_delta',
        data: { messageId: 'm1-thinking-0', delta: 'think ', thinking: true },
      })
      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1', event: 'stream_delta',
        data: { messageId: 'm1-thinking-0', delta: 'harder', thinking: true },
      })
      // No per-token broadcast yet — coalesced in the buffer.
      const preEnd = ctx.broadcastToSession.mock.calls.map(c => c.arguments[1]).filter(m => m.type === 'stream_delta')
      assert.equal(preEnd.length, 0, 'thinking deltas are buffered, not broadcast per-token')

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1', event: 'stream_end',
        data: { messageId: 'm1-thinking-0', thinking: true },
      })

      const msgs = ctx.broadcastToSession.mock.calls.map(c => c.arguments[1])
      const deltaIdx = msgs.findIndex(m => m.type === 'stream_delta')
      const endIdx = msgs.findIndex(m => m.type === 'stream_end')
      assert.ok(deltaIdx !== -1, 'one coalesced thinking delta frame emitted')
      assert.equal(msgs[deltaIdx].delta, 'think harder', 'two thinking deltas coalesced into one')
      assert.equal(msgs[deltaIdx].thinking, true)
      assert.equal(msgs[endIdx].thinking, true)
      assert.ok(deltaIdx < endIdx, 'coalesced thinking delta lands before the stream_end')
    })
  })

  // #5515 (epic #5514): latency instrumentation — broadcast-time serverTs.
  describe('serverTs stamping (#5515)', () => {
    it('stamps a wall-clock serverTs on flushed stream_delta (session path)', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)
      const before = Date.now()
      ctx.normalizer._onFlush([
        { sessionId: 'sess-1', messageId: 'msg-1', delta: 'hello' },
      ])
      const after = Date.now()
      const msg = ctx.broadcastToSession.mock.calls[0].arguments[1]
      assert.equal(typeof msg.serverTs, 'number')
      assert.ok(msg.serverTs >= before && msg.serverTs <= after, `serverTs ${msg.serverTs} not in [${before}, ${after}]`)
    })

    it('stamps serverTs on flushed stream_delta (broadcast/legacy path)', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)
      ctx.normalizer._onFlush([
        { sessionId: null, messageId: 'msg-2', delta: 'world' },
      ])
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(typeof msg.serverTs, 'number')
    })

    it('stamps serverTs on stream_start / stream_end broadcast through the normalizer', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)
      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'stream_start',
        data: { messageId: 'm1' },
      })
      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'stream_end',
        data: { messageId: 'm1' },
      })
      const stamped = ctx.broadcastToSession.mock.calls
        .map((c) => c.arguments[1])
        .filter((m) => m && (m.type === 'stream_start' || m.type === 'stream_end'))
      assert.ok(stamped.length >= 2, `expected stream_start+stream_end, got ${stamped.map((m) => m.type)}`)
      for (const m of stamped) {
        assert.equal(typeof m.serverTs, 'number', `${m.type} missing serverTs`)
      }
    })

    it('does not stamp serverTs on non-stream messages (e.g. session_activity)', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)
      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'stream_start',
        data: { messageId: 'm1' },
      })
      const activity = ctx.broadcast.mock.calls
        .map((c) => c.arguments[0])
        .find((m) => m && m.type === 'session_activity')
      assert.ok(activity, 'expected a session_activity broadcast')
      assert.equal(activity.serverTs, undefined)
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

    it('uses provider-scoped registry defaultModel for a non-Claude provider session (#2993)', () => {
      // Seed the global Claude registry with a known non-null default so the
      // assertion can distinguish "used codex registry" from "used Claude global".
      updateModels([{ value: 'claude-sonnet-4-6', displayName: 'Default (Claude Sonnet)' }])

      // Register a fake non-Claude provider with its own fallback models
      const FakeProvider = class {
        static getFallbackModels() {
          return [
            { id: 'codex-mini', label: 'Codex Mini', fullId: 'codex-mini-latest', contextWindow: 100_000 },
          ]
        }
        static getModelMetadata(fullId) {
          if (fullId === 'codex-mini-latest') {
            return { id: 'codex-mini', label: 'Codex Mini', fullId: 'codex-mini-latest', contextWindow: 100_000 }
          }
          return null
        }
      }
      registerProviderRegistry('codex-sdk', FakeProvider)
      const codexRegistry = getRegistryForProvider('codex-sdk')

      // Codex registry has no SDK-reported default — getDefaultModelId() returns null.
      // The broadcast must use the codex registry value (null), NOT the Claude global (sonnet-4-6).
      const ctx = makeCtx()
      // Make getSession return an entry whose provider is 'codex-sdk'
      ctx.sessionManager.getSession = mock.fn(() => ({ provider: 'codex-sdk' }))
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-codex',
        event: 'models_updated',
        data: { models: [{ id: 'codex-mini-latest' }] },
      })

      assert.equal(ctx.broadcast.mock.calls.length, 1)
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'available_models')
      // defaultModel must come from the codex provider's registry (null — no SDK default yet),
      // not the Claude global (which is now 'sonnet-4-6'). This ensures the test is non-vacuous.
      assert.equal(msg.defaultModel, codexRegistry.getDefaultModelId())
      assert.notEqual(msg.defaultModel, 'sonnet-4-6')

      // Restore global registry state so this test doesn't bleed into others
      resetModels()
    })

    it('falls back to global Claude registry when session lookup returns null (#2993)', () => {
      const ctx = makeCtx()
      // getSession returning null simulates an already-destroyed session
      ctx.sessionManager.getSession = mock.fn(() => null)
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-gone',
        event: 'models_updated',
        data: { models: [{ id: 'claude-sonnet-4-6' }] },
      })

      assert.equal(ctx.broadcast.mock.calls.length, 1)
      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'available_models')
      // Falls back to Claude default — must still produce a valid broadcast
      assert.ok('defaultModel' in msg)
      // provider must be resolved to 'claude-sdk' (not null) so clients can
      // route consistently when the fallback path is taken (#2993)
      assert.equal(msg.provider, 'claude-sdk')
    })

    it('includes provider field in available_models broadcast so clients can route correctly (#2993)', () => {
      const ctx = makeCtx()
      ctx.sessionManager.getSession = mock.fn(() => ({ provider: 'claude-sdk' }))
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-claude',
        event: 'models_updated',
        data: { models: [{ id: 'claude-sonnet-4-6' }] },
      })

      const msg = ctx.broadcast.mock.calls[0].arguments[0]
      assert.equal(msg.type, 'available_models')
      assert.equal(msg.provider, 'claude-sdk')
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

  // #5835 Phase 2: a terminal_resize session_event broadcasts terminal_size to
  // the SAME audience as terminal_output (opted-in terminal subscribers who are
  // also session viewers), so observers re-letterbox to the authoritative grid.
  describe('terminal_resize → terminal_size broadcast', () => {
    it('broadcasts terminal_size to terminal subscribers with the resized grid', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-1',
        event: 'terminal_resize',
        data: { cols: 160, rows: 48 },
      })

      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'terminal_size'
      )
      assert.ok(call, 'Expected a terminal_size broadcastToSession call')
      const [sessionId, msg, filter] = call.arguments
      assert.equal(sessionId, 'sess-1')
      assert.deepEqual(
        { type: msg.type, sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows },
        { type: 'terminal_size', sessionId: 'sess-1', cols: 160, rows: 48 },
      )

      // The filter admits only a client opted into THIS session's terminal AND
      // viewing it; opt-in alone, or viewing without opt-in, must be excluded.
      const viewerOptedIn = { terminalSessionIds: new Set(['sess-1']), activeSessionId: 'sess-1' }
      const viewerNoOptIn = { terminalSessionIds: new Set(), activeSessionId: 'sess-1' }
      const optInNotViewing = { terminalSessionIds: new Set(['sess-1']), activeSessionId: 'other', subscribedSessionIds: new Set() }
      const optInSubscribed = { terminalSessionIds: new Set(['sess-1']), activeSessionId: 'other', subscribedSessionIds: new Set(['sess-1']) }
      assert.equal(filter(viewerOptedIn), true)
      assert.equal(filter(viewerNoOptIn), false)
      assert.equal(filter(optInNotViewing), false)
      assert.equal(filter(optInSubscribed), true)
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
        cwd: '/bad',
        model: null,
        permissionMode: 'approve',
        errorCode: 'RESTORE_FAILED',
        errorMessage: 'GEMINI_API_KEY environment variable is not set',
        originalHistoryPreserved: true,
        historyLength: 2,
      })

      const call = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_restore_failed'
      )
      assert.ok(call, 'should broadcast session_restore_failed')
      const msg = call.arguments[0]
      assert.equal(msg.sessionId, 'sess-bad')
      assert.equal(msg.name, 'Gemini')
      assert.equal(msg.provider, 'gemini-cli')
      assert.equal(msg.cwd, '/bad')
      assert.equal(msg.model, null)
      assert.equal(msg.permissionMode, 'approve')
      assert.equal(msg.errorCode, 'RESTORE_FAILED')
      assert.equal(msg.errorMessage, 'GEMINI_API_KEY environment variable is not set')
      assert.equal(msg.originalHistoryPreserved, true)
      assert.equal(msg.historyLength, 2)
    })
  })

  describe('session_persist_failed event (#5714)', () => {
    it('broadcasts a persist failure to all clients', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_persist_failed', { sessionId: 'sess-1', name: 'My Session' })

      const call = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_persist_failed'
      )
      assert.ok(call, 'should broadcast session_persist_failed')
      assert.equal(call.arguments[0].sessionId, 'sess-1')
      assert.equal(call.arguments[0].name, 'My Session')
    })

    it('forwards a null name (destroy path) without throwing', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_persist_failed', { sessionId: 'sess-gone', name: null })

      const call = ctx.broadcast.mock.calls.find(c =>
        c.arguments[0].type === 'session_persist_failed'
      )
      assert.ok(call)
      assert.equal(call.arguments[0].name, null)
    })
  })

  describe('checkpoint_persist_failed event (#5731 T3)', () => {
    it('surfaces a checkpoint persist failure as a per-session session_error', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.checkpointManager.emit('checkpoint_persist_failed', { sessionId: 'sess-1', checkpointId: 'cp-1', operation: 'create' })

      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'session_error' && c.arguments[1]?.code === 'CHECKPOINT_PERSIST_FAILED'
      )
      assert.ok(call, 'should broadcast a CHECKPOINT_PERSIST_FAILED session_error to the session')
      const [sessionId, msg] = call.arguments
      assert.equal(sessionId, 'sess-1')
      assert.equal(msg.sessionId, 'sess-1')
      assert.equal(msg.recoverable, true)
      assert.match(msg.message, /lost on restart/)
    })

    it('does not throw when checkpointManager is absent (legacy single-session ctx)', () => {
      const ctx = makeCtx({ checkpointManager: null })
      assert.doesNotThrow(() => setupForwarding(ctx))
    })
  })

  describe('session_create_failed event (#5731 T6)', () => {
    it('surfaces a fresh-session start failure as a per-session session_error', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_create_failed', {
        sessionId: 'sess-1',
        name: 'Doomed',
        provider: 'claude-tui',
        cwd: '/tmp',
        model: null,
        errorCode: 'START_FAILED',
        errorMessage: 'claude PTY exited during warmup (code=1)',
      })

      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'session_error' && c.arguments[1]?.code === 'START_FAILED'
      )
      assert.ok(call, 'should broadcast a START_FAILED session_error to the session')
      const [sessionId, msg] = call.arguments
      assert.equal(sessionId, 'sess-1')
      assert.equal(msg.sessionId, 'sess-1')
      assert.equal(msg.recoverable, false, 'fresh-session failure has no retry affordance')
      assert.match(msg.message, /failed to start/)
      assert.match(msg.message, /warmup/, 'includes the provider rejection reason when present')
    })

    it('falls back to SESSION_START_FAILED + provider-named message when fields are sparse', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_create_failed', { sessionId: 'sess-2', provider: 'claude-tui' })

      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'session_error' && c.arguments[1]?.sessionId === 'sess-2'
      )
      assert.ok(call, 'should still broadcast with default code')
      const msg = call.arguments[1]
      assert.equal(msg.code, 'SESSION_START_FAILED')
      assert.match(msg.message, /\(claude-tui\)/)
    })

    it('ignores a session_create_failed with no sessionId', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)
      ctx.sessionManager.emit('session_create_failed', { errorMessage: 'oops' })
      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'session_error'
      )
      assert.equal(call, undefined, 'no broadcast without a session to scope to')
    })
  })

  describe('dev_preview_stop_failed event (#5731)', () => {
    it('surfaces a tunnel-stop failure as a per-session session_error', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.devPreview.emit('dev_preview_stop_failed', { sessionId: 'sess-1', port: 3000, error: 'kill failed' })

      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'session_error' && c.arguments[1]?.code === 'DEV_PREVIEW_STOP_FAILED'
      )
      assert.ok(call, 'should broadcast a DEV_PREVIEW_STOP_FAILED session_error to the session')
      const [sessionId, msg] = call.arguments
      assert.equal(sessionId, 'sess-1')
      assert.equal(msg.recoverable, true)
      assert.match(msg.message, /port 3000/)
      assert.match(msg.message, /may still be exposed/)
    })

    it('ignores a dev_preview_stop_failed with no sessionId', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)
      ctx.devPreview.emit('dev_preview_stop_failed', { port: 3000, error: 'x' })
      const call = ctx.broadcastToSession.mock.calls.find(c =>
        c.arguments[1]?.type === 'session_error' && c.arguments[1]?.code === 'DEV_PREVIEW_STOP_FAILED'
      )
      assert.equal(call, undefined)
    })
  })

  // #4756 — `stopped` event surfaces through the normalizer as a
  // `session_stopped` broadcast targeted at subscribers of the affected
  // session (NOT global broadcast). Pairs with the wiring in
  // session-manager.js's `_wireSessionEvents` (transient list) and the
  // `stopped` handler in event-normalizer.js.
  describe('stopped event (#4756)', () => {
    it('broadcasts session_stopped via broadcastToSession (not global)', () => {
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-stop',
        event: 'stopped',
        data: { code: 0 },
      })

      // Must route per-session — only subscribers of sess-stop should see
      // the confirmation, not every connected client.
      assert.equal(ctx.broadcastToSession.mock.calls.length, 1)
      const [sid, msg] = ctx.broadcastToSession.mock.calls[0].arguments
      assert.equal(sid, 'sess-stop')
      assert.equal(msg.type, 'session_stopped')
      assert.equal(msg.sessionId, 'sess-stop')
      assert.equal(msg.code, 0)
      // Must NOT also fire global broadcast for this event.
      assert.equal(ctx.broadcast.mock.calls.length, 0)
    })

    it('does not emit session_activity (informational, not busy/idle)', () => {
      // session_activity is fired on stream_start/result only — `stopped`
      // is a lifecycle signal, not a busy-state flip, so the sidebar
      // activity feed should not light up for it.
      const ctx = makeCtx()
      setupForwarding(ctx)

      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-stop',
        event: 'stopped',
        data: { code: 0 },
      })

      const activityCall = ctx.broadcast.mock.calls.find(
        c => c.arguments[0]?.type === 'session_activity',
      )
      assert.equal(activityCall, undefined, 'stopped must not trigger session_activity')
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
    // CLI mode is always Claude — provider field should be present (#2993)
    assert.ok('provider' in modelsMsg, 'expected provider field in available_models (#2993)')
    assert.equal(modelsMsg.provider, 'claude-cli')
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

  // #5731: legacy CLI path must also surface a tunnel-stop failure (global
  // broadcast) instead of silently claiming a clean stop.
  it('broadcasts a DEV_PREVIEW_STOP_FAILED session_error for a legacy stop failure', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.devPreview.emit('dev_preview_stop_failed', { sessionId: '__legacy__', port: 3000, error: 'kill failed' })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const errMsg = calls.find(m => m.type === 'session_error' && m.code === 'DEV_PREVIEW_STOP_FAILED')
    assert.ok(errMsg, 'expected a DEV_PREVIEW_STOP_FAILED session_error broadcast')
    assert.equal(errMsg.recoverable, true)
    assert.match(errMsg.message, /port 3000/)
    assert.match(errMsg.message, /may still be exposed/)
  })

  it('does not broadcast a stop failure for a non-legacy sessionId in cli mode', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.devPreview.emit('dev_preview_stop_failed', { sessionId: 'sess-x', port: 3000, error: 'x' })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    assert.equal(calls.find(m => m.type === 'session_error'), undefined)
  })

  // #4756: legacy-cli mode must also forward the `stopped` event so the
  // single-CLI confirmation reaches connected clients. The legacy path
  // uses `broadcast` (no per-session routing) since there's only one CLI.
  it('forwards stopped event as session_stopped broadcast (#4756)', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('stopped', { code: 0 })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const stoppedMsg = calls.find(m => m.type === 'session_stopped')
    assert.ok(stoppedMsg, 'expected session_stopped broadcast from legacy-cli')
    assert.equal(stoppedMsg.code, 0)
    // Legacy-cli path: ctx.sessionId is null → normalizer omits sessionId
    assert.ok(!('sessionId' in stoppedMsg), 'legacy-cli session_stopped should omit sessionId')
  })

  // #3240: skill_changed must reach legacy single-CLI users so the trust
  // mismatch UX (#3205) is consistent regardless of session mode. The
  // normaliser fills in `sessionId: null` from the legacy-cli context.
  it('forwards a skill_changed event through the normalizer with null sessionId', () => {
    const ctx = makeCliCtx()
    setupForwarding(ctx)

    ctx.cliSession.emit('skill_changed', {
      name: 'coding-style',
      source: '/abs/path/to/coding-style.md',
      oldHash: 'a'.repeat(64),
      newHash: 'b'.repeat(64),
      blocked: false,
      mode: 'warn',
    })

    const calls = ctx.broadcast.mock.calls.map(c => c.arguments[0])
    const skillMsg = calls.find(m => m.type === 'skill_changed')
    assert.ok(skillMsg, 'expected skill_changed broadcast')
    assert.equal(skillMsg.skillName, 'coding-style')
    assert.equal(skillMsg.sessionId, null)
    assert.equal(skillMsg.oldHashPrefix, 'a'.repeat(8))
    assert.equal(skillMsg.newHashPrefix, 'b'.repeat(8))
    assert.equal(skillMsg.mode, 'warn')
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

  it('refresh_context side-effect: logs a warning and never rejects when getSessionContext rejects (#5383)', async () => {
    const sm = new EventEmitter()
    sm.getSession = mock.fn(() => null)
    sm.listSessions = mock.fn(() => [])
    sm.getSessionContext = mock.fn(() => Promise.reject(new Error('ctx boom')))
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

    const warnings = []
    const logSpy = (entry) => {
      if (entry.level === 'warn' && entry.component === 'ws-forwarding') warnings.push(entry.message)
    }
    // Pin the log level so the non-critical warn isn't suppressed if another
    // test left the level at 'error' (#5386 review).
    const priorLevel = getLogLevel()
    setLogLevel('warn')
    // Explicitly prove the rejection never escapes as an unhandledRejection.
    const rejections = []
    const onUnhandled = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onUnhandled)
    addLogListener(logSpy)
    try {
      // A `result` event in multi-session mode emits a refresh_context side
      // effect, which calls getSessionContext — here it rejects. The rejection
      // must be swallowed (logged) and never propagate to crash the daemon.
      sm.emit('session_event', {
        sessionId: 'sess-1',
        event: 'result',
        data: { cost: 0, duration: 1, usage: {}, sessionId: 'sess-1' },
      })
      // Let the rejected getSessionContext().catch() settle.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    } finally {
      removeLogListener(logSpy)
      process.removeListener('unhandledRejection', onUnhandled)
      setLogLevel(priorLevel)
    }

    assert.deepEqual(rejections, [], 'the rejection must be swallowed — no unhandledRejection')
    assert.equal(sm.getSessionContext.mock.calls.length, 1, 'getSessionContext was attempted')
    assert.ok(
      warnings.some((m) => /Failed to refresh session context for sess-1/.test(m)),
      `expected the refresh-context warning, got: ${JSON.stringify(warnings)}`,
    )
    // The rejection must not produce a session_context broadcast.
    const broadcasts = ctx.broadcastToSession.mock.calls.map((c) => c.arguments[1]).filter(Boolean)
    assert.ok(!broadcasts.some((m) => m && m.type === 'session_context'), 'no session_context broadcast on rejection')
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

// #5313 (WP-1.3): the forwarding listeners run synchronously inside the
// SessionManager / CliSession EventEmitter's emit(). An uncaught throw there
// unwinds emit() and can crash the whole daemon — taking down every session —
// over one bad event. Both listeners now wrap their body in try/catch + log.
describe('forwarding listener throw containment (#5313)', () => {
  let currentListener = null
  let priorLogLevel = null
  afterEach(() => {
    if (currentListener) {
      removeLogListener(currentListener)
      currentListener = null
    }
    if (priorLogLevel != null) {
      setLogLevel(priorLogLevel)
      priorLogLevel = null
    }
  })

  it('multi-session session_event listener swallows a throwing broadcast (does not unwind emit)', () => {
    const ctx = makeCtx({
      // stream_start broadcasts session_activity synchronously at the top of
      // the listener — make that broadcast throw.
      broadcast: mock.fn(() => { throw new Error('boom: broadcast failed') }),
    })
    setupForwarding(ctx)

    // emit() must NOT throw — the listener contains the fault.
    assert.doesNotThrow(() => {
      ctx.sessionManager.emit('session_event', {
        sessionId: 'sess-throw-1',
        event: 'stream_start',
        data: { messageId: 'm1' },
      })
    }, 'a throwing broadcast must not unwind the SessionManager emit()')
  })

  it('multi-session session_event listener logs the contained error with the session id', () => {
    priorLogLevel = getLogLevel()
    setLogLevel('debug')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCtx({
      broadcast: mock.fn(() => { throw new Error('boom') }),
    })
    setupForwarding(ctx)
    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-throw-2',
      event: 'stream_start',
      data: { messageId: 'm1' },
    })

    const errLog = entries.find((e) =>
      e.level === 'error' && e.message.includes('sess-throw-2') && e.message.includes('session_event forwarding threw'))
    assert.ok(errLog, 'expected an error log naming the session and the containment site')
  })

  it('a sibling one-liner forwarder (session_updated) is contained via safeForward (#5313 review)', () => {
    // The small sibling listeners (session_updated/restore_failed/dev_preview*/
    // session_destroyed + the legacy-cli siblings) share the same crash shape as
    // the two big listeners and are wrapped via the safeForward() helper.
    priorLogLevel = getLogLevel()
    setLogLevel('debug')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCtx({ broadcast: mock.fn(() => { throw new Error('boom: session_updated broadcast') }) })
    setupForwarding(ctx)

    assert.doesNotThrow(() => {
      ctx.sessionManager.emit('session_updated', { sessionId: 's-upd', name: 'Renamed' })
    }, 'a throwing session_updated broadcast must not unwind the SessionManager emit()')

    const errLog = entries.find((e) =>
      e.level === 'error' && e.message.includes('session_updated') && e.message.includes('forwarding listener'))
    assert.ok(errLog, 'safeForward logs the contained sibling-listener error with its label')
  })

  it('multi-session forwarding stays functional after a throwing event — a later good event still routes', () => {
    let shouldThrow = true
    const ctx = makeCtx({
      broadcast: mock.fn(() => { if (shouldThrow) throw new Error('boom') }),
    })
    setupForwarding(ctx)

    // First event throws inside the listener (contained).
    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-throw-3',
      event: 'stream_start',
      data: { messageId: 'm1' },
    })
    // A subsequent good event must still route normally.
    shouldThrow = false
    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-throw-3',
      event: 'result',
      data: { cost: 0.01 },
    })
    const activity = ctx.broadcast.mock.calls
      .map((c) => c.arguments[0])
      .find((m) => m.type === 'session_activity' && m.isBusy === false)
    assert.ok(activity, 'forwarding still delivers after a prior contained throw')
  })

  it('legacy-cli forwarding listener swallows a throwing broadcast (does not unwind emit)', () => {
    const ctx = makeCliCtx({
      broadcast: mock.fn(() => { throw new Error('boom: broadcast failed') }),
    })
    setupForwarding(ctx)

    assert.doesNotThrow(() => {
      ctx.cliSession.emit('message', {
        type: 'assistant',
        content: 'Hello',
        tool: null,
        options: null,
        timestamp: 1000,
      })
    }, 'a throwing broadcast must not unwind the CliSession emit()')
  })

  it('legacy-cli forwarding listener logs the contained error with the event name', () => {
    priorLogLevel = getLogLevel()
    setLogLevel('debug')
    const entries = []
    currentListener = (e) => entries.push(e)
    addLogListener(currentListener)

    const ctx = makeCliCtx({
      broadcast: mock.fn(() => { throw new Error('boom') }),
    })
    setupForwarding(ctx)
    ctx.cliSession.emit('message', {
      type: 'assistant',
      content: 'Hi',
      tool: null,
      options: null,
      timestamp: 1,
    })

    const errLog = entries.find((e) =>
      e.level === 'error' && e.message.includes('legacy-cli forwarding threw') && e.message.includes('event=message'))
    assert.ok(errLog, 'expected an error log naming the event and the containment site')
  })
})

describe('terminal_output forwarding (#5835)', () => {
  it('broadcasts terminal_output ONLY to clients opted into the session terminal', () => {
    const ctx = makeCtx()
    setupForwarding(ctx)

    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'terminal_output',
      data: { data: '\x1b[31mhi\x1b[0m' },
    })

    assert.equal(ctx.broadcastToSession.mock.callCount(), 1)
    const [sid, msg, filter] = ctx.broadcastToSession.mock.calls[0].arguments
    assert.equal(sid, 'sess-1')
    assert.equal(msg.type, 'terminal_output')
    assert.equal(msg.sessionId, 'sess-1')
    assert.equal(msg.data, '\x1b[31mhi\x1b[0m')
    // The filter admits only a client that is BOTH a viewer of the session AND
    // opted into its terminal — opt-in alone must not bypass session scoping.
    assert.equal(typeof filter, 'function')
    assert.equal(filter({ terminalSessionIds: new Set(['sess-1']), subscribedSessionIds: new Set(['sess-1']) }), true)
    assert.equal(filter({ terminalSessionIds: new Set(['sess-1']), activeSessionId: 'sess-1' }), true) // active counts as viewing
    assert.equal(filter({ terminalSessionIds: new Set(['sess-1']) }), false) // opted in but NOT subscribed → excluded
    assert.equal(filter({ terminalSessionIds: new Set(['other']), subscribedSessionIds: new Set(['sess-1']) }), false) // opted into a different session
    assert.equal(filter({ subscribedSessionIds: new Set(['sess-1']) }), false) // chat-only subscriber, not opted in
    assert.equal(filter({}), false)
  })

  it('coerces a non-string/absent data payload to an empty string', () => {
    const ctx = makeCtx()
    setupForwarding(ctx)
    ctx.sessionManager.emit('session_event', { sessionId: 'sess-1', event: 'terminal_output', data: {} })
    const [, msg] = ctx.broadcastToSession.mock.calls[0].arguments
    assert.equal(msg.data, '')
  })

  it('does not record terminal_output to history or touch activity', () => {
    const ctx = makeCtx()
    // session_event for terminal_output must not go through the normalizer path
    // (no history write). It returns early — only broadcastToSession fires.
    setupForwarding(ctx)
    ctx.sessionManager.emit('session_event', { sessionId: 'sess-1', event: 'terminal_output', data: { data: 'x' } })
    assert.equal(ctx.broadcast.mock.callCount(), 0) // not a global broadcast (no session_activity)
  })
})
