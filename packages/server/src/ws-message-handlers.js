/**
 * WebSocket message handler registry.
 *
 * Dispatches messages via a Map-based registry instead of a monolithic switch.
 * Handler modules are organized by domain under handlers/.
 *
 * To add a new message type: export it from the appropriate handler file
 * (or create a new one) and add the import here.
 */
import { createLogger } from './logger.js'
import { inputHandlers } from './handlers/input-handlers.js'
import { sessionHandlers } from './handlers/session-handlers.js'
import { settingsHandlers } from './handlers/settings-handlers.js'
import { fileHandlers } from './handlers/file-handlers.js'
import { ideHandlers } from './handlers/ide-handlers.js'
import { conversationHandlers } from './handlers/conversation-handlers.js'
import { checkpointHandlers } from './handlers/checkpoint-handlers.js'
import { repoHandlers } from './handlers/repo-handlers.js'
import { featureHandlers } from './handlers/feature-handlers.js'
import { evaluatorHandlers } from './handlers/evaluator-handlers.js'
import { controlRoomHandlers } from './handlers/control-room-handlers.js'
import { summarizeHandlers } from './handlers/summarize-handlers.js'
import { pairingHandlers } from './handlers/pairing-handlers.js'
import { tokenHandlers } from './handlers/token-handlers.js'
import { orchestrationHandlers } from './handlers/orchestration-handlers.js'

const log = createLogger('ws')

// -- Handler registry --
const handlerRegistry = new Map([
  ...Object.entries(inputHandlers),
  ...Object.entries(sessionHandlers),
  ...Object.entries(settingsHandlers),
  ...Object.entries(fileHandlers),
  ...Object.entries(ideHandlers),
  ...Object.entries(conversationHandlers),
  ...Object.entries(checkpointHandlers),
  ...Object.entries(repoHandlers),
  ...Object.entries(featureHandlers),
  ...Object.entries(evaluatorHandlers),
  ...Object.entries(controlRoomHandlers),
  ...Object.entries(summarizeHandlers),
  ...Object.entries(pairingHandlers),
  ...Object.entries(tokenHandlers),
  ...Object.entries(orchestrationHandlers),
])

/**
 * Sorted array of all message type strings registered in the handler registry
 * at module load time (i.e. the built-in handler set, before any runtime
 * registrations via registerMessageHandler).
 *
 * Derived directly from handlerRegistry to prevent drift between the registry
 * and this exported list.
 *
 * Used by the schema-coverage test to assert that every built-in handler type
 * has a corresponding Zod schema in @chroxy/protocol.
 */
export const registeredMessageTypes = Object.freeze([...handlerRegistry.keys()].sort())

/**
 * Register a custom message handler at runtime.
 * Allows external code (e.g. provider plugins) to handle additional
 * message types without modifying the handler modules.
 *
 * @param {string} type - WS message type (e.g. 'my_custom_action')
 * @param {Function} handlerFn - async (ws, client, msg, ctx) => void
 * @throws {Error} if type is not a non-empty string or handlerFn is not a function
 */
export function registerMessageHandler(type, handlerFn) {
  if (typeof type !== 'string' || !type) {
    throw new Error('registerMessageHandler: type must be a non-empty string')
  }
  if (typeof handlerFn !== 'function') {
    throw new Error('registerMessageHandler: handlerFn must be a function')
  }
  handlerRegistry.set(type, handlerFn)
}

/**
 * Handle messages in multi-session mode.
 *
 * The `ctx` is role-scoped into namespaces (#5558) — `ctx.transport`,
 * `ctx.sessions`, `ctx.permissions`, `ctx.services`, `ctx.runtime`. The shape
 * is defined ONCE in ws-handler-context.js (the `WsHandlerContext` typedef +
 * `CTX_NAMESPACES` + `assertCtxShape`) so this doc can't drift from the real
 * object; see that module for the per-field breakdown.
 *
 * @param {WebSocket} ws
 * @param {object} client
 * @param {object} msg
 * @param {import('./ws-handler-context.js').WsHandlerContext} ctx
 */
export async function handleSessionMessage(ws, client, msg, ctx) {
  const handler = handlerRegistry.get(msg.type)
  if (handler) {
    // Errors propagate to _handleMessage in ws-server.js, which emits a
    // server_error with correlationId. Do NOT add an inner try/catch here.
    await handler(ws, client, msg, ctx)
  } else {
    log.debug(`Unknown message type: ${msg.type}`)
  }
}

/**
 * Create a session-manager adapter that wraps a single CLI session.
 * This allows handleCliMessage to delegate to handleSessionMessage
 * without duplicating all the message handling logic.
 *
 * NOTE: This path is unused in production — server-cli.js always passes a full
 * SessionManager and never a cliSession. However, ~11 test files pass a cliSession
 * mock as a lightweight harness, so this adapter is exercised by the test suite.
 * Removing it requires migrating those tests to use SessionManager directly; see #2330.
 */
function createCliSessionAdapter(cliSession) {
  const cwd = cliSession?.cwd || null
  const defaultEntry = { session: cliSession, cwd, name: 'Default' }

  return {
    getSession: (id) => (id === 'default' || !id) ? defaultEntry : null,
    isBudgetPaused: () => false,
    recordUserInput: () => {},
    touchActivity: () => {},
    listSessions: () => [{
      sessionId: 'default',
      name: 'Default',
      cwd,
      isBusy: cliSession?.isRunning || false,
      model: null,
      provider: null,
      createdAt: Date.now(),
    }],
    createSession: () => { throw new Error('Session management not available in single-CLI mode') },
    destroySession: () => { throw new Error('Session management not available in single-CLI mode') },
    renameSession: () => false,
    getHistoryCount: () => 0,
    getFullHistoryAsync: () => Promise.resolve([]),
    getSessionContext: () => Promise.resolve(null),
    getSessionCost: () => 0,
    getTotalCost: () => 0,
    getCostBudget: () => null,
    resumeBudget: () => {},
    get firstSessionId() { return 'default' },
    get defaultCwd() { return cwd },
  }
}

/** Handle messages in legacy single CLI mode — delegates to handleSessionMessage via adapter */
export function handleCliMessage(ws, client, msg, ctx) {
  // Override only the affected namespace buckets, preserving the others by
  // reference. The CLI adapter masquerades as a SessionManager and collapses
  // per-session broadcasts onto the single connection (#5558: namespaced ctx).
  const adaptedCtx = {
    ...ctx,
    sessions: {
      ...ctx.sessions,
      sessionManager: createCliSessionAdapter(ctx.sessions.cliSession),
    },
    transport: {
      ...ctx.transport,
      broadcastToSession: (_sid, message, filter) => ctx.transport.broadcast(message, filter),
      broadcastSessionList: () => {},
    },
  }

  return handleSessionMessage(ws, client, msg, adaptedCtx)
}
