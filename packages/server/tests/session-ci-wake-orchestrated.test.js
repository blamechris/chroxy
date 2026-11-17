import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession, reportInputAdmission } from '../src/base-session.js'
import { SchedulerEngine } from '../src/scheduler.js'
import { TurnDriver } from '../src/orchestration/turn-driver.js'
import { buildOrchestrationManager } from '../src/orchestration/build-manager.js'
import { wakeSession } from '../src/session-wake.js'
import { buildSessionCiWatcher } from '../src/session-ci-watcher.js'

/**
 * #8327 — a session a TurnDriver is driving refuses a daemon wake with
 * `orchestrated`, whichever driver instance holds it (the scheduler's, an
 * orchestration run's), before dispatch and again at flush; occupancy is
 * released on every way a driven turn ends. Real SessionManager, real
 * TurnDriver(s) built through their real construction sites.
 *
 * CRITICAL: every SessionManager uses a temp stateFilePath (#4633).
 */

let tmpDir
function tmpPath(name) {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'ci-wake-orch-'))
  return join(tmpDir, `${name}-${Math.random().toString(36).slice(2)}`)
}
after(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }) })

class FakeTurnSession extends BaseSession {
  static get capabilities() { return { daemonTurnInput: true } }
  constructor(opts = {}) {
    super({ cwd: '/tmp', ...opts })
    this.sent = []
    this.interrupts = 0
  }
  interrupt() { this.interrupts++ }
  sendMessage(prompt, attachments, sendOptions = {}) {
    if (this._isBusy) {
      const queued = this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      reportInputAdmission(sendOptions, queued
        ? { status: 'queued', delivery: 'queued' }
        : { status: 'rejected', delivery: 'not_dispatched', reason: 'queue_full' })
      return
    }
    this._isBusy = true
    this.sent.push(prompt)
    reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
  }
  completeTurn() {
    this._isBusy = false
    this.dequeueNextOutgoing()
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('daemon wakes refuse a session a TurnDriver drives (#8327)', () => {
  let mgr, session, drivers, orchestration

  const ev = (event, data = {}) => mgr.emit('session_event', { sessionId: 's1', event, data })
  // Drivers built through the two REAL construction sites.
  function schedulerDriver() {
    const engine = new SchedulerEngine({ sessionManager: mgr, store: {}, config: {} })
    const d = engine._ensureTurnDriver()
    drivers.push(d)
    return d
  }
  async function orchestrationDriver() {
    orchestration = buildOrchestrationManager({
      sessionManager: mgr,
      config: { features: { orchestration: true } },
      chroxyDir: tmpPath('orch'),
      log: null,
    })
    assert.ok(orchestration, 'orchestration manager built')
    return orchestration._driver
  }

  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, stateFilePath: tmpPath('state') })
    session = new FakeTurnSession()
    mgr._sessions.set('s1', { session, name: 'S1', cwd: '/repo' })
    drivers = []
    orchestration = null
  })
  afterEach(async () => {
    for (const d of drivers) d.dispose()
    await orchestration?.dispose?.()
  })

  const cases = [
    ['scheduler driver', () => schedulerDriver()],
    ['orchestration driver', () => orchestrationDriver()],
  ]

  for (const [name, make] of cases) {
    describe(name, () => {
      it('refuses with orchestrated while a turn runs, admits again once the result lands', async () => {
        const driver = await make()
        assert.equal(mgr.daemonTurnRefusal('s1'), null)
        const turn = driver.driveTurn('s1', 'plan')
        assert.equal(mgr.daemonTurnRefusal('s1'), 'orchestrated')
        ev('result', {})
        await turn
        await tick()
        assert.equal(mgr.daemonTurnRefusal('s1'), null, 'released after the turn')
      })

      it('stays refused across back-to-back queued turns and releases after the last', async () => {
        const driver = await make()
        const a = driver.driveTurn('s1', 'one')
        const b = driver.driveTurn('s1', 'two')
        ev('result', {})
        await a
        await tick()
        assert.equal(mgr.daemonTurnRefusal('s1'), 'orchestrated', 'the handoff gap never reads free')
        ev('result', {})
        await b
        await tick()
        assert.equal(mgr.daemonTurnRefusal('s1'), null)
      })

      for (const [label, terminal] of [
        ['error event', () => ev('error', { message: 'boom' })],
        ['stopped event', () => ev('stopped', {})],
        ['interrupted result', () => ev('result', { interrupted: true })],
        ['session destroyed', () => mgr.emit('session_destroyed', { sessionId: 's1' })],
      ]) {
        it(`releases on ${label}`, async () => {
          const driver = await make()
          const turn = driver.driveTurn('s1', 'x')
          assert.equal(mgr.daemonTurnRefusal('s1'), 'orchestrated')
          terminal()
          await assert.rejects(turn)
          await tick()
          assert.equal(mgr.isTurnDriven('s1'), false)
        })
      }

      it('releases when sendMessage throws', async () => {
        const driver = await make()
        session.sendMessage = () => { throw new Error('socket closing') }
        await assert.rejects(driver.driveTurn('s1', 'x'), { code: 'SEND_FAILED' })
        await tick()
        assert.equal(mgr.isTurnDriven('s1'), false)
      })

      it('on timeout holds through the drain, then releases once the session confirms it stopped', async () => {
        const driver = await make()
        const turn = driver.driveTurn('s1', 'x', { timeoutMs: 15 })
        await assert.rejects(turn, { code: 'TURN_TIMEOUT' })
        assert.equal(session.interrupts, 1)
        assert.equal(mgr.daemonTurnRefusal('s1'), 'orchestrated', 'the interrupted turn is still draining')
        ev('stopped', {})
        await tick()
        assert.equal(mgr.isTurnDriven('s1'), false)
      })

      it('releases when the driver is disposed mid-turn', async () => {
        const driver = await make()
        const turn = driver.driveTurn('s1', 'x')
        assert.equal(mgr.isTurnDriven('s1'), true)
        driver.dispose()
        await assert.rejects(turn, { code: 'SESSION_GONE' })
        assert.equal(mgr.isTurnDriven('s1'), false)
      })
    })
  }

  it('a session held by two drivers stays refused until both let go', async () => {
    const sched = schedulerDriver()
    const orch = await orchestrationDriver()
    const t1 = sched.driveTurn('s1', 'a')
    const t2 = orch.driveTurn('s1', 'b')
    sched.dispose()
    await assert.rejects(t1)
    assert.equal(mgr.daemonTurnRefusal('s1'), 'orchestrated')
    orch.dispose()
    await assert.rejects(t2)
    assert.equal(mgr.daemonTurnRefusal('s1'), null)
  })

  it('a removed session forgets its occupancy', async () => {
    const driver = schedulerDriver()
    driver.driveTurn('s1', 'x').catch(() => {})
    assert.equal(mgr.isTurnDriven('s1'), true)
    mgr._cleanupSessionMaps('s1')
    assert.equal(mgr._turnDriven.has('s1'), false)
  })

  it('ranks after budget-paused, user-stopped and wake-cap, before the provider reason', () => {
    const driver = new TurnDriver({ sessionManager: mgr })
    drivers.push(driver)
    driver.driveTurn('s1', 'x').catch(() => {})
    session.daemonTurnRefusal = () => 'not-started'
    assert.equal(mgr.daemonTurnRefusal('s1'), 'orchestrated')
    for (let i = 0; i < 3; i++) mgr.noteDaemonWake('s1')
    assert.equal(mgr.daemonTurnRefusal('s1', { maxConsecutiveWakes: 3 }), 'wake-cap')
    mgr.recordUserInterrupt('s1')
    assert.equal(mgr.daemonTurnRefusal('s1', { maxConsecutiveWakes: 3 }), 'user-stopped')
  })

  it('a wake queued BEFORE a driver took the session is refused at flush, and the queue keeps draining', async () => {
    session.sendMessage('the user turn') // busy
    const out = wakeSession(session, 'CI finished on PR #1', {
      turnInput: true,
      clientMessageId: 'chroxy-ci-wake-1',
      admitAtFlush: () => mgr.daemonTurnRefusal('s1') === null,
    })
    assert.equal(out, 'queued')
    const driver = schedulerDriver()
    const turn = driver.driveTurn('s1', 'orchestrated step')
    turn.catch(() => {})
    assert.equal(session.outgoingQueueLength, 2, 'wake first, driven prompt behind it')
    session.completeTurn()
    await tick()
    assert.deepEqual(session.sent, ['the user turn', 'orchestrated step'], 'the wake never went out; the driven prompt did')
  })

  describe('through the real CI watcher', () => {
    let pushes, logs, current, watcher
    const snap = (head, state) => ({
      sessionId: 's1',
      generatedAt: '2026-11-16T00:00:00.000Z',
      branch: 'fix/x',
      repo: { owner: 'blamechris', name: 'chroxy' },
      pr: { number: 1, title: 't', url: 'https://github.com/blamechris/chroxy/pull/1', headRefOid: head, isDraft: false },
      checks: state === 'pending'
        ? { state, counts: { total: 2, passed: 0, failed: 0, pending: 2, skipped: 0, unknown: 0 } }
        : { state, counts: { total: 2, passed: 0, failed: 2, pending: 0, skipped: 0, unknown: 0 } },
      merge: { mergeable: 'MERGEABLE', mergeStateStatus: null, reviewDecision: null },
      reason: null,
    })
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
    // One red CI cycle: the run starts, then settles failing.
    async function cycle() {
      current = snap('a'.repeat(40), 'pending')
      await pause(); await watcher.tick()
      current = snap('a'.repeat(40), 'failure')
      await pause(); await watcher.tick()
      await tick()
    }
    beforeEach(() => {
      pushes = []
      logs = []
      watcher = buildSessionCiWatcher({
        config: { sessionCi: { discoveryIntervalMs: 1 } },
        sessionManager: mgr,
        pushManager: { send: async (...args) => { pushes.push(args); return true } },
        logger: { debug() {}, info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
        survey: async () => current,
      })
    })

    it('before dispatch: the push still goes out, nothing is sent, the outcome is orchestrated', async () => {
      const driver = schedulerDriver()
      driver.driveTurn('s1', 'orchestrated step').catch(() => {})
      session.completeTurn() // free the session so only the refusal can stop the wake
      await cycle()
      assert.equal(pushes.length, 1, 'the notification is unaffected')
      assert.deepEqual(session.sent, ['orchestrated step'], 'no wake line reached the session')
      assert.ok(logs.some((l) => l.includes('(wake: orchestrated)')), `logs: ${JSON.stringify(logs)}`)
    })

    it('at flush: a wake the watcher queued before the driver took the session is cancelled', async () => {
      session.sendMessage('the user turn') // busy: the wake will QUEUE
      await cycle()
      assert.equal(session.outgoingQueueLength, 1, 'the wake queued')
      assert.equal(pushes.length, 1)
      const driver = schedulerDriver()
      driver.driveTurn('s1', 'orchestrated step').catch(() => {})
      session.completeTurn()
      await tick()
      assert.deepEqual(session.sent, ['the user turn', 'orchestrated step'], 'the wake was dropped at flush')
    })
  })
})
