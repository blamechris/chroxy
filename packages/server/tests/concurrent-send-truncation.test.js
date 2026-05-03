import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { CliSession } from '../src/cli-session.js'

/**
 * Regression coverage for the dogfooding handoff Issue 3 (concurrent-send
 * response truncation).
 *
 * Symptom (observed in dogfooding): in-flight assistant response was
 * persisted with only ~2 KB of content instead of the actual ~thousands of
 * chars that streamed. The handoff hypothesis was that `_pendingStreams` for
 * the in-flight messageId was being racy-flushed when a concurrent send
 * arrived — the user's "Uh oh" message hit the server mid-stream, was
 * correctly rejected by the `_isBusy` guard at `cli-session.js:386`, but the
 * preceding response had already been truncated in history.
 *
 * These tests pin down the unit-level behaviours of the suspected paths.
 * **All currently pass**, which means the suspected paths are NOT the cause:
 *
 *  - SessionMessageHistory.recordUserInput does not touch _pendingStreams.
 *  - CliSession._isBusy guard rejects the concurrent send without any
 *    side-effect on _currentMessageId, _currentCtx, or emitted events.
 *  - The CliSession → SessionMessageHistory integration preserves the full
 *    accumulated content end-to-end, even with a concurrent rejected send
 *    interleaved.
 *
 * If a future change to any of those paths re-introduces the truncation,
 * these tests will fail and pinpoint the regression. If the dogfooding
 * truncation is encountered again, the cause is somewhere ELSE in the chain
 * — start by ruling out: (a) actual claude CLI process emitting fewer chars
 * (network/API truncation upstream of the server), (b) an unaccounted SIGINT
 * path, (c) a server-fork or branch where stream_start fires twice for the
 * same messageId (covered by the regression-sentinel test below).
 *
 * Already ruled out by code-read (no test needed):
 *  - ws-broadcaster.js — broadcasts WS messages to clients, never touches
 *    _pendingStreams or history. Can't truncate.
 *  - WS message routing / handler dispatch — handleInput records the
 *    user_input via SessionMessageHistory and calls sendMessage; nothing
 *    in between touches the in-flight stream's accumulator.
 */
describe('concurrent-send truncation (handoff Issue 3 / #3163)', () => {
  let history

  beforeEach(() => {
    history = new SessionMessageHistory({ maxHistory: 50 })
  })

  // ---------------------------------------------------------------------------
  // SessionMessageHistory layer — _pendingStreams behaviour under concurrent
  // recordUserInput. Path: handlers/input-handlers.js:100 records the
  // user_input BEFORE calling sendMessage, even when sendMessage will reject
  // with _isBusy. Verify that recording a user_input mid-stream does NOT
  // touch _pendingStreams[key] for the in-flight response.
  // ---------------------------------------------------------------------------
  describe('SessionMessageHistory: pure-history layer', () => {
    it('preserves full stream content when a concurrent user_input is recorded mid-stream', () => {
      // Set up an in-flight stream
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-6' })

      // First batch of deltas
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-6', delta: 'long response part 1\n' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-6', delta: 'continuing the response with PR + 2 issue summaries\n' })

      // CONCURRENT user_input arrives mid-stream — the rejected send that
      // triggered the bug. handleInput records this BEFORE the _isBusy guard
      // rejects sendMessage.
      history.recordUserInput('s1', 'Uh oh it just sent the same messages I sent before out of order')

      // More stream deltas after the concurrent input was recorded
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-6', delta: 'lots more content\n' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-6', delta: 'totaling thousands of chars' })

      // Stream ends normally
      const result = history.recordHistory('s1', 'stream_end', { messageId: 'msg-6' })
      assert.equal(result.persistNeeded, true)

      // The persisted response should include ALL deltas — concurrent
      // user_input should not have truncated _pendingStreams.
      const responses = history.getHistory('s1').filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 1)
      const expected = 'long response part 1\ncontinuing the response with PR + 2 issue summaries\nlots more content\ntotaling thousands of chars'
      assert.equal(responses[0].content, expected)
    })

    it('stream_end with no prior deltas does not push an empty entry (matches pre-existing behaviour)', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-7' })
      history.recordHistory('s1', 'stream_end', { messageId: 'msg-7' })
      const responses = history.getHistory('s1').filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 0)
    })

    it('multiple concurrent user_inputs while a stream is in flight all get recorded without truncating the stream', () => {
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-8' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-8', delta: 'A' })
      history.recordUserInput('s1', 'first concurrent')
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-8', delta: 'B' })
      history.recordUserInput('s1', 'second concurrent')
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-8', delta: 'C' })
      history.recordHistory('s1', 'stream_end', { messageId: 'msg-8' })

      const all = history.getHistory('s1')
      const responses = all.filter((e) => e.type === 'message' && e.messageType === 'response')
      const userInputs = all.filter((e) => e.type === 'message' && e.messageType === 'user_input')
      assert.equal(responses.length, 1)
      assert.equal(responses[0].content, 'ABC')
      assert.equal(userInputs.length, 2)
    })

    it('stream_delta arriving after stream_end is silently ignored (would-be late delta after _pendingStreams.delete)', () => {
      // The _pendingStreams.delete at session-message-history.js:178 happens on
      // stream_end. If a delta arrives after that delete (e.g. from a delayed
      // network packet or out-of-order CLI event), the existing-undefined
      // guard at line 165 silently drops it.
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-9' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-9', delta: 'first' })
      history.recordHistory('s1', 'stream_end', { messageId: 'msg-9' })

      // Late delta — should be silently dropped, NOT truncate the previously
      // persisted entry.
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-9', delta: 'late' })

      const responses = history.getHistory('s1').filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 1)
      assert.equal(responses[0].content, 'first')
      // Pending state stayed clear — the late delta didn't reanimate the key.
      assert.equal(history.pendingStreams.has('s1:msg-9'), false)
    })

    it('a SECOND stream_start for the same messageId resets the accumulator (potential truncation path)', () => {
      // This is suspicious behaviour worth pinning: if any code path ever
      // emits stream_start twice for the same messageId, the second
      // _pendingStreams.set(key, '') would wipe the first half of the
      // accumulated content. CliSession guards against this with
      // ctx.hasStreamStarted, but a future regression OR a server fork with a
      // different stream_start emission policy would land here.
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-10' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-10', delta: 'first half (will be lost)' })
      // Hypothetical second stream_start — currently unreachable from CliSession but documented here as a regression sentinel.
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-10' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-10', delta: 'second half' })
      history.recordHistory('s1', 'stream_end', { messageId: 'msg-10' })

      const responses = history.getHistory('s1').filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 1)
      // Documenting current behaviour: the second stream_start truncated the first half.
      // If this assertion ever changes, audit cli-session.js / sdk-session.js / event-normalizer.js
      // for any code that could emit stream_start twice in one turn.
      assert.equal(responses[0].content, 'second half')
    })

    it('closePendingStreams discards in-flight content (used by destroySession — expected truncation)', () => {
      // Documents the destroy path: closePendingStreams is called from
      // SessionManager.destroySession and intentionally drops in-flight
      // _pendingStreams content without persisting. Returns the messageIds
      // that were closed so the caller can emit synthetic stream_end.
      history.recordHistory('s1', 'stream_start', { messageId: 'msg-11' })
      history.recordHistory('s1', 'stream_delta', { messageId: 'msg-11', delta: 'partial content' })

      const closed = history.closePendingStreams('s1')
      assert.deepEqual(closed, ['msg-11'])
      assert.equal(history.pendingStreams.has('s1:msg-11'), false)

      // No response was persisted — destroy intentionally drops in-flight content.
      const responses = history.getHistory('s1').filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 0)
    })
  })

  // ---------------------------------------------------------------------------
  // CliSession layer — _isBusy guard interaction. Path:
  // handlers/input-handlers.js:102 calls sendMessage which checks _isBusy at
  // cli-session.js:386. Verify that a rejected send doesn't touch the
  // in-flight response state.
  // ---------------------------------------------------------------------------
  describe('CliSession: _isBusy guard does not touch in-flight stream state', () => {
    function createSession() {
      const session = new CliSession({ cwd: '/tmp' })
      // Simulate post-sendMessage state without spawning a real child process.
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

    it('sendMessage emits "Already processing a message" without touching _currentMessageId or _currentCtx', async () => {
      const session = createSession()
      const errors = []
      session.on('error', (e) => errors.push(e))

      const beforeMessageId = session._currentMessageId
      const beforeCtx = session._currentCtx

      await session.sendMessage('concurrent input that should be rejected')

      assert.equal(errors.length, 1)
      assert.equal(errors[0].message, 'Already processing a message')
      // Critically: _currentMessageId and _currentCtx are unchanged. The
      // in-flight response continues uninterrupted.
      assert.equal(session._currentMessageId, beforeMessageId)
      assert.equal(session._currentCtx, beforeCtx)
      assert.equal(session._isBusy, true)
    })

    it('rejected concurrent send does not emit stream_end or any side-effect on the in-flight response', async () => {
      const session = createSession()
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_end', (d) => events.push({ type: 'stream_end', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))
      // Attach an error listener to catch the rejection — without it Node
      // would throw "Unhandled error" since EventEmitter requires a listener
      // for every emitted error event.
      session.on('error', () => {})

      // Simulate an in-flight stream.
      session._handleEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      })
      session._handleEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'in-flight content' } },
      })

      // Concurrent send is rejected.
      await session.sendMessage('concurrent send')

      // Only the synthetic in-flight events should appear — no stream_end.
      const types = events.map((e) => e.type)
      assert.deepEqual(types, ['stream_start', 'stream_delta'])
      assert.equal(events[1].delta, 'in-flight content')
    })
  })

  // ---------------------------------------------------------------------------
  // Integration: CliSession events flowing into SessionMessageHistory exactly
  // as they would via SessionManager. This pins down whether the truncation
  // can occur via the synthesized event chain alone — without WS layer or
  // broadcaster involvement.
  // ---------------------------------------------------------------------------
  describe('CliSession → SessionMessageHistory integration', () => {
    function wireUp() {
      const sessionId = 's-int'
      const session = new CliSession({ cwd: '/tmp' })
      session._isBusy = true
      session._messageCounter = 1
      session._currentMessageId = 'msg-int-1'
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

      // Mirror the SessionManager → SessionMessageHistory wiring (see
      // session-manager.js _wireSessionEvents). This integration is
      // intentionally minimal: the production proxy path also touches
      // _timeoutManager.touchActivity and re-emits `session_event`, but
      // neither side-effect touches `_pendingStreams` so they can't
      // contribute to the truncation symptom.
      session.on('stream_start', (data) => history.recordHistory(sessionId, 'stream_start', data))
      session.on('stream_delta', (data) => history.recordHistory(sessionId, 'stream_delta', data))
      session.on('stream_end', (data) => history.recordHistory(sessionId, 'stream_end', data))

      return { session, sessionId }
    }

    it('synthesized in-flight stream + concurrent rejected send results in full persisted content', async () => {
      const { session, sessionId } = wireUp()

      // Stream starts and accumulates 5 KB of content.
      session._handleEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      })
      const chunk = 'x'.repeat(1024)
      for (let i = 0; i < 5; i++) {
        session._handleEvent({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } },
        })
      }

      // Concurrent send is rejected mid-stream — _isBusy=true.
      const errors = []
      session.on('error', (e) => errors.push(e))
      await session.sendMessage('rejected')
      assert.equal(errors.length, 1)
      assert.equal(errors[0].message, 'Already processing a message')

      // Stream completes normally.
      session._handleEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
      })
      session._handleEvent({
        type: 'result',
        session_id: 'sdk-1',
        total_cost_usd: 0.01,
        duration_ms: 100,
        usage: {},
      })

      // Verify the full 5 KB content was persisted, not truncated by the
      // rejected concurrent send.
      const responses = history.getHistory(sessionId).filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 1)
      assert.equal(responses[0].content.length, 5 * 1024)
      assert.equal(responses[0].content, chunk.repeat(5))
    })

    it('interrupt mid-stream emits stream_end with whatever accumulated — expected truncation, NOT a bug', async () => {
      const { session, sessionId } = wireUp()
      const child = new EventEmitter()
      child.kill = () => {}
      session._child = child

      session._handleEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      })
      session._handleEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial before interrupt' } },
      })

      // Interrupt fires SIGINT. The 5-second safety timer would force-emit
      // stream_end if claude doesn't respond. Drive that path.
      session.interrupt()
      // Force the safety timeout to fire immediately so the test isn't slow.
      const timer = session._interruptTimer
      session._interruptTimer = null
      clearTimeout(timer)
      // Manually invoke the same logic the timer runs.
      if (session._isBusy) {
        const messageId = session._currentMessageId
        if (session._currentCtx?.hasStreamStarted) {
          session.emit('stream_end', { messageId })
        }
        session._clearMessageState()
      }

      // The persisted response is the partial content — this is the expected
      // behaviour for interrupt, NOT the truncation bug.
      const responses = history.getHistory(sessionId).filter((e) => e.type === 'message' && e.messageType === 'response')
      assert.equal(responses.length, 1)
      assert.equal(responses[0].content, 'partial before interrupt')
    })
  })
})
