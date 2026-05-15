import { randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { BaseSession } from './base-session.js'
import { FALLBACK_MODELS, ALLOWED_MODEL_IDS, claudeDeriveId, resolveClaudeContextWindow } from './models.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { createLogger } from './logger.js'
import { formatIdleDuration } from './session-timeout-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Permission hook script — same one CliSession uses. Lives at
// packages/server/hooks/permission-hook.sh.
const PERMISSION_HOOK_SCRIPT = resolve(__dirname, '..', 'hooks', 'permission-hook.sh')

const log = createLogger('claude-tui-session')

const CLAUDE = resolveBinary('claude', [
  join(homedir(), '.local/bin/claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.claude/local/node_modules/.bin/claude'),
  join(homedir(), '.npm-global/bin/claude'),
])

// Pre-trust the cwd in ~/.claude.json so the workspace-trust dialog doesn't
// block headless spawn. The dialog is interactive-only — without this, the
// PTY would render "Is this a project you trust?" and wait for Enter.
// Idempotent: if already trusted, no write.
function ensureCwdTrusted(cwd) {
  const realCwd = realpathSync(cwd)
  const claudeConfig = join(homedir(), '.claude.json')
  let config = {}
  if (existsSync(claudeConfig)) {
    try {
      config = JSON.parse(readFileSync(claudeConfig, 'utf8'))
    } catch (err) {
      log.warn(`~/.claude.json unreadable, skipping trust pre-write: ${err.message}`)
      return
    }
  }
  if (!config.projects || typeof config.projects !== 'object') {
    config.projects = {}
  }
  const existing = config.projects[realCwd]
  if (existing && existing.hasTrustDialogAccepted === true) return

  config.projects[realCwd] = {
    ...(existing || {}),
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: existing?.projectOnboardingSeenCount ?? 0,
  }
  // Atomic write via temp + rename. Use a per-call random suffix rather
  // than process.pid — concurrent ClaudeTuiSessions in the same chroxy
  // server share the pid, so two start()s racing for a different cwd
  // would clobber each other's temp file (#3922). The realpathSync()
  // earlier in this function still means each session writes a
  // different *target* path, but the temp file is global and needs to
  // be unique per write.
  const tmp = `${claudeConfig}.chroxy.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2))
  renameSync(tmp, claudeConfig)
}

// Build a settings.json that registers Stop + tool hooks. Claude pipes the
// hook event JSON to the command's stdin. Per-event filename pattern:
//   Stop         → <sink>/stop-<uuid>.json   (one per turn)
//   PreToolUse   → <sink>/pre-<uuid>.json    (one per tool call)
//   PostToolUse  → <sink>/post-<uuid>.json   (one per tool call)
//
// `uuidgen` gives us atomic unique names cross-platform (macOS + Linux).
// IMPORTANT: do not use `mktemp <sink>/foo-XXXXXX.json` — macOS BSD mktemp
// does NOT expand the X-template when there's a `.json` suffix after it,
// so the file ends up named literally "foo-XXXXXX.json" and every turn
// overwrites the same file. Found the hard way during the #3902 smoke
// test: turn-2 Stop hook was written but then skipped by the poller
// because its filename was already in _consumedFiles from turn 1.
//
// Each turn's poller scans the sink for files it hasn't yet consumed —
// so a persistent PTY can fire 1..N Stop events across the session
// lifetime and each turn picks up only its own.
//
// This is written ONCE per session at start() — the same settings.json is
// reused across every turn, so changing it mid-session has no effect
// (claude reads it at spawn time).
function writeHookSettings(sinkDir, { permissionsEnabled }) {
  const settingsPath = join(sinkDir, 'settings.json')
  const sinkDirEsc = JSON.stringify(sinkDir)
  // PreToolUse runs ALL registered hooks in order. We always capture the
  // event for our own observability; when permissions are enabled the
  // chroxy permission-hook.sh runs SECOND, gating the tool call via long-
  // poll to /permission. Claude waits for every hook to exit non-zero
  // before running the tool.
  const preToolUseHooks = [
    { type: 'command', command: `cat > ${sinkDirEsc}/pre-$(uuidgen).json` },
  ]
  if (permissionsEnabled) {
    preToolUseHooks.push({
      type: 'command',
      command: PERMISSION_HOOK_SCRIPT,
      timeout: 300,
    })
  }
  const settings = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: `cat > ${sinkDirEsc}/stop-$(uuidgen).json` }] },
      ],
      PreToolUse: [
        { hooks: preToolUseHooks },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: `cat > ${sinkDirEsc}/post-$(uuidgen).json` }] },
      ],
    },
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}

/**
 * ClaudeTuiSession — drives the interactive `claude` TUI under a PTY so the
 * round-trip bills as a subscription instead of programmatic (`claude -p` and
 * the Agent SDK are meter-shifted to programmatic pricing starting 2026-06-15;
 * the TUI path is untouched). #3902.
 *
 * Persistent-process shape — start() spawns ONE PTY (paying ~3.5s warmup
 * once), then every sendMessage() writes the next prompt to the same PTY
 * and reads its Stop hook payload. destroy() kills the PTY.
 * Deliver-on-complete only (no incremental streaming).
 *
 * Events emitted:
 *   ready         { sessionId, model, tools }
 *   stream_start  { messageId }
 *   stream_delta  { messageId, delta }
 *   stream_end    { messageId }
 *   result        { cost, duration, usage, sessionId }
 *   tool_start    { messageId, toolUseId, tool, input }
 *   tool_result   { toolUseId, result, truncated }
 *   error         { message }
 */
export class ClaudeTuiSession extends BaseSession {
  static get displayLabel() {
    return 'Claude Code (TUI · subscription)'
  }

  static get dataDir() {
    return join(homedir(), '.claude')
  }

  static get capabilities() {
    return {
      // Permissions are gated via the chroxy permission-hook.sh script that
      // posts to /permission on the chroxy HTTP server, same flow as
      // CliSession. Requires a `port` arg at construction so the
      // PreToolUse hook can phone home.
      permissions: true,
      inProcessPermissions: false,
      modelSwitch: false,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
      thinkingLevel: false,
      streaming: false,
      tools: true,
    }
  }

  static get preflight() {
    return {
      label: 'Claude TUI',
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
        envVars: [],
        hint: 'run `claude login` (subscription required — this provider does NOT accept ANTHROPIC_API_KEY)',
        optional: true,
      },
    }
  }

  static getFallbackModels() {
    return FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  static getModelMetadata(modelId) {
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    const fullId = modelId
    const id = claudeDeriveId(fullId)
    return { id, label: id, fullId, contextWindow: resolveClaudeContextWindow(fullId), description: '' }
  }

  constructor({ cwd, model, permissionMode, port, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider, activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, resultTimeoutMs, hardTimeoutMs } = {}) {
    super({ cwd, model, permissionMode, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider: provider || 'claude-tui', activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, resultTimeoutMs, hardTimeoutMs })

    this._port = port || null
    // Per-session hook secret — picked up by WsServer's session_created handler
    // (ws-server.js:_registerSessionHookSecretIfMissing reads
    // `entry.session._hookSecret` duck-typed). Mirrors the same name CliSession
    // uses so the existing permission HTTP route routes us with no changes.
    this._hookSecret = this._port ? randomBytes(32).toString('hex') : null
    this._sessionId = null   // upstream claude conversation uuid, assigned at start()
    this._sinkDir = null     // created on start, removed on destroy
    this._term = null        // persistent PTY for the session's lifetime
    this._settingsPath = null
    this._consumedFiles = new Set()  // hook payload filenames already processed
    this._activeTurn = null  // { messageId, startedAt, aborted, synthSeq }
    this._ptyExited = false
    this._ptyExitInfo = null
    // Ring buffer of recent PTY output bytes — surfaces in error
    // messages when the TUI renders a diagnostic (rate-limit, auth
    // failure, "switch back to API mode") that would otherwise be
    // silently dropped (#3919). Kept small (~4KB) so it doesn't eat
    // memory on long sessions.
    this._outputTail = ''
  }

  // Tail length to keep + length to include in error diagnostics.
  static get PTY_TAIL_BYTES() { return 4096 }
  static get PTY_TAIL_DIAGNOSTIC_BYTES() { return 1024 }

  get sessionId() {
    return this._sessionId
  }

  async start() {
    // Pre-flight: ensure cwd is trusted so the dialog doesn't block PTY spawns.
    try {
      ensureCwdTrusted(this.cwd)
    } catch (err) {
      log.warn(`trust pre-write failed (continuing): ${err.message}`)
    }

    // Create per-session sink dir for hook payloads + settings.json.
    const base = join(tmpdir(), 'chroxy-claude-tui')
    mkdirSync(base, { recursive: true })
    this._sinkDir = join(base, `s-${randomUUID()}`)
    mkdirSync(this._sinkDir, { recursive: true })

    // Generate the upstream session uuid here so the JSONL path is
    // predictable + so claude resumes the same conversation across turns.
    this._sessionId = randomUUID()

    const permissionsEnabled = !!(this._port && this._hookSecret)
    this._settingsPath = writeHookSettings(this._sinkDir, { permissionsEnabled })

    // Spawn node-pty + wait for TUI warmup. Extracted so tests can stub
    // the prototype method instead of mocking node-pty at the module level.
    await this._spawnPty(permissionsEnabled)

    if (this._ptyExited) {
      this.emit('error', { message: `claude PTY exited during warmup (code=${this._ptyExitInfo?.exitCode})` })
      return
    }

    this._processReady = true
    this.emit('ready', { sessionId: this._sessionId, model: this.model, tools: [] })
  }

  /**
   * Spawn the persistent PTY under node-pty + wait for the TUI to render.
   * Sets `this._term`, wires onData/onExit handlers, then sleeps for
   * WARMUP_MS so the TUI's input prompt is ready before the first
   * sendMessage() writes. Tests stub this method on the prototype to
   * skip the real spawn.
   *
   * @param {boolean} permissionsEnabled
   */
  async _spawnPty(permissionsEnabled) {
    let ptyMod
    try {
      ptyMod = await import('node-pty')
    } catch (err) {
      this.emit('error', { message: `node-pty unavailable: ${err.message}` })
      return
    }

    const cwdReal = realpathSync(this.cwd)
    const env = { ...process.env }
    // The TUI path must route via OAuth subscription. ANTHROPIC_API_KEY would
    // pin auth to API and defeat the whole point of this provider.
    delete env.ANTHROPIC_API_KEY
    env.TERM = 'xterm-256color'

    // permission-hook.sh reads these to phone home to /permission on the
    // chroxy HTTP server with the per-session secret.
    if (permissionsEnabled) {
      env.CHROXY_PORT = String(this._port)
      env.CHROXY_HOOK_SECRET = this._hookSecret
      env.CHROXY_PERMISSION_MODE = this.permissionMode || 'approve'
    }

    const args = [
      '--session-id', this._sessionId,
      '--settings', this._settingsPath,
    ]
    if (this.model) {
      // claude TUI accepts --model (verified against `claude --help`). Without
      // this the requested model was silently dropped, leaving ready.model
      // disagreeing with the actual model the TUI booted on (#3921).
      args.push('--model', this.model)
    }
    // Inject the append-bucket skills text via --append-system-prompt at
    // spawn time so the TUI sees it as part of the system prompt — same
    // channel CliSession uses (#3917). The prepend bucket would need to
    // ride on the first user message instead, but writing multi-line text
    // to a PTY input box prematurely-submits on every embedded \n, so
    // we route the prepend bucket through the same system-prompt channel
    // here. Semantically not identical to CliSession's split (prepend goes
    // to user message there), but functionally correct for the MVP and
    // avoids the PTY newline problem.
    const skillsPrefix = (typeof this._buildCombinedSkillsPrefix === 'function')
      ? this._buildCombinedSkillsPrefix()
      : ''
    if (skillsPrefix) {
      args.push('--append-system-prompt', skillsPrefix)
    }
    log.info(`spawn claude TUI (uuid=${this._sessionId.slice(0, 8)} model=${this.model || 'default'} perms=${permissionsEnabled} skills=${skillsPrefix ? skillsPrefix.length + 'b' : 'none'})`)

    try {
      this._term = ptyMod.spawn(CLAUDE, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: cwdReal,
        env,
      })
    } catch (err) {
      this.emit('error', { message: `Failed to spawn claude under PTY: ${err.message}` })
      return
    }

    this._term.onData((data) => {
      // Keep a tail of recent output so we can surface diagnostics when
      // the TUI renders an error inline (#3919). Strip ANSI escape
      // sequences before storing so the saved tail is readable; we
      // don't visual-render the PTY, so the colors aren't useful.
      const stripped = String(data).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      this._outputTail = (this._outputTail + stripped).slice(-ClaudeTuiSession.PTY_TAIL_BYTES)
    })
    this._term.onExit((info) => {
      this._ptyExited = true
      this._ptyExitInfo = info
      this._processReady = false
      // Reset turn state so the next sendMessage() sees a clean idle
      // (it'll still reject with "no longer alive", but won't be locked
      // by stale _isBusy from a turn the PTY interrupted) (#3924).
      const hadActiveTurn = this._activeTurn !== null
      this._activeTurn = null
      this._isBusy = false
      this._currentMessageId = null
      if (this._destroying) return
      log.warn(`claude PTY exited unexpectedly (code=${info?.exitCode} signal=${info?.signal})`)
      // Suppress the generic onExit error when a turn was in flight —
      // sendMessage's poll loop emits a more specific "PTY exited
      // mid-turn" error instead, so the dashboard sees one root cause
      // not two.
      if (!hadActiveTurn) {
        const tail = this._outputTailDiagnostic()
        const base = `Claude PTY exited (code=${info?.exitCode})`
        this.emit('error', { message: tail ? `${base}\nTUI output tail:\n${tail}` : base })
      }
    })

    // Wait for TUI to render + accept input. One-time warmup cost; the
    // whole point of the persistent-PTY refactor is to pay this once at
    // session start instead of on every sendMessage().
    // TODO(post-MVP): detect readiness by watching for "❯ " in pty output.
    const WARMUP_MS = 3500
    await new Promise((r) => setTimeout(r, WARMUP_MS))
  }

  async sendMessage(prompt, _attachments, _options = {}) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }
    if (!this._processReady || !this._term || this._ptyExited) {
      this.emit('error', { message: 'Session not started or PTY no longer alive' })
      return
    }

    this._isBusy = true
    this._messageCounter += 1
    const messageId = `${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId
    const startedAt = Date.now()
    this._activeTurn = { messageId, startedAt, aborted: false, synthSeq: 0 }

    try {
      this._term.write(prompt + '\r')
    } catch (err) {
      this._finishTurnError(`Failed to write prompt to PTY: ${err.message}`)
      return
    }

    // Arm soft + hard inactivity timers (#3920). Each new hook file the
    // poll loop drains re-arms both, so a long turn that's making
    // progress (tool calls firing, intermediate hooks) never trips them.
    // Soft fires once per silent stretch → inactivity_warning;
    // hard fires after the full window of silence → force-clear + error.
    this._armResultTimeout()

    // Poll the sink dir for new hook files. mktemp-named filenames make each
    // turn's Stop / Pre / Post events distinct from previous turns'; the
    // session-level _consumedFiles Set ensures we never re-process a file
    // that an earlier turn already handled.
    const HOOK_TIMEOUT_MS = this._hardTimeoutMs
    const pollStart = Date.now()
    let stopPayload = null

    const drainHookFiles = () => {
      let entries
      try { entries = readdirSync(this._sinkDir) } catch { return }
      const sizeBefore = this._consumedFiles.size
      // Process prefixes in causal order: pre- (tool_start) MUST fire
      // before post- (tool_result) so the dashboard can pair them via
      // toolUseId. Naive lex sort puts "post-…" before "pre-…" because
      // 'o' < 'r', which surfaced as tool_result-before-tool_start in
      // the #3902 smoke test. stop- is processed last so we drain any
      // late-arriving tool files before returning to the caller.
      const ordered = []
      for (const prefix of ['pre-', 'post-', 'stop-']) {
        for (const name of entries.sort()) {
          if (name.startsWith(prefix)) ordered.push(name)
        }
      }
      for (const name of ordered) {
        if (this._consumedFiles.has(name)) continue
        const full = join(this._sinkDir, name)
        let parsed
        try {
          const raw = readFileSync(full, 'utf8')
          if (raw.length === 0) continue  // partial write — poll again
          parsed = JSON.parse(raw)
        } catch { continue }
        this._consumedFiles.add(name)

        if (name.startsWith('stop-')) {
          stopPayload = parsed
          continue
        }
        try {
          this._emitToolHookEvent(name.startsWith('pre-') ? 'PreToolUse' : 'PostToolUse', parsed, messageId)
        } catch (err) {
          log.warn(`tool hook emit failed: ${err.message}`)
        }
      }
      // Any new hook file = progress evidence. Re-arm timers so a turn
      // that's actively producing tool events doesn't trip the soft
      // inactivity warning (#3920).
      if (this._consumedFiles.size > sizeBefore && this._isBusy) {
        this._armResultTimeout()
      }
    }

    while (Date.now() - pollStart < HOOK_TIMEOUT_MS) {
      if (this._activeTurn?.aborted) break
      if (this._ptyExited) break
      // _handleHardTimeout clears _isBusy; bail out cleanly if it fired.
      if (!this._isBusy) break
      drainHookFiles()
      if (stopPayload) break
      await new Promise((r) => setTimeout(r, 150))
    }

    if (!stopPayload) {
      let reason
      if (this._activeTurn?.aborted) {
        reason = 'turn aborted'
      } else if (this._ptyExited) {
        const code = this._ptyExitInfo?.exitCode
        const signal = this._ptyExitInfo?.signal
        reason = `Claude PTY exited mid-turn (code=${code}${signal ? ` signal=${signal}` : ''})`
      } else if (!this._isBusy) {
        // _handleHardTimeout already cleared state + emitted its own
        // error. Just return without double-firing.
        return
      } else {
        reason = `Stop hook timeout after ${Math.round((Date.now() - pollStart) / 1000)}s`
      }
      const tail = this._outputTailDiagnostic()
      this._finishTurnError(tail ? `${reason}\nTUI output tail:\n${tail}` : reason)
      return
    }

    const duration = Date.now() - startedAt
    const text = typeof stopPayload.last_assistant_message === 'string' ? stopPayload.last_assistant_message : ''

    // Deliver the response as a single stream burst so the dashboard renders
    // one assistant bubble (matches CliSession's event shape on Claude's side).
    this.emit('stream_start', { messageId })
    if (text) this.emit('stream_delta', { messageId, delta: text })
    this.emit('stream_end', { messageId })

    this.emit('result', {
      cost: 0,                       // not exposed by Stop hook in MVP
      duration,
      usage: null,                   // not exposed by Stop hook in MVP
      sessionId: this._sessionId,
    })

    // Clear inactivity timers — turn done, nothing to backstop (#3920).
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
  }

  /**
   * Translate one PreToolUse / PostToolUse hook payload into BaseSession tool
   * events. Hook payloads carry tool_use_id (when Claude Code provides it),
   * tool_name, tool_input, and on Post a tool_response. The dashboard pairs
   * `tool_start` with `tool_result` by toolUseId so each tool call renders as
   * one collapsible bubble.
   *
   * tool_use_id is sometimes absent from hook payloads (older claude
   * builds, certain MCP tools); when missing we synthesize a stable id
   * from messageId + a per-turn sequence so the pair still matches.
   *
   * @param {'PreToolUse' | 'PostToolUse'} kind
   * @param {object} payload — parsed hook JSON
   * @param {string} messageId — the current turn's wire-level messageId
   */
  _emitToolHookEvent(kind, payload, messageId) {
    if (!payload || typeof payload !== 'object') return
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown'
    let toolUseId = typeof payload.tool_use_id === 'string' && payload.tool_use_id.length > 0
      ? payload.tool_use_id
      : null
    if (!toolUseId) {
      // Synthesize a stable id when the hook payload omits tool_use_id
      // (older claude builds, certain MCP tools). Increment ONLY on
      // PreToolUse; reuse the current value on the matching PostToolUse
      // so the dashboard can pair tool_start with tool_result by
      // toolUseId (#3923). Breaks if tool calls overlap or Pre fires
      // without a Post, but strictly better than the previous always-
      // mismatch behaviour. The common path — payload carries
      // tool_use_id from claude — is unaffected.
      if (!this._activeTurn) return
      if (kind === 'PreToolUse') {
        this._activeTurn.synthSeq = (this._activeTurn.synthSeq || 0) + 1
      }
      toolUseId = `${messageId}-tool-${this._activeTurn.synthSeq || 1}`
    }

    if (kind === 'PreToolUse') {
      this.emit('tool_start', {
        messageId: toolUseId,
        toolUseId,
        tool: toolName,
        input: payload.tool_input ?? null,
      })
      return
    }

    // PostToolUse — extract a string-ish result for the dashboard.
    let result = ''
    let truncated = false
    const resp = payload.tool_response
    if (typeof resp === 'string') {
      result = resp
    } else if (resp && typeof resp === 'object') {
      // Most Claude tools return { stdout, stderr } or { content: [...] }.
      // Stringify and let the existing tool-result truncation handle size.
      try { result = JSON.stringify(resp) } catch { result = String(resp) }
    }
    const MAX = 10240  // mirror tool-result.js MAX_TOOL_RESULT_SIZE
    if (result.length > MAX) {
      result = result.slice(0, MAX)
      truncated = true
    }

    this.emit('tool_result', {
      toolUseId,
      result,
      truncated,
    })
  }

  _finishTurnError(message) {
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    this.emit('error', { message })
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
  }

  /**
   * Return the tail of recent PTY output suitable for inclusion in an
   * error message, or '' when there's nothing useful. Collapses
   * whitespace runs so the diagnostic is compact (#3919).
   */
  _outputTailDiagnostic() {
    if (!this._outputTail) return ''
    const trimmed = this._outputTail
      .slice(-ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES)
      .replace(/[\r\n]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
    return trimmed
  }

  /**
   * Arm (or re-arm) the soft + hard inactivity timers (#3920).
   *
   * Soft: fires `inactivity_warning` after _resultTimeoutMs of silence.
   * Session stays alive — the dashboard renders a check-in chip.
   *
   * Hard: force-clears busy state + emits `error` after _hardTimeoutMs.
   * Last-resort kill path for sessions that are genuinely stuck.
   *
   * Both are cleared+re-armed on each call, so any progress signal
   * (new hook file processed) resets both windows. Mirrors
   * `CliSession._armResultTimeout()`.
   */
  _armResultTimeout() {
    if (this._resultTimeout) clearTimeout(this._resultTimeout)
    if (this._hardTimeout) clearTimeout(this._hardTimeout)
    this._resultTimeout = null
    this._hardTimeout = null
    this._resultTimeout = setTimeout(() => {
      this._resultTimeout = null
      this._handleInactivityWarning()
    }, this._resultTimeoutMs)
    this._hardTimeout = setTimeout(() => {
      this._hardTimeout = null
      this._handleHardTimeout()
    }, this._hardTimeoutMs)
  }

  _handleInactivityWarning() {
    if (!this._isBusy) return
    const idleMs = this._resultTimeoutMs
    const friendly = formatIdleDuration(idleMs)
    log.info(`Inactivity warning (${friendly}) — session alive, prompting check-in`)
    this.emit('inactivity_warning', {
      messageId: this._currentMessageId,
      idleMs,
      prefab: 'Status update?',
    })
  }

  _handleHardTimeout() {
    if (!this._isBusy) return
    const friendly = formatIdleDuration(this._hardTimeoutMs)
    log.warn(`Hard-cap timeout (${friendly}) — force-clearing busy state`)
    const messageId = this._currentMessageId
    // Best-effort interrupt the running TUI turn (Ctrl-C). Doesn't
    // kill the PTY — claude TUI cancels the in-flight request and
    // returns to the prompt. _isBusy=false below lets the next
    // sendMessage proceed normally.
    if (this._term) {
      try { this._term.write('\x03') } catch { /* ignore */ }
    }
    this.emit('stream_end', { messageId })
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    this.emit('error', { message: `Response timed out after ${friendly}` })
  }

  /**
   * Abort the current turn. Sends SIGINT to the persistent PTY — claude's
   * TUI treats Ctrl-C as "cancel current request, return to input prompt"
   * (NOT as a process kill), so the session stays alive and the next
   * sendMessage() works normally.
   */
  interrupt() {
    if (!this._activeTurn) return
    this._activeTurn.aborted = true
    if (this._term) {
      // Write Ctrl-C as a byte to the PTY rather than killing the process —
      // claude TUI intercepts it for in-session cancellation.
      try { this._term.write('') } catch { /* ignore */ }
    }
  }

  async destroy() {
    this._destroying = true
    this._processReady = false
    this._isBusy = false
    this._activeTurn = null
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    if (this._term) {
      try { this._term.kill('SIGTERM') } catch { /* already dead */ }
      this._term = null
    }
    // Clean up the per-session sink dir so we don't leak hook payload
    // files under /tmp (#3918). One file per turn (stop) plus 2 per
    // tool call (pre + post) accumulate fast on long-running sessions.
    if (this._sinkDir) {
      try { rmSync(this._sinkDir, { recursive: true, force: true }) }
      catch (err) { log.warn(`sink dir cleanup failed: ${err.message}`) }
      this._sinkDir = null
    }
    this._consumedFiles.clear()
    this._clearMessageState()
  }
}
