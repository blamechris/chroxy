import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename, extname } from 'path'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { CodexSession, resolveCodexSandbox } from './codex-session.js'
import { CodexAppServerClient } from './codex-app-server-client.js'
import { PermissionManager, wirePermissionManager } from './permission-manager.js'
import { materializeAttachments, buildAttachmentsPromptSuffix } from './claude-tui-attachments.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger, loggerForSession } from './logger.js'

// Image extensions codex can attach for VISION via a `localImage` input item.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

const log = createLogger('codex-app-server')

/**
 * Codex session driven through the `codex app-server` JSON-RPC protocol
 * (persistent process) instead of one-shot `codex exec --json` (see
 * codex-session.js). This is the foundation for surfacing codex's approval
 * requests through Chroxy's permission pipeline (epic #6605).
 *
 * PHASE 1 was the DRIVING LAYER: run turns + map the app-server's streaming
 * notifications onto Chroxy's standard event contract.
 *
 * PHASE 2 (#6605) surfaces codex's APPROVALS through Chroxy's permission
 * pipeline. `approvalPolicy` is derived from the session's permission mode
 * (`auto` → `never`, else `on-request`), so codex asks before running a command
 * or editing a file; the server → client approval RPC
 * (`item/commandExecution/requestApproval` / `item/fileChange/requestApproval`)
 * is routed into a PermissionManager exactly like SdkSession's `canUseTool`
 * bridge — it emits `permission_request`, waits for the user's
 * `permission_response`, and answers codex with the correct per-method decision
 * enum (CommandExecutionApprovalDecision vs ReviewDecision). `capabilities`
 * therefore advertises `permissions` / `inProcessPermissions` /
 * `permissionModeSwitch`.
 *
 * This is the DEFAULT driver for the `codex` provider (#6616, see providers.js
 * `getProvider`); set `CHROXY_CODEX_APPSERVER=0` to fall back to the legacy
 * exec-based CodexSession.
 *
 * Architecturally this mirrors SdkSession (persistent backend + streaming),
 * NOT the JsonlSubprocessSession middle layer (subprocess-per-turn). Codex
 * provider identity (binary / auth / models / preflight) is delegated to
 * CodexSession's statics so both paths report identically.
 */
export class CodexAppServerSession extends BaseSession {
  // -- Provider identity (delegated to CodexSession so both paths agree) --
  static get providerName() { return 'codex' }
  static get displayLabel() { return 'OpenAI Codex (app-server)' }
  static get dataDir() { return CodexSession.dataDir }
  static get messageIdPrefix() { return 'codex' }
  static get apiKeyEnv() { return CodexSession.apiKeyEnv }
  static get binaryCandidates() { return CodexSession.binaryCandidates }
  static get resolvedBinary() { return CodexSession.resolvedBinary }
  static hasAlternativeCredentials() { return CodexSession.hasAlternativeCredentials() }
  static resolveAuth(env, helpers) { return CodexSession.resolveAuth(env, helpers) }
  static get preflight() { return CodexSession.preflight }
  static getAllowedModels() { return CodexSession.getAllowedModels() }
  static getFallbackModels() { return CodexSession.getFallbackModels() }
  static getModelMetadata(id) { return CodexSession.getModelMetadata(id) }

  static get capabilities() {
    return {
      // Phase 2 (#6605): approvals are surfaced through the permission pipeline.
      permissions: true,
      inProcessPermissions: true, // requires respondToPermission + respondToQuestion
      modelSwitch: true,
      permissionModeSwitch: true, // mode drives approvalPolicy + PermissionManager
      planMode: false,
      resume: false, // matches exec CodexSession; app-server resume is a follow-up
      terminal: false,
      thinkingLevel: false,
      streaming: true,
    }
  }

  constructor(opts = {}) {
    // #5367 canonical picker — forward every BaseSession opt; codex defaults in
    // the overrides bag (model omitted → app-server uses ~/.codex/config.toml).
    super(buildBaseSessionOpts(opts, {
      provider: opts.provider || 'codex',
      model: opts.model || null,
    }))
    this._client = null
    this._threadId = null
    this._activeTurn = null // { messageId, turnId, didStreamStart }
    this._lastUsage = null
    this._skillsPrepended = false // #6606 — inject the skills prefix once, on turn 1
    this._turnAbort = null // per-turn AbortController — cancels pending approvals
    this._attachDir = null // #6609 — lazily-created temp dir for materialized attachments

    // #6605 Phase 2 — surface codex approvals through the same PermissionManager
    // bridge SdkSession uses. wirePermissionManager re-emits permission_request /
    // permission_resolved / user_question on THIS session and back-links
    // _pendingPermissions/_lastPermissionData for ws-permissions.js.
    this._permissions = new PermissionManager({ log })
    wirePermissionManager(this, this._permissions, {
      onRequest: () => this._pauseResultTimeoutForPermission(),
      onResolved: () => this._resumeResultTimeoutForPermission(),
    })
  }

  _buildChildEnv() { return buildSpawnEnv('codex') }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start() {
    const sandbox = resolveCodexSandbox()
    this._client = new CodexAppServerClient({
      bin: CodexAppServerSession.resolvedBinary,
      cwd: this.cwd,
      env: this._buildChildEnv(),
      logger: log,
    })
    this._client.on('notification', (n) => this._onNotification(n))
    this._client.on('serverRequest', (r) => this._onServerRequest(r))
    this._client.on('exit', (e) => this._onClientExit(e))

    await this._client.initialize({ name: 'chroxy', version: '1' })
    const started = await this._client.request('thread/start', {
      approvalPolicy: this._approvalPolicy(), // #6605 P2 — derived from permission mode
      cwd: this.cwd,
      sandbox,
      ...(this.model ? { model: this.model } : {}),
    })
    this._threadId = started?.thread?.id || null
    // #6608 — do NOT set this.resumeSessionId in Phase 1: capabilities.resume is
    // false, and SessionManager persists resumeSessionId as the conversationId to
    // resume on restart. Leaving it null keeps the two consistent. The live thread
    // id is tracked on this._threadId (used for turn/start + interrupt). Wiring
    // real app-server resume (thread/resume) is a follow-up.
    this._log = loggerForSession('codex-app-server', this._threadId || 'no-thread')
    this._processReady = true
    ;(this._log || log).info(`codex app-server ready (thread=${this._threadId} sandbox=${sandbox})`)
    this.emit('ready', { model: this.model })
  }

  async sendMessage(prompt, attachments, sendOptions = {}) {
    if (this._isBusy) {
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      return
    }
    if (!this._processReady || !this._client) {
      this.emit('error', { message: 'Codex app-server session is not started' })
      return
    }
    this._isBusy = true
    this._messageCounter += 1
    const messageId = `msg-${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId
    this._activeTurn = { messageId, turnId: null, didStreamStart: false }
    // Fresh abort scope for this turn's approvals — interrupt()/destroy() abort it
    // so a pending permission_request resolves (deny) instead of hanging the turn.
    this._turnAbort = new AbortController()
    this._armResultTimeout()

    // #6606 review — mirror the exec path: prepend the combined skills prefix on
    // the FIRST turn so runtime skills reach codex. The flag flips only AFTER
    // turn/start succeeds, so a failed first turn still retries with the skills.
    let text = prompt || ''
    if (!this._skillsPrepended) {
      const combined = typeof this._buildCombinedSkillsPrefix === 'function' ? this._buildCombinedSkillsPrefix() : ''
      if (combined) text = `${combined}\n\n---\n\n${text}`
    }
    // #6609 — materialize attachments into codex UserInput items. Images become
    // `localImage` items (codex vision); documents / non-image file_refs are named
    // in a text suffix codex can read. Failure is non-fatal — send the prompt
    // without attachments rather than lose the turn.
    const input = this._buildTurnInput(text, attachments, messageId)

    ;(this._log || log).info(`codex app-server turn start (msg=${messageId} thread=${this._threadId} inputItems=${input.length})`)
    try {
      const res = await this._client.request('turn/start', {
        threadId: this._threadId,
        approvalPolicy: this._approvalPolicy(), // #6605 P2 — per-turn, tracks mode changes
        input,
        // #6608 — pass the CURRENT model per turn (turn/start accepts it) so a
        // mid-session set_model actually takes effect, matching the exec path's
        // per-turn model. thread/start seeds the initial model; this tracks changes.
        ...(this.model ? { model: this.model } : {}),
      })
      this._skillsPrepended = true
      if (this._activeTurn && !this._activeTurn.turnId) this._activeTurn.turnId = res?.turn?.id || null
    } catch (err) {
      // turn/start itself failed (dead server, bad thread) — fail this turn.
      this._failTurn(`Codex turn failed to start: ${err.message}`)
    }
  }

  // #6609 — build the codex `turn/start` input array from the prompt + Chroxy
  // attachments. codex's UserInput union natively takes file paths, so:
  //   - binary image/document → materialized to a temp file (reused helper)
  //   - file_ref → its path used directly (no copy)
  //   - images → a `localImage` input item (codex vision)
  //   - documents / non-image file_refs → named in a text suffix codex can read
  // Always returns at least the text item; attachment failure is non-fatal.
  _buildTurnInput(text, attachments, messageId) {
    let outText = text
    const imageItems = []
    if (attachments?.length) {
      try {
        const binary = attachments.filter((a) => a && typeof a.data === 'string')
        // #6614 review — defence-in-depth: the WS layer already converts/rejects
        // file_refs upstream (absolute + `..` paths are refused there), so this
        // branch is effectively unreachable on the wire — but don't hand an
        // unconfined path to a localImage item for any future non-WS caller. Skip
        // + warn on an absolute or parent-traversing path.
        const fileRefs = attachments.filter((a) => {
          if (!a || a.type !== 'file_ref' || typeof a.path !== 'string') return false
          if (a.path.startsWith('/') || a.path.split(/[/\\]/).includes('..')) {
            ;(this._log || log).warn(`codex attachment: skipping non-relative file_ref path "${a.path}"`)
            return false
          }
          return true
        })
        if (binary.length && !this._attachDir) this._attachDir = mkdtempSync(join(tmpdir(), 'chroxy-codex-attach-'))
        const materialized = binary.length ? materializeAttachments(binary, this._attachDir, messageId) : []
        const refFiles = fileRefs.map((a) => ({ path: a.path, name: a.name || basename(a.path), mediaType: '', size: 0 }))
        const all = [...materialized, ...refFiles]
        for (const f of all.filter((f) => this._isImageFile(f))) imageItems.push({ type: 'localImage', path: f.path })
        const suffix = buildAttachmentsPromptSuffix(all.filter((f) => !this._isImageFile(f)))
        if (suffix.suffix) outText = (outText || '') + suffix.suffix
        // #6614 review — surface anything we couldn't place (no `data` and not a
        // usable file_ref) instead of dropping it silently.
        const dropped = attachments.length - all.length
        if (dropped > 0) {
          ;(this._log || log).warn(`codex attachments: ${dropped} of ${attachments.length} not attachable (no data / invalid file_ref) — omitted (msg=${messageId})`)
        }
        ;(this._log || log).info(`codex attachments prepared (msg=${messageId} images=${imageItems.length} docs=${all.length - imageItems.length})`)
      } catch (err) {
        // #6614 review — truly fall back to text-only so the log is accurate: an
        // exception AFTER some images were pushed / the suffix appended must not
        // leave a half-built input. Reset both to the un-suffixed prompt.
        imageItems.length = 0
        outText = text
        ;(this._log || log).warn(`codex attachment materialization failed (msg=${messageId}): ${err.message} — sending prompt without attachments`)
      }
    }
    return [{ type: 'text', text: outText }, ...imageItems]
  }

  _isImageFile(f) {
    if ((f?.mediaType || '').toLowerCase().startsWith('image/')) return true
    return IMAGE_EXTS.has(extname(f?.path || '').toLowerCase())
  }

  // ------------------------------------------------------------------
  // app-server notification → Chroxy event mapping
  // ------------------------------------------------------------------

  _onNotification({ method, params }) {
    if (!this._activeTurn) {
      // Between turns: only usage/errors matter; ignore stray item churn.
      if (method === 'thread/tokenUsage/updated') this._lastUsage = this._mapUsage(params)
      return
    }
    this._resetResultTimeout()
    const t = this._activeTurn
    switch (method) {
      case 'turn/started':
        if (!t.turnId) t.turnId = params?.turn?.id || params?.turnId || null
        break
      case 'item/agentMessage/delta': {
        const delta = params?.delta ?? params?.text ?? ''
        if (!delta) break
        this._ensureStreamStart()
        this.emit('stream_delta', { messageId: t.messageId, delta })
        break
      }
      case 'item/started':
        this._onItemStarted(params?.item)
        break
      case 'item/completed':
        this._onItemCompleted(params?.item)
        break
      case 'thread/tokenUsage/updated':
        this._lastUsage = this._mapUsage(params)
        break
      case 'turn/completed':
        this._finishTurn(params?.turn)
        break
      case 'error':
        this._failTurn(`Codex error: ${JSON.stringify(params).slice(0, 200)}`)
        break
      default:
        break // reasoning/plan/other items are ignored in Phase 1
    }
  }

  _onItemStarted(item) {
    if (!item) return
    // commandExecution / fileChange / mcpToolCall map to Chroxy tools.
    if (item.type === 'commandExecution') {
      const toolUseId = item.id
      this.emit('tool_start', {
        messageId: this._activeTurn.messageId,
        toolUseId,
        tool: 'shell',
        input: { command: item.command, cwd: item.cwd },
      })
      this._trackToolStart(toolUseId, 'shell')
    } else if (item.type === 'fileChange') {
      const toolUseId = item.id
      this.emit('tool_start', {
        messageId: this._activeTurn.messageId,
        toolUseId,
        tool: 'apply_patch',
        input: { changes: item.changes ?? item.patch ?? null },
      })
      this._trackToolStart(toolUseId, 'apply_patch')
    }
  }

  _onItemCompleted(item) {
    if (!item) return
    if (item.type === 'commandExecution') {
      this.emit('tool_result', { toolUseId: item.id, result: item.aggregatedOutput ?? '' })
      this._trackToolResult(item.id)
    } else if (item.type === 'fileChange') {
      this.emit('tool_result', { toolUseId: item.id, result: item.status ?? '' })
      this._trackToolResult(item.id)
    } else if (item.type === 'agentMessage') {
      // Fallback: if the final text never arrived as deltas (short replies can
      // skip the delta stream), emit it once so the message isn't lost.
      if (!this._activeTurn.didStreamStart && item.text) {
        this._ensureStreamStart()
        this.emit('stream_delta', { messageId: this._activeTurn.messageId, delta: item.text })
      }
    }
  }

  _ensureStreamStart() {
    if (this._activeTurn.didStreamStart) return
    this._activeTurn.didStreamStart = true
    this.emit('stream_start', { messageId: this._activeTurn.messageId })
  }

  _mapUsage(params) {
    const u = params?.usage || params || {}
    return {
      input_tokens: u.inputTokens ?? u.input_tokens ?? 0,
      output_tokens: u.outputTokens ?? u.output_tokens ?? 0,
      cached_input_tokens: u.cachedInputTokens ?? u.cached_input_tokens ?? 0,
    }
  }

  _finishTurn(turn) {
    if (!this._activeTurn) return
    const t = this._activeTurn
    this._clearResultTimeout()
    if (t.didStreamStart) this.emit('stream_end', { messageId: t.messageId })
    this._emitResult(
      { cost: null, duration: turn?.durationMs ?? null, usage: this._lastUsage, sessionId: this._threadId },
      'turn_ended_with_orphan_tool_start',
    )
    this._activeTurn = null
    this._endTurnAbort()
    // #6606 review — disarm the intentional-stop flag on a NORMAL completion too
    // (mirrors sdk-session.js). interrupt() arms it; if the turn then completes
    // cleanly, only _failTurn would otherwise consume it, so a leftover flag
    // would mis-report a LATER genuine error as a clean `stopped` (#4881 race).
    this._clearIntentionalStop()
    this._clearMessageState()
    this._maybeDequeue()
  }

  _failTurn(message) {
    this._clearResultTimeout()
    const t = this._activeTurn
    if (t?.didStreamStart) this.emit('stream_end', { messageId: t.messageId })
    const wasIntentional = this._consumeIntentionalStop()
    if (wasIntentional) this.emit('stopped', {})
    else this.emit('error', { message })
    this._activeTurn = null
    this._endTurnAbort()
    this._clearMessageState()
    this._maybeDequeue()
  }

  // Abort this turn's approval scope (any pending permission_request resolves as
  // a deny) and drop the controller. Safe to call with no active turn.
  _endTurnAbort() {
    if (this._turnAbort) {
      try { this._turnAbort.abort() } catch { /* noop */ }
      this._turnAbort = null
    }
  }

  _maybeDequeue() {
    if (this._outgoingQueue.length && !this._destroying) this.dequeueNextOutgoing()
  }

  // Basic result-timeout so a wedged turn can't hang busy forever. Reset on
  // every notification (progress), cleared on turn end.
  _armResultTimeout() {
    this._clearResultTimeout()
    this._resultTimeout = setTimeout(() => {
      ;(this._log || log).warn(`codex app-server turn result timeout (msg=${this._currentMessageId})`)
      this._failTurn('Codex turn timed out with no result')
    }, this._resultTimeoutMs)
    if (typeof this._resultTimeout.unref === 'function') this._resultTimeout.unref()
  }

  _resetResultTimeout() {
    if (this._activeTurn) this._armResultTimeout()
  }

  _clearResultTimeout() {
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
  }

  // ------------------------------------------------------------------
  // Server → client requests (approvals) — routed into the permission pipeline
  // ------------------------------------------------------------------

  // Codex asks before running a command / editing a file (approvalPolicy
  // 'on-request'). Route the two clean approval families through the
  // PermissionManager; safe-decline the scope-escalation variant (#6610).
  _onServerRequest({ id, method, params }) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this._routeApproval(id, method, params)
      return
    }
    if (method === 'item/permissions/requestApproval') {
      // Scope-escalation: codex wants BROADER permissions than its sandbox. Surface
      // it through the permission pipeline as a distinctly-worded prompt (#6610).
      this._routePermissionsApproval(id, params)
      return
    }
    ;(this._log || log).warn(`codex app-server: unsupported serverRequest ${method} — declining`)
    this._client?.respondError(id, -32601, 'unsupported request')
  }

  // Bridge one codex approval RPC → a Chroxy permission_request and back. Mirrors
  // SdkSession's canUseTool: handlePermission emits permission_request, resolves
  // when the user answers (or on rule/mode short-circuit, timeout, or abort), and
  // we answer codex with the decision enum that matches THIS approval family.
  async _routeApproval(rpcId, method, params) {
    const { tool, input } = this._describeApproval(method, params)
    let result
    try {
      // Pass a sentinel `suggestions` entry so an "Allow always" response sets
      // `updatedPermissions` on the result (respondToPermission only echoes it
      // when suggestions were provided) — that's how we detect a SESSION grant
      // and answer codex with acceptForSession/approved_for_session. The sentinel
      // is never persisted (no SDK behind this path); it's a local marker only.
      const suggestions = [{ codexApproval: method }]
      result = await this._permissions.handlePermission(tool, input, this._turnAbort?.signal, this.permissionMode, suggestions)
    } catch (err) {
      result = { behavior: 'deny', message: err?.message || 'permission error' }
    }
    const allow = result?.behavior === 'allow'
    const session = allow && !!result?.updatedPermissions // "always allow" → session grant
    this._client?.respond(rpcId, this._codexDecision(method, allow, session))
  }

  // Map a codex approval request into the (tool, input) shape PermissionManager
  // renders. `description`/`command`/`file_path` drive the human-facing prompt.
  _describeApproval(method, params) {
    if (method === 'item/fileChange/requestApproval') {
      return {
        tool: 'apply_patch',
        input: { description: params?.reason || 'Apply file changes', file_path: params?.grantRoot },
      }
    }
    // item/commandExecution/requestApproval
    return {
      tool: 'shell',
      // Always give the prompt a non-empty description so a null/blank command
      // can't render an empty approval prompt (#6611 review nitpick).
      input: { command: params?.command, cwd: params?.cwd, description: params?.reason || params?.command || 'Run a shell command' },
    }
  }

  // The two approval families use DIFFERENT decision vocabularies (from the
  // app-server JSON schema): fileChange → ReviewDecision, commandExecution →
  // CommandExecutionApprovalDecision.
  _codexDecision(method, allow, session) {
    if (method === 'item/fileChange/requestApproval') {
      if (!allow) return { decision: 'denied' }
      return { decision: session ? 'approved_for_session' : 'approved' }
    }
    if (!allow) return { decision: 'decline' }
    return { decision: session ? 'acceptForSession' : 'accept' }
  }

  // #6610: codex's THIRD approval family — item/permissions/requestApproval — is a
  // scope-escalation (it wants broader filesystem/network access than its sandbox).
  // Unlike the command/file families the response is a permission-GRANT object
  // (PermissionsRequestApprovalResponse: { permissions, scope?, strictAutoReview? }),
  // not a decision enum, so it needs its own routing + response mapping. It still
  // flows through the same PermissionManager prompt (a distinctly-worded request),
  // so existing clients render + answer it with the normal allow/deny UI.
  async _routePermissionsApproval(rpcId, params) {
    let result
    try {
      const input = {
        description: this._describePermissionsRequest(params),
        // Structured detail for any client that wants to render the exact scope.
        requestedPermissions: params?.permissions ?? null,
      }
      // Sentinel suggestion → respondToPermission echoes updatedPermissions on an
      // "always allow", which we read as a SESSION-scoped grant (mirrors _routeApproval).
      const suggestions = [{ codexApproval: 'item/permissions/requestApproval' }]
      result = await this._permissions.handlePermission('request_permissions', input, this._turnAbort?.signal, this.permissionMode, suggestions)
    } catch (err) {
      result = { behavior: 'deny', message: err?.message || 'permission error' }
    }
    const allow = result?.behavior === 'allow'
    const session = allow && !!result?.updatedPermissions
    this._client?.respond(rpcId, this._codexPermissionsGrant(allow, session, params?.permissions))
  }

  // Build the PermissionsRequestApprovalResponse. Approve → grant EXACTLY what
  // codex requested (RequestPermissionProfile and GrantedPermissionProfile share
  // the same {fileSystem?, network?} shape, so echoing the request is schema-valid
  // by construction) with scope 'session' for an "always allow" else 'turn'. Deny →
  // an empty `permissions` object with `scope` OMITTED (an explicit 'none' is an
  // invalid PermissionGrantScope enum and wedges the turn — #6612).
  _codexPermissionsGrant(allow, session, requestedPermissions) {
    if (!allow) return { permissions: {} }
    const permissions = requestedPermissions && typeof requestedPermissions === 'object'
      ? requestedPermissions
      : {}
    return { permissions, scope: session ? 'session' : 'turn' }
  }

  // Human-readable summary of the requested scope for the approval prompt, so the
  // operator sees WHAT codex wants to broaden before granting it.
  _describePermissionsRequest(params) {
    const parts = []
    const fs = params?.permissions?.fileSystem
    if (fs) {
      for (const e of Array.isArray(fs.entries) ? fs.entries : []) {
        const path = e?.path?.path ?? e?.path?.pattern ?? e?.path?.value?.kind ?? 'a path'
        parts.push(`filesystem ${e?.access ?? 'access'} → ${path}`)
      }
      if (Array.isArray(fs.read) && fs.read.length) parts.push(`filesystem read: ${fs.read.join(', ')}`)
      if (Array.isArray(fs.write) && fs.write.length) parts.push(`filesystem write: ${fs.write.join(', ')}`)
    }
    if (params?.permissions?.network?.enabled) parts.push('network access')
    const scope = parts.length ? parts.join('; ') : 'broader permissions'
    const reason = typeof params?.reason === 'string' && params.reason.trim()
      ? ` — ${params.reason.trim()}`
      : ''
    return `Codex is requesting to broaden its sandbox permissions${reason}: ${scope}`
  }

  // 'auto' (skip all prompts) → codex runs without asking. Every other mode →
  // 'on-request': codex asks per action and the PermissionManager applies the
  // mode/rules (auto-allow for acceptEdits/rules, prompt for 'approve').
  _approvalPolicy() {
    return this.permissionMode === 'auto' ? 'never' : 'on-request'
  }

  // In-process permission responses (capabilities.inProcessPermissions) — thin
  // delegators to the PermissionManager, mirroring SdkSession.
  respondToPermission(requestId, decision, editedInput) {
    return this._permissions.respondToPermission(requestId, decision, editedInput)
  }

  respondToQuestion(text, answers) {
    return this._permissions.respondToQuestion(text, answers)
  }

  // A permission prompt can outlast the result timeout while it waits on a human;
  // pause the timer on request, re-arm it once the decision lands (#3920 pattern).
  _pauseResultTimeoutForPermission() { this._clearResultTimeout() }
  _resumeResultTimeoutForPermission() { if (this._activeTurn) this._armResultTimeout() }

  _onClientExit({ code, signal, error }) {
    if (this._destroying) return
    const detail = error ? error.message : `code=${code}${signal ? ` signal=${signal}` : ''}`
    ;(this._log || log).warn(`codex app-server exited unexpectedly (${detail})`)
    this._processReady = false
    if (this._activeTurn) this._failTurn(`Codex app-server exited (${detail})`)
    else this.emit('error', { message: `Codex app-server exited (${detail})`, recoverable: true })
  }

  // ------------------------------------------------------------------
  // Interrupt / teardown
  // ------------------------------------------------------------------

  async interrupt() {
    this.clearOutgoingQueue()
    this.markIntentionalStop()
    // Stop must not wait on a prompt: abort this turn's approval scope so a
    // pending permission_request resolves (deny → decline) immediately, instead
    // of leaving the turn wedged until the 5-min timeout (#6611 review).
    this._endTurnAbort()
    if (this._client && this._activeTurn?.turnId) {
      try { await this._client.request('turn/interrupt', { threadId: this._threadId, turnId: this._activeTurn.turnId }) }
      catch (err) { (this._log || log).debug(`turn/interrupt failed: ${err.message}`) }
    }
  }

  // Panic-button parity with SdkSession (#3729): switching TO auto drains any
  // already-emitted approval prompts (they resolve as allow → we answer codex
  // accept), so the user isn't left staring at a prompt after choosing "approve
  // everything". approvalPolicy for the NEXT turn is derived from the new mode.
  _onPermissionModeChanged(mode) {
    if (mode === 'auto') this._permissions.autoAllowPending()
  }

  async destroy() {
    this._destroying = true
    this.clearOutgoingQueue({ emit: false })
    this._clearIntentionalStop()
    this._clearResultTimeout()
    this._endTurnAbort() // resolve any in-flight approval as a deny before teardown
    try { this._permissions?.destroy() } catch { /* noop */ }
    // #6609 — drop the materialized-attachment temp dir.
    if (this._attachDir) { try { rmSync(this._attachDir, { recursive: true, force: true }) } catch { /* noop */ } this._attachDir = null }
    try { this._client?.kill() } catch { /* already gone */ }
    this._client = null
    this._activeTurn = null
    this._clearMessageState()
    this._destroyPendingBackgroundShells()
    this._processReady = false
    this.removeAllListeners()
  }
}
