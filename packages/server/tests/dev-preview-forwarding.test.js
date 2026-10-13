import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { DevPreviewManager } from '../src/dev-preview.js'

/**
 * Dev previews open only on an explicit request. Session output, such as a
 * tool_result that mentions a localhost port, never reaches the preview manager
 * and never produces a dev_preview message.
 *
 * Both forwarding paths are covered: the multi-session path
 * (session-manager `session_event`) and the legacy single-CLI path.
 */

// Ordinary tool output remains display data.
const PORT_MENTIONS = [
  ['a source fixture', 'assert.equal(url, "http://localhost:3100")'],
  ['an RPM measurement', 'fan running at 3000 RPM'],
  ['a bare localhost URL', 'ready - open http://localhost:5173 in your browser'],
  ['a Vite-style Local line', '  VITE v5.0.0  ready in 312 ms\n\n  Local:   http://localhost:3000/'],
  ['a "listening on port" line', 'Express server listening on port 9200'],
  ['a "started on" line with a date', 'build started on 2026-09-26'],
]

for (const mode of ['multi', 'legacy']) {
  it(`forwards the original request lifecycle and ended reason in ${mode} mode`, () => {
    const { ctx, devPreview } = mode === 'multi' ? makeMultiSessionCtx() : makeLegacyCtx()
    const sessionId = mode === 'multi' ? 'sess-1' : '__legacy__'
    const message = { type: 'dev_preview_status', sessionId, requestId: 'r1', port: 3100, state: 'closed', reason: 'HTTP service connection ended' }
    devPreview.emit('dev_preview_status', message)
    const call = mode === 'multi' ? ctx.broadcastToSession.mock.calls.at(-1).arguments : ctx.broadcast.mock.calls.at(-1).arguments
    const frame = mode === 'multi' ? call[1] : call[0]
    assert.equal(frame.requestId, 'r1')
    assert.equal(frame.state, 'closed')
    assert.equal(frame.reason, message.reason)
    if (mode === 'multi') assert.equal(call[0], sessionId)
    else assert.equal(frame.sessionId, sessionId)
  })
}

function makeDevPreview() {
  const devPreview = new DevPreviewManager()
  devPreview._createPreviewTunnel = mock.fn()
  mock.method(devPreview, 'closeSession')
  return new Proxy(devPreview, {
    get(target, key, receiver) {
      if (key === 'handleToolResult') return (...args) => { target._createPreviewTunnel(...args); throw new Error('Session output reached preview inference') }
      return Reflect.get(target, key, receiver)
    },
  })
}

function makeMultiSessionCtx() {
  const sm = new EventEmitter()
  sm.getSession = mock.fn(() => null)
  sm.listSessions = mock.fn(() => [])
  sm.getSessionContext = mock.fn(() => Promise.resolve(null))
  const devPreview = makeDevPreview()
  const ctx = {
    normalizer: new EventNormalizer(),
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
  return { ctx, sm, devPreview }
}

function makeLegacyCtx() {
  const cliSession = new EventEmitter()
  const devPreview = makeDevPreview()
  const ctx = {
    normalizer: new EventNormalizer(),
    sessionManager: null,
    cliSession,
    devPreview,
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
  }
  setupForwarding(ctx)
  return { ctx, cliSession, devPreview }
}

const isPreviewMessage = (msg) => typeof msg?.type === 'string' && msg.type.startsWith('dev_preview')

function previewMessages(fn) {
  return fn.mock.calls
    .map((c) => (typeof c.arguments[0] === 'string' ? c.arguments[1] : c.arguments[0]))
    .filter(isPreviewMessage)
}

describe('dev previews open only on an explicit request', () => {
  describe('multi-session path', () => {
    for (const [label, result] of PORT_MENTIONS) {
      it(`tool output that mentions ${label} does not start a dev preview`, () => {
        const { ctx, sm, devPreview } = makeMultiSessionCtx()

        sm.emit('session_event', {
          sessionId: 'sess-1',
          event: 'tool_result',
          data: { toolUseId: 'tool-1', result },
        })

        // The event was processed: the tool result itself is still forwarded.
        const forwarded = ctx.broadcastToSession.mock.calls.find(
          (c) => c.arguments[1]?.type === 'tool_result',
        )
        assert.ok(forwarded, 'the tool_result is still forwarded to the session')
        assert.equal(forwarded.arguments[1].result, result)

        assert.equal(devPreview._createPreviewTunnel.mock.callCount(), 0,
          'tool output must not be handed to the preview manager')
        assert.deepEqual(previewMessages(ctx.broadcastToSession), [])
        assert.deepEqual(previewMessages(ctx.broadcast), [])
      })
    }

    it('several tool results in a row never start a dev preview', () => {
      const { ctx, sm, devPreview } = makeMultiSessionCtx()

      PORT_MENTIONS.forEach(([, result], i) => {
        sm.emit('session_event', {
          sessionId: 'sess-1',
          event: 'tool_result',
          data: { toolUseId: `tool-${i}`, result },
        })
      })

      assert.equal(devPreview._createPreviewTunnel.mock.callCount(), 0)
      assert.deepEqual(previewMessages(ctx.broadcastToSession), [])
    })

    it('forwards a dev_preview_started event from the manager to its session', () => {
      const { ctx, devPreview } = makeMultiSessionCtx()

      devPreview.emit('dev_preview_started', {
        sessionId: 'sess-1',
        port: 5173,
        url: 'https://preview.example.test',
      })

      const call = ctx.broadcastToSession.mock.calls.find(
        (c) => c.arguments[1]?.type === 'dev_preview',
      )
      assert.ok(call, 'dev_preview_started is forwarded as a dev_preview message')
      assert.equal(call.arguments[0], 'sess-1')
      assert.equal(call.arguments[1].port, 5173)
      assert.equal(call.arguments[1].url, 'https://preview.example.test')
    })

    it('closes a session\'s previews when the session is destroyed', () => {
      const { sm, devPreview } = makeMultiSessionCtx()

      sm.emit('session_destroyed', { sessionId: 'sess-1' })

      assert.equal(devPreview.closeSession.mock.callCount(), 1)
      assert.equal(devPreview.closeSession.mock.calls[0].arguments[0], 'sess-1')
    })
  })

  describe('legacy single-CLI path', () => {
    for (const [label, result] of PORT_MENTIONS) {
      it(`tool output that mentions ${label} does not start a dev preview`, () => {
        const { ctx, cliSession, devPreview } = makeLegacyCtx()

        cliSession.emit('tool_result', { toolUseId: 'tool-1', result })

        // The event was processed: the tool result itself is still forwarded.
        const forwarded = ctx.broadcast.mock.calls.find(
          (c) => c.arguments[0]?.type === 'tool_result',
        )
        assert.ok(forwarded, 'the tool_result is still forwarded to clients')
        assert.equal(forwarded.arguments[0].result, result)

        assert.equal(devPreview._createPreviewTunnel.mock.callCount(), 0,
          'tool output must not be handed to the preview manager')
        assert.deepEqual(previewMessages(ctx.broadcast), [])
      })
    }

    it('forwards a dev_preview_started event from the manager to clients', () => {
      const { ctx, devPreview } = makeLegacyCtx()

      devPreview.emit('dev_preview_started', {
        sessionId: '__legacy__',
        port: 3000,
        url: 'https://preview.example.test',
      })

      const call = ctx.broadcast.mock.calls.find((c) => c.arguments[0]?.type === 'dev_preview')
      assert.ok(call, 'dev_preview_started is forwarded as a dev_preview message')
      assert.equal(call.arguments[0].port, 3000)
      assert.equal(call.arguments[0].url, 'https://preview.example.test')
    })
  })
})
