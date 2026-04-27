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
    it('wraps SDK errors as EVALUATOR_API_ERROR', async () => {
      const client = makeThrowingClient(new Error('rate limit'))
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => err.code === 'EVALUATOR_API_ERROR' && /rate limit/.test(err.message),
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
