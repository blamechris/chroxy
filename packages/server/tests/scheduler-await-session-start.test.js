import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import { SchedulerEngine } from '../src/scheduler.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #9245 — a scheduled fire into a session whose provider start() is still in
 * flight must wait for the start to settle (bounded) before driving its first
 * turn, and must not drive the turn at all when the start failed or never settled.
 *
 * REAL SessionManager (temp stateFilePath, #4633) + the real engine; the provider
 * mimics ByokSession: sendMessage rejects 'Session not ready' until start() ran.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

class SlowStartProvider extends EventEmitter {
  // Per-test knobs.
  static mode = 'delay' // 'delay' | 'reject' | 'hang' | 'sync'
  static delayMs = 40
  static sends = []
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.resumeSessionId = null
    this._ready = false
  }
  static get capabilities() { return { inProcessPermissions: true } }
  start() {
    const mode = SlowStartProvider.mode
    if (mode === 'sync') { this._ready = true; return undefined }
    if (mode === 'hang') return new Promise(() => {})
    if (mode === 'reject') {
      return new Promise((_, reject) => setTimeout(() => reject(new Error('stub start refused')), SlowStartProvider.delayMs))
    }
    return new Promise((resolve) => setTimeout(() => { this._ready = true; resolve() }, SlowStartProvider.delayMs))
  }
  async sendMessage(prompt) {
    SlowStartProvider.sends.push(prompt)
    if (!this._ready) throw new Error('Session not ready')
    this.emit('result', { cost: 0, duration: 1 })
  }
  respondToPermission() {}
  respondToQuestion() {}
  destroy() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(SlowStartProvider)
registerProvider('test-slow-start-9245', SlowStartProvider)

describe('scheduler waits for a starting session before its first turn (#9245)', () => {
  let dir, store, sm, engine

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-9245-'))
    store = new ScheduledTaskStore({ filePath: join(dir, 'scheduled-tasks.json'), logger: silentLog })
    sm = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: join(dir, 'session-state.json') })
    SlowStartProvider.mode = 'delay'
    SlowStartProvider.delayMs = 40
    SlowStartProvider.sends = []
  })
  afterEach(() => {
    try { engine?.destroy() } catch { /* ignore */ }
    try { sm.destroyAll() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  const newEngine = (extra = {}) => {
    engine = new SchedulerEngine({
      sessionManager: sm,
      store,
      config: { features: { scheduler: true } },
      validateCwd: () => null, // the default cwd (/tmp) is outside $HOME; not under test
      setTimer: () => 1,
      clearTimer: () => {},
      logger: silentLog,
      ...extra,
    })
    return engine
  }
  const addTask = () => store.add({ prompt: 'first fire', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-slow-start-9245' } })
  const fire = async (eng, task) => {
    const ended = new Promise((resolve) => eng.once('run-end', resolve))
    await eng._fire(task, Date.now())
    return ended
  }

  it('the first fire into a slow-starting provider succeeds', async () => {
    const eng = newEngine()
    const task = addTask()
    const res = await fire(eng, task)
    assert.equal(res.status, 'success', res.error)
    assert.deepEqual(SlowStartProvider.sends, ['first fire'])
  })

  it('a provider whose start() rejects fails the run naming the cause and never drives the turn', async () => {
    SlowStartProvider.mode = 'reject'
    const eng = newEngine()
    const res = await fire(eng, addTask())
    assert.equal(res.status, 'error')
    assert.ok(/did not finish starting/.test(res.error) && /stub start refused/.test(res.error), res.error)
    assert.equal(SlowStartProvider.sends.length, 0, 'turn must not be driven')
    assert.equal(eng._ownedRuns.size, 0, 'no owned run is left behind')
  })

  it('a start that never settles within the bound fails the run and never drives the turn', async () => {
    SlowStartProvider.mode = 'hang'
    const eng = newEngine({ runTimeoutMs: 60 })
    const t0 = Date.now()
    // The manager's start and wait timers are unref'd (a daemon has other handles);
    // hold the loop open so the runner does not see a hung promise as a finished loop.
    const keepAlive = setInterval(() => {}, 20)
    let res
    try { res = await fire(eng, addTask()) } finally { clearInterval(keepAlive) }
    assert.equal(res.status, 'error')
    assert.ok(/did not finish starting within 60ms/.test(res.error), res.error)
    assert.ok(Date.now() - t0 < 2000, 'bounded by the injected run timeout, not the 60s provider deadline')
    assert.equal(SlowStartProvider.sends.length, 0, 'turn must not be driven')
    assert.equal(eng._ownedRuns.size, 0, 'no owned run is left behind')
  })

  it('a sync-start provider and a reused settled session are not delayed', async () => {
    SlowStartProvider.mode = 'sync'
    // A long bound: a wait that always blocked would blow the elapsed check below.
    const eng = newEngine({ runTimeoutMs: 30000 })
    const task = addTask()
    let t0 = Date.now()
    const first = await fire(eng, task)
    assert.equal(first.status, 'success', first.error)
    assert.ok(Date.now() - t0 < 1000, 'sync start must not wait')
    t0 = Date.now()
    const second = await fire(eng, task)
    assert.equal(second.status, 'success', second.error)
    assert.equal(second.sessionId, first.sessionId, 'the session was reused')
    assert.ok(Date.now() - t0 < 1000, 'a reused session must not wait')
    assert.equal(SlowStartProvider.sends.length, 2)
  })

  it('a slow-start session reused on a later fire is already settled and not delayed', async () => {
    const eng = newEngine({ runTimeoutMs: 30000 })
    const task = addTask()
    const first = await fire(eng, task)
    assert.equal(first.status, 'success', first.error)
    const t0 = Date.now()
    const second = await fire(eng, task)
    assert.equal(second.status, 'success', second.error)
    assert.ok(Date.now() - t0 < 30, 'settled reuse must not wait')
  })
})
