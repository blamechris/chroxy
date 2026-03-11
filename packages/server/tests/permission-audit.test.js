import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionAuditLog } from '../src/permission-audit.js'

describe('PermissionAuditLog (#1851)', () => {
  let log

  beforeEach(() => {
    log = new PermissionAuditLog()
  })

  it('records mode changes with all required fields', () => {
    log.logModeChange({
      clientId: 'c1',
      sessionId: 's1',
      previousMode: 'approve',
      newMode: 'auto',
    })

    const entries = log.query()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'mode_change')
    assert.equal(entries[0].clientId, 'c1')
    assert.equal(entries[0].sessionId, 's1')
    assert.equal(entries[0].previousMode, 'approve')
    assert.equal(entries[0].newMode, 'auto')
    assert.equal(typeof entries[0].timestamp, 'number')
  })

  it('records permission decisions with all required fields', () => {
    log.logDecision({
      clientId: 'c2',
      sessionId: 's1',
      requestId: 'req-123',
      decision: 'allow',
    })

    const entries = log.query()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'decision')
    assert.equal(entries[0].clientId, 'c2')
    assert.equal(entries[0].requestId, 'req-123')
    assert.equal(entries[0].decision, 'allow')
  })

  it('filters by sessionId', () => {
    log.logModeChange({ clientId: 'c1', sessionId: 's1', previousMode: 'approve', newMode: 'auto' })
    log.logModeChange({ clientId: 'c1', sessionId: 's2', previousMode: 'approve', newMode: 'plan' })
    log.logDecision({ clientId: 'c1', sessionId: 's1', requestId: 'r1', decision: 'allow' })

    const s1 = log.query({ sessionId: 's1' })
    assert.equal(s1.length, 2)
    assert.ok(s1.every(e => e.sessionId === 's1'))
  })

  it('filters by type', () => {
    log.logModeChange({ clientId: 'c1', sessionId: 's1', previousMode: 'approve', newMode: 'auto' })
    log.logDecision({ clientId: 'c1', sessionId: 's1', requestId: 'r1', decision: 'deny' })

    const decisions = log.query({ type: 'decision' })
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].decision, 'deny')
  })

  it('filters by since timestamp', () => {
    log.logModeChange({ clientId: 'c1', sessionId: 's1', previousMode: 'approve', newMode: 'auto' })
    const after = Date.now() + 1
    log._entries[0].timestamp = Date.now() - 10000 // backdate first entry

    log.logDecision({ clientId: 'c1', sessionId: 's1', requestId: 'r1', decision: 'allow' })

    const recent = log.query({ since: after - 5 })
    assert.equal(recent.length, 1)
    assert.equal(recent[0].type, 'decision')
  })

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      log.logDecision({ clientId: 'c1', sessionId: 's1', requestId: `r${i}`, decision: 'allow' })
    }

    const limited = log.query({ limit: 3 })
    assert.equal(limited.length, 3)
    // Should return the most recent 3
    assert.equal(limited[2].requestId, 'r9')
  })

  it('enforces maxEntries bound', () => {
    const small = new PermissionAuditLog({ maxEntries: 10 })
    for (let i = 0; i < 20; i++) {
      small.logDecision({ clientId: 'c1', sessionId: 's1', requestId: `r${i}`, decision: 'allow' })
    }

    assert.ok(small.size <= 10)
  })

  it('clear removes all entries', () => {
    log.logModeChange({ clientId: 'c1', sessionId: 's1', previousMode: 'approve', newMode: 'auto' })
    log.clear()
    assert.equal(log.size, 0)
    assert.deepEqual(log.query(), [])
  })
})
