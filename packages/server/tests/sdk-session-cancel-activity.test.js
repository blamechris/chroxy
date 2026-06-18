import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SdkSession } from '../src/sdk-session.js'
import { BaseSession } from '../src/base-session.js'

/**
 * #5269 (Control Room Phase 2a): SdkSession control actions.
 *
 *   - task_id ↔ tool_use_id capture (_captureTaskId), order-independent
 *   - prompt-side finalize (_finalizeAgentByToolUseId): drop mapping + emit
 *     agent_completed so a cancelled/finished subagent node terminates promptly
 *   - cancelActivity(activityId): agent node → query.stopTask(task_id), with a
 *     structured result for every non-happy path (not the SDK throwing)
 *   - BaseSession default cancelActivity is not-supported (CLI/TUI/byok inherit)
 *
 * State file points at a tmp dir (#4633 sandbox) so no test touches real state.
 */

let _globalTmpDir = null
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'sdk-cancel-activity-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

function createSession(opts = {}) {
  const stateFilePath = opts.stateFilePath || tmpStateFile()
  const session = new SdkSession({ cwd: '/tmp', stateFilePath, ...opts })
  session._testStateFilePath = stateFilePath
  return session
}

// Seed an `agent` activity node for `toolUseId` directly via the registry (the
// same node agent_spawned produces).
function seedAgentNode(session, toolUseId, label = 'sub') {
  session._activity.onAgentSpawned({ toolUseId, description: label, startedAt: Date.now() })
}

// A stand-in query. destroy() calls `_query.interrupt()`, so every mock must
// carry it; spread `over` for stopTask variants.
function mockQuery(over = {}) {
  return { interrupt: async () => {}, ...over }
}

describe('SdkSession #5269 — task_id capture', () => {
  it('captures task_id keyed by tool_use_id', () => {
    const session = createSession()
    session._captureTaskId('tu-1', 'task-1')
    assert.equal(session._taskIdByToolUseId.get('tu-1'), 'task-1')
    session.destroy()
  })

  it('ignores a missing tool_use_id or task_id (no phantom entries)', () => {
    const session = createSession()
    session._captureTaskId(undefined, 'task-1')
    session._captureTaskId('tu-1', undefined)
    session._captureTaskId('', 'task-1')
    session._captureTaskId('tu-1', '')
    assert.equal(session._taskIdByToolUseId.size, 0)
    session.destroy()
  })

  it('is order-independent: task_started before agent_spawned still cancels', async () => {
    const session = createSession()
    // task_started lands first (mapping captured before the node exists)
    session._captureTaskId('tu-1', 'task-1')
    // then the agent node appears
    seedAgentNode(session, 'tu-1')
    const stopTask = mock.fn(async () => {})
    session._query = mockQuery({ stopTask })
    const res = await session.cancelActivity('tu-1')
    assert.equal(res.ok, true)
    assert.equal(stopTask.mock.callCount(), 1)
    assert.equal(stopTask.mock.calls[0].arguments[0], 'task-1')
    session.destroy()
  })
})

describe('SdkSession #5269 — _finalizeAgentByToolUseId', () => {
  it('drops the mapping and emits agent_completed when the agent is active', () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    session._captureTaskId('tu-1', 'task-1')
    const completed = []
    session.on('agent_completed', (d) => completed.push(d))
    session._finalizeAgentByToolUseId('tu-1')
    assert.deepEqual(completed, [{ toolUseId: 'tu-1' }])
    assert.equal(session._activeAgents.has('tu-1'), false)
    assert.equal(session._taskIdByToolUseId.has('tu-1'), false)
    session.destroy()
  })

  it('is idempotent — second call does not re-emit or throw', () => {
    const session = createSession()
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    let emits = 0
    session.on('agent_completed', () => { emits++ })
    session._finalizeAgentByToolUseId('tu-1')
    session._finalizeAgentByToolUseId('tu-1')
    assert.equal(emits, 1)
    session.destroy()
  })

  it('no-ops for an unknown / empty tool_use_id', () => {
    const session = createSession()
    let emits = 0
    session.on('agent_completed', () => { emits++ })
    session._finalizeAgentByToolUseId('nope')
    session._finalizeAgentByToolUseId('')
    session._finalizeAgentByToolUseId(undefined)
    assert.equal(emits, 0)
    session.destroy()
  })
})

describe('SdkSession #5269 — cancelActivity', () => {
  it('cancels an agent node via query.stopTask and finalizes it', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    session._captureTaskId('tu-1', 'task-1')
    const stopTask = mock.fn(async () => {})
    session._query = mockQuery({ stopTask })
    const completed = []
    session.on('agent_completed', (d) => completed.push(d))

    const res = await session.cancelActivity('tu-1')

    assert.deepEqual(res, { ok: true })
    assert.equal(stopTask.mock.callCount(), 1)
    assert.equal(stopTask.mock.calls[0].arguments[0], 'task-1')
    // Optimistic finalize: node cleared, mapping dropped, agent_completed fired.
    assert.deepEqual(completed, [{ toolUseId: 'tu-1' }])
    assert.equal(session._taskIdByToolUseId.has('tu-1'), false)
    session.destroy()
  })

  it('returns invalid-id for a non-string / empty id', async () => {
    const session = createSession()
    assert.deepEqual(await session.cancelActivity(''), { ok: false, reason: 'invalid-id' })
    assert.deepEqual(await session.cancelActivity(undefined), { ok: false, reason: 'invalid-id' })
    session.destroy()
  })

  it('returns not-found for an unknown activity id', async () => {
    const session = createSession()
    assert.deepEqual(await session.cancelActivity('nope'), { ok: false, reason: 'not-found' })
    session.destroy()
  })

  it('refuses a shell node with shell-not-cancellable', async () => {
    const session = createSession()
    session._activity.onBackgroundWorkChanged({ pending: [{ shellId: 'sh-1', command: 'sleep 99', startedAt: Date.now() }] })
    const res = await session.cancelActivity('shell:sh-1')
    assert.deepEqual(res, { ok: false, reason: 'shell-not-cancellable' })
    session.destroy()
  })

  it('refuses a plain tool node with not-cancellable', async () => {
    const session = createSession()
    session._activity.onToolStart({ toolUseId: 'tu-tool', name: 'Read', startedAt: Date.now() })
    const res = await session.cancelActivity('tu-tool')
    assert.deepEqual(res, { ok: false, reason: 'not-cancellable' })
    session.destroy()
  })

  it('returns not-found for an agent that already finished (terminal nodes are dropped)', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._captureTaskId('tu-1', 'task-1')
    session._activity.onAgentCompleted({ toolUseId: 'tu-1' }) // _end drops the entry
    session._query = mockQuery({ stopTask: mock.fn(async () => {}) })
    const res = await session.cancelActivity('tu-1')
    assert.deepEqual(res, { ok: false, reason: 'not-found' })
    session.destroy()
  })

  it('returns no-task-id when task_started was never seen', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._query = mockQuery({ stopTask: mock.fn(async () => {}) })
    const res = await session.cancelActivity('tu-1')
    assert.deepEqual(res, { ok: false, reason: 'no-task-id' })
    session.destroy()
  })

  it('returns not-supported when the query lacks stopTask (older SDK)', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._captureTaskId('tu-1', 'task-1')
    session._query = mockQuery() // no stopTask
    const res = await session.cancelActivity('tu-1')
    assert.deepEqual(res, { ok: false, reason: 'not-supported' })
    session.destroy()
  })

  it('surfaces stop-failed (not a throw) when stopTask rejects', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    session._captureTaskId('tu-1', 'task-1')
    session._query = mockQuery({ stopTask: async () => { throw new Error('boom') } })
    const res = await session.cancelActivity('tu-1')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'stop-failed')
    assert.equal(res.error, 'boom')
    // Failed stop must NOT finalize the node (it may still be running).
    assert.equal(session._taskIdByToolUseId.has('tu-1'), true)
    session.destroy()
  })
})

describe('BaseSession #5269 — default cancelActivity is not-supported', () => {
  it('returns not-supported on the base prototype', async () => {
    const res = await BaseSession.prototype.cancelActivity.call({}, 'anything')
    assert.deepEqual(res, { ok: false, reason: 'not-supported' })
  })
})

describe('SdkSession #5269 — lifecycle clears the task map', () => {
  it('destroy() clears stranded mappings', () => {
    const session = createSession()
    session._captureTaskId('tu-1', 'task-1')
    assert.equal(session._taskIdByToolUseId.size, 1)
    session.destroy()
    assert.equal(session._taskIdByToolUseId.size, 0)
  })

  it('source wires task_started/task_notification through the capture/finalize helpers', () => {
    // The dispatch lives inside the _callQuery async-iterator loop, which can't
    // be driven in isolation; pin the wiring as a source-text contract (mirrors
    // the #4881 finally-clear source assertion pattern).
    const src = readFileSync(new URL('../src/sdk-session.js', import.meta.url), 'utf8')
    assert.match(src, /subtype === 'task_started'[\s\S]*?_captureTaskId\(msg\.tool_use_id, msg\.task_id\)/)
    assert.match(src, /subtype === 'task_notification'[\s\S]*?_finalizeAgentByToolUseId\(msg\.tool_use_id\)/)
  })
})
