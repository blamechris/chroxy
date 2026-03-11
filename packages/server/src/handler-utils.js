/**
 * Shared utilities for message handlers.
 */
import { statSync, realpathSync } from 'fs'
import { homedir } from 'os'

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

/** Broadcast client_focus_changed to other clients when a client's active session changes */
export function broadcastFocusChanged(client, sessionId, ctx) {
  ctx.broadcast(
    { type: 'client_focus_changed', clientId: client.id, sessionId, timestamp: Date.now() },
    (c) => c.id !== client.id
  )
}
