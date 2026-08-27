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
import { wakeSession, sanitizeWakeText, MAX_WAKE_TEXT_CHARS } from '../src/session-wake.js'

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
