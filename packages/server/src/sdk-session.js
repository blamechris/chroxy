import { query } from '@anthropic-ai/claude-agent-sdk'
import { updateModels, saveModelsCache, updateContextWindow, getModels } from './models.js'
import { BaseSession } from './base-session.js'
import { buildContentBlocks } from './content-blocks.js'
import { MessageTransformPipeline } from './message-transform.js'
import { emitToolResults } from './tool-result.js'
import { parseMcpToolName } from './mcp-tools.js'
import { createLogger } from './logger.js'
import { PermissionManager } from './permission-manager.js'

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
    }
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

  constructor({ cwd, model, permissionMode, resumeSessionId, transforms, maxToolInput, sandbox } = {}) {
    super({ cwd, model, permissionMode })
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
    this._permissions.on('permission_resolved', () => {
      this._resumeResultTimeoutForPermission()
    })

    // Backward-compatible accessors (used by ws-permissions.js, settings-handlers.js)
    this._pendingPermissions = this._permissions._pendingPermissions
    this._lastPermissionData = this._permissions._lastPermissionData

    // Permission pause bookkeeping for _resultTimeout (#2831)
    this._permissionPauseCount = 0
    this._resultTimeoutPaused = false
    this._resetResultTimeout = null
  }

  get sessionId() {
    return this._sessionId
  }

  /** Public accessor for the SDK session ID used to resume conversations. */
  get resumeSessionId() {
    return this._sdkSessionId
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
    const messageId = `msg-${this._messageCounter}`
    this._currentMessageId = messageId
    // Shared ref so _handleResultTimeout can observe the latest value
    // when it fires (the timer was armed when hasStreamStarted was still
    // false, but the turn may have streamed before the timeout landed).
    const streamState = { hasStreamStarted: false }
    let didStreamText = false

    const sdkPermMode = this._sdkPermissionMode()
    const options = {
      cwd: this.cwd,
      permissionMode: sdkPermMode,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
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

    // Safety timeout: force-clear if result never arrives.
    // Resets on every SDK event (tool calls, streaming, etc.) so long-running
    // agent tasks with many tool calls don't get falsely timed out.
    // Paused while permission prompts are outstanding (#2831): awaiting
    // user input on a permission is NOT "inactivity".
    const RESULT_TIMEOUT_MS = 300_000 // 5 min of inactivity
    const resetResultTimeout = () => {
      if (this._resultTimeout) clearTimeout(this._resultTimeout)
      this._resultTimeout = null
      if (this._resultTimeoutPaused) return
      this._resultTimeout = setTimeout(() => {
        this._handleResultTimeout(messageId, streamState.hasStreamStarted)
      }, RESULT_TIMEOUT_MS)
    }
    this._resetResultTimeout = resetResultTimeout
    resetResultTimeout()

    try {
      // Allow subclasses to augment query options (e.g. DockerSdkSession
      // injects spawnClaudeCodeProcess here)
      this._augmentQueryOptions(options)

      // If attachments present, build multimodal content blocks
      const queryArgs = { prompt: transformedPrompt, options }
      if (attachments?.length) {
        queryArgs.prompt = buildContentBlocks(transformedPrompt, attachments)
      }
      this._query = this._callQuery(queryArgs)

      for await (const msg of this._query) {
        if (this._destroying) break
        resetResultTimeout() // Any SDK event = activity, reset inactivity timer

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init') {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
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
                  const toolStartData = {
                    messageId: event.content_block.id || `${messageId}-tool`,
                    toolUseId: event.content_block.id,
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
              let sawContextWindow = false
              const modelIds = Object.keys(msg.modelUsage)
              for (const [modelId, usage] of Object.entries(msg.modelUsage)) {
                if (usage && typeof usage.contextWindow === 'number') {
                  sawContextWindow = true
                  if (updateContextWindow(modelId, usage.contextWindow)) {
                    contextWindowChanged = true
                  }
                }
              }
              // Drift signal: SDK emitted modelUsage entries but none carried a
              // numeric contextWindow. Likely means the field was renamed or
              // removed upstream. Log a redacted sample so a future regression
              // is diagnosable without flooding info-level output.
              if (!sawContextWindow && modelIds.length > 0) {
                const sampleId = modelIds[0]
                const sampleKeys = Object.keys(msg.modelUsage[sampleId] || {})
                log.debug(
                  `modelUsage contract drift: expected numeric contextWindow; received modelIds=${JSON.stringify(modelIds)} sampleKeys=${JSON.stringify(sampleKeys)}`
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
   * Handle a true inactivity timeout — the 5-min result timer fired
   * while the session was still busy. Emits stream_end (if streaming),
   * auto-denies any pending permissions, emits `permission_expired` for
   * each so the client UI clears stale prompts, then clears state and
   * emits an error. Issue #2831 added the permission cleanup so late
   * user approvals don't resolve into an abandoned SDK turn.
   */
  _handleResultTimeout(messageId, hasStreamStarted) {
    if (!this._isBusy) return
    log.warn('Result timeout (5 min inactivity) — force-clearing busy state')
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
    this.emit('error', { message: 'Response timed out after 5 minutes of inactivity' })
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
      if (this._resultTimeout) {
        clearTimeout(this._resultTimeout)
        this._resultTimeout = null
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
