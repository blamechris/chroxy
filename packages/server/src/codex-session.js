import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'

/**
 * Manages a Codex CLI session using `codex exec --json`.
 *
 * Implements the same EventEmitter interface as SdkSession/CliSession so
 * SessionManager and WsServer work identically regardless of provider.
 *
 * Codex JSONL event types:
 *   thread.started  - Session initialized with thread_id
 *   turn.started    - New turn begins
 *   item.completed  - Item finished: agent_message, reasoning, tool_call, tool_result
 *   turn.completed  - Turn ends with usage stats
 *
 * Events emitted (standard provider contract):
 *   ready        { model }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 */

const DEFAULT_MODEL = 'codex-mini-latest'

function resolveCodex() {
  try {
    return execFileSync('which', ['codex'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch { /* not on PATH */ }

  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'codex'
}

const CODEX = resolveCodex()

export class CodexSession extends EventEmitter {
  static get capabilities() {
    return {
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
    }
  }

  constructor({ cwd, model, permissionMode } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.model = model || DEFAULT_MODEL
    this.permissionMode = permissionMode || 'auto'
    this._isReady = false
    this._isBusy = false
    this.resumeSessionId = null
    this._process = null
    this._messageCounter = 0
    this._destroying = false
    this._threadId = null
  }

  get isRunning() {
    return this._isBusy
  }

  get isReady() {
    return this._isReady
  }

  start() {
    this._isReady = true
    // Emit ready asynchronously to match SdkSession/CliSession behavior
    process.nextTick(() => {
      this.emit('ready', { sessionId: null, model: this.model, tools: [] })
    })
  }

  destroy() {
    this._destroying = true
    this._isReady = false
    this._isBusy = false
    if (this._process) {
      try {
        this._process.kill('SIGTERM')
      } catch { /* already dead */ }
      this._process = null
    }
    this.removeAllListeners()
  }

  sendMessage(text, attachments, options) {
    if (!this._isReady) {
      this.emit('error', { message: 'Session is not running' })
      return
    }
    if (this._isBusy) {
      this.emit('error', { message: 'Session is busy' })
      return
    }
    if (attachments && attachments.length > 0) {
      this.emit('error', { message: 'Codex provider does not support attachments' })
      return
    }

    this._isBusy = true

    const args = ['exec', '--json']
    if (this.model) {
      args.push('-c', `model="${this.model}"`)
    }
    args.push(text)

    const proc = spawn(CODEX, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this._process = proc

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseCodexLine(line)
      if (event) {
        this._processCodexEvent(event)
      }
    })

    proc.stderr.on('data', (chunk) => {
      if (this._destroying) return
      const msg = chunk.toString().trim()
      if (msg) {
        console.error(`[codex] stderr: ${msg}`)
      }
    })

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      if (code !== 0 && code !== null) {
        this.emit('error', { message: `Codex process exited with code ${code}` })
      }
    })

    proc.on('error', (err) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      this.emit('error', { message: err.message || 'Failed to spawn codex' })
    })
  }

  interrupt() {
    if (this._process) {
      try {
        this._process.kill('SIGINT')
      } catch { /* already dead */ }
    }
  }

  setModel(model) {
    this.model = model
  }

  setPermissionMode(_mode) {
    // Codex doesn't support permission mode switching
  }

  /**
   * Parse a JSONL line from Codex stdout.
   * @param {string} line - Raw JSONL line
   * @returns {Object|null} Parsed event or null if invalid
   */
  _parseCodexLine(line) {
    if (!line || !line.trim()) return null
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }

  /**
   * Map a Codex event to the standard Chroxy event stream.
   * @param {Object} event - Parsed Codex JSONL event
   */
  _processCodexEvent(event) {
    switch (event.type) {
      case 'thread.started':
        this._threadId = event.thread_id
        break

      case 'turn.started':
        // Nothing to emit — stream_start is per-message
        break

      case 'item.completed': {
        const item = event.item
        if (!item) break

        if (item.type === 'agent_message') {
          const messageId = `codex-msg-${++this._messageCounter}`
          this.emit('stream_start', { messageId })
          this.emit('stream_delta', { messageId, delta: item.text || '' })
          this.emit('stream_end', { messageId })
        } else if (item.type === 'reasoning') {
          // Reasoning is internal — emit as a message event for visibility
          this.emit('message', {
            type: 'system',
            content: item.text || '',
            timestamp: Date.now(),
          })
        } else if (item.type === 'tool_call') {
          const messageId = `codex-tool-${++this._messageCounter}`
          this.emit('tool_start', {
            messageId,
            toolUseId: item.id || messageId,
            tool: item.name || 'unknown',
            input: item.arguments || item.input || {},
          })
        } else if (item.type === 'tool_result') {
          const toolUseId = item.tool_call_id || item.id || `codex-tool-${this._messageCounter}`
          this.emit('tool_result', {
            toolUseId,
            result: item.output || item.text || '',
          })
        }
        break
      }

      case 'turn.completed': {
        const usage = event.usage || {}
        this.emit('result', {
          cost: null, // Codex doesn't report cost per turn
          duration: null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: usage.cached_input_tokens || 0,
          },
          sessionId: this._threadId,
        })
        break
      }

      default:
        // Unknown event type — ignore
        break
    }
  }
}
