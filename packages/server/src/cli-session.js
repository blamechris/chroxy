import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { resolveModelId } from './models.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Module-level lock for settings.json read-modify-write operations.
// Multiple CliSession instances starting/stopping simultaneously can
// corrupt each other's writes without serialization.
let _settingsLock = Promise.resolve()

function withSettingsLock(fn) {
  // Serialize regardless of success/failure — then(fn, fn) ensures fn runs after
  // the previous operation completes, whether it succeeded or failed
  const next = _settingsLock.then(fn, fn)
  _settingsLock = next.catch(() => {})
  return next
}

/**
 * Manages a persistent Claude Code CLI session using headless mode.
 *
 * A single `claude -p --input-format stream-json --output-format stream-json`
 * process stays alive for the lifetime of the session. Messages are sent as
 * NDJSON on stdin; "message complete" is signaled by a `result` event on
 * stdout (not process exit).
 *
 * Events emitted:
 *   ready        { sessionId, model, tools }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   message      { type, content, tool, timestamp }
 *   tool_start   { messageId, tool, input }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 */
export class CliSession extends EventEmitter {
  constructor({ cwd, allowedTools, model, port, apiToken, permissionMode } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.allowedTools = allowedTools || []
    this.model = model || null
    this.permissionMode = permissionMode || 'approve'
    this._port = port || null
    this._apiToken = apiToken || null
    this._sessionId = null
    this._child = null
    this._destroying = false
    this._messageCounter = 0
    this._rl = null
    this._stderrRL = null

    // Persistent-process state
    this._isBusy = false
    this._processReady = false
    this._currentMessageId = null
    this._currentCtx = null
    this._pendingMessage = null
    this._respawnCount = 0
    this._respawnTimer = null
    this._resultTimeout = null
    this._interruptTimer = null

    // Hook registration retry state
    this._hookRetryCount = 0
    this._hookRetryTimer = null
    this._hookRegistered = false
  }

  get sessionId() {
    return this._sessionId
  }

  /** Backward compat: returns true when processing a message */
  get isRunning() {
    return this._isBusy
  }

  /** True when process is alive and ready to accept a message */
  get isReady() {
    return this._processReady && !this._isBusy
  }

  /**
   * Start the persistent Claude process. Call once after construction.
   */
  start() {
    // Register permission hook before starting the process (only once, not on respawn)
    if (this._port && this._respawnCount === 0) {
      this._registerPermissionHook()
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

    console.log(`[cli-session] Starting persistent process (model: ${this.model || 'default'}, permission: ${this.permissionMode})`)
    this._spawnPersistentProcess(args)
  }

  /**
   * Spawn the persistent claude process and wire up event handlers.
   */
  _spawnPersistentProcess(args) {
    this._cleanupReadlines()
    this._processReady = false

    const child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        CLAUDE_HEADLESS: '1',
        CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
        ...(this._port ? { CHROXY_PORT: String(this._port) } : {}),
        ...(this._apiToken ? { CHROXY_TOKEN: this._apiToken } : {}),
        CHROXY_PERMISSION_MODE: this.permissionMode,
      },
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
        console.log(`[cli-session] stderr: ${line}`)
      }
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

      // Safety net: if we were mid-message, close the stream
      if (this._isBusy && this._currentMessageId) {
        if (this._currentCtx?.hasStreamStarted) {
          this.emit('stream_end', { messageId: this._currentMessageId })
        }
        this._clearMessageState()
      }

      console.log(`[cli-session] Process exited (code ${code}), scheduling respawn`)
      this.emit('error', { message: 'Claude process exited unexpectedly, restarting...' })
      this._scheduleRespawn()
    })

    // stdin is writable immediately — process is ready for NDJSON messages.
    // system.init arrives with the first response, not at startup.
    this._processReady = true
    console.log('[cli-session] Process started, ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })

    // Dequeue any message that arrived during respawn
    if (this._pendingMessage) {
      const pending = this._pendingMessage
      this._pendingMessage = null
      console.log('[cli-session] Dequeuing pending message')
      this.sendMessage(pending)
    }
  }

  /**
   * Schedule a respawn with exponential backoff.
   * Backoff: 1s, 2s, 4s, 8s, 15s (max). Cap at 5 retries then stop.
   */
  _scheduleRespawn() {
    if (this._destroying) return

    this._respawnCount++
    if (this._respawnCount > 5) {
      console.error('[cli-session] Max respawn attempts reached (5), giving up')
      this.emit('error', { message: 'Claude process failed to stay alive after 5 attempts' })
      return
    }

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._respawnCount - 1, delays.length - 1)]
    console.log(`[cli-session] Respawning in ${delay}ms (attempt ${this._respawnCount}/5)`)

    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null
      if (!this._destroying) {
        this.start()
      }
    }, delay)
  }

  /**
   * Send a message to Claude via stdin NDJSON.
   */
  sendMessage(prompt) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }

    if (!this._processReady) {
      console.log('[cli-session] Process not ready, queuing message')
      this._pendingMessage = prompt
      return
    }

    this._isBusy = true
    this._messageCounter++
    this._currentMessageId = `msg-${this._messageCounter}`
    this._currentCtx = { hasStreamStarted: false, didStreamText: false, currentContentBlockType: null }

    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    })

    console.log(`[cli-session] Sending message ${this._currentMessageId}: "${prompt.slice(0, 60)}"`)
    this._child.stdin.write(ndjson + '\n')

    // Safety timeout: force-clear if result never arrives (5 min)
    this._resultTimeout = setTimeout(() => {
      if (this._isBusy) {
        console.warn('[cli-session] Result timeout (5 min) — force-clearing busy state')
        const messageId = this._currentMessageId
        if (this._currentCtx?.hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        this._clearMessageState()
        this.emit('error', { message: 'Response timed out after 5 minutes' })
      }
    }, 300_000)
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
          console.log(`[cli-session] Session initialized: ${data.session_id}`)
          this.emit('ready', {
            sessionId: data.session_id,
            model: data.model,
            tools: data.tools,
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
              this.emit('tool_start', {
                messageId,
                tool: event.content_block.name,
                input: null,
              })
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
            }
            break
          }

          case 'content_block_stop': {
            if (ctx) ctx.currentContentBlockType = null
            break
          }
        }
        break
      }

      case 'assistant': {
        // The assistant event fires repeatedly with --include-partial-messages.
        // Text is only emitted here as a fallback for non-streamed responses.
        // If streaming has started (hasStreamStarted), text arrives via deltas —
        // emitting it here too would create duplicate/fragmented response bubbles.
        // Only emit when ctx exists (i.e., when processing a user request) to
        // filter out startup hints that arrive before the first message.
        const ctx = this._currentCtx
        const content = data.message?.content
        if (Array.isArray(content) && ctx) {
          for (const block of content) {
            if (block.type === 'text' && ctx && !ctx.didStreamText && !ctx.hasStreamStarted) {
              this.emit('message', {
                type: 'response',
                content: block.text,
                timestamp: Date.now(),
              })
            }
            // tool_use blocks are handled by content_block_start → tool_start event;
            // emitting them here too would create duplicate tool messages in the app
          }
        }
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
   */
  _clearMessageState() {
    this._isBusy = false
    this._currentMessageId = null
    this._currentCtx = null
    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
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
    if (this._isBusy) {
      console.warn('[cli-session] Ignoring model change while message is in-flight')
      return
    }

    const newModel = model ? resolveModelId(model) : null
    const changed = newModel !== this.model
    this.model = newModel

    if (!changed) {
      console.log(`[cli-session] Model unchanged: ${this.model || 'default'}`)
      return
    }

    console.log(`[cli-session] Model changed to ${this.model || 'default'}, restarting process`)

    // Suppress auto-respawn while we kill the old process
    this._destroying = true
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

    this._cleanupReadlines()

    if (this._child) {
      // Start the new process only after the old one is fully dead.
      // The close handler from _spawnPersistentProcess sees _destroying=true
      // and returns early. Our handler then starts the new process.
      const oldChild = this._child
      this._child = null

      let didClose = false
      const respawn = () => {
        if (didClose) return
        didClose = true
        this._destroying = false
        this._respawnCount = 0
        this.start()
      }

      oldChild.on('close', () => {
        clearTimeout(forceKillTimer)
        respawn()
      })

      // Force-kill after 10s if process doesn't exit cleanly
      const forceKillTimer = setTimeout(() => {
        if (!didClose) {
          console.warn('[cli-session] Process did not exit after 10s, force-killing with SIGKILL')
          try {
            oldChild.kill('SIGKILL')
          } catch (err) {
            // Process may already be gone, that's fine
          }
          respawn()
        }
      }, 10000)

      oldChild.kill('SIGTERM')
    } else {
      this._destroying = false
      this._respawnCount = 0
      this.start()
    }
  }

  /**
   * Change the permission mode for subsequent messages.
   * Kills the current process and respawns with the new mode (new session).
   */
  setPermissionMode(mode) {
    const VALID_MODES = ['approve', 'auto', 'plan']
    if (!VALID_MODES.includes(mode)) {
      console.warn(`[cli-session] Ignoring invalid permission mode: ${mode}`)
      return
    }

    if (this._isBusy) {
      console.warn('[cli-session] Ignoring permission mode change while message is in-flight')
      return
    }

    if (mode === this.permissionMode) {
      console.log(`[cli-session] Permission mode unchanged: ${this.permissionMode}`)
      return
    }

    console.log(`[cli-session] Permission mode changed to ${mode}, restarting process`)
    this.permissionMode = mode

    // Same kill-and-respawn pattern as setModel()
    this._destroying = true
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

    this._cleanupReadlines()

    if (this._child) {
      const oldChild = this._child
      this._child = null

      let didClose = false
      const respawn = () => {
        if (didClose) return
        didClose = true
        this._destroying = false
        this._respawnCount = 0
        this.start()
      }

      oldChild.on('close', () => {
        clearTimeout(forceKillTimer)
        respawn()
      })

      // Force-kill after 10s if process doesn't exit cleanly
      const forceKillTimer = setTimeout(() => {
        if (!didClose) {
          console.warn('[cli-session] Process did not exit after 10s, force-killing with SIGKILL')
          try {
            oldChild.kill('SIGKILL')
          } catch (err) {
            // Process may already be gone, that's fine
          }
          respawn()
        }
      }, 10000)

      oldChild.kill('SIGTERM')
    } else {
      this._destroying = false
      this._respawnCount = 0
      this.start()
    }
  }

  /** Interrupt the current message (send SIGINT to child process) */
  interrupt() {
    if (!this._child) return

    console.log('[cli-session] Sending SIGINT to claude process')
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
        console.warn('[cli-session] Interrupt safety timeout — force-clearing busy state')
        const messageId = this._currentMessageId
        if (this._currentCtx?.hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }
        this._clearMessageState()
      }
    }, 5000)
  }

  /**
   * Register the Chroxy permission hook in ~/.claude/settings.json.
   * Adds a PreToolUse hook that forwards all tool requests to our HTTP endpoint.
   *
   * Serialized via module-level lock to prevent concurrent write races
   * when multiple sessions start simultaneously.
   */
  _registerPermissionHook() {
    return withSettingsLock(() => this._registerPermissionHookSync())
  }

  _registerPermissionHookSync() {
    try {
      const hookScript = resolve(__dirname, '..', 'hooks', 'permission-hook.sh')
      const settingsPath = resolve(homedir(), '.claude', 'settings.json')

      let settings = {}
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      } catch (err) {
        if (err.code === 'ENOENT') {
          // File doesn't exist — start fresh
          mkdirSync(resolve(homedir(), '.claude'), { recursive: true })
        } else {
          // File exists but contains invalid JSON — schedule retry
          const errMsg = `Cannot parse ${settingsPath}: ${err.message}. Will retry hook registration.`
          console.error(`[cli-session] ${errMsg}`)
          this.emit('error', { message: errMsg })
          this._scheduleHookRetry()
          return
        }
      }

      if (!settings.hooks) settings.hooks = {}
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = []

      // Remove any existing Chroxy hook entry
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
        (entry) => !entry._chroxy
      )

      // Add our hook — script reads CHROXY_PORT and CHROXY_TOKEN from env vars
      // (inherited by the spawned Claude process). Non-Chroxy sessions don't
      // have these vars, so the hook falls through to normal permission prompts.
      settings.hooks.PreToolUse.push({
        _chroxy: true,
        matcher: '',  // empty string matches all tools
        hooks: [
          {
            type: 'command',
            command: hookScript,
            timeout: 300,
          },
        ],
      })

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      console.log('[cli-session] Registered permission hook in ~/.claude/settings.json')

      // Clear any pending retry timer
      if (this._hookRetryTimer) {
        clearTimeout(this._hookRetryTimer)
        this._hookRetryTimer = null
      }

      this._hookRegistered = true
      this._hookRetryCount = 0
    } catch (err) {
      const errMsg = `Failed to register permission hook: ${err.message}. Will retry hook registration.`
      console.error(`[cli-session] ${errMsg}`)
      this.emit('error', { message: errMsg })
      this._scheduleHookRetry()
    }
  }

  /**
   * Schedule a retry of hook registration with exponential backoff.
   * Delays: 2s, 5s, 10s. Max 3 attempts.
   */
  _scheduleHookRetry() {
    if (this._destroying || this._hookRegistered) return

    // If a retry is already scheduled, don't schedule another one
    if (this._hookRetryTimer) return

    this._hookRetryCount++
    if (this._hookRetryCount > 3) {
      const errMsg = 'Hook registration failed after 3 attempts. Please check ~/.claude/settings.json and restart the server. Permissions will not work until this is fixed.'
      console.error(`[cli-session] ${errMsg}`)
      this.emit('error', { message: errMsg })
      return
    }

    const delays = [2000, 5000, 10000]
    const delay = delays[this._hookRetryCount - 1]
    console.log(`[cli-session] Hook registration failed, retrying in ${delay / 1000}s (attempt ${this._hookRetryCount}/3)`)

    this._hookRetryTimer = setTimeout(() => {
      this._hookRetryTimer = null
      if (!this._destroying && !this._hookRegistered) {
        this._registerPermissionHook()
      }
    }, delay)
  }

  /**
   * Remove the Chroxy permission hook from ~/.claude/settings.json.
   *
   * Serialized via module-level lock to prevent concurrent write races
   * when multiple sessions stop simultaneously.
   */
  _unregisterPermissionHook() {
    return withSettingsLock(() => this._unregisterPermissionHookSync())
  }

  _unregisterPermissionHookSync() {
    try {
      const settingsPath = resolve(homedir(), '.claude', 'settings.json')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))

      if (settings.hooks?.PreToolUse) {
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
          (entry) => !entry._chroxy
        )
        // Clean up empty arrays
        if (settings.hooks.PreToolUse.length === 0) {
          delete settings.hooks.PreToolUse
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
        console.log('[cli-session] Unregistered permission hook from ~/.claude/settings.json')
      }
    } catch (err) {
      console.error(`[cli-session] Failed to unregister permission hook: ${err.message}`)
    }
  }

  /** Clean up resources */
  destroy() {
    this._destroying = true

    // Clean up hook retry timer
    if (this._hookRetryTimer) {
      clearTimeout(this._hookRetryTimer)
      this._hookRetryTimer = null
    }

    // Remove permission hook from settings
    if (this._port) {
      this._unregisterPermissionHook()
    }

    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer)
      this._respawnTimer = null
    }

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
        try { child.kill('SIGKILL') } catch {}
      }, 3000)

      child.on('close', () => clearTimeout(forceKillTimer))
      this._child = null
    }

    this._isBusy = false
    this._processReady = false
    this.removeAllListeners()
  }
}
