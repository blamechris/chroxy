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

/** Frames built from a display scan that timed out: not a finding about the folder. */
const timedOutFrames = new WeakSet()

function frameFor(sessionId, entry, appliesFrom, state) {
  const { status, summary, digest } = state
  // What the RUNNING process was launched with: claude-cli and claude-tui keep it until restart.
  const launched = appliesFrom === 'restart' ? entry.session?.launchedWithProject : undefined
  const frame = {
    type: 'folder_trust_state',
    sessionId,
    status,
    summary,
    digest,
    appliesFrom,
    ...(typeof launched === 'boolean' ? { launchedWithProject: launched } : {}),
  }
  if (state.timedOut) timedOutFrames.add(frame)
  return frame
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

/** Whether a session of this record gets a `folder_trust_state` frame at all (it has a folder and runs claude). */
export function folderTrustFrameApplies(entry) {
  return folderOf(entry) !== null && folderTrustAppliesFrom(entry.provider) !== 'n/a'
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
 * Tell the rest of the daemon that a session's folder is not trusted (as of a frame
 * about to be sent), so anything that was running from the folder's own settings can
 * stop showing its output (`folder_trust_lost` on the session manager). Idempotent
 * for its listeners; a failure is never allowed to cost the frame.
 * @param {{ emit?: Function }|null|undefined} sessionManager
 * @param {{ sessionId?: string, status?: string }|null} frame
 */
export function noteFolderTrustFrame(sessionManager, frame) {
  // A frame from a scan that timed out says the folder was not reviewed, not that it lost trust.
  if (!frame || frame.status === 'trusted' || timedOutFrames.has(frame) || typeof frame.sessionId !== 'string') return
  try { sessionManager?.emit?.('folder_trust_lost', { sessionId: frame.sessionId }) } catch { /* display only */ }
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
    const frame = frameFor(listed.sessionId, entry, appliesFrom, state)
    noteFolderTrustFrame(manager, frame)
    ctx.transport.broadcastToSession(listed.sessionId, frame)
  }
}
