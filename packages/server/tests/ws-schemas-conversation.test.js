import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ClientMessageSchema,
  ListConversationsSchema,
  ResumeConversationSchema,
  SearchConversationsSchema,
} from '../src/ws-schemas.js'

describe('Conversation schemas in ClientMessageSchema (#2154)', () => {
  it('list_conversations passes individual schema validation', () => {
    const result = ListConversationsSchema.safeParse({ type: 'list_conversations' })
    assert.ok(result.success, 'ListConversationsSchema should accept { type: "list_conversations" }')
  })

  it('list_conversations passes ClientMessageSchema discriminated union', () => {
    const result = ClientMessageSchema.safeParse({ type: 'list_conversations' })
    assert.ok(result.success, 'ClientMessageSchema should accept list_conversations')
  })

  it('resume_conversation passes individual schema validation', () => {
    const result = ResumeConversationSchema.safeParse({
      type: 'resume_conversation',
      conversationId: 'conv-abc-123',
    })
    assert.ok(result.success, 'ResumeConversationSchema should accept valid message')
  })

  it('resume_conversation passes ClientMessageSchema discriminated union', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'resume_conversation',
      conversationId: 'conv-abc-123',
    })
    assert.ok(result.success, 'ClientMessageSchema should accept resume_conversation')
  })

  it('resume_conversation accepts optional cwd and name', () => {
    const result = ResumeConversationSchema.safeParse({
      type: 'resume_conversation',
      conversationId: 'conv-abc-123',
      cwd: '/home/user/project',
      name: 'My Conversation',
    })
    assert.ok(result.success, 'Should accept optional cwd and name fields')
  })

  it('resume_conversation rejects missing conversationId', () => {
    const result = ResumeConversationSchema.safeParse({
      type: 'resume_conversation',
    })
    assert.ok(!result.success, 'Should reject when conversationId is missing')
  })

  it('search_conversations passes ClientMessageSchema discriminated union', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'search_conversations',
      query: 'test query',
    })
    assert.ok(result.success, 'ClientMessageSchema should accept search_conversations')
  })

  it('search_conversations rejects empty query', () => {
    const result = SearchConversationsSchema.safeParse({
      type: 'search_conversations',
      query: '',
    })
    assert.ok(!result.success, 'Should reject empty query string')
  })
})
