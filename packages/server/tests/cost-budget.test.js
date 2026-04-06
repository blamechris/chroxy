import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { registerProvider } from '../src/providers.js'
import { SessionManager } from '../src/session-manager.js'

// Stub session provider for testing
class StubSession extends EventEmitter {
  constructor() {
    super()
    this.model = 'test'
    this.permissionMode = 'approve'
    this.isRunning = false
    this.resumeSessionId = null
  }
  start() {}
  destroy() {}
  sendMessage() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}
StubSession.capabilities = {}

registerProvider('test-cost', StubSession)

describe('cost budget tracking', () => {
  let sm

  beforeEach(() => {
    sm = new SessionManager({
      costBudget: 5.00,
      providerType: 'test-cost',
      defaultCwd: process.cwd(),
      stateFilePath: '/tmp/test-cost-budget-state.json',
    })
  })

  it('tracks cumulative cost per session', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)

    entry.session.emit('result', { cost: 1.50, duration: 100 })
    entry.session.emit('result', { cost: 0.75, duration: 50 })

    assert.equal(sm.getSessionCost(sid), 2.25)
  })

  it('emits cost_update on each result', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)
    const updates = []

    sm.on('session_event', ({ event, data }) => {
      if (event === 'cost_update') updates.push(data)
    })

    entry.session.emit('result', { cost: 1.00, duration: 100 })
    assert.equal(updates.length, 1)
    assert.equal(updates[0].sessionCost, 1.00)
    assert.equal(updates[0].budget, 5.00)
  })

  it('emits budget_warning at 80%', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)
    const warnings = []

    sm.on('session_event', ({ event, data }) => {
      if (event === 'budget_warning') warnings.push(data)
    })

    entry.session.emit('result', { cost: 4.00, duration: 100 })
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].percent, 80)
  })

  it('does not re-warn after first 80% warning', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)
    const warnings = []

    sm.on('session_event', ({ event, data }) => {
      if (event === 'budget_warning') warnings.push(data)
    })

    entry.session.emit('result', { cost: 4.00, duration: 100 })
    entry.session.emit('result', { cost: 0.50, duration: 50 })
    assert.equal(warnings.length, 1, 'Should only warn once')
  })

  it('emits budget_exceeded at 100%', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)
    const exceeded = []

    sm.on('session_event', ({ event, data }) => {
      if (event === 'budget_exceeded') exceeded.push(data)
    })

    entry.session.emit('result', { cost: 5.00, duration: 100 })
    assert.equal(exceeded.length, 1)
    assert.equal(exceeded[0].percent, 100)
  })

  it('does not re-emit budget_exceeded after first crossing', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)
    const exceeded = []

    sm.on('session_event', ({ event, data }) => {
      if (event === 'budget_exceeded') exceeded.push(data)
    })

    entry.session.emit('result', { cost: 5.00, duration: 100 })
    entry.session.emit('result', { cost: 1.00, duration: 50 })
    entry.session.emit('result', { cost: 0.50, duration: 30 })
    assert.equal(exceeded.length, 1, 'Should only exceed once')
  })

  it('does not emit both warning and exceeded when jumping past 100%', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)
    const events = []

    sm.on('session_event', ({ event }) => {
      if (event === 'budget_warning' || event === 'budget_exceeded') events.push(event)
    })

    // Jump from 0 to 120% in one result
    entry.session.emit('result', { cost: 6.00, duration: 100 })
    assert.equal(events.length, 1, 'Should emit only one budget event')
    assert.equal(events[0], 'budget_exceeded', 'Should emit exceeded, not warning')
  })

  it('does not emit budget events when no budget configured', () => {
    const smNoBudget = new SessionManager({
      providerType: 'test-cost',
      defaultCwd: process.cwd(),
      stateFilePath: '/tmp/test-cost-no-budget-state.json',
    })
    const sid = smNoBudget.createSession({ name: 'Test' })
    const entry = smNoBudget.getSession(sid)
    const events = []

    smNoBudget.on('session_event', ({ event }) => {
      if (event === 'budget_warning' || event === 'budget_exceeded') events.push(event)
    })

    entry.session.emit('result', { cost: 100.00, duration: 100 })
    assert.equal(events.length, 0)
    assert.equal(smNoBudget.getSessionCost(sid), 100.00)
  })

  it('getTotalCost sums across sessions', () => {
    const sid1 = sm.createSession({ name: 'Session 1' })
    const sid2 = sm.createSession({ name: 'Session 2' })
    const entry1 = sm.getSession(sid1)
    const entry2 = sm.getSession(sid2)

    entry1.session.emit('result', { cost: 1.00, duration: 100 })
    entry2.session.emit('result', { cost: 2.00, duration: 100 })

    assert.equal(sm.getTotalCost(), 3.00)
  })

  it('cleans up cost data on session destroy', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)

    entry.session.emit('result', { cost: 1.00, duration: 100 })
    assert.equal(sm.getSessionCost(sid), 1.00)

    sm.destroySession(sid)
    assert.equal(sm.getSessionCost(sid), 0)
  })

  it('ignores result events without cost', () => {
    const sid = sm.createSession({ name: 'Test' })
    const entry = sm.getSession(sid)

    entry.session.emit('result', { duration: 100 })
    assert.equal(sm.getSessionCost(sid), 0)
  })
})
