import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { ClaudeByokSession } from '../src/byok-session.js'

/**
 * Tests for byok-session.js (PR 1 — chat only, no tool dispatch).
 *
 * The Anthropic SDK is replaced with a stub via `session._client = ...` so
 * we never hit the network and don't need an API key in CI. The stub mirrors
 * the SDK's `messages.stream(...)` shape: returns an object that is both
 * async-iterable and exposes a .finalMessage() helper.
 */

function fakeStream(events, finalMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    async finalMessage() {
      return (
        finalMessage || {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: events.map((e) => e.delta?.text || '').join('') }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      )
    },
  }
}

function captureEvents(session) {
  const captured = []
  const known = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'result', 'error', 'tool_start', 'tool_result']
  for (const name of known) {
    session.on(name, (payload) => captured.push({ name, payload }))
  }
  return captured
}

describe('ClaudeByokSession', () => {
  let tmpHome
  let originalHome
  let originalApiKey

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-test-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  describe('static configuration', () => {
    it('exposes the expected displayLabel', () => {
      assert.equal(ClaudeByokSession.displayLabel, 'Claude (API key — BYOK)')
    })

    it('declares no dataDir (no ~/.claude dependency)', () => {
      assert.equal(ClaudeByokSession.dataDir, null)
    })

    it('PR 2 capabilities: tools enabled via in-process permissions', () => {
      const caps = ClaudeByokSession.capabilities
      assert.equal(caps.permissions, true, 'PR 2 gates tools through PermissionManager')
      assert.equal(caps.inProcessPermissions, true)
      assert.equal(caps.modelSwitch, true)
      assert.equal(caps.streaming, true)
      assert.equal(caps.skillToggle, true)
      assert.equal(caps.resume, false, 'in-memory history only')
    })

    it('preflight declares ANTHROPIC_API_KEY as required (not optional)', () => {
      const pf = ClaudeByokSession.preflight
      assert.equal(pf.credentials.optional, false)
      assert.deepEqual(pf.credentials.envVars, ['ANTHROPIC_API_KEY'])
      assert.match(pf.credentials.hint, /credentials\.json/)
    })
  })

  describe('start()', () => {
    it('emits ready with model + empty tools when credentials present', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-7' })
      const captured = captureEvents(session)
      // Inject a stub client BEFORE start to skip the real Anthropic constructor.
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      const ready = captured.find((e) => e.name === 'ready')
      assert.ok(ready, 'ready event must fire')
      assert.equal(ready.payload.model, 'claude-opus-4-7')
      assert.deepEqual(ready.payload.tools, [])
      await session.destroy()
    })

    it('emits error when credentials are missing', async () => {
      delete process.env.ANTHROPIC_API_KEY
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      const captured = captureEvents(session)
      await session.start()
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent, 'error event must fire')
      assert.match(errorEvent.payload.message, /BYOK credentials not found/)
      assert.equal(captured.find((e) => e.name === 'ready'), undefined)
    })
  })

  describe('sendMessage()', () => {
    it('emits stream_start, stream_delta(s), stream_end, result for a successful turn', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-7' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 4 } },
              { type: 'message_stop' },
            ], {
              // Realistic finalMessage matches message_delta's usage —
              // in real streams the two never diverge.
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'Hello, world' }],
              usage: { input_tokens: 5, output_tokens: 4 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')
      const starts = captured.filter((e) => e.name === 'stream_start')
      const deltas = captured.filter((e) => e.name === 'stream_delta')
      const ends = captured.filter((e) => e.name === 'stream_end')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(starts.length, 1, 'one stream_start per turn')
      assert.equal(deltas.length, 2, 'two text deltas')
      // Canonical chroxy field name is `delta`, NOT `text` — dashboard +
      // mobile message-handlers both read `msg.delta`. Emitting `text`
      // here renders empty bubbles (caught by review on PR #4055).
      assert.equal(deltas[0].payload.delta, 'Hello')
      assert.equal(deltas[1].payload.delta, ', world')
      // stream_end MUST fire before result so the dashboard flushes its
      // debounced delta buffer + clears streamingMessageId. Order matters.
      assert.equal(ends.length, 1, 'stream_end fires exactly once per turn')
      const endIdx = captured.findIndex((e) => e.name === 'stream_end')
      const resultIdx = captured.findIndex((e) => e.name === 'result')
      assert.ok(endIdx < resultIdx, 'stream_end must precede result')
      // result payload carries duration + usage + stopReason + cost.
      assert.equal(results.length, 1)
      assert.equal(results[0].payload.stopReason, 'end_turn')
      assert.equal(results[0].payload.usage.input_tokens, 5)
      assert.equal(results[0].payload.usage.output_tokens, 4)
      assert.equal(typeof results[0].payload.duration, 'number')
      assert.ok(results[0].payload.duration >= 0)
      // Cost MUST be on the result payload — session-manager.js:_trackCost
      // (the budget-check + cumulative session-cost feeder) reads it as a
      // typeof === 'number' gate. Omitting it silently disables BYOK cost
      // accounting (#4056, blocks #4054).
      assert.equal(typeof results[0].payload.cost, 'number')
      // Opus 4.7 default: 5 input * $15/Mtok + 4 output * $75/Mtok
      //   = 0.000075 + 0.000300 = 0.000375 USD
      assert.ok(
        Math.abs(results[0].payload.cost - 0.000375) < 1e-9,
        `expected cost ~= 0.000375 for 5in/4out on opus-4-7, got ${results[0].payload.cost}`,
      )
      await session.destroy()
    })

    it('accumulates usage + cost across multiple tool-use rounds', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Auto-allow so the agent loop executes without prompting.
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      // Two rounds: round 1 ends with stop_reason=tool_use (10in/20out),
      // round 2 ends with stop_reason=end_turn (7in/3out). Cost MUST
      // reflect the sum, not just the last round (the bug #4056 fixes).
      let round = 0
      session._client = {
        messages: {
          stream: () => {
            round += 1
            if (round === 1) {
              return fakeStream([], {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
                usage: { input_tokens: 10, output_tokens: 20 },
              })
            }
            return fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 7, output_tokens: 3 },
            })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'one result per turn even across rounds')
      // Accumulated usage: 10+7 input, 20+3 output.
      assert.equal(results[0].payload.usage.input_tokens, 17)
      assert.equal(results[0].payload.usage.output_tokens, 23)
      // Accumulated cost (Opus 4.7): (17 * 15 + 23 * 75) / 1e6 = 0.001980
      assert.ok(
        Math.abs(results[0].payload.cost - 0.001980) < 1e-9,
        `expected cost ~= 0.001980, got ${results[0].payload.cost}`,
      )
      await session.destroy()
    })

    it('emits cost: 0 when model has no pricing entry (graceful degradation)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-future-model-9-9' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('q')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result)
      // Usage still propagates even when pricing is unknown — the
      // cumulative-display story (#4054) can still show token counts.
      assert.equal(result.payload.usage.input_tokens, 100)
      // But cost falls back to 0 rather than crashing or emitting NaN.
      assert.equal(result.payload.cost, 0)
      await session.destroy()
    })

    it('warns at most once per session per unknown model (#4085)', async () => {
      // Pre-fix: warn fired in every sendMessage. A 10-turn run on an
      // unknown model spammed 10 identical warns. The Set guard pins
      // the warn count to exactly 1 across N turns.
      //
      // Inspect _pricingWarnedModels directly — the test pattern in
      // this file doesn't intercept the module-level logger, and Set
      // membership is a sufficient proxy: the warn-firing site is the
      // ONLY thing that adds to the set, so set.size === N is
      // equivalent to "warn fired N times for distinct models."
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-future-model-x-y' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      await session.start()
      await session.sendMessage('q1')
      await session.sendMessage('q2')
      await session.sendMessage('q3')
      // The set has exactly one entry — the model id — proving the
      // gate fired exactly once across three turns.
      assert.equal(session._pricingWarnedModels.size, 1)
      assert.ok(session._pricingWarnedModels.has('claude-future-model-x-y'))
      await session.destroy()
    })

    it('resolves dated full model ids to family pricing (#4084)', async () => {
      // A user pinning to a dated revision must still get a non-zero
      // cost, not the silent cost: 0 + warn that pre-fix produced.
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-7-20251201' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 5, output_tokens: 4 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('q')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result)
      // Same math as the canonical happy-path test (5in/4out on opus-4-7
      // = 0.000375 USD). Same numeric expectation proves the family
      // resolution worked.
      assert.ok(Math.abs(result.payload.cost - 0.000375) < 1e-9,
        `dated-id pricing must equal family-head pricing; got cost=${result.payload.cost}`)
      // And no warn fired — pricing was found.
      assert.equal(session._pricingWarnedModels.size, 0)
      await session.destroy()
    })

    it('refuses concurrent sendMessage with an error event', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Stream that never yields anything until aborted — pretend the
      // model is still thinking.
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              await new Promise((r) => setTimeout(r, 200))
            },
            async finalMessage() {
              return { stop_reason: 'end_turn', content: [], usage: {} }
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      const turn1 = session.sendMessage('first')
      // Don't await turn1 yet — fire turn2 while it's still pending.
      await session.sendMessage('second')
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.some((e) => /Already processing/.test(e.payload.message)),
        'second concurrent call should error')
      session.interrupt()
      await turn1
      await session.destroy()
    })

    it('appends user + assistant turns to history (chat continuity)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [
                { type: 'message_start', message: { id: 'msg', model: 'claude-opus-4-7' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'response' } },
                { type: 'message_stop' },
              ],
              {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'response' }],
                usage: {},
              },
            ),
        },
      }
      await session.start()
      await session.sendMessage('first')
      await session.sendMessage('second')
      assert.equal(session._history.length, 4, '2 turns = user+assistant ×2')
      assert.equal(session._history[0].role, 'user')
      assert.equal(session._history[0].content, 'first')
      assert.equal(session._history[1].role, 'assistant')
      assert.equal(session._history[2].role, 'user')
      assert.equal(session._history[2].content, 'second')
      await session.destroy()
    })

    it('rolls back the user message if stream init throws synchronously', async () => {
      // Without rollback, the orphan user message breaks the next turn's
      // user/assistant alternation that the SDK requires (review on #4055).
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => {
            throw Object.assign(new Error('bad request'), { status: 400 })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('bad turn')
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.some((e) => e.payload.code === 'HTTP_400'))
      assert.equal(session._history.length, 0, 'orphan user message must be rolled back')
      await session.destroy()
    })

    it('rolls back the entire turn when stream init throws at round >= 1 (#4109)', async () => {
      // Round 0 succeeds with a tool_use; round 1 stream init throws.
      // Without rollback, history ends on a `user` tool_result turn, and
      // the next sendMessage pushes a plain-text `user` turn — back-to-
      // back user roles. The SDK accepts this today but the alternation
      // invariant we comment about elsewhere is now soft, and a future
      // API tightening could 400 it.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          toolName: block.name,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              // Round 0: succeed, return one tool_use to push the loop to round 1.
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            // Round 1: throw at stream init (transient 5xx).
            throw Object.assign(new Error('upstream rate limit'), { status: 429 })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('round-1-failure')
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.some((e) => e.payload.code === 'HTTP_429'), `expected an HTTP_429 error, got: ${JSON.stringify(errors)}`)
      assert.equal(streamCallCount, 2, 'stream() should be invoked twice (round 0 + round 1)')
      // After rollback, history must be EMPTY — the turn never landed.
      // No back-to-back user turns possible because there is no turn at all.
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back on round-1 stream-init throw; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('round-1 stream-init throw lets the next sendMessage land cleanly (alternation preserved)', async () => {
      // End-to-end follow-up to the rollback test above. After the
      // failure, the next sendMessage should produce a valid history:
      // exactly one user turn (the new prompt), no orphans, no back-to-
      // back user roles.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            if (streamCallCount === 2) {
              throw Object.assign(new Error('upstream gone'), { status: 502 })
            }
            // Retry: clean text response.
            return fakeStream(
              [{ type: 'message_stop' }],
              {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'recovered' }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      captureEvents(session)
      await session.start()
      await session.sendMessage('first attempt — will fail at round 1')
      // captureEvents() already attached an 'error' listener, so the
      // first call's HTTP_502 didn't surface as an unhandled rejection.
      // Now retry: pre-fix this would have produced back-to-back user turns.
      await session.sendMessage('retry')
      // History after successful retry: [user-prompt, assistant]
      assert.equal(session._history.length, 2, `expected 2 entries, got ${session._history.length}: ${JSON.stringify(session._history)}`)
      assert.equal(session._history[0].role, 'user')
      assert.equal(session._history[0].content, 'retry')
      assert.equal(session._history[1].role, 'assistant')
      await session.destroy()
    })

    it('rolls back the entire turn when for-await rejects mid-iteration at round >= 1 (#4118)', async () => {
      // Round 0 returns one tool_use; round 1's stream rejects DURING
      // iteration (not at init). Without the outer-catch rollback,
      // _history ends on a `user` tool_result turn and the next
      // sendMessage produces back-to-back user roles.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            // Round 1: stream STARTS (no sync throw at init) but the
            // for-await rejects mid-iteration.
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
                const err = new Error('network dropped mid-stream')
                err.status = 502
                throw err
              },
              async finalMessage() { return null },
            }
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('round-1-async-failure')
      assert.equal(streamCallCount, 2)
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.length >= 1, 'turn surfaces an error')
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back on round-1 mid-stream throw; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('rolls back the entire turn when finalMessage() rejects at round >= 1 (#4118)', async () => {
      // Round 0 returns one tool_use; round 1's stream iterates cleanly
      // but `await stream.finalMessage()` rejects. Same alternation
      // soft-break — must be caught by the outer-catch rollback.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            // Round 1: stream iterates cleanly but finalMessage rejects.
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'message_stop' }
              },
              async finalMessage() {
                const err = new Error('finalMessage failed')
                err.status = 500
                throw err
              },
            }
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('finalMessage-rejection')
      assert.equal(streamCallCount, 2)
      assert.ok(captured.some((e) => e.name === 'error'), 'turn surfaces an error')
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back when finalMessage rejects; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('rolls back the entire turn when tool execution rejects at round >= 1 (#4118)', async () => {
      // Round 0 succeeds with a tool_use. Round 1 starts with a fresh
      // tool_use, but _executeToolBlock rejects synchronously inside the
      // promise. Same alternation soft-break — outer-catch rollback.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let executeCount = 0
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCount += 1
        if (executeCount === 1) {
          this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: 'ok', isError: false })
          return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
        }
        throw new Error('tool execution exploded')
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            // Both rounds return tool_use so we get a second invocation
            // of _executeToolBlock which throws.
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: `tu_${streamCallCount}`, name: 'Read', input: { file_path: '/x' } }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('tool-rejection')
      assert.equal(executeCount, 2, 'second tool_use invokes the failing executor')
      assert.ok(captured.some((e) => e.name === 'error'), 'turn surfaces an error')
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back when a tool throws mid-loop; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('emits stream_end on the error path too (no stranded spinner)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
              const err = new Error('upstream went away')
              err.status = 502
              throw err
            },
            async finalMessage() { return null },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')
      const ends = captured.filter((e) => e.name === 'stream_end')
      const errors = captured.filter((e) => e.name === 'error')
      assert.equal(ends.length, 1, 'stream_end must fire even when the stream errors mid-flight')
      assert.ok(errors.length >= 1, 'error event still fires')
      await session.destroy()
    })

    it('surfaces SDK errors with a HTTP_* code when status present', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              const err = new Error('rate limit exceeded')
              err.status = 429
              throw err
            },
            async finalMessage() {
              return null
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent)
      assert.equal(errorEvent.payload.code, 'HTTP_429')
      assert.match(errorEvent.payload.message, /rate limit/)
      await session.destroy()
    })

    it('reports an ABORT error code when interrupt() fires mid-stream', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              await new Promise((r) => setTimeout(r, 80))
              // #4057: real SDK throws APIUserAbortError on aborted
              // signals — not the generic 'AbortError'. Use the real
              // class so the test asserts the primary `instanceof`
              // detection path, not just the name-string fallback.
              throw new APIUserAbortError({ message: 'Request was aborted.' })
            },
            async finalMessage() {
              return null
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      const turn = session.sendMessage('hi')
      setTimeout(() => session.interrupt(), 20)
      await turn
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent, 'interrupt should produce an error event')
      assert.equal(errorEvent.payload.code, 'ABORT')
      await session.destroy()
    })

    it('detects APIUserAbortError WITHOUT relying on the signal.aborted fallback (#4057)', async () => {
      // The other abort test still works under the name-string fallback
      // because interrupt() sets signal.aborted = true. This test
      // isolates the primary `instanceof APIUserAbortError` path by
      // throwing without ever aborting the controller — only the SDK
      // class identity should match.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              throw new APIUserAbortError({ message: 'Request was aborted.' })
            },
            async finalMessage() {
              return null
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      // NOTE: no session.interrupt() call — signal.aborted stays false.
      // The only way `aborted` can be true in _emitTurnError is the
      // instanceof check matching the thrown class.
      await session.sendMessage('hi')
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent)
      assert.equal(errorEvent.payload.code, 'ABORT',
        'APIUserAbortError instance must map to code=ABORT via instanceof, not via signal.aborted')
      await session.destroy()
    })

    it('warns and continues when attachments are passed (PR 1 limitation)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
              { type: 'message_stop' },
            ]),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('describe this', [{ type: 'image', data: 'base64...' }])
      const errorEvent = captured.find(
        (e) => e.name === 'error' && /does not yet materialise attachments/.test(e.payload.message),
      )
      assert.ok(errorEvent, 'should warn about dropped attachments')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result, 'turn should still complete with text-only prompt')
      await session.destroy()
    })
  })

  describe('tool dispatch (PR 2)', () => {
    it('executes a tool_use block via the local executor and loops on tool_result', async () => {
      // Round 1: model emits a Read tool_use, stop_reason=tool_use.
      // Round 2: model emits text, stop_reason=end_turn.
      let callCount = 0
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Permission mode auto so the test doesn't hang waiting for a user
      // tap. The point of the test is the agent loop, not the permission UI.
      session.setPermissionMode('auto')
      // Force the Read tool through a stub executor by intercepting at
      // the tool layer. The session's own executor would try to read a
      // real file — out of scope for this test.
      const originalExecute = session._executeToolBlock.bind(session)
      session._executeToolBlock = async function ({ block }) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'mock tool output',
          is_error: false,
        }
      }
      session._client = {
        messages: {
          stream: () => {
            callCount += 1
            if (callCount === 1) {
              return fakeStream(
                [
                  { type: 'message_start', message: { id: 'msg', model: 'claude-opus-4-7' } },
                  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
                  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
                  { type: 'message_stop' },
                ],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
                  usage: { input_tokens: 10, output_tokens: 5 },
                },
              )
            }
            return fakeStream(
              [
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                { type: 'message_stop' },
              ],
              {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'done' }],
                usage: { input_tokens: 12, output_tokens: 8 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('please read /tmp/x')
      // Round 1 + round 2 = 2 stream() calls
      assert.equal(callCount, 2, 'agent loop should iterate twice (tool round + final)')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'one final result, not one per round')
      assert.equal(results[0].payload.stopReason, 'end_turn')
      // History should contain: user prompt, assistant turn 1, user tool_result, assistant turn 2
      assert.equal(session._history.length, 4)
      assert.equal(session._history[0].role, 'user')
      assert.equal(session._history[1].role, 'assistant')
      assert.equal(session._history[2].role, 'user', 'tool_result rides on a user message')
      assert.ok(Array.isArray(session._history[2].content))
      assert.equal(session._history[2].content[0].type, 'tool_result')
      assert.equal(session._history[3].role, 'assistant')
      session._executeToolBlock = originalExecute
      await session.destroy()
    })

    it('fills synthetic tool_result blocks for unexecuted tool_use on mid-loop abort (#4061)', async () => {
      // Three tool_use blocks. Inside block 1's executor stub we abort
      // the session's AbortController and then return a normal
      // tool_result. The agent loop's next iteration sees signal.aborted
      // and runs the synthetic-fill for blocks 2 and 3. Without the
      // fix, history.push would land 1 tool_result for 3 tool_use ids
      // and the next sendMessage would 400. With the fix:
      //   - History carries N=3 tool_result blocks (1 real + 2 synthetic)
      //   - The dashboard receives N=3 tool_result events too, so the
      //     tool-call bubbles for blocks 2 and 3 don't hang on 'running…'
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let executeCalls = 0
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCalls += 1
        // On block 1, abort the controller so the next loop iteration
        // observes signal.aborted and triggers the synthetic-fill.
        if (executeCalls === 1) {
          this._abortController.abort()
        }
        // Mirror real _executeToolBlock's event emission so we can
        // assert end-to-end event counts.
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          toolName: block.name,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
                  { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/b' } },
                  { type: 'tool_use', id: 'tu_3', name: 'Read', input: { file_path: '/c' } },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            ),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      // Only the first block executed — the abort fired during its
      // executor call, the loop breaks before block 2 / block 3 run.
      assert.equal(executeCalls, 1, 'only one real execute before abort')
      // History MUST carry a user message with exactly 3 tool_result
      // blocks: tu_1 real, tu_2 + tu_3 synthetic. The next sendMessage
      // would otherwise 400.
      const userTurns = session._history.filter((m) => m.role === 'user' && Array.isArray(m.content))
      const toolResultTurn = userTurns[userTurns.length - 1]
      assert.ok(toolResultTurn, 'tool_result user-turn must be pushed even after abort')
      const ids = toolResultTurn.content.map((b) => b.tool_use_id).sort()
      assert.deepEqual(ids, ['tu_1', 'tu_2', 'tu_3'],
        'every tool_use id must have a matching tool_result block')
      // The synthetic ones are explicit errors.
      const synthetic = toolResultTurn.content.filter((b) => b.tool_use_id !== 'tu_1')
      assert.equal(synthetic.length, 2)
      for (const s of synthetic) {
        assert.equal(s.type, 'tool_result', 'synthetic block must carry the tool_result type tag')
        assert.equal(s.is_error, true, 'synthetic tool_result must mark is_error')
        assert.match(s.content, /[Ii]nterrupted/, 'synthetic content should reference the abort')
      }
      // The dashboard / mobile tool-call bubble closes on `tool_result`
      // events — without one per synthetic, blocks 2 and 3 would stay
      // in 'running…' forever (#4108 review). Assert all three fire.
      const toolResultEvents = captured.filter((e) => e.name === 'tool_result')
      const eventIds = toolResultEvents.map((e) => e.payload.toolUseId).sort()
      assert.deepEqual(eventIds, ['tu_1', 'tu_2', 'tu_3'])
      const syntheticEvents = toolResultEvents.filter((e) => e.payload.toolUseId !== 'tu_1')
      assert.equal(syntheticEvents.length, 2)
      for (const ev of syntheticEvents) {
        assert.equal(ev.payload.isError, true)
        assert.match(ev.payload.result, /[Ii]nterrupted/)
        assert.equal(ev.payload.toolName, 'Read', 'synthetic event carries the original tool name')
      }
      await session.destroy()
    })

    it('breaks out of the loop after MAX_TOOL_ROUNDS (infinite-loop safety)', async () => {
      // Model insists on calling a tool on every round — agent loop must
      // bail at the cap, run one summary round (#4063), and emit result so
      // the session doesn't hang.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'x', is_error: false }
      }
      let callCount = 0
      session._client = {
        messages: {
          stream: ({ tools }) => {
            callCount += 1
            // The summary round (#4063) is called without `tools` — the
            // model must respond with text only. Distinguish here to keep
            // the existing assertion meaningful: tool calls are bounded.
            if (!tools || tools.length === 0) {
              return fakeStream(
                [
                  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                  { type: 'message_stop' },
                ],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'I made some progress but hit the cap.' }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: `toolu_${callCount}`, name: 'Read', input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('infinite loop please')
      // 25 tool-rounds + 1 summary round = 26 calls.
      assert.equal(callCount, 26, `expected 25 tool rounds + 1 summary, got ${callCount}`)
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'must emit result even on safety-cap exit')
      await session.destroy()
    })

    it('emits a non-fatal MAX_TOOL_ROUNDS_REACHED error when the cap fires (#4063)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'x', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'Summary text.' }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('infinite loop please')
      const errs = captured.filter((e) => e.name === 'error')
      const capErr = errs.find((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      assert.ok(capErr, `expected MAX_TOOL_ROUNDS_REACHED error, got: ${errs.map((e) => e.payload?.code).join(', ') || 'none'}`)
      assert.equal(capErr.payload.fatal, false, 'cap-reached must be non-fatal (session stays alive)')
      assert.match(capErr.payload.message, /25/, 'message should cite the cap count')
      // Session must still be usable after — busy flag clears via _finishTurn.
      assert.equal(session._isBusy, false, 'session should not be stuck busy after non-fatal cap-hit error')
      await session.destroy()
    })

    it('streams summary text from the post-cap round so the user sees what was accomplished (#4063)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              return fakeStream(
                [
                  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I capped out but did X, Y, Z.' } },
                  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                ],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'I capped out but did X, Y, Z.' }],
                  usage: { input_tokens: 5, output_tokens: 10 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const deltas = captured.filter((e) => e.name === 'stream_delta').map((e) => e.payload.delta || '').join('')
      assert.match(deltas, /capped out but did X, Y, Z/, 'summary text must be streamed to the dashboard')
      // The result event reflects the summary's stop_reason, not the cap-hit's tool_use.
      const result = captured.find((e) => e.name === 'result')
      assert.equal(result.payload.stopReason, 'end_turn')
      await session.destroy()
    })

    it('surfaces a denied permission as an error tool_result', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Default 'approve' mode — without a permission response the
      // promise would hang. Stub the permission manager to deny.
      session._permissions.handlePermission = async () => ({ behavior: 'deny', message: 'no' })
      let callCount = 0
      session._client = {
        messages: {
          stream: () => {
            callCount += 1
            if (callCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf /' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('try something dangerous')
      const denied = captured.find((e) => e.name === 'tool_result' && e.payload.isError === true)
      assert.ok(denied, 'denied tool produces an error tool_result event')
      assert.match(denied.payload.result, /no/i)
      await session.destroy()
    })
  })

  describe('lifecycle', () => {
    it('destroy() is idempotent and clears history', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session._history.push({ role: 'user', content: 'foo' })
      await session.destroy()
      assert.equal(session._history.length, 0)
      await session.destroy()  // second call must not throw
    })

    it('setModel updates without restart (stateless SDK client)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-7' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session.setModel('claude-sonnet-4-6')
      assert.equal(session.model, 'claude-sonnet-4-6')
      await session.destroy()
    })
  })
})
