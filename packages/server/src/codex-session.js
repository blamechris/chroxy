import { spawn } from 'child_process'
import { BaseSession } from './base-session.js'
import { createInterface } from 'readline'
import { resolveBinary } from './utils/resolve-binary.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { createLogger, redactSensitive } from './logger.js'

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

/**
 * No default model is hard-coded here.
 *
 * Previously this module shipped `DEFAULT_MODEL = 'gpt-5.4'`, which pinned
 * the server to a specific Codex release and caused `codex exec -c model=...`
 * to fail whenever that version wasn't available on the host. Instead we now
 * pass `null` through to `BaseSession` when no model is supplied, and
 * `buildCodexArgs()` below omits the `-c model=...` override so Codex CLI
 * falls back to whatever default is configured in `~/.codex/config.toml`.
 */
const DEFAULT_MODEL = null

const CODEX = resolveBinary('codex', [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/usr/bin/codex',
])

/**
 * Build the argv passed to `codex exec`. Exported for unit testing.
 *
 * @param {string} text   User prompt
 * @param {string|null} model  Optional model ID. If falsy, no `-c model=` flag
 *                              is appended — Codex CLI uses its own default.
 * @returns {string[]}
 */
export function buildCodexArgs(text, model) {
  const args = ['exec', text, '--json']
  if (model) {
    args.push('-c', `model="${model}"`)
  }
  return args
}

// Per-provider model allowlist — #2946.
// `set_model` must reject a Claude or Gemini model on a Codex session (the
// CLI would exit opaquely). Keep this list small and explicit; issue #2956
// tracks a proper registry fed by the Codex CLI itself.
const CODEX_ALLOWED_MODELS = Object.freeze([
  'gpt-5-codex',
  'gpt-5',
  'gpt-4.1',
  'gpt-4o',
  'o1',
  'o3',
])

export class CodexSession extends BaseSession {
  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'OpenAI Codex'
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
    return CODEX_ALLOWED_MODELS
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   */
  static get preflight() {
    return {
      label: 'Codex',
      binary: {
        name: 'codex',
        args: ['--version'],
        candidates: [
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          '/usr/bin/codex',
        ],
        installHint: 'install Codex CLI',
      },
      credentials: {
        envVars: ['OPENAI_API_KEY'],
        hint: 'set OPENAI_API_KEY',
        optional: false,
      },
    }
  }

  constructor({ cwd, model, permissionMode } = {}) {
    // `model` may be null/undefined — BaseSession coerces to null and
    // buildCodexArgs() omits the `-c model=...` flag so Codex CLI defers
    // to its own default from ~/.codex/config.toml.
    super({ cwd, model: model || DEFAULT_MODEL, permissionMode: permissionMode || 'auto' })
    this.resumeSessionId = null
    this._process = null
  }

  start() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set')
    }
    this._processReady = true
    process.nextTick(() => {
      this.emit('ready', { sessionId: null, model: this.model, tools: [] })
    })
  }

  /**
   * Build the env for the codex subprocess.
   *
   * Uses an explicit allowlist so operator secrets (ANTHROPIC_API_KEY,
   * CHROXY_HOOK_SECRET, arbitrary DB credentials, etc.) never leak into a
   * third-party CLI's environment.
   */
  _buildChildEnv() {
    return buildSpawnEnv('codex')
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

    const args = buildCodexArgs(text, this.model)

    let stderrBuf = ''
    const proc = spawn(CODEX, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this._buildChildEnv(),
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
      if (msg && (msg.includes('ERROR') || msg.includes('WARN') || msg.includes('error') || msg.includes('not set'))) {
        if (stderrBuf.length < 1024) stderrBuf += (stderrBuf ? '\n' : '') + msg
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
        const detail = stderrBuf ? `: ${redactSensitive(stderrBuf.slice(0, 500))}` : ''
        this.emit('error', { message: `Codex process exited with code ${code}${detail}` })
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
