import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerPushTokenErrorSchema } from '../src/ws-schemas.js'

describe('ServerPushTokenErrorSchema (#1985)', () => {
  test('validates correct push_token_error message', () => {
    const result = ServerPushTokenErrorSchema.safeParse({
      type: 'push_token_error',
      message: 'Push token rejected — must be a non-empty string',
    })
    assert.ok(result.success)
  })

  test('rejects missing message', () => {
    const result = ServerPushTokenErrorSchema.safeParse({
      type: 'push_token_error',
    })
    assert.ok(!result.success)
  })

  test('rejects wrong type', () => {
    const result = ServerPushTokenErrorSchema.safeParse({
      type: 'server_error',
      message: 'test',
    })
    assert.ok(!result.success)
  })
})
