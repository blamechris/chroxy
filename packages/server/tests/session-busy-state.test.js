/**
 * #8302 — why a session reads busy.
 *
 * `isRunning` merges "the model is mid-turn" with "the model is idle but a
 * background shell is still tracked". The wire carried only the merged boolean,
 * so a session held busy by a dead shell read as "Working". These tests pin the
 * derivation, its two invariants, and that every server surface that publishes
 * `isBusy` publishes the reason beside it.
 *
 * CRITICAL: SessionManager here uses a temp stateFilePath (#4633).
 */
import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaseSession } from '../src/base-session.js'
import { SessionManager } from '../src/session-manager.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { deriveBusyReason, busyStateOf, BUSY_REASONS } from '../src/session-busy-state.js'
import { UserShellSession } from '../src/user-shell-session.js'
import { ServerSessionListEntrySchema, ServerBackgroundWorkChangedSchema } from '@chroxy/protocol'

let tmp
function tmpPath(name) {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'busy-state-test-'))
  return join(tmp, name)
}
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

// BaseSession has no destroy(); the tracker's sweep timer is the only resource.
const dispose = (session) => session._backgroundShellTracker.destroy()

function makeSession() {
  return new BaseSession({ cwd: '/tmp', skillsDir: tmpPath('skills'), repoSkillsDir: null })
}

describe('deriveBusyReason', () => {
  it('is null whenever the session is not running, whatever else is true', () => {
    assert.equal(deriveBusyReason(false, false, 0), null)
    assert.equal(deriveBusyReason(false, true, 3), null)
    assert.equal(deriveBusyReason(false, false, 3), null)
  })

  it('is "turn" while the model is mid-turn, with or without shells', () => {
    assert.equal(deriveBusyReason(true, true, 0), 'turn')
    assert.equal(deriveBusyReason(true, true, 2), 'turn')
  })

  it('is "background-shells" only when idle AND a shell is tracked', () => {
    assert.equal(deriveBusyReason(true, false, 1), 'background-shells')
  })

  it('reads "turn" for a running session with no turn and no shell (the pre-#8302 meaning of busy)', () => {
    assert.equal(deriveBusyReason(true, false, 0), 'turn')
  })

  it('only ever returns a declared reason or null', () => {
    for (const running of [true, false]) for (const turn of [true, false]) for (const n of [0, 1, 5]) {
      const r = deriveBusyReason(running, turn, n)
      assert.ok(r === null || BUSY_REASONS.includes(r), `${running}/${turn}/${n} -> ${r}`)
    }
  })
})

describe('BaseSession busy getters', () => {
  let session
  beforeEach(() => { session = makeSession() })
  afterEach(() => { dispose(session) })

  it('idle: no reason, no shells', () => {
    assert.equal(session.isRunning, false)
    assert.equal(session.turnActive, false)
    assert.equal(session.backgroundShellCount, 0)
    assert.equal(session.busyReason, null)
  })

  it('mid-turn: "turn"', () => {
    session._isBusy = true
    assert.equal(session.turnActive, true)
    assert.equal(session.busyReason, 'turn')
  })

  it('mid-turn WITH a shell is still "turn": the model is the thing working', () => {
    session._isBusy = true
    session.trackBackgroundShell({ shellId: 'a' })
    assert.equal(session.busyReason, 'turn')
    assert.equal(session.backgroundShellCount, 1)
  })

  it('idle model holding a tracked shell: "background-shells", and isBusy is unchanged (true)', () => {
    session.trackBackgroundShell({ shellId: 'a' })
    assert.equal(session.isRunning, true, 'isBusy semantics are untouched')
    assert.equal(session.turnActive, false)
    assert.equal(session.busyReason, 'background-shells')
    assert.equal(session.backgroundShellCount, 1)
  })

  it('counts an advisory-quiesced shell even though the banner list hides it', () => {
    session.trackBackgroundShell({ shellId: 'a' })
    session._pendingBackgroundShells.get('a').quiesced = true
    assert.deepEqual(session.getPendingBackgroundShells(), [], 'precondition: hidden from the banner list')
    assert.equal(session.isRunning, true)
    assert.equal(session.backgroundShellCount, 1, 'the count is the tracker size, not the list length')
    assert.equal(session.busyReason, 'background-shells')
  })

  it('returns to null once the shell is cleared', () => {
    session.trackBackgroundShell({ shellId: 'a' })
    session.clearBackgroundShell('a')
    assert.equal(session.busyReason, null)
    assert.equal(session.backgroundShellCount, 0)
  })

  it('holds the two invariants across every combination', () => {
    for (const turn of [false, true]) for (const shells of [0, 1, 3]) {
      const s = makeSession()
      s._isBusy = turn
      for (let i = 0; i < shells; i++) s.trackBackgroundShell({ shellId: `x${i}` })
      const isBusy = s.isRunning
      assert.equal(s.busyReason === null, !isBusy, `null <=> !isBusy (turn=${turn} shells=${shells})`)
      if (s.busyReason === 'background-shells') {
        assert.equal(s.turnActive, false)
        assert.ok(s.backgroundShellCount > 0)
      }
      dispose(s)
    }
  })

  it('a user shell (isRunning is PTY liveness, no turn) keeps null <=> !isBusy', () => {
    const shell = Object.create(UserShellSession.prototype)
    shell._isBusy = false
    shell._backgroundShellTracker = { size: 0 }
    shell._shellAlive = true
    assert.equal(shell.isRunning, true)
    assert.equal(shell.busyReason, 'turn', 'busy with no turn and no shell reads as the pre-#8302 "busy"')
    shell._shellAlive = false
    assert.equal(shell.busyReason, null)
  })
})

describe('busyStateOf (the publish boundary)', () => {
  it('projects a BaseSession in each state', () => {
    const s = makeSession()
    assert.deepEqual(busyStateOf(s), { busyReason: null, backgroundShellCount: 0 })
    s._isBusy = true
    assert.deepEqual(busyStateOf(s), { busyReason: 'turn', backgroundShellCount: 0 })
    s._isBusy = false
    s.trackBackgroundShell({ shellId: 'a' })
    assert.deepEqual(busyStateOf(s), { busyReason: 'background-shells', backgroundShellCount: 1 })
    dispose(s)
  })

  it('gives a provider without the getters the pre-#8302 reading', () => {
    assert.deepEqual(busyStateOf({ isRunning: true }), { busyReason: 'turn', backgroundShellCount: 0 })
    assert.deepEqual(busyStateOf({ isRunning: false }), { busyReason: null, backgroundShellCount: 0 })
    assert.deepEqual(busyStateOf(null), { busyReason: null, backgroundShellCount: 0 })
  })

  it('never lets a wrong provider put a contradiction on the wire', () => {
    // Busy but claims no reason.
    assert.equal(busyStateOf({ isRunning: true, busyReason: null }).busyReason, 'turn')
    // Not busy but claims a reason.
    assert.equal(busyStateOf({ isRunning: false, busyReason: 'turn', backgroundShellCount: 2 }).busyReason, null)
    // Claims shell-held with no shell.
    assert.equal(busyStateOf({ isRunning: true, busyReason: 'background-shells', backgroundShellCount: 0 }).busyReason, 'turn')
    // An undeclared reason.
    assert.equal(busyStateOf({ isRunning: true, busyReason: 'banana' }).busyReason, 'turn')
    // A garbage count.
    for (const bad of [-1, 1.5, NaN, '3', null, Infinity]) {
      assert.equal(busyStateOf({ isRunning: true, backgroundShellCount: bad }).backgroundShellCount, 0, String(bad))
    }
  })
})

describe('SessionManager.listSessions publishes the reason (#8302)', () => {
  let mgr
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpPath(`state-${Math.random().toString(36).slice(2)}.json`) })
  })
  afterEach(() => { mgr.destroyAll() })

  const entryFor = (session) => {
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp', createdAt: Date.now() })
    return mgr.listSessions().find((e) => e.sessionId === 's1')
  }

  it('idle: isBusy false, busyReason null, no shells', () => {
    const e = entryFor(makeSession())
    assert.equal(e.isBusy, false)
    assert.equal(e.busyReason, null)
    assert.equal(e.backgroundShellCount, 0)
  })

  it('mid-turn: isBusy true, busyReason "turn"', () => {
    const s = makeSession()
    s._isBusy = true
    const e = entryFor(s)
    assert.equal(e.isBusy, true)
    assert.equal(e.busyReason, 'turn')
  })

  it('idle model held busy only by a shell: isBusy stays true and the reason says why', () => {
    const s = makeSession()
    s.trackBackgroundShell({ shellId: 'a' })
    const e = entryFor(s)
    assert.equal(e.isBusy, true, 'isBusy is unchanged')
    assert.equal(e.busyReason, 'background-shells')
    assert.equal(e.backgroundShellCount, 1)
    assert.equal(e.pendingBackgroundShells.length, 1)
  })

  it('a quiesced shell: pendingBackgroundShells is [] yet the session is busy, and the count explains it', () => {
    const s = makeSession()
    s.trackBackgroundShell({ shellId: 'a' })
    s._pendingBackgroundShells.get('a').quiesced = true
    const e = entryFor(s)
    assert.deepEqual(e.pendingBackgroundShells, [])
    assert.equal(e.isBusy, true)
    assert.equal(e.busyReason, 'background-shells')
    assert.equal(e.backgroundShellCount, 1, 'the wire can now say WHY busy with an empty list')
  })

  it('invariants hold on every published entry', () => {
    for (const [turn, shells] of [[false, 0], [true, 0], [false, 2], [true, 2]]) {
      const s = makeSession()
      s._isBusy = turn
      for (let i = 0; i < shells; i++) s.trackBackgroundShell({ shellId: `x${i}` })
      const e = entryFor(s)
      assert.equal(e.busyReason === null, !e.isBusy, `null <=> !isBusy (turn=${turn} shells=${shells})`)
      if (e.busyReason === 'background-shells') {
        assert.equal(turn, false)
        assert.ok(e.backgroundShellCount > 0)
      }
      // and it parses against the wire schema
      assert.equal(ServerSessionListEntrySchema.safeParse(e).success, true, JSON.stringify(ServerSessionListEntrySchema.safeParse(e).error?.issues))
    }
  })

  it('an old-shape stub session without the getters still lists, with the pre-#8302 reading', () => {
    const stub = Object.assign(new EventEmitter(), { isRunning: true, destroy() {}, getPendingBackgroundShells: () => [] })
    const e = entryFor(stub)
    assert.equal(e.isBusy, true)
    assert.equal(e.busyReason, 'turn')
    assert.equal(e.backgroundShellCount, 0)
  })
})

describe('background_work_changed carries the reason (#8302)', () => {
  const norm = new EventNormalizer()
  const ctxFor = (session) => ({ sessionId: 's1', mode: 'multi', getSessionEntry: () => (session ? { session } : null) })

  it('stamps busyReason and the tracker count from the live session', () => {
    const s = makeSession()
    s.trackBackgroundShell({ shellId: 'a' })
    s._pendingBackgroundShells.get('a').quiesced = true
    const { messages } = norm.normalize('background_work_changed', { pending: s.getPendingBackgroundShells() }, ctxFor(s))
    const msg = messages[0].msg
    assert.deepEqual(msg.pending, [])
    assert.equal(msg.busyReason, 'background-shells')
    assert.equal(msg.backgroundShellCount, 1)
    assert.equal(ServerBackgroundWorkChangedSchema.safeParse(msg).success, true)
  })

  it('reads "turn" mid-turn and null once everything is idle', () => {
    const s = makeSession()
    s._isBusy = true
    assert.equal(norm.normalize('background_work_changed', { pending: [] }, ctxFor(s)).messages[0].msg.busyReason, 'turn')
    s._isBusy = false
    const idle = norm.normalize('background_work_changed', { pending: [] }, ctxFor(s)).messages[0].msg
    assert.equal(idle.busyReason, null)
    assert.equal(idle.backgroundShellCount, 0)
  })

  it('OMITS both fields (never null) when the session cannot be resolved: unknown is not idle', () => {
    const msg = norm.normalize('background_work_changed', { pending: [] }, ctxFor(null)).messages[0].msg
    assert.equal('busyReason' in msg, false)
    assert.equal('backgroundShellCount' in msg, false)
    assert.equal(ServerBackgroundWorkChangedSchema.safeParse(msg).success, true, 'an old-shape message still validates')
  })

  it('the tracker emits it on clear, with the post-clear reason', () => {
    const s = makeSession()
    const seen = []
    s.on('background_work_changed', (d) => seen.push(d))
    s.trackBackgroundShell({ shellId: 'a' })
    s.clearBackgroundShell('a')
    const last = norm.normalize('background_work_changed', seen[seen.length - 1], ctxFor(s)).messages[0].msg
    assert.equal(last.busyReason, null)
    assert.deepEqual(last.pending, [])
  })
})
