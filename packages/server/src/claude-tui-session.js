import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { BaseSession } from './base-session.js'
import { FALLBACK_MODELS, ALLOWED_MODEL_IDS, claudeDeriveId, resolveClaudeContextWindow } from './models.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { createLogger } from './logger.js'

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

// Build a settings.json that registers a Stop hook writing the payload to disk.
// Claude pipes the hook event JSON to the command's stdin, so `cat > <path>`
// captures it verbatim.
function writeHookSettings(sinkDir, payloadPath) {
  const settingsPath = join(sinkDir, 'settings.json')
  const settings = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: `cat > ${JSON.stringify(payloadPath)}` }] },
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
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: false,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: false,
      thinkingLevel: false,
      streaming: false,
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

  constructor({ cwd, model, permissionMode, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider, activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, resultTimeoutMs, hardTimeoutMs } = {}) {
    super({ cwd, model, permissionMode, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider: provider || 'claude-tui', activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, resultTimeoutMs, hardTimeoutMs })

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
    const settingsPath = writeHookSettings(this._sinkDir, payloadPath)

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

    const args = ['--session-id', turnUuid, '--settings', settingsPath]
    log.info(`spawn claude TUI (uuid=${turnUuid.slice(0, 8)} msg=${messageId})`)

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

    // Poll for Stop hook payload.
    const HOOK_TIMEOUT_MS = this._hardTimeoutMs
    const pollStart = Date.now()
    let payload = null

    const poll = async () => {
      while (Date.now() - pollStart < HOOK_TIMEOUT_MS) {
        if (this._activeTurn?.aborted) return null
        if (existsSync(payloadPath)) {
          try {
            const raw = readFileSync(payloadPath, 'utf8')
            if (raw.length > 0) {
              return JSON.parse(raw)
            }
          } catch { /* partial write, keep polling */ }
        }
        if (exited) {
          return null
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return null
    }

    payload = await poll()

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
