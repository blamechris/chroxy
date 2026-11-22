import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Writable, Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CliSession } from '../src/cli-session.js'
import { recordProcessTree, killRecordedTree, processStartTime } from '../src/platform.js'

/**
 * #9267: a child the Stop safety timer retired is no longer `_child`, so its process
 * tree must still be reaped: a descendant that ignores SIGTERM is SIGKILLed at the
 * escalation even though the parent already exited, a recorded pid whose start time
 * changed (recycled) is never signalled, and destroy() reaches the retired tree.
 *
 * Every process table, start time and signal is INJECTED (`_treeDeps` / the platform
 * `deps` seams): no real process is enumerated or signalled.
 */

const PARENT = 7000

/** A fake process world: pid -> { ppid, started }, plus a record of every signal sent. */
function world(procs) {
  const w = { procs: { ...procs }, signals: [] }
  w.deps = {
    ps: () => Object.entries(w.procs).map(([pid, p]) => `${pid} ${p.ppid}`).join('\n'),
    startTimeOf: (pid) => w.procs[pid]?.started ?? null,
    kill: (pid, sig) => { w.signals.push([pid, sig]) },
  }
  return w
}

function fakeChild({ onKill } = {}) {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(_c, _e, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = PARENT
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig); onKill?.(sig) }
  return child
}

const open = []
function busySession(w, child) {
  const session = new CliSession({ cwd: '/tmp' })
  open.push(session)
  session._processReady = true
  session._child = child
  session._treeDeps = w.deps
  session.on('error', () => {})
  session._isBusy = true
  session._currentMessageId = 'm-1'
  return session
}

afterEach((t) => {
  t.mock.timers.reset()
  for (const s of open.splice(0)) {
    for (const k of ['_resultTimeout', '_hardTimeout', '_streamStallTimeout', '_interruptTimer']) {
      if (s[k]) { clearTimeout(s[k]); s[k] = null }
    }
  }
})

describe('platform: recordProcessTree / killRecordedTree (#9267)', () => {
  it('records live descendants with their start times, and drops one whose start time is unreadable', () => {
    const w = world({
      [PARENT]: { ppid: 1, started: 'p' },
      7001: { ppid: PARENT, started: 'a' },
      7002: { ppid: 7001, started: 'b' },
      7003: { ppid: PARENT, started: null },
    })
    const rec = recordProcessTree({ pid: PARENT }, w.deps)
    assert.deepEqual(rec.map((r) => r.pid).sort(), [7001, 7002])
    assert.deepEqual(rec.find((r) => r.pid === 7002), { pid: 7002, started: 'b' })
  })

  it('signals a recorded descendant only while its start time still matches', () => {
    const w = world({ 7001: { ppid: PARENT, started: 'a' }, 7002: { ppid: PARENT, started: 'b' } })
    const rec = [{ pid: 7001, started: 'a' }, { pid: 7002, started: 'b' }]
    w.procs[7002].started = 'recycled' // the pid now belongs to someone else
    killRecordedTree({ kill() {} }, rec, { force: true, ...w.deps })
    assert.deepEqual(w.signals, [[7001, 'SIGKILL']])
  })

  it('skips a descendant that is already gone', () => {
    const w = world({})
    killRecordedTree({ kill() {} }, [{ pid: 7001, started: 'a' }], { force: true, ...w.deps })
    assert.deepEqual(w.signals, [])
  })

  it('processStartTime honours the injected seam and refuses a nonsense pid', () => {
    assert.equal(processStartTime(7001, { startTimeOf: () => 'x' }), 'x')
    assert.equal(processStartTime(0), null)
    assert.equal(processStartTime(undefined), null)
  })
})

describe('claude-cli: the Stop timer reaps the whole retired tree (#9267)', () => {
  it('a descendant that ignores SIGTERM is SIGKILLed at the escalation although the parent exited on SIGTERM', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const w = world({ [PARENT]: { ppid: 1, started: 'p' }, 7001: { ppid: PARENT, started: 'a' } })
    const child = fakeChild({ onKill: (sig) => { if (sig === 'SIGTERM') { delete w.procs[PARENT]; child.emit('close', 0) } } })
    const session = busySession(w, child)
    session.interrupt()
    t.mock.timers.tick(5000)
    assert.deepEqual(w.signals, [[7001, 'SIGTERM']], 'SIGTERM reached the descendant first')
    assert.deepEqual(child.kills, ['SIGINT', 'SIGTERM'])
    // the parent is gone and the descendant, reparented, ignored SIGTERM
    w.procs[7001].ppid = 1
    t.mock.timers.tick(3000)
    assert.deepEqual(w.signals, [[7001, 'SIGTERM'], [7001, 'SIGKILL']], 'the parent\'s close did not cancel the escalation')
  })

  it('a recorded pid recycled before the escalation is NOT signalled', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const w = world({ [PARENT]: { ppid: 1, started: 'p' }, 7001: { ppid: PARENT, started: 'a' } })
    const child = fakeChild()
    const session = busySession(w, child)
    session.interrupt()
    t.mock.timers.tick(5000)
    w.signals.length = 0
    w.procs[7001] = { ppid: 1, started: 'someone-else' } // the descendant died; the pid was reused
    t.mock.timers.tick(3000)
    assert.deepEqual(w.signals, [], 'never signal a pid whose start time changed')
  })

  it('destroy() after the retirement kills the retired tree immediately and cancels the escalation', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const w = world({ [PARENT]: { ppid: 1, started: 'p' }, 7001: { ppid: PARENT, started: 'a' } })
    const child = fakeChild()
    const session = busySession(w, child)
    session.interrupt()
    t.mock.timers.tick(5000)
    w.signals.length = 0
    child.kills.length = 0
    session.destroy()
    assert.deepEqual(w.signals, [[7001, 'SIGKILL']])
    assert.deepEqual(child.kills, ['SIGKILL'])
    w.signals.length = 0
    t.mock.timers.tick(3000)
    assert.deepEqual(w.signals, [], 'the escalation was cancelled with the session')
  })
})
