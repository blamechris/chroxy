import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { OrchestrationPermissionGate } from '../src/orchestration/permission-gate.js'

// #6691 E-2 — the scoped headless approver. It answers permission_request ONLY
// for sessions the run owns, and never grants a standing Bash whitelist.

function mkStub() {
  const sm = new EventEmitter()
  const sessions = new Map()
  sm.getSession = (id) => sessions.get(id) || null
  const add = (id) => {
    const session = { responses: [], respondToPermission(requestId, decision) { this.responses.push({ requestId, decision }) } }
    sessions.set(id, { session })
    return session
  }
  sm.req = (id, data) => sm.emit('session_event', { sessionId: id, event: 'permission_request', data })
  return { sm, add, sessions }
}

let gate
afterEach(() => { gate?.dispose(); gate = null })

describe('OrchestrationPermissionGate', () => {
  it('ignores permission requests for sessions it does not own', () => {
    const { sm, add } = mkStub()
    const s = add('s1')
    gate = new OrchestrationPermissionGate({
      sessionManager: sm,
      isOwnedSession: () => false, // owns nothing
      policyForSession: () => 'audit',
    })
    sm.req('s1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    assert.equal(s.responses.length, 0, 'never answers a non-owned session')
  })

  it('denies Bash for an owned audit session', () => {
    const { sm, add } = mkStub()
    const s = add('s1')
    gate = new OrchestrationPermissionGate({
      sessionManager: sm,
      isOwnedSession: (id) => id === 's1',
      policyForSession: () => 'audit',
    })
    sm.req('s1', { requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf /' } })
    assert.deepEqual(s.responses, [{ requestId: 'r1', decision: 'deny' }])
  })

  it('always denies Task/WebFetch/WebSearch regardless of role', () => {
    const { sm, add } = mkStub()
    const s = add('s1')
    gate = new OrchestrationPermissionGate({
      sessionManager: sm,
      isOwnedSession: () => true,
      policyForSession: () => 'implement',
    })
    for (const [i, tool] of ['Task', 'WebFetch', 'WebSearch'].entries()) {
      sm.req('s1', { requestId: `r${i}`, toolName: tool, input: {} })
    }
    assert.deepEqual(s.responses.map((r) => r.decision), ['deny', 'deny', 'deny'])
  })

  it('escalates then denies Bash for an implement worker, emitting an escalation', () => {
    const { sm, add } = mkStub()
    const s = add('s1')
    const escalations = []
    gate = new OrchestrationPermissionGate({
      sessionManager: sm,
      isOwnedSession: () => true,
      policyForSession: () => 'implement',
      emitEscalation: (info) => escalations.push(info),
    })
    sm.req('s1', { requestId: 'r1', toolName: 'Bash', input: { command: 'npm test' } })
    // deny keeps the worker unblocked until the user resolves the escalation
    assert.deepEqual(s.responses, [{ requestId: 'r1', decision: 'deny' }])
    assert.equal(escalations.length, 1)
    assert.equal(escalations[0].toolName, 'Bash')
    assert.equal(escalations[0].requestId, 'r1')
  })

  it('ignores non-permission session events and requests with no requestId', () => {
    const { sm, add } = mkStub()
    const s = add('s1')
    gate = new OrchestrationPermissionGate({
      sessionManager: sm,
      isOwnedSession: () => true,
      policyForSession: () => 'audit',
    })
    sm.emit('session_event', { sessionId: 's1', event: 'result', data: { cost: 1 } })
    sm.req('s1', { toolName: 'Bash' }) // no requestId
    assert.equal(s.responses.length, 0)
  })

  it('unsubscribes on dispose', () => {
    const { sm, add } = mkStub()
    const s = add('s1')
    gate = new OrchestrationPermissionGate({
      sessionManager: sm,
      isOwnedSession: () => true,
      policyForSession: () => 'audit',
    })
    gate.dispose()
    gate = null
    sm.req('s1', { requestId: 'r1', toolName: 'Bash' })
    assert.equal(s.responses.length, 0, 'no longer listening after dispose')
  })
})
