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
 *
 * Optional subclass overrides (statics — defaults derived from providerName):
 *   - displayLabel       — human label used in error text (defaults to providerName)
 *   - messageIdPrefix    — prefix for generated message IDs (defaults to providerName)
 *
 * Note: the required statics above throw when accessed on an unconfigured subclass,
 * but this happens at the time the getter is first read (e.g. during start() or
 * sendMessage()), not at module-load time.
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

  constructor({
    cwd,
    model,
    permissionMode,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    maxTotalSkillBytes,
    provider,
    activeManualSkills,
  } = {}) {
    super({
      cwd,
      model,
      permissionMode: permissionMode || 'auto',
      skillsDir,
      repoSkillsDir,
      maxSkillBytes,
      maxTotalSkillBytes,
      provider,
      activeManualSkills,
    })
    this.resumeSessionId = null
    this._process = null
    // Skills MVP (#2957) — providers without a system-prompt flag (Codex,
    // Gemini) prepend skills text to the first user message only.
    this._skillsPrepended = false
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

    // Skills MVP (#2957) — prepend skills text to the first user message when
    // the provider has no system-prompt flag (Codex, Gemini). Only done once
    // per session; subsequent messages flow through unmodified.
    //
    // Per-skill injection mode (#3200): subprocess providers have only one
    // injection channel — the user message. Skills that asked for
    // `injection: append` / `system` (the system-prompt channel) have
    // nowhere else to land here, so we concatenate both buckets. The
    // provider-default mode for Codex / Gemini is `prepend`, so in
    // practice every loaded skill ends up in the prepend bucket and the
    // system-prompt bucket is empty; the concat is defensive against
    // user-authored frontmatter that pins `injection: append` explicitly.
    //
    // Header dedupe (#3228): build the combined payload via
    // `_buildCombinedSkillsPrefix()` so the `# User skills` header is
    // rendered exactly once at the top. The previous implementation
    // concatenated the string outputs of `_buildPrependPrompt()` and
    // `_buildSystemPrompt()` directly; each carries its own header and
    // the join produced two headers in the user-message prefix.
    //
    // The `_skillsPrepended` flag is flipped AFTER the spawn succeeds (#3225).
    // If spawn throws synchronously, leaving the flag false ensures the next
    // sendMessage() retry still includes the skills text — otherwise a
    // failed first turn would leak the skill bucket forever.
    let effectiveText = text
    let willPrependSkills = false
    if (!this._skillsPrepended) {
      const combined = typeof this._buildCombinedSkillsPrefix === 'function'
        ? this._buildCombinedSkillsPrefix()
        : ''
      if (combined) {
        effectiveText = `${combined}\n\n---\n\n${text}`
      }
      willPrependSkills = true
    }

    const args = this._buildArgs(effectiveText)
    let proc
    try {
      proc = spawn(Klass.resolvedBinary, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this._buildChildEnv(),
      })
    } catch (err) {
      // spawn() can throw synchronously (ENOENT for missing binary, EACCES,
      // etc.) — leave _skillsPrepended false so a retry still injects the
      // skills text. Reset busy state and surface the error to the caller.
      this._isBusy = false
      this.emit('error', {
        message: err && err.message ? err.message : `Failed to spawn ${Klass.providerName}`,
      })
      return
    }

    // Spawn succeeded: argv is committed to the wire, so flip the flag.
    if (willPrependSkills) {
      this._skillsPrepended = true
    }

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
      // Split per-line so _shouldSkipStderr is applied to each line individually.
      // A single data chunk may contain multiple lines; trimming the whole chunk
      // would cause a skippable line (e.g. DeprecationWarning) to suppress real
      // error lines that share the same chunk.
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        const msg = line.trim()
        if (!msg) continue
        if (this._shouldSkipStderr(msg)) continue
        if (stderrBuf.length < DEFAULT_STDERR_CAP) {
          stderrBuf += (stderrBuf ? '\n' : '') + msg
        }
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
      // Spawn-level error (ENOENT, EACCES, etc.) means the argv never
      // reached a real process — revert `_skillsPrepended` so the next
      // sendMessage retry still injects the prepend bucket (#3225). We
      // can't distinguish a launch failure from a runtime crash via this
      // event alone, but in practice 'error' on a ChildProcess fires for
      // launch failures; runtime crashes flow through 'close' with a
      // non-zero exit code (where the argv DID reach the process, so
      // the flag rightly stays true).
      if (willPrependSkills) {
        this._skillsPrepended = false
      }
      if (this._destroying) return
      this.emit('error', {
        message: err.message || `Failed to spawn ${Klass.providerName}`,
      })
    })
  }
}
