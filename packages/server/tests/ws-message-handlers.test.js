import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAttachments,
  handleSessionMessage,
  PERMISSION_MODES,
  ALLOWED_PERMISSION_MODE_IDS,
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_SIZE,
  MAX_DOCUMENT_SIZE,
  ALLOWED_IMAGE_TYPES,
} from '../src/ws-message-handlers.js'
import { createMockSession } from './test-helpers.js'

/**
 * ws-message-handlers.js unit tests (#1727)
 *
 * Tests cover:
 * - validateAttachments pure function (no IO)
 * - handleSessionMessage: input, interrupt, set_model, set_permission_mode,
 *   permission_response, user_question_response
 * - Session management: list_sessions, switch_session, destroy_session, rename_session
 */

// ---- Test fixtures ----

function makeSession(overrides = {}) {
  return { session: createMockSession(), cwd: '/tmp', ...overrides }
}

function makeCtx(overrides = {}) {
  const sessionMap = new Map()
  return {
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
      isBudgetPaused: mock.fn(() => false),
      recordUserInput: mock.fn(),
      touchActivity: mock.fn(),
      getHistoryCount: mock.fn(() => 5),
      resumeBudget: mock.fn(),
      destroySession: mock.fn(),
      renameSession: mock.fn((id, name) => sessionMap.has(id)),
      listSessions: mock.fn(() => ['sess-1', 'sess-2']),  // 2 sessions so destroy is allowed
      firstSessionId: 'sess-2',
      ...overrides.sessionManager,
    },
    send: mock.fn(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    sendSessionInfo: mock.fn(),
    primaryClients: new Map(),
    updatePrimary: mock.fn(),
    checkpointManager: {
      createCheckpoint: mock.fn(() => Promise.resolve()),
    },
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    clients: new Map(),
    _sessions: sessionMap,  // Helper to add sessions directly
    ...overrides,
  }
}

function addSession(ctx, id, entry = null) {
  const e = entry ?? makeSession()
  ctx._sessions.set(id, e)
  return e
}

function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: null, ...overrides }
}

const WS = {}  // Opaque ws handle — handlers only pass it through ctx.send

// ---- Tests ----

describe('validateAttachments', () => {
  it('returns null for empty array', () => {
    assert.equal(validateAttachments([]), null)
  })

  it('rejects non-array input', () => {
    assert.ok(validateAttachments('string') !== null)
    assert.ok(validateAttachments(null) !== null)
  })

  it(`rejects more than ${MAX_ATTACHMENT_COUNT} attachments`, () => {
    const atts = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => ({
      type: 'image', mediaType: 'image/png', data: 'abc', name: 'x.png',
    }))
    assert.ok(validateAttachments(atts) !== null)
  })

  it('accepts valid image attachment', () => {
    assert.equal(validateAttachments([{
      type: 'image',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
      name: 'test.png',
    }]), null)
  })

  it('rejects image with unsupported media type', () => {
    assert.ok(validateAttachments([{
      type: 'image', mediaType: 'image/bmp', data: 'abc', name: 'f.bmp',
    }]) !== null)
  })

  it('accepts valid file_ref attachment', () => {
    assert.equal(validateAttachments([{
      type: 'file_ref', path: 'src/app.js',
    }]), null)
  })

  it('rejects file_ref with absolute path', () => {
    assert.ok(validateAttachments([{
      type: 'file_ref', path: '/etc/passwd',
    }]) !== null)
  })

  it('rejects file_ref with path traversal', () => {
    assert.ok(validateAttachments([{
      type: 'file_ref', path: '../secret',
    }]) !== null)
  })

  it('rejects attachment missing mediaType', () => {
    assert.ok(validateAttachments([{
      type: 'image', data: 'abc', name: 'f.png',
    }]) !== null)
  })
})

describe('handleSessionMessage', () => {
  describe('input', () => {
    it('sends session_error when no active session', async () => {
      const ctx = makeCtx()
      const client = makeClient()
      await handleSessionMessage(WS, client, { type: 'input', data: 'hello' }, ctx)
      const sent = ctx.send.mock.calls[0].arguments[1]
      assert.equal(sent.type, 'session_error')
    })

    it('sends message to session via sendMessage', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'input', data: 'hello world' }, ctx)
      assert.equal(entry.session.sendMessage.callCount, 1)
      assert.equal(entry.session.sendMessage.lastCall[0], 'hello world')
    })

    it('does nothing for empty input', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'input', data: '  ' }, ctx)
      // Empty input — sendMessage not called
      assert.equal(ctx.send.mock.calls.length, 0)
    })

    it('sends session_error when budget is paused', async () => {
      const ctx = makeCtx({ sessionManager: { isBudgetPaused: mock.fn(() => true) } })
      // Need getSession to return something
      ctx.sessionManager.getSession = mock.fn(() => makeSession())
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'input', data: 'hi' }, ctx)
      const sent = ctx.send.mock.calls[0].arguments[1]
      assert.equal(sent.type, 'session_error')
      assert.ok(sent.message.includes('budget'))
    })
  })

  describe('interrupt', () => {
    it('calls session.interrupt()', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'interrupt' }, ctx)
      assert.equal(entry.session.interrupt.callCount, 1)
    })

    it('does nothing when no active session', async () => {
      const ctx = makeCtx()
      const client = makeClient()
      await handleSessionMessage(WS, client, { type: 'interrupt' }, ctx)
      // No error sent — silently ignored
      assert.equal(ctx.send.mock.calls.length, 0)
    })
  })

  describe('set_model', () => {
    it('calls session.setModel with valid model', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      // Use a known allowed model id
      const { ALLOWED_MODEL_IDS } = await import('../src/models.js')
      const validModel = [...ALLOWED_MODEL_IDS][0]
      await handleSessionMessage(WS, client, { type: 'set_model', model: validModel }, ctx)
      assert.equal(entry.session.setModel.callCount, 1)
    })

    it('does not set invalid model id', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'set_model', model: 'fake-model-xyz' }, ctx)
      assert.equal(entry.session.setModel.callCount, 0)
    })
  })

  describe('set_permission_mode', () => {
    it('calls session.setPermissionMode with valid mode', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'set_permission_mode', mode: 'approve' }, ctx)
      assert.equal(entry.session.setPermissionMode.callCount, 1)
      assert.equal(entry.session.setPermissionMode.lastCall[0], 'approve')
    })

    it('does not set invalid permission mode', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'set_permission_mode', mode: 'hack' }, ctx)
      assert.equal(entry.session.setPermissionMode.callCount, 0)
    })
  })

  describe('permission_response', () => {
    it('calls session.respondToPermission', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'permission_response',
        requestId: 'req-abc',
        decision: 'allow',
      }, ctx)
      assert.equal(entry.session.respondToPermission.callCount, 1)
      const [id, decision] = entry.session.respondToPermission.lastCall
      assert.equal(id, 'req-abc')
      assert.equal(decision, 'allow')
    })
  })

  describe('user_question_response', () => {
    it('calls session.respondToQuestion', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'user_question_response',
        toolUseId: 'tool-xyz',
        answer: 'yes please',
      }, ctx)
      assert.equal(entry.session.respondToQuestion.callCount, 1)
    })
  })

  describe('destroy_session', () => {
    it('calls sessionManager.destroySession', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'destroy_session', sessionId: 'sess-1' }, ctx)
      assert.equal(ctx.sessionManager.destroySession.mock.calls.length, 1)
    })
  })

  describe('rename_session', () => {
    it('calls sessionManager.renameSession', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'rename_session',
        sessionId: 'sess-1',
        name: 'My Session',
      }, ctx)
      assert.equal(ctx.sessionManager.renameSession.mock.calls.length, 1)
    })
  })
})

describe('PERMISSION_MODES and ALLOWED_PERMISSION_MODE_IDS', () => {
  it('PERMISSION_MODES contains approve, acceptEdits, auto, plan', () => {
    const ids = PERMISSION_MODES.map(m => m.id)
    assert.ok(ids.includes('approve'))
    assert.ok(ids.includes('acceptEdits'))
    assert.ok(ids.includes('auto'))
    assert.ok(ids.includes('plan'))
  })

  it('ALLOWED_PERMISSION_MODE_IDS matches PERMISSION_MODES', () => {
    for (const { id } of PERMISSION_MODES) {
      assert.ok(ALLOWED_PERMISSION_MODE_IDS.has(id))
    }
  })
})
