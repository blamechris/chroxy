import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'

/**
 * #3736: permissionSessionMap must not leak entries on internal resolution
 * paths (timeout, abort, auto_mode, cleared).
 *
 * Pre-fix only the user-response paths (WS permission_response and the HTTP
 * /permission-response endpoint) called `permissionSessionMap.delete(id)`.
 * The internal auto-resolve paths in PermissionManager emit `permission_resolved`
 * but the map entry was never removed — long-running sessions accumulated stale
 * entries (small leak, ~80 bytes each, unbounded growth until session destroy).
 *
 * The fix wires cleanup into the unified pipeline via a new
 * `action: 'delete'` registrations contract on the EventNormalizer +
 * ws-forwarding, so any future internal-resolution path inherits cleanup
 * automatically.
 *
 * questionSessionMap (toolUseId → sessionId) had the same shape of bug for
 * AskUserQuestion timeout/abort/cleared paths; covered here too.
 */

function makeMultiCtx(overrides = {}) {
  const sm = new EventEmitter()
  sm.getSession = mock.fn(() => null)
  sm.listSessions = mock.fn(() => [])
  sm.getSessionContext = mock.fn(() => Promise.resolve(null))
  const normalizer = new EventNormalizer()
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = mock.fn()
  devPreview.closeSession = mock.fn()

  return {
    normalizer,
    sessionManager: sm,
    cliSession: null,
    devPreview,
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    ...overrides,
  }
}

function emitPermissionRequest(ctx, sessionId, requestId) {
  ctx.sessionManager.emit('session_event', {
    sessionId,
    event: 'permission_request',
    data: {
      requestId,
      tool: 'Bash',
      description: 'ls',
      input: {},
      remainingMs: 300_000,
    },
  })
}

function emitPermissionResolved(ctx, sessionId, requestId, decision, reason) {
  ctx.sessionManager.emit('session_event', {
    sessionId,
    event: 'permission_resolved',
    data: { requestId, decision, reason },
  })
}

describe('permissionSessionMap cleanup on internal resolution paths (#3736)', () => {
  it('removes entry when permission resolves with reason "timeout"', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-timeout')
    assert.equal(ctx.permissionSessionMap.get('req-timeout'), 'sess-1',
      'precondition: permission_request must register the entry')

    emitPermissionResolved(ctx, 'sess-1', 'req-timeout', 'deny', 'timeout')

    assert.equal(ctx.permissionSessionMap.has('req-timeout'), false,
      'timeout-resolved permission must be removed from permissionSessionMap')
  })

  it('removes entry when permission resolves with reason "aborted"', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-aborted')
    emitPermissionResolved(ctx, 'sess-1', 'req-aborted', 'deny', 'aborted')

    assert.equal(ctx.permissionSessionMap.has('req-aborted'), false,
      'abort-resolved permission must be removed from permissionSessionMap')
  })

  it('removes entry when permission resolves with reason "auto_mode" (panic-button switch)', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-auto')
    emitPermissionResolved(ctx, 'sess-1', 'req-auto', 'allow', 'auto_mode')

    assert.equal(ctx.permissionSessionMap.has('req-auto'), false,
      'auto_mode-resolved permission must be removed from permissionSessionMap')
  })

  it('removes entry when permission resolves with reason "cleared" (clearAll on message completion)', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-cleared')
    emitPermissionResolved(ctx, 'sess-1', 'req-cleared', 'deny', 'cleared')

    assert.equal(ctx.permissionSessionMap.has('req-cleared'), false,
      'cleared-resolved permission must be removed from permissionSessionMap')
  })

  it('removes entry when user explicitly responds (reason "user")', () => {
    // The pre-existing user path already cleans up at the message-handler
    // level (settings-handlers.js), but with the unified-pipeline fix the
    // normalizer-driven cleanup ALSO fires for user resolutions. Double
    // delete is harmless (Map.delete is idempotent) — assert the end state.
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-user')
    emitPermissionResolved(ctx, 'sess-1', 'req-user', 'allow', 'user')

    assert.equal(ctx.permissionSessionMap.has('req-user'), false,
      'user-resolved permission must be removed from permissionSessionMap')
  })

  it('only deletes the resolved requestId — other entries survive', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-a')
    emitPermissionRequest(ctx, 'sess-1', 'req-b')
    emitPermissionRequest(ctx, 'sess-2', 'req-c')

    emitPermissionResolved(ctx, 'sess-1', 'req-a', 'deny', 'timeout')

    assert.equal(ctx.permissionSessionMap.has('req-a'), false, 'req-a was resolved → removed')
    assert.equal(ctx.permissionSessionMap.get('req-b'), 'sess-1', 'req-b unrelated → survives')
    assert.equal(ctx.permissionSessionMap.get('req-c'), 'sess-2', 'req-c unrelated → survives')
  })

  it('does not throw when resolving an unknown requestId (defensive)', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    assert.doesNotThrow(() => {
      emitPermissionResolved(ctx, 'sess-1', 'req-never-seen', 'deny', 'timeout')
    })
    assert.equal(ctx.permissionSessionMap.size, 0)
  })

  it('still broadcasts permission_resolved to clients (cleanup is additive)', () => {
    // Regression guard: the fix adds delete-registrations but must not
    // suppress the user-facing broadcast (#3048 relies on this).
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    emitPermissionRequest(ctx, 'sess-1', 'req-x')
    emitPermissionResolved(ctx, 'sess-1', 'req-x', 'deny', 'timeout')

    const call = ctx.broadcastToSession.mock.calls.find(
      (c) => c.arguments[1]?.type === 'permission_resolved',
    )
    assert.ok(call, 'permission_resolved must still broadcast after cleanup fix')
    assert.equal(call.arguments[1].requestId, 'req-x')
  })
})

describe('questionSessionMap cleanup on internal resolution paths (#3736)', () => {
  it('removes entry when an AskUserQuestion permission_resolved arrives with toolUseId (any reason)', () => {
    const ctx = makeMultiCtx()
    setupForwarding(ctx)

    // Register a question entry as a user_question event would
    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'user_question',
      data: { toolUseId: 'tool-q-timeout', questions: [{ question: 'go?' }] },
    })
    assert.equal(ctx.questionSessionMap.get('tool-q-timeout'), 'sess-1',
      'precondition: user_question must register the entry')

    // Internal resolution path — PermissionManager emits with `toolUseId`
    // and a reason (timeout/aborted/cleared/answered).
    ctx.sessionManager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'permission_resolved',
      data: { toolUseId: 'tool-q-timeout', reason: 'timeout' },
    })

    assert.equal(ctx.questionSessionMap.has('tool-q-timeout'), false,
      'AskUserQuestion timeout must remove the questionSessionMap entry')
  })
})
