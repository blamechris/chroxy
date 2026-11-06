/**
 * Conversation listing / search / transcript scope.
 *
 * - **Unbound client** (main API token, desktop dashboard, test client):
 *   everything, unchanged. Unbound clients already have full-token access, so
 *   filtering would only hide conversations behind a cosmetic scope.
 *
 * - **Bound client** (`client.boundSessionId` is set, including an empty or
 *   non-string value — those are bindings that name no session, and they match
 *   nothing): only the conversation the bound session is itself running.
 *   Directory containment is NOT ownership. Two sessions can share a project
 *   directory, and a project can sit beneath another session's directory, so a
 *   conversation recorded under the bound session's cwd may belong to a
 *   different session. A conversation is visible to a bound client only when:
 *     1. its id equals the conversation the daemon associates with the bound
 *        session (`sessionManager.getConversationId`), AND
 *     2. its recorded cwd is the bound session's cwd or beneath it.
 *   When the daemon does not know the association (a session that has not
 *   started a conversation yet, or a manager that cannot report one) the answer
 *   is "none": the scope fails closed rather than falling back to the directory.
 */
import { isAbsolute } from 'path'
import { isPathWithin } from './handler-utils.js'
import { isBoundClient } from './environments/authority.js'

/**
 * The conversation id the daemon associates with the client's bound session, or
 * null when it is unknown or the client is not usable as a bound client.
 * @param {object} client
 * @param {object} ctx
 * @returns {string|null}
 */
export function boundConversationId(client, ctx) {
  const sid = client?.boundSessionId
  if (typeof sid !== 'string' || sid.length === 0) return null
  const id = ctx?.sessions?.sessionManager?.getConversationId?.(sid)
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * May this client read the conversation `conversationId` recorded under `cwd`?
 * Unbound clients always may. A bound client may only when it is the bound
 * session's own conversation and `cwd` is inside the session's directory.
 * @param {{ conversationId: string, cwd: string|null }} conv
 * @param {object} client
 * @param {object} ctx
 * @returns {boolean}
 */
export function clientOwnsConversation(conv, client, ctx) {
  if (!isBoundClient(client)) return true
  const ownId = boundConversationId(client, ctx)
  if (!ownId || conv?.conversationId !== ownId) return false
  const allowedCwd = ctx?.sessions?.sessionManager?.getSession?.(client.boundSessionId)?.cwd
  if (!allowedCwd || typeof allowedCwd !== 'string' || !isAbsolute(allowedCwd)) return false
  // `isPathWithin` refuses a non-absolute argument (#7273), and `cwd` is read
  // out of a record on disk: anything unusable fails closed.
  const cwd = conv?.cwd
  if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd)) return false
  return isPathWithin(cwd, allowedCwd)
}

/**
 * @param {Array<{ conversationId: string, cwd: string|null }>} conversations
 * @param {object} client - Connected client state
 * @param {object} ctx - Handler context (needs `sessions.sessionManager`)
 * @returns {Array} Filtered conversation list
 */
export function scopeConversationsToClient(conversations, client, ctx) {
  if (!Array.isArray(conversations)) return []
  if (!isBoundClient(client)) return conversations
  return conversations.filter((conv) => clientOwnsConversation(conv, client, ctx))
}
