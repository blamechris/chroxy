/**
 * Handlers: trust_folder, untrust_folder.
 *
 * Trusting a folder lets its project settings (MCP servers, hooks, status line,
 * agents, skills, commands) run, so it is PRIMARY-ONLY: the primary API token,
 * on a connection that is not bound to a session and carries no agent principal
 * (the bar `add_mcp_server` holds, plus the unbound requirement). Everyone else
 * gets a typed error before the session is looked up.
 *
 * The folder is ALWAYS the cwd in the server's record of `sessionId`. The
 * message carries no path; a `cwd` or `path` field on it is ignored.
 */

import { sendError } from '../handler-utils.js'
import { isBoundClient } from '../environments/authority.js'
import { sessionLogger } from '../logger.js'
import { trustFolder, untrustFolder } from '../folder-trust.js'
import { broadcastFolderTrustState } from '../folder-trust-wire.js'

/** @returns {boolean} true when the caller was refused (the handler must return). */
export function rejectFolderTrustUnlessPrimary(ws, client, msg, ctx, op) {
  if (client?.isPrimaryToken === true && !isBoundClient(client)) return false
  sessionLogger(client?.boundSessionId).warn(
    `Client ${client?.id} attempted ${op} — rejected (folder trust needs the primary token on an unbound connection)`,
  )
  sendError(
    ws,
    msg?.requestId,
    'FOLDER_TRUST_FORBIDDEN',
    'Only the primary API token, on a connection not bound to a session, can change which folders are trusted.',
    undefined,
    ctx,
  )
  return true
}

function makeHandler(op, apply, logVerb) {
  return async function handleFolderTrust(ws, client, msg, ctx) {
    if (rejectFolderTrustUnlessPrimary(ws, client, msg, ctx, op)) return
    const requestId = msg?.requestId
    const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : ''
    const entry = sessionId ? ctx.sessions?.sessionManager?.getSession(sessionId) : null
    const cwd = entry?.cwd ?? entry?.session?.cwd
    if (!entry || typeof cwd !== 'string' || cwd === '') {
      sendError(ws, requestId, 'FOLDER_TRUST_NOT_APPLIED', `${op} needs a known session`, undefined, ctx)
      return
    }
    let result
    try {
      result = await apply(cwd)
    } catch (err) {
      sessionLogger(sessionId).warn(`${op} failed for ${cwd}: ${err?.message || err}`)
      ctx.transport.send(ws, {
        type: 'folder_trust_result',
        sessionId,
        ok: false,
        status: 'untrusted',
        error: 'The trust change could not be saved',
        ...(requestId ? { requestId } : {}),
      })
      return
    }
    if (result.ok) {
      // The path is logged; the summary (commands, args) is not.
      sessionLogger(sessionId).info(`Folder ${result.realPath} ${logVerb} by ${client.id} (session ${sessionId})`)
    }
    ctx.transport.send(ws, {
      type: 'folder_trust_result',
      sessionId,
      ok: result.ok,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(requestId ? { requestId } : {}),
    })
    if (result.realPath) broadcastFolderTrustState(ctx, result.realPath)
  }
}

export const folderTrustHandlers = {
  trust_folder: makeHandler('trust_folder', trustFolder, 'trusted'),
  untrust_folder: makeHandler('untrust_folder', untrustFolder, 'no longer trusted'),
}
