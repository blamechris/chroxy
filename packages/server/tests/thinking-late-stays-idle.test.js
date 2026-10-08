import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SessionManager } from '../src/session-manager.js'
import { PushNotificationHandler } from '../src/server-cli/push-notification-handler.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * #7393 — a thinking block can reach claude-tui's transcript AFTER the turn's
 * Stop hook, and is then shown inside a short late window (live smoke on
 * 8d6b00095). Its frames are tagged `late: true` by the session. They must not
 * make the session busy again: ws-forwarding broadcast `session_activity
 * { isBusy: true }` for every stream_start, and nothing sends idle again until
 * the next `result`, so the dashboard sat on "Agent is working" (the #8497 /
 * #8502 stuck-busy class).
 *
 * These drive the REAL forwarder and the REAL normalizer and replay the frames
 * the way a client does.
 */

const SID = 'sess-7393-late'

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


const lateTriple = (emit, id = 'msg-1-thinking-0') => {
  emit('stream_start', { messageId: id, thinking: true, late: true })
  emit('stream_delta', { messageId: id, delta: 'late reasoning', thinking: true, late: true })
  emit('stream_end', { messageId: id, thinking: true, late: true, thinkingDurationMs: 900 })
}

describe('late thinking does not make the session busy (#7393)', () => {
  it('result, then a late thinking block: the session stays idle and sends no busy ping', () => {
    const { frames, emit } = harness()
    emit('stream_start', { messageId: 'msg-1' })
    emit('stream_delta', { messageId: 'msg-1', delta: 'answer' })
    emit('stream_end', { messageId: 'msg-1' })
    emit('result', { cost: null, duration: 5, usage: null, sessionId: 'c1' })
    const before = frames.length
    assert.equal(replay(frames).idle, true, 'precondition: idle after the result')

    lateTriple(emit)
    const after = frames.slice(before)
    assert.equal(replay(frames).idle, true, 'still idle after the late block')
    assert.deepEqual(after.filter((f) => f.type === 'session_activity'), [], 'no session_activity at all for late frames')
    assert.deepEqual(after.filter((f) => f.type === 'agent_busy'), [])
    // ... but the block itself still reaches the client, tagged as thinking.
    const wire = after.filter((f) => f.type === 'stream_start' || f.type === 'stream_end')
    assert.deepEqual(wire.map((f) => [f.type, f.messageId, f.thinking]), [
      ['stream_start', 'msg-1-thinking-0', true],
      ['stream_end', 'msg-1-thinking-0', true],
    ])
  })

  it('a thinking stream DURING a turn behaves as before: the sidebar still hears busy', () => {
    const { frames, emit } = harness()
    emit('stream_start', { messageId: 'msg-2-thinking-0', thinking: true })
    const pings = frames.filter((f) => f.type === 'session_activity')
    assert.equal(pings.length, 1)
    assert.equal(pings[0].isBusy, true)
  })

  it('an ordinary response stream_start still broadcasts busy', () => {
    const { frames, emit } = harness()
    emit('stream_start', { messageId: 'msg-3' })
    assert.equal(frames.filter((f) => f.type === 'session_activity' && f.isBusy === true).length, 1)
    assert.ok(frames.some((f) => f.type === 'agent_busy'))
  })

  it('the late flag is not leaked onto the wire frames', () => {
    const { frames, emit } = harness()
    lateTriple(emit)
    assert.ok(frames.every((f) => !('late' in f)), 'clients never see an internal field')
  })
})

describe('late thinking is not activity (#7393)', () => {
  it('does not push the idle timeout back, while a live thinking start still does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-late-idle-'))
    const m = new SessionManager({ stateFilePath: join(dir, 'state.json'), cwd: '/tmp' })
    try {
      const fake = new EventEmitter()
      m._wireSessionEvents('s1', fake)
      let touches = 0
      const orig = m.touchActivity.bind(m)
      m.touchActivity = (id) => { touches++; return orig(id) }

      fake.emit('stream_start', { messageId: 'a-thinking-0', thinking: true })
      assert.equal(touches, 1, 'control: an in-turn thinking start touches')
      fake.emit('stream_start', { messageId: 'a-thinking-1', thinking: true, late: true })
      assert.equal(touches, 1, 'a late one does not')
      fake.emit('stream_start', { messageId: 'b' })
      assert.equal(touches, 2, 'control: a response start touches')
    } finally {
      m.destroyAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records a late block in the session history so a replay shows it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-late-hist-'))
    const m = new SessionManager({ stateFilePath: join(dir, 'state.json'), cwd: '/tmp' })
    try {
      const fake = new EventEmitter()
      m._wireSessionEvents('s1', fake)
      fake.emit('stream_start', { messageId: 'turn-thinking-0', thinking: true, late: true })
      fake.emit('stream_delta', { messageId: 'turn-thinking-0', delta: 'late reasoning', thinking: true, late: true })
      fake.emit('stream_end', { messageId: 'turn-thinking-0', thinking: true, late: true, thinkingDurationMs: 700 })
      const entry = m._messageHistory?.getHistory
        ? m._messageHistory.getHistory('s1').find((e) => e.kind === 'thinking')
        : m.getHistory('s1').find((e) => e.kind === 'thinking')
      assert.ok(entry, 'a thinking entry was recorded')
      assert.equal(entry.content, 'late reasoning')
      assert.equal(entry.thinkingDurationMs, 700)
      assert.ok(!('late' in entry), 'the internal tag is not persisted')
    } finally {
      m.destroyAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not reopen the idle-push dedupe (a late thinking start is not a new busy cycle)', () => {
    const sm = new EventEmitter()
    const handler = new PushNotificationHandler({
      sessionManager: sm, pushManager: { hasConfiguredSinks: () => false, send() {} }, getWsServer: () => undefined,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    })
    handler._idleNotifiedSessions.add('s1')
    handler._onSessionEvent({ sessionId: 's1', event: 'stream_start', data: { messageId: 't', thinking: true, late: true } })
    assert.equal(handler._idleNotifiedSessions.has('s1'), true, 'a late start leaves the dedupe alone')
    handler._onSessionEvent({ sessionId: 's1', event: 'stream_start', data: { messageId: 'r' } })
    assert.equal(handler._idleNotifiedSessions.has('s1'), false, 'control: a real stream_start clears it')
  })
})
