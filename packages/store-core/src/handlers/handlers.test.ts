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
  handleCheckpointCreated,
  handleCheckpointList,
  handleCheckpointRestored,
  handleError,
  handleSessionError,
  handleLogEntry,
  handleClientJoined,
  handleClientLeft,
  handlePrimaryChanged,
  handleClientFocusChanged,
  handleConversationId,
  handleConversationsList,
  handleHistoryReplayStart,
  handleHistoryReplayEnd,
  handlePermissionRequest,
  handlePermissionResolved,
  handlePermissionExpired,
  handlePermissionTimeout,
  handlePermissionRulesUpdated,
  handleSessionList,
  handleSessionContext,
  handleSessionTimeout,
  handleSessionRestoreFailed,
  handleSessionWarning,
  handleSessionSwitched,
  handleDirectoryListing,
  handleFileListing,
  handleFileContent,
  handleWriteFileResult,
  handleSlashCommands,
  handleAgentList,
  handleProviderList,
  handleFileList,
  handleDiffResult,
  handleGitStatusResult,
  handleGitBranchesResult,
  handleGitStageResult,
  handleGitCommitResult,
  handleAgentSpawned,
  handleAgentCompleted,
  handleEnvironmentList,
  handleEnvironmentError,
  handleAvailableModels,
  handleMcpServers,
  handleCostUpdate,
} from './index'
import type {
  AgentInfo,
  Checkpoint,
  ConnectedClient,
  ConversationSummary,
  DevPreview,
  ModelInfo,
  SessionInfo,
} from '../types'

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
// handleCheckpointCreated
// ---------------------------------------------------------------------------
describe('handleCheckpointCreated', () => {
  const existing: Checkpoint[] = [
    {
      id: 'cp-1',
      name: 'first',
      description: '',
      messageCount: 3,
      createdAt: 1000,
      hasGitSnapshot: false,
    },
  ]
  const incoming: Checkpoint = {
    id: 'cp-2',
    name: 'second',
    description: 'after edits',
    messageCount: 7,
    createdAt: 2000,
    hasGitSnapshot: true,
  }

  it('appends a checkpoint when message targets the active session', () => {
    const out = handleCheckpointCreated(
      { sessionId: 'sess-1', checkpoint: incoming },
      existing,
      'sess-1',
    )
    expect(out).toEqual([...existing, incoming])
  })

  it('falls back to active session when message has no sessionId', () => {
    const out = handleCheckpointCreated(
      { checkpoint: incoming },
      existing,
      'sess-1',
    )
    expect(out).toEqual([...existing, incoming])
  })

  it('returns null when sessionId differs from active session', () => {
    const out = handleCheckpointCreated(
      { sessionId: 'other', checkpoint: incoming },
      existing,
      'sess-1',
    )
    expect(out).toBeNull()
  })

  it('returns null when checkpoint payload is missing', () => {
    expect(
      handleCheckpointCreated({ sessionId: 'sess-1' }, existing, 'sess-1'),
    ).toBeNull()
  })

  it('returns null when checkpoint payload is not an object', () => {
    expect(
      handleCheckpointCreated(
        { sessionId: 'sess-1', checkpoint: 'not-an-object' },
        existing,
        'sess-1',
      ),
    ).toBeNull()
  })

  it('returns null when checkpoint payload is null', () => {
    expect(
      handleCheckpointCreated(
        { sessionId: 'sess-1', checkpoint: null },
        existing,
        'sess-1',
      ),
    ).toBeNull()
  })

  it('returns null when active session is null (no fallback target)', () => {
    expect(
      handleCheckpointCreated({ checkpoint: incoming }, existing, null),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleError
// ---------------------------------------------------------------------------
describe('handleError', () => {
  it('extracts code + message and builds a system ChatMessage', () => {
    const result = handleError({ code: 'BAD_THING', message: 'Something broke' })
    expect(result.code).toBe('BAD_THING')
    expect(result.message).toBe('Something broke')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.content).toBe('Something broke')
    expect(result.systemMessage.id).toMatch(/^system-/)
    expect(result.systemMessage.timestamp).toBeGreaterThan(0)
  })

  it('strips ANSI escape sequences from message', () => {
    const result = handleError({ message: '[31mred error[0m' })
    expect(result.message).toBe('red error')
    expect(result.systemMessage.content).toBe('red error')
  })

  it('falls back to default message when missing or non-string', () => {
    const r1 = handleError({})
    expect(r1.message).toBe('An unexpected server error occurred')
    expect(r1.systemMessage.content).toBe('An unexpected server error occurred')

    const r2 = handleError({ message: 42 })
    expect(r2.message).toBe('An unexpected server error occurred')
  })

  it('falls back to default message when stripped value is empty/whitespace', () => {
    // The app inline implementation explicitly trims and falls back when the
    // result is empty — preserve that behaviour here.
    const result = handleError({ message: '   ' })
    expect(result.message).toBe('An unexpected server error occurred')
  })

  it('defaults code to "UNKNOWN" when missing or non-string', () => {
    expect(handleError({}).code).toBe('UNKNOWN')
    expect(handleError({ code: 42 }).code).toBe('UNKNOWN')
  })

  it('extracts requestId when string, otherwise null', () => {
    expect(handleError({ requestId: 'req-1' }).requestId).toBe('req-1')
    expect(handleError({}).requestId).toBeNull()
    expect(handleError({ requestId: 42 }).requestId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleSessionError
// ---------------------------------------------------------------------------
describe('handleSessionError', () => {
  it('returns crash patch when category is "crash" and resolves session', () => {
    const result = handleSessionError({ sessionId: 'sess-1', category: 'crash' }, 'active-1')
    expect(result.category).toBe('crash')
    expect(result.sessionPatch).toEqual({
      sessionId: 'sess-1',
      patch: { health: 'crashed' },
    })
    expect(result.message).toBeNull()
    expect(result.systemMessage).toBeNull()
  })

  it('falls back to active session for crash without explicit sessionId', () => {
    const result = handleSessionError({ category: 'crash' }, 'active-1')
    expect(result.sessionPatch).toEqual({
      sessionId: 'active-1',
      patch: { health: 'crashed' },
    })
  })

  it('builds bound-session-mismatch message when SESSION_TOKEN_MISMATCH + boundSessionName', () => {
    const result = handleSessionError(
      {
        category: 'auth',
        code: 'SESSION_TOKEN_MISMATCH',
        boundSessionName: 'My Session',
        message: 'Not authorized',
      },
      null,
    )
    expect(result.category).toBe('auth')
    expect(result.code).toBe('SESSION_TOKEN_MISMATCH')
    expect(result.boundSessionName).toBe('My Session')
    expect(result.message).toContain('"My Session"')
    expect(result.message).toContain('Disconnect')
    expect(result.systemMessage).not.toBeNull()
    expect(result.systemMessage!.type).toBe('system')
    expect(result.sessionPatch).toBeNull()
  })

  it('uses raw msg.message for non-crash, non-bound errors', () => {
    const result = handleSessionError(
      { category: 'rate_limit', message: 'Slow down' },
      null,
    )
    expect(result.message).toBe('Slow down')
    expect(result.systemMessage!.content).toBe('Slow down')
    expect(result.sessionPatch).toBeNull()
  })

  it('falls back to "Unknown error" when non-crash has no message', () => {
    const result = handleSessionError({ category: 'rate_limit' }, null)
    expect(result.message).toBe('Unknown error')
    expect(result.systemMessage!.content).toBe('Unknown error')
  })

  it('falls back to "Unknown error" when message is an empty string', () => {
    const result = handleSessionError(
      { category: 'rate_limit', message: '' },
      null,
    )
    expect(result.message).toBe('Unknown error')
    expect(result.systemMessage!.content).toBe('Unknown error')
  })

  it('falls back to "Unknown error" when message is whitespace only', () => {
    const result = handleSessionError(
      { category: 'rate_limit', message: '   \t\n  ' },
      null,
    )
    expect(result.message).toBe('Unknown error')
    expect(result.systemMessage!.content).toBe('Unknown error')
  })

  it('treats SESSION_TOKEN_MISMATCH without boundSessionName as a generic error', () => {
    // boundSessionName is required for the rewrite — without it, fall through
    // to the generic msg.message path.
    const result = handleSessionError(
      { code: 'SESSION_TOKEN_MISMATCH', message: 'Not authorized' },
      null,
    )
    expect(result.message).toBe('Not authorized')
    expect(result.boundSessionName).toBeNull()
  })

  it('treats empty boundSessionName as missing (matches inline guard)', () => {
    const result = handleSessionError(
      {
        code: 'SESSION_TOKEN_MISMATCH',
        boundSessionName: '',
        message: 'Not authorized',
      },
      null,
    )
    expect(result.message).toBe('Not authorized')
    expect(result.boundSessionName).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleClientJoined
// ---------------------------------------------------------------------------
describe('handleClientJoined', () => {
  const existingClient: ConnectedClient = {
    clientId: 'client-1',
    deviceName: 'iPhone',
    deviceType: 'phone',
    platform: 'ios',
    isSelf: false,
  }

  it('appends a new client to the roster', () => {
    const result = handleClientJoined(
      {
        client: {
          clientId: 'client-2',
          deviceName: 'MacBook',
          deviceType: 'desktop',
          platform: 'darwin',
        },
      },
      [existingClient],
    )
    expect(result).not.toBeNull()
    expect(result!.client).toEqual({
      clientId: 'client-2',
      deviceName: 'MacBook',
      deviceType: 'desktop',
      platform: 'darwin',
      isSelf: false,
    })
    expect(result!.roster).toHaveLength(2)
    expect(result!.roster[0]).toEqual(existingClient)
    expect(result!.roster[1]).toEqual(result!.client)
  })

  it('upserts when client with same id is already present', () => {
    const result = handleClientJoined(
      {
        client: {
          clientId: 'client-1',
          deviceName: 'iPhone (renamed)',
          deviceType: 'phone',
          platform: 'ios',
        },
      },
      [existingClient],
    )
    expect(result).not.toBeNull()
    expect(result!.roster).toHaveLength(1)
    expect(result!.roster[0].deviceName).toBe('iPhone (renamed)')
  })

  it('defaults missing deviceName to null', () => {
    const result = handleClientJoined(
      { client: { clientId: 'client-2' } },
      [],
    )
    expect(result!.client.deviceName).toBeNull()
  })

  it('defaults invalid deviceType to "unknown"', () => {
    const result = handleClientJoined(
      { client: { clientId: 'client-2', deviceType: 'laptop' } },
      [],
    )
    expect(result!.client.deviceType).toBe('unknown')
  })

  it('accepts all valid deviceType values', () => {
    for (const dt of ['phone', 'tablet', 'desktop', 'unknown'] as const) {
      const result = handleClientJoined(
        { client: { clientId: 'c', deviceType: dt } },
        [],
      )
      expect(result!.client.deviceType).toBe(dt)
    }
  })

  it('defaults missing platform to "unknown"', () => {
    const result = handleClientJoined(
      { client: { clientId: 'client-2' } },
      [],
    )
    expect(result!.client.platform).toBe('unknown')
  })

  it('returns null when client is missing', () => {
    expect(handleClientJoined({}, [])).toBeNull()
  })

  it('returns null when client.clientId is missing', () => {
    expect(handleClientJoined({ client: {} }, [])).toBeNull()
  })

  it('returns null when client.clientId is non-string', () => {
    expect(handleClientJoined({ client: { clientId: 42 } }, [])).toBeNull()
  })

  it('always sets isSelf=false (new joiners are never us)', () => {
    const result = handleClientJoined(
      { client: { clientId: 'client-2', isSelf: true } },
      [],
    )
    expect(result!.client.isSelf).toBe(false)
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
// handleCheckpointList
// ---------------------------------------------------------------------------
describe('handleCheckpointList', () => {
  const incoming: Checkpoint[] = [
    {
      id: 'cp-1',
      name: 'first',
      description: '',
      messageCount: 3,
      createdAt: 1000,
      hasGitSnapshot: false,
    },
    {
      id: 'cp-2',
      name: 'second',
      description: 'desc',
      messageCount: 5,
      createdAt: 2000,
      hasGitSnapshot: true,
    },
  ]

  it('returns the checkpoints array when message targets active session', () => {
    const out = handleCheckpointList(
      { sessionId: 'sess-1', checkpoints: incoming },
      'sess-1',
    )
    expect(out).toEqual(incoming)
  })

  it('falls back to active session when message has no sessionId', () => {
    const out = handleCheckpointList({ checkpoints: incoming }, 'sess-1')
    expect(out).toEqual(incoming)
  })

  it('returns null when sessionId differs from active session', () => {
    const out = handleCheckpointList(
      { sessionId: 'other', checkpoints: incoming },
      'sess-1',
    )
    expect(out).toBeNull()
  })

  it('returns null when checkpoints field is missing', () => {
    expect(handleCheckpointList({ sessionId: 'sess-1' }, 'sess-1')).toBeNull()
  })

  it('returns null when checkpoints field is not an array', () => {
    expect(
      handleCheckpointList(
        { sessionId: 'sess-1', checkpoints: 'not-array' },
        'sess-1',
      ),
    ).toBeNull()
  })

  it('returns empty array when checkpoints is an empty array', () => {
    expect(
      handleCheckpointList({ sessionId: 'sess-1', checkpoints: [] }, 'sess-1'),
    ).toEqual([])
  })

  it('returns null when active session is null', () => {
    expect(handleCheckpointList({ checkpoints: incoming }, null)).toBeNull()
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

// ---------------------------------------------------------------------------
// handleCheckpointRestored
// ---------------------------------------------------------------------------
describe('handleCheckpointRestored', () => {
  it('extracts trimmed newSessionId', () => {
    expect(handleCheckpointRestored({ newSessionId: 'sess-new' })).toEqual({
      newSessionId: 'sess-new',
    })
  })

  it('trims whitespace from newSessionId', () => {
    expect(
      handleCheckpointRestored({ newSessionId: '  sess-trim  ' }),
    ).toEqual({ newSessionId: 'sess-trim' })
  })

  it('returns null when newSessionId is missing', () => {
    expect(handleCheckpointRestored({})).toBeNull()
  })

  it('returns null when newSessionId is not a string', () => {
    expect(handleCheckpointRestored({ newSessionId: 42 })).toBeNull()
  })

  it('returns null when newSessionId is empty string', () => {
    expect(handleCheckpointRestored({ newSessionId: '' })).toBeNull()
  })

  it('returns null when newSessionId is whitespace only', () => {
    expect(handleCheckpointRestored({ newSessionId: '   ' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleLogEntry
// ---------------------------------------------------------------------------
describe('handleLogEntry', () => {
  it('parses all fields and strips ANSI from message', () => {
    const result = handleLogEntry({
      component: 'ws',
      level: 'info',
      message: '[33mhello[0m world',
      timestamp: 12345,
      sessionId: 'sess-1',
    })
    expect(result.entry.component).toBe('ws')
    expect(result.entry.level).toBe('info')
    expect(result.entry.message).toBe('hello world')
    expect(result.entry.timestamp).toBe(12345)
    expect(result.entry.sessionId).toBe('sess-1')
    expect(result.entry.id).toMatch(/^log-/)
  })

  it('defaults missing component to "unknown"', () => {
    const result = handleLogEntry({ level: 'info', message: 'x' })
    expect(result.entry.component).toBe('unknown')
  })

  it('defaults invalid level to "info"', () => {
    expect(handleLogEntry({ level: 'bogus' }).entry.level).toBe('info')
    expect(handleLogEntry({}).entry.level).toBe('info')
    expect(handleLogEntry({ level: 42 }).entry.level).toBe('info')
  })

  it('accepts each valid level', () => {
    expect(handleLogEntry({ level: 'debug' }).entry.level).toBe('debug')
    expect(handleLogEntry({ level: 'info' }).entry.level).toBe('info')
    expect(handleLogEntry({ level: 'warn' }).entry.level).toBe('warn')
    expect(handleLogEntry({ level: 'error' }).entry.level).toBe('error')
  })

  it('defaults missing message to empty string', () => {
    const result = handleLogEntry({ component: 'ws' })
    expect(result.entry.message).toBe('')
  })

  it('defaults non-number timestamp to a recent value', () => {
    const before = Date.now()
    const result = handleLogEntry({})
    const after = Date.now()
    expect(result.entry.timestamp).toBeGreaterThanOrEqual(before)
    expect(result.entry.timestamp).toBeLessThanOrEqual(after)
  })

  it('omits sessionId when not a string', () => {
    const result = handleLogEntry({ component: 'ws', sessionId: 42 })
    expect(result.entry.sessionId).toBeUndefined()
    expect('sessionId' in result.entry).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleClientLeft
// ---------------------------------------------------------------------------
describe('handleClientLeft', () => {
  const roster: ConnectedClient[] = [
    {
      clientId: 'client-1',
      deviceName: 'iPhone',
      deviceType: 'phone',
      platform: 'ios',
      isSelf: false,
    },
    {
      clientId: 'client-2',
      deviceName: 'MacBook',
      deviceType: 'desktop',
      platform: 'darwin',
      isSelf: false,
    },
  ]

  it('removes the matching client and reports the departing entry', () => {
    const result = handleClientLeft({ clientId: 'client-1' }, roster)
    expect(result).not.toBeNull()
    expect(result!.clientId).toBe('client-1')
    expect(result!.departingClient).toEqual(roster[0])
    expect(result!.roster).toHaveLength(1)
    expect(result!.roster[0].clientId).toBe('client-2')
  })

  it('returns roster unchanged when clientId does not match', () => {
    const result = handleClientLeft({ clientId: 'nonexistent' }, roster)
    expect(result).not.toBeNull()
    expect(result!.departingClient).toBeUndefined()
    expect(result!.roster).toHaveLength(2)
  })

  it('returns null when clientId is missing', () => {
    expect(handleClientLeft({}, roster)).toBeNull()
  })

  it('returns null when clientId is non-string', () => {
    expect(handleClientLeft({ clientId: 42 }, roster)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handlePrimaryChanged
// ---------------------------------------------------------------------------
describe('handlePrimaryChanged', () => {
  it('extracts sessionId and clientId', () => {
    expect(
      handlePrimaryChanged({ sessionId: 'sess-1', clientId: 'client-1' }),
    ).toEqual({ sessionId: 'sess-1', primaryClientId: 'client-1' })
  })

  it('returns null primaryClientId when missing', () => {
    expect(handlePrimaryChanged({ sessionId: 'sess-1' })).toEqual({
      sessionId: 'sess-1',
      primaryClientId: null,
    })
  })

  it('returns null primaryClientId when non-string', () => {
    expect(
      handlePrimaryChanged({ sessionId: 'sess-1', clientId: 42 }),
    ).toEqual({ sessionId: 'sess-1', primaryClientId: null })
  })

  it('returns null sessionId when missing or non-string', () => {
    expect(handlePrimaryChanged({ clientId: 'c' })).toEqual({
      sessionId: null,
      primaryClientId: 'c',
    })
    expect(handlePrimaryChanged({ sessionId: 42, clientId: 'c' })).toEqual({
      sessionId: null,
      primaryClientId: 'c',
    })
  })

  it('preserves the literal "default" sessionId verbatim (caller decides routing)', () => {
    // Both clients special-case `sessionId === 'default'` to apply globally.
    // The shared handler does NOT do that branching — it just hands the value
    // back as-is and the call site decides.
    expect(
      handlePrimaryChanged({ sessionId: 'default', clientId: 'c' }),
    ).toEqual({ sessionId: 'default', primaryClientId: 'c' })
  })
})

// ---------------------------------------------------------------------------
// handleClientFocusChanged
// ---------------------------------------------------------------------------
describe('handleClientFocusChanged', () => {
  it('extracts both fields when valid', () => {
    expect(
      handleClientFocusChanged({ clientId: 'client-1', sessionId: 'sess-1' }),
    ).toEqual({ clientId: 'client-1', sessionId: 'sess-1' })
  })

  it('returns null when clientId is missing', () => {
    expect(handleClientFocusChanged({ sessionId: 'sess-1' })).toBeNull()
  })

  it('returns null when sessionId is missing', () => {
    expect(handleClientFocusChanged({ clientId: 'client-1' })).toBeNull()
  })

  it('returns null when clientId is non-string', () => {
    expect(
      handleClientFocusChanged({ clientId: 42, sessionId: 'sess-1' }),
    ).toBeNull()
  })

  it('returns null when sessionId is non-string', () => {
    expect(
      handleClientFocusChanged({ clientId: 'client-1', sessionId: 42 }),
    ).toBeNull()
  })

  it('returns null when both are missing', () => {
    expect(handleClientFocusChanged({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleConversationId
// ---------------------------------------------------------------------------
describe('handleConversationId', () => {
  it('extracts sessionId and conversationId verbatim', () => {
    expect(
      handleConversationId({ sessionId: 'sess-1', conversationId: 'conv-abc' }),
    ).toEqual({ sessionId: 'sess-1', conversationId: 'conv-abc' })
  })

  it('returns null conversationId when missing', () => {
    expect(handleConversationId({ sessionId: 'sess-1' })).toEqual({
      sessionId: 'sess-1',
      conversationId: null,
    })
  })

  it('returns null conversationId when non-string', () => {
    expect(
      handleConversationId({ sessionId: 'sess-1', conversationId: 42 }),
    ).toEqual({ sessionId: 'sess-1', conversationId: null })
  })

  it('returns null sessionId when missing (no active-session fallback)', () => {
    // Prior inline behaviour: `msg.sessionId as string` without a fallback —
    // call site gates on truthy sessionId before applying.
    expect(handleConversationId({ conversationId: 'conv-abc' })).toEqual({
      sessionId: null,
      conversationId: 'conv-abc',
    })
  })

  it('returns null sessionId when non-string', () => {
    expect(
      handleConversationId({ sessionId: 42, conversationId: 'conv-abc' }),
    ).toEqual({ sessionId: null, conversationId: 'conv-abc' })
  })

  it('returns both null when message is empty', () => {
    expect(handleConversationId({})).toEqual({
      sessionId: null,
      conversationId: null,
    })
  })
})

// ---------------------------------------------------------------------------
// handleSessionList
// ---------------------------------------------------------------------------
describe('handleSessionList', () => {
  const sessions: SessionInfo[] = [
    {
      sessionId: 'sess-1',
      name: 'One',
      cwd: '/tmp',
      type: 'cli',
      hasTerminal: true,
      model: null,
      permissionMode: null,
      isBusy: false,
      createdAt: 1000,
      conversationId: null,
    },
  ]

  it('returns the parsed sessions array verbatim', () => {
    expect(handleSessionList({ sessions })).toBe(sessions)
  })

  it('returns null when sessions is missing', () => {
    expect(handleSessionList({})).toBeNull()
  })

  it('returns null when sessions is not an array', () => {
    expect(handleSessionList({ sessions: 'nope' })).toBeNull()
    expect(handleSessionList({ sessions: { foo: 'bar' } })).toBeNull()
  })

  it('returns empty array verbatim (auto-resume gate stays at call site)', () => {
    const empty: SessionInfo[] = []
    expect(handleSessionList({ sessions: empty })).toBe(empty)
  })
})

// ---------------------------------------------------------------------------
// handleConversationsList
// ---------------------------------------------------------------------------
describe('handleConversationsList', () => {
  it('extracts conversations array verbatim', () => {
    const conversations: ConversationSummary[] = [
      {
        conversationId: 'conv-1',
        project: '/repo',
        projectName: 'repo',
        modifiedAt: '2026-04-27T00:00:00Z',
        modifiedAtMs: 1700000000000,
        sizeBytes: 1024,
        preview: 'hello',
        cwd: '/repo',
      },
    ]
    expect(handleConversationsList({ conversations })).toEqual({
      conversations,
    })
  })

  it('returns empty array when conversations is missing', () => {
    expect(handleConversationsList({})).toEqual({ conversations: [] })
  })

  it('returns empty array when conversations is non-array', () => {
    expect(handleConversationsList({ conversations: 'nope' })).toEqual({
      conversations: [],
    })
    expect(handleConversationsList({ conversations: null })).toEqual({
      conversations: [],
    })
  })

  it('forwards array elements verbatim without per-element validation', () => {
    // Behaviour-preserving: matches the prior inline `as ConversationSummary[]`
    // cast — the call site trusts whatever the server sent.
    const malformed = [{ wat: true }] as unknown as ConversationSummary[]
    expect(handleConversationsList({ conversations: malformed })).toEqual({
      conversations: malformed,
    })
  })
})

// ---------------------------------------------------------------------------
// handleHistoryReplayStart
// ---------------------------------------------------------------------------
describe('handleHistoryReplayStart', () => {
  it('returns receivingHistoryReplay=true with fullHistory=false by default', () => {
    expect(handleHistoryReplayStart({}, null)).toEqual({
      receivingHistoryReplay: true,
      fullHistory: false,
      sessionId: null,
    })
  })

  it('preserves fullHistory=true only when strictly === true', () => {
    expect(
      handleHistoryReplayStart({ fullHistory: true }, null).fullHistory,
    ).toBe(true)
    // Truthy-but-not-true values should NOT trigger the full-history branch
    // (matches the prior inline `msg.fullHistory === true` strict check).
    expect(
      handleHistoryReplayStart({ fullHistory: 1 }, null).fullHistory,
    ).toBe(false)
    expect(
      handleHistoryReplayStart({ fullHistory: 'true' }, null).fullHistory,
    ).toBe(false)
  })

  it('uses explicit sessionId from message', () => {
    const result = handleHistoryReplayStart(
      { fullHistory: true, sessionId: 'sess-1' },
      'active-1',
    )
    expect(result).toEqual({
      receivingHistoryReplay: true,
      fullHistory: true,
      sessionId: 'sess-1',
    })
  })

  it('falls back to activeSessionId when message has no sessionId', () => {
    const result = handleHistoryReplayStart({ fullHistory: true }, 'active-1')
    expect(result.sessionId).toBe('active-1')
  })

  it('returns null sessionId when neither is available', () => {
    expect(
      handleHistoryReplayStart({ fullHistory: true }, null).sessionId,
    ).toBeNull()
  })

  it('preserves whitespace in sessionId verbatim (matches prior inline logic)', () => {
    // Prior inline logic was `(msg.sessionId as string) || activeSessionId`,
    // which does NOT trim. Verify we keep parity — `'  sess-1  '` should be
    // returned unchanged so it's compared against `sessionStates[targetId]`
    // exactly as the call site previously did.
    expect(
      handleHistoryReplayStart(
        { fullHistory: true, sessionId: '  sess-1  ' },
        'active-1',
      ).sessionId,
    ).toBe('  sess-1  ')
  })

  it('falls back to activeSessionId when sessionId is empty string', () => {
    // `'' || 'active-1'` → `'active-1'` — matches the prior inline logic.
    expect(
      handleHistoryReplayStart(
        { fullHistory: true, sessionId: '' },
        'active-1',
      ).sessionId,
    ).toBe('active-1')
  })
})

// ---------------------------------------------------------------------------
// handleSessionContext
// ---------------------------------------------------------------------------
describe('handleSessionContext', () => {
  it('extracts all fields when valid', () => {
    const result = handleSessionContext(
      {
        sessionId: 'sess-1',
        gitBranch: 'main',
        gitDirty: 3,
        gitAhead: 1,
        projectName: 'chroxy',
      },
      null,
    )
    expect(result).toEqual({
      sessionId: 'sess-1',
      patch: {
        sessionContext: {
          gitBranch: 'main',
          gitDirty: 3,
          gitAhead: 1,
          projectName: 'chroxy',
        },
      },
    })
  })

  it('falls back to active session when sessionId is missing', () => {
    const result = handleSessionContext(
      { gitBranch: 'main', gitDirty: 0, gitAhead: 0, projectName: 'p' },
      'active-1',
    )
    expect(result.sessionId).toBe('active-1')
  })

  it('uses null/0 fallbacks for missing or non-string/non-number fields', () => {
    const result = handleSessionContext({ sessionId: 'sess-1' }, null)
    expect(result.patch).toEqual({
      sessionContext: {
        gitBranch: null,
        gitDirty: 0,
        gitAhead: 0,
        projectName: null,
      },
    })
  })

  it('coerces non-string gitBranch/projectName to null', () => {
    const result = handleSessionContext(
      { sessionId: 'sess-1', gitBranch: 42, projectName: { x: 1 } },
      null,
    )
    expect((result.patch.sessionContext as { gitBranch: unknown }).gitBranch).toBeNull()
    expect((result.patch.sessionContext as { projectName: unknown }).projectName).toBeNull()
  })

  it('coerces non-number gitDirty/gitAhead to 0', () => {
    const result = handleSessionContext(
      { sessionId: 'sess-1', gitDirty: 'a', gitAhead: null },
      null,
    )
    expect((result.patch.sessionContext as { gitDirty: number }).gitDirty).toBe(0)
    expect((result.patch.sessionContext as { gitAhead: number }).gitAhead).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// handlePermissionRequest
// ---------------------------------------------------------------------------
describe('handlePermissionRequest', () => {
  it('extracts requestId, tool, description, input, sessionId, remainingMs', () => {
    const result = handlePermissionRequest({
      requestId: 'req-1',
      tool: 'Bash',
      description: 'rm -rf /',
      input: { command: 'rm -rf /' },
      sessionId: 'sess-1',
      remainingMs: 30000,
    })
    expect(result).toEqual({
      requestId: 'req-1',
      tool: 'Bash',
      description: 'rm -rf /',
      input: { command: 'rm -rf /' },
      sessionId: 'sess-1',
      remainingMs: 30000,
    })
  })

  it('returns null requestId when missing', () => {
    const result = handlePermissionRequest({})
    expect(result.requestId).toBeNull()
  })

  it('returns null requestId when non-string', () => {
    const result = handlePermissionRequest({ requestId: 42 })
    expect(result.requestId).toBeNull()
  })

  it('returns null tool when missing or non-string', () => {
    expect(handlePermissionRequest({ requestId: 'r' }).tool).toBeNull()
    expect(handlePermissionRequest({ requestId: 'r', tool: 42 }).tool).toBeNull()
  })

  it('returns null description when missing or non-string', () => {
    expect(handlePermissionRequest({ requestId: 'r' }).description).toBeNull()
    expect(
      handlePermissionRequest({ requestId: 'r', description: 42 }).description,
    ).toBeNull()
  })

  it('returns null input when missing or not an object', () => {
    expect(handlePermissionRequest({ requestId: 'r' }).input).toBeNull()
    expect(
      handlePermissionRequest({ requestId: 'r', input: 'not an object' }).input,
    ).toBeNull()
    expect(handlePermissionRequest({ requestId: 'r', input: null }).input).toBeNull()
  })

  it('returns null sessionId when missing or non-string', () => {
    expect(handlePermissionRequest({ requestId: 'r' }).sessionId).toBeNull()
    expect(
      handlePermissionRequest({ requestId: 'r', sessionId: 42 }).sessionId,
    ).toBeNull()
  })

  it('returns null remainingMs when missing or non-number', () => {
    expect(handlePermissionRequest({ requestId: 'r' }).remainingMs).toBeNull()
    expect(
      handlePermissionRequest({ requestId: 'r', remainingMs: 'soon' }).remainingMs,
    ).toBeNull()
  })

  it('preserves remainingMs of 0 (numeric falsy)', () => {
    expect(
      handlePermissionRequest({ requestId: 'r', remainingMs: 0 }).remainingMs,
    ).toBe(0)
  })

  it('forwards array input verbatim (arrays pass the inline object guard)', () => {
    // Inline guard: `msg.input && typeof msg.input === 'object'` — arrays pass
    // this guard. Preserve that behaviour: forward arrays verbatim.
    const arr = [1, 2, 3]
    const result = handlePermissionRequest({ requestId: 'r', input: arr })
    expect(result.input).toBe(arr)
  })
})

// ---------------------------------------------------------------------------
// handleSessionTimeout
// ---------------------------------------------------------------------------
describe('handleSessionTimeout', () => {
  it('extracts sessionId and name when present', () => {
    const result = handleSessionTimeout({ sessionId: 'sess-1', name: 'Editor' })
    expect(result.sessionId).toBe('sess-1')
    expect(result.name).toBe('Editor')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.content).toBe('Session "Editor" was closed due to inactivity.')
    expect(result.systemMessage.id).toMatch(/^system-/)
  })

  it('uses "Unknown" name fallback when missing', () => {
    const result = handleSessionTimeout({ sessionId: 'sess-1' })
    expect(result.name).toBe('Unknown')
    expect(result.systemMessage.content).toBe('Session "Unknown" was closed due to inactivity.')
  })

  it('returns null sessionId when missing or non-string', () => {
    expect(handleSessionTimeout({}).sessionId).toBeNull()
    expect(handleSessionTimeout({ sessionId: 42 }).sessionId).toBeNull()
  })

  it('trims whitespace from sessionId and name', () => {
    const result = handleSessionTimeout({ sessionId: '  sess-1  ', name: '  Editor  ' })
    expect(result.sessionId).toBe('sess-1')
    expect(result.name).toBe('Editor')
  })

  it('returns null sessionId and "Unknown" name when whitespace-only', () => {
    const result = handleSessionTimeout({ sessionId: '   ', name: '   ' })
    expect(result.sessionId).toBeNull()
    expect(result.name).toBe('Unknown')
  })
})

// ---------------------------------------------------------------------------
// handleHistoryReplayEnd
// ---------------------------------------------------------------------------
describe('handleHistoryReplayEnd', () => {
  it('returns receivingHistoryReplay=false', () => {
    expect(handleHistoryReplayEnd()).toEqual({
      receivingHistoryReplay: false,
    })
  })
})

// ---------------------------------------------------------------------------
// handlePermissionResolved
// ---------------------------------------------------------------------------
describe('handlePermissionResolved', () => {
  it('extracts requestId and decision', () => {
    expect(
      handlePermissionResolved({ requestId: 'req-1', decision: 'allow' }),
    ).toEqual({ requestId: 'req-1', decision: 'allow' })
  })

  it('returns null requestId when missing or non-string', () => {
    expect(handlePermissionResolved({}).requestId).toBeNull()
    expect(handlePermissionResolved({ requestId: 42 }).requestId).toBeNull()
  })

  it('returns null decision when missing or non-string', () => {
    expect(handlePermissionResolved({ requestId: 'r' }).decision).toBeNull()
    expect(
      handlePermissionResolved({ requestId: 'r', decision: 42 }).decision,
    ).toBeNull()
  })

  it('forwards decision verbatim — does not validate enum', () => {
    // Inline impls used `msg.decision as string` with no validation; keep that.
    const result = handlePermissionResolved({
      requestId: 'r',
      decision: 'allowAlways',
    })
    expect(result.decision).toBe('allowAlways')
  })
})

// ---------------------------------------------------------------------------
// handlePermissionExpired
// ---------------------------------------------------------------------------
describe('handlePermissionExpired', () => {
  it('extracts requestId and builds a system ChatMessage', () => {
    const result = handlePermissionExpired({ requestId: 'req-1' })
    expect(result.requestId).toBe('req-1')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.id).toMatch(/^system-/)
    expect(result.systemMessage.timestamp).toBeGreaterThan(0)
    expect(result.systemMessage.content).toContain('Expired')
  })

  it('returns null requestId when missing or non-string', () => {
    expect(handlePermissionExpired({}).requestId).toBeNull()
    expect(handlePermissionExpired({ requestId: 42 }).requestId).toBeNull()
  })

  it('still returns a system message when requestId is null', () => {
    // The handler is purely a parser — call site decides whether to apply
    // anything based on requestId presence. Mirrors handleBudgetExceeded.
    const result = handlePermissionExpired({})
    expect(result.systemMessage).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// handlePermissionTimeout
// ---------------------------------------------------------------------------
describe('handlePermissionTimeout', () => {
  it('extracts requestId, tool, and builds a system ChatMessage', () => {
    const result = handlePermissionTimeout({
      requestId: 'req-1',
      tool: 'Bash',
    })
    expect(result.requestId).toBe('req-1')
    expect(result.tool).toBe('Bash')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.id).toMatch(/^system-/)
    expect(result.systemMessage.content).toContain('Bash')
    expect(result.systemMessage.content).toContain('auto-denied')
  })

  it('defaults tool to "permission" when missing or non-string', () => {
    expect(handlePermissionTimeout({ requestId: 'r' }).tool).toBe('permission')
    expect(
      handlePermissionTimeout({ requestId: 'r', tool: 42 }).tool,
    ).toBe('permission')
  })

  it('returns null requestId when missing or non-string', () => {
    expect(handlePermissionTimeout({}).requestId).toBeNull()
    expect(handlePermissionTimeout({ requestId: 42 }).requestId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handlePermissionRulesUpdated
// ---------------------------------------------------------------------------
describe('handlePermissionRulesUpdated', () => {
  it('extracts the rules array verbatim', () => {
    const rules = [
      { tool: 'Bash', decision: 'allow', pattern: 'ls *' },
      { tool: 'Edit', decision: 'deny' },
    ]
    const result = handlePermissionRulesUpdated({
      sessionId: 'sess-1',
      rules,
    })
    expect(result.sessionId).toBe('sess-1')
    expect(result.rules).toBe(rules)
  })

  it('returns empty array when rules is missing', () => {
    expect(handlePermissionRulesUpdated({}).rules).toEqual([])
  })

  it('returns empty array when rules is not an array', () => {
    expect(
      handlePermissionRulesUpdated({ rules: 'not-an-array' }).rules,
    ).toEqual([])
  })

  it('returns null sessionId when missing or non-string', () => {
    expect(handlePermissionRulesUpdated({}).sessionId).toBeNull()
    expect(
      handlePermissionRulesUpdated({ sessionId: 42 }).sessionId,
    ).toBeNull()
  })

  it('forwards rule elements verbatim — no per-element validation', () => {
    // Inline impls cast to PermissionRule[] without validating element shape.
    // Preserve that behaviour: malformed elements pass through unchecked.
    const rules = [{ junk: 'data' }, null, 42]
    const result = handlePermissionRulesUpdated({
      sessionId: 'sess-1',
      rules,
    })
    expect(result.rules).toBe(rules)
  })
})

// ---------------------------------------------------------------------------
// handleSessionRestoreFailed
// ---------------------------------------------------------------------------
describe('handleSessionRestoreFailed', () => {
  it('extracts all fields when present', () => {
    const result = handleSessionRestoreFailed({
      sessionId: 'sess-1',
      name: 'Editor',
      provider: 'claude',
      errorCode: 'NO_API_KEY',
      errorMessage: 'API key missing',
    })
    expect(result.sessionId).toBe('sess-1')
    expect(result.name).toBe('Editor')
    expect(result.provider).toBe('claude')
    expect(result.errorCode).toBe('NO_API_KEY')
    expect(result.errorMessage).toBe('API key missing')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.content).toBe('Failed to restore Editor: API key missing')
  })

  it('falls back to sessionId when name is missing', () => {
    const result = handleSessionRestoreFailed({
      sessionId: 'sess-1',
      errorMessage: 'boom',
    })
    expect(result.systemMessage.content).toBe('Failed to restore sess-1: boom')
  })

  it('falls back to "session" when name and sessionId are missing', () => {
    const result = handleSessionRestoreFailed({ errorMessage: 'boom' })
    expect(result.systemMessage.content).toBe('Failed to restore session: boom')
  })

  it('falls back to errorCode when errorMessage is missing', () => {
    const result = handleSessionRestoreFailed({
      sessionId: 'sess-1',
      errorCode: 'NO_API_KEY',
    })
    expect(result.systemMessage.content).toBe('Failed to restore sess-1: NO_API_KEY')
  })

  it('falls back to "unknown error" when both error fields are missing', () => {
    const result = handleSessionRestoreFailed({ sessionId: 'sess-1' })
    expect(result.systemMessage.content).toBe('Failed to restore sess-1: unknown error')
  })

  it('coerces non-string fields to null', () => {
    const result = handleSessionRestoreFailed({
      sessionId: 42,
      name: false,
      provider: { x: 1 },
      errorCode: null,
      errorMessage: 99,
    })
    expect(result.sessionId).toBeNull()
    expect(result.name).toBeNull()
    expect(result.provider).toBeNull()
    expect(result.errorCode).toBeNull()
    expect(result.errorMessage).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleSessionWarning
// ---------------------------------------------------------------------------
describe('handleSessionWarning', () => {
  it('extracts all fields when present', () => {
    const result = handleSessionWarning({
      sessionId: 'sess-1',
      name: 'Editor',
      remainingMs: 60000,
      message: 'Session ends in 60s',
    })
    expect(result.sessionId).toBe('sess-1')
    expect(result.sessionName).toBe('Editor')
    expect(result.remainingMs).toBe(60000)
    expect(result.message).toBe('Session ends in 60s')
    expect(result.systemMessage.content).toBe('Session ends in 60s')
    expect(result.systemMessage.type).toBe('system')
    expect(result.systemMessage.id).toMatch(/^warn-/)
  })

  it('falls back to defaults when fields are missing', () => {
    const result = handleSessionWarning({})
    expect(result.sessionId).toBeNull()
    expect(result.sessionName).toBe('Session')
    expect(result.remainingMs).toBe(120000)
    expect(result.message).toBe('Session will timeout soon')
    expect(result.systemMessage.content).toBe('Session will timeout soon')
  })

  it('coerces non-string sessionId/name to default fallbacks', () => {
    const result = handleSessionWarning({ sessionId: 42, name: { x: 1 }, remainingMs: 'a' })
    expect(result.sessionId).toBeNull()
    expect(result.sessionName).toBe('Session')
    expect(result.remainingMs).toBe(120000)
  })

  it('trims whitespace from sessionId/name/message', () => {
    const result = handleSessionWarning({
      sessionId: '  sess-1  ',
      name: '  Editor  ',
      message: '  ending soon  ',
    })
    expect(result.sessionId).toBe('sess-1')
    expect(result.sessionName).toBe('Editor')
    expect(result.message).toBe('ending soon')
  })

  it('falls back to defaults when fields are whitespace-only', () => {
    const result = handleSessionWarning({ sessionId: '   ', name: '   ', message: '   ' })
    expect(result.sessionId).toBeNull()
    expect(result.sessionName).toBe('Session')
    expect(result.message).toBe('Session will timeout soon')
  })
})

// ---------------------------------------------------------------------------
// handleSessionSwitched
// ---------------------------------------------------------------------------
describe('handleSessionSwitched', () => {
  it('extracts newSessionId and conversationId when both are present', () => {
    expect(
      handleSessionSwitched({ sessionId: 'sess-1', conversationId: 'conv-1' }),
    ).toEqual({ newSessionId: 'sess-1', conversationId: 'conv-1' })
  })

  it('returns null conversationId when missing', () => {
    expect(handleSessionSwitched({ sessionId: 'sess-1' })).toEqual({
      newSessionId: 'sess-1',
      conversationId: null,
    })
  })

  it('returns null when sessionId is missing', () => {
    expect(handleSessionSwitched({})).toBeNull()
  })

  it('returns null when sessionId is non-string', () => {
    expect(handleSessionSwitched({ sessionId: 42 })).toBeNull()
  })

  it('returns null when sessionId is empty', () => {
    expect(handleSessionSwitched({ sessionId: '' })).toBeNull()
  })

  it('returns null when sessionId is whitespace only', () => {
    expect(handleSessionSwitched({ sessionId: '   ' })).toBeNull()
  })

  it('trims whitespace from sessionId and conversationId', () => {
    expect(
      handleSessionSwitched({ sessionId: '  sess-1  ', conversationId: '  conv-1  ' }),
    ).toEqual({ newSessionId: 'sess-1', conversationId: 'conv-1' })
  })

  it('returns null conversationId when non-string', () => {
    expect(handleSessionSwitched({ sessionId: 'sess-1', conversationId: 42 })).toEqual({
      newSessionId: 'sess-1',
      conversationId: null,
    })
  })
})

// ---------------------------------------------------------------------------
// handleDirectoryListing
// ---------------------------------------------------------------------------
describe('handleDirectoryListing', () => {
  it('extracts all fields from a valid payload', () => {
    const entries = [{ name: 'src', isDirectory: true }, { name: 'README.md', isDirectory: false }]
    expect(
      handleDirectoryListing({
        path: '/repo',
        parentPath: '/',
        entries,
        error: null,
      }),
    ).toEqual({
      path: '/repo',
      parentPath: '/',
      entries,
      error: null,
    })
  })

  it('defaults to nulls and empty array when fields are missing', () => {
    expect(handleDirectoryListing({})).toEqual({
      path: null,
      parentPath: null,
      entries: [],
      error: null,
    })
  })

  it('coerces non-string path/parentPath/error to null', () => {
    expect(
      handleDirectoryListing({
        path: 123,
        parentPath: false,
        entries: 'nope',
        error: 0,
      }),
    ).toEqual({
      path: null,
      parentPath: null,
      entries: [],
      error: null,
    })
  })

  it('forwards entries verbatim without per-element validation', () => {
    const malformed = [{ wat: true }, 42, null]
    expect(handleDirectoryListing({ entries: malformed })).toEqual({
      path: null,
      parentPath: null,
      entries: malformed,
      error: null,
    })
  })

  it('extracts error string when present', () => {
    expect(handleDirectoryListing({ error: 'permission denied' })).toEqual({
      path: null,
      parentPath: null,
      entries: [],
      error: 'permission denied',
    })
  })

  it('preserves empty-string path verbatim (no trim/empty coercion)', () => {
    // Behaviour-preserving: matches inline `typeof === 'string' ? msg.path : null`.
    // Empty string is still a string, so it passes through.
    expect(handleDirectoryListing({ path: '', parentPath: '' })).toEqual({
      path: '',
      parentPath: '',
      entries: [],
      error: null,
    })
  })
})

// ---------------------------------------------------------------------------
// handleSlashCommands
// ---------------------------------------------------------------------------
describe('handleSlashCommands', () => {
  it('returns commands array when valid and no session id on message (broadcast)', () => {
    const cmds = [{ name: '/help' }, { name: '/clear' }]
    expect(handleSlashCommands({ commands: cmds }, 'active-1')).toEqual({ commands: cmds })
  })

  it('returns commands array when session id matches active', () => {
    const cmds = [{ name: '/help' }]
    expect(
      handleSlashCommands({ sessionId: 'active-1', commands: cmds }, 'active-1'),
    ).toEqual({ commands: cmds })
  })

  it('returns empty commands array verbatim', () => {
    expect(handleSlashCommands({ commands: [] }, 'active-1')).toEqual({ commands: [] })
  })

  it('returns commands when message has session id but no active session', () => {
    const cmds = [{ name: '/help' }]
    expect(handleSlashCommands({ sessionId: 'sess-1', commands: cmds }, null)).toEqual({
      commands: cmds,
    })
  })

  it('returns null when session id mismatches active session', () => {
    expect(
      handleSlashCommands({ sessionId: 'other', commands: [{ name: '/help' }] }, 'active-1'),
    ).toBeNull()
  })

  it('returns null when commands is missing', () => {
    expect(handleSlashCommands({}, 'active-1')).toBeNull()
  })

  it('returns null when commands is non-array', () => {
    expect(handleSlashCommands({ commands: 'oops' }, 'active-1')).toBeNull()
    expect(handleSlashCommands({ commands: { x: 1 } }, 'active-1')).toBeNull()
    expect(handleSlashCommands({ commands: null }, 'active-1')).toBeNull()
  })

  it('returns commands when no active session and no session id on message', () => {
    const cmds = [{ name: '/help' }]
    expect(handleSlashCommands({ commands: cmds }, null)).toEqual({ commands: cmds })
  })

  // Behaviour-preservation tests for the truthiness-based guard.
  // The original inline guard was `if (msg.sessionId && active && msg.sessionId !== active) skip`,
  // which treats any truthy value as "set" (not just strings).
  it('skips when non-string truthy session id mismatches active', () => {
    // Number sessionId different from active string — original code skipped this.
    expect(
      handleSlashCommands({ sessionId: 123, commands: [{ name: '/help' }] }, 'active-1'),
    ).toBeNull()
  })

  it('returns commands when falsy session id (empty string) and active is set', () => {
    // Empty-string sessionId is falsy → guard bypassed in original truthiness check.
    const cmds = [{ name: '/help' }]
    expect(handleSlashCommands({ sessionId: '', commands: cmds }, 'active-1')).toEqual({
      commands: cmds,
    })
  })
})

// ---------------------------------------------------------------------------
// handleFileListing
// ---------------------------------------------------------------------------
describe('handleFileListing', () => {
  it('extracts all fields from a valid payload', () => {
    const entries = [{ name: 'index.ts', size: 1024 }, { name: 'app.ts', size: 2048 }]
    expect(
      handleFileListing({
        path: '/repo/src',
        parentPath: '/repo',
        entries,
        error: null,
      }),
    ).toEqual({
      path: '/repo/src',
      parentPath: '/repo',
      entries,
      error: null,
    })
  })

  it('defaults to nulls and empty array when fields are missing', () => {
    expect(handleFileListing({})).toEqual({
      path: null,
      parentPath: null,
      entries: [],
      error: null,
    })
  })

  it('coerces non-string path/parentPath/error to null and non-array entries to []', () => {
    expect(
      handleFileListing({
        path: 42,
        parentPath: {},
        entries: 'nope',
        error: false,
      }),
    ).toEqual({
      path: null,
      parentPath: null,
      entries: [],
      error: null,
    })
  })

  it('forwards entries verbatim without per-element validation', () => {
    const malformed = [{ huh: 1 }, 'string-entry', null]
    expect(handleFileListing({ entries: malformed })).toEqual({
      path: null,
      parentPath: null,
      entries: malformed,
      error: null,
    })
  })

  it('extracts error string when present', () => {
    expect(handleFileListing({ error: 'not found' })).toEqual({
      path: null,
      parentPath: null,
      entries: [],
      error: 'not found',
    })
  })
})

// ---------------------------------------------------------------------------
// handleAgentList
// ---------------------------------------------------------------------------
describe('handleAgentList', () => {
  it('returns agents array when valid and no session id on message (broadcast)', () => {
    const agents = [{ name: 'reviewer' }, { name: 'planner' }]
    expect(handleAgentList({ agents }, 'active-1')).toEqual({ agents })
  })

  it('returns agents array when session id matches active', () => {
    const agents = [{ name: 'reviewer' }]
    expect(
      handleAgentList({ sessionId: 'active-1', agents }, 'active-1'),
    ).toEqual({ agents })
  })

  it('returns empty agents array verbatim', () => {
    expect(handleAgentList({ agents: [] }, 'active-1')).toEqual({ agents: [] })
  })

  it('returns agents when message has session id but no active session', () => {
    const agents = [{ name: 'reviewer' }]
    expect(handleAgentList({ sessionId: 'sess-1', agents }, null)).toEqual({ agents })
  })

  it('returns null when session id mismatches active session', () => {
    expect(
      handleAgentList({ sessionId: 'other', agents: [{ name: 'r' }] }, 'active-1'),
    ).toBeNull()
  })

  it('returns null when agents is missing', () => {
    expect(handleAgentList({}, 'active-1')).toBeNull()
  })

  it('returns null when agents is non-array', () => {
    expect(handleAgentList({ agents: 'oops' }, 'active-1')).toBeNull()
    expect(handleAgentList({ agents: { x: 1 } }, 'active-1')).toBeNull()
    expect(handleAgentList({ agents: null }, 'active-1')).toBeNull()
  })

  it('returns agents when no active session and no session id on message', () => {
    const agents = [{ name: 'reviewer' }]
    expect(handleAgentList({ agents }, null)).toEqual({ agents })
  })

  // Behaviour-preservation tests for the truthiness-based guard (mirrors
  // the original inline `msg.sessionId && active && msg.sessionId !== active`).
  it('skips when non-string truthy session id mismatches active', () => {
    expect(
      handleAgentList({ sessionId: 123, agents: [{ name: 'r' }] }, 'active-1'),
    ).toBeNull()
  })

  it('returns agents when falsy session id (empty string) and active is set', () => {
    const agents = [{ name: 'reviewer' }]
    expect(handleAgentList({ sessionId: '', agents }, 'active-1')).toEqual({ agents })
  })
})

// ---------------------------------------------------------------------------
// handleFileContent
// ---------------------------------------------------------------------------
describe('handleFileContent', () => {
  it('extracts all fields from a valid payload', () => {
    expect(
      handleFileContent({
        path: '/repo/src/index.ts',
        content: 'export {}',
        language: 'typescript',
        size: 9,
        truncated: false,
        error: null,
      }),
    ).toEqual({
      path: '/repo/src/index.ts',
      content: 'export {}',
      language: 'typescript',
      size: 9,
      truncated: false,
      error: null,
    })
  })

  it('defaults to nulls and false when fields are missing', () => {
    expect(handleFileContent({})).toEqual({
      path: null,
      content: null,
      language: null,
      size: null,
      truncated: false,
      error: null,
    })
  })

  it('coerces non-string path/content/language/error to null', () => {
    expect(
      handleFileContent({
        path: 1,
        content: false,
        language: 0,
        error: {},
      }),
    ).toEqual({
      path: null,
      content: null,
      language: null,
      size: null,
      truncated: false,
      error: null,
    })
  })

  it('coerces non-number size to null', () => {
    expect(handleFileContent({ size: '9001' })).toEqual({
      path: null,
      content: null,
      language: null,
      size: null,
      truncated: false,
      error: null,
    })
  })

  it('returns truncated=true only for strict === true', () => {
    expect(handleFileContent({ truncated: true }).truncated).toBe(true)
  })

  it('returns truncated=false for truthy non-boolean values', () => {
    // Behaviour-preserving: matches inline `msg.truncated === true`. Truthy
    // strings/numbers do NOT count.
    expect(handleFileContent({ truncated: 'true' }).truncated).toBe(false)
    expect(handleFileContent({ truncated: 1 }).truncated).toBe(false)
    expect(handleFileContent({ truncated: {} }).truncated).toBe(false)
  })

  it('returns truncated=false when missing', () => {
    expect(handleFileContent({}).truncated).toBe(false)
  })

  it('extracts error string when present', () => {
    expect(handleFileContent({ error: 'too big' })).toEqual({
      path: null,
      content: null,
      language: null,
      size: null,
      truncated: false,
      error: 'too big',
    })
  })

  it('preserves empty-string content verbatim', () => {
    // Empty string is still a string and passes through (matches inline guard).
    expect(handleFileContent({ content: '' }).content).toBe('')
  })

  it('preserves zero size verbatim', () => {
    expect(handleFileContent({ size: 0 }).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// handleProviderList
// ---------------------------------------------------------------------------
describe('handleProviderList', () => {
  it('returns providers array when valid', () => {
    const providers = [{ name: 'anthropic' }, { name: 'openai' }]
    expect(handleProviderList({ providers })).toEqual({ providers })
  })

  it('returns empty providers array verbatim', () => {
    expect(handleProviderList({ providers: [] })).toEqual({ providers: [] })
  })

  it('ignores session id on message (no guard)', () => {
    const providers = [{ name: 'anthropic' }]
    expect(handleProviderList({ sessionId: 'whatever', providers })).toEqual({ providers })
  })

  it('returns null when providers is missing', () => {
    expect(handleProviderList({})).toBeNull()
  })

  it('returns null when providers is non-array', () => {
    expect(handleProviderList({ providers: 'oops' })).toBeNull()
    expect(handleProviderList({ providers: { x: 1 } })).toBeNull()
    expect(handleProviderList({ providers: null })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleWriteFileResult
// ---------------------------------------------------------------------------
describe('handleWriteFileResult', () => {
  it('extracts both fields when present', () => {
    expect(
      handleWriteFileResult({ path: '/repo/out.txt', error: null }),
    ).toEqual({ path: '/repo/out.txt', error: null })
  })

  it('extracts error when set', () => {
    expect(
      handleWriteFileResult({ path: '/repo/out.txt', error: 'EACCES' }),
    ).toEqual({ path: '/repo/out.txt', error: 'EACCES' })
  })

  it('defaults to nulls when fields are missing', () => {
    expect(handleWriteFileResult({})).toEqual({ path: null, error: null })
  })

  it('coerces non-string fields to null', () => {
    expect(handleWriteFileResult({ path: 1, error: false })).toEqual({
      path: null,
      error: null,
    })
  })

  it('preserves empty-string path verbatim', () => {
    expect(handleWriteFileResult({ path: '' })).toEqual({ path: '', error: null })
  })
})

// ---------------------------------------------------------------------------
// handleFileList
// ---------------------------------------------------------------------------
describe('handleFileList', () => {
  it('returns files array when valid', () => {
    const files = [{ path: 'a.ts' }, { path: 'b.ts' }]
    expect(handleFileList({ files })).toEqual({ files })
  })

  it('returns empty files array verbatim', () => {
    expect(handleFileList({ files: [] })).toEqual({ files: [] })
  })

  it('returns empty array when files is missing (matches dashboard default)', () => {
    expect(handleFileList({})).toEqual({ files: [] })
  })

  it('returns empty array when files is non-array (matches dashboard default)', () => {
    expect(handleFileList({ files: 'oops' })).toEqual({ files: [] })
    expect(handleFileList({ files: { x: 1 } })).toEqual({ files: [] })
    expect(handleFileList({ files: null })).toEqual({ files: [] })
  })

  it('ignores session id on message (no guard)', () => {
    const files = [{ path: 'a.ts' }]
    expect(handleFileList({ sessionId: 'whatever', files })).toEqual({ files })
  })
})

// ---------------------------------------------------------------------------
// handleDiffResult
// ---------------------------------------------------------------------------
describe('handleDiffResult', () => {
  it('extracts files array and error verbatim', () => {
    const files = [{ path: 'a.txt', additions: 1, deletions: 0 }]
    const result = handleDiffResult({ files, error: null })
    expect(result.files).toBe(files)
    expect(result.error).toBeNull()
  })

  it('defaults to [] for missing/non-array files', () => {
    expect(handleDiffResult({}).files).toEqual([])
    expect(handleDiffResult({ files: 'oops' }).files).toEqual([])
    expect(handleDiffResult({ files: null }).files).toEqual([])
  })

  it('extracts error string when present', () => {
    expect(handleDiffResult({ error: 'no diff' }).error).toBe('no diff')
  })

  it('preserves empty-string error verbatim', () => {
    expect(handleDiffResult({ error: '' }).error).toBe('')
  })

  it('coerces non-string error to null', () => {
    expect(handleDiffResult({ error: 0 }).error).toBeNull()
    expect(handleDiffResult({ error: false }).error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleGitStatusResult
// ---------------------------------------------------------------------------
describe('handleGitStatusResult', () => {
  it('extracts all fields from a valid payload', () => {
    expect(
      handleGitStatusResult({
        branch: 'main',
        staged: [{ path: 'a' }],
        unstaged: [{ path: 'b' }],
        untracked: ['c'],
        error: null,
      }),
    ).toEqual({
      branch: 'main',
      staged: [{ path: 'a' }],
      unstaged: [{ path: 'b' }],
      untracked: ['c'],
      error: null,
    })
  })

  it('defaults to nulls and empty arrays when missing', () => {
    expect(handleGitStatusResult({})).toEqual({
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      error: null,
    })
  })

  it('coerces non-string branch/error to null', () => {
    expect(handleGitStatusResult({ branch: 1, error: false })).toEqual({
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      error: null,
    })
  })

  it('coerces non-array list fields to []', () => {
    expect(handleGitStatusResult({ staged: 'no', unstaged: {}, untracked: null })).toEqual({
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      error: null,
    })
  })

  it('preserves empty-string branch/error verbatim', () => {
    expect(handleGitStatusResult({ branch: '', error: '' })).toEqual({
      branch: '',
      staged: [],
      unstaged: [],
      untracked: [],
      error: '',
    })
  })
})

// ---------------------------------------------------------------------------
// handleGitBranchesResult
// ---------------------------------------------------------------------------
describe('handleGitBranchesResult', () => {
  it('extracts all fields from a valid payload', () => {
    const branches = [{ name: 'main' }, { name: 'feat/x' }]
    expect(
      handleGitBranchesResult({ branches, currentBranch: 'main', error: null }),
    ).toEqual({ branches, currentBranch: 'main', error: null })
  })

  it('defaults to nulls and empty array when missing', () => {
    expect(handleGitBranchesResult({})).toEqual({
      branches: [],
      currentBranch: null,
      error: null,
    })
  })

  it('coerces non-string currentBranch/error to null', () => {
    expect(handleGitBranchesResult({ currentBranch: 1, error: false })).toEqual({
      branches: [],
      currentBranch: null,
      error: null,
    })
  })

  it('preserves empty-string currentBranch/error verbatim', () => {
    expect(handleGitBranchesResult({ currentBranch: '', error: '' })).toEqual({
      branches: [],
      currentBranch: '',
      error: '',
    })
  })
})

// ---------------------------------------------------------------------------
// handleGitStageResult (also handles git_unstage_result)
// ---------------------------------------------------------------------------
describe('handleGitStageResult', () => {
  it('extracts error when present', () => {
    expect(handleGitStageResult({ error: 'EACCES' })).toEqual({ error: 'EACCES' })
  })

  it('defaults to null when missing', () => {
    expect(handleGitStageResult({})).toEqual({ error: null })
  })

  it('coerces non-string error to null', () => {
    expect(handleGitStageResult({ error: false })).toEqual({ error: null })
  })

  it('preserves empty-string error verbatim', () => {
    expect(handleGitStageResult({ error: '' })).toEqual({ error: '' })
  })
})

// ---------------------------------------------------------------------------
// handleGitCommitResult
// ---------------------------------------------------------------------------
describe('handleGitCommitResult', () => {
  it('extracts all fields from a valid payload', () => {
    expect(
      handleGitCommitResult({ hash: 'abc1234', message: 'fix: x', error: null }),
    ).toEqual({ hash: 'abc1234', message: 'fix: x', error: null })
  })

  it('defaults to nulls when missing', () => {
    expect(handleGitCommitResult({})).toEqual({
      hash: null,
      message: null,
      error: null,
    })
  })

  it('coerces non-string fields to null', () => {
    expect(handleGitCommitResult({ hash: 1, message: false, error: 0 })).toEqual({
      hash: null,
      message: null,
      error: null,
    })
  })

  it('preserves empty-string fields verbatim', () => {
    expect(handleGitCommitResult({ hash: '', message: '', error: '' })).toEqual({
      hash: '',
      message: '',
      error: '',
    })
  })

  it('extracts error when present', () => {
    expect(handleGitCommitResult({ error: 'merge conflict' }).error).toBe('merge conflict')
  })
})

// ---------------------------------------------------------------------------
// handleAgentSpawned
// ---------------------------------------------------------------------------
describe('handleAgentSpawned', () => {
  it('appends a new agent when toolUseId not present in current list', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
    ]
    const builder = handleAgentSpawned(
      {
        sessionId: 'sess-1',
        toolUseId: 'tu-2',
        description: 'second',
        startedAt: 200,
      },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-1')
    expect(builder.applyTo(existing)).toEqual([
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
      { toolUseId: 'tu-2', description: 'second', startedAt: 200 },
    ])
  })

  it('returns the same array reference when toolUseId already present (dedup)', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
    ]
    const builder = handleAgentSpawned(
      { toolUseId: 'tu-1', description: 'duplicate', startedAt: 999 },
      'active-1',
    )
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it('returns same array (no-op) when toolUseId is missing', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
    ]
    const builder = handleAgentSpawned({ description: 'no id' }, 'active-1')
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it('returns same array (no-op) when toolUseId is non-string', () => {
    const existing: AgentInfo[] = []
    const builder = handleAgentSpawned({ toolUseId: 42 }, 'active-1')
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it("defaults description to 'Background task' when missing", () => {
    const builder = handleAgentSpawned(
      { toolUseId: 'tu-1', startedAt: 100 },
      'active-1',
    )
    expect(builder.applyTo([])).toEqual([
      { toolUseId: 'tu-1', description: 'Background task', startedAt: 100 },
    ])
  })

  it("defaults description to 'Background task' when empty string", () => {
    // Matches prior inline `(msg.description as string) || 'Background task'`.
    const builder = handleAgentSpawned(
      { toolUseId: 'tu-1', description: '', startedAt: 100 },
      'active-1',
    )
    expect(builder.applyTo([])[0]?.description).toBe('Background task')
  })

  it('defaults startedAt to current time when missing', () => {
    const before = Date.now()
    const builder = handleAgentSpawned({ toolUseId: 'tu-1' }, 'active-1')
    const out = builder.applyTo([])
    const after = Date.now()
    expect(out).toHaveLength(1)
    const startedAt = out[0]?.startedAt
    expect(typeof startedAt).toBe('number')
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(startedAt).toBeLessThanOrEqual(after)
  })

  it('defaults startedAt to current time when zero (falsy)', () => {
    // Matches prior inline `(msg.startedAt as number) || Date.now()`: 0 is falsy.
    const before = Date.now()
    const builder = handleAgentSpawned(
      { toolUseId: 'tu-1', startedAt: 0 },
      'active-1',
    )
    const startedAt = builder.applyTo([])[0]?.startedAt as number
    const after = Date.now()
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(startedAt).toBeLessThanOrEqual(after)
  })

  it('falls back to active session when message has no sessionId', () => {
    const builder = handleAgentSpawned({ toolUseId: 'tu-1' }, 'active-1')
    expect(builder.sessionId).toBe('active-1')
  })

  it('uses explicit sessionId from message when present', () => {
    const builder = handleAgentSpawned(
      { sessionId: 'sess-99', toolUseId: 'tu-1' },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-99')
  })

  it('returns null sessionId when neither is available', () => {
    const builder = handleAgentSpawned({ toolUseId: 'tu-1' }, null)
    expect(builder.sessionId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleAgentCompleted
// ---------------------------------------------------------------------------
describe('handleAgentCompleted', () => {
  it('removes the matching toolUseId from current list', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
      { toolUseId: 'tu-2', description: 'second', startedAt: 200 },
    ]
    const builder = handleAgentCompleted(
      { sessionId: 'sess-1', toolUseId: 'tu-1' },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-1')
    expect(builder.applyTo(existing)).toEqual([
      { toolUseId: 'tu-2', description: 'second', startedAt: 200 },
    ])
  })

  it('returns the same array reference when toolUseId not in list', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
    ]
    const builder = handleAgentCompleted({ toolUseId: 'tu-99' }, 'active-1')
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it('returns same array (no-op) when toolUseId is missing', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
    ]
    const builder = handleAgentCompleted({}, 'active-1')
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it('returns same array (no-op) when toolUseId is non-string', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
    ]
    const builder = handleAgentCompleted({ toolUseId: 42 }, 'active-1')
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it('falls back to active session when message has no sessionId', () => {
    const builder = handleAgentCompleted({ toolUseId: 'tu-1' }, 'active-1')
    expect(builder.sessionId).toBe('active-1')
  })

  it('uses explicit sessionId from message when present', () => {
    const builder = handleAgentCompleted(
      { sessionId: 'sess-99', toolUseId: 'tu-1' },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-99')
  })

  it('returns null sessionId when neither is available', () => {
    const builder = handleAgentCompleted({ toolUseId: 'tu-1' }, null)
    expect(builder.sessionId).toBeNull()
    expect(builder.applyTo([])).toEqual([])
  })

  it('removes only the matching entry, preserves others', () => {
    const existing: AgentInfo[] = [
      { toolUseId: 'tu-1', description: 'first', startedAt: 100 },
      { toolUseId: 'tu-2', description: 'second', startedAt: 200 },
      { toolUseId: 'tu-3', description: 'third', startedAt: 300 },
    ]
    const builder = handleAgentCompleted({ toolUseId: 'tu-2' }, 'active-1')
    expect(builder.applyTo(existing).map((a) => a.toolUseId)).toEqual([
      'tu-1',
      'tu-3',
    ])
  })
})

// ---------------------------------------------------------------------------
// handleEnvironmentList
// ---------------------------------------------------------------------------
describe('handleEnvironmentList', () => {
  it('returns environments array when valid', () => {
    const envs = [{ id: 'env-1', name: 'dev' }, { id: 'env-2', name: 'prod' }]
    expect(handleEnvironmentList({ environments: envs })).toEqual({ environments: envs })
  })

  it('returns empty environments array verbatim', () => {
    expect(handleEnvironmentList({ environments: [] })).toEqual({ environments: [] })
  })

  it('returns empty array when environments is missing', () => {
    expect(handleEnvironmentList({})).toEqual({ environments: [] })
  })

  it('returns empty array when environments is non-array', () => {
    expect(handleEnvironmentList({ environments: 'oops' })).toEqual({ environments: [] })
    expect(handleEnvironmentList({ environments: { x: 1 } })).toEqual({ environments: [] })
    expect(handleEnvironmentList({ environments: null })).toEqual({ environments: [] })
  })

  it('ignores session id on message (no guard)', () => {
    const envs = [{ id: 'env-1' }]
    expect(handleEnvironmentList({ sessionId: 'whatever', environments: envs })).toEqual({
      environments: envs,
    })
  })
})

// ---------------------------------------------------------------------------
// handleEnvironmentError
// ---------------------------------------------------------------------------
describe('handleEnvironmentError', () => {
  it('returns error string when present', () => {
    expect(handleEnvironmentError({ error: 'docker daemon down' })).toEqual({
      error: 'docker daemon down',
    })
  })

  it('preserves empty-string error verbatim', () => {
    // Matches the prior inline `console.error('[ws] Environment error:', msg.error)` —
    // the original code passed the value through unconditionally.
    expect(handleEnvironmentError({ error: '' })).toEqual({ error: '' })
  })

  it('returns null when error is missing', () => {
    expect(handleEnvironmentError({})).toEqual({ error: null })
  })

  it('returns null when error is non-string', () => {
    expect(handleEnvironmentError({ error: 42 })).toEqual({ error: null })
    expect(handleEnvironmentError({ error: { msg: 'x' } })).toEqual({ error: null })
    expect(handleEnvironmentError({ error: null })).toEqual({ error: null })
  })
})

// ---------------------------------------------------------------------------
// handleAvailableModels
// ---------------------------------------------------------------------------
describe('handleAvailableModels', () => {
  it('passes through valid object entries verbatim', () => {
    const models: ModelInfo[] = [
      { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4' },
      { id: 'opus', label: 'Opus', fullId: 'claude-opus-4', contextWindow: 200000 },
    ]
    expect(handleAvailableModels({ models })).toEqual({
      models,
      defaultModelId: null,
    })
  })

  it('expands string entries into capitalized objects', () => {
    expect(handleAvailableModels({ models: ['sonnet'] })).toEqual({
      models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'sonnet' }],
      defaultModelId: null,
    })
  })

  it('trims whitespace on string entries', () => {
    expect(handleAvailableModels({ models: ['  haiku  '] })).toEqual({
      models: [{ id: 'haiku', label: 'Haiku', fullId: 'haiku' }],
      defaultModelId: null,
    })
  })

  it('handles a mixed array of strings and objects', () => {
    const result = handleAvailableModels({
      models: [
        'sonnet',
        { id: 'opus', label: 'Opus', fullId: 'claude-opus-4' },
      ],
    })
    expect(result.models).toEqual([
      { id: 'sonnet', label: 'Sonnet', fullId: 'sonnet' },
      { id: 'opus', label: 'Opus', fullId: 'claude-opus-4' },
    ])
  })

  it('filters malformed object entries (missing fields)', () => {
    const result = handleAvailableModels({
      models: [
        { id: 'opus', label: 'Opus', fullId: 'claude-opus-4' },
        { id: '', label: 'X', fullId: 'y' }, // empty id
        { id: 'a', label: '   ', fullId: 'a' }, // whitespace label
        { id: 'b', label: 'B' }, // missing fullId
        { label: 'No id', fullId: 'x' }, // missing id
      ],
    })
    expect(result.models).toEqual([
      { id: 'opus', label: 'Opus', fullId: 'claude-opus-4' },
    ])
  })

  it('filters non-string non-object entries (numbers, null, etc.)', () => {
    const result = handleAvailableModels({
      models: [42, null, undefined, true, ''],
    })
    expect(result.models).toEqual([])
  })

  it('keeps contextWindow only when number > 0', () => {
    const result = handleAvailableModels({
      models: [
        { id: 'a', label: 'A', fullId: 'a', contextWindow: 100000 },
        { id: 'b', label: 'B', fullId: 'b', contextWindow: 0 },
        { id: 'c', label: 'C', fullId: 'c', contextWindow: -1 },
        { id: 'd', label: 'D', fullId: 'd', contextWindow: '200000' },
        { id: 'e', label: 'E', fullId: 'e' },
      ],
    })
    expect(result.models).toEqual([
      { id: 'a', label: 'A', fullId: 'a', contextWindow: 100000 },
      { id: 'b', label: 'B', fullId: 'b' },
      { id: 'c', label: 'C', fullId: 'c' },
      { id: 'd', label: 'D', fullId: 'd' },
      { id: 'e', label: 'E', fullId: 'e' },
    ])
  })

  it('extracts defaultModelId when string', () => {
    const result = handleAvailableModels({
      models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4' }],
      defaultModel: 'claude-sonnet-4',
    })
    expect(result.defaultModelId).toBe('claude-sonnet-4')
  })

  it('returns null defaultModelId when missing', () => {
    expect(
      handleAvailableModels({
        models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'sonnet' }],
      }).defaultModelId,
    ).toBeNull()
  })

  it('returns null defaultModelId when non-string', () => {
    const result = handleAvailableModels({
      models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'sonnet' }],
      defaultModel: 42,
    })
    expect(result.defaultModelId).toBeNull()
  })

  it('returns empty models array when models is missing', () => {
    expect(handleAvailableModels({})).toEqual({
      models: [],
      defaultModelId: null,
    })
  })

  it('returns empty models array when models is non-array', () => {
    expect(handleAvailableModels({ models: 'oops' })).toEqual({
      models: [],
      defaultModelId: null,
    })
    expect(handleAvailableModels({ models: { x: 1 } })).toEqual({
      models: [],
      defaultModelId: null,
    })
    expect(handleAvailableModels({ models: null })).toEqual({
      models: [],
      defaultModelId: null,
    })
  })

  it('preserves empty-string entries as filtered (no expansion)', () => {
    // String must be non-empty after trim to expand.
    expect(handleAvailableModels({ models: ['', '  '] })).toEqual({
      models: [],
      defaultModelId: null,
    })
  })

  it('capitalizes only the first character of string entries', () => {
    expect(handleAvailableModels({ models: ['claude-sonnet-4'] })).toEqual({
      models: [
        { id: 'claude-sonnet-4', label: 'Claude-sonnet-4', fullId: 'claude-sonnet-4' },
      ],
      defaultModelId: null,
    })
  })
})

// ---------------------------------------------------------------------------
// handleMcpServers
// ---------------------------------------------------------------------------
describe('handleMcpServers', () => {
  it('uses sessionId from message when present', () => {
    const servers = [{ name: 'srv-1', status: 'running' }]
    const result = handleMcpServers(
      { sessionId: 'sess-9', servers },
      'active-1',
    )
    expect(result).toEqual({
      sessionId: 'sess-9',
      patch: { mcpServers: servers },
    })
  })

  it('falls back to active session when message has no sessionId', () => {
    const servers = [{ name: 'srv-1', status: 'running' }]
    const result = handleMcpServers({ servers }, 'active-1')
    expect(result.sessionId).toBe('active-1')
    expect(result.patch).toEqual({ mcpServers: servers })
  })

  it('returns null sessionId when neither is available', () => {
    const result = handleMcpServers({ servers: [] }, null)
    expect(result.sessionId).toBeNull()
  })

  it('returns empty array when servers is missing', () => {
    const result = handleMcpServers({}, 'active-1')
    expect(result.patch).toEqual({ mcpServers: [] })
  })

  it('returns empty array when servers is non-array', () => {
    expect(handleMcpServers({ servers: 'oops' }, 'active-1').patch).toEqual({
      mcpServers: [],
    })
    expect(handleMcpServers({ servers: { x: 1 } }, 'active-1').patch).toEqual({
      mcpServers: [],
    })
    expect(handleMcpServers({ servers: null }, 'active-1').patch).toEqual({
      mcpServers: [],
    })
  })

  it('passes element shape through verbatim (no per-element validation)', () => {
    // Elements aren't validated at the shared layer — caller casts to McpServer[].
    const servers = [
      { name: 'srv-1', status: 'running' },
      { totally: 'malformed' },
      'string-entry',
    ]
    expect(handleMcpServers({ servers }, 'active-1').patch).toEqual({
      mcpServers: servers,
    })
  })

  it('preserves whitespace-padded sessionId verbatim (no trim, no fallback)', () => {
    // Matches legacy `(msg.sessionId as string) || activeSessionId` semantics:
    // a non-empty whitespace-padded string is truthy, so it's used as-is and
    // we do NOT fall back to activeSessionId. Downstream sessionStates lookup
    // will miss (correct outcome), rather than silently patching active.
    const result = handleMcpServers(
      { sessionId: '  sess-1  ', servers: [] },
      'active-1',
    )
    expect(result.sessionId).toBe('  sess-1  ')
  })

  it('falls back to activeSessionId when sessionId is empty string', () => {
    // Empty string is falsy, so the legacy `||` falls back to activeSessionId.
    const result = handleMcpServers(
      { sessionId: '', servers: [] },
      'active-1',
    )
    expect(result.sessionId).toBe('active-1')
  })
})

// ---------------------------------------------------------------------------
// handleCostUpdate
// ---------------------------------------------------------------------------
describe('handleCostUpdate', () => {
  it('passes a numeric sessionCost through', () => {
    const result = handleCostUpdate(
      { sessionId: 'sess-1', sessionCost: 1.23 },
      'active-1',
    )
    expect(result).toEqual({
      sessionId: 'sess-1',
      patch: { sessionCost: 1.23 },
    })
  })

  it('passes zero through (number > 0 not required)', () => {
    const result = handleCostUpdate({ sessionCost: 0 }, 'active-1')
    expect(result.patch).toEqual({ sessionCost: 0 })
  })

  it('returns null sessionCost when missing', () => {
    expect(handleCostUpdate({}, 'active-1').patch).toEqual({ sessionCost: null })
  })

  it('returns null sessionCost when non-number', () => {
    expect(handleCostUpdate({ sessionCost: '1.23' }, 'active-1').patch).toEqual({
      sessionCost: null,
    })
    expect(handleCostUpdate({ sessionCost: null }, 'active-1').patch).toEqual({
      sessionCost: null,
    })
    expect(handleCostUpdate({ sessionCost: { x: 1 } }, 'active-1').patch).toEqual({
      sessionCost: null,
    })
  })

  it('uses sessionId from message when present', () => {
    expect(
      handleCostUpdate({ sessionId: 'sess-9', sessionCost: 0.5 }, 'active-1')
        .sessionId,
    ).toBe('sess-9')
  })

  it('falls back to active session when message has no sessionId', () => {
    expect(handleCostUpdate({ sessionCost: 0.5 }, 'active-1').sessionId).toBe(
      'active-1',
    )
  })

  it('returns null sessionId when neither is available', () => {
    expect(handleCostUpdate({ sessionCost: 0.5 }, null).sessionId).toBeNull()
  })

  it('preserves whitespace-padded sessionId verbatim (no trim, no fallback)', () => {
    // Matches legacy `(msg.sessionId as string) || activeSessionId` semantics:
    // a non-empty whitespace-padded string is truthy, so it's used as-is and
    // we do NOT fall back to activeSessionId. Downstream sessionStates lookup
    // will miss (correct outcome), rather than silently applying the cost
    // update to the active session.
    const result = handleCostUpdate(
      { sessionId: '  sess-1  ', sessionCost: 0.5 },
      'active-1',
    )
    expect(result.sessionId).toBe('  sess-1  ')
  })

  it('falls back to activeSessionId when sessionId is empty string', () => {
    // Empty string is falsy, so the legacy `||` falls back to activeSessionId.
    const result = handleCostUpdate(
      { sessionId: '', sessionCost: 0.5 },
      'active-1',
    )
    expect(result.sessionId).toBe('active-1')
  })
})
