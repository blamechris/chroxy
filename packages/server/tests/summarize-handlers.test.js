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

  it('passes a resolveExecutable that delegates to sessionManager.verifyOneShotExecutable (#8030)', async () => {
    ctx.sessions.sessionManager.verifyOneShotExecutable = createSpy(() => '/verified/claude')
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: 'sess-1',
    }, ctx)
    const arg = ctx.summarizeSession.calls[0][0]
    assert.equal(typeof arg.resolveExecutable, 'function')
    assert.equal(arg.resolveExecutable(), '/verified/claude')
    assert.equal(ctx.sessions.sessionManager.verifyOneShotExecutable.callCount, 1)
  })

  it('resolveExecutable fails closed when sessionManager has no verifyOneShotExecutable (#8030)', async () => {
    // createMockSessionManager doesn't implement verifyOneShotExecutable —
    // the handler must never fall back to an unverified spawn.
    assert.equal(typeof ctx.sessions.sessionManager.verifyOneShotExecutable, 'undefined')
    await summarizeHandlers.summarize_session(ws, client, {
      type: 'summarize_session', sessionId: 'sess-1',
    }, ctx)
    const arg = ctx.summarizeSession.calls[0][0]
    assert.throws(() => arg.resolveExecutable(), (err) => err.code === 'PROVIDER_BINARY_UNVERIFIED')
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

    it('maps a PROVIDER_BINARY_* error code (no err.reason) to binary-unverified with the fixed message (#8030)', async () => {
      ctx = makeCtx({
        summarizeSession: createSpy(async () => {
          const err = new Error('claude-sdk: "claude" at /opt/homebrew/bin/claude binary hash changed since it was pinned (pinned a4291b0c…, now deadbeef…)')
          err.code = 'PROVIDER_BINARY_PROVENANCE'
          throw err
        }),
      })
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'r',
      }, ctx)
      const reply = lastSent(ctx)
      assert.equal(reply.code, 'SUMMARIZE_FAILED')
      assert.equal(reply.reason, 'binary-unverified')
      assert.equal(reply.message, 'Could not summarize this session — the Claude binary did not pass verification (see the server log)')
      // Leak guard still holds for this family of errors too.
      assert.ok(!/a4291b0c/.test(reply.message), 'raw hash fragment must not leak')
    })

    it('maps a version-floor refusal to binary-unverified even though it carries its own err.reason (#8030 review)', async () => {
      ctx = makeCtx({
        summarizeSession: createSpy(async () => {
          // ProviderBinaryVersionError sets BOTH a PROVIDER_BINARY_* code and
          // reason 'too_old'; the code must win.
          const err = new Error('Claude SDK: "claude" at /opt/homebrew/bin/claude is older than the required 2.1.141 (found 2.1.100)')
          err.code = 'PROVIDER_BINARY_VERSION'
          err.reason = 'too_old'
          throw err
        }),
      })
      await summarizeHandlers.summarize_session(ws, client, {
        type: 'summarize_session', sessionId: 'sess-1', requestId: 'r',
      }, ctx)
      const reply = lastSent(ctx)
      assert.equal(reply.reason, 'binary-unverified')
      assert.equal(reply.message, 'Could not summarize this session — the Claude binary did not pass verification (see the server log)')
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
