import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatorHandlers } from '../../src/handlers/evaluator-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

/**
 * The handler is a thin shim: validate input, resolve cwd from active session,
 * call evaluateDraft, send back the result. The handler exposes a
 * `ctx.evaluateDraft` seam so tests can inject a stub instead of mocking the
 * module — keeps these tests as plain unit tests.
 */

function makeCtx({ sessions = new Map(), evaluator } = {}) {
  const sent = []
  return {
    send: createSpy((_ws, msg) => { sent.push(msg) }),
    sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
    evaluateDraft: evaluator,
    _sent: sent,
  }
}

function makeWs() {
  return { readyState: 1, send: createSpy(() => {}) }
}

function makeClient(overrides = {}) {
  return { id: 'c1', activeSessionId: null, ...overrides }
}

describe('evaluator-handlers', () => {
  describe('evaluate_draft input validation', () => {
    it('returns INVALID_DRAFT error when draft is missing', async () => {
      const ctx = makeCtx()
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { type: 'evaluate_draft' }, ctx)
      assert.equal(ctx._sent.length, 1)
      assert.equal(ctx._sent[0].type, 'evaluate_draft_result')
      assert.equal(ctx._sent[0].error.code, 'INVALID_DRAFT')
    })

    it('returns INVALID_DRAFT when draft is whitespace', async () => {
      const ctx = makeCtx()
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: '   ' }, ctx)
      assert.equal(ctx._sent[0].error.code, 'INVALID_DRAFT')
    })

    it('returns DRAFT_TOO_LARGE for drafts over 50KB', async () => {
      const ctx = makeCtx()
      const big = 'x'.repeat(50 * 1024 + 1)
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: big }, ctx)
      assert.equal(ctx._sent[0].error.code, 'DRAFT_TOO_LARGE')
    })

    it('echoes requestId when present', async () => {
      const ctx = makeCtx()
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), {
        draft: '',
        requestId: 'req-123',
      }, ctx)
      assert.equal(ctx._sent[0].requestId, 'req-123')
    })

    it('sets requestId to null when client omitted it', async () => {
      const ctx = makeCtx()
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: '' }, ctx)
      assert.equal(ctx._sent[0].requestId, null)
    })
  })

  describe('verdict routing', () => {
    it('returns the forward verdict from the evaluator unchanged', async () => {
      const evaluator = createSpy(async () => ({
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'Clear enough.',
      }))
      const ctx = makeCtx({ evaluator })
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: 'fix bug' }, ctx)

      assert.equal(evaluator.callCount, 1)
      const out = ctx._sent[0]
      assert.equal(out.type, 'evaluate_draft_result')
      assert.equal(out.verdict, 'forward')
      assert.equal(out.reasoning, 'Clear enough.')
      assert.equal(out.error, undefined)
    })

    it('returns rewritten text on rewrite verdict', async () => {
      const evaluator = async () => ({
        verdict: 'rewrite',
        rewritten: 'Profile foo() and propose 2 specific optimizations.',
        clarification: null,
        reasoning: 'Original was vague.',
      })
      const ctx = makeCtx({ evaluator })
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: 'make it faster' }, ctx)

      const out = ctx._sent[0]
      assert.equal(out.verdict, 'rewrite')
      assert.equal(out.rewritten, 'Profile foo() and propose 2 specific optimizations.')
    })

    it('returns clarification question on clarify verdict', async () => {
      const evaluator = async () => ({
        verdict: 'clarify',
        rewritten: null,
        clarification: 'Which file?',
        reasoning: 'Ambiguous reference.',
      })
      const ctx = makeCtx({ evaluator })
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: 'remove it' }, ctx)

      const out = ctx._sent[0]
      assert.equal(out.verdict, 'clarify')
      assert.equal(out.clarification, 'Which file?')
    })
  })

  describe('session cwd plumbing', () => {
    it('passes the active session cwd to the evaluator', async () => {
      const session = createMockSession()
      session.cwd = '/Users/me/project'
      const sessions = new Map([['s1', { session, cwd: '/Users/me/project' }]])

      let receivedCwd = null
      const evaluator = async ({ cwd }) => {
        receivedCwd = cwd
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }
      }
      const ctx = makeCtx({ sessions, evaluator })

      await evaluatorHandlers.evaluate_draft(
        makeWs(),
        makeClient({ activeSessionId: 's1' }),
        { draft: 'fix bug' },
        ctx,
      )
      assert.equal(receivedCwd, '/Users/me/project')
    })

    it('passes null cwd when no session is bound', async () => {
      let receivedCwd = 'not-set'
      const evaluator = async ({ cwd }) => {
        receivedCwd = cwd
        return { verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }
      }
      const ctx = makeCtx({ evaluator })

      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: 'fix' }, ctx)
      assert.equal(receivedCwd, null)
    })
  })

  describe('error propagation', () => {
    it('surfaces the EVALUATOR_NO_API_KEY code through the error envelope', async () => {
      const err = new Error('ANTHROPIC_API_KEY is not set')
      err.code = 'EVALUATOR_NO_API_KEY'
      const evaluator = async () => { throw err }
      const ctx = makeCtx({ evaluator })

      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: 'x' }, ctx)
      const out = ctx._sent[0]
      assert.equal(out.type, 'evaluate_draft_result')
      assert.equal(out.error.code, 'EVALUATOR_NO_API_KEY')
      assert.match(out.error.message, /ANTHROPIC_API_KEY/)
      assert.equal(out.verdict, undefined)
    })

    it('uses EVALUATOR_ERROR as the fallback code when err.code is missing', async () => {
      const evaluator = async () => { throw new Error('something broke') }
      const ctx = makeCtx({ evaluator })

      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), { draft: 'x' }, ctx)
      assert.equal(ctx._sent[0].error.code, 'EVALUATOR_ERROR')
    })

    it('echoes requestId in error responses too', async () => {
      const evaluator = async () => { throw new Error('nope') }
      const ctx = makeCtx({ evaluator })
      await evaluatorHandlers.evaluate_draft(makeWs(), makeClient(), {
        draft: 'x',
        requestId: 'req-err',
      }, ctx)
      assert.equal(ctx._sent[0].requestId, 'req-err')
    })
  })
})
