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
import { materializeAttachments, buildAttachmentsPromptSuffix } from './claude-tui-attachments.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Permission hook script — same one CliSession uses. Lives at
// packages/server/hooks/permission-hook.sh.
const PERMISSION_HOOK_SCRIPT = resolve(__dirname, '..', 'hooks', 'permission-hook.sh')

const log = createLogger('claude-tui-session')

// #4031: broaden ANSI strip beyond CSI to also handle the escape
// categories that the claude TUI emits during startup + redraw:
//
//   CSI:                ESC [ <params> <final byte 0x40..0x7E>
//   OSC:                ESC ] <data> ( BEL | ESC \ )    e.g. title set
//   SS3:                ESC O <byte>                    e.g. function keys
//   Bracketed paste:    ESC [ ? 2004 [hl]               handled by CSI re
//   Single-char:        ESC = | ESC > | ESC c | ...     terminal-mode bytes
//
// The previous regex only covered CSI, so OSC title-sets / SS3 cursor
// keys interleaved with the "❯ " glyph would survive the strip and
// leave control bytes in _outputTail, breaking the substring match.
// Strip them all so the saved tail is plain printable text only.
const ANSI_STRIP = new RegExp(
  [
    '\\x1b\\[[0-9;?]*[\\x40-\\x7E]', // CSI
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC ... BEL or ST
    '\\x1bO.', // SS3
    '\\x1b[=>cN]', // common single-char terminal-mode codes
    '[\\x00-\\x08\\x0b-\\x1f\\x7f]', // stray C0 controls except \t and \n
  ].join('|'),
  'g',
)

// Render a byte buffer as a compact hex + ASCII dump suitable for log
// lines. Used by the probe-timeout diagnostic so the actual TUI output
// is visible — no more guessing whether the glyph was missing, mangled,
// or just past the search window (#4031).
//
// Accepts either a Buffer (preferred — see #4031 review on the
// stripped-tail problem) or a string (utf8-encoded to bytes). `maxBytes`
// caps the dump size; caller is expected to pass at least the probe-
// scan window so the dump covers the full region. A smaller cap would
// hide bytes the probe actually checked, defeating the diagnostic's
// purpose (review-caught regression: PR originally hardcoded 256
// internally while the probe widened to 1024).
function formatHexDump(input, maxBytes) {
  let buf
  if (Buffer.isBuffer(input)) {
    buf = input
  } else if (typeof input === 'string') {
    buf = Buffer.from(input, 'utf8')
  } else {
    return '<empty>'
  }
  if (buf.length === 0) return '<empty>'
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : buf.length
  const slice = buf.subarray(-Math.min(buf.length, cap))
  const omitted = buf.length - slice.length
  const lines = []
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.subarray(i, i + 16)
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk).map((b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    lines.push(`${hex.padEnd(48)}  |${ascii}|`)
  }
  const header = omitted > 0
    ? `(${slice.length} of ${buf.length} bytes; first ${omitted} omitted)`
    : `(${slice.length} bytes)`
  return `${header}\n${lines.join('\n')}`
}

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
      // #4013: TUI supports mid-session permission switch via a sidecar
      // file the hook script re-reads on every tool call. No PTY restart
      // (which would lose the resumed conversation context), unlike
      // CliSession's restart-based setPermissionMode.
      permissionModeSwitch: true,
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
    // #4013: sidecar file containing the current permission mode. The
    // hook script re-reads it on every tool call so setPermissionMode()
    // can take effect without restarting the PTY (which would lose the
    // resumed conversation context).
    this._permissionModeFile = null
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
    // #4031 (review): _outputTail is ANSI-stripped for readability +
    // probe stability, so the hex-dump diagnostic sourced from it
    // could never surface the very escape/control bytes we wanted to
    // see when the probe missed. Keep an UNSTRIPPED parallel tail —
    // sized in real bytes via Buffer — exclusively for the hex dump
    // so 0x1b/OSC/SS3 sequences land in the log. node-pty returns
    // UTF-8 strings already decoded, but the relevant control bytes
    // are 7-bit ASCII and survive the decode unchanged.
    this._outputTailRaw = Buffer.alloc(0)
  }

  // Tail length to keep + length to include in error diagnostics.
  static get PTY_TAIL_BYTES() { return 4096 }
  static get PTY_TAIL_DIAGNOSTIC_BYTES() { return 1024 }

  // Glyphs the TUI may print to mark its input prompt. The original "❯ "
  // (U+276F + space) was the only candidate before #4031; expanded to
  // cover variants seen in different claude TUI builds and configs:
  //   - "❯ "   — modern claude TUI, glyph followed by space
  //   - "❯"    — same glyph without trailing space (cursor on top, some
  //              terminal widths render without the pad)
  //   - "> "   — ASCII fallback when the TUI detects a non-Unicode TERM
  //
  // All three are required to appear at line-start (preceded by '\n' or
  // the very beginning of the search window) — without that anchor,
  // "> " false-positives against markdown blockquotes in assistant
  // output, and bare "❯" false-positives against any text that happens
  // to use the glyph as a list bullet. The match is line-anchored to
  // mean "the TUI just rendered an empty prompt line", which is what
  // we actually care about (#4031, #4033).
  static get PROMPT_GLYPHS() { return ['❯ ', '❯', '> '] }
  // Backwards-compatibility shim — tests imported PROMPT_GLYPH prior to
  // #4031. Returns the primary candidate. New code should prefer the
  // PROMPT_GLYPHS list directly.
  static get PROMPT_GLYPH() { return this.PROMPT_GLYPHS[0] }

  /**
   * True iff `tail` contains any PROMPT_GLYPHS candidate at line-start
   * (after a newline, or at the very start of the string). Used by the
   * readiness probe + tests; extracted for clarity since the line-
   * anchor logic isn't obvious from `.includes()` calls.
   */
  static promptGlyphAppearsIn(tail) {
    if (typeof tail !== 'string' || tail.length === 0) return false
    return this.PROMPT_GLYPHS.some((g) => {
      const idx = tail.indexOf(g)
      if (idx < 0) return false
      // Walk through every occurrence; accept if any is at line-start.
      let i = idx
      while (i >= 0) {
        if (i === 0 || tail[i - 1] === '\n') return true
        i = tail.indexOf(g, i + 1)
      }
      return false
    })
  }
  // Window for the probe scan, in JS string code units (UTF-16, NOT
  // UTF-8 bytes — see review note below). Widened from 256 → 1024 in
  // #4031 because claude TUI's startup splash + redraw cycle is larger
  // than the original budget assumed, leading to probe misses on cold
  // sessions. The glyph from an earlier turn that's drifted past this
  // window no longer counts as "current" — the same drift logic as
  // before, just a more generous threshold.
  //
  // #4031 (review): the previous name "*_BYTES" was misleading. The
  // probe slices a JS string (`_outputTail.slice(-N)`), so N counts
  // UTF-16 code units. For ASCII output one code unit == one byte; for
  // Unicode-heavy output (BMP supplementary, emoji, etc.) the actual
  // byte window can be larger. That's fine for the probe — the glyphs
  // we match are short and we want generosity — but the name is now
  // accurate.
  static get PROMPT_TAIL_WINDOW_CHARS() { return 1024 }
  // Backwards-compatibility shim — tests + older callers imported the
  // BYTES name prior to the #4031 review rename. Same value; new code
  // should prefer PROMPT_TAIL_WINDOW_CHARS.
  static get PROMPT_TAIL_WINDOW_BYTES() { return this.PROMPT_TAIL_WINDOW_CHARS }
  // Upper bounds on how long we'll wait for the prompt before falling
  // through (and writing anyway, with a warn). Spawn warmup is generous
  // because cold claude can take >5s on a fresh keychain unlock; per-turn
  // is short because between-turn rendering is fast unless something is
  // already broken.
  static get SPAWN_WARMUP_MAX_MS() { return 15_000 }
  static get TURN_PROMPT_WAIT_MAX_MS() { return 5_000 }

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

    // #4013: write the initial permission mode to a sidecar file so the
    // hook script can pick up mid-session changes (env vars on the
    // running PTY can't be mutated from outside). The file is the source
    // of truth once start() returns; the CHROXY_PERMISSION_MODE env var
    // only matters as a fallback when the file is unreadable. If the
    // initial write itself fails (disk full, permissions, etc.) we drop
    // the sidecar and continue with env-var-only mode — losing the
    // ability to hot-swap is acceptable; failing session start is not.
    if (permissionsEnabled) {
      const sidecarPath = join(this._sinkDir, 'permission-mode')
      try {
        writeFileSync(sidecarPath, this.permissionMode || 'approve')
        this._permissionModeFile = sidecarPath
      } catch (err) {
        log.warn(`initial permission-mode sidecar write failed (${err.message}) — falling back to env-var-only mode; mid-session permission switch will not take effect`)
        this._permissionModeFile = null
      }
    }

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
      // #4013: hook reads sidecar first (per-tool-call, picks up
      // mid-session changes from setPermissionMode), falls back to the
      // env var above when the file is missing/unreadable.
      if (this._permissionModeFile) {
        env.CHROXY_PERMISSION_MODE_FILE = this._permissionModeFile
      }
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
      // Strip pattern broadened in #4031 to cover OSC/SS3/single-char
      // codes that the original CSI-only regex left behind — those
      // interleaved with the "❯ " glyph and broke the readiness probe.
      const rawStr = String(data)
      const stripped = rawStr.replace(ANSI_STRIP, '')
      this._outputTail = (this._outputTail + stripped).slice(-ClaudeTuiSession.PTY_TAIL_BYTES)
      // #4031 (review): also retain a parallel UNSTRIPPED tail sized
      // in real bytes via Buffer, exclusively for the timeout hex
      // dump. _outputTail can never surface the escape/control bytes
      // we want to diagnose because the strip happens before storage;
      // _outputTailRaw closes that gap without polluting the readable
      // tail used by other diagnostics.
      const chunk = Buffer.from(rawStr, 'utf8')
      const merged = this._outputTailRaw.length === 0
        ? chunk
        : Buffer.concat([this._outputTailRaw, chunk])
      this._outputTailRaw = merged.length > ClaudeTuiSession.PTY_TAIL_BYTES
        ? merged.subarray(-ClaudeTuiSession.PTY_TAIL_BYTES)
        : merged
    })
    this._term.onExit((info) => {
      this._ptyExited = true
      this._ptyExitInfo = info
      this._processReady = false
      // Reset turn state so the next sendMessage() sees a clean idle
      // (it'll still reject with "no longer alive", but won't be locked
      // by stale _isBusy from a turn the PTY interrupted) (#3924).
      const hadActiveTurn = this._activeTurn !== null
      // #4022: clean up the in-flight turn's attachment dir BEFORE
      // nulling _activeTurn, otherwise sendMessage's poll loop reaches
      // _finishTurnError with activeTurn=null and the helper no-ops →
      // dir leaks until destroy(). The cleanup is idempotent (rmSync
      // with force:true), so _finishTurnError calling it again is fine.
      this._cleanupTurnAttachments(this._activeTurn)
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

    // Wait for the TUI to render its input prompt before returning. The
    // prior implementation used a hardcoded 3.5s sleep, which silently
    // failed when claude took longer to come up — the first sendMessage
    // would write bytes into a non-prompt buffer and the turn would stall
    // indefinitely (#4014; same root-cause class as #4010). The probe
    // watches _outputTail for the "❯ " glyph; on miss we still proceed so
    // a tail-encoding edge case can't permanently brick the session.
    const ready = await this._waitForPrompt(ClaudeTuiSession.SPAWN_WARMUP_MAX_MS)
    if (!ready && !this._ptyExited) {
      // #4031: dump what claude actually wrote so we can tell whether
      // the glyph is missing, in a different encoding, or just past
      // the search window. Pre-fix this was a guess-and-rebuild loop;
      // the dump turns it into one round-trip.
      log.warn(
        `TUI prompt glyph not seen within ${ClaudeTuiSession.SPAWN_WARMUP_MAX_MS}ms — proceeding (first sendMessage may stall)\n` +
        `_outputTail dump:\n${this._outputTailHexDump()}`,
      )
    }
  }

  /**
   * Resolve `true` when the TUI input prompt is rendered, `false` on
   * timeout or PTY exit. The probe scans only the trailing
   * PROMPT_TAIL_WINDOW_CHARS of _outputTail: an older prompt glyph from
   * an earlier turn will still be in the buffer for a while but says
   * nothing about *current* readiness — when the TUI is mid-render the
   * recent bytes are response/animation frames, not the prompt.
   *
   * Tries each candidate in PROMPT_GLYPHS to handle TUI variants
   * (modern unicode prompt, no-trailing-space cursor placement, ASCII
   * fallback). Win if ANY candidate matches.
   *
   * Used by _spawnPty (one-time, generous timeout) and sendMessage
   * (per-turn, short timeout). The per-turn call closes the
   * between-turn race that produced #4014 — Stop hook fires before the
   * TUI re-renders its input box, and the next prompt's bytes arrive
   * during that transient render and get dropped.
   */
  async _waitForPrompt(timeoutMs) {
    // windowChars (NOT windowBytes) — slicing a JS string counts UTF-16
    // code units, not UTF-8 bytes. For ASCII output the two are equal;
    // for Unicode-heavy output the actual byte window may be larger,
    // which is harmless here (we only need to find a short glyph). See
    // PROMPT_TAIL_WINDOW_CHARS docstring (#4031 review).
    const windowChars = ClaudeTuiSession.PROMPT_TAIL_WINDOW_CHARS
    const start = Date.now()
    const matches = (tail) => ClaudeTuiSession.promptGlyphAppearsIn(tail)
    while (Date.now() - start < timeoutMs) {
      if (this._ptyExited) return false
      if (matches(this._outputTail.slice(-windowChars))) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return matches(this._outputTail.slice(-windowChars))
  }

  /**
   * #4031: dump the trailing bytes of the UNSTRIPPED PTY tail as a
   * hex+ASCII block for a log line. Called when the readiness probe
   * times out so the actual TUI output is visible — saves a debugging
   * round-trip where we'd otherwise have to guess whether the glyph
   * was missing, mangled by an unstripped control byte, or just past
   * the search window. Public-ish (single underscore) so tests can
   * assert on the format without re-implementing it.
   *
   * Sourced from `_outputTailRaw` (a Buffer of raw, un-ANSI-stripped
   * bytes) so escape/control sequences land in the log; sourcing from
   * the stripped `_outputTail` would silently hide the very bytes the
   * diagnostic exists to surface (#4031 review).
   */
  _outputTailHexDump() {
    // Cap at the probe-scan window so the dump is the same SIZE the
    // probe scanned — but since the raw buffer carries un-stripped
    // bytes (escape sequences + their printable payload), the actual
    // visible content here is a strict superset of what the probe saw
    // and may include bytes the probe never had a chance to match.
    // That's the point: the dump should expose them.
    const windowChars = ClaudeTuiSession.PROMPT_TAIL_WINDOW_CHARS
    return formatHexDump(this._outputTailRaw, windowChars)
  }

  async sendMessage(prompt, attachments, _options = {}) {
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

    // #4012: TUI can't accept inline multimodal blocks the way SDK/CLI
    // do, but it CAN read files via the Read tool. Materialize each
    // attachment under the per-session sink dir and append a structured
    // suffix to the prompt naming each file. Pre-fix, attachments were
    // dropped on the floor (the `_attachments` underscore was load-
    // bearing). Failure here is non-fatal: we log and proceed with the
    // unaugmented prompt so a write-fault doesn't lose the user's text.
    let promptToSend = prompt
    if (attachments?.length && this._sinkDir) {
      try {
        const baseDir = join(this._sinkDir, 'attachments')
        // #4022: record the per-turn dir up-front so cleanup runs on
        // every exit path (success, abort, hard timeout, PTY exit
        // mid-turn). materializeAttachments() creates the dir before it
        // decides whether any individual attachment is salvageable, so
        // even an "all skipped" outcome (every att.data invalid → files
        // returns []) leaves the empty dir on disk. If we only recorded
        // attachmentsDir when the suffix was truthy, that empty dir
        // would leak until destroy() rmSync'd the whole sinkDir — fine
        // for short sessions, an on-disk drip for long-lived ones.
        this._activeTurn.attachmentsDir = join(baseDir, messageId)
        const files = materializeAttachments(attachments, baseDir, messageId)
        const suffix = buildAttachmentsPromptSuffix(files)
        if (suffix) {
          promptToSend = (prompt || '') + suffix
          log.info(`TUI attachments materialized (msg=${messageId} count=${files.length} dir=${this._activeTurn.attachmentsDir})`)
        }
      } catch (err) {
        log.warn(`TUI attachment materialization failed (msg=${messageId}): ${err.message} — sending prompt without attachments`)
      }
    }

    // #4010: fire stream_start the moment the turn begins, not after the
    // Stop hook arrives. This is the only signal the dashboard has for
    // `agent_busy` (event-normalizer.js:62-66 synthesizes it from
    // stream_start). Pre-fix, stream_start was deferred until the response
    // came back as one burst — fine on a normal 10-30s turn, but if the
    // TUI stalls (claude not yet at the prompt when our bytes arrive),
    // stream_start NEVER fires, the dashboard thinks the session is idle
    // even though _isBusy=true, so the Send button doesn't toggle to Stop
    // and the user has no UI escape hatch from a stuck session.
    this.emit('stream_start', { messageId })

    // #4014: wait for the TUI to be at its input prompt before writing.
    // Between turns the TUI re-renders "❯ " after Stop hook fires, and
    // if our bytes arrive during that transient render they get dropped
    // and the turn stalls indefinitely. On the first turn this also
    // catches the case where _spawnPty's warmup window expired without
    // ever seeing the glyph. We still write if the probe misses — the
    // glyph might be encoded unexpectedly on some terminals and we'd
    // rather risk a stall than refuse to deliver any prompt.
    const ready = await this._waitForPrompt(ClaudeTuiSession.TURN_PROMPT_WAIT_MAX_MS)
    if (!ready && !this._ptyExited) {
      // #4031: dump the trailing tail so the next dogfood failure
      // tells us WHY the probe missed (missing glyph, mangled bytes,
      // glyph past window) instead of forcing a guess-and-rebuild loop.
      log.warn(
        `TUI not at prompt before turn (msg=${messageId}) — writing anyway\n` +
        `_outputTail dump:\n${this._outputTailHexDump()}`,
      )
    }
    if (this._ptyExited) {
      const code = this._ptyExitInfo?.exitCode
      const signal = this._ptyExitInfo?.signal
      this._finishTurnError(`Claude PTY exited before prompt write (code=${code}${signal ? ` signal=${signal}` : ''})`, messageId)
      return
    }
    // If the user clicked Stop during the probe wait, interrupt() has
    // already written Ctrl-C to the PTY and marked the turn aborted.
    // Writing the prompt now would queue it behind the cancel and either
    // execute against a half-reset TUI or silently desync busy state
    // (server clears busy via _finishTurnError below, but the TUI might
    // still process the bytes once it returns to prompt). Bail cleanly.
    if (this._activeTurn?.aborted) {
      this._finishTurnError('Turn aborted before prompt write', messageId)
      return
    }

    try {
      this._term.write(promptToSend + '\r')
    } catch (err) {
      this._finishTurnError(`Failed to write prompt to PTY: ${err.message}`, messageId)
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
      this._finishTurnError(tail ? `${reason}\nTUI output tail:\n${tail}` : reason, messageId)
      return
    }

    const duration = Date.now() - startedAt
    const text = typeof stopPayload.last_assistant_message === 'string' ? stopPayload.last_assistant_message : ''

    // Deliver the response as a single stream burst so the dashboard renders
    // one assistant bubble (matches CliSession's event shape on Claude's side).
    // stream_start was already emitted at turn start (#4010) — don't fire it
    // again here or the dashboard creates two assistant bubbles for one turn.
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
    // #4022: drop the per-turn attachment dir now that the Stop hook
    // has fired and the response has streamed back. The Read-tool
    // results are already in the model's context window, so the bytes
    // on disk aren't needed for the next turn.
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
  }

  /**
   * #4022: rmSync the per-turn attachment directory if the turn
   * materialized any files. No-op when the turn had no attachments
   * (the common case). rmSync uses `force: true` so a missing dir
   * (already cleaned up by an earlier path, or never created) doesn't
   * throw. The session-level _sinkDir cleanup in destroy() remains as
   * a backstop for any cleanup we miss here.
   */
  _cleanupTurnAttachments(activeTurn) {
    const dir = activeTurn?.attachmentsDir
    if (!dir) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      log.warn(`per-turn attachment cleanup failed (${dir}): ${err.message}`)
    }
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

  _finishTurnError(message, callerMessageId) {
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    // #4010: balance the early stream_start with stream_end + result so the
    // dashboard's busy state clears (event-normalizer.js:215 synthesizes
    // agent_idle from result). Without this, an aborted/failed TUI turn
    // leaves the Send button toggled to Stop indefinitely.
    //
    // Prefer the caller-supplied messageId so a PTY-exit-mid-turn race
    // (onExit nulls _currentMessageId before the poll loop falls through
    // to here) still pairs stream_end with the stream_start we opened.
    // Without that fallback, the if(messageId) guard would silently skip
    // stream_end, leaving session-message-history._pendingStreams holding
    // the entry until destroy().
    const messageId = callerMessageId || this._currentMessageId
    const duration = this._activeTurn ? Date.now() - this._activeTurn.startedAt : 0
    if (messageId) this.emit('stream_end', { messageId })
    this.emit('error', { message })
    this.emit('result', { cost: 0, duration, usage: null, sessionId: this._sessionId })
    // #4022: drop the per-turn attachment dir on every failure path so
    // a stalled/aborted/PTY-exited turn doesn't leak the materialized
    // files until destroy(). No-op when the turn had no attachments.
    this._cleanupTurnAttachments(this._activeTurn)
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
    const duration = this._activeTurn ? Date.now() - this._activeTurn.startedAt : this._hardTimeoutMs
    this.emit('stream_end', { messageId })
    // #4022: drop the per-turn attachment dir on hard timeout. Done
    // BEFORE nulling _activeTurn so the helper still has access to the
    // attachmentsDir path. No-op when the turn had no attachments.
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    this.emit('error', { message: `Response timed out after ${friendly}` })
    // #4010: emit result so the dashboard receives agent_idle and clears
    // the Stop button. stream_end on its own only clears streamingMessageId.
    this.emit('result', { cost: 0, duration, usage: null, sessionId: this._sessionId })
  }

  /**
   * #4013: mid-session permission switch. Unlike CliSession, the TUI
   * does NOT restart its PTY on mode change — env vars on a running
   * process can't be mutated from outside, so we write the new mode to
   * a sidecar file the hook script re-reads on every tool call. The
   * persistent conversation context survives the change. Takes effect
   * on the next tool-call boundary; an in-flight tool that already
   * routed to /permission is unaffected.
   */
  setPermissionMode(mode) {
    if (!super.setPermissionMode(mode)) return
    if (!this._permissionModeFile) {
      // Permissions weren't enabled at start (no port). Mode was
      // updated on `this.permissionMode` by super; nothing else to do.
      log.info(`Permission mode changed to ${mode} (no sidecar — hook script not active)`)
      return
    }
    // Atomic update: write a tmp file then rename. Direct writeFileSync
    // truncates-then-writes, so a concurrent hook read could observe an
    // empty/partial value mid-write and fall through to the stale env
    // var. rename(2) is atomic within the same filesystem, so readers
    // either see the OLD complete value or the NEW complete value —
    // never an empty/partial value.
    const tmpPath = `${this._permissionModeFile}.tmp-${randomUUID()}`
    try {
      writeFileSync(tmpPath, mode)
      renameSync(tmpPath, this._permissionModeFile)
      log.info(`Permission mode changed to ${mode} (sidecar updated, no PTY restart)`)
    } catch (err) {
      // Best-effort cleanup of the tmp file if rename never landed.
      try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
      // Hook precedence is file → env var. If the rename failed the
      // sidecar still holds the previous mode, so the next tool call
      // reads the stale FILE value (not the env var). Be explicit so
      // the operator isn't misled.
      log.warn(`failed to write permission-mode sidecar (${err.message}) — next tool call will use the previously written mode from the sidecar file`)
    }
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
      // Write Ctrl-C (0x03) to the PTY rather than killing the process.
      // Claude TUI intercepts it as "cancel current request, return to
      // input prompt", so the session stays alive and the next
      // sendMessage() works normally. Matches _handleHardTimeout.
      try { this._term.write('\x03') } catch { /* ignore */ }
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
    // Sidecar file lived inside _sinkDir which we just removed — clear
    // the reference so setPermissionMode() after destroy() no-ops cleanly.
    this._permissionModeFile = null
    this._consumedFiles.clear()
    this._clearMessageState()
  }
}
