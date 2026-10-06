/**
 * session-wake.js — the shared "may this daemon type into a live session" gate
 * (#7424, extracted from mailbox-route.js's injectWakeup).
 *
 * The gate is security-load-bearing: swarm-audit finding C2 (#5984) is that a
 * duck-typed `typeof session.writeTerminalInput === 'function'` check would let
 * an ingest-secret holder inject an EXECUTED line into a user-shell session's
 * root shell. So the negative cases here are the point, and each one names the
 * shape it is refusing.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wakeSession, sanitizeWakeText, supportsDaemonTurnInput, MAX_WAKE_TEXT_CHARS } from '../src/session-wake.js'
import { BaseSession, reportInputAdmission } from '../src/base-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession } from '../src/cli-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { UserShellSession } from '../src/user-shell-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/** A stand-in for ClaudeTuiSession: the positive discriminator lives on the CLASS. */
function tuiSession({ isRunning = false, write = () => true } = {}) {
  class FakeTui {
    static isClaudeTui = true
    constructor() {
      this.isRunning = isRunning
      this.writes = []
      this.writeTerminalInput = (text) => {
        this.writes.push(text)
        return write(text)
      }
    }
  }
  return new FakeTui()
}

describe('sanitizeWakeText', () => {
  it('flattens every control character, including the CR that would submit early', () => {
    // A bare CR mid-string would submit the first half as a prompt and leave the
    // rest typed into the next one — the whole reason a caller may not embed one.
    assert.equal(sanitizeWakeText('one\rtwo\nthree\u0000four\u007ffive'), 'one two three four five')
  })

  it('squeezes runs of whitespace and trims', () => {
    assert.equal(sanitizeWakeText('  a \t\t b  '), 'a b')
  })

  it('caps the length', () => {
    const out = sanitizeWakeText('x'.repeat(MAX_WAKE_TEXT_CHARS + 50))
    assert.equal(out.length, MAX_WAKE_TEXT_CHARS)
  })

  it('returns empty for a non-string or a control-only string', () => {
    assert.equal(sanitizeWakeText(null), '')
    assert.equal(sanitizeWakeText(42), '')
    assert.equal(sanitizeWakeText('\r\n '), '')
  })
})

describe('wakeSession', () => {
  it('types the line plus a single trailing return into an idle claude-tui session', () => {
    const session = tuiSession()
    assert.equal(wakeSession(session, 'CI finished on PR #1'), 'injected')
    assert.deepEqual(session.writes, ['CI finished on PR #1\r'])
  })

  it('refuses a session that merely LOOKS like a tui (user-shell duck-typing, swarm-audit C2)', () => {
    // Exactly the shape #5983's user-shell session has: writeTerminalInput
    // exists, the class marker does not. A duck-typed gate would inject an
    // executed line into that shell.
    const writes = []
    const userShell = { isRunning: false, writeTerminalInput: (t) => { writes.push(t); return true } }
    assert.equal(wakeSession(userShell, 'echo hello'), 'not-tui')
    assert.deepEqual(writes, [], 'nothing may be written to a non-tui session')
  })

  it('refuses a truthy-but-not-true marker', () => {
    class Sneaky {
      static isClaudeTui = 1
      constructor() { this.isRunning = false; this.writes = [] }
      writeTerminalInput(t) { this.writes.push(t); return true }
    }
    const s = new Sneaky()
    assert.equal(wakeSession(s, 'hello'), 'not-tui')
    assert.deepEqual(s.writes, [])
  })

  it('refuses a marked class that has no writeTerminalInput', () => {
    class MarkedButMute { static isClaudeTui = true }
    const s = new MarkedButMute()
    s.isRunning = false
    assert.equal(wakeSession(s, 'hello'), 'not-tui')
  })

  it('refuses a busy session so an in-flight turn is never corrupted', () => {
    const session = tuiSession({ isRunning: true })
    assert.equal(wakeSession(session, 'hello'), 'busy')
    assert.deepEqual(session.writes, [])
  })

  it('reports pty-dead when the write returns false', () => {
    const session = tuiSession({ write: () => false })
    assert.equal(wakeSession(session, 'hello'), 'pty-dead')
  })

  it('reports pty-dead rather than throwing when the write throws', () => {
    const session = tuiSession({ write: () => { throw new Error('EPIPE') } })
    assert.equal(wakeSession(session, 'hello'), 'pty-dead')
  })

  it('refuses a null session and a text that scrubs to nothing', () => {
    assert.equal(wakeSession(null, 'hello'), 'no-session')
    const session = tuiSession()
    assert.equal(wakeSession(session, '\r\r'), 'empty-text')
    assert.deepEqual(session.writes, [], 'a bare return must never be typed into a live prompt')
  })
})

// ---------------------------------------------------------------------------
// #8301 — the provider-neutral turn-input route
// ---------------------------------------------------------------------------

/**
 * A claude-sdk-shaped provider built on the REAL BaseSession queue: idle
 * dispatches and reports `accepted`, busy enqueues via `enqueueOutgoingMessage`
 * and reports `queued`, and `completeTurn()` flushes the head the way the
 * providers' post-turn path does. Only the child process / SDK query is absent.
 */
class FakeTurnSession extends BaseSession {
  static get capabilities() { return { daemonTurnInput: true } }
  constructor(opts = {}) {
    super({ cwd: '/tmp', ...opts })
    this.sent = []
  }
  sendMessage(prompt, attachments, sendOptions = {}) {
    if (this._isBusy) {
      const queued = this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      reportInputAdmission(sendOptions, queued
        ? { status: 'queued', delivery: 'queued' }
        : { status: 'rejected', delivery: 'not_dispatched', reason: 'queue_full' })
      return
    }
    this._isBusy = true
    this.sent.push({ prompt, attachments, sendOptions })
    reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
  }
  completeTurn() {
    this._isBusy = false
    this.dequeueNextOutgoing()
  }
}

const nextTick = () => new Promise((resolve) => process.nextTick(resolve))

describe('wakeSession — turn-input route (#8301)', () => {
  it('delivers the sanitized line through sendMessage to an idle session and reports injected', () => {
    const s = new FakeTurnSession()
    const admitted = []
    const out = wakeSession(s, 'CI finished\r\non PR #1', {
      turnInput: true,
      clientMessageId: 'chroxy-ci-wake-1',
      onAdmission: (a) => admitted.push(a),
    })
    assert.equal(out, 'injected')
    assert.equal(s.sent.length, 1, 'sendMessage called exactly once')
    assert.equal(s.sent[0].prompt, 'CI finished on PR #1', 'control characters flattened, no trailing return')
    assert.deepEqual(s.sent[0].attachments, [])
    assert.equal(s.sent[0].sendOptions.clientMessageId, 'chroxy-ci-wake-1')
    assert.equal(admitted.length, 1)
    assert.equal(admitted[0].outcome, 'injected')
    assert.equal(admitted[0].line, 'CI finished on PR #1')
  })

  it('queues behind a running turn, reports queued, and the REAL queue flushes it at turn end', async () => {
    const s = new FakeTurnSession()
    s.sendMessage('the user turn') // goes busy
    const admitted = []
    const out = wakeSession(s, 'CI finished on PR #2', {
      turnInput: true,
      clientMessageId: 'chroxy-ci-wake-2',
      onAdmission: (a) => admitted.push(a.outcome),
    })
    assert.equal(out, 'queued')
    assert.equal(s.sent.length, 1, 'a busy session is not written to mid-turn')
    assert.equal(s.outgoingQueueLength, 1)

    s.completeTurn()
    await nextTick()
    assert.equal(s.sent.length, 2, 'the queue flushed the wake after the turn ended')
    assert.equal(s.sent[1].prompt, 'CI finished on PR #2')
    assert.equal(s.sent[1].sendOptions.clientMessageId, 'chroxy-ci-wake-2')
    // The flush re-dispatches with the SAME sendOptions, so the provider reports
    // `accepted` a second time. The caller must hear about the wake once.
    assert.deepEqual(admitted, ['queued'])
  })

  it('forwards admitAtFlush to sendMessage only when it is a function (#8301)', () => {
    const s = new FakeTurnSession()
    const gate = () => true
    wakeSession(s, 'a', { turnInput: true, admitAtFlush: gate })
    assert.equal(s.sent[0].sendOptions.admitAtFlush, gate)
    const s2 = new FakeTurnSession()
    wakeSession(s2, 'a', { turnInput: true, admitAtFlush: 'yes' })
    assert.equal('admitAtFlush' in s2.sent[0].sendOptions, false)
    const s3 = new FakeTurnSession()
    wakeSession(s3, 'a', { turnInput: true })
    assert.equal('admitAtFlush' in s3.sent[0].sendOptions, false)
  })

  it('does not consult isRunning: a busy turn is queued, not refused', () => {
    const s = new FakeTurnSession()
    s._isBusy = true
    Object.defineProperty(s, 'isRunning', { get: () => true })
    assert.equal(wakeSession(s, 'hello', { turnInput: true }), 'queued')
  })

  it('reports rejected, and never calls the caller a success, when the provider rejects', () => {
    class Rejecting extends FakeTurnSession {
      sendMessage(prompt, attachments, sendOptions = {}) {
        reportInputAdmission(sendOptions, { status: 'rejected', delivery: 'not_dispatched', reason: 'busy' })
      }
    }
    const admitted = []
    assert.equal(wakeSession(new Rejecting(), 'hello', { turnInput: true, onAdmission: (a) => admitted.push(a.outcome) }), 'rejected')
    assert.deepEqual(admitted, ['rejected'])
  })

  it('reports pending, then delivers the outcome through onAdmission, when admission lands late', async () => {
    class Late extends FakeTurnSession {
      async sendMessage(prompt, attachments, sendOptions = {}) {
        await nextTick()
        reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
      }
    }
    const admitted = []
    const out = wakeSession(new Late(), 'hello', { turnInput: true, onAdmission: (a) => admitted.push(a.outcome) })
    assert.equal(out, 'pending', 'the synchronous result must not claim an outcome the provider has not reported')
    assert.deepEqual(admitted, [])
    await nextTick(); await nextTick()
    assert.deepEqual(admitted, ['injected'])
  })

  it('ignores a malformed or non-final admission report', () => {
    class Odd extends FakeTurnSession {
      sendMessage(prompt, attachments, sendOptions = {}) {
        reportInputAdmission(sendOptions, null)
        reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'queued' })
        reportInputAdmission(sendOptions, { status: 'uncertain', delivery: 'unknown' })
      }
    }
    assert.equal(wakeSession(new Odd(), 'hello', { turnInput: true }), 'pending')
  })

  it('swallows a rejecting sendMessage promise instead of leaking an unhandled rejection', async () => {
    class Boom extends FakeTurnSession {
      async sendMessage() { throw new Error('provider fault') }
    }
    const unhandled = []
    const onUnhandled = (e) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      assert.equal(wakeSession(new Boom(), 'hello', { turnInput: true }), 'pending')
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [])
  })

  it('never throws when sendMessage throws synchronously', () => {
    class Throws extends FakeTurnSession {
      sendMessage() { throw new Error('sync fault') }
    }
    assert.equal(wakeSession(new Throws(), 'hello', { turnInput: true }), 'error')
  })

  it('does not let a throwing onAdmission callback fail the wake', () => {
    const s = new FakeTurnSession()
    assert.equal(wakeSession(s, 'hello', { turnInput: true, onAdmission: () => { throw new Error('cb') } }), 'injected')
  })

  it('sanitizes control characters and caps the length on this route too', () => {
    const s = new FakeTurnSession()
    wakeSession(s, `a\u0000b\rc\nd\u007fe ${'x'.repeat(MAX_WAKE_TEXT_CHARS + 100)}`, { turnInput: true })
    const prompt = s.sent[0].prompt
    assert.equal(/[\u0000-\u001f\u007f]/.test(prompt), false, 'no control character reaches the provider')
    assert.ok(prompt.startsWith('a b c d e '))
    assert.equal(prompt.length, MAX_WAKE_TEXT_CHARS)
  })

  it('reports empty-text and sends nothing when nothing survives sanitizing', () => {
    const s = new FakeTurnSession()
    assert.equal(wakeSession(s, '\r\n\u0000 ', { turnInput: true }), 'empty-text')
    assert.equal(wakeSession(s, 42, { turnInput: true }), 'empty-text')
    assert.deepEqual(s.sent, [])
  })

  it('is OPT-IN: without turnInput the same session is still not-tui (the mailbox caller)', () => {
    const s = new FakeTurnSession()
    assert.equal(wakeSession(s, 'You have 1 unread message'), 'not-tui')
    assert.equal(wakeSession(s, 'You have 1 unread message', {}), 'not-tui')
    assert.equal(wakeSession(s, 'You have 1 unread message', { turnInput: 'yes' }), 'not-tui', 'strict === true')
    assert.deepEqual(s.sent, [])
  })

  it('keeps the claude-tui PTY route for a tui session even when turnInput is requested', () => {
    const session = tuiSession()
    let sendMessageCalls = 0
    session.sendMessage = () => { sendMessageCalls++ }
    assert.equal(wakeSession(session, 'CI finished on PR #3', { turnInput: true }), 'injected')
    assert.deepEqual(session.writes, ['CI finished on PR #3\r'])
    assert.equal(sendMessageCalls, 0, 'a tui session must not be reached through sendMessage')
    // and the tui busy rule is unchanged on this path
    assert.equal(wakeSession(tuiSession({ isRunning: true }), 'x', { turnInput: true }), 'busy')
  })

  describe('the discriminator (positive, strict === true, class-level)', () => {
    const roster = (Klass) => wakeSession(Object.create(Klass.prototype), 'hello', { turnInput: true })

    it('refuses a session without the flag, even though it has a sendMessage', () => {
      class NoFlag extends BaseSession { sendMessage() { throw new Error('must not be called') } }
      assert.equal(wakeSession(new NoFlag({ cwd: '/tmp' }), 'hello', { turnInput: true }), 'not-tui')
    })

    it('refuses a truthy-but-not-true flag', () => {
      for (const sneaky of [1, 'true', {}, [], 'yes']) {
        let called = 0
        class Sneaky extends BaseSession {
          static get capabilities() { return { daemonTurnInput: sneaky } }
          sendMessage() { called++ }
        }
        assert.equal(wakeSession(new Sneaky({ cwd: '/tmp' }), 'hello', { turnInput: true }), 'not-tui', `flag ${JSON.stringify(sneaky)}`)
        assert.equal(called, 0)
      }
    })

    it('reads the flag off the CLASS, never off an instance property', () => {
      let called = 0
      const impostor = { constructor: { capabilities: {} }, daemonTurnInput: true, capabilities: { daemonTurnInput: true }, sendMessage: () => { called++ } }
      assert.equal(wakeSession(impostor, 'hello', { turnInput: true }), 'not-tui')
      assert.equal(called, 0)
    })

    it('treats a throwing capabilities getter as "not supported"', () => {
      let called = 0
      class Throwing {
        static get capabilities() { throw new Error('boom') }
        sendMessage() { called++ }
      }
      const s = new Throwing()
      assert.equal(supportsDaemonTurnInput(s), false)
      assert.equal(wakeSession(s, 'hello', { turnInput: true }), 'not-tui')
      assert.equal(called, 0)
    })

    it('refuses a user shell even if one is ever (wrongly) flagged', () => {
      let called = 0
      class FlaggedShell extends UserShellSession {
        static get capabilities() { return { ...UserShellSession.capabilities, daemonTurnInput: true } }
        sendMessage() { called++ }
      }
      assert.equal(wakeSession(Object.create(FlaggedShell.prototype), 'rm -rf /', { turnInput: true }), 'not-tui')
      assert.equal(called, 0)
    })

    it('real providers: declared for sdk / cli / codex-app-server, never for tui or the user shell', () => {
      assert.equal(SdkSession.capabilities.daemonTurnInput, true)
      assert.equal(CliSession.capabilities.daemonTurnInput, true)
      assert.equal(CodexAppServerSession.capabilities.daemonTurnInput, true)
      assert.notEqual(ClaudeTuiSession.capabilities.daemonTurnInput, true)
      assert.notEqual(UserShellSession.capabilities.daemonTurnInput, true)
      assert.equal(roster(UserShellSession), 'not-tui')
    })
  })
})
