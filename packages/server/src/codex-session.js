import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { MessageTransformPipeline } from './message-transform.js'

/**
 * Manages a Codex CLI session for the provider registry.
 *
 * Wraps the OpenAI Codex CLI (`codex exec`) as a session provider.
 * Each sendMessage() spawns a `codex exec --json` process and streams
 * JSONL events, mapping them to the standard provider interface.
 *
 * Install: npm install -g @openai/codex
 * Docs: https://developers.openai.com/codex/cli/
 *
 * Events emitted (same as SdkSession/CliSession):
 *   ready        { sessionId, model, tools }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   message      { type, content, timestamp }
 *   tool_start   { messageId, toolUseId, tool, input }
 *   tool_result  { toolUseId, result, truncated }
 *   result       { sessionId, cost, duration, usage }
 *   error        { message }
 */

// Map Chroxy permission modes to Codex --ask-for-approval values
const PERMISSION_MODE_MAP = {
  approve: 'untrusted',       // pause for every command
  acceptEdits: 'on-request',  // auto-approve file ops, ask for others
  auto: 'never',              // no approval prompts
  plan: 'untrusted',          // Codex has no plan mode — fall back to approve
}

// Default model for Codex sessions
const DEFAULT_CODEX_MODEL = 'codex-mini'

export class CodexSession extends EventEmitter {
  static get capabilities() {
    return {
      permissions: false,           // Codex uses sandbox model, not per-tool approval
      inProcessPermissions: false,
      modelSwitch: true,            // --model flag per-process
      permissionModeSwitch: true,   // Maps to --ask-for-approval
      planMode: false,              // Codex has no plan mode
      resume: true,                 // codex exec resume <thread_id>
      terminal: false,
    }
  }

  constructor({ cwd, model, permissionMode, resumeSessionId, transforms } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.model = model || DEFAULT_CODEX_MODEL
    this.permissionMode = permissionMode || 'approve'
    this._transformPipeline = new MessageTransformPipeline(transforms || [])

    this._threadId = resumeSessionId || null
    this._child = null
    this._rl = null
    this._stderrRL = null
    this._isBusy = false
    this._processReady = false
    this._messageCounter = 0
    this._currentMessageId = null
    this._destroying = false
    this._resultTimeout = null

    // Streaming state per message
    this._hasStreamStarted = false
    this._streamedText = ''
  }

  get resumeSessionId() {
    return this._threadId
  }

  get isRunning() {
    return this._isBusy
  }

  get isReady() {
    return this._processReady && !this._isBusy
  }

  /**
   * Mark session as ready. No persistent process needed — each message
   * spawns its own `codex exec` process.
   */
  start() {
    this._processReady = true
    console.log('[codex-session] Ready for messages')
    this.emit('ready', { sessionId: this._threadId, model: this.model, tools: [] })
  }

  /**
   * Send a message to Codex via `codex exec --json`.
   * Spawns a one-shot process and streams JSONL events.
   */
  async sendMessage(prompt, attachments, options = {}) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
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
    const messageId = `msg-${this._messageCounter}`
    this._currentMessageId = messageId
    this._hasStreamStarted = false
    this._streamedText = ''

    const startTime = Date.now()

    // Build command args
    const args = ['exec']

    // Resume existing thread if we have one
    if (this._threadId) {
      args.push('resume', this._threadId)
    }

    args.push('--json')
    args.push('--model', this.model)

    // Map permission mode to Codex approval mode
    const approvalMode = PERMISSION_MODE_MAP[this.permissionMode] || 'untrusted'
    args.push('--ask-for-approval', approvalMode)

    // If auto mode, also set sandbox to full access
    if (this.permissionMode === 'auto') {
      args.push('--sandbox', 'danger-full-access')
    } else if (this.permissionMode === 'acceptEdits') {
      args.push('--sandbox', 'workspace-write')
    }

    // The prompt goes last
    args.push(transformedPrompt)

    console.log(`[codex-session] Spawning: codex ${args.slice(0, 4).join(' ')} ... "${(prompt || '').slice(0, 60)}"`)

    try {
      this._spawnProcess(args, messageId, startTime)
    } catch (err) {
      console.error(`[codex-session] Failed to spawn codex: ${err.message}`)
      this.emit('error', { message: `Failed to spawn codex: ${err.message}` })
      this._clearMessageState()
    }

    // Safety timeout: force-clear if result never arrives (5 min)
    this._resultTimeout = setTimeout(() => {
      if (this._isBusy) {
        console.warn('[codex-session] Result timeout (5 min) — force-clearing busy state')
        if (this._hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        this._killChild()
        this._clearMessageState()
        this.emit('error', { message: 'Response timed out after 5 minutes' })
      }
    }, 300_000)
  }

  /**
   * Spawn the codex exec process and wire up JSONL event handlers.
   */
  _spawnProcess(args, messageId, startTime) {
    const child = spawn('codex', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure Codex doesn't try to open a TUI
        CI: '1',
      },
    })

    this._child = child

    // Close stdin — codex exec reads prompt from args, not stdin
    child.stdin.end()

    // Parse stdout as JSONL
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

      this._handleEvent(data, messageId)
    })

    // Log stderr for debugging
    const stderrRL = createInterface({ input: child.stderr })
    this._stderrRL = stderrRL
    stderrRL.on('line', (line) => {
      if (line.trim()) {
        console.log(`[codex-session] stderr: ${line}`)
      }
    })

    child.on('error', (err) => {
      this._cleanupReadlines()
      this._child = null
      if (!this._destroying) {
        console.error(`[codex-session] Process error: ${err.message}`)
        if (this._hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        this.emit('error', { message: `Codex process error: ${err.message}` })
        this._clearMessageState()
      }
    })

    child.on('close', (code) => {
      this._cleanupReadlines()
      this._child = null

      if (this._destroying) return

      const duration = Date.now() - startTime

      // If we're still busy, the process exited before emitting turn.completed
      if (this._isBusy) {
        if (this._hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }

        // Non-zero exit code and no content → error
        if (code !== 0 && !this._streamedText) {
          this.emit('error', { message: `Codex process exited with code ${code}` })
        }

        // Emit result for whatever we got
        this.emit('result', {
          sessionId: this._threadId,
          cost: null,
          duration,
          usage: null,
        })

        this._clearMessageState()
      }
    })
  }

  /**
   * Handle a single JSONL event from the codex exec process.
   *
   * Event mapping:
   *   thread.started                    → capture threadId for resume
   *   turn.started                      → (internal)
   *   item.started  (agent_message)     → stream_start
   *   item.completed (agent_message)    → stream_delta + stream_end
   *   item.started  (command_execution) → tool_start (Bash)
   *   item.completed (command_execution)→ tool_result
   *   item.started  (file_change)       → tool_start (Edit/Write)
   *   item.completed (file_change)      → tool_result
   *   turn.completed                    → result
   *   turn.failed / error               → error
   */
  _handleEvent(data, messageId) {
    switch (data.type) {
      case 'thread.started': {
        this._threadId = data.thread_id
        console.log(`[codex-session] Thread started: ${data.thread_id}`)
        this.emit('ready', {
          sessionId: data.thread_id,
          model: this.model,
          tools: [],
        })
        break
      }

      case 'turn.started': {
        // Turn begins — internal tracking only
        break
      }

      case 'item.started': {
        const item = data.item
        if (!item) break

        switch (item.type) {
          case 'agent_message': {
            if (!this._hasStreamStarted) {
              this._hasStreamStarted = true
              this.emit('stream_start', { messageId })
            }
            break
          }

          case 'command_execution': {
            this.emit('tool_start', {
              messageId,
              toolUseId: item.id,
              tool: 'Bash',
              input: { command: item.command || '' },
            })
            break
          }

          case 'file_change': {
            const tool = item.operation === 'create' ? 'Write' : 'Edit'
            this.emit('tool_start', {
              messageId,
              toolUseId: item.id,
              tool,
              input: { file_path: item.file || item.path || '' },
            })
            break
          }

          case 'mcp_tool_call': {
            this.emit('tool_start', {
              messageId,
              toolUseId: item.id,
              tool: item.name || 'MCP',
              input: item.arguments || {},
            })
            break
          }
        }
        break
      }

      case 'item.completed': {
        const item = data.item
        if (!item) break

        switch (item.type) {
          case 'agent_message': {
            const text = item.text || ''
            if (text) {
              if (!this._hasStreamStarted) {
                this._hasStreamStarted = true
                this.emit('stream_start', { messageId })
              }
              this._streamedText += text
              this.emit('stream_delta', { messageId, delta: text })
            }
            break
          }

          case 'command_execution': {
            this.emit('tool_result', {
              toolUseId: item.id,
              result: item.output || item.stdout || '',
              truncated: false,
            })
            break
          }

          case 'file_change': {
            this.emit('tool_result', {
              toolUseId: item.id,
              result: item.diff || item.summary || 'File changed',
              truncated: false,
            })
            break
          }

          case 'mcp_tool_call': {
            this.emit('tool_result', {
              toolUseId: item.id,
              result: item.output || item.result || '',
              truncated: false,
            })
            break
          }
        }
        break
      }

      case 'turn.completed': {
        if (this._hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }

        const usage = data.usage || {}
        this.emit('result', {
          sessionId: this._threadId,
          cost: data.cost_usd || null,
          duration: data.duration_ms || null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: usage.cached_input_tokens || 0,
          },
        })

        this._clearMessageState()
        break
      }

      case 'turn.failed': {
        if (this._hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        const errorMsg = data.error?.message || data.message || 'Turn failed'
        console.error(`[codex-session] Turn failed: ${errorMsg}`)
        this.emit('error', { message: errorMsg })
        this._clearMessageState()
        break
      }

      case 'error': {
        const errorMsg = data.message || data.error?.message || 'Unknown error'
        console.error(`[codex-session] Error event: ${errorMsg}`)
        this.emit('error', { message: errorMsg })
        break
      }
    }
  }

  /**
   * Change the model. Takes effect on the next spawned process.
   */
  setModel(model) {
    if (this._isBusy) {
      console.warn('[codex-session] Ignoring model change while message is in-flight')
      return
    }

    if (model === this.model) {
      console.log(`[codex-session] Model unchanged: ${this.model}`)
      return
    }

    this.model = model || DEFAULT_CODEX_MODEL
    console.log(`[codex-session] Model changed to ${this.model}`)
  }

  /**
   * Change the permission mode. Takes effect on the next spawned process.
   */
  setPermissionMode(mode) {
    const VALID_MODES = ['approve', 'auto', 'plan', 'acceptEdits']
    if (!VALID_MODES.includes(mode)) {
      console.warn(`[codex-session] Ignoring invalid permission mode: ${mode}`)
      return
    }

    if (this._isBusy) {
      console.warn('[codex-session] Ignoring permission mode change while message is in-flight')
      return
    }

    if (mode === this.permissionMode) {
      console.log(`[codex-session] Permission mode unchanged: ${this.permissionMode}`)
      return
    }

    this.permissionMode = mode
    console.log(`[codex-session] Permission mode changed to ${mode}`)
  }

  /**
   * No-op — Codex handles permissions via sandbox/approval flags.
   */
  respondToPermission() {}

  /**
   * No-op — Codex does not support AskUserQuestion.
   */
  respondToQuestion() {}

  /**
   * Interrupt the current process.
   */
  async interrupt() {
    if (!this._child) return
    console.log('[codex-session] Interrupting codex process')
    this._child.kill('SIGINT')
  }

  /**
   * Clear per-message state.
   */
  _clearMessageState() {
    this._isBusy = false
    this._currentMessageId = null
    this._hasStreamStarted = false
    this._streamedText = ''
    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
  }

  /** Kill the child process if alive */
  _killChild() {
    if (this._child) {
      try { this._child.kill('SIGTERM') } catch {}
      this._child = null
    }
    this._cleanupReadlines()
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
   * Clean up resources.
   */
  destroy() {
    this._destroying = true

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }

    this._killChild()
    this._clearMessageState()
    this._processReady = false
    this.removeAllListeners()
  }
}
