/**
 * Tests for shared stateless message handler functions.
 */
import { describe, it, expect, vi } from 'vitest'
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
  handleInactivityWarning,
  handleMultiQuestionIntervention,
  applyInterventionBuilder,
  handleDevPreview,
  handleDevPreviewStopped,
  handleAuthOk,
  parseConnectedClients,
  handleAuthFail,
  handleKeyExchangeOk,
  handleServerMode,
  handleCheckpointCreated,
  handleCheckpointList,
  handleCheckpointRestored,
  handleError,
  handleSessionError,
  handleSessionStopped,
  handleLogEntry,
  handleClientJoined,
  handleClientLeft,
  handlePrimaryChanged,
  handleSessionRole,
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
  buildSessionListPatches,
  cumulativeUsageEquals,
  chunkSubscribeSessionIds,
  SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
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
  handleAuthBootstrap,
  handleTunnelUrlChanged,
  handleFileList,
  handleDiffResult,
  handleGitStatusResult,
  handleGitBranchesResult,
  handleGitStageResult,
  handleGitCommitResult,
  handleAgentSpawned,
  handleAgentCompleted,
  handleAgentEvent,
  handleBackgroundWorkChanged,
  handleEnvironmentList,
  handleEnvironmentError,
  handleAvailableModels,
  handleMcpServers,
  handleCostUpdate,
  handleSessionUsage,
  handleResultUsage,
  handleServerError,
  handleServerShutdown,
  handleServerStatusLegacy,
  handleWebTaskUpsert,
  applyWebTaskUpsert,
  handleWebTaskError,
  handleWebTaskList,
  handleWebFeatureStatus,
  handleSearchResults,
  handleUserQuestion,
  handleUserInput,
  handleMessage,
  handleToolStart,
  handleToolResult,
  handleToolInputDelta,
  MAX_TOOL_INPUT_PARTIAL_LEN,
  handleStreamStart,
  sharedStreamDelta,
  handleStreamEnd,
  // #5454 — remaining both-sides duplicates
  handleRawOutput,
  handleTokenRotated,
  handlePairFail,
  PAIR_FAIL_MESSAGES,
  handleSessionCostThresholdCrossed,
  handleNotificationPrefs,
  resolvePermissionStreamSplit,
} from './index'
import type { StreamDeltaContext, PendingDelta } from './index'
import { nextMessageId } from '../utils'
import type {
  ActiveTool,
  AgentInfo,
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ConversationSummary,
  CumulativeUsage,
  DevPreview,
  ModelInfo,
  PendingBackgroundShell,
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

  // #4019: description passes through when present + string-typed; non-strings
  // get dropped so the typed shape downstream consumers see stays clean.
  it('preserves the optional description field when present', () => {
    const msg = {
      modes: [
        { id: 'default', label: 'Default', description: 'Prompt for each tool call' },
        { id: 'auto', label: 'Auto Approve', description: 'Skip all prompts' },
      ],
    }
    expect(handleAvailablePermissionModes(msg)).toEqual([
      { id: 'default', label: 'Default', description: 'Prompt for each tool call' },
      { id: 'auto', label: 'Auto Approve', description: 'Skip all prompts' },
    ])
  })

  it('omits description when missing — preserves back-compat with old servers', () => {
    // Pre-#4018 servers didn't ship the field at all. Result must not
    // synthesise an empty string.
    const result = handleAvailablePermissionModes({
      modes: [{ id: 'default', label: 'Default' }],
    })
    expect(result).toEqual([{ id: 'default', label: 'Default' }])
    expect(result?.[0]).not.toHaveProperty('description')
  })

  it('drops non-string descriptions at the type boundary', () => {
    const msg = {
      modes: [
        { id: 'a', label: 'A', description: 42 },          // number
        { id: 'b', label: 'B', description: { x: 1 } },    // object
        { id: 'c', label: 'C', description: null },        // null
      ],
    }
    const result = handleAvailablePermissionModes(msg)
    // All three should pass the validity gate (have id + label) but their
    // description gets stripped because it's not a string.
    expect(result).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ])
    expect(result?.[0]).not.toHaveProperty('description')
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
  it('returns claudeReady: true and clears stoppedAt/stoppedCode (#4879)', () => {
    // #4879 — clearing the stopped marker on claude_ready is what makes
    // the quiet "Session stopped." inline strip auto-dismiss when the
    // server restarts the child after the operator's next input. Both
    // new fields collapse to null end-to-end for sessions that were
    // never stopped, so the patch is safe to broadcast unconditionally.
    expect(handleClaudeReady()).toEqual({
      claudeReady: true,
      stoppedAt: null,
      stoppedCode: null,
    })
  })

  // #5431 — enriched ready: a present `backgroundTasks` array (even empty)
  // is an authoritative transcript snapshot for BOTH new fields; absence
  // leaves stored state untouched (pre-#5431 servers / no transcript).
  it('projects transcript backgroundTasks + scheduledWakeup when present (#5431)', () => {
    const task = { toolUseId: 'toolu_01', kind: 'bash', description: 'Wait for CI checks', startedAt: 1781068000000 }
    expect(handleClaudeReady({
      type: 'claude_ready',
      backgroundTasks: [task],
      scheduledWakeup: { at: 1781068600000, reason: 'watching CI' },
    })).toEqual({
      claudeReady: true,
      stoppedAt: null,
      stoppedCode: null,
      transcriptBackgroundTasks: [task],
      scheduledWakeup: { at: 1781068600000, reason: 'watching CI' },
    })
  })

  it('clears both fields on an explicit empty snapshot (#5431)', () => {
    expect(handleClaudeReady({ type: 'claude_ready', backgroundTasks: [] })).toEqual({
      claudeReady: true,
      stoppedAt: null,
      stoppedCode: null,
      transcriptBackgroundTasks: [],
      scheduledWakeup: null,
    })
  })

  it('leaves the fields absent on a plain ready (#5431 wire-compat)', () => {
    expect(handleClaudeReady({ type: 'claude_ready' })).toEqual({
      claudeReady: true,
      stoppedAt: null,
      stoppedCode: null,
    })
  })

  it('drops malformed task entries instead of throwing (#5431)', () => {
    expect(handleClaudeReady({
      type: 'claude_ready',
      backgroundTasks: [null, 'junk', { toolUseId: 42 }, { toolUseId: 'toolu_02', kind: 'monitor', description: 'tail log', startedAt: 5 }],
      scheduledWakeup: { at: 'soon' },
    })).toEqual({
      claudeReady: true,
      stoppedAt: null,
      stoppedCode: null,
      transcriptBackgroundTasks: [{ toolUseId: 'toolu_02', kind: 'monitor', description: 'tail log', startedAt: 5 }],
      scheduledWakeup: null,
    })
  })
})

// ---------------------------------------------------------------------------
// handleAgentIdle / handleAgentBusy
// ---------------------------------------------------------------------------
describe('handleAgentIdle', () => {
  it('returns isIdle: true and clears streamingMessageId + activeTools', () => {
    // #4308 — agent_idle is a guaranteed turn boundary, so it's also the
    // safety-net clear for activeTools. Any still-tracked in-flight tools
    // (missed result, server crash mid-turn) are dropped so the activity
    // indicator can't get stuck on a phantom "Running X".
    expect(handleAgentIdle()).toEqual({
      isIdle: true,
      streamingMessageId: null,
      activeTools: [],
    })
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
// handleInactivityWarning (#3899)
// ---------------------------------------------------------------------------
describe('handleInactivityWarning', () => {
  it('produces a patch with idleMs, prefab, and receivedAt timestamp', () => {
    const before = Date.now()
    const result = handleInactivityWarning(
      { sessionId: 'sess-1', messageId: 'm-1', idleMs: 1_800_000, prefab: 'Status update?' },
      'active-1',
    )
    const after = Date.now()
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('sess-1')
    const warning = result!.patch.inactivityWarning as { idleMs: number; prefab: string; receivedAt: number }
    expect(warning.idleMs).toBe(1_800_000)
    expect(warning.prefab).toBe('Status update?')
    expect(warning.receivedAt).toBeGreaterThanOrEqual(before)
    expect(warning.receivedAt).toBeLessThanOrEqual(after)
  })

  it('falls back to active session when message has no sessionId', () => {
    const result = handleInactivityWarning(
      { messageId: 'm-1', idleMs: 30_000, prefab: 'Status update?' },
      'active-1',
    )
    expect(result!.sessionId).toBe('active-1')
  })

  it('floors fractional idleMs (server may report sub-ms drift)', () => {
    const result = handleInactivityWarning(
      { idleMs: 1_800_500.7, prefab: 'Status update?' },
      'active-1',
    )
    expect((result!.patch.inactivityWarning as { idleMs: number }).idleMs).toBe(1_800_500)
  })

  it('returns null when idleMs is missing', () => {
    expect(handleInactivityWarning({ prefab: 'Status update?' }, 'active-1')).toBeNull()
  })

  it('returns null when idleMs is non-positive', () => {
    expect(
      handleInactivityWarning({ idleMs: 0, prefab: 'Status update?' }, 'active-1'),
    ).toBeNull()
    expect(
      handleInactivityWarning({ idleMs: -1, prefab: 'Status update?' }, 'active-1'),
    ).toBeNull()
  })

  it('returns null when idleMs floors to zero (sub-1ms values)', () => {
    // 0.5 passes a naive `> 0` check but floors to 0 — the handler
    // floors before the threshold to reject this defence-in-depth case
    // even though the wire schema's `.int()` already prevents it.
    expect(
      handleInactivityWarning({ idleMs: 0.5, prefab: 'Status update?' }, 'active-1'),
    ).toBeNull()
    expect(
      handleInactivityWarning({ idleMs: 0.999, prefab: 'Status update?' }, 'active-1'),
    ).toBeNull()
  })

  it('returns null when idleMs exceeds the 24h sane-duration ceiling', () => {
    const ONE_DAY = 24 * 60 * 60 * 1000
    // Boundary: exactly 24h is allowed (matches Zod's .max(...))
    expect(
      handleInactivityWarning({ idleMs: ONE_DAY, prefab: 'Status update?' }, 'active-1'),
    ).not.toBeNull()
    // 1ms over the ceiling: rejected — same as the wire schema would do
    expect(
      handleInactivityWarning({ idleMs: ONE_DAY + 1, prefab: 'Status update?' }, 'active-1'),
    ).toBeNull()
  })

  it('returns null when idleMs is non-finite', () => {
    expect(
      handleInactivityWarning({ idleMs: Number.POSITIVE_INFINITY, prefab: 'x' }, 'a'),
    ).toBeNull()
    expect(
      handleInactivityWarning({ idleMs: NaN, prefab: 'x' }, 'a'),
    ).toBeNull()
  })

  it('returns null when prefab is missing or blank', () => {
    expect(handleInactivityWarning({ idleMs: 1000 }, 'active-1')).toBeNull()
    expect(handleInactivityWarning({ idleMs: 1000, prefab: '' }, 'a')).toBeNull()
    expect(handleInactivityWarning({ idleMs: 1000, prefab: '   ' }, 'a')).toBeNull()
  })

  it('returns null sessionId when neither explicit nor active is set', () => {
    const result = handleInactivityWarning(
      { idleMs: 1000, prefab: 'Status update?' },
      null,
    )
    expect(result!.sessionId).toBeNull()
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
  // #3112: systemMessage was dropped from the return shape; neither call
  // site consumed it. Tests now assert only the fields callers actually use.
  it('extracts code + message', () => {
    const result = handleError({ code: 'BAD_THING', message: 'Something broke' })
    expect(result.code).toBe('BAD_THING')
    expect(result.message).toBe('Something broke')
  })

  it('strips ANSI escape sequences from message', () => {
    const result = handleError({ message: '[31mred error[0m' })
    expect(result.message).toBe('red error')
  })

  it('falls back to default message when missing or non-string', () => {
    const r1 = handleError({})
    expect(r1.message).toBe('An unexpected server error occurred')

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

  // #4178: surface `fatal` on the typed return so dashboard + app share a
  // single parsed shape rather than each reaching into `msg.fatal` with
  // its own ad-hoc type guard. Default unset (undefined) is treated as
  // fatal by consumers — pin that contract here.
  it('extracts fatal when boolean false', () => {
    expect(handleError({ code: 'MAX_TOOL_ROUNDS_REACHED', fatal: false }).fatal).toBe(false)
  })

  it('extracts fatal when boolean true', () => {
    expect(handleError({ code: 'STREAM_ERROR', fatal: true }).fatal).toBe(true)
  })

  it('leaves fatal undefined when missing', () => {
    expect(handleError({ code: 'WHATEVER' }).fatal).toBeUndefined()
  })

  it('leaves fatal undefined when non-boolean (string "false" must NOT degrade to false)', () => {
    // A typo (msg.fatal: 'false') was the regression risk #4178 calls
    // out. The parser must reject non-boolean and leave fatal=undefined,
    // which downstream treats as fatal — surfacing the bug as a red
    // toast instead of silently downgrading to a warning.
    expect(handleError({ fatal: 'false' as unknown as boolean }).fatal).toBeUndefined()
    expect(handleError({ fatal: 0 as unknown as boolean }).fatal).toBeUndefined()
    expect(handleError({ fatal: null as unknown as boolean }).fatal).toBeUndefined()
  })

  // #5039 — partial-cost passthrough. PR #5037 added optional usage + cost
  // fields to the server's error envelope when the failed turn folded any
  // parent + Task subagent rounds before the error fired. The dashboard
  // toast and mobile alert use the parsed snapshot to render a "this turn
  // cost $X" sub-line; the parser is the single source of truth for the
  // strict-finite gate that decides whether the snapshot is usable.
  describe('partialCost (#5039 — PR #5037 wire passthrough)', () => {
    it('parses cost + usage into the partialCost slot when both present', () => {
      const result = handleError({
        code: 'STREAM_ERROR',
        message: 'stream failed',
        cost: 0.0875,
        usage: {
          input_tokens: 1200,
          output_tokens: 3400,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
        },
      })
      expect(result.partialCost).toEqual({
        costUsd: 0.0875,
        inputTokens: 1200,
        outputTokens: 3400,
        cacheReadTokens: 500,
        cacheCreationTokens: 100,
      })
    })

    it('keeps partialCost when usage is missing (subscription-billed provider)', () => {
      // Subscription-billed providers can produce a cost without a usage
      // breakdown — keep the cost surfaced so the user still sees the
      // failed-turn spend even when the token counters are unavailable.
      const result = handleError({
        code: 'STREAM_ERROR',
        message: 'stream failed',
        cost: 0.05,
      })
      expect(result.partialCost).toEqual({
        costUsd: 0.05,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    })

    it('falls back to null when cost is missing (pre-#5037 wire shape)', () => {
      // Pre-PR #5037 servers don't carry partials; the parser must
      // surface null so consumers can branch on presence without
      // re-implementing the gate.
      expect(handleError({ code: 'STREAM_ERROR', message: 'x' }).partialCost).toBeNull()
    })

    it('rejects NaN / Infinity / negative / non-number cost (matches _trackUsage gate)', () => {
      // Server-side _trackUsage (#5038) only accumulates Number.isFinite
      // costs — mirror that gate here so a provider bug can't poison
      // the partial-cost display either.
      expect(handleError({ cost: NaN }).partialCost).toBeNull()
      expect(handleError({ cost: Infinity }).partialCost).toBeNull()
      expect(handleError({ cost: -0.01 }).partialCost).toBeNull()
      expect(handleError({ cost: '0.05' as unknown as number }).partialCost).toBeNull()
      expect(handleError({ cost: null as unknown as number }).partialCost).toBeNull()
    })

    it('zeroes individual non-finite token fields without losing other counters', () => {
      // Best-effort token parse: a single bad counter (NaN, negative,
      // non-number) drops just that field — the rest of the breakdown
      // still surfaces. Without this, a provider that emits one bogus
      // counter would null the whole partial snapshot.
      const result = handleError({
        cost: 0.02,
        usage: {
          input_tokens: 1000,
          output_tokens: NaN,
          cache_read_input_tokens: -5,
          cache_creation_input_tokens: 'x',
        },
      })
      expect(result.partialCost).toEqual({
        costUsd: 0.02,
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    })

    it('treats non-object usage as empty (zero tokens, cost still surfaced)', () => {
      // A wire-side typo (`usage: 'oops'`) must not poison the cost
      // surface — fall back to zero counters and still render the cost.
      const result = handleError({
        cost: 0.03,
        usage: 'oops' as unknown as Record<string, number>,
      })
      expect(result.partialCost).toEqual({
        costUsd: 0.03,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    })

    it('accepts cost: 0 (free / cache-only turn) and surfaces the snapshot', () => {
      // A 100%-cached turn can still fold a non-zero usage breakdown
      // without billing — the user benefits from seeing those tokens
      // even if the cost is $0.
      const result = handleError({
        cost: 0,
        usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 1000 },
      })
      expect(result.partialCost).toEqual({
        costUsd: 0,
        inputTokens: 50,
        outputTokens: 0,
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
      })
    })
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
    expect(result.sessionPatch).toBeNull()
  })

  it('uses raw msg.message for non-crash, non-bound errors', () => {
    const result = handleSessionError(
      { category: 'rate_limit', message: 'Slow down' },
      null,
    )
    expect(result.message).toBe('Slow down')
    expect(result.sessionPatch).toBeNull()
  })

  it('falls back to "Unknown error" when non-crash has no message', () => {
    const result = handleSessionError({ category: 'rate_limit' }, null)
    expect(result.message).toBe('Unknown error')
  })

  it('falls back to "Unknown error" when message is an empty string', () => {
    const result = handleSessionError(
      { category: 'rate_limit', message: '' },
      null,
    )
    expect(result.message).toBe('Unknown error')
  })

  it('falls back to "Unknown error" when message is whitespace only', () => {
    const result = handleSessionError(
      { category: 'rate_limit', message: '   \t\n  ' },
      null,
    )
    expect(result.message).toBe('Unknown error')
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
// handleSessionStopped (#4879)
// ---------------------------------------------------------------------------
describe('handleSessionStopped', () => {
  const fixedNow = () => 1_700_000_000_000

  it('builds a patch targeting the explicit sessionId with the stopped marker + code', () => {
    const result = handleSessionStopped(
      { sessionId: 'sess-1', code: 143 },
      'active-1',
      fixedNow,
    )
    expect(result).toEqual({
      sessionId: 'sess-1',
      patch: { stoppedAt: 1_700_000_000_000, stoppedCode: 143 },
    })
  })

  it('falls back to active session when sessionId is missing', () => {
    const result = handleSessionStopped({ code: 0 }, 'active-1', fixedNow)
    expect(result.sessionId).toBe('active-1')
    expect(result.patch).toEqual({ stoppedAt: 1_700_000_000_000, stoppedCode: 0 })
  })

  it('preserves code 0 explicitly (clean SIGINT exit is a meaningful signal)', () => {
    const result = handleSessionStopped({ sessionId: 's', code: 0 }, null, fixedNow)
    expect(result.patch.stoppedCode).toBe(0)
  })

  it('returns stoppedCode: null when code is missing on the wire', () => {
    const result = handleSessionStopped({ sessionId: 's' }, null, fixedNow)
    expect(result.patch.stoppedCode).toBeNull()
    expect(result.patch.stoppedAt).toBe(1_700_000_000_000)
  })

  it('returns stoppedCode: null when code is non-integer (defensive)', () => {
    // ServerSessionStoppedSchema enforces integer at the protocol layer
    // (`z.number().int()`), but the handler is also called from
    // untrusted/test paths — collapse anything non-integer to null
    // rather than poisoning stoppedCode with a string, NaN, Infinity,
    // or a fractional value (which would render "exit 1.5" in the UI).
    expect(handleSessionStopped({ code: 'not a number' }, null, fixedNow).patch.stoppedCode).toBeNull()
    expect(handleSessionStopped({ code: null }, null, fixedNow).patch.stoppedCode).toBeNull()
    expect(handleSessionStopped({ code: NaN }, null, fixedNow).patch.stoppedCode).toBeNull()
    expect(handleSessionStopped({ code: Infinity }, null, fixedNow).patch.stoppedCode).toBeNull()
    // Fractional values get the same treatment — the schema is `int()`,
    // not `finite()`, so a buggy producer sending 1.5 must NOT render.
    expect(handleSessionStopped({ code: 1.5 }, null, fixedNow).patch.stoppedCode).toBeNull()
    expect(handleSessionStopped({ code: -0.1 }, null, fixedNow).patch.stoppedCode).toBeNull()
  })

  it('returns sessionId: null when no sessionId on msg AND no active session (broadcast guard semantics handled by caller)', () => {
    const result = handleSessionStopped({ code: 0 }, null, fixedNow)
    expect(result.sessionId).toBeNull()
  })

  it('defaults `now` to Date.now when not injected', () => {
    const before = Date.now()
    const result = handleSessionStopped({ sessionId: 's' }, null)
    const after = Date.now()
    const stoppedAt = result.patch.stoppedAt as number
    expect(typeof stoppedAt).toBe('number')
    expect(stoppedAt).toBeGreaterThanOrEqual(before)
    expect(stoppedAt).toBeLessThanOrEqual(after)
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
      resultTimeoutMs: 45 * 60 * 1000,
      streamStallTimeoutMs: 5 * 60 * 1000,
      encryption: 'required',
      sessionToken: 'tok-abc',
      clientId: 'client-1',
      webFeatures: { available: true, remote: false, teleport: true },
      capabilities: { notificationPrefs: true, somethingElse: false },
      serverPublicKey: 'srv-pub-key',
      serverKeySig: 'srv-key-sig',
      // #5616 — identity-rotation continuity cert.
      newIdentityKey: 'new-id-key',
      rotationCert: 'rotation-cert-sig',
      // #5555 — folded static permission-mode enum.
      availablePermissionModes: [
        { id: 'approve', label: 'Approve' },
        { id: 'auto', label: 'Auto' },
      ],
    })
    expect(result).toEqual({
      serverMode: 'cli',
      sessionCwd: '/home/me',
      defaultCwd: '/home',
      serverVersion: '0.6.12',
      latestVersion: '0.6.13',
      serverCommit: 'abc123',
      protocolVersion: 2,
      resultTimeoutMs: 45 * 60 * 1000,
      streamStallTimeoutMs: 5 * 60 * 1000,
      encryption: 'required',
      sessionToken: 'tok-abc',
      myClientId: 'client-1',
      webFeatures: { available: true, remote: false, teleport: true },
      serverCapabilities: { notificationPrefs: true, somethingElse: false },
      serverPublicKey: 'srv-pub-key',
      serverKeySig: 'srv-key-sig',
      newIdentityKey: 'new-id-key',
      rotationCert: 'rotation-cert-sig',
      availablePermissionModes: [
        { id: 'approve', label: 'Approve' },
        { id: 'auto', label: 'Auto' },
      ],
    })
  })

  // #5555 (eager key exchange) — serverPublicKey carries the server's
  // ephemeral X25519 key on the eager path; null means "fall back to the
  // discrete key_exchange handshake".
  it('extracts serverPublicKey when the server honoured the eager path', () => {
    expect(handleAuthOk({ serverPublicKey: 'abc123' }).serverPublicKey).toBe('abc123')
  })

  it('returns null serverPublicKey when absent, empty, or non-string (discrete fallback)', () => {
    expect(handleAuthOk({}).serverPublicKey).toBeNull()
    expect(handleAuthOk({ serverPublicKey: '' }).serverPublicKey).toBeNull()
    expect(handleAuthOk({ serverPublicKey: 42 }).serverPublicKey).toBeNull()
    expect(handleAuthOk({ serverPublicKey: null }).serverPublicKey).toBeNull()
  })

  // #5616 — identity-rotation continuity-cert fields.
  it('extracts the rotation continuity cert (newIdentityKey + rotationCert)', () => {
    const result = handleAuthOk({ newIdentityKey: 'new-id', rotationCert: 'cert-sig' })
    expect(result.newIdentityKey).toBe('new-id')
    expect(result.rotationCert).toBe('cert-sig')
  })

  it('returns null cert fields when absent, empty, or non-string (un-rotated/old server)', () => {
    expect(handleAuthOk({}).newIdentityKey).toBeNull()
    expect(handleAuthOk({}).rotationCert).toBeNull()
    expect(handleAuthOk({ newIdentityKey: '', rotationCert: '' }).newIdentityKey).toBeNull()
    expect(handleAuthOk({ newIdentityKey: 42, rotationCert: {} }).newIdentityKey).toBeNull()
    expect(handleAuthOk({ newIdentityKey: null, rotationCert: null }).rotationCert).toBeNull()
  })

  it('rejects unknown serverMode values', () => {
    // #4810: 'terminal' was previously accepted but the wire protocol only
    // emits 'cli'; the unreachable branch is now treated as unknown.
    expect(handleAuthOk({ serverMode: 'terminal' }).serverMode).toBeNull()
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

  // #3760 — resultTimeoutMs guard (positive finite number, else null).
  describe('resultTimeoutMs', () => {
    it('passes through positive finite numbers', () => {
      expect(handleAuthOk({ resultTimeoutMs: 1 }).resultTimeoutMs).toBe(1)
      expect(handleAuthOk({ resultTimeoutMs: 45 * 60 * 1000 }).resultTimeoutMs).toBe(45 * 60 * 1000)
    })

    it('rejects 0, negative, non-finite, or non-number values', () => {
      for (const bad of [0, -1, NaN, Infinity, -Infinity, '20m', null, undefined, {}]) {
        expect(handleAuthOk({ resultTimeoutMs: bad }).resultTimeoutMs).toBeNull()
      }
    })

    it('returns null when the field is omitted', () => {
      expect(handleAuthOk({}).resultTimeoutMs).toBeNull()
    })
  })

  // #4497 / #4477 — streamStallTimeoutMs guard. 0 is the protocol's "disabled"
  // sentinel so it must be treated the same as absent (chip falls back to the
  // generic phrase). This was the latent #4766 bug on mobile.
  describe('streamStallTimeoutMs', () => {
    it('passes through positive finite numbers', () => {
      expect(handleAuthOk({ streamStallTimeoutMs: 5 * 60 * 1000 }).streamStallTimeoutMs).toBe(
        5 * 60 * 1000,
      )
    })

    it('rejects 0, negative, non-finite, or non-number values', () => {
      for (const bad of [0, -1, NaN, Infinity, -Infinity, '5m', null, undefined, []]) {
        expect(handleAuthOk({ streamStallTimeoutMs: bad }).streamStallTimeoutMs).toBeNull()
      }
    })

    it('returns null when the field is omitted', () => {
      expect(handleAuthOk({}).streamStallTimeoutMs).toBeNull()
    })
  })

  describe('encryption', () => {
    it('passes through string values verbatim', () => {
      expect(handleAuthOk({ encryption: 'required' }).encryption).toBe('required')
      expect(handleAuthOk({ encryption: 'optional' }).encryption).toBe('optional')
    })

    it('returns null for missing or non-string values', () => {
      expect(handleAuthOk({}).encryption).toBeNull()
      expect(handleAuthOk({ encryption: true }).encryption).toBeNull()
      expect(handleAuthOk({ encryption: 42 }).encryption).toBeNull()
    })
  })

  describe('sessionToken', () => {
    it('extracts string sessionToken (pairing flow)', () => {
      expect(handleAuthOk({ sessionToken: 'tok-xyz' }).sessionToken).toBe('tok-xyz')
    })

    it('returns null when missing or non-string', () => {
      expect(handleAuthOk({}).sessionToken).toBeNull()
      expect(handleAuthOk({ sessionToken: 42 }).sessionToken).toBeNull()
    })
  })

  describe('myClientId', () => {
    it('extracts clientId as myClientId', () => {
      expect(handleAuthOk({ clientId: 'client-1' }).myClientId).toBe('client-1')
    })

    it('returns null when missing or non-string', () => {
      expect(handleAuthOk({}).myClientId).toBeNull()
      expect(handleAuthOk({ clientId: 42 }).myClientId).toBeNull()
    })
  })

  describe('webFeatures', () => {
    it('coerces wire flags to hard booleans', () => {
      const wf = handleAuthOk({
        webFeatures: { available: 1, remote: 'yes', teleport: 0 },
      }).webFeatures
      expect(wf).toEqual({ available: true, remote: true, teleport: false })
    })

    it('defaults to all-false when the field is missing', () => {
      expect(handleAuthOk({}).webFeatures).toEqual({
        available: false,
        remote: false,
        teleport: false,
      })
    })

    it('defaults to all-false when the field is non-object or an array', () => {
      expect(handleAuthOk({ webFeatures: null }).webFeatures).toEqual({
        available: false,
        remote: false,
        teleport: false,
      })
      expect(handleAuthOk({ webFeatures: [] }).webFeatures).toEqual({
        available: false,
        remote: false,
        teleport: false,
      })
      expect(handleAuthOk({ webFeatures: 'true' }).webFeatures).toEqual({
        available: false,
        remote: false,
        teleport: false,
      })
    })

    it('does not share the default object across calls (mutation safety)', () => {
      const a = handleAuthOk({}).webFeatures
      a.available = true
      const b = handleAuthOk({}).webFeatures
      expect(b.available).toBe(false)
    })
  })

  describe('serverCapabilities', () => {
    it('only stores strict-true values (fail-closed)', () => {
      const caps = handleAuthOk({
        capabilities: {
          notificationPrefs: true,
          taggedOnly: 'true',
          falsy: false,
          numeric: 1,
        },
      }).serverCapabilities
      expect(caps).toEqual({
        notificationPrefs: true,
        taggedOnly: false,
        falsy: false,
        numeric: false,
      })
    })

    it('returns empty object when missing or malformed', () => {
      expect(handleAuthOk({}).serverCapabilities).toEqual({})
      expect(handleAuthOk({ capabilities: null }).serverCapabilities).toEqual({})
      expect(handleAuthOk({ capabilities: [] }).serverCapabilities).toEqual({})
      expect(handleAuthOk({ capabilities: 'cap' }).serverCapabilities).toEqual({})
    })

    // Defence-in-depth (#4781 Copilot review): server-supplied keys are
    // untrusted; refuse `__proto__`/`constructor`/`prototype` so a malformed
    // payload can't mutate Object.prototype. JSON.parse'd payloads with
    // these keys become own properties enumerable by Object.entries.
    it('refuses prototype-pollution keys (__proto__, constructor, prototype)', () => {
      const polluted = JSON.parse(
        '{"__proto__": true, "constructor": true, "prototype": true, "ok": true}',
      )
      const caps = handleAuthOk({ capabilities: polluted }).serverCapabilities
      expect(caps).toEqual({ ok: true })
      // Object.prototype must be unchanged after parsing the payload.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  })

  it('returns the hardened defaults payload for an empty message', () => {
    expect(handleAuthOk({})).toEqual({
      serverMode: null,
      sessionCwd: null,
      defaultCwd: null,
      serverVersion: null,
      latestVersion: null,
      serverCommit: null,
      protocolVersion: null,
      resultTimeoutMs: null,
      streamStallTimeoutMs: null,
      encryption: null,
      sessionToken: null,
      myClientId: null,
      webFeatures: { available: false, remote: false, teleport: false },
      serverCapabilities: {},
      serverPublicKey: null,
      serverKeySig: null,
      newIdentityKey: null,
      rotationCert: null,
      availablePermissionModes: null,
    })
  })
})

// ---------------------------------------------------------------------------
// parseConnectedClients (#4766)
// ---------------------------------------------------------------------------
describe('parseConnectedClients', () => {
  it('parses a well-formed roster and marks self via myClientId', () => {
    const result = parseConnectedClients(
      [
        { clientId: 'client-1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos' },
        { clientId: 'client-2', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
      ],
      'client-1',
    )
    expect(result).toEqual([
      {
        clientId: 'client-1',
        deviceName: 'Dashboard',
        deviceType: 'desktop',
        platform: 'macos',
        isSelf: true,
      },
      {
        clientId: 'client-2',
        deviceName: 'Phone',
        deviceType: 'phone',
        platform: 'ios',
        isSelf: false,
      },
    ])
  })

  it('marks no entries as self when myClientId is null', () => {
    const result = parseConnectedClients(
      [{ clientId: 'a', deviceType: 'phone', platform: 'ios' }],
      null,
    )
    expect(result[0].isSelf).toBe(false)
  })

  it('returns [] when rawClients is not an array', () => {
    expect(parseConnectedClients(undefined, 'c1')).toEqual([])
    expect(parseConnectedClients(null, 'c1')).toEqual([])
    expect(parseConnectedClients('clients', 'c1')).toEqual([])
    expect(parseConnectedClients({ clientId: 'oops' }, 'c1')).toEqual([])
  })

  it('drops entries missing a string clientId', () => {
    const result = parseConnectedClients(
      [
        { clientId: 'good', deviceType: 'desktop', platform: 'macos' },
        { clientId: 42, deviceType: 'desktop' },
        { deviceType: 'desktop' },
        null,
        'not-an-object',
      ],
      'good',
    )
    expect(result).toHaveLength(1)
    expect(result[0].clientId).toBe('good')
  })

  it('falls back deviceType to "unknown" for malformed/unknown values', () => {
    const result = parseConnectedClients(
      [
        { clientId: 'a', deviceType: 'space-station' },
        { clientId: 'b', deviceType: 42 },
        { clientId: 'c' },
      ],
      null,
    )
    expect(result.map((c) => c.deviceType)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('falls back deviceName=null and platform="unknown" when missing/non-string', () => {
    const result = parseConnectedClients(
      [{ clientId: 'a' }, { clientId: 'b', deviceName: 42, platform: false }],
      null,
    )
    expect(result[0].deviceName).toBeNull()
    expect(result[0].platform).toBe('unknown')
    expect(result[1].deviceName).toBeNull()
    expect(result[1].platform).toBe('unknown')
  })

  it('accepts every valid deviceType variant', () => {
    const variants = ['phone', 'tablet', 'desktop', 'unknown'] as const
    const result = parseConnectedClients(
      variants.map((dt, i) => ({ clientId: `c${i}`, deviceType: dt })),
      null,
    )
    expect(result.map((c) => c.deviceType)).toEqual([...variants])
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
  // #5616 — the no-cert baseline shape (all four keys, cert fields null).
  const NO_CERT = { newIdentityKey: null, rotationCert: null }

  it('extracts publicKey string', () => {
    expect(handleKeyExchangeOk({ publicKey: 'base64key==' })).toEqual({
      publicKey: 'base64key==',
      serverKeySig: null,
      ...NO_CERT,
    })
  })

  it('returns null publicKey when missing', () => {
    expect(handleKeyExchangeOk({})).toEqual({ publicKey: null, serverKeySig: null, ...NO_CERT })
  })

  it('returns null publicKey for non-string values', () => {
    // Matches inline guard: `if (!msg.publicKey || typeof msg.publicKey !== 'string')`
    expect(handleKeyExchangeOk({ publicKey: 42 })).toEqual({ publicKey: null, serverKeySig: null, ...NO_CERT })
    expect(handleKeyExchangeOk({ publicKey: null })).toEqual({ publicKey: null, serverKeySig: null, ...NO_CERT })
    expect(handleKeyExchangeOk({ publicKey: '' })).toEqual({ publicKey: null, serverKeySig: null, ...NO_CERT })
  })

  it('#5536 — extracts the serverKeySig when present', () => {
    expect(handleKeyExchangeOk({ publicKey: 'pk==', serverKeySig: 'sig==' })).toEqual({
      publicKey: 'pk==',
      serverKeySig: 'sig==',
      ...NO_CERT,
    })
  })

  it('#5536 — null serverKeySig for missing / empty / non-string', () => {
    expect(handleKeyExchangeOk({ publicKey: 'pk==', serverKeySig: '' }).serverKeySig).toBe(null)
    expect(handleKeyExchangeOk({ publicKey: 'pk==', serverKeySig: 42 }).serverKeySig).toBe(null)
  })

  it('#5616 — extracts the rotation cert on the discrete path', () => {
    expect(
      handleKeyExchangeOk({ publicKey: 'pk==', newIdentityKey: 'new-id', rotationCert: 'cert==' }),
    ).toEqual({ publicKey: 'pk==', serverKeySig: null, newIdentityKey: 'new-id', rotationCert: 'cert==' })
  })

  it('#5616 — null cert fields for missing / empty / non-string', () => {
    expect(handleKeyExchangeOk({ publicKey: 'pk==' }).newIdentityKey).toBe(null)
    expect(handleKeyExchangeOk({ publicKey: 'pk==', newIdentityKey: '' }).newIdentityKey).toBe(null)
    expect(handleKeyExchangeOk({ publicKey: 'pk==', rotationCert: 99 }).rotationCert).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// handleServerMode
// ---------------------------------------------------------------------------
describe('handleServerMode', () => {
  it('extracts cli mode', () => {
    expect(handleServerMode({ mode: 'cli' })).toEqual({ mode: 'cli' })
  })

  it('returns null for unknown mode (caller surfaces an alert)', () => {
    // #4810: 'terminal' was previously accepted but is now treated as unknown
    // since the wire protocol only emits 'cli'.
    expect(handleServerMode({ mode: 'terminal' })).toEqual({ mode: null })
    expect(handleServerMode({ mode: 'bogus' })).toEqual({ mode: null })
    expect(handleServerMode({ mode: 42 })).toEqual({ mode: null })
    expect(handleServerMode({})).toEqual({ mode: null })
  })
})

// ---------------------------------------------------------------------------
// handleCheckpointRestored
// ---------------------------------------------------------------------------
describe('handleCheckpointRestored', () => {
  it('extracts trimmed newSessionId (defaults filesOnly true)', () => {
    expect(handleCheckpointRestored({ newSessionId: 'sess-new' })).toEqual({
      newSessionId: 'sess-new',
      filesOnly: true,
    })
  })

  it('trims whitespace from newSessionId', () => {
    expect(
      handleCheckpointRestored({ newSessionId: '  sess-trim  ' }),
    ).toEqual({ newSessionId: 'sess-trim', filesOnly: true })
  })

  // #6766: the flag lets the client describe the restore truthfully.
  it('carries filesOnly:false when the server branched the conversation', () => {
    expect(
      handleCheckpointRestored({ newSessionId: 'sess-new', filesOnly: false }),
    ).toEqual({ newSessionId: 'sess-new', filesOnly: false })
  })

  it('carries filesOnly:true when the server reports a files-only restore', () => {
    expect(
      handleCheckpointRestored({ newSessionId: 'sess-new', filesOnly: true }),
    ).toEqual({ newSessionId: 'sess-new', filesOnly: true })
  })

  it('defaults filesOnly to true when the field is a non-boolean', () => {
    expect(
      handleCheckpointRestored({ newSessionId: 'sess-new', filesOnly: 'yes' }),
    ).toEqual({ newSessionId: 'sess-new', filesOnly: true })
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

  it('preserves the always-on audit level (#6001), not coercing it to info', () => {
    // The server's shell-audit trail is emitted at level 'audit'; the dashboard
    // must keep it first-class (filterable / distinctly badged), not flatten it.
    expect(handleLogEntry({ level: 'audit' }).entry.level).toBe('audit')
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
// handleSessionRole (#5589 / #5281)
// ---------------------------------------------------------------------------
describe('handleSessionRole', () => {
  it('derives primary when the primary is THIS client', () => {
    expect(
      handleSessionRole({ sessionId: 's1', primaryClientId: 'me' }, 'me'),
    ).toEqual({ sessionId: 's1', primaryClientId: 'me', role: 'primary' })
  })

  it('derives observer when another client is primary', () => {
    expect(
      handleSessionRole({ sessionId: 's1', primaryClientId: 'other' }, 'me'),
    ).toEqual({ sessionId: 's1', primaryClientId: 'other', role: 'observer' })
  })

  it('derives unclaimed when primaryClientId is null (nobody-until-claim)', () => {
    expect(
      handleSessionRole({ sessionId: 's1', primaryClientId: null }, 'me'),
    ).toEqual({ sessionId: 's1', primaryClientId: null, role: 'unclaimed' })
  })

  it('derives unclaimed when primaryClientId is missing', () => {
    expect(handleSessionRole({ sessionId: 's1' }, 'me')).toEqual({
      sessionId: 's1',
      primaryClientId: null,
      role: 'unclaimed',
    })
  })

  it('treats a known primary as observer when own id is unknown (pre-auth race)', () => {
    expect(
      handleSessionRole({ sessionId: 's1', primaryClientId: 'other' }, null),
    ).toEqual({ sessionId: 's1', primaryClientId: 'other', role: 'observer' })
  })

  it('stays unclaimed when own id is unknown and the slot is empty', () => {
    expect(
      handleSessionRole({ sessionId: 's1', primaryClientId: null }, null),
    ).toEqual({ sessionId: 's1', primaryClientId: null, role: 'unclaimed' })
  })

  it('returns null sessionId when missing or non-string', () => {
    expect(handleSessionRole({ primaryClientId: 'me' }, 'me')).toEqual({
      sessionId: null,
      primaryClientId: 'me',
      role: 'primary',
    })
    expect(
      handleSessionRole({ sessionId: 42, primaryClientId: 'me' }, 'me'),
    ).toEqual({ sessionId: null, primaryClientId: 'me', role: 'primary' })
  })

  it('returns null primaryClientId when non-string', () => {
    expect(
      handleSessionRole({ sessionId: 's1', primaryClientId: 42 }, 'me'),
    ).toEqual({ sessionId: 's1', primaryClientId: null, role: 'unclaimed' })
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
// cumulativeUsageEquals
// ---------------------------------------------------------------------------
describe('cumulativeUsageEquals', () => {
  const base: CumulativeUsage = {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    costUsd: 0.12,
    turnsBilled: 3,
  }

  it('returns true when both snapshots match across all six fields', () => {
    expect(cumulativeUsageEquals(base, { ...base })).toBe(true)
  })

  it('returns false when any single field differs', () => {
    expect(cumulativeUsageEquals(base, { ...base, inputTokens: 101 })).toBe(false)
    expect(cumulativeUsageEquals(base, { ...base, outputTokens: 51 })).toBe(false)
    expect(cumulativeUsageEquals(base, { ...base, cacheReadTokens: 11 })).toBe(false)
    expect(cumulativeUsageEquals(base, { ...base, cacheCreationTokens: 6 })).toBe(false)
    expect(cumulativeUsageEquals(base, { ...base, costUsd: 0.13 })).toBe(false)
    expect(cumulativeUsageEquals(base, { ...base, turnsBilled: 4 })).toBe(false)
  })

  it('returns false when either side is null or undefined', () => {
    // Preserves the prior inline `current && ...` guard — null `current`
    // falls through and the candidate snapshot is applied as a no-op write.
    expect(cumulativeUsageEquals(null, base)).toBe(false)
    expect(cumulativeUsageEquals(base, null)).toBe(false)
    expect(cumulativeUsageEquals(null, null)).toBe(false)
    expect(cumulativeUsageEquals(undefined, base)).toBe(false)
    expect(cumulativeUsageEquals(base, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildSessionListPatches (#4767)
// ---------------------------------------------------------------------------
describe('buildSessionListPatches', () => {
  const makeSession = (
    sessionId: string,
    overrides: Partial<SessionInfo> = {},
  ): SessionInfo => ({
    sessionId,
    name: sessionId,
    cwd: '/tmp',
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 1000,
    conversationId: null,
    ...overrides,
  })

  it('returns null when handleSessionList rejects the message', () => {
    expect(buildSessionListPatches({}, [], null)).toBeNull()
    expect(buildSessionListPatches({ sessions: 'nope' }, [], null)).toBeNull()
  })

  it('exposes the parsed sessionList by reference', () => {
    const sessions = [makeSession('s1')]
    const out = buildSessionListPatches({ sessions }, [], null)
    expect(out).not.toBeNull()
    expect(out!.sessionList).toBe(sessions)
  })

  it('computes removedIds for sessions that dropped out of the snapshot', () => {
    const sessions = [makeSession('s2'), makeSession('s3')]
    const out = buildSessionListPatches({ sessions }, ['s1', 's2', 's3', 's4'], null)
    expect(out!.removedIds).toEqual(['s1', 's4'])
  })

  it('preserves prevSessionStateIds order in removedIds (matches both prior inline loops)', () => {
    const sessions = [makeSession('s3')]
    const out = buildSessionListPatches({ sessions }, ['s1', 's2', 's3', 's4'], null)
    expect(out!.removedIds).toEqual(['s1', 's2', 's4'])
  })

  it('returns empty removedIds when nothing was removed', () => {
    const sessions = [makeSession('s1'), makeSession('s2')]
    const out = buildSessionListPatches({ sessions }, ['s1'], null)
    expect(out!.removedIds).toEqual([])
  })

  it('lists new sessions not present in prevSessionStateIds in snapshot order', () => {
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')]
    const out = buildSessionListPatches({ sessions }, ['s2'], null)
    expect(out!.newSessionIds).toEqual(['s1', 's3'])
  })

  it('handles fully fresh state (empty prev, all sessions new)', () => {
    const sessions = [makeSession('s1'), makeSession('s2')]
    const out = buildSessionListPatches({ sessions }, [], null)
    expect(out!.newSessionIds).toEqual(['s1', 's2'])
    expect(out!.removedIds).toEqual([])
  })

  it('skips malformed entries without sessionId (fail-soft)', () => {
    // Behaviour-preserving: the prior inline loops dereference s.sessionId
    // directly. Skipping silently here keeps the helper defensive against
    // hypothetical future server bugs that the prior code would have
    // crashed on.
    const sessions = [
      makeSession('s1'),
      null as unknown as SessionInfo,
      { foo: 'bar' } as unknown as SessionInfo,
      makeSession('s2'),
    ]
    const out = buildSessionListPatches({ sessions }, [], null)
    expect(out!.newSessionIds).toEqual(['s1', 's2'])
    expect(out!.backgroundShellBuilders.size).toBe(2)
  })

  it('emits conversationIdPatches for every session with a truthy conversationId', () => {
    const sessions = [
      makeSession('s1', { conversationId: 'conv-1' }),
      makeSession('s2', { conversationId: null }),
      makeSession('s3', { conversationId: 'conv-3' }),
    ]
    const out = buildSessionListPatches({ sessions }, [], null)
    expect(out!.conversationIdPatches.get('s1')).toBe('conv-1')
    expect(out!.conversationIdPatches.has('s2')).toBe(false)
    expect(out!.conversationIdPatches.get('s3')).toBe('conv-3')
  })

  it('emits cumulativeUsagePatches for every session with a defined cumulativeUsage snapshot', () => {
    const usage: CumulativeUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.5,
      turnsBilled: 6,
    }
    const sessions = [
      makeSession('s1', { cumulativeUsage: usage }),
      makeSession('s2'), // no cumulativeUsage field
    ]
    const out = buildSessionListPatches({ sessions }, [], null)
    expect(out!.cumulativeUsagePatches.get('s1')).toBe(usage)
    expect(out!.cumulativeUsagePatches.has('s2')).toBe(false)
  })

  it('emits backgroundShellBuilders for every session (default empty pending list)', () => {
    const sessions = [
      makeSession('s1', {
        pendingBackgroundShells: [
          { shellId: 'sh1', command: 'sleep 1', startedAt: 1000 },
        ],
      }),
      makeSession('s2'), // omitted field → empty list
    ]
    const out = buildSessionListPatches({ sessions }, [], null)
    expect(out!.backgroundShellBuilders.size).toBe(2)
    const s1Builder = out!.backgroundShellBuilders.get('s1')!
    expect(s1Builder.sessionId).toBe('s1')
    const s1Applied = s1Builder.applyTo([])
    expect(s1Applied).toEqual([
      { shellId: 'sh1', command: 'sleep 1', startedAt: 1000 },
    ])
    const s2Builder = out!.backgroundShellBuilders.get('s2')!
    // Empty pending list → applyTo on empty current returns existing
    // empty array (reference-equality short-circuit).
    const empty: PendingBackgroundShell[] = []
    expect(s2Builder.applyTo(empty)).toBe(empty)
  })

  it('chunks non-active session ids into subscribeChunks of SESSION_LIST_SUBSCRIBE_CHUNK_SIZE', () => {
    // Active id is excluded; remaining ids are sliced into batches.
    const total = SESSION_LIST_SUBSCRIBE_CHUNK_SIZE + 5 // active + (chunk_size + 4) non-active
    const sessions = Array.from({ length: total }, (_, i) =>
      makeSession(`s${i + 1}`),
    )
    const out = buildSessionListPatches({ sessions }, [], 's1')
    expect(out!.subscribeChunks).toHaveLength(2)
    expect(out!.subscribeChunks[0]).toHaveLength(SESSION_LIST_SUBSCRIBE_CHUNK_SIZE)
    expect(out!.subscribeChunks[1]).toHaveLength(4)
    // Active id must not appear in any chunk.
    const flat = out!.subscribeChunks.flat()
    expect(flat).not.toContain('s1')
  })

  it('returns empty subscribeChunks when no non-active ids remain', () => {
    const sessions = [makeSession('s1')]
    const out = buildSessionListPatches({ sessions }, [], 's1')
    expect(out!.subscribeChunks).toEqual([])
  })

  it('returns empty subscribeChunks when sessionList is empty (auto-resume path)', () => {
    const out = buildSessionListPatches({ sessions: [] }, ['s1', 's2'], 's1')
    expect(out!.sessionList).toEqual([])
    expect(out!.removedIds).toEqual(['s1', 's2'])
    expect(out!.subscribeChunks).toEqual([])
  })

  it('respects custom subscribeChunkSize, falls back to default on invalid input', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => makeSession(`s${i + 1}`))
    const out = buildSessionListPatches({ sessions }, [], 's1', 3)
    // 6 non-active ids / chunk_size 3 → 2 full chunks
    expect(out!.subscribeChunks.map((c) => c.length)).toEqual([3, 3])
    // Invalid sizes fall back to the constant default (would all fit in one chunk here).
    const out2 = buildSessionListPatches({ sessions }, [], 's1', 0)
    expect(out2!.subscribeChunks).toHaveLength(1)
    expect(out2!.subscribeChunks[0]).toHaveLength(6)
  })

  it('chunkSubscribeSessionIds: filters out active id and chunks by size', () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      makeSession(`s${i + 1}`),
    )
    expect(chunkSubscribeSessionIds(sessions, 's1', 3).map((c) => c.length)).toEqual([3, 3])
    // No active filter when activeSessionId is null.
    expect(chunkSubscribeSessionIds(sessions, null, 3).map((c) => c.length)).toEqual([3, 3, 1])
    // Empty when only the active id is present.
    expect(chunkSubscribeSessionIds([makeSession('s1')], 's1')).toEqual([])
    // Skips malformed entries fail-soft.
    const malformed = [
      makeSession('s1'),
      null as unknown as SessionInfo,
      makeSession('s2'),
    ]
    expect(chunkSubscribeSessionIds(malformed, 's1')).toEqual([['s2']])
  })

  it('chunkSubscribeSessionIds: clamps chunk size to SESSION_LIST_SUBSCRIBE_CHUNK_SIZE', () => {
    // 25 non-active sessions; caller requests chunk of 100 → clamped to 20
    // so the server's SubscribeSessionsSchema.max(20) never sees a bigger chunk.
    const sessions = Array.from({ length: 26 }, (_, i) => makeSession(`s${i + 1}`))
    const chunks = chunkSubscribeSessionIds(sessions, 's1', 100)
    expect(chunks.map((c) => c.length)).toEqual([SESSION_LIST_SUBSCRIBE_CHUNK_SIZE, 5])
    // Exact match: requesting the cap explicitly behaves the same as the default.
    expect(chunkSubscribeSessionIds(sessions, 's1', SESSION_LIST_SUBSCRIBE_CHUNK_SIZE)).toEqual(
      chunkSubscribeSessionIds(sessions, 's1'),
    )
  })

  it('chunkSubscribeSessionIds: coerces non-integer chunk sizes via Math.floor', () => {
    // 7 non-active ids; chunk 2.5 → floor(2.5) = 2 → ceil(7/2) = 4 chunks
    const sessions = Array.from({ length: 8 }, (_, i) => makeSession(`s${i + 1}`))
    const chunks = chunkSubscribeSessionIds(sessions, 's1', 2.5)
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 2, 1])
    // No element duplicated and no element skipped.
    expect(chunks.flat()).toEqual(['s2', 's3', 's4', 's5', 's6', 's7', 's8'])
  })

  it('chunkSubscribeSessionIds: rejects invalid chunk sizes (≤0, NaN, ∞, sub-1 floats)', () => {
    const sessions = Array.from({ length: 6 }, (_, i) => makeSession(`s${i + 1}`))
    // 0, negative, NaN, Infinity all fall back to the default constant.
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const chunks = chunkSubscribeSessionIds(sessions, 's1', bad)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toHaveLength(5) // 6 sessions - 1 active = 5 ids
    }
    // 0.5 → floor → 0 → fallback to default.
    const subOne = chunkSubscribeSessionIds(sessions, 's1', 0.5)
    expect(subOne).toHaveLength(1)
    expect(subOne[0]).toHaveLength(5)
  })

  it('includes the active session in cumulativeUsage / conversationId / backgroundShell maps', () => {
    // The subscribeChunks filter excludes the active id, but the patch
    // maps must include it — both clients update the active session's
    // sessionStates entry the same way as any other.
    const sessions = [
      makeSession('s1', {
        conversationId: 'conv-1',
        cumulativeUsage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          turnsBilled: 1,
        },
      }),
    ]
    const out = buildSessionListPatches({ sessions }, ['s1'], 's1')
    expect(out!.conversationIdPatches.get('s1')).toBe('conv-1')
    expect(out!.cumulativeUsagePatches.has('s1')).toBe(true)
    expect(out!.backgroundShellBuilders.has('s1')).toBe(true)
    // s1 is active → excluded from subscribe chunks.
    expect(out!.subscribeChunks).toEqual([])
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
      latestSeq: null,
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
      latestSeq: null,
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

  // #5555.3 — latestSeq cursor advancement.
  it('parses a finite numeric latestSeq', () => {
    expect(handleHistoryReplayStart({ latestSeq: 42 }, null).latestSeq).toBe(42)
    expect(handleHistoryReplayStart({ latestSeq: 0 }, null).latestSeq).toBe(0)
  })

  it('returns null latestSeq when absent or non-finite (older server / bad value)', () => {
    expect(handleHistoryReplayStart({}, null).latestSeq).toBeNull()
    expect(handleHistoryReplayStart({ latestSeq: NaN }, null).latestSeq).toBeNull()
    expect(handleHistoryReplayStart({ latestSeq: '5' }, null).latestSeq).toBeNull()
    expect(handleHistoryReplayStart({ latestSeq: Infinity }, null).latestSeq).toBeNull()
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

  it('rejects array input (#3123 — type guard now excludes arrays)', () => {
    // Updated guard: `!Array.isArray(msg.input)` — arrays no longer satisfy
    // the object check. This aligns the runtime guard with the declared
    // `Record<string, unknown> | null` return type.
    const arr = [1, 2, 3]
    const result = handlePermissionRequest({ requestId: 'r', input: arr })
    expect(result.input).toBeNull()
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
      cwd: '/repo',
      model: 'sonnet-4-5',
      permissionMode: 'approve',
      errorCode: 'NO_API_KEY',
      errorMessage: 'API key missing',
      historyLength: 2,
    })
    expect(result.sessionId).toBe('sess-1')
    expect(result.name).toBe('Editor')
    expect(result.provider).toBe('claude')
    expect(result.cwd).toBe('/repo')
    expect(result.model).toBe('sonnet-4-5')
    expect(result.permissionMode).toBe('approve')
    expect(result.errorCode).toBe('NO_API_KEY')
    expect(result.errorMessage).toBe('API key missing')
    expect(result.historyLength).toBe(2)
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
      cwd: 123,
      model: null,
      permissionMode: true,
      errorCode: null,
      errorMessage: 99,
      historyLength: '2',
    })
    expect(result.sessionId).toBeNull()
    expect(result.name).toBeNull()
    expect(result.provider).toBeNull()
    expect(result.cwd).toBeNull()
    expect(result.model).toBeNull()
    expect(result.permissionMode).toBeNull()
    expect(result.errorCode).toBeNull()
    expect(result.errorMessage).toBeNull()
    expect(result.historyLength).toBeNull()
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
      requestId: null,
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
      requestId: null,
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
      requestId: null,
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
      requestId: null,
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
      requestId: null,
    })
  })

  it('preserves empty-string content verbatim', () => {
    // Empty string is still a string and passes through (matches inline guard).
    expect(handleFileContent({ content: '' }).content).toBe('')
  })

  it('#6502 — echoes the request nonce when present', () => {
    expect(handleFileContent({ path: '/f.ts', content: 'x', requestId: '42' }).requestId).toBe('42')
  })

  it('#6502 — coerces a missing/non-string requestId to null', () => {
    expect(handleFileContent({}).requestId).toBe(null)
    expect(handleFileContent({ requestId: 7 }).requestId).toBe(null)
    expect(handleFileContent({ requestId: null }).requestId).toBe(null)
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
// handleAuthBootstrap (#5555)
// ---------------------------------------------------------------------------
describe('handleAuthBootstrap', () => {
  it('extracts all three lists + sessionId', () => {
    const providers = [{ name: 'anthropic' }]
    const slashCommands = [{ name: 'clear', source: 'builtin' }]
    const agents = [{ name: 'reviewer', source: 'project' }]
    expect(
      handleAuthBootstrap({ type: 'auth_bootstrap', providers, slashCommands, agents, sessionId: 'sess-1' }),
    ).toEqual({ providers, slashCommands, agents, sessionId: 'sess-1', tunnelUrl: null })
  })

  it('defaults each missing list to [] and sessionId to null', () => {
    expect(handleAuthBootstrap({ type: 'auth_bootstrap' })).toEqual({
      providers: [],
      slashCommands: [],
      agents: [],
      sessionId: null,
      tunnelUrl: null,
    })
  })

  it('coerces non-array lists to [] independently (partial-compute tolerance)', () => {
    expect(
      handleAuthBootstrap({ providers: [{ name: 'x' }], slashCommands: 'oops', agents: null }),
    ).toEqual({ providers: [{ name: 'x' }], slashCommands: [], agents: [], sessionId: null, tunnelUrl: null })
  })

  it('treats empty/non-string sessionId as null', () => {
    expect(handleAuthBootstrap({ sessionId: '' }).sessionId).toBeNull()
    expect(handleAuthBootstrap({ sessionId: 42 as unknown as string }).sessionId).toBeNull()
  })

  it('#5555 (sub-item 7): extracts a wss tunnelUrl, else null', () => {
    expect(handleAuthBootstrap({ tunnelUrl: 'wss://abc.trycloudflare.com' }).tunnelUrl).toBe(
      'wss://abc.trycloudflare.com',
    )
    expect(handleAuthBootstrap({ tunnelUrl: '' }).tunnelUrl).toBeNull()
    expect(handleAuthBootstrap({ tunnelUrl: 42 as unknown as string }).tunnelUrl).toBeNull()
    expect(handleAuthBootstrap({}).tunnelUrl).toBeNull()
    // Rejects a non-wss scheme — the parser only ever yields a secure endpoint.
    expect(handleAuthBootstrap({ tunnelUrl: 'ws://evil.example' }).tunnelUrl).toBeNull()
    expect(handleAuthBootstrap({ tunnelUrl: 'http://nope' }).tunnelUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleTunnelUrlChanged (#5555 sub-item 7)
// ---------------------------------------------------------------------------
describe('handleTunnelUrlChanged', () => {
  it('extracts url + previousUrl when both present', () => {
    expect(
      handleTunnelUrlChanged({
        type: 'tunnel_url_changed',
        url: 'wss://new.trycloudflare.com',
        previousUrl: 'wss://old.trycloudflare.com',
      }),
    ).toEqual({ url: 'wss://new.trycloudflare.com', previousUrl: 'wss://old.trycloudflare.com' })
  })

  it('previousUrl defaults to null when missing or non-string', () => {
    expect(handleTunnelUrlChanged({ url: 'wss://new.example' })).toEqual({
      url: 'wss://new.example',
      previousUrl: null,
    })
    expect(
      handleTunnelUrlChanged({ url: 'wss://new.example', previousUrl: 42 as unknown as string })!.previousUrl,
    ).toBeNull()
  })

  it('returns null when url is missing or non-string (caller skips the apply)', () => {
    expect(handleTunnelUrlChanged({ type: 'tunnel_url_changed' })).toBeNull()
    expect(handleTunnelUrlChanged({ url: '' })).toBeNull()
    expect(handleTunnelUrlChanged({ url: 99 as unknown as string })).toBeNull()
  })

  it('rejects a non-wss url and drops a non-wss previousUrl', () => {
    // A bogus scheme on `url` means the whole push is skipped.
    expect(handleTunnelUrlChanged({ url: 'ws://evil.example' })).toBeNull()
    expect(handleTunnelUrlChanged({ url: 'http://nope' })).toBeNull()
    // A valid wss `url` with a non-wss `previousUrl` keeps the url, drops prev.
    expect(
      handleTunnelUrlChanged({ url: 'wss://new.example', previousUrl: 'ws://old.example' }),
    ).toEqual({ url: 'wss://new.example', previousUrl: null })
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
  // #3132: per-element validation added — entries must conform to the
  // canonical `DiffFile` shape (path/status/additions/deletions/hunks).
  // Malformed entries are dropped fail-soft.
  it('extracts well-formed file entries', () => {
    const files = [
      {
        path: 'a.txt',
        status: 'modified',
        additions: 1,
        deletions: 0,
        hunks: [],
      },
    ]
    const result = handleDiffResult({ files, error: null })
    expect(result.files).toEqual(files)
    expect(result.error).toBeNull()
  })

  it('drops malformed entries fail-soft (#3132)', () => {
    // Suppress the debug-log spam from validateGitElements during this test.
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const files = [
      {
        path: 'good.txt',
        status: 'added',
        additions: 0,
        deletions: 0,
        hunks: [],
      },
      // Missing required `status`
      { path: 'bad.txt', additions: 1, deletions: 0, hunks: [] },
      // Wrong `status` enum
      {
        path: 'bad2.txt',
        status: 'invalid',
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    ]
    const result = handleDiffResult({ files })
    expect(result.files.length).toBe(1)
    expect(result.files[0].path).toBe('good.txt')
    debugSpy.mockRestore()
  })

  // #3184: aggregate the per-element drop logs into ONE bounded log per
  // payload. A pathological case (1000-file diff where every entry is
  // malformed because of a server-side regression) previously emitted 1000
  // console.debug lines per `diff_result` event; the new contract emits a
  // single line per call with the drop count.
  it('emits a single aggregated debug log per payload, not one per dropped element (#3184)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    // Construct 50 malformed entries — without the aggregation fix this
    // would emit 50 console.debug calls.
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `bad${i}.txt`, // missing status
      additions: 0,
      deletions: 0,
      hunks: [],
    }))
    handleDiffResult({ files })

    expect(debugSpy).toHaveBeenCalledTimes(1)
    // The single line must carry the count and total so an operator can see
    // the failure scope at a glance.
    const message = debugSpy.mock.calls[0]?.[0] as string
    expect(message).toMatch(/handleDiffResult\.files/)
    expect(message).toMatch(/50.*50|50\/50/)
    debugSpy.mockRestore()
  })

  it('does not log when every element is valid (#3184)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    handleDiffResult({
      files: [
        { path: 'a.txt', status: 'added', additions: 0, deletions: 0, hunks: [] },
        { path: 'b.txt', status: 'modified', additions: 1, deletions: 1, hunks: [] },
      ],
    })
    expect(debugSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
  })

  it('does not log on empty input arrays (#3184)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    handleDiffResult({ files: [] })
    expect(debugSpy).not.toHaveBeenCalled()
    debugSpy.mockRestore()
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
  // #3132: per-element validation added — `staged`/`unstaged` entries must
  // conform to `GitFileStatus` (path + valid status enum). `untracked` is
  // validated as `string[]`. Malformed entries are dropped fail-soft.
  it('extracts all fields from a valid payload', () => {
    expect(
      handleGitStatusResult({
        branch: 'main',
        staged: [{ path: 'a', status: 'modified' }],
        unstaged: [{ path: 'b', status: 'added' }],
        untracked: ['c'],
        error: null,
      }),
    ).toEqual({
      branch: 'main',
      staged: [{ path: 'a', status: 'modified' }],
      unstaged: [{ path: 'b', status: 'added' }],
      untracked: ['c'],
      error: null,
    })
  })

  it('drops malformed staged/unstaged/untracked entries fail-soft (#3132)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const result = handleGitStatusResult({
      branch: 'main',
      staged: [
        { path: 'good', status: 'modified' },
        { path: 'bad-no-status' }, // missing status
        { path: 'bad-status', status: 'invalid' }, // bad enum
        'not-an-object', // wrong type entirely
      ],
      unstaged: [],
      untracked: ['ok', 42, null, 'also-ok'],
    })
    expect(result.staged.length).toBe(1)
    expect(result.staged[0]).toEqual({ path: 'good', status: 'modified' })
    expect(result.untracked).toEqual(['ok', 'also-ok'])
    debugSpy.mockRestore()
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
  // #3132: per-element validation added — `branches` entries must conform
  // to `GitBranch` (name + isCurrent + isRemote booleans). Malformed
  // entries are dropped fail-soft.
  it('extracts all fields from a valid payload', () => {
    const branches = [
      { name: 'main', isCurrent: true, isRemote: false },
      { name: 'feat/x', isCurrent: false, isRemote: false },
    ]
    expect(
      handleGitBranchesResult({ branches, currentBranch: 'main', error: null }),
    ).toEqual({ branches, currentBranch: 'main', error: null })
  })

  it('drops malformed branch entries fail-soft (#3132)', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const result = handleGitBranchesResult({
      branches: [
        { name: 'good', isCurrent: false, isRemote: false },
        { name: 'no-flags' }, // missing isCurrent/isRemote
        'not-an-object',
      ],
    })
    expect(result.branches.length).toBe(1)
    expect(result.branches[0].name).toBe('good')
    debugSpy.mockRestore()
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
// #5016 — handleAgentEvent (Task subagent nested progress)
// ---------------------------------------------------------------------------
describe('handleAgentEvent (#5016)', () => {
  const mkTaskBubble = (toolUseId: string): ChatMessage => ({
    id: 'm-' + toolUseId,
    type: 'tool_use',
    content: '',
    tool: 'Task',
    toolUseId,
    timestamp: 1000,
  })

  it('appends a child event to the parent Task tool_use bubble', () => {
    const existing: ChatMessage[] = [mkTaskBubble('tu-task-1')]
    const builder = handleAgentEvent(
      {
        sessionId: 'sess-1',
        parentToolUseId: 'tu-task-1',
        eventType: 'tool_start',
        payload: { toolUseId: 'tu-child-1', tool: 'Read', input: { file_path: '/a' } },
      },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-1')
    const next = builder.applyTo(existing)
    expect(next).not.toBe(existing)
    expect(next[0]?.childAgentEvents).toEqual([
      { type: 'tool_start', payload: { toolUseId: 'tu-child-1', tool: 'Read', input: { file_path: '/a' } } },
    ])
  })

  it('accumulates multiple child events in order on the same bubble', () => {
    let messages: ChatMessage[] = [mkTaskBubble('tu-task-2')]
    const events: { eventType: string; payload: Record<string, unknown> }[] = [
      { eventType: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { eventType: 'tool_input_delta', payload: { toolUseId: 'c1', partialJson: '{"x":' } },
      { eventType: 'tool_result', payload: { toolUseId: 'c1', result: 'hello' } },
    ]
    for (const ev of events) {
      const builder = handleAgentEvent(
        { parentToolUseId: 'tu-task-2', ...ev },
        'active-1',
      )
      messages = builder.applyTo(messages)
    }
    expect(messages[0]?.childAgentEvents).toHaveLength(3)
    expect(messages[0]?.childAgentEvents?.map((e) => e.type)).toEqual([
      'tool_start',
      'tool_input_delta',
      'tool_result',
    ])
  })

  it('returns the same array reference when parentToolUseId is missing', () => {
    const existing: ChatMessage[] = [mkTaskBubble('tu-task-3')]
    const builder = handleAgentEvent(
      { eventType: 'tool_start', payload: {} },
      'active-1',
    )
    expect(builder.applyTo(existing)).toBe(existing)
  })

  it('returns the same array reference when eventType is missing/empty', () => {
    const existing: ChatMessage[] = [mkTaskBubble('tu-task-4')]
    const builder = handleAgentEvent(
      { parentToolUseId: 'tu-task-4', payload: {} },
      'active-1',
    )
    expect(builder.applyTo(existing)).toBe(existing)
  })

  it('returns the same array reference when no matching parent bubble exists', () => {
    const existing: ChatMessage[] = [mkTaskBubble('tu-task-5')]
    const builder = handleAgentEvent(
      {
        parentToolUseId: 'tu-task-NOT-PRESENT',
        eventType: 'tool_start',
        payload: { toolUseId: 'c1' },
      },
      'active-1',
    )
    expect(builder.applyTo(existing)).toBe(existing)
  })

  it('ignores bubbles whose type is not tool_use even when toolUseId matches', () => {
    const existing: ChatMessage[] = [
      // A `response` bubble that happens to carry the same id —
      // shouldn't be mutated.
      {
        id: 'm-decoy',
        type: 'response',
        content: 'parent text',
        toolUseId: 'tu-task-6',
        timestamp: 100,
      },
      mkTaskBubble('tu-task-6'),
    ]
    const builder = handleAgentEvent(
      {
        parentToolUseId: 'tu-task-6',
        eventType: 'stream_delta',
        payload: { delta: 'hi' },
      },
      'active-1',
    )
    const next = builder.applyTo(existing)
    // Only the tool_use bubble is patched.
    expect(next[0]).toBe(existing[0])
    expect(next[1]?.childAgentEvents).toHaveLength(1)
  })

  it('normalises non-object payload to {}', () => {
    const existing: ChatMessage[] = [mkTaskBubble('tu-task-7')]
    const builder = handleAgentEvent(
      {
        parentToolUseId: 'tu-task-7',
        eventType: 'stream_delta',
        payload: null,
      },
      'active-1',
    )
    expect(builder.applyTo(existing)[0]?.childAgentEvents?.[0]?.payload).toEqual({})
  })

  it('falls back to active session when message has no sessionId', () => {
    const builder = handleAgentEvent(
      { parentToolUseId: 'x', eventType: 'tool_start', payload: {} },
      'active-1',
    )
    expect(builder.sessionId).toBe('active-1')
  })
})

// ---------------------------------------------------------------------------
// #4307 — handleBackgroundWorkChanged
// ---------------------------------------------------------------------------
describe('handleBackgroundWorkChanged (#4307)', () => {
  it('replaces the pending list with the server snapshot', () => {
    const existing: PendingBackgroundShell[] = [
      { shellId: 'old', command: 'sleep 1', startedAt: 100 },
    ]
    const builder = handleBackgroundWorkChanged(
      {
        sessionId: 'sess-1',
        pending: [
          { shellId: 'new', command: 'sleep 60', startedAt: 200 },
        ],
      },
      'active-1',
    )
    expect(builder.sessionId).toBe('sess-1')
    expect(builder.applyTo(existing)).toEqual([
      { shellId: 'new', command: 'sleep 60', startedAt: 200 },
    ])
  })

  it('returns the same array reference when the snapshot matches the current list', () => {
    const existing: PendingBackgroundShell[] = [
      { shellId: 'a', command: 'cmd-a', startedAt: 100 },
      { shellId: 'b', command: 'cmd-b', startedAt: 200 },
    ]
    const builder = handleBackgroundWorkChanged(
      {
        pending: [
          { shellId: 'a', command: 'cmd-a', startedAt: 100 },
          { shellId: 'b', command: 'cmd-b', startedAt: 200 },
        ],
      },
      'active-1',
    )
    const result = builder.applyTo(existing)
    expect(result).toBe(existing)
  })

  it('returns an empty list when pending is empty (the "clear" path)', () => {
    const existing: PendingBackgroundShell[] = [
      { shellId: 'a', command: 'cmd-a', startedAt: 100 },
    ]
    const builder = handleBackgroundWorkChanged(
      { pending: [] },
      'active-1',
    )
    expect(builder.applyTo(existing)).toEqual([])
  })

  it('treats missing pending field as empty list (defensive fail-soft)', () => {
    const builder = handleBackgroundWorkChanged({}, 'active-1')
    expect(builder.applyTo([])).toEqual([])
  })

  it('drops entries missing shellId without rejecting the whole snapshot', () => {
    const builder = handleBackgroundWorkChanged(
      {
        pending: [
          { shellId: 'good', command: 'cmd', startedAt: 100 },
          { command: 'no id', startedAt: 100 },
          { shellId: '', command: 'empty', startedAt: 100 },
        ],
      },
      'active-1',
    )
    const out = builder.applyTo([])
    expect(out).toHaveLength(1)
    expect(out[0]?.shellId).toBe('good')
  })

  it('defaults missing command to empty string', () => {
    const builder = handleBackgroundWorkChanged(
      { pending: [{ shellId: 'a', startedAt: 100 }] },
      'active-1',
    )
    expect(builder.applyTo([])[0]?.command).toBe('')
  })

  it('defaults missing startedAt to current time', () => {
    const before = Date.now()
    const builder = handleBackgroundWorkChanged(
      { pending: [{ shellId: 'a', command: 'cmd' }] },
      'active-1',
    )
    const out = builder.applyTo([])
    const after = Date.now()
    expect(out[0]?.startedAt).toBeGreaterThanOrEqual(before)
    expect(out[0]?.startedAt).toBeLessThanOrEqual(after)
  })

  it('falls back to active session when message has no sessionId', () => {
    const builder = handleBackgroundWorkChanged({ pending: [] }, 'active-1')
    expect(builder.sessionId).toBe('active-1')
  })

  it('returns null sessionId when neither is available', () => {
    const builder = handleBackgroundWorkChanged({ pending: [] }, null)
    expect(builder.sessionId).toBeNull()
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

  it('trims whitespace from defaultModelId (#3137)', () => {
    const result = handleAvailableModels({
      models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4' }],
      defaultModel: '  claude-sonnet-4  ',
    })
    expect(result.defaultModelId).toBe('claude-sonnet-4')
  })

  it('returns null defaultModelId for empty string (#3137)', () => {
    const result = handleAvailableModels({
      models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'sonnet' }],
      defaultModel: '',
    })
    expect(result.defaultModelId).toBeNull()
  })

  it('returns null defaultModelId for whitespace-only string (#3137)', () => {
    const result = handleAvailableModels({
      models: [{ id: 'sonnet', label: 'Sonnet', fullId: 'sonnet' }],
      defaultModel: '   \t\n  ',
    })
    expect(result.defaultModelId).toBeNull()
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

// ---------------------------------------------------------------------------
// handleSessionUsage
// ---------------------------------------------------------------------------
describe('handleSessionUsage', () => {
  it('passes a fully-populated cumulativeUsage through', () => {
    const result = handleSessionUsage(
      {
        sessionId: 'sess-1',
        cumulativeUsage: {
          inputTokens: 1234,
          outputTokens: 567,
          cacheReadTokens: 8000,
          cacheCreationTokens: 200,
          costUsd: 0.0345,
          turnsBilled: 3,
        },
      },
      'active-1',
    )
    expect(result).toEqual({
      sessionId: 'sess-1',
      patch: {
        cumulativeUsage: {
          inputTokens: 1234,
          outputTokens: 567,
          cacheReadTokens: 8000,
          cacheCreationTokens: 200,
          costUsd: 0.0345,
          turnsBilled: 3,
        },
      },
    })
  })

  it('coerces missing fields to 0 (always emits a complete block)', () => {
    const result = handleSessionUsage({ cumulativeUsage: {} }, 'active-1')
    expect(result.patch).toEqual({
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turnsBilled: 0,
      },
    })
  })

  it('coerces non-finite fields to 0 (NaN, Infinity, strings, null all become 0)', () => {
    // A corrupted payload must not poison the store with `$NaN` or
    // `$Infinity` values the renderer would format literally.
    const result = handleSessionUsage(
      {
        cumulativeUsage: {
          inputTokens: NaN,
          outputTokens: Infinity,
          cacheReadTokens: -Infinity,
          cacheCreationTokens: '500',
          costUsd: null,
          turnsBilled: undefined,
        },
      },
      'active-1',
    )
    expect(result.patch).toEqual({
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turnsBilled: 0,
      },
    })
  })

  it('emits an all-zero block when cumulativeUsage is missing entirely', () => {
    // Defensive: if the server somehow emits the event without a payload,
    // the renderer still sees a well-formed zero block (not undefined).
    const result = handleSessionUsage({ sessionId: 'sess-1' }, null)
    expect(result.patch).toEqual({
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turnsBilled: 0,
      },
    })
  })

  it('uses sessionId from message when present', () => {
    expect(
      handleSessionUsage(
        { sessionId: 'sess-9', cumulativeUsage: { costUsd: 0.5 } },
        'active-1',
      ).sessionId,
    ).toBe('sess-9')
  })

  it('falls back to active session when sessionId missing', () => {
    expect(
      handleSessionUsage({ cumulativeUsage: { costUsd: 0.5 } }, 'active-1').sessionId,
    ).toBe('active-1')
  })

  it('returns null sessionId when neither is available', () => {
    expect(handleSessionUsage({}, null).sessionId).toBeNull()
  })

  it('preserves whitespace-padded sessionId verbatim (no trim, no fallback)', () => {
    // Mirrors handleCostUpdate semantics — a non-empty whitespace-padded
    // string is truthy, so the downstream sessionStates lookup misses
    // rather than silently routing the usage update to the active session.
    const result = handleSessionUsage(
      { sessionId: '  sess-1  ', cumulativeUsage: { costUsd: 0.5 } },
      'active-1',
    )
    expect(result.sessionId).toBe('  sess-1  ')
  })

  it('falls back to activeSessionId when sessionId is empty string', () => {
    const result = handleSessionUsage(
      { sessionId: '', cumulativeUsage: { costUsd: 0.5 } },
      'active-1',
    )
    expect(result.sessionId).toBe('active-1')
  })
})

// ---------------------------------------------------------------------------
// handleServerError
// ---------------------------------------------------------------------------
describe('handleServerError', () => {
  it('passes a valid category through', () => {
    const result = handleServerError({
      category: 'tunnel',
      message: 'tunnel down',
      recoverable: false,
    })
    expect(result.serverError.category).toBe('tunnel')
  })

  it('accepts all four allow-list values', () => {
    for (const cat of ['tunnel', 'session', 'permission', 'general'] as const) {
      const result = handleServerError({ category: cat, message: 'm' })
      expect(result.serverError.category).toBe(cat)
    }
  })

  it('coerces an invalid category to "general"', () => {
    expect(
      handleServerError({ category: 'bogus', message: 'm' }).serverError.category,
    ).toBe('general')
  })

  it('coerces a non-string category to "general"', () => {
    expect(
      handleServerError({ category: 42, message: 'm' }).serverError.category,
    ).toBe('general')
  })

  it('defaults missing category to "general"', () => {
    expect(handleServerError({ message: 'm' }).serverError.category).toBe(
      'general',
    )
  })

  it('strips ANSI escape codes from message', () => {
    const result = handleServerError({
      message: '\x1b[31mboom\x1b[0m',
    })
    expect(result.serverError.message).toBe('boom')
    expect(result.chatMessage.content).toBe('boom')
  })

  it('defaults to "Unknown server error" when message is missing', () => {
    expect(handleServerError({}).serverError.message).toBe('Unknown server error')
  })

  it('defaults to "Unknown server error" when message is whitespace-only', () => {
    expect(handleServerError({ message: '   ' }).serverError.message).toBe(
      'Unknown server error',
    )
  })

  it('defaults to "Unknown server error" when message is non-string', () => {
    expect(handleServerError({ message: 123 }).serverError.message).toBe(
      'Unknown server error',
    )
  })

  it('passes recoverable through when boolean', () => {
    expect(
      handleServerError({ recoverable: false }).serverError.recoverable,
    ).toBe(false)
    expect(
      handleServerError({ recoverable: true }).serverError.recoverable,
    ).toBe(true)
  })

  it('defaults recoverable to true when missing', () => {
    expect(handleServerError({}).serverError.recoverable).toBe(true)
  })

  it('defaults recoverable to true when non-boolean', () => {
    expect(
      handleServerError({ recoverable: 'yes' }).serverError.recoverable,
    ).toBe(true)
  })

  it('includes optional sessionId when provided', () => {
    const result = handleServerError({ sessionId: 'sess-9', message: 'm' })
    expect(result.serverError.sessionId).toBe('sess-9')
  })

  it('omits sessionId when missing', () => {
    const result = handleServerError({ message: 'm' })
    expect('sessionId' in result.serverError).toBe(false)
  })

  it('omits sessionId when not a string', () => {
    const result = handleServerError({ sessionId: 42, message: 'm' })
    expect('sessionId' in result.serverError).toBe(false)
  })

  it('populates id and timestamp on serverError', () => {
    const before = Date.now()
    const result = handleServerError({ message: 'm' })
    const after = Date.now()
    expect(typeof result.serverError.id).toBe('string')
    expect(result.serverError.id.length).toBeGreaterThan(0)
    expect(result.serverError.timestamp).toBeGreaterThanOrEqual(before)
    expect(result.serverError.timestamp).toBeLessThanOrEqual(after)
  })

  it('builds a ChatMessage of type "error" with the same content as serverError.message', () => {
    const result = handleServerError({
      category: 'session',
      message: 'something went wrong',
    })
    expect(result.chatMessage.type).toBe('error')
    expect(result.chatMessage.content).toBe('something went wrong')
    expect(typeof result.chatMessage.id).toBe('string')
    expect(result.chatMessage.id.length).toBeGreaterThan(0)
    expect(typeof result.chatMessage.timestamp).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// handleServerShutdown
// ---------------------------------------------------------------------------
describe('handleServerShutdown', () => {
  it('passes "restart" reason through', () => {
    expect(handleServerShutdown({ reason: 'restart' }).shutdownReason).toBe(
      'restart',
    )
  })

  it('passes "shutdown" reason through', () => {
    expect(handleServerShutdown({ reason: 'shutdown' }).shutdownReason).toBe(
      'shutdown',
    )
  })

  it('passes "crash" reason through', () => {
    expect(handleServerShutdown({ reason: 'crash' }).shutdownReason).toBe(
      'crash',
    )
  })

  it('defaults invalid reason to "shutdown"', () => {
    expect(handleServerShutdown({ reason: 'bogus' }).shutdownReason).toBe(
      'shutdown',
    )
  })

  it('defaults missing reason to "shutdown"', () => {
    expect(handleServerShutdown({}).shutdownReason).toBe('shutdown')
  })

  it('defaults non-string reason to "shutdown"', () => {
    expect(handleServerShutdown({ reason: 42 }).shutdownReason).toBe('shutdown')
  })

  it('passes numeric restartEtaMs through (including 0)', () => {
    expect(handleServerShutdown({ restartEtaMs: 5000 }).restartEtaMs).toBe(5000)
    expect(handleServerShutdown({ restartEtaMs: 0 }).restartEtaMs).toBe(0)
  })

  it('defaults missing restartEtaMs to 0', () => {
    expect(handleServerShutdown({}).restartEtaMs).toBe(0)
  })

  it('defaults non-number restartEtaMs to 0', () => {
    expect(handleServerShutdown({ restartEtaMs: '500' }).restartEtaMs).toBe(0)
    expect(handleServerShutdown({ restartEtaMs: null }).restartEtaMs).toBe(0)
  })

  it('populates restartingSince with the current timestamp', () => {
    const before = Date.now()
    const result = handleServerShutdown({})
    const after = Date.now()
    expect(result.restartingSince).toBeGreaterThanOrEqual(before)
    expect(result.restartingSince).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// handleServerStatusLegacy
// ---------------------------------------------------------------------------
describe('handleServerStatusLegacy', () => {
  it('uses the message text when present', () => {
    const result = handleServerStatusLegacy({ message: 'Hello there' })
    expect(result.chatMessage.content).toBe('Hello there')
  })

  it('strips ANSI escape codes from message', () => {
    const result = handleServerStatusLegacy({
      message: '\x1b[32mok\x1b[0m',
    })
    expect(result.chatMessage.content).toBe('ok')
  })

  it('defaults to "Status update" when message is missing', () => {
    expect(handleServerStatusLegacy({}).chatMessage.content).toBe('Status update')
  })

  it('defaults to "Status update" when message is whitespace-only', () => {
    expect(
      handleServerStatusLegacy({ message: '   ' }).chatMessage.content,
    ).toBe('Status update')
  })

  it('defaults to "Status update" when message is non-string', () => {
    expect(
      handleServerStatusLegacy({ message: 42 }).chatMessage.content,
    ).toBe('Status update')
  })

  it('builds a ChatMessage of type "system"', () => {
    const result = handleServerStatusLegacy({ message: 'hi' })
    expect(result.chatMessage.type).toBe('system')
    expect(typeof result.chatMessage.id).toBe('string')
    expect(result.chatMessage.id.length).toBeGreaterThan(0)
    expect(typeof result.chatMessage.timestamp).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// handleWebTaskUpsert
// ---------------------------------------------------------------------------
describe('handleWebTaskUpsert', () => {
  it('returns null task when msg.task is missing', () => {
    expect(handleWebTaskUpsert({})).toEqual({ task: null })
  })

  it('returns null task when msg.task is null', () => {
    expect(handleWebTaskUpsert({ task: null })).toEqual({ task: null })
  })

  it('returns null task when msg.task is non-object', () => {
    expect(handleWebTaskUpsert({ task: 'not-a-task' })).toEqual({ task: null })
    expect(handleWebTaskUpsert({ task: 42 })).toEqual({ task: null })
  })

  it('returns null task when task.taskId is missing', () => {
    const task = {
      prompt: 'hello',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      result: null,
      error: null,
    }
    expect(handleWebTaskUpsert({ task })).toEqual({ task: null })
  })

  it('returns null task when task.taskId is empty string', () => {
    const task = {
      taskId: '',
      prompt: 'hello',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      result: null,
      error: null,
    }
    expect(handleWebTaskUpsert({ task })).toEqual({ task: null })
  })

  it('returns null task when task.taskId is non-string', () => {
    const task = {
      taskId: 42,
      prompt: 'hello',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      result: null,
      error: null,
    }
    expect(handleWebTaskUpsert({ task })).toEqual({ task: null })
  })

  it('passes a valid task through', () => {
    const task = {
      taskId: 'task-1',
      prompt: 'do the thing',
      status: 'pending' as const,
      createdAt: 1000,
      updatedAt: 1000,
      result: null,
      error: null,
    }
    expect(handleWebTaskUpsert({ task })).toEqual({ task })
  })
})

// ---------------------------------------------------------------------------
// applyWebTaskUpsert (#5556 slice 4)
// ---------------------------------------------------------------------------
describe('applyWebTaskUpsert', () => {
  const t = (taskId: string, status: string) =>
    ({ taskId, status }) as unknown as Parameters<typeof applyWebTaskUpsert>[0][number]

  it('appends a new task to the end of the list', () => {
    const result = applyWebTaskUpsert([t('a', 'running')], t('b', 'running'))
    expect(result).toEqual([
      { taskId: 'a', status: 'running' },
      { taskId: 'b', status: 'running' },
    ])
  })

  it('replaces an existing task with the same taskId, re-appending it at the end', () => {
    const result = applyWebTaskUpsert(
      [t('a', 'running'), t('b', 'running')],
      t('a', 'completed'),
    )
    expect(result).toEqual([
      { taskId: 'b', status: 'running' },
      { taskId: 'a', status: 'completed' },
    ])
  })

  it('does not mutate the input list', () => {
    const existing = [t('a', 'running')]
    applyWebTaskUpsert(existing, t('a', 'completed'))
    expect(existing).toEqual([{ taskId: 'a', status: 'running' }])
  })
})

// ---------------------------------------------------------------------------
// handleWebTaskError
// ---------------------------------------------------------------------------
describe('handleWebTaskError', () => {
  it('extracts taskId, message, code, and boundSessionName when present', () => {
    const result = handleWebTaskError({
      taskId: 'task-1',
      message: 'something failed',
      code: 'SESSION_TOKEN_MISMATCH',
      boundSessionName: 'main',
    })
    expect(result.taskId).toBe('task-1')
    expect(result.errorMessage).toBe('something failed')
    expect(result.code).toBe('SESSION_TOKEN_MISMATCH')
    expect(result.boundSessionName).toBe('main')
  })

  it('returns null taskId when missing', () => {
    expect(handleWebTaskError({}).taskId).toBeNull()
  })

  it('returns null taskId when non-string', () => {
    expect(handleWebTaskError({ taskId: 42 }).taskId).toBeNull()
  })

  it('returns null taskId when empty string', () => {
    expect(handleWebTaskError({ taskId: '' }).taskId).toBeNull()
  })

  it('returns null code when missing', () => {
    expect(handleWebTaskError({}).code).toBeNull()
  })

  it('returns null code when non-string', () => {
    expect(handleWebTaskError({ code: 42 }).code).toBeNull()
  })

  it('returns null boundSessionName when missing', () => {
    expect(handleWebTaskError({}).boundSessionName).toBeNull()
  })

  it('returns null boundSessionName when non-string', () => {
    expect(handleWebTaskError({ boundSessionName: 42 }).boundSessionName).toBeNull()
  })

  it('returns null boundSessionName when empty string', () => {
    expect(handleWebTaskError({ boundSessionName: '' }).boundSessionName).toBeNull()
  })

  it('defaults errorMessage to "Unknown error" when message missing', () => {
    expect(handleWebTaskError({}).errorMessage).toBe('Unknown error')
  })

  it('defaults errorMessage to "Unknown error" when message is non-string', () => {
    expect(handleWebTaskError({ message: 42 }).errorMessage).toBe('Unknown error')
  })

  it('defaults errorMessage to "Unknown error" when message is empty string', () => {
    expect(handleWebTaskError({ message: '' }).errorMessage).toBe('Unknown error')
  })

  it('returns chatMessageContent set to the message text when present', () => {
    const result = handleWebTaskError({ message: 'task blew up' })
    expect(result.chatMessageContent).toBe('task blew up')
  })

  it('chatMessageContent defaults to "Web task error" when message is missing', () => {
    const result = handleWebTaskError({})
    expect(result.chatMessageContent).toBe('Web task error')
  })

  it('chatMessageContent defaults to "Web task error" when message is non-string', () => {
    expect(handleWebTaskError({ message: 42 }).chatMessageContent).toBe(
      'Web task error',
    )
  })

  it('chatMessageContent defaults to "Web task error" when message is empty string', () => {
    expect(handleWebTaskError({ message: '' }).chatMessageContent).toBe(
      'Web task error',
    )
  })

  it('does not allocate a message id (caller builds the ChatMessage)', () => {
    // Calling the handler 100x must not advance the global nextMessageId
    // counter. We verify by calling a separate id-allocating handler before
    // and after, and checking the counter advances by exactly one.
    const before = nextMessageId('probe')
    for (let i = 0; i < 100; i++) {
      handleWebTaskError({ message: 'x', taskId: 't' })
    }
    const after = nextMessageId('probe')
    const beforeNum = parseInt(before.split('-')[1], 10)
    const afterNum = parseInt(after.split('-')[1], 10)
    expect(afterNum - beforeNum).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// handleWebTaskList
// ---------------------------------------------------------------------------
describe('handleWebTaskList', () => {
  it('passes the tasks array through', () => {
    const tasks = [
      {
        taskId: 't1',
        prompt: 'a',
        status: 'pending',
        createdAt: 0,
        updatedAt: 0,
        result: null,
        error: null,
      },
    ]
    expect(handleWebTaskList({ tasks })).toEqual({ tasks })
  })

  it('defaults to [] when tasks missing', () => {
    expect(handleWebTaskList({})).toEqual({ tasks: [] })
  })

  it('defaults to [] when tasks is non-array', () => {
    expect(handleWebTaskList({ tasks: 'not an array' })).toEqual({ tasks: [] })
    expect(handleWebTaskList({ tasks: null })).toEqual({ tasks: [] })
    expect(handleWebTaskList({ tasks: 42 })).toEqual({ tasks: [] })
    expect(handleWebTaskList({ tasks: {} })).toEqual({ tasks: [] })
  })

  it('returns an empty array unchanged', () => {
    expect(handleWebTaskList({ tasks: [] })).toEqual({ tasks: [] })
  })
})

// ---------------------------------------------------------------------------
// handleWebFeatureStatus
// ---------------------------------------------------------------------------
describe('handleWebFeatureStatus', () => {
  it('coerces truthy values to true', () => {
    expect(
      handleWebFeatureStatus({ available: true, remote: true, teleport: true }),
    ).toEqual({
      webFeatures: { available: true, remote: true, teleport: true },
    })
  })

  it('coerces falsy values to false', () => {
    expect(
      handleWebFeatureStatus({
        available: false,
        remote: false,
        teleport: false,
      }),
    ).toEqual({
      webFeatures: { available: false, remote: false, teleport: false },
    })
  })

  it('defaults missing fields to false', () => {
    expect(handleWebFeatureStatus({})).toEqual({
      webFeatures: { available: false, remote: false, teleport: false },
    })
  })

  it('coerces truthy non-boolean values to true', () => {
    expect(
      handleWebFeatureStatus({ available: 1, remote: 'yes', teleport: {} }),
    ).toEqual({
      webFeatures: { available: true, remote: true, teleport: true },
    })
  })

  it('coerces falsy non-boolean values to false', () => {
    expect(
      handleWebFeatureStatus({ available: 0, remote: '', teleport: null }),
    ).toEqual({
      webFeatures: { available: false, remote: false, teleport: false },
    })
  })

  it('handles partial fields', () => {
    expect(handleWebFeatureStatus({ available: true })).toEqual({
      webFeatures: { available: true, remote: false, teleport: false },
    })
  })
})

// ---------------------------------------------------------------------------
// handleSearchResults
// ---------------------------------------------------------------------------
describe('handleSearchResults', () => {
  it('passes results through and applies when query matches currentQuery', () => {
    const results = [
      {
        conversationId: 'c1',
        projectName: 'p',
        project: null,
        cwd: null,
        preview: null,
        snippet: 's',
        matchCount: 1,
      },
    ]
    const out = handleSearchResults({ results, query: 'foo' }, 'foo')
    expect(out.shouldApply).toBe(true)
    expect(out.results).toBe(results)
  })

  it('returns shouldApply=false when message query is stale vs currentQuery', () => {
    const results = [{ conversationId: 'c1' }]
    const out = handleSearchResults({ results, query: 'old' }, 'new')
    expect(out.shouldApply).toBe(false)
    expect(out.results).toBe(results)
  })

  it('returns shouldApply=true when message has no query (broadcast)', () => {
    const results = [{ conversationId: 'c1' }]
    const out = handleSearchResults({ results }, 'still-typing')
    expect(out.shouldApply).toBe(true)
    expect(out.results).toBe(results)
  })

  it('returns shouldApply=true when currentQuery is null', () => {
    const results = [{ conversationId: 'c1' }]
    const out = handleSearchResults({ results, query: 'foo' }, null)
    expect(out.shouldApply).toBe(true)
    expect(out.results).toBe(results)
  })

  it('returns shouldApply=true when currentQuery is empty string', () => {
    const results = [{ conversationId: 'c1' }]
    const out = handleSearchResults({ results, query: 'foo' }, '')
    expect(out.shouldApply).toBe(true)
  })

  it('defaults results to [] when missing', () => {
    const out = handleSearchResults({ query: 'foo' }, 'foo')
    expect(out.results).toEqual([])
    expect(out.shouldApply).toBe(true)
  })

  it('defaults results to [] when non-array', () => {
    expect(handleSearchResults({ results: 'oops' }, null).results).toEqual([])
    expect(handleSearchResults({ results: 42 }, null).results).toEqual([])
    expect(handleSearchResults({ results: null }, null).results).toEqual([])
    expect(handleSearchResults({ results: {} }, null).results).toEqual([])
  })

  it('treats non-string query as null (always applies, even when currentQuery set)', () => {
    const results = [{ conversationId: 'c1' }]
    const out = handleSearchResults({ results, query: 42 }, 'new')
    expect(out.shouldApply).toBe(true)
    expect(out.results).toBe(results)
  })

  it('returns shouldApply=true when message and current queries are identical', () => {
    const out = handleSearchResults({ results: [], query: 'same' }, 'same')
    expect(out.shouldApply).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handleUserQuestion
// ---------------------------------------------------------------------------
describe('handleUserQuestion', () => {
  it('returns null when questions field is missing', () => {
    expect(handleUserQuestion({}, 'sess-1')).toBeNull()
  })

  it('returns null when questions is not an array', () => {
    expect(handleUserQuestion({ questions: 'nope' }, 'sess-1')).toBeNull()
    expect(handleUserQuestion({ questions: null }, 'sess-1')).toBeNull()
    expect(handleUserQuestion({ questions: {} }, 'sess-1')).toBeNull()
  })

  it('returns null when questions array is empty', () => {
    expect(handleUserQuestion({ questions: [] }, 'sess-1')).toBeNull()
  })

  it('returns null when first question is not an object', () => {
    expect(handleUserQuestion({ questions: ['plain string'] }, 'sess-1')).toBeNull()
    expect(handleUserQuestion({ questions: [42] }, 'sess-1')).toBeNull()
    expect(handleUserQuestion({ questions: [null] }, 'sess-1')).toBeNull()
  })

  it('returns null when q.question is not a string', () => {
    expect(handleUserQuestion({ questions: [{ question: 42 }] }, 'sess-1')).toBeNull()
    expect(handleUserQuestion({ questions: [{}] }, 'sess-1')).toBeNull()
    expect(handleUserQuestion({ questions: [{ question: null }] }, 'sess-1')).toBeNull()
  })

  it('builds a prompt-typed ChatMessage for a valid question', () => {
    const out = handleUserQuestion(
      {
        questions: [{ question: 'Pick a colour', options: [{ label: 'red' }, { label: 'blue' }] }],
        toolUseId: 'tu-1',
        sessionId: 'sess-9',
      },
      'sess-active',
    )
    expect(out).not.toBeNull()
    expect(out!.chatMessage.type).toBe('prompt')
    expect(out!.chatMessage.content).toBe('Pick a colour')
    expect(out!.chatMessage.toolUseId).toBe('tu-1')
    expect(typeof out!.chatMessage.id).toBe('string')
    expect(out!.chatMessage.id.length).toBeGreaterThan(0)
    expect(typeof out!.chatMessage.timestamp).toBe('number')
  })

  // #4613 — mirrors the #4607 fix for handleToolStart. The server's history
  // ring buffer stamps `timestamp: Date.now()` at append time and forwards it
  // on every replay (session-message-history.js:208-216). When the dashboard
  // rebuilds the `prompt` ChatMessage during history_replay (the question
  // event is part of the replayed ring buffer), it must honour that wire
  // timestamp instead of stamping a new Date.now(). Without this, a question
  // prompt that originally fired at 10:00 shows as "just now" if you tab
  // away and back. Lower-impact than #4607 (affects bubble display only, not
  // the timer pill), but still a correctness bug.
  it('honours wire `timestamp` field on the user_question payload (#4613)', () => {
    const wireTimestamp = 1_700_000_000_000
    const out = handleUserQuestion(
      {
        questions: [{ question: 'Pick a colour' }],
        timestamp: wireTimestamp,
      },
      'sess-active',
    )
    expect(out).not.toBeNull()
    expect(out!.chatMessage.timestamp).toBe(wireTimestamp)
  })

  it('falls back to Date.now() when wire `timestamp` is missing (live user_question, #4613)', () => {
    const before = Date.now()
    const out = handleUserQuestion(
      { questions: [{ question: 'Pick a colour' }] },
      'sess-active',
    )
    const after = Date.now()
    expect(out).not.toBeNull()
    expect(out!.chatMessage.timestamp).toBeGreaterThanOrEqual(before)
    expect(out!.chatMessage.timestamp).toBeLessThanOrEqual(after)
  })

  it('ignores non-finite wire `timestamp` and falls back to Date.now() (#4613)', () => {
    // Defensive: a malformed wire payload (NaN, Infinity, string-coerced)
    // must not poison the displayed bubble timestamp with NaN-driven
    // arithmetic downstream.
    const before = Date.now()
    const out = handleUserQuestion(
      {
        questions: [{ question: 'Pick a colour' }],
        timestamp: Number.NaN,
      },
      'sess-active',
    )
    const after = Date.now()
    expect(out).not.toBeNull()
    expect(out!.chatMessage.timestamp).toBeGreaterThanOrEqual(before)
    expect(out!.chatMessage.timestamp).toBeLessThanOrEqual(after)
  })

  it('uses msg.sessionId when present', () => {
    const out = handleUserQuestion(
      { questions: [{ question: 'Q?' }], sessionId: 'sess-9' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-9')
  })

  it('falls back to activeSessionId when msg.sessionId is missing', () => {
    const out = handleUserQuestion(
      { questions: [{ question: 'Q?' }] },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  it('falls back to activeSessionId when msg.sessionId is empty string', () => {
    const out = handleUserQuestion(
      { questions: [{ question: 'Q?' }], sessionId: '' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  it('returns null sessionId when both msg.sessionId and activeSessionId are missing', () => {
    const out = handleUserQuestion({ questions: [{ question: 'Q?' }] }, null)
    expect(out!.sessionId).toBeNull()
  })

  it('filters options to only objects with string label and sets value=label, appending Other sentinel (#3746)', () => {
    const out = handleUserQuestion(
      {
        questions: [
          {
            question: 'Pick',
            options: [
              { label: 'a' },
              { label: 'b', other: 1 },
              null,
              'string-not-object',
              { notLabel: 'x' },
              { label: 42 },
              { label: 'c' },
            ],
          },
        ],
      },
      null,
    )
    expect(out!.chatMessage.options).toEqual([
      { label: 'a', value: 'a' },
      { label: 'b', value: 'b' },
      { label: 'c', value: 'c' },
      { label: 'Other', value: '__chroxy_other__' },
    ])
  })

  it('options defaults to [] (no Other sentinel) when q.options is missing or non-array (#3746)', () => {
    const out1 = handleUserQuestion(
      { questions: [{ question: 'Q?' }] },
      null,
    )
    expect(out1!.chatMessage.options).toEqual([])
    const out2 = handleUserQuestion(
      { questions: [{ question: 'Q?', options: 'oops' }] },
      null,
    )
    expect(out2!.chatMessage.options).toEqual([])
    const out3 = handleUserQuestion(
      { questions: [{ question: 'Q?', options: {} }] },
      null,
    )
    expect(out3!.chatMessage.options).toEqual([])
  })

  it('appends Other sentinel after model-provided options (#3746)', () => {
    const out = handleUserQuestion(
      {
        questions: [{ question: 'Pick a colour', options: [{ label: 'red' }, { label: 'blue' }] }],
      },
      null,
    )
    expect(out!.chatMessage.options).toEqual([
      { label: 'red', value: 'red' },
      { label: 'blue', value: 'blue' },
      { label: 'Other', value: '__chroxy_other__' },
    ])
  })

  it('does not append Other sentinel when all options are filtered out (#3746)', () => {
    const out = handleUserQuestion(
      {
        questions: [{ question: 'Q?', options: [null, 'x', { notLabel: 'y' }] }],
      },
      null,
    )
    expect(out!.chatMessage.options).toEqual([])
  })

  // #3752: model-supplied "Other" collides with the synthetic sentinel.
  // Without dedup the user sees two "Other" rows; the model's wins.
  it('prefers a model-supplied "Other" option over the synthetic sentinel (#3752)', () => {
    const out = handleUserQuestion(
      {
        questions: [
          {
            question: 'Pick',
            options: [{ label: 'a' }, { label: 'Other' }, { label: 'c' }],
          },
        ],
      },
      null,
    )
    // Exactly one "Other" row, with value === 'Other' (label-derived),
    // NOT value === '__chroxy_other__'. Free-text escape hatch yields
    // to the model's literal value.
    expect(out!.chatMessage.options).toEqual([
      { label: 'a', value: 'a' },
      { label: 'c', value: 'c' },
      { label: 'Other', value: 'Other' },
    ])
  })

  // #3752: defensive — if a model-derived value somehow lands on the
  // sentinel string itself, strip it before appending. Without this,
  // React keys collide in the dashboard's `key={opt.value}` map.
  it('strips a model option whose value would collide with the sentinel value (#3752)', () => {
    const out = handleUserQuestion(
      {
        questions: [
          {
            question: 'Pick',
            options: [{ label: 'a' }, { label: '__chroxy_other__' }, { label: 'c' }],
          },
        ],
      },
      null,
    )
    // The colliding row is dropped entirely (its value would shadow the
    // sentinel's key in the renderer); the sentinel is then appended.
    expect(out!.chatMessage.options).toEqual([
      { label: 'a', value: 'a' },
      { label: 'c', value: 'c' },
      { label: 'Other', value: '__chroxy_other__' },
    ])
  })

  // #3752 review (#3792): if dedup leaves zero usable options, fall through
  // to free-text-only — DO NOT append the sentinel as a sole tap target.
  // That would invert the existing contract (zero options → renderers show
  // free-text directly) into "user must tap Other to reach free-text".
  it('returns empty options when dedup strips every model option (#3752)', () => {
    const out = handleUserQuestion(
      {
        questions: [
          {
            question: 'Pick',
            // Only entry collides with the sentinel value — dropped by
            // dedup. No real options remain.
            options: [{ label: '__chroxy_other__' }],
          },
        ],
      },
      null,
    )
    expect(out!.chatMessage.options).toEqual([])
  })

  it('truncates questionText to 60 characters', () => {
    const long = 'x'.repeat(120)
    const out = handleUserQuestion(
      { questions: [{ question: long }] },
      null,
    )
    expect(out!.questionText).toBe('x'.repeat(60))
    // The full text is preserved on the chat message itself.
    expect(out!.chatMessage.content).toBe(long)
  })

  it('passes shorter question text through unchanged', () => {
    const out = handleUserQuestion(
      { questions: [{ question: 'short' }] },
      null,
    )
    expect(out!.questionText).toBe('short')
  })

  it('toolUseId is taken from msg.toolUseId verbatim', () => {
    const out = handleUserQuestion(
      { questions: [{ question: 'Q?' }], toolUseId: 'tu-42' },
      null,
    )
    expect(out!.chatMessage.toolUseId).toBe('tu-42')
  })

  it('omits toolUseId when msg.toolUseId is non-string', () => {
    const out1 = handleUserQuestion(
      { questions: [{ question: 'Q?' }], toolUseId: 42 },
      null,
    )
    expect(out1!.chatMessage.toolUseId).toBeUndefined()
    const out2 = handleUserQuestion(
      { questions: [{ question: 'Q?' }], toolUseId: null },
      null,
    )
    expect(out2!.chatMessage.toolUseId).toBeUndefined()
    const out3 = handleUserQuestion(
      { questions: [{ question: 'Q?' }] },
      null,
    )
    expect(out3!.chatMessage.toolUseId).toBeUndefined()
  })

  it('falls back to activeSessionId when msg.sessionId is non-string', () => {
    const out1 = handleUserQuestion(
      { questions: [{ question: 'Q?' }], sessionId: 42 },
      'sess-active',
    )
    expect(out1!.sessionId).toBe('sess-active')
    const out2 = handleUserQuestion(
      { questions: [{ question: 'Q?' }], sessionId: { id: 'x' } },
      'sess-active',
    )
    expect(out2!.sessionId).toBe('sess-active')
    const out3 = handleUserQuestion(
      { questions: [{ question: 'Q?' }], sessionId: null },
      'sess-active',
    )
    expect(out3!.sessionId).toBe('sess-active')
  })

  // #4604 Chunk B — multi-question forms. Previously handleUserQuestion
  // dropped every question past q[0]; the server-side driver had no way
  // to know what the user wanted to pick for q2/q3 and defaulted them
  // to option 1 (or stalled the form entirely). Now the full N-question
  // payload rides on `chatMessage.questions`.
  describe('multi-question form support (#4604 Chunk B)', () => {
    it('populates chatMessage.questions with every normalized question', () => {
      const out = handleUserQuestion(
        {
          questions: [
            { question: 'Q1?', options: [{ label: 'a' }, { label: 'b' }] },
            { question: 'Q2?', multiSelect: true, options: [{ label: 'p' }, { label: 'q' }] },
            { question: 'Q3?', options: [{ label: 'x' }] },
          ],
          toolUseId: 'tu-multi',
        },
        null,
      )
      expect(out).not.toBeNull()
      expect(out!.chatMessage.questions).toBeDefined()
      expect(out!.chatMessage.questions!.length).toBe(3)
      expect(out!.chatMessage.questions![0].question).toBe('Q1?')
      expect(out!.chatMessage.questions![1].question).toBe('Q2?')
      expect(out!.chatMessage.questions![2].question).toBe('Q3?')
      // Single-select questions get the Other sentinel appended; the
      // multi-select question does NOT (the checkbox UI doesn't compose
      // with a free-text escape hatch).
      expect(out!.chatMessage.questions![0].options).toEqual([
        { label: 'a', value: 'a' },
        { label: 'b', value: 'b' },
        { label: 'Other', value: '__chroxy_other__' },
      ])
      expect(out!.chatMessage.questions![1].options).toEqual([
        { label: 'p', value: 'p' },
        { label: 'q', value: 'q' },
      ])
      expect(out!.chatMessage.questions![1].multiSelect).toBe(true)
      expect(out!.chatMessage.questions![2].options).toEqual([
        { label: 'x', value: 'x' },
        { label: 'Other', value: '__chroxy_other__' },
      ])
    })

    it('legacy top-level options + content mirror questions[0] (back-compat with single-q renderers)', () => {
      const out = handleUserQuestion(
        {
          questions: [
            { question: 'First', options: [{ label: 'a' }, { label: 'b' }] },
            { question: 'Second', options: [{ label: 'x' }] },
          ],
        },
        null,
      )
      // questions[0] is the same as the legacy top-level fields so
      // pre-Chunk-B renderers that only read `content` + `options`
      // keep rendering the first question identically.
      expect(out!.chatMessage.content).toBe(out!.chatMessage.questions![0].question)
      expect(out!.chatMessage.options).toEqual(out!.chatMessage.questions![0].options)
    })

    it('single-question form still populates chatMessage.questions (N=1 case)', () => {
      const out = handleUserQuestion(
        {
          questions: [{ question: 'Just one', options: [{ label: 'a' }] }],
        },
        null,
      )
      // Even single-question prompts populate `questions` — renderers
      // detect multi-question by `questions.length > 1` so the N=1 case
      // must still be present (renderers can iterate uniformly).
      expect(out!.chatMessage.questions).toBeDefined()
      expect(out!.chatMessage.questions!.length).toBe(1)
      expect(out!.chatMessage.questions![0].question).toBe('Just one')
    })

    it('skips malformed entries past q[0] without poisoning the rest of the form', () => {
      const out = handleUserQuestion(
        {
          questions: [
            { question: 'Q1?', options: [{ label: 'a' }] },
            { notAQuestion: true },           // malformed — skipped
            'plain-string',                    // malformed — skipped
            null,                              // malformed — skipped
            { question: 'Q5?', options: [{ label: 'p' }] },
          ],
        },
        null,
      )
      expect(out!.chatMessage.questions!.length).toBe(2)
      expect(out!.chatMessage.questions!.map((q) => q.question)).toEqual(['Q1?', 'Q5?'])
    })
  })
})

// ---------------------------------------------------------------------------
// handleUserInput
// ---------------------------------------------------------------------------
describe('handleUserInput', () => {
  it('returns null when parseUserInputMessage returns null (own client echo)', () => {
    const out = handleUserInput(
      { clientId: 'me', text: 'hello', sessionId: 'sess-1' },
      'me',
      'sess-active',
    )
    expect(out).toBeNull()
  })

  it('returns null when no target session can be resolved', () => {
    const out = handleUserInput(
      { clientId: 'them', text: 'hello' },
      'me',
      null,
    )
    expect(out).toBeNull()
  })

  it('builds a ChatMessage using the server-stamped messageId when present', () => {
    const out = handleUserInput(
      {
        clientId: 'them',
        text: 'hello world',
        sessionId: 'sess-1',
        messageId: 'srv-stable-id',
        timestamp: 12345,
      },
      'me',
      'sess-active',
    )
    expect(out).not.toBeNull()
    expect(out!.sessionId).toBe('sess-1')
    expect(out!.content).toBe('hello world')
    expect(out!.chatMessage.id).toBe('srv-stable-id')
    expect(out!.chatMessage.type).toBe('user_input')
    expect(out!.chatMessage.content).toBe('hello world')
    expect(out!.chatMessage.timestamp).toBe(12345)
  })

  it('generates a fresh message id when no stable messageId is provided', () => {
    const out = handleUserInput(
      {
        clientId: 'them',
        text: 'hi',
        sessionId: 'sess-1',
      },
      'me',
      'sess-active',
    )
    expect(out).not.toBeNull()
    expect(out!.chatMessage.id).toMatch(/^user_input-\d+-\d+$/)
  })

  it('falls back to activeSessionId when msg.sessionId is missing', () => {
    const out = handleUserInput(
      { clientId: 'them', text: 'hi' },
      'me',
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  it('exposes parsed.content separately so the dashboard can write the terminal buffer', () => {
    const out = handleUserInput(
      { clientId: 'them', text: 'terminal text', sessionId: 'sess-1' },
      'me',
      null,
    )
    expect(out!.content).toBe('terminal text')
  })

  it('treats non-string messageId as missing (generates id instead)', () => {
    const out = handleUserInput(
      {
        clientId: 'them',
        text: 'hi',
        sessionId: 'sess-1',
        messageId: 42,
      },
      'me',
      null,
    )
    expect(out!.chatMessage.id).not.toBe(42)
    expect(out!.chatMessage.id).toMatch(/^user_input-\d+-\d+$/)
  })
})

// ---------------------------------------------------------------------------
// handleMessage
// ---------------------------------------------------------------------------
describe('handleMessage', () => {
  it('uses messageType field when present, falling back to type', () => {
    const out1 = handleMessage(
      { messageType: 'response', type: 'message', content: 'hi', timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    expect(out1.shouldDispatch).toBe(true)
    if (out1.shouldDispatch) {
      expect(out1.chatMessage.type).toBe('response')
    }

    const out2 = handleMessage(
      { type: 'error', content: 'oh no', timestamp: 2 },
      'sess-active',
      false,
      [],
    )
    expect(out2.shouldDispatch).toBe(true)
    if (out2.shouldDispatch) {
      expect(out2.chatMessage.type).toBe('error')
    }
  })

  // #4476: server PR #4475 emits `error{code: 'stream_stall'}` when the CLI
  // child has been silent for the configured stall window (default 5min).
  // The discriminator field flows through event-normalizer.js (#4467) and
  // lands here as a top-level `message` with `messageType: 'error'` and a
  // populated `code`. The dashboard chip needs that `code` on the
  // ChatMessage so it can render the distinct 'Stream stalled — retry?'
  // affordance instead of the generic red error bubble.
  it('preserves the structured error code on the ChatMessage (#4476)', () => {
    const out = handleMessage(
      {
        messageType: 'error',
        content: 'Stream stalled — no response for 5 minutes',
        code: 'stream_stall',
        timestamp: 100,
      },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) {
      expect(out.chatMessage.type).toBe('error')
      expect(out.chatMessage.code).toBe('stream_stall')
    }
  })

  it('leaves chatMessage.code undefined when the wire message omits code', () => {
    // Existing generic errors (no structured code) must continue to render
    // as the plain red bubble — the chip variant only kicks in when the
    // server explicitly tags the error.
    const out = handleMessage(
      {
        messageType: 'error',
        content: 'something exploded',
        timestamp: 100,
      },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) {
      expect(out.chatMessage.code).toBeUndefined()
    }
  })

  it('coerces a non-string code to undefined rather than passing junk through', () => {
    // Defense in depth — the protocol schema already constrains `code` to
    // a string at the wire boundary, but the runtime type of `msg` is
    // `Record<string, unknown>` and a malformed payload could land here
    // with `code: 42`. Drop it instead of storing the wrong type on
    // ChatMessage.
    const out = handleMessage(
      {
        messageType: 'error',
        content: 'something exploded',
        code: 42,
        timestamp: 100,
      },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) {
      expect(out.chatMessage.code).toBeUndefined()
    }
  })

  // #4947: server PR #4944 emits `error{code:'resume_unknown',
  // attemptedResumeId, message}` when the claude CLI rejects a `--resume
  // <id>` because the conversation id is unknown locally. The dashboard
  // ResumeUnknownChip surfaces `attemptedResumeId` as subtext so operators
  // can correlate against the persisted state file. Without preserving the
  // field on the ChatMessage here, the chip would degrade to "headline
  // only" and the (Optional) acceptance-criterion subtext would never
  // render in practice.
  describe('attemptedResumeId preservation (#4947)', () => {
    it('preserves a string attemptedResumeId on the ChatMessage', () => {
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'Previous Claude conversation could not be resumed',
          code: 'resume_unknown',
          attemptedResumeId: 'abc123-def456-7890',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.code).toBe('resume_unknown')
        expect(out.chatMessage.attemptedResumeId).toBe('abc123-def456-7890')
      }
    })

    it('leaves attemptedResumeId undefined when the wire field is missing', () => {
      // Pre-#4944 servers and every non-resume_unknown error envelope omit
      // the field entirely. ChatMessage simply stays undefined and the
      // chip's hasId guard hides the subtext slot.
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'something else',
          code: 'stream_stall',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBeUndefined()
      }
    })

    it('coerces a non-string attemptedResumeId to undefined (defense in depth)', () => {
      // Same hardening as `code: 42` above. A malformed producer must not
      // populate the chat-message field with garbage that the chip will
      // then render verbatim.
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'resume_unknown',
          attemptedResumeId: 42,
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBeUndefined()
      }
    })

    it('coerces an empty-string attemptedResumeId to undefined', () => {
      // Empty string is treated as missing — the chip's render guard
      // already treats whitespace-only as absent, but normalising at the
      // store boundary means downstream consumers (mobile app, future
      // log/console viewers) see the same shape: present or absent, never
      // present-but-empty.
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'resume_unknown',
          attemptedResumeId: '',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBeUndefined()
      }
    })

    // PR #4967 Copilot review hardening: gating + trim + 256-char cap.
    it('drops attemptedResumeId when messageType is not error (out-of-contract gating)', () => {
      // Documented as set only on `type === 'error'`; a buggy producer
      // attaching it to e.g. a `response` envelope must not pollute the
      // store with out-of-contract data.
      const out = handleMessage(
        {
          messageType: 'response',
          content: 'hello',
          code: 'resume_unknown',
          attemptedResumeId: 'abc123',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBeUndefined()
      }
    })

    it('drops attemptedResumeId when code is not resume_unknown (out-of-contract gating)', () => {
      // Only the resume-unknown error path documents this field; other
      // error codes attaching it (drift or producer bug) shouldn't make
      // it into the store.
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'stream_stall',
          attemptedResumeId: 'abc123',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBeUndefined()
      }
    })

    it('trims whitespace from attemptedResumeId before storing', () => {
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'resume_unknown',
          attemptedResumeId: '  abc123  ',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBe('abc123')
      }
    })

    it('drops attemptedResumeId when only whitespace', () => {
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'resume_unknown',
          attemptedResumeId: '   \t  ',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBeUndefined()
      }
    })

    it('truncates attemptedResumeId to 256 chars (matches wire schema cap)', () => {
      const oversized = 'a'.repeat(500)
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'resume_unknown',
          attemptedResumeId: oversized,
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBe('a'.repeat(256))
      }
    })

    // #5006: server PR #5004 introduced the terminal-escalation code
    // `resume_unknown_exhausted` emitted when the post-fallback retry ALSO
    // matches the unknown-resume pattern. event-normalizer.js already
    // forwards `attemptedResumeId` for the new code; the store-core gate
    // must mirror that or the field is silently stripped before reaching
    // the dashboard / mobile chip. These tests pin the widened gate.
    it('#5006 — preserves attemptedResumeId on resume_unknown_exhausted (terminal escalation)', () => {
      const out = handleMessage(
        {
          messageType: 'error',
          content:
            'Auto-recovery exhausted: Claude CLI rejected the resumed conversation id and a fresh-start retry also failed.',
          code: 'resume_unknown_exhausted',
          attemptedResumeId: 'abc123-def456-7890',
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.code).toBe('resume_unknown_exhausted')
        expect(out.chatMessage.attemptedResumeId).toBe('abc123-def456-7890')
      }
    })

    it('#5006 — trims and truncates attemptedResumeId on resume_unknown_exhausted (same hardening as resume_unknown)', () => {
      const oversized = '   ' + 'a'.repeat(500) + '   '
      const out = handleMessage(
        {
          messageType: 'error',
          content: 'x',
          code: 'resume_unknown_exhausted',
          attemptedResumeId: oversized,
          timestamp: 100,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.shouldDispatch).toBe(true)
      if (out.shouldDispatch) {
        expect(out.chatMessage.attemptedResumeId).toBe('a'.repeat(256))
      }
    })
  })

  it('skips user_input outside replay (live echo handled elsewhere)', () => {
    const out = handleMessage(
      { messageType: 'user_input', content: 'hi', timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(false)
  })

  it('renders user_input during replay', () => {
    const out = handleMessage(
      { messageType: 'user_input', content: 'hi', timestamp: 1 },
      'sess-active',
      true,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) {
      expect(out.chatMessage.type).toBe('user_input')
    }
  })

  it('skips replay duplicates', () => {
    const cached: ChatMessage[] = [
      { id: 'srv-1', type: 'response', content: 'hello', timestamp: 100 },
    ]
    const out = handleMessage(
      {
        messageType: 'response',
        messageId: 'srv-1',
        content: 'hello',
        timestamp: 100,
      },
      'sess-active',
      true,
      cached,
    )
    expect(out.shouldDispatch).toBe(false)
  })

  it('does NOT run replay-dedup outside replay', () => {
    const cached: ChatMessage[] = [
      { id: 'srv-1', type: 'response', content: 'hello', timestamp: 100 },
    ]
    const out = handleMessage(
      {
        messageType: 'response',
        messageId: 'srv-1',
        content: 'hello',
        timestamp: 100,
      },
      'sess-active',
      false,
      cached,
    )
    expect(out.shouldDispatch).toBe(true)
  })

  it('uses stableMessageId for ALL message types when present (canonical #2902 behaviour)', () => {
    const out1 = handleMessage(
      {
        messageType: 'response',
        messageId: 'srv-resp-1',
        content: 'hello',
        timestamp: 1,
      },
      'sess-active',
      false,
      [],
    )
    if (!out1.shouldDispatch) throw new Error('expected dispatch')
    expect(out1.chatMessage.id).toBe('srv-resp-1')

    const out2 = handleMessage(
      {
        messageType: 'user_input',
        messageId: 'srv-input-1',
        content: 'hi',
        timestamp: 2,
      },
      'sess-active',
      true,
      [],
    )
    if (!out2.shouldDispatch) throw new Error('expected dispatch')
    expect(out2.chatMessage.id).toBe('srv-input-1')

    const out3 = handleMessage(
      {
        messageType: 'error',
        messageId: 'srv-err-1',
        content: 'oops',
        timestamp: 3,
      },
      'sess-active',
      false,
      [],
    )
    if (!out3.shouldDispatch) throw new Error('expected dispatch')
    expect(out3.chatMessage.id).toBe('srv-err-1')
  })

  it('generates a fresh id when no stableMessageId is provided', () => {
    const out = handleMessage(
      { messageType: 'response', content: 'hello', timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    if (!out.shouldDispatch) throw new Error('expected dispatch')
    expect(out.chatMessage.id).toMatch(/^response-\d+-\d+$/)
  })

  it('builds ChatMessage with content, tool, options, timestamp passed through', () => {
    const opts = [{ label: 'a', value: '1' }]
    const out = handleMessage(
      {
        messageType: 'tool_use',
        content: 'using bash',
        tool: 'Bash',
        options: opts,
        timestamp: 999,
      },
      'sess-active',
      false,
      [],
    )
    if (!out.shouldDispatch) throw new Error('expected dispatch')
    expect(out.chatMessage.content).toBe('using bash')
    expect(out.chatMessage.tool).toBe('Bash')
    expect(out.chatMessage.options).toBe(opts)
    expect(out.chatMessage.timestamp).toBe(999)
  })

  it('detects rate-limit errors (case-insensitive)', () => {
    const cases = [
      'Rate Limit exceeded',
      'usage limit hit',
      'You have exceeded your QUOTA',
      'API is overloaded right now',
    ]
    for (const content of cases) {
      const out = handleMessage(
        { messageType: 'error', content, timestamp: 1 },
        'sess-active',
        false,
        [],
      )
      if (!out.shouldDispatch) throw new Error('expected dispatch')
      expect(out.isRateLimitError).toBe(true)
      expect(out.errorContent).toBe(content)
    }
  })

  it('does not flag non-rate-limit errors', () => {
    const out = handleMessage(
      { messageType: 'error', content: 'random failure', timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    if (!out.shouldDispatch) throw new Error('expected dispatch')
    expect(out.isRateLimitError).toBe(false)
    expect(out.errorContent).toBeNull()
  })

  it('only flags rate-limit when msgType is error', () => {
    const out = handleMessage(
      {
        messageType: 'response',
        content: 'rate limit mention in response',
        timestamp: 1,
      },
      'sess-active',
      false,
      [],
    )
    if (!out.shouldDispatch) throw new Error('expected dispatch')
    expect(out.isRateLimitError).toBe(false)
  })

  it('does not flag rate-limit when content is non-string', () => {
    const out = handleMessage(
      { messageType: 'error', content: 42, timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    // content: 42 fails the `typeof content === 'string'` guard, so dispatch is dropped.
    expect(out.shouldDispatch).toBe(false)
  })

  // Runtime validation guards (Copilot review on PR #3148): handleMessage now
  // rejects malformed payloads up front rather than building an invalid
  // ChatMessage and letting it crash render paths.
  it('drops dispatch when messageType / type is missing', () => {
    const out = handleMessage(
      { content: 'hi', timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(false)
  })

  it('drops dispatch when messageType is non-string', () => {
    const out = handleMessage(
      { messageType: 7, content: 'hi', timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(false)
  })

  it('drops dispatch when content is non-string', () => {
    const out = handleMessage(
      { messageType: 'response', content: 42, timestamp: 1 },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(false)
  })

  it('drops dispatch when timestamp is non-number', () => {
    const out = handleMessage(
      { messageType: 'response', content: 'hi', timestamp: 'now' },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(false)
  })

  it('drops tool field when non-string (sanitises rather than passing through)', () => {
    const out = handleMessage(
      {
        messageType: 'tool_use',
        content: 'using bash',
        tool: 99,
        timestamp: 1,
      },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    if (out.shouldDispatch) {
      expect(out.chatMessage.tool).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// handleToolStart
// ---------------------------------------------------------------------------
describe('handleToolStart', () => {
  it('uses server messageId as the tool id when present', () => {
    const out = handleToolStart(
      {
        messageId: 'srv-tool-1',
        sessionId: 'sess-1',
        tool: 'Bash',
        toolUseId: 'tu-1',
        input: { cmd: 'ls' },
      },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    expect(out.chatMessage!.id).toBe('srv-tool-1')
  })

  it('generates a tool id when no messageId is provided', () => {
    const out = handleToolStart(
      { sessionId: 'sess-1', tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.shouldDispatch).toBe(true)
    expect(out.chatMessage!.id).toMatch(/^tool-\d+-\d+$/)
  })

  it('skips dispatch when replay cache already contains the same id', () => {
    const cached: ChatMessage[] = [
      {
        id: 'srv-tool-1',
        type: 'tool_use',
        content: '',
        timestamp: 1,
      },
    ]
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      'sess-active',
      true,
      cached,
    )
    expect(out.shouldDispatch).toBe(false)
    expect(out.chatMessage).toBeNull()
  })

  it('dispatches during replay when cache has no matching id', () => {
    const cached: ChatMessage[] = [
      { id: 'other-id', type: 'tool_use', content: '', timestamp: 1 },
    ]
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      'sess-active',
      true,
      cached,
    )
    expect(out.shouldDispatch).toBe(true)
    expect(out.chatMessage!.id).toBe('srv-tool-1')
  })

  it('dispatches outside replay regardless of cache content', () => {
    const cached: ChatMessage[] = [
      { id: 'srv-tool-1', type: 'tool_use', content: '', timestamp: 1 },
    ]
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      'sess-active',
      false,
      cached,
    )
    expect(out.shouldDispatch).toBe(true)
    expect(out.chatMessage!.id).toBe('srv-tool-1')
  })

  it('serialises input as JSON when present', () => {
    const out = handleToolStart(
      {
        messageId: 'srv-tool-1',
        tool: 'Bash',
        input: { cmd: 'ls', flag: true },
      },
      'sess-active',
      false,
      [],
    )
    expect(out.chatMessage!.content).toBe(JSON.stringify({ cmd: 'ls', flag: true }))
  })

  it('falls back to tool name when input is absent', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.chatMessage!.content).toBe('Bash')
  })

  it('falls back to empty string when both input and tool are absent', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1' },
      'sess-active',
      false,
      [],
    )
    expect(out.chatMessage!.content).toBe('')
  })

  it('populates type/tool/toolUseId/serverName/timestamp on the ChatMessage', () => {
    const before = Date.now()
    const out = handleToolStart(
      {
        messageId: 'srv-tool-1',
        tool: 'Read',
        toolUseId: 'tu-99',
        serverName: 'mcp-server',
        input: { path: '/x' },
      },
      'sess-active',
      false,
      [],
    )
    const after = Date.now()
    const cm = out.chatMessage!
    expect(cm.type).toBe('tool_use')
    expect(cm.tool).toBe('Read')
    expect(cm.toolUseId).toBe('tu-99')
    expect(cm.serverName).toBe('mcp-server')
    expect(cm.timestamp).toBeGreaterThanOrEqual(before)
    expect(cm.timestamp).toBeLessThanOrEqual(after)
  })

  it('resolves sessionId from message when present', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', sessionId: 'sess-1', tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.sessionId).toBe('sess-1')
  })

  it('falls back to active session when message has no sessionId', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.sessionId).toBe('sess-active')
  })

  it('returns null sessionId when neither active nor message provides one', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      null,
      false,
      [],
    )
    expect(out.sessionId).toBeNull()
  })

  it("exposes resolved toolName (msg.tool when present)", () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.toolName).toBe('Bash')
  })

  it("exposes 'tool' fallback toolName when msg.tool is missing", () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1' },
      'sess-active',
      false,
      [],
    )
    expect(out.toolName).toBe('tool')
  })

  it('coerces non-string msg.tool to undefined and toolName to fallback', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', tool: 123 },
      'sess-active',
      false,
      [],
    )
    expect(out.chatMessage!.tool).toBeUndefined()
    expect(out.toolName).toBe('tool')
    // content fallback also coerces: no input + non-string tool → ''
    expect(out.chatMessage!.content).toBe('')
  })

  it('coerces non-string msg.messageId to a generated id', () => {
    const out = handleToolStart(
      { messageId: 42, tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.chatMessage!.id).toMatch(/^tool-\d+-\d+$/)
  })

  it('coerces non-string msg.sessionId to activeSessionId fallback', () => {
    const out = handleToolStart(
      { messageId: 'srv-tool-1', sessionId: 42, tool: 'Bash' },
      'sess-active',
      false,
      [],
    )
    expect(out.sessionId).toBe('sess-active')
  })

  // #4308 — activeTools tracking
  describe('activeTools (#4308)', () => {
    it('emits an ActiveTool entry with tool name, toolUseId, input, startedAt', () => {
      const out = handleToolStart(
        {
          messageId: 'srv-tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          input: { cmd: 'ls' },
        },
        'sess-active',
        false,
        [],
      )
      expect(out.activeTool).not.toBeNull()
      expect(out.activeTool!.toolUseId).toBe('tu-1')
      expect(out.activeTool!.tool).toBe('Bash')
      expect(out.activeTool!.input).toEqual({ cmd: 'ls' })
      expect(typeof out.activeTool!.startedAt).toBe('number')
      expect(out.activeTool!.startedAt).toBeGreaterThan(0)
    })

    it('omits serverName when not present on the wire', () => {
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash', toolUseId: 'tu-1' },
        'sess-active',
        false,
        [],
      )
      expect(out.activeTool!.serverName).toBeUndefined()
    })

    it('forwards serverName for MCP tools', () => {
      const out = handleToolStart(
        {
          messageId: 'srv-tool-1',
          tool: 'mcp__chrome_devtools__take_snapshot',
          toolUseId: 'tu-1',
          serverName: 'chrome_devtools',
        },
        'sess-active',
        false,
        [],
      )
      expect(out.activeTool!.serverName).toBe('chrome_devtools')
    })

    it('returns null activeTool when toolUseId is missing', () => {
      // Without a stable toolUseId we cannot dedup or remove on tool_result,
      // so skip the push rather than orphan an entry.
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash' },
        'sess-active',
        false,
        [],
      )
      expect(out.activeTool).toBeNull()
    })

    it('returns null activeTool during replay dedup', () => {
      const cached: ChatMessage[] = [
        { id: 'srv-tool-1', type: 'tool_use', content: '', timestamp: 1 },
      ]
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash', toolUseId: 'tu-1' },
        'sess-active',
        true,
        cached,
      )
      expect(out.shouldDispatch).toBe(false)
      expect(out.activeTool).toBeNull()
    })

    // #4607 — the server's history ring buffer stamps `timestamp: Date.now()`
    // at append time and forwards it on every replay
    // (session-message-history.js:208-216). When the dashboard rebuilds the
    // tool_use ChatMessage during history_replay (e.g. because fullHistory
    // wiped the messages array so the cached-id dedup misses), it must
    // honour that wire timestamp instead of stamping a new Date.now(). Both
    // `chatMessage.timestamp` AND the derived `activeTool.startedAt` must
    // carry it through, otherwise the "Running <tool> · Ns" pill restarts
    // at ~1s on tab-switch for any session whose activeTools was previously
    // empty (toolUseId-dedup in applyToActiveTools only protects the case
    // where the same id is already tracked).
    it('honours wire `timestamp` field on the tool_start payload (#4607)', () => {
      const wireTimestamp = 1_700_000_000_000
      const out = handleToolStart(
        {
          messageId: 'srv-tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          timestamp: wireTimestamp,
        },
        'sess-active',
        false,
        [],
      )
      expect(out.chatMessage!.timestamp).toBe(wireTimestamp)
      expect(out.activeTool!.startedAt).toBe(wireTimestamp)
    })

    it('falls back to Date.now() when wire `timestamp` is missing (live tool_start, #4607)', () => {
      const before = Date.now()
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash', toolUseId: 'tu-1' },
        'sess-active',
        false,
        [],
      )
      const after = Date.now()
      expect(out.chatMessage!.timestamp).toBeGreaterThanOrEqual(before)
      expect(out.chatMessage!.timestamp).toBeLessThanOrEqual(after)
      expect(out.activeTool!.startedAt).toBe(out.chatMessage!.timestamp)
    })

    it('ignores non-finite wire `timestamp` and falls back to Date.now() (#4607)', () => {
      // Defensive: a malformed wire payload (NaN, Infinity, string-coerced)
      // must not poison the elapsed-time clock with NaN-driven arithmetic.
      const before = Date.now()
      const out = handleToolStart(
        {
          messageId: 'srv-tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          timestamp: Number.NaN,
        },
        'sess-active',
        false,
        [],
      )
      const after = Date.now()
      expect(out.chatMessage!.timestamp).toBeGreaterThanOrEqual(before)
      expect(out.chatMessage!.timestamp).toBeLessThanOrEqual(after)
    })

    it('applyToActiveTools pushes the new entry onto the array', () => {
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash', toolUseId: 'tu-1' },
        'sess-active',
        false,
        [],
      )
      const next = out.applyToActiveTools([])
      expect(next).toHaveLength(1)
      expect(next[0]!.toolUseId).toBe('tu-1')
      expect(next[0]!.tool).toBe('Bash')
    })

    it('applyToActiveTools dedupes by toolUseId (same reference on duplicate)', () => {
      const existing: ActiveTool[] = [
        { toolUseId: 'tu-1', tool: 'Bash', startedAt: 1 },
      ]
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash', toolUseId: 'tu-1' },
        'sess-active',
        false,
        [],
      )
      const next = out.applyToActiveTools(existing)
      expect(next).toBe(existing)
    })

    it('applyToActiveTools is a no-op when activeTool is null (no toolUseId)', () => {
      const existing: ActiveTool[] = [
        { toolUseId: 'tu-0', tool: 'Read', startedAt: 1 },
      ]
      const out = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash' }, // no toolUseId
        'sess-active',
        false,
        [],
      )
      expect(out.activeTool).toBeNull()
      expect(out.applyToActiveTools(existing)).toBe(existing)
    })

    it('supports parallel in-flight tools (multiple distinct toolUseIds)', () => {
      const out1 = handleToolStart(
        { messageId: 'srv-tool-1', tool: 'Bash', toolUseId: 'tu-1' },
        'sess-active',
        false,
        [],
      )
      const out2 = handleToolStart(
        { messageId: 'srv-tool-2', tool: 'Read', toolUseId: 'tu-2' },
        'sess-active',
        false,
        [],
      )
      const step1 = out1.applyToActiveTools([])
      const step2 = out2.applyToActiveTools(step1)
      expect(step2.map((t) => t.toolUseId)).toEqual(['tu-1', 'tu-2'])
    })
  })
})

// ---------------------------------------------------------------------------
// handleToolResult
// ---------------------------------------------------------------------------
describe('handleToolResult', () => {
  it('returns null when toolUseId is missing', () => {
    const out = handleToolResult({ result: 'ok' }, 'sess-active')
    expect(out).toBeNull()
  })

  it('returns null when toolUseId is non-string', () => {
    const out = handleToolResult({ toolUseId: 42, result: 'ok' }, 'sess-active')
    expect(out).toBeNull()
  })

  it('builds patch with toolResult and toolResultTruncated', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 'hello', truncated: true },
      'sess-active',
    )
    expect(out).not.toBeNull()
    expect(out!.patch.toolResult).toBe('hello')
    expect(out!.patch.toolResultTruncated).toBe(true)
  })

  it('omits toolResultImages when images is missing', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 'ok' },
      'sess-active',
    )
    expect(out!.patch.toolResultImages).toBeUndefined()
  })

  it('omits toolResultImages when images array is empty', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 'ok', images: [] },
      'sess-active',
    )
    expect(out!.patch.toolResultImages).toBeUndefined()
  })

  it('includes toolResultImages when images array has entries', () => {
    const images = [{ mediaType: 'image/png', data: 'base64-data' }]
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 'ok', images },
      'sess-active',
    )
    expect(out!.patch.toolResultImages).toEqual(images)
  })

  it("defaults resultText to '' when missing", () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1' },
      'sess-active',
    )
    expect(out!.resultText).toBe('')
    expect(out!.patch.toolResult).toBe('')
  })

  it('exposes resultText for caller side-effects', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 'visible-text' },
      'sess-active',
    )
    expect(out!.resultText).toBe('visible-text')
  })

  // #6712 — carry isError so a failed tool_result (codex mcpToolCall / orphan
  // sweep) can be styled by the renderers.
  it('patches toolResultIsError from a boolean msg.isError', () => {
    expect(handleToolResult({ toolUseId: 'tu-1', result: 'boom', isError: true }, 's')!.patch.toolResultIsError).toBe(true)
    expect(handleToolResult({ toolUseId: 'tu-1', result: 'ok', isError: false }, 's')!.patch.toolResultIsError).toBe(false)
  })

  it('defaults toolResultIsError to false when isError is absent or non-boolean', () => {
    expect(handleToolResult({ toolUseId: 'tu-1', result: 'ok' }, 's')!.patch.toolResultIsError).toBe(false)
    // non-boolean coerces to the safe default (matches the truncated guard)
    expect(handleToolResult({ toolUseId: 'tu-1', result: 'ok', isError: 'true' as unknown as boolean }, 's')!.patch.toolResultIsError).toBe(false)
  })

  it('resolves sessionId from message when present', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', sessionId: 'sess-1', result: 'ok' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-1')
  })

  it('falls back to active sessionId when not on message', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 'ok' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  it('exposes toolUseId on the result', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-99', result: 'ok' },
      'sess-active',
    )
    expect(out!.toolUseId).toBe('tu-99')
  })

  it('coerces non-string msg.result to empty string', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', result: 123 },
      'sess-active',
    )
    expect(out!.resultText).toBe('')
    expect(out!.patch.toolResult).toBe('')
  })

  it('coerces non-boolean msg.truncated to false', () => {
    // Behaviour-defensive: matches the convention used by handleFileContent
    // (truthy non-boolean values do not flip truncated to true).
    expect(
      handleToolResult({ toolUseId: 'tu-1', truncated: 'yes' }, 'sess-active')!
        .patch.toolResultTruncated,
    ).toBe(false)
    expect(
      handleToolResult({ toolUseId: 'tu-1', truncated: 1 }, 'sess-active')!
        .patch.toolResultTruncated,
    ).toBe(false)
  })

  it('coerces non-string msg.sessionId to activeSessionId fallback', () => {
    const out = handleToolResult(
      { toolUseId: 'tu-1', sessionId: 42, result: 'ok' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  describe('applyTo()', () => {
    const baseMessages: ChatMessage[] = [
      { id: 'msg-1', type: 'response', content: 'hello', timestamp: 1 },
      {
        id: 'msg-2',
        type: 'tool_use',
        content: 'Bash',
        toolUseId: 'tu-1',
        timestamp: 2,
      },
      { id: 'msg-3', type: 'response', content: 'after', timestamp: 3 },
    ]

    it('finds the matching tool_use message and merges patch', () => {
      const out = handleToolResult(
        { toolUseId: 'tu-1', result: 'output', truncated: false },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated).not.toBe(baseMessages)
      expect(updated[1]).toMatchObject({
        id: 'msg-2',
        type: 'tool_use',
        toolUseId: 'tu-1',
        toolResult: 'output',
        toolResultTruncated: false,
      })
    })

    it('returns same array reference when no matching tool_use is found (no-op)', () => {
      const out = handleToolResult(
        { toolUseId: 'tu-missing', result: 'output' },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated).toBe(baseMessages)
    })

    it("does not match a non-tool_use message even if its toolUseId field equals", () => {
      // Defensive: only tool_use messages are valid match targets.
      const messages: ChatMessage[] = [
        // hypothetical: a response message with the same toolUseId on it
        {
          id: 'm-1',
          type: 'response',
          content: 'x',
          toolUseId: 'tu-1',
          timestamp: 1,
        },
      ]
      const out = handleToolResult({ toolUseId: 'tu-1', result: 'out' }, 'sess-active')
      const updated = out!.applyTo(messages)
      expect(updated).toBe(messages)
    })

    it('does not disturb other messages in the array', () => {
      const out = handleToolResult(
        { toolUseId: 'tu-1', result: 'output' },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated[0]).toBe(baseMessages[0])
      expect(updated[2]).toBe(baseMessages[2])
    })

    it('attaches toolResultImages when present', () => {
      const images = [{ mediaType: 'image/png', data: 'b64' }]
      const out = handleToolResult(
        { toolUseId: 'tu-1', result: 'out', images },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated[1]!.toolResultImages).toEqual(images)
    })
  })

  // #4308 — activeTools removal
  describe('applyToActiveTools (#4308)', () => {
    it('removes the entry whose toolUseId matches', () => {
      const out = handleToolResult({ toolUseId: 'tu-1', result: 'ok' }, 'sess-active')
      const before: ActiveTool[] = [
        { toolUseId: 'tu-1', tool: 'Bash', startedAt: 1 },
        { toolUseId: 'tu-2', tool: 'Read', startedAt: 2 },
      ]
      const after = out!.applyToActiveTools(before)
      expect(after).toHaveLength(1)
      expect(after[0]!.toolUseId).toBe('tu-2')
    })

    it('returns same array reference when toolUseId is not present (no-op)', () => {
      const out = handleToolResult({ toolUseId: 'tu-missing', result: 'ok' }, 'sess-active')
      const before: ActiveTool[] = [
        { toolUseId: 'tu-1', tool: 'Bash', startedAt: 1 },
      ]
      const after = out!.applyToActiveTools(before)
      expect(after).toBe(before)
    })

    it('removes only the matching entry when multiple in-flight tools exist', () => {
      const out = handleToolResult({ toolUseId: 'tu-2', result: 'ok' }, 'sess-active')
      const before: ActiveTool[] = [
        { toolUseId: 'tu-1', tool: 'Bash', startedAt: 1 },
        { toolUseId: 'tu-2', tool: 'Read', startedAt: 2 },
        { toolUseId: 'tu-3', tool: 'WebFetch', startedAt: 3 },
      ]
      const after = out!.applyToActiveTools(before)
      expect(after.map((t) => t.toolUseId)).toEqual(['tu-1', 'tu-3'])
    })
  })
})

// ---------------------------------------------------------------------------
// handleToolInputDelta (#4081)
// ---------------------------------------------------------------------------
describe('handleToolInputDelta', () => {
  it('returns null when toolUseId is missing', () => {
    const out = handleToolInputDelta({ partialJson: '{"a":1}' }, 'sess-active')
    expect(out).toBeNull()
  })

  it('returns null when toolUseId is non-string', () => {
    const out = handleToolInputDelta(
      { toolUseId: 42, partialJson: '{"a":1}' },
      'sess-active',
    )
    expect(out).toBeNull()
  })

  it('returns null when partialJson is missing', () => {
    const out = handleToolInputDelta({ toolUseId: 'tu-1' }, 'sess-active')
    expect(out).toBeNull()
  })

  it('returns null when partialJson is non-string', () => {
    const out = handleToolInputDelta(
      { toolUseId: 'tu-1', partialJson: 123 },
      'sess-active',
    )
    expect(out).toBeNull()
  })

  it('accepts empty-string partialJson (SDK can emit empty chunks)', () => {
    const out = handleToolInputDelta(
      { toolUseId: 'tu-1', partialJson: '' },
      'sess-active',
    )
    expect(out).not.toBeNull()
    expect(out!.partialJson).toBe('')
  })

  it('resolves sessionId from message when present', () => {
    const out = handleToolInputDelta(
      { toolUseId: 'tu-1', partialJson: '{', sessionId: 'sess-1' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-1')
  })

  it('falls back to active sessionId when not on message', () => {
    const out = handleToolInputDelta(
      { toolUseId: 'tu-1', partialJson: '{' },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  it('coerces non-string sessionId to activeSessionId fallback', () => {
    const out = handleToolInputDelta(
      { toolUseId: 'tu-1', partialJson: '{', sessionId: 42 },
      'sess-active',
    )
    expect(out!.sessionId).toBe('sess-active')
  })

  describe('applyTo()', () => {
    const baseMessages: ChatMessage[] = [
      { id: 'msg-1', type: 'response', content: 'hello', timestamp: 1 },
      {
        id: 'msg-2',
        type: 'tool_use',
        content: 'Bash',
        toolUseId: 'tu-1',
        timestamp: 2,
      },
      { id: 'msg-3', type: 'response', content: 'after', timestamp: 3 },
    ]

    it('appends partialJson to undefined toolInputPartial on first delta', () => {
      const out = handleToolInputDelta(
        { toolUseId: 'tu-1', partialJson: '{"command":"' },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated).not.toBe(baseMessages)
      expect(updated[1]!.toolInputPartial).toBe('{"command":"')
    })

    it('concatenates 3 sequential partials into the full buffer', () => {
      // Canonical case from the issue: Bash `command` assembled across
      // 3 input_json_delta chunks. After all 3 deltas the buffer must
      // equal their string concatenation in arrival order.
      const chunks = ['{"command":"', 'rm -rf /tmp/', 'foo"}']
      let messages = baseMessages
      for (const partialJson of chunks) {
        const out = handleToolInputDelta(
          { toolUseId: 'tu-1', partialJson },
          'sess-active',
        )
        messages = out!.applyTo(messages)
      }
      expect(messages[1]!.toolInputPartial).toBe('{"command":"rm -rf /tmp/foo"}')
    })

    it('returns same array reference when no matching tool_use is found (no-op)', () => {
      const out = handleToolInputDelta(
        { toolUseId: 'tu-missing', partialJson: '{' },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated).toBe(baseMessages)
    })

    it('does not match a non-tool_use message even if its toolUseId field equals', () => {
      const messages: ChatMessage[] = [
        {
          id: 'm-1',
          type: 'response',
          content: 'x',
          toolUseId: 'tu-1',
          timestamp: 1,
        },
      ]
      const out = handleToolInputDelta(
        { toolUseId: 'tu-1', partialJson: '{' },
        'sess-active',
      )
      expect(out!.applyTo(messages)).toBe(messages)
    })

    it('does not disturb other messages in the array', () => {
      const out = handleToolInputDelta(
        { toolUseId: 'tu-1', partialJson: '{' },
        'sess-active',
      )
      const updated = out!.applyTo(baseMessages)
      expect(updated[0]).toBe(baseMessages[0])
      expect(updated[2]).toBe(baseMessages[2])
    })

    it('only touches the matching tool_use when multiple tool_use entries exist', () => {
      const messages: ChatMessage[] = [
        { id: 'm-1', type: 'tool_use', content: 'A', toolUseId: 'tu-a', timestamp: 1 },
        { id: 'm-2', type: 'tool_use', content: 'B', toolUseId: 'tu-b', timestamp: 2 },
      ]
      const out = handleToolInputDelta(
        { toolUseId: 'tu-b', partialJson: '{"x":1}' },
        'sess-active',
      )
      const updated = out!.applyTo(messages)
      expect(updated[0]).toBe(messages[0])
      expect(updated[0]!.toolInputPartial).toBeUndefined()
      expect(updated[1]!.toolInputPartial).toBe('{"x":1}')
    })

    it('preserves existing toolInputPartial when applyTo runs after prior deltas', () => {
      const seeded: ChatMessage[] = [
        {
          id: 'msg-2',
          type: 'tool_use',
          content: 'Bash',
          toolUseId: 'tu-1',
          toolInputPartial: '{"command":"ls',
          timestamp: 2,
        },
      ]
      const out = handleToolInputDelta(
        { toolUseId: 'tu-1', partialJson: ' -la"}' },
        'sess-active',
      )
      const updated = out!.applyTo(seeded)
      expect(updated[0]!.toolInputPartial).toBe('{"command":"ls -la"}')
    })

    // Cap defends against adversarial / runaway tool input that would
    // otherwise grow client `messages` state without bound. The cap value
    // (1 MiB) is exported as `MAX_TOOL_INPUT_PARTIAL_LEN`. When the buffer
    // would exceed the cap, further chunks are dropped and the bubble's
    // `toolInputPartialTruncated` boolean is set to `true` exactly once
    // (#4263) so the UI can show the user input was cut off — subsequent
    // deltas after truncation are dropped silently. See issues #4241
    // and #4263.
    describe('toolInputPartial length cap (#4241, #4263)', () => {
      it('exposes MAX_TOOL_INPUT_PARTIAL_LEN equal to 1 MiB', () => {
        expect(MAX_TOOL_INPUT_PARTIAL_LEN).toBe(1024 * 1024)
      })

      it('does not truncate when concatenated length stays below the cap', () => {
        const chunk = 'a'.repeat(1024)
        const seeded: ChatMessage[] = [
          {
            id: 'msg-2',
            type: 'tool_use',
            content: 'Bash',
            toolUseId: 'tu-1',
            toolInputPartial: 'a'.repeat(MAX_TOOL_INPUT_PARTIAL_LEN - 2048),
            timestamp: 2,
          },
        ]
        const out = handleToolInputDelta(
          { toolUseId: 'tu-1', partialJson: chunk },
          'sess-active',
        )
        const updated = out!.applyTo(seeded)
        expect(updated[0]!.toolInputPartial!.length).toBe(
          MAX_TOOL_INPUT_PARTIAL_LEN - 1024,
        )
        expect(updated[0]!.toolInputPartial!.endsWith('[truncated]')).toBe(false)
        expect(updated[0]!.toolInputPartialTruncated).toBeUndefined()
      })

      it('caps the buffer and sets toolInputPartialTruncated when a chunk pushes past the cap', () => {
        const existing = 'a'.repeat(MAX_TOOL_INPUT_PARTIAL_LEN - 10)
        const seeded: ChatMessage[] = [
          {
            id: 'msg-2',
            type: 'tool_use',
            content: 'Bash',
            toolUseId: 'tu-1',
            toolInputPartial: existing,
            timestamp: 2,
          },
        ]
        // Adding 100 'b's would land at len = cap + 90.
        const out = handleToolInputDelta(
          { toolUseId: 'tu-1', partialJson: 'b'.repeat(100) },
          'sess-active',
        )
        const updated = out!.applyTo(seeded)
        const buf = updated[0]!.toolInputPartial!
        // #4263: buffer is the cap-bounded slice (existing 'a' run + first
        // 10 'b's) — NO in-band suffix marker, and length equals the cap.
        expect(buf.length).toBe(MAX_TOOL_INPUT_PARTIAL_LEN)
        expect(buf.endsWith('...[truncated]')).toBe(false)
        expect(buf).toBe(existing + 'b'.repeat(10))
        expect(updated[0]!.toolInputPartialTruncated).toBe(true)
      })

      it('truncates exactly at the cap when the boundary is hit precisely', () => {
        const existing = 'a'.repeat(MAX_TOOL_INPUT_PARTIAL_LEN - 5)
        const seeded: ChatMessage[] = [
          {
            id: 'msg-2',
            type: 'tool_use',
            content: 'Bash',
            toolUseId: 'tu-1',
            toolInputPartial: existing,
            timestamp: 2,
          },
        ]
        // Adding exactly 6 'b's pushes one byte past the cap.
        const out = handleToolInputDelta(
          { toolUseId: 'tu-1', partialJson: 'b'.repeat(6) },
          'sess-active',
        )
        const updated = out!.applyTo(seeded)
        const buf = updated[0]!.toolInputPartial!
        // 5 'b's keep buffer at the cap; the 6th would overflow.
        expect(buf).toBe(existing + 'b'.repeat(5))
        expect(buf.length).toBe(MAX_TOOL_INPUT_PARTIAL_LEN)
        expect(updated[0]!.toolInputPartialTruncated).toBe(true)
      })

      it('drops further deltas idempotently once toolInputPartialTruncated is set', () => {
        // After truncation, the flag is set. A following delta must not
        // accumulate further bytes (idempotent terminal state).
        const cappedBuf = 'a'.repeat(MAX_TOOL_INPUT_PARTIAL_LEN)
        const seeded: ChatMessage[] = [
          {
            id: 'msg-2',
            type: 'tool_use',
            content: 'Bash',
            toolUseId: 'tu-1',
            toolInputPartial: cappedBuf,
            toolInputPartialTruncated: true,
            timestamp: 2,
          },
        ]
        const out = handleToolInputDelta(
          { toolUseId: 'tu-1', partialJson: 'more data' },
          'sess-active',
        )
        const updated = out!.applyTo(seeded)
        // applyTo returns the same reference (no clone) on no-op.
        expect(updated).toBe(seeded)
        expect(updated[0]!.toolInputPartial).toBe(cappedBuf)
        expect(updated[0]!.toolInputPartialTruncated).toBe(true)
      })

      // #4263 backwards compatibility: a client may rehydrate state
      // written by a pre-#4263 client where the legacy in-band
      // `...[truncated]` suffix is the only terminal-state signal (no
      // boolean). The handler must still treat that buffer as terminal
      // and drop further deltas.
      it('drops further deltas when the legacy suffix marker is present without the boolean (backwards compat)', () => {
        const legacyMarker = '...[truncated]'
        const cappedBuf = 'a'.repeat(MAX_TOOL_INPUT_PARTIAL_LEN) + legacyMarker
        const seeded: ChatMessage[] = [
          {
            id: 'msg-2',
            type: 'tool_use',
            content: 'Bash',
            toolUseId: 'tu-1',
            toolInputPartial: cappedBuf,
            // NB: no toolInputPartialTruncated — this is the pre-#4263 shape.
            timestamp: 2,
          },
        ]
        const out = handleToolInputDelta(
          { toolUseId: 'tu-1', partialJson: 'more data' },
          'sess-active',
        )
        const updated = out!.applyTo(seeded)
        expect(updated).toBe(seeded)
        expect(updated[0]!.toolInputPartial).toBe(cappedBuf)
      })

      it('caps cumulative growth across many small chunks (5 MiB of input)', () => {
        // Realistic adversarial pattern: server emits many small chunks
        // that together would push past the cap. Verify the buffer never
        // grows beyond cap, regardless of arrival pattern, and the
        // truncation boolean is set exactly once.
        const chunk = 'x'.repeat(64 * 1024) // 64 KiB chunks
        const numChunks = 80 // ~5 MiB total
        let messages: ChatMessage[] = [
          {
            id: 'msg-2',
            type: 'tool_use',
            content: 'Bash',
            toolUseId: 'tu-1',
            timestamp: 2,
          },
        ]
        for (let i = 0; i < numChunks; i++) {
          const out = handleToolInputDelta(
            { toolUseId: 'tu-1', partialJson: chunk },
            'sess-active',
          )
          messages = out!.applyTo(messages)
        }
        const buf = messages[0]!.toolInputPartial!
        expect(buf.length).toBeLessThanOrEqual(MAX_TOOL_INPUT_PARTIAL_LEN)
        expect(buf.endsWith('...[truncated]')).toBe(false)
        expect(messages[0]!.toolInputPartialTruncated).toBe(true)
      })
    })
  })
})

// ---------------------------------------------------------------------------
// handleStreamStart
// ---------------------------------------------------------------------------
describe('handleStreamStart', () => {
  it('reuses existing response message (no new message, no remap)', () => {
    const existing: ChatMessage[] = [
      { id: 'msg-1', type: 'response', content: 'partial', timestamp: 1 },
    ]
    const out = handleStreamStart(
      { messageId: 'msg-1', sessionId: 'sess-1' },
      'sess-active',
      existing,
    )
    expect(out.sessionId).toBe('sess-1')
    expect(out.streamingMessageId).toBe('msg-1')
    expect(out.isNewMessage).toBe(false)
    expect(out.newMessage).toBeNull()
    expect(out.remap).toBeNull()
  })

  it('creates a new response message when no existing message matches', () => {
    const before = Date.now()
    const out = handleStreamStart(
      { messageId: 'msg-1', sessionId: 'sess-1' },
      'sess-active',
      [],
    )
    const after = Date.now()
    expect(out.sessionId).toBe('sess-1')
    expect(out.streamingMessageId).toBe('msg-1')
    expect(out.isNewMessage).toBe(true)
    expect(out.remap).toBeNull()
    expect(out.newMessage).not.toBeNull()
    expect(out.newMessage!.id).toBe('msg-1')
    expect(out.newMessage!.type).toBe('response')
    expect(out.newMessage!.content).toBe('')
    expect(out.newMessage!.timestamp).toBeGreaterThanOrEqual(before)
    expect(out.newMessage!.timestamp).toBeLessThanOrEqual(after)
  })

  it('returns a remap when existing message of different type collides with stream id', () => {
    const existing: ChatMessage[] = [
      { id: 'msg-1', type: 'tool_use', content: 'Bash', timestamp: 1 },
    ]
    const out = handleStreamStart(
      { messageId: 'msg-1', sessionId: 'sess-1' },
      'sess-active',
      existing,
    )
    expect(out.sessionId).toBe('sess-1')
    expect(out.streamingMessageId).toBe('msg-1-response')
    expect(out.isNewMessage).toBe(true)
    expect(out.remap).toEqual({ from: 'msg-1', to: 'msg-1-response' })
    expect(out.newMessage).not.toBeNull()
    expect(out.newMessage!.id).toBe('msg-1-response')
    expect(out.newMessage!.type).toBe('response')
  })

  it('falls back to active session when message has no sessionId', () => {
    const out = handleStreamStart(
      { messageId: 'msg-1' },
      'sess-active',
      [],
    )
    expect(out.sessionId).toBe('sess-active')
  })

  it('uses message sessionId when present', () => {
    const out = handleStreamStart(
      { messageId: 'msg-1', sessionId: 'sess-from-msg' },
      'sess-active',
      [],
    )
    expect(out.sessionId).toBe('sess-from-msg')
  })

  it('returns null sessionId when neither active nor message provides one', () => {
    const out = handleStreamStart(
      { messageId: 'msg-1' },
      null,
      [],
    )
    expect(out.sessionId).toBeNull()
    expect(out.streamingMessageId).toBe('msg-1')
  })

  it('falls back to nextMessageId when msg.messageId is not a string', () => {
    // Non-string messageId is a malformed payload (protocol schema requires
    // string). Helper synthesizes a fresh id rather than producing a
    // non-string ChatMessage.id that lies about its type.
    const out = handleStreamStart(
      { messageId: 42, sessionId: 'sess-1' },
      'sess-active',
      [],
    )
    expect(out.sessionId).toBe('sess-1')
    expect(typeof out.streamingMessageId).toBe('string')
    expect(out.streamingMessageId).not.toBe('42')
    expect(out.streamingMessageId.length).toBeGreaterThan(0)
    expect(out.isNewMessage).toBe(true)
    expect(out.newMessage).not.toBeNull()
    expect(typeof out.newMessage!.id).toBe('string')
  })

  it('falls back to activeSessionId when msg.sessionId is not a string', () => {
    const out = handleStreamStart(
      { messageId: 'msg-1', sessionId: 42 },
      'sess-active',
      [],
    )
    expect(out.sessionId).toBe('sess-active')
  })
})

// ---------------------------------------------------------------------------
// handleStreamEnd
// ---------------------------------------------------------------------------
describe('handleStreamEnd', () => {
  it('resolves sessionId from message when present', () => {
    const out = handleStreamEnd(
      { messageId: 'msg-1', sessionId: 'sess-from-msg' },
      'sess-active',
    )
    expect(out.sessionId).toBe('sess-from-msg')
    expect(out.messageId).toBe('msg-1')
  })

  it('falls back to active session when message has no sessionId', () => {
    const out = handleStreamEnd(
      { messageId: 'msg-1' },
      'sess-active',
    )
    expect(out.sessionId).toBe('sess-active')
    expect(out.messageId).toBe('msg-1')
  })

  it('returns null sessionId when neither active nor message provides one', () => {
    const out = handleStreamEnd(
      { messageId: 'msg-1' },
      null,
    )
    expect(out.sessionId).toBeNull()
    expect(out.messageId).toBe('msg-1')
  })

  it('returns null messageId when msg.messageId is not a string', () => {
    const out = handleStreamEnd(
      { messageId: 42 },
      'sess-active',
    )
    // The protocol schema (ServerStreamEndSchema) guarantees messageId is a
    // string for well-formed payloads. For malformed payloads, return null
    // rather than letting non-string values poison the call-site Maps used
    // for _deltaIdRemaps / _postPermissionSplits cleanup. Map.delete(null)
    // is a safe no-op.
    expect(out.messageId).toBeNull()
  })

  it('returns null messageId when msg.messageId is missing', () => {
    const out = handleStreamEnd(
      {},
      'sess-active',
    )
    expect(out.messageId).toBeNull()
    expect(out.sessionId).toBe('sess-active')
  })
})

// ---------------------------------------------------------------------------
// handleResultUsage
// ---------------------------------------------------------------------------
describe('handleResultUsage', () => {
  it('populates contextUsage from a complete usage object', () => {
    const out = handleResultUsage(
      {
        sessionId: 'sess-1',
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 25,
        },
        cost: 0.42,
        duration: 1234,
      },
      'active-1',
    )
    expect(out).toEqual({
      sessionId: 'sess-1',
      contextUsage: {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreation: 50,
        cacheRead: 25,
      },
      lastResultCost: 0.42,
      lastResultDuration: 1234,
    })
  })

  it('defaults missing usage fields to 0', () => {
    const out = handleResultUsage(
      { usage: {} },
      'active-1',
    )
    expect(out.contextUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
    })
  })

  it('returns null contextUsage when usage is missing', () => {
    const out = handleResultUsage({}, 'active-1')
    expect(out.contextUsage).toBeNull()
  })

  it('returns null contextUsage when usage is not an object', () => {
    expect(handleResultUsage({ usage: 'oops' }, 'active-1').contextUsage).toBeNull()
    expect(handleResultUsage({ usage: 42 }, 'active-1').contextUsage).toBeNull()
    expect(handleResultUsage({ usage: null }, 'active-1').contextUsage).toBeNull()
    expect(handleResultUsage({ usage: [] }, 'active-1').contextUsage).toBeNull()
    expect(
      handleResultUsage({ usage: [1, 2, 3] }, 'active-1').contextUsage,
    ).toBeNull()
  })

  it('coerces non-numeric usage fields to 0 (typeof guard rejects strings/objects/NaN)', () => {
    // Each field uses `typeof === 'number' && Number.isFinite(...)` so that a
    // malformed payload like `input_tokens: '100'` does not flow a string into
    // ContextUsage's numeric contract (would later poison `calculateCost`
    // arithmetic on the dashboard).
    const out = handleResultUsage(
      {
        usage: {
          input_tokens: '100',
          output_tokens: { x: 1 },
          cache_creation_input_tokens: NaN,
          cache_read_input_tokens: null,
        },
      },
      'active-1',
    )
    expect(out.contextUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
    })
  })

  it('passes a numeric cost through', () => {
    expect(handleResultUsage({ cost: 0.5 }, 'active-1').lastResultCost).toBe(0.5)
  })

  it('passes zero cost through', () => {
    expect(handleResultUsage({ cost: 0 }, 'active-1').lastResultCost).toBe(0)
  })

  it('returns null cost when missing', () => {
    expect(handleResultUsage({}, 'active-1').lastResultCost).toBeNull()
  })

  it('returns null cost when non-number', () => {
    expect(handleResultUsage({ cost: '0.5' }, 'active-1').lastResultCost).toBeNull()
    expect(handleResultUsage({ cost: null }, 'active-1').lastResultCost).toBeNull()
    expect(handleResultUsage({ cost: { x: 1 } }, 'active-1').lastResultCost).toBeNull()
  })

  it('passes a numeric duration through', () => {
    expect(handleResultUsage({ duration: 1234 }, 'active-1').lastResultDuration).toBe(1234)
  })

  it('passes zero duration through', () => {
    expect(handleResultUsage({ duration: 0 }, 'active-1').lastResultDuration).toBe(0)
  })

  it('returns null duration when missing', () => {
    expect(handleResultUsage({}, 'active-1').lastResultDuration).toBeNull()
  })

  it('returns null duration when non-number', () => {
    expect(handleResultUsage({ duration: '1234' }, 'active-1').lastResultDuration).toBeNull()
    expect(handleResultUsage({ duration: null }, 'active-1').lastResultDuration).toBeNull()
    expect(handleResultUsage({ duration: { x: 1 } }, 'active-1').lastResultDuration).toBeNull()
  })

  it('uses sessionId from message when present', () => {
    expect(
      handleResultUsage({ sessionId: 'sess-9' }, 'active-1').sessionId,
    ).toBe('sess-9')
  })

  it('falls back to active session when message has no sessionId', () => {
    expect(handleResultUsage({}, 'active-1').sessionId).toBe('active-1')
  })

  it('returns null sessionId when neither is available', () => {
    expect(handleResultUsage({}, null).sessionId).toBeNull()
  })

  it('preserves whitespace-padded sessionId verbatim (no trim)', () => {
    // A non-empty whitespace-padded string is truthy, so it's used as-is and
    // we do NOT fall back to activeSessionId. Matches `handleMcpServers` /
    // `handleCostUpdate` behaviour exactly.
    const out = handleResultUsage(
      { sessionId: '  sess-1  ' },
      'active-1',
    )
    expect(out.sessionId).toBe('  sess-1  ')
  })

  it('falls back to activeSessionId when sessionId is empty string', () => {
    // Empty string is falsy, so `|| activeSessionId` kicks in.
    const out = handleResultUsage(
      { sessionId: '' },
      'active-1',
    )
    expect(out.sessionId).toBe('active-1')
  })

  it('falls back to activeSessionId when sessionId is non-string runtime value', () => {
    // The `typeof === 'string'` guard rejects numbers/booleans/objects so
    // the declared `string | null` return type stays honest at runtime, even
    // for protocol-violating payloads.
    expect(
      handleResultUsage({ sessionId: 42 }, 'active-1').sessionId,
    ).toBe('active-1')
    expect(
      handleResultUsage({ sessionId: true }, 'active-1').sessionId,
    ).toBe('active-1')
    expect(
      handleResultUsage({ sessionId: { id: 'x' } }, 'active-1').sessionId,
    ).toBe('active-1')
    expect(
      handleResultUsage({ sessionId: null }, 'active-1').sessionId,
    ).toBe('active-1')
  })
})

// ---------------------------------------------------------------------------
// handleMultiQuestionIntervention (#4653)
// ---------------------------------------------------------------------------
describe('handleMultiQuestionIntervention', () => {
  it('appends a new intervention entry when toolUseId is unseen', () => {
    const builder = handleMultiQuestionIntervention(
      {
        sessionId: 'sess-1',
        toolUseId: 'toolu_1',
        questionCount: 3,
        reason: 'multi_question',
        timestamp: 1700000000000,
      },
      'active-1',
    )
    expect(builder).not.toBeNull()
    expect(builder!.sessionId).toBe('sess-1')
    const { interventions } = builder!.applyTo([])
    expect(interventions).toHaveLength(1)
    expect(interventions[0]).toEqual({
      kind: 'multi_question',
      toolUseId: 'toolu_1',
      count: 3,
      timestamp: 1700000000000,
    })
  })

  it('falls back to active session when message has no sessionId', () => {
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_2', questionCount: 2 },
      'active-1',
    )
    expect(builder!.sessionId).toBe('active-1')
  })

  it('dedups repeats by toolUseId — returns the array unchanged so React skips a re-render', () => {
    const existing = [
      { kind: 'multi_question' as const, toolUseId: 'toolu_dup', count: 4, timestamp: 100 },
    ]
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_dup', questionCount: 4, timestamp: 200 },
      'active-1',
    )
    const { interventions } = builder!.applyTo(existing)
    // Same reference — referential equality preserved for the React diff.
    expect(interventions).toBe(existing)
  })

  it('appends second distinct intervention to existing list', () => {
    const existing = [
      { kind: 'multi_question' as const, toolUseId: 'toolu_a', count: 2, timestamp: 100 },
    ]
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_b', questionCount: 5, timestamp: 200 },
      'active-1',
    )
    const { interventions } = builder!.applyTo(existing)
    expect(interventions).toHaveLength(2)
    expect(interventions[1].toolUseId).toBe('toolu_b')
    expect(interventions[1].count).toBe(5)
  })

  it('defaults timestamp to Date.now() when payload omits it', () => {
    const before = Date.now()
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_now', questionCount: 2 },
      'active-1',
    )
    const after = Date.now()
    const { interventions } = builder!.applyTo([])
    expect(interventions[0].timestamp).toBeGreaterThanOrEqual(before)
    expect(interventions[0].timestamp).toBeLessThanOrEqual(after)
  })

  it('floors fractional questionCount (defence-in-depth against malformed payloads)', () => {
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_frac', questionCount: 3.7 },
      'active-1',
    )
    const { interventions } = builder!.applyTo([])
    // 3.7 floors to 3 — still >= 2, so it's accepted with the floored value.
    expect(interventions[0].count).toBe(3)
  })

  it('returns null when toolUseId is missing or non-string', () => {
    expect(
      handleMultiQuestionIntervention({ questionCount: 2 }, 'active-1'),
    ).toBeNull()
    expect(
      handleMultiQuestionIntervention({ toolUseId: '', questionCount: 2 }, 'active-1'),
    ).toBeNull()
    expect(
      handleMultiQuestionIntervention({ toolUseId: 123, questionCount: 2 }, 'active-1'),
    ).toBeNull()
  })

  it('returns null when questionCount is missing, non-finite, or < 2 (mirrors wire schema)', () => {
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a' }, 'active-1'),
    ).toBeNull()
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a', questionCount: NaN }, 'active-1'),
    ).toBeNull()
    expect(
      handleMultiQuestionIntervention(
        { toolUseId: 'a', questionCount: Number.POSITIVE_INFINITY },
        'active-1',
      ),
    ).toBeNull()
    // < 2 — the permission-hook never denies single-q forms, so a 0/1
    // count is a malformed payload and would render a misleading
    // "0 questions" or "1 question" in the UI.
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a', questionCount: -1 }, 'active-1'),
    ).toBeNull()
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a', questionCount: 0 }, 'active-1'),
    ).toBeNull()
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a', questionCount: 1 }, 'active-1'),
    ).toBeNull()
    // 1.9 floors to 1 — also rejected (defence against fractional payloads
    // that would sneak past a naive `>= 2` check).
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a', questionCount: 1.9 }, 'active-1'),
    ).toBeNull()
    // Boundary: exactly 2 is the smallest valid count.
    expect(
      handleMultiQuestionIntervention({ toolUseId: 'a', questionCount: 2 }, 'active-1'),
    ).not.toBeNull()
  })

  it('accepts timestamp === 0 (epoch is valid per protocol — clock-skewed dev environments)', () => {
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_epoch', questionCount: 2, timestamp: 0 },
      'a',
    )
    expect(builder).not.toBeNull()
    const { interventions } = builder!.applyTo([])
    expect(interventions[0].timestamp).toBe(0)
  })

  it('ring-caps the array at MAX_SESSION_INTERVENTIONS (drops oldest entries)', async () => {
    const { MAX_SESSION_INTERVENTIONS } = await import('../utils')
    // Pre-fill exactly to the cap with synthetic entries
    const existing = Array.from({ length: MAX_SESSION_INTERVENTIONS }, (_, i) => ({
      kind: 'multi_question' as const,
      toolUseId: `toolu_${i}`,
      count: 2,
      timestamp: i,
    }))
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_new', questionCount: 7, timestamp: 9999 },
      'active-1',
    )
    const { interventions } = builder!.applyTo(existing)
    expect(interventions).toHaveLength(MAX_SESSION_INTERVENTIONS)
    // Oldest dropped, newest at the end.
    expect(interventions[0].toolUseId).toBe('toolu_1')
    expect(interventions[interventions.length - 1].toolUseId).toBe('toolu_new')
  })
})

// ---------------------------------------------------------------------------
// applyInterventionBuilder (#4653)
// ---------------------------------------------------------------------------
describe('applyInterventionBuilder', () => {
  it('reports isFirst=true when this is the first intervention in an empty session', () => {
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_first', questionCount: 2 },
      'a',
    )!
    const { interventions, isFirst } = applyInterventionBuilder(builder, [])
    expect(interventions).toHaveLength(1)
    expect(isFirst).toBe(true)
  })

  it('reports isFirst=false on subsequent distinct interventions', () => {
    const existing = [
      { kind: 'multi_question' as const, toolUseId: 'toolu_prev', count: 2, timestamp: 1 },
    ]
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_next', questionCount: 3 },
      'a',
    )!
    const { interventions, isFirst } = applyInterventionBuilder(builder, existing)
    expect(interventions).toHaveLength(2)
    expect(isFirst).toBe(false)
  })

  it('reports isFirst=false when a duplicate skips the append (no inline-notice on stuck-model re-emit)', () => {
    const existing = [
      { kind: 'multi_question' as const, toolUseId: 'toolu_dup', count: 2, timestamp: 1 },
    ]
    const builder = handleMultiQuestionIntervention(
      { toolUseId: 'toolu_dup', questionCount: 2 },
      'a',
    )!
    const { interventions, isFirst } = applyInterventionBuilder(builder, existing)
    expect(interventions).toBe(existing)
    expect(isFirst).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sharedStreamDelta (#4981) — platform-neutral hot-path logic
//
// These exercise the logic that previously lived (duplicated) inside the
// dashboard `handleStreamDelta` and the app `case 'stream_delta'`: the
// single-hop defensive remap, the post-tool continuation split (#4889) with
// the #4999/#5014 mid-sentence gate, and the #4975 mid-word peel. A minimal
// in-memory harness models a single-session store; the platform-divergent
// hooks (terminal write, #4297 reorder, flat fallback) are no-ops here and
// covered by the dashboard/app wrapper integration suites.
// ---------------------------------------------------------------------------

describe('sharedStreamDelta (#4981)', () => {
  function makeHarness(sessionId: string) {
    // Single session-state messages array + streamingMessageId.
    let messages: ChatMessage[] = []
    let streamingMessageId: string | null = null
    const pendingDeltas = new Map<string, PendingDelta>()
    const deltaIdRemaps = new Map<string, string>()
    const postPermissionSplits = new Set<string>()
    const replayingSessions = new Set<string>()

    const ctx: StreamDeltaContext = {
      activeSessionId: sessionId,
      pendingDeltas,
      deltaIdRemaps,
      postPermissionSplits,
      replayingSessions,
      getSessionMessages: (id) => (id === sessionId ? messages : null),
      getFlatMessages: () => [],
      appendTerminalDelta: () => {},
      reorderEmptyResponseSlot: () => {},
      appendResponseSlot: (targetId, slot, opts) => {
        if (targetId !== sessionId) return
        if (opts?.onlyIfAbsent && messages.some((m) => m.id === slot.id)) return
        streamingMessageId = slot.id
        messages = [...messages, slot]
      },
      peelSlotContent: (targetId, id, count) => {
        if (targetId !== sessionId) return
        messages = messages.map((m) =>
          m.id === id && m.type === 'response'
            ? { ...m, content: m.content.slice(0, m.content.length - count) }
            : m,
        )
      },
      scheduleFlush: () => {},
    }

    // Emulate the 100ms flush: append each buffered delta onto its matching
    // response slot's flushed content (the matched-id path of the real
    // flushPendingDeltas).
    function flush() {
      for (const [id, { delta }] of pendingDeltas) {
        messages = messages.map((m) =>
          m.id === id && m.type === 'response'
            ? { ...m, content: m.content + delta }
            : m,
        )
      }
      pendingDeltas.clear()
    }

    function send(msg: Record<string, unknown>) {
      sharedStreamDelta({ sessionId, ...msg }, ctx)
    }

    function seedResponse(id: string, content = '') {
      streamingMessageId = id
      messages = [...messages, { id, type: 'response', content, timestamp: 1 }]
    }
    function seedTool(id: string) {
      messages = [...messages, { id, type: 'tool_use', content: 'x', timestamp: 1 }]
    }

    return {
      send,
      flush,
      seedResponse,
      seedTool,
      get messages() { return messages },
      get streamingMessageId() { return streamingMessageId },
      pendingDeltas,
      deltaIdRemaps,
      postPermissionSplits,
      replayingSessions,
    }
  }

  it('buffers the delta onto the same slot when no tool follows', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Hello ')
    h.send({ messageId: 'resp-1', delta: 'world' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(1)
    expect(responses[0]!.content).toBe('Hello world')
  })

  it('post-tool continuation split (#4889): sentence-terminated prior slot → fresh -cont- bubble', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Let me check chroxy before filing.')
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: 'Filing now.' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(2)
    expect(responses[0]!.content).toBe('Let me check chroxy before filing.')
    expect(responses[1]!.content).toBe('Filing now.')
    expect(responses[1]!.id).toMatch(/^resp-1-cont-/)
    // Single-hop remap recorded against the ORIGINAL incoming id.
    expect(h.deltaIdRemaps.get('resp-1')).toBe(responses[1]!.id)
  })

  it('single-hop remap: a second post-tool delta reuses the existing remap (no chain)', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'First sentence.')
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: 'Second sentence.' })
    h.flush()
    const firstCont = h.deltaIdRemaps.get('resp-1')!
    h.seedTool('toolu_b')
    h.send({ messageId: 'resp-1', delta: 'Third sentence.' })
    h.flush()
    const secondCont = h.deltaIdRemaps.get('resp-1')!
    // The map still keys on the original id (single entry, overwritten).
    expect(h.deltaIdRemaps.size).toBe(1)
    expect(secondCont).not.toBe(firstCont)
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses.map((r) => r.content)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ])
  })

  it('mid-sentence gate (#4999): non-terminated prior slot → delta coalesces into same bubble', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Let me check the')
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: ' issue list' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    // No split — one bubble.
    expect(responses).toHaveLength(1)
    expect(responses[0]!.content).toBe('Let me check the issue list')
    expect(h.deltaIdRemaps.has('resp-1')).toBe(false)
  })

  it('mid-sentence gate (#5014): CJK fullwidth terminator counts as sentence-complete → split', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', '调查问题。')
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: '现在提交。' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(2)
    expect(responses[1]!.id).toMatch(/^resp-1-cont-/)
  })

  it('mid-word inside a sentence (#4975/#4999): prior ends mid-word → gate coalesces into ONE bubble', () => {
    const h = makeHarness('s1')
    // Prior content ends with a word char (`...PR #3.Del` → last char `l`),
    // so the #4999 mid-sentence gate routes the post-tool delta back to the
    // existing slot. The word "Delegating" reassembles in a single bubble and
    // the #4975 peel never needs to fire.
    h.seedResponse('resp-1', 'Starting on PR #3.Del')
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: 'egating the review.' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(1)
    expect(responses[0]!.content).toBe('Starting on PR #3.Delegating the review.')
    expect(responses[0]!.content).toContain('Delegating')
  })

  it('mid-word inside a sentence with still-buffered prior (delta not yet flushed) also coalesces', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Starting on PR #3.')
    // Buffer "Del" without flushing — counts as content for the split decision.
    h.send({ messageId: 'resp-1', delta: 'Del' })
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: 'egating the review.' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(1)
    expect(responses[0]!.content).toBe('Starting on PR #3.Delegating the review.')
  })

  it('replay guard: no continuation split while the session is replaying', () => {
    const h = makeHarness('s1')
    h.replayingSessions.add('s1')
    h.seedResponse('resp-1', 'First sentence.')
    h.seedTool('toolu_a')
    h.send({ messageId: 'resp-1', delta: 'Second sentence.' })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    // Replayed history is reassembled server-side — the delta coalesces onto
    // the existing slot instead of splitting into a fresh -cont- bubble.
    expect(responses).toHaveLength(1)
    expect(responses[0]!.content).toBe('First sentence.Second sentence.')
    expect(h.deltaIdRemaps.has('resp-1')).toBe(false)
  })

  it('defensive remap: delta whose slot is a tool_use routes to a -response slot', () => {
    const h = makeHarness('s1')
    // A tool_use occupies the incoming id (server reused messageId).
    h.seedTool('resp-collide')
    h.send({ messageId: 'resp-collide', delta: 'hi' })
    h.flush()
    const suffixed = h.messages.find((m) => m.id === 'resp-collide-response')
    expect(suffixed).toBeDefined()
    expect(suffixed!.type).toBe('response')
    expect(suffixed!.content).toBe('hi')
    expect(h.deltaIdRemaps.get('resp-collide')).toBe('resp-collide-response')
  })

  // -------------------------------------------------------------------------
  // #5130 — malformed-payload hardening. ServerStreamDeltaSchema declares
  // `messageId` and `delta` as required `z.string()`, so these arms only fire
  // for payloads that bypassed Zod parse. Valid payloads (covered by every
  // test above) are unaffected.
  // -------------------------------------------------------------------------

  it('#5130: non-string messageId early-returns without poisoning any collection', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Hello')
    // messageId is a number — must not become a Map/Set key.
    h.send({ messageId: 123 as unknown as string, delta: 'world' })
    h.flush()
    // No buffering happened, content untouched.
    expect(h.pendingDeltas.size).toBe(0)
    expect(h.deltaIdRemaps.size).toBe(0)
    expect(h.postPermissionSplits.size).toBe(0)
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(1)
    expect(responses[0]!.content).toBe('Hello')
    // No non-string key leaked into pendingDeltas.
    for (const key of h.pendingDeltas.keys()) {
      expect(typeof key).toBe('string')
    }
  })

  it('#5130: missing messageId early-returns', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Hello')
    h.send({ delta: 'world' })
    h.flush()
    expect(h.pendingDeltas.size).toBe(0)
    expect(h.deltaIdRemaps.size).toBe(0)
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses[0]!.content).toBe('Hello')
  })

  it('#5130: missing delta does NOT append the literal "undefined"', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Hello')
    h.send({ messageId: 'resp-1' }) // delta absent
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses).toHaveLength(1)
    // The literal "undefined" must NOT have been concatenated.
    expect(responses[0]!.content).toBe('Hello')
    expect(responses[0]!.content).not.toContain('undefined')
    expect(h.pendingDeltas.size).toBe(0)
  })

  it('#5130: non-string delta does NOT append (early-return, nothing buffered)', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Hello')
    h.send({ messageId: 'resp-1', delta: { foo: 'bar' } as unknown as string })
    h.flush()
    const responses = h.messages.filter((m) => m.type === 'response')
    expect(responses[0]!.content).toBe('Hello')
    expect(responses[0]!.content).not.toContain('[object Object]')
    expect(h.pendingDeltas.size).toBe(0)
  })

  it('#5130: non-string sessionId falls back to the active session (no Map-key coercion)', () => {
    const h = makeHarness('s1')
    h.seedResponse('resp-1', 'Hello ')
    // Call the handler directly to override the harness's spread sessionId with
    // a non-string value. The captured sessionId should fall back to the
    // active session ('s1'), and the delta should buffer + flush normally.
    sharedStreamDelta(
      { messageId: 'resp-1', delta: 'world', sessionId: 42 as unknown as string },
      {
        activeSessionId: 's1',
        pendingDeltas: h.pendingDeltas,
        deltaIdRemaps: h.deltaIdRemaps,
        postPermissionSplits: h.postPermissionSplits,
        replayingSessions: h.replayingSessions,
        getSessionMessages: (id) => (id === 's1' ? h.messages : null),
        getFlatMessages: () => [],
        appendTerminalDelta: () => {},
        reorderEmptyResponseSlot: () => {},
        appendResponseSlot: () => {},
        peelSlotContent: () => {},
        scheduleFlush: () => {},
      },
    )
    // The buffered entry's sessionId must be the active-session fallback, not 42.
    const buffered = h.pendingDeltas.get('resp-1')
    expect(buffered).toBeDefined()
    expect(buffered!.sessionId).toBe('s1')
    expect(buffered!.delta).toBe('world')
  })
})

// ---------------------------------------------------------------------------
// handleRawOutput (#5454)
// ---------------------------------------------------------------------------
describe('handleRawOutput', () => {
  it('extracts the data field verbatim', () => {
    expect(handleRawOutput({ data: 'hello\x1b[0m' }).data).toBe('hello\x1b[0m')
  })

  it('falls back to the empty string for missing or non-string data', () => {
    // The declared `{ data: string }` type is honest: a malformed payload
    // appends nothing rather than letting `undefined` flow into the
    // dashboard's `stripAnsi(data)` (which throws on non-strings). The
    // server's raw payload is always a PTY string, so this is unreachable
    // from a well-behaved producer.
    expect(handleRawOutput({}).data).toBe('')
    expect(handleRawOutput({ data: 42 }).data).toBe('')
  })
})

// ---------------------------------------------------------------------------
// handleTokenRotated (#5454)
// ---------------------------------------------------------------------------
describe('handleTokenRotated', () => {
  it('returns the token when it is a string', () => {
    expect(handleTokenRotated({ token: 'tok-1' }).token).toBe('tok-1')
  })

  it('passes the empty string through verbatim (call sites gate on truthiness)', () => {
    expect(handleTokenRotated({ token: '' }).token).toBe('')
  })

  it('returns null for missing or non-string tokens', () => {
    expect(handleTokenRotated({}).token).toBeNull()
    expect(handleTokenRotated({ token: 42 }).token).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handlePairFail (#5454)
// ---------------------------------------------------------------------------
describe('handlePairFail', () => {
  it('maps known reasons to the friendly QR-flow copy', () => {
    for (const reason of Object.keys(PAIR_FAIL_MESSAGES)) {
      const result = handlePairFail({ reason }, 'pairing_failed')
      expect(result.reason).toBe(reason)
      expect(result.alertMessage).toBe(PAIR_FAIL_MESSAGES[reason])
    }
  })

  it('falls back to the generic template for unknown reasons', () => {
    const result = handlePairFail({ reason: 'weird_reason' }, 'pairing_failed')
    expect(result.reason).toBe('weird_reason')
    expect(result.alertMessage).toBe('Pairing failed: weird_reason')
  })

  it('uses the injected fallback for missing, empty, and non-string reasons', () => {
    expect(handlePairFail({}, 'pairing_failed').reason).toBe('pairing_failed')
    expect(handlePairFail({ reason: '' }, 'unknown').reason).toBe('unknown')
    expect(handlePairFail({ reason: 42 }, 'unknown').reason).toBe('unknown')
    expect(handlePairFail({}, 'unknown').alertMessage).toBe('Pairing failed: unknown')
  })
})

// ---------------------------------------------------------------------------
// handleSessionCostThresholdCrossed (#5454)
// ---------------------------------------------------------------------------
describe('handleSessionCostThresholdCrossed', () => {
  it('builds the costThresholdWarning patch for the explicit session', () => {
    const result = handleSessionCostThresholdCrossed({
      sessionId: 'sess-1',
      costUsd: 5.25,
      thresholdUsd: 5,
    })
    expect(result.sessionId).toBe('sess-1')
    expect(result.patch).toEqual({
      costThresholdWarning: { costUsd: 5.25, thresholdUsd: 5, dismissedAt: null },
    })
  })

  it('does NOT fall back to any active session — explicit sessionId only', () => {
    expect(handleSessionCostThresholdCrossed({ costUsd: 1, thresholdUsd: 1 }).sessionId).toBeNull()
    expect(handleSessionCostThresholdCrossed({ sessionId: 42 }).sessionId).toBeNull()
  })

  it('defaults non-finite / missing / non-number amounts to 0', () => {
    const result = handleSessionCostThresholdCrossed({
      sessionId: 's',
      costUsd: Number.NaN,
      thresholdUsd: '5',
    })
    expect(result.patch.costThresholdWarning.costUsd).toBe(0)
    expect(result.patch.costThresholdWarning.thresholdUsd).toBe(0)
    expect(
      handleSessionCostThresholdCrossed({ sessionId: 's', costUsd: Infinity })
        .patch.costThresholdWarning.costUsd,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// handleNotificationPrefs (#5454)
// ---------------------------------------------------------------------------
describe('handleNotificationPrefs', () => {
  const validMsg = {
    type: 'notification_prefs',
    prefs: {
      categories: { permission: true, activity_error: false },
      devices: {},
      quietHours: null,
    },
  }

  it('parses a valid snapshot into the stored shape', () => {
    const { notificationPrefs, issues } = handleNotificationPrefs(validMsg)
    expect(issues).toBeNull()
    expect(notificationPrefs).toEqual({
      categories: { permission: true, activity_error: false },
      devices: {},
      quietHours: null,
    })
    // bypassCategories must be OMITTED (not undefined-valued) when absent
    expect(Object.prototype.hasOwnProperty.call(notificationPrefs, 'bypassCategories')).toBe(false)
  })

  it('forwards bypassCategories and quietHours when present (#4544)', () => {
    const { notificationPrefs } = handleNotificationPrefs({
      type: 'notification_prefs',
      prefs: {
        categories: { permission: true },
        devices: {
          'device-1': { quietHours: { start: '22:00', end: '07:00', timezone: 'Australia/Melbourne' } },
        },
        quietHours: { start: '23:00', end: '06:00', timezone: 'Australia/Melbourne' },
        bypassCategories: ['permission'],
      },
    })
    expect(notificationPrefs).not.toBeNull()
    expect(notificationPrefs!.bypassCategories).toEqual(['permission'])
    expect(notificationPrefs!.quietHours).toEqual({
      start: '23:00',
      end: '06:00',
      timezone: 'Australia/Melbourne',
    })
    expect(notificationPrefs!.devices['device-1']!.quietHours).toEqual({
      start: '22:00',
      end: '07:00',
      timezone: 'Australia/Melbourne',
    })
  })

  it('returns issues (and null prefs) when validation fails', () => {
    const { notificationPrefs, issues } = handleNotificationPrefs({
      type: 'notification_prefs',
      prefs: { categories: { permission: 'yes' }, devices: {}, quietHours: null },
    })
    expect(notificationPrefs).toBeNull()
    expect(Array.isArray(issues)).toBe(true)
    expect((issues as unknown[]).length).toBeGreaterThan(0)
  })

  it('rejects a quiet-hours window missing its timezone (#4544)', () => {
    const { notificationPrefs } = handleNotificationPrefs({
      type: 'notification_prefs',
      prefs: {
        categories: {},
        devices: {},
        quietHours: { start: '22:00', end: '07:00' },
      },
    })
    expect(notificationPrefs).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolvePermissionStreamSplit (#554 / #5454)
// ---------------------------------------------------------------------------
describe('resolvePermissionStreamSplit', () => {
  it('returns null when there is no current stream', () => {
    expect(resolvePermissionStreamSplit(null, new Map())).toBeNull()
  })

  it('returns null for the "pending" placeholder id', () => {
    expect(resolvePermissionStreamSplit('pending', new Map())).toBeNull()
  })

  it('returns the current stream id verbatim when no remap matches', () => {
    expect(resolvePermissionStreamSplit('msg-1', new Map([['orig-9', 'other']]))).toEqual({
      serverStreamId: 'msg-1',
    })
  })

  it('reverse-maps a remapped client id back to the server-origin id', () => {
    const remaps = new Map([
      ['orig-1', 'client-1'],
      ['orig-2', 'client-2'],
    ])
    expect(resolvePermissionStreamSplit('client-2', remaps)).toEqual({
      serverStreamId: 'orig-2',
    })
  })
})
