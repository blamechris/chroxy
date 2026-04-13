/**
 * Conversation listing / search scope enforcement.
 *
 * Closes Adversary A8 (2026-04-11 audit). Previously,
 * `list_conversations` and `search_conversations` scanned every JSONL
 * under `~/.claude/projects/**` and returned the full set to any
 * authenticated client — including bound pairing-issued mobile clients
 * that should only see the session they were paired for. A mobile user
 * could enumerate every Claude Code conversation across every project
 * on the operator's machine, grep for secrets-in-transcripts, and
 * identify high-value targets for follow-up attacks.
 *
 * Defense: scope the result set to what the client is allowed to see.
 *
 * - **Bound client** (has `client.boundSessionId`): only conversations
 *   whose recorded `cwd` is the bound session's cwd, or a subdirectory
 *   of it. If the bound session has no cwd (shouldn't happen, but
 *   defensive), return the empty set.
 *
 * - **Unbound client** (main API token, desktop dashboard, test
 *   client): return the full set unchanged. Unbound clients already
 *   have full-token access and can create any session they want;
 *   filtering here would just hide conversations behind a cosmetic
 *   scope.
 *
 * This is a soft defense — an attacker who holds the main API token
 * can already read the files directly. The check exists specifically
 * to shrink the blast radius of a compromised pairing token.
 */
import { isPathWithin } from './handler-utils.js'

/**
 * @param {Array<{ cwd: string|null }>} conversations
 * @param {object} client - Connected client state
 * @param {object} ctx - Handler context (needs `sessionManager.getSession`)
 * @returns {Array} Filtered conversation list
 */
export function scopeConversationsToClient(conversations, client, ctx) {
  if (!Array.isArray(conversations)) return []
  // Unbound clients: full token, full visibility.
  if (!client?.boundSessionId) return conversations
  const entry = ctx?.sessionManager?.getSession?.(client.boundSessionId)
  const allowedCwd = entry?.cwd
  // Bound-but-cwd-missing: fail closed. A bound client should not see
  // *any* conversation if we can't confidently scope the result.
  if (!allowedCwd || typeof allowedCwd !== 'string') return []
  return conversations.filter((conv) => {
    const cwd = conv?.cwd
    if (!cwd || typeof cwd !== 'string') return false
    return cwd === allowedCwd || isPathWithin(cwd, allowedCwd)
  })
}
