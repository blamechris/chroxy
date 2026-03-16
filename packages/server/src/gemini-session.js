import { spawn } from 'child_process'
import { BaseSession } from './base-session.js'
import { createInterface } from 'readline'
import { resolveBinary } from './utils/resolve-binary.js'

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

const GEMINI = resolveBinary('gemini', [
  '/opt/homebrew/bin/gemini',
  '/usr/local/bin/gemini',
  '/usr/bin/gemini',
])

export class GeminiSession extends BaseSession {
  static get capabilities() {
    return {
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
      thinkingLevel: false,
    }
  }

  constructor({ cwd, model, permissionMode } = {}) {
    super({ cwd, model: model || DEFAULT_MODEL, permissionMode: permissionMode || 'auto' })
    this.resumeSessionId = null
    this._process = null
  }

  start() {
    this._processReady = true
    process.nextTick(() => {
      this.emit('ready', { sessionId: null, model: this.model, tools: [] })
    })
  }

  destroy() {
    this._destroying = true
    this._processReady = false
    this._isBusy = false
    if (this._process) {
      try {
        this._process.kill('SIGTERM')
      } catch { /* already dead */ }
      this._process = null
    }
    this.removeAllListeners()
  }

  async sendMessage(text, attachments, options) {
    if (!this._processReady) {
      this.emit('error', { message: 'Session is not running' })
      return
    }
    if (this._isBusy) {
      this.emit('error', { message: 'Session is busy' })
      return
    }
    if (attachments && attachments.length > 0) {
      this.emit('error', { message: 'Gemini provider does not support attachments' })
      return
    }

    this._isBusy = true
    this._currentMessageId = `gemini-msg-${++this._messageCounter}`

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
    let didStreamStart = false

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseJsonLine(line)
      if (event) {
        // For assistant text, use a single stream per sendMessage call
        if (event.type === 'assistant' && event.content && Array.isArray(event.content)) {
          for (const block of event.content) {
            if (block.type === 'text') {
              if (!didStreamStart) {
                this.emit('stream_start', { messageId: this._currentMessageId })
                didStreamStart = true
              }
              this.emit('stream_delta', { messageId: this._currentMessageId, delta: block.text || '' })
            }
          }
        }
        this._processGeminiEvent(event, didStreamStart)
      }
    })

    proc.stderr.on('data', (chunk) => {
      if (this._destroying) return
      const msg = chunk.toString().trim()
      if (msg && !msg.includes('DeprecationWarning')) {
        console.error(`[gemini] stderr: ${msg}`)
      }
    })

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      // End any open stream
      if (didStreamStart) {
        this.emit('stream_end', { messageId: this._currentMessageId })
      }
      if (code !== 0 && code !== null) {
        this.emit('error', { message: `Gemini process exited with code ${code}` })
      }
      // Emit result so clients transition from busy to idle
      this.emit('result', {
        cost: null,
        duration: null,
        usage: null,
        sessionId: null,
      })
    })

    proc.on('error', (err) => {
      this._process = null
      this._isBusy = false
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
        // Text blocks handled in sendMessage for unified streaming
        // Only process tool_use blocks here
        if (!event.content || !Array.isArray(event.content)) break
        for (const block of event.content) {
          if (block.type === 'tool_use') {
            const toolMessageId = `gemini-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId: toolMessageId,
              toolUseId: block.id || toolMessageId,
              tool: block.name || 'unknown',
              input: block.input || {},
            })
          }
        }
        break
      }

      case 'tool_result': {
        const toolUseId = event.tool_use_id || event.id || `gemini-tool-${this._messageCounter}`
        this.emit('tool_result', {
          toolUseId,
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
