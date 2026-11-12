import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { QuestionRouteMap } from '../src/question-route-map.js'

describe('QuestionRouteMap reset and reuse (#8478)', () => {
  it('clear resets both history indexes before the same owner records and evicts again', () => {
    const map = new QuestionRouteMap({ maxPerOwner: 2, maxRecent: 10, now: () => 0 })
    for (const id of ['old-1', 'old-2']) {
      map.set(id, 'A')
      assert.equal(map.delete(id), true)
    }
    map.set('live', 'A')
    assert.deepEqual([...map._byOwner.get('A')], ['old-1', 'old-2'])

    map.clear()

    assert.equal(map.size, 0, 'live routes are cleared')
    assert.equal(map._recent.size, 0, 'recent records are cleared')
    // Check before reuse: a stale owner index would make synchronous eviction
    // spin in _forget, so a timer cannot turn that regression into a failure.
    assert.equal(map._byOwner.size, 0, 'the per-owner index is cleared before reuse')
    assert.equal(map.recentOwner('old-1'), undefined)
    assert.equal(map.recentOwner('old-2'), undefined)

    for (const id of ['new-1', 'new-2', 'new-3']) {
      map.set(id, 'A')
      assert.equal(map.delete(id), true)
    }

    assert.equal(map.size, 0)
    assert.equal(map.recentOwner('new-1'), undefined, 'the same owner evicts its oldest new record')
    assert.equal(map.recentOwner('new-2')?.sessionId, 'A')
    assert.equal(map.recentOwner('new-3')?.sessionId, 'A')
    assert.deepEqual([...map._recent.keys()], ['new-2', 'new-3'])
    assert.deepEqual([...map._byOwner.get('A')], ['new-2', 'new-3'])
  })

  it('_forget tolerates absent and already forgotten recent entries without disturbing other routes', () => {
    const map = new QuestionRouteMap({ now: () => 0 })
    assert.doesNotThrow(() => map._forget('missing'))
    map.set('recent', 'A')
    map.delete('recent')
    map.set('live', 'A')
    const recent = map.recentOwner('recent')

    assert.doesNotThrow(() => map._forget('missing'))
    assert.equal(map.recentOwner('recent'), recent)
    assert.deepEqual([...map._byOwner.get('A')], ['recent'])

    map._forget('recent')
    assert.doesNotThrow(() => map._forget('recent'))
    assert.equal(map.recentOwner('recent'), undefined)
    assert.equal(map._recent.size, 0)
    assert.equal(map._byOwner.size, 0)
    assert.equal(map.get('live'), 'A')
  })
})
