import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

    it('surfaces parsed MCP server metadata without spawning tools', async () => {
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          github: {
            command: 'node',
            args: ['github-mcp.js'],
            env: { GITHUB_TOKEN: 'secret' },
          },
        },
      }))
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        model: 'claude-opus-4-7',
        mcpConfigPath: configPath,
      })
      const captured = captureEvents(session)
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      assert.ok(Object.isFrozen(session.mcpServers), 'MCP metadata list is read-only')
      assert.deepEqual(session.mcpServers, [
        {
          name: 'github',
          command: 'node',
          args: ['github-mcp.js'],
          envKeys: ['GITHUB_TOKEN'],
        },
      ])
      assert.deepEqual(session._mcpServerConfigs, [
        {
          name: 'github',
          command: 'node',
          args: ['github-mcp.js'],
          env: { GITHUB_TOKEN: 'secret' },
        },
      ])
      const ready = captured.find((e) => e.name === 'ready')
      assert.ok(ready, 'ready event must fire')
      assert.deepEqual(ready.payload.tools, [], 'foundation slice does not materialize MCP tools yet')
      await session.destroy()
    })

    it('starts cleanly when MCP config is malformed', async () => {
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, '{ bad json')
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      const captured = captureEvents(session)
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      assert.deepEqual(session.mcpServers, [])
      assert.deepEqual(session._mcpServerConfigs, [])
      assert.ok(captured.find((e) => e.name === 'ready'), 'malformed MCP config must not block startup')
      await session.destroy()
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
      // result payload carries duration + usage + stopReason.
      assert.equal(results.length, 1)
      assert.equal(results[0].payload.stopReason, 'end_turn')
      assert.equal(results[0].payload.usage.output_tokens, 4)
      assert.equal(typeof results[0].payload.duration, 'number')
      assert.ok(results[0].payload.duration >= 0)
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
