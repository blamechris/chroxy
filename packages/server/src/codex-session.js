import { spawn } from 'child_process'
import { BaseSession } from './base-session.js'
import { createInterface } from 'readline'
import { resolveBinary } from './utils/resolve-binary.js'
import { createLogger } from './logger.js'

const log = createLogger('codex')

/**
 * Manages a Codex CLI session using `codex exec --json`.
 *
 * Implements the same EventEmitter interface as SdkSession/CliSession so
 * SessionManager and WsServer work identically regardless of provider.
 *
 * Codex CLI outputs JSONL events via --json flag:
 *   thread.started  { thread_id }
 *   turn.started    {}
 *   item.completed  { item: { id, type, text, ... } }
 *   turn.completed  { usage: { input_tokens, output_tokens, cached_input_tokens } }
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

const DEFAULT_MODEL = 'o4-mini'

const CODEX = resolveBinary('codex', [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/usr/bin/codex',
])

export class CodexSession extends BaseSession {
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
      this.emit('error', { message: 'Codex provider does not support attachments' })
      return
    }

    this._isBusy = true
    this._currentMessageId = `codex-msg-${++this._messageCounter}`

    const args = ['exec', text, '--json']
    if (this.model) {
      args.push('-c', `model="${this.model}"`)
    }

    const proc = spawn(CODEX, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this._process = proc
    let didStreamStart = false
    let didEmitResult = false

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseJsonLine(line)
      if (!event || !event.type) return

      switch (event.type) {
        case 'item.completed': {
          const item = event.item
          if (!item) break

          if (item.type === 'agent_message' && item.text) {
            if (!didStreamStart) {
              this.emit('stream_start', { messageId: this._currentMessageId })
              didStreamStart = true
            }
            this.emit('stream_delta', { messageId: this._currentMessageId, delta: item.text })
          } else if (item.type === 'tool_call') {
            const toolMessageId = `codex-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId: toolMessageId,
              toolUseId: item.id || toolMessageId,
              tool: item.name || 'unknown',
              input: item.arguments || item.input || {},
            })
          } else if (item.type === 'tool_output') {
            this.emit('tool_result', {
              toolUseId: item.call_id || item.id || `codex-tool-${this._messageCounter}`,
              result: item.output || item.text || '',
            })
          }
          break
        }

        case 'turn.completed': {
          didEmitResult = true
          // End stream before result (standard provider contract)
          if (didStreamStart) {
            this.emit('stream_end', { messageId: this._currentMessageId })
            didStreamStart = false
          }
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
          break
      }
    })

    proc.stderr.on('data', (chunk) => {
      if (this._destroying) return
      const msg = chunk.toString().trim()
      if (msg && (msg.includes('ERROR') || msg.includes('WARN'))) {
        log.error(`stderr: ${msg}`)
      }
    })

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      if (didStreamStart) {
        this.emit('stream_end', { messageId: this._currentMessageId })
      }
      if (code !== 0 && code !== null) {
        this.emit('error', { message: `Codex process exited with code ${code}` })
      }
      // Emit result only if turn.completed wasn't received
      if (!didEmitResult) {
        this.emit('result', {
          cost: null,
          duration: null,
          usage: null,
          sessionId: null,
        })
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

  setPermissionMode(_mode) {
    // Codex CLI doesn't support permission mode switching from Chroxy
  }

}
