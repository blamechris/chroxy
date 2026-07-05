import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { CodexSession, resolveCodexSandbox } from './codex-session.js'
import { CodexAppServerClient } from './codex-app-server-client.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger, loggerForSession } from './logger.js'

const log = createLogger('codex-app-server')

/**
 * Codex session driven through the `codex app-server` JSON-RPC protocol
 * (persistent process) instead of one-shot `codex exec --json` (see
 * codex-session.js). This is the foundation for surfacing codex's approval
 * requests through Chroxy's permission pipeline (epic #6605).
 *
 * PHASE 1 (this file) is the DRIVING LAYER only: it runs turns and maps the
 * app-server's streaming notifications onto Chroxy's standard event contract,
 * at behaviour-parity with the exec path. It uses `approvalPolicy: 'never'`
 * (codex runs commands within its sandbox without prompting, exactly like
 * `codex exec`), and does NOT yet surface approvals — `capabilities.permissions`
 * stays false. Phase 2 flips the policy to `on-request` and wires the
 * server → client approval RPC into a PermissionManager.
 *
 * Selected only when `CHROXY_CODEX_APPSERVER=1` (see providers.js `getProvider`);
 * otherwise the exec-based CodexSession is used, so this is a no-op by default.
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
      // Phase 1 is behaviour-parity with exec: no approval surfacing yet.
      // Phase 2 flips permissions/inProcessPermissions to true.
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: false,
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
      approvalPolicy: 'never', // Phase 1: sandboxed, no prompts (parity with exec)
      cwd: this.cwd,
      sandbox,
      ...(this.model ? { model: this.model } : {}),
    })
    this._threadId = started?.thread?.id || null
    this.resumeSessionId = this._threadId
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
    this._armResultTimeout()
    ;(this._log || log).info(`codex app-server turn start (msg=${messageId} thread=${this._threadId})`)
    try {
      const res = await this._client.request('turn/start', {
        threadId: this._threadId,
        approvalPolicy: 'never',
        input: [{ type: 'text', text: prompt || '' }],
      })
      if (this._activeTurn && !this._activeTurn.turnId) this._activeTurn.turnId = res?.turn?.id || null
    } catch (err) {
      // turn/start itself failed (dead server, bad thread) — fail this turn.
      this._failTurn(`Codex turn failed to start: ${err.message}`)
    }
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
    this._clearMessageState()
    this._maybeDequeue()
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
  // Server → client requests (approvals). Phase 1: not enabled.
  // ------------------------------------------------------------------

  _onServerRequest({ id, method }) {
    // With approvalPolicy:'never' the server should not ask; if it does (future
    // codex behaviour / a policy we didn't set), decline cleanly rather than
    // wedge the turn. Phase 2 routes these into the permission pipeline.
    ;(this._log || log).warn(`codex app-server unexpected serverRequest ${method} — declining (approvals land in Phase 2)`)
    this._client?.respondError(id, -32601, 'approvals not enabled (Chroxy Phase 1)')
  }

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
    if (this._client && this._activeTurn?.turnId) {
      try { await this._client.request('turn/interrupt', { threadId: this._threadId, turnId: this._activeTurn.turnId }) }
      catch (err) { (this._log || log).debug(`turn/interrupt failed: ${err.message}`) }
    }
  }

  async destroy() {
    this._destroying = true
    this.clearOutgoingQueue({ emit: false })
    this._clearIntentionalStop()
    this._clearResultTimeout()
    try { this._client?.kill() } catch { /* already gone */ }
    this._client = null
    this._activeTurn = null
    this._clearMessageState()
    this._destroyPendingBackgroundShells()
    this._processReady = false
    this.removeAllListeners()
  }
}
