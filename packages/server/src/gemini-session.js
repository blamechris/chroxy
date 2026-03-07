import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'

/**
 * Manages a Gemini CLI session using `gemini -p --output-format stream-json`.
 *
 * Implements the same EventEmitter interface as SdkSession/CliSession so
 * SessionManager and WsServer work identically regardless of provider.
 *
 * Gemini CLI supports `--output-format stream-json` which outputs NDJSON events.
 * The exact event format depends on the Gemini CLI version; this provider
 * maps the most common patterns to the standard Chroxy event stream.
 *
 * Events emitted (standard provider contract):
 *   ready        { model }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   tool_start   { messageId, toolUseId, tool, input }
 *   tool_result  { toolUseId, result }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 */

const DEFAULT_MODEL = 'gemini-2.5-pro'

function resolveGemini() {
  try {
    return execFileSync('which', ['gemini'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch { /* not on PATH */ }

  const candidates = [
    '/opt/homebrew/bin/gemini',
    '/usr/local/bin/gemini',
    '/usr/bin/gemini',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'gemini'
}

const GEMINI = resolveGemini()

export class GeminiSession extends EventEmitter {
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
    this.isRunning = false
    this.resumeSessionId = null
    this._process = null
    this._messageCounter = 0
    this._destroying = false
  }

  start() {
    this.isRunning = true
    process.nextTick(() => {
      this.emit('ready', { model: this.model })
    })
  }

  destroy() {
    this._destroying = true
    this.isRunning = false
    if (this._process) {
      try {
        this._process.kill('SIGTERM')
      } catch { /* already dead */ }
      this._process = null
    }
    this.removeAllListeners()
  }

  sendMessage(text) {
    if (!this.isRunning) {
      this.emit('error', { message: 'Session is not running' })
      return
    }

    const args = ['-p', text, '--output-format', 'stream-json', '-y']
    if (this.model) {
      args.push('-m', this.model)
    }

    const proc = spawn(GEMINI, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this._process = proc

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseGeminiLine(line)
      if (event) {
        this._processGeminiEvent(event)
      }
    })

    proc.stderr.on('data', (chunk) => {
      if (this._destroying) return
      const text = chunk.toString().trim()
      if (text && !text.includes('DeprecationWarning')) {
        console.error(`[gemini] stderr: ${text}`)
      }
    })

    proc.on('close', (code) => {
      this._process = null
      if (this._destroying) return
      if (code !== 0 && code !== null) {
        this.emit('error', { message: `Gemini process exited with code ${code}` })
      }
    })

    proc.on('error', (err) => {
      this._process = null
      if (this._destroying) return
      this.emit('error', { message: err.message || 'Failed to spawn gemini' })
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
    // Gemini CLI doesn't support permission mode switching from Chroxy
  }

  /**
   * Parse a JSONL line from Gemini stdout.
   * @param {string} line - Raw JSONL line
   * @returns {Object|null} Parsed event or null if invalid
   */
  _parseGeminiLine(line) {
    if (!line || !line.trim()) return null
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }

  /**
   * Map a Gemini event to the standard Chroxy event stream.
   *
   * Gemini CLI stream-json format emits events with varying shapes.
   * This handler maps the most common patterns:
   *   - assistant events with text content → stream_start/delta/end
   *   - assistant events with tool_use → tool_start
   *   - tool_result events → tool_result
   *   - result events → result
   *
   * @param {Object} event - Parsed Gemini JSONL event
   */
  _processGeminiEvent(event) {
    if (!event || !event.type) return

    switch (event.type) {
      case 'assistant': {
        if (!event.content || !Array.isArray(event.content)) break
        for (const block of event.content) {
          if (block.type === 'text') {
            const messageId = `gemini-msg-${++this._messageCounter}`
            this.emit('stream_start', { messageId })
            this.emit('stream_delta', { messageId, delta: block.text || '' })
            this.emit('stream_end', { messageId })
          } else if (block.type === 'tool_use') {
            const messageId = `gemini-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId,
              toolUseId: block.id || messageId,
              tool: block.name || 'unknown',
              input: block.input || {},
            })
          }
        }
        break
      }

      case 'tool_result': {
        this.emit('tool_result', {
          toolUseId: event.tool_use_id || event.id || '',
          result: event.content || event.output || '',
        })
        break
      }

      case 'result': {
        const usage = event.usage || {}
        this.emit('result', {
          cost: null,
          duration: null,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          },
          sessionId: null,
        })
        break
      }

      default:
        // Unknown event — ignore
        break
    }
  }
}
