/**
 * WebSocket message handler registry.
 *
 * Dispatches messages via a Map-based registry instead of a monolithic switch.
 * Handler modules are organized by domain under handlers/.
 *
 * To add a new message type: export it from the appropriate handler file
 * (or create a new one) and add the import here.
 */
import { inputHandlers } from './handlers/input-handlers.js'
import { sessionHandlers } from './handlers/session-handlers.js'
import { settingsHandlers } from './handlers/settings-handlers.js'
import { fileHandlers } from './handlers/file-handlers.js'
import { conversationHandlers } from './handlers/conversation-handlers.js'
import { checkpointHandlers } from './handlers/checkpoint-handlers.js'
import { webTaskHandlers } from './handlers/web-task-handlers.js'
import { repoHandlers } from './handlers/repo-handlers.js'

// Re-export shared constants and utilities for backward compatibility.
// Canonical source is handler-utils.js — handler modules import from there directly.
export {
  PERMISSION_MODES,
  ALLOWED_PERMISSION_MODE_IDS,
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_SIZE,
  MAX_DOCUMENT_SIZE,
  ALLOWED_IMAGE_TYPES,
  validateAttachments,
  resolveFileRefAttachments,
} from './handler-utils.js'

// -- Handler registry --
const handlerRegistry = new Map([
  ...Object.entries(inputHandlers),
  ...Object.entries(sessionHandlers),
  ...Object.entries(settingsHandlers),
  ...Object.entries(fileHandlers),
  ...Object.entries(conversationHandlers),
  ...Object.entries(checkpointHandlers),
  ...Object.entries(webTaskHandlers),
  ...Object.entries(repoHandlers),
])

/**
 * Handle messages in multi-session mode.
 *
 * ctx shape: {
 *   send, broadcast, broadcastToSession, broadcastSessionList,
 *   sessionManager, checkpointManager, devPreview, webTaskManager,
 *   pushManager, primaryClients, clients,
 *   permissionSessionMap, questionSessionMap, pendingPermissions,
 *   fileOps, permissions,
 *   updatePrimary, sendSessionInfo, replayHistory,
 *   draining,
 * }
 */
export async function handleSessionMessage(ws, client, msg, ctx) {
  const handler = handlerRegistry.get(msg.type)
  if (handler) {
    await handler(ws, client, msg, ctx)
  } else {
    console.log(`[ws] Unknown message type: ${msg.type}`)
  }
}

/**
 * Create a session-manager adapter that wraps a single CLI session.
 * This allows handleCliMessage to delegate to handleSessionMessage
 * without duplicating all the message handling logic.
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
  const adaptedCtx = {
    ...ctx,
    sessionManager: createCliSessionAdapter(ctx.cliSession),
    broadcastToSession: (_sid, message, filter) => ctx.broadcast(message, filter),
    broadcastSessionList: () => {},
  }

  return handleSessionMessage(ws, client, msg, adaptedCtx)
}
