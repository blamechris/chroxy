/**
 * Model, permission mode, and provider settings handlers.
 *
 * Handles: set_model, set_permission_mode, permission_response,
 *          query_permission_audit, list_providers, set_permission_rules
 */
import { ALLOWED_MODEL_IDS, toShortModelId, isClaudeProvider } from '../models.js'
import {
  ALLOWED_PERMISSION_MODE_IDS,
  resolveSession,
  resolveSessionOrError,
  requireSessionMethod,
  sendError,
  sendSessionError,
  buildSessionTokenMismatchPayload,
  isSessionViewer,
} from '../handler-utils.js'
import { listProviders, getProvider } from '../providers.js'
import { isProviderModelUnrestricted } from '../config.js'
import { createLogger, loggerForSession, sessionLogger } from '../logger.js'
// Credential + skills handlers were split into sibling modules (audit P2-4);
// their maps are composed into settingsHandlers below.
import { credentialHandlers } from './credential-handlers.js'
import { skillsHandlers } from './skills-handlers.js'
import {
  PER_SESSION_SETTINGS,
  buildPerSessionSettingHandler,
} from '../per-session-settings.js'
import { createPermissionResolver, resolveOriginSessionId } from '../permission-resolver.js'
import { sanitizeToolInput, PULL_MAX_INPUT_CHARS } from '../redaction.js'
// #6605 — SINGLE source of truth for the rule-eligibility sets. These used to be
// a duplicate hard-coded copy here, which silently drifted from
// permission-manager's when codex's `apply_patch` (rule-eligible, like Write) and
// `shell` (never-auto-allow, like Bash) were added — so set_permission_rules
// validation and PermissionManager's enforcement could disagree. Import the
// exported sets so the two layers can never diverge again.
import { ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../permission-manager.js'

const log = createLogger('ws')

/**
 * Sentinel: the provider opted OUT of static model validation entirely
 * (#5418 — ollama's `getAllowedModels()` returns null because valid models
 * are whatever the local daemon has pulled; a static list would reject
 * them all). Distinct from the legacy "no per-provider list" fallback,
 * which routes to the global Claude allowlist and would wrongly reject
 * every non-Claude id.
 */
const PROVIDER_MODELS_UNRESTRICTED = Symbol('provider-models-unrestricted')

/**
 * Resolve the allowed model IDs for a specific provider — #2946 / #5418.
 *
 * Providers opt in to per-provider validation by exposing a static
 * `getAllowedModels()` returning an array of accepted IDs. Providers that
 * don't have the method at all (docker-* wrappers and any pre-#2946
 * embedder-registered class) fall back to the dynamic global
 * `ALLOWED_MODEL_IDS`, which is fed by the Claude Agent SDK's supported-
 * models list and is the historical source of truth for Claude sessions.
 *
 * Tri-state return:
 *   - `string[]` — provider opted in; the array is authoritative.
 *   - `PROVIDER_MODELS_UNRESTRICTED` — the method exists and returned a
 *     non-array (#5418 ollama): accept any non-empty model id verbatim.
 *   - `null` — no method / unknown provider / method threw: use the
 *     global allowlist (conservative legacy behaviour).
 *
 * @param {string|undefined} providerName - Session's registered provider name
 * @returns {string[]|typeof PROVIDER_MODELS_UNRESTRICTED|null}
 */
function getProviderAllowedModels(providerName, config) {
  if (!providerName) return null
  // #6378: an operator can opt a static-allowlist provider into unrestricted
  // model validation via `config.providers.allowAnyModel` — treat it exactly
  // like ollama (#5418) so an unlisted-but-API-valid id passes through and the
  // upstream API validates, with no release. Checked before the class lookup so
  // it applies regardless of what getAllowedModels() returns.
  if (isProviderModelUnrestricted(config, providerName)) return PROVIDER_MODELS_UNRESTRICTED
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
    if (Array.isArray(list)) return list
    return PROVIDER_MODELS_UNRESTRICTED
  } catch {
    return null
  }
}

function handleSetModel(ws, client, msg, ctx) {
  if (typeof msg.model !== 'string') {
    log.warn(`Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
    sendError(ws, msg?.requestId, 'INVALID_MODEL', `Invalid or unsupported model: ${msg.model}`, undefined, ctx)
    return
  }

  const modelSessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)

  // #5731 (T1): reject set_model on a provider that can't switch models, mirroring
  // the permissionModeSwitch guard in handleSetPermissionMode below. Without this,
  // a provider whose setModel is a no-op (e.g. claude-tui, modelSwitch:false) still
  // updates BaseSession.model and broadcasts `model_changed` while the running
  // session keeps its original model — so every client (incl. the ungated mobile
  // picker) shows a switch that never happened.
  if (entry && entry.provider) {
    let ModelProviderClass
    try {
      ModelProviderClass = getProvider(entry.provider)
    } catch {
      // Unknown provider — allow through (fail open for forward-compat).
    }
    if (ModelProviderClass && ModelProviderClass.capabilities?.modelSwitch === false) {
      ;sessionLogger(modelSessionId).warn(`Rejected set_model on ${entry.provider} session ${modelSessionId} from ${client.id}: provider does not support modelSwitch`)
      sendError(
        ws,
        msg?.requestId,
        'CAPABILITY_NOT_SUPPORTED',
        `The active provider '${entry.provider}' does not support model switching.`,
        undefined,
        ctx,
      )
      return
    }
  }

  // Per-provider allowlist: the global ALLOWED_MODEL_IDS is Claude-only, so
  // accepting any Claude model ID on a Gemini/Codex session and forwarding
  // it to setModel() would respawn the CLI with an unknown `-m` arg and
  // crash opaquely (see issue #2946). Consult the session's provider first.
  if (entry) {
    const providerAllowed = getProviderAllowedModels(entry.provider, ctx.services?.config)
    if (providerAllowed === PROVIDER_MODELS_UNRESTRICTED) {
      // #5418: the provider validates nothing statically (ollama — any
      // locally pulled model id is valid; an unknown id surfaces as the
      // backend's own error on the next message). Pass the id through
      // verbatim after a minimal non-empty guard — without this branch the
      // null fell through to the global Claude allowlist, which rejected
      // every Ollama model and accepted Claude ids that 404 at the local
      // daemon.
      const model = msg.model.trim()
      if (model.length === 0) {
        log.warn(`Rejected empty model id on ${entry.provider} session ${modelSessionId} from ${client.id}`)
        sendError(ws, msg?.requestId, 'INVALID_MODEL', `Invalid or unsupported model: ${msg.model}`, undefined, ctx)
        return
      }
      ;sessionLogger(modelSessionId).info(`Model change from ${client.id} on session ${modelSessionId}: ${model}`)
      // #5696: setModel() returns false when the session is busy (mid-turn) or
      // the model is unchanged (no-op). Mirror the permission-mode guard
      // (#3729) below — only broadcast model_changed when the change actually
      // landed, else clients show a model the session never switched to.
      if (!entry.session.setModel(model)) {
        ;sessionLogger(modelSessionId).warn(`set_model rejected (session busy or no-op): requested ${model}`)
        sendError(ws, msg?.requestId, 'MODEL_NOT_APPLIED', `Model change to '${model}' was not applied (session busy or already on that model).`, undefined, ctx)
        return
      }
      ctx.transport.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(model) })
      return
    }
    if (providerAllowed) {
      if (!providerAllowed.includes(msg.model)) {
        // #4828: session-scoped — modelSessionId identifies the affected
        // session. Legacy single-session adapters may surface an empty
        // sessionId, so fall back to the module-level `log` rather than
        // throwing inside loggerForSession (matches the input-handlers
        // pattern from #4823).
        ;sessionLogger(modelSessionId).warn(`Rejected model '${msg.model}' on ${entry.provider} session ${modelSessionId} from ${client.id}`)
        sendError(
          ws,
          msg?.requestId,
          'MODEL_NOT_SUPPORTED_BY_PROVIDER',
          `Model '${msg.model}' is not supported by the active provider '${entry.provider}'. Supported models: ${providerAllowed.join(', ')}`,
          undefined,
          ctx,
        )
        return
      }
      // #4828: session-scoped (single-session fallback as above).
      ;sessionLogger(modelSessionId).info(`Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
      // #5696: only broadcast when setModel() reports the change landed.
      if (!entry.session.setModel(msg.model)) {
        ;sessionLogger(modelSessionId).warn(`set_model rejected (session busy or no-op): requested ${msg.model}`)
        sendError(ws, msg?.requestId, 'MODEL_NOT_APPLIED', `Model change to '${msg.model}' was not applied (session busy or already on that model).`, undefined, ctx)
        return
      }
      // Non-Claude providers use opaque model IDs (e.g. 'gemini-2.5-pro') —
      // broadcast them verbatim. toShortModelId() is a Claude-specific
      // alias collapse (claude-sonnet-4-6 → sonnet) and returns the input
      // unchanged for non-Claude IDs, so applying it uniformly is safe.
      ctx.transport.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
      return
    }
    // Fall through to the legacy global allowlist when the provider hasn't
    // opted in (e.g. claude-sdk, claude-cli, docker-* inherit from it).
  }

  // #6201 (OCP) — the global ALLOWED_MODEL_IDS below is the Claude-only,
  // SDK-fed allowlist. A KNOWN non-Claude provider reaches this fallthrough
  // only when it declares no static getAllowedModels() (getProviderAllowedModels
  // returned null above); letting it through would silently validate its model
  // ids against Claude's allowlist — an open-for-extension gap a newly-added
  // provider could trip purely by existing. Reject such a provider with a clear
  // error instead. Claude-family providers (claudeFamily === true) and legacy
  // single-session (entry === null) fall through unchanged; an UNKNOWN provider
  // fails open, mirroring the modelSwitch capability guard above. No current
  // provider hits this branch — every shipped non-Claude provider has
  // getAllowedModels() (so it's handled above) and user-shell is modelSwitch:false
  // (rejected earlier) — so this is a pure forward-compat guard.
  if (entry && entry.provider) {
    let ResolvedProviderClass = null
    try {
      ResolvedProviderClass = getProvider(entry.provider)
    } catch {
      // Unknown provider — can't classify; fail open to the legacy behaviour.
    }
    if (ResolvedProviderClass && !isClaudeProvider(entry.provider, ResolvedProviderClass)) {
      ;sessionLogger(modelSessionId).warn(`Rejected set_model '${msg.model}' on ${entry.provider} session ${modelSessionId} from ${client.id}: provider declares no model allowlist and is not Claude-family`)
      sendError(
        ws,
        msg?.requestId,
        'MODEL_NOT_SUPPORTED_BY_PROVIDER',
        `The active provider '${entry.provider}' does not declare a model allowlist; cannot validate model '${msg.model}'.`,
        undefined,
        ctx,
      )
      return
    }
  }

  if (ALLOWED_MODEL_IDS.has(msg.model)) {
    if (entry) {
      // #4828: session-scoped (single-session fallback).
      ;sessionLogger(modelSessionId).info(`Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
      // #5696: only broadcast when setModel() reports the change landed.
      if (!entry.session.setModel(msg.model)) {
        ;sessionLogger(modelSessionId).warn(`set_model rejected (session busy or no-op): requested ${msg.model}`)
        sendError(ws, msg?.requestId, 'MODEL_NOT_APPLIED', `Model change to '${msg.model}' was not applied (session busy or already on that model).`, undefined, ctx)
        return
      }
      ctx.transport.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
    }
    return
  }

  log.warn(`Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
  sendError(ws, msg?.requestId, 'INVALID_MODEL', `Invalid or unsupported model: ${msg.model}`, undefined, ctx)
}

function handleSetPermissionMode(ws, client, msg, ctx) {
  if (
    typeof msg.mode === 'string' &&
    ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
  ) {
    const permModeSessionId = msg.sessionId || client.activeSessionId
    const entry = resolveSession(ctx, msg, client)
    if (entry) {
      // #2963 — capability gate: providers that don't support permission mode
      // (Gemini, Codex) must be rejected here rather than silently accepting
      // the change, which would let the UI show visual confirmation of a mode
      // that has no effect on the session.
      if (entry.provider) {
        let ProviderClass
        try {
          ProviderClass = getProvider(entry.provider)
        } catch {
          // Unknown provider — allow through (fail open for forward-compat).
        }
        if (ProviderClass && ProviderClass.capabilities?.permissionModeSwitch === false) {
          // #4828: session-scoped (single-session fallback).
          ;sessionLogger(permModeSessionId).warn(`Rejected set_permission_mode on ${entry.provider} session ${permModeSessionId} from ${client.id}: provider does not support permissionModeSwitch`)
          sendError(
            ws,
            msg?.requestId,
            'CAPABILITY_NOT_SUPPORTED',
            `The active provider '${entry.provider}' does not support permission mode switching.`,
            undefined,
            ctx,
          )
          return
        }
      }

      if (msg.mode === 'plan' && !entry.session.constructor.capabilities?.planMode) {
        sendSessionError(ws, ctx, 'This provider does not support plan mode')
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
          // #4828: session-scoped to the bound session — that's the
          // session the rejection belongs to.
          loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} (bound to ${client.boundSessionId}) attempted to flip to auto permission mode — rejected`)
          sendError(ws, msg?.requestId, 'AUTO_MODE_FORBIDDEN_BOUND_CLIENT',
            'Pairing-issued session tokens cannot enable auto permission mode. Use the primary API token from a device with physical access to this machine.',
            undefined, ctx)
          return
        }
        if (ctx.services.config?.allowAutoPermissionMode !== true) {
          // #4828: session-scoped (single-session fallback).
          ;sessionLogger(permModeSessionId).warn(`Client ${client.id} attempted to flip to auto permission mode but allowAutoPermissionMode is not enabled in server config`)
          sendError(ws, msg?.requestId, 'AUTO_MODE_DISABLED_BY_CONFIG',
            'Auto permission mode is disabled on this server. To enable, set allowAutoPermissionMode:true in the server config file (requires local filesystem access). Default is disabled for security.',
            undefined, ctx)
          return
        }
      }
      if (msg.mode === 'auto' && !msg.confirmed) {
        // #4828: session-scoped (single-session fallback).
        ;sessionLogger(permModeSessionId).info(`Auto mode requested by ${client.id}, awaiting confirmation`)
        // #5609: on providers where the auto-switch is destructive (CLI —
        // _onPermissionModeChanged respawns the `claude -p` subprocess, the
        // #3729 panic-button) AND a turn is currently in flight, name the
        // consequence so the user isn't surprised by a dropped response. SDK
        // and TUI apply the switch in-place and keep the turn running, so they
        // keep the plain warning. The warning string is rendered verbatim by
        // the mobile app's confirm Alert (SettingsBar.tsx).
        const interruptsTurn = !!entry.session.constructor.capabilities?.interruptsTurnOnAutoSwitch
        const warning = interruptsTurn && entry.session._isBusy
          ? 'This session is mid-response. Switching to Auto will INTERRUPT the running turn and restart the session — the in-flight response will be dropped. Tools will then run without asking for permission.'
          : 'Auto mode bypasses all permission checks. Claude will execute tools without asking.'
        ctx.transport.send(ws, {
          type: 'confirm_permission_mode',
          mode: 'auto',
          warning,
        })
      } else {
        const previousMode = entry.session.permissionMode || 'unknown'
        // #4828: session-scoped (single-session fallback).
        const _pmLog = sessionLogger(permModeSessionId)
        if (msg.mode === 'auto') {
          _pmLog.info(`Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()} (was: ${previousMode})`)
        } else {
          _pmLog.info(`Permission mode change from ${client.id} on session ${permModeSessionId}: ${previousMode} → ${msg.mode} at ${new Date().toISOString()}`)
        }
        // BaseSession exposes the mode on the public `permissionMode` field.
        // The earlier `_permissionMode` read was a typo that always resolved
        // to `undefined`, so the audit log silently fell back to 'approve'
        // regardless of the real previous mode (Copilot review on PR #3730).
        // Reuse `previousMode` from above (line 203) — same source of truth.
        entry.session.setPermissionMode(msg.mode)
        // #3729: setPermissionMode silently rejects mid-turn changes (and
        // same-mode no-ops). Use the post-call value as ground truth — if
        // the session is still on the previous mode, the call was rejected
        // and we must not broadcast a misleading `permission_mode_changed`.
        // Pre-fix the dashboard's optimistic update + this unconditional
        // broadcast both confirmed an "auto" switch that never landed,
        // leaving the user staring at fresh prompts in supposed bypass mode.
        const actualMode = entry.session.permissionMode
        if (actualMode !== msg.mode) {
          // #4828: session-scoped (single-session fallback).
          ;sessionLogger(permModeSessionId).warn(`set_permission_mode rejected (session busy or no-op): requested ${msg.mode}, still ${actualMode}`)
          sendError(ws, msg?.requestId, 'PERMISSION_MODE_NOT_APPLIED',
            `Permission mode change to '${msg.mode}' was not applied (session busy or already in that mode).`,
            undefined, ctx)
          return
        }
        if (ctx.permissions.permissionAudit) {
          ctx.permissions.permissionAudit.logModeChange({
            clientId: client.id,
            sessionId: permModeSessionId,
            previousMode,
            newMode: msg.mode,
          })
        }
        ctx.transport.broadcastToSession(permModeSessionId, { type: 'permission_mode_changed', mode: msg.mode })
      }
    }
  } else {
    log.warn(`Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
    sendError(ws, msg?.requestId, 'INVALID_PERMISSION_MODE', `Invalid permission mode: ${msg.mode}`, undefined, ctx)
  }
}

function handlePermissionResponse(ws, client, msg, ctx) {
  const { requestId, decision } = msg
  if (!requestId || !decision) return

  // #5373: the binding check + SDK-vs-legacy dispatch + audit are delegated to
  // the shared permission-resolver (also used by the HTTP handler in
  // ws-permissions.js), so the binding rule lives in ONE place. Two things stay
  // HERE because they have no HTTP analog / are transport-specific:
  //   - the WS-ONLY unbound-subscription guard (#4798, invariant G), which runs
  //     BEFORE the resolver, and
  //   - the elaborate binding-mismatch forensic log (#2832) + the per-transport
  //     error / permission_expired / permission_resolved messages.
  //
  // `mappedSessionId` is the raw mapping; `originSessionId` adds the WS-only
  // legacy `client.activeSessionId` fallback. That fallback is passed to the
  // resolver as `dispatchFallbackSessionId` (used ONLY to pick the dispatch
  // session, NEVER for the binding check — invariant B / the #2806 residual).
  // #6030: computed via resolveOriginSessionId (the SAME helper the resolver
  // uses), so the session this handler authorizes against is byte-identical to
  // the one the resolver dispatches to — closing the prior `||` (here) vs `??`
  // (resolver) split that disagreed on empty-string / 0-ish mapped ids.
  const mappedSessionId = ctx.permissions.permissionSessionMap.get(requestId)
  const originSessionId = resolveOriginSessionId(mappedSessionId, client.activeSessionId)

  // #4798 (audit P0 symmetry with #4788): for UNBOUND clients, require the
  // originSessionId to match the client's active or subscribed sessions before
  // routing the decision. Without this, an unbound dashboard tab could
  // approve/deny a permission for any session by replaying a known requestId —
  // arguably MORE dangerous than the question hijack vector (#4788) because
  // permission decisions gate file writes / shell exec. Routes through
  // isSessionViewer (#6030) — the SAME predicate _broadcastToSession uses to pick
  // recipients (ws-broadcaster.js _matchesSession) — so "who may answer == who
  // could receive" can never drift. Leaves the mapping intact so the legitimate
  // subscribed client can still respond. WS-ONLY by design: a primary HTTP caller
  // has full session authority (§3), so the HTTP path has no analog and must not
  // inherit this restriction.
  if (!client.boundSessionId && originSessionId) {
    if (!isSessionViewer(client, originSessionId)) {
      sessionLogger(originSessionId).warn(`[permission-response-reject] unbound client ${client.id} attempted to respond to ${requestId} (originSessionId=${originSessionId}, activeSessionId=${client.activeSessionId ?? 'none'}, subscribed=false) — dropped`)
      return
    }
  }

  const resolver = createPermissionResolver({
    permissionSessionMap: ctx.permissions.permissionSessionMap,
    pendingPermissions: ctx.permissions.pendingPermissions,
    getSessionManager: () => ctx.sessions.sessionManager,
    resolveLegacyPermission: (rid, dec) => ctx.permissions.permissions.resolvePermission(rid, dec),
    getPermissionAudit: () => ctx.permissions.permissionAudit,
    // #5704: route the map delete through the WsServer teardown so resolving a
    // permission over WS also drops its permission-induced subscription refcount.
    onRouteTeardown: ctx.permissions.unregisterPermissionRoute,
  })
  const result = resolver.resolve(requestId, decision, client.boundSessionId, {
    clientId: client.id,
    dispatchFallbackSessionId: client.activeSessionId,
    // #6543 (feature B): the operator's per-hunk edits for an approve. The server
    // whitelists which fields may be substituted (permission-manager.js
    // mergeEditedInput) — a client can narrow the content but not redirect the
    // path. Only present when the client reviewed + edited the proposed write.
    editedInput: msg.editedInput,
  })

  if (result.kind === 'binding_mismatch') {
    // Correlate with the [session-binding-create] log at the same requestId to
    // recover the original creating client's bound session + createdAt (#2832).
    const permData = (mappedSessionId && ctx.sessions.sessionManager)
      ? ctx.sessions.sessionManager.getSession(mappedSessionId)?.session?._lastPermissionData?.get(requestId)
      : ctx.permissions.pendingPermissions?.get(requestId)?.data
    const createdAt = permData?.createdAt ?? null
    const ageMs = createdAt ? Date.now() - createdAt : null
    const clientConnectedAt = client.authTime ?? null
    const likelyPostReconnect = Boolean(
      (ageMs !== null && ageMs > 30_000) ||
      (createdAt && clientConnectedAt && clientConnectedAt > createdAt)
    )
    // #4828: session-scoped to the bound session — the reject belongs to the
    // OWNER of `boundSessionId`, not the mismatched mapped session.
    loggerForSession('ws', result.boundSessionId).warn(`[session-binding-reject] permission_response rejected ${JSON.stringify({
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
    // The resolver does NOT consume the map entry on a mismatch — the
    // legitimate client can still respond. Issue #2912: payload shape matches
    // every other SESSION_TOKEN_MISMATCH emit site.
    ctx.transport.send(ws, {
      type: 'error',
      requestId: requestId ?? null,
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: result.boundSessionId,
        message: 'Not authorized to respond to this permission request',
      }),
    })
    return
  }

  if (result.kind === 'expired' || result.kind === 'not_found') {
    ctx.transport.send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
    return
  }

  // result.kind === 'resolved' — the resolver dispatched (sdk|legacy) + audited.
  // #3048: SDK-session broadcasts go through the unified pipeline
  // (PermissionManager → SdkSession → SessionManager → EventNormalizer →
  // broadcast). Legacy non-SDK sessions (no PermissionManager) keep an inline
  // broadcast for the unmapped case only — mirrors the prior `!originSessionId`.
  if (!result.sessionId) {
    // #6590: broadcast to ALL clients INCLUDING the resolver (no `c.id !==
    // client.id` exclusion). The resolving client needs its own
    // `permission_resolved` to prune `permissionInputs[requestId]` (#6559) —
    // append-only otherwise, so on this legacy path the entry used to linger
    // until disconnect. Echoing to the resolver is SAFE to re-apply: the
    // `permissionInputs` prune is a guarded copy-delete, the notification
    // read-stamp only touches not-yet-acked rows, and re-marking the
    // already-answered prompt is functionally inert (its label reads from
    // `resolvedPermissions`, and the pending-count only checks that `answered`
    // is truthy — only `answeredAt` is refreshed to the server-confirmed time).
    // This also matches the SDK path, which broadcasts session events to every
    // subscriber without excluding the origin client.
    ctx.transport.broadcast({ type: 'permission_resolved', requestId, decision })
  }

  // #6771 — an `allowAlways` that resolved on an in-process session just
  // persisted a durable project rule (permission-manager.js). Broadcast the
  // updated rule sets so every client's rules surface (mobile SessionRules,
  // etc.) reflects the new standing grant without a reconnect. The manager
  // updated its in-memory persistent set synchronously during respondToPermission,
  // so getPersistentPermissionRules() already includes it.
  if (decision === 'allowAlways' && result.sessionId) {
    const rulesEntry = ctx.sessions.sessionManager?.getSession?.(result.sessionId)
    const rulesSession = rulesEntry?.session
    if (rulesSession && typeof rulesSession.getPersistentPermissionRules === 'function') {
      ctx.transport.broadcastToSession(result.sessionId, {
        type: 'permission_rules_updated',
        sessionId: result.sessionId,
        rules: typeof rulesSession.getPermissionRules === 'function' ? rulesSession.getPermissionRules() : [],
        persistentRules: rulesSession.getPersistentPermissionRules(),
      })
    }
  }
}

function handleQueryPermissionAudit(ws, client, msg, ctx) {
  // #6837 — same authority principle as the adjacent handleGetPermissionInput: a
  // pairing-bound (share-a-session) token is scoped to ITS OWN session. Without
  // this gate a bound client could read another session's decision history, or
  // omit sessionId entirely and pull the GLOBAL cross-session audit log. Bound
  // clients must name their own boundSessionId explicitly; the global query is
  // host-authority (unbound / primary token) only.
  if (client.boundSessionId && msg.sessionId !== client.boundSessionId) {
    loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} (bound to ${client.boundSessionId}) attempted to query permission audit for ${msg.sessionId || 'ALL sessions'} — rejected`)
    sendError(ws, msg?.requestId, 'PERMISSION_AUDIT_FORBIDDEN_BOUND_CLIENT',
      "Pairing-issued session tokens can only query their own session's permission audit.",
      undefined, ctx)
    return
  }

  if (ctx.permissions.permissionAudit) {
    const entries = ctx.permissions.permissionAudit.query({
      sessionId: msg.sessionId,
      type: msg.auditType,
      since: msg.since,
      limit: msg.limit,
    })
    ctx.transport.send(ws, { type: 'permission_audit_result', entries })
  } else {
    ctx.transport.send(ws, { type: 'permission_audit_result', entries: [] })
  }
}

function handleListProviders(ws, client, msg, ctx) {
  ctx.transport.send(ws, { type: 'provider_list', providers: listProviders() })
}

const VALID_THINKING_LEVELS = new Set(['default', 'high', 'max'])

async function handleSetThinkingLevel(ws, client, msg, ctx) {
  // #5731 T9: every rejection path echoes the client's requestId with a single
  // THINKING_LEVEL_NOT_APPLIED code so the dashboard rolls back its optimistic
  // dropdown update (mirrors set_model's MODEL_NOT_APPLIED and
  // set_permission_mode's PERMISSION_MODE_NOT_APPLIED). The capability check is
  // inlined (rather than routed through requireSessionMethod) so the
  // unsupported-provider rejection carries the requestId + code too — otherwise
  // a no-op on a provider without thinking-level control would leave the
  // dropdown stuck on a level the session never entered. requestId is optional
  // (older clients omit it); sendError tolerates null.
  const requestId = msg?.requestId
  const level = typeof msg.level === 'string' ? msg.level.trim() : ''
  if (!VALID_THINKING_LEVELS.has(level)) {
    sendError(ws, requestId, 'THINKING_LEVEL_NOT_APPLIED', `Invalid thinking level: ${level}`, undefined, ctx)
    return
  }

  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    sendError(ws, requestId, 'THINKING_LEVEL_NOT_APPLIED', 'No active session', undefined, ctx)
    return
  }

  if (!entry.session || typeof entry.session.setThinkingLevel !== 'function') {
    sendError(ws, requestId, 'THINKING_LEVEL_NOT_APPLIED', 'This provider does not support thinking level control', undefined, ctx)
    return
  }

  try {
    await entry.session.setThinkingLevel(level)
    ctx.transport.broadcastToSession(sessionId, { type: 'thinking_level_changed', level })
  } catch (err) {
    sendError(ws, requestId, 'THINKING_LEVEL_NOT_APPLIED', `Failed to set thinking level: ${err.message}`, undefined, ctx)
  }
}

/**
 * #3639 — set the per-session promptEvaluatorSkipPattern. Mirrors the
 * #3185 toggle handler: strict-typed payload validation, idempotent on
 * unchanged input, broadcast on actual change, immediate persist (rather
 * than the debounced schedulePersist) because pattern updates are operator
 * actions and the synchronous flush prevents a crash inside the debounce
 * window from silently losing the change.
 *
 * Empty string and `null` both clear the override — at that point
 * `shouldSkipEvaluator` falls through to the server-wide
 * `config.promptEvaluatorSkipPattern` (#3187) and the default skip rules.
 *
 * Validation: BaseSession.setPromptEvaluatorSkipPattern returns false for
 * invalid regex sources. We surface that as a session_error with a clear
 * message so the operator sees what was wrong instead of the change
 * silently being dropped.
 */
function handleSetPromptEvaluatorSkipPattern(ws, client, msg, ctx) {
  // Accept string or null. Anything else is a malformed payload.
  if (msg.value !== null && typeof msg.value !== 'string') {
    sendSessionError(ws, ctx, 'set_prompt_evaluator_skip_pattern requires a string `value` (or null/empty to clear)')
    return
  }

  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSessionOrError(ws, ctx, msg, client)
  if (!entry) return

  if (!requireSessionMethod(ws, ctx, entry, 'setPromptEvaluatorSkipPattern', 'This provider does not support promptEvaluatorSkipPattern')) {
    // Defensive — mirrors the parallel path in handleSetPromptEvaluator.
    return
  }

  // Pre-validate non-empty strings here so we can distinguish a valid no-op
  // (setter returns false because value matches current) from a rejected
  // malformed regex (setter also returns false). Without this distinction
  // the operator gets no feedback when their pattern is broken.
  if (typeof msg.value === 'string' && msg.value.length > 0) {
    try {
      new RegExp(msg.value, 'i')
    } catch (err) {
      sendSessionError(ws, ctx, `Invalid pattern: ${err.message || 'malformed regex'}`)
      return
    }
  }

  const changed = entry.session.setPromptEvaluatorSkipPattern(msg.value)
  if (!changed) {
    // No-op (value already matches current) — no broadcast, no persist.
    return
  }

  // The setter normalises empty string → null. Surface the stored value
  // (not the raw payload) so subscribed clients see a stable shape.
  const storedValue = entry.session.promptEvaluatorSkipPattern
  ctx.transport.broadcastToSession(sessionId, {
    type: 'prompt_evaluator_skip_pattern_changed',
    sessionId,
    value: storedValue,
  })

  // Immediate persist — same justification as handleSetPromptEvaluator:
  // pattern updates are rare operator actions and the sync flush avoids
  // losing the change to a crash inside the debounce window.
  try {
    ctx.sessions.sessionManager?.serializeState?.()
  } catch (err) {
    // #4828: session-scoped.
    loggerForSession('ws', sessionId).warn(`Failed to persist promptEvaluatorSkipPattern for ${sessionId}: ${err?.message || err}`)
  }
}

function handleSetPermissionRules(ws, client, msg, ctx) {
  // Bound (pairing-issued) session tokens are scoped to USE existing
  // permissions, never to escalate — the same principle that blocks them from
  // flipping to auto mode in handleSetPermissionMode. Permission rules can
  // auto-allow execution-capable tools (Write, Edit, …), so letting a bound
  // (share-a-session) client set them is exactly that escalation. The gate is
  // host-authority = an UNBOUND client (no boundSessionId — the primary token,
  // or an unbound linking-mode pairing token), mirroring rejectCredentialWriteIfBound.
  if (client.boundSessionId) {
    loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} (bound to ${client.boundSessionId}) attempted to set permission rules — rejected`)
    sendError(ws, msg?.requestId, 'PERMISSION_RULES_FORBIDDEN_BOUND_CLIENT',
      'Pairing-issued session tokens cannot modify permission rules. Use the primary API token from a device with physical access to this machine.',
      undefined, ctx)
    return
  }

  const rules = msg.rules

  // Validate: must be an array
  if (!Array.isArray(rules)) {
    log.warn(`Rejected invalid permission rules from ${client.id}: not an array`)
    sendSessionError(ws, ctx, 'rules must be an array')
    return
  }

  // Validate each rule shape and eligibility
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule || typeof rule !== 'object') {
      sendSessionError(ws, ctx, `rules[${i}]: not an object`)
      return
    }
    if (typeof rule.tool !== 'string' || !rule.tool.trim()) {
      sendSessionError(ws, ctx, `rules[${i}]: missing tool name`)
      return
    }
    if (rule.decision !== 'allow' && rule.decision !== 'deny') {
      sendSessionError(ws, ctx, `rules[${i}]: decision must be 'allow' or 'deny'`)
      return
    }
    if (NEVER_AUTO_ALLOW.has(rule.tool)) {
      sendSessionError(ws, ctx, `rules[${i}]: tool '${rule.tool}' cannot be auto-allowed`)
      return
    }
    if (!ELIGIBLE_TOOLS.has(rule.tool)) {
      sendSessionError(ws, ctx, `rules[${i}]: tool '${rule.tool}' is not eligible for permission rules`)
      return
    }
    // #6803 — optional path/glob scope: a non-empty string when present.
    if (rule.path !== undefined && (typeof rule.path !== 'string' || !rule.path.trim())) {
      sendSessionError(ws, ctx, `rules[${i}]: path scope must be a non-empty string`)
      return
    }
  }

  // #6771 — optional durable (project-scoped) rule set. When present, it FULLY
  // REPLACES the persisted rules for this session's project cwd — the client
  // "manage / remove persistent rule" path (send the reduced list to drop one).
  // Validated with the same eligibility floor as session rules.
  const projectRules = msg.projectRules
  if (projectRules !== undefined) {
    if (!Array.isArray(projectRules)) {
      sendSessionError(ws, ctx, 'projectRules must be an array')
      return
    }
    for (let i = 0; i < projectRules.length; i++) {
      const rule = projectRules[i]
      if (!rule || typeof rule !== 'object') {
        sendSessionError(ws, ctx, `projectRules[${i}]: not an object`)
        return
      }
      if (typeof rule.tool !== 'string' || !rule.tool.trim()) {
        sendSessionError(ws, ctx, `projectRules[${i}]: missing tool name`)
        return
      }
      if (rule.decision !== 'allow' && rule.decision !== 'deny') {
        sendSessionError(ws, ctx, `projectRules[${i}]: decision must be 'allow' or 'deny'`)
        return
      }
      if (rule.decision === 'allow' && NEVER_AUTO_ALLOW.has(rule.tool)) {
        sendSessionError(ws, ctx, `projectRules[${i}]: tool '${rule.tool}' cannot be auto-allowed`)
        return
      }
      if (rule.decision === 'allow' && !ELIGIBLE_TOOLS.has(rule.tool)) {
        sendSessionError(ws, ctx, `projectRules[${i}]: tool '${rule.tool}' is not eligible for permission rules`)
        return
      }
      // #6803 — optional path/glob scope: a non-empty string when present.
      if (rule.path !== undefined && (typeof rule.path !== 'string' || !rule.path.trim())) {
        sendSessionError(ws, ctx, `projectRules[${i}]: path scope must be a non-empty string`)
        return
      }
    }
  }

  const sessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSessionOrError(ws, ctx, msg, client)
  if (!entry) return

  // #6829 — the two halves have DIFFERENT capability gates. Session rules need
  // the session-rule setter (`setPermissionRules` — absent on codex by design,
  // so it keeps advertising sessionRules:false). Durable project rules need only
  // the persistent re-seed setter (`setPersistentPermissionRules` — which codex
  // HAS since #6829). Gating the whole handler on `setPermissionRules` made the
  // projectRules remove/clear path dead on codex: durable rules could be CREATED
  // (allowAlways resolves inside the PermissionManager, no handler involved) but
  // never removed from any client.
  const supportsSessionRules = typeof entry.session?.setPermissionRules === 'function'

  if (projectRules === undefined) {
    // Session-rules-only request — unchanged legacy gate: providers without the
    // session-rule setter (codex, cli, tui, gemini) are rejected.
    if (!requireSessionMethod(ws, ctx, entry, 'setPermissionRules', 'This provider does not support permission rules')) {
      return
    }
  } else {
    // projectRules present — the durable half needs the persistent setter (all
    // in-process-permission providers: sdk / byok / codex). Providers with no
    // PermissionManager at all stay rejected, as before.
    if (!requireSessionMethod(ws, ctx, entry, 'setPersistentPermissionRules', 'This provider does not support persistent permission rules')) {
      return
    }
    // A NON-EMPTY session-rule set aimed at a provider without the session-rule
    // setter must fail loudly, not be silently dropped. The rules:[] echo the
    // clients send alongside a project-rule removal is a no-op and passes.
    if (!supportsSessionRules && rules.length > 0) {
      sendSessionError(ws, ctx, 'This provider does not support session permission rules')
      return
    }
  }

  if (supportsSessionRules) {
    entry.session.setPermissionRules(rules)
  }

  // #6771 — apply the durable project-rule replacement (if any) to the store,
  // then re-seed THIS session's in-memory persistent set so it takes effect
  // immediately. The store is keyed by the session's cwd. (The persistent-setter
  // gate above already guaranteed the method exists on this path.)
  const ruleStore = ctx.sessions.sessionManager?.permissionRuleStore
  if (projectRules !== undefined && ruleStore && typeof ruleStore.setRules === 'function') {
    const stored = ruleStore.setRules(entry.session.cwd, projectRules)
    entry.session.setPersistentPermissionRules(stored)
  }

  // Audit the whitelist change
  if (ctx.permissions.permissionAudit) {
    ctx.permissions.permissionAudit.logWhitelistChange({
      clientId: client.id,
      sessionId,
      rules,
    })
  }

  // Broadcast updated rules to all session clients. #6771 — include the durable
  // persistentRules so the rules surfaces show session AND project grants.
  const currentRules = entry.session.getPermissionRules ? entry.session.getPermissionRules() : rules
  const persistentRules = typeof entry.session.getPersistentPermissionRules === 'function'
    ? entry.session.getPersistentPermissionRules()
    : []
  ctx.transport.broadcastToSession(sessionId, { type: 'permission_rules_updated', rules: currentRules, persistentRules, sessionId })
  // #4828: session-scoped.
  loggerForSession('ws', sessionId).info(`Permission rules updated by ${client.id} on session ${sessionId}: ${rules.length} session rule(s)${projectRules !== undefined ? `, ${projectRules.length} project rule(s)` : ''}`)
}

/**
 * #6824 — enable/disable an already-configured MCP server for the active
 * session (runtime toggle, not add/remove). Only the BYOK lane runs an
 * in-daemon MCP fleet that can be parked/unparked, so this rejects other
 * providers with a capability error the client uses to keep its toggle hidden.
 *
 * AUTH: routed through `resolveSession`, which enforces session-token
 * binding — a pairing-bound client may only act on ITS OWN session; a bound
 * token naming a different session resolves to no entry and is rejected. This
 * is the own-session gate, not the host-authority (unbound-only) gate that
 * `set_permission_rules` uses: enabling a server can never ADD an untrusted
 * one (the fleet re-runs the trust gate on unpark) and disabling only REDUCES
 * capability, so neither direction is the privilege escalation that rule-
 * setting is. Every rejection — validation, session resolution, capability,
 * unknown server — echoes `requestId` (when supplied) with a stable code
 * (MCP_SERVER_NOT_APPLIED / MCP_SERVER_TOGGLE_UNSUPPORTED /
 * MCP_SERVER_NOT_FOUND), the same echo discipline as the set_model /
 * set_permission_mode / set_thinking_level NOT_APPLIED family.
 *
 * On success the session re-emits `mcp_servers` (broadcast to every subscriber
 * → multi-device consistency), so this handler does not send its own ack — the
 * updated list IS the confirmation.
 */
async function handleSetMcpServerEnabled(ws, client, msg, ctx) {
  const requestId = msg?.requestId
  const server = typeof msg?.server === 'string' ? msg.server.trim() : ''
  if (!server) {
    sendError(ws, requestId, 'MCP_SERVER_NOT_APPLIED', 'set_mcp_server_enabled requires a non-empty `server` name', undefined, ctx)
    return
  }
  if (typeof msg?.enabled !== 'boolean') {
    sendError(ws, requestId, 'MCP_SERVER_NOT_APPLIED', 'set_mcp_server_enabled requires a boolean `enabled`', undefined, ctx)
    return
  }

  const sessionId = msg?.sessionId || client?.activeSessionId
  // Session resolution failures (no active session, or a bound token naming a
  // DIFFERENT session — resolveSession enforces the binding) echo requestId +
  // the stable NOT_APPLIED code, mirroring handleSetThinkingLevel, rather than
  // resolveSessionOrError's code-less session_error, so the doc-block contract
  // ("every rejection echoes requestId with a stable code") holds on ALL paths.
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    sendError(ws, requestId, 'MCP_SERVER_NOT_APPLIED', 'No active session', undefined, ctx)
    return
  }

  // Capability gate — only providers that expose `setMcpServerEnabled` (the
  // BYOK lane) can toggle. Others ride the claude binary's own MCP config.
  if (!entry.session || typeof entry.session.setMcpServerEnabled !== 'function') {
    sendError(ws, requestId, 'MCP_SERVER_TOGGLE_UNSUPPORTED',
      'This provider does not support enabling/disabling MCP servers (its MCP config is managed by the underlying CLI).',
      undefined, ctx)
    return
  }

  try {
    const result = await entry.session.setMcpServerEnabled(server, msg.enabled)
    if (!result || result.found === false) {
      sendError(ws, requestId, 'MCP_SERVER_NOT_FOUND', `No configured MCP server named '${server}' for this session.`, undefined, ctx)
      return
    }
    // The session re-emits `mcp_servers` on a real change (forwarded to all
    // subscribers). Persist immediately so a crash inside the debounce window
    // can't lose the parked-set change — same discipline as the permission-rule
    // and per-session-setting handlers.
    if (result.changed) {
      try {
        ctx.sessions.sessionManager?.serializeState?.()
      } catch (err) {
        loggerForSession('ws', sessionId).warn(`Failed to persist disabledMcpServers for ${sessionId}: ${err?.message || err}`)
      }
    }
    loggerForSession('ws', sessionId).info(`MCP server '${server}' ${msg.enabled ? 'enabled' : 'disabled'} by ${client.id} on session ${sessionId} (changed=${result.changed})`)
  } catch (err) {
    sendError(ws, requestId, 'MCP_SERVER_NOT_APPLIED', `Failed to ${msg.enabled ? 'enable' : 'disable'} MCP server '${server}': ${err?.message || String(err)}`, undefined, ctx)
  }
}

/**
 * #6822 — submit a pasted OAuth authorization code for a remote MCP server that
 * reported `oauth-required`. The daemon redeems the code (holding the PKCE
 * verifier + state server-side), persists the tokens encrypted at rest, and
 * reconnects the server authenticated. Only the BYOK lane runs an in-daemon MCP
 * fleet, so this rejects other providers with a capability error.
 *
 * AUTH: identical own-session gate as `set_mcp_server_enabled` (routed through
 * `resolveSession`, which enforces session-token binding). Redeeming a code can
 * only authorize the server the user is already trying to connect — it never
 * escalates. Every rejection echoes `requestId` (when supplied) with a stable
 * code (MCP_AUTH_NOT_APPLIED / MCP_AUTH_UNSUPPORTED / MCP_AUTH_NOT_FOUND /
 * MCP_AUTH_FAILED). On success the session re-emits `mcp_servers` (the new
 * status IS the confirmation) — no separate ack. The `code` and any token are
 * NEVER logged.
 */
async function handleSubmitMcpAuthCode(ws, client, msg, ctx) {
  const requestId = msg?.requestId
  const server = typeof msg?.server === 'string' ? msg.server.trim() : ''
  const code = typeof msg?.code === 'string' ? msg.code.trim() : ''
  if (!server) {
    sendError(ws, requestId, 'MCP_AUTH_NOT_APPLIED', 'submit_mcp_auth_code requires a non-empty `server` name', undefined, ctx)
    return
  }
  if (!code) {
    sendError(ws, requestId, 'MCP_AUTH_NOT_APPLIED', 'submit_mcp_auth_code requires a non-empty `code`', undefined, ctx)
    return
  }

  const sessionId = msg?.sessionId || client?.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    sendError(ws, requestId, 'MCP_AUTH_NOT_APPLIED', 'No active session', undefined, ctx)
    return
  }

  if (!entry.session || typeof entry.session.submitMcpAuthCode !== 'function') {
    sendError(ws, requestId, 'MCP_AUTH_UNSUPPORTED',
      'This provider does not support MCP OAuth authorization (its MCP config is managed by the underlying CLI).',
      undefined, ctx)
    return
  }

  try {
    const result = await entry.session.submitMcpAuthCode(server, code)
    if (!result || result.found === false) {
      sendError(ws, requestId, 'MCP_AUTH_NOT_FOUND', `No configured MCP server named '${server}' awaiting authorization for this session.`, undefined, ctx)
      return
    }
    if (result.ok === false) {
      // Value-free reason — redemption failed (wrong/expired code, AS error).
      sendError(ws, requestId, 'MCP_AUTH_FAILED', result.error || `Authorization for MCP server '${server}' failed.`, undefined, ctx)
      return
    }
    // Success: the session re-emitted `mcp_servers` (status now connected or,
    // if the server still rejects, oauth-required again). Never log the code.
    loggerForSession('ws', sessionId).info(`MCP server '${server}' authorization completed by ${client.id} on session ${sessionId} (status=${result.status || 'unknown'})`)
  } catch (err) {
    sendError(ws, requestId, 'MCP_AUTH_FAILED', `Authorization for MCP server '${server}' failed: ${err?.message || String(err)}`, undefined, ctx)
  }
}

// #4664: assemble the per-session-setting WS handlers from the registry.
// Each setting's `requestType` (e.g. `'set_prompt_evaluator'`) is the
// message-type key the dispatcher looks up; the factory-built handler
// covers payload validation, session resolution, setter invocation,
// broadcast, and immediate persist with the same shape every existing
// hand-written handler used. Adding a new setting means appending one
// entry to PER_SESSION_SETTINGS — no new handler boilerplate.
const perSessionSettingHandlers = {}
for (const settingDef of PER_SESSION_SETTINGS) {
  perSessionSettingHandlers[settingDef.requestType] = buildPerSessionSettingHandler(settingDef)
}

/**
 * #6543 (IDE P3 feature B) — reply to a `get_permission_input` pull. The
 * `permission_request` broadcast truncates `input` at ~10K (secret-safe), so a
 * client building a per-hunk pre-write diff pulls the FULL (still secret-
 * redacted) tool input by requestId.
 *
 * SECURITY — session-bound, read-only, redacted:
 *   1. The requestId → session mapping (`permissionSessionMap`, populated for
 *      both the SDK and hook dispatch paths) locates the owning session.
 *   2. Authorization is IDENTICAL to `permission_response`: a bound client must
 *      own that session; an unbound client must be a viewer of it
 *      (`isSessionViewer`). An unauthorized (or unknown) request gets
 *      `found:false` with NO input — it can never read another session's input.
 *   3. The raw input (`session._pendingPermissions`, the back-compat accessor
 *      onto the session's PermissionManager) is re-run through `sanitizeToolInput`
 *      with the larger `PULL_MAX_INPUT_CHARS` cap — for the tool_input object the
 *      KEY-NAME + VALUE-SHAPE secret passes run on every value regardless of the
 *      cap, so a higher cap never weakens redaction, only the truncation point.
 */
function handleGetPermissionInput(ws, client, msg, ctx) {
  const requestId = msg.requestId
  const send = (fields) => ctx.transport.send(ws, { type: 'permission_input', requestId, ...fields })
  const notFound = (code, message) => send({ found: false, error: { code, message } })

  const sessionId = ctx.permissions.permissionSessionMap.get(requestId)
  if (!sessionId) return notFound('NOT_FOUND', 'No pending permission for that request.')

  // Same authority gate as permission_response — a client may only read the
  // input for a permission it could itself answer.
  if (client.boundSessionId) {
    if (client.boundSessionId !== sessionId) return notFound('NOT_FOUND', 'No pending permission for that request.')
  } else if (!isSessionViewer(client, sessionId)) {
    return notFound('NOT_FOUND', 'No pending permission for that request.')
  }

  const sess = ctx.sessions.sessionManager?.getSession?.(sessionId)?.session
  const pending = sess?._pendingPermissions?.get(requestId)
  if (!pending) return notFound('NOT_PENDING', 'That permission is no longer pending (resolved or expired).')

  const tool = sess?._lastPermissionData?.get(requestId)?.tool
  // #6551 — memoize the redacted pull on the pending entry so repeated pulls for
  // the same requestId don't re-run the full redactDeep tree-walk + JSON.stringify
  // per call. The pending entry is deleted at every resolve/timeout/abort site, so
  // the memo auto-invalidates with it (no separate cache-invalidation wiring). The
  // input is treated as immutable once pending, so the cached value stays correct.
  if (pending._redactedPull === undefined) {
    pending._redactedPull = sanitizeToolInput(pending.input, { maxChars: PULL_MAX_INPUT_CHARS })
  }
  return send({ found: true, tool, input: pending._redactedPull })
}

export const settingsHandlers = {
  set_model: handleSetModel,
  set_permission_mode: handleSetPermissionMode,
  permission_response: handlePermissionResponse,
  // #6543 (IDE P3 feature B): pull the full redacted tool input for a pre-write diff.
  get_permission_input: handleGetPermissionInput,
  query_permission_audit: handleQueryPermissionAudit,
  list_providers: handleListProviders,
  set_thinking_level: handleSetThinkingLevel,
  set_permission_rules: handleSetPermissionRules,
  // #6824: per-server MCP enable/disable (BYOK lane; capability-gated).
  set_mcp_server_enabled: handleSetMcpServerEnabled,
  // #6822: submit a pasted OAuth authorization code (BYOK lane; capability-gated).
  submit_mcp_auth_code: handleSubmitMcpAuthCode,
  // promptEvaluatorSkipPattern keeps its bespoke handler because the
  // payload shape (string-or-null + pre-validation regex compile to
  // surface a distinct error code) doesn't fit the boolean/string
  // factory. The other three per-session settings come from the
  // registry above.
  set_prompt_evaluator_skip_pattern: handleSetPromptEvaluatorSkipPattern,
  ...perSessionSettingHandlers,
  // Skills + credential handlers split into sibling modules (audit P2-4).
  ...skillsHandlers,
  ...credentialHandlers,
}

export { ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW }
