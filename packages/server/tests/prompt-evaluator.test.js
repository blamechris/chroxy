import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDraft } from '../src/prompt-evaluator.js'

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
          assert.equal(err.message, 'Evaluator authentication failed (check ANTHROPIC_API_KEY)')
          assert.ok(!/claude-opus-4-7/.test(err.message))
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
          assert.equal(err.message, 'Evaluator service unavailable')
          assert.ok(!/edge-pop-syd/.test(err.message))
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
