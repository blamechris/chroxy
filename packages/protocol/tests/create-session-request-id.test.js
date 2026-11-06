import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CreateSessionSchema } from '../src/schemas/client.ts'

describe('CreateSessionSchema requestId (#7977)', () => {
  it('accepts a create with no requestId (old clients)', () => {
    assert.equal(CreateSessionSchema.safeParse({ type: 'create_session', name: 'x' }).success, true)
  })

  it('accepts and preserves a wire-valid requestId', () => {
    const r = CreateSessionSchema.safeParse({ type: 'create_session', requestId: 'ac-1_A' })
    assert.equal(r.success, true)
    assert.equal(r.data.requestId, 'ac-1_A')
  })

  it('rejects an empty, over-long, or non-token requestId', () => {
    for (const requestId of ['', 'x'.repeat(129), 'has space', 'a/b', 42]) {
      assert.equal(CreateSessionSchema.safeParse({ type: 'create_session', requestId }).success, false, String(requestId))
    }
  })
})
