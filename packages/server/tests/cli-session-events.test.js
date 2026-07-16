import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * Tests for CliSession._handleEvent stream-event handling.
 *
 * We instantiate CliSession without calling start() and manually
 * set up internal state to test event handling in isolation.
 */

function createSession() {
  const session = new CliSession({ cwd: '/tmp' })
  // Simulate post-sendMessage state
  session._isBusy = true
  session._messageCounter = 1
  session._currentMessageId = 'msg-1'
  session._currentCtx = {
    hasStreamStarted: false,
    didStreamText: false,
    assistantTextSeen: 0,
    currentContentBlockType: null,
    currentToolName: null,
    currentToolUseId: null,
    toolInputChunks: '',
    toolInputBytes: 0,
    toolInputOverflow: false,
  }
  return session
}

function toolUseStart(name, id) {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', name, id },
    },
  }
}

function inputJsonDelta(partial_json) {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json },
    },
  }
}

function contentBlockStop() {
  return {
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  }
}

describe('CliSession stream-event handling', () => {
  describe('input_json_delta accumulation', () => {
    it('accumulates chunks within buffer cap', () => {
      const session = createSession()
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))
      session._handleEvent(inputJsonDelta('{"com'))
      session._handleEvent(inputJsonDelta('mand":'))
      session._handleEvent(inputJsonDelta('"ls"}'))

      assert.equal(session._currentCtx.toolInputChunks, '{"command":"ls"}')
      assert.equal(session._currentCtx.toolInputOverflow, false)
    })

    it('ignores non-string partial_json values', () => {
      const session = createSession()
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))
      session._handleEvent(inputJsonDelta('{"a":1}'))
      // Non-string should be ignored
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: 123 },
        },
      })

      assert.equal(session._currentCtx.toolInputChunks, '{"a":1}')
    })
  })

  describe('buffer cap (MAX_TOOL_INPUT_LENGTH)', () => {
    it('discards buffer when accumulated size exceeds cap', () => {
      const session = createSession()
      session.on('error', () => {}) // absorb overflow error event
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      // Fill buffer close to the session's actual cap
      const cap = session._maxToolInput
      const bigChunk = 'x'.repeat(cap - 2000)
      session._handleEvent(inputJsonDelta(bigChunk))
      assert.equal(session._currentCtx.toolInputChunks.length, cap - 2000)
      assert.equal(session._currentCtx.toolInputOverflow, false)

      // This chunk pushes over the cap
      const overflowChunk = 'y'.repeat(3000)
      session._handleEvent(inputJsonDelta(overflowChunk))

      assert.equal(session._currentCtx.toolInputChunks, '')
      assert.equal(session._currentCtx.toolInputOverflow, true)
    })

    it('emits error event on overflow', () => {
      const session = createSession()
      const errors = []
      session.on('error', (data) => errors.push(data))

      session._handleEvent(toolUseStart('AskUserQuestion', 'toolu_1'))

      // Trigger overflow using session's actual cap
      const bigChunk = 'x'.repeat(session._maxToolInput + 1)
      session._handleEvent(inputJsonDelta(bigChunk))

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.includes('Tool input too large'))
      assert.ok(errors[0].message.includes('AskUserQuestion'))
    })

    it('stops accumulating after overflow', () => {
      const session = createSession()
      session.on('error', () => {}) // absorb overflow error event
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      // Trigger overflow using session's actual cap
      const bigChunk = 'x'.repeat(session._maxToolInput + 1)
      session._handleEvent(inputJsonDelta(bigChunk))
      assert.equal(session._currentCtx.toolInputOverflow, true)

      // Subsequent chunks should be ignored
      session._handleEvent(inputJsonDelta('more data'))
      assert.equal(session._currentCtx.toolInputChunks, '')
    })
  })

  describe('AskUserQuestion detection', () => {
    it('emits user_question for valid AskUserQuestion tool_use', () => {
      const session = createSession()
      const events = []
      session.on('user_question', (data) => events.push(data))

      session._handleEvent(toolUseStart('AskUserQuestion', 'toolu_ask1'))

      const input = JSON.stringify({
        questions: [{
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
          ],
          multiSelect: false,
        }],
      })
      session._handleEvent(inputJsonDelta(input))
      session._handleEvent(contentBlockStop())

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_ask1')
      assert.equal(events[0].questions.length, 1)
      assert.equal(events[0].questions[0].question, 'Which approach?')
      assert.equal(session._waitingForAnswer, true)
    })

    it('skips parse when buffer overflowed', () => {
      const session = createSession()
      const events = []
      session.on('user_question', (data) => events.push(data))
      session.on('error', () => {}) // absorb overflow error event

      session._handleEvent(toolUseStart('AskUserQuestion', 'toolu_ask2'))

      // Trigger overflow
      const bigChunk = 'x'.repeat(262145)
      session._handleEvent(inputJsonDelta(bigChunk))
      assert.equal(session._currentCtx.toolInputOverflow, true)

      // content_block_stop should NOT try to parse
      session._handleEvent(contentBlockStop())

      assert.equal(events.length, 0)
      assert.equal(session._waitingForAnswer, false)
    })
  })

  describe('overflow flag reset', () => {
    it('resets overflow flag on new content_block_start', () => {
      const session = createSession()
      session.on('error', () => {}) // absorb overflow error event

      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      // Trigger overflow
      const bigChunk = 'x'.repeat(262145)
      session._handleEvent(inputJsonDelta(bigChunk))
      assert.equal(session._currentCtx.toolInputOverflow, true)

      // Finish this block
      session._handleEvent(contentBlockStop())

      // Start a new tool_use block — overflow and byte counter should reset
      session._handleEvent(toolUseStart('Edit', 'toolu_2'))
      assert.equal(session._currentCtx.toolInputOverflow, false)
      assert.equal(session._currentCtx.toolInputChunks, '')
      assert.equal(session._currentCtx.toolInputBytes, 0)

      // New accumulation should work normally
      session._handleEvent(inputJsonDelta('{"file":"test.js"}'))
      assert.equal(session._currentCtx.toolInputChunks, '{"file":"test.js"}')
    })
  })

  describe('tool_start emission', () => {
    it('emits tool_start on content_block_start for tool_use with the tool id as messageId', () => {
      const session = createSession()
      const events = []
      session.on('tool_start', (data) => events.push(data))

      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      // messageId is the tool's content_block.id, not the turn-level _currentMessageId.
      // Each tool in a multi-tool turn must have a distinct id; sharing the turn-level
      // id collides with the post-tool stream_start and corrupts client message state
      // (ChatView dedup drops bubbles, flushPendingDeltas leaks deltas into tool_use).
      assert.equal(events[0].messageId, 'toolu_1')
      assert.equal(events[0].toolUseId, 'toolu_1')
    })

    it('gives each tool in a multi-tool turn a distinct messageId', () => {
      const session = createSession()
      const events = []
      session.on('tool_start', (data) => events.push(data))

      session._handleEvent(toolUseStart('Bash', 'toolu_a'))
      session._handleEvent(contentBlockStop())
      session._handleEvent(toolUseStart('Bash', 'toolu_b'))
      session._handleEvent(contentBlockStop())
      session._handleEvent(toolUseStart('Read', 'toolu_c'))

      assert.equal(events.length, 3)
      const ids = events.map((e) => e.messageId)
      assert.deepEqual(ids, ['toolu_a', 'toolu_b', 'toolu_c'])
      // Sanity: all distinct, none equals the turn-level _currentMessageId.
      assert.equal(new Set(ids).size, 3)
      assert.ok(!ids.includes('msg-1'))
    })

    it('falls back to a suffixed turn id when content_block.id is missing', () => {
      const session = createSession()
      const events = []
      session.on('tool_start', (data) => events.push(data))

      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Bash' },
        },
      })

      assert.equal(events.length, 1)
      // Both fields reuse the synthesized fallback id so the wire schema
      // (ServerToolStartSchema.toolUseId: z.string()) still holds.
      assert.equal(events[0].messageId, 'msg-1-tool')
      assert.equal(events[0].toolUseId, 'msg-1-tool')
    })

    it('aligns ctx.currentToolUseId with synthesized fallback when content_block.id is missing (#4778)', () => {
      const session = createSession()
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Task' },
        },
      })

      // Without #4778, ctx.currentToolUseId stays undefined on the fallback
      // path and downstream emits (user_question / agent_spawned /
      // _activeAgents.set) propagate toolUseId=undefined while the
      // tool_start wire event already carries `${messageId}-tool`.
      assert.equal(session._currentCtx.currentToolUseId, 'msg-1-tool')
    })

    it('propagates synthesized toolUseId to agent_spawned on Task fallback (#4778)', () => {
      const session = createSession()
      const spawned = []
      session.on('agent_spawned', (info) => spawned.push(info))

      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Task' },
        },
      })
      session._handleEvent(inputJsonDelta('{"description":"do thing","prompt":"x"}'))
      session._handleEvent(contentBlockStop())

      assert.equal(spawned.length, 1)
      assert.equal(spawned[0].toolUseId, 'msg-1-tool')
      // _activeAgents key must match the wire-emitted toolUseId so later
      // lookups (agent_completed, etc.) resolve instead of writing to
      // _activeAgents.set(undefined, ...).
      assert.ok(session._activeAgents.has('msg-1-tool'))
      assert.ok(!session._activeAgents.has(undefined))
    })
  })

  describe('text streaming', () => {
    it('emits stream_start and stream_delta for text blocks', () => {
      const session = createSession()
      const starts = []
      const deltas = []
      session.on('stream_start', (data) => starts.push(data))
      session.on('stream_delta', (data) => deltas.push(data))

      // Start a text block
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' },
        },
      })

      assert.equal(starts.length, 1)
      assert.equal(starts[0].messageId, 'msg-1')

      // Send text deltas
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' },
        },
      })
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' },
        },
      })

      assert.equal(deltas.length, 2)
      assert.equal(deltas[0].delta, 'Hello ')
      assert.equal(deltas[1].delta, 'world')
      assert.equal(session._currentCtx.didStreamText, true)
    })
  })

  describe('content_block_stop cleanup', () => {
    it('clears tool state after content_block_stop', () => {
      const session = createSession()
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))
      session._handleEvent(inputJsonDelta('{"command":"ls"}'))

      assert.equal(session._currentCtx.currentToolName, 'Bash')
      assert.equal(session._currentCtx.currentToolUseId, 'toolu_1')

      session._handleEvent(contentBlockStop())

      assert.equal(session._currentCtx.currentToolName, null)
      assert.equal(session._currentCtx.currentToolUseId, null)
      assert.equal(session._currentCtx.toolInputChunks, '')
    })
  })

  describe('malformed JSON in AskUserQuestion', () => {
    it('does not emit user_question for invalid JSON', () => {
      const session = createSession()
      const events = []
      const errors = []
      session.on('user_question', (data) => events.push(data))

      session._handleEvent(toolUseStart('AskUserQuestion', 'toolu_bad'))
      session._handleEvent(inputJsonDelta('{invalid json'))
      session._handleEvent(contentBlockStop())

      assert.equal(events.length, 0)
      assert.equal(session._waitingForAnswer, false)
    })

    it('still emits when JSON.parse legally returns a falsy value (#4774)', () => {
      // Regression for Copilot review on #4774: gating the
      // post-extraction emit on `if (!parsed)` would silently swallow
      // legal falsy JSON like `0` / `false` / `null`, drifting from the
      // pre-extraction behavior which only short-circuited on parse
      // *failure*, not on falsy parsed values. AskUserQuestion in
      // particular would emit `user_question` with `questions: undefined`
      // pre-extraction; the refactor must preserve that.
      const session = createSession()
      const events = []
      session.on('user_question', (data) => events.push(data))

      session._handleEvent(toolUseStart('AskUserQuestion', 'toolu_falsy'))
      session._handleEvent(inputJsonDelta('0'))
      session._handleEvent(contentBlockStop())

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_falsy')
      assert.equal(events[0].questions, undefined)
      assert.equal(session._waitingForAnswer, true)
    })
  })

  describe('tool_result events', () => {
    it('emits tool_result for user events with tool_result content blocks', () => {
      const session = createSession()
      const results = []
      session.on('tool_result', (data) => results.push(data))

      session._handleEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'file contents here' }],
        },
      })

      assert.equal(results.length, 1)
      assert.equal(results[0].toolUseId, 'toolu_abc')
      assert.equal(results[0].result, 'file contents here')
      assert.equal(results[0].truncated, false)
    })

    it('handles array content in tool_result blocks', () => {
      const session = createSession()
      const results = []
      session.on('tool_result', (data) => results.push(data))

      session._handleEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_def',
            content: [
              { type: 'text', text: 'Line 1' },
              { type: 'text', text: 'Line 2' },
            ],
          }],
        },
      })

      assert.equal(results.length, 1)
      assert.equal(results[0].toolUseId, 'toolu_def')
      assert.equal(results[0].result, 'Line 1\nLine 2')
    })

    it('truncates results exceeding 10KB', () => {
      const session = createSession()
      const results = []
      session.on('tool_result', (data) => results.push(data))

      const largeContent = 'x'.repeat(20000)
      session._handleEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: largeContent }],
        },
      })

      assert.equal(results.length, 1)
      assert.equal(results[0].result.length, 10240)
      assert.equal(results[0].truncated, true)
    })

    it('emits multiple tool_results from a single user event', () => {
      const session = createSession()
      const results = []
      session.on('tool_result', (data) => results.push(data))

      session._handleEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result 1' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'result 2' },
          ],
        },
      })

      assert.equal(results.length, 2)
      assert.equal(results[0].toolUseId, 'toolu_1')
      assert.equal(results[1].toolUseId, 'toolu_2')
    })

    it('skips tool_result blocks without tool_use_id', () => {
      const session = createSession()
      const results = []
      session.on('tool_result', (data) => results.push(data))

      session._handleEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'orphan result' }],
        },
      })

      assert.equal(results.length, 0)
    })

    it('includes toolUseId in tool_start events', () => {
      const session = createSession()
      const events = []
      session.on('tool_start', (data) => events.push(data))

      session._handleEvent(toolUseStart('Read', 'toolu_read1'))

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'toolu_read1')
      assert.equal(events[0].tool, 'Read')
    })
  })

  describe('sendMessage applies transforms', () => {
    function createMockChild() {
      const child = new EventEmitter()
      child.stdin = { write: () => {}, end: () => {} }
      child._stdinData = []
      child.stdin.write = (data) => child._stdinData.push(data)
      return child
    }

    it('applies voiceCleanup when configured and isVoice is true', () => {
      const session = new CliSession({ cwd: '/tmp', transforms: ['voiceCleanup'] })
      session._processReady = true
      const child = createMockChild()
      session._child = child

      session.sendMessage('um fix the bug', [], { isVoice: true })

      assert.equal(child._stdinData.length, 1)
      const parsed = JSON.parse(child._stdinData[0].replace(/\n$/, ''))
      // voiceCleanup should remove "um" and add period
      assert.equal(parsed.message.content[0].text, 'fix the bug.')

      session.destroy()
    })

    it('passes through unchanged when no transforms configured', () => {
      const session = new CliSession({ cwd: '/tmp' })
      session._processReady = true
      const child = createMockChild()
      session._child = child

      session.sendMessage('um fix the bug', [])

      const parsed = JSON.parse(child._stdinData[0].replace(/\n$/, ''))
      assert.equal(parsed.message.content[0].text, 'um fix the bug')

      session.destroy()
    })
  })

  describe('assistant event streaming fallback', () => {
    it('derives streaming from incremental assistant text', () => {
      const session = createSession()
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))

      // First assistant event — partial text
      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      })

      assert.equal(events.length, 2)
      assert.equal(events[0].type, 'stream_start')
      assert.equal(events[0].messageId, 'msg-1')
      assert.equal(events[1].type, 'stream_delta')
      assert.equal(events[1].delta, 'Hello')

      // Second assistant event — more text
      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      })

      assert.equal(events.length, 3)
      assert.equal(events[2].type, 'stream_delta')
      assert.equal(events[2].delta, ' world')

      session.destroy()
    })

    it('skips assistant text when stream_event deltas already active', () => {
      const session = createSession()
      const messages = []
      session.on('stream_delta', (d) => messages.push(d))

      // Simulate stream_event already set didStreamText
      session._currentCtx.didStreamText = true
      session._currentCtx.hasStreamStarted = true

      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      })

      // No delta should be emitted from assistant event
      assert.equal(messages.length, 0)

      session.destroy()
    })

    it('does not emit for empty or missing text blocks', () => {
      const session = createSession()
      const events = []
      session.on('stream_start', () => events.push('start'))
      session.on('stream_delta', () => events.push('delta'))

      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '' }] },
      })

      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      })

      assert.equal(events.length, 0)

      session.destroy()
    })

    it('emits only the new portion on each incremental update', () => {
      const session = createSession()
      const deltas = []
      session.on('stream_delta', (d) => deltas.push(d.delta))

      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'A' }] },
      })
      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'AB' }] },
      })
      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ABC' }] },
      })

      assert.deepEqual(deltas, ['A', 'B', 'C'])

      session.destroy()
    })

    it('emits stream_start only once across multiple assistant events', () => {
      const session = createSession()
      const starts = []
      session.on('stream_start', () => starts.push(true))

      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi' }] },
      })
      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi there' }] },
      })

      assert.equal(starts.length, 1)

      session.destroy()
    })

    it('handles multiple text blocks in a single assistant event', () => {
      const session = createSession()
      const deltas = []
      session.on('stream_delta', (d) => deltas.push(d.delta))

      session._handleEvent({
        type: 'assistant',
        message: { content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'text', text: ' world' },
        ] },
      })

      // Both text blocks concatenated: "Hello world" (11 chars)
      assert.equal(deltas.length, 1)
      assert.equal(deltas[0], 'Hello world')
      assert.equal(session._currentCtx.assistantTextSeen, 11)

      session.destroy()
    })

    it('does not emit when messageId is null', () => {
      const session = createSession()
      session._currentMessageId = null
      const events = []
      session.on('stream_start', () => events.push('start'))
      session.on('stream_delta', () => events.push('delta'))

      session._handleEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      })

      assert.equal(events.length, 0)

      session.destroy()
    })
  })

  describe('result fallback for non-streamed text (#5064 — /compact)', () => {
    // The CLI's `/compact` slash command returns the compaction summary in
    // `data.result` but emits either no `assistant` event at all, or one
    // with empty / no-growth text content. Without a fallback the dashboard
    // sees nothing — no stream_start, no message, no acknowledgement.
    // SDK mode mirrors this fallback at sdk-session.js:801.

    it('emits a fallback response message when result text exists and no stream started', () => {
      const session = createSession()
      const messages = []
      const streams = []
      session.on('message', (m) => messages.push(m))
      session.on('stream_start', () => streams.push('start'))
      session.on('stream_end', () => streams.push('end'))

      // Simulate /compact: result arrives directly with summary text,
      // no stream_event, no assistant event with non-empty text.
      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        result: 'Conversation compacted to summary.',
        total_cost_usd: 0,
        duration_ms: 100,
        usage: {},
      })

      assert.equal(messages.length, 1)
      assert.equal(messages[0].type, 'response')
      assert.equal(messages[0].content, 'Conversation compacted to summary.')
      // No stream_start / stream_end — pure fallback path.
      assert.equal(streams.length, 0)
    })

    it('does not emit fallback when a stream already fired (normal streamed turn)', () => {
      const session = createSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      // Simulate normal streamed turn: stream_event drives text delta,
      // then result arrives with the same text echoed in data.result.
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' },
        },
      })
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streamed reply' },
        },
      })
      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        result: 'streamed reply',
        total_cost_usd: 0,
        duration_ms: 100,
        usage: {},
      })

      // Streamed turns must NOT double-emit a fallback message —
      // the stream_delta is the canonical surface for the text.
      assert.equal(messages.length, 0)
    })

    it('exposes the streamed reply via stream_delta on a normal streamed turn (#5090)', () => {
      // Companion to the no-fallback case above. The `messages.length === 0`
      // assertion only proves the fallback was suppressed — it does NOT prove
      // the consumer sees the streamed text. Without this companion, a future
      // regression where `stream_delta` is silently dropped AND the fallback
      // is also suppressed would still pass the no-fallback test (both bugs
      // would cancel out and the consumer would see nothing).
      //
      // Pin that the concatenated `stream_delta` chunks compose the final
      // response text the consumer would render.
      const session = createSession()
      const messages = []
      const streamDeltas = []
      session.on('message', (m) => messages.push(m))
      session.on('stream_delta', (d) => streamDeltas.push(d.delta))

      // Same wire sequence as the no-fallback case, but split the text across
      // two deltas so we also pin that concatenation order is preserved.
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' },
        },
      })
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streamed ' },
        },
      })
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'reply' },
        },
      })
      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        result: 'streamed reply',
        total_cost_usd: 0,
        duration_ms: 100,
        usage: {},
      })

      // Primary contract (mirrors the no-fallback case): no synthesized
      // response message on streamed turns.
      assert.equal(messages.length, 0)
      // New contract: the streamed text reached the consumer via stream_delta,
      // and the concatenated chunks equal the canonical reply text.
      assert.equal(streamDeltas.length, 2)
      assert.equal(streamDeltas.join(''), 'streamed reply')
    })

    it('does not emit fallback when data.result is empty or missing', () => {
      const session = createSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      // Result with no `result` field at all (e.g. error subtype, tool turn).
      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        total_cost_usd: 0,
        duration_ms: 100,
        usage: {},
      })

      assert.equal(messages.length, 0)

      // Result with empty string `result`.
      session._currentMessageId = 'msg-2'
      session._currentCtx = {
        hasStreamStarted: false,
        didStreamText: false,
        assistantTextSeen: 0,
        currentContentBlockType: null,
        currentToolName: null,
        currentToolUseId: null,
        toolInputChunks: '',
        toolInputBytes: 0,
        toolInputOverflow: false,
      }
      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        result: '',
        total_cost_usd: 0,
        duration_ms: 100,
        usage: {},
      })

      assert.equal(messages.length, 0)
    })

    it('emits a result event regardless of fallback path', () => {
      const session = createSession()
      const results = []
      session.on('result', (r) => results.push(r))

      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        result: 'Conversation compacted.',
        total_cost_usd: 0.001,
        duration_ms: 250,
        usage: { input_tokens: 10 },
      })

      assert.equal(results.length, 1)
      assert.equal(results[0].sessionId, 'sess-1')
      assert.equal(results[0].cost, 0.001)
      assert.equal(results[0].duration, 250)
    })

    it('forwards the full usage payload on streamed turns, with no fallback message (#5095)', () => {
      // Companion pin to #5084's fallback gate. The fallback is suppressed
      // on streamed turns (ctx.hasStreamStarted === true), but we must also
      // prove the `result` event still carries the canonical `usage` payload
      // — input_tokens, output_tokens, cache_creation_input_tokens,
      // cache_read_input_tokens — so the session-manager cost-gate
      // (session-manager.js:1709 → _trackUsage) has the raw token counts to
      // accumulate for the dashboard meter. A regression where #5084's
      // fallback gate swallowed `usage` emission for streamed turns would
      // silently zero the meter for every subscription user. This is the
      // verification gap PR #5087 deferred.
      const session = createSession()
      const messages = []
      const results = []
      session.on('message', (m) => messages.push(m))
      session.on('result', (r) => results.push(r))

      // Drive a normal streamed turn end-to-end.
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' },
        },
      })
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streamed reply' },
        },
      })

      // Subscription-billed result: cost is null (no per-turn $$$), but
      // usage carries real token counts. The `usage` payload here is a
      // representative example of the shape `claude -p` emits on a
      // subscription-billing path (illustrative values, not a captured
      // wire sample).
      const usage = {
        input_tokens: 137,
        output_tokens: 42,
        cache_creation_input_tokens: 1024,
        cache_read_input_tokens: 8192,
      }
      session._handleEvent({
        type: 'result',
        session_id: 'sess-1',
        subtype: 'success',
        result: 'streamed reply',
        total_cost_usd: null,
        duration_ms: 250,
        usage,
      })

      // Primary contract: NO synthetic fallback message on streamed turns.
      // The stream_delta is the canonical surface for the text — a fallback
      // here would double-emit the reply.
      assert.equal(messages.length, 0)

      // Canonical contract: the `result` event the session-manager listens
      // for carries the full usage object verbatim. session-manager's
      // _trackUsage reads `resultData.usage.{input_tokens, output_tokens,
      // cache_read_input_tokens, cache_creation_input_tokens}` — pin all
      // four so a future regression that drops a field (e.g. shallow
      // restructure that forgets cache_* keys) fails here, not silently in
      // the meter.
      assert.equal(results.length, 1)
      assert.equal(results[0].sessionId, 'sess-1')
      assert.equal(results[0].cost, null)
      assert.equal(results[0].duration, 250)
      assert.ok(results[0].usage, 'usage must be present on streamed-turn result')
      assert.equal(results[0].usage.input_tokens, 137)
      assert.equal(results[0].usage.output_tokens, 42)
      assert.equal(results[0].usage.cache_creation_input_tokens, 1024)
      assert.equal(results[0].usage.cache_read_input_tokens, 8192)
      // Structural-equality check: the result event must forward a usage
      // object deeply equal to the one the wire payload carried — not a
      // synthesized subset that drops cache fields.
      assert.deepEqual(results[0].usage, usage)
    })
  })

  describe('result fallback for error-subtype text (#5088)', () => {
    // Some `claude -p` result events carry human-readable text in a
    // structured `error.subtype` payload (e.g. permission_denied,
    // usage_limit_exceeded) but never emit a stream_start. Without a
    // dedicated fallback the user sees nothing — same silent-disappear
    // pattern that #5064 fixed for `/compact`. Surface this by emitting a
    // `type: 'error'` message (→ `messageType: 'error'` on the wire) so
    // downstream consumers render it as a distinct error bubble rather
    // than a normal `data.result` reply.
    //
    // The `data.result` path in #5064 takes priority — only fall back
    // to error-subtype text when `data.result` is missing/empty, so we
    // never double-emit for the same turn.
    //
    // Complementary to #5090 (stream_delta pinning) — touch this file
    // additively, don't disturb the existing describe blocks.
    function errorSubtype(text) {
      return {
        type: 'result',
        session_id: 'sess-err',
        subtype: 'error_during_execution',
        error: { subtype: text },
        total_cost_usd: 0,
        duration_ms: 50,
        usage: {},
      }
    }

    it('emits a fallback type=error message when error.subtype text exists and no stream started', () => {
      const session = createSession()
      const messages = []
      const streams = []
      session.on('message', (m) => messages.push(m))
      session.on('stream_start', () => streams.push('start'))
      session.on('stream_end', () => streams.push('end'))

      session._handleEvent(errorSubtype('Permission denied: write to /etc/hosts'))

      assert.equal(messages.length, 1)
      assert.equal(messages[0].type, 'error')
      assert.equal(messages[0].kind, undefined)
      assert.equal(messages[0].content, 'Permission denied: write to /etc/hosts')
      // No stream surfaced for this turn — pure fallback path.
      assert.equal(streams.length, 0)
    })

    it('does not emit error-subtype fallback when a stream already fired', () => {
      const session = createSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      // Normal streamed turn first.
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'text' },
        },
      })
      session._handleEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'streamed reply' },
        },
      })
      // Then a result event with an error subtype echoes alongside.
      session._handleEvent(errorSubtype('Permission denied'))

      // The streamed delta is the canonical surface — don't fall back.
      assert.equal(messages.length, 0)
    })

    it('prefers data.result over error.subtype when both are present', () => {
      const session = createSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      session._handleEvent({
        type: 'result',
        session_id: 'sess-err',
        subtype: 'error_during_execution',
        result: 'Conversation compacted to summary.',
        error: { subtype: 'Permission denied' },
        total_cost_usd: 0,
        duration_ms: 50,
        usage: {},
      })

      // The existing #5064 path wins — don't double-emit.
      assert.equal(messages.length, 1)
      assert.equal(messages[0].type, 'response')
      assert.equal(messages[0].content, 'Conversation compacted to summary.')
      // No `kind` annotation when `data.result` provided the text.
      assert.equal(messages[0].kind, undefined)
    })

    it('does not emit fallback when error.subtype is empty or missing', () => {
      const session = createSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      // No `error` field at all.
      session._handleEvent({
        type: 'result',
        session_id: 'sess-err',
        subtype: 'error_during_execution',
        total_cost_usd: 0,
        duration_ms: 50,
        usage: {},
      })
      assert.equal(messages.length, 0)

      // `error` present but `subtype` empty.
      session._currentMessageId = 'msg-2'
      session._currentCtx = {
        hasStreamStarted: false,
        didStreamText: false,
        assistantTextSeen: 0,
        currentContentBlockType: null,
        currentToolName: null,
        currentToolUseId: null,
        toolInputChunks: '',
        toolInputBytes: 0,
        toolInputOverflow: false,
      }
      session._handleEvent({
        type: 'result',
        session_id: 'sess-err',
        subtype: 'error_during_execution',
        error: { subtype: '' },
        total_cost_usd: 0,
        duration_ms: 50,
        usage: {},
      })
      assert.equal(messages.length, 0)
    })

    it('does not widen to non-result events (system event with error.subtype is ignored)', () => {
      const session = createSession()
      const messages = []
      session.on('message', (m) => messages.push(m))

      // A system event happens to carry an `error.subtype` shaped field —
      // the fallback must remain scoped to `result` events.
      session._handleEvent({
        type: 'system',
        subtype: 'sub_agent_notification',
        error: { subtype: 'should-not-fall-back' },
      })

      // System events emit a `system`-typed message via their own
      // handler, never the error-subtype fallback's `error` bubble.
      const fallbackBubbles = messages.filter((m) => m.type === 'error')
      assert.equal(fallbackBubbles.length, 0)
    })

    it('still emits the result event after the error-subtype fallback fires', () => {
      const session = createSession()
      const results = []
      session.on('result', (r) => results.push(r))

      session._handleEvent(errorSubtype('Permission denied'))

      assert.equal(results.length, 1)
      assert.equal(results[0].sessionId, 'sess-err')
    })
  })
})

// #6692 — the CLI's stream-json result line carries the same modelUsage /
// num_turns / duration_api_ms fields as the SDK (shared runtime); forward
// them normalized, degrading to null on older CLI builds.
describe('per-model usage forwarding (#6692)', () => {
  it('forwards modelUsage/num_turns/duration_api_ms from the result line', () => {
    const session = createSession()
    const results = []
    session.on('result', (r) => results.push(r))
    session._handleEvent({
      type: 'result',
      session_id: 's1',
      subtype: 'success',
      result: 'ok',
      total_cost_usd: 0.01,
      duration_ms: 5,
      duration_api_ms: 3,
      num_turns: 2,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        'claude-opus-4-8': { inputTokens: 1, outputTokens: 1, costUSD: 0.01 },
      },
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].numTurns, 2)
    assert.equal(results[0].apiDurationMs, 3)
    assert.deepEqual(results[0].modelUsage, {
      'claude-opus-4-8': {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        web_search_requests: 0,
        cost_usd: 0.01,
      },
    })
  })

  it('degrades all three fields to null on an older CLI result line', () => {
    const session = createSession()
    const results = []
    session.on('result', (r) => results.push(r))
    session._handleEvent({
      type: 'result',
      session_id: 's1',
      subtype: 'success',
      result: 'ok',
      total_cost_usd: 0,
      duration_ms: 5,
      usage: {},
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].numTurns, null)
    assert.equal(results[0].apiDurationMs, null)
    assert.equal(results[0].modelUsage, null)
  })
})
