import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { BaseSession } from './base-session.js'

/**
 * JsonlSubprocessSession — shared spawn/readline/event-handling for session
 * providers that drive a CLI as a one-shot JSONL subprocess per message
 * (Codex, Gemini; future: Aider, Ollama).
 *
 * Subclasses supply the binary, the argv builder, the event mapper, and a few
 * descriptive constants; everything else (process lifecycle, readline loop,
 * stderr capture, error propagation, busy-flag bookkeeping) lives here.
 *
 * Required subclass overrides (statics):
 *   - binaryCandidates   — array of absolute binary paths tried in order
 *   - resolvedBinary     — result of resolveBinary(name, candidates)
 *   - apiKeyEnv          — env var name required for start() (e.g. 'OPENAI_API_KEY')
 *   - providerName       — short name used for log prefixes / error text (e.g. 'codex')
 *   - displayLabel       — human label used in error text (e.g. 'Codex')
 *   - messageIdPrefix    — prefix for generated message IDs (e.g. 'codex')
 *
 * Required instance overrides:
 *   - _buildArgs(text)               — argv for spawn; inject model flag etc.
 *   - _buildChildEnv()               — env map passed to spawn (buildSpawnEnv wrapper)
 *   - _processJsonlLine(event, ctx)  — map one parsed JSONL event to emitter calls
 *
 * Optional hooks (default no-op):
 *   - _shouldSkipStderr(msg)         — return true to drop a stderr line entirely
 *   - _emitFallbackResult(ctx)       — fires on close; default emits minimal result
 *
 * The `ctx` passed to _processJsonlLine() / _emitFallbackResult() is mutable
 * and shared across all callbacks for a single sendMessage() invocation:
 *   {
 *     messageId: string,     // id shared by stream_start/delta/end for this turn
 *     didStreamStart: bool,  // has a stream_start been emitted yet?
 *     didEmitResult: bool,   // has the stream produced a `result` event?
 *     proc: ChildProcess,    // the spawned child, exposed for rare edge cases
 *   }
 */

const DEFAULT_STDERR_CAP = 1024
const STDERR_SLICE_FOR_ERROR = 500

export class JsonlSubprocessSession extends BaseSession {

  // ------------------------------------------------------------------
  // Static overrides — all throw by default so misconfigured subclasses
  // fail loudly at module-load time rather than at first sendMessage().
  // ------------------------------------------------------------------

  static get binaryCandidates() {
    throw new Error(`${this.name}.binaryCandidates must be overridden`)
  }

  static get resolvedBinary() {
    throw new Error(`${this.name}.resolvedBinary must be overridden`)
  }

  static get apiKeyEnv() {
    throw new Error(`${this.name}.apiKeyEnv must be overridden`)
  }

  static get providerName() {
    throw new Error(`${this.name}.providerName must be overridden`)
  }

  static get displayLabel() {
    return this.providerName
  }

  static get messageIdPrefix() {
    return this.providerName
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  constructor({ cwd, model, permissionMode } = {}) {
    super({ cwd, model, permissionMode: permissionMode || 'auto' })
    this.resumeSessionId = null
    this._process = null
  }

  start() {
    const envVar = this.constructor.apiKeyEnv
    if (!process.env[envVar]) {
      throw new Error(`${envVar} environment variable is not set`)
    }
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

  interrupt() {
    if (this._process) {
      try {
        this._process.kill('SIGINT')
      } catch { /* already dead */ }
    }
  }

  setPermissionMode(_mode) {
    // Subprocess providers don't support mode switching mid-flight. Subclasses
    // may override if their CLI gains support.
  }

  // ------------------------------------------------------------------
  // Required subclass methods
  // ------------------------------------------------------------------

  /** @returns {string[]} argv passed to spawn() */
  _buildArgs(_text) {
    throw new Error(`${this.constructor.name}._buildArgs must be overridden`)
  }

  /** @returns {object} env map passed to spawn() */
  _buildChildEnv() {
    throw new Error(`${this.constructor.name}._buildChildEnv must be overridden`)
  }

  /**
   * Map a single parsed JSONL event to emitter calls. Mutate `ctx` to flip
   * didStreamStart / didEmitResult as appropriate.
   *
   * @param {object} _event  parsed JSON line
   * @param {object} _ctx    shared per-sendMessage mutable context
   */
  _processJsonlLine(_event, _ctx) {
    throw new Error(`${this.constructor.name}._processJsonlLine must be overridden`)
  }

  // ------------------------------------------------------------------
  // Optional subclass hooks
  // ------------------------------------------------------------------

  /** Return true to silently drop a stderr line (e.g. node DeprecationWarning). */
  _shouldSkipStderr(_msg) {
    return false
  }

  /**
   * Emitted from close when the JSONL stream never produced a `result`.
   * Default: emit a minimal result so clients transition from busy → idle.
   * Codex overrides to only emit when turn.completed was missing.
   */
  _emitFallbackResult(_ctx) {
    this.emit('result', { cost: null, duration: null, usage: null, sessionId: null })
  }

  // ------------------------------------------------------------------
  // sendMessage — the shared runtime
  // ------------------------------------------------------------------

  async sendMessage(text, attachments, _options) {
    if (!this._processReady) {
      this.emit('error', { message: 'Session is not running' })
      return
    }
    if (this._isBusy) {
      this.emit('error', { message: 'Session is busy' })
      return
    }
    if (attachments && attachments.length > 0) {
      this.emit('error', {
        message: `${this.constructor.displayLabel} provider does not support attachments`,
      })
      return
    }

    const Klass = this.constructor
    this._isBusy = true
    this._currentMessageId = `${Klass.messageIdPrefix}-msg-${++this._messageCounter}`

    const args = this._buildArgs(text)
    const proc = spawn(Klass.resolvedBinary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this._buildChildEnv(),
    })

    this._process = proc

    const ctx = {
      messageId: this._currentMessageId,
      didStreamStart: false,
      didEmitResult: false,
      proc,
    }
    let stderrBuf = ''

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseJsonLine(line)
      if (!event) return
      this._processJsonlLine(event, ctx)
    })

    proc.stderr.on('data', (chunk) => {
      if (this._destroying) return
      const msg = chunk.toString().trim()
      if (!msg) return
      if (this._shouldSkipStderr(msg)) return
      if (stderrBuf.length < DEFAULT_STDERR_CAP) {
        stderrBuf += (stderrBuf ? '\n' : '') + msg
      }
    })

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      if (ctx.didStreamStart) {
        this.emit('stream_end', { messageId: ctx.messageId })
        ctx.didStreamStart = false
      }
      if (code !== 0 && code !== null) {
        const detail = stderrBuf ? `: ${stderrBuf.slice(0, STDERR_SLICE_FOR_ERROR)}` : ''
        this.emit('error', {
          message: `${Klass.displayLabel} process exited with code ${code}${detail}`,
        })
      }
      if (!ctx.didEmitResult) {
        this._emitFallbackResult(ctx)
      }
    })

    proc.on('error', (err) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      this.emit('error', {
        message: err.message || `Failed to spawn ${Klass.providerName}`,
      })
    })
  }
}
