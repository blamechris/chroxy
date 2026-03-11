import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RegisterPushTokenSchema } from '../src/ws-schemas.js'

describe('RegisterPushTokenSchema min(1) (#1984)', () => {
  it('accepts non-empty token', () => {
    const result = RegisterPushTokenSchema.safeParse({
      type: 'register_push_token',
      token: 'ExponentPushToken[abc123]',
    })
    assert.ok(result.success)
  })

  it('rejects empty string token', () => {
    const result = RegisterPushTokenSchema.safeParse({
      type: 'register_push_token',
      token: '',
    })
    assert.ok(!result.success, 'Should reject empty token')
  })
})
