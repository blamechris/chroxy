import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
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
    currentContentBlockType: null,
    currentToolName: null,
    currentToolUseId: null,
    toolInputChunks: '',
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
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      // Fill buffer close to limit (262144)
      const bigChunk = 'x'.repeat(260000)
      session._handleEvent(inputJsonDelta(bigChunk))
      assert.equal(session._currentCtx.toolInputChunks.length, 260000)
      assert.equal(session._currentCtx.toolInputOverflow, false)

      // This chunk pushes over the cap
      const overflowChunk = 'y'.repeat(3000)
      session._handleEvent(inputJsonDelta(overflowChunk))

      assert.equal(session._currentCtx.toolInputChunks, '')
      assert.equal(session._currentCtx.toolInputOverflow, true)
    })

    it('stops accumulating after overflow', () => {
      const session = createSession()
      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      // Trigger overflow
      const bigChunk = 'x'.repeat(262145)
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

      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      // Trigger overflow
      const bigChunk = 'x'.repeat(262145)
      session._handleEvent(inputJsonDelta(bigChunk))
      assert.equal(session._currentCtx.toolInputOverflow, true)

      // Finish this block
      session._handleEvent(contentBlockStop())

      // Start a new tool_use block — overflow should reset
      session._handleEvent(toolUseStart('Edit', 'toolu_2'))
      assert.equal(session._currentCtx.toolInputOverflow, false)
      assert.equal(session._currentCtx.toolInputChunks, '')

      // New accumulation should work normally
      session._handleEvent(inputJsonDelta('{"file":"test.js"}'))
      assert.equal(session._currentCtx.toolInputChunks, '{"file":"test.js"}')
    })
  })

  describe('tool_start emission', () => {
    it('emits tool_start on content_block_start for tool_use', () => {
      const session = createSession()
      const events = []
      session.on('tool_start', (data) => events.push(data))

      session._handleEvent(toolUseStart('Bash', 'toolu_1'))

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      assert.equal(events[0].messageId, 'msg-1')
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
})
