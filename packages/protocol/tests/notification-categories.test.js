import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BYPASS_CATEGORIES, NOTIFICATION_CATEGORY_ORDER } from '../src/notification-categories.ts'

describe('default notification bypass categories (#8567)', () => {
  it('preserves the documented operator-blocking defaults', () => {
    assert.deepEqual([...DEFAULT_BYPASS_CATEGORIES], ['permission', 'activity_error'])
  })

  it('contains only known categories, without duplicates', () => {
    assert.ok(DEFAULT_BYPASS_CATEGORIES.length > 0, 'default bypass list must not be empty')
    assert.equal(new Set(DEFAULT_BYPASS_CATEGORIES).size, DEFAULT_BYPASS_CATEGORIES.length)
    for (const key of DEFAULT_BYPASS_CATEGORIES) {
      assert.ok(NOTIFICATION_CATEGORY_ORDER.includes(key), `unknown default bypass category: ${key}`)
    }
  })

  it('cannot be changed by a consumer', () => {
    assert.ok(Object.isFrozen(DEFAULT_BYPASS_CATEGORIES))
    assert.throws(() => DEFAULT_BYPASS_CATEGORIES.push('result'), TypeError)
  })
})
