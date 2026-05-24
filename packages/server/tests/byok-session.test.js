import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const known = [
    'ready', 'stream_start', 'stream_delta', 'stream_end', 'result', 'error',
    'tool_start', 'tool_result',
    // #4080: chroxy event re-emitted from the SDK's input_json_delta so
    // the dashboard tool-call bubble can live-preview the model's
    // evolving tool input (especially valuable for Bash early-abort).
    'tool_input_delta',
  ]
  for (const name of known) {
    session.on(name, (payload) => captured.push({ name, payload }))
  }
  return captured
}

/**
 * Drives one round of tool dispatch against the unstubbed executor and
 * returns the tool_result block the model would have seen on the next
 * round. Pre-#4172 every e2e test re-wrote ~25 lines of identical
 * two-round stream stub scaffolding; this helper collapses each test to
 * just its meaningful inputs (tool id/name/input) and assertions.
 *
 * The caller is responsible for permission setup BEFORE calling this —
 * setPermissionMode, _permissions.setRules, _permissions.handlePermission
 * override, etc. The helper only owns the round-1 tool_use emit and the
 * round-2 tool_result capture.
 *
 * @param {object} session  ClaudeByokSession instance (already constructed)
 * @param {object} call     { id, name, input } — the tool_use the model emits
 * @param {object} [opts]
 * @param {string} [opts.prompt='go']  Text passed to sendMessage
 * @returns {Promise<object|null>}  The tool_result content block, or null
 *                                  if the agent loop never reached round 2.
 */
async function runOneToolRound(session, { id, name, input }, opts = {}) {
  const prompt = opts.prompt ?? 'go'
  let round = 0
  let toolResultBlock = null
  session._client = {
    messages: {
      stream: ({ messages }) => {
        round += 1
        if (round === 1) {
          return fakeStream(
            [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
            {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id, name, input }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          )
        }
        const lastTurn = messages[messages.length - 1]
        toolResultBlock = (lastTurn.content || []).find((c) => c?.type === 'tool_result')
        return fakeStream(
          [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
        )
      },
    },
  }
  await session.start()
  await session.sendMessage(prompt)
  return toolResultBlock
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

  describe('tool_start event (#4240)', () => {
    // Wire-shape parity with sdk-session.js and cli-session.js. The
    // event-normalizer reads `data.tool` / `data.input` (matching the
    // protocol ServerToolStartSchema, where `tool: z.string()` is
    // REQUIRED). The legacy byok-session emit used `{toolName}` only,
    // so the dashboard saw `tool: undefined` on the wire and the
    // tool-call bubble rendered a generic placeholder instead of the
    // tool name (#4240). These tests pin the canonical shape against
    // future regressions.

    it('emits tool_start with {tool, input} matching the normalizer wire shape', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-7' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_42', name: 'Read', input: {} } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tu_42', name: 'Read', input: { file_path: '/tmp/x' } }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const starts = captured.filter((e) => e.name === 'tool_start')
      assert.equal(starts.length, 1, 'one tool_use content block -> one tool_start event')
      const payload = starts[0].payload
      // The wire-facing fields the normalizer reads. ServerToolStartSchema
      // requires `tool: z.string()` (non-null), so `tool` MUST be the
      // tool name string here — not undefined and not the legacy
      // `toolName` key.
      assert.equal(payload.tool, 'Read', 'tool field carries the tool name (normalizer-expected key)')
      assert.equal(payload.toolUseId, 'tu_42', 'toolUseId is propagated')
      assert.ok('input' in payload, 'input field is present (may be null pre-delta, but the key must exist)')
      assert.equal(typeof payload.messageId, 'string', 'messageId is set')
      await session.destroy()
    })

    it('does NOT emit the legacy {toolName} key', async () => {
      // Belt-and-braces against a future revert: if anyone reintroduces
      // `toolName` the normalizer will silently drop it and the wire
      // shape regresses to `tool: undefined`.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_stop' },
            ]),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const start = captured.find((e) => e.name === 'tool_start')
      assert.ok(start, 'tool_start event was emitted')
      assert.equal(start.payload.toolName, undefined,
        'legacy `toolName` key must not appear — normalizer reads `tool`, not `toolName`')
    })
  })

  describe('tool_input_delta event (#4080)', () => {
    // The Anthropic SDK streams input JSON for each tool_use block as
    // `input_json_delta` content_block_delta events. Pre-#4080
    // byok-session no-op'd these, so the dashboard tool-call bubble
    // showed nothing until finalMessage() resolved — defeating the
    // value of streaming for long tool inputs (Bash command preview
    // is the canonical case where the user wants to see "rm -rf"
    // forming and abort BEFORE the round finishes).
    //
    // The translator emits `tool_input_delta` carrying ONLY the block
    // index. byok-session is the source of truth for index→toolUseId
    // (populated on content_block_start with type=tool_use, cleared
    // on content_block_stop), per the #4059 translator-stays-pure
    // boundary. These tests pin the wire shape and the surrounding
    // contract.

    it('emits 3 tool_input_delta events with matching toolUseId and concatenable partialJson', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-7' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_42', name: 'Read', input: {} } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'th":"/tm' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'p/x"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 8 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tu_42', name: 'Read', input: { file_path: '/tmp/x' } }],
              usage: { input_tokens: 5, output_tokens: 8 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 3, 'three input_json_delta chunks -> three tool_input_delta events')
      // All deltas must carry the SAME toolUseId resolved from the
      // index→toolUseId map seeded on content_block_start.
      for (const d of deltas) {
        assert.equal(d.payload.toolUseId, 'tu_42', 'toolUseId from the index map')
        assert.equal(typeof d.payload.messageId, 'string', 'messageId is set')
        assert.equal(typeof d.payload.partialJson, 'string', 'partialJson is a string')
      }
      // Concatenating the partials must reconstruct the input JSON
      // the dashboard would parse on completion — the on-the-wire
      // chunking is split arbitrarily by the SDK but the BYTES must
      // be preserved in order.
      const joined = deltas.map((d) => d.payload.partialJson).join('')
      assert.equal(joined, '{"file_path":"/tmp/x"}', 'partials concatenate to the full input JSON')
      await session.destroy()
    })

    it('does NOT emit tool_input_delta for non-tool-use content blocks (text or thinking)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
              { type: 'content_block_stop', index: 0 },
              // A delta for an index we never saw a tool_use start for
              // — translator emits tool_input_delta, but byok-session
              // must drop it because the index→toolUseId map is empty
              // for this index.
              { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'orphan' } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')

      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 0, 'no tool_input_delta for text-only turns or unmapped indices')
      // Sanity: the text_delta still flowed through stream_delta so
      // we haven't broken the happy path while adding the gate.
      const streamDeltas = captured.filter((e) => e.name === 'stream_delta')
      assert.equal(streamDeltas.length, 1, 'text delta still surfaces on stream_delta')
      await session.destroy()
    })

    it('suppresses tool_input_delta while a permission prompt is pending for the same toolUseId', async () => {
      // Defensive-but-load-bearing: the issue's acceptance criterion
      // calls out the flicker case. Today permission requests fire
      // AFTER the stream completes (so the same toolUseId can't have
      // a delta racing a pending permission within ONE round), but
      // the gate must exist for any future mid-stream-permission
      // refactor or a multi-round flow where the same toolUseId is
      // re-streamed. Force the pending state by hand and verify the
      // delta is dropped.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_99', name: 'Bash', input: {} } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"rm -rf"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tu_99', name: 'Bash', input: { command: 'rm -rf' } }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      // Pre-seed the pending set so the delta hits the gate.
      session._pendingPermissionToolUseIds.add('tu_99')
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('do it')
      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 0, 'gate suppresses tool_input_delta while permission is pending')
      await session.destroy()
    })

    it('clears the index→toolUseId map on the error path so stale entries do not leak into the next turn', async () => {
      // Copilot review on #4233: pre-fix the per-round clear lived
      // ONLY after finalMessage() resolved. An iteration /
      // finalMessage() throw skipped it, so a stream that errored
      // mid-tool-stream left index N → tu_X stuck in the map, and the
      // NEXT turn's tool_input_delta for index N would resolve to the
      // previous turn's tu_X — silently mis-tagging. Verify the
      // finally block drains the map regardless of exit path.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            // eslint-disable-next-line require-yield
            async *[Symbol.asyncIterator]() {
              // Yield a tool_use start so the map gets populated,
              // then throw — finalMessage() never runs, so the
              // per-round clear after it never fires.
              yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_pre_err', name: 'Read', input: {} } }
              throw new Error('simulated mid-stream failure')
            },
            async finalMessage() {
              throw new Error('finalMessage not reached')
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('this turn will fail')
      // The error path emits an error event and ends the turn.
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.length >= 1, 'error event surfaces on the failure path')
      // The map MUST be empty before the next turn starts. Reading
      // private state is acceptable here because the alternative
      // (running a SECOND fake stream and asserting no stale toolUseId
      // leaks through) duplicates the existing per-round-clear test
      // without proving the finally path actually ran.
      assert.equal(session._streamingIndexToToolUseId.size, 0,
        'finally must clear the map even when the stream throws')
      await session.destroy()
    })

    it('clears the index→toolUseId map between rounds so a later index does not pick up a stale toolUseId', async () => {
      // Round 1: tool_use at index 0 → tu_a, content_block_stop fires
      // → map entry deleted. But the defensive clear after
      // finalMessage() is the belt-and-suspenders: if a future SDK
      // skipped content_block_stop, round 2's index 0 must NOT
      // resolve to tu_a from round 1. Round 2's tool_use at index 0
      // is tu_b, and its delta must carry tu_b.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let round = 0
      session._client = {
        messages: {
          stream: () => {
            round += 1
            if (round === 1) {
              return fakeStream([
                { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} } },
                { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } },
                // NOTE: deliberately omit content_block_stop here to
                // force the finalMessage()-time clear (a real SDK
                // would always emit stop; this is the defensive case
                // the per-round clear was added for).
                { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
              ], {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }],
                usage: { input_tokens: 1, output_tokens: 1 },
              })
            }
            return fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_b', name: 'Read', input: {} } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/b"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 2, 'one delta per round')
      assert.equal(deltas[0].payload.toolUseId, 'tu_a', 'round 1 delta carries round-1 toolUseId')
      assert.equal(deltas[1].payload.toolUseId, 'tu_b',
        'round 2 delta MUST carry tu_b — not tu_a leaked from a missing content_block_stop')
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

    it('fills synthetic tool_result blocks for unexecuted tool_use on mid-loop abort (#4061, #4062)', async () => {
      // Three tool_use blocks. We abort during PHASE 1 (sequential
      // permission gating) — between block 1's and block 2's gate. The
      // gate loop's next iteration observes signal.aborted, stops
      // gating, and runs the synthetic-fill for the unscheduled
      // remainder. Execution of block 1 (the only successfully-gated
      // block) still happens via Promise.all in phase 2.
      //
      // Pre-#4062 this test aborted from inside block 1's executor in
      // sequential mode. After the parallelism refactor, executions
      // fan out via Promise.all so a mid-exec abort no longer prevents
      // siblings from running — the only deterministic path to the
      // synthetic-fill is to trip the signal during the gate phase. The
      // assertions on the history invariant (N tool_use → N tool_result)
      // and the closing tool_result events remain identical.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Stub the gate so block 1 auto-allows and triggers the abort.
      // Blocks 2 and 3 never enter the gate — the loop sees aborted at
      // the top and breaks. Phase 2 still executes block 1.
      let gateCalls = 0
      session._gateToolBlock = async function ({ block }) {
        gateCalls += 1
        if (gateCalls === 1) {
          // Trip the abort BEFORE returning so the next gate-loop
          // iteration sees signal.aborted and bails into the
          // synthetic-fill. The already-resolved decision for block 1
          // still goes through to phase 2.
          this._abortController.abort()
          return { behavior: 'allow', updatedInput: block.input || {} }
        }
        throw new Error('gate should not run after abort')
      }
      let executeCalls = 0
      // Wrap the original executor so we still emit the real tool_result
      // event for block 1 (mirrors the production code path).
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCalls += 1
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

    it('executes parallel tool_use blocks concurrently — wall clock < sequential (#4062)', async () => {
      // Three Read tool_use blocks in one assistant turn. Each executor
      // sleeps 100ms. Sequential would take ~300ms; Promise.all should
      // collapse to ~100ms + a small scheduler margin. Assert the total
      // is comfortably under the sequential floor.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      const SLEEP_MS = 100
      const startTimes = []
      const endTimes = []
      session._executeToolBlock = async function ({ block, messageId, decision }) {
        // Sanity check: orchestrator passes the pre-resolved decision.
        assert.ok(decision, 'orchestrator must pass a pre-resolved decision into _executeToolBlock')
        assert.equal(decision.behavior, 'allow', 'auto mode resolves to allow')
        startTimes.push(Date.now())
        await new Promise((r) => setTimeout(r, SLEEP_MS))
        endTimes.push(Date.now())
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          toolName: block.name,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } },
                    { type: 'tool_use', id: 'tu_b', name: 'Read', input: { file_path: '/b' } },
                    { type: 'tool_use', id: 'tu_c', name: 'Read', input: { file_path: '/c' } },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const turnStart = Date.now()
      await session.sendMessage('parallel reads')
      const turnTotal = Date.now() - turnStart
      // Sequential would be 3 * 100ms = 300ms (minimum). Parallel should
      // finish in ~100ms plus a generous CI scheduler margin. Tight
      // upper bound at 250ms — proves concurrency without flakiness on
      // overloaded runners.
      assert.equal(startTimes.length, 3, 'all three executors fire')
      assert.ok(
        turnTotal < 250,
        `expected parallel turn < 250ms, got ${turnTotal}ms — sequential floor is ~300ms`,
      )
      // Additional concurrency check: each executor's start should be
      // within the lifetime of the others (overlap, not back-to-back).
      const lastStart = Math.max(...startTimes)
      const firstEnd = Math.min(...endTimes)
      assert.ok(
        lastStart < firstEnd,
        `executors must overlap — last start (${lastStart}) should precede first end (${firstEnd})`,
      )
      await session.destroy()
    })

    it('preserves tool_result order when one block is denied amid approvals (#4062)', async () => {
      // Three tool_use blocks. Middle one (tu_b) gets denied by a
      // session rule; the others auto-allow. Even though execution is
      // parallel, the tool_result content array must preserve the
      // source ordering [tu_a, tu_b-denied, tu_c] so the Anthropic API
      // sees a strict tool_use ↔ tool_result alignment.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('approve')
      let gateCallIndex = 0
      session._gateToolBlock = async function ({ block }) {
        const idx = gateCallIndex++
        if (idx === 1) {
          // Block b: deny.
          return { behavior: 'deny', message: 'Denied by session rule' }
        }
        return { behavior: 'allow', updatedInput: block.input || {} }
      }
      // Add a small variable delay so any naive ordering bug surfaces.
      const delays = { tu_a: 60, tu_c: 20 }
      session._executeToolBlock = async function ({ block, messageId, decision }) {
        if (decision?.behavior !== 'allow') {
          // Mirror the production deny short-circuit so this stub
          // behaves identically to the real implementation for denied
          // blocks — important because the orchestrator passes the
          // decision through.
          const msg = decision.message || 'Permission denied by user.'
          this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: msg, isError: true })
          return { type: 'tool_result', tool_use_id: block.id, content: msg, is_error: true }
        }
        const sleep = delays[block.id] || 0
        if (sleep) await new Promise((r) => setTimeout(r, sleep))
        this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'echo a' } },
                    { type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'echo b' } },
                    { type: 'tool_use', id: 'tu_c', name: 'Bash', input: { command: 'echo c' } },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('mixed approval')
      // History: user-prompt, assistant tool_use, user tool_result, assistant final.
      const toolResultTurn = session._history.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      assert.ok(toolResultTurn, 'tool_result user-turn must be present')
      const ids = toolResultTurn.content.map((b) => b.tool_use_id)
      assert.deepEqual(ids, ['tu_a', 'tu_b', 'tu_c'],
        'tool_result order must match tool_use source order even with parallel execution + variable latency')
      // The denied block carries the denial.
      const denied = toolResultTurn.content[1]
      assert.equal(denied.tool_use_id, 'tu_b')
      assert.equal(denied.is_error, true)
      assert.match(denied.content, /[Dd]enied/)
      // The two approved blocks succeeded.
      assert.equal(toolResultTurn.content[0].is_error, false)
      assert.equal(toolResultTurn.content[2].is_error, false)
      await session.destroy()
    })

    it('serialises permission gating across parallel tool_use blocks (#4062 UX)', async () => {
      // The acceptance criterion: permission prompts must surface one
      // at a time, not all-at-once, even though execution fans out.
      // Stub _gateToolBlock to record the order in which it's CALLED
      // (start) and RESOLVED (end). Real gates are async (await user
      // tap on phone); we simulate with a 30ms delay each. If the
      // orchestrator parallelised gates, the calls would overlap — i.e.
      // call 2 starts before call 1 resolves.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('approve')
      const events = []
      let counter = 0
      session._gateToolBlock = async function ({ block }) {
        const id = ++counter
        events.push({ kind: 'start', id, block: block.id, t: Date.now() })
        await new Promise((r) => setTimeout(r, 30))
        events.push({ kind: 'end', id, block: block.id, t: Date.now() })
        return { behavior: 'allow', updatedInput: block.input || {} }
      }
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, toolName: block.name, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
                    { type: 'tool_use', id: 'tu_b', name: 'Read', input: {} },
                    { type: 'tool_use', id: 'tu_c', name: 'Read', input: {} },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('go')
      // Strict alternation: start1, end1, start2, end2, start3, end3 —
      // no two starts back-to-back without an end in between. Anything
      // else means gates overlapped (parallel prompts — bad UX).
      assert.equal(events.length, 6, 'three gates → six start/end events')
      for (let i = 0; i < 3; i++) {
        assert.equal(events[i * 2].kind, 'start', `event ${i * 2} should be a start`)
        assert.equal(events[i * 2 + 1].kind, 'end', `event ${i * 2 + 1} should be the matching end`)
        assert.equal(events[i * 2].id, events[i * 2 + 1].id, 'start and end ids must pair up — gates cannot interleave')
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

    it('embeds the summary instruction in the existing tool_result user turn (#4063 alternation guard — review #4146)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools, messages }) => {
            if (!tools || tools.length === 0) {
              // On the summary round, the LAST entry in `messages` must
              // be a user turn carrying both tool_result blocks AND the
              // synthetic instruction. Verify that here so a regression
              // that pushes a second user turn back-to-back is caught.
              const last = messages[messages.length - 1]
              assert.equal(last.role, 'user', 'last turn must be user (single turn, not two consecutive)')
              const kinds = last.content.map((c) => c.type).sort()
              assert.ok(kinds.includes('tool_result'), 'last user turn must still carry tool_result blocks')
              assert.ok(kinds.includes('text'), 'last user turn must include the synthetic text instruction')
              // Verify the second-to-last is assistant (alternation).
              const prev = messages[messages.length - 2]
              assert.equal(prev.role, 'assistant', 'turn before final must be assistant')
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
                { stop_reason: 'end_turn', content: [{ type: 'text', text: 'summary' }], usage: { input_tokens: 1, output_tokens: 1 } },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      // Attach an error listener so EventEmitter doesn't throw on the
      // non-fatal MAX_TOOL_ROUNDS_REACHED emit. We don't use the captured
      // payload — the alternation check happens in the stream stub above.
      captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      await session.destroy()
    })

    it('pops the synthetic instruction on summary stream-init failure (#4063 invariant — review)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Synchronous throw from summary stream-init.
              throw new Error('summary-init failed')
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      // After failure, the user-turn rollback should have popped the
      // synthetic instruction back off. The last user turn should
      // contain ONLY tool_result blocks — no leftover text instruction.
      const last = session._history[session._history.length - 1]
      assert.equal(last.role, 'user')
      const types = last.content.map((c) => c.type)
      assert.equal(types.every((t) => t === 'tool_result'), true,
        `last user turn must not retain summary text on failure, got types: ${types.join(',')}`)
      await session.destroy()
    })

    it('emits exactly one result + no STREAM_ERROR on summary stream-init failure (#4147)', async () => {
      // Pre-#4147 we tested that the synthetic instruction was popped,
      // but didn't pin the event sequence. After the cap-hit break the
      // outer try-block still reaches `emit('result', ...)`, so the
      // turn ends cleanly: ONE non-fatal MAX_TOOL_ROUNDS_REACHED error
      // (fatal: false), ONE result event with the cap-hit round's
      // stop_reason (tool_use), and NO STREAM_ERROR event. Pin both
      // shape and count so a future refactor that accidentally double-
      // emits or escalates to STREAM_ERROR fails loudly.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              throw new Error('summary-init failed')
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capErrs = errs.filter((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const streamErrs = errs.filter((e) => e.payload?.code === 'STREAM_ERROR')
      const aborts = errs.filter((e) => e.payload?.code === 'ABORT')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(capErrs.length, 1, 'exactly one MAX_TOOL_ROUNDS_REACHED error must fire')
      assert.equal(capErrs[0].payload.fatal, false, 'cap-hit error must be non-fatal')
      assert.equal(streamErrs.length, 0, 'init failure must NOT escalate to STREAM_ERROR')
      assert.equal(aborts.length, 0, 'init failure is not an abort')
      assert.equal(results.length, 1, 'turn must still emit exactly one result event after the break')
      assert.equal(results[0].payload.stopReason, 'tool_use',
        'result reflects the cap-hit round (no summary ran)')
      assert.equal(session._isBusy, false, 'session must be released after the break')
      await session.destroy()
    })

    it('swallows APIUserAbortError on summary stream-init — does NOT fire ABORT (#4170)', async () => {
      // Pin the current contract for the narrow window between the cap-
      // hit error emit (~L456) and summary stream-init (~L482): if the
      // user aborts in this gap the SDK throws APIUserAbortError, which
      // normally _emitTurnError routes to ABORT. But it hits the inner
      // try/catch around the stream-init (L494) BEFORE reaching the
      // outer catch — so the abort is swallowed: the instruction is
      // popped, a warning logs, and the loop breaks. No ABORT event,
      // no STREAM_ERROR. The turn ends via the existing result+stream_end
      // emits identical to the sync init-fail path (#4147).
      //
      // Whether that's the right contract is a separate question (the
      // issue invites that conversation). This test pins the behaviour
      // so any future change in the inner catch surfaces deliberately.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Summary stream-init throws APIUserAbortError synchronously.
              // Simulates the SDK's behaviour when signal is already aborted
              // at the call site.
              throw new APIUserAbortError({ message: 'Request was aborted.' })
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_ag', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capErrs = errs.filter((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const streamErrs = errs.filter((e) => e.payload?.code === 'STREAM_ERROR')
      const aborts = errs.filter((e) => e.payload?.code === 'ABORT')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(capErrs.length, 1, 'exactly one MAX_TOOL_ROUNDS_REACHED must fire')
      assert.equal(capErrs[0].payload.fatal, false, 'cap-hit error must be non-fatal')
      assert.equal(aborts.length, 0,
        'APIUserAbortError swallowed by inner catch — no ABORT event surfaces (current contract)')
      assert.equal(streamErrs.length, 0,
        'init failure must NOT escalate to STREAM_ERROR even when the cause is an abort')
      assert.equal(results.length, 1, 'turn must still emit exactly one result event after the break')
      assert.equal(results[0].payload.stopReason, 'tool_use',
        'result reflects the cap-hit round (no summary ran)')
      assert.equal(session._isBusy, false, 'session must be released after the break')
      await session.destroy()
    })

    it('treats abort during summary for-await as ABORT, not STREAM_ERROR (#4147)', async () => {
      // The existing async-rejection test throws a plain Error and
      // asserts STREAM_ERROR. #4147 asks us to also pin the abort
      // path: when the user interrupts mid-summary the for-await
      // throws APIUserAbortError, which _emitTurnError must route to
      // ABORT (instanceof check). Both MAX_TOOL_ROUNDS_REACHED and
      // ABORT fire, history is truncated, and the session is reusable.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Summary round: simulate the user pressing Stop —
              // for-await throws APIUserAbortError.
              return {
                async *[Symbol.asyncIterator]() {
                  throw new APIUserAbortError({ message: 'Request was aborted.' })
                },
                async finalMessage() { throw new Error('never reached') },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_y', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const historyBefore = session._history.length
      const captured = captureEvents(session)
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      assert.ok(errs.some((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED'),
        'cap-hit error fires before the abort')
      assert.ok(errs.some((e) => e.payload?.code === 'ABORT'),
        'APIUserAbortError must route to ABORT, not STREAM_ERROR')
      assert.equal(errs.filter((e) => e.payload?.code === 'STREAM_ERROR').length, 0,
        'abort path must not also fire STREAM_ERROR')
      assert.equal(session._history.length, historyBefore,
        'history must roll back to pre-send length on abort')
      assert.equal(session._isBusy, false, 'session must be released so the user can send again')

      // Session usable after: the real bug this guards against is
      // _isBusy left true / _abortController not nulled after abort
      // (then the next sendMessage short-circuits with 'Already
      // processing' per byok-session.js:_finishTurn). Swap the stream
      // stub so the assertion isolates session reusability, not the
      // cap-hit path's stub behaviour.
      session._client.messages.stream = () => fakeStream(
        [
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ],
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
      )
      const captured2 = captureEvents(session)
      await session.sendMessage('still here?')
      assert.ok(captured2.some((e) => e.name === 'result'), 'next turn after abort must succeed')
      await session.destroy()
    })

    it('rolls back the entire turn when the summary stream rejects async (outer catch — review)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      const historyBefore = []
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Stream init succeeds but async iteration throws.
              return {
                async *[Symbol.asyncIterator]() {
                  throw new Error('async network error in summary stream')
                },
                async finalMessage() { throw new Error('never reached') },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      historyBefore.push(...session._history)
      const captured = captureEvents(session)
      await session.sendMessage('go')
      // Outer catch should have truncated the WHOLE turn — the user's
      // original prompt + every assistant/tool_result pair.
      assert.equal(session._history.length, historyBefore.length,
        'history must roll back to pre-send length on async summary failure')
      // A STREAM_ERROR should also be emitted (from _emitTurnError).
      const errs = captured.filter((e) => e.name === 'error')
      assert.ok(errs.some((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED'),
        'cap-hit error fires before the failure')
      assert.ok(errs.some((e) => e.payload?.code === 'STREAM_ERROR'),
        'async failure escalates to STREAM_ERROR')
      await session.destroy()
    })

    it('rolls back the turn when summary finalMessage() rejects non-abort async (#4169)', async () => {
      // Parallels the for-await async-rejection test, but exercises the
      // distinct branch where for-await drains cleanly and only
      // `await summaryStream.finalMessage()` rejects (e.g. network drop
      // after the last event, JSON parse failure on the final frame).
      // The outer catch must still truncate history + emit STREAM_ERROR.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Summary round: for-await drains a delta cleanly, then
              // finalMessage() rejects with a non-abort error.
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
                  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
                },
                async finalMessage() {
                  throw new Error('finalMessage network drop')
                },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_fm', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const historyBefore = session._history.length
      const captured = captureEvents(session)
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capIdx = errs.findIndex((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const streamErrIdx = errs.findIndex((e) => e.payload?.code === 'STREAM_ERROR')
      assert.notEqual(capIdx, -1, 'cap-hit error must fire')
      assert.notEqual(streamErrIdx, -1, 'finalMessage non-abort rejection must escalate to STREAM_ERROR')
      assert.ok(capIdx < streamErrIdx,
        'cap-hit error must fire BEFORE the finalMessage rejection (order matters)')
      assert.equal(errs.filter((e) => e.payload?.code === 'ABORT').length, 0,
        'non-abort rejection must NOT route to ABORT')
      assert.equal(session._history.length, historyBefore,
        'history must roll back to pre-send length when finalMessage rejects async')
      assert.equal(session._isBusy, false, 'session must be released after rollback')
      await session.destroy()
    })

    it('routes summary finalMessage() APIUserAbortError to ABORT, not STREAM_ERROR (#4169)', async () => {
      // The mirror of the for-await abort test (#4147), but on the
      // finalMessage() branch. Real SDKs can reject finalMessage with
      // APIUserAbortError if the user pressed Stop after the last event
      // streamed in but before the final frame parsed. _emitTurnError's
      // instanceof check must still route to ABORT.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
                  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
                },
                async finalMessage() {
                  throw new APIUserAbortError({ message: 'Request was aborted.' })
                },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_fma', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const historyBefore = session._history.length
      const captured = captureEvents(session)
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capIdx = errs.findIndex((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const abortIdx = errs.findIndex((e) => e.payload?.code === 'ABORT')
      assert.notEqual(capIdx, -1, 'cap-hit error must fire')
      assert.notEqual(abortIdx, -1, 'finalMessage APIUserAbortError must route to ABORT')
      assert.ok(capIdx < abortIdx,
        'cap-hit error must fire BEFORE the ABORT from finalMessage (order matters)')
      assert.equal(errs.filter((e) => e.payload?.code === 'STREAM_ERROR').length, 0,
        'abort path on finalMessage must NOT escalate to STREAM_ERROR')
      assert.equal(session._history.length, historyBefore,
        'history must roll back on abort')
      assert.equal(session._isBusy, false, 'session must be released')
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

    describe('end-to-end real executor coverage (#4065)', () => {
      // These tests prove the seam between byok-session._executeToolBlock
      // and the real executeBuiltinTool in byok-tool-executor.js. Prior
      // tests in this file stub _executeToolBlock entirely — they would
      // pass even if the dispatch / permission-gate / result-shape
      // contract between the two modules broke. Here, we DON'T stub
      // anything below the agent loop: real cwd, real permission flow
      // (auto-allow), real Read tool, real file ops.

      let workspace
      beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'chroxy-byok-e2e-'))
      })
      afterEach(() => {
        rmSync(workspace, { recursive: true, force: true })
      })

      it('reads a real file via the unstubbed executor and feeds its content to the next round', async () => {
        // Plant a known file in a real workspace dir.
        const targetPath = join(workspace, 'note.txt')
        const fileBody = 'this came from a real file on disk\nline two'
        writeFileSync(targetPath, fileBody)

        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto') // auto-allow so no UI handshake
        // IMPORTANT: do NOT stub session._executeToolBlock. We want the
        // real dispatch + permission gate + executor + tool_result return.
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_a', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'please read note.txt' })

        // Assert the tool_result the model received on the next round
        // contains the REAL file content from disk (not a stubbed value).
        assert.ok(toolResultBlock, 'round 2 must include a tool_result content block')
        assert.equal(toolResultBlock.tool_use_id, 'toolu_a')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /this came from a real file on disk/)
        assert.match(toolResultBlock.content, /line two/)
        await session.destroy()
      })

      it('propagates is_error: true to the next round when the real Read fails (nonexistent file)', async () => {
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_b', name: 'Read',
          input: { file_path: join(workspace, 'does-not-exist.txt') },
        }, { prompt: 'please read a missing file' })

        assert.ok(toolResultBlock, 'failure tool_result must propagate to next round')
        assert.equal(toolResultBlock.is_error, true, 'a missing-file Read must surface as is_error: true')
        await session.destroy()
      })

      it('writes a real file via the unstubbed executor (Write seam) (#4150)', async () => {
        const targetPath = join(workspace, 'fresh.txt')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_w', name: 'Write',
          input: { file_path: targetPath, content: 'planted on disk' },
        }, { prompt: 'write a note' })
        assert.ok(toolResultBlock, 'Write must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /Wrote 15 bytes/)
        assert.match(toolResultBlock.content, /\(created\)/)
        // The file must actually exist on disk with the planted content.
        assert.equal(readFileSync(targetPath, 'utf8'), 'planted on disk')
        await session.destroy()
      })

      it('edits a real file via the unstubbed executor (Edit seam) (#4150)', async () => {
        const targetPath = join(workspace, 'edit-me.txt')
        writeFileSync(targetPath, 'before:keep:after')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_e', name: 'Edit',
          input: { file_path: targetPath, old_string: 'keep', new_string: 'KEPT' },
        }, { prompt: 'do the edit' })
        assert.ok(toolResultBlock, 'Edit must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /Replaced 1 occurrence/)
        assert.equal(readFileSync(targetPath, 'utf8'), 'before:KEPT:after')
        await session.destroy()
      })

      it('runs a Bash command via the unstubbed executor and feeds stdout back (#4150)', async () => {
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_b', name: 'Bash', input: { command: 'echo bash-seam-ok' },
        }, { prompt: 'run echo' })
        assert.ok(toolResultBlock, 'Bash must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /bash-seam-ok/)
        // Bash result includes the exit-footer the model relies on.
        assert.match(toolResultBlock.content, /exit=0/)
        await session.destroy()
      })

      it('redacts ANTHROPIC_API_KEY from the Bash subprocess environment (#4150 secret denylist)', async () => {
        // ANTHROPIC_API_KEY is already 'sk-ant-test-key-fixture' from the
        // outer beforeEach. Bash's safe-env builder must strip it before
        // spawning so `env` inside Bash never sees it.
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_secret', name: 'Bash', input: { command: 'env' },
        }, { prompt: 'dump env' })
        assert.ok(toolResultBlock, 'Bash env dump must produce a tool_result')
        // The fixture key MUST NOT appear in stdout — the safe-env builder
        // drops it before spawn.
        assert.equal(toolResultBlock.content.includes('sk-ant-test-key-fixture'), false,
          'ANTHROPIC_API_KEY must not leak into Bash subprocess env')
        await session.destroy()
      })

      it('lists files via the unstubbed Glob executor (#4150)', async () => {
        writeFileSync(join(workspace, 'a.txt'), '1')
        writeFileSync(join(workspace, 'b.txt'), '2')
        writeFileSync(join(workspace, 'c.md'), '3')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_g', name: 'Glob', input: { pattern: '*.txt' },
        }, { prompt: 'find txt files' })
        assert.ok(toolResultBlock, 'Glob must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /a\.txt/)
        assert.match(toolResultBlock.content, /b\.txt/)
        assert.equal(toolResultBlock.content.includes('c.md'), false, '*.txt glob must not include c.md')
        await session.destroy()
      })

      it('greps real file contents via the unstubbed executor (#4150)', async () => {
        writeFileSync(join(workspace, 'haystack.txt'), 'alpha\nNEEDLE-here\ngamma\n')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_grep', name: 'Grep', input: { pattern: 'NEEDLE' },
        }, { prompt: 'grep for it' })
        assert.ok(toolResultBlock, 'Grep must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /haystack\.txt/)
        assert.match(toolResultBlock.content, /NEEDLE-here/)
        await session.destroy()
      })

      it('surfaces a Permission gate error tool_result when handlePermission throws (#4151)', async () => {
        // byok-session._executeToolBlock wraps handlePermission in
        // try/catch and converts thrown errors to is_error: true with
        // 'Permission gate error: ...' content. Inject a permission
        // manager whose handlePermission rejects (e.g. timeout/abort)
        // and assert the next round sees that shape.
        const session = new ClaudeByokSession({ cwd: workspace })
        // Override after construction — _permissions was wired in the
        // constructor; we replace it before runOneToolRound() starts.
        session._permissions.handlePermission = async () => {
          throw new Error('simulated gate failure')
        }
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_pg', name: 'Read',
          input: { file_path: join(workspace, 'whatever.txt') },
        }, { prompt: 'try a read' })
        assert.ok(toolResultBlock, 'permission-gate throw must still produce a tool_result')
        assert.equal(toolResultBlock.is_error, true)
        assert.match(toolResultBlock.content, /Permission gate error/)
        assert.match(toolResultBlock.content, /simulated gate failure/)
        await session.destroy()
      })

      it('acceptEdits mode auto-approves Read through the real executor (#4151)', async () => {
        // acceptEdits is one of four permission modes (#3729); for tools
        // in ACCEPT_EDITS_TOOLS it short-circuits the prompt path and
        // auto-allows. Exercising the seam end-to-end proves the
        // mode-to-decision-to-executor flow works.
        const targetPath = join(workspace, 'accept-edits.txt')
        writeFileSync(targetPath, 'accept-edits-content')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('acceptEdits')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_ae', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'read it' })
        assert.ok(toolResultBlock, 'acceptEdits Read must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /accept-edits-content/)
        await session.destroy()
      })

      it('session rule decision=allow auto-approves Read through the real executor (#4151)', async () => {
        // Default permission mode (approve) requires a prompt unless a
        // session rule matches. Setting a rule for Read should short-
        // circuit the prompt path and let the real executor run.
        const targetPath = join(workspace, 'rule-allow.txt')
        writeFileSync(targetPath, 'rule-allow-content')
        const session = new ClaudeByokSession({ cwd: workspace })
        session._permissions.setRules([{ tool: 'Read', decision: 'allow' }])
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_ra', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'read via rule' })
        assert.ok(toolResultBlock, 'allow-rule Read must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /rule-allow-content/)
        await session.destroy()
      })

      it('session rule decision=deny refuses Read with a deny tool_result (#4151)', async () => {
        // The mirror of the allow case: a deny rule short-circuits to a
        // denied tool_result without invoking the executor at all. The
        // file content must NOT be in the result.
        const targetPath = join(workspace, 'rule-deny.txt')
        writeFileSync(targetPath, 'should-not-appear')
        const session = new ClaudeByokSession({ cwd: workspace })
        session._permissions.setRules([{ tool: 'Read', decision: 'deny' }])
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_rd', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'read via deny rule' })
        assert.ok(toolResultBlock, 'deny-rule must still produce a tool_result')
        assert.equal(toolResultBlock.is_error, true)
        assert.equal(toolResultBlock.content.includes('should-not-appear'), false,
          'deny rule must short-circuit BEFORE the executor reads the file')
        await session.destroy()
      })

      it('refuses a path-traversal attempt via the real path-safety check', async () => {
        // Real executor enforces validatePathWithinCwd. Asking for
        // /etc/passwd should produce is_error: true with a recognisable
        // message, even with permission set to auto-allow.
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_c', name: 'Read', input: { file_path: '/etc/passwd' },
        }, { prompt: 'try to escape' })

        assert.ok(toolResultBlock)
        assert.equal(toolResultBlock.is_error, true, 'path-outside-workspace must be is_error')
        assert.match(toolResultBlock.content, /outside workspace/i)
        await session.destroy()
      })
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

    it('destroy() clears the todo Map (#4137)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session._todos.set('t1', { id: 't1', content: 'work', status: 'pending' })
      session._todos.set('t2', { id: 't2', content: 'more work', status: 'in_progress' })
      assert.equal(session._todos.size, 2)
      await session.destroy()
      assert.equal(session._todos.size, 0)
    })

    it('destroy() clears _cwdRealCache and _pricingWarnedModels (#4153)', async () => {
      // Mirror #4137's teardown shape — every in-memory collection on
      // this session should be reset at destroy so a held reference
      // (debugger, future export feature, test introspection) doesn't
      // outlive the session. Neither is a leak risk (both are bounded)
      // but the rationale that motivated _todos.clear() in #4152 applies
      // equally here.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session._cwdRealCache.set('/tmp/a', { resolved: '/tmp/a', verifiedAt: Date.now() })
      session._cwdRealCache.set('/tmp/b', { resolved: '/tmp/b', verifiedAt: Date.now() })
      session._pricingWarnedModels.add('claude-future-model-1')
      session._pricingWarnedModels.add('claude-future-model-2')
      assert.equal(session._cwdRealCache.size, 2)
      assert.equal(session._pricingWarnedModels.size, 2)
      await session.destroy()
      assert.equal(session._cwdRealCache.size, 0, '_cwdRealCache cleared')
      assert.equal(session._pricingWarnedModels.size, 0, '_pricingWarnedModels cleared')
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
