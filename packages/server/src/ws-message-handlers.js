/**
 * WebSocket message handler registry.
 *
 * Dispatches messages via a Map-based registry instead of a monolithic switch.
 * Handler modules are organized by domain under handlers/.
 *
 * To add a new message type: export it from the appropriate handler file
 * (or create a new one) and add the import here.
 */
import { readFileSync, statSync, realpathSync } from 'fs'
import { resolve, relative } from 'path'

import { inputHandlers } from './handlers/input-handlers.js'
import { sessionHandlers } from './handlers/session-handlers.js'
import { settingsHandlers } from './handlers/settings-handlers.js'
import { fileHandlers } from './handlers/file-handlers.js'
import { conversationHandlers } from './handlers/conversation-handlers.js'
import { checkpointHandlers } from './handlers/checkpoint-handlers.js'
import { webTaskHandlers } from './handlers/web-task-handlers.js'
import { repoHandlers } from './handlers/repo-handlers.js'

// -- Permission modes (re-exported for backward compat) --
export const PERMISSION_MODES = [
  { id: 'approve', label: 'Approve' },
  { id: 'acceptEdits', label: 'Accept Edits' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
]
export const ALLOWED_PERMISSION_MODE_IDS = new Set(PERMISSION_MODES.map((m) => m.id))

// -- Attachment validation constants --
export const MAX_ATTACHMENT_COUNT = 5
export const MAX_IMAGE_SIZE = 2 * 1024 * 1024       // 2MB decoded
export const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024    // 5MB decoded
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ALLOWED_DOC_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'])

/**
 * Validate an attachments array from a WebSocket message.
 * Returns null if valid, or an error string if invalid.
 */
export function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) return 'attachments must be an array'
  if (attachments.length > MAX_ATTACHMENT_COUNT) return `too many attachments (max ${MAX_ATTACHMENT_COUNT})`
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (!att || typeof att !== 'object') return `attachment[${i}]: not an object`
    if (typeof att.type !== 'string' || (att.type !== 'image' && att.type !== 'document' && att.type !== 'file_ref')) {
      return `attachment[${i}]: type must be 'image', 'document', or 'file_ref'`
    }

    // file_ref: project-relative path — server reads content before sending to Claude
    if (att.type === 'file_ref') {
      if (typeof att.path !== 'string' || !att.path.trim()) {
        return `attachment[${i}]: file_ref requires a non-empty path`
      }
      if (att.path.startsWith('/')) {
        return `attachment[${i}]: file_ref path must not be absolute`
      }
      if (att.path.split('/').includes('..')) {
        return `attachment[${i}]: file_ref path must not contain traversal (..)`
      }
      continue
    }

    if (typeof att.mediaType !== 'string') return `attachment[${i}]: missing mediaType`
    if (typeof att.data !== 'string') return `attachment[${i}]: missing data`
    if (typeof att.name !== 'string') return `attachment[${i}]: missing name`

    if (att.type === 'image' && !ALLOWED_IMAGE_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'image' requires an image mediaType`
    }
    if (att.type === 'document' && !ALLOWED_DOC_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'document' requires a document mediaType`
    }

    const decodedSize = Math.ceil(att.data.length * 3 / 4)
    const maxSize = att.type === 'image' ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE
    if (decodedSize > maxSize) {
      return `attachment[${i}]: exceeds ${maxSize / (1024 * 1024)}MB limit`
    }
  }
  return null
}

const MAX_FILE_REF_SIZE = 1 * 1024 * 1024 // 1MB max per file_ref

/**
 * Resolve file_ref attachments by reading file content from the session's cwd.
 * Converts file_ref entries to standard document attachments with base64 data.
 * Non-file_ref attachments are passed through unchanged.
 *
 * @param {Array} attachments - Validated attachment array
 * @param {string} cwd - Session working directory
 * @returns {Array} Resolved attachments (file_ref → document with inline text)
 */
export function resolveFileRefAttachments(attachments, cwd) {
  if (!attachments?.length || !cwd) return attachments
  return attachments.map(att => {
    if (att.type !== 'file_ref') return att
    const absPath = resolve(cwd, att.path)
    // Security: ensure resolved path is within cwd
    const rel = relative(cwd, absPath)
    if (rel.startsWith('..') || resolve(cwd, rel) !== absPath) {
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: cannot read file outside project: ${att.path}]`).toString('base64'), name: att.name || att.path }
    }
    // Security: verify after symlink resolution to prevent symlink escape
    try {
      const realAbs = realpathSync(absPath)
      const realCwd = realpathSync(cwd)
      const realRel = relative(realCwd, realAbs)
      if (realRel.startsWith('..')) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: cannot read file outside project: ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
    } catch {
      // realpathSync fails if file doesn't exist — let readFileSync handle ENOENT below
    }
    try {
      const stat = statSync(absPath)
      if (stat.size > MAX_FILE_REF_SIZE) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: file too large (${(stat.size / 1024).toFixed(0)}KB, max 1MB): ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
      // Detect binary files by checking for null bytes in the first 8KB
      const raw = readFileSync(absPath)
      const sample = raw.subarray(0, 8192)
      if (sample.includes(0)) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: binary file not supported: ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
      const content = raw.toString('utf-8')
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(content).toString('base64'), name: att.name || att.path }
    } catch (err) {
      const msg = err?.code === 'ENOENT' ? 'file not found' : err?.code === 'EACCES' ? 'permission denied' : 'read error'
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: ${msg}: ${att.path}]`).toString('base64'), name: att.name || att.path }
    }
  })
}

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
