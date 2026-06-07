import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeByokSession } from '../src/byok-session.js'

/**
 * #5274 (Control Room Phase 2a parity): ClaudeByokSession control actions.
 *
 * Mirrors tests/sdk-session-cancel-activity.test.js, but the cancel MECHANISM
 * differs: SdkSession maps an agent node to query.stopTask(task_id); byok owns
 * each subagent as a child session in _subagentSessions and aborts the child's
 * stream via its interrupt(). The structured-result vocabulary is identical.
 *
 * State file points at a tmp dir (#4633 sandbox) so no test touches real state.
 */

let _globalTmpDir = null
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'byok-cancel-activity-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

function createSession(opts = {}) {
  return new ClaudeByokSession({ cwd: '/tmp', stateFilePath: tmpStateFile(), ...opts })
}

// Seed an `agent` activity node for `toolUseId` (the node agent_spawned produces).
function seedAgentNode(session, toolUseId, label = 'sub') {
  session._activity.onAgentSpawned({ toolUseId, description: label, startedAt: Date.now() })
}

// A stand-in child subagent session: interrupt() is the only surface cancel uses.
function fakeChild(over = {}) {
  return { interrupt: mock.fn(() => {}), ...over }
}

describe('ClaudeByokSession #5274 — cancelActivity', () => {
  it('cancels an agent node via the child interrupt() and finalizes it', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    const child = fakeChild()
    session._subagentSessions.set('tu-1', child)
    const completed = []
    session.on('agent_completed', (d) => completed.push(d))

    const res = await session.cancelActivity('tu-1')

    assert.deepEqual(res, { ok: true })
    assert.equal(child.interrupt.mock.callCount(), 1)
    // Optimistic finalize: node cleared + agent_completed fired.
    assert.deepEqual(completed, [{ toolUseId: 'tu-1' }])
    assert.equal(session._activeAgents.has('tu-1'), false)
    await session.destroy()
  })

  it('returns invalid-id for a non-string / empty id', async () => {
    const session = createSession()
    assert.deepEqual(await session.cancelActivity(''), { ok: false, reason: 'invalid-id' })
    assert.deepEqual(await session.cancelActivity(undefined), { ok: false, reason: 'invalid-id' })
    await session.destroy()
  })

  it('returns not-found for an unknown activity id', async () => {
    const session = createSession()
    assert.deepEqual(await session.cancelActivity('nope'), { ok: false, reason: 'not-found' })
    await session.destroy()
  })

  it('refuses a shell node with shell-not-cancellable', async () => {
    const session = createSession()
    session._activity.onBackgroundWorkChanged({ pending: [{ shellId: 'sh-1', command: 'sleep 99', startedAt: Date.now() }] })
    const res = await session.cancelActivity('shell:sh-1')
    assert.deepEqual(res, { ok: false, reason: 'shell-not-cancellable' })
    await session.destroy()
  })

  it('refuses a plain tool node with not-cancellable', async () => {
    const session = createSession()
    session._activity.onToolStart({ toolUseId: 'tu-tool', name: 'Read', startedAt: Date.now() })
    const res = await session.cancelActivity('tu-tool')
    assert.deepEqual(res, { ok: false, reason: 'not-cancellable' })
    await session.destroy()
  })

  it('returns not-found for an agent that already finished (terminal nodes are dropped)', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._subagentSessions.set('tu-1', fakeChild())
    session._activity.onAgentCompleted({ toolUseId: 'tu-1' }) // _end drops the entry
    const res = await session.cancelActivity('tu-1')
    assert.deepEqual(res, { ok: false, reason: 'not-found' })
    await session.destroy()
  })

  it('returns not-found when there is no live child handle for the agent node', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1') // node exists, but _subagentSessions has no entry
    const res = await session.cancelActivity('tu-1')
    assert.deepEqual(res, { ok: false, reason: 'not-found' })
    await session.destroy()
  })

  it('surfaces stop-failed (not a throw) when the child interrupt() throws', async () => {
    const session = createSession()
    seedAgentNode(session, 'tu-1')
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    session._subagentSessions.set('tu-1', fakeChild({ interrupt: () => { throw new Error('boom') } }))
    const res = await session.cancelActivity('tu-1')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'stop-failed')
    assert.equal(res.error, 'boom')
    // Failed cancel must NOT finalize the node (it may still be running).
    assert.equal(session._activeAgents.has('tu-1'), true)
    await session.destroy()
  })
})

describe('ClaudeByokSession #5274 — _finalizeAgentByToolUseId', () => {
  it('drops the _activeAgents entry and emits agent_completed when active', async () => {
    const session = createSession()
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    const completed = []
    session.on('agent_completed', (d) => completed.push(d))
    session._finalizeAgentByToolUseId('tu-1')
    assert.deepEqual(completed, [{ toolUseId: 'tu-1' }])
    assert.equal(session._activeAgents.has('tu-1'), false)
    await session.destroy()
  })

  it('is idempotent — second call does not re-emit or throw', async () => {
    const session = createSession()
    session._activeAgents.set('tu-1', { toolUseId: 'tu-1' })
    let emits = 0
    session.on('agent_completed', () => { emits++ })
    session._finalizeAgentByToolUseId('tu-1')
    session._finalizeAgentByToolUseId('tu-1')
    assert.equal(emits, 1)
    await session.destroy()
  })

  it('no-ops for an unknown / empty tool_use_id', async () => {
    const session = createSession()
    let emits = 0
    session.on('agent_completed', () => { emits++ })
    session._finalizeAgentByToolUseId('nope')
    session._finalizeAgentByToolUseId('')
    session._finalizeAgentByToolUseId(undefined)
    assert.equal(emits, 0)
    await session.destroy()
  })
})
