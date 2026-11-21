/**
 * Wire shape of a session folder's trust state (`folder_trust_state`).
 *
 * One builder for every emission: when a session becomes ready, when a client
 * subscribes to or switches to it, and after a trust change. The folder always
 * comes from the server's record of the session, never from a client message.
 */

import { getFolderTrustState, getFolderTrustStateForDisplay, getFolderTrustStateIfCached, resolveRealPath } from './folder-trust.js'

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

function frameFor(sessionId, entry, appliesFrom, state) {
  const { status, summary, digest } = state
  // What the RUNNING process was launched with: claude-cli and claude-tui keep it until restart.
  const launched = appliesFrom === 'restart' ? entry.session?.launchedWithProject : undefined
  return {
    type: 'folder_trust_state',
    sessionId,
    status,
    summary,
    digest,
    appliesFrom,
    ...(typeof launched === 'boolean' ? { launchedWithProject: launched } : {}),
  }
}

const folderOf = (entry) => {
  const cwd = entry?.cwd ?? entry?.session?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * The `folder_trust_state` frame, built from a scan done in this thread (a caller that
 * has just decided something, or that passes a `state` it already computed). A provider
 * that does not run claude gets no frame and no scan.
 * @param {string} sessionId
 * @param {{ cwd?: string, provider?: string, session?: object }} entry - the session manager's record
 * @param {{ cached?: boolean, state?: object }} [opts]
 * @returns {object|null}
 */
export function buildFolderTrustStateMessage(sessionId, entry, opts = {}) {
  const cwd = folderOf(entry)
  if (!cwd) return null
  const appliesFrom = folderTrustAppliesFrom(entry.provider)
  if (appliesFrom === 'n/a') return null
  return frameFor(sessionId, entry, appliesFrom, opts.state ?? getFolderTrustState(cwd, opts))
}

/**
 * The same frame for a synchronous emitter that must not scan: answers only from a
 * fresh cached scan (and starts an off-thread scan to warm the cache), else null.
 */
export function buildFolderTrustStateMessageIfCached(sessionId, entry) {
  const cwd = folderOf(entry)
  if (!cwd) return null
  const appliesFrom = folderTrustAppliesFrom(entry.provider)
  if (appliesFrom === 'n/a') return null
  const state = getFolderTrustStateIfCached(cwd)
  return state ? frameFor(sessionId, entry, appliesFrom, state) : null
}

/**
 * The same frame with the scan done on a worker thread, so building it never blocks
 * the frames clients are waiting for. Used for subscribe / switch.
 */
export async function buildFolderTrustStateMessageForDisplay(sessionId, entry) {
  const cwd = folderOf(entry)
  if (!cwd) return null
  const appliesFrom = folderTrustAppliesFrom(entry.provider)
  if (appliesFrom === 'n/a') return null
  return frameFor(sessionId, entry, appliesFrom, await getFolderTrustStateForDisplay(cwd))
}

/**
 * Send the fresh state to every session whose folder has the same real path. The
 * folder is scanned once (off-thread), not once per session.
 * @param {{ sessions: { sessionManager: object }, transport: { broadcastToSession: Function } }} ctx
 * @param {string} realPath
 */
export async function broadcastFolderTrustState(ctx, realPath) {
  const manager = ctx.sessions?.sessionManager
  let state = null
  for (const listed of manager?.listSessions?.() ?? []) {
    if (typeof listed.cwd !== 'string') continue
    const r = resolveRealPath(listed.cwd)
    if (r.error || r.path !== realPath) continue
    const entry = manager.getSession(listed.sessionId)
    if (!entry) continue
    const appliesFrom = folderTrustAppliesFrom(entry.provider)
    if (appliesFrom === 'n/a') continue
    state ??= await getFolderTrustStateForDisplay(realPath)
    ctx.transport.broadcastToSession(listed.sessionId, frameFor(listed.sessionId, entry, appliesFrom, state))
  }
}
