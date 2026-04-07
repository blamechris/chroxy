/**
 * Shared utilities, constants, and validators for message handlers.
 *
 * This module is the dependency root for handler modules — it must NOT
 * import from ws-message-handlers.js or any handler module to avoid
 * circular dependencies.
 */
import { statSync, realpathSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { resolve, relative } from 'path'

// -- Permission modes --
export const PERMISSION_MODES = [
  { id: 'approve', label: 'Approve' },
  { id: 'acceptEdits', label: 'Accept Edits' },
  { id: 'auto', label: 'Auto (bypass)' },
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

/**
 * Validate that a cwd path exists, is a directory, and is within the user's home directory.
 * Returns null if valid, or an error string describing the problem.
 * @param {string} cwd - The directory path to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateCwdWithinHome(cwd) {
  try {
    const s = statSync(cwd)
    if (!s.isDirectory()) return `Not a directory: ${cwd}`
  } catch {
    return `Directory does not exist: ${cwd}`
  }
  const home = homedir()
  let realCwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    return `Cannot resolve path: ${cwd}`
  }
  if (!realCwd.startsWith(home + '/') && realCwd !== home) {
    return 'Directory must be within your home directory'
  }
  return null
}

/**
 * Check whether a connected WS client declared a specific capability during auth.
 *
 * @param {WebSocket} ws - The WebSocket connection object
 * @param {string} capability - The capability string to check
 * @returns {boolean} true if the client declared the capability, false otherwise
 */
export function clientHasCapability(ws, capability) {
  return ws.clientCapabilities?.has(capability) ?? false
}

/** Broadcast client_focus_changed to other clients when a client's active session changes */
export function broadcastFocusChanged(client, sessionId, ctx) {
  ctx.broadcast(
    { type: 'client_focus_changed', clientId: client.id, sessionId, timestamp: Date.now() },
    (c) => c.id !== client.id
  )
}

/**
 * Auto-subscribe all other authenticated clients to a session.
 * Call after creating a session so streaming messages reach every connected client
 * (dashboard, other mobile clients, etc.) without requiring explicit subscribe_sessions.
 */
export function autoSubscribeOtherClients(sessionId, excludeWs, ctx) {
  for (const [clientWs, c] of ctx.clients) {
    if (c.authenticated && clientWs !== excludeWs) {
      c.subscribedSessionIds.add(sessionId)
    }
  }
}

/**
 * Enforce that a bound client is only accessing its bound session.
 * Throws if the client has a boundSessionId that doesn't match the target.
 *
 * @param {object} client - Connected client state
 * @param {string} targetSessionId - The session ID being accessed
 * @throws {Error} if the client is bound to a different session
 */
export function enforceBoundSession(client, targetSessionId) {
  if (client.boundSessionId && client.boundSessionId !== targetSessionId) {
    const err = new Error('Access denied: client is bound to a different session')
    err.code = 'SESSION_TOKEN_MISMATCH'
    throw err
  }
}

/**
 * Resolve a session from a message and client context.
 * Prefers msg.sessionId, falls back to client.activeSessionId.
 * Returns the session entry, or null if not found.
 *
 * If the client has a boundSessionId, enforces that the resolved session
 * matches the binding. Returns null if the binding is violated.
 *
 * @param {object} ctx - Handler context with sessionManager
 * @param {object} msg - Incoming WebSocket message
 * @param {object} client - Connected client state
 * @returns {object|null} Session entry or null
 */
export function resolveSession(ctx, msg, client) {
  const sid = msg.sessionId || client?.activeSessionId

  // Enforce session token binding: a bound client can only resolve its own
  // session. If a specific sid was requested and it doesn't match, reject.
  if (sid && client?.boundSessionId && client.boundSessionId !== sid) {
    return null
  }

  // Delegate to sessionManager — its getSession handles null/undefined sid
  // (real SessionManager returns null, cliSession adapter returns default entry).
  return ctx.sessionManager?.getSession(sid) ?? null
}

/**
 * Send a structured error response to a WebSocket client.
 * Use in handler catch blocks so the client can clear loading state
 * and surface a user-facing message instead of silently spinning.
 *
 * @param {WebSocket} ws - Target WebSocket connection
 * @param {string|null} requestId - Correlating request ID (may be null)
 * @param {string} code - Machine-readable error code (e.g. 'HANDLER_ERROR')
 * @param {string} message - Human-readable error description
 */
export function sendError(ws, requestId, code, message) {
  if (!ws || ws.readyState !== 1) return
  ws.send(JSON.stringify({ type: 'error', requestId: requestId ?? null, code, message }))
}
