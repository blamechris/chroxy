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
// The semantics pinned here: a PRESENT `willRetry` decides (only `true` retries;
// `false` and any malformed value end the turn), and only a payload WITHOUT the
// field falls back to the #6623 heuristic. Continuation is pinned causally: a
// retry's later notifications are delivered through to the turn's result, and an
// end's stragglers are dropped.
//
// This file refuses to run outside `tests/_setup.mjs` (loaded with `--import`):
// without it the config dir is the developer's real one and nothing guards
// writes to it.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fsNamespace from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, basename } from 'node:path'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'

// --- Mandatory isolation: tests/_setup.mjs must already be installed ---------
{
  const fail = (why) => {
    throw new Error(`codex-willretry.test.js: refusing to run without tests/_setup.mjs isolation: ${why}. ` +
      'Run with: node --import ./tests/_setup.mjs --experimental-test-module-mocks --test tests/codex-willretry.test.js')
  }
  const cfg = process.env.CHROXY_CONFIG_DIR
  if (!cfg) fail('CHROXY_CONFIG_DIR is not set')
  const realTmp = fsNamespace.realpathSync(tmpdir())
  const realCfg = fsNamespace.realpathSync(cfg)
  if (!realCfg.startsWith(realTmp + sep) || !basename(realCfg).startsWith('chroxy-test-cfg-')) {
    fail('CHROXY_CONFIG_DIR is not the per-process temp dir _setup.mjs creates')
  }
  const marker = Symbol.for('chroxy.testFsSandbox')
  for (const name of ['writeFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'renameSync']) {
    if (!fsNamespace[name]?.[marker]) fail(`fs.${name} is not guarded by the write sandbox`)
  }
}

const THREAD = 'thr-8754'

function mkSession() {
  const sk = fsNamespace.mkdtempSync(join(tmpdir(), 'chroxy-cas-8754-'))
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
    fsNamespace.rmSync(sk, { recursive: true, force: true })
  }
  return { s, timers, cleanup }
}

const EVENTS = ['error', 'stopped', 'stream_start', 'stream_delta', 'stream_end', 'result']
function capture(s, events = EVENTS) {
  const out = []
  events.forEach((e) => s.on(e, (p) => out.push([e, p])))
  return out
}
const names = (ev) => ev.map(([e]) => e)

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
// Present but not a boolean: each must end the turn, never consult the heuristic.
const MALFORMED = [null, 'true', 1]

const errorNote = (turnId, error, extra = {}) => ({ method: 'error', params: { threadId: THREAD, turnId, error, ...extra } })
const turnStarted = (turnId) => ({ method: 'turn/started', params: { threadId: THREAD, turn: { id: turnId } } })
const delta = (turnId, text) => ({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId, delta: text } })
const completed = (turnId) => ({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: turnId, status: 'completed', durationMs: 5 } } })

describe('codex willRetry on an active turn (#8754)', () => {
  it('willRetry: true keeps the turn open for an error the heuristic would fail, and arms both backstops', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      assert.deepEqual(names(ev), [], 'no terminal event while codex retries')
      assert.equal(s._isBusy, true)
      assert.ok(s._activeTurn, 'turn preserved')
      assert.ok(s._reconnectWatchdog, '#6629 watchdog armed')
      assert.ok(s._reconnectDeadline, '#6856 deadline armed')
      assert.equal(timers.set.length, 1, 'deadline armed once through the seam')
    } finally { cleanup() }
  })

  it('repeated willRetry: true ticks re-arm the watchdog but keep the SAME one-shot deadline', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      const firstDeadline = s._reconnectDeadline
      const firstWatchdog = s._reconnectWatchdog
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: true }))
      assert.ok(s._reconnectWatchdog, 'watchdog still armed')
      // Identity compared as a boolean, so a failure reports plain values. Comparing the
      // function-bearing handles directly was observed to surface as ERR_TEST_FAILURE
      // rather than ERR_ASSERTION in the test runner's report.
      assert.equal(s._reconnectWatchdog !== firstWatchdog, true, 'watchdog re-armed (slides) on each tick')
      assert.equal(s._reconnectDeadline === firstDeadline, true, 'same deadline handle after later ticks')
      assert.equal(timers.set.length, 1, 'deadline never re-armed')
      assert.equal(timers.cleared.length, 0, 'deadline never cleared by a retry tick')
    } finally { cleanup() }
  })

  it('the one-shot deadline still fails a willRetry: true turn that never recovers', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      timers.set[0].fn()
      assert.deepEqual(names(ev), ['error'])
      assert.equal(ev[0][1].code, 'stream_stall', 'hard bound preserved')
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
    } finally { cleanup() }
  })

  it('willRetry: true (non-reconnect error) then delta and completion: the turn is delivered to its result', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed(), { willRetry: true }))
      assert.equal(s._endedNativeTurnIds.has('turn-1'), false, 'a retry is not an end')
      s._onNotification(delta('turn-1', 'recovered'))
      assert.equal(s._reconnectWatchdog, null, 'forward progress disarms the watchdog')
      assert.equal(s._reconnectDeadline, null, 'forward progress disarms the deadline')
      s._onNotification(completed('turn-1'))
      assert.deepEqual(names(ev), ['stream_start', 'stream_delta', 'stream_end', 'result'], 'delivered, no error')
      assert.equal(ev[1][1].delta, 'recovered')
      assert.deepEqual(ev.slice(0, 3).map(([, p]) => p.messageId), ['m1', 'm1', 'm1'], 'the stream stays on the same turn')
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
      assert.equal(s._endedNativeTurnIds.has('turn-1'), true, 'ended by its completion, not by the retry')
    } finally { cleanup() }
  })

  it('willRetry: false fails the turn even when the error is reconnect-shaped, and drops both backstops', () => {
    const { s, timers, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      // Arm the backstops first with a genuine retry, then end the turn.
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: true }))
      const deadline = s._reconnectDeadline
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: false }))
      assert.deepEqual(names(ev), ['error'], 'explicit false is terminal')
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
      assert.equal(s._reconnectWatchdog, null, 'watchdog cleared')
      assert.equal(s._reconnectDeadline, null, 'deadline cleared')
      assert.ok(timers.cleared.includes(deadline), 'deadline cleared through the seam')
    } finally { cleanup() }
  })

  it('willRetry: false: the ended turn\'s stragglers (delta, completion) are dropped', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: false }))
      assert.deepEqual(names(ev), ['error'])
      s._onNotification(delta('turn-1', 'late'))
      s._onNotification(completed('turn-1'))
      assert.deepEqual(names(ev), ['error'], 'no stream, no second result for the ended turn')
      assert.equal(s._activeTurn, null, 'no phantom turn')
      assert.equal(s._isBusy, false)
    } finally { cleanup() }
  })

  for (const v of MALFORMED) {
    it(`willRetry: ${JSON.stringify(v)} (present, not a boolean) ends the turn even when the error is reconnect-shaped`, () => {
      const { s, cleanup } = mkSession()
      try {
        const ev = capture(s)
        openTurn(s)
        s._onNotification(errorNote('turn-1', reconnectShaped(), { willRetry: v }))
        assert.deepEqual(names(ev), ['error'], 'malformed is terminal, not the heuristic')
        assert.equal(s._activeTurn, null)
        assert.equal(s._isBusy, false)
        assert.equal(s._reconnectWatchdog, null)
        assert.equal(s._reconnectDeadline, null)
        assert.equal(s._endedNativeTurnIds.has('turn-1'), true)
      } finally { cleanup() }
    })
  }

  it('without willRetry, the #6623 heuristic still decides: a reconnect-shaped error keeps the turn open', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', reconnectShaped()))
      assert.deepEqual(names(ev), [])
      assert.ok(s._activeTurn)
      assert.ok(s._reconnectWatchdog)
      assert.ok(s._reconnectDeadline)
    } finally { cleanup() }
  })

  it('without willRetry, a non-reconnect error still fails the turn', () => {
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s)
      openTurn(s)
      s._onNotification(errorNote('turn-1', connectFailed()))
      assert.deepEqual(names(ev), ['error'])
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
    } finally { cleanup() }
  })
})

describe('codex willRetry with no turn open (#8754)', () => {
  // A retry with no turn open must neither open a turn nor mark codex's turn
  // ended: its later notifications are live, and are followed to a result (#8710).
  for (const [label, error, extra] of [
    ['willRetry: true (non-reconnect error)', connectFailed(), { willRetry: true }],
    ['no willRetry, reconnect-shaped (heuristic fallback)', reconnectShaped(), {}],
  ]) {
    it(`${label}: nothing surfaced or opened, then codex's turn is followed through to its result`, () => {
      const { s, cleanup } = mkSession()
      try {
        const ev = capture(s)
        s._onNotification(errorNote('turn-x', error, extra))
        assert.deepEqual(names(ev), [], 'nothing surfaced')
        assert.equal(s._activeTurn, null, 'no phantom turn')
        assert.equal(s._isBusy, false, 'not marked busy')
        assert.equal(s._endedNativeTurnIds.has('turn-x'), false, 'not marked ended')
        s._onNotification(turnStarted('turn-x'))
        assert.ok(s._activeTurn, 'the real turn event opens a turn')
        assert.equal(s._activeTurn.turnId, 'turn-x')
        s._onNotification(delta('turn-x', 'work'))
        s._onNotification(completed('turn-x'))
        assert.deepEqual(names(ev), ['stream_start', 'stream_delta', 'stream_end', 'result'], 'followed to its result, no error')
        assert.equal(ev[1][1].delta, 'work')
        assert.equal(s._activeTurn, null)
        assert.equal(s._isBusy, false)
        assert.equal(s._endedNativeTurnIds.has('turn-x'), true, 'ended by its completion')
      } finally { cleanup() }
    })
  }

  for (const v of [false, ...MALFORMED]) {
    it(`willRetry: ${JSON.stringify(v)} with a reconnect-shaped message surfaces the error, and the turn's stragglers are dropped`, () => {
      const { s, cleanup } = mkSession()
      try {
        const ev = capture(s)
        s._onNotification(errorNote('turn-x', {
          message: 'Reconnecting... 5/5',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        }, { willRetry: v }))
        assert.deepEqual(names(ev), ['error'], 'an end with no turn open is surfaced')
        assert.equal(s._activeTurn, null, 'no turn is opened for it')
        assert.equal(s._isBusy, false)
        assert.equal(s._endedNativeTurnIds.has('turn-x'), true, 'recorded as ended (#8710 straggler filter)')
        s._onNotification(delta('turn-x', 'late'))
        s._onNotification(completed('turn-x'))
        assert.deepEqual(names(ev), ['error'], 'stragglers dropped')
        assert.equal(s._activeTurn, null, 'no phantom turn from a straggler')
        assert.equal(s._isBusy, false)
      } finally { cleanup() }
    })
  }
})

describe('_codexWillRetry (#8754)', () => {
  it('a present willRetry decides (only true retries); only an absent field falls back to the heuristic', () => {
    const { s, cleanup } = mkSession()
    try {
      const rc = reconnectShaped()
      const cf = connectFailed()
      assert.equal(s._codexWillRetry({ willRetry: true, error: cf }, cf), true)
      assert.equal(s._codexWillRetry({ willRetry: false, error: rc }, rc), false)
      for (const v of MALFORMED) {
        assert.equal(s._codexWillRetry({ willRetry: v, error: rc }, rc), false, `malformed ${JSON.stringify(v)} is not a retry`)
      }
      assert.equal(s._codexWillRetry(JSON.parse('{"willRetry":null,"error":{}}'), rc), false, 'JSON null is present')
      assert.equal(s._codexWillRetry({ error: rc }, rc), true, 'absent: heuristic, reconnect-shaped')
      assert.equal(s._codexWillRetry({ error: cf }, cf), false, 'absent: heuristic, other error')
      assert.equal(s._codexWillRetry(undefined, rc), true, 'no params at all: heuristic')
      assert.equal(s._codexWillRetry(undefined, {}), false)
    } finally { cleanup() }
  })
})
