// #8754 — codex's own `ErrorNotification.willRetry` decides whether an `error`
// notification ends the turn, on an active turn and with no turn open.
//
// Hermetic by construction: no CodexAppServerClient, no child process, no
// `destroy()` (so no `kill()`), no attach directory, no owner-pid file and no
// network. The session is driven only through `_onNotification` with literal
// payloads. The #6856 deadline goes through the injected `setTimer`/`clearTimer`
// seam, so no real deadline timer is armed. The #6629 watchdog and the result
// timeout use the real globals (unref'd), and every test clears them in `finally`.
//
// Covered: a boolean `willRetry` (true and false) and a payload WITHOUT the field
// (the pre-0.163.0 heuristic fallback). Non-boolean values ('true', 1, null) are
// deliberately NOT asserted here: their semantics await a separate review
// disposition, and nothing in this file pins them either way.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'

const THREAD = 'thr-8754'

function mkSession() {
  const sk = mkdtempSync(join(tmpdir(), 'chroxy-cas-8754-'))
  const timers = { set: [], cleared: [] }
  const s = new CodexAppServerSession({
    cwd: '/tmp',
    skillsDir: sk,
    repoSkillsDir: null,
    // #6856 seam: record the deadline handle instead of arming a real timer.
    setTimer: (fn, ms) => {
      const h = { fn, ms, unref() {} }
      timers.set.push(h)
      return h
    },
    clearTimer: (h) => { timers.cleared.push(h) },
  })
  s._threadId = THREAD
  const cleanup = () => {
    s._clearResultTimeout()
    s._clearReconnectWatchdog()
    s._clearReconnectDeadline()
    rmSync(sk, { recursive: true, force: true })
  }
  return { s, timers, cleanup }
}

function capture(s, events) {
  const out = []
  events.forEach((e) => s.on(e, (p) => out.push([e, p])))
  return out
}

function openTurn(s, turnId = 'turn-1') {
  s._isBusy = true
  s._activeTurn = { messageId: 'm1', turnId, didStreamStart: false }
}

// The #6623 shape: the heuristic alone reads it as codex reconnecting.
const reconnectShaped = () => ({
  message: 'Reconnecting... 2/5',
  codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
})
// Not reconnect-shaped: the heuristic alone reads it as terminal.
const connectFailed = () => ({
  message: 'connection refused',
  codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 502 } },
})

function errorNote(turnId, error, extra = {}) {
  return { method: 'error', params: { threadId: THREAD, turnId, error, ...extra } }
}

describe('codex willRetry on an active turn (#8754)', () => {
  it('willRetry: true keeps the turn open for an error the heuristic would fail, and arms both backstops', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error', 'stopped', 'stream_end', 'result'])
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      assert.deepEqual(ev.map(([e]) => e), [], 'no terminal event while codex retries')
      assert.equal(s._isBusy, true)
      assert.ok(s._activeTurn, 'turn preserved')
      assert.ok(s._reconnectWatchdog, '#6629 watchdog armed')
      assert.ok(s._reconnectDeadline, '#6856 deadline armed')
      assert.equal(timers.set.length, 1, 'deadline armed once through the seam')
    } finally { cleanup() }
  })

  it('repeated willRetry: true ticks keep the SAME one-shot deadline (not extended)', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      capture(s, ['error'])
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      const first = s._reconnectDeadline
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: true }))
      assert.equal(s._reconnectDeadline, first, 'same handle after later ticks')
      assert.equal(timers.set.length, 1, 'never re-armed')
      assert.equal(timers.cleared.length, 0, 'never cleared by a retry tick')
    } finally { cleanup() }
  })

  it('willRetry: true re-arms the #6629 watchdog on every tick, does not mark the turn ended, and the turn goes on', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error', 'stream_start', 'stream_delta'])
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      const firstWatchdog = s._reconnectWatchdog
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      assert.ok(s._reconnectWatchdog, 'watchdog still armed')
      assert.notEqual(s._reconnectWatchdog, firstWatchdog, 'watchdog re-armed (slides) on each tick')
      assert.equal(s._endedNativeTurnIds.has('turn-1'), false, 'a retry is not an end')
      const messageId = s._activeTurn.messageId
      // codex recovers: its next notification for the same turn maps onto it.
      s._onNotification({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: 'turn-1', delta: 'hi' } })
      assert.deepEqual(ev.map(([e]) => e), ['stream_start', 'stream_delta'])
      assert.equal(ev[1][1].messageId, messageId, 'same turn, no new one')
      assert.equal(s._reconnectWatchdog, null, 'forward progress disarms the watchdog')
      assert.equal(s._reconnectDeadline, null, 'forward progress disarms the deadline')
    } finally { cleanup() }
  })

  it('the one-shot deadline still fails a willRetry: true turn that never recovers', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error'])
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      timers.set[0].fn()
      assert.equal(ev.length, 1)
      assert.equal(ev[0][1].code, 'stream_stall', 'hard bound preserved')
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
    } finally { cleanup() }
  })

  it('willRetry: false fails the turn even when the error is reconnect-shaped, and drops both backstops', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error', 'stopped'])
      openTurn(s)
      // Arm the backstops first with a genuine retry, then end the turn.
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: true }))
      const deadline = s._reconnectDeadline
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: false }))
      assert.deepEqual(ev.map(([e]) => e), ['error'], 'explicit false is terminal')
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
      assert.equal(s._reconnectWatchdog, null, 'watchdog cleared')
      assert.equal(s._reconnectDeadline, null, 'deadline cleared')
      assert.ok(timers.cleared.includes(deadline), 'deadline cleared through the seam')
    } finally { cleanup() }
  })

  it('without willRetry, the #6623 heuristic still decides: a reconnect-shaped error keeps the turn open', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error'])
      openTurn(s)
      s._onNotification(errorNote('turn-1', reconnectShaped()))
      assert.equal(ev.length, 0)
      assert.ok(s._activeTurn)
      assert.ok(s._reconnectWatchdog)
      assert.ok(s._reconnectDeadline)
    } finally { cleanup() }
  })

  it('without willRetry, a non-reconnect error still fails the turn', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error'])
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed()))
      assert.deepEqual(ev.map(([e]) => e), ['error'])
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
    } finally { cleanup() }
  })
})

describe('codex willRetry with no turn open (#8754)', () => {
  it('willRetry: false with a reconnect-shaped message surfaces the error', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error'])
      s._onNotification(errorNote('turn-x', {
        message: 'Reconnecting... 5/5',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      }, { willRetry: false }))
      assert.deepEqual(ev.map(([e]) => e), ['error'], 'explicit false is an end with no turn open too')
      assert.equal(s._activeTurn, null, 'no turn is opened for it')
      assert.equal(s._isBusy, false)
      assert.equal(s._endedNativeTurnIds.has('turn-x'), true, 'recorded as ended (#8710 straggler filter)')
      // A straggler for the ended turn opens nothing.
      s._onNotification({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: 'turn-x', delta: 'late' } })
      assert.equal(s._activeTurn, null, 'no phantom turn from a straggler')
    } finally { cleanup() }
  })

  // A retry with no turn open must neither open a turn nor mark codex's turn
  // ended: its later notifications are live and are followed (#8710).
  for (const [label, error, extra] of [
    ['willRetry: true', connectFailed(), { willRetry: true }],
    ['no willRetry, reconnect-shaped (heuristic fallback)', reconnectShaped(), {}],
  ]) {
    it(`${label}: not surfaced, no phantom turn, not marked ended, and later notifications are followed`, () => {
      const { s, cleanup } = mkSession()
      try {
        const ev = capture(s, ['error', 'stream_start', 'stream_delta'])
        s._onNotification(errorNote('turn-x', error, extra))
        assert.equal(ev.length, 0, 'nothing surfaced')
        assert.equal(s._activeTurn, null, 'no phantom turn')
        assert.equal(s._isBusy, false, 'not marked busy')
        assert.equal(s._endedNativeTurnIds.has('turn-x'), false, 'not marked ended')
        s._onNotification({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: 'turn-x', delta: 'work' } })
        assert.deepEqual(ev.map(([e]) => e), ['stream_start', 'stream_delta'], 'codex\'s turn is followed')
        assert.ok(s._activeTurn, 'a turn is opened for the live notification')
        assert.equal(s._activeTurn.turnId, 'turn-x')
      } finally { cleanup() }
    })
  }
})

describe('_codexWillRetry (#8754)', () => {
  it('a boolean willRetry decides both ways; an absent field falls back to the heuristic', () => {
    const { s, cleanup } = mkSession()
    try {
      const rc = reconnectShaped()
      const cf = connectFailed()
      assert.equal(s._codexWillRetry({ willRetry: true, error: cf }, cf), true)
      assert.equal(s._codexWillRetry({ willRetry: false, error: rc }, rc), false)
      assert.equal(s._codexWillRetry({ error: rc }, rc), true)
      assert.equal(s._codexWillRetry({ error: cf }, cf), false)
      assert.equal(s._codexWillRetry(undefined, {}), false)
    } finally { cleanup() }
  })
})
