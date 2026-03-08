import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CONCURRENT_PTY } from '../src/ws-message-handlers.js'

describe('MAX_CONCURRENT_PTY', () => {
  it('is exported and set to 4', () => {
    assert.equal(MAX_CONCURRENT_PTY, 4)
  })

  it('is a positive integer', () => {
    assert.ok(Number.isInteger(MAX_CONCURRENT_PTY))
    assert.ok(MAX_CONCURRENT_PTY > 0)
  })
})
