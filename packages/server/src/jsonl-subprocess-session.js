import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { createLogger } from './logger.js'
import { guardChildStreams } from './child-stream-guard.js'
import { getErrorMessage } from './utils/error-message.js'
import { prepareSpawn } from './utils/win-spawn.js'
import { labelBinarySpawnFailure } from './utils/verify-binary.js'
import { killProcessTree } from './platform.js'

const log = createLogger('jsonl-subprocess-session')

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

  /**
   * #6563 — whether this provider can authenticate WITHOUT `apiKeyEnv` set
   * (e.g. Codex OAuth tokens in ~/.codex/auth.json from `codex login`). When
   * true, start() does NOT throw on a missing env var. Base default: false
   * (env-var-only). A subclass with a non-env credential source overrides this
   * to reuse the SAME probe its resolveAuth()/preflight use, so display, runtime,
   * and preflight share one definition of "authenticated".
   */
  static hasAlternativeCredentials() {
    return false
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

  constructor(opts = {}) {
    // #5367: forward every BaseSession opt via the canonical picker (preserves
    // the #3805 / #4660 / #3899 / #4790 / #5288 plumbing that this middle layer
    // historically had to re-declare by hand — the trap documented in
    // [[feedback_jsonl_subprocess_middle_layer]]). The lone override is
    // permissionMode, which defaults to 'auto' for subprocess providers.
    super(buildBaseSessionOpts(opts, { permissionMode: opts.permissionMode || 'auto' }))
    // JsonlSubprocessSession-local opt (not a BaseSession opt).
    const { resumeSessionId } = opts
    // #3865: accept resumeSessionId from constructor so SessionManager's
    // serializeState/restoreState path carries a captured Codex thread_id
    // across server restarts. Without this, persistence was wired up at
    // every layer EXCEPT here, so restored Codex sessions silently lost
    // their thread and the user experienced the same "context loss" the
    // PR was supposed to fix.
    this.resumeSessionId = resumeSessionId || null
    this._process = null
    // Skills MVP (#2957) — providers without a system-prompt flag (Codex,
    // Gemini) prepend skills text to the first user message only.
    this._skillsPrepended = false
    // #4881: provider parity with CliSession's #4602 _intentionalStop flag.
    // Set by `interrupt()` immediately before SIGINT-ing the child, then
    // consumed inside `proc.on('close')` so a user-initiated Stop:
    //   - suppresses the loud "{provider} process exited with code N" error
    //     emit (SIGINT exits the JSONL subprocess with code 130 or null
    //     depending on the CLI), and
    //   - emits a single transient `stopped` event with the exit `code` so
    //     the dashboard/mobile UX can render the same quiet confirmation
    //     surface PR #4868 wired for CliSession.
    // Single-use: cleared on every close path (close, destroy) so the flag
    // never leaks past one sendMessage cycle. Matches CliSession's
    // capture-and-clear discipline in `_handleChildClose`.
    // The flag itself is declared+initialized on BaseSession (#5375).
  }

  start() {
    const envVar = this.constructor.apiKeyEnv
    // #6563: OAuth-only providers (Codex via `codex login`) have no env key — the
    // child authenticates from its OAuth file (e.g. ~/.codex/auth.json; HOME is
    // forwarded to the child). Only throw when there is NEITHER the env var NOR an
    // alternative credential source, so a `codex login`-only user isn't rejected
    // by the runtime despite resolveAuth() reporting ready.
    if (!process.env[envVar] && !this.constructor.hasAlternativeCredentials()) {
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
    // #4881: clear so a teardown after interrupt() never leaks the flag past
    // this session instance. Mirrors CliSession.destroy() (#4602).
    this._clearIntentionalStop()
    if (this._process) {
      // #6643 — on Windows SIGTERM only TerminateProcess-es the cmd.exe shim
      // wrapping a `.cmd` provider (codex/gemini/…), orphaning the real node
      // grandchild (there is no forceKill escalation on this path). Reap the
      // whole tree; POSIX behaviour is an identical graceful SIGTERM.
      killProcessTree(this._process)
      this._process = null
    }
    this.removeAllListeners()
  }

  interrupt() {
    if (!this._process) return
    // #4881: mark the imminent child exit as user-initiated so the
    // proc.on('close') handler suppresses the "exited with code N" error and
    // instead emits a quiet `stopped` event with the exit code. Cleared in
    // the close handler (single-use, mirrors CliSession #4602).
    this.markIntentionalStop()
    try {
      this._process.kill('SIGINT')
    } catch { /* already dead */ }
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
    // `{providerLabel}-msg-{bootPrefix}-{counter}` — the bootPrefix from
    // BaseSession ensures messageIds from different server boots can never
    // collide with the dashboard's localStorage cache (#3700). Without
    // it, Codex/Gemini sessions would still hit the same collision class
    // that CliSession/SdkSession were fixed for.
    this._currentMessageId = `${Klass.messageIdPrefix}-msg-${this._messageIdPrefix}-${++this._messageCounter}`

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
    // Captured once here so the spawn-time backstop (#6708) verifies the EXACT
    // binary this attempt used — both the sync catch below and the async
    // proc.on('error') handler — rather than a fresh re-resolve that could land
    // on a different path than the one that failed.
    let attemptedBinary = null
    try {
      // #6484 — the resolver can hand us a `.cmd` shim on Windows (npm-only host,
      // no native `.exe`); spawning a `.cmd` via child_process throws EINVAL on
      // Node 24, so route it through cmd.exe with proper escaping — the same
      // prepareSpawn cli-session.js uses. No-op for a `.exe` and on POSIX.
      attemptedBinary = Klass.resolvedBinary
      const spawnSpec = prepareSpawn(attemptedBinary, args)
      proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: this.cwd,
        // We pass the prompt as argv, not stdin. Some CLIs, notably
        // `codex exec`, treat an open stdin pipe as extra prompt input and
        // wait for EOF forever, leaving the session stuck busy.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this._buildChildEnv(),
        ...spawnSpec.options,
      })
    } catch (err) {
      // spawn() can throw synchronously (EINVAL for a bad `.cmd` on Node 24,
      // etc.) — leave _skillsPrepended false so a retry still injects the
      // skills text. Reset busy state and surface the error to the caller.
      this._isBusy = false
      // #6708 — a spawn failure AFTER preflight passed means the binary changed
      // out from under us (quarantined / moved / removed by XProtect between
      // session-create and this turn). Re-verify the ATTEMPTED path so the error
      // names the real cause + fix instead of an opaque failure.
      const labeled = labelBinarySpawnFailure({
        attemptedPath: err?.path || attemptedBinary,
        binary: Klass.providerName,
      })
      this.emit('error', {
        message: labeled || getErrorMessage(err, `Failed to spawn ${Klass.providerName}`),
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
    // Two buffers: `stderrBuf` collects high-signal lines (those the
    // subclass did NOT skip via _shouldSkipStderr); `rawStderrBuf` collects
    // every line as a fallback so non-zero exits never surface as a bare
    // "exited with code N" with no detail (#3834). A subclass filter that's
    // too aggressive — or a CLI that writes its real failure reason in a
    // line that doesn't match the filter — would otherwise hide the cause.
    let stderrBuf = ''
    let rawStderrBuf = ''

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
        if (rawStderrBuf.length < DEFAULT_STDERR_CAP) {
          rawStderrBuf += (rawStderrBuf ? '\n' : '') + msg
        }
        if (this._shouldSkipStderr(msg)) continue
        if (stderrBuf.length < DEFAULT_STDERR_CAP) {
          stderrBuf += (stderrBuf ? '\n' : '') + msg
        }
      }
    })

    // #5324 (WP-5.2) — guard the child's stdout/stderr streams against an
    // unhandled 'error' event that would crash the daemon. Shared helper (P2-9);
    // `_destroying` flips after attach so it is read lazily.
    guardChildStreams(proc, { destroying: () => this._destroying, log, label: Klass.providerName })

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      // #4881: capture-and-clear BEFORE the _destroying short-circuit so the
      // flag never leaks past a close even when destroy() fires first.
      // Mirrors CliSession._handleChildClose (#4602).
      const wasIntentionalStop = this._consumeIntentionalStop()
      if (this._destroying) return
      if (ctx.didStreamStart) {
        this.emit('stream_end', { messageId: ctx.messageId })
        ctx.didStreamStart = false
      }
      if (wasIntentionalStop) {
        // #4881: user clicked Stop — interrupt() set the flag, SIGINT brought
        // the child down. Skip the loud "{provider} process exited with code
        // N" error surface and emit the quiet `stopped` event for parity
        // with CliSession (#4868). SIGINT typically exits with 130 or null
        // depending on the CLI; both are user-initiated and not crashes.
        this.emit('stopped', { code })
      } else if (code !== 0 && code !== null) {
        // Prefer high-signal stderr; fall back to raw so the user always
        // sees *some* explanation when the child died.
        const sourceBuf = stderrBuf || rawStderrBuf
        // #3841 — surface a one-shot warning when the raw fallback was the
        // only signal. That means the subclass's _shouldSkipStderr filter
        // swallowed every stderr line yet the child still died, so the
        // filter is over-aggressive and worth tightening.
        if (!stderrBuf && rawStderrBuf) {
          log.warn(
            `[${Klass.providerName}] _shouldSkipStderr filtered all stderr but child exited ${code} — using raw fallback`,
          )
        }
        const detail = sourceBuf ? `: ${sourceBuf.slice(0, STDERR_SLICE_FOR_ERROR)}` : ''
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
      // #6708 — a launch failure here (async ENOENT/EACCES is the REAL missing-
      // /quarantined-binary path; the sync catch above only sees Node-24 `.cmd`
      // EINVAL) → label the ATTEMPTED path's cause + fix instead of a bare ENOENT.
      const labeled = labelBinarySpawnFailure({
        attemptedPath: err?.path || attemptedBinary,
        binary: Klass.providerName,
      })
      this.emit('error', {
        message: labeled || err.message || `Failed to spawn ${Klass.providerName}`,
      })
    })
  }
}
