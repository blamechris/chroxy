import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDraft, shouldSkipEvaluator } from '../src/prompt-evaluator.js'

/**
 * The evaluator wraps a single Anthropic API call and parses its JSON response.
 * Tests use a stub `client` that mimics the SDK's `messages.create` shape, so
 * we can drive each parse path without ever hitting the network.
 */

function makeStubClient(responseText, { onCall } = {}) {
  return {
    messages: {
      create: async (args) => {
        if (onCall) onCall(args)
        return { content: [{ type: 'text', text: responseText }] }
      },
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

describe('evaluateDraft', () => {
  describe('input validation', () => {
    it('throws when draft is missing', async () => {
      await assert.rejects(
        () => evaluateDraft({ client: makeStubClient('{}') }),
        /draft must be a non-empty string/,
      )
    })

    it('throws when draft is empty/whitespace', async () => {
      await assert.rejects(
        () => evaluateDraft({ draft: '   ', client: makeStubClient('{}') }),
        /draft must be a non-empty string/,
      )
    })

    it('throws EVALUATOR_NO_API_KEY when no key is set and no client injected', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        await assert.rejects(
          () => evaluateDraft({ draft: 'hello' }),
          (err) => err.code === 'EVALUATOR_NO_API_KEY',
        )
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })
  })

  describe('forward verdict', () => {
    it('returns the parsed forward verdict with reasoning', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'Looks clear.',
      }))
      const out = await evaluateDraft({ draft: 'fix the bug', client })
      assert.deepEqual(out, {
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'Looks clear.',
      })
    })

    it('treats empty rewritten/clarification fields as null on forward', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'forward',
        rewritten: '',
        clarification: '',
        reasoning: 'fine',
      }))
      const out = await evaluateDraft({ draft: 'go ahead', client })
      assert.equal(out.rewritten, null)
      assert.equal(out.clarification, null)
    })
  })

  describe('rewrite verdict', () => {
    it('returns the rewritten text trimmed', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'rewrite',
        rewritten: '  Profile processQueue() and propose 2 specific optimizations.  ',
        clarification: null,
        reasoning: 'Original was vague.',
      }))
      const out = await evaluateDraft({ draft: 'make it faster', client })
      assert.equal(out.verdict, 'rewrite')
      assert.equal(out.rewritten, 'Profile processQueue() and propose 2 specific optimizations.')
      assert.equal(out.clarification, null)
    })

    it('throws EVALUATOR_BAD_RESPONSE when rewrite verdict has no rewritten text', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'rewrite',
        rewritten: null,
        clarification: null,
        reasoning: 'oops',
      }))
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => err.code === 'EVALUATOR_BAD_RESPONSE',
      )
    })
  })

  describe('clarify verdict', () => {
    it('returns the clarification question', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'clarify',
        rewritten: null,
        clarification: 'Which auth middleware do you mean?',
        reasoning: 'Ambiguous reference.',
      }))
      const out = await evaluateDraft({ draft: 'remove the auth middleware', client })
      assert.equal(out.verdict, 'clarify')
      assert.equal(out.clarification, 'Which auth middleware do you mean?')
      assert.equal(out.rewritten, null)
    })

    it('throws EVALUATOR_BAD_RESPONSE when clarify verdict has no clarification', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'clarify',
        rewritten: null,
        clarification: '',
        reasoning: 'oops',
      }))
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => err.code === 'EVALUATOR_BAD_RESPONSE',
      )
    })
  })

  describe('response parsing edge cases', () => {
    it('strips ```json fences before parsing', async () => {
      const client = makeStubClient('```json\n{"verdict":"forward","rewritten":null,"clarification":null,"reasoning":"ok"}\n```')
      const out = await evaluateDraft({ draft: 'x', client })
      assert.equal(out.verdict, 'forward')
    })

    it('strips bare ``` fences too', async () => {
      const client = makeStubClient('```\n{"verdict":"forward","rewritten":null,"clarification":null,"reasoning":"ok"}\n```')
      const out = await evaluateDraft({ draft: 'x', client })
      assert.equal(out.verdict, 'forward')
    })

    it('throws EVALUATOR_BAD_RESPONSE for empty response', async () => {
      const client = makeStubClient('   ')
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => err.code === 'EVALUATOR_BAD_RESPONSE',
      )
    })

    it('throws EVALUATOR_BAD_RESPONSE for non-JSON response', async () => {
      const client = makeStubClient('I cannot do that, sorry.')
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => err.code === 'EVALUATOR_BAD_RESPONSE',
      )
    })

    it('throws EVALUATOR_BAD_RESPONSE for unknown verdict value', async () => {
      const client = makeStubClient(JSON.stringify({
        verdict: 'maybe',
        rewritten: null,
        clarification: null,
        reasoning: 'unsure',
      }))
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => err.code === 'EVALUATOR_BAD_RESPONSE',
      )
    })
  })

  describe('API errors', () => {
    it('wraps SDK errors as EVALUATOR_API_ERROR with sanitized message', async () => {
      // Plain Error has no .status — should bucket as a network error and
      // MUST NOT leak the raw upstream message.
      const original = new Error('account-12345 hit token bucket; request_id=req_abc; ip=10.0.0.1')
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_API_ERROR')
          assert.equal(err.message, 'Evaluator network error')
          assert.ok(!/account-12345/.test(err.message))
          assert.ok(!/request_id/.test(err.message))
          // Original error preserved for server-side logging.
          assert.equal(err.cause, original)
          return true
        },
      )
    })

    it('maps 401 to authentication-failed message', async () => {
      const original = Object.assign(new Error('invalid x-api-key (request_id=req_xyz)'), { status: 401 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_API_ERROR')
          assert.equal(err.message, 'Evaluator authentication failed (check ANTHROPIC_API_KEY)')
          assert.equal(err.cause, original)
          return true
        },
      )
    })

    it('maps 403 to authentication-failed message', async () => {
      const original = Object.assign(new Error('forbidden — your account does not have access to claude-opus-4-7'), { status: 403 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_API_ERROR')
          assert.equal(err.message, 'Evaluator authentication failed (check ANTHROPIC_API_KEY)')
          assert.ok(!/claude-opus-4-7/.test(err.message))
          assert.equal(err.cause, original)
          return true
        },
      )
    })

    it('maps 429 to rate-limited message', async () => {
      const original = Object.assign(new Error('rate_limit_exceeded; tier=build; reset=2026-04-26T12:00:00Z'), { status: 429 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.message, 'Evaluator rate limited')
          assert.equal(err.cause, original)
          return true
        },
      )
    })

    it('maps 5xx to service-unavailable message', async () => {
      const original = Object.assign(new Error('upstream timeout at edge-pop-syd'), { status: 503 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_API_ERROR')
          assert.equal(err.message, 'Evaluator service unavailable')
          assert.ok(!/edge-pop-syd/.test(err.message))
          assert.equal(err.cause, original)
          return true
        },
      )
    })

    it('falls through to generic message for other statuses (e.g. 400)', async () => {
      const original = Object.assign(new Error('messages.0.content: too long'), { status: 400 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_API_ERROR')
          assert.equal(err.message, 'Evaluator API call failed')
          assert.equal(err.cause, original)
          return true
        },
      )
    })
  })

  describe('passthrough to SDK', () => {
    it('forwards cwd into the user message when provided', async () => {
      let capturedArgs = null
      const client = makeStubClient(
        JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }),
        { onCall: (args) => { capturedArgs = args } },
      )
      await evaluateDraft({ draft: 'fix it', cwd: '/repo/foo', client })
      assert.ok(capturedArgs.messages[0].content.includes('Session cwd: /repo/foo'))
      assert.ok(capturedArgs.messages[0].content.includes('Draft message:\nfix it'))
    })

    it('omits cwd line when no cwd provided', async () => {
      let capturedArgs = null
      const client = makeStubClient(
        JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }),
        { onCall: (args) => { capturedArgs = args } },
      )
      await evaluateDraft({ draft: 'fix it', client })
      assert.ok(!capturedArgs.messages[0].content.includes('Session cwd'))
      assert.ok(capturedArgs.messages[0].content.startsWith('Draft message:'))
    })

    it('uses CHROXY_EVALUATOR_MODEL env override when no explicit model given', async () => {
      const saved = process.env.CHROXY_EVALUATOR_MODEL
      process.env.CHROXY_EVALUATOR_MODEL = 'claude-test-override'
      let capturedArgs = null
      const client = makeStubClient(
        JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }),
        { onCall: (args) => { capturedArgs = args } },
      )
      try {
        await evaluateDraft({ draft: 'x', client })
        assert.equal(capturedArgs.model, 'claude-test-override')
      } finally {
        if (saved !== undefined) process.env.CHROXY_EVALUATOR_MODEL = saved
        else delete process.env.CHROXY_EVALUATOR_MODEL
      }
    })

    it('explicit model arg beats env override', async () => {
      process.env.CHROXY_EVALUATOR_MODEL = 'claude-env-model'
      let capturedArgs = null
      const client = makeStubClient(
        JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }),
        { onCall: (args) => { capturedArgs = args } },
      )
      try {
        await evaluateDraft({ draft: 'x', model: 'claude-explicit', client })
        assert.equal(capturedArgs.model, 'claude-explicit')
      } finally {
        delete process.env.CHROXY_EVALUATOR_MODEL
      }
    })
  })
})

describe('shouldSkipEvaluator', () => {
  describe('non-string + empty input', () => {
    it('skips when message is undefined', () => {
      assert.equal(shouldSkipEvaluator(undefined), true)
    })

    it('skips when message is null', () => {
      assert.equal(shouldSkipEvaluator(null), true)
    })

    it('skips when message is a number', () => {
      assert.equal(shouldSkipEvaluator(42), true)
    })

    it('skips empty string', () => {
      assert.equal(shouldSkipEvaluator(''), true)
    })

    it('skips whitespace-only string', () => {
      assert.equal(shouldSkipEvaluator('   \n  \t '), true)
    })
  })

  describe('short messages', () => {
    it('skips message under 20 chars (after trim)', () => {
      assert.equal(shouldSkipEvaluator('please fix it'), true)
    })

    it('skips message at 19 chars', () => {
      const msg = 'a'.repeat(19)
      assert.equal(msg.length, 19)
      assert.equal(shouldSkipEvaluator(msg), true)
    })

    it('does not skip on length alone at 20 chars', () => {
      // 20 chars, not a continuation pattern — should NOT skip on length
      const msg = 'please make it work!'
      assert.equal(msg.length, 20)
      assert.equal(shouldSkipEvaluator(msg), false)
    })

    it('trims before measuring length', () => {
      // Long-with-padding draft whose trimmed length is < 20
      assert.equal(shouldSkipEvaluator('     short      '), true)
    })
  })

  describe('continuation / ack patterns', () => {
    const cases = [
      'y',
      'n',
      'yes',
      'YES',
      'no',
      'go',
      'Go.',
      'continue',
      'run it',
      'ok',
      'OK.',
      'okay',
      'sure',
      'sounds good',
      'looks good',
      'Looks good.',
      'do it',
    ]
    for (const c of cases) {
      it(`skips continuation pattern: ${JSON.stringify(c)}`, () => {
        assert.equal(shouldSkipEvaluator(c), true)
      })
    }

    it('does not match when continuation phrase has extra prose', () => {
      // "yes please add a test for the new helper" is substantive
      assert.equal(
        shouldSkipEvaluator('yes please add a test for the new helper'),
        false,
      )
    })
  })

  describe('substantive messages', () => {
    it('does not skip a substantive code request', () => {
      const msg = 'Refactor processQueue() to use a worker pool of 4 instead of recursion.'
      assert.equal(shouldSkipEvaluator(msg), false)
    })

    it('does not skip a question that exceeds the length threshold', () => {
      const msg = 'How should I handle the case where the input array is empty?'
      assert.equal(shouldSkipEvaluator(msg), false)
    })
  })

  describe('config.promptEvaluatorSkipPattern', () => {
    it('skips when custom pattern matches', () => {
      // Default would NOT skip "please proceed when ready" (substantive,
      // doesn't match the default ack regex). Custom pattern adds it.
      const msg = 'please proceed when ready'
      assert.equal(shouldSkipEvaluator(msg), false)
      assert.equal(
        shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: '^please proceed' }),
        true,
      )
    })

    it('still applies the length and default rules when custom pattern does not match', () => {
      // Custom pattern is unrelated; "y" should still skip via the default.
      assert.equal(
        shouldSkipEvaluator('y', { promptEvaluatorSkipPattern: '^foo$' }),
        true,
      )
    })

    it('falls back gracefully when custom pattern is malformed', () => {
      // Unbalanced bracket — should not throw, should fall through to defaults.
      const msg = 'this is a long substantive message that should be evaluated normally'
      assert.equal(
        shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: '[invalid' }),
        false,
      )
      // Default rules still apply with a malformed custom pattern.
      assert.equal(
        shouldSkipEvaluator('yes', { promptEvaluatorSkipPattern: '[invalid' }),
        true,
      )
    })

    it('ignores empty custom pattern', () => {
      const msg = 'this message is long enough not to skip on length'
      assert.equal(
        shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: '' }),
        false,
      )
    })

    it('ignores non-string custom pattern', () => {
      const msg = 'this message is long enough not to skip on length'
      assert.equal(
        shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: 123 }),
        false,
      )
    })

    it('treats custom pattern as case-insensitive', () => {
      assert.equal(
        shouldSkipEvaluator('PROCEED', { promptEvaluatorSkipPattern: '^proceed$' }),
        true,
      )
    })

    it('accepts an undefined config without throwing', () => {
      assert.equal(shouldSkipEvaluator('y', undefined), true)
      assert.equal(shouldSkipEvaluator('y'), true)
    })
  })
})
