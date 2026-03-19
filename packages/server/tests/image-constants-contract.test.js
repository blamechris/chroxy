/**
 * Contract test: assert server image validation constants are correct.
 * Dashboard TS constants are independently tested by the vitest suite.
 * If either side changes limits, a corresponding update must be made to both.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTACHMENT_COUNT, MAX_IMAGE_SIZE, ALLOWED_IMAGE_TYPES } from '../src/handler-utils.js'

describe('image validation constants contract', () => {
  it('MAX_IMAGE_SIZE is 2MB', () => {
    assert.strictEqual(MAX_IMAGE_SIZE, 2 * 1024 * 1024, 'server MAX_IMAGE_SIZE should be 2MB')
  })

  it('MAX_ATTACHMENT_COUNT is 5', () => {
    assert.strictEqual(MAX_ATTACHMENT_COUNT, 5, 'server MAX_ATTACHMENT_COUNT should be 5')
  })

  it('ALLOWED_IMAGE_TYPES includes exactly jpeg, png, gif, webp', () => {
    const expected = ['image/gif', 'image/jpeg', 'image/png', 'image/webp']
    const actual = [...ALLOWED_IMAGE_TYPES].sort()
    assert.deepStrictEqual(actual, expected,
      `server ALLOWED_IMAGE_TYPES should be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  })
})
