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
// hook event JSON to the command's stdin. Per-event:
//   Stop         → single file at <sink>/stop-<turn>.json (final response)
//   PreToolUse   → unique file matching <sink>/pre-XXXXXX.json (one per tool)
//   PostToolUse  → unique file matching <sink>/post-XXXXXX.json (one per tool)
//
// `mktemp` gives us atomic unique names cross-platform (BSD + GNU). The
// session's poller scans the sink dir for new pre-/post- files in arrival
// order so PreToolUse → tool_start and PostToolUse → tool_result events fire
// in sequence.
function writeHookSettings(sinkDir, stopPayloadPath, { permissionsEnabled }) {
  const settingsPath = join(sinkDir, 'settings.json')
  const sinkDirEsc = JSON.stringify(sinkDir)
  // PreToolUse runs ALL registered hooks in order. We always capture the
  // event for our own observability; when permissions are enabled the
  // chroxy permission-hook.sh runs SECOND, gating the tool call via long-
  // poll to /permission. Claude waits for every hook to exit non-zero
  // before running the tool.
  const preToolUseHooks = [
    { type: 'command', command: `cat > $(mktemp ${sinkDirEsc}/pre-XXXXXX.json)` },
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
        { hooks: [{ type: 'command', command: `cat > ${JSON.stringify(stopPayloadPath)}` }] },
      ],
      PreToolUse: [
        { hooks: preToolUseHooks },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: `cat > $(mktemp ${sinkDirEsc}/post-XXXXXX.json)` }] },
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
 * MVP shape — one PTY spawn per turn, deliver-on-complete (no streaming).
 * The Stop hook payload includes `last_assistant_message`; the dashboard
 * receives stream_start + stream_delta(full text) + stream_end + result in a
 * single tick after the Stop hook fires.
 *
 * Events emitted:
 *   ready         { sessionId, model, tools }
 *   stream_start  { messageId }
 *   stream_delta  { messageId, delta }
 *   stream_end    { messageId }
 *   result        { cost, duration, usage, sessionId }
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
    this._sessionId = null  // assigned on first sendMessage
    this._sinkDir = null    // created on start, removed on destroy
    this._activeTurn = null // { uuid, ptyTerm, payloadPath, abort }
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

    this._processReady = true
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })
  }

  async sendMessage(prompt, _attachments, _options = {}) {
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return
    }
    if (!this._processReady) {
      this.emit('error', { message: 'Session not started' })
      return
    }

    this._isBusy = true
    this._messageCounter += 1
    const messageId = `${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId

    const turnUuid = this._sessionId || randomUUID()
    if (!this._sessionId) this._sessionId = turnUuid

    const payloadPath = join(this._sinkDir, `stop-${turnUuid}-${this._messageCounter}.json`)
    const permissionsEnabled = !!(this._port && this._hookSecret)
    const settingsPath = writeHookSettings(this._sinkDir, payloadPath, { permissionsEnabled })

    let ptyMod
    try {
      ptyMod = await import('node-pty')
    } catch (err) {
      this._isBusy = false
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
    // chroxy HTTP server with the per-session secret. When permissions
    // aren't enabled (no port given to the constructor) the hook still
    // gets installed but exits silently because CHROXY_PORT is unset.
    if (permissionsEnabled) {
      env.CHROXY_PORT = String(this._port)
      env.CHROXY_HOOK_SECRET = this._hookSecret
      env.CHROXY_PERMISSION_MODE = this.permissionMode || 'approve'
    }

    const args = [
      '--session-id', turnUuid,
      '--settings', settingsPath,
    ]
    log.info(`spawn claude TUI (uuid=${turnUuid.slice(0, 8)} msg=${messageId} perms=${permissionsEnabled})`)

    let term
    try {
      term = ptyMod.spawn(CLAUDE, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: cwdReal,
        env,
      })
    } catch (err) {
      this._isBusy = false
      this.emit('error', { message: `Failed to spawn claude under PTY: ${err.message}` })
      return
    }

    this._activeTurn = { uuid: turnUuid, term, payloadPath, messageId, aborted: false }

    const startedAt = Date.now()

    // Drain pty output (discard — visual parsing is out of scope for MVP).
    term.onData(() => { /* discard */ })

    let exited = false
    let exitInfo = null
    term.onExit((info) => { exited = true; exitInfo = info })

    // Wait for TUI to be ready to accept input, then write prompt.
    // TODO(post-MVP): detect readiness by watching for "❯ " in pty output
    // instead of a fixed delay.
    const PROMPT_DELAY_MS = 3500
    await new Promise((r) => setTimeout(r, PROMPT_DELAY_MS))

    if (exited || this._activeTurn?.aborted) {
      this._finishTurnError(`pty exited before prompt could be sent (code=${exitInfo?.exitCode})`)
      return
    }

    try {
      term.write(prompt + '\r')
    } catch (err) {
      this._finishTurnError(`Failed to write prompt to PTY: ${err.message}`)
      return
    }

    // Poll for hook payloads. Three event streams flow through the sink dir:
    //   stop-<turn>.json           → final response → break the loop
    //   pre-XXXXXX.json (multiple) → tool_start events
    //   post-XXXXXX.json (multiple) → tool_result events
    //
    // Each file is processed once (tracked in `consumed`) and left on disk —
    // sink dir is per-session and cleaned up on destroy.
    const HOOK_TIMEOUT_MS = this._hardTimeoutMs
    const pollStart = Date.now()
    const consumed = new Set()
    let payload = null

    const processToolFiles = () => {
      let entries
      try { entries = readdirSync(this._sinkDir) } catch { return }
      // Sort lexicographically — mktemp's XXXXXX suffix isn't sorted, but
      // for a single turn, the file mtimes are close enough that any
      // tool_start before tool_result on the same toolUseId still arrives
      // in the order the hook fired.
      entries.sort()
      for (const name of entries) {
        if (consumed.has(name)) continue
        if (!name.startsWith('pre-') && !name.startsWith('post-')) continue
        const full = join(this._sinkDir, name)
        let parsed
        try {
          const raw = readFileSync(full, 'utf8')
          if (raw.length === 0) continue  // partial write — poll again
          parsed = JSON.parse(raw)
        } catch { continue }
        consumed.add(name)
        try {
          this._emitToolHookEvent(name.startsWith('pre-') ? 'PreToolUse' : 'PostToolUse', parsed, messageId)
        } catch (err) {
          log.warn(`tool hook emit failed: ${err.message}`)
        }
      }
    }

    while (Date.now() - pollStart < HOOK_TIMEOUT_MS) {
      if (this._activeTurn?.aborted) break

      processToolFiles()

      if (existsSync(payloadPath)) {
        try {
          const raw = readFileSync(payloadPath, 'utf8')
          if (raw.length > 0) {
            payload = JSON.parse(raw)
            // Drain any remaining tool files before exiting (Post may land
            // in the same tick as Stop on a fast turn).
            processToolFiles()
            break
          }
        } catch { /* partial write, keep polling */ }
      }
      if (exited) break
      await new Promise((r) => setTimeout(r, 150))
    }

    if (!payload) {
      this._finishTurnError(this._activeTurn?.aborted
        ? 'turn aborted'
        : `Stop hook timeout after ${Math.round((Date.now() - pollStart) / 1000)}s`)
      return
    }

    const duration = Date.now() - startedAt
    const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : ''

    // Deliver the response as a single stream burst so the dashboard renders
    // one assistant bubble (matches CliSession's event shape on Claude's side).
    this.emit('stream_start', { messageId })
    if (text) this.emit('stream_delta', { messageId, delta: text })
    this.emit('stream_end', { messageId })

    this.emit('result', {
      cost: 0,                     // not exposed by Stop hook in MVP
      duration,
      usage: null,                 // not exposed by Stop hook in MVP
      sessionId: turnUuid,
    })

    this._cleanupTurn()
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
    this._cleanupTurn()
  }

  _cleanupTurn() {
    const turn = this._activeTurn
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    if (turn?.term) {
      try { turn.term.kill('SIGTERM') } catch { /* already dead */ }
    }
  }

  interrupt() {
    if (!this._activeTurn) return
    this._activeTurn.aborted = true
    try { this._activeTurn.term.kill('SIGINT') } catch { /* ignore */ }
  }

  async destroy() {
    this._destroying = true
    if (this._activeTurn) {
      try { this._activeTurn.term.kill('SIGTERM') } catch { /* ignore */ }
      this._activeTurn = null
    }
    this._isBusy = false
    this._processReady = false
    this._clearMessageState()
  }
}
