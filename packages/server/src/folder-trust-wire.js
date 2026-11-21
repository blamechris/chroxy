/**
 * Wire shape of a session folder's trust state (`folder_trust_state`).
 *
 * One builder for every emission: when a session becomes ready, when a client
 * subscribes to or switches to it, and after a trust change. The folder always
 * comes from the server's record of the session, never from a client message.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { getFolderTrustState } from './folder-trust.js'

/**
 * When a change reaches a running session of this provider. claude-sdk reads its
 * setting sources on every turn; claude-cli and claude-tui (and the docker
 * variants that run claude) read them at launch. Anything else never runs claude.
 */
const APPLIES_FROM = Object.freeze({
  'claude-sdk': 'next_turn',
  'docker-sdk': 'next_turn',
  'claude-cli': 'restart',
  'claude-tui': 'restart',
  'docker-cli': 'restart',
  docker: 'restart',
})

export function folderTrustAppliesFrom(provider) {
  return APPLIES_FROM[provider] ?? 'n/a'
}

/**
 * @param {string} sessionId
 * @param {{ cwd?: string, provider?: string, session?: { cwd?: string } }} entry - the session manager's record
 * @param {{ cached?: boolean }} [opts] - `cached` reuses a scan up to 2 s old (turn-end emissions)
 * @returns {object|null} the `folder_trust_state` frame, or null without a folder
 */
export function buildFolderTrustStateMessage(sessionId, entry, opts) {
  const cwd = entry?.cwd ?? entry?.session?.cwd
  if (typeof cwd !== 'string' || cwd === '') return null
  const { status, summary } = getFolderTrustState(cwd, opts)
  return {
    type: 'folder_trust_state',
    sessionId,
    status,
    ...(summary ? { summary } : {}),
    appliesFrom: folderTrustAppliesFrom(entry.provider),
  }
}

function realPathOrResolved(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Send the fresh state to every session whose folder has the same real path.
 * @param {{ sessions: { sessionManager: object }, transport: { broadcastToSession: Function } }} ctx
 * @param {string} realPath
 */
export function broadcastFolderTrustState(ctx, realPath) {
  const manager = ctx.sessions?.sessionManager
  for (const listed of manager?.listSessions?.() ?? []) {
    if (typeof listed.cwd !== 'string' || realPathOrResolved(listed.cwd) !== realPath) continue
    const entry = manager.getSession(listed.sessionId)
    const msg = entry ? buildFolderTrustStateMessage(listed.sessionId, entry) : null
    if (msg) ctx.transport.broadcastToSession(listed.sessionId, msg)
  }
}
