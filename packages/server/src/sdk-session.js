import { query } from '@anthropic-ai/claude-agent-sdk'
import { join } from 'path'
import { homedir } from 'os'
import { updateModels, saveModelsCache, updateContextWindow, getModels, FALLBACK_MODELS, ALLOWED_MODEL_IDS, claudeDeriveId, resolveClaudeContextWindow } from './models.js'
import { BaseSession } from './base-session.js'
import { buildContentBlocks } from './content-blocks.js'
import { MessageTransformPipeline } from './message-transform.js'
import { emitToolResults } from './tool-result.js'
import { parseMcpToolName } from './mcp-tools.js'
import { createLogger } from './logger.js'
import { PermissionManager } from './permission-manager.js'
import { formatBytes } from './utils/format-bytes.js'
import { formatIdleDuration } from './session-timeout-manager.js'

const log = createLogger('sdk')

/**
 * Manages a Claude Code session using the Agent SDK.
 *
 * Same EventEmitter interface as CliSession so SessionManager and WsServer
 * work identically regardless of which session type is in use.
 *
 * Key advantages over CliSession:
 *   - In-process permission handling via canUseTool (no HTTP hook pipeline)
 *   - setModel/setPermissionMode work live without process restart
 *   - One query() call per user message, SDK manages conversation state
 *
 * Events emitted (identical to CliSession):
 *   ready        { sessionId, model, tools }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   message      { type, content, timestamp }
 *   tool_start   { messageId, tool, input }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 *   permission_request { requestId, tool, description, input }
 *   user_question      { toolUseId, questions }
 *   agent_spawned      { toolUseId, description, startedAt }
 *   agent_completed    { toolUseId }
 *   tool_result        { toolUseId, result, truncated }
 */

// Default max accumulated size for tool_use input (~256KB)
const DEFAULT_MAX_TOOL_INPUT_LENGTH = 262144

// Marker stamped on a proc the first time _attachSidecarProcessListeners()
// wires its default listeners (#3504 review).  Subsequent calls on the same
// proc short-circuit instead of attaching duplicate listeners — without this
// guard a re-wiring caller (resume/reconnect path, future K8s session class
// re-spawning into the same proc) would emit N copies of every warn-log.
// Symbol-keyed so it cannot collide with consumer code or test stubs.
const SIDECAR_LISTENERS_ATTACHED = Symbol('sdk-session.sidecarListenersAttached')

// Cumulative byte threshold for escalating stdin_dropped to error (#3506).
// Defaults to 10 MiB — equivalent to ten full pre-dial-cap chunks.  Once the
// running total of dropped bytes meets or exceeds this, a single error log
// is emitted (one-shot per crossing) so operators triaging "why did my
// prompt vanish?" get a loud signal even on a flood of small drops.
export const STDIN_DROPPED_BYTES_ERROR_THRESHOLD = 10 * 1024 * 1024

// Drop-count cadence for re-escalating stdin_dropped to error (#3506).
// In addition to the byte threshold, every Nth drop event is logged at error
// level so a stream of zero-byte / unknown-size drops still raises a loud
// signal.  Set to 10 to balance signal-to-noise.
export const STDIN_DROPPED_ESCALATION_EVERY_N = 10

// Minimum interval between refused-sendMessage warn logs (#3575).
// PR #3560 (#3539) added a warn on every refused sendMessage when
// `_stdinForwardingDisabled` is latched, but a stuck client retrying in a
// hot loop floods operator logs with the same line. The per-call `error`
// event still fires every time so client UI feedback is unaffected — only
// the log line is gated. 30s balances visibility ("the session is still
// stuck") with noise control.
export const REFUSED_SENDMESSAGE_WARN_INTERVAL_MS = 30 * 1000

export class SdkSession extends BaseSession {
  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'Claude Code (SDK)'
  }

  /**
   * Root data directory for this provider (#2965).
   * Consumers (conversation-scanner, ws-file-ops) use this to locate
   * provider-specific subdirs (projects/, agents/, commands/) without
   * hardcoding the path.
   */
  static get dataDir() {
    return join(homedir(), '.claude')
  }

  static get capabilities() {
    return {
      permissions: true,
      inProcessPermissions: true,
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: false,
      resume: true,
      terminal: false,
      thinkingLevel: true,
      // #3932: explicit `streaming` so the capability matrix is uniform across
      // providers — claude-tui sets this to false (deliver-on-complete), all
      // others stream incremental deltas via stream_delta during a turn.
      streaming: true,
      // #3209/#3246: SDK rebuilds systemPrompt.append on every turn
      // (see sdk-session.js#_callQuery), so a runtime toggle of
      // _activeManualSkills + _loadSkills() takes effect on the next
      // user message. Subprocess providers don't get this for free —
      // they snapshot the skills text at session start.
      skillToggle: true,
    }
  }

  /**
   * Custom event names this provider emits beyond the BaseSession defaults.
   *
   * #3544: `stdin_dropped_totals` carries the cumulative running total of
   * bytes dropped at the SidecarProcess pre-dial cap so operators (mobile
   * users, dashboard-only operators) who can't tail the server log still
   * see how much input has been silently lost. SessionManager forwards
   * customEvents as transient session_events — they aren't recorded in
   * history and aren't replayed on reconnect, but the cumulative counters
   * are session-lifetime so a fresh emit on the next drop re-publishes
   * the running total.
   *
   * @returns {string[]}
   */
  static get customEvents() {
    return ['stdin_dropped_totals']
  }

  /**
   * #3209: SDK is the only provider that rebuilds the system prompt
   * each turn, so manual-skill toggles propagate to the wire here.
   * Subprocess providers (CliSession, CodexSession, GeminiSession)
   * inherit the BaseSession default of `false`.
   */
  supportsRuntimeSkillToggle() {
    return true
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   * SDK mode spawns the `claude` binary under the hood, so the same
   * binary check applies. Credentials can come from ANTHROPIC_API_KEY,
   * CLAUDE_CODE_OAUTH_TOKEN, or a prior `claude login` subscription.
   */
  static get preflight() {
    return {
      label: 'Claude SDK',
      binary: {
        name: 'claude',
        args: ['--version'],
        candidates: [
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
        ],
        installHint: 'install Claude Code CLI (required by the Agent SDK)',
      },
      credentials: {
        envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        hint: 'run `claude login` or set ANTHROPIC_API_KEY',
        optional: true,
      },
    }
  }

  /**
   * Minimal model list for the per-provider registry (#2956). The live
   * Agent SDK push (`supportedModels()`) replaces this at runtime; the
   * fallback ships only short aliases so the dropdown is never empty
   * before the first SDK response arrives.
   */
  static getFallbackModels() {
    return FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  /**
   * Claude-style metadata: strip the `claude-` prefix for the short id,
   * reuse the shared context-window heuristic. Used by the per-provider
   * registry for both lookup and validation (#2956).
   *
   * The registry calls this with the full model id as returned by the SDK
   * (e.g. 'claude-sonnet-4-6'). Short alias resolution is intentionally
   * left to the caller — the registry always has the fullId available.
   *
   * @param {string} modelId - Full model id (e.g. 'claude-sonnet-4-6').
   * @returns {{id:string,label:string,fullId:string,contextWindow:number,description?:string}|null}
   */
  static getModelMetadata(modelId) {
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    const fullId = modelId
    const id = claudeDeriveId(fullId)
    return {
      id,
      label: id,
      fullId,
      contextWindow: resolveClaudeContextWindow(fullId),
      description: '',
    }
  }

  /** Token budgets for thinking levels. null = adaptive (SDK default). */
  static THINKING_BUDGETS = { default: null, high: 32000, max: 128000 }

  /** Error patterns mapped to user-friendly messages. */
  static _ERROR_PATTERNS = [
    { test: /credit|billing|quota|usage.limit/i,
      msg: 'Insufficient API credits or billing limit reached. Check your API provider dashboard.' },
    { test: /rate.limit|too many requests|429/i,
      msg: 'API rate limit exceeded. Please wait a moment and try again.' },
    { test: /authentication|invalid.api.key|401|unauthorized/i,
      msg: 'API authentication failed. Check your API key configuration.' },
    { test: /overloaded|503|529|temporarily unavailable/i,
      msg: 'The API is temporarily overloaded. Please try again in a few minutes.' },
    { test: /SIGABRT|SIGKILL|SIGSEGV|terminated by signal/i,
      msg: 'Claude Code process crashed. This is often caused by API errors (insufficient credits, invalid key, or rate limits). Check your API provider dashboard.' },
  ]

  static _enrichErrorMessage(raw) {
    if (!raw) return 'Unknown error'
    for (const { test, msg } of SdkSession._ERROR_PATTERNS) {
      if (test.test(raw)) return msg
    }
    return raw
  }

  get thinkingLevel() { return this._thinkingLevel }

  constructor({ cwd, model, permissionMode, resumeSessionId, transforms, maxToolInput, sandbox, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider, activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, chroxyContextHint, stdinForwardingDisabled, resultTimeoutMs, hardTimeoutMs } = {}) {
    super({ cwd, model, permissionMode, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider: provider || 'claude-sdk', activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, chroxyContextHint, resultTimeoutMs, hardTimeoutMs })
    this._maxToolInput = maxToolInput || DEFAULT_MAX_TOOL_INPUT_LENGTH
    this._transformPipeline = new MessageTransformPipeline(transforms || [])
    this._sandbox = sandbox || null

    this._sdkSessionId = resumeSessionId || null
    this._sessionId = null
    this._query = null
    this._thinkingLevel = null
    this._pendingInput = []

    // Permission handling — delegated to PermissionManager
    this._permissions = new PermissionManager({ log })
    this._permissions.on('permission_request', (data) => {
      // Pause the inactivity timer: waiting on user input is NOT inactivity.
      // Without this, sessions with pending permissions silently go
      // unresponsive after 5 min (#2831). Pause/resume uses a reference
      // count so concurrent prompts correctly keep the timer suspended
      // until the last one is resolved.
      this._pauseResultTimeoutForPermission()
      this.emit('permission_request', data)
    })
    this._permissions.on('user_question', (data) => {
      this._pauseResultTimeoutForPermission()
      this.emit('user_question', data)
    })
    this._permissions.on('permission_resolved', (data) => {
      this._resumeResultTimeoutForPermission()
      // #3048: re-emit so the unified pipeline (SessionManager → ws-forwarding
      // → EventNormalizer → broadcast) can fan out the resolution to every
      // connected client.
      //
      // #3736: also re-emit AskUserQuestion resolutions (which carry
      // `toolUseId` instead of `requestId`) so the EventNormalizer can prune
      // the questionSessionMap entry. Pre-fix this branch was silently
      // dropped and the question map leaked one entry per timeout/abort/clear.
      // The EventNormalizer + ws-forwarding handle both shapes; the
      // permission-audit listener in ws-server.js gates on `data.requestId`
      // and ignores the question variant.
      if (data && (data.requestId || data.toolUseId)) {
        this.emit('permission_resolved', data)
      }
    })

    // Backward-compatible accessors (used by ws-permissions.js, settings-handlers.js)
    this._pendingPermissions = this._permissions._pendingPermissions
    this._lastPermissionData = this._permissions._lastPermissionData

    // Permission pause bookkeeping for _resultTimeout (#2831)
    this._permissionPauseCount = 0
    this._resultTimeoutPaused = false
    this._resetResultTimeout = null

    // stdin_dropped accounting (#3506) — every chunk dropped at the
    // SidecarProcess pre-dial cap accumulates here so operators can
    // see the running cost of dropped input.  The default listener
    // (see _attachSidecarProcessListeners) escalates to an error log
    // on the first drop, every Nth drop, and when the cumulative byte
    // total crosses STDIN_DROPPED_BYTES_ERROR_THRESHOLD.  Subsequent
    // drops fall back to warn so a hot-loop drop flood doesn't spam.
    this._stdinDroppedBytesTotal = 0
    this._stdinDroppedCount = 0
    this._stdinDroppedThresholdLogged = false

    // #3540: SESSION-STICKY stdin_disabled flag (latched by the
    // _attachSidecarProcessListeners 'stdin_disabled' handler, see #3501).
    // Initialised here so SessionManager.serializeState can read the field
    // unconditionally and so a hydrated value from restoreState survives
    // until the next process tick.  The metadata field is the canonical
    // signal for restored sessions: clients connecting after restart see
    // the disabled state in session_list / listSessions, no replayed
    // `error` event needed (the original event already fired and was
    // proxied; cold restart treats the persisted flag as authoritative).
    this._stdinForwardingDisabled = !!stdinForwardingDisabled

    // #3575: rate-limit the refused-sendMessage warn log. A stuck client that
    // retries on every error event would otherwise flood operator logs with
    // the same line on every attempt. Tracks the last Date.now() that the
    // refusal warn fired; the warn is gated on
    // `now - _lastRefusedWarnTs >= REFUSED_SENDMESSAGE_WARN_INTERVAL_MS`.
    // The per-call `error` event still fires on every refused sendMessage so
    // client UI feedback is unaffected.
    this._lastRefusedWarnTs = 0
  }

  get sessionId() {
    return this._sessionId
  }

  /** Public accessor for the SDK session ID used to resume conversations. */
  get resumeSessionId() {
    return this._sdkSessionId
  }

  /**
   * Public accessor for the cumulative stdin_dropped totals (#3544).
   *
   * Returns a snapshot of the session-lifetime counters maintained by
   * `_attachSidecarProcessListeners`. Operators can poll this from a test
   * client or session-info handler; the same numbers are published as a
   * `stdin_dropped_totals` session_event whenever a fresh drop arrives.
   *
   * @returns {{ bytes: number, count: number }}
   */
  get stdinDroppedTotals() {
    return {
      bytes: this._stdinDroppedBytesTotal,
      count: this._stdinDroppedCount,
    }
  }


  /**
   * Start the SDK session. Creates the long-lived streaming input generator
   * and begins the query loop.
   */
  start() {
    this._processReady = true
    log.info('Ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })
  }

  /**
   * Send a message to Claude via the Agent SDK.
   * Each call creates a new query() with resume to maintain conversation.
   */
  async sendMessage(prompt, attachments, sendOptions = {}) {
    // #3539: once `_stdinForwardingDisabled` latches (see #3502/#3402), any
    // further sendMessage calls would be silently dropped on the SidecarProcess
    // PassThrough — the user sees a hung turn instead of an error. Refuse the
    // write up front, surface the same machine-readable `code: 'stdin_disabled'`
    // contract that #3502 established, and drain any queued follow-ups so the
    // post-finally dequeue path (#3541) does not re-trigger writes after the
    // flag flips. Decision: one-shot reject (per-call). The session is
    // unrecoverable until restart, so queueing for "flush on resume" would only
    // hide the problem; clients must handle the error and prompt for restart.
    if (this._stdinForwardingDisabled) {
      // #3575: rate-limit the refused-sendMessage warn so a stuck client
      // retrying in a hot loop does not flood operator logs. The per-call
      // `error` event below still fires on every attempt — only the log line
      // is gated. The "Discarding queued follow-ups" warn is also gated by
      // this same window because it only ever fires alongside the refusal
      // warn (one drain per latch transition).
      const now = Date.now()
      const warnSuppressed = (now - this._lastRefusedWarnTs) < REFUSED_SENDMESSAGE_WARN_INTERVAL_MS
      if (!warnSuppressed) {
        log.warn(
          'Refusing sendMessage — stdin forwarding is disabled for this session; ' +
          'restart the session to recover'
        )
        this._lastRefusedWarnTs = now
      }
      // Drop any messages that piled up in the queue while the flag was
      // flipping. Without this, the post-turn dequeue would call
      // sendMessage(...) once per queued item and emit one error per message —
      // noisy, and pointless because none of them can be sent.
      if (this._pendingInput?.length) {
        if (!warnSuppressed) {
          log.warn(
            `Discarding ${this._pendingInput.length} queued follow-up message(s) — ` +
            'stdin forwarding is disabled'
          )
        }
        this._pendingInput.length = 0
      }
      this.emit('error', {
        code: 'stdin_disabled',
        message: 'Cannot send message — stdin forwarding is disabled; restart this session',
        recoverable: false,
      })
      return
    }

    if (this._isBusy) {
      // Queue the message — it will be sent after the current turn completes
      if (!this._pendingInput) this._pendingInput = []
      this._pendingInput.push({ prompt, attachments, sendOptions })
      log.info(`Queued follow-up message (${this._pendingInput.length} pending)`)
      return
    }

    // Apply message transforms if configured
    let transformedPrompt = prompt
    if (this._transformPipeline.hasTransforms && typeof prompt === 'string') {
      transformedPrompt = this._transformPipeline.apply(prompt, {
        cwd: this.cwd,
        model: this.model,
        isVoiceInput: !!sendOptions.isVoice,
        platform: process.platform,
      })
    }

    this._isBusy = true
    this._messageCounter++
    // `msg-{bootPrefix}-{counter}` — see BaseSession constructor for why
    // the boot-unique prefix is needed (#3700). Format change does not
    // affect the wire schema; clients treat messageId as opaque string.
    const messageId = `msg-${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId
    // Shared ref so _handleResultTimeout can observe the latest value
    // when it fires (the timer was armed when hasStreamStarted was still
    // false, but the turn may have streamed before the timeout landed).
    const streamState = { hasStreamStarted: false }
    let didStreamText = false

    const sdkPermMode = this._sdkPermissionMode()
    // Skills MVP (#2957) — append shared skills via SDK systemPrompt.append.
    // Per-skill injection mode (#3200): the append bucket flows through
    // systemPrompt.append; the prepend bucket is concatenated onto the
    // first user message, once per session.
    const skillsText = this._buildSystemPrompt()
    const systemPrompt = { type: 'preset', preset: 'claude_code' }
    if (skillsText) {
      systemPrompt.append = skillsText
    }
    // Don't flip `_skillsPrepended` until _callQuery() has accepted the
    // prompt (#3225). If the call throws synchronously — bad SDK args,
    // missing claude binary in DockerSdkSession's spawnClaudeCodeProcess,
    // etc. — the prepend bucket needs to ride on the next attempt.
    let firstMessagePrefix = ''
    let willPrependSkills = false
    if (!this._skillsPrepended) {
      const prependText = typeof this._buildPrependPrompt === 'function'
        ? this._buildPrependPrompt()
        : ''
      if (prependText) {
        firstMessagePrefix = `${prependText}\n\n---\n\n`
      }
      willPrependSkills = true
    }
    const options = {
      cwd: this.cwd,
      permissionMode: sdkPermMode,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt,
      tools: { type: 'preset', preset: 'claude_code' },
    }

    // SDK requires this flag when using bypassPermissions
    if (sdkPermMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true
    }

    if (this.model) {
      options.model = this.model
    }

    // Apply thinking level if set
    if (this._thinkingLevel) {
      const budget = SdkSession.THINKING_BUDGETS[this._thinkingLevel]
      if (budget != null) options.maxThinkingTokens = budget
    }

    // Sandbox settings (lightweight isolation without Docker)
    if (this._sandbox) {
      options.sandbox = this._sandbox
    }

    // In-process permission handling (only when not bypassing).
    // We forward the SDK-provided `suggestions` to the permission manager
    // so the 'allow always' flow can echo them back via updatedPermissions.
    // Without this, respondToPermission('allowAlways') had nothing to
    // attach to the PermissionResult — and worse, the 2026-04-11 audit
    // (Skeptic) found the old code passed behavior:'allowAlways' which
    // isn't a valid PermissionResult.behavior (SDK only accepts
    // 'allow'|'deny'). The correct shape per the SDK's "always allow"
    // documentation is { behavior: 'allow', updatedPermissions:
    // <suggestions from callback options> }.
    if (this.permissionMode !== 'auto') {
      options.canUseTool = (toolName, input, { signal, suggestions }) =>
        this._handlePermission(toolName, input, signal, suggestions)
    }

    // Resume existing session if we have one
    if (this._sdkSessionId) {
      options.resume = this._sdkSessionId
    }

    // Safety timeouts: SOFT warning + HARD cap, both armed on every SDK
    // event. Soft fires `inactivity_warning` (session stays alive);
    // hard fires the existing kill path (force-clear, auto-deny
    // pending perms, emit error). Both paused while a permission
    // prompt is outstanding (#2831) — awaiting user input is not
    // inactivity. Both windows configurable per server (#3749 / #3899)
    // — see BaseSession.
    const SOFT_TIMEOUT_MS = this._resultTimeoutMs
    const HARD_TIMEOUT_MS = this._hardTimeoutMs
    const resetResultTimeout = () => {
      if (this._resultTimeout) clearTimeout(this._resultTimeout)
      if (this._hardTimeout) clearTimeout(this._hardTimeout)
      this._resultTimeout = null
      this._hardTimeout = null
      if (this._resultTimeoutPaused) return
      this._resultTimeout = setTimeout(() => {
        this._resultTimeout = null
        this._handleInactivityWarning(messageId)
      }, SOFT_TIMEOUT_MS)
      this._hardTimeout = setTimeout(() => {
        this._hardTimeout = null
        this._handleHardTimeout(messageId, streamState.hasStreamStarted)
      }, HARD_TIMEOUT_MS)
    }
    this._resetResultTimeout = resetResultTimeout
    resetResultTimeout()

    try {
      // Allow subclasses to augment query options (e.g. DockerSdkSession
      // injects spawnClaudeCodeProcess here)
      this._augmentQueryOptions(options)

      // If attachments present, build multimodal content blocks
      const promptWithSkills = firstMessagePrefix
        ? `${firstMessagePrefix}${transformedPrompt}`
        : transformedPrompt
      const queryArgs = { prompt: promptWithSkills, options }
      if (attachments?.length) {
        queryArgs.prompt = buildContentBlocks(promptWithSkills, attachments)
      }
      this._query = this._callQuery(queryArgs)

      // _callQuery returned an iterable without throwing — the prepend
      // bucket is committed to this turn's prompt, so flip the flag (#3225).
      // If _callQuery threw synchronously, control falls into the catch
      // below with the flag still false, ensuring the next retry
      // re-includes the prepend skills.
      if (willPrependSkills) {
        this._skillsPrepended = true
      }

      for await (const msg of this._query) {
        if (this._destroying) break
        resetResultTimeout() // Any SDK event = activity, reset inactivity timer

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init') {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
              // #3687: persist the actual model the SDK booted with so
              // sendSessionInfo (replay on reconnect / tab switch) reports
              // the truth instead of `null` when the user didn't specify a
              // model.
              if (typeof msg.model === 'string' && msg.model) {
                this.bootedModel = msg.model
              }
              log.info(`Session initialized: ${msg.session_id} (model: ${msg.model})`)
              this.emit('ready', {
                sessionId: msg.session_id,
                model: msg.model,
                tools: msg.tools || [],
              })
              // Emit MCP server status if present (including empty list to clear stale state)
              if (Array.isArray(msg.mcp_servers)) {
                if (msg.mcp_servers.length > 0) {
                  log.info(`MCP servers: ${msg.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ')}`)
                }
                this.emit('mcp_servers', { servers: msg.mcp_servers })
              }
              // Fetch dynamic model list from SDK (non-blocking)
              this._fetchSupportedModels()
            } else {
              // Forward non-init system events (e.g. /usage, /cost, other
              // slash command responses) as system messages to the client
              const text = msg.message || msg.text || msg.subtype || 'System event'
              log.info(`System event (${msg.subtype || 'unknown'}): ${typeof text === 'string' ? text.slice(0, 120) : text}`)
              this.emit('message', {
                type: 'system',
                content: text,
                timestamp: Date.now(),
              })
            }
            break
          }

          case 'stream_event': {
            // Handle partial message events (content_block_start/delta/stop)
            const event = msg.event
            if (!event) break

            switch (event.type) {
              case 'content_block_start': {
                const blockType = event.content_block?.type
                if (blockType === 'text') {
                  if (!streamState.hasStreamStarted) {
                    streamState.hasStreamStarted = true
                    this.emit('stream_start', { messageId })
                  }
                } else if (blockType === 'tool_use') {
                  // Reuse a single derived toolId for both fields so the wire
                  // schema (`ServerToolStartSchema.toolUseId: z.string()`)
                  // holds even on the defensive fallback path. Mirrors
                  // cli-session.js.
                  const toolId = event.content_block.id || `${messageId}-tool`
                  const toolStartData = {
                    messageId: toolId,
                    toolUseId: toolId,
                    tool: event.content_block.name,
                    input: null,
                  }
                  const mcp = parseMcpToolName(event.content_block.name)
                  if (mcp) toolStartData.serverName = mcp.serverName
                  this.emit('tool_start', toolStartData)
                }
                break
              }

              case 'content_block_delta': {
                const delta = event.delta
                if (!delta) break
                if (delta.type === 'text_delta') {
                  if (!streamState.hasStreamStarted) {
                    streamState.hasStreamStarted = true
                    this.emit('stream_start', { messageId })
                  }
                  didStreamText = true
                  this.emit('stream_delta', { messageId, delta: delta.text })
                }
                break
              }
            }
            break
          }

          case 'assistant': {
            // Full assistant message — process content blocks for tool detection
            const content = msg.message?.content
            if (!Array.isArray(content)) break

            for (const block of content) {
              if (block.type === 'text' && block.text && !didStreamText && !streamState.hasStreamStarted) {
                // Fallback for non-streamed text
                this.emit('message', {
                  type: 'response',
                  content: block.text,
                  timestamp: Date.now(),
                })
              }

              if (block.type === 'tool_use') {
                this._handleToolUseBlock(messageId, block)
              }
            }
            break
          }

          case 'user': {
            // Tool result content blocks appear in user-role messages during the tool loop
            emitToolResults(msg.message?.content, this)
            break
          }

          case 'result': {
            if (streamState.hasStreamStarted) {
              this.emit('stream_end', { messageId })
            }

            if (msg.session_id) {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
            }

            // Correct any static context-window guess using the SDK's
            // authoritative per-model values. Only cache + broadcast when
            // a value actually changed to avoid thrashy writes / UI churn.
            let contextWindowChanged = false
            if (msg.modelUsage && typeof msg.modelUsage === 'object') {
              const missingIds = []
              for (const [modelId, usage] of Object.entries(msg.modelUsage)) {
                if (usage && typeof usage.contextWindow === 'number') {
                  if (updateContextWindow(modelId, usage.contextWindow)) {
                    contextWindowChanged = true
                  }
                } else {
                  missingIds.push(modelId)
                }
              }
              // Drift signal: at least one modelUsage entry was missing a
              // numeric contextWindow. Catches both total drift (field renamed
              // or removed upstream) and partial drift (schema updated for one
              // model family before another). Log a redacted sample so a
              // future regression is diagnosable without flooding info-level
              // output.
              if (missingIds.length > 0) {
                const sampleId = missingIds[0]
                const sampleKeys = Object.keys(msg.modelUsage[sampleId] || {})
                log.debug(
                  `modelUsage partial drift: contextWindow missing for modelIds=${JSON.stringify(missingIds)} sampleKeys=${JSON.stringify(sampleKeys)}`
                )
              }
            }
            if (contextWindowChanged) {
              saveModelsCache()
              // Notify connected clients so the picker / budget UI picks up
              // the corrected window without waiting for the next refresh.
              this.emit('models_updated', { models: getModels() })
            }

            this.emit('result', {
              sessionId: msg.session_id || this._sdkSessionId,
              cost: msg.total_cost_usd,
              duration: msg.duration_ms,
              usage: msg.usage,
            })

            this._clearMessageState()
            break
          }
        }
      }
    } catch (err) {
      if (streamState.hasStreamStarted) {
        this.emit('stream_end', { messageId })
      }
      if (!this._destroying) {
        log.error(`Query error: ${err.message}`)
        this.emit('error', { message: SdkSession._enrichErrorMessage(err.message) })
      }
      this._clearMessageState()
    } finally {
      this._query = null
      // Dequeue any follow-up messages that arrived while busy
      if (this._pendingInput?.length && !this._destroying) {
        // #3562: if the SidecarProcess latched stdin_disabled mid-turn (e.g.
        // the PassThrough closed while _callQuery was still streaming), the
        // entry-gate at the top of sendMessage has already been bypassed
        // for this turn. Without this short-circuit, we would shift one
        // follow-up, schedule a process.nextTick recursion, and only then
        // hit the entry gate — wasting a hop and emitting a per-message
        // error. Drain the queue at the dequeue site for symmetry with
        // the entry-gate drain (#3539/PR #3560), log a single warn, and
        // skip the recursion entirely.
        if (this._stdinForwardingDisabled) {
          log.warn(
            `Discarding ${this._pendingInput.length} queued follow-up message(s) after turn finish — ` +
            'stdin forwarding is disabled'
          )
          this._pendingInput.length = 0
          return
        }
        const next = this._pendingInput.shift()
        log.info(`Dequeuing follow-up message (${this._pendingInput.length} remaining)`)
        // Use setImmediate/nextTick to avoid stack depth issues
        process.nextTick(() => {
          if (!this._destroying) {
            this.sendMessage(next.prompt, next.attachments, next.sendOptions)
          }
        })
      }
    }
  }

  /**
   * Invoke the SDK query function. Extracted for testability.
   * @param {object} queryArgs - { prompt, options }
   * @returns {AsyncIterable} SDK message stream
   */
  _callQuery(queryArgs) {
    return query(queryArgs)
  }

  /**
   * Hook for subclasses to modify query options before they're passed to query().
   * Default implementation is a no-op. Override in subclasses that need to inject
   * additional options (e.g. spawnClaudeCodeProcess for container isolation).
   * @param {object} options - The query options object (mutated in place)
   */
  _augmentQueryOptions(_options) {
    // No-op — override in subclasses
  }

  /**
   * Attach default log listeners for SidecarProcess stdin failure
   * signals (#3402, #3474, #3506).
   *
   * SidecarProcess (used by container/k8s spawnClaudeCodeProcess paths)
   * emits two stdin failure events the SDK itself does not surface:
   *
   *   - `stdin_disabled`  — fired when forwarding becomes unrecoverable
   *     (post-reconnect or live WS close mid-write). One-shot.
   *     Logged at warn level.
   *   - `stdin_dropped`   — fired for every chunk that exceeds the 1 MiB
   *     pre-dial cap. Payload: `{ bytes, reason: 'pre-dial-cap' }`.
   *     #3506: every drop logs with a cumulative running total
   *     (`_stdinDroppedBytesTotal` + `_stdinDroppedCount`); the level
   *     escalates to error on the first drop, every Nth drop
   *     (`STDIN_DROPPED_ESCALATION_EVERY_N`), and when the cumulative
   *     byte total crosses `STDIN_DROPPED_BYTES_ERROR_THRESHOLD`. All
   *     other drops log at warn.
   *
   * Both signal silent data loss from the consumer's perspective: the
   * underlying PassThrough still accepts writes, so without an explicit
   * listener the user sees a hung turn instead of an error.  This helper
   * provides the "log at minimum" guarantee — subclasses or future
   * K8s-aware paths may override to escalate further (e.g. emit a
   * session error event, abort the turn).
   *
   * Idempotent on two axes:
   *   1. Safe on non-SidecarProcess procs — Node ChildProcess (Docker path)
   *      never emits these events, so the listeners simply never fire.
   *   2. Safe on repeat calls — the proc is stamped with a Symbol marker
   *      after the first wiring; subsequent calls short-circuit so a
   *      resume/reconnect caller cannot accumulate duplicate listeners
   *      (and therefore duplicate logs) on the same proc.
   *
   * @param {EventEmitter|null|undefined} proc — the spawned process from
   *   `spawnClaudeCodeProcess`.  May be a Node ChildProcess (Docker path)
   *   or a SidecarProcess (K8s path); only the latter emits these events.
   */
  _attachSidecarProcessListeners(proc) {
    if (!proc || typeof proc.on !== 'function') return
    // Re-wiring guard (#3504 review): stamp the proc on first attach so
    // duplicate calls don't pile up listeners.  Symbol-keyed so it can't
    // collide with consumer code or arbitrary EventEmitters used as stubs.
    if (proc[SIDECAR_LISTENERS_ATTACHED]) return
    proc[SIDECAR_LISTENERS_ATTACHED] = true

    proc.on('stdin_dropped', (info) => {
      // #3506: track a cumulative byte counter and escalate to error
      // level on the first drop, every Nth drop, and when the running
      // total crosses STDIN_DROPPED_BYTES_ERROR_THRESHOLD.  Other drops
      // log at warn so the signal stays loud without flooding logs.
      const rawBytes = info?.bytes
      const knownBytes = typeof rawBytes === 'number' && Number.isFinite(rawBytes)
      const bytesLabel = knownBytes ? `${rawBytes} bytes` : 'unknown bytes'
      const reason = info?.reason ?? 'unknown'

      this._stdinDroppedCount += 1
      if (knownBytes && rawBytes > 0) {
        this._stdinDroppedBytesTotal += rawBytes
      }

      const cumulative = this._stdinDroppedBytesTotal
      const dropCount = this._stdinDroppedCount

      const isFirstDrop = dropCount === 1
      const crossedByteThreshold =
        !this._stdinDroppedThresholdLogged &&
        cumulative >= STDIN_DROPPED_BYTES_ERROR_THRESHOLD
      const hitCountCadence =
        dropCount > 1 && dropCount % STDIN_DROPPED_ESCALATION_EVERY_N === 0

      const escalate = isFirstDrop || crossedByteThreshold || hitCountCadence
      if (crossedByteThreshold) {
        this._stdinDroppedThresholdLogged = true
      }

      // #3543: keep the raw byte count for scriptable log consumers and
      // append a humanised KiB/MiB/GiB suffix so threshold-cross lines are
      // easier to scan at a glance.  Format: `cumulative=N bytes (X.X MiB)`.
      const cumulativeHuman = formatBytes(cumulative)
      const message =
        `Sidecar stdin chunk dropped (${bytesLabel}, reason=${reason}, ` +
        `cumulative=${cumulative} bytes (${cumulativeHuman}) over ${dropCount} drops) — ` +
        'turn input was truncated; consumer may need to retry'

      if (escalate) {
        log.error(message)
      } else {
        log.warn(message)
      }

      // #3544: surface the cumulative totals as a session-level event so
      // SessionManager can proxy it onto the unified `session_event`
      // envelope. Dashboards and the mobile app see "X bytes lost over N
      // drops" instead of a hung turn. Emitted on every drop (not only
      // escalations) so the dashboard counter stays live; the `escalated`
      // flag lets the UI distinguish a "first drop / threshold-cross /
      // every-Nth" loud signal from routine warn-level updates.
      this.emit('stdin_dropped_totals', {
        bytes: cumulative,
        count: dropCount,
        reason,
        escalated: escalate,
      })
    })

    proc.on('stdin_disabled', () => {
      // #3468 + #3501: SESSION-STICKY semantics.  Once any spawn under this
      // session emits 'stdin_disabled' we latch `_stdinForwardingDisabled`
      // and log a single warn for the lifetime of the session.  Subsequent
      // spawns (next turn, post-reconnect retry) that fire their own
      // 'stdin_disabled' are intentionally silenced.
      //
      // Trade-off (decided in #3501): per-spawn warns would surface every
      // reconnect-induced loss but spam the operator log on a session that
      // is already known to be in the disabled state — the actionable signal
      // (reconnect/restart) was already delivered.  The session-sticky path
      // keeps the warn high-signal: one warn = "this session lost stdin
      // forwarding"; the latched flag is the persistent diagnostic for
      // anything more granular (e.g. metrics, dashboards).  If a future
      // K8s-aware subclass wants per-spawn visibility it can override this
      // method or read `_stdinForwardingDisabled` directly.
      if (this._stdinForwardingDisabled) return
      this._stdinForwardingDisabled = true
      // #3536 review: SidecarProcess explicitly does NOT re-wire stdin on
      // WS reconnect (see k8s.js `stdin_disabled signal` block) — once this
      // signal fires forwarding is permanently lost for the lifetime of the
      // session.  Recommend a session restart only; mentioning reconnect
      // contradicts `recoverable: false` and misleads users into a path
      // that cannot work.
      const message = 'Sidecar stdin forwarding is disabled — further writes will be ' +
        'silently dropped; restart this session to recover'
      log.warn(message)
      // #3502: surface the disabled flag to paired clients via the session
      // `error` channel.  SessionManager._wireSessionEvents proxies `error`
      // into the unified `session_event` envelope, so dashboards and the
      // mobile app receive a structured frame and can render a "stdin lost
      // — restart this session" banner instead of seeing a hung turn.
      // Single emit per session: gated by the same _stdinForwardingDisabled
      // short-circuit above so a flapping sidecar can't spam errors.
      this.emit('error', {
        code: 'stdin_disabled',
        message,
        recoverable: false,
      })
    })
  }

  /**
   * Handle tool_use blocks from assistant messages.
   * Detects Task tool for agent monitoring.
   *
   * Note: AskUserQuestion is NOT handled here — it flows through the
   * canUseTool callback in _handleAskUserQuestion(), which emits
   * user_question and waits for respondToQuestion().
   */
  _handleToolUseBlock(messageId, block) {
    // Guard against oversized tool inputs
    const inputStr = JSON.stringify(block.input || {})
    if (Buffer.byteLength(inputStr, 'utf8') > this._maxToolInput) {
      log.warn(`Tool input for ${block.name} exceeded ${this._maxToolInput} bytes, skipping`)
      this.emit('error', {
        message: `Tool input too large (>${Math.round(this._maxToolInput / 1024)}KB) for ${block.name} — tool use was skipped`,
      })
      return
    }

    if (block.name === 'Task') {
      const input = block.input || {}
      const description = (typeof input.description === 'string'
        ? input.description : 'Background task').slice(0, 200)
      const agentInfo = {
        toolUseId: block.id,
        description,
        startedAt: Date.now(),
      }
      this._activeAgents.set(block.id, agentInfo)
      this.emit('agent_spawned', agentInfo)
    }
  }

  /**
   * In-process permission handler for canUseTool callback.
   * Delegates to the PermissionManager.
   */
  _handlePermission(toolName, input, signal, suggestions) {
    return this._permissions.handlePermission(toolName, input, signal, this.permissionMode, suggestions)
  }

  /**
   * Resolve a pending permission request (called by WsServer when
   * the app sends permission_response).
   */
  respondToPermission(requestId, decision) {
    return this._permissions.respondToPermission(requestId, decision)
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   * In SDK mode, the canUseTool callback is holding a Promise open.
   * This method resolves it with the user's answer as structured updatedInput.
   */
  respondToQuestion(text, answersMap) {
    this._permissions.respondToQuestion(text, answersMap)
  }

  /**
   * Change the model. In SDK mode this doesn't require process restart.
   */
  setModel(model) {
    if (!super.setModel(model)) return
    log.info(`Model changed to ${this.model || 'default'}`)
  }

  setPermissionMode(mode) {
    if (!super.setPermissionMode(mode)) return
    this._permissions.clearRules()
    // #3729: switching TO auto is a "panic button" — drain any pending
    // permission prompts so the user isn't left staring at modals after
    // declaring "approve everything". Without this, prompts that were
    // emitted under the previous mode hang until the user resolves them
    // or they hit the 5-min timeout, contradicting the bypass semantics.
    if (mode === 'auto') {
      this._permissions.autoAllowPending()
    }
    log.info(`Permission mode changed to ${mode}`)
  }

  /**
   * Set per-session permission rules. Delegates to PermissionManager.
   * @param {Array<{tool: string, decision: string}>} rules
   */
  setPermissionRules(rules) {
    if (typeof this._permissions.setRules === 'function') {
      this._permissions.setRules(rules)
    }
  }

  /**
   * Get current per-session permission rules. Delegates to PermissionManager.
   * @returns {Array<{tool: string, decision: string}>}
   */
  getPermissionRules() {
    if (typeof this._permissions.getRules === 'function') {
      return this._permissions.getRules()
    }
    return []
  }

  /**
   * Clear all per-session permission rules. Delegates to PermissionManager.
   */
  clearPermissionRules() {
    if (typeof this._permissions.clearRules === 'function') {
      this._permissions.clearRules()
    }
  }

  /**
   * Set thinking level by adjusting max thinking tokens.
   * @param {string} level - 'default' | 'high' | 'max'
   */
  async setThinkingLevel(level) {
    const budget = SdkSession.THINKING_BUDGETS[level] ?? null
    this._thinkingLevel = level === 'default' ? null : level

    if (this._query && typeof this._query.setMaxThinkingTokens === 'function') {
      try {
        await this._query.setMaxThinkingTokens(budget)
        log.info(`Thinking level set to ${level} (${budget ?? 'adaptive'} tokens)`)
      } catch (err) {
        log.warn(`Failed to set thinking level: ${err.message}`)
      }
    }

    // Note: thinking_level_changed is broadcast by the WS handler, not emitted here
  }

  /**
   * Map internal permission mode to SDK PermissionMode.
   */
  _sdkPermissionMode() {
    switch (this.permissionMode) {
      case 'auto': return 'bypassPermissions'
      case 'plan': return 'plan'
      default: return 'default'
    }
  }

  /**
   * Query the SDK for available models and emit models_updated.
   * Called after session init — non-blocking, failures are logged and ignored.
   */
  async _fetchSupportedModels() {
    if (!this._query || typeof this._query.supportedModels !== 'function') return

    try {
      const sdkModels = await this._query.supportedModels()
      const converted = updateModels(sdkModels)
      if (converted && converted.length > 0) {
        log.info(`Dynamic model list: ${converted.map(m => m.id).join(', ')}`)
        saveModelsCache()
        this.emit('models_updated', { models: converted })
      }
    } catch (err) {
      log.warn(`Failed to fetch supported models: ${err.message}`)
    }
  }

  /**
   * Interrupt the current query.
   */
  async interrupt() {
    if (!this._query) return

    log.info('Interrupting query')
    try {
      await this._query.interrupt()
    } catch (err) {
      log.warn(`Interrupt error: ${err.message}`)
    }
  }

  /**
   * Handle the SOFT inactivity warning (#3899) — `_resultTimeoutMs` of
   * silence with no SDK event to reset it (default 30 min). Unlike
   * `_handleHardTimeout`, this does NOT clear busy state, does NOT
   * auto-deny pending permissions, and does NOT emit `error`. It just
   * emits a transient `inactivity_warning` event so the client can
   * render a check-in chip ("Status update?") and (if push is wired)
   * deliver an Expo notification.
   *
   * The hard-cap timer continues running in parallel — if the user
   * never engages, the kill path eventually fires anyway. The soft
   * timer is NOT re-armed here; each silent stretch fires exactly
   * one warning (any subsequent activity resets both timers, so the
   * next stretch fires a fresh warning).
   */
  _handleInactivityWarning(messageId) {
    if (!this._isBusy) return
    const idleMs = this._resultTimeoutMs
    const friendly = formatIdleDuration(idleMs)
    log.info(`Inactivity warning (${friendly}) — session alive, prompting check-in`)
    this.emit('inactivity_warning', {
      messageId,
      idleMs,
      prefab: 'Status update?',
    })
  }

  /**
   * Handle the HARD-cap timeout (#3899; pre-#3899 this was the only
   * handler, named `_handleResultTimeout` — kept as the absolute
   * backstop for genuinely stuck sessions when the user never check-
   * ins on the soft warning). Emits stream_end (if streaming), auto-
   * denies any pending permissions, emits `permission_expired` for
   * each so the client UI clears stale prompts, then clears state and
   * emits an error. Issue #2831 added the permission cleanup so late
   * user approvals don't resolve into an abandoned SDK turn.
   */
  _handleHardTimeout(messageId, hasStreamStarted) {
    if (!this._isBusy) return
    const friendly = formatIdleDuration(this._hardTimeoutMs)
    log.warn(`Hard-cap timeout (${friendly} inactivity) — force-clearing busy state`)
    if (hasStreamStarted) {
      this.emit('stream_end', { messageId })
    }
    // Fire permission_expired for every outstanding permission BEFORE
    // clearing state — the underlying Map is cleared by _clearMessageState
    // → PermissionManager.clearAll() below.
    if (this._pendingPermissions && this._pendingPermissions.size > 0) {
      for (const [requestId] of this._pendingPermissions) {
        this.emit('permission_expired', { requestId, message: 'Permission request expired (session timeout)' })
      }
    }
    // Attempt to abort the SDK query generator so no further events land
    // into a cleared message. Best-effort — the SDK's generator may not
    // support .return()/.throw() uniformly.
    this._abortActiveQuery()
    this._clearMessageState()
    this.emit('error', { message: `Response timed out after ${friendly} of inactivity` })
  }

  /**
   * Best-effort abort of the active SDK query generator. Used when the
   * session times out mid-turn so tool results don't stream into a
   * cleared message context (#2831).
   */
  _abortActiveQuery() {
    const q = this._query
    if (!q) return
    try {
      if (typeof q.interrupt === 'function') {
        const p = q.interrupt()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => log.warn(`Query interrupt (timeout) failed: ${err.message}`))
        }
      } else if (typeof q.return === 'function') {
        q.return()
      }
    } catch (err) {
      log.warn(`Query abort (timeout) failed: ${err.message}`)
    }
  }

  /**
   * Pause the inactivity timer because a permission prompt is
   * outstanding. Ref-counted so concurrent prompts all have to resolve
   * before the timer re-arms. #2831.
   */
  _pauseResultTimeoutForPermission() {
    this._permissionPauseCount++
    if (this._permissionPauseCount === 1) {
      this._resultTimeoutPaused = true
      // #3899: clear BOTH the soft warning and hard cap. Awaiting user
      // input on a permission is not inactivity; both re-arm together
      // via `_resetResultTimeout()` when the last prompt resolves.
      if (this._resultTimeout) {
        clearTimeout(this._resultTimeout)
        this._resultTimeout = null
      }
      if (this._hardTimeout) {
        clearTimeout(this._hardTimeout)
        this._hardTimeout = null
      }
    }
  }

  /**
   * Resume the inactivity timer when a permission prompt is resolved.
   * Only re-arms once the last concurrent prompt clears. #2831.
   */
  _resumeResultTimeoutForPermission() {
    if (this._permissionPauseCount === 0) return
    this._permissionPauseCount--
    if (this._permissionPauseCount === 0) {
      this._resultTimeoutPaused = false
      if (this._isBusy && typeof this._resetResultTimeout === 'function') {
        this._resetResultTimeout()
      }
    }
  }

  /**
   * Clear per-message state, marking us as ready for the next message.
   */
  _clearMessageState() {
    super._clearMessageState()
    this._permissions.clearAll()
    // Pause counter is tied to the previous message — reset so the next
    // message starts with a fresh counter.
    this._permissionPauseCount = 0
    this._resultTimeoutPaused = false
    this._resetResultTimeout = null
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this._destroying = true
    this._pendingInput = []

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
    if (this._hardTimeout) {
      clearTimeout(this._hardTimeout)
      this._hardTimeout = null
    }

    // Interrupt active query
    if (this._query) {
      this._query.interrupt().catch((err) => {
        log.warn(`Failed to interrupt active query: ${err.message} (non-critical, session destroying)`)
      })
      this._query = null
    }

    // Emit completions for any tracked agents and clear busy state
    this._clearMessageState()

    // Clean up permission manager
    this._permissions.destroy()

    this._processReady = false
    this.removeAllListeners()
  }
}
