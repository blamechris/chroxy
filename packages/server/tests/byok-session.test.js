import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
              const err = new Error('aborted')
              err.name = 'AbortError'
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
      const turn = session.sendMessage('hi')
      setTimeout(() => session.interrupt(), 20)
      await turn
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent, 'interrupt should produce an error event')
      assert.equal(errorEvent.payload.code, 'ABORT')
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
      // Three tool_use blocks. The executor stub aborts the session
      // controller right after the FIRST block returns. Without the
      // fix, history.push would land 1 tool_result for 3 tool_use
      // blocks and the next sendMessage would 400. With the fix, two
      // synthetic is_error: true tool_results fill the gap.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let executeCalls = 0
      session._executeToolBlock = async function ({ block }) {
        executeCalls += 1
        // After block 1 completes, fire the abort so the loop breaks
        // when it re-checks signal.aborted.
        if (executeCalls === 1) {
          this._abortController.abort()
        }
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
        assert.equal(s.is_error, true, 'synthetic tool_result must mark is_error')
        assert.match(s.content, /[Ii]nterrupted/, 'synthetic content should reference the abort')
      }
      await session.destroy()
    })

    it('breaks out of the loop after MAX_TOOL_ROUNDS (infinite-loop safety)', async () => {
      // Model insists on calling a tool on every round — agent loop must
      // bail at the cap and emit result so the session doesn't hang.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'x', is_error: false }
      }
      let callCount = 0
      session._client = {
        messages: {
          stream: () => {
            callCount += 1
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
      assert.ok(callCount <= 25, `expected <= MAX_TOOL_ROUNDS, got ${callCount}`)
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'must emit result even on safety-cap exit')
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
