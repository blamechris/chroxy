import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { SessionManager } from '../src/session-manager.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'
import { SchedulerEngine, BUSY_SKIP_LIMIT } from '../src/scheduler.js'
import { registerProvider } from '../src/providers.js'
import { BaseSession } from '../src/base-session.js'
import { GIT } from '../src/git.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'
import { worktreeHasUnsavedWork, worktreeUnsavedWorkReport, describeUnsavedWork, sanitizeNoticeText } from '../src/worktree-gc.js'
import { disableRepoAutoGc, rmDirRobust } from './test-helpers.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { nsCtx } from './test-helpers.js'

/**
 * #9242 — a scheduled task never drives, and never destroys, a session a person
 * is using.
 *
 * REAL SessionManager (temp stateFilePath, #4633) + the real engine. A client's
 * input goes through the REAL input handler so `recordUserIntent` runs exactly as
 * in production. Worktree cases use a real temp git repo.
 */

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

class Prov extends EventEmitter {
  static sends = [] // { sessionId-ish tag, prompt }
  static terminal = []
  static permissionAnswers = []
  static seq = 0
  constructor(opts) {
    super()
    this.cwd = opts.cwd
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.isRunning = false
    this.turnActive = false
    this.resumeSessionId = null
    this.tag = ++Prov.seq
  }
  static get capabilities() { return { inProcessPermissions: true } }
  start() { return undefined }
  async sendMessage(prompt) {
    Prov.sends.push({ tag: this.tag, prompt })
    setImmediate(() => this.emit('result', { cost: 0, duration: 1 }))
  }
  respondToPermission(...a) { Prov.permissionAnswers.push(a) }
  respondToQuestion() {}
  writeTerminalInput(d) { Prov.terminal.push(d) }
  destroy() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(Prov)
registerProvider('test-leave-used-9242', Prov)

// A real BaseSession (so the real outgoing queue and its flush-time admission run) that
// queues a send while `draining` is set, like SdkSession's draining query (#8321).
class QueueProv extends BaseSession {
  static dispatched = []
  static get capabilities() { return { inProcessPermissions: true } }
  constructor(opts) {
    super({ ...opts, provider: 'test-queue-9242' })
    this.draining = false
    this.resumeSessionId = null
  }
  async start() { this._processReady = true }
  sendMessage(prompt, attachments, sendOptions) {
    if (this.draining) {
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      return undefined
    }
    QueueProv.dispatched.push(prompt)
    setImmediate(() => this.emit('result', { cost: 0, duration: 1 }))
    return undefined
  }
  respondToPermission() {}
  respondToQuestion() {}
  destroy() { this._destroying = true }
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(QueueProv)
registerProvider('test-queue-9242', QueueProv)

async function waitFor(pred, what) {
  const deadline = Date.now() + 3000
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('a scheduled task leaves a session a person is using alone (#9242)', () => {
  let dir, stateFile, store, mgrs, engines, repos, logs

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-9242-'))
    stateFile = join(dir, 'session-state.json')
    store = new ScheduledTaskStore({ filePath: join(dir, 'scheduled-tasks.json'), logger: silentLog })
    mgrs = []
    engines = []
    repos = []
    logs = []
    Prov.sends = []
    Prov.terminal = []
    Prov.permissionAnswers = []
  })
  afterEach(() => {
    for (const e of engines) { try { e.destroy() } catch { /* ignore */ } }
    for (const m of mgrs) { try { m.destroyAll() } catch { /* ignore */ } }
    for (const r of repos) { try { rmDirRobust(r) } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const newMgr = (extra = {}) => {
    const m = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: stateFile, persistDebounceMs: 10, ...extra })
    mgrs.push(m)
    return m
  }
  const capLog = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug() {} }
  // The keep/leave decision is made synchronously in _destroyTaskSession, so its log line
  // is the positive signal that the "survived" assertions below really ran the keep path.
  const sawLog = (re) => logs.some((l) => re.test(l))
  const newEngine = (sm) => {
    const e = new SchedulerEngine({
      sessionManager: sm,
      store,
      config: { features: { scheduler: true } },
      validateCwd: () => null,
      setTimer: () => 1,
      clearTimer: () => {},
      logger: capLog,
    })
    engines.push(e)
    e.start()
    return e
  }
  const addTask = () => store.add({ prompt: 'scheduled prompt', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-leave-used-9242' } })
  const fire = async (eng, task) => {
    const ended = new Promise((resolve) => eng.once('run-end', resolve))
    await eng._fire(task, Date.now())
    return ended
  }
  const ids = (sm) => sm.listSessions().map((s) => s.sessionId).sort()
  const codes = (sm, id) => sm.getHandoffBlockers(id).map((b) => b.code)
  const linkOnDisk = (id) => JSON.parse(readFileSync(stateFile, 'utf8')).sessions.find((s) => s.id === id)?.scheduledTaskId
  const promptsTo = (sm, id) => Prov.sends.filter((s) => s.tag === sm.getSession(id).session.tag).map((s) => s.prompt)

  /** A real-handler ctx over `sm`; `intents` counts recordUserIntent calls. */
  const intents = []
  const handlerCtx = (sm, extra = {}) => nsCtx({
    sessionManager: {
      getSession: (id) => sm.getSession(id),
      isBudgetPaused: (id) => sm.isBudgetPaused(id),
      recordUserInput: (...x) => sm.recordUserInput(...x),
      recordUserIntent: (id) => { intents.push(id); return sm.recordUserIntent(id) },
      recordQuestionAnswered: () => {},
      releaseScheduledTaskLink: (id) => sm.releaseScheduledTaskLink(id),
      touchActivity: (id) => sm.touchActivity(id),
      getHistoryCount: () => 0,
      listSessions: () => sm.listSessions(),
    },
    send: () => {}, broadcast: () => {}, broadcastToSession: () => {},
    updatePrimary: () => {}, claimPrimary: () => ({ changed: false, primaryClientId: 'c1' }),
    getPrimary: () => 'c1', isPrimary: () => true,
    checkpointManager: { createCheckpoint: () => Promise.resolve() },
    permissionSessionMap: new Map(), questionSessionMap: new Map(), pendingPermissions: new Map(), clients: new Map(),
    ...extra,
  })
  const sendMsg = (sm, sessionId, msg, extra) => handleSessionMessage({}, { id: 'c1', activeSessionId: sessionId, clientCapabilities: new Set() }, msg, handlerCtx(sm, extra))

  /** A person sends input to `sessionId` through the real client input handler. */
  const personTypes = async (sm, sessionId, data = 'my own work') => {
    const ctx = nsCtx({
      sessionManager: {
        getSession: (id) => sm.getSession(id),
        isBudgetPaused: (id) => sm.isBudgetPaused(id),
        recordUserInput: (...x) => sm.recordUserInput(...x),
        recordUserIntent: (id) => sm.recordUserIntent(id),
        touchActivity: (id) => sm.touchActivity(id),
        getHistoryCount: () => 0,
        listSessions: () => [],
      },
      send: () => {}, broadcast: () => {}, broadcastToSession: () => {},
      updatePrimary: () => {}, claimPrimary: () => ({ changed: false, primaryClientId: 'c1' }),
      getPrimary: () => 'c1', isPrimary: () => true,
      checkpointManager: { createCheckpoint: () => Promise.resolve() },
      permissionSessionMap: new Map(), questionSessionMap: new Map(), pendingPermissions: new Map(), clients: new Map(),
    })
    await handleSessionMessage({}, { id: 'c1', activeSessionId: sessionId, clientCapabilities: new Set() }, { type: 'input', data, clientMessageId: `u-${Math.random()}` }, ctx)
  }

  describe('a person using the task session', () => {
    it('input to the task session ends its ownership; the next fire does not interleave with it', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const first = await fire(eng, task)
      assert.equal(first.status, 'success', first.error)
      const s = first.sessionId
      assert.deepEqual(codes(sm, s), ['automation_owned'], 'control: owned while the scheduler drives it')

      await personTypes(sm, s)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt', 'my own work'], 'the person\'s input reached their session')
      assert.deepEqual(codes(sm, s), [], 'released: no longer automation-owned')

      const second = await fire(eng, task)
      assert.equal(second.status, 'success', second.error)
      assert.notEqual(second.sessionId, s, 'the task moved to a fresh session')
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt', 'my own work'], 'the person\'s session got no further scheduled prompt')
      assert.deepEqual(promptsTo(sm, second.sessionId), ['scheduled prompt'])
      assert.deepEqual(ids(sm), [s, second.sessionId].sort())
    })

    it('a fire while the session is mid-turn is skipped, never driven into the turn', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const first = await fire(eng, task)
      const s = first.sessionId
      const live = sm.getSession(s).session
      live.isRunning = true
      live.turnActive = true

      const second = await fire(eng, task)
      assert.equal(second.status, 'skipped', second.error)
      assert.match(second.error, /busy/i)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt'], 'nothing was sent into the busy session')
      assert.deepEqual(ids(sm), [s], 'and no extra session was minted')
      assert.equal(store.get(task.id).lastRun.status, 'skipped', 'recorded, so the schedule advances')

      live.isRunning = false
      live.turnActive = false
      const third = await fire(eng, task)
      assert.equal(third.status, 'success', third.error)
      assert.equal(third.sessionId, s, 'idle again: the same session is reused')
    })

    it('a session held only by background shells is not busy', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const live = sm.getSession(s).session
      live.isRunning = true
      live.turnActive = false
      live.backgroundShellCount = 2
      live.busyReason = 'background-shells'
      const second = await fire(eng, task)
      assert.equal(second.status, 'success', second.error)
      assert.equal(second.sessionId, s)
    })

    it('a person who takes the session over while the start wait is pending still wins', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const realWait = sm.awaitSessionStart.bind(sm)
      sm.awaitSessionStart = (sid, ms) => {
        const p = realWait(sid, ms)
        // The person's intent lands while the scheduler is awaiting the start.
        sm.recordUserIntent(sid)
        return p
      }
      const second = await fire(eng, task)
      assert.equal(second.status, 'skipped', second.error)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt'])
    })

    it('deleting the task right after a person took over does not close their session, even before the next adoption pass', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      await personTypes(sm, s)
      store.remove(task.id)
      eng._releaseSessions() // the pass that follows a deletion, WITHOUT the adoption pass first
      assert.ok(sawLog(/leaving its session .* open \(no longer owned/), 'the leave-alone branch ran')
      assert.ok(sm.getSession(s), 'the person\'s session survived')
      eng.refresh()
      assert.ok(sm.getSession(s), 'still there after a full refresh')
    })

    it('the release survives a restart: the session is not re-adopted and the task gets a fresh one', async () => {
      const first = newMgr()
      const eng1 = newEngine(first)
      const task = addTask()
      const s = (await fire(eng1, task)).sessionId
      await waitFor(() => linkOnDisk(s) === task.id, 'the ownership link on disk')
      await personTypes(first, s)
      await waitFor(() => linkOnDisk(s) === undefined, 'the release to reach the state file')
      eng1.destroy()
      first.destroyAll()

      const second = newMgr()
      assert.ok(second.restoreState(), 'restored')
      assert.deepEqual(second.listScheduledTaskSessions(), [], 'no link survived')
      const eng2 = newEngine(second)
      eng2.start()
      assert.equal(eng2.scheduledSessionIds.has(task.id), false)
      const res = await fire(eng2, task)
      assert.equal(res.status, 'success', res.error)
      assert.notEqual(res.sessionId, s)
    })

    it('a task whose session nobody touched is still reused and still destroyed on deletion (control)', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      assert.equal((await fire(eng, task)).sessionId, s, 'reused')
      store.remove(task.id)
      eng.refresh()
      await waitFor(() => !sm.getSession(s), 'the session to be closed')
    })

    it('releaseScheduledOwnership refuses a session owned by another task and an unowned one', () => {
      const sm = newMgr()
      const mine = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: 't-mine' } })
      const plain = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242' })
      assert.equal(sm.releaseScheduledOwnership(mine, 't-other'), false)
      assert.equal(sm.getSession(mine).metadata.scheduledTaskId, 't-mine')
      assert.equal(sm.releaseScheduledOwnership(plain, 't-mine'), false)
      assert.equal(sm.releaseScheduledOwnership(mine, 't-mine'), true)
      assert.equal(sm.getSession(mine).metadata?.scheduledTaskId, undefined)
    })

    it('release keeps the session\'s other metadata', () => {
      const sm = newMgr()
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: 't-x', orchestrationRunId: 'run_1' } })
      sm.recordUserIntent(id)
      assert.deepEqual(sm.getSession(id).metadata, { orchestrationRunId: 'run_1' })
    })
  })

  describe('every human answer and the dispatch/crash windows (#9242 round 2)', () => {
    it('answering a question in the task session releases it (real user_question_response handler)', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      assert.deepEqual(codes(sm, s), ['automation_owned'])
      const ctx = nsCtx({
        sessionManager: { getSession: (id) => sm.getSession(id), recordUserIntent: (id) => sm.recordUserIntent(id), recordQuestionAnswered: () => {} },
        send: () => {}, broadcast: () => {}, broadcastToSession: () => {},
        permissionSessionMap: new Map(), questionSessionMap: new Map(), pendingPermissions: new Map(), clients: new Map(),
      })
      await handleSessionMessage({}, { id: 'c1', activeSessionId: s, clientCapabilities: new Set() }, { type: 'user_question_response', answer: 'yes' }, ctx)
      assert.deepEqual(codes(sm, s), [], 'the answer released the session')
      const second = await fire(eng, task)
      assert.notEqual(second.sessionId, s)
      assert.deepEqual(promptsTo(sm, s), ['scheduled prompt'])
    })

    it('release is written to the state file immediately, before any timer', () => {
      const sm = newMgr({ persistDebounceMs: 600000 })
      const id = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: 't-crash' } })
      sm._flushPersist()
      assert.equal(linkOnDisk(id), 't-crash', 'control: the link is on disk')
      assert.equal(sm.releaseScheduledOwnership(id, 't-crash'), true)
      assert.equal(linkOnDisk(id), undefined, 'gone from disk with no timer having run')
      sm.destroyAll()
      const fresh = newMgr()
      assert.ok(fresh.restoreState())
      assert.deepEqual(fresh.listScheduledTaskSessions(), [], 'a restart cannot re-adopt it')
    })

    it('a scheduled prompt queued inside the provider is dropped, not dispatched, when a person takes over before the flush', async () => {
      QueueProv.dispatched = []
      const sm = newMgr()
      const eng = new SchedulerEngine({ sessionManager: sm, store, config: { features: { scheduler: true } }, validateCwd: () => null, setTimer: () => 1, clearTimer: () => {}, logger: silentLog })
      engines.push(eng)
      eng.start()
      const task = store.add({ prompt: 'queued scheduled', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-queue-9242' } })
      const ended = new Promise((resolve) => eng.once('run-end', resolve))
      const s = sm.createSession({ cwd: '/tmp', provider: 'test-queue-9242', metadata: { scheduledTaskId: task.id } })
      eng.refresh()
      const live = sm.getSession(s).session
      live.draining = true
      const firing = eng._fire(store.get(task.id), Date.now())
      await waitFor(() => live._outgoingQueue.length === 1, 'the prompt to queue')
      assert.equal(live._outgoingQueue.length, 1, 'premise: the prompt is queued inside the provider')
      sm.recordUserIntent(s) // the person takes over before the queue flushes
      live.draining = false
      live.dequeueNextOutgoing()
      await firing
      const res = await ended
      assert.deepEqual(QueueProv.dispatched, [], 'the scheduled prompt was never dispatched')
      assert.equal(res.status, 'skipped', res.error)
      assert.match(res.error, /taken over/)
    })

    it('control: a queued scheduled prompt still flushes while the task owns the session', async () => {
      QueueProv.dispatched = []
      const sm = newMgr()
      const eng = new SchedulerEngine({ sessionManager: sm, store, config: { features: { scheduler: true } }, validateCwd: () => null, setTimer: () => 1, clearTimer: () => {}, logger: silentLog })
      engines.push(eng)
      eng.start()
      const task = store.add({ prompt: 'queued scheduled', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-queue-9242' } })
      const ended = new Promise((resolve) => eng.once('run-end', resolve))
      const s = sm.createSession({ cwd: '/tmp', provider: 'test-queue-9242', metadata: { scheduledTaskId: task.id } })
      eng.refresh()
      const live = sm.getSession(s).session
      live.draining = true
      const firing = eng._fire(store.get(task.id), Date.now())
      await waitFor(() => live._outgoingQueue.length === 1, 'the prompt to queue')
      live.draining = false
      live.dequeueNextOutgoing()
      await firing
      assert.equal((await ended).status, 'success')
      assert.deepEqual(QueueProv.dispatched, ['queued scheduled'])
    })
  })

  describe('remaining takeover paths (#9242 round 3)', () => {
    it('a hint-only (unadopted) session is released on disk immediately by a person, and a restart does not re-adopt it', async () => {
      const first = newMgr()
      const task = addTask()
      const id = first.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: task.id } })
      first.serializeState()
      first.destroyAll()
      const second = newMgr({ persistDebounceMs: 600000 })
      assert.ok(second.restoreState())
      assert.equal(second.getSession(id).restoredScheduledTaskId, task.id, 'premise: a hint, not adopted')
      assert.equal(linkOnDisk(id), task.id, 'premise: on disk')
      second.recordUserIntent(id)
      assert.equal(linkOnDisk(id), undefined, 'gone from disk with no timer having run')
      second.destroyAll()
      const third = newMgr()
      assert.ok(third.restoreState())
      assert.deepEqual(third.listScheduledTaskSessions(), [])
    })

    it('terminal input with a newline releases the session; a bare keystroke does not (real handler)', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      await sendMsg(sm, s, { type: 'terminal_input', data: 'abc' })
      assert.deepEqual(Prov.terminal, ['abc'], 'premise: delivered')
      assert.deepEqual(codes(sm, s), ['automation_owned'], 'a bare keystroke is not a submission')
      await sendMsg(sm, s, { type: 'terminal_input', data: 'go\n' })
      assert.deepEqual(codes(sm, s), [], 'a submitted line releases')
    })

    it('a person\'s permission_response does NOT release the session (scheduled runs deny prompts themselves)', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      intents.length = 0
      await sendMsg(sm, s, { type: 'permission_response', requestId: 'req-1', decision: 'allow' }, { permissionSessionMap: new Map([['req-1', s]]) })
      assert.deepEqual(intents, [], 'no user intent was recorded')
      assert.deepEqual(codes(sm, s), ['automation_owned'], 'still owned')
    })

    describe('checkpoint Files restore', () => {
      const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
      const restoreMsg = { type: 'restore_checkpoint', checkpointId: 'cp1', mode: 'files' }

      it('claims an OWNED session before the restore resolves: a fire during the pending restore does not drive it', async () => {
        const sm = newMgr()
        const eng = newEngine(sm)
        const task = addTask()
        const s = (await fire(eng, task)).sessionId
        const d = deferred()
        const pending = sendMsg(sm, s, restoreMsg, { checkpointManager: { getCheckpoint: () => ({ id: 'cp1', cwd: '/tmp', name: 'cp', resumeSessionId: null }), restoreCheckpoint: () => d.promise } })
        assert.deepEqual(codes(sm, s), [], 'released synchronously, before the restore settled')
        const second = await fire(eng, task)
        assert.notEqual(second.sessionId, s, 'the fire went to a fresh session')
        assert.deepEqual(promptsTo(sm, s), ['scheduled prompt'], 'nothing was driven into the restoring session')
        d.resolve({ id: 'cp1', name: 'cp' })
        await pending
      })

      it('clears an unadopted restore HINT too', async () => {
        const first = newMgr()
        const task = addTask()
        const id = first.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: task.id } })
        first.serializeState()
        first.destroyAll()
        const second = newMgr()
        assert.ok(second.restoreState())
        assert.equal(second.getSession(id).restoredScheduledTaskId, task.id, 'premise: hinted')
        const d = deferred()
        const pending = sendMsg(second, id, restoreMsg, { checkpointManager: { getCheckpoint: () => ({ id: 'cp1', cwd: '/tmp', name: 'cp', resumeSessionId: null }), restoreCheckpoint: () => d.promise } })
        assert.equal(second.getSession(id).restoredScheduledTaskId, undefined, 'hint cleared before the restore settled')
        assert.deepEqual(second.listScheduledTaskSessions(), [])
        d.resolve({ id: 'cp1', name: 'cp' })
        await pending
      })

      it('an unauthorized (revoked) connection\'s restore does not cost the task its session', async () => {
        const sm = newMgr()
        const eng = newEngine(sm)
        const task = addTask()
        const s = (await fire(eng, task)).sessionId
        await sendMsg(sm, s, restoreMsg, {
          checkpointManager: { getCheckpoint: () => ({ id: 'cp1', cwd: '/tmp', name: 'cp', resumeSessionId: null }), restoreCheckpoint: async () => { throw new Error('revoked') } },
          transport: { isConnectionAuthorized: () => false },
        })
        assert.deepEqual(codes(sm, s), ['automation_owned'], 'still owned')
      })

      it('a refused restore (session busy) does not release either', async () => {
        const sm = newMgr()
        const eng = newEngine(sm)
        const task = addTask()
        const s = (await fire(eng, task)).sessionId
        sm.getSession(s).session.isRunning = true
        let restored = 0
        await sendMsg(sm, s, restoreMsg, { checkpointManager: { getCheckpoint: () => ({ id: 'cp1', cwd: '/tmp', name: 'cp', resumeSessionId: null }), restoreCheckpoint: async () => { restored += 1 } } })
        assert.equal(restored, 0, 'premise: refused')
        assert.deepEqual(codes(sm, s), ['automation_owned'])
      })

      it('a conversation-only restore (no file rewrite) does not release', async () => {
        const sm = newMgr()
        const eng = newEngine(sm)
        const task = addTask()
        const s = (await fire(eng, task)).sessionId
        let restored = 0
        await sendMsg(sm, s, { type: 'restore_checkpoint', checkpointId: 'cp1', mode: 'conversation' }, { checkpointManager: { getCheckpoint: () => ({ id: 'cp1', cwd: '/tmp', name: 'cp', resumeSessionId: null }), restoreCheckpoint: async () => { restored += 1 } } })
        assert.equal(restored, 0, 'premise: no file restore ran')
        assert.deepEqual(codes(sm, s), ['automation_owned'])
      })
    })

    it('a session busy for BUSY_SKIP_LIMIT fires in a row is declared stuck: error outcome, released, next fire starts fresh', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const live = sm.getSession(s).session
      live.isRunning = true
      live.turnActive = true
      const outcomes = []
      for (let i = 0; i < BUSY_SKIP_LIMIT; i++) outcomes.push(await fire(eng, task))
      assert.deepEqual(outcomes.map((o) => o.status), ['skipped', 'skipped', 'error'])
      assert.match(outcomes[2].error, /busy for \d+ consecutive/)
      assert.deepEqual(codes(sm, s), [], 'released: an ordinary session now')
      assert.ok(sm.getSession(s), 'and still open to inspect')
      const next = await fire(eng, task)
      assert.equal(next.status, 'success', next.error)
      assert.notEqual(next.sessionId, s, 'a fresh session')
    })

    it('a successful dispatch resets the busy-skip count', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const live = sm.getSession(s).session
      for (let round = 0; round < 3; round++) {
        live.isRunning = true; live.turnActive = true
        assert.equal((await fire(eng, task)).status, 'skipped')
        assert.equal((await fire(eng, task)).status, 'skipped')
        live.isRunning = false; live.turnActive = false
        assert.equal((await fire(eng, task)).status, 'success')
      }
    })

    it('a busy-skipped ONE-SHOT task is not retired: it keeps its nextRun, is retried later, and then runs', async () => {
      const sm = newMgr()
      const clock = 1_700_000_000_000
      const eng = new SchedulerEngine({ sessionManager: sm, store, config: { features: { scheduler: true } }, validateCwd: () => null, setTimer: () => 1, clearTimer: () => {}, logger: capLog, busyRetryMs: 60000, now: () => clock })
      engines.push(eng)
      eng.start()
      const at = clock + 5000
      const task = store.add({ prompt: 'once', cadence: { kind: 'once', at }, target: { provider: 'test-leave-used-9242' } })
      const s = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: task.id } })
      eng.refresh()
      const live = sm.getSession(s).session
      live.isRunning = true; live.turnActive = true
      const res = await fire(eng, store.get(task.id))
      assert.equal(res.status, 'skipped')
      assert.equal(store.get(task.id).lastRun ?? undefined, undefined, 'the skip was not recorded (that would retire it)')
      assert.equal(store.get(task.id).nextRun, at, 'still scheduled')
      assert.equal(eng._retryAt.has(task.id), true, 'held back')
      assert.equal(eng._dueTasks(clock + 1000).length, 0, 'premise: not yet due')
      assert.equal(eng._dueTasks(at + 1000).length, 0, 'not re-fired in a hot loop: held back until the retry time')
      assert.equal(eng._dueTasks(clock + 61000).length, 1, 'due again after the retry delay')
      live.isRunning = false; live.turnActive = false
      const again = await fire(eng, store.get(task.id))
      assert.equal(again.status, 'success', again.error)
      assert.ok(store.get(task.id).lastRun, 'and it ran')
      assert.equal(eng._retryAt.has(task.id), false, 'the hold is dropped once an outcome is recorded')
    })

    it('a one-shot task whose session stays busy is not retired as an error: the stuck session is released and the task runs in a fresh one', async () => {
      const clock = 1_700_000_000_000
      const sm = newMgr()
      const eng = new SchedulerEngine({ sessionManager: sm, store, config: { features: { scheduler: true } }, validateCwd: () => null, setTimer: () => 1, clearTimer: () => {}, logger: capLog, busyRetryMs: 60000, now: () => clock })
      engines.push(eng)
      eng.start()
      const task = store.add({ prompt: 'once', cadence: { kind: 'once', at: clock + 5000 }, target: { provider: 'test-leave-used-9242' } })
      const s = sm.createSession({ cwd: '/tmp', provider: 'test-leave-used-9242', metadata: { scheduledTaskId: task.id } })
      eng.refresh()
      const live = sm.getSession(s).session
      live.isRunning = true; live.turnActive = true
      const outcomes = []
      for (let i = 0; i < BUSY_SKIP_LIMIT; i++) outcomes.push(await fire(eng, store.get(task.id)))
      assert.deepEqual(outcomes.map((o) => o.status), ['skipped', 'skipped', 'skipped'], 'never an error for a one-shot')
      assert.equal(store.get(task.id).lastRun ?? undefined, undefined, 'not retired')
      assert.deepEqual(codes(sm, s), [], 'the stuck session was released')
      assert.equal(eng._dueTasks(clock + 6000).length, 1, 'due again immediately, no retry delay')
      const res = await fire(eng, store.get(task.id))
      assert.equal(res.status, 'success', res.error)
      assert.notEqual(res.sessionId, s, 'in a fresh session')
    })

    it('a destroy waiting on the session lock cannot be typed into: the entry is already hidden from clients (no re-check needed)', async () => {
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = (await fire(eng, task)).sessionId
      const release = await sm._locks.acquire(s)
      store.remove(task.id)
      eng.refresh()
      assert.equal(sm.getSession(s), null, 'hidden synchronously when the destroy was requested, before the lock is won')
      await personTypes(sm, s) // the handler cannot resolve the session: nothing is released or sent
      release()
      await waitFor(() => !sm._sessions.has(s), 'the destroy to finish')
    })
  })

  describe('deleting a task never loses uncommitted work', () => {
    const makeRepo = () => {
      const repo = mkdtempSync(join(tmpdir(), 'chroxy-9242-repo-'))
      repos.push(repo)
      execFileSync(GIT, ['init', '--initial-branch=main', repo], { stdio: 'pipe' })
      disableRepoAutoGc(repo)
      execFileSync(GIT, ['-C', repo, 'config', 'user.email', 'test@chroxy.test'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
      return repo
    }
    // Created owned, then ADOPTED by the engine (a deletion can only close a session the
    // engine maps; without this the tests below would pass vacuously).
    const worktreeSession = (sm, repo, eng, taskId) => {
      sm._worktreeBase = join(repo, 'worktrees')
      const id = sm.createSession({ cwd: repo, provider: 'test-leave-used-9242', worktree: true, metadata: { scheduledTaskId: taskId } })
      eng.refresh()
      assert.equal(eng.scheduledSessionIds.get(taskId), id, 'control: adopted')
      return id
    }

    // #9286: the person is told why the session was kept, in the session itself.
    const keptNotices = (sm, id) => sm.getHistory(id).filter((m) => m.messageType === 'system' && /was deleted, but this session was kept open/.test(m.content))
    const ignoreEnv = (repo) => {
      writeFileSync(join(repo, '.gitignore'), '.env\n')
      execFileSync(GIT, ['-C', repo, 'add', '--', '.gitignore'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'ignore'], { stdio: 'pipe' })
    }

    it('#9286: an ignored .env keeps the session and the notice names the kind, the path and what to do', () => {
      const repo = makeRepo()
      ignoreEnv(repo)
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = store.add({ name: 'nightly report', prompt: 'p', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-leave-used-9242' } })
      eng.refresh()
      const s = worktreeSession(sm, repo, eng, task.id)
      sm.renameSession(s, 'my renamed session')
      writeFileSync(join(sm.getSession(s).worktreePath, '.env'), 'K=1')
      const live = []
      sm.on('session_event', (e) => { if (e.sessionId === s && e.event === 'message') live.push(e.data) })
      store.remove(task.id)
      eng.refresh()
      assert.ok(sm.getSession(s), 'kept')
      const notices = keptNotices(sm, s)
      assert.equal(notices.length, 1)
      const text = notices[0].content
      assert.ok(/ignored files/.test(text), 'names the kind')
      assert.ok(text.includes('.env'), 'names the path')
      assert.ok(/kept open instead of being closed/.test(text) && /close the session yourself/.test(text), 'says kept, and what to do')
      assert.ok(text.includes('Scheduled task "nightly report"'), 'names the TASK')
      assert.ok(!text.includes('my renamed session'), 'not the renamed session')
      assert.equal(live.length, 1, 'also broadcast live')
      assert.equal(live[0].type, 'system')
    })

    it('#9286: untracked files are named', () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      writeFileSync(join(sm.getSession(s).worktreePath, 'scratch-notes.txt'), 'x')
      store.remove(task.id)
      eng.refresh()
      const [n] = keptNotices(sm, s)
      assert.ok(n && /untracked files: scratch-notes\.txt/.test(n.content), n?.content)
      assert.ok(!/ignored files/.test(n.content), 'no wrong kind')
    })

    it('#9286: unreachable commits are named', () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      writeFileSync(join(wt, 'work.txt'), 'x')
      execFileSync(GIT, ['-C', wt, 'add', '--', 'work.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', wt, 'commit', '-m', 'work'], { stdio: 'pipe' })
      store.remove(task.id)
      eng.refresh()
      const [n] = keptNotices(sm, s)
      assert.ok(n && /commits no branch, tag or remote reaches/.test(n.content), n?.content)
      assert.ok(!/untracked|ignored/.test(n.content), 'no wrong kind')
    })

    it('#9286: a session the task no longer owns gets no notice when the task is deleted', () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      writeFileSync(join(sm.getSession(s).worktreePath, 'x.txt'), 'x')
      sm.releaseScheduledOwnership(s, task.id)
      store.remove(task.id)
      eng.refresh()
      assert.ok(sm.getSession(s), 'left open')
      assert.equal(keptNotices(sm, s).length, 0)
    })

    it('#9286: noteScheduledSessionKept on an unknown or destroying session returns false and does not throw', () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const report = { has: true, kinds: ['untracked'], samples: {} }
      assert.equal(sm.noteScheduledSessionKept('0'.repeat(32), task.id, report, 'n'), false)
      sm._sessions.get(s)._destroying = true
      assert.equal(sm.noteScheduledSessionKept(s, task.id, report, 'n'), false)
      sm._sessions.get(s)._destroying = false
      assert.equal(sm.noteScheduledSessionKept(s, task.id, report), true)
      assert.ok(/^A scheduled task was deleted/.test(keptNotices(sm, s)[0].content), 'absent name falls back')
    })

    it('#9286: a CLEAN worktree is destroyed and no notice is recorded', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      let noticed = 0
      sm.on('session_event', (e) => { if (e.sessionId === s && e.event === 'message') noticed++ })
      const wt = sm.getSession(s).worktreePath
      store.remove(task.id)
      eng.refresh()
      await waitFor(() => !existsSync(wt), 'its worktree to be removed')
      assert.equal(noticed, 0)
      assert.equal(keptNotices(sm, s).length, 0)
    })

    it('#9286: the notice replays after a restart, through the state file', () => {
      const repo = makeRepo()
      ignoreEnv(repo)
      const first = newMgr()
      const eng = newEngine(first)
      const task = addTask()
      const s = worktreeSession(first, repo, eng, task.id)
      writeFileSync(join(first.getSession(s).worktreePath, '.env'), 'K=1')
      store.remove(task.id)
      eng.refresh()
      assert.equal(keptNotices(first, s).length, 1, 'premise: recorded')
      const second = newMgr()
      assert.ok(second.restoreState(), 'restored')
      const replayed = keptNotices(second, s)
      assert.equal(replayed.length, 1, 'the notice is in the restored history')
      assert.ok(replayed[0].content.includes('.env'))
    })

    it('a task whose worktree has an uncommitted file is deleted: the session, the worktree and the file survive', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      writeFileSync(join(wt, 'precious.txt'), 'uncommitted work')

      store.remove(task.id)
      eng.refresh()
      assert.ok(sawLog(/keeping its session .* unsaved work/), 'the keep-because-unsaved branch ran')
      assert.ok(sm.getSession(s), 'the session was not destroyed')
      assert.equal(readFileSync(join(wt, 'precious.txt'), 'utf8'), 'uncommitted work')
      assert.deepEqual(codes(sm, s), [], 'ownership was released: an ordinary session now')
      await waitFor(() => linkOnDisk(s) === undefined, 'the release on disk')
    })

    it('an ignored (untracked-by-design) file also counts: it would be deleted with the worktree', async () => {
      const repo = makeRepo()
      writeFileSync(join(repo, '.gitignore'), 'secret.env\n')
      execFileSync(GIT, ['-C', repo, 'add', '--', '.gitignore'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'ignore'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      writeFileSync(join(sm.getSession(s).worktreePath, 'secret.env'), 'K=1')
      store.remove(task.id)
      eng.refresh()
      assert.ok(sawLog(/keeping its session .* unsaved work/), 'the keep branch ran')
      assert.ok(sm.getSession(s))
    })

    it('a commit made in the detached worktree is not lost either', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      writeFileSync(join(wt, 'work.txt'), 'x')
      execFileSync(GIT, ['-C', wt, 'add', '--', 'work.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', wt, 'commit', '-m', 'work'], { stdio: 'pipe' })
      store.remove(task.id)
      eng.refresh()
      assert.ok(sawLog(/keeping its session .* unsaved work/), 'the keep branch ran')
      assert.ok(sm.getSession(s), 'unreachable commit: session and worktree kept')
      assert.ok(existsSync(join(wt, 'work.txt')))
    })

    it('git config that hides untracked/ignored entries cannot make a dirty worktree read clean', async () => {
      for (const [file, content, ignoreFirst] of [['draft.txt', 'untracked draft', false], ['.env', 'K=1', true]]) {
        const repo = makeRepo()
        if (ignoreFirst) {
          writeFileSync(join(repo, '.gitignore'), '.env\n')
          execFileSync(GIT, ['-C', repo, 'add', '--', '.gitignore'], { stdio: 'pipe' })
          execFileSync(GIT, ['-C', repo, 'commit', '-m', 'ignore'], { stdio: 'pipe' })
        }
        execFileSync(GIT, ['-C', repo, 'config', 'status.showUntrackedFiles', 'no'], { stdio: 'pipe' })
        const sm = newMgr()
        const eng = newEngine(sm)
        const task = addTask()
        const s = worktreeSession(sm, repo, eng, task.id)
        const wt = sm.getSession(s).worktreePath
        writeFileSync(join(wt, file), content)
        assert.equal(worktreeHasUnsavedWork(wt), true, `${file} is unsaved work despite the config`)
        store.remove(task.id)
        eng.refresh()
        assert.ok(sawLog(/keeping its session .* unsaved work/), `${file}: the keep branch ran`)
        assert.ok(sm.getSession(s), `${file}: session kept`)
        assert.equal(readFileSync(join(wt, file), 'utf8'), content)
        store.add({ prompt: 'x', cadence: { kind: 'interval', everyMs: 3600000, anchor: 1000 }, target: { provider: 'test-leave-used-9242' } })
      }
    })

    it('a CLEAN owned worktree session is still destroyed and its worktree removed (control)', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      assert.ok(existsSync(wt))
      store.remove(task.id)
      eng.refresh()
      await waitFor(() => !sm.getSession(s), 'the clean session to be closed')
      await waitFor(() => !existsSync(wt), 'its worktree to be removed')
    })

    it('a worktree whose status cannot be read (not a repo) is kept (fail safe)', () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const notARepo = mkdtempSync(join(tmpdir(), 'chroxy-9242-nr-'))
      repos.push(notARepo)
      sm.getSession(s).worktreePath = notARepo
      store.remove(task.id)
      eng.refresh()
      assert.ok(sawLog(/keeping its session .* unsaved work/), 'the keep branch ran')
      assert.ok(sm.getSession(s), 'unknown state is treated as unsafe')
    })

    it('a worktree whose directory is already gone holds nothing to lose: the session is destroyed', async () => {
      const repo = makeRepo()
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      sm.getSession(s).worktreePath = join(repo, 'does-not-exist')
      store.remove(task.id)
      eng.refresh()
      assert.equal(sawLog(/keeping its session/), false)
      await waitFor(() => !sm.getSession(s), 'the session to be closed')
    })

    it('a tracked file marked assume-unchanged and edited is unsaved work (status cannot see it)', () => {
      const repo = makeRepo()
      writeFileSync(join(repo, 'tracked.txt'), 'v1')
      execFileSync(GIT, ['-C', repo, 'add', '--', 'tracked.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'tracked'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      assert.equal(worktreeHasUnsavedWork(wt), false, 'control: clean')
      execFileSync(GIT, ['-C', wt, 'update-index', '--assume-unchanged', 'tracked.txt'], { stdio: 'pipe' })
      writeFileSync(join(wt, 'tracked.txt'), 'edited')
      assert.equal(execFileSync(GIT, ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'premise: plain status does not show the edit')
      assert.equal(worktreeHasUnsavedWork(wt), true)
    })

    it('a tracked file marked skip-worktree is unsaved work', () => {
      const repo = makeRepo()
      writeFileSync(join(repo, 'tracked.txt'), 'v1')
      execFileSync(GIT, ['-C', repo, 'add', '--', 'tracked.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'tracked'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      execFileSync(GIT, ['-C', wt, 'update-index', '--skip-worktree', 'tracked.txt'], { stdio: 'pipe' })
      writeFileSync(join(wt, 'tracked.txt'), 'edited')
      assert.equal(worktreeHasUnsavedWork(wt), true)
    })

    it('a populated submodule is unsaved work even when it holds only an ignored file', () => {
      const repo = makeRepo()
      const sub = makeRepo()
      writeFileSync(join(sub, 's.txt'), 's')
      execFileSync(GIT, ['-C', sub, 'add', '--', 's.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', sub, 'commit', '-m', 's'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'mod'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'sm'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      assert.equal(worktreeHasUnsavedWork(wt), false, 'control: an unpopulated (uninitialised) submodule is not work')
      execFileSync(GIT, ['-C', wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], { stdio: 'pipe' })
      const abs = execFileSync(GIT, ['-C', join(wt, 'mod'), 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
      mkdirSync(join(abs, 'info'), { recursive: true })
      writeFileSync(join(abs, 'info', 'exclude'), '.env\n')
      writeFileSync(join(wt, 'mod', '.env'), 'K=1')
      assert.equal(execFileSync(GIT, ['-C', wt, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }).trim(), '', 'premise: the parent status reads clean')
      assert.equal(worktreeHasUnsavedWork(wt), true)
    })

    it('a hand-made file inside an UNINITIALISED submodule directory is unsaved work; an empty one is not', () => {
      const repo = makeRepo()
      const sub = makeRepo()
      writeFileSync(join(sub, 's.txt'), 's')
      execFileSync(GIT, ['-C', sub, 'add', '--', 's.txt'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', sub, 'commit', '-m', 's'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'mod'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'sm'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      assert.equal(existsSync(join(wt, 'mod', '.git')), false, 'premise: not initialised')
      assert.equal(worktreeHasUnsavedWork(wt), false, 'control: an empty uninitialised submodule dir is not work')
      writeFileSync(join(wt, 'mod', 'work.txt'), 'hand-made')
      assert.equal(execFileSync(GIT, ['-C', wt, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }).trim(), '', 'premise: status reads clean')
      assert.equal(worktreeHasUnsavedWork(wt), true)
    })

    it('an ignored directory is listed once, not file by file (--ignored=matching)', () => {
      const repo = makeRepo()
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      execFileSync(GIT, ['-C', repo, 'add', '--', '.gitignore'], { stdio: 'pipe' })
      execFileSync(GIT, ['-C', repo, 'commit', '-m', 'ignore'], { stdio: 'pipe' })
      const sm = newMgr()
      const eng = newEngine(sm)
      const task = addTask()
      const s = worktreeSession(sm, repo, eng, task.id)
      const wt = sm.getSession(s).worktreePath
      mkdirSync(join(wt, 'node_modules', 'x'), { recursive: true })
      for (let i = 0; i < 400; i++) writeFileSync(join(wt, 'node_modules', 'x', `f${i}`), String(i))
      mkdirSync(join(wt, 'src', 'deep'), { recursive: true })
      writeFileSync(join(wt, 'src', 'deep', 'new.txt'), 'u')
      let statusOut = ''
      const spy = (cwd, args) => {
        const out = execFileSync(GIT, ['-C', cwd, ...args], { encoding: 'utf8' })
        if (args.includes('status')) statusOut = out
        return out
      }
      assert.equal(worktreeHasUnsavedWork(wt, { git: spy }), true)
      assert.ok(statusOut.length < 400, `status output stayed small (${statusOut.length} bytes)`)
      assert.ok(statusOut.includes('src/deep/new.txt'), 'untracked files are still enumerated in full')
    })

  })

  describe('worktreeHasUnsavedWork (injected git)', () => {
    const git = (status, revList, ls = '', lsS = '') => (cwd, args) => {
      const r = args.includes('status') ? status : args.includes('rev-list') ? revList : args.includes('-v') ? ls : lsS
      if (r instanceof Error) throw r
      return r
    }
    const enoent = () => Object.assign(new Error('gone'), { code: 'ENOENT' })
    const has = (g, extra = {}) => worktreeHasUnsavedWork('/x', { git: g, lstat: () => ({}), readdir: () => [], ...extra })
    it('clean tree and HEAD reachable from a ref: no unsaved work', () => {
      assert.equal(has(git('', '')), false)
    })
    it('a dirty tree is unsaved work', () => {
      assert.equal(has(git('?? a\n', '')), true)
    })
    it('an unreadable status is unsaved work even if the commit check would pass', () => {
      assert.equal(has(git(new Error('boom'), '')), true)
    })
    it('a commit no ref reaches is unsaved work', () => {
      assert.equal(has(git('', 'abc123\n')), true)
    })
    it('an unreadable commit check is unsaved work', () => {
      assert.equal(has(git('', new Error('boom'))), true)
    })
    it('an assume-unchanged (lowercase) or skip-worktree (S) tag is unsaved work; a plain H tag is not', () => {
      assert.equal(has(git('', '', 'H a\x00')), false)
      assert.equal(has(git('', '', 'H a\x00h b\x00')), true)
      assert.equal(has(git('', '', 'S b\x00')), true)
    })
    it('a gitlink whose directory has any entry is unsaved work; an empty or absent one is not', () => {
      const lsS = '160000 abc 0\tmod\x00100644 def 0\ta.txt\x00'
      assert.equal(has(git('', '', '', lsS), { readdir: () => ['work.txt'] }), true)
      assert.equal(has(git('', '', '', lsS), { readdir: () => [] }), false)
      assert.equal(has(git('', '', '', lsS), { readdir: () => { throw enoent() } }), false)
      assert.equal(has(git('', '', '', lsS), { readdir: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } }), true, 'cannot tell: keep')
    })
    it('an unreadable ls-files is unsaved work', () => {
      assert.equal(has(git('', '', new Error('boom'))), true)
    })
    it('a path that does not exist (ENOENT) is no unsaved work, without asking git', () => {
      let called = false
      assert.equal(worktreeHasUnsavedWork('/gone', { git: () => { called = true; return '' }, lstat: () => { throw enoent() } }), false)
      assert.equal(called, false)
    })
    it('a stat error other than ENOENT (EACCES, EIO) is "cannot tell": kept', () => {
      for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
        assert.equal(worktreeHasUnsavedWork('/x', { git: git('', ''), lstat: () => { throw Object.assign(new Error('x'), { code }) } }), true, code)
      }
    })
    it('#9286 report: kinds and sample paths, and `has` always agrees with the boolean', () => {
      const rep = (g, extra = {}) => worktreeUnsavedWorkReport('/x', { git: g, lstat: () => ({}), readdir: () => [], ...extra })
      assert.deepEqual(rep(git('', '')), { has: false, kinds: [], samples: {} })
      const r = rep(git(' M t.txt\n?? new.txt\n!! .env\n', 'abc123\n', 'H a\0h b\0S c\0', '160000 abc 0\tsub\0'), { readdir: () => ['f'] })
      assert.deepEqual(r.kinds, ['modified', 'untracked', 'ignored', 'unreachable-commits', 'hidden-index', 'submodule'])
      assert.deepEqual(r.samples.ignored, ['.env'])
      assert.deepEqual(r.samples.untracked, ['new.txt'])
      assert.deepEqual(r.samples['hidden-index'], ['b', 'c'])
      assert.deepEqual(r.samples.submodule, ['sub'])
      const many = Array.from({ length: 20 }, (_, i) => `?? f${i}\n`).join('')
      assert.equal(rep(git(many, '')).samples.untracked.length, 5, 'sample is capped')
      assert.deepEqual(rep(git(new Error('x'), '')).kinds, ['unreadable'])
      assert.deepEqual(rep(git('', new Error('x'))).kinds, ['unreadable'])
      for (const g of [git('', ''), git('?? a\n', ''), git('', 'x'), git('', '', 'h a\0'), git(new Error('x'), '')]) {
        assert.equal(rep(g).has, has(g))
      }
      assert.equal(has(git('?? a\n', new Error('would not be asked'))), true, 'the boolean still stops at the first finding')
    })
    it('#9286 sanitizeNoticeText: strips bidi/zero-width characters and never splits a surrogate pair', () => {
      assert.equal(sanitizeNoticeText('a\u202eb\u2066c\u2069d\u200be\ufefff\u200fg', 120), 'abcdefg')
      const out = sanitizeNoticeText('\u{1F600}'.repeat(200), 120)
      assert.equal(Array.from(out).length, 117 + 3, 'capped by code points')
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), 'no lone surrogate')
      assert.ok(!describeUnsavedWork({ kinds: ['ignored'], samples: { ignored: ['evil\u202etxt.exe'] } }).includes('\u202e'))
    })
    it('#9286 describeUnsavedWork: names kinds and paths, strips control characters', () => {
      const text = describeUnsavedWork({ kinds: ['ignored', 'unreachable-commits'], samples: { ignored: ['.env', 'a\nb'] } })
      assert.ok(text.includes('ignored files') && text.includes('.env, ab') && text.includes('commits no branch'), text)
    })
  })
})
