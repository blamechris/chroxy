/**
 * Config-driven ACP (Agent Client Protocol) provider (#7319, part of the
 * #7304/#7306 ACP-interop tranche).
 *
 * `AcpSession` spawns an arbitrary ACP-speaking agent over stdio and holds
 * the connection open for the LIFETIME of the chroxy session — one child
 * process, many turns, with `initialize` and `session/new` happening once at
 * start(). This mirrors `codex-app-server-session.js` (`CodexAppServerSession
 * extends BaseSession`), NOT `jsonl-subprocess-session.js`, whose `spawn()`
 * call sits inside `sendMessage()` and therefore starts a NEW child per
 * message — the wrong shape for a persistent JSON-RPC agent connection. The
 * `@agentclientprotocol/sdk` package (added by #7318) supplies the JSON-RPC
 * framing itself (`ndJsonStream` + `client()`), so unlike
 * `codex-app-server-client.js` there is no need for a hand-rolled transport
 * layer here — this file IS the driving layer.
 *
 * Permissions ship HARDWIRED TO DENY ALL: `capabilities.inProcessPermissions`
 * is false (so `validateProviderClass` does not require
 * `respondToPermission`/`respondToQuestion` — see providers.js), and every
 * `session/request_permission` the agent sends is answered with a rejection
 * option by `_denyAllPermission`. That is a legal, safe, fully-testable
 * intermediate state; #7320 wires the real permission bridge.
 *
 * Translation onto Chroxy's EXISTING outbound session events only (no new
 * `@chroxy/protocol` wire types in this PR — see docs on `_onSessionUpdate`):
 *   - `agent_message_chunk`         → stream_start / stream_delta / stream_end
 *   - `agent_thought_chunk`         → stream_start / stream_delta / stream_end (thinking:true)
 *   - `tool_call` / `tool_call_update` (terminal status only) → tool_start / tool_result
 *   - `StopReason`                  → result (or stopped/error for a cancelled turn)
 *   - `plan` / `available_commands_update` / `current_mode_update` — DROPPED.
 *     None of these map onto an existing outbound event; a new one would drag
 *     in ~3 separate protocol coverage guards (#7319 issue body), so they are
 *     explicitly deferred to a follow-up rather than absorbed here.
 *
 * Protocol version is pinned to v1 (`acp.PROTOCOL_VERSION`, the stable
 * `@agentclientprotocol/sdk` root export) — `./experimental/v2` and the other
 * `experimental/*` subpaths are never imported.
 */
import { spawn } from 'child_process'
import { Readable, Writable } from 'stream'
import * as acp from '@agentclientprotocol/sdk'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { prepareSpawn } from './utils/win-spawn.js'
import { guardChildStreams } from './child-stream-guard.js'
import { killProcessTree } from './platform.js'
import { getChroxyHostEnv } from './chroxy-host-metadata.js'
import { CHROXY_SECRET_DENYLIST } from './utils/spawn-env.js'
import { validateAcpProviders } from './acp-config.js'
import { registerProvider, getRegisteredProviderNames } from './providers.js'
import { BILLING_CLASSES } from './billing-class.js'
import { createLogger, loggerForSession } from './logger.js'

const log = createLogger('acp-session')

// Cap on the rendered tool_result text (mirrors codex-app-server-session.js's
// MAX_MCP_RESULT_CHARS) — a tool_call_update's content array can carry an
// arbitrarily large diff/output blob; bound it so a single tool_result can't
// balloon the transcript or the persisted history ring.
const MAX_TOOL_RESULT_CHARS = 10_000

// Cap on captured stderr (diagnostics only — surfaced in a spawn/exit error).
const STDERR_CAP = 2000

/**
 * Build the child's environment for a configured ACP agent. Full parent env
 * (an ACP agent is a real CLI tool that generally needs PATH/HOME/etc., same
 * posture as the 'claude' denylist branch in spawn-env.js) minus Chroxy's own
 * daemon secrets (#6311's floor — must never reach ANY spawned child,
 * regardless of provider), plus Chroxy's host-identity metadata, plus the
 * entry's configured `env` overrides last (highest precedence — the whole
 * point of the config knob, e.g. to hand the agent its OWN provider API key).
 *
 * @param {Record<string,string>} configuredEnv
 * @returns {Record<string,string>}
 */
function buildAcpChildEnv(configuredEnv) {
  const env = { ...process.env }
  for (const key of CHROXY_SECRET_DENYLIST) delete env[key]
  return { ...env, ...getChroxyHostEnv(), ...configuredEnv }
}

/**
 * Reduce a `tool_call`/`tool_call_update`'s `content` array (ToolCallContent[])
 * to a `{ result, truncated }` tool_result pair. `content` items are one of
 * `{type:'content', content: ContentBlock}`, `{type:'diff', path, ...}`, or
 * `{type:'terminal', terminalId}` — text content blocks render verbatim,
 * everything else renders a short marker (fs/terminal bridging — reading a
 * diff's full text or a terminal's live output — is deferred to #7306).
 *
 * @param {Array<object>|null|undefined} content
 * @returns {{ result: string, truncated: boolean }}
 */
function summarizeToolCallContent(content) {
  if (!Array.isArray(content) || content.length === 0) return { result: '', truncated: false }
  const parts = []
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'content') {
      const block = entry.content
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type) parts.push(`[${block.type}]`)
    } else if (entry.type === 'diff') {
      parts.push(`diff: ${typeof entry.path === 'string' ? entry.path : '(unknown path)'}`)
    } else if (entry.type === 'terminal') {
      parts.push('[terminal output]')
    }
  }
  const text = parts.join('\n')
  if (text.length > MAX_TOOL_RESULT_CHARS) return { result: text.slice(0, MAX_TOOL_RESULT_CHARS), truncated: true }
  return { result: text, truncated: false }
}

/**
 * Create an AcpSession subclass for one validated config entry (the
 * `createAnthropicCompatibleSessionClass` shape — a class-factory closing
 * over the entry, stamped out once per configured agent by
 * `registerAcpProviders`).
 *
 * @param {object} rawEntry - `{ id, label?, command, args?, env? }`
 * @returns {typeof AcpSession}
 */
export function createAcpSessionClass(rawEntry) {
  if (typeof rawEntry !== 'object' || rawEntry === null || typeof rawEntry.id !== 'string' || rawEntry.id.length === 0) {
    throw new Error('createAcpSessionClass requires an entry with a non-empty id')
  }
  if (typeof rawEntry.command !== 'string' || rawEntry.command.length === 0) {
    throw new Error(`acp entry '${rawEntry.id}' requires a command`)
  }

  // Defensive normalization (no-op for validateAcpProviders output).
  const entry = Object.freeze({
    id: rawEntry.id,
    label: typeof rawEntry.label === 'string' && rawEntry.label.length > 0 ? rawEntry.label : rawEntry.id,
    command: rawEntry.command,
    args: Object.freeze(Array.isArray(rawEntry.args) ? rawEntry.args.filter((a) => typeof a === 'string') : []),
    env: Object.freeze(
      rawEntry.env && typeof rawEntry.env === 'object' && !Array.isArray(rawEntry.env) ? { ...rawEntry.env } : {},
    ),
  })

  class AcpSession extends BaseSession {
    static get providerName() { return entry.id }
    static get displayLabel() { return entry.label }
    // No `~/.claude`-style local data-dir dependency — pure stdio to the
    // configured agent. getProviderDataDirs() skips providers returning null.
    static get dataDir() { return null }
    static get messageIdPrefix() { return 'acp' }
    static get apiKeyEnv() { return null }

    /** The validated config entry this class was built from (introspection/tests). */
    static get acpEntry() { return entry }

    static get capabilities() {
      return {
        // #7319 ships permissions hardwired to deny-all — no operator-facing
        // permission flow exists yet, so `permissions` is false (mirrors
        // gemini-session.js's "no permission surface at all" convention
        // rather than codex/CLI's "surfaced, in-process or hook-routed"
        // true). #7320 flips both this and inProcessPermissions on.
        permissions: false,
        inProcessPermissions: false,
        // The spawned agent picks its own model; Chroxy has no visibility or
        // control over it in this PR.
        modelSwitch: false,
        permissionModeSwitch: false,
        planMode: false,
        resume: false,
        // fs/* and terminal/* client methods are not implemented yet — #7306.
        terminal: false,
        thinkingLevel: false,
        streaming: true,
      }
    }

    // The spawned agent manages its OWN authentication (OAuth, its own API
    // key, whatever it needs) — chroxy has no credential to check, so start()
    // never has a "missing env var" reason to refuse.
    static hasAlternativeCredentials() { return true }

    static get preflight() {
      return {
        label: entry.label,
        credentials: { envVars: [], hint: '', optional: true },
      }
    }

    static resolveAuth() {
      return {
        ready: true,
        source: 'none',
        envVar: null,
        envVars: [],
        hint: '',
        detail: `${entry.label} — spawns "${entry.command}" (ACP agent manages its own authentication)`,
        // External agent, billed against whatever credential IT holds —
        // never chroxy's own subscription/credit pool (#5630 convention).
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }

    // No model concept Chroxy can see or control (the agent picks its own).
    // null/[] read as "not applicable" (mirrors dataDir's null convention),
    // not "zero models allowed".
    static getFallbackModels() { return [] }
    static getAllowedModels() { return null }
    static getModelMetadata() { return null }

    constructor(opts = {}) {
      // #5367 canonical picker — forward every BaseSession opt.
      super(buildBaseSessionOpts(opts, { provider: opts.provider || entry.id }))
      this._acpEntry = entry
      this._child = null
      this._connection = null
      this._sessionId = null
      // { messageId, thinkingMessageId, didStreamStart } — null between turns.
      this._activeTurn = null
    }

    _buildChildEnv() { return buildAcpChildEnv(this._acpEntry.env) }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    async start() {
      const entryRef = this._acpEntry
      let child
      try {
        const spawnSpec = prepareSpawn(entryRef.command, entryRef.args)
        child = spawn(spawnSpec.command, spawnSpec.args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this._buildChildEnv(),
          ...spawnSpec.options,
        })
      } catch (err) {
        throw new Error(`Failed to spawn ACP agent "${entryRef.label}" (${entryRef.command}): ${err.message}`)
      }
      this._child = child

      let stderrTail = ''
      child.stderr?.on('data', (chunk) => {
        if (stderrTail.length < STDERR_CAP) stderrTail += chunk.toString().slice(0, STDERR_CAP - stderrTail.length)
      })
      // #5324/#5361 pattern — an EPIPE/read-fault on stdout/stderr with no
      // listener would otherwise crash the whole daemon.
      guardChildStreams(child, { destroying: () => this._destroying, log, label: entryRef.id })
      child.on('exit', (code, signal) => this._onChildExit(code, signal, stderrTail))
      child.on('error', (err) => this._onChildError(err))

      const output = Writable.toWeb(child.stdin)
      const input = Readable.toWeb(child.stdout)
      const stream = acp.ndJsonStream(output, input)

      // Registered BEFORE connecting — a request/notification can arrive the
      // instant the child starts talking.
      const app = acp.client({ name: 'chroxy' })
        .onNotification(acp.CLIENT_METHODS.session_update, (ctx) => this._onSessionUpdate(ctx.params))
        // Trampoline (not a direct bound reference) so a test double can
        // override `session._denyAllPermission` on the INSTANCE and have it
        // take effect — the lookup happens at call time, not registration
        // time. See acp-session.test.js's guard-proof test.
        .onRequest(acp.CLIENT_METHODS.session_request_permission, (ctx) => this._denyAllPermission(ctx))

      let connection
      try {
        connection = app.connect(stream)
        // We only use this to avoid an unhandled-rejection warning on an
        // abnormal close; child.on('exit'/'error') above is the authoritative
        // signal for reporting an unexpected teardown to the session (see
        // _onChildExit/_onChildError) — hooking .closed too would double-fire.
        connection.closed.catch(() => {})
        this._connection = connection

        await connection.agent.request(acp.AGENT_METHODS.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'chroxy', version: '1' },
        })
        const newSession = await connection.agent.request(acp.AGENT_METHODS.session_new, {
          cwd: this.cwd,
          mcpServers: [],
        })
        this._sessionId = newSession?.sessionId || null
      } catch (err) {
        this._connection = null
        this._child = null
        try { killProcessTree(child) } catch { /* already gone */ }
        throw new Error(`Failed to initialize ACP agent "${entryRef.label}": ${err.message}`)
      }

      this._processReady = true
      this._log = loggerForSession('acp', this._sessionId || entryRef.id)
      ;(this._log || log).info(`ACP agent ready (id=${entryRef.id} pid=${child.pid} session=${this._sessionId})`)
      this.emit('ready', { model: this.model })
    }

    async sendMessage(prompt, attachments, sendOptions = {}) {
      if (this._isBusy) {
        this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
        return
      }
      if (!this._processReady || !this._connection) {
        this.emit('error', { message: 'ACP session is not started' })
        return
      }
      if (Array.isArray(attachments) && attachments.length > 0) {
        // #7319 scope: attachment → ACP ContentBlock mapping (image/resource)
        // is not implemented yet. Refuse loudly rather than silently drop the
        // user's files, mirroring JsonlSubprocessSession's attachment refusal.
        this.emit('error', {
          message: `${this.constructor.displayLabel} does not support attachments yet`,
        })
        return
      }

      this._isBusy = true
      this._messageCounter += 1
      const messageId = `msg-${this._messageIdPrefix}-${this._messageCounter}`
      this._currentMessageId = messageId
      // Captured locally so a stale response (a promise that resolves AFTER a
      // timeout/interrupt/destroy already ended this turn) can be detected
      // and ignored below, instead of re-processing a turn that already ended.
      const turn = { messageId, thinkingMessageId: null, didStreamStart: false }
      this._activeTurn = turn
      this._armResultTimeout()

      let res
      try {
        res = await this._connection.agent.request(acp.AGENT_METHODS.session_prompt, {
          sessionId: this._sessionId,
          prompt: [{ type: 'text', text: prompt || '' }],
        })
      } catch (err) {
        if (this._activeTurn !== turn) return
        this._failTurn(`ACP agent error: ${err.message}`)
        return
      }
      if (this._activeTurn !== turn) return
      this._finishTurn(res)
    }

    // ------------------------------------------------------------------
    // session/update → Chroxy event mapping
    // ------------------------------------------------------------------

    _onSessionUpdate(params) {
      if (!this._activeTurn) return // between turns: ignore stray updates
      if (params?.sessionId && this._sessionId && params.sessionId !== this._sessionId) return
      this._resetResultTimeout()
      const update = params?.update
      if (!update) return
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          this._onAgentMessageChunk(update)
          break
        case 'agent_thought_chunk':
          this._onAgentThoughtChunk(update)
          break
        case 'tool_call':
          this._onToolCall(update)
          break
        case 'tool_call_update':
          this._onToolCallUpdate(update)
          break
        default:
          // user_message_chunk / plan / plan_update / plan_removed /
          // available_commands_update / current_mode_update / config_option_update /
          // session_info_update / usage_update / compaction_* — no matching
          // existing outbound event (see the file-header doc). Dropped in #7319.
          break
      }
    }

    _onAgentMessageChunk(update) {
      const text = update?.content?.type === 'text' ? update.content.text : ''
      if (!text) return
      const t = this._activeTurn
      if (!t.didStreamStart) {
        t.didStreamStart = true
        this.emit('stream_start', { messageId: t.messageId })
      }
      this.emit('stream_delta', { messageId: t.messageId, delta: text })
    }

    _onAgentThoughtChunk(update) {
      const text = update?.content?.type === 'text' ? update.content.text : ''
      if (!text) return
      const t = this._activeTurn
      if (!t.thinkingMessageId) {
        t.thinkingMessageId = `${t.messageId}-thinking`
        this.emit('stream_start', { messageId: t.thinkingMessageId, thinking: true })
      }
      this.emit('stream_delta', { messageId: t.thinkingMessageId, delta: text, thinking: true })
    }

    _onToolCall(update) {
      const toolUseId = update?.toolCallId
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
      const t = this._activeTurn
      if (!t.openToolCalls) t.openToolCalls = new Set()
      t.openToolCalls.add(toolUseId)
      const tool = update.kind || update.name || 'tool'
      this.emit('tool_start', {
        messageId: t.messageId,
        toolUseId,
        tool,
        input: { title: update.title, kind: update.kind, rawInput: update.rawInput, locations: update.locations },
      })
      this._trackToolStart(toolUseId, tool)
    }

    _onToolCallUpdate(update) {
      const toolUseId = update?.toolCallId
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
      const status = update.status
      // Non-terminal progress updates (pending/in_progress) have no matching
      // existing outbound event — only a completed/failed update closes the
      // tool_start opened above (or synthesizes one, for a nonconformant
      // agent that updates before it ever opened the call).
      if (status !== 'completed' && status !== 'failed') return
      const t = this._activeTurn
      if (!t.openToolCalls || !t.openToolCalls.has(toolUseId)) {
        this._onToolCall({ toolCallId: toolUseId, title: update.title, kind: update.kind, name: update.name, rawInput: update.rawInput, locations: update.locations })
      }
      t.openToolCalls.delete(toolUseId)
      const { result, truncated } = summarizeToolCallContent(update.content)
      this.emit('tool_result', { toolUseId, result, truncated, isError: status === 'failed' })
      this._trackToolResult(toolUseId)
    }

    // ------------------------------------------------------------------
    // Turn completion
    // ------------------------------------------------------------------

    _closeOpenStreams(t) {
      if (!t) return
      if (t.didStreamStart) this.emit('stream_end', { messageId: t.messageId })
      if (t.thinkingMessageId) this.emit('stream_end', { messageId: t.thinkingMessageId })
    }

    /**
     * `session/prompt` resolved. `StopReason` (`end_turn` / `max_tokens` /
     * `max_turn_requests` / `refusal` / `cancelled`) maps onto Chroxy's
     * existing turn-boundary events: `cancelled` — OR any turn that resolved
     * while `interrupt()`'s intentional-stop flag was armed, regardless of
     * what the agent reported — is a `stopped`/`error` exactly like every
     * other provider's interrupt path; everything else is a normal `result`.
     * The other three reasons (`max_tokens`/`max_turn_requests`/`refusal`)
     * have no dedicated wire signal anywhere in this codebase today (the SDK
     * provider doesn't distinguish a max-turns stop from a clean one either)
     * — inventing one here would be exactly the protocol-surface growth the
     * issue asks to avoid, so they read as a normal completed turn; any
     * explanation the agent gave already streamed as ordinary assistant text.
     */
    _finishTurn(res) {
      const t = this._activeTurn
      this._clearResultTimeout()
      this._closeOpenStreams(t)
      this._activeTurn = null
      const wasIntentional = this._consumeIntentionalStop()
      const stopReason = res?.stopReason
      if (wasIntentional || stopReason === 'cancelled') {
        if (wasIntentional) this.emit('stopped', {})
        else this.emit('error', { message: 'The agent turn was cancelled.' })
        this._clearMessageState()
        this._maybeDequeue()
        return
      }
      this._emitResult(
        { cost: null, duration: null, usage: null, sessionId: this._sessionId },
        'turn_ended_with_orphan_tool_start',
      )
      this._clearIntentionalStop()
      this._clearMessageState()
      this._maybeDequeue()
    }

    _failTurn(message, { code } = {}) {
      const t = this._activeTurn
      this._clearResultTimeout()
      this._closeOpenStreams(t)
      this._activeTurn = null
      const wasIntentional = this._consumeIntentionalStop()
      if (wasIntentional) this.emit('stopped', {})
      else this.emit('error', code ? { message, code } : { message })
      this._clearMessageState()
      this._maybeDequeue()
    }

    _maybeDequeue() {
      if (this._outgoingQueue.length && !this._destroying) this.dequeueNextOutgoing()
    }

    // ------------------------------------------------------------------
    // Result timeout (soft warning only — mirrors codex-app-server-session.js;
    // no hard-timeout / stream-stall machinery, which even that reference
    // doesn't implement).
    // ------------------------------------------------------------------

    _armResultTimeout() {
      this._clearResultTimeout()
      this._resultTimeout = setTimeout(() => {
        ;(this._log || log).warn(`ACP agent turn result timeout (msg=${this._currentMessageId})`)
        this._failTurn('ACP agent turn timed out with no result')
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
    // Permissions — hardwired to deny-all (#7319). #7320 replaces this with
    // the real PermissionManager bridge.
    // ------------------------------------------------------------------

    /**
     * Answer a `session/request_permission` request with a rejection. Picks a
     * `reject_once` (preferred — the most locally-scoped decline) or
     * `reject_always` option from whatever the agent offered; falls back to
     * the protocol-legal `{outcome:'cancelled'}` if the agent offered no
     * reject option at all (defensive — every real ACP agent offers one).
     *
     * @param {{params: import('@agentclientprotocol/sdk').RequestPermissionRequest}} ctx
     */
    async _denyAllPermission(ctx) {
      const options = Array.isArray(ctx?.params?.options) ? ctx.params.options : []
      const reject = options.find((o) => o?.kind === 'reject_once') || options.find((o) => o?.kind === 'reject_always')
      const toolCallId = ctx?.params?.toolCall?.toolCallId ?? 'unknown'
      ;(this._log || log).info(
        `ACP permission request denied by default (toolCallId=${toolCallId}) — the permission bridge lands in #7320`,
      )
      if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } }
      return { outcome: { outcome: 'cancelled' } }
    }

    // ------------------------------------------------------------------
    // Child / connection teardown
    // ------------------------------------------------------------------

    _onChildExit(code, signal, stderrTail) {
      if (this._destroying) return
      this._processReady = false
      const detail = `code=${code}${signal ? ` signal=${signal}` : ''}`
      ;(this._log || log).warn(`ACP agent "${this._acpEntry.id}" exited unexpectedly (${detail})`)
      const tail = stderrTail ? `: ${stderrTail.slice(0, 500)}` : ''
      const message = `ACP agent "${this._acpEntry.label}" exited unexpectedly (${detail})${tail}`
      if (this._activeTurn) this._failTurn(message)
      else this.emit('error', { message, recoverable: true })
    }

    _onChildError(err) {
      if (this._destroying) return
      this._processReady = false
      const message = `Failed to run ACP agent "${this._acpEntry.label}": ${err.message}`
      if (this._activeTurn) this._failTurn(message)
      else this.emit('error', { message })
    }

    // ------------------------------------------------------------------
    // Interrupt / teardown
    // ------------------------------------------------------------------

    async interrupt() {
      this.clearOutgoingQueue()
      this.markIntentionalStop()
      if (this._connection && this._sessionId) {
        try { await this._connection.agent.notify(acp.AGENT_METHODS.session_cancel, { sessionId: this._sessionId }) }
        catch (err) { (this._log || log).debug(`session/cancel notify failed: ${err.message}`) }
      }
    }

    async destroy() {
      this._destroying = true
      this.clearOutgoingQueue({ emit: false })
      this._clearIntentionalStop()
      this._clearResultTimeout()
      this._activeTurn = null
      if (this._connection) {
        try { this._connection.close() } catch { /* already gone */ }
        this._connection = null
      }
      if (this._child) {
        try { killProcessTree(this._child) } catch { /* already gone */ }
        this._child = null
      }
      this._clearMessageState()
      this._destroyPendingBackgroundShells()
      this._processReady = false
      this.removeAllListeners()
    }
  }

  return AcpSession
}

/**
 * Register every valid `providers.acp` entry from the merged config as a
 * first-class provider (#7319) — one registered provider per configured
 * agent, mirroring `registerAnthropicCompatibleProviders`. Called once at
 * server startup (server-cli.js).
 *
 * Invalid entries are logged and skipped; valid siblings still register.
 * Collisions are checked against both the static RESERVED_PROVIDER_IDS and
 * the LIVE registry at call time.
 *
 * @param {object | null | undefined} config - Merged server config
 * @returns {string[]} The provider ids that were registered
 */
export function registerAcpProviders(config) {
  const block = config?.providers
  // Legacy form: `providers` as an array of provider-id strings
  // (informational, written by `chroxy init`) — nothing to register.
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return []
  if (!Object.prototype.hasOwnProperty.call(block, 'acp')) return []

  const { entries, warnings } = validateAcpProviders(block.acp, {
    reservedIds: getRegisteredProviderNames(),
  })
  for (const warning of warnings) {
    log.warn(warning)
  }

  const registered = []
  for (const entry of entries) {
    registerProvider(entry.id, createAcpSessionClass(entry))
    registered.push(entry.id)
    log.info(
      `ACP provider registered: ${entry.id} → ${entry.command}${entry.args.length ? ` ${entry.args.join(' ')}` : ''} (permissions: deny-all)`,
    )
  }
  return registered
}
