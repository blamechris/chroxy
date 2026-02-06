import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createInterface } from 'readline'

/**
 * Manages a Claude Code CLI session using headless mode (`claude -p`).
 *
 * Each user message spawns a new `claude -p` process with `--output-format stream-json`.
 * Subsequent messages reuse the session via `--resume <sessionId>`.
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
  constructor({ cwd, allowedTools, model } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.allowedTools = allowedTools || []
    this.model = model || null
    this._sessionId = null
    this._child = null
    this._isRunning = false
    this._messageCounter = 0
  }

  get sessionId() {
    return this._sessionId
  }

  get isRunning() {
    return this._isRunning
  }

  /**
   * Send a message to Claude. Spawns a `claude -p` process, streams events,
   * and resolves when the process exits.
   */
  sendMessage(prompt) {
    if (this._isRunning) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }

    this._isRunning = true
    this._messageCounter++
    const messageId = `msg-${this._messageCounter}`

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (this._sessionId) {
      args.push('--resume', this._sessionId)
    }

    if (this.model) {
      args.push('--model', this.model)
    }

    if (this.allowedTools.length > 0) {
      args.push('--allowedTools', this.allowedTools.join(','))
    }

    const resumeId = this._sessionId
    console.log(`[cli-session] Spawning: claude -p "${prompt.slice(0, 60)}"${resumeId ? ` --resume ${resumeId}` : ''}`)

    this._spawnProcess(args, prompt, messageId, resumeId)
  }

  /** Spawn the claude process and wire up event handlers */
  _spawnProcess(args, prompt, messageId, resumeId) {
    const child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this._child = child

    // Close stdin — claude -p takes prompt via args, not stdin
    child.stdin.end()

    // Read stdout line by line — each line is a JSON object
    const rl = createInterface({ input: child.stdout })
    let hasStreamStarted = false
    let didStreamText = false
    let currentContentBlockType = null

    rl.on('line', (line) => {
      if (!line.trim()) return

      let data
      try {
        data = JSON.parse(line)
      } catch {
        // Not JSON — could be stderr leak or debug output
        return
      }

      this._handleEvent(data, messageId, {
        get hasStreamStarted() { return hasStreamStarted },
        set hasStreamStarted(v) { hasStreamStarted = v },
        get didStreamText() { return didStreamText },
        set didStreamText(v) { didStreamText = v },
        get currentContentBlockType() { return currentContentBlockType },
        set currentContentBlockType(v) { currentContentBlockType = v },
      })
    })

    // Log stderr for debugging (Claude CLI may print warnings there)
    const stderrRL = createInterface({ input: child.stderr })
    stderrRL.on('line', (line) => {
      if (line.trim()) {
        console.log(`[cli-session] stderr: ${line}`)
      }
    })

    child.on('error', (err) => {
      this._isRunning = false
      this._child = null
      this.emit('error', { message: `Failed to spawn claude: ${err.message}` })
    })

    child.on('close', (code) => {
      this._isRunning = false
      this._child = null

      // If stream was open, close it
      if (hasStreamStarted) {
        this.emit('stream_end', { messageId })
      }

      // If resume failed (exit code 1), retry without --resume
      if (code === 1 && resumeId) {
        console.log(`[cli-session] Resume failed for session ${resumeId}, starting fresh`)
        this._sessionId = null
        this._isRunning = true
        const freshArgs = args.filter((a, i) => {
          if (a === '--resume') return false
          if (i > 0 && args[i - 1] === '--resume') return false
          return true
        })
        this._spawnProcess(freshArgs, prompt, messageId, null)
        return
      }

      if (code !== 0 && code !== null) {
        console.log(`[cli-session] Process exited with code ${code}`)
      }
    })
  }

  /** Handle a single parsed JSON event from Claude CLI stdout */
  _handleEvent(data, messageId, ctx) {
    switch (data.type) {
      case 'system': {
        if (data.subtype === 'init') {
          this._sessionId = data.session_id
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
            } else if (delta.type === 'input_json_delta' && ctx.currentContentBlockType === 'tool_use') {
              // Tool input streaming — we could emit partial tool input if needed
            }
            break
          }

          case 'content_block_stop': {
            if (ctx.currentContentBlockType === 'text' && ctx.hasStreamStarted) {
              this.emit('stream_end', { messageId })
              ctx.hasStreamStarted = false
            }
            ctx.currentContentBlockType = null
            break
          }
        }
        break
      }

      case 'assistant': {
        // Complete assistant message — only emit for content not already streamed
        const content = data.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && !ctx.didStreamText) {
              // Text wasn't streamed — emit as a complete message
              this.emit('message', {
                type: 'response',
                content: block.text,
                timestamp: Date.now(),
              })
            } else if (block.type === 'tool_use') {
              this.emit('message', {
                type: 'tool_use',
                content: JSON.stringify(block.input, null, 2),
                tool: block.name,
                timestamp: Date.now(),
              })
            }
          }
        }
        break
      }

      case 'result': {
        if (data.session_id) {
          this._sessionId = data.session_id
        }
        this.emit('result', {
          sessionId: data.session_id,
          cost: data.total_cost_usd,
          duration: data.duration_ms,
          usage: data.usage,
        })
        break
      }
    }
  }

  /** Interrupt the current message (send SIGINT to child process) */
  interrupt() {
    if (this._child) {
      console.log('[cli-session] Sending SIGINT to claude process')
      this._child.kill('SIGINT')
    }
  }

  /** Clean up resources */
  destroy() {
    if (this._child) {
      this._child.kill('SIGTERM')
      this._child = null
    }
    this._isRunning = false
    this.removeAllListeners()
  }
}
