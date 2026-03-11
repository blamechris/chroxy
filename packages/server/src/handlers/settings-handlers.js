/**
 * Model, permission mode, and provider settings handlers.
 *
 * Handles: set_model, set_permission_mode, permission_response,
 *          query_permission_audit, list_providers
 */
import { ALLOWED_MODEL_IDS, toShortModelId } from '../models.js'
import { ALLOWED_PERMISSION_MODE_IDS } from '../handler-utils.js'
import { listProviders } from '../providers.js'

function handleSetModel(ws, client, msg, ctx) {
  if (
    typeof msg.model === 'string' &&
    ALLOWED_MODEL_IDS.has(msg.model)
  ) {
    const modelSessionId = msg.sessionId || client.activeSessionId
    const entry = ctx.sessionManager.getSession(modelSessionId)
    if (entry) {
      console.log(`[ws] Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
      entry.session.setModel(msg.model)
      ctx.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
    }
  } else {
    console.warn(`[ws] Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
  }
}

function handleSetPermissionMode(ws, client, msg, ctx) {
  if (
    typeof msg.mode === 'string' &&
    ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
  ) {
    const permModeSessionId = msg.sessionId || client.activeSessionId
    const entry = ctx.sessionManager.getSession(permModeSessionId)
    if (entry) {
      if (msg.mode === 'plan' && !entry.session.constructor.capabilities?.planMode) {
        ctx.send(ws, { type: 'session_error', message: 'This provider does not support plan mode' })
        return
      }
      if (msg.mode === 'auto' && !msg.confirmed) {
        console.log(`[ws] Auto mode requested by ${client.id}, awaiting confirmation`)
        ctx.send(ws, {
          type: 'confirm_permission_mode',
          mode: 'auto',
          warning: 'Auto mode bypasses all permission checks. Claude will execute tools without asking.',
        })
      } else {
        const previousMode = entry.session.permissionMode || 'unknown'
        if (msg.mode === 'auto') {
          console.log(`[ws] Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()} (was: ${previousMode})`)
        } else {
          console.log(`[ws] Permission mode change from ${client.id} on session ${permModeSessionId}: ${previousMode} → ${msg.mode} at ${new Date().toISOString()}`)
        }
        const prevMode = entry.session._permissionMode || 'approve'
        entry.session.setPermissionMode(msg.mode)
        if (ctx.permissionAudit) {
          ctx.permissionAudit.logModeChange({
            clientId: client.id,
            sessionId: permModeSessionId,
            previousMode: prevMode,
            newMode: msg.mode,
          })
        }
        ctx.broadcastToSession(permModeSessionId, { type: 'permission_mode_changed', mode: msg.mode })
      }
    }
  } else {
    console.warn(`[ws] Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
  }
}

function handlePermissionResponse(ws, client, msg, ctx) {
  const { requestId, decision } = msg
  if (!requestId || !decision) return

  const originSessionId = ctx.permissionSessionMap.get(requestId) || client.activeSessionId
  ctx.permissionSessionMap.delete(requestId)

  let resolved = false

  if (originSessionId && ctx.sessionManager) {
    const entry = ctx.sessionManager.getSession(originSessionId)
    if (entry && typeof entry.session.respondToPermission === 'function') {
      const hasPending = entry.session._pendingPermissions?.has(requestId)
      if (hasPending !== false) {
        entry.session.respondToPermission(requestId, decision)
        resolved = true
      } else {
        ctx.send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
      }
      if (!resolved) return
    }
  }

  if (!resolved && ctx.pendingPermissions.has(requestId)) {
    ctx.permissions.resolvePermission(requestId, decision)
    resolved = true
  }

  if (!resolved) {
    ctx.send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
  }

  // Audit trail for permission decisions
  if (resolved && ctx.permissionAudit) {
    ctx.permissionAudit.logDecision({
      clientId: client.id,
      sessionId: originSessionId,
      requestId,
      decision,
    })
  }

  // Notify all OTHER clients that this permission was resolved so they dismiss their prompts
  if (resolved) {
    ctx.broadcast(
      { type: 'permission_resolved', requestId, decision, sessionId: originSessionId },
      (c) => c.id !== client.id
    )
  }
}

function handleQueryPermissionAudit(ws, client, msg, ctx) {
  if (ctx.permissionAudit) {
    const entries = ctx.permissionAudit.query({
      sessionId: msg.sessionId,
      type: msg.auditType,
      since: msg.since,
      limit: msg.limit,
    })
    ctx.send(ws, { type: 'permission_audit_result', entries })
  } else {
    ctx.send(ws, { type: 'permission_audit_result', entries: [] })
  }
}

function handleListProviders(ws, client, msg, ctx) {
  ctx.send(ws, { type: 'provider_list', providers: listProviders() })
}

export const settingsHandlers = {
  set_model: handleSetModel,
  set_permission_mode: handleSetPermissionMode,
  permission_response: handlePermissionResponse,
  query_permission_audit: handleQueryPermissionAudit,
  list_providers: handleListProviders,
}
