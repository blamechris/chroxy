import { query } from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'
import { resolveModelId } from './models.js'

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
 */
export class SdkSession extends EventEmitter {
  constructor({ cwd, model, permissionMode, resumeSessionId } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.model = model || null
    this.permissionMode = permissionMode || 'approve'

    this._sdkSessionId = resumeSessionId || null
    this._sessionId = null
    this._query = null
    this._isBusy = false
    this._waitingForAnswer = false
    this._processReady = false
    this._messageCounter = 0
    this._currentMessageId = null
    this._destroying = false

    // Permission handling
    this._pendingPermissions = new Map() // requestId -> resolve
    this._permissionTimers = new Map() // requestId -> timer
    this._permissionCounter = 0

    // AskUserQuestion handling
    this._pendingUserAnswer = null // { resolve, input } when waiting for user answer
    this._questionTimer = null

    // Agent tracking
    this._activeAgents = new Map() // toolUseId -> { toolUseId, description, startedAt }

    // Result timeout
    this._resultTimeout = null
  }

  get sessionId() {
    return this._sessionId
  }

  /** Public accessor for the SDK session ID used to resume conversations. */
  get resumeSessionId() {
    return this._sdkSessionId
  }

  get isRunning() {
    return this._isBusy
  }

  get isReady() {
    return this._processReady && !this._isBusy
  }

  /**
   * Start the SDK session. Creates the long-lived streaming input generator
   * and begins the query loop.
   */
  start() {
    this._processReady = true
    console.log('[sdk-session] Ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })
  }

  /**
   * Send a message to Claude via the Agent SDK.
   * Each call creates a new query() with resume to maintain conversation.
   */
  async sendMessage(prompt) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }

    this._isBusy = true
    this._messageCounter++
    const messageId = `msg-${this._messageCounter}`
    this._currentMessageId = messageId
    let hasStreamStarted = false
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

    // In-process permission handling (only when not bypassing)
    if (this.permissionMode !== 'auto') {
      options.canUseTool = (toolName, input, { signal }) =>
        this._handlePermission(toolName, input, signal)
    }

    // Resume existing session if we have one
    if (this._sdkSessionId) {
      options.resume = this._sdkSessionId
    }

    // Safety timeout: force-clear if result never arrives (5 min)
    this._resultTimeout = setTimeout(() => {
      if (this._isBusy) {
        console.warn('[sdk-session] Result timeout (5 min) — force-clearing busy state')
        if (hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        this._clearMessageState()
        this.emit('error', { message: 'Response timed out after 5 minutes' })
      }
    }, 300_000)

    try {
      this._query = query({ prompt, options })

      for await (const msg of this._query) {
        if (this._destroying) break

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init') {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
              console.log(`[sdk-session] Session initialized: ${msg.session_id} (model: ${msg.model})`)
              this.emit('ready', {
                sessionId: msg.session_id,
                model: msg.model,
                tools: msg.tools || [],
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
                  if (!hasStreamStarted) {
                    hasStreamStarted = true
                    this.emit('stream_start', { messageId })
                  }
                } else if (blockType === 'tool_use') {
                  this.emit('tool_start', {
                    messageId: event.content_block.id || `${messageId}-tool`,
                    tool: event.content_block.name,
                    input: null,
                  })
                }
                break
              }

              case 'content_block_delta': {
                const delta = event.delta
                if (!delta) break
                if (delta.type === 'text_delta') {
                  if (!hasStreamStarted) {
                    hasStreamStarted = true
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
              if (block.type === 'text' && block.text && !didStreamText && !hasStreamStarted) {
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

          case 'result': {
            if (hasStreamStarted) {
              this.emit('stream_end', { messageId })
            }

            if (msg.session_id) {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
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
      if (hasStreamStarted) {
        this.emit('stream_end', { messageId })
      }
      if (!this._destroying) {
        console.error(`[sdk-session] Query error: ${err.message}`)
        this.emit('error', { message: err.message })
      }
      this._clearMessageState()
    } finally {
      this._query = null
    }
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
   *
   * For AskUserQuestion: emits user_question and waits for respondToQuestion()
   * to deliver the user's answer, then returns it as structured updatedInput.
   *
   * For all other tools: emits permission_request and waits for
   * respondToPermission() to deliver the user's allow/deny decision.
   */
  _handlePermission(toolName, input, signal) {
    if (toolName === 'AskUserQuestion') {
      return this._handleAskUserQuestion(input, signal)
    }

    return new Promise((resolve) => {
      const requestId = `perm-${++this._permissionCounter}-${Date.now()}`
      this._pendingPermissions.set(requestId, resolve)

      const toolInput = input || {}
      const description = toolInput.description
        || toolInput.command
        || toolInput.file_path
        || toolInput.pattern
        || toolInput.query
        || (Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput).slice(0, 200) : toolName)

      console.log(`[sdk-session] Permission request ${requestId}: ${toolName}`)

      this.emit('permission_request', {
        requestId,
        tool: toolName,
        description,
        input: toolInput,
      })

      // Auto-deny on abort signal (user interrupted)
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this._pendingPermissions.has(requestId)) {
            this._pendingPermissions.delete(requestId)
            this._clearPermissionTimer(requestId)
            resolve({ behavior: 'deny', message: 'Request cancelled' })
          }
        }, { once: true })
      }

      // Auto-deny after 5 minutes if no response
      const timer = setTimeout(() => {
        this._permissionTimers.delete(requestId)
        if (this._pendingPermissions.has(requestId)) {
          console.log(`[sdk-session] Permission ${requestId} timed out, auto-denying`)
          this._pendingPermissions.delete(requestId)
          resolve({ behavior: 'deny', message: 'Permission timed out' })
        }
      }, 300_000)
      this._permissionTimers.set(requestId, timer)
    })
  }

  /**
   * Handle AskUserQuestion via canUseTool.
   * Emits user_question and waits for respondToQuestion() to deliver the
   * user's answer, then resolves with structured updatedInput.
   */
  _handleAskUserQuestion(input, signal) {
    return new Promise((resolve) => {
      const questionInput = input || {}
      this._waitingForAnswer = true
      this._pendingUserAnswer = { resolve, input: questionInput }

      const toolUseId = `ask-${++this._permissionCounter}-${Date.now()}`
      console.log(`[sdk-session] AskUserQuestion detected (${toolUseId})`)

      this.emit('user_question', {
        toolUseId,
        questions: questionInput.questions,
      })

      // Auto-deny on abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          if (this._pendingUserAnswer) {
            this._clearQuestionTimer()
            this._pendingUserAnswer = null
            this._waitingForAnswer = false
            resolve({ behavior: 'deny', message: 'Cancelled' })
          }
        }, { once: true })
      }

      // Auto-deny after 5 minutes if no response
      this._questionTimer = setTimeout(() => {
        this._questionTimer = null
        if (this._pendingUserAnswer) {
          console.log(`[sdk-session] Question ${toolUseId} timed out, auto-denying`)
          this._pendingUserAnswer = null
          this._waitingForAnswer = false
          resolve({ behavior: 'deny', message: 'Question timed out' })
        }
      }, 300_000)
    })
  }

  /**
   * Clear the AskUserQuestion timeout timer.
   */
  _clearQuestionTimer() {
    if (this._questionTimer) {
      clearTimeout(this._questionTimer)
      this._questionTimer = null
    }
  }

  /**
   * Clear a permission timeout timer by request ID.
   */
  _clearPermissionTimer(requestId) {
    const timer = this._permissionTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this._permissionTimers.delete(requestId)
    }
  }

  /**
   * Resolve a pending permission request (called by WsServer when
   * the app sends permission_response).
   */
  respondToPermission(requestId, decision) {
    const resolve = this._pendingPermissions.get(requestId)
    if (!resolve) {
      console.warn(`[sdk-session] No pending permission for ${requestId}`)
      return
    }
    this._pendingPermissions.delete(requestId)
    this._clearPermissionTimer(requestId)

    console.log(`[sdk-session] Permission ${requestId} resolved: ${decision}`)

    if (decision === 'allow') {
      resolve({ behavior: 'allow', updatedInput: undefined })
    } else if (decision === 'allowAlways') {
      resolve({ behavior: 'allowAlways', updatedInput: undefined })
    } else {
      resolve({ behavior: 'deny', message: 'User denied' })
    }
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   * In SDK mode, the canUseTool callback is holding a Promise open.
   * This method resolves it with the user's answer as structured updatedInput.
   */
  respondToQuestion(text) {
    if (!this._pendingUserAnswer) return
    this._clearQuestionTimer()
    const { resolve, input } = this._pendingUserAnswer
    this._pendingUserAnswer = null
    this._waitingForAnswer = false

    console.log(`[sdk-session] Question response received: "${text.slice(0, 60)}"`)

    // Build structured answers map: SDK expects { [questionText]: selectedLabel }
    const answers = {}
    const questions = input.questions || []
    if (questions.length > 0) {
      // Map the answer to each question. The app sends a single text
      // response, which works for the common single-question case.
      // For multi-question prompts the user's text applies to all.
      for (const q of questions) {
        answers[q.question] = text
      }
    }

    resolve({
      behavior: 'allow',
      updatedInput: {
        questions,
        answers,
      },
    })
  }

  /**
   * Change the model. In SDK mode this doesn't require process restart.
   */
  setModel(model) {
    if (this._isBusy) {
      console.warn('[sdk-session] Ignoring model change while message is in-flight')
      return
    }

    const newModel = model ? resolveModelId(model) : null
    if (newModel === this.model) {
      console.log(`[sdk-session] Model unchanged: ${this.model || 'default'}`)
      return
    }

    this.model = newModel
    console.log(`[sdk-session] Model changed to ${this.model || 'default'}`)
  }

  /**
   * Change the permission mode. In SDK mode this doesn't require process restart.
   */
  setPermissionMode(mode) {
    const VALID_MODES = ['approve', 'auto', 'plan']
    if (!VALID_MODES.includes(mode)) {
      console.warn(`[sdk-session] Ignoring invalid permission mode: ${mode}`)
      return
    }

    if (this._isBusy) {
      console.warn('[sdk-session] Ignoring permission mode change while message is in-flight')
      return
    }

    if (mode === this.permissionMode) {
      console.log(`[sdk-session] Permission mode unchanged: ${this.permissionMode}`)
      return
    }

    this.permissionMode = mode
    console.log(`[sdk-session] Permission mode changed to ${mode}`)
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
   * Interrupt the current query.
   */
  async interrupt() {
    if (!this._query) return

    console.log('[sdk-session] Interrupting query')
    try {
      await this._query.interrupt()
    } catch (err) {
      console.warn(`[sdk-session] Interrupt error: ${err.message}`)
    }
  }

  /**
   * Clear per-message state, marking us as ready for the next message.
   */
  _clearMessageState() {
    this._isBusy = false
    this._waitingForAnswer = false
    this._currentMessageId = null

    // Emit completions for any tracked agents
    if (this._activeAgents.size > 0) {
      for (const agent of this._activeAgents.values()) {
        this.emit('agent_completed', { toolUseId: agent.toolUseId })
      }
      this._activeAgents.clear()
    }

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }

    // Auto-deny any pending permissions and clear their timers
    for (const [requestId, resolve] of this._pendingPermissions) {
      this._clearPermissionTimer(requestId)
      resolve({ behavior: 'deny', message: 'Message completed' })
    }
    this._pendingPermissions.clear()

    // Auto-deny pending user answer
    this._clearQuestionTimer()
    if (this._pendingUserAnswer) {
      this._pendingUserAnswer.resolve({ behavior: 'deny', message: 'Message completed' })
      this._pendingUserAnswer = null
    }
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this._destroying = true

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }

    // Interrupt active query
    if (this._query) {
      this._query.interrupt().catch(() => {})
      this._query = null
    }

    // Emit completions for any tracked agents and clear busy state
    this._clearMessageState()

    this._processReady = false
    this.removeAllListeners()
  }
}
