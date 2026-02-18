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
})
