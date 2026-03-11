import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ResumeConversationSchema } from '../src/ws-schemas.js'

describe('ResumeConversationSchema name validation (#1980)', () => {
  it('accepts name under 200 chars', () => {
    const result = ResumeConversationSchema.safeParse({
      type: 'resume_conversation',
      conversationId: 'abc-123',
      name: 'My Session',
    })
    assert.ok(result.success)
  })

  it('rejects name over 200 chars', () => {
    const result = ResumeConversationSchema.safeParse({
      type: 'resume_conversation',
      conversationId: 'abc-123',
      name: 'x'.repeat(201),
    })
    assert.ok(!result.success, 'Should reject name over 200 chars')
  })

  it('allows omitting name', () => {
    const result = ResumeConversationSchema.safeParse({
      type: 'resume_conversation',
      conversationId: 'abc-123',
    })
    assert.ok(result.success)
  })
})
