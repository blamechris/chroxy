import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { BaseSession } from './base-session.js'
import { createInterface } from 'readline'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger, redactSensitive } from './logger.js'

const log = createLogger('gemini')

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

// Resolve the gemini binary once at module load. Under a GUI launch
// (e.g. Tauri on macOS) PATH is minimal and may exclude the user's
// install dir — fall through to known locations so `spawn()` succeeds.
// Covers curl|sh installers (~/.local/bin) and `npm install -g` without
// sudo (~/.npm-global/bin).
const GEMINI = resolveBinary('gemini', [
  join(homedir(), '.local/bin/gemini'),
  '/opt/homebrew/bin/gemini',
  '/usr/local/bin/gemini',
  join(homedir(), '.npm-global/bin/gemini'),
])

// Per-provider model allowlist — #2946.
// `set_model` must reject a Claude model on a Gemini session (the CLI would
// exit opaquely). Keep this list small and explicit; issue #2956 tracks a
// proper registry fed by `gemini models list` or similar.
const GEMINI_ALLOWED_MODELS = Object.freeze([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
])

export class GeminiSession extends BaseSession {
  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'Google Gemini'
  }

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

  /**
   * Model IDs this provider accepts in `set_model`. Returns a plain array so
   * the settings handler can surface it to the client on rejection.
   * @returns {string[]}
   */
  static getAllowedModels() {
    return GEMINI_ALLOWED_MODELS
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   */
  static get preflight() {
    return {
      label: 'Gemini',
      binary: {
        name: 'gemini',
        args: ['--version'],
        candidates: [
          join(homedir(), '.local/bin/gemini'),
          '/opt/homebrew/bin/gemini',
          '/usr/local/bin/gemini',
          join(homedir(), '.npm-global/bin/gemini'),
        ],
        installHint: 'install Gemini CLI (see https://github.com/google-gemini/generative-ai-cli)',
      },
      credentials: {
        envVars: ['GEMINI_API_KEY'],
        hint: 'set GEMINI_API_KEY',
        optional: false,
      },
    }
  }

  constructor({ cwd, model, permissionMode, skillsDir } = {}) {
    super({ cwd, model: model || DEFAULT_MODEL, permissionMode: permissionMode || 'auto', skillsDir })
    this.resumeSessionId = null
    this._process = null
    // Skills MVP (#2957) — Gemini CLI has no system-prompt flag, so prepend
    // skills to the first user message only.
    this._skillsPrepended = false
  }

  start() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is not set')
    }
    this._processReady = true
    process.nextTick(() => {
      this.emit('ready', { sessionId: null, model: this.model, tools: [] })
    })
  }

  /**
   * Build the env for the gemini subprocess.
   *
   * Uses an explicit allowlist so operator secrets (ANTHROPIC_API_KEY,
   * OPENAI_API_KEY, CHROXY_HOOK_SECRET, arbitrary DB credentials, etc.)
   * never leak into a third-party CLI's environment.
   */
  _buildChildEnv() {
    return buildSpawnEnv('gemini')
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

    // Skills MVP (#2957) — prepend skills to the first user message of the
    // session (Gemini CLI has no system-prompt flag).
    let effectiveText = text
    if (!this._skillsPrepended) {
      const skillsText = this._buildSystemPrompt()
      if (skillsText) {
        effectiveText = `${skillsText}\n\n---\n\n${text}`
      }
      this._skillsPrepended = true
    }

    const args = ['-p', effectiveText, '--output-format', 'stream-json', '-y']
    if (this.model) {
      args.push('-m', this.model)
    }

    let stderrBuf = ''
    const proc = spawn(GEMINI, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this._buildChildEnv(),
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
        if (stderrBuf.length < 1024) stderrBuf += (stderrBuf ? '\n' : '') + msg
        log.error(`stderr: ${msg}`)
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
        const detail = stderrBuf ? `: ${redactSensitive(stderrBuf.slice(0, 500))}` : ''
        this.emit('error', { message: `Gemini process exited with code ${code}${detail}` })
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
    return super.setModel(model)
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
