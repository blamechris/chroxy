import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'

/**
 * #9267: after a Stop, the 5 s safety timer ends the turn if the child ignored
 * SIGINT. That child used to stay alive and its late answer was accepted as a
 * new `message` + `result` on the already-stopped turn. The timer now retires
 * the child (SIGTERM, then SIGKILL after a grace) and its output is dropped;
 * the next send starts a fresh child whose output is delivered.
 */

const openSessions = []
let nextPid = 900001
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_c, _e, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  // No real pid: killProcessTree must not enumerate/signal real processes.
  child.pid = undefined
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig) }
  child.tag = nextPid++
  return child
}

function cliSession() {
  const session = new CliSession({ cwd: '/tmp' })
  session._processReady = true
  session._child = fakeChild()
  session.on('error', () => {})
  openSessions.push(session)
  session._isBusy = true
  session._currentMessageId = 'm-1'
  session._currentCtx = { hasStreamStarted: false, didStreamText: false, assistantTextSeen: 0, currentContentBlockType: null, currentToolName: null, currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false }
  return session
}

function watch(session) {
  const log = { messages: [], results: [], markers: [] }
  session.on('message', (m) => log.messages.push(m))
  session.on('result', (r) => {
    log.results.push(r)
    if (r.stopMarker || r.marker) log.markers.push(r)
  })
  return log
}

const lateReply = JSON.stringify({ type: 'result', subtype: 'success', result: 'I kept running after SIGINT.', session_id: 's-1', duration_ms: 1 })

describe('claude-cli: a child that ignored SIGINT cannot answer a turn the safety timer ended (#9267)', () => {
  afterEach((t) => {
    t.mock.timers.reset()
    for (const s of openSessions.splice(0)) {
      for (const k of ['_resultTimeout', '_hardTimeout', '_streamStallTimeout', '_interruptTimer']) {
        if (s[k]) { clearTimeout(s[k]); s[k] = null }
      }
    }
  })

  it('drops the late reply and result of the retired child', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const old = session._child
    const w = watch(session)
    session.interrupt()
    t.mock.timers.tick(5000)
    assert.equal(w.results.length, 1, 'the timer reports the stop once')
    session._handleStdoutLine(lateReply, old)
    assert.equal(w.messages.length, 0, 'no message on the ended turn')
    assert.equal(w.results.length, 1, 'no second result')
  })

  it('SIGTERMs the child that ignored SIGINT, SIGKILLing after a grace if it lingers', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const old = session._child
    session.interrupt()
    t.mock.timers.tick(5000)
    assert.deepEqual(old.kills, ['SIGINT', 'SIGTERM'])
    t.mock.timers.tick(3000)
    assert.deepEqual(old.kills, ['SIGINT', 'SIGTERM', 'SIGKILL'])
  })

  it('does not SIGKILL a child that closed within the grace', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const old = session._child
    session.interrupt()
    t.mock.timers.tick(5000)
    old.emit('close', 0)
    t.mock.timers.tick(3000)
    assert.deepEqual(old.kills, ['SIGINT', 'SIGTERM'])
  })

  it('is per child: a message sent after the timer starts a new child whose reply is delivered', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const old = session._child
    const w = watch(session)
    session.interrupt()
    t.mock.timers.tick(5000)
    const fresh = fakeChild()
    session.start = () => { session._child = fresh; session._processReady = true }
    await session.sendMessage('again')
    session._drainPendingQueue() // what the real spawn's `spawn` event does for a message parked behind it
    assert.equal(session._child, fresh)
    session._handleStdoutLine(lateReply, old)
    assert.equal(w.results.length, 1, 'the old child is still ignored')
    session._handleStdoutLine(lateReply, fresh)
    assert.equal(w.results.length, 2, 'the new child answers the new turn')
    assert.equal(w.messages.some((m) => m.content === 'I kept running after SIGINT.'), true)
  })

  it('the retired child\'s close emits no second result, no stopped, no error, no respawn', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const old = session._child
    const w = watch(session)
    const errors = []
    const stopped = []
    session.on('error', (e) => errors.push(e))
    session.on('stopped', (e) => stopped.push(e))
    let respawns = 0
    session._scheduleRespawn = () => { respawns++ }
    session.markStopRequested()
    session.interrupt()
    t.mock.timers.tick(5000)
    old.emit('close', 0)
    assert.equal(w.results.length, 1)
    assert.equal(w.markers.length, 0)
    assert.equal(errors.length, 0)
    assert.equal(stopped.length, 0)
    assert.equal(respawns, 0)
  })

  it('a child that exits promptly after SIGINT behaves as before: one result, stopped, no SIGTERM', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const old = session._child
    const w = watch(session)
    const stopped = []
    session.on('stopped', (e) => stopped.push(e))
    session.interrupt()
    session._handleChildClose(0)
    t.mock.timers.tick(5000)
    assert.equal(w.results.length, 1)
    assert.equal(stopped.length, 1)
    assert.deepEqual(old.kills, ['SIGINT'])
  })
})
