import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { createPermissionHookManager } from './permission-hook.js'
import { BaseSession } from './base-session.js'
import { buildContentBlocks } from './content-blocks.js'
import { forceKill } from './platform.js'
import { MessageTransformPipeline } from './message-transform.js'
import { emitToolResults } from './tool-result.js'
import { parseMcpToolName } from './mcp-tools.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger } from './logger.js'

const log = createLogger('cli-session')

// Resolve the claude binary once at module load. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's
// install dir — fall through to known locations so `spawn()` succeeds.
const CLAUDE = resolveBinary('claude', [
  join(homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.claude/local/node_modules/.bin/claude'),
  join(homedir(), '.npm-global/bin/claude'),
])

// Default max accumulated size for tool_use input_json_delta chunks (~256KB)
const DEFAULT_MAX_TOOL_INPUT_LENGTH = 262144

/**
 * Manages a persistent Claude Code CLI session using headless mode.
 *
 * A single `claude -p --input-format stream-json --output-format stream-json`
 * process stays alive for the lifetime of the session. Messages are sent as
 * NDJSON on stdin; "message complete" is signaled by a `result` event on
 * stdout (not process exit).
 *
 * Events emitted:
 *   ready            { sessionId, model, tools }
 *   stream_start     { messageId }
 *   stream_delta     { messageId, delta }
 *   stream_end       { messageId }
 *   message          { type, content, tool, timestamp }
 *   tool_start       { messageId, tool, input }
 *   result           { cost, duration, usage, sessionId }
 *   error            { message }
 *   user_question    { toolUseId, questions }
 *   agent_spawned    { toolUseId, description, startedAt }
 *   agent_completed  { toolUseId }
 *   plan_started     {}
 *   plan_ready       { allowedPrompts }
 *   tool_result      { toolUseId, result, truncated }
 */

export class CliSession extends BaseSession {
  static get capabilities() {
    return {
      permissions: true,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: true,
      planMode: true,
      resume: false,
      terminal: false,
      thinkingLevel: false,
    }
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   * Declares the binary and credential requirements for this provider so
   * doctor.js can check only the binaries the configured provider actually
   * needs (see issue #2951).
   */
  static get preflight() {
    return {
      label: 'Claude CLI',
      binary: {
        name: 'claude',
        args: ['--version'],
        candidates: [
          join(homedir(), '.local/bin/claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          join(homedir(), '.claude/local/node_modules/.bin/claude'),
          join(homedir(), '.npm-global/bin/claude'),
        ],
        installHint: 'install Claude Code CLI',
      },
      credentials: {
        envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        hint: 'run `claude login` or set ANTHROPIC_API_KEY',
        optional: true,
      },
    }
  }

  constructor({ cwd, allowedTools, model, port, apiToken, permissionMode, settingsPath, maxToolInput, transforms, skillsDir } = {}) {
    super({ cwd, model, permissionMode, skillsDir })
    this.allowedTools = allowedTools || []
    this._port = port || null
    this._apiToken = apiToken || null
    // Per-session secret for the permission hook endpoint — never the primary API token
    this._hookSecret = randomBytes(32).toString('hex')
    this._maxToolInput = maxToolInput || DEFAULT_MAX_TOOL_INPUT_LENGTH
    this._transformPipeline = new MessageTransformPipeline(transforms || [])
    this._sessionId = null
    this._child = null
    this._rl = null
    this._stderrRL = null

    // Persistent-process state
    this._inPlanMode = false
    this._planAllowedPrompts = null
    this._waitingForAnswer = false
    this._currentCtx = null
    this._pendingQueue = []
    this._respawnCount = 0
    this._respawnTimer = null
    this._respawnScheduled = false
    this._respawning = false
    this._interruptTimer = null

    // Hook manager (shared module)
    this._hookManager = (this._port) ? createPermissionHookManager(this, { settingsPath }) : null

    // Pending-permission bookkeeping for the inactivity timer (#2831).
    // WsServer calls notifyPermissionPending/Resolved when a hook
    // permission belonging to this session is broadcast/resolved.
    this._pendingPermissionIds = new Set()
    this._resultTimeoutPaused = false
  }

  get sessionId() {
    return this._sessionId
  }

  /**
   * Start the persistent Claude process. Call once after construction.
   */
  start() {
    // Register permission hook before starting the process (only once, not on respawn)
    if (this._hookManager && this._respawnCount === 0) {
      this._hookManager.register()
    }

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (this.model) {
      args.push('--model', this.model)
    }

    if (this.permissionMode === 'auto') {
      args.push('--permission-mode', 'bypassPermissions')
    } else if (this.permissionMode === 'plan') {
      args.push('--permission-mode', 'plan')
    }

    if (this.allowedTools.length > 0) {
      args.push('--allowedTools', this.allowedTools.join(','))
    }

    // Skills MVP (#2957) — append shared skills to the Claude CLI system prompt.
    const skillsText = this._buildSystemPrompt()
    if (skillsText) {
      args.push('--append-system-prompt', skillsText)
    }

    log.info(`Starting persistent process (model: ${this.model || 'default'}, permission: ${this.permissionMode})`)
    this._spawnPersistentProcess(args)
  }

  /**
   * Spawn the persistent claude process and wire up event handlers.
   *
   * Uses buildSpawnEnv('claude') which strips ANTHROPIC_API_KEY from the
   * parent env (so the CLI uses OAuth/subscription auth instead of burning
   * API credits) while still forwarding the rest of the user's environment
   * — Claude Code tools expect the full shell env to be available.
   */
  _buildChildEnv() {
    const extras = {
      CI: '1',
      CLAUDE_HEADLESS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      CHROXY_PERMISSION_MODE: this.permissionMode,
      ...(this._port ? { CHROXY_PORT: String(this._port) } : {}),
      // Pass a short-lived per-session secret instead of the primary API token.
      // This limits the blast radius if a tool reads process.env — the hook secret
      // only authorises POST /permission, not the WebSocket API.
      ...(this._port ? { CHROXY_HOOK_SECRET: this._hookSecret } : {}),
    }
    return buildSpawnEnv('claude', extras)
  }

  _spawnPersistentProcess(args) {
    this._cleanupReadlines()
    this._processReady = false

    const child = spawn(CLAUDE, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this._buildChildEnv(),
    })

    this._child = child

    // Do NOT close stdin — we write messages to it

    // Read stdout line by line — each line is a JSON object
    const rl = createInterface({ input: child.stdout })
    this._rl = rl

    rl.on('line', (line) => {
      if (!line.trim()) return

      let data
      try {
        data = JSON.parse(line)
      } catch {
        return
      }

      this._handleEvent(data)
    })

    // Log stderr for debugging
    const stderrRL = createInterface({ input: child.stderr })
    this._stderrRL = stderrRL
    stderrRL.on('line', (line) => {
      if (line.trim()) {
        log.info(`stderr: ${line}`)
      }
    })

    // Absorb EPIPE and other low-level stdin errors so they don't become
    // unhandled exceptions. Writes are already wrapped in try/catch below.
    child.stdin.on('error', (err) => {
      log.warn(`stdin error (ignored): ${err.message}`)
    })

    child.on('error', (err) => {
      this._cleanupReadlines()
      this._processReady = false
      this._child = null
      this.emit('error', { message: `Failed to spawn claude: ${err.message}` })
      this._scheduleRespawn()
    })

    child.on('close', (code) => {
      this._cleanupReadlines()
      this._processReady = false
      this._child = null

      if (this._destroying) return
      if (this._respawning) return

      // Safety net: if we were mid-message, close the stream
      if (this._isBusy && this._currentMessageId) {
        if (this._currentCtx?.hasStreamStarted) {
          this.emit('stream_end', { messageId: this._currentMessageId })
        }
        this._clearMessageState()
      }

      log.info(`Process exited (code ${code}), scheduling respawn`)
      this.emit('error', { message: 'Claude process exited unexpectedly, restarting...' })
      this._scheduleRespawn()
    })

    // stdin is writable immediately — process is ready for NDJSON messages.
    // system.init arrives with the first response, not at startup.
    this._processReady = true
    log.info('Process started, ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })

    // Dequeue the next pending message if not already busy.
    // sendMessage() sets _isBusy, so the loop sends at most one message.
    // Remaining items stay in the queue and are drained one-by-one via
    // _clearMessageState() after each result.
    while (this._pendingQueue.length > 0 && !this._isBusy) {
      const pending = this._pendingQueue.shift()
      log.info(`Dequeuing pending message (${this._pendingQueue.length} remaining)`)
      this.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }
  }

  /**
   * Schedule a respawn with exponential backoff.
   * Backoff: 1s, 2s, 4s, 8s, 15s (max). Cap at 5 retries then stop.
   */
  _scheduleRespawn() {
    if (this._destroying) return
    if (this._respawning) return
    if (this._respawnScheduled) return

    this._respawnCount++
    if (this._respawnCount > 5) {
      log.error('Max respawn attempts reached (5), giving up')
      this.emit('error', { message: 'Claude process failed to stay alive after 5 attempts' })
      return
    }

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._respawnCount - 1, delays.length - 1)]
    log.info(`Respawning in ${delay}ms (attempt ${this._respawnCount}/5)`)

    this._respawnScheduled = true
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null
      this._respawnScheduled = false
      if (!this._destroying) {
        this.start()
      }
    }, delay)
  }

  /**
   * Send a message to Claude via stdin NDJSON.
   */
  async sendMessage(prompt, attachments, options = {}) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }

    if (!this._processReady) {
      if (this._pendingQueue.length >= 3) {
        this.emit('error', { message: 'Pending message queue full (max 3) — message discarded' })
        return
      }
      log.info(`Process not ready, queuing message (queue depth: ${this._pendingQueue.length + 1})`)
      this._pendingQueue.push({ prompt, attachments, options })
      return
    }

    // Apply message transforms if configured
    let transformedPrompt = prompt
    if (this._transformPipeline.hasTransforms && typeof prompt === 'string') {
      transformedPrompt = this._transformPipeline.apply(prompt, {
        cwd: this.cwd,
        model: this.model,
        isVoiceInput: !!options.isVoice,
        platform: process.platform,
      })
    }

    this._isBusy = true
    this._messageCounter++
    this._currentMessageId = `msg-${this._messageCounter}`
    this._currentCtx = { hasStreamStarted: false, didStreamText: false, assistantTextSeen: 0, currentContentBlockType: null, currentToolName: null, currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false }

    const content = buildContentBlocks(transformedPrompt, attachments)

    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })

    log.info(`Sending message ${this._currentMessageId}: "${(prompt || '').slice(0, 60)}"${attachments?.length ? ` (+${attachments.length} attachment(s))` : ''}`)
    try {
      this._child.stdin.write(ndjson + '\n')
    } catch (err) {
      log.error(`stdin.write failed (sendMessage): ${err.message}`)
      this._clearMessageState()
      this.emit('error', { message: `Failed to send message: ${err.message}` })
      return
    }

    // Safety timeout: force-clear if result never arrives (5 min).
    // Paused while permission prompts are outstanding (#2831): awaiting
    // user input on a permission is NOT "inactivity".
    this._armResultTimeout()
  }

  /**
   * Arm the 5-minute inactivity timer. No-op if paused because of a
   * pending permission prompt (#2831).
   */
  _armResultTimeout() {
    if (this._resultTimeout) clearTimeout(this._resultTimeout)
    this._resultTimeout = null
    if (this._resultTimeoutPaused) return
    this._resultTimeout = setTimeout(() => this._handleResultTimeout(), 300_000)
  }

  /**
   * Handle a true inactivity timeout. Before clearing state, emit
   * permission_expired for any registered pending permissions so the
   * client UI clears stale prompts (#2831). Without this, late user
   * approvals would resolve into a dead message context and no
   * response ever streams.
   */
  _handleResultTimeout() {
    if (!this._isBusy) return
    log.warn('Result timeout (5 min) — force-clearing busy state')
    const messageId = this._currentMessageId
    if (this._currentCtx?.hasStreamStarted) {
      this.emit('stream_end', { messageId })
    }
    // Fire permission_expired for every pending permission we know about
    // so the client clears the stale prompt.
    for (const requestId of this._pendingPermissionIds) {
      this.emit('permission_expired', {
        requestId,
        message: 'Permission request expired (session timeout)',
      })
    }
    this._pendingPermissionIds.clear()
    this._clearMessageState()
    this.emit('error', { message: 'Response timed out after 5 minutes' })
  }

  /**
   * Notify the session that a permission request belonging to it is
   * outstanding — pauses the inactivity timer so the session doesn't
   * time out while waiting on user input. #2831.
   *
   * @param {string} requestId
   */
  notifyPermissionPending(requestId) {
    if (!requestId || this._pendingPermissionIds.has(requestId)) return
    this._pendingPermissionIds.add(requestId)
    if (this._pendingPermissionIds.size === 1) {
      this._resultTimeoutPaused = true
      if (this._resultTimeout) {
        clearTimeout(this._resultTimeout)
        this._resultTimeout = null
      }
    }
  }

  /**
   * Notify the session that a permission request has been resolved
   * (allow/deny/expired). When the last outstanding permission clears,
   * the inactivity timer re-arms for a fresh window. #2831.
   *
   * @param {string} requestId
   */
  notifyPermissionResolved(requestId) {
    if (!requestId || !this._pendingPermissionIds.has(requestId)) return
    this._pendingPermissionIds.delete(requestId)
    if (this._pendingPermissionIds.size === 0) {
      this._resultTimeoutPaused = false
      if (this._isBusy) {
        this._armResultTimeout()
      }
    }
  }

  /**
   * Handle a single parsed JSON event from Claude CLI stdout.
   * Uses instance state (_currentMessageId, _currentCtx) instead of params.
   */
  _handleEvent(data) {
    switch (data.type) {
      case 'system': {
        if (data.subtype === 'init') {
          this._sessionId = data.session_id
          this._respawnCount = 0
          log.info(`Session initialized: ${data.session_id}`)
          this.emit('ready', {
            sessionId: data.session_id,
            model: data.model,
            tools: data.tools,
          })
          // Emit MCP server status if present (including empty list to clear stale state)
          if (Array.isArray(data.mcp_servers)) {
            if (data.mcp_servers.length > 0) {
              log.info(`MCP servers: ${data.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ')}`)
            }
            this.emit('mcp_servers', { servers: data.mcp_servers })
          }
        } else {
          // Forward non-init system events (e.g. usage limits, sub-agent
          // notifications) as system messages to the client
          const text = data.message || data.text || data.subtype || 'System event'
          log.info(`System event (${data.subtype || 'unknown'}): ${text}`)
          this.emit('message', {
            type: 'system',
            content: text,
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'stream_event': {
        const event = data.event
        if (!event) break

        const messageId = this._currentMessageId
        const ctx = this._currentCtx
        if (!messageId || !ctx) break

        switch (event.type) {
          case 'content_block_start': {
            const blockType = event.content_block?.type
            ctx.currentContentBlockType = blockType

            if (blockType === 'text') {
              if (!ctx.hasStreamStarted) {
                ctx.hasStreamStarted = true
                this.emit('stream_start', { messageId })
              }
            } else if (blockType === 'tool_use') {
              ctx.currentToolName = event.content_block.name
              ctx.currentToolUseId = event.content_block.id
              ctx.toolInputChunks = ''
              ctx.toolInputBytes = 0
              ctx.toolInputOverflow = false
              const toolStartData = {
                messageId,
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

            if (delta.type === 'text_delta' && ctx.currentContentBlockType === 'text') {
              if (!ctx.hasStreamStarted) {
                ctx.hasStreamStarted = true
                this.emit('stream_start', { messageId })
              }
              ctx.didStreamText = true
              this.emit('stream_delta', { messageId, delta: delta.text })
            } else if (delta.type === 'input_json_delta' && ctx.currentContentBlockType === 'tool_use') {
              if (typeof delta.partial_json === 'string' && !ctx.toolInputOverflow) {
                const chunkBytes = Buffer.byteLength(delta.partial_json, 'utf8')
                if (ctx.toolInputBytes + chunkBytes > this._maxToolInput) {
                  ctx.toolInputChunks = ''
                  ctx.toolInputOverflow = true
                  log.warn(`toolInputChunks exceeded ${this._maxToolInput} bytes, discarding buffer`)
                  this.emit('error', {
                    message: `Tool input too large (>${Math.round(this._maxToolInput / 1024)}KB) for ${ctx.currentToolName || 'unknown tool'} — input was truncated`,
                  })
                } else {
                  ctx.toolInputChunks += delta.partial_json
                  ctx.toolInputBytes += chunkBytes
                }
              }
            }
            break
          }

          case 'content_block_stop': {
            // toolInputChunks is falsy ('') after overflow discard, so the
            // AskUserQuestion parse path is naturally skipped on overflow.
            if (ctx && ctx.currentToolName === 'AskUserQuestion' && ctx.toolInputChunks) {
              try {
                const input = JSON.parse(ctx.toolInputChunks)
                log.info(`AskUserQuestion detected (${ctx.currentToolUseId})`)
                this._waitingForAnswer = true
                this.emit('user_question', {
                  toolUseId: ctx.currentToolUseId,
                  questions: input.questions,
                })
              } catch (err) {
                log.error(`Failed to parse AskUserQuestion input: ${err.message}`)
              }
            }
            if (ctx && ctx.currentToolName === 'Task' && ctx.toolInputChunks) {
              try {
                const input = JSON.parse(ctx.toolInputChunks)
                const description = (typeof input.description === 'string'
                  ? input.description : 'Background task').slice(0, 200)
                const agentInfo = {
                  toolUseId: ctx.currentToolUseId,
                  description,
                  startedAt: Date.now(),
                }
                this._activeAgents.set(ctx.currentToolUseId, agentInfo)
                this.emit('agent_spawned', agentInfo)
              } catch (err) {
                log.warn(`Failed to parse Task tool input: ${err.message}`)
              }
            }
            if (ctx && ctx.currentToolName === 'EnterPlanMode') {
              this._inPlanMode = true
              this.emit('plan_started')
            }
            if (ctx && ctx.currentToolName === 'ExitPlanMode') {
              let allowedPrompts = []
              if (ctx.toolInputChunks) {
                try {
                  const input = JSON.parse(ctx.toolInputChunks)
                  allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : []
                } catch (err) {
                  log.warn(`Failed to parse ExitPlanMode input: ${err.message}`)
                }
              }
              this._planAllowedPrompts = allowedPrompts
            }
            if (ctx) {
              ctx.currentContentBlockType = null
              ctx.currentToolName = null
              ctx.currentToolUseId = null
              ctx.toolInputChunks = ''
            }
            break
          }
        }
        break
      }

      case 'assistant': {
        // The assistant event fires repeatedly with --include-partial-messages,
        // delivering incrementally growing text content. When stream_event events
        // provide real-time deltas, we skip assistant text (didStreamText guard).
        // Otherwise, derive streaming from the incremental assistant text growth
        // so the dashboard shows real-time token-by-token rendering.
        const ctx = this._currentCtx
        const messageId = this._currentMessageId
        const content = data.message?.content
        if (Array.isArray(content) && ctx && messageId) {
          // If stream_event deltas already drove streaming, skip assistant text
          if (ctx.didStreamText) break

          // Concatenate all text blocks to handle multi-block content safely
          let fullText = ''
          for (const block of content) {
            if (block.type === 'text' && block.text) fullText += block.text
          }

          const prevLen = ctx.assistantTextSeen
          if (fullText.length > prevLen) {
            if (!ctx.hasStreamStarted) {
              ctx.hasStreamStarted = true
              this.emit('stream_start', { messageId })
            }
            this.emit('stream_delta', { messageId, delta: fullText.slice(prevLen) })
            ctx.assistantTextSeen = fullText.length
          }
          // tool_use blocks are handled by content_block_start → tool_start event;
          // emitting them here too would create duplicate tool messages in the app
        }
        break
      }

      case 'user': {
        // Tool result content blocks appear in user-role messages during the tool loop
        emitToolResults(data.message?.content, this)
        break
      }

      case 'result': {
        if (data.session_id) {
          this._sessionId = data.session_id
        }

        const messageId = this._currentMessageId
        const ctx = this._currentCtx

        // Close any open stream before emitting result
        if (ctx?.hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }

        // Emit plan_ready before clearing state — the turn that calls
        // ExitPlanMode ends with a normal result event
        if (this._inPlanMode && this._planAllowedPrompts !== null) {
          this.emit('plan_ready', { allowedPrompts: this._planAllowedPrompts })
          this._inPlanMode = false
          this._planAllowedPrompts = null
        }

        this.emit('result', {
          sessionId: data.session_id,
          cost: data.total_cost_usd,
          duration: data.duration_ms,
          usage: data.usage,
        })

        // Message complete — ready for next message
        this._clearMessageState()
        break
      }
    }
  }

  /**
   * Clear per-message state, marking us as ready for the next message.
   * After clearing, drains the next item from _pendingQueue (if any) so
   * that all queued messages are eventually delivered in FIFO order.
   */
  _clearMessageState() {
    super._clearMessageState()
    this._waitingForAnswer = false
    this._currentCtx = null
    // Reset permission pause bookkeeping — the next message starts fresh.
    this._pendingPermissionIds.clear()
    this._resultTimeoutPaused = false
    // If plan mode is active but ExitPlanMode never arrived (interrupt/crash),
    // the flag is stale — reset it. In normal flow, _planAllowedPrompts is
    // non-null (set by ExitPlanMode) and plan_ready has already been emitted
    // + both flags reset before we reach here.
    if (this._inPlanMode && this._planAllowedPrompts === null) {
      this._inPlanMode = false
    }
    this._planAllowedPrompts = null
    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }

    // Drain the next queued message on the next tick so that any synchronous
    // 'result' event listeners finish before sendMessage() is called.
    // This prevents re-entrancy where both a result listener and the drain
    // both call sendMessage() in the same tick, sending two messages when
    // only one is expected.
    if (this._pendingQueue.length > 0 && this._processReady) {
      process.nextTick(() => {
        if (this._destroying) return
        if (!this._processReady || this._pendingQueue.length === 0) return
        const pending = this._pendingQueue.shift()
        log.info(`Dequeuing next pending message after result (${this._pendingQueue.length} remaining)`)
        this.sendMessage(pending.prompt, pending.attachments, pending.options || {})
      })
    }
  }

  /**
   * Kill the current child process (if any) and respawn.
   * Suppresses auto-respawn during the kill, clears timers, and starts fresh.
   */
  _killAndRespawn() {
    this._respawning = true
    this._processReady = false
    this._sessionId = null

    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }

    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer)
      this._respawnTimer = null
    }
    this._respawnScheduled = false

    this._cleanupReadlines()

    if (this._child) {
      const oldChild = this._child
      this._child = null

      let didClose = false
      const respawn = () => {
        if (didClose) return
        didClose = true
        this._respawning = false
        this._respawnCount = 0
        if (this._destroying) return
        this.start()
      }

      oldChild.on('close', () => {
        clearTimeout(forceKillTimer)
        respawn()
      })

      // Force-kill after 10s if process doesn't exit cleanly
      const forceKillTimer = setTimeout(() => {
        if (!didClose) {
          log.warn('Process did not exit after 10s, force-killing')
          try {
            forceKill(oldChild)
          } catch (_err) {
            // Process may already be gone, that's fine
          }
          respawn()
        }
      }, 10000)

      oldChild.kill('SIGTERM')
    } else {
      this._respawning = false
      this._respawnCount = 0
      if (!this._destroying) {
        this.start()
      }
    }
  }

  /** Clean up readline interfaces */
  _cleanupReadlines() {
    if (this._rl) {
      this._rl.close()
      this._rl = null
    }
    if (this._stderrRL) {
      this._stderrRL.close()
      this._stderrRL = null
    }
  }

  /**
   * Change the model used for subsequent messages.
   * Kills the current process and respawns with the new model (new session).
   */
  setModel(model) {
    if (!super.setModel(model)) return
    log.info(`Model changed to ${this.model || 'default'}, restarting process`)
    this._killAndRespawn()
  }

  setPermissionMode(mode) {
    if (!super.setPermissionMode(mode)) return
    log.info(`Permission mode changed to ${mode}, restarting process`)
    this._killAndRespawn()
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   * Claude is waiting for user input on stdin mid-turn, so we bypass
   * the _isBusy check and write directly.
   */
  respondToQuestion(text) {
    if (!this._child || !this._waitingForAnswer) return
    this._waitingForAnswer = false
    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    })
    try {
      this._child.stdin.write(ndjson + '\n')
    } catch (err) {
      log.error(`stdin.write failed (respondToQuestion): ${err.message}`)
    }
  }

  /** Interrupt the current message (send SIGINT to child process) */
  interrupt() {
    if (!this._child) return

    log.info('Sending SIGINT to claude process')
    this._child.kill('SIGINT')

    // Safety: if still busy after 5s, force-clear state.
    // Claude should either emit a result (process survives) or die (close handler respawns).
    // Clear any existing timer first to avoid orphaned timers on rapid interrupts.
    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }
    this._interruptTimer = setTimeout(() => {
      this._interruptTimer = null
      if (this._isBusy) {
        log.warn('Interrupt safety timeout — force-clearing busy state')
        const messageId = this._currentMessageId
        if (this._currentCtx?.hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        this._clearMessageState()
      }
    }, 5000)
  }

  /** Clean up resources */
  destroy() {
    this._destroying = true
    this._respawning = false

    // Clean up permission hook — destroy() now chains unregister() after any
    // in-flight register() promise, preventing a register-after-unregister race
    // that would leave a dead hook in settings.json.
    if (this._hookManager) {
      this._hookManager.destroy()
    }

    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer)
      this._respawnTimer = null
    }
    this._respawnScheduled = false

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }

    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }

    this._cleanupReadlines()

    if (this._child) {
      // Close stdin for clean exit
      try { this._child.stdin.end() } catch {}

      // Force-kill after 3s if still alive
      const child = this._child
      const forceKillTimer = setTimeout(() => {
        try { forceKill(child) } catch {}
      }, 3000)

      child.on('close', () => clearTimeout(forceKillTimer))
      this._child = null
    }

    // Emit completions for any tracked agents and clear busy state.
    // Must happen before removeAllListeners() so events are delivered.
    this._clearMessageState()
    this._inPlanMode = false

    this._processReady = false
    this.removeAllListeners()
  }
}
