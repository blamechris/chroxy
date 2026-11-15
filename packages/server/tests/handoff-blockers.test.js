import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { BaseSession, SOFT_HANDOFF_BLOCKER_CODES } from '../src/base-session.js'
import { PermissionManager } from '../src/permission-manager.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { SessionManager } from '../src/session-manager.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8281: `getHandoffBlockers()` -- the typed "is anything still able to act in
 * this session" answer a handoff will ask. One test per code, each paired with
 * the idle control (`[]`) so a test that passes because EVERYTHING is reported
 * cannot hide. Nothing here touches `isRunning` / `listSessions().isBusy`.
 */

// A session that models the provider contract (busy -> enqueue; idle -> send and
// go busy; turn end -> clear busy + flush head) with a real PermissionManager,
// the way sdk / byok / codex own one.
class FakeSession extends BaseSession {
  constructor(opts = {}) {
    super({ cwd: '/tmp', ...opts })
    this._permissions = new PermissionManager({ cwd: '/tmp' })
    this._processReady = true
    this.sent = []
  }

  sendMessage(prompt, attachments, sendOptions) {
    if (this._isBusy) {
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      return
    }
    this._isBusy = true
    this.sent.push(prompt)
  }

  completeTurn() {
    this._isBusy = false
    this.dequeueNextOutgoing()
  }

  getPendingQuestions() {
    return this._permissions.getPendingQuestions()
  }
}

const codes = (s) => s.getHandoffBlockers().map((b) => b.code)
const find = (s, code) => s.getHandoffBlockers().find((b) => b.code === code)
const tick = () => new Promise((resolve) => process.nextTick(resolve))

function withSession(fn) {
  const s = new FakeSession()
  try {
    return fn(s)
  } finally {
    s._permissions.clearAll()
    s._destroyPendingBackgroundShells()
  }
}

describe('BaseSession.getHandoffBlockers (#8281)', () => {
  it('an idle ready session has no blockers', () => {
    withSession((s) => assert.deepEqual(s.getHandoffBlockers(), []))
  })

  it('turn_active while a turn is in flight', () => {
    withSession((s) => {
      s._isBusy = true
      assert.deepEqual(codes(s), ['turn_active'])
    })
  })

  it('queued_prompts while a follow-up waits in the queue', () => {
    withSession((s) => {
      s.sendMessage('first')
      s.sendMessage('second')
      assert.equal(s.outgoingQueueLength, 1)
      assert.deepEqual(find(s, 'queued_prompts'), { code: 'queued_prompts', detail: { count: 1 } })
    })
  })

  it('pending_permission while an approval waits, with its request id', () => {
    withSession((s) => {
      s._permissions.handlePermission('Bash', { command: 'ls' }, undefined, 'approve')
      const ids = s.getPendingPermissionIds()
      assert.equal(ids.length, 1)
      assert.deepEqual(find(s, 'pending_permission'), { code: 'pending_permission', detail: { requestIds: ids } })
    })
  })

  it('pending_question while an AskUserQuestion waits', () => {
    withSession((s) => {
      s._permissions.handlePermission('AskUserQuestion', { questions: [{ question: 'q?', options: [] }] }, undefined, 'approve')
      assert.deepEqual(find(s, 'pending_question'), { code: 'pending_question', detail: { count: 1 } })
    })
  })

  it('active_agents while a subagent runs', () => {
    withSession((s) => {
      s._activeAgents.set('tool-1', { toolUseId: 'tool-1', description: 'd', startedAt: 1 })
      assert.deepEqual(codes(s), ['active_agents'])
    })
  })

  it('not_ready before the provider process is ready', () => {
    withSession((s) => {
      s._processReady = false
      assert.deepEqual(codes(s), ['not_ready'])
    })
  })

  it('destroying once teardown has begun', () => {
    withSession((s) => {
      s._destroying = true
      assert.deepEqual(codes(s), ['destroying'])
    })
  })

  it('background_shells is reported as SOFT', () => {
    withSession((s) => {
      s.trackBackgroundShell({ shellId: 'sh-1', command: 'sleep 1' })
      const b = find(s, 'background_shells')
      assert.deepEqual(b, { code: 'background_shells', detail: { count: 1, soft: true } })
      assert.equal(SOFT_HANDOFF_BLOCKER_CODES.has('background_shells'), true)
      assert.deepEqual(codes(s), ['background_shells'], 'a shell alone is the only reason')
    })
  })

  it('a session with no permission manager reports no pending ids', () => {
    const s = new FakeSession()
    s._permissions = undefined
    assert.deepEqual(s.getPendingPermissionIds(), [])
  })

  describe('the dequeue window', () => {
    it('reports queued_prompts on the tick the queue empties, before the queued send starts', async () => {
      const s = new FakeSession()
      s.sendMessage('first')
      s.sendMessage('second')
      s.completeTurn() // busy clears, 'second' leaves the queue, its send is deferred
      // Same tick: not busy, queue empty -- the exact gap `isRunning` cannot see.
      assert.equal(s._isBusy, false)
      assert.equal(s.outgoingQueueLength, 0)
      assert.equal(s.isRunning, false)
      assert.deepEqual(s.sent, ['first'], 'the queued send has not started')
      assert.deepEqual(find(s, 'queued_prompts'), { code: 'queued_prompts', detail: { count: 1 } })
      await tick()
      // The send began: the in-flight marker is gone, the turn itself now blocks.
      assert.deepEqual(s.sent, ['first', 'second'])
      assert.deepEqual(codes(s), ['turn_active'])
    })

    it('clears the marker when the flush-time admission is refused', async () => {
      const s = new FakeSession()
      s.sendMessage('first')
      s.sendMessage('second', undefined, { admitAtFlush: () => false })
      s.completeTurn()
      assert.deepEqual(codes(s), ['queued_prompts'])
      await tick()
      assert.deepEqual(s.sent, ['first'])
      assert.deepEqual(s.getHandoffBlockers(), [])
    })

    it('clears the marker when the session is destroyed before the tick', async () => {
      const s = new FakeSession()
      s.sendMessage('first')
      s.sendMessage('second')
      s.completeTurn()
      s._destroying = true
      await tick()
      assert.equal(s.hasDequeueInFlight, false)
      assert.deepEqual(codes(s), ['destroying'])
    })
  })
})

describe('CodexAppServerSession turn_active (#8281)', () => {
  it('counts an active turn that has no turn id yet', () => {
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-hb-'))
    const s = new CodexAppServerSession({ cwd: '/tmp', skillsDir: sk, repoSkillsDir: null })
    try {
      s._processReady = true
      assert.deepEqual(s.getHandoffBlockers(), [])
      s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
      assert.equal(s._isBusy, false, 'precondition: the busy flag alone does not see it')
      assert.deepEqual(codes(s), ['turn_active'])
    } finally {
      s._permissions.clearAll()
      rmSync(sk, { recursive: true, force: true })
    }
  })
})

describe('SessionManager.getHandoffBlockers (#8281)', () => {
  let registerProvider

  before(async () => {
    ({ registerProvider } = await import('../src/providers.js'))
    class ReadyProvider extends BaseSession {
      constructor(opts) {
        super({ cwd: opts.cwd })
        this._processReady = true
        this.resumeSessionId = null
      }
      static get capabilities() { return {} }
      start() {}
      destroy() { this._destroying = true }
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
    }
    declareUnknownCustomization(ReadyProvider)
    registerProvider('test-handoff-blockers', ReadyProvider)
    // A provider that is not a BaseSession at all must not break the answer.
    class BareProvider extends EventEmitter {
      constructor(opts) { super(); this.cwd = opts.cwd; this.isRunning = false }
      static get capabilities() { return {} }
      start() {}
      destroy() {}
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
    }
    declareUnknownCustomization(BareProvider)
    registerProvider('test-handoff-bare', BareProvider)
  })

  function makeMgr() {
    const dir = mkdtempSync(join(tmpdir(), 'sm-handoff-'))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 10, defaultCwd: '/tmp', stateFilePath: join(dir, 'state.json') })
    mgr._tmpDir = dir
    return mgr
  }
  function cleanup(mgr) { mgr.destroyAll(); rmSync(mgr._tmpDir, { recursive: true, force: true }) }
  const mcodes = (mgr, id, opts) => mgr.getHandoffBlockers(id, opts).map((b) => b.code)

  it('an idle session returns an empty array', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-handoff-blockers' })
      assert.deepEqual(mgr.getHandoffBlockers(id), [])
      assert.deepEqual(mgr.getHandoffBlockers(id, { evaluatorPending: false, hookPendingPermissionIds: [] }), [])
    } finally { cleanup(mgr) }
  })

  it('not_found for an unknown session', () => {
    const mgr = makeMgr()
    try {
      assert.deepEqual(mgr.getHandoffBlockers('nope'), [{ code: 'not_found' }])
    } finally { cleanup(mgr) }
  })

  it('evaluator_pending when the caller says the evaluator holds a draft', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-handoff-blockers' })
      assert.deepEqual(mcodes(mgr, id, { evaluatorPending: true }), ['evaluator_pending'])
    } finally { cleanup(mgr) }
  })

  it('automation_owned for a session bound to a scheduled task, idle between turns', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-handoff-blockers', metadata: { scheduledTaskId: 'task-1' } })
      assert.equal(mgr.getSession(id).session.isRunning, false, 'precondition: idle between turns')
      assert.deepEqual(mgr.getHandoffBlockers(id), [
        { code: 'automation_owned', detail: { scheduledTaskId: 'task-1' } },
      ])
    } finally { cleanup(mgr) }
  })

  it('automation_owned for a session owned by an orchestration run, idle between turns', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({
        cwd: '/tmp', provider: 'test-handoff-blockers',
        metadata: { orchestrationRunId: 'run_1', orchestrationRole: 'worker.audit' },
      })
      assert.equal(mgr.getSession(id).session.isRunning, false, 'precondition: idle between turns')
      assert.deepEqual(mgr.getHandoffBlockers(id), [
        { code: 'automation_owned', detail: { orchestrationRunId: 'run_1' } },
      ])
    } finally { cleanup(mgr) }
  })

  it('a hook-routed approval passed by the caller is reported, merged with the session\'s own', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-handoff-blockers' })
      assert.deepEqual(mgr.getHandoffBlockers(id, { hookPendingPermissionIds: ['hook-1'] }), [
        { code: 'pending_permission', detail: { requestIds: ['hook-1'] } },
      ])
      // Control: without the option the session cannot see it, which is why the
      // WS layer must pass it.
      assert.deepEqual(mgr.getHandoffBlockers(id), [])
      const session = mgr.getSession(id).session
      session._permissions = new PermissionManager({ cwd: '/tmp' })
      session._permissions.handlePermission('Bash', { command: 'ls' }, undefined, 'approve')
      const own = session.getPendingPermissionIds()
      const merged = mgr.getHandoffBlockers(id, { hookPendingPermissionIds: ['hook-1', own[0]] })
      assert.equal(merged.filter((b) => b.code === 'pending_permission').length, 1, 'one entry, not two')
      assert.deepEqual(merged[0].detail.requestIds.sort(), ['hook-1', own[0]].sort())
      session._permissions.clearAll()
    } finally { cleanup(mgr) }
  })

  it('includes the session\'s own blockers', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-handoff-blockers' })
      mgr.getSession(id).session._isBusy = true
      assert.deepEqual(mcodes(mgr, id), ['turn_active'])
    } finally { cleanup(mgr) }
  })

  it('a provider with no getHandoffBlockers contributes nothing', () => {
    const mgr = makeMgr()
    try {
      const id = mgr.createSession({ cwd: '/tmp', provider: 'test-handoff-bare' })
      assert.deepEqual(mgr.getHandoffBlockers(id), [])
    } finally { cleanup(mgr) }
  })
})
