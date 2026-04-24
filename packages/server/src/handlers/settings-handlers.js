/**
 * Model, permission mode, and provider settings handlers.
 *
 * Handles: set_model, set_permission_mode, permission_response,
 *          query_permission_audit, list_providers, set_permission_rules
 */
import { ALLOWED_MODEL_IDS, toShortModelId } from '../models.js'
import { ALLOWED_PERMISSION_MODE_IDS, resolveSession, sendError, buildSessionTokenMismatchPayload } from '../handler-utils.js'
import { listProviders, getProvider } from '../providers.js'
import { createLogger } from '../logger.js'

// Tools that are eligible to be whitelisted via set_permission_rules.
// These are safe file-operation tools that don't execute code or make network requests.
const ELIGIBLE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'])

// Tools that must never be auto-allowed regardless of user rules.
const NEVER_AUTO_ALLOW = new Set(['Bash', 'Task', 'WebFetch', 'WebSearch'])

const log = createLogger('ws')

/**
 * Resolve the allowed model IDs for a specific provider — #2946.
 *
 * Providers opt in to per-provider validation by exposing a static
 * `getAllowedModels()` returning an array of accepted IDs. Providers that
 * don't (claude-sdk/claude-cli/docker-*) fall back to the dynamic global
 * `ALLOWED_MODEL_IDS`, which is fed by the Claude Agent SDK's supported-
 * models list and is the historical source of truth for Claude sessions.
 *
 * Returning `null` means "no per-provider list available — use the global
 * allowlist." Returning an array means the provider has opted in and the
 * array is authoritative.
 *
 * @param {string|undefined} providerName - Session's registered provider name
 * @returns {string[]|null}
 */
function getProviderAllowedModels(providerName) {
  if (!providerName) return null
  let ProviderClass
  try {
    ProviderClass = getProvider(providerName)
  } catch {
    // Unknown provider — can't validate, defer to global list.
    return null
  }
  if (typeof ProviderClass.getAllowedModels !== 'function') return null
  try {
    const list = ProviderClass.getAllowedModels()
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

function handleSetModel(ws, client, msg, ctx) {
  if (typeof msg.model !== 'string') {
    log.warn(`Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
    sendError(ws, msg?.requestId, 'INVALID_MODEL', `Invalid or unsupported model: ${msg.model}`)
    return
  }

  const modelSessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)

  // Per-provider allowlist: the global ALLOWED_MODEL_IDS is Claude-only, so
  // accepting any Claude model ID on a Gemini/Codex session and forwarding
  // it to setModel() would respawn the CLI with an unknown `-m` arg and
  // crash opaquely (see issue #2946). Consult the session's provider first.
  if (entry) {
    const providerAllowed = getProviderAllowedModels(entry.provider)
    if (providerAllowed) {
      if (!providerAllowed.includes(msg.model)) {
        log.warn(`Rejected model '${msg.model}' on ${entry.provider} session ${modelSessionId} from ${client.id}`)
        sendError(
          ws,
          msg?.requestId,
          'MODEL_NOT_SUPPORTED_BY_PROVIDER',
          `Model '${msg.model}' is not supported by the active provider '${entry.provider}'. Supported models: ${providerAllowed.join(', ')}`,
        )
        return
      }
      log.info(`Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
      entry.session.setModel(msg.model)
      // Non-Claude providers use opaque model IDs (e.g. 'gemini-2.5-pro') —
      // broadcast them verbatim. toShortModelId() is a Claude-specific
      // alias collapse (claude-sonnet-4-6 → sonnet) and returns the input
      // unchanged for non-Claude IDs, so applying it uniformly is safe.
      ctx.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
      return
    }
    // Fall through to the legacy global allowlist when the provider hasn't
    // opted in (e.g. claude-sdk, claude-cli, docker-* inherit from it).
  }

  if (ALLOWED_MODEL_IDS.has(msg.model)) {
    if (entry) {
      log.info(`Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
      entry.session.setModel(msg.model)
      ctx.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
    }
    return
  }

  log.warn(`Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
  sendError(ws, msg?.requestId, 'INVALID_MODEL', `Invalid or unsupported model: ${msg.model}`)
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
      // Auto permission mode is the ultimate privilege escalation in
      // the chroxy handler dispatch — it disables all permission
      // checks, so every subsequent tool call auto-executes. The
      // 2026-04-11 audit (Adversary A5) flagged this as a step in
      // the kill chain: an authenticated attacker sends
      // `{mode:'auto', confirmed:true}` and trivially flips the
      // session to unrestricted execution. Pre-audit, the only
      // protection was a `confirmed:true` flag that a malicious
      // client can just send directly — it requires no actual
      // physical user confirmation.
      //
      // Two defense-in-depth gates close the attack:
      //
      // 1. Config opt-in: config.allowAutoPermissionMode must be
      //    explicitly set to true in the operator's config file.
      //    Default is false, so fresh installs reject auto mode
      //    entirely. The operator has to walk up to the dev machine
      //    and edit the config to enable it — out-of-band
      //    confirmation that no network-side flag can provide.
      //
      // 2. Bound-client rejection: clients that authenticated via a
      //    pairing-issued session token (client.boundSessionId set)
      //    are NEVER allowed to flip to auto mode, regardless of
      //    config. Pairing tokens are scoped to a specific session
      //    and should only be able to use existing permissions, not
      //    escalate. Only the primary API token can flip to auto.
      if (msg.mode === 'auto') {
        if (client.boundSessionId) {
          log.warn(`Client ${client.id} (bound to ${client.boundSessionId}) attempted to flip to auto permission mode — rejected`)
          sendError(ws, msg?.requestId, 'AUTO_MODE_FORBIDDEN_BOUND_CLIENT',
            'Pairing-issued session tokens cannot enable auto permission mode. Use the primary API token from a device with physical access to this machine.')
          return
        }
        if (ctx.config?.allowAutoPermissionMode !== true) {
          log.warn(`Client ${client.id} attempted to flip to auto permission mode but allowAutoPermissionMode is not enabled in server config`)
          sendError(ws, msg?.requestId, 'AUTO_MODE_DISABLED_BY_CONFIG',
            'Auto permission mode is disabled on this server. To enable, set allowAutoPermissionMode:true in the server config file (requires local filesystem access). Default is disabled for security.')
          return
        }
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
    sendError(ws, msg?.requestId, 'INVALID_PERMISSION_MODE', `Invalid permission mode: ${msg.mode}`)
  }
}

function handlePermissionResponse(ws, client, msg, ctx) {
  const { requestId, decision } = msg
  if (!requestId || !decision) return

  // Resolve the origin session of this permission request. The
  // authoritative source is permissionSessionMap (populated at request
  // creation). The fallback to client.activeSessionId exists only for
  // legacy code paths where the map wasn't populated; it must NOT be
  // used to bypass the binding check for a bound client, because for a
  // bound client `activeSessionId === boundSessionId`, which would
  // short-circuit the check below.
  const mappedSessionId = ctx.permissionSessionMap.get(requestId)
  const originSessionId = mappedSessionId || client.activeSessionId

  // Enforce session binding: if this client authenticated with a
  // pairing-issued session token that was bound to a specific session,
  // prevent them from approving/denying a permission request belonging
  // to any OTHER session — including legacy pendingPermissions entries
  // that have no mapping.
  //
  // For a BOUND client, the request MUST have an explicit mapping in
  // permissionSessionMap AND that mapping must equal boundSessionId.
  // Without this, agent-review on PR #2806 found a residual bypass:
  // when the requestId was not in the map, originSessionId would fall
  // back to client.activeSessionId, which equals boundSessionId, the
  // check would pass, and execution would fall through to the legacy
  // pendingPermissions resolver — which has no session check at all.
  //
  // Discovered in the 2026-04-11 production readiness audit (blocker 5).
  // The 616aeaf62 / 2c0ac7d2d commits claimed to enforce binding across
  // all session-scoped handlers but missed this one + the HTTP fallback.
  if (client.boundSessionId) {
    if (!mappedSessionId || mappedSessionId !== client.boundSessionId) {
      // Correlate with the [session-binding-create] log at the same
      // requestId to recover the original creating client's bound session
      // and createdAt. Reproduction steps: see issue #2832.
      const permData = (mappedSessionId && ctx.sessionManager)
        ? ctx.sessionManager.getSession(mappedSessionId)?.session?._lastPermissionData?.get(requestId)
        : ctx.pendingPermissions?.get(requestId)?.data
      const createdAt = permData?.createdAt ?? null
      const ageMs = createdAt ? Date.now() - createdAt : null
      const clientConnectedAt = client.authTime ?? null
      const likelyPostReconnect = Boolean(
        (ageMs !== null && ageMs > 30_000) ||
        (createdAt && clientConnectedAt && clientConnectedAt > createdAt)
      )
      log.warn(`[session-binding-reject] permission_response rejected ${JSON.stringify({
        requestId,
        decision,
        clientId: client.id,
        activeSessionId: client.activeSessionId ?? null,
        boundSessionId: client.boundSessionId ?? null,
        mappedSessionId: mappedSessionId ?? null,
        requestCreatedAt: createdAt,
        clientConnectedAt,
        requestAgeMs: ageMs,
        likelyPostReconnect,
      })}`)
      // Don't consume the permissionSessionMap entry — let the legitimate
      // client still respond to it.
      // Issue #2912: payload shape matches every other SESSION_TOKEN_MISMATCH
      // emit site so the client can branch on `code` alone without worrying
      // about which transport surface (type: 'error' vs 'session_error' vs
      // 'web_task_error') produced it.
      ctx.send(ws, {
        type: 'error',
        requestId: requestId ?? null,
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessionManager,
          boundSessionId: client.boundSessionId,
          message: 'Not authorized to respond to this permission request',
        }),
      })
      return
    }
  }

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
