import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleSessionMessage,
  registerMessageHandler,
} from '../src/ws-message-handlers.js'
import {
  validateAttachments,
  PERMISSION_MODES,
  ALLOWED_PERMISSION_MODE_IDS,
  MAX_ATTACHMENT_COUNT,
} from '../src/handler-utils.js'
import { createMockSession, nsCtx } from './test-helpers.js'

/**
 * ws-message-handlers.js unit tests (#1727)
 *
 * Tests cover:
 * - validateAttachments pure function (no IO)
 * - handleSessionMessage: input, interrupt, set_model, set_permission_mode,
 *   permission_response, user_question_response
 * - Session management: destroy_session, rename_session
 */

// ---- Test fixtures ----

function makeSession(overrides = {}) {
  return { session: createMockSession(), cwd: '/tmp', ...overrides }
}

function makeCtx(overrides = {}) {
  const sessionMap = new Map()
  const { sessionManager: smOverrides, ...restOverrides } = overrides
  // #5563: primary-ownership moved off a `primaryClients` Map onto the
  // getPrimary / isPrimary / claimPrimary / clearPrimary surface. Back them
  // with a local Map so destroy/input handlers route through the helpers
  // (e.g. handleDestroySession now calls ctx.transport.clearPrimary).
  const primaryMap = new Map()
  return nsCtx({
    sessionManager: {
      getSession: mock.fn((id) => sessionMap.get(id) ?? null),
      isBudgetPaused: mock.fn(() => false),
      recordUserInput: mock.fn(),
      touchActivity: mock.fn(),
      getHistoryCount: mock.fn(() => 5),
      resumeBudget: mock.fn(),
      destroySession: mock.fn(),
      renameSession: mock.fn((id) => sessionMap.has(id)),
      listSessions: mock.fn(() => ['sess-1', 'sess-2']),  // 2 sessions so destroy is allowed
      firstSessionId: 'sess-2',
      ...smOverrides,
    },
    send: mock.fn(),
    broadcast: mock.fn(),
    broadcastToSession: mock.fn(),
    broadcastSessionList: mock.fn(),
    sendSessionInfo: mock.fn(),
    updatePrimary: mock.fn((sid, cid) => { primaryMap.set(sid, cid) }),
    claimPrimary: mock.fn((sid, cid, o = {}) => {
      const current = primaryMap.get(sid)
      if (current === cid) return { changed: false, primaryClientId: current }
      if (current && !o.force) return { changed: false, rejected: true, primaryClientId: current }
      primaryMap.set(sid, cid)
      return { changed: true, primaryClientId: cid }
    }),
    getPrimary: mock.fn((sid) => primaryMap.get(sid)),
    isPrimary: mock.fn((sid, cid) => primaryMap.get(sid) === cid),
    clearPrimary: mock.fn((sid) => { primaryMap.delete(sid) }),
    checkpointManager: {
      createCheckpoint: mock.fn(() => Promise.resolve()),
    },
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    pendingPermissions: new Map(),
    permissions: {
      resolvePermission: mock.fn(),
    },
    clients: new Map(),
    _sessions: sessionMap,  // Helper to add sessions directly
    ...restOverrides,
  })
}

function addSession(ctx, id, entry = null) {
  const e = entry ?? makeSession()
  ctx._sessions.set(id, e)
  return e
}

function makeClient(overrides = {}) {
  return { id: 'client-1', activeSessionId: null, ...overrides }
}

const WS = {}  // Opaque ws handle — handlers only pass it through ctx.transport.send

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
      const sent = ctx.transport.send.mock.calls[0].arguments[1]
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
      assert.equal(ctx.transport.send.mock.calls.length, 0)
    })

    it('sends session_error when budget is paused', async () => {
      const ctx = makeCtx({ sessionManager: { isBudgetPaused: mock.fn(() => true) } })
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'input', data: 'hi' }, ctx)
      const sent = ctx.transport.send.mock.calls[0].arguments[1]
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
      assert.equal(ctx.transport.send.mock.calls.length, 0)
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

    // #5418 — providers whose getAllowedModels() returns null (ollama)
    // validate nothing statically: any locally pulled model id must pass
    // through verbatim. Before the tri-state fix, the null fell through to
    // the global Claude allowlist, which rejected every Ollama model AND
    // accepted Claude ids that 404 at the local daemon.
    it('accepts any non-empty model id on an unrestricted provider (ollama, #5418)', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1', makeSession({ provider: 'ollama' }))
      await handleSessionMessage(WS, client, { type: 'set_model', model: 'my-custom-finetune:7b' }, ctx)
      assert.equal(entry.session.setModel.callCount, 1)
      assert.equal(entry.session.setModel.lastCall[0], 'my-custom-finetune:7b')
      const broadcast = ctx.transport.broadcastToSession.mock.calls.at(-1)?.arguments[1]
      assert.equal(broadcast?.type, 'model_changed')
      assert.equal(broadcast?.model, 'my-custom-finetune:7b', 'opaque local ids broadcast verbatim')
    })

    it('rejects a whitespace-only model id even on an unrestricted provider (#5418)', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1', makeSession({ provider: 'ollama' }))
      // #5632: sendError now routes through ctx.transport.send (the
      // encryption-aware path), not a raw ws.send. The rejection envelope is the
      // payload (arguments[1]) of the last transport.send call.
      const ws = { readyState: 1, send: mock.fn() }
      await handleSessionMessage(ws, client, { type: 'set_model', model: '   ' }, ctx)
      assert.equal(entry.session.setModel.callCount, 0)
      const sent = ctx.transport.send.mock.calls.at(-1).arguments[1]
      assert.equal(sent.type, 'error')
      assert.equal(sent.code, 'INVALID_MODEL')
    })

    it('a provider allow-list still rejects unknown ids (tri-state regression guard, #5418)', async () => {
      // deepseek opts IN with an authoritative array — the unrestricted
      // branch must not leak to providers that declare a real list.
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1', makeSession({ provider: 'deepseek' }))
      const ws = { readyState: 1, send: mock.fn() }
      await handleSessionMessage(ws, client, { type: 'set_model', model: 'my-custom-finetune:7b' }, ctx)
      assert.equal(entry.session.setModel.callCount, 0)
      // #5632: rejection routes through ctx.transport.send (encryption-aware path).
      const sent = ctx.transport.send.mock.calls.at(-1).arguments[1]
      assert.equal(sent.code, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
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

    it('rejects auto mode when config.allowAutoPermissionMode is NOT enabled (2026-04-11 audit Adversary A5)', async () => {
      // Pre-audit: any authenticated client could flip to auto mode by
      // sending { mode:'auto', confirmed:true }. The confirmed flag
      // was server-side honor-system with no physical-user confirmation
      // — a trivial step in the Adversary kill chain.
      // Post-fix: auto mode requires an explicit operator opt-in in
      // the server config file. Default is undefined/false, so fresh
      // installs are secure by default.
      const ctx = makeCtx()
      // config is null / no allowAutoPermissionMode set → default deny
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'set_permission_mode',
        mode: 'auto',
        confirmed: true,  // attacker's flag — should no longer matter
      }, ctx)
      assert.equal(entry.session.setPermissionMode.callCount, 0,
        'auto mode must not be applied when config does not explicitly enable it')
    })

    it('allows auto mode when config.allowAutoPermissionMode is true and confirmed', async () => {
      const ctx = makeCtx({ config: { allowAutoPermissionMode: true } })
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'set_permission_mode',
        mode: 'auto',
        confirmed: true,
      }, ctx)
      assert.equal(entry.session.setPermissionMode.callCount, 1)
      assert.equal(entry.session.setPermissionMode.lastCall[0], 'auto')
    })

    it('rejects auto mode for bound clients even when config allows it (defense in depth)', async () => {
      // A pairing-issued session token should NEVER escalate to auto.
      // Pairing scopes authority to an existing session — flipping to
      // auto would break that boundary. Even operators who opt into
      // allowAutoPermissionMode should only be able to flip via the
      // primary API token.
      const ctx = makeCtx({ config: { allowAutoPermissionMode: true } })
      const boundClient = makeClient({
        activeSessionId: 'sess-1',
        boundSessionId: 'sess-1',
      })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, boundClient, {
        type: 'set_permission_mode',
        mode: 'auto',
        confirmed: true,
      }, ctx)
      assert.equal(entry.session.setPermissionMode.callCount, 0,
        'bound (pairing-token) clients must never be able to flip to auto mode')
    })

    it('still allows bound clients to use non-auto permission modes', async () => {
      // Sanity: the auto-mode rejection must not accidentally block
      // other legitimate permission-mode changes from bound clients
      // (approve / acceptEdits / plan are fine).
      const ctx = makeCtx({ config: { allowAutoPermissionMode: true } })
      const boundClient = makeClient({
        activeSessionId: 'sess-1',
        boundSessionId: 'sess-1',
      })
      const entry = addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, boundClient, {
        type: 'set_permission_mode',
        mode: 'approve',
      }, ctx)
      assert.equal(entry.session.setPermissionMode.callCount, 1)
      assert.equal(entry.session.setPermissionMode.lastCall[0], 'approve')
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

    it('rejects bound client trying to respond to cross-session permission (2026-04-11 audit blocker 5)', async () => {
      // Pre-audit, handlePermissionResponse in settings-handlers.js skipped
      // the boundSessionId check. A client bound to session A could approve
      // or deny a permission request belonging to session B. Direct bypass
      // of the 616aeaf62/2c0ac7d2d session-binding enforcement claim.
      const ctx = makeCtx()
      // Mapping says this request belongs to session-B
      ctx.permissions.permissionSessionMap.set('cross-req', 'session-B')
      const entryB = addSession(ctx, 'session-B')
      // Client is bound to session-A
      const boundClient = makeClient({
        activeSessionId: 'session-A',
        boundSessionId: 'session-A',
      })
      await handleSessionMessage(WS, boundClient, {
        type: 'permission_response',
        requestId: 'cross-req',
        decision: 'allow',
      }, ctx)
      // Permission must NOT have been resolved on session-B
      assert.equal(entryB.session.respondToPermission.callCount, 0,
        'bound client must not be able to resolve cross-session permissions')
      // Mapping must NOT have been consumed so the legit bound client can still respond
      assert.ok(ctx.permissions.permissionSessionMap.has('cross-req'),
        'permissionSessionMap entry must be preserved for the legit client')
      // (We don't assert on the SESSION_TOKEN_MISMATCH error reaching the client
      // here: since #5632 sendError routes through ctx.transport.send, but the
      // opaque WS handle at the top of the file isn't readyState=1 so the
      // delivery is a no-op anyway. The "no cross-session resolve" + "mapping
      // preserved" assertions above are what actually prevent the attack.)
    })

    it('allows bound client to respond to permission for its own bound session', async () => {
      const ctx = makeCtx()
      ctx.permissions.permissionSessionMap.set('own-req', 'session-A')
      const entryA = addSession(ctx, 'session-A')
      const boundClient = makeClient({
        activeSessionId: 'session-A',
        boundSessionId: 'session-A',
      })
      await handleSessionMessage(WS, boundClient, {
        type: 'permission_response',
        requestId: 'own-req',
        decision: 'allow',
      }, ctx)
      assert.equal(entryA.session.respondToPermission.callCount, 1,
        'bound client must be able to resolve permissions for its own session')
    })

    it('rejects bound client resolving a legacy pendingPermissions entry with no session mapping (2026-04-11 audit blocker 5 — agent-review residual bypass)', async () => {
      // Before the follow-up fix: a bound client could send a permission_response
      // with a requestId that was in the legacy ctx.permissions.pendingPermissions map but
      // NOT in permissionSessionMap. In that case, originSessionId fell back to
      // client.activeSessionId (which for a bound client equals boundSessionId),
      // the binding check passed trivially, and execution fell through to the
      // legacy resolver — which has no session check. The fix requires a bound
      // client's requestId to have an explicit mapping.
      const ctx = makeCtx()
      // NO permissionSessionMap entry; legacy pendingPermissions has the id
      const legacyResolve = mock.fn()
      ctx.permissions.pendingPermissions.set('legacy-req', { resolve: legacyResolve, timer: null })
      const boundClient = makeClient({
        activeSessionId: 'session-A',
        boundSessionId: 'session-A',
      })
      await handleSessionMessage(WS, boundClient, {
        type: 'permission_response',
        requestId: 'legacy-req',
        decision: 'allow',
      }, ctx)
      assert.equal(ctx.permissions.permissions.resolvePermission.mock?.calls?.length ?? 0, 0,
        'bound client must not resolve legacy permissions with no session mapping')
      assert.equal(legacyResolve.mock.calls.length, 0,
        'legacy resolve callback must not be invoked by bound client fallthrough')
      assert.ok(ctx.permissions.pendingPermissions.has('legacy-req'),
        'pendingPermissions entry must be preserved for a legitimate unbound client')
    })

    it('allows unbound client to respond to any session (primary-token mode)', async () => {
      const ctx = makeCtx()
      ctx.permissions.permissionSessionMap.set('any-req', 'session-X')
      const entryX = addSession(ctx, 'session-X')
      const unboundClient = makeClient({ activeSessionId: 'session-X' })  // no boundSessionId
      await handleSessionMessage(WS, unboundClient, {
        type: 'permission_response',
        requestId: 'any-req',
        decision: 'allow',
      }, ctx)
      assert.equal(entryX.session.respondToPermission.callCount, 1)
    })

    // #2905 / #3048: cross-client dismissal contract. Post-#3048, SDK sessions
    // (those with an originSessionId mapping) route the broadcast through the
    // unified pipeline (PermissionManager.emit → SdkSession.emit → SessionManager
    // session_event → EventNormalizer → broadcast). The handler no longer
    // broadcasts inline for SDK requests — it just calls respondToPermission
    // and lets the pipeline fan out. Verify by asserting respondToPermission
    // is invoked and ctx.transport.broadcast is NOT called.
    it('routes SDK resolution through respondToPermission (no inline broadcast — unified pipeline owns it, #3048)', async () => {
      const ctx = makeCtx()
      ctx.permissions.permissionSessionMap.set('req-broadcast', 'sess-1')
      const entry = addSession(ctx, 'sess-1')
      const responder = makeClient({ id: 'responder', activeSessionId: 'sess-1' })
      await handleSessionMessage(WS, responder, {
        type: 'permission_response',
        requestId: 'req-broadcast',
        decision: 'allow',
      }, ctx)
      assert.equal(entry.session.respondToPermission.callCount, 1)
      assert.deepStrictEqual(entry.session.respondToPermission.lastCall, ['req-broadcast', 'allow', undefined, undefined]) // #6543 editedInput 3rd arg + #6773 reason 4th arg (both absent here)
      assert.equal(ctx.transport.broadcast.mock.calls.length, 0,
        'SDK path must NOT broadcast inline — the unified pipeline handles it (#3048)')
    })

    // #3048: legacy non-SDK sessions resolved via ctx.permissions.permissions.resolvePermission
    // have no PermissionManager to wire through, so the handler still broadcasts
    // inline for that branch. Verify the filter excludes the responder.
    it('broadcasts inline for legacy non-SDK resolutions (#3048)', async () => {
      const ctx = makeCtx()
      // No permissionSessionMap entry → originSessionId is null → legacy branch
      ctx.permissions.pendingPermissions.set('legacy-req', { resolve: () => {}, timer: null })
      const responder = makeClient({ id: 'responder' })  // unbound client
      await handleSessionMessage(WS, responder, {
        type: 'permission_response',
        requestId: 'legacy-req',
        decision: 'deny',
      }, ctx)
      assert.equal(ctx.transport.broadcast.mock.calls.length, 1,
        'legacy branch must still broadcast inline (no PermissionManager pipeline available)')
      const [msg, filter] = ctx.transport.broadcast.mock.calls[0].arguments
      assert.equal(msg.type, 'permission_resolved')
      assert.equal(msg.requestId, 'legacy-req')
      assert.equal(msg.decision, 'deny')
      assert.equal(Object.prototype.hasOwnProperty.call(msg, 'sessionId'), false,
        'unmapped legacy resolutions must not carry a sessionId')
      // #6590: the broadcast no longer excludes the resolving client (no filter
      // arg) — the resolver needs its own permission_resolved to prune
      // permissionInputs[requestId], and this matches the SDK path.
      assert.equal(filter, undefined,
        'legacy broadcast reaches ALL clients incl. the resolver (no exclusion filter, #6590)')
    })
  })

  describe('user_question_response', () => {
    it('calls session.respondToQuestion', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      // #5753 — a real toolUseId is registered at dispatch; seed it so routing
      // resolves (an unmapped toolUseId is now dropped, not active-fallback'd).
      ctx.permissions.questionSessionMap.set('tool-xyz', 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'user_question_response',
        toolUseId: 'tool-xyz',
        answer: 'yes please',
      }, ctx)
      assert.equal(entry.session.respondToQuestion.callCount, 1)
      // #4668: handler forwards msg.toolUseId so claude-tui-session can
      // route to the right pending entry in its Map. Old 2-arg shape
      // (answer, answersMap) is preserved positionally; toolUseId is the
      // new trailing optional arg passed to every session type.
      // #4651: 4th arg is opts ({freeformText}); undefined when no
      // freeformText present on the wire.
      assert.deepStrictEqual(entry.session.respondToQuestion.lastCall, ['yes please', undefined, 'tool-xyz', undefined])
    })

    it('forwards answers map to respondToQuestion', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      const entry = addSession(ctx, 'sess-1')
      const answersMap = { 'Allow?': 'yes' }
      // #5753 — seed the dispatch-time route for this toolUseId.
      ctx.permissions.questionSessionMap.set('tool-abc', 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'user_question_response',
        toolUseId: 'tool-abc',
        answer: 'yes',
        answers: answersMap,
      }, ctx)
      assert.equal(entry.session.respondToQuestion.callCount, 1)
      // #4651: 4th positional arg is opts; undefined here (no freeformText).
      assert.deepStrictEqual(entry.session.respondToQuestion.lastCall, ['yes', answersMap, 'tool-abc', undefined])
    })
  })

  describe('destroy_session', () => {
    it('calls sessionManager.destroySession', async () => {
      const ctx = makeCtx()
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, { type: 'destroy_session', sessionId: 'sess-1' }, ctx)
      assert.equal(ctx.sessions.sessionManager.destroySession.mock.calls.length, 1)
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
      assert.equal(ctx.sessions.sessionManager.renameSession.mock.calls.length, 1)
    })

    it('catches rejection and sends session_error (#1918)', async () => {
      const ctx = makeCtx({
        sessionManager: {
          renameSession: mock.fn(() => { throw new Error('session destroyed concurrently') }),
        },
      })
      const client = makeClient({ activeSessionId: 'sess-1' })
      addSession(ctx, 'sess-1')
      await handleSessionMessage(WS, client, {
        type: 'rename_session',
        sessionId: 'sess-1',
        name: 'New Name',
      }, ctx)
      // Should send session_error, not throw unhandled rejection
      const sendCalls = ctx.transport.send.mock.calls
      const errorMsg = sendCalls.find(c => c.arguments[1]?.type === 'session_error')
      assert.ok(errorMsg, 'should send session_error on rename failure')
      assert.ok(errorMsg.arguments[1].message.includes('session destroyed concurrently'))
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

describe('registerMessageHandler', () => {
  // Track registered test types so tests don't bleed between runs.
  // The registry is module-level, so we clean up in afterEach.
  const registeredTypes = []

  afterEach(() => {
    // Re-register a no-op to neutralise handlers added by these tests.
    // (We can't delete from the Map directly without importing it, but
    //  overwriting with a no-op prevents interference between test runs.)
    for (const type of registeredTypes) {
      registerMessageHandler(type, async () => {})
    }
    registeredTypes.length = 0
  })

  it('dispatches a custom message type to the registered handler', async () => {
    const handlerFn = mock.fn()
    registerMessageHandler('my_custom_action', handlerFn)
    registeredTypes.push('my_custom_action')

    const ctx = makeCtx()
    const client = makeClient()
    const msg = { type: 'my_custom_action', payload: 'hello' }
    await handleSessionMessage(WS, client, msg, ctx)

    assert.equal(handlerFn.mock.calls.length, 1)
    const [ws, cl, m, c] = handlerFn.mock.calls[0].arguments
    assert.equal(ws, WS)
    assert.equal(cl, client)
    assert.equal(m, msg)
    assert.equal(c, ctx)
  })

  it('passes full ctx to the registered handler', async () => {
    let capturedCtx = null
    registerMessageHandler('ctx_capture_test', async (_ws, _client, _msg, ctx) => {
      capturedCtx = ctx
    })
    registeredTypes.push('ctx_capture_test')

    const ctx = makeCtx()
    const client = makeClient()
    await handleSessionMessage(WS, client, { type: 'ctx_capture_test' }, ctx)

    assert.ok(capturedCtx !== null)
    assert.ok(typeof capturedCtx.transport.send === 'function' || capturedCtx.transport.send?.mock)
  })

  it('overwrites a previously registered handler for the same type', async () => {
    const first = mock.fn()
    const second = mock.fn()
    registerMessageHandler('overwrite_test', first)
    registerMessageHandler('overwrite_test', second)
    registeredTypes.push('overwrite_test')

    await handleSessionMessage(WS, makeClient(), { type: 'overwrite_test' }, makeCtx())

    assert.equal(first.mock.calls.length, 0, 'first handler should not be called after overwrite')
    assert.equal(second.mock.calls.length, 1, 'second handler should be called')
  })

  it('throws when type is not a non-empty string', () => {
    assert.throws(() => registerMessageHandler('', async () => {}), /non-empty string/)
    assert.throws(() => registerMessageHandler(null, async () => {}), /non-empty string/)
  })

  it('throws when handlerFn is not a function', () => {
    assert.throws(() => registerMessageHandler('valid_type', 'not-fn'), /function/)
    assert.throws(() => registerMessageHandler('valid_type', null), /function/)
  })
})
