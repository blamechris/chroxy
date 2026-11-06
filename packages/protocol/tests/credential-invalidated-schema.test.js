import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerCredentialInvalidatedSchema } from '../src/schemas/index.ts'

describe('ServerCredentialInvalidatedSchema', () => {
  it('accepts each reason the server sends', () => {
    for (const reason of ['revoked', 'expired', 'evicted', 'invalid']) {
      assert.equal(ServerCredentialInvalidatedSchema.safeParse({ type: 'credential_invalidated', reason }).success, true, reason)
    }
  })

  it('rejects a reason outside that vocabulary, a missing reason and a wrong type', () => {
    assert.equal(ServerCredentialInvalidatedSchema.safeParse({ type: 'credential_invalidated', reason: 'destroyed' }).success, false)
    assert.equal(ServerCredentialInvalidatedSchema.safeParse({ type: 'credential_invalidated' }).success, false)
    assert.equal(ServerCredentialInvalidatedSchema.safeParse({ type: 'auth_fail', reason: 'revoked' }).success, false)
  })
})
