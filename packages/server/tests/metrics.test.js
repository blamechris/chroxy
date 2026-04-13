import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { metrics } from '../src/metrics.js'

describe('MetricsStore', () => {
  beforeEach(() => {
    metrics.reset()
  })

  it('returns 0 for uninitialized counters', () => {
    assert.equal(metrics.get('never.set'), 0)
  })

  it('increments counters', () => {
    metrics.inc('auth.failures')
    metrics.inc('auth.failures')
    assert.equal(metrics.get('auth.failures'), 2)
  })

  it('increments by arbitrary amounts', () => {
    metrics.inc('ws.messages.received', 10)
    assert.equal(metrics.get('ws.messages.received'), 10)
    metrics.inc('ws.messages.received', 5)
    assert.equal(metrics.get('ws.messages.received'), 15)
  })

  it('snapshot returns all counters plus _uptimeSeconds', () => {
    metrics.inc('push.sent')
    metrics.inc('tunnel.flaps', 3)
    const snap = metrics.snapshot()
    assert.equal(snap['push.sent'], 1)
    assert.equal(snap['tunnel.flaps'], 3)
    assert.equal(typeof snap._uptimeSeconds, 'number')
    assert.ok(snap._uptimeSeconds >= 0)
  })

  it('reset clears all counters', () => {
    metrics.inc('push.sent', 99)
    metrics.reset()
    assert.equal(metrics.get('push.sent'), 0)
    const snap = metrics.snapshot()
    assert.ok(!('push.sent' in snap))
  })
})
