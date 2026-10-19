import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BYPASS_CATEGORIES, NOTIFICATION_CATEGORY_ORDER } from '../src/notification-categories.ts'

describe('quiet-hours bypass defaults', () => {
  it('pins the documented defaults to known notification categories', () => {
    assert.deepEqual(DEFAULT_BYPASS_CATEGORIES, ['permission', 'activity_error'])
    assert.ok(DEFAULT_BYPASS_CATEGORIES.every(category => NOTIFICATION_CATEGORY_ORDER.includes(category)))
  })

  it('cannot be mutated by a consumer', () => {
    assert.ok(Object.isFrozen(DEFAULT_BYPASS_CATEGORIES))
    assert.throws(() => DEFAULT_BYPASS_CATEGORIES.push('result'), TypeError)
    assert.deepEqual(DEFAULT_BYPASS_CATEGORIES, ['permission', 'activity_error'])
  })
})
