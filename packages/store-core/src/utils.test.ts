/**
 * Tests for shared utility functions.
 */
import { describe, it, expect } from 'vitest'
import { createEmptyBaseSessionState } from './utils'
import type { BaseSessionState } from './types'

describe('createEmptyBaseSessionState', () => {
  it('returns an object with all expected fields', () => {
    const state = createEmptyBaseSessionState()

    expect(state).toEqual({
      messages: [],
      streamingMessageId: null,
      claudeReady: false,
      activeModel: null,
      permissionMode: null,
      contextUsage: null,
      lastResultCost: null,
      lastResultDuration: null,
      sessionCost: null,
      isIdle: true,
      health: 'healthy',
      activeAgents: [],
      isPlanPending: false,
      planAllowedPrompts: [],
      primaryClientId: null,
      conversationId: null,
      sessionContext: null,
      mcpServers: [],
      devPreviews: [],
    })
  })

  it('returns a new object on each call (no shared references)', () => {
    const a = createEmptyBaseSessionState()
    const b = createEmptyBaseSessionState()

    expect(a).not.toBe(b)
    expect(a.messages).not.toBe(b.messages)
    expect(a.activeAgents).not.toBe(b.activeAgents)
    expect(a.planAllowedPrompts).not.toBe(b.planAllowedPrompts)
    expect(a.mcpServers).not.toBe(b.mcpServers)
    expect(a.devPreviews).not.toBe(b.devPreviews)
  })

  it('satisfies the BaseSessionState type', () => {
    const state: BaseSessionState = createEmptyBaseSessionState()
    expect(state.health).toBe('healthy')
    expect(state.isIdle).toBe(true)
    expect(state.claudeReady).toBe(false)
  })
})
