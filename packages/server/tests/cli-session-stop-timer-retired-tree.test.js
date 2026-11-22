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
  w.psCalls = 0
  w.taskkills = []
  w.deps = {
    // `isWindows: false` forces the POSIX branch on every OS, so no cell here ever reaches the
    // real taskkill (or ps / process.kill): every table, start time and signal is injected.
    isWindows: false,
    ps: () => { w.psCalls++; return Object.entries(w.procs).map(([pid, p]) => `${pid} ${p.ppid} ${p.started ?? ''}`).join('\n') },
    startTimeOf: () => { throw new Error('per-pid ps -p lookup: the snapshot is the only source') },
    kill: (pid, sig) => { w.signals.push([pid, sig]) },
    taskkill: (pid) => { w.taskkills.push(pid) },
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
  it('records live descendants with their start times from ONE process-table snapshot', () => {
    const w = world({
      [PARENT]: { ppid: 1, started: 'p' },
      7001: { ppid: PARENT, started: 'a' },
      7002: { ppid: 7001, started: 'b' },
      7004: { ppid: 1, started: 'unrelated' },
    })
    const rec = recordProcessTree({ pid: PARENT }, w.deps)
    assert.deepEqual(rec.map((r) => r.pid).sort(), [7001, 7002])
    assert.deepEqual(rec.find((r) => r.pid === 7002), { pid: 7002, started: 'b' })
    assert.equal(w.psCalls, 1, 'one bounded ps call, not one per descendant')
  })

  it('records NOTHING for a child Node has already reaped (its pid may be recycled): no ps at all', () => {
    const w = world({ [PARENT]: { ppid: 1, started: 'p' }, 7001: { ppid: PARENT, started: 'a' } })
    assert.deepEqual(recordProcessTree({ pid: PARENT, exitCode: 0 }, w.deps), [])
    assert.deepEqual(recordProcessTree({ pid: PARENT, exitCode: null, signalCode: 'SIGTERM' }, w.deps), [])
    assert.equal(w.psCalls, 0)
  })

  it('records NOTHING when the root is not in the snapshot, or ps is unavailable', () => {
    const w = world({ 7001: { ppid: PARENT, started: 'a' } })
    assert.deepEqual(recordProcessTree({ pid: PARENT }, w.deps), [])
    assert.deepEqual(recordProcessTree({ pid: PARENT }, { isWindows: false, ps: () => { throw new Error('no ps') } }), [])
  })

  it('takes ONE process-table snapshot per kill however many descendants were recorded', () => {
    const w = world({
      7001: { ppid: PARENT, started: 'a' }, 7002: { ppid: PARENT, started: 'b' }, 7003: { ppid: 7001, started: 'c' },
    })
    const rec = [{ pid: 7001, started: 'a' }, { pid: 7002, started: 'b' }, { pid: 7003, started: 'c' }]
    killRecordedTree({ kill() {} }, rec, { force: true, ...w.deps })
    assert.equal(w.psCalls, 1)
    assert.equal(w.signals.length, 3)
  })

  it('a failed snapshot signals no descendant, and the handle kill still runs', () => {
    const w = world({ 7001: { ppid: PARENT, started: 'a' } })
    const kills = []
    killRecordedTree({ kill: (s) => kills.push(s) }, [{ pid: 7001, started: 'a' }], { force: true, ...w.deps, ps: () => { throw new Error('no ps') } })
    assert.deepEqual(w.signals, [])
    assert.deepEqual(kills, ['SIGKILL'])
  })

  it('a record without a start time is never signalled', () => {
    // The live process ALSO reports no start time: null === null would otherwise read as a match.
    const w = world({ 7001: { ppid: PARENT, started: null } })
    killRecordedTree({ kill() {} }, [{ pid: 7001, started: null }, { pid: 7001, started: undefined }], { force: true, ...w.deps })
    assert.deepEqual(w.signals, [])
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

describe('platform: killRecordedTree on Windows never taskkills by a possibly-recycled pid (#9267)', () => {
  const win = (w) => ({ ...w.deps, isWindows: true })

  it('a live child gets the tree taskkill once, and no handle kill', () => {
    const w = world({})
    const kills = []
    killRecordedTree({ pid: PARENT, kill: (s) => kills.push(s) }, [], win(w))
    assert.deepEqual(w.taskkills, [PARENT])
    assert.deepEqual(kills, [])
  })

  it('a child that has exited is never taskkilled: the handle only', () => {
    const w = world({})
    const kills = []
    killRecordedTree({ pid: PARENT, exitCode: 0, kill: (s) => kills.push(s) }, [], win(w))
    killRecordedTree({ pid: PARENT, exitCode: null, signalCode: 'SIGTERM', kill: (s) => kills.push(s) }, [], win(w))
    assert.deepEqual(w.taskkills, [])
    assert.equal(kills.length, 2)
  })

  it('the delayed paths (handleOnly: escalation, destroy) never taskkill, even for a child that looks alive', () => {
    const w = world({})
    const kills = []
    killRecordedTree({ pid: PARENT, kill: (s) => kills.push(s) }, [], { ...win(w), force: true, handleOnly: true })
    assert.deepEqual(w.taskkills, [])
    assert.deepEqual(kills, ['SIGKILL'])
  })

  it('a taskkill that fails falls back to the handle', () => {
    const w = world({})
    const kills = []
    killRecordedTree({ pid: PARENT, kill: (s) => kills.push(s) }, [], { ...win(w), taskkill: () => { throw new Error('boom') } })
    assert.deepEqual(kills, ['SIGKILL'])
  })

  it('records no descendants on Windows', () => {
    const w = world({ [PARENT]: { ppid: 1, started: 'p' }, 7001: { ppid: PARENT, started: 'a' } })
    assert.deepEqual(recordProcessTree({ pid: PARENT }, win(w)), [])
    assert.equal(w.psCalls, 0)
  })
})

describe('claude-cli: Stop timer retirement on Windows (#9267)', () => {
  it('taskkills the live child once at retirement; the 3 s escalation and destroy() never taskkill', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const w = world({})
    const child = fakeChild()
    const session = busySession(w, child)
    session._treeDeps = { ...w.deps, isWindows: true }
    session.interrupt()
    t.mock.timers.tick(5000)
    assert.deepEqual(w.taskkills, [PARENT], 'the first kill, while the child is alive, may use the tree taskkill')
    child.exitCode = 0 // exited; its pid may be recycled from here on
    child.emit('close', 0)
    t.mock.timers.tick(3000)
    session.destroy()
    assert.deepEqual(w.taskkills, [PARENT], 'nothing after the child exited goes by pid')
  })
})

describe('claude-cli: the Stop timer reaps the whole retired tree (#9267)', () => {
  it('a descendant that ignores SIGTERM is SIGKILLed at the escalation after the parent exited on SIGTERM (fake child: the production close listener is pinned by the real-wiring cell in cli-session-stop-timer-late-reply.test.js)', (t) => {
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
