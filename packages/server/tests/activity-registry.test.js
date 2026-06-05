/**
 * #5160 — per-session activity registry (Control Room phase 1).
 *
 * Pins the behaviour the WS layer / store-core reducer (#5162) and dashboard
 * (#5163) build on:
 *   - tool_start → running tool node; tool_result → terminal (done/failed)
 *   - agent_spawned is authoritative for a Task (upgrades the tool node)
 *   - background_work_changed reconciles shell nodes (add / end)
 *   - permission_request / user_question → blocked node; resolved → terminal
 *   - agent_event nests child tools under the parent agent (parentId)
 *   - reset() (turn-end) ends non-shell orphans, shells survive
 *   - clear() (destroy) ends everything and empties the registry
 *   - snapshot-on-subscribe (getSnapshotMessage) is the full current tree
 *   - emitted deltas validate against the @chroxy/protocol wire schemas
 *   - BaseSession wiring: events feed the registry and re-emit activity_*
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ACTIVITY_SCHEMA_VERSION,
  ServerActivitySnapshotSchema,
  ServerActivityDeltaSchema,
} from '@chroxy/protocol'
import { ActivityRegistry } from '../src/activity-registry.js'
import { BaseSession } from '../src/base-session.js'

// --- registry-in-isolation harness -----------------------------------------

function makeRegistry(sessionId = 's1') {
  const deltas = []
  const r = new ActivityRegistry({
    sessionId,
    emit: (event, payload) => {
      assert.equal(event, 'activity_delta', 'registry only emits activity_delta')
      deltas.push(payload)
    },
  })
  return { r, deltas }
}

function ops(deltas) {
  return deltas.map((d) => d.op)
}

function lastEntry(deltas) {
  return deltas[deltas.length - 1].entry
}

describe('ActivityRegistry — construction', () => {
  it('requires an emit function', () => {
    assert.throws(() => new ActivityRegistry({ sessionId: 's1' }), TypeError)
  })

  it('starts with an empty snapshot', () => {
    const { r } = makeRegistry()
    const snap = r.getSnapshotMessage()
    assert.equal(snap.type, 'activity_snapshot')
    assert.equal(snap.sessionId, 's1')
    assert.equal(snap.schemaVersion, ACTIVITY_SCHEMA_VERSION)
    assert.deepEqual(snap.entries, [])
  })

  it('setSessionId updates the snapshot session id', () => {
    const { r } = makeRegistry('')
    r.setSessionId('sdk-123')
    assert.equal(r.getSnapshotMessage().sessionId, 'sdk-123')
  })
})

describe('ActivityRegistry — tool lifecycle', () => {
  it('tool_start creates a running tool node, tool_result ends it done', () => {
    const { r, deltas } = makeRegistry()
    r.onToolStart({ toolUseId: 't1', tool: 'Bash' })
    assert.deepEqual(ops(deltas), ['started'])
    const started = lastEntry(deltas)
    assert.equal(started.kind, 'tool')
    assert.equal(started.label, 'Bash')
    assert.equal(started.status, 'running')
    assert.equal(started.endedAt, undefined)
    assert.deepEqual(started.outputRef, { kind: 'tool_use', id: 't1' })

    r.onToolResult({ toolUseId: 't1' })
    assert.deepEqual(ops(deltas), ['started', 'ended'])
    const ended = lastEntry(deltas)
    assert.equal(ended.status, 'done')
    assert.ok(ended.endedAt >= ended.startedAt)
    // Terminated nodes drop out of the snapshot.
    assert.equal(r.getEntries().length, 0)
  })

  it('tool_result with isError ends the node as failed', () => {
    const { r, deltas } = makeRegistry()
    r.onToolStart({ toolUseId: 't1', tool: 'Bash' })
    r.onToolResult({ toolUseId: 't1', isError: true })
    assert.equal(lastEntry(deltas).status, 'failed')
  })

  it('tool_result for an unknown id is a no-op', () => {
    const { r, deltas } = makeRegistry()
    r.onToolResult({ toolUseId: 'never-started' })
    assert.equal(deltas.length, 0)
  })

  it('ignores tool_start without a toolUseId', () => {
    const { r, deltas } = makeRegistry()
    r.onToolStart({ tool: 'Bash' })
    r.onToolStart({})
    assert.equal(deltas.length, 0)
  })
})

describe('ActivityRegistry — agent (Task) lifecycle', () => {
  it('agent_spawned creates a running agent node', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'investigate flaky test', startedAt: 1000 })
    const e = lastEntry(deltas)
    assert.equal(e.kind, 'agent')
    assert.equal(e.label, 'investigate flaky test')
    assert.equal(e.status, 'running')
    assert.equal(e.startedAt, 1000)
  })

  it('agent_spawned upgrades a pre-existing tool node in place (Task dedup)', () => {
    const { r, deltas } = makeRegistry()
    // Task fires tool_start AND agent_spawned on the SAME id.
    r.onToolStart({ toolUseId: 'a1', tool: 'Task' })
    r.onAgentSpawned({ toolUseId: 'a1', description: 'do the thing' })
    // One node, upgraded — not two.
    assert.equal(r.getEntries().length, 1)
    const e = r.getEntries()[0]
    assert.equal(e.kind, 'agent')
    assert.equal(e.label, 'do the thing')
    // started then updated (upgrade), no duplicate node.
    assert.deepEqual(ops(deltas), ['started', 'updated'])
  })

  it('tool_start after agent_spawned does not downgrade the agent', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'do the thing' })
    r.onToolStart({ toolUseId: 'a1', tool: 'Task' })
    assert.equal(r.getEntries()[0].kind, 'agent')
    assert.deepEqual(ops(deltas), ['started']) // tool_start was a no-op
  })

  it('agent_completed ends the agent done', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'x' })
    r.onAgentCompleted({ toolUseId: 'a1' })
    assert.equal(lastEntry(deltas).status, 'done')
    assert.equal(r.getEntries().length, 0)
  })

  it('agent tool_result ends the agent (failed on error)', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'x' })
    r.onToolResult({ toolUseId: 'a1', isError: true })
    assert.equal(lastEntry(deltas).status, 'failed')
  })
})

describe('ActivityRegistry — hierarchy via agent_event', () => {
  it('nests child tool_start under the parent agent with parentId', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'parent' })
    r.onAgentEvent({ parentToolUseId: 'a1', type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } })
    const child = lastEntry(deltas)
    assert.equal(child.kind, 'tool')
    assert.equal(child.parentId, 'a1')
    assert.equal(child.label, 'Read')
    assert.equal(child.id, 'a1::c1')
    assert.deepEqual(child.outputRef, { kind: 'tool_use', id: 'c1' })
  })

  it('child tool_result ends the namespaced child node', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'parent' })
    r.onAgentEvent({ parentToolUseId: 'a1', type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } })
    r.onAgentEvent({ parentToolUseId: 'a1', type: 'tool_result', payload: { toolUseId: 'c1' } })
    assert.equal(lastEntry(deltas).status, 'done')
    assert.equal(lastEntry(deltas).id, 'a1::c1')
  })

  it('drops a child whose parent agent is not tracked', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentEvent({ parentToolUseId: 'ghost', type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } })
    assert.equal(deltas.length, 0)
  })

  it('ending the parent agent drains its open children first', () => {
    const { r, deltas } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'parent' })
    r.onAgentEvent({ parentToolUseId: 'a1', type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } })
    r.onAgentCompleted({ toolUseId: 'a1' })
    // child ended, then parent ended
    const ended = deltas.filter((d) => d.op === 'ended').map((d) => d.entry.id)
    assert.deepEqual(ended, ['a1::c1', 'a1'])
    assert.equal(r.getEntries().length, 0)
  })

  it('two subagents running the same child tool do not collide', () => {
    const { r } = makeRegistry()
    r.onAgentSpawned({ toolUseId: 'a1', description: 'p1' })
    r.onAgentSpawned({ toolUseId: 'a2', description: 'p2' })
    r.onAgentEvent({ parentToolUseId: 'a1', type: 'tool_start', payload: { toolUseId: 'same', tool: 'Read' } })
    r.onAgentEvent({ parentToolUseId: 'a2', type: 'tool_start', payload: { toolUseId: 'same', tool: 'Read' } })
    const ids = r.getEntries().map((e) => e.id).sort()
    assert.deepEqual(ids, ['a1', 'a1::same', 'a2', 'a2::same'])
  })
})

describe('ActivityRegistry — background shells', () => {
  it('reconciles new shells from the pending snapshot', () => {
    const { r, deltas } = makeRegistry()
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'npm test', startedAt: 500 }] })
    const e = lastEntry(deltas)
    assert.equal(e.kind, 'shell')
    assert.equal(e.id, 'shell:brk1')
    assert.equal(e.label, 'npm test')
    assert.equal(e.status, 'running')
    assert.equal(e.startedAt, 500)
    assert.deepEqual(e.outputRef, { kind: 'shell', id: 'brk1' })
  })

  it('does not re-emit for a shell already tracked (preserves startedAt)', () => {
    const { r, deltas } = makeRegistry()
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'a', startedAt: 500 }] })
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'a', startedAt: 999 }] })
    assert.deepEqual(ops(deltas), ['started']) // second snapshot is a no-op for brk1
    assert.equal(r.getEntries()[0].startedAt, 500)
  })

  it('ends a shell that drops out of the pending snapshot', () => {
    const { r, deltas } = makeRegistry()
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'a' }] })
    r.onBackgroundWorkChanged({ pending: [] })
    assert.deepEqual(ops(deltas), ['started', 'ended'])
    assert.equal(lastEntry(deltas).kind, 'shell')
    assert.equal(lastEntry(deltas).status, 'done')
  })

  it('handles a missing/non-array pending field as empty', () => {
    const { r, deltas } = makeRegistry()
    r.onBackgroundWorkChanged({})
    r.onBackgroundWorkChanged({ pending: null })
    assert.equal(deltas.length, 0)
  })
})

describe('ActivityRegistry — blocked (permission / question)', () => {
  it('permission_request creates a blocked node, resolved-approve ends it done', () => {
    const { r, deltas } = makeRegistry()
    r.onPermissionRequest({ requestId: 'req1', tool: 'Bash', description: 'rm -rf build' })
    const e = lastEntry(deltas)
    assert.equal(e.status, 'blocked')
    assert.equal(e.label, 'rm -rf build')
    assert.equal(e.id, 'blocked:req1')

    r.onPermissionResolved({ requestId: 'req1', decision: 'allow' })
    assert.equal(lastEntry(deltas).status, 'done')
  })

  it('permission denied / timeout / aborted ends the node failed', () => {
    for (const data of [
      { requestId: 'r', decision: 'deny' },
      { requestId: 'r', reason: 'timeout' },
      { requestId: 'r', reason: 'aborted' },
    ]) {
      const { r, deltas } = makeRegistry()
      r.onPermissionRequest({ requestId: 'r', tool: 'Bash' })
      r.onPermissionResolved(data)
      assert.equal(lastEntry(deltas).status, 'failed')
    }
  })

  it('user_question creates a blocked node, resolved via toolUseId ends it', () => {
    const { r, deltas } = makeRegistry()
    r.onUserQuestion({ toolUseId: 'ask-1' })
    assert.equal(lastEntry(deltas).status, 'blocked')
    assert.equal(lastEntry(deltas).id, 'blocked:ask-1')
    r.onPermissionResolved({ toolUseId: 'ask-1', reason: 'aborted' })
    assert.equal(lastEntry(deltas).status, 'failed')
  })
})

describe('ActivityRegistry — reset (turn-end) and clear (destroy)', () => {
  it('reset ends non-shell orphans but leaves shells running', () => {
    const { r, deltas } = makeRegistry()
    r.onToolStart({ toolUseId: 't1', tool: 'Grep' })
    r.onAgentSpawned({ toolUseId: 'a1', description: 'x' })
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'a' }] })
    deltas.length = 0
    r.reset()
    // tool + agent ended, shell untouched
    const endedIds = deltas.filter((d) => d.op === 'ended').map((d) => d.entry.id).sort()
    assert.deepEqual(endedIds, ['a1', 't1'])
    const remaining = r.getEntries()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].kind, 'shell')
    assert.equal(remaining[0].status, 'running')
  })

  it('clear ends everything (including shells) and empties the registry', () => {
    const { r, deltas } = makeRegistry()
    r.onToolStart({ toolUseId: 't1', tool: 'Grep' })
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'a' }] })
    deltas.length = 0
    r.clear()
    const endedIds = deltas.filter((d) => d.op === 'ended').map((d) => d.entry.id).sort()
    assert.deepEqual(endedIds, ['shell:brk1', 't1'])
    assert.equal(r.getEntries().length, 0)
    // second clear is a no-op
    deltas.length = 0
    r.clear()
    assert.equal(deltas.length, 0)
  })
})

describe('ActivityRegistry — wire-schema compliance', () => {
  it('every emitted delta validates against ServerActivityDeltaSchema', () => {
    const { r, deltas } = makeRegistry('sess-A')
    r.onAgentSpawned({ toolUseId: 'a1', description: 'parent' })
    r.onAgentEvent({ parentToolUseId: 'a1', type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } })
    r.onToolStart({ toolUseId: 't1', tool: 'Bash' })
    r.onBackgroundWorkChanged({ pending: [{ shellId: 'brk1', command: 'npm test' }] })
    r.onPermissionRequest({ requestId: 'req1', tool: 'Bash' })
    r.onToolResult({ toolUseId: 't1', isError: true })
    r.onBackgroundWorkChanged({ pending: [] })
    r.onPermissionResolved({ requestId: 'req1', decision: 'deny' })
    r.onAgentCompleted({ toolUseId: 'a1' })
    assert.ok(deltas.length > 0)
    for (const d of deltas) {
      const parsed = ServerActivityDeltaSchema.safeParse({ type: 'activity_delta', ...d })
      assert.ok(parsed.success, `delta failed schema: ${JSON.stringify(d)} -> ${parsed.error}`)
    }
  })

  it('snapshot validates against ServerActivitySnapshotSchema', () => {
    const { r } = makeRegistry('sess-B')
    r.onToolStart({ toolUseId: 't1', tool: 'Bash' })
    r.onAgentSpawned({ toolUseId: 'a1', description: 'x' })
    const parsed = ServerActivitySnapshotSchema.safeParse(r.getSnapshotMessage())
    assert.ok(parsed.success, `snapshot failed schema: ${parsed.error}`)
    assert.equal(parsed.data.entries.length, 2)
  })
})

// --- BaseSession integration -----------------------------------------------

describe('ActivityRegistry — BaseSession wiring', () => {
  let skillsDir

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-activity-skills-'))
  })

  function makeSession() {
    return new BaseSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
  }

  it('feeds session events into the registry and re-emits activity_delta', () => {
    const session = makeSession()
    const deltas = []
    session.on('activity_delta', (d) => deltas.push(d))

    session.emit('tool_start', { messageId: 'm1', toolUseId: 't1', tool: 'Bash' })
    session.emit('tool_result', { toolUseId: 't1', result: 'ok', truncated: false })

    assert.deepEqual(ops(deltas), ['started', 'ended'])
    assert.equal(deltas[0].entry.kind, 'tool')
    assert.equal(deltas[1].entry.status, 'done')

    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('getActivitySnapshot reflects in-flight work', () => {
    const session = makeSession()
    session.emit('agent_spawned', { toolUseId: 'a1', description: 'work' })
    const snap = session.getActivitySnapshot()
    assert.equal(snap.type, 'activity_snapshot')
    assert.equal(snap.entries.length, 1)
    assert.equal(snap.entries[0].kind, 'agent')

    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('background_work_changed feeds shell nodes into the registry', () => {
    const session = makeSession()
    const deltas = []
    session.on('activity_delta', (d) => deltas.push(d))
    // Use the real BaseSession path so we exercise the wiring end-to-end.
    session.trackBackgroundShell({ shellId: 'brk1', command: 'npm test' })
    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].entry.kind, 'shell')
    assert.equal(deltas[0].op, 'started')

    session.clearBackgroundShell('brk1')
    assert.equal(deltas.at(-1).op, 'ended')
    assert.equal(deltas.at(-1).entry.kind, 'shell')

    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('_clearMessageState (turn-end) ends non-shell nodes, shells survive', () => {
    const session = makeSession()
    session.emit('tool_start', { messageId: 'm1', toolUseId: 't1', tool: 'Grep' })
    session.trackBackgroundShell({ shellId: 'brk1', command: 'a' })
    const deltas = []
    session.on('activity_delta', (d) => deltas.push(d))

    session._clearMessageState()

    const ended = deltas.filter((d) => d.op === 'ended').map((d) => d.entry.id)
    assert.ok(ended.includes('t1'))
    assert.ok(!ended.includes('shell:brk1'))
    const remaining = session.getActivitySnapshot().entries
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].kind, 'shell')

    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('removeAllListeners (destroy chokepoint) clears the registry', () => {
    const session = makeSession()
    session.trackBackgroundShell({ shellId: 'brk1', command: 'a' })
    const deltas = []
    session.on('activity_delta', (d) => deltas.push(d))

    session.removeAllListeners()

    assert.equal(deltas.length, 1)
    assert.equal(deltas[0].op, 'ended')
    assert.equal(session.getActivitySnapshot().entries.length, 0)
  })

  it('targeted removeAllListeners(event) does NOT drain the registry', () => {
    const session = makeSession()
    session.trackBackgroundShell({ shellId: 'brk1', command: 'a' })
    session.removeAllListeners('some_other_event')
    assert.equal(session.getActivitySnapshot().entries.length, 1)

    rmSync(skillsDir, { recursive: true, force: true })
  })
})
