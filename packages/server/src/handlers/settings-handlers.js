/**
 * Model, permission mode, and provider settings handlers.
 *
 * Handles: set_model, set_permission_mode, permission_response,
 *          query_permission_audit, list_providers, set_permission_rules
 */
import { ALLOWED_MODEL_IDS, toShortModelId } from '../models.js'
import { ALLOWED_PERMISSION_MODE_IDS, resolveSession } from '../handler-utils.js'
import { listProviders } from '../providers.js'
import { createLogger } from '../logger.js'

// Tools that are eligible to be whitelisted via set_permission_rules.
// These are safe file-operation tools that don't execute code or make network requests.
const ELIGIBLE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'])

// Tools that must never be auto-allowed regardless of user rules.
const NEVER_AUTO_ALLOW = new Set(['Bash', 'Task', 'WebFetch', 'WebSearch'])

const log = createLogger('ws')

function handleSetModel(ws, client, msg, ctx) {
  if (
    typeof msg.model === 'string' &&
    ALLOWED_MODEL_IDS.has(msg.model)
  ) {
    const modelSessionId = msg.sessionId || client.activeSessionId
    const entry = resolveSession(ctx, msg, client)
    if (entry) {
      log.info(`Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
      entry.session.setModel(msg.model)
      ctx.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
    }
  } else {
    log.warn(`Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
  }
}

function handleSetPermissionMode(ws, client, msg, ctx) {
  if (
    typeof msg.mode === 'string' &&
    ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
  ) {
    const permModeSessionId = msg.sessionId || client.activeSessionId
    const entry = resolveSession(ctx, msg, client)
    if (entry) {
      if (msg.mode === 'plan' && !entry.session.constructor.capabilities?.planMode) {
        ctx.send(ws, { type: 'session_error', message: 'This provider does not support plan mode' })
        return
      }
      if (msg.mode === 'auto' && !msg.confirmed) {
        log.info(`Auto mode requested by ${client.id}, awaiting confirmation`)
        ctx.send(ws, {
          type: 'confirm_permission_mode',
          mode: 'auto',
          warning: 'Auto mode bypasses all permission checks. Claude will execute tools without asking.',
        })
      } else {
        const previousMode = entry.session.permissionMode || 'unknown'
        if (msg.mode === 'auto') {
          log.info(`Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()} (was: ${previousMode})`)
        } else {
          log.info(`Permission mode change from ${client.id} on session ${permModeSessionId}: ${previousMode} → ${msg.mode} at ${new Date().toISOString()}`)
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
    log.warn(`Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
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

const VALID_THINKING_LEVELS = new Set(['default', 'high', 'max'])

async function handleSetThinkingLevel(ws, client, msg, ctx) {
  const level = typeof msg.level === 'string' ? msg.level.trim() : ''
  if (!VALID_THINKING_LEVELS.has(level)) {
    ctx.send(ws, { type: 'session_error', message: `Invalid thinking level: ${level}` })
    return
  }

  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    ctx.send(ws, { type: 'session_error', message: 'No active session' })
    return
  }

  if (typeof entry.session.setThinkingLevel !== 'function') {
    ctx.send(ws, { type: 'session_error', message: 'This provider does not support thinking level control' })
    return
  }

  try {
    await entry.session.setThinkingLevel(level)
    ctx.broadcastToSession(sessionId, { type: 'thinking_level_changed', level })
  } catch (err) {
    ctx.send(ws, { type: 'session_error', message: `Failed to set thinking level: ${err.message}` })
  }
}

function handleSetPermissionRules(ws, client, msg, ctx) {
  const rules = msg.rules

  // Validate: must be an array
  if (!Array.isArray(rules)) {
    log.warn(`Rejected invalid permission rules from ${client.id}: not an array`)
    ctx.send(ws, { type: 'session_error', message: 'rules must be an array' })
    return
  }

  // Validate each rule shape and eligibility
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule || typeof rule !== 'object') {
      ctx.send(ws, { type: 'session_error', message: `rules[${i}]: not an object` })
      return
    }
    if (typeof rule.tool !== 'string' || !rule.tool.trim()) {
      ctx.send(ws, { type: 'session_error', message: `rules[${i}]: missing tool name` })
      return
    }
    if (rule.decision !== 'allow' && rule.decision !== 'deny') {
      ctx.send(ws, { type: 'session_error', message: `rules[${i}]: decision must be 'allow' or 'deny'` })
      return
    }
    if (NEVER_AUTO_ALLOW.has(rule.tool)) {
      ctx.send(ws, { type: 'session_error', message: `rules[${i}]: tool '${rule.tool}' cannot be auto-allowed` })
      return
    }
    if (!ELIGIBLE_TOOLS.has(rule.tool)) {
      ctx.send(ws, { type: 'session_error', message: `rules[${i}]: tool '${rule.tool}' is not eligible for permission rules` })
      return
    }
  }

  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    ctx.send(ws, { type: 'session_error', message: 'No active session' })
    return
  }

  if (typeof entry.session.setPermissionRules !== 'function') {
    ctx.send(ws, { type: 'session_error', message: 'This provider does not support permission rules' })
    return
  }

  entry.session.setPermissionRules(rules)

  // Audit the whitelist change
  if (ctx.permissionAudit) {
    ctx.permissionAudit.logWhitelistChange({
      clientId: client.id,
      sessionId,
      rules,
    })
  }

  // Broadcast updated rules to all session clients
  const currentRules = entry.session.getPermissionRules ? entry.session.getPermissionRules() : rules
  ctx.broadcastToSession(sessionId, { type: 'permission_rules_updated', rules: currentRules, sessionId })
  log.info(`Permission rules updated by ${client.id} on session ${sessionId}: ${rules.length} rule(s)`)
}

export const settingsHandlers = {
  set_model: handleSetModel,
  set_permission_mode: handleSetPermissionMode,
  permission_response: handlePermissionResponse,
  query_permission_audit: handleQueryPermissionAudit,
  list_providers: handleListProviders,
  set_thinking_level: handleSetThinkingLevel,
  set_permission_rules: handleSetPermissionRules,
}

export { ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW }
