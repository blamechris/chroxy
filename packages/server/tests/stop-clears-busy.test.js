import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { createAcpSessionClass } from '../src/acp-session.js'

// #8497 — a requested Stop ended a turn with `stopped` and NO `result` on every
// provider that reports it that way (ACP, Codex app-server, the jsonl-subprocess
// family). The clients leave "busy" on `agent_idle` / `session_activity`, both of
// which were only ever sent for a `result`, so the session stayed busy forever.
//
// The fix lives at the one place all providers meet the wire (ws-forwarding), so
// these tests drive the REAL forwarder and the REAL normalizer, and the ACP one
// also drives a REAL spawned fake agent through its REAL stop path.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'fake-acp-agent.js')
const SID = 'sess-8497'

/**
 * A forwarder wired to an ORDERED log of every frame a client would receive, so
 * a test can replay the log the way a client does and count busy -> idle
 * transitions instead of grepping for frame types.
 */
function harness({ listSessions = () => [] } = {}) {
  const frames = []
  // What a client that is NOT viewing the session receives: only global broadcasts.
  const globalFrames = []
  const sm = new EventEmitter()
  sm.getSession = () => null
  sm.listSessions = listSessions
  sm.getSessionContext = () => Promise.resolve(null)
  const normalizer = new EventNormalizer()
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = () => {}
  devPreview.closeSession = () => {}
  setupForwarding({
    normalizer,
    sessionManager: sm,
    cliSession: null,
    devPreview,
    checkpointManager: new EventEmitter(),
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: (msg) => { frames.push(msg); globalFrames.push(msg) },
    broadcastToSession: (_sid, msg) => frames.push(msg),
  })
  const emit = (event, data = {}) => sm.emit('session_event', { sessionId: SID, event, data })
  return { frames, globalFrames, emit, sm, normalizer }
}

/** Replay frames as a client does: only these four frames move busy/idle. */
function replay(frames) {
  let idle = true
  let busyToIdle = 0
  for (const f of frames) {
    const next = f.type === 'agent_busy' ? false
      : f.type === 'agent_idle' ? true
        : f.type === 'session_activity' ? !f.isBusy
          : idle
    if (!idle && next) busyToIdle++
    idle = next
  }
  return { idle, busyToIdle }
}

/**
 * The last frame a client that only sees GLOBAL broadcasts got that says whether
 * `SID` is busy: a `session_activity` ping, or the session's row in a
 * `session_list` (which the client re-derives `isIdle` from). null = none.
 */
function lastBusyClaim(globalFrames) {
  let last = null
  for (const f of globalFrames) {
    if (f.type === 'session_activity' && f.sessionId === SID) last = f.isBusy
    else if (f.type === 'session_list') {
      const row = (f.sessions || []).find((x) => x.sessionId === SID)
      if (row) last = row.isBusy
    }
  }
  return last
}

/**
 * The session lists a client that only sees GLOBAL frames got AFTER `index` (the
 * length of the frame log when the Stop was announced). Judging the list by
 * position, not just by whether one exists, is what stops an earlier list (the
 * `stream_start` one) from standing in for the one the Stop owes.
 */
function listRowsAfter(globalFrames, index) {
  return globalFrames.slice(index)
    .filter((f) => f.type === 'session_list')
    .map((f) => (f.sessions || []).find((x) => x.sessionId === SID))
    .filter(Boolean)
}

const count = (frames, type) => frames.filter((f) => f.type === type).length
const idleActivity = (frames) => frames.filter((f) => f.type === 'session_activity' && f.isBusy === false)
const nextTick = () => new Promise((resolve) => setImmediate(resolve))

describe('#8497 a requested Stop leaves busy on the client', () => {
  it('ACP: HANG_UNTIL_CANCEL + interrupt() reaches the client as idle, exactly once, with no result and no chip', async () => {
    const { frames, emit, normalizer } = harness()
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-8497-'))
    const Klass = createAcpSessionClass({
      id: `fake-acp-8497-${Date.now()}`,
      label: 'Fake ACP Agent',
      command: process.execPath,
      args: [FIXTURE],
      env: {},
    })
    const s = new Klass({ cwd: tmpdir(), skillsDir: sk, repoSkillsDir: null, resultTimeoutMs: 5000 })
    try {
      for (const ev of ['stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result', 'result', 'stopped', 'error']) {
        s.on(ev, (data) => emit(ev, data))
      }
      await s.start()

      const waiting = new Promise((resolve) => {
        s.on('stream_delta', (d) => { if (d.delta === 'WAITING') resolve() })
      })
      const stoppedP = new Promise((resolve) => s.once('stopped', resolve))
      const sendP = s.sendMessage('HANG_UNTIL_CANCEL', [])
      await waiting
      await s.interrupt()
      await stoppedP
      await sendP
      await nextTick()
    } finally {
      await s.destroy()
      normalizer.destroy()
      rmSync(sk, { recursive: true, force: true })
    }

    // The precondition the issue observed: the provider really ended the turn
    // with `stopped` and no `result`.
    assert.equal(count(frames, 'result'), 0, 'a Stop is not a result, so no marker or chip can be created')
    assert.equal(count(frames, 'session_stopped'), 1, 'exactly one quiet confirmation')
    assert.equal(count(frames, 'agent_busy'), 1, 'the turn went busy')

    // The fix: what the clients actually consume to leave busy.
    assert.equal(count(frames, 'agent_idle'), 1, 'the per-session idle frame the client resets its stream state on')
    assert.equal(idleActivity(frames).length, 1, 'and the sidebar / isIdle activity ping')
    const state = replay(frames)
    assert.equal(state.idle, true, 'the client ends idle')
    assert.equal(state.busyToIdle, 1, 'with exactly one busy -> idle transition')
  })

  it('a turn that ends with `result` then `stopped` (claude-cli shape) announces idle once', () => {
    const { frames, emit, normalizer } = harness()
    emit('stream_start', { messageId: 'm1' })
    emit('result', { cost: null, duration: 0, usage: null, sessionId: 'c1' })
    emit('stopped', { code: 0 })
    normalizer.destroy()

    assert.equal(count(frames, 'agent_idle'), 1, 'the result already idled the turn; the stopped must not repeat it')
    assert.equal(idleActivity(frames).length, 1)
    assert.equal(count(frames, 'session_stopped'), 1)
    assert.deepEqual(replay(frames), { idle: true, busyToIdle: 1 })
  })

  it('a turn that ends with `stopped` then `result` still has exactly one busy -> idle transition', () => {
    const { frames, emit, normalizer } = harness()
    emit('stream_start', { messageId: 'm1' })
    emit('stopped', {})
    emit('result', { cost: null, duration: 0, usage: null, sessionId: 'c1' })
    normalizer.destroy()

    assert.equal(count(frames, 'session_stopped'), 1)
    assert.deepEqual(replay(frames), { idle: true, busyToIdle: 1 })
  })

  it('a Stop that lands before the turn produced any output still idles, after an earlier turn ended in a result', async () => {
    // The shape that rules out a flag cleared only by stream_start: nothing is
    // forwarded between the dispatch and the Stop, so a "result already
    // announced idle" flag left over from the PREVIOUS turn would swallow this one.
    const { frames, emit, normalizer } = harness()
    emit('stream_start', { messageId: 'm1' })
    emit('result', { cost: null, duration: 0, usage: null, sessionId: 'c1' })
    await nextTick()

    frames.push({ type: 'agent_busy' }) // the client marks the turn busy when it sends; the server saw nothing yet
    emit('stopped', {})
    normalizer.destroy()

    assert.equal(count(frames, 'session_stopped'), 1)
    assert.equal(replay(frames).idle, true, 'the second turn must not stay busy')
  })

  it('an ordinary turn is unchanged: one idle frame, one idle ping carrying the cost, no session_stopped', () => {
    const { frames, emit, normalizer } = harness()
    emit('stream_start', { messageId: 'm1' })
    emit('result', { cost: 0.01, duration: 5, usage: null, sessionId: 'c1' })
    normalizer.destroy()

    assert.equal(count(frames, 'agent_idle'), 1)
    assert.equal(count(frames, 'session_stopped'), 0)
    const [ping] = idleActivity(frames)
    assert.equal(ping.lastCost, 0.01)
  })

  it('a stopped for a session that was already idle is harmless (idempotent on the client)', () => {
    const { frames, emit, normalizer } = harness()
    emit('stopped', {})
    normalizer.destroy()
    assert.deepEqual(replay(frames), { idle: true, busyToIdle: 0 })
    assert.equal(count(frames, 'session_stopped'), 1)
  })

  it('a client that is not viewing the session ends the Stop idle: the session_list reads the live session AFTER the provider tore the turn down', async () => {
    // ACP / Codex / SDK emit `stopped` BEFORE _clearMessageState() clears busy, so a
    // session_list built inside the emit publishes isBusy:true. agent_idle only
    // reaches viewers of the session; a client that sees only global frames must
    // find idle in the LAST busy-bearing frame it gets.
    let live = null
    const h = harness({
      listSessions: () => [{ sessionId: SID, isBusy: live ? live.isRunning : false }],
    })
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-8497-'))
    const Klass = createAcpSessionClass({
      id: `fake-acp-8497b-${Date.now()}`,
      label: 'Fake ACP Agent',
      command: process.execPath,
      args: [FIXTURE],
      env: {},
    })
    const s = new Klass({ cwd: tmpdir(), skillsDir: sk, repoSkillsDir: null, resultTimeoutMs: 5000 })
    live = s
    let stoppedAt = -1
    try {
      for (const ev of ['stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result', 'result', 'stopped', 'error']) {
        s.on(ev, (data) => {
          if (ev === 'stopped') stoppedAt = h.globalFrames.length
          h.emit(ev, data)
        })
      }
      await s.start()
      const waiting = new Promise((resolve) => {
        s.on('stream_delta', (d) => { if (d.delta === 'WAITING') resolve() })
      })
      const stoppedP = new Promise((resolve) => s.once('stopped', resolve))
      const sendP = s.sendMessage('HANG_UNTIL_CANCEL', [])
      await waiting
      await s.interrupt()
      await stoppedP
      await sendP
      await nextTick()
    } finally {
      await s.destroy()
      h.normalizer.destroy()
      rmSync(sk, { recursive: true, force: true })
    }

    assert.equal(s.isRunning, false, 'precondition: the session is idle once the Stop settled')
    // The list must be the one sent AFTER the Stop: the `stream_start` list that
    // went out when the turn began says busy and would satisfy a bare "was a
    // list published" check even with the Stop's own list deleted.
    assert.ok(stoppedAt >= 0, 'precondition: the Stop reached the forwarder')
    const rows = listRowsAfter(h.globalFrames, stoppedAt)
    assert.ok(rows.length >= 1, 'a session list was published after the Stop')
    assert.equal(rows.at(-1).isBusy, false, 'and it reports the session idle')
    assert.equal(lastBusyClaim(h.globalFrames), false, 'the last busy-bearing global frame says idle')
  })

  it('the session_list a Stop triggers is built after the provider\'s synchronous teardown, not inside the emit', async () => {
    let busy = true
    const h = harness({ listSessions: () => [{ sessionId: SID, isBusy: busy }] })
    h.emit('stream_start', { messageId: 'm1' })
    // The provider shape: emit('stopped') first, THEN clear busy, in one call stack.
    const at = h.globalFrames.length
    h.emit('stopped', {})
    busy = false
    await nextTick()
    h.normalizer.destroy()
    const rows = listRowsAfter(h.globalFrames, at)
    assert.equal(rows.length, 1, 'exactly one list follows the Stop')
    assert.equal(rows[0].isBusy, false, 'and it was built after the teardown, not inside the emit')
    assert.equal(lastBusyClaim(h.globalFrames), false)
  })

  it('the dedupe covers one synchronous turn end only: a result a microtask earlier does not swallow a later Stop', async () => {
    // Pins the tick scope. A wider window (a macrotask) would still hold the
    // flag here and drop this turn's idle.
    const { frames, emit, normalizer } = harness()
    emit('stream_start', { messageId: 'm1' })
    emit('result', { cost: null, duration: 0, usage: null, sessionId: 'c1' })
    await Promise.resolve()
    const before = count(frames, 'agent_idle')
    frames.push({ type: 'agent_busy' })
    emit('stopped', {})
    normalizer.destroy()
    assert.equal(count(frames, 'agent_idle'), before + 1, 'the Stop announced its own idle')
    assert.equal(replay(frames).idle, true)
  })

  it('`stopped` then `result` repeats the idle on purpose: the result is the frame that carries the cost', () => {
    const { frames, emit, normalizer } = harness()
    emit('stream_start', { messageId: 'm1' })
    emit('stopped', {})
    emit('result', { cost: 0.02, duration: 1, usage: null, sessionId: 'c1' })
    normalizer.destroy()
    assert.equal(idleActivity(frames).length, 2)
    assert.equal(idleActivity(frames)[1].lastCost, 0.02, 'the cost still reaches the sidebar')
    assert.equal(replay(frames).busyToIdle, 1, 'but the client sees one transition')
  })
})
