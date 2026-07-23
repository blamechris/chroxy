/**
 * WsHandlerContext — the role-scoped context handed to every WS message
 * handler (#5558).
 *
 * Before #5558 this was a flat ~31-field "god context": a summarize-handler
 * received the same surface as an input-handler, the real coupling graph was
 * invisible, and partial test mocks passed while silently omitting fields that
 * future code would read. The shape is now bucketed into five namespaces so a
 * handler's `ctx.transport` / `ctx.sessions` / `ctx.permissions` / `ctx.services`
 * / `ctx.runtime` reads declare what it actually couples to.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the shape: the JSDoc typedef
 * below, the `CTX_NAMESPACES` list, and `assertCtxShape()` are all derived from
 * the same five buckets. ws-server.js builds the production ctx; tests build a
 * namespaced mock via `tests/test-helpers.js` and may run it through
 * `assertCtxShape()` so a partial mock fails loudly at construction instead of
 * at the first missing-field read deep inside a handler.
 *
 * No TypeScript in the server — the typedef exists purely for editor `@type`
 * hints in the handler modules (`/** @param {import('../ws-handler-context.js').WsHandlerContext} ctx *​/`).
 *
 * @typedef {Object} WsHandlerTransport
 * @property {(ws: any, msg: object) => void} send - Send one message to one client.
 * @property {(msg: object, filter?: (client: object) => boolean) => void} broadcast - Broadcast to all (optionally filtered) clients.
 * @property {(sessionId: string, msg: object, filter?: (client: object) => boolean) => void} broadcastToSession - Broadcast to clients subscribed to a session.
 * @property {() => void} broadcastSessionList - Re-send the session list to every authenticated client.
 * @property {(client: object, sessionId: string) => void} subscribeClient - Index-maintaining subscribe (#5563).
 * @property {(client: object, sessionId: string) => void} unsubscribeClient - Index-maintaining unsubscribe (#5563).
 * @property {(client: object, sessionId: string|null) => void} setActiveSession - Index-maintaining active-session set (#5563).
 * @property {(sessionId: string, clientId: string) => void} updatePrimary - First-input adoption: claim primary iff unclaimed, else no-op (#5563).
 * @property {(sessionId: string, clientId: string, opts?: {force?: boolean}) => {changed: boolean, rejected?: boolean, primaryClientId: string|undefined}} claimPrimary - Explicit claim / hand-off (force=true) for a session (#5563).
 * @property {(sessionId: string) => string|undefined} getPrimary - Current primary clientId for a session, or undefined (#5563).
 * @property {(sessionId: string, clientId: string) => boolean} isPrimary - True iff clientId is the session's primary (#5563).
 * @property {(sessionId: string) => void} clearPrimary - Vacate a session's primary slot, announcing the vacancy (#5563).
 * @property {(sessionId: string) => void} syncTerminalMirror - Re-evaluate the terminal-mirror coalescer gate for a session after its subscriber set changes (#5837).
 * @property {(ws: any, sessionId: string) => void} sendSessionInfo - Send a session_info envelope.
 * @property {(ws: any, sessionId: string) => void} replayHistory - Replay a session's history to a client.
 * @property {Map} clients - WebSocket → client-state Map (the WsClientManager's Map).
 *
 * @typedef {Object} WsHandlerSessions
 * @property {object|null} sessionManager - The multi-session SessionManager (null in single-CLI mode).
 * @property {object|null} cliSession - The legacy single CLI session (null in multi-session mode).
 *
 * @typedef {Object} WsHandlerPermissions
 * @property {object} permissions - The permission handler (createPermissionHandler).
 * @property {object} permissionAudit - The PermissionAuditLog.
 * @property {Map} pendingPermissions - requestId → pending permission.
 * @property {Map} permissionSessionMap - requestId → sessionId routing.
 * @property {(requestId: string) => void} unregisterPermissionRoute - #5704 teardown hook.
 * @property {Map} questionSessionMap - toolUseId → sessionId routing.
 *
 * @typedef {Object} WsHandlerServices
 * @property {object|null} pushManager - Push-notification manager.
 * @property {object|null} pairingManager - Pairing/approval manager.
 * @property {object|null} checkpointManager - Checkpoint manager.
 * @property {object|null} tokenManager - Token lifecycle manager (revoke/rotate); null in --no-auth mode (#6006).
 * @property {object|null} devPreview - Dev-preview manager.
 * @property {object|null} webTaskManager - Background web-task manager.
 * @property {object|null} environmentManager - Container/environment manager.
 * @property {object|null} devicePreferences - Per-device active-session memory.
 * @property {object} fileOps - File-operations facade.
 * @property {object} config - Runtime config.
 * @property {object|null} skillsUsageRecorder - Per-skill usage aggregates (lives on SessionManager).
 * @property {(requestId: string, result: object) => void} resolvePairRequester - Resolve a pending pair request.
 * @property {(requestId: string, reason: string) => void} broadcastPairResolved - Fan-out a pair-resolved notice.
 *
 * @typedef {Object} WsHandlerRuntime
 * @property {boolean} draining - True while the server is draining for shutdown.
 * @property {string[]} projectsDirs - Per-provider projects dirs (computed fresh each access).
 * @property {string[]} userAgentsDirs - Per-provider agents dirs (computed fresh each access).
 * @property {Map} evaluatorIterations - sessionId → stable auto-evaluator iteration counter (#3186/#3637).
 *
 * @typedef {Object} WsHandlerContext
 * @property {WsHandlerTransport} transport
 * @property {WsHandlerSessions} sessions
 * @property {WsHandlerPermissions} permissions
 * @property {WsHandlerServices} services
 * @property {WsHandlerRuntime} runtime
 * @property {string} [correlationId] - Per-message id, spread on at dispatch time in ws-server.js.
 */

/**
 * The five role namespaces and the keys each must carry. Single source of
 * truth for `assertCtxShape`; ws-server.js's `_handlerCtx` and the test mock
 * builder are both asserted against this so they cannot silently drift.
 *
 * Optional, cross-cutting test-injection seams (e.g. `ctx.evaluateDraft`,
 * `ctx.summarizeSession`, `ctx.scanConversations`, `ctx.resolveRepoSet`,
 * `ctx.surveyRunners`, `ctx.realpath`, `ctx._pendingEvaluatorAwaits`) are
 * deliberately NOT listed here — they are optional DI hooks read with
 * `ctx?.X ?? defaultX` and never present on the production ctx.
 *
 * @type {Record<string, string[]>}
 */
export const CTX_NAMESPACES = {
  transport: [
    'send',
    'broadcast',
    'broadcastToSession',
    'broadcastSessionList',
    'subscribeClient',
    'unsubscribeClient',
    'setActiveSession',
    'updatePrimary',
    'claimPrimary',
    'getPrimary',
    'isPrimary',
    'clearPrimary',
    'syncTerminalMirror',
    'sendSessionInfo',
    'replayHistory',
    'clients',
  ],
  sessions: [
    'sessionManager',
    'cliSession',
  ],
  permissions: [
    'permissions',
    'permissionAudit',
    'pendingPermissions',
    'permissionSessionMap',
    'unregisterPermissionRoute',
    'questionSessionMap',
  ],
  services: [
    'pushManager',
    'pairingManager',
    'checkpointManager',
    'devPreview',
    'webTaskManager',
    'environmentManager',
    'devicePreferences',
    'fileOps',
    'config',
    'skillsUsageRecorder',
    'resolvePairRequester',
    'broadcastPairResolved',
    // #6277: host-local user-shell approval store; the create gate holds a
    // spawn here when userShell.requireApproval is on. Null in test ctx mocks.
    'shellApprovalStore',
    // #5966: bounded RepoEventStore drained by the Control Room repo-events
    // survey. Null until the first GitHub-webhook delivery lazily creates it.
    'repoEventStore',
    // #6540: repo-events webhook-secret config surface. `webhookPayloadUrl`
    // derives the GitHub payload URL from the live origin; `repoWebhookDeliveries`
    // is the in-memory recent-delivery ring (null until the first delivery);
    // `setWebhookSecretCache` refreshes the in-process secret cache on a
    // set/rotate/clear.
    'webhookPayloadUrl',
    'repoWebhookDeliveries',
    'setWebhookSecretCache',
    // #6691: the OrchestrationManager (delegation harness). Present only when
    // the orchestration feature is enabled and the engine is wired (E-4); the
    // handlers (S-2) treat an absent manager as "engine not running".
    'orchestrationManager',
  ],
  runtime: [
    'draining',
    'projectsDirs',
    'userAgentsDirs',
    'evaluatorIterations',
  ],
}

/** All namespace names, in declaration order. */
export const CTX_NAMESPACE_NAMES = Object.keys(CTX_NAMESPACES)

/**
 * Assert that `ctx` carries every role namespace and that each namespace
 * object exists. By default this is SHALLOW — it checks the five namespace
 * objects are present (the common partial-mock failure: a test forgets an
 * entire bucket). Pass `{ deep: true }` to additionally assert every key
 * inside each namespace is present (used by the test-helper builder + its
 * unit test so a drifted mock fails at construction, not at first read).
 *
 * Throws a `TypeError` naming the first missing namespace/key so the failure
 * is self-explaining.
 *
 * @param {object} ctx - Candidate handler context.
 * @param {{deep?: boolean}} [options]
 * @returns {object} the same ctx (for chaining).
 */
export function assertCtxShape(ctx, { deep = false } = {}) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError(`assertCtxShape: expected a ctx object, got ${ctx === null ? 'null' : typeof ctx}`)
  }
  for (const ns of CTX_NAMESPACE_NAMES) {
    const bucket = ctx[ns]
    if (!bucket || typeof bucket !== 'object') {
      throw new TypeError(
        `assertCtxShape: handler ctx is missing the '${ns}' namespace `
        + `(expected ctx.${ns} to be an object). Build it via test-helpers' nsCtx().`
      )
    }
    if (deep) {
      for (const key of CTX_NAMESPACES[ns]) {
        if (!(key in bucket)) {
          throw new TypeError(
            `assertCtxShape: ctx.${ns} is missing required key '${key}'. `
            + `If this is intentional, the key must still be present (set to null/undefined explicitly).`
          )
        }
      }
    }
  }
  return ctx
}
