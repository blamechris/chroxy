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

// #3651 — stub that never resolves on its own and rejects with an
// AbortError when the caller's signal aborts. Mirrors what the real
// Anthropic SDK does when passed a signal that fires.
function makeHangingClient({ onSignal } = {}) {
  return {
    messages: {
      create: (_args, opts) => new Promise((_resolve, reject) => {
        const signal = opts?.signal
        if (!signal) return // never resolves
        if (signal.aborted) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
          return
        }
        signal.addEventListener('abort', () => {
          if (onSignal) onSignal(signal)
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
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

    // #3100: surface the numeric upstream status on the wrapped error so the
    // WS handler (and downstream dashboard) can branch on auth vs rate-limit
    // vs 5xx without parsing the sanitized message string.
    it('copies numeric err.status onto the wrapped error (401)', async () => {
      const original = Object.assign(new Error('invalid x-api-key'), { status: 401 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.status, 401)
          return true
        },
      )
    })

    it('copies numeric err.status onto the wrapped error (429)', async () => {
      const original = Object.assign(new Error('rate_limit_exceeded'), { status: 429 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.status, 429)
          return true
        },
      )
    })

    it('copies numeric err.status onto the wrapped error (503)', async () => {
      const original = Object.assign(new Error('upstream timeout'), { status: 503 })
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.status, 503)
          return true
        },
      )
    })

    it('leaves wrapped.status undefined when the SDK error has no status (network)', async () => {
      const original = new Error('socket hang up')
      const client = makeThrowingClient(original)
      await assert.rejects(
        () => evaluateDraft({ draft: 'x', client }),
        (err) => {
          assert.equal(err.status, undefined)
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

  // #3651: hard deadline on the Anthropic round-trip. Without it, a hung
  // promise (network partition, slow upstream, 503 with no body) blocks
  // the user_input hot path indefinitely.
  describe('timeout (#3651)', () => {
    it('throws EVALUATOR_TIMEOUT when messages.create never resolves before the deadline', async () => {
      const client = makeHangingClient()
      await assert.rejects(
        () => evaluateDraft({ draft: 'a substantive draft for evaluation', client, timeoutMs: 25 }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_TIMEOUT')
          assert.match(err.message, /timed out after 25ms/)
          return true
        },
      )
    })

    it('passes an AbortSignal to messages.create that fires on timeout', async () => {
      let receivedSignal = null
      const client = {
        messages: {
          create: (_args, opts) => new Promise((_resolve, reject) => {
            receivedSignal = opts?.signal ?? null
            if (!receivedSignal) return
            receivedSignal.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }),
        },
      }
      await assert.rejects(
        () => evaluateDraft({ draft: 'a substantive draft for evaluation', client, timeoutMs: 25 }),
        (err) => err.code === 'EVALUATOR_TIMEOUT',
      )
      assert.ok(receivedSignal, 'evaluateDraft must pass a signal in the SDK options')
      assert.equal(receivedSignal.aborted, true, 'signal must be aborted on timeout')
    })

    it('does not abort a fast-resolving call', async () => {
      let receivedSignal = null
      const client = {
        messages: {
          create: async (_args, opts) => {
            receivedSignal = opts?.signal ?? null
            return { content: [{ type: 'text', text: JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }) }] }
          },
        },
      }
      const result = await evaluateDraft({ draft: 'a substantive draft for evaluation', client, timeoutMs: 5_000 })
      assert.equal(result.verdict, 'forward')
      assert.equal(receivedSignal?.aborted, false, 'signal must not abort on fast resolution')
    })

    it('clears the timeout when the call resolves so no orphaned timer fires later', async () => {
      // Pin the cleanup contract: a successful evaluate must not leave a
      // setTimeout queued that would call controller.abort() later (no-op
      // on an already-completed call, but still a leaked event-loop entry).
      let timeoutCalls = 0
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      const liveTimers = new Set()
      globalThis.setTimeout = (fn, ms, ...rest) => {
        timeoutCalls++
        const handle = realSetTimeout(fn, ms, ...rest)
        liveTimers.add(handle)
        return handle
      }
      globalThis.clearTimeout = (handle) => {
        liveTimers.delete(handle)
        return realClearTimeout(handle)
      }
      try {
        const client = makeStubClient(
          JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }),
        )
        await evaluateDraft({ draft: 'a substantive draft for evaluation', client })
        assert.equal(timeoutCalls, 1, 'evaluateDraft schedules exactly one timer per call')
        assert.equal(liveTimers.size, 0, 'the timer must be cleared on success — none should be live')
      } finally {
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
      }
    })

    it('honours CHROXY_EVALUATOR_TIMEOUT_MS env override when no explicit timeoutMs given', async () => {
      const saved = process.env.CHROXY_EVALUATOR_TIMEOUT_MS
      process.env.CHROXY_EVALUATOR_TIMEOUT_MS = '15'
      try {
        const client = makeHangingClient()
        const start = Date.now()
        await assert.rejects(
          () => evaluateDraft({ draft: 'a substantive draft for evaluation', client }),
          (err) => err.code === 'EVALUATOR_TIMEOUT',
        )
        const elapsed = Date.now() - start
        assert.ok(elapsed < 200, `env-configured timeout should fire well before 200ms (took ${elapsed}ms)`)
      } finally {
        if (saved !== undefined) process.env.CHROXY_EVALUATOR_TIMEOUT_MS = saved
        else delete process.env.CHROXY_EVALUATOR_TIMEOUT_MS
      }
    })

    it('explicit timeoutMs arg beats env override', async () => {
      process.env.CHROXY_EVALUATOR_TIMEOUT_MS = '60000'
      try {
        const client = makeHangingClient()
        const start = Date.now()
        await assert.rejects(
          () => evaluateDraft({ draft: 'a substantive draft for evaluation', client, timeoutMs: 20 }),
          (err) => err.code === 'EVALUATOR_TIMEOUT',
        )
        const elapsed = Date.now() - start
        assert.ok(elapsed < 200, `explicit arg should fire well before the env-configured 60s (took ${elapsed}ms)`)
      } finally {
        delete process.env.CHROXY_EVALUATOR_TIMEOUT_MS
      }
    })

    it('rejects non-positive timeoutMs and falls back to env / default', async () => {
      // 0, -5, NaN, Infinity must not silently become "abort instantly". A
      // 30s default fast-resolves the stub call, so we just verify no error.
      const client = makeStubClient(
        JSON.stringify({ verdict: 'forward', rewritten: null, clarification: null, reasoning: 'ok' }),
      )
      for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = await evaluateDraft({ draft: 'a substantive draft for evaluation', client, timeoutMs: bad })
        assert.equal(result.verdict, 'forward', `non-positive timeoutMs ${bad} must fall back to default`)
      }
    })

    it('EVALUATOR_TIMEOUT does not get rewrapped as EVALUATOR_API_ERROR', async () => {
      // The timeout-detection branch must short-circuit BEFORE the API error
      // sanitizer runs. Without this, a future refactor that reorders the
      // catch block could double-wrap the timeout and lose the code.
      const client = makeHangingClient()
      await assert.rejects(
        () => evaluateDraft({ draft: 'a substantive draft for evaluation', client, timeoutMs: 25 }),
        (err) => {
          assert.equal(err.code, 'EVALUATOR_TIMEOUT')
          assert.notEqual(err.code, 'EVALUATOR_API_ERROR')
          return true
        },
      )
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

  describe('compiled-pattern cache (#3213)', () => {
    it('reuses the same compiled regex across repeated calls', async () => {
      // Stub global RegExp constructor to count compilations of one specific
      // source. Uses node:test's mocking via a module-level wrapper since
      // we can't easily peek into the cache directly.
      const { _resetSkipPatternCache } = await import('../src/prompt-evaluator.js')
      _resetSkipPatternCache()

      const OriginalRegExp = global.RegExp
      let constructed = 0
      global.RegExp = function (source, flags) {
        if (source === '^cached pattern$') constructed++
        return new OriginalRegExp(source, flags)
      }
      try {
        const msg = 'this message is long enough to pass the trivial-skip check'
        for (let i = 0; i < 50; i++) {
          shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: '^cached pattern$' })
        }
        assert.equal(constructed, 1, 'pattern should compile exactly once across 50 calls')
      } finally {
        global.RegExp = OriginalRegExp
        _resetSkipPatternCache()
      }
    })

    it('does not re-warn on a malformed pattern across repeated calls', async () => {
      // Capture log output by patching node's console.warn — the server
      // logger ultimately writes through it. Asserting on logger internals
      // would couple to its implementation; this is the integration check.
      const { _resetSkipPatternCache } = await import('../src/prompt-evaluator.js')
      _resetSkipPatternCache()

      const writes = []
      const originalWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk, ...rest) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (s.includes('Invalid promptEvaluatorSkipPattern')) writes.push(s)
        return originalWrite(chunk, ...rest)
      }
      try {
        const msg = 'this message is long enough to pass the trivial-skip check'
        for (let i = 0; i < 10; i++) {
          shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: '[unclosed' })
        }
        // The cache stores `null` for invalid sources, so the warning fires
        // once on first compilation, not on every subsequent call.
        assert.equal(writes.length, 1, `expected one warn, got ${writes.length}`)
      } finally {
        process.stderr.write = originalWrite
        _resetSkipPatternCache()
      }
    })

    it('warning message does not echo the user-supplied regex source (#3212)', async () => {
      // Reachable channel: log.warn fans out to paired WS clients via
      // log_entry events. The raw regex source is user-supplied config and
      // must not be leaked back to the network — see comment at the top of
      // _compileSkipPattern.
      const { _resetSkipPatternCache } = await import('../src/prompt-evaluator.js')
      _resetSkipPatternCache()

      const writes = []
      const originalWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk, ...rest) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        writes.push(s)
        return originalWrite(chunk, ...rest)
      }
      try {
        const sentinelSource = '[REDACTED-SENTINEL-PATTERN-XYZ123'
        const msg = 'this message is long enough to pass the trivial-skip check'
        shouldSkipEvaluator(msg, { promptEvaluatorSkipPattern: sentinelSource })
        const haystack = writes.join('')
        assert.ok(
          /Invalid promptEvaluatorSkipPattern/.test(haystack),
          'expected the generic warn line to appear',
        )
        assert.ok(
          !haystack.includes(sentinelSource),
          'warn output must not echo the raw regex source — see #3212 (log.warn fans out via log_entry)',
        )
        // Also verify the SDK error message itself isn't leaked, which
        // typically embeds the bad source verbatim.
        assert.ok(
          !haystack.includes('SyntaxError'),
          'warn output must not include the underlying SyntaxError',
        )
      } finally {
        process.stderr.write = originalWrite
        _resetSkipPatternCache()
      }
    })
  })
})
