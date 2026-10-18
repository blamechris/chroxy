import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BYPASS_CATEGORIES, NOTIFICATION_CATEGORY_ORDER } from '../src/notification-categories.ts'

describe('default notification bypass categories', () => {
  it('keeps the established defaults immutable and free of duplicates', () => {
    assert.deepEqual(DEFAULT_BYPASS_CATEGORIES, ['permission', 'activity_error'])
    assert.ok(Object.isFrozen(DEFAULT_BYPASS_CATEGORIES))
    assert.equal(new Set(DEFAULT_BYPASS_CATEGORIES).size, DEFAULT_BYPASS_CATEGORIES.length)
  })

  it('only bypasses categories in the notification roster', () => {
    for (const key of DEFAULT_BYPASS_CATEGORIES) {
      assert.ok(NOTIFICATION_CATEGORY_ORDER.includes(key), `unknown bypass category: ${key}`)
    }
  })
})
