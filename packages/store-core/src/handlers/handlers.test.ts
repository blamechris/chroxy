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
  handleDevPreview,
  handleDevPreviewStopped,
  handleAuthOk,
  handleAuthFail,
  handleKeyExchangeOk,
  handleServerMode,
} from './index'
import type { DevPreview, SessionInfo } from '../types'

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

// ---------------------------------------------------------------------------
// handleDevPreview
// ---------------------------------------------------------------------------
describe('handleDevPreview', () => {
  it('appends a new preview when no port collision exists', () => {
    const existing: DevPreview[] = [{ port: 3000, url: 'http://localhost:3000' }]
    const builder = handleDevPreview(
      { sessionId: 'sess-1', port: 8080, url: 'http://localhost:8080' },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-1')
    expect(builder.applyTo(existing)).toEqual({
      devPreviews: [
        { port: 3000, url: 'http://localhost:3000' },
        { port: 8080, url: 'http://localhost:8080' },
      ],
    })
  })

  it('replaces an existing preview entry with the same port (dedup)', () => {
    const existing: DevPreview[] = [
      { port: 3000, url: 'http://localhost:3000' },
      { port: 8080, url: 'http://old-url:8080' },
    ]
    const builder = handleDevPreview(
      { sessionId: 'sess-1', port: 8080, url: 'http://new-url:8080' },
      'active-1',
    )
    expect(builder.applyTo(existing)).toEqual({
      devPreviews: [
        { port: 3000, url: 'http://localhost:3000' },
        { port: 8080, url: 'http://new-url:8080' },
      ],
    })
  })

  it('falls back to active session when message has no sessionId', () => {
    const builder = handleDevPreview(
      { port: 4000, url: 'http://localhost:4000' },
      'active-1',
    )
    expect(builder.sessionId).toBe('active-1')
    expect(builder.applyTo([])).toEqual({
      devPreviews: [{ port: 4000, url: 'http://localhost:4000' }],
    })
  })

  it('returns null sessionId when neither is available', () => {
    const builder = handleDevPreview({ port: 4000, url: 'http://localhost:4000' }, null)
    expect(builder.sessionId).toBeNull()
  })

  it('forwards port/url verbatim — no validation tightening', () => {
    // Matches prior inline behaviour: `msg.port as number, msg.url as string`.
    // The original cast did no runtime validation, and tightening here would
    // be a behaviour change (out of scope for the #2661 mechanical migration).
    const builder = handleDevPreview(
      { sessionId: 'sess-1', port: 'not-a-number', url: 42 },
      null,
    )
    expect(builder.applyTo([])).toEqual({
      devPreviews: [{ port: 'not-a-number', url: 42 } as unknown as DevPreview],
    })
  })

  it('appends to the filtered tail (ordering invariant)', () => {
    // The new entry is always last after filter; existing non-colliding
    // entries keep their relative order. Pinning this so refactors that
    // switch to a Map cannot silently change observable ordering.
    const existing: DevPreview[] = [
      { port: 3000, url: 'http://localhost:3000' },
      { port: 4000, url: 'http://localhost:4000' },
    ]
    const builder = handleDevPreview(
      { port: 5000, url: 'http://localhost:5000' },
      'active-1',
    )
    const out = builder.applyTo(existing)
    expect(out.devPreviews.map((p) => p.port)).toEqual([3000, 4000, 5000])
  })
})

// ---------------------------------------------------------------------------
// handleDevPreviewStopped
// ---------------------------------------------------------------------------
describe('handleDevPreviewStopped', () => {
  it('removes the matching port from previews', () => {
    const existing: DevPreview[] = [
      { port: 3000, url: 'http://localhost:3000' },
      { port: 8080, url: 'http://localhost:8080' },
    ]
    const builder = handleDevPreviewStopped({ sessionId: 'sess-1', port: 8080 }, 'active-1')
    expect(builder.sessionId).toBe('sess-1')
    expect(builder.applyTo(existing)).toEqual({
      devPreviews: [{ port: 3000, url: 'http://localhost:3000' }],
    })
  })

  it('leaves previews unchanged when no port matches', () => {
    const existing: DevPreview[] = [{ port: 3000, url: 'http://localhost:3000' }]
    const builder = handleDevPreviewStopped({ sessionId: 'sess-1', port: 9999 }, 'active-1')
    expect(builder.applyTo(existing)).toEqual({
      devPreviews: [{ port: 3000, url: 'http://localhost:3000' }],
    })
  })

  it('falls back to active session when message has no sessionId', () => {
    const existing: DevPreview[] = [{ port: 4000, url: 'http://localhost:4000' }]
    const builder = handleDevPreviewStopped({ port: 4000 }, 'active-1')
    expect(builder.sessionId).toBe('active-1')
    expect(builder.applyTo(existing)).toEqual({ devPreviews: [] })
  })

  it('returns null sessionId when neither is available', () => {
    const builder = handleDevPreviewStopped({ port: 4000 }, null)
    expect(builder.sessionId).toBeNull()
    expect(builder.applyTo([])).toEqual({ devPreviews: [] })
  })

  it('returns empty list when current previews is empty', () => {
    const builder = handleDevPreviewStopped({ sessionId: 'sess-1', port: 4000 }, null)
    expect(builder.applyTo([])).toEqual({ devPreviews: [] })
  })
})

// ---------------------------------------------------------------------------
// handleAuthOk
// ---------------------------------------------------------------------------
describe('handleAuthOk', () => {
  it('extracts all fields when valid', () => {
    const result = handleAuthOk({
      serverMode: 'cli',
      cwd: '/home/me',
      defaultCwd: '/home',
      serverVersion: '0.6.12',
      latestVersion: '0.6.13',
      serverCommit: 'abc123',
      protocolVersion: 2,
    })
    expect(result).toEqual({
      serverMode: 'cli',
      sessionCwd: '/home/me',
      defaultCwd: '/home',
      serverVersion: '0.6.12',
      latestVersion: '0.6.13',
      serverCommit: 'abc123',
      protocolVersion: 2,
    })
  })

  it('accepts terminal as serverMode', () => {
    expect(handleAuthOk({ serverMode: 'terminal' }).serverMode).toBe('terminal')
  })

  it('rejects unknown serverMode values', () => {
    expect(handleAuthOk({ serverMode: 'bogus' }).serverMode).toBeNull()
    expect(handleAuthOk({ serverMode: 42 }).serverMode).toBeNull()
    expect(handleAuthOk({}).serverMode).toBeNull()
  })

  it('returns null for non-string string fields', () => {
    const result = handleAuthOk({
      cwd: 42,
      defaultCwd: null,
      serverVersion: false,
      latestVersion: {},
      serverCommit: [],
    })
    expect(result.sessionCwd).toBeNull()
    expect(result.defaultCwd).toBeNull()
    expect(result.serverVersion).toBeNull()
    expect(result.latestVersion).toBeNull()
    expect(result.serverCommit).toBeNull()
  })

  it('preserves empty cwd strings (raw extract — not trimmed)', () => {
    // Inline implementations used `typeof msg.cwd === 'string' ? msg.cwd : null`
    // — empty string is preserved as-is, NOT coerced to null.
    expect(handleAuthOk({ cwd: '' }).sessionCwd).toBe('')
  })

  it('rejects non-integer protocolVersion', () => {
    expect(handleAuthOk({ protocolVersion: 1.5 }).protocolVersion).toBeNull()
    expect(handleAuthOk({ protocolVersion: 0 }).protocolVersion).toBeNull()
    expect(handleAuthOk({ protocolVersion: -1 }).protocolVersion).toBeNull()
    expect(handleAuthOk({ protocolVersion: NaN }).protocolVersion).toBeNull()
    expect(handleAuthOk({ protocolVersion: Infinity }).protocolVersion).toBeNull()
    expect(handleAuthOk({ protocolVersion: '2' }).protocolVersion).toBeNull()
    expect(handleAuthOk({}).protocolVersion).toBeNull()
  })

  it('accepts protocolVersion >= 1', () => {
    expect(handleAuthOk({ protocolVersion: 1 }).protocolVersion).toBe(1)
    expect(handleAuthOk({ protocolVersion: 5 }).protocolVersion).toBe(5)
  })

  it('returns all-null payload for an empty message', () => {
    expect(handleAuthOk({})).toEqual({
      serverMode: null,
      sessionCwd: null,
      defaultCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      protocolVersion: null,
    })
  })
})

// ---------------------------------------------------------------------------
// handleAuthFail
// ---------------------------------------------------------------------------
describe('handleAuthFail', () => {
  it('extracts reason string', () => {
    expect(handleAuthFail({ reason: 'expired token' })).toEqual({ reason: 'expired token' })
  })

  it('falls back to "Invalid token" when reason missing', () => {
    expect(handleAuthFail({})).toEqual({ reason: 'Invalid token' })
  })

  it('falls back to "Invalid token" when reason is non-string', () => {
    // Inline impls used `(msg.reason as string) || 'Invalid token'` — any falsy
    // value (incl. empty string) falls back. Non-string values (numbers etc)
    // are passed through as-is in the original cast, but our typed handler
    // should treat them as missing.
    expect(handleAuthFail({ reason: '' })).toEqual({ reason: 'Invalid token' })
    expect(handleAuthFail({ reason: 42 })).toEqual({ reason: 'Invalid token' })
    expect(handleAuthFail({ reason: null })).toEqual({ reason: 'Invalid token' })
  })
})

// ---------------------------------------------------------------------------
// handleKeyExchangeOk
// ---------------------------------------------------------------------------
describe('handleKeyExchangeOk', () => {
  it('extracts publicKey string', () => {
    expect(handleKeyExchangeOk({ publicKey: 'base64key==' })).toEqual({
      publicKey: 'base64key==',
    })
  })

  it('returns null publicKey when missing', () => {
    expect(handleKeyExchangeOk({})).toEqual({ publicKey: null })
  })

  it('returns null publicKey for non-string values', () => {
    // Matches inline guard: `if (!msg.publicKey || typeof msg.publicKey !== 'string')`
    expect(handleKeyExchangeOk({ publicKey: 42 })).toEqual({ publicKey: null })
    expect(handleKeyExchangeOk({ publicKey: null })).toEqual({ publicKey: null })
    expect(handleKeyExchangeOk({ publicKey: '' })).toEqual({ publicKey: null })
  })
})

// ---------------------------------------------------------------------------
// handleServerMode
// ---------------------------------------------------------------------------
describe('handleServerMode', () => {
  it('extracts cli mode', () => {
    expect(handleServerMode({ mode: 'cli' })).toEqual({ mode: 'cli' })
  })

  it('extracts terminal mode', () => {
    expect(handleServerMode({ mode: 'terminal' })).toEqual({ mode: 'terminal' })
  })

  it('returns null for unknown mode (caller surfaces an alert)', () => {
    expect(handleServerMode({ mode: 'bogus' })).toEqual({ mode: null })
    expect(handleServerMode({ mode: 42 })).toEqual({ mode: null })
    expect(handleServerMode({})).toEqual({ mode: null })
  })
})
