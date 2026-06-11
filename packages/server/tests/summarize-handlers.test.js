import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeHandlers } from '../src/handlers/summarize-handlers.js'
import { handleSessionMessage, registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager, nsCtx } from './test-helpers.js'
import { ClientMessageSchema, ServerSummarizeSessionResultSchema } from '@chroxy/protocol'

/**
 * #5547 — tests for the summarize_session WS handler: request/result
 * correlation, the per-session in-flight guard, authority rejection, history
 * sourcing, and the no-leak failure path. The model call is injected via
 * ctx.summarizeSession so no provider is needed.
 */

const HISTORY = [
  { type: 'user_input', content: 'build the widget' },
  { type: 'response', content: 'built it' },
]

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { manager, sessionsMap } = createMockSessionManager([
    { id: 'sess-1', name: 'Widget work', cwd: '/home/user/proj' },
  ])
  // Give the session a model so the handler's default-model resolution has
  // something to thread through.
  sessionsMap.get('sess-1').session.model = 'claude-session-model'
  manager.getHistory = (id) => (id === 'sess-1' ? HISTORY : [])

  return nsCtx({
    send: sendSpy,
    sessionManager: manager,
    config: {},
    summarizeSession: createSpy(async () => ({ summary: 'CONTINUATION BRIEF', truncated: false })),
    ...overrides,
    _send: sendSpy,
  })
}

function lastSent(ctx) {
  const calls = ctx.transport.send.calls
  return calls.length ? calls[calls.length - 1][1] : null
}

describe('summarize_session handler', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeCtx()
    client = { id: 'client-A' }
    ws = {}
  })

  it('is registered in the handler registry', () => {
    assert.ok(registeredMessageTypes.includes('summarize_session'))
    assert.equal(typeof summarizeHandlers.summarize_session, 'function')
  })

  it('summarize_session is a valid ClientMessageSchema type', () => {
    const parsed = ClientMessageSchema.safeParse({
      type: 'summarize_session', sessionId: 'sess-1', requestId: 'r1',
    })
    assert.ok(parsed.success, parsed.error?.message)
  })

  it('replies with summarize_session_result echoing sessionId + requestId', async () => {
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: 'sess-1', requestId: 'req-42',
    }, ctx)

    const reply = lastSent(ctx)
    assert.equal(reply.type, 'summarize_session_result')
    assert.equal(reply.sessionId, 'sess-1')
    assert.equal(reply.requestId, 'req-42')
    assert.equal(reply.summary, 'CONTINUATION BRIEF')
    assert.equal(reply.truncated, false)
    // Schema-conformant.
    assert.ok(ServerSummarizeSessionResultSchema.safeParse(reply).success)
  })

  it('threads the session model + cwd + name into the summarizer', async () => {
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: 'sess-1',
    }, ctx)
    const arg = ctx.summarizeSession.calls[0][0]
    assert.equal(arg.model, 'claude-session-model')
    assert.equal(arg.cwd, '/home/user/proj')
    assert.equal(arg.sessionName, 'Widget work')
    assert.deepEqual(arg.history, HISTORY)
  })

  it('prefers config.summarize.model over the session model', async () => {
    ctx = makeCtx({ config: { summarize: { model: 'claude-cheap' } } })
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: 'sess-1',
    }, ctx)
    assert.equal(ctx.summarizeSession.calls[0][0].model, 'claude-cheap')
  })

  it('rejects a missing sessionId with SUMMARIZE_FAILED', async () => {
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: '',
    }, ctx)
    const reply = lastSent(ctx)
    assert.equal(reply.code, 'SUMMARIZE_FAILED')
    assert.equal(reply.reason, 'invalid-session-id')
  })

  it('rejects an unknown session', async () => {
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: 'nope', requestId: 'r',
    }, ctx)
    const reply = lastSent(ctx)
    assert.equal(reply.code, 'SUMMARIZE_FAILED')
    assert.equal(reply.reason, 'unknown-session')
    assert.equal(reply.sessionId, 'nope')
    assert.equal(reply.requestId, 'r')
  })

  describe('authority', () => {
    it('allows a host-level (unbound) client', async () => {
      await summarizeHandlers.summarize_session(ws, { id: 'host' }, {
        type: 'summarize_session', sessionId: 'sess-1',
      }, ctx)
      assert.equal(lastSent(ctx).type, 'summarize_session_result')
    })

    it('allows a client bound to THIS session', async () => {
      await summarizeHandlers.summarize_session(ws, { id: 'b', boundSessionId: 'sess-1' }, {
        type: 'summarize_session', sessionId: 'sess-1',
      }, ctx)
      assert.equal(lastSent(ctx).type, 'summarize_session_result')
    })

    it('rejects a client bound to a DIFFERENT session', async () => {
      await summarizeHandlers.summarize_session(ws, { id: 'b', boundSessionId: 'other' }, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'r',
      }, ctx)
      const reply = lastSent(ctx)
      assert.equal(reply.code, 'SUMMARIZE_FAILED')
      assert.equal(reply.reason, 'forbidden')
      // Must NOT have called the (expensive) summarizer.
      assert.equal(ctx.summarizeSession.callCount, 0)
    })
  })

  describe('in-flight guard', () => {
    it('rejects a concurrent summarize for the same session', async () => {
      // A runner that blocks until we release it, so two requests overlap.
      let release
      const gate = new Promise((r) => { release = r })
      ctx = makeCtx({ summarizeSession: createSpy(async () => { await gate; return { summary: 'S', truncated: false } }) })

      const p1 = summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'a',
      }, ctx)
      // Second request arrives while the first is still in flight.
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'b',
      }, ctx)

      const blocked = lastSent(ctx)
      assert.equal(blocked.code, 'SUMMARIZE_FAILED')
      assert.equal(blocked.reason, 'summarize-in-progress')
      assert.equal(blocked.requestId, 'b')

      release()
      await p1
      // After the first settles, a fresh request is accepted again.
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'c',
      }, ctx)
      assert.equal(lastSent(ctx).type, 'summarize_session_result')
    })
  })

  describe('failure leak guard', () => {
    it('does not echo raw provider error text into the message', async () => {
      ctx = makeCtx({
        summarizeSession: createSpy(async () => {
          const err = new Error('API key sk-ant-LEAKED-1234 rejected at https://api.example/v1')
          throw err
        }),
      })
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'r',
      }, ctx)
      const reply = lastSent(ctx)
      assert.equal(reply.code, 'SUMMARIZE_FAILED')
      assert.ok(!/sk-ant-LEAKED/.test(reply.message), 'raw key fragment must not leak')
      assert.ok(!/api\.example/.test(reply.message), 'raw endpoint must not leak')
    })

    it('does not echo a raw getHistory error into the message', async () => {
      ctx = makeCtx()
      ctx.sessions.sessionManager.getHistory = () => {
        throw new Error('ENOENT: /home/secret/.chroxy/session-state.json missing')
      }
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'r',
      }, ctx)
      const reply = lastSent(ctx)
      assert.equal(reply.code, 'SUMMARIZE_FAILED')
      assert.equal(reply.reason, 'history-failed')
      assert.ok(!/ENOENT/.test(reply.message), 'raw error text must not leak')
      assert.ok(!/\.chroxy/.test(reply.message), 'internal path must not leak')
    })

    it('maps empty-history to a friendly message', async () => {
      ctx = makeCtx({
        summarizeSession: createSpy(async () => {
          const err = new Error('Session has no readable history to summarize')
          err.reason = 'empty-history'
          throw err
        }),
      })
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1',
      }, ctx)
      const reply = lastSent(ctx)
      assert.equal(reply.reason, 'empty-history')
      assert.match(reply.message, /no conversation to summarize/)
    })
  })

  it('routes via handleSessionMessage dispatch', async () => {
    await handleSessionMessage(ws, client, {
      type: 'summarize_session', sessionId: 'sess-1', requestId: 'dispatch',
    }, ctx)
    const reply = lastSent(ctx)
    assert.equal(reply.type, 'summarize_session_result')
    assert.equal(reply.requestId, 'dispatch')
  })
})
