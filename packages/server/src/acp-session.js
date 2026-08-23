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
import { BaseSession, buildBaseSessionOpts, CHROXY_CONTEXT_HINT_TEXT } from './base-session.js'
import { prepareSpawn } from './utils/win-spawn.js'
import { guardChildStreams } from './child-stream-guard.js'
import { killProcessTree } from './platform.js'
import { getChroxyHostEnv } from './chroxy-host-metadata.js'
import { CHROXY_SECRET_DENYLIST, STANDARD_ALLOWLIST } from './utils/spawn-env.js'
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

// #7319 review — grace window between SIGTERM and SIGKILL on teardown. The
// configured `command` is entirely operator-chosen and unvetted (unlike the
// four binaries chroxy itself resolves), so nothing guarantees it honors
// SIGTERM; a no-op handler would otherwise leave it running indefinitely,
// inheriting the daemon's own environment. Matches byok-mcp-client.js's
// destroy()-teardown grace exactly (KILL_GRACE_MS).
const ACP_KILL_GRACE_MS = 1000

// #7319 review — grace window given to `child.on('exit')` to win the race
// against `connection.closed` and report the informative code/signal message
// (see `_onConnectionClosed`) before falling back to the generic "connection
// closed" message. Both fire off the same underlying process teardown in the
// common case (near-simultaneously); this is generous enough for that ORDER
// to settle while still being a rounding error against the wedge it exists to
// unstick (previously: forever).
const CONNECTION_CLOSED_GRACE_MS = 250

/**
 * Build the child's environment for a configured ACP agent.
 *
 * ALLOWLIST posture (#7319 review), not denylist: `spawn-env.js`'s own header
 * comment states the rule this file previously got backwards — allowlist mode
 * is for THIRD-PARTY providers so operator secrets never reach them; denylist
 * is for the first-party Claude CLI only. An ACP agent's `command` is entirely
 * operator-chosen and unvetted — the least-trusted binary in the registry, not
 * the most — so it starts from `STANDARD_ALLOWLIST` (PATH/HOME/locale/etc,
 * the same baseline codex/gemini use) plus Chroxy's host-identity metadata,
 * plus the entry's configured `env` overrides (highest precedence — the whole
 * point of the config knob, e.g. to hand the agent its OWN provider API key).
 *
 * Chroxy's own daemon secrets (`CHROXY_SECRET_DENYLIST`, #6311's floor) are
 * stripped LAST, after `configuredEnv` is merged — not just from the ambient
 * allowlisted env — so a `providers.acp[].env` entry can never smuggle one
 * back in either. This is the one place that floor is enforced against an
 * OPERATOR-supplied input, not just an ambient one, and it must actually hold
 * for the claim below to be true rather than aspirational.
 *
 * @param {Record<string,string>} configuredEnv
 * @returns {Record<string,string>}
 */
function buildAcpChildEnv(configuredEnv) {
  const env = {}
  for (const key of STANDARD_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const merged = { ...env, ...getChroxyHostEnv(), ...configuredEnv }
  for (const key of CHROXY_SECRET_DENYLIST) delete merged[key]
  return merged
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
      // { messageId, thinkingMessageId, didStreamStart, openToolCalls,
      //   toolCallContent } — null between turns.
      this._activeTurn = null
      // #7319 review — inject the combined skills/preamble prefix once, on
      // turn 1 (mirrors codex-app-server-session.js's #6606 fix).
      this._skillsPrepended = false
      // #7319 review — dedup so a dying child's `connection.closed` and
      // `child.on('exit')` (which both fire off the same underlying process
      // teardown) don't each independently report the same failure.
      this._teardownReported = false
      this._connectionClosedGraceTimer = null
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
        // #7319 review — child.on('exit'/'error') is NOT actually the sole
        // authoritative teardown signal: an agent can close stdout (ending
        // the stream, which settles `connection.closed`) while staying alive
        // — no exit, no error, ever. Left unconsumed, that wedges the session
        // "ready" forever with no path back to a working turn. Route it
        // through the SAME dedup'd teardown path as child.on('exit') so
        // EITHER signal — whichever actually fires — reports exactly once.
        connection.closed
          .then(() => this._onConnectionClosed())
          .catch((err) => this._onConnectionClosed(err))
        this._connection = connection

        const init = await connection.agent.request(acp.AGENT_METHODS.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'chroxy', version: '1' },
        })
        // #7319 review — the schema says the client SHOULD disconnect if the
        // negotiated version isn't one it supports. We only ever OFFER v1;
        // enforce that we also GOT v1 back rather than silently proceeding
        // against an agent that negotiated something else.
        if (init?.protocolVersion !== acp.PROTOCOL_VERSION) {
          throw new Error(
            `negotiated protocol version ${init?.protocolVersion} — chroxy only supports v${acp.PROTOCOL_VERSION}`,
          )
        }
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

      // #7319 review — ACP has no system-prompt channel, so the first-turn
      // message is the ONLY vehicle for the session preamble, the chroxy
      // context hint, and any loaded skill (mirrors codex-app-server-
      // session.js's #6606 fix for the identical "no system channel" shape).
      // Flipped to true only AFTER the request succeeds so a failed first
      // turn still retries with the prefix (jsonl-subprocess-session.js's
      // discipline for the same flag).
      let text = prompt || ''
      const willPrependFirstTurn = !this._skillsPrepended
      if (willPrependFirstTurn) {
        const prefix = this._buildFirstTurnPrefix()
        if (prefix) text = `${prefix}\n\n---\n\n${text}`
      }

      let res
      try {
        res = await this._connection.agent.request(acp.AGENT_METHODS.session_prompt, {
          sessionId: this._sessionId,
          prompt: [{ type: 'text', text }],
        })
        if (willPrependFirstTurn) this._skillsPrepended = true
      } catch (err) {
        if (this._activeTurn !== turn) return
        this._failTurn(`ACP agent error: ${err.message}`)
        return
      }
      if (this._activeTurn !== turn) return
      this._finishTurn(res)
    }

    /**
     * The combined first-turn prefix: session preamble, then the chroxy
     * context hint, then every loaded skill (prepend + append/system buckets
     * combined — `_buildCombinedSkillsPrefix()` already de-duplicates those
     * two buckets for a provider with no separate system-prompt channel; do
     * NOT also call `_buildSystemPrompt()`, whose OWN skillsText source is
     * the same append bucket and would double-inject it). Same ordering as
     * `_buildSystemPrompt()` for consistency. Empty string when nothing is
     * configured, so the `sendMessage` caller can branch on truthiness.
     *
     * @returns {string}
     */
    _buildFirstTurnPrefix() {
      const parts = []
      if (this.sessionPreamble) parts.push(this.sessionPreamble)
      if (this.chroxyContextHint) parts.push(CHROXY_CONTEXT_HINT_TEXT)
      const skills = typeof this._buildCombinedSkillsPrefix === 'function' ? this._buildCombinedSkillsPrefix() : ''
      if (skills) parts.push(skills)
      return parts.join('\n\n')
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

    // #7319 review — `ToolCall.status` is OPTIONAL and schema-legal to
    // already be terminal on the VERY FIRST message about a call (only
    // `toolCallId` + `title` are required); the SDK's own example agent
    // always splits open/close into two messages, which is what the original
    // implementation silently assumed. Ignoring `update.status` here left a
    // tool_call that arrives pre-completed open for the rest of the turn, so
    // the turn-end orphan sweep (BaseSession._sweepUnresolvedToolStarts)
    // synthesized a FALSE "did not emit a result" failure for a tool that
    // actually succeeded. Close immediately when the initial message is
    // already terminal, exactly as if a separate tool_call_update had
    // followed it.
    _onToolCall(update) {
      const toolUseId = update?.toolCallId
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
      const t = this._activeTurn
      if (!t.openToolCalls) t.openToolCalls = new Set()
      t.openToolCalls.add(toolUseId)
      this._rememberToolCallContent(t, toolUseId, update.content)
      const tool = update.kind || update.name || 'tool'
      this.emit('tool_start', {
        messageId: t.messageId,
        toolUseId,
        tool,
        input: { title: update.title, kind: update.kind, rawInput: update.rawInput, locations: update.locations },
      })
      this._trackToolStart(toolUseId, tool)
      if (update.status === 'completed' || update.status === 'failed') {
        this._closeToolCall(toolUseId, update.status)
      }
    }

    _onToolCallUpdate(update) {
      const toolUseId = update?.toolCallId
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
      const t = this._activeTurn
      this._rememberToolCallContent(t, toolUseId, update.content)
      const status = update.status
      // Non-terminal progress updates (pending/in_progress) have no matching
      // existing outbound event beyond remembering their content above —
      // only a completed/failed update closes the tool_start opened earlier
      // (or synthesizes one, for a nonconformant agent that updates before
      // it ever opened the call).
      if (status !== 'completed' && status !== 'failed') return
      if (!t.openToolCalls || !t.openToolCalls.has(toolUseId)) {
        this._onToolCall({ toolCallId: toolUseId, title: update.title, kind: update.kind, name: update.name, rawInput: update.rawInput, locations: update.locations })
        // The synthetic open above carries no `status`, so it never
        // self-closes — fall through and close with the status we actually
        // received.
      }
      this._closeToolCall(toolUseId, status)
    }

    // #7319 review — `ToolCallUpdate`'s fields are ALL optional except
    // `toolCallId` ("only changed fields need to be included" — the schema's
    // own words), so a terminal update legitimately omits `content` when it
    // didn't change since an earlier tick (e.g. content arrives on an
    // in-progress update, then a bare `status:'completed'` follows with no
    // content of its own). Remembering the latest non-empty content per
    // toolCallId and reading it back here means a contentless terminal
    // update can never blank out real output that already arrived.
    _rememberToolCallContent(t, toolUseId, content) {
      if (!t.toolCallContent) t.toolCallContent = new Map()
      if (Array.isArray(content) && content.length > 0) t.toolCallContent.set(toolUseId, content)
    }

    _closeToolCall(toolUseId, status) {
      const t = this._activeTurn
      if (!t.openToolCalls || !t.openToolCalls.has(toolUseId)) return // already closed
      t.openToolCalls.delete(toolUseId)
      const content = t.toolCallContent?.get(toolUseId) ?? null
      t.toolCallContent?.delete(toolUseId)
      const { result, truncated } = summarizeToolCallContent(content)
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

    /**
     * Single choke point for reporting an UNEXPECTED teardown, from whichever
     * signal actually fires first (#7319 review — `child.on('exit')` and
     * `connection.closed` both stem from the same underlying process death in
     * the common case, with no ordering guarantee between them; an agent that
     * closes stdout while staying alive fires ONLY `connection.closed`, never
     * `exit`). `_teardownReported` makes this report exactly once regardless
     * of which signal(s) fire, or in which order.
     */
    _reportTeardown(message, { recoverable = true } = {}) {
      if (this._destroying || this._teardownReported) return
      this._teardownReported = true
      this._processReady = false
      if (this._activeTurn) this._failTurn(message)
      else this.emit('error', { message, recoverable })
    }

    _onChildExit(code, signal, stderrTail) {
      if (this._destroying) return
      const detail = `code=${code}${signal ? ` signal=${signal}` : ''}`
      ;(this._log || log).warn(`ACP agent "${this._acpEntry.id}" exited unexpectedly (${detail})`)
      const tail = stderrTail ? `: ${stderrTail.slice(0, 500)}` : ''
      this._reportTeardown(`ACP agent "${this._acpEntry.label}" exited unexpectedly (${detail})${tail}`)
    }

    _onChildError(err) {
      if (this._destroying) return
      this._reportTeardown(`Failed to run ACP agent "${this._acpEntry.label}": ${err.message}`)
    }

    /**
     * `connection.closed` settled — either because WE closed it (destroy(),
     * guarded by `_destroying` above), the child exited (child.on('exit')
     * fires too; whichever of the two gets here first wins via
     * `_teardownReported`), or — the case this handler exists to catch — the
     * agent closed stdout while remaining alive, which `child.on('exit')`
     * never sees at all.
     *
     * Deferred by a short grace window rather than reported immediately: if
     * `child.on('exit')` is ALSO about to fire (the common case), it carries
     * the useful exit code/signal and should win the race and report that
     * instead of this generic message. Reporting synchronously here would
     * make the generic message win essentially every time (stdout 'end'
     * tends to observably precede the 'exit' event), producing a double
     * report — the exact defect a prior version of this file had (#7319
     * review finding #10).
     */
    _onConnectionClosed(err) {
      if (this._destroying || this._teardownReported) return
      const detail = err ? `: ${err.message}` : ''
      this._connectionClosedGraceTimer = setTimeout(() => {
        this._connectionClosedGraceTimer = null
        this._reportTeardown(`ACP agent "${this._acpEntry.label}" connection closed unexpectedly${detail}`)
      }, CONNECTION_CLOSED_GRACE_MS)
      if (typeof this._connectionClosedGraceTimer.unref === 'function') this._connectionClosedGraceTimer.unref()
    }

    // ------------------------------------------------------------------
    // Interrupt / teardown
    // ------------------------------------------------------------------

    /**
     * #7319 review — `markIntentionalStop()` and the `session/cancel` notify
     * are gated behind an ACTIVE turn (mirrors SdkSession.interrupt(),
     * sdk-session.js:1844: "return early when no query is active").
     * `clearOutgoingQueue()` stays unconditional either way, matching that
     * same method — a deliberate Stop should always cancel queued follow-ups,
     * even with nothing currently running.
     *
     * Without the guard, tapping Stop between turns (input-handlers.js calls
     * interrupt() with no busy check) armed the flag with no active turn to
     * consume it — `_finishTurn` is the ONLY consumer, so the flag sat armed
     * until the NEXT turn's clean `end_turn` completion, which then read it
     * as an intentional stop and emitted `stopped` with no `result` event at
     * all for a turn nobody interrupted.
     */
    async interrupt() {
      this.clearOutgoingQueue()
      if (!this._activeTurn) return
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
      if (this._connectionClosedGraceTimer) { clearTimeout(this._connectionClosedGraceTimer); this._connectionClosedGraceTimer = null }
      this._activeTurn = null
      if (this._connection) {
        try { this._connection.close() } catch { /* already gone */ }
        this._connection = null
      }
      if (this._child) {
        await this._killChildWithGrace(this._child)
        this._child = null
      }
      this._clearMessageState()
      this._destroyPendingBackgroundShells()
      this._processReady = false
      this.removeAllListeners()
    }

    /**
     * #7319 review — a bare `killProcessTree()` is a SIGTERM-only request on
     * POSIX (platform.js): it relies on the child actually honoring the
     * signal. This provider's binary is entirely operator-chosen and
     * unvetted (verified: an agent with a no-op SIGTERM handler was still
     * alive 4.2s later) — an orphan here inherits the daemon's own
     * environment, the expensive kind of leak. Escalate to SIGKILL after a
     * short grace window, mirroring byok-mcp-client.js's destroy() teardown.
     * Resolves once the child actually exits, or once the grace window
     * elapses and SIGKILL is sent — whichever comes first.
     *
     * @param {import('child_process').ChildProcess} child
     * @returns {Promise<void>}
     */
    _killChildWithGrace(child) {
      // Already exited (e.g. the child died on its own — _onChildExit
      // already ran — and destroy() is only now cleaning up) — nothing to
      // signal or wait out. Node never replays a past 'exit' to a listener
      // attached after the fact, so without this check we'd needlessly burn
      // the full grace window waiting on an event that will never fire.
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(graceTimer)
          resolve()
        }
        child.once('exit', finish)
        try { killProcessTree(child) } catch { /* already gone */ }
        const graceTimer = setTimeout(() => {
          try { killProcessTree(child, { force: true }) } catch { /* already gone */ }
          finish()
        }, ACP_KILL_GRACE_MS)
        if (typeof graceTimer.unref === 'function') graceTimer.unref()
      })
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
