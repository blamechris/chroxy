/**
 * Auto-evaluator decision-contract tests (#3189).
 *
 * Pins the auto-flow contract at the unit boundary: given a draft and a
 * session's `promptEvaluator` toggle, what should an auto-flow consumer
 * do? The consumer is the WS `user_input` handler (#3186) — handler-level
 * integration tests live in `tests/handlers/input-handlers.test.js`. This
 * file complements those by pinning the prompt-evaluator-side contract
 * the handler relies on, in isolation from WS plumbing.
 *
 * Why a separate file from `prompt-evaluator.test.js`: that file covers
 * the manual `evaluate_draft` request/response flow exhaustively. This
 * file pins the *auto*-flow decisions — when to skip, how each verdict
 * shape is exposed to a consumer that wants to route on it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateDraft,
  shouldSkipEvaluator,
  _resetSkipPatternCache,
} from '../src/prompt-evaluator.js'

function makeStubClient(responseJson) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(responseJson) }],
      }),
    },
  }
}

function makeThrowingClient(err) {
  return {
    messages: {
      create: async () => { throw err },
    },
  }
}

describe('auto-evaluator decision contract (#3189)', () => {
  describe('skip heuristic gates the round-trip', () => {
    it('short ack short-circuits — consumer must NOT call evaluateDraft', () => {
      assert.equal(shouldSkipEvaluator('y'), true)
      assert.equal(shouldSkipEvaluator('yes'), true)
      assert.equal(shouldSkipEvaluator('go ahead'), true)
      assert.equal(shouldSkipEvaluator('looks good'), true)
    })

    it('continuation pattern short-circuits regardless of toggle state', () => {
      // The skip heuristic is computed without knowing the toggle —
      // the consumer is expected to gate on toggle first, then skip
      // heuristic, then call evaluateDraft.
      assert.equal(shouldSkipEvaluator('ok'), true)
      assert.equal(shouldSkipEvaluator('do it'), true)
      assert.equal(shouldSkipEvaluator('continue'), true)
    })

    it('substantive message proceeds — consumer must call evaluateDraft', () => {
      const draft = 'Add a unit test for the new permission rule engine that covers stale entries.'
      assert.equal(shouldSkipEvaluator(draft), false)
    })

    it('20-char threshold is the minimum — consumer must call evaluateDraft at length 20+', () => {
      assert.equal(shouldSkipEvaluator('a'.repeat(19)), true)
      assert.equal(shouldSkipEvaluator('a'.repeat(20)), false)
    })

    it('custom skip pattern OR-d with the default — pattern source is per-session config', () => {
      _resetSkipPatternCache()
      try {
        // Draft must be >= 20 chars and NOT match the default pattern, so
        // the only way the test passes is via the session-supplied custom
        // pattern. Without this, the < 20 length gate would short-circuit
        // before the custom-pattern branch ever runs (Copilot review on
        // PR #3650 caught the original test passing for the wrong reason).
        const cfg = { promptEvaluatorSkipPattern: '^acknowledged for the team$' }
        assert.equal(shouldSkipEvaluator('acknowledged for the team', cfg), true)
        // Default rules still apply when the custom pattern doesn't match —
        // the substantive message still goes to evaluateDraft.
        assert.equal(shouldSkipEvaluator('this is a substantive draft message', cfg), false)
      } finally {
        _resetSkipPatternCache()
      }
    })
  })

  describe('verdict shapes the auto-flow consumer routes on', () => {
    it('forward verdict — consumer sends draft as-is, no broadcast', async () => {
      const result = await evaluateDraft({
        draft: 'Refactor the input handler to use the new context shape.',
        client: makeStubClient({
          verdict: 'forward',
          rewritten: null,
          clarification: null,
          reasoning: 'Clear and specific.',
        }),
      })
      assert.equal(result.verdict, 'forward')
      assert.equal(result.rewritten, null)
      assert.equal(result.clarification, null)
      assert.equal(typeof result.reasoning, 'string')
    })

    it('rewrite verdict — consumer broadcasts evaluator_rewrite + sends rewritten text', async () => {
      const result = await evaluateDraft({
        draft: 'fix that thing',
        client: makeStubClient({
          verdict: 'rewrite',
          rewritten: 'Please fix the failing assertion in foo.test.js:42.',
          clarification: null,
          reasoning: 'Original was vague.',
        }),
      })
      assert.equal(result.verdict, 'rewrite')
      assert.equal(typeof result.rewritten, 'string')
      assert.ok(result.rewritten.length > 0)
      assert.equal(result.clarification, null)
    })

    it('clarify verdict — consumer broadcasts evaluator_clarify, holds the message', async () => {
      const result = await evaluateDraft({
        draft: 'remove it from the function',
        client: makeStubClient({
          verdict: 'clarify',
          rewritten: null,
          clarification: 'Which file are you referring to?',
          reasoning: 'Ambiguous "it".',
        }),
      })
      assert.equal(result.verdict, 'clarify')
      assert.equal(result.rewritten, null)
      assert.equal(typeof result.clarification, 'string')
      assert.ok(result.clarification.length > 0)
    })
  })

  describe('fail-open contract — error codes consumer must recognize', () => {
    it('EVALUATOR_API_ERROR is thrown for upstream failures', async () => {
      await assert.rejects(
        () => evaluateDraft({
          draft: 'Substantive enough draft message body.',
          client: makeThrowingClient(Object.assign(new Error('rate limit'), { status: 429 })),
        }),
        (err) => err.code === 'EVALUATOR_API_ERROR' && err.status === 429,
      )
    })

    it('EVALUATOR_NO_API_KEY is thrown when no key and no client injected', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        await assert.rejects(
          () => evaluateDraft({ draft: 'Substantive enough draft message body.' }),
          (err) => err.code === 'EVALUATOR_NO_API_KEY',
        )
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })

    it('EVALUATOR_BAD_RESPONSE is thrown when the model returns a non-conformant payload', async () => {
      // The auto-flow consumer must treat BAD_RESPONSE the same way it
      // treats API_ERROR — fail-open and forward the original draft.
      // Pinning the error code here so a future change can't silently
      // re-route BAD_RESPONSE to a different fail-mode.
      await assert.rejects(
        () => evaluateDraft({
          draft: 'Substantive enough draft message body.',
          client: makeStubClient({ verdict: 'unknown_verdict', rewritten: null, clarification: null, reasoning: '' }),
        }),
        (err) => err.code === 'EVALUATOR_BAD_RESPONSE',
      )
    })
  })

  describe('decision matrix integration — skip first, then evaluate', () => {
    it('toggle ON + short message → skip wins, evaluator never called', async () => {
      // The contract: consumer checks shouldSkipEvaluator BEFORE
      // calling evaluateDraft, so a short ack like "yes" never burns
      // the round-trip.
      let evaluatorCalled = false
      const client = {
        messages: {
          create: async () => {
            evaluatorCalled = true
            return { content: [{ type: 'text', text: '{}' }] }
          },
        },
      }
      const draft = 'yes'
      if (!shouldSkipEvaluator(draft)) {
        await evaluateDraft({ draft, client })
      }
      assert.equal(evaluatorCalled, false, 'short message must NOT trigger evaluateDraft')
    })

    it('toggle ON + substantive message → evaluator called, verdict drives routing', async () => {
      let evaluatorCalled = false
      const client = {
        messages: {
          create: async () => {
            evaluatorCalled = true
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  verdict: 'forward',
                  rewritten: null,
                  clarification: null,
                  reasoning: 'Clear.',
                }),
              }],
            }
          },
        },
      }
      const draft = 'Refactor the WebSocket handler to use the new ctx shape end-to-end.'
      if (!shouldSkipEvaluator(draft)) {
        await evaluateDraft({ draft, client })
      }
      assert.equal(evaluatorCalled, true, 'substantive message MUST trigger evaluateDraft')
    })
  })
})
