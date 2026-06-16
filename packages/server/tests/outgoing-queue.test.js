import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BaseSession, OUTGOING_QUEUE_MAX } from '../src/base-session.js'
import { CliSession } from '../src/cli-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { EventNormalizer } from '../src/event-normalizer.js'

/**
 * #5936 (epic #5935): server-authoritative outgoing-message queue.
 *
 * Replaces the SDK's ad-hoc `_pendingInput` (cap 3) and the CLI's mid-turn
 * "Already processing a message" reject with one shared session-level queue on
 * BaseSession: a send-while-busy message ENQUEUES and flushes FIFO on the
 * turn-complete `result` event. These tests pin the queue mechanics
 * (enqueue / flush-FIFO / overflow cap / interrupt policy / mirror events) at
 * the BaseSession layer plus the provider `interrupt()` wiring and the
 * normalizer → wire mapping.
 *
 * None of these construct a SessionManager, so no `stateFilePath` is needed —
 * BaseSession / the providers never touch `~/.chroxy/` here.
 */

// Minimal concrete session: BaseSession's queue methods are provider-agnostic,
// so a tiny subclass that models the provider contract (busy → enqueue; idle →
// send + go busy; turn-complete → clear busy + flush head) exercises the full
// queue lifecycle deterministically without a child process or SDK query.
class FakeSession extends BaseSession {
  constructor(opts = {}) {
    super({ cwd: '/tmp', ...opts })
    this.sent = []
  }

  sendMessage(prompt, attachments, sendOptions) {
    if (this._isBusy) {
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      return
    }
    this._isBusy = true
    this.sent.push({ prompt, sendOptions })
  }

  // Mirror the providers' _clearMessageState / post-turn finally: turn ends,
  // busy clears, the queue head flushes.
  completeTurn() {
    this._isBusy = false
    this.dequeueNextOutgoing()
  }
}

const tick = () => new Promise((resolve) => process.nextTick(resolve))

describe('outgoing-message queue (#5936)', () => {
  describe('enqueue while busy', () => {
    it('enqueues a send-while-busy message and emits message_queued', () => {
      const s = new FakeSession()
      s.sendMessage('first') // goes busy, sent
      assert.equal(s._isBusy, true)
      assert.equal(s.sent.length, 1)

      const queued = []
      s.on('message_queued', (e) => queued.push(e))

      s.sendMessage('follow-up', undefined, { clientMessageId: 'uin-7' })
      assert.equal(s.outgoingQueueLength, 1)
      assert.equal(s.sent.length, 1, 'a queued message is NOT sent immediately')
      assert.equal(queued.length, 1)
      assert.deepEqual(queued[0], { clientMessageId: 'uin-7', text: 'follow-up', queueLength: 1 })
    })

    it('omits clientMessageId from message_queued when none was supplied', () => {
      const s = new FakeSession()
      s.sendMessage('first')
      const queued = []
      s.on('message_queued', (e) => queued.push(e))
      s.sendMessage('follow-up')
      assert.equal(queued[0].clientMessageId, undefined)
      assert.equal(queued[0].text, 'follow-up')
    })
  })

  describe('flush on turn-complete (FIFO)', () => {
    it('flushes queued follow-ups one per turn, in order, emitting message_dequeued', async () => {
      const s = new FakeSession()
      s.sendMessage('a') // busy, sent=[a]
      s.sendMessage('b') // queued
      s.sendMessage('c') // queued
      assert.equal(s.outgoingQueueLength, 2)

      const dequeued = []
      s.on('message_dequeued', (e) => dequeued.push(e))

      // Turn for 'a' completes → flush head 'b'. The message_dequeued(flush)
      // event + the re-dispatch both land on the next tick (so the event only
      // fires when the send actually happens).
      s.completeTurn()
      await tick()
      assert.equal(dequeued.length, 1)
      assert.equal(dequeued[0].reason, 'flush')
      assert.equal(dequeued[0].queueLength, 1, 'queueLength is the count remaining after dequeue')
      assert.deepEqual(s.sent.map((m) => m.prompt), ['a', 'b'])

      // Turn for 'b' completes → flush 'c'.
      s.completeTurn()
      await tick()
      assert.deepEqual(s.sent.map((m) => m.prompt), ['a', 'b', 'c'])

      // Nothing left — a completing turn is a no-op.
      s.completeTurn()
      await tick()
      assert.deepEqual(s.sent.map((m) => m.prompt), ['a', 'b', 'c'])
      assert.equal(dequeued.length, 2, 'exactly two flush events for two queued messages')
    })

    it('preserves the sender clientMessageId through a flush', async () => {
      const s = new FakeSession()
      s.sendMessage('a')
      s.sendMessage('b', undefined, { clientMessageId: 'uin-b' })
      const dequeued = []
      s.on('message_dequeued', (e) => dequeued.push(e))
      s.completeTurn()
      await tick()
      assert.equal(dequeued[0].clientMessageId, 'uin-b')
      assert.equal(s.sent[1].sendOptions.clientMessageId, 'uin-b', 're-dispatch carries the original sendOptions')
    })
  })

  describe('overflow cap', () => {
    it('discards past OUTGOING_QUEUE_MAX with a surfaced error (not a silent drop)', () => {
      const s = new FakeSession()
      s.sendMessage('turn') // busy
      const errors = []
      const queued = []
      s.on('error', (e) => errors.push(e))
      s.on('message_queued', (e) => queued.push(e))

      for (let i = 0; i < OUTGOING_QUEUE_MAX; i++) s.sendMessage(`q${i}`)
      assert.equal(s.outgoingQueueLength, OUTGOING_QUEUE_MAX)
      assert.equal(errors.length, 0)
      assert.equal(queued.length, OUTGOING_QUEUE_MAX)

      // One past the cap → error, no growth, no message_queued.
      const accepted = s.enqueueOutgoingMessage({ prompt: 'overflow' })
      assert.equal(accepted, false)
      assert.equal(s.outgoingQueueLength, OUTGOING_QUEUE_MAX)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, 'queue_full')
      assert.equal(errors[0].recoverable, true)
      assert.match(errors[0].message, new RegExp(`max ${OUTGOING_QUEUE_MAX}`))
      assert.equal(queued.length, OUTGOING_QUEUE_MAX, 'no message_queued for the discarded overflow')
    })
  })

  describe('interrupt policy — cancel (clear), not flush', () => {
    it('clearOutgoingQueue emits message_dequeued(interrupted) per item and empties the queue', () => {
      const s = new FakeSession()
      s.sendMessage('turn')
      s.sendMessage('q1', undefined, { clientMessageId: 'uin-1' })
      s.sendMessage('q2')
      assert.equal(s.outgoingQueueLength, 2)

      const dequeued = []
      s.on('message_dequeued', (e) => dequeued.push(e))
      const cleared = s.clearOutgoingQueue()
      assert.equal(cleared, 2)
      assert.equal(s.outgoingQueueLength, 0)
      assert.equal(dequeued.length, 2)
      assert.ok(dequeued.every((e) => e.reason === 'interrupted'))
      assert.equal(dequeued[0].clientMessageId, 'uin-1')
    })

    it('clearOutgoingQueue({ emit: false }) tears down silently (destroy path)', () => {
      const s = new FakeSession()
      s.sendMessage('turn')
      s.sendMessage('q1')
      const dequeued = []
      s.on('message_dequeued', (e) => dequeued.push(e))
      const cleared = s.clearOutgoingQueue({ emit: false })
      assert.equal(cleared, 1)
      assert.equal(s.outgoingQueueLength, 0)
      assert.equal(dequeued.length, 0, 'silent clear emits nothing')
    })

    it('a completing turn after an interrupt does NOT flush (queue was cancelled)', async () => {
      const s = new FakeSession()
      s.sendMessage('turn')
      s.sendMessage('q1')
      s.clearOutgoingQueue() // interrupt cancels the queued follow-up
      s.completeTurn()       // the (now interrupted) turn settles
      await tick()
      assert.deepEqual(s.sent.map((m) => m.prompt), ['turn'], 'no cancelled follow-up auto-fires')
    })
  })

  // The providers wire clearOutgoingQueue into interrupt() so a deliberate Stop
  // cancels queued follow-ups before the turn-end `result` can flush them.
  describe('provider interrupt() cancels the queue', () => {
    it('SdkSession.interrupt() clears queued follow-ups', async () => {
      const s = new SdkSession({ cwd: '/tmp' })
      s._isBusy = true
      s.sendMessage('q1', undefined, { clientMessageId: 'uin-a' })
      s.sendMessage('q2')
      assert.equal(s.outgoingQueueLength, 2)

      const dequeued = []
      s.on('message_dequeued', (e) => dequeued.push(e))
      await s.interrupt() // no active _query → clears, then returns
      assert.equal(s.outgoingQueueLength, 0)
      assert.equal(dequeued.length, 2)
      assert.ok(dequeued.every((e) => e.reason === 'interrupted'))
      s.destroy()
    })

    it('CliSession.interrupt() clears queued follow-ups', async () => {
      const s = new CliSession({ cwd: '/tmp' })
      s._isBusy = true
      await s.sendMessage('q1')
      await s.sendMessage('q2')
      assert.equal(s.outgoingQueueLength, 2)

      const dequeued = []
      s.on('message_dequeued', (e) => dequeued.push(e))
      s.interrupt() // no child → clears, then returns
      assert.equal(s.outgoingQueueLength, 0)
      assert.equal(dequeued.length, 2)
      assert.ok(dequeued.every((e) => e.reason === 'interrupted'))
      s.destroy()
    })
  })

  describe('normalizer → wire mapping injects sessionId', () => {
    const norm = new EventNormalizer()

    it('maps message_queued with the canonical ctx.sessionId', () => {
      const out = norm.normalize(
        'message_queued',
        { clientMessageId: 'uin-9', text: 'hi', queueLength: 2 },
        { sessionId: 'sess-1' },
      )
      assert.deepEqual(out.messages[0].msg, {
        type: 'message_queued',
        sessionId: 'sess-1',
        clientMessageId: 'uin-9',
        text: 'hi',
        queueLength: 2,
      })
    })

    it('maps message_dequeued and defaults a missing reason to flush', () => {
      const out = norm.normalize(
        'message_dequeued',
        { queueLength: 0 },
        { sessionId: 'sess-1' },
      )
      assert.deepEqual(out.messages[0].msg, {
        type: 'message_dequeued',
        sessionId: 'sess-1',
        queueLength: 0,
        reason: 'flush',
      })
    })

    it('passes through reason: interrupted', () => {
      const out = norm.normalize(
        'message_dequeued',
        { clientMessageId: 'uin-1', queueLength: 1, reason: 'interrupted' },
        { sessionId: 'sess-2' },
      )
      assert.equal(out.messages[0].msg.reason, 'interrupted')
      assert.equal(out.messages[0].msg.clientMessageId, 'uin-1')
    })
  })
})
