import { randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { BaseSession } from './base-session.js'
import { FALLBACK_MODELS, ALLOWED_MODEL_IDS, claudeDeriveId, resolveClaudeContextWindow } from './models.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { createLogger } from './logger.js'

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
  // Atomic write via temp + rename to avoid concurrent corruption.
  const tmp = `${claudeConfig}.chroxy.${process.pid}.tmp`
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
  }

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
    log.info(`spawn claude TUI (uuid=${this._sessionId.slice(0, 8)} perms=${permissionsEnabled})`)

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

    this._term.onData(() => { /* drain & discard */ })
    this._term.onExit((info) => {
      this._ptyExited = true
      this._ptyExitInfo = info
      this._processReady = false
      if (!this._destroying) {
        log.warn(`claude PTY exited unexpectedly (code=${info?.exitCode} signal=${info?.signal})`)
        this.emit('error', { message: `Claude PTY exited (code=${info?.exitCode})` })
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
    }

    while (Date.now() - pollStart < HOOK_TIMEOUT_MS) {
      if (this._activeTurn?.aborted) break
      if (this._ptyExited) break
      drainHookFiles()
      if (stopPayload) break
      await new Promise((r) => setTimeout(r, 150))
    }

    if (!stopPayload) {
      this._finishTurnError(this._activeTurn?.aborted
        ? 'turn aborted'
        : `Stop hook timeout after ${Math.round((Date.now() - pollStart) / 1000)}s`)
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
      if (!this._activeTurn) return
      this._activeTurn.synthSeq = (this._activeTurn.synthSeq || 0) + 1
      toolUseId = `${messageId}-tool-${this._activeTurn.synthSeq}`
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
    this.emit('error', { message })
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
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
    if (this._term) {
      try { this._term.kill('SIGTERM') } catch { /* already dead */ }
      this._term = null
    }
    this._clearMessageState()
  }
}
