/**
 * Tests for shared utility functions.
 */
import { describe, it, expect } from 'vitest'
import { createEmptyBaseSessionState, isActivityEvent, ACTIVITY_EVENT_TYPES } from './utils'
import type { BaseSessionState } from './types'

describe('createEmptyBaseSessionState', () => {
  it('returns an object with all expected fields', () => {
    const state = createEmptyBaseSessionState()

    expect(state).toEqual({
      messages: [],
      streamingMessageId: null,
      pendingClientMessageId: null,
      claudeReady: false,
      activeModel: null,
      permissionMode: null,
      contextUsage: null,
      contextOccupancy: null,
      lastResultCost: null,
      lastResultDuration: null,
      sessionCost: null,
      cumulativeUsage: null,
      costThresholdWarning: null,
      isIdle: true,
      lastClientActivityAt: null,
      health: 'healthy',
      // #4879: quiet "Stop confirmed" marker — null until session_stopped lands
      stoppedAt: null,
      stoppedCode: null,
      activeAgents: [],
      activeTools: [],
      // #4307: empty array on init — populated by background_work_changed
      // events and/or session_list snapshot seed.
      pendingBackgroundShells: [],
      // #5431: transcript-derived outstanding work — empty/null until an
      // enriched claude_ready arrives.
      transcriptBackgroundTasks: [],
      scheduledWakeup: null,
      isPlanPending: false,
      planAllowedPrompts: [],
      primaryClientId: null,
      sessionRole: null,
      conversationId: null,
      sessionContext: null,
      statusLine: null,
      mcpServers: [],
      devPreviews: [],
      inactivityWarning: null,
      // #4653: chroxy-side intervention ring — empty array on init,
      // populated by multi_question_intervention events.
      interventions: [],
      // #5937: outgoing-message queue — empty array on init, populated by
      // message_queued / optimistic enqueue.
      queuedMessages: [],
    })
  })

  it('returns a new object on each call (no shared references)', () => {
    const a = createEmptyBaseSessionState()
    const b = createEmptyBaseSessionState()

    expect(a).not.toBe(b)
    expect(a.messages).not.toBe(b.messages)
    expect(a.activeAgents).not.toBe(b.activeAgents)
    expect(a.activeTools).not.toBe(b.activeTools)
    expect(a.pendingBackgroundShells).not.toBe(b.pendingBackgroundShells)
    expect(a.planAllowedPrompts).not.toBe(b.planAllowedPrompts)
    expect(a.mcpServers).not.toBe(b.mcpServers)
    expect(a.devPreviews).not.toBe(b.devPreviews)
    // #4653: interventions ring is per-session — each fresh state must
    // get its own array so a deny on session A doesn't bleed into session B.
    expect(a.interventions).not.toBe(b.interventions)
  })

  it('satisfies the BaseSessionState type', () => {
    const state: BaseSessionState = createEmptyBaseSessionState()
    expect(state.health).toBe('healthy')
    expect(state.isIdle).toBe(true)
    expect(state.claudeReady).toBe(false)
  })
})

describe('isActivityEvent (#3758)', () => {
  it('returns true for the canonical stream/tool/message activity types', () => {
    for (const t of ['stream_start', 'stream_delta', 'stream_end', 'tool_start', 'tool_result', 'message', 'result']) {
      expect(isActivityEvent(t)).toBe(true)
    }
  })

  it('returns true for user-blocking events (user_question, permission_request) — the agent is still alive, waiting on the user', () => {
    expect(isActivityEvent('user_question')).toBe(true)
    expect(isActivityEvent('permission_request')).toBe(true)
  })

  it('returns false for passive housekeeping events that should not reset the activity counter', () => {
    for (const t of ['pong', 'server_status', 'session_list', 'session_updated', 'key_exchange_ok', 'auth_ok', 'history_replay_start', 'history_replay_end']) {
      expect(isActivityEvent(t)).toBe(false)
    }
  })

  it('returns false for non-string or unknown inputs', () => {
    expect(isActivityEvent(undefined)).toBe(false)
    expect(isActivityEvent(null)).toBe(false)
    expect(isActivityEvent(42)).toBe(false)
    expect(isActivityEvent('totally_made_up')).toBe(false)
  })

  it('exposes ACTIVITY_EVENT_TYPES as a read-only set with the same membership', () => {
    expect(ACTIVITY_EVENT_TYPES.has('stream_delta')).toBe(true)
    expect(ACTIVITY_EVENT_TYPES.has('pong')).toBe(false)
  })
})
