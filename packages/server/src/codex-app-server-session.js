import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename, extname } from 'path'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { nonNegInt, synthesizeModelUsage } from './usage-normalize.js'
import { CodexSession, resolveCodexSandbox } from './codex-session.js'
import { CodexAppServerClient } from './codex-app-server-client.js'
import { PermissionManager, wirePermissionManager } from './permission-manager.js'
import { materializeAttachments, buildAttachmentsPromptSuffix } from './claude-tui-attachments.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger, loggerForSession } from './logger.js'

// Image extensions codex can attach for VISION via a `localImage` input item.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

// #6638: cap on cached fileChange diffs (itemId → changes). A turn deletes each on
// completion and clears the map at turn end, so this only bites a pathological
// flood of un-completed fileChange items.
const MAX_PENDING_FILE_CHANGES = 500

// #6684: cap the rendered mcpToolCall result text. A connector tool can return an
// arbitrarily large content array / structuredContent blob; bound it so a single
// tool_result can't balloon the transcript or the persisted history ring.
const MAX_MCP_RESULT_CHARS = 10_000

// #6629: bounded backstop for codex's OWN response-stream reconnect loop. #6623
// keeps the turn OPEN on a transient `Reconnecting... N/M` error so codex can
// recover, and the only pre-existing backstop was the 30-min result timeout.
// But a pending permission prompt CLEARS that timer outright
// (`_pauseResultTimeoutForPermission` → `_clearResultTimeout`), and it is only
// re-armed when the NEXT notification arrives (`_resetResultTimeout`, run at the
// top of `_onNotification`). A codex approval is a server→client REQUEST, not a
// notification, so it never re-arms anything. So the exact #6629 situation — a
// shell-escalation prompt pending, then the response stream wedges mid-reconnect
// with no further notifications — leaves NO active result timeout at all, and the
// session hangs in "Working..." indefinitely. This watchdog is the independent
// backstop for that gap: armed on a transient reconnect notification, NOT touched
// by the permission pause, disarmed the moment codex makes any real forward
// progress, and — if codex neither recovers nor emits its terminal give-up —
// fails the turn cleanly (clears busy + sweeps orphan tool_starts) with
// `error{code:'stream_stall'}` so the client shows its existing retry affordance
// instead of a stale spinner. 2 min comfortably clears codex's bounded N/5 retry
// cycle while bounding the worst-case stale state far below the 30-min default.
const RECONNECT_WATCHDOG_MS = 2 * 60 * 1000

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
    this._reconnectWatchdog = null // #6629 — bounded backstop for a wedged reconnect
    // #6638: per-session sandbox override (create_session `codexSandbox`) — wins
    // over CHROXY_CODEX_SANDBOX / the default. Applied at thread start.
    this._codexSandbox = opts.codexSandbox || null
    // #6638: fileChange item.changes cached by itemId, so a fileChange approval
    // (whose params carry NO diff) can surface WHAT will change. Cleared per turn.
    this._pendingFileChanges = new Map()
    this._attachDir = null // #6609 — lazily-created temp dir for materialized attachments

    // #6605 Phase 2 — surface codex approvals through the same PermissionManager
    // bridge SdkSession uses. wirePermissionManager re-emits permission_request /
    // permission_resolved / user_question on THIS session and back-links
    // _pendingPermissions/_lastPermissionData for ws-permissions.js.
    // #6794 — pass cwd so the protected-path floor can resolve relative tool
    // targets (.git/.claude/.env…) against this session's working directory.
    // #6771 — pass the durable rule store (persistent per-project allow-always).
    this._permissions = new PermissionManager({ log, cwd: this.cwd, ruleStore: this._permissionRuleStore })
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
    const sandbox = resolveCodexSandbox(this._codexSandbox)
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
    // #6629 — any notification that is NOT another `error` tick is genuine forward
    // progress: codex's response stream is live again, so disarm the reconnect
    // watchdog that #6623's suppression path may have armed. (A terminal `error`
    // clears it below on its way to _failTurn; a transient reconnect `error` re-arms it.)
    if (method !== 'error') this._clearReconnectWatchdog()
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
      case 'error': {
        // #6623 — codex emits transient `error` notifications WHILE its OWN retry
        // loop re-establishes a dropped response stream (a `Reconnecting... N/M`
        // message + `codexErrorInfo.responseStreamDisconnected`). This commonly
        // fires right after a permission / escalation round-trip stalls a shell
        // turn. These are NOT terminal: failing here surfaces a red provider error
        // and orphans the in-flight turn even though codex is still recovering and
        // may yet emit turn/completed. Keep the turn OPEN on a reconnect-in-progress
        // notification — the result timeout (re-armed by _resetResultTimeout above)
        // is the backstop if codex never recovers, and codex's terminal give-up
        // (a disconnect WITHOUT a reconnecting message) still falls through to fail.
        const err = this._errorPayload(params)
        if (this._isTransientReconnect(err)) {
          ;(this._log || log).warn(`codex app-server response stream reconnecting (turn kept open): ${err.message || 'responseStreamDisconnected'}`)
          // #6629 — arm the bounded watchdog so a reconnect that NEVER recovers
          // (nor emits codex's terminal give-up) still reconciles the stale
          // working state, even when a pending permission has paused the result
          // timeout. Re-arms on each reconnect tick so codex's legit N/5 retry
          // burst doesn't trip it mid-recovery.
          this._armReconnectWatchdog()
          break
        }
        this._clearReconnectWatchdog() // terminal error → about to fail; drop the backstop
        this._failTurn(`Codex error: ${JSON.stringify(params).slice(0, 200)}`)
        break
      }
      default:
        break // reasoning/plan/other items are ignored in Phase 1
    }
  }

  _onItemStarted(item) {
    if (!item) return
    // commandExecution / fileChange / mcpToolCall map to Chroxy tools. The
    // mcpToolCall EXECUTION is surfaced as a tool_start/tool_result so connector
    // tool calls are visible in the transcript (#6684 part 4). Note this is
    // transcript visibility only — a connector tool execution does not itself go
    // through the approval pipeline (that is the separate mcpServer/elicitation
    // request, #6635); see docs/design/codex-permission-model.md §8.
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
      const changes = item.changes ?? item.patch ?? null
      this.emit('tool_start', {
        messageId: this._activeTurn.messageId,
        toolUseId,
        tool: 'apply_patch',
        input: { changes },
      })
      this._trackToolStart(toolUseId, 'apply_patch')
      // #6638: remember the changes so a later fileChange approval (keyed by the
      // same itemId, but carrying no diff) can show what will change. Only cache a
      // non-null diff — a null-change item would just waste a slot and evict a real
      // diff earlier. Bounded: deleted on item completion / cleared per turn; evict
      // oldest at the cap.
      if (toolUseId != null && changes != null) {
        if (this._pendingFileChanges.size >= MAX_PENDING_FILE_CHANGES) {
          this._pendingFileChanges.delete(this._pendingFileChanges.keys().next().value)
        }
        this._pendingFileChanges.set(toolUseId, changes)
      }
    } else if (item.type === 'mcpToolCall') {
      // #6684: surface a connector tool EXECUTION in the transcript, labelled
      // `server/tool` (e.g. `github/create_issue`) so the source connector is
      // clear, with the call arguments as the input.
      const toolUseId = item.id
      const tool = this._mcpToolLabel(item)
      this.emit('tool_start', {
        messageId: this._activeTurn.messageId,
        toolUseId,
        tool,
        input: { server: item.server, tool: item.tool, arguments: item.arguments },
      })
      this._trackToolStart(toolUseId, tool)
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
      if (item.id != null) this._pendingFileChanges.delete(item.id) // #6638: done — release the cached diff
    } else if (item.type === 'mcpToolCall') {
      // #6684/#6712: emit the connector tool's output as a tool_result. A failed
      // call surfaces error.message as the result text AND flags `isError` (which
      // now round-trips the wire → clients style the error). Large output is
      // capped and flagged `truncated`.
      const { result, truncated } = this._summarizeMcpResult(item)
      const isError = item.status === 'failed' || item.error != null
      this.emit('tool_result', { toolUseId: item.id, result, truncated, isError })
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

  // #6684: `server/tool` label for an mcpToolCall (e.g. `github/create_issue`),
  // degrading to whichever of the two is present, else a generic `mcp`.
  _mcpToolLabel(item) {
    const server = typeof item?.server === 'string' ? item.server.trim() : ''
    const tool = typeof item?.tool === 'string' ? item.tool.trim() : ''
    if (server && tool) return `${server}/${tool}`
    return tool || server || 'mcp'
  }

  // #6684: reduce an mcpToolCall completion to a { result, truncated } tool_result
  // (the caller adds `isError` from the item status). Prefers the connector's
  // error message, then the MCP content array (text parts inline, non-text parts
  // as a `[type]` marker), then structuredContent, then the bare status so the
  // card is never blank. Text is bounded by MAX_MCP_RESULT_CHARS.
  _summarizeMcpResult(item) {
    if (item?.error && typeof item.error.message === 'string' && item.error.message) {
      return this._capMcpResult(item.error.message)
    }
    const content = item?.result?.content
    if (Array.isArray(content) && content.length > 0) {
      const text = content
        .map((c) => (c && typeof c.text === 'string' ? c.text : c && typeof c.type === 'string' ? `[${c.type}]` : null))
        .filter(Boolean)
        .join('\n')
      if (text) return this._capMcpResult(text)
    }
    if (item?.result?.structuredContent != null) {
      return this._capMcpResult(JSON.stringify(item.result.structuredContent))
    }
    return { result: item?.status ?? '', truncated: false }
  }

  // Cap the rendered text at MAX_MCP_RESULT_CHARS, signalling an over-cap slice via
  // the wire `truncated` flag (ServerToolResultSchema.truncated → store-core's
  // toolResultTruncated) rather than an in-band marker.
  _capMcpResult(text) {
    const s = String(text)
    if (s.length > MAX_MCP_RESULT_CHARS) {
      return { result: s.slice(0, MAX_MCP_RESULT_CHARS), truncated: true }
    }
    return { result: s, truncated: false }
  }

  _ensureStreamStart() {
    if (this._activeTurn.didStreamStart) return
    this._activeTurn.didStreamStart = true
    this.emit('stream_start', { messageId: this._activeTurn.messageId })
  }

  _mapUsage(params) {
    const u = params?.usage || params || {}
    const rawInput = nonNegInt(u.inputTokens ?? u.input_tokens)
    const cached = nonNegInt(u.cachedInputTokens ?? u.cached_input_tokens)
    return {
      // #6692: codex reports cached tokens as a SUBSET of input (OpenAI's
      // prompt_tokens_details convention; corroborated in-repo by the exec
      // path's context ratchet treating input_tokens as the full prompt —
      // codex-session.js). Chroxy's accounting keys are ADDITIVE (Anthropic
      // shape: input excludes cache reads), so split into uncached input +
      // cache_read. The subtraction is clamped, so a future codex build that
      // switched to additive reporting would undercount input rather than
      // go negative. Before this fix the cache count was emitted only under
      // `cached_input_tokens`, a key `_trackUsage` never reads — codex cache
      // tokens were silently dropped from cumulativeUsage.
      input_tokens: nonNegInt(rawInput - cached),
      output_tokens: nonNegInt(u.outputTokens ?? u.output_tokens),
      cache_read_input_tokens: cached,
      // Deprecated duplicate of cache_read_input_tokens — kept one release
      // for any external reader of the raw result payload (#6692).
      cached_input_tokens: cached,
    }
  }

  _finishTurn(turn) {
    if (!this._activeTurn) return
    const t = this._activeTurn
    this._clearResultTimeout()
    if (t.didStreamStart) this.emit('stream_end', { messageId: t.messageId })
    this._emitResult(
      {
        cost: null,
        duration: turn?.durationMs ?? null,
        usage: this._lastUsage,
        // #6692: single-model split (codex runs one model per session; cost
        // is unknown at the source — pricing happens downstream).
        modelUsage: synthesizeModelUsage(this.model, this._lastUsage),
        sessionId: this._threadId,
      },
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

  // #6629 — `code` lets the reconnect-watchdog surface its failure as
  // `error{code:'stream_stall'}` so clients reuse the existing recoverable-stall
  // retry chip (parity with SdkSession's stall recovery) instead of rendering a
  // bare, non-actionable error. An intentional stop still wins and reports `stopped`.
  _failTurn(message, { code } = {}) {
    this._clearResultTimeout()
    const t = this._activeTurn
    if (t?.didStreamStart) this.emit('stream_end', { messageId: t.messageId })
    const wasIntentional = this._consumeIntentionalStop()
    if (wasIntentional) this.emit('stopped', {})
    else this.emit('error', code ? { message, code } : { message })
    this._activeTurn = null
    this._endTurnAbort()
    this._clearMessageState()
    this._maybeDequeue()
  }

  // #6623 — codex's `error` notification carries the error under an `error` wrapper
  // in the wild ({ error: { message, codexErrorInfo, ... } }) but a bare shape
  // ({ message, ... }) elsewhere. Normalize to the inner error object either way so
  // the callers read one shape.
  _errorPayload(params) {
    return params?.error && typeof params.error === 'object' ? params.error : (params || {})
  }

  // #6623 — true iff this error is codex's OWN transient response-stream reconnect
  // (its retry loop is still running) rather than a terminal failure. Codex tags the
  // retry with BOTH `codexErrorInfo.responseStreamDisconnected` AND a
  // `Reconnecting... N/M` message; the terminal give-up drops the reconnecting
  // message (or is a different error entirely), so it still fails the turn. Gating
  // on both keeps the suppression conservative — anything not clearly a retry falls
  // through to _failTurn.
  _isTransientReconnect(err) {
    const info = err?.codexErrorInfo
    const disconnected = info && typeof info === 'object' && info.responseStreamDisconnected != null
    if (!disconnected) return false
    return /reconnect/i.test(typeof err?.message === 'string' ? err.message : '')
  }

  // #6638: also release cached fileChange diffs when per-turn state is cleared
  // (turn end / fail / destroy), so a diff can't outlive its turn.
  _clearMessageState() {
    super._clearMessageState()
    this._pendingFileChanges.clear()
    this._clearReconnectWatchdog() // #6629 — drop the reconnect backstop on any turn teardown
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

  // #6629 — bounded reconnect watchdog. Armed when #6623 keeps a turn open on a
  // transient response-stream reconnect; unlike the result timeout it is NOT
  // paused by a pending permission, so a codex that wedges mid-reconnect (never
  // recovers, never emits its terminal give-up) still reconciles the stale
  // working state promptly. Re-armed (clear + set) on each reconnect tick so
  // codex's legit multi-attempt retry burst doesn't trip it — it only fires
  // after a full window of silence following the last thing codex said. Disarmed
  // by any genuine forward-progress notification (recovery) and on turn teardown.
  _armReconnectWatchdog() {
    this._clearReconnectWatchdog()
    this._reconnectWatchdog = setTimeout(() => {
      this._reconnectWatchdog = null
      if (!this._activeTurn) return
      // #6629 — INTENTIONAL that this fires even while a permission prompt is
      // pending. The watchdog only arms on a genuine disconnect and is disarmed by
      // ANY forward-progress notification, so reaching this callback means codex
      // emitted no ticks and made no progress for the full window — the response
      // stream is genuinely wedged and the turn cannot complete regardless of the
      // pending approval. Failing cleanly (deny the pending approval via
      // _endTurnAbort + surface a recoverable stall) is the actionable outcome;
      // deliberately NOT firing during a pending permission would just restore the
      // #6629 indefinite-stale-state bug (the paused result timeout is exactly what
      // this watchdog exists to backstop). The user can retry to continue.
      ;(this._log || log).warn(`codex app-server response stream did not recover within ${RECONNECT_WATCHDOG_MS}ms — reconciling stale working state (#6629)`)
      this._failTurn('Codex response stream disconnected and did not recover — the turn was stopped. Retry to continue.', { code: 'stream_stall' })
    }, RECONNECT_WATCHDOG_MS)
    if (typeof this._reconnectWatchdog.unref === 'function') this._reconnectWatchdog.unref()
  }

  _clearReconnectWatchdog() {
    if (this._reconnectWatchdog) { clearTimeout(this._reconnectWatchdog); this._reconnectWatchdog = null }
  }

  // ------------------------------------------------------------------
  // Server → client requests (approvals) — routed into the permission pipeline
  // ------------------------------------------------------------------

  // Codex asks before running a command / editing a file (approvalPolicy
  // 'on-request'). All three approval families route through the PermissionManager:
  // command/file as decision enums, and the scope-escalation variant as a
  // permission-grant prompt (#6610). See docs/design/codex-permission-model.md.
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
    if (method === 'mcpServer/elicitation/request') {
      // A codex MCP server (connector, e.g. GitHub) is eliciting the user — most
      // commonly a write/action confirmation. Previously this fell through to the
      // -32601 decline below, so the connector approval was silently rejected and
      // "missed" (#6635). Surface it as an accept/decline prompt. NOTE: structured
      // form-content collection and interactive url-mode flows are a follow-up —
      // accept currently answers with the action only, no `content`.
      this._routeMcpElicitation(id, params)
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
      // #6638: the approval params carry no diff, so correlate to the fileChange
      // item's cached changes (same itemId) and surface WHAT changes — a paths
      // summary in the description (visible with no client change) + the raw
      // changes for a client that renders a diff.
      const changes = params?.itemId != null ? this._pendingFileChanges.get(params.itemId) ?? null : null
      const summary = this._summarizeFileChanges(changes)
      const description = summary
        ? (params?.reason ? `${params.reason} — ${summary}` : `Apply changes: ${summary}`)
        : (params?.reason || 'Apply file changes')
      return {
        tool: 'apply_patch',
        input: { description, file_path: params?.grantRoot, changes },
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

  // #6638: summarize a fileChange `changes` array (FileUpdateChange[] =
  // { path, kind, diff }) into a paths line for the approval prompt, e.g.
  // "2 files: src/a.js, src/b.js". Caps the list (+N more) so it stays bounded
  // for the ≤200-char prompt. Returns null when there's nothing to summarize.
  _summarizeFileChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return null
    const MAX = 3
    const paths = changes.map((c) => (c && typeof c.path === 'string' ? c.path : null)).filter(Boolean)
    if (paths.length === 0) return `${changes.length} file change(s)`
    const shown = paths.slice(0, MAX)
    const extra = paths.length - shown.length
    const list = shown.join(', ') + (extra > 0 ? `, +${extra} more` : '')
    return `${paths.length} file${paths.length === 1 ? '' : 's'}: ${list}`
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

  // Build the PermissionsRequestApprovalResponse. Approve → grant EXACTLY what codex
  // requested. RequestPermissionProfile and GrantedPermissionProfile share the same
  // {fileSystem?, network?} shape (the request is even additionalProperties:false), so
  // we reconstruct the grant from those two known fields rather than echoing the raw
  // request object: that grants precisely the requested scope while making a malformed
  // frame (an array — typeof [] === 'object' — or any unexpected key) structurally
  // unable to reach the wire and wedge the turn (#6612). Scope 'session' for an
  // "always allow" else 'turn'. Deny → an empty `permissions` object with `scope`
  // OMITTED (an explicit 'none' is an invalid PermissionGrantScope enum and wedges
  // the turn — #6612).
  _codexPermissionsGrant(allow, session, requestedPermissions) {
    if (!allow) return { permissions: {} }
    const src = requestedPermissions && typeof requestedPermissions === 'object' && !Array.isArray(requestedPermissions)
      ? requestedPermissions
      : {}
    const permissions = {}
    if (src.fileSystem !== undefined) permissions.fileSystem = src.fileSystem
    if (src.network !== undefined) permissions.network = src.network
    return { permissions, scope: session ? 'session' : 'turn' }
  }

  // Human-readable summary of the requested scope for the approval prompt, so the
  // operator sees WHAT codex wants to broaden before granting it. The prompt is
  // truncated to 200 chars downstream, so cap each list to a few entries + a
  // "+N more" tail (keeps the most-load-bearing detail — including the trailing
  // "network access" — from being sliced off) and stringify every path defensively.
  _describePermissionsRequest(params) {
    const MAX_ENTRIES = 3
    const summarize = (arr, render) => {
      const shown = arr.slice(0, MAX_ENTRIES).map(render)
      const extra = arr.length - shown.length
      return extra > 0 ? [...shown, `+${extra} more`] : shown
    }
    const parts = []
    const fs = params?.permissions?.fileSystem
    if (fs && typeof fs === 'object') {
      const entries = Array.isArray(fs.entries) ? fs.entries : []
      for (const p of summarize(entries, (e) => {
        const path = e?.path?.path ?? e?.path?.pattern ?? e?.path?.value?.kind ?? 'a path'
        return `filesystem ${e?.access ?? 'access'} → ${String(path)}`
      })) parts.push(p)
      if (Array.isArray(fs.read) && fs.read.length) parts.push(`filesystem read: ${summarize(fs.read, String).join(', ')}`)
      if (Array.isArray(fs.write) && fs.write.length) parts.push(`filesystem write: ${summarize(fs.write, String).join(', ')}`)
    }
    if (params?.permissions?.network?.enabled) parts.push('network access')
    const scope = parts.length ? parts.join('; ') : 'broader permissions'
    const reason = typeof params?.reason === 'string' && params.reason.trim()
      ? ` — ${params.reason.trim()}`
      : ''
    return `Codex is requesting to broaden its sandbox permissions${reason}: ${scope}`
  }

  // #6635: an MCP server (connector) is eliciting the user. Surface it as an
  // accept/decline prompt through the permission pipeline (was silently declined
  // with -32601, so a GitHub-connector write approval was "missed" and the tool
  // call rejected). The elicitation response is { action: accept|decline|cancel,
  // content? }; we answer with the action only — structured `content` collection
  // (form / openai/form modes) and interactive url-mode flows are a follow-up.
  async _routeMcpElicitation(rpcId, params) {
    let result
    try {
      const input = {
        description: this._describeMcpElicitation(params),
        serverName: params?.serverName ?? null,
        mode: params?.mode ?? null,
        // Surfaced so the client can show a url-mode elicitation's link.
        url: typeof params?.url === 'string' ? params.url : null,
        message: typeof params?.message === 'string' ? params.message : null,
      }
      // The sentinel is inert for this tool (unlike command/file/escalation, we
      // don't read updatedPermissions): an elicitation "allow" is a one-shot
      // accept, never a persisted rule — kept only for handlePermission symmetry.
      const suggestions = [{ codexApproval: 'mcpServer/elicitation/request' }]
      result = await this._permissions.handlePermission('mcp_elicitation', input, this._turnAbort?.signal, this.permissionMode, suggestions)
    } catch (err) {
      result = { behavior: 'deny', message: err?.message || 'permission error' }
    }
    const allow = result?.behavior === 'allow'
    // #6635: we can't collect structured `content` yet (#6684), so a form-mode
    // elicitation that REQUIRES fields is DECLINED even on allow — an action-only
    // accept could make the connector act on empty/default params the user never
    // saw. Confirmation-style (no required fields) + url-mode accept normally; a
    // decline is always the safe status quo (matches the pre-#6635 -32601 outcome).
    const action = allow && !this._elicitationRequiresContent(params) ? 'accept' : 'decline'
    this._client?.respond(rpcId, { action })
  }

  // True when accepting would need structured `content` we can't yet collect:
  // `openai/form` (freeform content) or a `form` whose schema declares required
  // properties. `url`-mode and content-less confirmation forms return false.
  _elicitationRequiresContent(params) {
    const mode = params?.mode
    if (mode === 'openai/form') return true
    if (mode !== 'form') return false
    const required = params?.requestedSchema?.required
    return Array.isArray(required) && required.length > 0
  }

  // Human-readable elicitation prompt: which connector is asking, and what for.
  _describeMcpElicitation(params) {
    const server = typeof params?.serverName === 'string' && params.serverName.trim()
      ? params.serverName.trim()
      : 'an MCP connector'
    const msg = typeof params?.message === 'string' && params.message.trim() ? params.message.trim() : ''
    const url = params?.mode === 'url' && typeof params?.url === 'string' && params.url.trim()
      ? ` (opens ${params.url.trim()})`
      : ''
    // Build the two shapes explicitly rather than post-cleaning whitespace: with a
    // message → `connector "x" asks: <msg>`, without → `connector "x": is requesting…`.
    return msg
      ? `Codex connector "${server}" asks: ${msg}${url}`
      : `Codex connector "${server}": is requesting your input${url}`
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

  // #6829 — permission-rule accessors, mirroring SdkSession/ByokSession. Codex's
  // PermissionManager already owns a rule store (seeded per-cwd in the ctor), but
  // without these thin wrappers a codex session's rules were invisible on the
  // wire: the `permission_rules_updated` broadcast (settings-handlers.js) and the
  // ws-history reconnect replay (ws-history.js) both gate on `getPermissionRules`
  // / `getPersistentPermissionRules`, and the projectRules re-seed calls
  // `setPersistentPermissionRules` — so on codex an allowAlways persisted at the
  // enforcement layer but never broadcast, replayed, or re-seeded. Session-rule
  // MUTATION (`setPermissionRules`) is intentionally NOT exposed so codex keeps
  // advertising `sessionRules:false` in the provider picker (providers.js derives
  // the capability from `setPermissionRules` presence); only the durable
  // project-rule read/replay surface is wired.

  /** Current session-scoped permission rules. Delegates to PermissionManager. */
  getPermissionRules() {
    if (typeof this._permissions.getRules === 'function') {
      return this._permissions.getRules()
    }
    return []
  }

  /**
   * #6771/#6829 — durable (project-scoped) permission rules applied to this
   * session, tagged `persist:'project'`. Delegates to PermissionManager.
   */
  getPersistentPermissionRules() {
    if (typeof this._permissions.getPersistentRules === 'function') {
      return this._permissions.getPersistentRules()
    }
    return []
  }

  /**
   * #6771/#6829 — re-seed this session's in-memory durable rule set (no persist;
   * the caller owns the store write). Delegates to PermissionManager.
   */
  setPersistentPermissionRules(rules) {
    if (typeof this._permissions.setPersistentRules === 'function') {
      this._permissions.setPersistentRules(rules)
    }
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
    this._clearReconnectWatchdog() // #6629 — never leave the reconnect timer armed past teardown
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
