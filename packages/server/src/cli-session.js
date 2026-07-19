import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { randomBytes } from 'crypto'
import { normalizeSdkModelUsage } from './usage-normalize.js'
import { homedir } from 'os'
import { join } from 'path'
import { createPermissionHookManager } from './permission-hook.js'
import { guardChildStreams } from './child-stream-guard.js'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { buildContentBlocks } from './content-blocks.js'
import { ALLOWED_MODEL_IDS } from './models.js'
import { CLAUDE_FALLBACK_MODELS, claudeModelMetadata } from './claude-model-catalog.js'
import { forceKill, killProcessTree } from './platform.js'
import { MessageTransformPipeline } from './message-transform.js'
import { emitToolResults } from './tool-result.js'
import { buildToolStartData, extractToolInputSemantics } from './claude-stream-parser.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { labelBinarySpawnFailure } from './utils/verify-binary.js'
import { prepareSpawn } from './utils/win-spawn.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { RespawnRateLimiter } from './utils/respawn-rate-limiter.js'
import { createLogger, loggerForSession } from './logger.js'
import { formatIdleDuration } from './session-timeout-manager.js'
import { BILLING_CLASSES, isProgrammaticCreditEra } from './billing-class.js'

const log = createLogger('cli-session')

// Well-known fallback locations. Under a GUI launch (e.g. Tauri on macOS) PATH
// is minimal and may exclude the user's install dir — fall through to these so
// `spawn()` succeeds.
const CLAUDE_BINARY_CANDIDATES = [
  join(homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.claude/local/node_modules/.bin/claude'),
  join(homedir(), '.npm-global/bin/claude'),
]

// Re-resolve fresh on every spawn (NOT a frozen module-load const) so a binary
// quarantined / moved / reinstalled after daemon start is spawned from its
// CURRENT path — and matches what preflight verified (#6708 defect #3).
function resolveClaudeBinary() {
  return resolveBinary('claude', CLAUDE_BINARY_CANDIDATES)
}

// Default max accumulated size for tool_use input_json_delta chunks (~256KB)
const DEFAULT_MAX_TOOL_INPUT_LENGTH = 262144

/**
 * Patterns the claude CLI emits on stderr when `--resume <id>` fails because
 * the conversation id is unknown locally (e.g. the operator wiped
 * `~/.claude/projects/` between chroxy boots, or restored a state file from a
 * different machine). Matched case-insensitively against each buffered stderr
 * line; one match is enough to classify the failure as `resume_unknown` and
 * trigger the one-shot fresh-conversation fallback in #4929.
 *
 * Kept as an exported constant so the regression test can pin both the
 * detection contract AND the exact strings without re-implementing the matcher.
 * If claude CLI ever changes its wording, the test will fail loudly here
 * rather than silently regressing back into the "exited unexpectedly" respawn
 * loop reported in #4929.
 *
 * #4950 — the original seventh pattern `/resume.*failed/i` was too loose:
 * unrelated stderr like "tool resume failed" or "user wanted to resume after
 * the failed sync" would falsely classify as resume_unknown and wipe
 * `_sessionId` mid-conversation. The three replacement patterns require both
 * the resume verb AND a session/conversation/id keyword nearby, so a tool-side
 * failure that happens to log "resume failed" in isolation no longer triggers
 * a phantom `_sessionId` wipe.
 */
export const RESUME_UNKNOWN_STDERR_PATTERNS = [
  /no conversation found/i,
  /conversation.*not.*found/i,
  /session.*not.*found/i,
  /no such conversation/i,
  /unknown session/i,
  /could not find session/i,
  // #4950 — tightened replacements for the dropped `/resume.*failed/i`. Each
  // requires the resume verb to co-occur with session/conversation/id so the
  // matcher stays scoped to the --resume-id failure mode it was designed for.
  //
  // #4968 — `id` is anchored with \b so it doesn't bleed into substrings of
  // unrelated words (invalid, considered, avoided, widget, mid, kid, …). The
  // long tokens `session` and `conversation` don't need anchoring.
  //
  // #4969 — `resum(e|ing)` covers the gerund form claude CLI may emit
  // ("Error resuming session abc-123"). Original `resume.*` patterns missed
  // the gerund and silently fell through to the generic "exited unexpectedly"
  // respawn loop reported in #4929.
  /resum(e|ing).*(fail|error).*(session|conversation|\bid\b)/i,
  /resum(e|ing).*(session|conversation|\bid\b).*(fail|error)/i,
  /(fail|error|could not|unable to|cannot).*resum(e|ing).*(session|conversation|\bid\b)/i,
]

/**
 * Inspect a buffered stderr line set and return true if any line matches a
 * known "unknown resume id" pattern. Pure helper — exported so the test suite
 * can pin the matcher behavior without spawning a child process.
 *
 * @param {string[]} stderrLines
 * @returns {boolean}
 */
export function stderrIndicatesUnknownResume(stderrLines) {
  if (!Array.isArray(stderrLines) || stderrLines.length === 0) return false
  for (const line of stderrLines) {
    if (typeof line !== 'string' || !line) continue
    for (const pattern of RESUME_UNKNOWN_STDERR_PATTERNS) {
      if (pattern.test(line)) return true
    }
  }
  return false
}

/**
 * Build the argv passed to `claude -p --input-format stream-json …`.
 *
 * Extracted so #4887 has a single, pure place to assert the resume contract.
 * Mirrors the historical inline build in `start()` exactly — same arg order,
 * same flag spellings — plus an optional `--resume <id>` segment when a prior
 * `_sessionId` is known.
 *
 * Resume invariants (#4887):
 *   - A fresh session (no `_sessionId` yet) omits `--resume`. claude CLI
 *     allocates a brand-new conversation on first init.
 *   - A respawn (model switch, perm-mode flip, crash) or a server-restart
 *     restore call MUST include `--resume <id>`. Without it, the new
 *     subprocess inherits the chroxy-side history ring buffer (replayed to
 *     the dashboard) but the model itself starts cold mid-conversation —
 *     the failure mode reported in #4887.
 *
 * @param {object} opts
 * @param {string|null} opts.model
 * @param {string} opts.permissionMode
 * @param {string[]} opts.allowedTools
 * @param {string} opts.skillsText
 * @param {string|null} opts.resumeSessionId
 * @returns {string[]}
 */
export function buildClaudeCliArgs({ model, permissionMode, allowedTools, skillsText, resumeSessionId } = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]

  if (model) {
    args.push('--model', model)
  }

  if (permissionMode === 'auto') {
    args.push('--permission-mode', 'bypassPermissions')
  } else if (permissionMode === 'plan') {
    args.push('--permission-mode', 'plan')
  }

  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','))
  }

  if (skillsText) {
    args.push('--append-system-prompt', skillsText)
  }

  // #4887 — wire the prior claude session_id back onto the new subprocess so
  // the model retains the full prior transcript. Only emitted when a non-empty
  // string is known; a brand-new session (first start()) leaves this off so
  // claude CLI mints a fresh conversation id on its `system.init` line.
  if (typeof resumeSessionId === 'string' && resumeSessionId.length > 0) {
    args.push('--resume', resumeSessionId)
  }

  return args
}

/**
 * Manages a persistent Claude Code CLI session using headless mode.
 *
 * A single `claude -p --input-format stream-json --output-format stream-json`
 * process stays alive for the lifetime of the session. Messages are sent as
 * NDJSON on stdin; "message complete" is signaled by a `result` event on
 * stdout (not process exit).
 *
 * Events emitted:
 *   ready            { sessionId, model, tools }
 *   stream_start     { messageId }
 *   stream_delta     { messageId, delta }
 *   stream_end       { messageId }
 *   message          { type, content, tool, timestamp }
 *   tool_start       { messageId, tool, input }
 *   result           { cost, duration, usage, sessionId }
 *   error            { message }
 *   user_question    { toolUseId, questions }
 *   agent_spawned    { toolUseId, description, startedAt }
 *   agent_completed  { toolUseId }
 *   plan_started     {}
 *   plan_ready       { allowedPrompts }
 *   tool_result      { toolUseId, result, truncated }
 */

export class CliSession extends BaseSession {
  // #5858: Claude-family flag — single source of truth for isClaudeProvider().
  // DockerSession (docker-cli / docker) extends this and inherits it.
  static claudeFamily = true

  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'Claude Code (CLI)'
  }

  /**
   * #5698: `respawn_exhausted` is the terminal "session is dead (flapping)"
   * signal — emitted by `_scheduleRespawn` once the bounded auto-respawn budget
   * (the rolling rate cap or the consecutive max of 5) is spent. SessionManager
   * listens for it and drops the session from its list (no input-rejecting
   * zombie tab), mirroring ClaudeTuiSession's contract. Listing it here makes
   * `_wireSessionEvents` bridge it onto the transient `session_event` channel
   * as well. DockerSession is the only subclass of CliSession, so it inherits
   * this getter and the terminal signal; the other subprocess providers
   * (BYOK/DeepSeek extend BaseSession, Gemini/Codex extend
   * JsonlSubprocessSession) have no auto-respawn loop, so there is nothing to
   * exhaust there.
   */
  static get customEvents() {
    return ['respawn_exhausted']
  }

  /**
   * Root data directory for this provider (#2965).
   * Consumers (conversation-scanner, ws-file-ops) use this to locate
   * provider-specific subdirs (projects/, agents/, commands/) without
   * hardcoding the path.
   */
  static get dataDir() {
    return join(homedir(), '.claude')
  }

  static get capabilities() {
    return {
      permissions: true,
      inProcessPermissions: false,
      modelSwitch: true,
      permissionModeSwitch: true,
      // #5609: switching to 'auto' mid-turn is the #3729 panic-button —
      // BaseSession lets 'auto' bypass the _isBusy guard and CliSession's
      // _onPermissionModeChanged respawns the `claude -p` subprocess, which
      // DROPS the in-flight turn. Surfaced as a capability so the dashboard /
      // app can word their confirm dialog accurately (CLI = interrupts;
      // SDK/TUI = safe) instead of silently differing per provider.
      interruptsTurnOnAutoSwitch: true,
      planMode: true,
      // #4887 — claude CLI supports `--resume <id>`; CliSession now wires
      // `_sessionId` into the spawn argv on respawn / restore so the model
      // retains the prior transcript instead of starting cold mid-conversation.
      // Persistence + UI gating both branch on this flag.
      resume: true,
      terminal: false,
      thinkingLevel: false,
      // #3932: declared explicitly so the capability matrix matches across
      // providers — claude-tui is the only one that sets this to false.
      streaming: true,
    }
  }

  /**
   * The exact path the CLI subprocess will spawn, re-resolved fresh so
   * preflight verifies the SAME path the spawn uses (no stale const). (#6708)
   */
  static get resolvedBinary() {
    return resolveClaudeBinary()
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   * Declares the binary and credential requirements for this provider so
   * doctor.js can check only the binaries the configured provider actually
   * needs (see issue #2951).
   */
  static get preflight() {
    return {
      label: 'Claude CLI',
      binary: {
        name: 'claude',
        args: ['--version'],
        candidates: [
          join(homedir(), '.local/bin/claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          join(homedir(), '.claude/local/node_modules/.bin/claude'),
          join(homedir(), '.npm-global/bin/claude'),
        ],
        installHint: 'install Claude Code CLI',
      },
      credentials: {
        envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        hint: 'run `claude login` or set ANTHROPIC_API_KEY',
        optional: true,
      },
    }
  }

  /**
   * Resolve runtime auth state for the dashboard (#4769).
   *
   * Host `claude-cli` always bills the Claude subscription: spawn-env.js's
   * `claude` denylist strips ANTHROPIC_API_KEY before the subprocess starts,
   * so the env var is irrelevant — the CLI auths via the host's ~/.claude
   * OAuth state. Mark ready up front; the on-disk OAuth probe doesn't see
   * Keychain credentials and would otherwise misreport unconfigured.
   *
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth() {
    const envVars = this.preflight.credentials.envVars
    // claude-cli always auths via the host OAuth/subscription pool (the env
    // key is stripped before spawn), so it's never the `api-key` class. Before
    // 2026-06-15 this is flat subscription; on/after it draws from the metered
    // programmatic-credit pool (#5629). The era is read at call time so a
    // long-running daemon flips copy at the boundary without a restart.
    const era = isProgrammaticCreditEra()
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint: 'run `claude login` if not yet authed',
      detail: era
        ? 'Programmatic credit pool — monthly metered credits (CLI strips ANTHROPIC_API_KEY before spawn)'
        : 'Claude subscription (CLI strips ANTHROPIC_API_KEY before spawn)',
      billingClass: era ? BILLING_CLASSES.PROGRAMMATIC_CREDIT : BILLING_CLASSES.SUBSCRIPTION,
    }
  }

  /**
   * Per-provider fallback model list (#2956). Shared with every Claude
   * provider via `CLAUDE_FALLBACK_MODELS` in claude-model-catalog.js
   * (#6201 OCP). The default Claude registry is
   * what this provider uses at runtime — this static exists so
   * `getRegistryForProvider('claude-cli')` and the per-provider tests
   * can discover the Claude defaults through the same hook shape used
   * by Codex/Gemini.
   *
   * @returns {ReadonlyArray<{id:string,label:string,fullId:string,contextWindow:number}>}
   */
  static getFallbackModels() {
    return CLAUDE_FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  /**
   * Claude-style metadata via the shared claudeModelMetadata() helper
   * (#6201 OCP). Mirrors SdkSession (#2956).
   *
   * @param {string} modelId
   * @returns {{id:string,label:string,fullId:string,contextWindow:number,description?:string}|null}
   */
  static getModelMetadata(modelId) {
    return claudeModelMetadata(modelId)
  }

  constructor(opts = {}) {
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-cli' }))
    // CliSession-local opts (not BaseSession opts — see buildBaseSessionOpts).
    const { allowedTools, port, apiToken, settingsPath, maxToolInput, transforms, resumeSessionId } = opts
    this.allowedTools = allowedTools || []
    this._port = port || null
    this._apiToken = apiToken || null
    // Per-session secret for the permission hook endpoint — never the primary API token
    this._hookSecret = randomBytes(32).toString('hex')
    this._maxToolInput = maxToolInput || DEFAULT_MAX_TOOL_INPUT_LENGTH
    this._transformPipeline = new MessageTransformPipeline(transforms || [])
    // #4887 — seed `_sessionId` from the persisted resume id so the very-first
    // start() (post-restore) passes `--resume <id>` and the new claude
    // subprocess re-hydrates the prior conversation. Falsy / non-string values
    // (older state files, missing opt) leave `_sessionId` null exactly as
    // before, so brand-new sessions still mint a fresh claude conversation.
    this._sessionId = (typeof resumeSessionId === 'string' && resumeSessionId.length > 0)
      ? resumeSessionId
      : null
    // #4828: session-scoped logger, lazily bound when the CLI emits its
    // `init` message (where session_id becomes known). Pre-init log lines
    // stay on the module-level `log` — same fallback pattern as SdkSession
    // / ClaudeTuiSession.
    this._log = null
    this._child = null
    this._rl = null
    this._stderrRL = null

    // Persistent-process state
    this._inPlanMode = false
    this._planAllowedPrompts = null
    this._waitingForAnswer = false
    this._currentCtx = null
    this._pendingQueue = []
    this._respawnCount = 0
    this._respawnTimer = null
    this._respawnScheduled = false
    this._respawning = false
    // #5349: rolling-window respawn cap independent of `_respawnCount`, which
    // resets on every `system.init` (warmup success). Without it a session that
    // dies shortly after each successful init flaps forever. Mirrors the same
    // guard in ClaudeTuiSession.
    this._respawnRateLimiter = new RespawnRateLimiter()
    this._interruptTimer = null
    // #4929: track in-flight `--resume <id>` attempts so we can detect when
    // claude CLI rejects an unknown id and avoid the spin-retry loop reported
    // in the issue. Set in `_spawnPersistentProcess` whenever we passed
    // `--resume`, cleared by `system.init` (resume confirmed) and inspected
    // by `_handleChildClose` if the child exits before init fires.
    this._attemptedResumeId = null
    this._recentStderrLines = []
    // One-shot fallback latch: if we detect `resume_unknown`, drop `_sessionId`
    // and respawn a fresh conversation exactly once. If THAT also fails the
    // child exits for a different reason and the normal respawn path runs.
    // Prevents an infinite "clear → respawn → resume → clear" oscillation if
    // some future bug ever re-introduces a phantom resume id.
    this._didFallbackFromUnknownResume = false
    // #4602: distinguishes "user clicked Stop" (interrupt → child exits)
    // from "child crashed" so _handleChildClose skips the misleading
    // "exited unexpectedly" toast + auto-respawn on the stop path.
    // Single-use: set by interrupt(), cleared by _handleChildClose / destroy.
    // The flag itself is declared+initialized on BaseSession (#5375).

    // Hook manager (shared module)
    this._hookManager = (this._port) ? createPermissionHookManager(this, { settingsPath }) : null

    // Pending-permission bookkeeping for the inactivity timer (#2831).
    // WsServer calls notifyPermissionPending/Resolved when a hook
    // permission belonging to this session is broadcast/resolved.
    this._pendingPermissionIds = new Set()
    this._resultTimeoutPaused = false
  }

  get sessionId() {
    return this._sessionId
  }

  /**
   * Public accessor for the claude CLI session id used to resume conversations
   * via `claude -p --resume <id>` (#4887). SessionManager.serializeState reads
   * this to persist `sdkSessionId` (the cross-provider name for the resume
   * token); restoreState forwards it back into the constructor as
   * `resumeSessionId` so the new chroxy boot re-attaches to the prior
   * conversation instead of starting cold.
   *
   * Returns `null` until the CLI emits its first `system.init` event (or until
   * the constructor seeds the value from a persisted state file).
   *
   * @returns {string|null}
   */
  get resumeSessionId() {
    return this._sessionId || null
  }

  /**
   * Start the persistent Claude process. Call once after construction.
   */
  start() {
    // Register permission hook before starting the process (only once, not on respawn)
    if (this._hookManager && this._respawnCount === 0) {
      this._hookManager.register()
    }

    // Skills MVP (#2957) — append shared skills to the Claude CLI system prompt.
    const skillsText = this._buildSystemPrompt()

    // #4887 — pass `_sessionId` as `--resume` whenever it's known. This is the
    // load-bearing flag for the bug: on respawn (crash / model switch / perm-
    // mode flip) and on server-restart restore, the new claude subprocess
    // would otherwise lose every prior turn in the model's context window and
    // the user would see the dashboard transcript replay correctly while the
    // model itself starts cold mid-conversation.
    const args = buildClaudeCliArgs({
      model: this.model,
      permissionMode: this.permissionMode,
      allowedTools: this.allowedTools,
      skillsText,
      resumeSessionId: this._sessionId,
    })

    const resumeNote = this._sessionId ? ` (resume ${this._sessionId})` : ''
    log.info(`Starting persistent process (model: ${this.model || 'default'}, permission: ${this.permissionMode})${resumeNote}`)
    this._spawnPersistentProcess(args)
  }

  /**
   * Spawn the persistent claude process and wire up event handlers.
   *
   * Uses buildSpawnEnv('claude') which strips ANTHROPIC_API_KEY from the
   * parent env (so the CLI uses OAuth/subscription auth instead of burning
   * API credits) while still forwarding the rest of the user's environment
   * — Claude Code tools expect the full shell env to be available.
   */
  _buildChildEnv() {
    const extras = {
      CI: '1',
      CLAUDE_HEADLESS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      CHROXY_PERMISSION_MODE: this.permissionMode,
      ...(this._port ? { CHROXY_PORT: String(this._port) } : {}),
      // Pass a short-lived per-session secret instead of the primary API token.
      // This limits the blast radius if a tool reads process.env — the hook secret
      // only authorises POST /permission, not the WebSocket API.
      ...(this._port ? { CHROXY_HOOK_SECRET: this._hookSecret } : {}),
    }
    return buildSpawnEnv('claude', extras)
  }

  _spawnPersistentProcess(args) {
    this._cleanupReadlines()
    this._processReady = false

    // #4929: capture which `--resume <id>` (if any) this spawn attempted.
    // Read off the argv we're about to pass instead of `_sessionId` so the
    // detection is robust to future refactors that build args differently —
    // we're asking "what did we actually tell claude to resume?" not "what's
    // our in-memory id?". `_handleChildClose` inspects this on exit to decide
    // whether to classify a quick failure as `resume_unknown` (#4929).
    const resumeIdx = args.indexOf('--resume')
    this._attemptedResumeId = (resumeIdx >= 0 && typeof args[resumeIdx + 1] === 'string')
      ? args[resumeIdx + 1]
      : null
    this._recentStderrLines = []

    // On Windows the resolver can land on a `claude.cmd` shim (npm-global install
    // with no native `claude.exe`); spawning a `.cmd` via child_process throws
    // EINVAL on Node 24, so route it through cmd.exe with proper escaping. No-op
    // for a directly-runnable `.exe` and on POSIX. See utils/win-spawn.js.
    // Captured so the spawn-time backstop (#6708) verifies the EXACT binary this
    // attempt used, not a fresh re-resolve that could land on a different path.
    const attemptedBinary = resolveClaudeBinary()
    const spawnSpec = prepareSpawn(attemptedBinary, args)
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this._buildChildEnv(),
      ...spawnSpec.options,
    })

    this._child = child

    // Do NOT close stdin — we write messages to it

    // Read stdout line by line — each line is a JSON object
    const rl = createInterface({ input: child.stdout })
    this._rl = rl

    rl.on('line', (line) => this._handleStdoutLine(line))

    // Log stderr for debugging
    const stderrRL = createInterface({ input: child.stderr })
    this._stderrRL = stderrRL
    stderrRL.on('line', (line) => {
      if (line.trim()) {
        // #4828: session-scoped when init has fired (stderr arrives both
        // pre- and post-init; the fallback covers the pre-init case).
        ;(this._log || log).info(`stderr: ${line}`)
        // #4929: buffer the most recent stderr lines while a `--resume` is
        // outstanding so `_handleChildClose` can classify the failure. Bounded
        // to 50 lines so a chatty subprocess can't grow this unbounded — the
        // unknown-resume error fits in the first handful of lines so 50 is
        // generous. Only buffer until `system.init` clears `_attemptedResumeId`
        // (a successful resume confirms via init); after that we drop lines on
        // the floor and let the normal stderr->log path do its job.
        if (this._attemptedResumeId) {
          this._recentStderrLines.push(line)
          if (this._recentStderrLines.length > 50) {
            this._recentStderrLines.shift()
          }
        }
      }
    })

    // #5361 (follow-up to #5324) — guard the child's stdout/stderr streams
    // against an unhandled 'error' event that would crash the daemon. Shared
    // helper (P2-9); `_destroying` flips after attach so it is read lazily.
    guardChildStreams(child, { destroying: () => this._destroying, log: this._log || log })

    // Absorb EPIPE and other low-level stdin errors so they don't become
    // unhandled exceptions. Writes are already wrapped in try/catch below.
    child.stdin.on('error', (err) => {
      // #4828: session-scoped when init has fired.
      ;(this._log || log).warn(`stdin error (ignored): ${err.message}`)
    })

    child.on('error', (err) => {
      this._cleanupReadlines()
      this._processReady = false
      this._child = null
      // #6708 — a spawn error (ENOENT/EACCES) can mean the binary was quarantined
      // /moved/removed out from under the running daemon (this is the respawn
      // path too, so it fires mid-session). Verify the ATTEMPTED path and label
      // the cause + fix instead of surfacing a bare ENOENT. Falls back to raw.
      const labeled = labelBinarySpawnFailure({ attemptedPath: err?.path || attemptedBinary, binary: 'claude' })
      this.emit('error', { message: labeled || `Failed to spawn claude: ${err.message}` })
      this._scheduleRespawn()
    })

    child.on('close', (code) => this._handleChildClose(code))

    // stdin is writable immediately — process is ready for NDJSON messages.
    // system.init arrives with the first response, not at startup.
    this._processReady = true
    log.info('Process started, ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })

    // Dequeue the next pending message if not already busy.
    // sendMessage() sets _isBusy, so the loop sends at most one message.
    // Remaining items stay in the queue and are drained one-by-one via
    // _clearMessageState() after each result.
    while (this._pendingQueue.length > 0 && !this._isBusy) {
      const pending = this._pendingQueue.shift()
      // #4828: session-scoped when init has fired (dequeue can race with
      // the very-first init so the fallback is intentional).
      ;(this._log || log).info(`Dequeuing pending message (${this._pendingQueue.length} remaining)`)
      this.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }
  }

  /**
   * Schedule a respawn with exponential backoff.
   * Backoff: 1s, 2s, 4s, 8s, 15s (max). Cap at 5 retries then stop.
   */
  _scheduleRespawn() {
    if (this._destroying) return
    if (this._respawning) return
    if (this._respawnScheduled) return

    // #5349: rolling-window cap, checked BEFORE _respawnCount so a session that
    // keeps surviving warmup (resetting _respawnCount on system.init) still
    // gives up once it flaps past the window cap.
    if (!this._respawnRateLimiter.record()) {
      const { maxPerWindow, windowMs } = this._respawnRateLimiter
      log.error(`Respawn rate cap reached (>${maxPerWindow} in ${Math.round(windowMs / 60000)}min), giving up — session is flapping`)
      // #5698: a CODED terminal error (so the client can render a distinct
      // "session ended (flapping)" final state instead of a transient toast)
      // PLUS `respawn_exhausted` so SessionManager drops the dead session.
      this.emit('error', { code: 'cli_respawn_exhausted', message: `Claude process is flapping — exceeded ${maxPerWindow} respawns in ${Math.round(windowMs / 60000)} minutes` })
      this.emit('respawn_exhausted', { reason: 'cli_respawn_rate_capped' })
      return
    }

    this._respawnCount++
    if (this._respawnCount > 5) {
      log.error('Max respawn attempts reached (5), giving up')
      // #5698: see the rate-cap branch above — coded terminal error + the
      // session-dropping `respawn_exhausted` signal.
      this.emit('error', { code: 'cli_respawn_exhausted', message: 'Claude process failed to stay alive after 5 attempts' })
      this.emit('respawn_exhausted', { reason: 'cli_respawn_exhausted', attempts: this._respawnCount - 1 })
      return
    }

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._respawnCount - 1, delays.length - 1)]
    log.info(`Respawning in ${delay}ms (attempt ${this._respawnCount}/5)`)

    this._respawnScheduled = true
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null
      this._respawnScheduled = false
      if (!this._destroying) {
        this.start()
      }
    }, delay)
  }

  /**
   * Send a message to Claude via stdin NDJSON.
   */
  async sendMessage(prompt, attachments, options = {}) {
    if (this._isBusy) {
      // #5936 (epic #5935): a send-while-busy follow-up now QUEUES into the
      // shared outgoing queue (BaseSession) instead of rejecting with "Already
      // processing a message" — flushed FIFO on the turn-complete `result` (via
      // _clearMessageState's drain below). Matches the SDK's behaviour. The
      // overflow cap + the message_queued mirror live in enqueueOutgoingMessage.
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions: options })
      return
    }

    if (!this._processReady) {
      if (this._pendingQueue.length >= 3) {
        this.emit('error', { message: 'Pending message queue full (max 3) — message discarded' })
        return
      }
      // #4828: session-scoped when init has fired (queuing typically happens
      // pre-init or during respawn — both can race with the binding).
      ;(this._log || log).info(`Process not ready, queuing message (queue depth: ${this._pendingQueue.length + 1})`)
      this._pendingQueue.push({ prompt, attachments, options })
      return
    }

    // Apply message transforms if configured
    let transformedPrompt = prompt
    if (this._transformPipeline.hasTransforms && typeof prompt === 'string') {
      transformedPrompt = this._transformPipeline.apply(prompt, {
        cwd: this.cwd,
        model: this.model,
        isVoiceInput: !!options.isVoice,
        platform: process.platform,
      })
    }

    // Per-skill injection mode (#3200): skills with `injection: prepend`
    // need to ride on the first user message. The append/system bucket is
    // already wired through `--append-system-prompt` at process start
    // (see _buildArgs); only the prepend bucket is handled here, once
    // per session.
    //
    // `_skillsPrepended` is NOT flipped here — we wait for the stdin write
    // to succeed (#3225). If the write throws (EPIPE on a dead child), a
    // retry needs to re-include the prepend bucket, otherwise the skill
    // text is silently lost. The flag is set just after the successful
    // `_child.stdin.write(...)` below.
    let willPrependSkills = false
    if (!this._skillsPrepended && typeof transformedPrompt === 'string') {
      const prependText = typeof this._buildPrependPrompt === 'function'
        ? this._buildPrependPrompt()
        : ''
      if (prependText) {
        transformedPrompt = `${prependText}\n\n---\n\n${transformedPrompt}`
        willPrependSkills = true
      } else {
        // Nothing to prepend — flag flip is a no-op cost-saver only;
        // mark prepended so we skip the cost on every subsequent turn.
        willPrependSkills = true
      }
    }

    this._isBusy = true
    this._messageCounter++
    // `msg-{bootPrefix}-{counter}` — see BaseSession constructor for why
    // the boot-unique prefix is needed (#3700). Format change does not
    // affect the wire schema; clients treat messageId as opaque string.
    this._currentMessageId = `msg-${this._messageIdPrefix}-${this._messageCounter}`
    this._currentCtx = { hasStreamStarted: false, didStreamText: false, assistantTextSeen: 0, currentContentBlockType: null, currentToolName: null, currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false }

    const content = buildContentBlocks(transformedPrompt, attachments)

    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })

    // #4828: session-scoped when init has fired. The very first message
    // sends pre-init (CLI's `init` arrives in the first response), so the
    // first turn falls back to module-level `log`; all subsequent sends
    // route through `this._log`.
    ;(this._log || log).info(`Sending message ${this._currentMessageId}: "${(prompt || '').slice(0, 60)}"${attachments?.length ? ` (+${attachments.length} attachment(s))` : ''}`)
    try {
      this._child.stdin.write(ndjson + '\n')
    } catch (err) {
      // #4828: session-scoped when init has fired.
      ;(this._log || log).error(`stdin.write failed (sendMessage): ${err.message}`)
      this._clearMessageState()
      this.emit('error', { message: `Failed to send message: ${err.message}` })
      return
    }

    // Skills text is committed to the wire — safe to flip the flag now (#3225).
    // If the write threw above we returned early, leaving the flag false so
    // the next attempt re-injects the prepend bucket.
    if (willPrependSkills) {
      this._skillsPrepended = true
    }

    // Safety timeouts: soft warning + hard cap. Both armed on every
    // activity; soft fires `inactivity_warning` (session stays alive),
    // hard fires the existing kill path. Both paused while a permission
    // prompt is outstanding (#2831) — waiting on user input is not
    // inactivity. Defaults + overrides documented in BaseSession.
    this._armResultTimeout()
  }

  /**
   * Arm the SOFT-warning + HARD-cap + STREAM-STALL timers in parallel.
   * No-op when paused because of a pending permission prompt (#2831).
   * Windows are configurable per server via config.resultTimeoutMs /
   * hardTimeoutMs / streamStallTimeoutMs (#3749 / #3899 / #4467).
   *
   * Stall timer is only armed when `_streamStallTimeoutMs > 0` —
   * operators can disable the active-recovery path via config 0.
   *
   * All timers are cleared at the top of every call, so any activity-
   * triggered reset (`_handleStdoutLine`) restarts the silence windows
   * from zero. That's by design: every cap bounds *silent* stretches,
   * not the wall-clock session duration.
   */
  _armResultTimeout() {
    if (this._resultTimeout) clearTimeout(this._resultTimeout)
    if (this._hardTimeout) clearTimeout(this._hardTimeout)
    if (this._streamStallTimeout) clearTimeout(this._streamStallTimeout)
    this._resultTimeout = null
    this._hardTimeout = null
    this._streamStallTimeout = null
    if (this._resultTimeoutPaused) return
    this._resultTimeout = setTimeout(() => {
      this._resultTimeout = null
      this._handleInactivityWarning()
    }, this._resultTimeoutMs)
    this._hardTimeout = setTimeout(() => {
      this._hardTimeout = null
      this._handleHardTimeout()
    }, this._hardTimeoutMs)
    // #4467: only arm if configured > 0 (operators can disable).
    if (this._streamStallTimeoutMs > 0) {
      this._streamStallTimeout = setTimeout(() => {
        this._streamStallTimeout = null
        this._handleStreamStall()
      }, this._streamStallTimeoutMs)
    }
  }

  /**
   * Handle the SOFT inactivity warning (#3899). Fired after
   * `_resultTimeoutMs` of silence with no activity to reset it.
   *
   * Unlike `_handleHardTimeout`, this does NOT clear busy state,
   * does NOT auto-deny pending permissions, and does NOT emit `error`.
   * It just emits a transient `inactivity_warning` event so the client
   * can render a check-in affordance ("Status update?") and (if the
   * server has push wired) deliver an Expo notification.
   *
   * The hard-cap timer keeps running — if the user never engages, the
   * kill path eventually fires anyway. The soft timer is NOT re-armed
   * here: each silent stretch produces exactly one warning (subsequent
   * activity resets BOTH timers, so the next stretch fires a fresh
   * warning).
   */
  _handleInactivityWarning() {
    if (!this._isBusy) return
    const idleMs = this._resultTimeoutMs
    const friendly = formatIdleDuration(idleMs)
    // #4828: session-scoped (inactivity warning fires from active turn).
    ;(this._log || log).info(`Inactivity warning (${friendly}) — session alive, prompting check-in`)
    this.emit('inactivity_warning', {
      messageId: this._currentMessageId,
      idleMs,
      prefab: 'Status update?',
    })
  }

  /**
   * Handle the HARD-cap timeout (#3899; pre-#3899 this was the only
   * handler — kept as the absolute backstop for genuinely stuck
   * sessions). Before clearing state, emit `permission_expired` for
   * any registered pending permissions so the client UI clears stale
   * prompts (#2831). Without this, late user approvals would resolve
   * into a dead message context and no response ever streams.
   */
  _handleHardTimeout() {
    if (!this._isBusy) return
    const friendly = formatIdleDuration(this._hardTimeoutMs)
    // #4828: session-scoped (hard-cap fires from active turn).
    ;(this._log || log).warn(`Hard-cap timeout (${friendly}) — force-clearing busy state`)
    // Fire permission_expired for every pending permission we know about
    // so the client clears the stale prompt.
    for (const requestId of this._pendingPermissionIds) {
      this.emit('permission_expired', {
        requestId,
        message: 'Permission request expired (session timeout)',
      })
    }
    this._pendingPermissionIds.clear()
    this._emitInterruptedTurnResult(this._hardTimeoutMs)
    this.emit('error', { message: `Response timed out after ${friendly}` })
  }

  // #4467: stream-stall recovery. Fires when the child has been silent
  // for `_streamStallTimeoutMs` despite the session being busy — typically
  // a half-open TCP to the Anthropic API that the OS hasn't surfaced yet.
  // Logs with context, emits `error` with `code: 'stream_stall'` so the
  // dashboard can show a distinct "Stream stalled — retry?" affordance,
  // then clears busy state so the user CAN actually retry.
  _handleStreamStall() {
    if (!this._isBusy) return
    const friendly = formatIdleDuration(this._streamStallTimeoutMs)
    // #4828: session-scoped (stall fires from active turn).
    ;(this._log || log).warn(
      `Stream stalled (${friendly}, messageId=${this._currentMessageId}) — clearing busy state for retry`,
    )
    this._emitInterruptedTurnResult(this._streamStallTimeoutMs)
    this.emit('error', {
      code: 'stream_stall',
      message: `Stream stalled — no response for ${friendly}. Try sending again.`,
    })
  }

  /**
   * Notify the session that a permission request belonging to it is
   * outstanding — pauses the inactivity timer so the session doesn't
   * time out while waiting on user input. #2831.
   *
   * @param {string} requestId
   */
  notifyPermissionPending(requestId) {
    if (!requestId || this._pendingPermissionIds.has(requestId)) return
    this._pendingPermissionIds.add(requestId)
    if (this._pendingPermissionIds.size === 1) {
      this._resultTimeoutPaused = true
      // #3899: clear BOTH the soft warning and hard cap. Awaiting user
      // input is not inactivity; the timer trio re-arms together when
      // the last pending permission resolves.
      if (this._resultTimeout) {
        clearTimeout(this._resultTimeout)
        this._resultTimeout = null
      }
      if (this._hardTimeout) {
        clearTimeout(this._hardTimeout)
        this._hardTimeout = null
      }
      // #4467: clear the stall timer too — waiting on the user is not a stall.
      if (this._streamStallTimeout) {
        clearTimeout(this._streamStallTimeout)
        this._streamStallTimeout = null
      }
    }
  }

  /**
   * Notify the session that a permission request has been resolved
   * (allow/deny/expired). When the last outstanding permission clears,
   * the inactivity timer re-arms for a fresh window. #2831.
   *
   * @param {string} requestId
   */
  notifyPermissionResolved(requestId) {
    if (!requestId || !this._pendingPermissionIds.has(requestId)) return
    this._pendingPermissionIds.delete(requestId)
    if (this._pendingPermissionIds.size === 0) {
      this._resultTimeoutPaused = false
      if (this._isBusy) {
        this._armResultTimeout()
      }
    }
  }

  /**
   * Process one raw line from the CLI subprocess's stdout. Skips blanks
   * and JSON-parse failures, then resets the inactivity timer (#3884 —
   * every parsed event proves the subprocess is alive, so the timer was
   * never meant to be wall-clock from send) before handing the parsed
   * event off to `_handleEvent`. Extracted from the inline `rl.on('line')`
   * handler so tests can drive the production path without standing up
   * a real readline interface.
   *
   * @param {string} line
   */
  _handleStdoutLine(line) {
    if (!line.trim()) return

    let data
    try {
      data = JSON.parse(line)
    } catch {
      return
    }

    // _armResultTimeout is a no-op while paused for a pending permission,
    // so this is safe to call unconditionally on every event.
    this._armResultTimeout()

    this._handleEvent(data)
  }

  /**
   * Handle a single parsed JSON event from Claude CLI stdout.
   * Uses instance state (_currentMessageId, _currentCtx) instead of params.
   */
  _handleEvent(data) {
    switch (data.type) {
      case 'system': {
        if (data.subtype === 'init') {
          this._sessionId = data.session_id
          this._respawnCount = 0
          // #4929: resume confirmed — claude CLI fired its first system.init,
          // so the `--resume` (if any) succeeded. Clear the attempt tracker so
          // a later unrelated exit doesn't get misclassified as resume failure,
          // drop the stderr buffer (was only useful for failure diagnostics),
          // and release the one-shot fallback latch so a FUTURE unknown-resume
          // (e.g. user wipes ~/.claude/projects/ while chroxy keeps running and
          // then crashes) can fall back again.
          this._attemptedResumeId = null
          this._recentStderrLines = []
          this._didFallbackFromUnknownResume = false
          // #4828: bind the session-scoped logger now that session_id is
          // known. Subsequent log lines route through the WsServer log
          // fan-out (#4787) to dashboards bound to this session.
          this._log = loggerForSession('cli-session', data.session_id)
          // #3687: persist the actual model the CLI booted with so
          // sendSessionInfo (replay on reconnect / tab switch) reports the
          // truth instead of `null` when the user didn't specify a model.
          if (typeof data.model === 'string' && data.model) {
            this.bootedModel = data.model
          }
          ;(this._log || log).info(`Session initialized: ${data.session_id}`)
          this.emit('ready', {
            sessionId: data.session_id,
            model: data.model,
            tools: data.tools,
          })
          // Emit MCP server status if present (including empty list to clear stale state)
          if (Array.isArray(data.mcp_servers)) {
            if (data.mcp_servers.length > 0) {
              // #4828: session-scoped (post-init).
              ;(this._log || log).info(`MCP servers: ${data.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ')}`)
            }
            this.emit('mcp_servers', { servers: data.mcp_servers })
          }
        } else {
          // Forward non-init system events (e.g. usage limits, sub-agent
          // notifications) as system messages to the client
          const text = data.message || data.text || data.subtype || 'System event'
          // #4828: session-scoped (non-init system event arrives after init).
          ;(this._log || log).info(`System event (${data.subtype || 'unknown'}): ${text}`)
          this.emit('message', {
            type: 'system',
            content: text,
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'stream_event': {
        const event = data.event
        if (!event) break

        const messageId = this._currentMessageId
        const ctx = this._currentCtx
        if (!messageId || !ctx) break

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
              ctx.currentToolName = event.content_block.name
              ctx.toolInputChunks = ''
              ctx.toolInputBytes = 0
              ctx.toolInputOverflow = false
              // Delegate to the shared parser so CliSession + SdkSession
              // emit identical tool_start payloads (see
              // claude-stream-parser.js for the toolId-derivation rules).
              const toolStartData = buildToolStartData(messageId, event.content_block)
              // #4778: align ctx with the wire-emitted toolUseId so the
              // synthesized fallback (`${messageId}-tool` when
              // content_block.id is missing) propagates to
              // _applyToolInputSemantics → user_question / agent_spawned
              // and _activeAgents.set(). Without this, ctx.currentToolUseId
              // stayed undefined on the fallback path and downstream
              // payloads carried toolUseId=undefined.
              ctx.currentToolUseId = toolStartData.toolUseId
              this.emit('tool_start', toolStartData)
              // #4628: track so _clearMessageState (or _emitResult) can
              // sweep on turn-end if the API ever drops a tool_result.
              this._trackToolStart(toolStartData.toolUseId, event.content_block.name)
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
              if (typeof delta.partial_json === 'string' && !ctx.toolInputOverflow) {
                const chunkBytes = Buffer.byteLength(delta.partial_json, 'utf8')
                if (ctx.toolInputBytes + chunkBytes > this._maxToolInput) {
                  ctx.toolInputChunks = ''
                  ctx.toolInputOverflow = true
                  // #4828: session-scoped (stream_event fires post-init).
                  ;(this._log || log).warn(`toolInputChunks exceeded ${this._maxToolInput} bytes, discarding buffer`)
                  this.emit('error', {
                    message: `Tool input too large (>${Math.round(this._maxToolInput / 1024)}KB) for ${ctx.currentToolName || 'unknown tool'} — input was truncated`,
                  })
                } else {
                  ctx.toolInputChunks += delta.partial_json
                  ctx.toolInputBytes += chunkBytes
                }
              }
            }
            break
          }

          case 'content_block_stop': {
            if (ctx && ctx.currentToolName) {
              this._applyToolInputSemantics(ctx)
            }
            if (ctx) {
              ctx.currentContentBlockType = null
              ctx.currentToolName = null
              ctx.currentToolUseId = null
              ctx.toolInputChunks = ''
            }
            break
          }
        }
        break
      }

      case 'assistant': {
        // The assistant event fires repeatedly with --include-partial-messages,
        // delivering incrementally growing text content. When stream_event events
        // provide real-time deltas, we skip assistant text (didStreamText guard).
        // Otherwise, derive streaming from the incremental assistant text growth
        // so the dashboard shows real-time token-by-token rendering.
        const ctx = this._currentCtx
        const messageId = this._currentMessageId
        const content = data.message?.content
        if (Array.isArray(content) && ctx && messageId) {
          // If stream_event deltas already drove streaming, skip assistant text
          if (ctx.didStreamText) {
            break
          }

          // Concatenate all text blocks to handle multi-block content safely
          let fullText = ''
          for (const block of content) {
            if (block.type === 'text' && block.text) fullText += block.text
          }

          const prevLen = ctx.assistantTextSeen
          if (fullText.length > prevLen) {
            if (!ctx.hasStreamStarted) {
              ctx.hasStreamStarted = true
              this.emit('stream_start', { messageId })
            }
            this.emit('stream_delta', { messageId, delta: fullText.slice(prevLen) })
            ctx.assistantTextSeen = fullText.length
          }
          // tool_use blocks are handled by content_block_start → tool_start event;
          // emitting them here too would create duplicate tool messages in the app
        }
        break
      }

      case 'user': {
        // Tool result content blocks appear in user-role messages during the tool loop
        emitToolResults(data.message?.content, this)
        break
      }

      case 'result': {
        if (data.session_id) {
          this._sessionId = data.session_id
        }

        const messageId = this._currentMessageId
        const ctx = this._currentCtx

        // #5064 — Fallback for turns that complete without ever emitting
        // streamed assistant text. The canonical case is `/compact`: the
        // CLI returns the compaction summary in `data.result` but emits
        // either no `assistant` event at all, or one with empty/no-growth
        // text content, so the dashboard sees nothing. Mirror the SDK
        // fallback (sdk-session.js:801) and surface `data.result` as a
        // `message` of type `response` before the `result` event fires.
        // Guard on !hasStreamStarted so normal streamed turns aren't
        // double-emitted.
        //
        // #5088 — Same silent-disappear pattern for error-subtype text.
        // Some result events carry human-readable text in `data.error.subtype`
        // (e.g. permission_denied, usage_limit_exceeded) without any
        // streamed assistant content. Surface that text by emitting a
        // `type: 'error'` message (→ `messageType: 'error'` on the wire) so
        // downstream consumers render it as a distinct error bubble rather
        // than a normal reply. The `data.result` path above takes priority —
        // only fall back to error-subtype text when `data.result` was
        // missing/empty so we never double-emit for the same turn.
        if (!ctx?.hasStreamStarted && typeof data.result === 'string' && data.result.length > 0) {
          this.emit('message', {
            type: 'response',
            content: data.result,
            timestamp: Date.now(),
          })
        } else if (
          !ctx?.hasStreamStarted &&
          typeof data.error?.subtype === 'string' &&
          data.error.subtype.length > 0
        ) {
          this.emit('message', {
            type: 'error',
            content: data.error.subtype,
            timestamp: Date.now(),
          })
        }

        // Close any open stream before emitting result
        if (ctx?.hasStreamStarted) {
          this.emit('stream_end', { messageId })
        }

        // Emit plan_ready before clearing state — the turn that calls
        // ExitPlanMode ends with a normal result event
        if (this._inPlanMode && this._planAllowedPrompts !== null) {
          this.emit('plan_ready', { allowedPrompts: this._planAllowedPrompts })
          this._inPlanMode = false
          this._planAllowedPrompts = null
        }

        this.emit('result', {
          sessionId: data.session_id,
          // #5629: `total_cost_usd` is forwarded verbatim from claude's
          // stream-json result. Historically this was `null` for subscription
          // runs (no dollar charge). On/after 2026-06-15 claude-cli draws on
          // the metered programmatic-credit pool, so this becomes REAL credit
          // spend — the session-manager finite-cost gate accumulates it the
          // same way it does api-key spend (see _trackUsage / the billing-class
          // cost contract there). No code change needed here; the field just
          // starts carrying a finite number for those runs.
          cost: data.total_cost_usd,
          duration: data.duration_ms,
          usage: data.usage,
          // #6692: the CLI's stream-json result is produced by the same
          // runtime as the SDK's; when it carries modelUsage/num_turns/
          // duration_api_ms, forward them — all three degrade to null on
          // older CLI builds that omit them.
          numTurns: Number.isFinite(data.num_turns) ? data.num_turns : null,
          apiDurationMs: Number.isFinite(data.duration_api_ms) ? data.duration_api_ms : null,
          modelUsage: normalizeSdkModelUsage(data.modelUsage),
        })

        // Message complete — ready for next message
        this._clearMessageState()
        break
      }
    }
  }

  /**
   * Apply session-state side effects for tools whose accumulated
   * `toolInputChunks` JSON drives plan-mode flags, agent tracking, or
   * user-question prompts. Called at `content_block_stop` once the full
   * tool input has been buffered. Delegates the wire-format parsing to
   * the shared {@link extractToolInputSemantics} so SdkSession (which
   * receives the full input directly in `_handleToolUseBlock`) cannot
   * drift in how it interprets the same tool names.
   *
   * `ctx.toolInputChunks` is the empty string after overflow discard, so
   * AskUserQuestion / Task / ExitPlanMode paths that need a real payload
   * are naturally skipped on overflow; EnterPlanMode takes the no-input
   * path and still fires.
   *
   * @param {{ currentToolName: string|null, currentToolUseId: string|null, toolInputChunks: string }} ctx
   * @private
   */
  _applyToolInputSemantics(ctx) {
    const toolName = ctx.currentToolName
    const toolUseId = ctx.currentToolUseId
    // `parseSucceeded` tracks whether the buffered JSON parsed without
    // throwing — distinct from `parsed != null`, because JSON.parse can
    // legally return falsy values (0, false, '', null) and the
    // pre-extraction code emitted on any successful parse regardless of
    // the parsed value. Gating on truthiness would silently drop those
    // payloads. (#4774 Copilot review)
    let parsed = null
    let parseSucceeded = false
    if (ctx.toolInputChunks) {
      try {
        parsed = JSON.parse(ctx.toolInputChunks)
        parseSucceeded = true
      } catch (err) {
        // Parse-failure logging matches the per-tool pre-extraction
        // messages so existing log scraping continues to work.
        if (toolName === 'AskUserQuestion') {
          // #4828: session-scoped (tool parsing runs strictly post-init).
          ;(this._log || log).error(`Failed to parse AskUserQuestion input: ${err.message}`)
          return
        }
        if (toolName === 'Task') {
          ;(this._log || log).warn(`Failed to parse Task tool input: ${err.message}`)
          return
        }
        if (toolName === 'ExitPlanMode') {
          ;(this._log || log).warn(`Failed to parse ExitPlanMode input: ${err.message}`)
          // ExitPlanMode falls through with parseSucceeded=false so the
          // empty allowedPrompts default still applies.
        }
      }
    }

    const semantics = extractToolInputSemantics(toolName, parsed)
    if (!semantics) return

    switch (semantics.kind) {
      case 'ask_user_question': {
        // The pre-extraction code required a non-empty buffer AND a
        // successful parse before emitting; preserve that gate via
        // `parseSucceeded` (truthiness of `parsed` would drop legal
        // falsy JSON values).
        if (!parseSucceeded) return
        // #4828: session-scoped.
        ;(this._log || log).info(`AskUserQuestion detected (${toolUseId})`)
        this._waitingForAnswer = true
        this.emit('user_question', {
          toolUseId,
          questions: semantics.payload.questions,
        })
        return
      }
      case 'task': {
        if (!parseSucceeded) return
        const agentInfo = {
          toolUseId,
          description: semantics.payload.description,
          startedAt: Date.now(),
        }
        this._activeAgents.set(toolUseId, agentInfo)
        this.emit('agent_spawned', agentInfo)
        return
      }
      case 'enter_plan': {
        this._inPlanMode = true
        this.emit('plan_started')
        return
      }
      case 'exit_plan': {
        this._planAllowedPrompts = semantics.payload.allowedPrompts
        return
      }
    }
  }

  /**
   * Clear per-message state, marking us as ready for the next message.
   * After clearing, drains the next item from _pendingQueue (if any) so
   * that all queued messages are eventually delivered in FIFO order.
   */
  _clearMessageState() {
    super._clearMessageState()
    this._waitingForAnswer = false
    this._currentCtx = null
    // Reset permission pause bookkeeping — the next message starts fresh.
    this._pendingPermissionIds.clear()
    this._resultTimeoutPaused = false
    // If plan mode is active but ExitPlanMode never arrived (interrupt/crash),
    // the flag is stale — reset it. In normal flow, _planAllowedPrompts is
    // non-null (set by ExitPlanMode) and plan_ready has already been emitted
    // + both flags reset before we reach here.
    if (this._inPlanMode && this._planAllowedPrompts === null) {
      this._inPlanMode = false
    }
    this._planAllowedPrompts = null
    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }

    // Drain the next queued message on the next tick so that any synchronous
    // 'result' event listeners finish before sendMessage() is called.
    // This prevents re-entrancy where both a result listener and the drain
    // both call sendMessage() in the same tick, sending two messages when
    // only one is expected.
    //
    // #5936: two distinct queues drain here, in priority order:
    //   1. `_outgoingQueue` (shared, BaseSession) — mid-turn send-while-busy
    //      follow-ups. Flushed via dequeueNextOutgoing() (which emits
    //      message_dequeued + re-dispatches on nextTick). This is the common
    //      case after a normal turn.
    //   2. `_pendingQueue` (CLI-only) — messages that arrived while the child
    //      process was NOT ready (pre-init / respawn). Pre-#5936 behaviour,
    //      unchanged. Only drained when the outgoing queue is empty so a single
    //      turn flushes exactly one message and the next `result` flushes the
    //      next (each re-dispatch re-sets _isBusy).
    if (this._processReady) {
      if (this._outgoingQueue.length > 0) {
        this.dequeueNextOutgoing()
      } else if (this._pendingQueue.length > 0) {
        process.nextTick(() => {
          if (this._destroying) return
          if (!this._processReady || this._pendingQueue.length === 0) return
          const pending = this._pendingQueue.shift()
          // #4828: session-scoped (post-result, post-init).
          ;(this._log || log).info(`Dequeuing next pending message after result (${this._pendingQueue.length} remaining)`)
          this.sendMessage(pending.prompt, pending.attachments, pending.options || {})
        })
      }
    }
  }

  /**
   * Kill the current child process (if any) and respawn.
   * Suppresses auto-respawn during the kill, clears timers, and starts fresh.
   */
  _killAndRespawn() {
    // #4471: emit synthetic terminating events BEFORE setting _respawning,
    // otherwise the _handleChildClose guard short-circuits and the dashboard
    // never receives `agent_idle` — Stop stays stuck on panic-button +
    // mid-turn setModel paths.
    this._emitInterruptedTurnResult()

    this._respawning = true
    this._processReady = false
    // #4887 — DO NOT null `_sessionId` here. `start()` reads it as the
    // `--resume` argument; clearing it would force the respawned subprocess
    // to mint a brand-new conversation and the model would see the new user
    // message with no prior turns — exactly the cold-start failure in #4887.
    // The session id is re-confirmed by the next `system.init` (claude CLI
    // echoes the resumed id back), so the in-process value stays accurate
    // even on the rare fork case.
    // #4828: drop the session-scoped logger so the next init re-binds it
    // (the underlying session_id is unchanged on a normal resume, but the
    // logger context is re-created on every init for symmetry with first-
    // boot — cheap and avoids any stale closure).
    this._log = null

    // #4887 — the respawned child re-attaches to the prior conversation via
    // `--resume <_sessionId>`. The append/system bucket still rides on
    // `--append-system-prompt` at spawn (already in the new argv). The
    // prepend bucket is concatenated onto the FIRST user message; a respawn
    // means the next sendMessage() is once again that first message. Reset
    // the flag so the prepend bucket flows through on the next turn (#3225).
    this._skillsPrepended = false

    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }

    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer)
      this._respawnTimer = null
    }
    this._respawnScheduled = false

    // #3966: release the soft + hard inactivity timers armed for the dropped
    // turn. The panic-button path (`setPermissionMode('auto')` while busy)
    // and `setModel` mid-turn both detach the in-flight message context, so
    // these timers would otherwise either fire `_handleHardTimeout` against
    // a stale messageId or linger past test boundaries as phantom timers.
    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
    if (this._hardTimeout) {
      clearTimeout(this._hardTimeout)
      this._hardTimeout = null
    }
    // #4467: release the stream-stall timer too for the same reason.
    if (this._streamStallTimeout) {
      clearTimeout(this._streamStallTimeout)
      this._streamStallTimeout = null
    }
    this._resultTimeoutPaused = false

    this._cleanupReadlines()

    if (this._child) {
      const oldChild = this._child
      this._child = null

      let didClose = false
      const respawn = () => {
        if (didClose) return
        didClose = true
        this._respawning = false
        this._respawnCount = 0
        if (this._destroying) return
        this.start()
      }

      oldChild.on('close', () => {
        clearTimeout(forceKillTimer)
        respawn()
      })

      // Force-kill after 10s if process doesn't exit cleanly
      const forceKillTimer = setTimeout(() => {
        if (!didClose) {
          // #4828: session-scoped if init has fired before kill.
          ;(this._log || log).warn('Process did not exit after 10s, force-killing')
          try {
            forceKill(oldChild)
          } catch (_err) {
            // Process may already be gone, that's fine
          }
          respawn()
        }
      }, 10000)
      // #6043: fire-and-forget respawn safety net — never gate process exit on
      // it. Respawn runs either off the child's 'close' or this fallback; if the
      // loop is otherwise dead the process is exiting and there is nothing to
      // respawn into, so holding the loop open for 10s only leaks (notably in
      // tests with a mock child that never emits 'close').
      if (typeof forceKillTimer.unref === 'function') forceKillTimer.unref()

      // #6643 — on Windows a plain SIGTERM only TerminateProcess-es the cmd.exe
      // shim wrapping a `.cmd` provider (claude/codex/…); the real node
      // grandchild is orphaned and the wrapper's `close` above then cancels the
      // forceKill escalation before it can fire. killProcessTree reaps the whole
      // tree (POSIX behaviour is an identical graceful SIGTERM).
      killProcessTree(oldChild)
    } else {
      this._respawning = false
      this._respawnCount = 0
      if (!this._destroying) {
        this.start()
      }
    }
  }

  /** Clean up readline interfaces */
  _cleanupReadlines() {
    if (this._rl) {
      this._rl.close()
      this._rl = null
    }
    if (this._stderrRL) {
      this._stderrRL.close()
      this._stderrRL = null
    }
  }

  /**
   * Change the model used for subsequent messages.
   * Kills the current process and respawns with the new model (new session).
   * #5374: BaseSession.setModel owns the guard + resolve and fires this hook.
   */
  _onModelChanged() {
    // #4828: session-scoped if init has fired before the model change.
    ;(this._log || log).info(`Model changed to ${this.model || 'default'}, restarting process`)
    this._killAndRespawn()
  }

  _onPermissionModeChanged(mode) {
    // #3729 panic-button semantics: BaseSession.setPermissionMode lets `'auto'`
    // bypass the `_isBusy` guard, so flipping to auto mid-turn IS destructive —
    // the in-flight `claude -p` process is killed and respawned, dropping the
    // current turn. This is by design (parity with SDK auto-resolve of pending
    // prompts); see #3735 for the regression test pinning this behavior.
    // #4828: session-scoped if init has fired.
    ;(this._log || log).info(`Permission mode changed to ${mode}, restarting process`)
    this._killAndRespawn()
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   * Claude is waiting for user input on stdin mid-turn, so we bypass
   * the _isBusy check and write directly.
   */
  respondToQuestion(text) {
    if (!this._child || !this._waitingForAnswer) return
    this._waitingForAnswer = false
    const ndjson = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    })
    try {
      this._child.stdin.write(ndjson + '\n')
    } catch (err) {
      // #4828: session-scoped (respondToQuestion fires strictly post-init).
      ;(this._log || log).error(`stdin.write failed (respondToQuestion): ${err.message}`)
    }
  }

  // Synthetic terminating events for an interrupted turn. The `result` emit
  // is load-bearing: event-normalizer fans it to `agent_idle`, which clears
  // the dashboard's streamingMessageId/isIdle. Without it, an interrupted
  // turn leaves Stop stuck visible and "Thinking…" permanent.
  // Mirrors TUI #4010. cost:null skips session-manager billing.
  _emitInterruptedTurnResult(duration = 0) {
    if (!this._isBusy || !this._currentMessageId) return
    const messageId = this._currentMessageId
    const sessionId = this._sessionId
    if (this._currentCtx?.hasStreamStarted) {
      this.emit('stream_end', { messageId })
    }
    this._clearMessageState()
    this.emit('result', { cost: null, duration, usage: null, sessionId })
  }

  _handleChildClose(code) {
    this._cleanupReadlines()
    this._processReady = false
    this._child = null

    // #4602: capture-and-clear up front so the flag never leaks past a
    // close, even when the _destroying / _respawning guards short-circuit
    // (e.g. user clicks Stop → flag set → model switch fires
    // _killAndRespawn → _respawning short-circuit hits, but the flag must
    // not persist to silently swallow a real crash on a future close).
    const wasIntentionalStop = this._consumeIntentionalStop()

    // #4929: capture the resume-attempt state for this child BEFORE the
    // destroy/respawn short-circuits return. A `--resume <id>` that the CLI
    // rejected ("No conversation found …") exits the child quickly without
    // ever emitting system.init, so `_attemptedResumeId` is still set when we
    // get here. We mirror the wasIntentionalStop capture-and-clear pattern so
    // the flag never leaks past a close.
    const attemptedResumeId = this._attemptedResumeId
    const stderrLines = this._recentStderrLines
    this._attemptedResumeId = null
    this._recentStderrLines = []

    if (this._destroying) return
    if (this._respawning) return

    this._emitInterruptedTurnResult()

    // #4602: user-initiated Stop sent SIGINT via interrupt(). The child
    // exited cleanly as a result — do NOT show "exited unexpectedly" and
    // do NOT auto-respawn the child the user explicitly stopped.
    if (wasIntentionalStop) {
      // #4828: session-scoped if init had fired before the stop.
      ;(this._log || log).info(`Process exited (code ${code}) after user stop`)
      this.emit('stopped', { code })
      return
    }

    // #4929: classify as resume-unknown when a `--resume <id>` spawn exited
    // before claude CLI fired its first system.init AND the buffered stderr
    // matches a known "no conversation found" pattern. Without this branch the
    // generic "exited unexpectedly" toast + auto-respawn loop would re-pass
    // the same broken resume id forever (the bug reported in #4929).
    //
    // Detection requires BOTH conditions:
    //   - attemptedResumeId is set (the spawn passed `--resume`)
    //   - stderrIndicatesUnknownResume(stderrLines) matched a known pattern
    //
    // We deliberately require the pattern match instead of treating "any exit
    // before init while resuming" as resume-unknown — a genuine CLI crash
    // mid-resume (network blip, OAuth refresh, OS OOM kill) would otherwise
    // get misclassified and we'd silently wipe the user's `_sessionId`. The
    // pattern matcher is the load-bearing safety net.
    if (attemptedResumeId && stderrIndicatesUnknownResume(stderrLines)) {
      // One-shot fallback latch (#4929 — see constructor). If we already
      // fell back from an unknown resume earlier this lifecycle and the
      // fresh spawn ALSO died with the same pattern, escalate to a terminal
      // "auto-recovery exhausted" path: surface a distinct error code and
      // STOP the auto-respawn so the session sits down until the user takes
      // a deliberate next step.
      //
      // #4948: previously this branch still called `_scheduleRespawn()` —
      // but the next spawn would re-confirm via `system.init` (clearing the
      // latch AND re-setting `_sessionId` from the init payload) which made
      // the "give up" toast immediately precede what looked like a normal
      // recovery. Two problems with that:
      //   1. The user sees a confusing "auto-recovery gave up" message and
      //      then the session appears to be working again, with no signal
      //      whether the underlying issue is actually resolved.
      //   2. If the fresh-start spawn ALSO fails the same way, we'd just
      //      respawn again, ad infinitum until `_respawnCount` hits the cap
      //      buried inside `_scheduleRespawn`.
      // Stopping here gives a clean terminal state: `_sessionId` is null,
      // the latch resets so a future explicit start can re-arm the one-shot
      // fallback, and the operator/UI gets an unambiguous "the auto-recovery
      // gave up, you need to act" signal.
      if (this._didFallbackFromUnknownResume) {
        ;(this._log || log).error(
          `Resume fallback also failed (code ${code}, attemptedResumeId=${attemptedResumeId}) — ` +
          'auto-recovery exhausted; will NOT respawn. User must start a fresh session manually.',
        )
        // Reset the latch so a future explicit user-driven start can re-arm
        // the one-shot fallback. Without this reset the latch would persist
        // past the terminal error and prevent recovery on the very next
        // manual start (which would silently skip the auto-fallback and
        // fall straight through to the generic-crash respawn loop).
        this._didFallbackFromUnknownResume = false
        // Keep `_sessionId = null` (was already cleared by the first
        // fallback branch below) so a manual restart omits `--resume` and
        // mints a brand-new conversation rather than re-attempting the
        // broken id a third time.
        this._sessionId = null
        this.emit('error', {
          code: 'resume_unknown_exhausted',
          message:
            'Auto-recovery exhausted: Claude CLI rejected the resumed conversation id and a fresh-start ' +
            'retry also failed. Start a new session manually to continue. ' +
            'Check the chroxy logs for the stderr from the claude subprocess.',
          attemptedResumeId,
        })
        return
      }

      ;(this._log || log).warn(
        `Resume rejected by claude CLI (code ${code}, attemptedResumeId=${attemptedResumeId}) — ` +
        'falling back to a fresh conversation. Prior transcript is preserved in the chroxy ring buffer ' +
        'but the model will not see the earlier turns (claude CLI does not know that conversation id).',
      )
      // Clear the broken id so the next spawn omits `--resume` and mints a
      // brand-new claude conversation. SessionManager will pick up the new
      // session_id from the next system.init via the existing
      // `resumeSessionId` getter → persistence chain (#4887).
      this._sessionId = null
      this._didFallbackFromUnknownResume = true
      // Reset _skillsPrepended so the prepend bucket flows onto the FIRST
      // user message of the fresh conversation (#3225) — mirrors the
      // _killAndRespawn handling, just for the resume-fallback path.
      this._skillsPrepended = false
      // Emit a distinct error event so the dashboard can render a one-shot
      // "Conversation no longer exists on this machine — starting fresh"
      // affordance instead of the generic "exited unexpectedly" toast.
      this.emit('error', {
        code: 'resume_unknown',
        message:
          'Previous Claude conversation could not be resumed (the id is unknown to the local claude CLI — ' +
          'it may have been wiped from ~/.claude/projects/). Starting a fresh conversation; the model will ' +
          'not see the earlier transcript.',
        attemptedResumeId,
      })
      this._scheduleRespawn()
      return
    }

    // #4828: session-scoped if init had fired.
    ;(this._log || log).info(`Process exited (code ${code}), scheduling respawn`)
    this.emit('error', { message: 'Claude process exited unexpectedly, restarting...' })
    this._scheduleRespawn()
  }

  /** Interrupt the current message (send SIGINT to child process) */
  interrupt() {
    // #5936: a deliberate Stop cancels the owner's queued follow-ups (cancel,
    // not flush). Clear BEFORE the SIGINT so the synthetic interrupted-turn
    // `result` → _clearMessageState drain sees an empty queue and nothing
    // auto-fires after the halt. Runs even with no child so a queued send is
    // never stranded.
    this.clearOutgoingQueue()

    if (!this._child) return

    // #4602: mark the imminent child exit as user-initiated so
    // _handleChildClose suppresses the "exited unexpectedly" error and the
    // auto-respawn. If the child survives SIGINT (claude only aborts the
    // current turn), the next natural exit will be a real crash — the flag
    // is cleared in _handleChildClose on whichever exit fires first.
    this.markIntentionalStop()

    // #4828: session-scoped if init has fired.
    ;(this._log || log).info('Sending SIGINT to claude process')
    this._child.kill('SIGINT')

    // Safety: if still busy after 5s, force-clear state.
    // Claude should either emit a result (process survives) or die (close handler respawns).
    // Clear any existing timer first to avoid orphaned timers on rapid interrupts.
    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }
    this._interruptTimer = setTimeout(() => {
      this._interruptTimer = null
      // #4602: if the child survived SIGINT (claude only aborted the turn),
      // clear the flag so a later natural crash still triggers respawn —
      // otherwise the flag stays armed indefinitely and swallows real crashes.
      this._clearIntentionalStop()
      if (this._isBusy) {
        // #4828: session-scoped.
        ;(this._log || log).warn('Interrupt safety timeout — force-clearing busy state')
        this._emitInterruptedTurnResult()
      }
    }, 5000)
    // #6043: fire-and-forget busy-state safety net — never gate process exit on
    // it. It only force-clears local state if the child ignored SIGINT; if the
    // loop is otherwise idle the process is exiting and the state is moot.
    if (typeof this._interruptTimer.unref === 'function') this._interruptTimer.unref()
  }

  /** Clean up resources */
  destroy() {
    this._destroying = true
    this._respawning = false
    // #5936: tear down the shared outgoing queue silently (no message_dequeued
    // for a session that's going away).
    this.clearOutgoingQueue({ emit: false })
    this._clearIntentionalStop()

    // Clean up permission hook — destroy() now chains unregister() after any
    // in-flight register() promise, preventing a register-after-unregister race
    // that would leave a dead hook in settings.json.
    if (this._hookManager) {
      this._hookManager.destroy()
    }

    if (this._respawnTimer) {
      clearTimeout(this._respawnTimer)
      this._respawnTimer = null
    }
    this._respawnScheduled = false

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
    if (this._hardTimeout) {
      clearTimeout(this._hardTimeout)
      this._hardTimeout = null
    }
    if (this._streamStallTimeout) {
      clearTimeout(this._streamStallTimeout)
      this._streamStallTimeout = null
    }

    if (this._interruptTimer) {
      clearTimeout(this._interruptTimer)
      this._interruptTimer = null
    }

    this._cleanupReadlines()

    if (this._child) {
      // Close stdin for clean exit
      try { this._child.stdin.end() } catch {}

      // Force-kill after 3s if still alive
      const child = this._child
      const forceKillTimer = setTimeout(() => {
        try { forceKill(child) } catch {}
      }, 3000)
      // #6043: fire-and-forget safety net — never gate process exit on it. If
      // the loop is otherwise idle the process is shutting down anyway and the
      // child is reaped on exit; the timer only matters while the loop is alive
      // for other reasons. Without unref it pins the loop for the full 3s in
      // tests whose mock child never emits 'close'.
      if (typeof forceKillTimer.unref === 'function') forceKillTimer.unref()

      child.on('close', () => clearTimeout(forceKillTimer))
      this._child = null
    }

    // Emit completions for any tracked agents and clear busy state.
    // Must happen before removeAllListeners() so events are delivered.
    this._clearMessageState()
    this._inPlanMode = false

    this._processReady = false
    this.removeAllListeners()
  }
}
