/**
 * Tests for shared stateless message handler functions.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveSessionId,
  handleModelChanged,
  handlePermissionModeChanged,
  handleAvailablePermissionModes,
  handleSessionUpdated,
  handleConfirmPermissionMode,
  handleClaudeReady,
  handleAgentIdle,
  handleAgentBusy,
  handleThinkingLevelChanged,
  handleBudgetWarning,
  handleBudgetExceeded,
  handleBudgetResumed,
  handlePlanStarted,
  handlePlanReady,
} from './index'
import type { SessionInfo } from '../types'

// ---------------------------------------------------------------------------
// resolveSessionId
// ---------------------------------------------------------------------------
describe('resolveSessionId', () => {
  it('returns sessionId from message when present', () => {
    expect(resolveSessionId({ sessionId: 'sess-1' }, 'active-1')).toBe('sess-1')
  })

  it('falls back to activeSessionId when message has no sessionId', () => {
    expect(resolveSessionId({}, 'active-1')).toBe('active-1')
  })

  it('falls back to activeSessionId when sessionId is empty string', () => {
    expect(resolveSessionId({ sessionId: '  ' }, 'active-1')).toBe('active-1')
  })

  it('returns null when neither is available', () => {
    expect(resolveSessionId({}, null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleModelChanged
// ---------------------------------------------------------------------------
describe('handleModelChanged', () => {
  it('extracts model string', () => {
    expect(handleModelChanged({ model: 'claude-3-opus' })).toEqual({ model: 'claude-3-opus' })
  })

  it('trims whitespace', () => {
    expect(handleModelChanged({ model: '  sonnet  ' })).toEqual({ model: 'sonnet' })
  })

  it('returns null for missing model', () => {
    expect(handleModelChanged({})).toEqual({ model: null })
  })

  it('returns null for empty string', () => {
    expect(handleModelChanged({ model: '' })).toEqual({ model: null })
  })

  it('returns null for non-string model', () => {
    expect(handleModelChanged({ model: 42 })).toEqual({ model: null })
  })
})

// ---------------------------------------------------------------------------
// handlePermissionModeChanged
// ---------------------------------------------------------------------------
describe('handlePermissionModeChanged', () => {
  it('extracts mode string', () => {
    expect(handlePermissionModeChanged({ mode: 'auto-approve' })).toEqual({ mode: 'auto-approve' })
  })

  it('trims whitespace', () => {
    expect(handlePermissionModeChanged({ mode: ' default ' })).toEqual({ mode: 'default' })
  })

  it('returns null for missing mode', () => {
    expect(handlePermissionModeChanged({})).toEqual({ mode: null })
  })
})

// ---------------------------------------------------------------------------
// handleAvailablePermissionModes
// ---------------------------------------------------------------------------
describe('handleAvailablePermissionModes', () => {
  it('filters valid permission modes', () => {
    const msg = {
      modes: [
        { id: 'default', label: 'Default' },
        { id: 'auto', label: 'Auto Approve' },
        'invalid',
        null,
        { id: 123, label: 'Bad ID' },
      ],
    }
    const result = handleAvailablePermissionModes(msg)
    expect(result).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'auto', label: 'Auto Approve' },
    ])
  })

  it('returns null when modes is not an array', () => {
    expect(handleAvailablePermissionModes({})).toBeNull()
    expect(handleAvailablePermissionModes({ modes: 'not-array' })).toBeNull()
  })

  it('returns empty array when no modes are valid', () => {
    expect(handleAvailablePermissionModes({ modes: [null, 42, 'str'] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// handleSessionUpdated
// ---------------------------------------------------------------------------
describe('handleSessionUpdated', () => {
  const sessions: SessionInfo[] = [
    {
      sessionId: 'sess-1',
      name: 'Old Name',
      cwd: '/home',
      type: 'cli',
      hasTerminal: true,
      model: null,
      permissionMode: null,
      isBusy: false,
      createdAt: 1000,
      conversationId: null,
    },
    {
      sessionId: 'sess-2',
      name: 'Other Session',
      cwd: '/home',
      type: 'cli',
      hasTerminal: true,
      model: null,
      permissionMode: null,
      isBusy: false,
      createdAt: 2000,
      conversationId: null,
    },
  ]

  it('updates the matching session name', () => {
    const result = handleSessionUpdated(
      { sessionId: 'sess-1', name: 'New Name' },
      sessions,
    )
    expect(result).not.toBeNull()
    expect(result![0].name).toBe('New Name')
    expect(result![1].name).toBe('Other Session')
  })

  it('returns null when sessionId is missing', () => {
    expect(handleSessionUpdated({ name: 'New Name' }, sessions)).toBeNull()
  })

  it('returns null when name is missing', () => {
    expect(handleSessionUpdated({ sessionId: 'sess-1' }, sessions)).toBeNull()
  })

  it('returns list unchanged when sessionId does not match', () => {
    const result = handleSessionUpdated(
      { sessionId: 'nonexistent', name: 'New Name' },
      sessions,
    )
    expect(result).not.toBeNull()
    expect(result![0].name).toBe('Old Name')
    expect(result![1].name).toBe('Other Session')
  })
})

// ---------------------------------------------------------------------------
// handleConfirmPermissionMode
// ---------------------------------------------------------------------------
describe('handleConfirmPermissionMode', () => {
  it('returns mode + warning when both are present', () => {
    const out = handleConfirmPermissionMode({
      mode: 'plan',
      warning: 'This will discard pending edits.',
    })
    expect(out).toEqual({ mode: 'plan', warning: 'This will discard pending edits.' })
  })

  it('falls back to a default warning when warning is missing', () => {
    expect(handleConfirmPermissionMode({ mode: 'plan' })).toEqual({
      mode: 'plan',
      warning: 'Are you sure?',
    })
  })

  it('falls back to the default warning when warning is non-string', () => {
    expect(handleConfirmPermissionMode({ mode: 'plan', warning: 42 })).toEqual({
      mode: 'plan',
      warning: 'Are you sure?',
    })
  })

  it('returns null when mode is missing', () => {
    expect(handleConfirmPermissionMode({})).toBeNull()
  })

  it('returns null when mode is non-string', () => {
    expect(handleConfirmPermissionMode({ mode: 42 })).toBeNull()
  })

  it('returns null when mode is empty string (treated as missing by inline impls)', () => {
    // The original inline check was `typeof msg.mode === 'string' ? msg.mode : null`
    // followed by `if (confirmMode)` — empty string is falsy and would be skipped.
    expect(handleConfirmPermissionMode({ mode: '' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleClaudeReady
// ---------------------------------------------------------------------------
describe('handleClaudeReady', () => {
  it('returns claudeReady: true', () => {
    expect(handleClaudeReady()).toEqual({ claudeReady: true })
  })
})

// ---------------------------------------------------------------------------
// handleAgentIdle / handleAgentBusy
// ---------------------------------------------------------------------------
describe('handleAgentIdle', () => {
  it('returns isIdle: true', () => {
    expect(handleAgentIdle()).toEqual({ isIdle: true })
  })
})

describe('handleAgentBusy', () => {
  it('returns isIdle: false', () => {
    expect(handleAgentBusy()).toEqual({ isIdle: false })
  })
})

// ---------------------------------------------------------------------------
// handleThinkingLevelChanged
// ---------------------------------------------------------------------------
describe('handleThinkingLevelChanged', () => {
  it('extracts valid thinking level', () => {
    expect(handleThinkingLevelChanged({ level: 'high' })).toEqual({ level: 'high' })
    expect(handleThinkingLevelChanged({ level: 'max' })).toEqual({ level: 'max' })
    expect(handleThinkingLevelChanged({ level: 'default' })).toEqual({ level: 'default' })
  })

  it('defaults to "default" for invalid level', () => {
    expect(handleThinkingLevelChanged({ level: 'turbo' })).toEqual({ level: 'default' })
    expect(handleThinkingLevelChanged({})).toEqual({ level: 'default' })
    expect(handleThinkingLevelChanged({ level: 42 })).toEqual({ level: 'default' })
  })
})

// ---------------------------------------------------------------------------
// handleBudgetWarning
// ---------------------------------------------------------------------------
describe('handleBudgetWarning', () => {
  it('extracts warning message and builds system ChatMessage', () => {
    const result = handleBudgetWarning({ message: 'At 80% of budget' })
    expect(result.warningMessage).toBe('At 80% of budget')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.content).toBe('At 80% of budget')
    expect(result.systemMessage.id).toMatch(/^system-/)
    expect(result.systemMessage.timestamp).toBeGreaterThan(0)
  })

  it('uses default message when not provided', () => {
    const result = handleBudgetWarning({})
    expect(result.warningMessage).toBe('Approaching cost budget limit')
    expect(result.systemMessage.content).toBe('Approaching cost budget limit')
  })
})

// ---------------------------------------------------------------------------
// handleBudgetExceeded
// ---------------------------------------------------------------------------
describe('handleBudgetExceeded', () => {
  it('extracts exceeded message and builds system ChatMessage', () => {
    const result = handleBudgetExceeded({ message: 'Exceeded $5 limit' })
    expect(result.exceededMessage).toBe('Exceeded $5 limit')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.content).toBe('Exceeded $5 limit — session paused')
    expect(result.systemMessage.id).toMatch(/^system-/)
  })

  it('uses default message when not provided', () => {
    const result = handleBudgetExceeded({})
    expect(result.exceededMessage).toBe('Cost budget exceeded')
    expect(result.systemMessage.content).toBe('Cost budget exceeded — session paused')
  })
})

// ---------------------------------------------------------------------------
// handleBudgetResumed
// ---------------------------------------------------------------------------
describe('handleBudgetResumed', () => {
  it('builds system ChatMessage with resume text', () => {
    const result = handleBudgetResumed()
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.content).toBe('Cost budget override — session resumed')
    expect(result.systemMessage.id).toMatch(/^system-/)
  })
})

// ---------------------------------------------------------------------------
// handlePlanStarted
// ---------------------------------------------------------------------------
describe('handlePlanStarted', () => {
  it('uses explicit sessionId from message', () => {
    const result = handlePlanStarted({ sessionId: 'sess-1' }, 'active-1')
    expect(result).toEqual({
      sessionId: 'sess-1',
      patch: { isPlanPending: false, planAllowedPrompts: [] },
    })
  })

  it('falls back to active session when message has no sessionId', () => {
    const result = handlePlanStarted({}, 'active-1')
    expect(result).toEqual({
      sessionId: 'active-1',
      patch: { isPlanPending: false, planAllowedPrompts: [] },
    })
  })

  it('returns null sessionId when neither is available', () => {
    const result = handlePlanStarted({}, null)
    expect(result.sessionId).toBeNull()
    expect(result.patch).toEqual({ isPlanPending: false, planAllowedPrompts: [] })
  })
})

// ---------------------------------------------------------------------------
// handlePlanReady
// ---------------------------------------------------------------------------
describe('handlePlanReady', () => {
  it('uses explicit sessionId and forwards allowedPrompts verbatim', () => {
    const prompts = [{ tool: 'Bash', prompt: 'rm -rf node_modules' }]
    const result = handlePlanReady(
      { sessionId: 'sess-1', allowedPrompts: prompts },
      'active-1',
    )
    expect(result).toEqual({
      sessionId: 'sess-1',
      patch: { isPlanPending: true, planAllowedPrompts: prompts },
    })
  })

  it('falls back to active session when message has no sessionId', () => {
    const result = handlePlanReady({ allowedPrompts: [] }, 'active-1')
    expect(result.sessionId).toBe('active-1')
    expect(result.patch).toEqual({ isPlanPending: true, planAllowedPrompts: [] })
  })

  it('treats missing allowedPrompts as empty array', () => {
    const result = handlePlanReady({ sessionId: 'sess-1' }, null)
    expect(result.patch.planAllowedPrompts).toEqual([])
  })

  it('treats non-array allowedPrompts as empty array (matches prior inline guard)', () => {
    const result = handlePlanReady(
      { sessionId: 'sess-1', allowedPrompts: 'not an array' },
      null,
    )
    expect(result.patch.planAllowedPrompts).toEqual([])
  })

  it('flips isPlanPending true (vs handlePlanStarted which flips false)', () => {
    // Sanity check that the started/ready pair use opposite values for the
    // same field — easy to copy-paste-typo, worth pinning explicitly.
    const ready = handlePlanReady({}, 'active-1')
    const started = handlePlanStarted({}, 'active-1')
    expect(ready.patch.isPlanPending).toBe(true)
    expect(started.patch.isPlanPending).toBe(false)
  })

  it('returns null sessionId when neither is available', () => {
    const result = handlePlanReady({}, null)
    expect(result.sessionId).toBeNull()
  })
})
