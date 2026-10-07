/**
 * Daemon-update WS handler (#8331): `daemon_update_action`.
 *
 * The dashboard banner's two buttons. `restart-now` asks the deploy script to
 * apply the waiting update immediately; `postpone` holds it off for an hour.
 *
 * ── Authority ─────────────────────────────────────────────────────────────────
 * Restarting the daemon kills every live session, so this is gated exactly like
 * the other host-level mutations (scheduler writes, #7025): STRICT PRIMARY token
 * AND unbound — `client.isPrimaryToken === true && !client.boundSessionId`. A
 * paired phone holds an unbound pairing token and must not be able to restart
 * the owner's machine. The gate is the FIRST statement: a refusal reads no
 * module, touches no file, and echoes the `requestId` so the client clears its
 * pending state.
 *
 * ── What this handler does NOT decide ─────────────────────────────────────────
 * Whether the daemon is idle is `daemon-idle-state.js`'s verdict (the same
 * function /api/daemon/idle answers from), reached through the DaemonUpdateStatus
 * module. Whether to deploy at all is the script's, which re-checks under its own
 * lock. `force` on the request file is derived on the server from that verdict;
 * the client only says it confirmed (`confirmBusy`).
 */

import { createLogger } from '../logger.js'

const log = createLogger('daemon-update')

function result(ws, ctx, msg, fields) {
  ctx.transport.send(ws, {
    type: 'daemon_update_action_result',
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
    action: typeof msg?.action === 'string' ? msg.action : null,
    ...fields,
  })
}

function handleDaemonUpdateAction(ws, client, msg, ctx) {
  if (client?.isPrimaryToken !== true || client?.boundSessionId) {
    log.warn(`Denied daemon_update_action:${msg?.action} from ${client?.id ?? 'a client'} (NOT_AUTHORIZED)`)
    result(ws, ctx, msg, { ok: false, code: 'NOT_AUTHORIZED', message: 'Updating the daemon requires the primary token.' })
    return
  }
  const updates = ctx.services?.daemonUpdate
  if (!updates) {
    result(ws, ctx, msg, { ok: false, code: 'UNAVAILABLE', message: 'Update status is not available on this server.' })
    return
  }
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null

  if (msg.action === 'restart-now') {
    const out = updates.requestRestart({ target: msg.target, confirmBusy: msg.confirmBusy === true })
    if (out.confirmRequired) {
      ctx.transport.send(ws, {
        type: 'daemon_update_confirm_required',
        requestId,
        // The STORED target (normalised), not whatever the client typed.
        target: out.target,
        reasons: out.reasons,
        sessions: out.sessions,
      })
      return
    }
    if (!out.ok) { result(ws, ctx, msg, out); return }
    log.warn(`Daemon restart requested by client ${client.id} for ${msg.target} (force=${out.force})`)
    result(ws, ctx, msg, { ok: true, force: out.force })
    return
  }

  if (msg.action === 'postpone') {
    const out = updates.postpone({ target: msg.target })
    if (!out.ok) { result(ws, ctx, msg, out); return }
    result(ws, ctx, msg, { ok: true, postponedUntil: out.until })
    return
  }

  result(ws, ctx, msg, { ok: false, code: 'UNSUPPORTED_ACTION', message: `Unsupported action '${String(msg.action).slice(0, 64)}'` })
}

export const daemonUpdateHandlers = {
  daemon_update_action: handleDaemonUpdateAction,
}
