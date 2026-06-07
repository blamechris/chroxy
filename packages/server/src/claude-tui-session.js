import { randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { BaseSession } from './base-session.js'
import { FALLBACK_MODELS, ALLOWED_MODEL_IDS, claudeDeriveId, resolveClaudeContextWindow } from './models.js'
import { resolveBinary } from './utils/resolve-binary.js'
import { createLogger, loggerForSession } from './logger.js'
import { formatIdleDuration } from './session-timeout-manager.js'
import { isOperatorTimeoutInRange } from './duration.js'
import { materializeAttachments, buildAttachmentsPromptSuffix } from './claude-tui-attachments.js'
import {
  parseBackgroundShellId,
  parseBackgroundShellOutputPath,
  isRunInBackgroundInput,
  parseBashOutputShellId,
} from './background-shells.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Permission hook script — same one CliSession uses. Lives at
// packages/server/hooks/permission-hook.sh.
const PERMISSION_HOOK_SCRIPT = resolve(__dirname, '..', 'hooks', 'permission-hook.sh')

const log = createLogger('claude-tui-session')

// ANSI strip pattern covering the escape categories claude TUI emits
// during startup + redraw — keeps _outputTail readable for inline
// diagnostics (#3919) and the timeout hex dump.
//
//   CSI:                ESC [ <params> <final byte 0x40..0x7E>
//   OSC:                ESC ] <data> ( BEL | ESC \ )    e.g. title set
//   SS3:                ESC O <byte>                    e.g. function keys
//   Bracketed paste:    ESC [ ? 2004 [hl]               handled by CSI re
//   Single-char:        ESC = | ESC > | ESC c | ...     terminal-mode bytes
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

// #4604 — watchdog window for the AskUserQuestion answer round-trip.
// respondToQuestion() writes ONE keystroke (the chosen option's digit)
// and assumes claude TUI emits PostToolUse shortly after. Multi-question
// AskUserQuestion forms violate that assumption: claude TUI renders a
// per-question form that needs additional keystrokes + a Submit, and
// PostToolUse never fires. Without this watchdog the session wedges at
// _isBusy=true forever (the 8m+ symptom in #4604). On expiry we clear
// _isBusy + _pendingUserAnswer and emit ASK_USER_QUESTION_STALL so the
// dashboard can prompt the user to retry. Root cause is fixed in Chunk B.
const ASK_USER_QUESTION_WATCHDOG_MS = 30 * 1000

// #4651 — settle delay between the "Other" digit write and the freeform
// text write. After we press the Other digit, claude TUI swaps from the
// option-select menu to a text-input prompt. Writing the freeform text
// too quickly races that swap (the keystrokes land at the menu and jump-
// nav fires — same footgun as #4288). 150 ms covers the observed local-
// loop swap time with comfortable margin; tune via the empirical
// recording in scripts/tui-form-recorder.mjs if dogfood reveals a wedge.
const OTHER_FREEFORM_SETTLE_MS = 150

// #4651 — additional watchdog window granted after the Other digit lands
// so the freeform text write + claude TUI's text-input acknowledgement
// have time to complete. Without this, the existing 30s ASK_USER_QUESTION
// watchdog can fire mid-freeform-write on a slow PTY (laggy tunnel,
// emoji-heavy text) and tear down a turn that's actively progressing.
const OTHER_FREEFORM_WATCHDOG_MS = 30 * 1000

// #4635 — settle delay between the final single-select question's auto-
// advance digit and the Submit `'1'` keystroke. Mixed multi-question
// forms (with at least one multi-select) work fine because the explicit
// `'\t'` after each multi-select gives claude TUI a settled commit signal
// that fully renders the next screen before our next keystroke. But on a
// pure all-single-select form the LAST digit auto-advances to the Submit
// screen, and the 1ms per-char throttle writes the Submit `'1'` faster
// than claude TUI can render the Submit screen — so the `'1'` lands on
// the still-rendering last-question screen, gets swallowed, and the form
// never submits. The 30s ASK_USER_QUESTION watchdog then fires.
//
// 150 ms mirrors the empirically-validated OTHER_FREEFORM_SETTLE_MS used
// for the option-menu → text-input prompt swap (#4651) — same render-
// settling motivation, same observed magnitude. Only inserted when the
// final question in the sequence is single-select; mixed forms keep the
// pre-#4635 timing-free path (Tab's commit signal makes Submit settle
// naturally and the existing empirical recording pins the Tab + '1' run).
//
// #4882 (resolved 2026-06-07) — the fresh all-single-select recorder pass
// finally ran against a live claude TUI (v2.1.168) and is committed at
// `docs/empirical/4882-all-single-select-2q.jsonl`. A human driving a pure
// two-question all-single-select form submitted with the digit sequence
// `'2','2','1'` and the form committed on the Submit `'1'` ALONE — no
// trailing `\r` was pressed. So:
//   - The Submit screen accepts `'1'` (it does NOT require `\r`, and does
//     NOT auto-submit after the last digit — there IS a Submit screen).
//   - 150ms is kept (LOCKED): the human's natural gap before Submit was
//     ~4s, which confirms a settle works but gives no lower bound, so
//     tuning down isn't justified by this capture. 150ms mirrors the
//     OTHER_FREEFORM_SETTLE_MS render-settle magnitude (#4651) and the
//     #4635 wedge has not recurred, so it stays.
//   - The trailing `\r` below is now CONFIRMED unnecessary (the human
//     never sent it) but is retained as confirmed-harmless belt-and-braces
//     — see the comment at its `sequence.push('\r')` site. It is NOT
//     removed here because this recording covered only the 2-question
//     all-single-select shape; pulling the `\r` from the mixed and 3+q
//     paths it also feeds would be an overreach from a single-shape capture.
// The 30s ASK_USER_QUESTION watchdog remains the safety net for any shape
// not yet captured. Prior wedge analysis: #4635, #4867.
const MULTI_QUESTION_SUBMIT_SETTLE_MS = 150

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
export function writeHookSettings(sinkDir, { permissionsEnabled }) {
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
        // First hook: forensic sink — tee preserves stdin for the
        // sibling-cleanup hook below. Replaces the pre-#4668 cat-to-file
        // because cat would consume stdin entirely, leaving the cleanup
        // hook with an empty payload.
        { hooks: [
          { type: 'command', command: `tee ${sinkDirEsc}/post-$(uuidgen).json | grep -q '"tool_name":"AskUserQuestion"' && rm -rf ${sinkDirEsc}/askuserquestion-active || true` },
        ] },
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

  /**
   * Resolve runtime auth state for the dashboard (#4769).
   *
   * claude-tui explicitly deletes ANTHROPIC_API_KEY from the spawn env and
   * routes via OAuth/Keychain — the interactive TUI under a PTY bypasses
   * programmatic credit metering. Marked ready up front; the on-disk OAuth
   * probe can't see Keychain credentials.
   *
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string}}
   */
  static resolveAuth() {
    const envVars = this.preflight.credentials.envVars
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint: 'run `claude login` if not yet authed',
      detail: 'Claude subscription (interactive TUI under PTY — bypasses programmatic credit metering)',
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

  /**
   * #4653: provider-specific events the SessionManager should forward as
   * transient `session_event`s. `multi_question_intervention` fires from
   * `_emitToolHookEvent` whenever PreToolUse sees an AskUserQuestion whose
   * `questions[]` has length > 1 — i.e. the EXACT condition the bash
   * permission-hook (`packages/server/hooks/permission-hook.sh`, #4648)
   * denies on. The dashboard renders an inline notice + a session-footer
   * counter so the user knows chroxy intercepted the multi-question form.
   * Without this surface the user wonders if the model is being clever
   * (asking one at a time naturally) or if chroxy is intervening — see
   * the v0.9.24 dogfood feedback captured on #4653.
   */
  static get customEvents() {
    return ['multi_question_intervention']
  }

  constructor({ cwd, model, permissionMode, port, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider, activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, chroxyContextHint, sessionPreamble, resultTimeoutMs, hardTimeoutMs, streamStallTimeoutMs, backgroundShellHardQuiesceMs, firstOutputTimeoutMs, skipPermissions } = {}) {
    super({ cwd, model, permissionMode, skillsDir, repoSkillsDir, maxSkillBytes, maxTotalSkillBytes, provider: provider || 'claude-tui', activeManualSkills, providerSkillAllowlist, trustStore, trustMismatchMode, promptEvaluator, promptEvaluatorSkipPattern, chroxyContextHint, sessionPreamble, resultTimeoutMs, hardTimeoutMs, streamStallTimeoutMs, backgroundShellHardQuiesceMs })

    this._port = port || null
    // #4044: when true, spawn `claude` with --dangerously-skip-permissions
    // and skip chroxy's permission-hook + sidecar entirely. The user wants
    // unmediated Claude TUI behaviour, not chroxy's `auto` mode (which still
    // routes every call through the hook). Distinct from `permissionMode`:
    // skipPermissions disables the whole permission system; permissionMode
    // selects between approve/auto/acceptEdits/plan WITHIN it.
    this.skipPermissions = !!skipPermissions
    // Per-session hook secret — picked up by WsServer's session_created handler
    // (ws-server.js:_registerSessionHookSecretIfMissing reads
    // `entry.session._hookSecret` duck-typed). Mirrors the same name CliSession
    // uses so the existing permission HTTP route routes us with no changes.
    this._hookSecret = this._port ? randomBytes(32).toString('hex') : null
    this._sessionId = null   // upstream claude conversation uuid, assigned at start()
    // #4792: session-scoped logger. Assigned in start() once _sessionId is
    // generated. Until then, code paths that need to log MUST fall back to
    // the module-level `log` (e.g. trust pre-write failure, sink dir create
    // failure). Per-session log lines (sendMessage, respondToQuestion,
    // attachment materialization) prefer `this._log` so the WsServer log
    // listener can route them to the right bound client (#4787, #4793).
    this._log = null
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
    // #4278: when claude TUI calls AskUserQuestion, chroxy's PreToolUse
    // hook emits user_question and stashes the toolUseId here. The
    // dashboard's QuestionPrompt UI eventually sends a
    // `user_question_response` which routes to respondToQuestion() —
    // that method writes the chosen answer back to the PTY (claude's
    // own TTY-style prompt is waiting on stdin).
    //
    // #4668 (Map refactor): when claude TUI emits parallel AskUserQuestion
    // tool_use blocks in one assistant turn (which it has been observed to
    // do post-#4648 deny), the single-field `_pendingUserAnswer` was
    // overwritten by each new tool_use — so the user's answer to question
    // 1 got routed to question 4's slot. Map keyed by toolUseId preserves
    // every pending answer independently; respondToQuestion(toolUseId, …)
    // routes the dashboard's answer to the right entry. Back-compat getter
    // `_pendingUserAnswer` returns the most-recently-set entry so legacy
    // tests + callers that read the single field keep working.
    this._pendingUserAnswers = new Map()
    this._lastPendingAnswerToolUseId = null
    // #4604: watchdog timer armed in respondToQuestion(). If PostToolUse
    // never arrives after we write the answer (multi-question form wedge),
    // _onAskUserQuestionStall clears busy state + emits an error so the
    // session is recoverable. Cleared on PostToolUse + destroy().
    this._askUserQuestionWatchdog = null
    // #4884: forensic timing for the defensive trailing '\r' added in
    // #4867 / #4886 — record the wall-clock at which Submit-'1' is written
    // to the PTY for each multi-question form, keyed by toolUseId. On the
    // matching PostToolUse we log the delta at INFO so live mixed-form
    // submissions generate evidence that the trailing '\r' (which lands
    // ~1ms after Submit-'1' on the mixed path) is harmless. Map (not
    // single field) to mirror _pendingUserAnswers — parallel AskUserQuestion
    // tool_use blocks in one turn each get an independent submit-time entry.
    // Entries are pruned when the matching PostToolUse fires OR when the
    // teardown / watchdog stall path clears the form.
    this._multiQuestionSubmitAt = new Map()
    // #4732: effective pre-first-output timeout in ms. Distinct from
    // _streamStallTimeoutMs (#4638) — that watchdog only re-arms BETWEEN
    // hook events, so a turn where claude TUI accepts the prompt write
    // but never emits ANY hook (stuck Anthropic API call, frozen dialog
    // screen) had no recoverable watchdog short of the 2h hard cap. This
    // timer arms at _armResultTimeout() time and disarms on the first
    // consumed hook event. 0 disables; non-finite, negative, or above
    // the 24h ceiling falls back to FIRST_OUTPUT_TIMEOUT_MS (90s).
    this._firstOutputTimeoutMs =
      isOperatorTimeoutInRange(firstOutputTimeoutMs, { allowZero: true, name: 'firstOutputTimeoutMs', log })
        ? firstOutputTimeoutMs
        : ClaudeTuiSession.FIRST_OUTPUT_TIMEOUT_MS
    this._firstOutputTimeout = null
    this._firstOutputArmedAt = 0
    // #4732: per-turn latch — flipped true by `_clearFirstOutputWatchdog`
    // so subsequent `_armResultTimeout` re-arms (one per consumed hook)
    // don't re-arm the first-output timer. Reset to false on each new
    // turn via `_resetFirstOutputWatchdogForTurn` (sendMessage entry path).
    this._firstOutputDisarmed = false
  }

  /**
   * Back-compat getter for the pre-#4668 single-field `_pendingUserAnswer`.
   * Returns the most-recently-set pending answer entry, or null when none
   * are pending. New code should iterate / look up `_pendingUserAnswers`
   * directly by toolUseId.
   */
  get _pendingUserAnswer() {
    if (!this._lastPendingAnswerToolUseId) return null
    return this._pendingUserAnswers.get(this._lastPendingAnswerToolUseId) || null
  }

  /**
   * Back-compat setter: writing an entry sets it in the Map keyed by its
   * toolUseId AND updates the "most recent" pointer. Pre-#4668 callers
   * that wrote `_pendingUserAnswer = { ... }` don't need to change.
   *
   * #4802: the previous null-branch behaviour (`= null` → Map.clear()) is
   * removed. Implicit clear-all at every teardown site silently wiped
   * sibling AskUserQuestion entries that still had answers in flight
   * (see `_pendingUserAnswers_clearAll` for the audit + the per-callsite
   * rationale). Writing null now throws so the regression is loud — each
   * callsite must pick `_pendingUserAnswers_clearAll()` (intentional
   * turn-level wipe with documented reason) or
   * `_clearPendingAnswerByToolUseId(tid)` (surgical, the watchdog path)
   * explicitly.
   */
  set _pendingUserAnswer(entry) {
    if (entry === null || entry === undefined) {
      throw new Error('_pendingUserAnswer = null/undefined forbidden (#4802) — use _pendingUserAnswers_clearAll() or _clearPendingAnswerByToolUseId(tid) so the destructive intent is visible at the call site')
    }
    const toolUseId = entry.toolUseId
    if (toolUseId) {
      this._pendingUserAnswers.set(toolUseId, entry)
      this._lastPendingAnswerToolUseId = toolUseId
    }
  }

  /**
   * #4802: explicit clear-all for the turn-level teardown sites that
   * unambiguously kill the PTY for the current turn (Ctrl-C via
   * `_teardownTurn` / `interrupt()`, or SIGTERM via `destroy()`). After
   * any of those, even a surviving Map entry can't be served — claude
   * TUI is no longer waiting on its prompt — so wiping the slot keeps
   * a late `respondToQuestion` from writing into a torn-down form.
   *
   * NOT used by `_finishTurnError` (no Ctrl-C, sibling answers may still
   * be valid for the brief race window — see audit P1.2) nor by the
   * AskUserQuestion stall watchdog (knows the exact `toolUseId` that
   * stalled, so it calls `_clearPendingAnswerByToolUseId` instead per
   * #4691).
   */
  _pendingUserAnswers_clearAll() {
    this._pendingUserAnswers.clear()
    this._lastPendingAnswerToolUseId = null
    // #4884: parallel cleanup so stale submit-timing entries don't leak
    // when a teardown path wipes the pending answers (the forensic log
    // only fires when PostToolUse arrives; if teardown won the race, the
    // submit-time entry would otherwise sit there until destroy()).
    if (this._multiQuestionSubmitAt) this._multiQuestionSubmitAt.clear()
  }

  /** Internal: drop a specific pending answer entry (PostToolUse cleanup). */
  _clearPendingAnswerByToolUseId(toolUseId) {
    if (!toolUseId) return
    this._pendingUserAnswers.delete(toolUseId)
    // #4884: parallel cleanup of the submit-timing entry for the same
    // toolUseId. Idempotent — no-op when the entry was already consumed
    // by PostToolUse's delta log.
    if (this._multiQuestionSubmitAt) this._multiQuestionSubmitAt.delete(toolUseId)
    if (this._lastPendingAnswerToolUseId === toolUseId) {
      // Advance the "most recent" pointer to whichever entry was set most
      // recently after the one we just removed (insertion-order via Map
      // iteration). null when the Map is empty.
      const keys = [...this._pendingUserAnswers.keys()]
      this._lastPendingAnswerToolUseId = keys.length > 0 ? keys[keys.length - 1] : null
    }
  }

  /**
   * #4668 cleanup: drop the askuserquestion-active sibling lock the
   * permission-hook.sh leaves under our sink dir. The hook script's
   * PostToolUse cleanup (tee | grep | rm) handles the happy path, but
   * when a turn tears down for ANY other reason (watchdog fire, stream
   * stall, hard timeout, PTY exit mid-turn, destroy()) the lock leaks
   * and blocks the next turn's AskUserQuestion at the sibling-deny
   * check. Cheap idempotent rm — call from every teardown path.
   */
  _clearAskUserQuestionLock() {
    if (!this._sinkDir) return
    try { rmSync(join(this._sinkDir, 'askuserquestion-active'), { recursive: true, force: true }) } catch {}
  }

  // Tail length to keep + length to include in error diagnostics.
  static get PTY_TAIL_BYTES() { return 4096 }
  static get PTY_TAIL_DIAGNOSTIC_BYTES() { return 1024 }

  // #4269: per-character delay when writing the prompt to the PTY.
  // claude TUI's paste detector triggers on byte-arrival rate, not DEC
  // mode 2004 — a single bulk write of ~hundreds of bytes is collapsed
  // into a "[Pasted text #1 +N lines] paste again to expand" placeholder
  // that chroxy never confirms, hanging the turn silently. Throttling to
  // ~1 ms per char makes the bytes look like typed input. A 600-char
  // prompt costs ~600 ms of one-time latency before claude starts —
  // imperceptible during interactive use.
  //
  // The loop iterates by code-point (`for (const ch of text)`), not by
  // UTF-16 code unit, so each non-BMP char (emoji, supplementary CJK)
  // is one write of a 2-code-unit string and writes its 4 UTF-8 bytes
  // in a single tick. An emoji-heavy prompt therefore arrives at ~4×
  // the byte-rate of ASCII, still well under any reasonable bulk-paste
  // threshold given the 1ms throttle. If paste-detection symptoms ever
  // surface for emoji-only prompts, decompose to UTF-8 bytes (or
  // graphemes) before the loop (#4274).
  static get PROMPT_CHAR_DELAY_MS() { return 1 }

  // #4732: default pre-first-output silence timeout (ms). Fires once at
  // turn start when claude TUI accepts the prompt write but emits no
  // hook events for this long — see _firstOutputTimeoutMs JSDoc + the
  // describe block in claude-tui-session.test.js for the why. Sized at
  // 90s: wide enough to cover slow first-token latency (cold model,
  // big context, slow Anthropic backend) but tight enough that the
  // dashboard chip surfaces within a minute or two of a real stall so
  // the user can retry without waiting for the 2h hard cap.
  static get FIRST_OUTPUT_TIMEOUT_MS() { return 90 * 1000 }

  // #4276: per-char throttling is O(N) blocking latency. For huge
  // prompts (pasted file contents, JSON dumps) the cumulative cost
  // dominates the turn — at ~1ms per code-point a 100K-char prompt
  // would block sendMessage for over a minute with no user-visible
  // progress. Above this threshold the helper falls back to a single
  // bulk `_term.write(text)`, accepting that very large prompts may
  // trip claude TUI's paste detector. That symptom (visible "Pasted
  // text" placeholder) is strictly better than a multi-minute silent
  // hang, and small/medium prompts — the typical interactive path —
  // are unaffected.
  //
  // 8192 was chosen as a generous interactive ceiling: ~8s worst case
  // even with a 1ms-floor event loop, and well above any realistic
  // hand-typed or single-paragraph prompt. Adjust if the dirty-test
  // stub (#4271) measures the actual paste-detector threshold.
  static get MAX_THROTTLED_CHARS() { return 8192 }

  // Path to the per-PID session file claude TUI maintains. The file
  // surfaces a `status` field (busy/idle/...) updated by claude itself
  // on every state transition — `claude ps` consumes the same files.
  // Polling this is the readiness signal #4040 adopted in place of the
  // prior screen-scrape, which was fundamentally fragile (the TUI's
  // input prompt is bordered + has status widgets rendered AFTER it,
  // so any "glyph at trailing edge" regex misses, and any "glyph
  // anywhere in window" regex false-positives on welcome text).
  //
  // Coupling worth flagging: claude only writes `status` when its
  // entrypoint is `cli` (the plain `claude` binary we spawn). If a
  // future refactor switches this provider to spawn via `sdk-cli` or
  // a different entrypoint, the file may exist without a `status`
  // field — `readSessionStatus` will return null forever, the probe
  // will time out on every turn, and we degrade silently to "always
  // not-ready" (the warn at the timeout site catches this at runtime).
  static sessionFilePath(pid) {
    return join(homedir(), '.claude', 'sessions', `${pid}.json`)
  }

  // Read + parse the session file. Returns the `status` string when
  // the file exists and is valid JSON with a string status; otherwise
  // returns null. Any error is swallowed (file not yet written, mid-
  // write JSON.parse failure, transient FS race) — callers re-poll.
  static readSessionStatus(filePath) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      return typeof data.status === 'string' ? data.status : null
    } catch {
      return null
    }
  }

  // Upper bounds on how long we'll wait for status=idle before falling
  // through (and writing anyway, with a warn). Spawn warmup is generous
  // because cold claude can take a few seconds on a fresh keychain
  // unlock; per-turn is short because between-turn idle->busy->idle
  // transitions are sub-second once the session is up.
  static get SPAWN_WARMUP_MAX_MS() { return 15_000 }
  static get TURN_PROMPT_WAIT_MAX_MS() { return 5_000 }
  // Wedge instrumentation (#4678 follow-up): hook-poll loop emits a
  // heartbeat log line every HOOK_HEARTBEAT_MS of silent waiting (no
  // stop-hook yet). Sized so healthy short turns (<5s end-to-end) emit
  // zero heartbeats but wedges produce a 5s-cadence trail of state.
  static get HOOK_HEARTBEAT_MS() { return 5_000 }

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
    // #4792: now that the session id exists, bind the per-instance logger
    // so subsequent log lines carry sessionId and route correctly through
    // the WsServer log fan-out (#4787). Anything that logs before this
    // point uses the module-level `log` (unscoped) and only reaches
    // unbound dashboard clients — that is the desired behaviour for
    // pre-start setup failures.
    this._log = loggerForSession('claude-tui-session', this._sessionId)

    // #4044: skipPermissions wins over port — when the user opts in to
    // unmediated TUI behaviour, the hook installation + sidecar write must
    // both be elided. Otherwise we'd run two competing permission systems
    // (chroxy's hook + claude's own --dangerously-skip-permissions flag).
    const permissionsEnabled = !!(this._port && this._hookSecret) && !this.skipPermissions
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
      // #4668 (short-term): per-session sink directory so the hook can
      // place its sibling-AskUserQuestion lockfile somewhere that's
      // automatically cleaned up by destroy()'s rmSync of this._sinkDir.
      // The hook silently no-ops the sibling-deny check when this env
      // var is absent, so removing it again later is safe. Set under
      // permissionsEnabled because the hook itself only runs in that
      // mode — outside it, claude TUI takes its own permission path and
      // none of CHROXY_* env vars are read.
      env.CHROXY_SINK_DIR = this._sinkDir
    }

    const args = [
      '--session-id', this._sessionId,
      '--settings', this._settingsPath,
    ]
    if (this.skipPermissions) {
      // #4044: bypass chroxy's hook + claude's per-tool prompt entirely.
      // Caller is expected to opt in explicitly via the session option.
      // The dashboard CreateSessionModal surface + warning copy + WS
      // protocol plumbing are tracked separately in #4208 — until then
      // this option is only reachable via direct programmatic construction.
      args.push('--dangerously-skip-permissions')
    }
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
      // don't visual-render the PTY, so the colors aren't useful. Strip
      // pattern covers CSI / OSC / SS3 / single-char terminal-mode codes
      // (#4031 — broadened to keep the readable tail clean for error
      // diagnostics and the hex dump).
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

    // Wait for the TUI to reach status=idle before returning. The prior
    // implementations (hardcoded sleep, then glyph screen-scrape across
    // #4014/#4031/#4035/#4039) all failed silently when claude's render
    // shape didn't match expectation. #4040 swaps to claude's own
    // session file — `~/.claude/sessions/<pid>.json` carries a `status`
    // field claude updates on every state transition. Atomic, kernel-
    // backed, decoupled from TUI rendering changes. On miss we still
    // proceed so a transient FS race doesn't brick the session.
    const ready = await this._waitForPrompt(ClaudeTuiSession.SPAWN_WARMUP_MAX_MS)
    if (!ready && !this._ptyExited) {
      const degraded = this._lastProbeSawStatus === false
        ? ' — session file never appeared with a `status` field; if claude was spawned via a non-cli entrypoint or upstream changed the file format, the probe has degraded and will never see ready'
        : ''
      log.warn(
        `TUI session file did not reach status=idle within ${ClaudeTuiSession.SPAWN_WARMUP_MAX_MS}ms${degraded} — proceeding (first sendMessage may stall)\n` +
        `_outputTail dump:\n${this._outputTailHexDump()}`,
      )
    }
  }

  /**
   * Resolve `true` when the TUI is ready for input (claude's per-PID
   * session file reports a status other than 'busy'), `false` on
   * timeout or PTY exit.
   *
   * Reads `~/.claude/sessions/<pty.pid>.json` — the same file
   * `claude ps` consumes. Claude TUI writes this file at startup and
   * updates `status` on every state transition: 'busy' while processing
   * a turn, 'idle' (or other non-busy variants) when waiting for input.
   *
   * Used by _spawnPty (one-time, generous timeout) and sendMessage
   * (per-turn, short timeout). Replaces the #4014/#4031/#4035 screen-
   * scrape approaches, which never had a stable signal to anchor on:
   * the input box is followed by status widgets in the trailing buffer,
   * so a trailing-edge match never fires, and a looser line-anchored
   * match false-positives on welcome text. The session file is what
   * claude itself uses for the `claude ps` state machine, so it's
   * decoupled from rendering and survives TUI redraw changes (#4040).
   */
  async _waitForPrompt(timeoutMs) {
    // No usable PTY pid — treat as not-ready and fall through to the
    // existing warn-and-write path. Returning true here would silently
    // disable readiness gating on any platform/runtime where node-pty
    // doesn't populate `pid` (Copilot review on #4040). Tests that
    // explicitly want to skip the probe stub `_waitForPrompt` directly
    // rather than rely on this guard.
    //
    // Wedge instrumentation (#4678 follow-up): record elapsedMs +
    // sawStatus + result on every exit path. The wedge symptom is
    // `stream_start` then silence — without this log we cannot tell
    // whether the call returned promptly (write stage stalled) or
    // burned its 5s timeout (probe degraded). Routes via `_activeTurn`
    // so the line is sourced from the same turn the caller is logging.
    const startMs = Date.now()
    const finish = (ready) => {
      const elapsedMs = Date.now() - startMs
      if (this._activeTurn) {
        this._activeTurn.waitForPromptMs = elapsedMs
        this._activeTurn.waitForPromptReady = ready
        this._activeTurn.waitForPromptSawStatus = this._lastProbeSawStatus
      }
      log.info(`waitForPrompt (msg=${this._activeTurn?.messageId ?? 'none'} elapsedMs=${elapsedMs} sawStatus=${this._lastProbeSawStatus} ready=${ready})`)
      return ready
    }
    const pid = this._term && this._term.pid
    if (!Number.isInteger(pid) || pid <= 0) {
      this._lastProbeSawStatus = false
      return finish(false)
    }
    const sessFile = ClaudeTuiSession.sessionFilePath(pid)
    // Track whether we ever read a non-null status. Distinguishes
    // "claude wrote status but never reached idle" (real busy/stuck)
    // from "status field never appeared" (probe degraded — see the
    // entrypoint:cli note on sessionFilePath). The warn sites read
    // `_lastProbeSawStatus` to surface the difference in logs.
    let sawStatus = false
    const checkReady = () => {
      const status = ClaudeTuiSession.readSessionStatus(sessFile)
      if (status !== null) sawStatus = true
      return status !== null && status !== 'busy'
    }
    while (Date.now() - startMs < timeoutMs) {
      if (this._ptyExited) {
        this._lastProbeSawStatus = sawStatus
        return finish(false)
      }
      if (checkReady()) {
        this._lastProbeSawStatus = sawStatus
        return finish(true)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    const ready = checkReady()
    this._lastProbeSawStatus = sawStatus
    return finish(ready)
  }

  /**
   * Dump the trailing bytes of the UNSTRIPPED PTY tail as a hex+ASCII
   * block for a log line (#4031). Called on readiness timeout or any
   * other diagnostic surface where seeing what claude actually wrote —
   * including escape/control sequences — saves a debugging round-trip.
   * Public-ish (single underscore) so tests can assert on the format
   * without re-implementing it.
   *
   * Sourced from `_outputTailRaw` rather than the ANSI-stripped tail so
   * 0x1b / OSC / SS3 bytes land in the log; the stripped variant would
   * hide the very bytes the diagnostic exists to surface (#4031 review).
   */
  _outputTailHexDump() {
    // Cap at PTY_TAIL_DIAGNOSTIC_BYTES so logs stay bounded while still
    // showing enough context to identify a TUI-rendered error inline.
    // The raw (un-stripped) buffer is used so escape/control bytes
    // survive into the diagnostic — sourcing from the stripped tail
    // would hide the very bytes we want to see (#4031 review).
    return formatHexDump(this._outputTailRaw, ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES)
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
    // Wedge instrumentation (#4678 follow-up): entry log for grep'ing
    // every turn from chroxy.log. Per-stage timings + completion get
    // accumulated on _activeTurn and emitted in the summary line at
    // turn finish (success or error). Together they let us reconstruct
    // where the wedge actually sits without re-instrumenting the file.
    // #4792: prefer the session-bound logger so the entry routes to the
    // correct bound dashboard client. Falls back to module-level `log`
    // only if start() hasn't run (defensive — sendMessage on an unstarted
    // session is a misuse, but the fallback keeps the diagnostic alive).
    ;(this._log || log).info(`sendMessage start (msg=${messageId} sessionId=${this._sessionId} bytes=${Buffer.byteLength(prompt || '', 'utf8')} attachments=${attachments?.length || 0})`)

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
        const suffixResult = buildAttachmentsPromptSuffix(files)
        if (suffixResult.suffix) {
          promptToSend = (prompt || '') + suffixResult.suffix
          log.info(`TUI attachments materialized (msg=${messageId} count=${files.length} dir=${this._activeTurn.attachmentsDir})`)
          // #4026: cap-firing diagnostic. The whole point of
          // MAX_ATTACHMENT_SUFFIX_BYTES is to catch pathological path-
          // generation regressions (deterministic hashes, deeper base
          // dirs) before users hit the PTY's silent ~4KB truncation —
          // a quiet truncation here defeats the cap's purpose. Two
          // distinct warn lines so ops can grep for either degradation:
          //   - regular truncation: some files dropped from the list
          //   - bareFallback: even one entry exceeded the cap (worst)
          // #4792: same session-scoped logger fallback as sendMessage start.
          const slog = this._log || log
          if (suffixResult.bareFallback) {
            slog.warn(`TUI attachment suffix bare-fallback fired (msg=${messageId} count=${files.length} cap=${suffixResult.cap}B) — all file paths omitted from prompt suffix; agent will only see the size-cap marker. Pathological path-generation regression?`)
          } else if (suffixResult.truncated) {
            slog.warn(`TUI attachment suffix truncated (msg=${messageId} suffixBytes=${suffixResult.byteLength} cap=${suffixResult.cap}B omitted=${suffixResult.omitted} of=${files.length})`)
          }
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

    // #4014/#4040: wait for the TUI to report status=idle before writing.
    // Between turns the TUI flips back to idle after the Stop hook fires
    // (it must — claude updates its own session file on every transition,
    // and `claude ps` relies on the same field). If our bytes arrive
    // mid-busy the keystrokes get dropped or queued behind the in-flight
    // turn. On the first turn this also catches the case where
    // _spawnPty's warmup window expired before claude wrote idle. We
    // still write if the probe misses — a transient FS race shouldn't
    // refuse to deliver the prompt.
    const ready = await this._waitForPrompt(ClaudeTuiSession.TURN_PROMPT_WAIT_MAX_MS)
    if (!ready && !this._ptyExited) {
      const degraded = this._lastProbeSawStatus === false
        ? ' — and the probe has never seen a `status` field this session, suggesting a degraded probe (see sessionFilePath docs)'
        : ''
      log.warn(
        `TUI session file not at status=idle before turn (msg=${messageId})${degraded} — writing anyway\n` +
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

    // #4732: reset the per-turn pre-first-output watchdog latch so the
    // upcoming `_armResultTimeout` call arms a fresh first-output timer
    // for this turn (the latch was set true when the PREVIOUS turn
    // consumed its first hook). Must happen BEFORE `_armResultTimeout`
    // below — that helper checks the latch.
    this._resetFirstOutputWatchdogForTurn()

    try {
      // #4269: claude TUI's paste detector triggers on byte-arrival rate,
      // not DEC mode 2004 — a single bulk write of the whole prompt is
      // collapsed into "[Pasted text #1 +N lines] paste again to expand"
      // and chroxy never confirms, hanging the turn silently. The
      // shared _writePtyTextThrottled() helper writes the text one char
      // at a time with PROMPT_CHAR_DELAY_MS between each so the bytes
      // look like typed input. The bracketed-paste-disable / re-enable
      // wrap is kept as defense-in-depth for any claude version that
      // DOES honor mode 2004; the throttle is what actually fixes the
      // bug. Same helper also serves respondToQuestion() (#4278).
      const completed = await this._writePtyTextThrottled(promptToSend, {
        onAbort: () => this._finishTurnError('Turn aborted during prompt write', messageId),
      })
      if (!completed) return
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
    // Wedge instrumentation (#4678 follow-up): track loop progress so
    // a wedge that manifests as "stuck waiting for stop-hook" produces
    // a heartbeat log every HOOK_HEARTBEAT_MS — without this we cannot
    // tell whether the loop is iterating but the sink dir stays empty,
    // or whether the loop itself has stopped iterating.
    let pollIters = 0
    let lastHeartbeatMs = pollStart
    const consumedAtStart = this._consumedFiles.size

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
        // #4732: a consumed hook file = first output observed for this
        // turn. Disarm the pre-first-output watchdog BEFORE the
        // re-arm below — `_armResultTimeout` would otherwise re-arm
        // it, defeating the disarm and giving the watchdog a fresh
        // window after every hook. The inter-stream `_streamStallTimeout`
        // continues to re-arm on each consumed event as before.
        this._clearFirstOutputWatchdog()
        this._armResultTimeout()
      }
    }

    while (Date.now() - pollStart < HOOK_TIMEOUT_MS) {
      if (this._activeTurn?.aborted) break
      if (this._ptyExited) break
      // _handleHardTimeout clears _isBusy; bail out cleanly if it fired.
      if (!this._isBusy) break
      drainHookFiles()
      pollIters++
      // Wedge instrumentation (#4678 follow-up): if the loop has been
      // running >= HOOK_HEARTBEAT_MS since the last heartbeat with no
      // stop-hook, emit a progress line. Sized at 5s so a healthy
      // ~2-5s tool turn emits zero heartbeats while a wedge gets
      // logged every 5s with sink-dir state.
      const now = Date.now()
      if (now - lastHeartbeatMs >= ClaudeTuiSession.HOOK_HEARTBEAT_MS) {
        lastHeartbeatMs = now
        let sinkFileCount = 0
        try { sinkFileCount = readdirSync(this._sinkDir).length } catch {}
        log.info(`hookPoll heartbeat (msg=${messageId} iters=${pollIters} elapsedMs=${now - pollStart} sinkFiles=${sinkFileCount} consumed=${this._consumedFiles.size - consumedAtStart} stopFound=${stopPayload ? 'yes' : 'no'})`)
      }
      if (stopPayload) break
      await new Promise((r) => setTimeout(r, 150))
    }
    // Wedge instrumentation (#4678 follow-up): always log the loop's
    // exit shape — whether it broke on stopPayload, abort, ptyExited,
    // !isBusy, or timeout. Pair with sendMessage's final summary to
    // reconstruct the wedge stage post-hoc.
    log.info(`hookPoll exit (msg=${messageId} iters=${pollIters} elapsedMs=${Date.now() - pollStart} consumed=${this._consumedFiles.size - consumedAtStart} stopFound=${stopPayload ? 'yes' : 'no'} aborted=${this._activeTurn?.aborted ? 'yes' : 'no'} ptyExited=${this._ptyExited ? 'yes' : 'no'} stillBusy=${this._isBusy ? 'yes' : 'no'})`)

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

    // #4628: sweep any tool_starts whose PostToolUse hook never fired
    // BEFORE emitting result. _emitResult does this in one step. The
    // sweep ensures the synthetic tool_result is broadcast first, so
    // the dashboard's activeTools clears as part of the same turn-end
    // burst rather than zombifying until next chroxy restart.
    this._emitResult({
      // #4072: `cost: null` (not 0) is the chroxy convention for
      // "subscription-billed provider, cost not measured". The session-
      // manager `_trackCost`/`_trackUsage` gate is
      // `typeof data.cost === 'number'`, so null skips the cumulative
      // accumulator and keeps `cumulativeUsage` at zero — that's the
      // signal the dashboard / app uses to suppress the cost badge.
      cost: null,                    // not exposed by Stop hook in MVP
      duration,
      usage: null,                   // not exposed by Stop hook in MVP
      sessionId: this._sessionId,
    }, 'stop_hook_fired_without_post_hook')

    // Wedge instrumentation (#4678 follow-up): summary log on success
    // path, matching the one _finishTurnError emits on error paths so
    // every turn lands one grep-able line regardless of outcome.
    this._logSendMessageSummary('success')
    // Clear inactivity timers — turn done, nothing to backstop (#3920, #4638, #4732).
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    // #4732: clear the pre-first-output watchdog. By the success path we
    // already saw at least one hook (the Stop hook), so it should be
    // disarmed via _clearFirstOutputWatchdog already — but the same
    // belt-and-braces clear the other timers get above also applies here
    // so a freak ordering can't leak a live handle past turn-end.
    this._clearFirstOutputWatchdog()
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
   * Write a string to the PTY one character at a time with
   * PROMPT_CHAR_DELAY_MS between each, wrapped in bracketed-paste-disable
   * / re-enable so claude TUI's paste detector accepts it as typed input
   * (#4269). Returns true on completion, false if `_activeTurn.aborted`
   * or `_ptyExited` (#4275) tripped mid-write — in either case `onAbort`
   * was called.
   *
   * Used by both sendMessage's prompt write and respondToQuestion's
   * answer write (#4278). The control sequences (\x1b[?2004l/h, \r) are
   * single writes — only the visible text is throttled, since that's
   * what claude's heuristic measures.
   *
   * Above MAX_THROTTLED_CHARS the helper switches to a single bulk
   * `_term.write(text)` (#4276). Per-char throttling is O(N) blocking
   * latency and unbounded for huge prompts (e.g. pasted file contents)
   * — the bulk path may trip claude's paste detector but that's
   * preferable to multi-minute silent hangs.
   *
   * Multi-line input (any embedded `\n`) takes a separate fast-path
   * (#4678): the body is normalised, wrapped in CSI bracketed-paste
   * markers, and delivered as a single atomic write — see the inline
   * comment in the function body for the why.
   *
   * @param {string} text — the text to write (no trailing CR; \r appended)
   * @param {object} [opts]
   * @param {() => void} [opts.onAbort] — called if abort tripped; caller
   *   typically uses this to surface a turn-level error.
   * @returns {Promise<boolean>} true if completed, false if aborted.
   */
  async _writePtyTextThrottled(text, { onAbort } = {}) {
    // Wedge instrumentation (#4678 follow-up): track which path the
    // write took, the byte/code-point count, and elapsed ms. The wedge
    // symptom (`stream_start` then silence) is consistent with this
    // function never returning OR returning but the bytes never being
    // consumed by claude TUI. The log line at finish() distinguishes
    // the two — if the line never appears in the log, the wedge is in
    // here; if it appears with completed=true, the wedge is downstream
    // (hook poll loop, or claude TUI itself).
    const writeStartMs = Date.now()
    const codePointCount = [...text].length
    const byteLength = Buffer.byteLength(text, 'utf8')
    const finish = (path, completed) => {
      const elapsedMs = Date.now() - writeStartMs
      if (this._activeTurn) {
        this._activeTurn.writePath = path
        this._activeTurn.writeMs = elapsedMs
        this._activeTurn.writeBytes = byteLength
        this._activeTurn.writeCompleted = completed
      }
      log.info(`writePtyText (msg=${this._activeTurn?.messageId ?? 'none'} path=${path} codePoints=${codePointCount} bytes=${byteLength} elapsedMs=${elapsedMs} completed=${completed})`)
      return completed
    }
    // #4678: multi-line prompts (from Shift+Enter in the dashboard
    // composer) need to be delivered as a single bracketed paste —
    // claude TUI v2.1.x treats raw \n in the input box as "insert
    // newline in multi-line composition" with no way to break out via
    // a subsequent \r (the bare \r is also interpreted as a newline
    // when the cursor is in a multi-line composition). Wrapping the
    // content in CSI bracketed-paste markers (\x1b[200~ ... \x1b[201~)
    // tells claude TUI the content was pasted; on receipt of the close
    // marker the input is ready to submit and the trailing \r fires.
    //
    // Single-line content keeps the per-char throttled write — the
    // #4269 throttle exists to defeat claude TUI's heuristic paste
    // detector when the input is typed input (not a real paste). For
    // genuine paste we use the explicit markers and rely on claude TUI
    // honouring DEC mode 2004 for those bytes.
    const hasNewlines = /\r?\n/.test(text)
    if (hasNewlines) {
      // Normalise CRLF → LF so the pasted body contains a single line
      // break per logical newline. Trailing newlines are dropped so
      // the close marker lands at the end of the visible content
      // rather than after an empty trailing line. Embedded paste-end
      // markers (`\x1b[201~`) are stripped from the body — leaving
      // them intact would let attacker-controlled content (an MCP tool
      // result echoed into a follow-up prompt, an evaluator rewrite,
      // any future content-injection path) terminate the bracketed
      // paste early and land the suffix as typed input in claude TUI.
      // Defense-in-depth; the typing-user case is zero-risk today.
      // Order matters: strip embedded \x1b[201~ markers BEFORE the
      // trailing-newline strip. Removing markers can expose trailing
      // newlines that were hidden by them — e.g. "\n\x1b[201~\n" needs
      // to become "" (empty body → abort), not "\n" (a degenerate
      // one-newline paste). Doing trailing-strip first would keep the
      // newline that the marker was masking.
      const body = text
        .replace(/\r\n/g, '\n')
        .replace(/\x1b\[201~/g, '')
        .replace(/\n+$/, '')
      if (this._activeTurn?.aborted || this._ptyExited) {
        onAbort?.()
        return finish('paste-abort', false)
      }
      // After stripping, an all-whitespace or all-control-bytes prompt
      // can collapse to an empty body. Sending the degenerate
      // `\x1b[200~\x1b[201~\r` produces a CR-on-empty-input — at best
      // a no-op, at worst behaviour the TUI doesn't expect. Drop the
      // turn cleanly via the abort path so the caller sees a finished
      // turn (no message ever leaves chroxy) rather than chroxy
      // claiming to have sent and then waiting forever for a reply.
      if (body.length === 0) {
        onAbort?.()
        return finish('paste-empty', false)
      }
      this._term.write('\x1b[200~' + body + '\x1b[201~\r')
      return finish('paste', true)
    }

    // #4805: single-line throttled path used to feed `freeformText`
    // verbatim into _term.write — no defense against C0 control bytes
    // or ANSI escape sequences embedded in the input. The newline
    // bracketed-paste branch above (#4678) already strips embedded
    // `\x1b[201~` markers and explicitly cites attacker-controlled MCP
    // tool results as the threat model; the single-line branch has the
    // same input shape and applies the parallel defense.
    //
    // Stripped (in this order, since the first match wins):
    //   - ANSI CSI: ESC [ <params 0x30-0x3f> <intermediates 0x20-0x2f>
    //     <final 0x40-0x7e> — the full ECMA-48 grammar including
    //     DEC-private sequences `?`/`<`/`=`/`>`/`:` (W2 #4805)
    //   - String controls: ESC ] / P / X / ^ / _ <payload> (BEL | ESC \)
    //     — covers OSC (title-set), DCS (sixel/ReGIS/termcap),
    //     SOS / PM / APC (W2 #4805 — original regex covered OSC only)
    //   - Stray two-byte ESC + final-byte sequences: RIS `\x1b c`,
    //     DECSC/DECRC `\x1b 7`/`8`, IND/RI/NEL/HTS `\x1b D`/`M`/`E`/`H`,
    //     keypad-mode `\x1b =`/`>` — `\x1b.?` catch-all (W2 #4805)
    //   - C0 control bytes \x00-\x08 + \x0b-\x1f + \x7f — the range
    //     now includes \x1b so any unmatched lone ESC is stripped
    //     (W2 #4805 closed the 0x1b char-class gap). Excludes \t (a
    //     normal printable whitespace a user may paste); \r/\n never
    //     reach this path (the multi-line branch handles them).
    // Note: the sequence-matching alternations come BEFORE the
    // C0 class so a full escape is matched as one unit. If the
    // lone-byte class came first the regex would peel off the \x1b
    // introducer and leave the [<final> bytes as printable garbage.
    // Known damage paths covered:
    //   - \x03 (Ctrl-C) aborts the active TUI form
    //   - OSC \x1b]0;...\x07 rewrites the window title on some hosts
    //   - DEC-private CSI (\x1b[?25l hide-cursor, \x1b[?1049h alt-
    //     screen, \x1b[?1000h / \x1b[?1006h mouse-tracking) desync
    //     the TUI input state machine — the recurring wedge symptom
    //     class
    //   - RIS \x1b c full-terminal-reset clears the scrollback
    //   - APC payloads (iTerm2 proprietary commands)
    const stripped = []
    text = text.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|\x1b.?|[\x00-\x08\x0b-\x1f\x7f]/g,
      (match) => {
        stripped.push(match)
        return ''
      },
    )
    if (stripped.length > 0) {
      // Bounded hex preview (first 32 stripped bytes total) gives an
      // incident-response footprint without blowing the log on a
      // malicious flood. Sequences are concatenated then truncated so
      // each warn line carries the same payload shape regardless of
      // how many distinct sequences were stripped.
      const totalBytes = stripped.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0)
      const sampleHex = Buffer.from(stripped.join(''), 'utf8').slice(0, 32).toString('hex')
      const truncated = totalBytes > 32 ? ',…' : ''
      log.warn(`writePtyText (msg=${this._activeTurn?.messageId ?? 'none'}) stripped ${totalBytes} control/escape bytes from single-line input (sample=${sampleHex}${truncated}) (#4805)`)
    }
    // After stripping, an all-control-byte prompt can collapse to an
    // empty body. Mirror the multi-line branch's `body.length === 0`
    // guard (:1358): abort the turn cleanly rather than write a bare
    // \r submit to the TUI — the caller sees a finished turn (no
    // message ever leaves chroxy) instead of chroxy claiming to have
    // sent and waiting forever for a reply.
    if (text.length === 0) {
      onAbort?.()
      return finish('throttled-empty', false)
    }
    // Re-compute counts now that the body may have shrunk so the bulk-
    // path threshold check + finish() bookkeeping stay accurate.
    const sanitizedCodePointCount = [...text].length

    this._term.write('\x1b[?2004l')
    try {
      // #4276: huge prompts bypass the throttle. Code-point count
      // (counted once at function entry) keeps the threshold
      // consistent with how the loop iterates — an emoji-only 5000-
      // char string [...].length is 5000, not 10000.
      if (sanitizedCodePointCount > ClaudeTuiSession.MAX_THROTTLED_CHARS) {
        // Re-check the turn lifecycle exactly once before the bulk
        // write — same shape as the loop's per-iter guards, so a
        // caller that aborted between scheduling and execution doesn't
        // flood a torn-down PTY with a huge payload.
        if (this._activeTurn?.aborted || this._ptyExited) {
          onAbort?.()
          return finish('bulk-abort', false)
        }
        this._term.write(text)
        this._term.write('\r')
        return finish('bulk', true)
      }
      for (const ch of text) {
        // #4275: re-check _ptyExited inside the loop, mirroring the
        // pre-write guard in sendMessage. A long prompt + a mid-write
        // PTY crash previously relied on the next _term.write throwing
        // to bubble up — correct but not the explicit-state-machine
        // pattern the rest of this file uses.
        if (this._activeTurn?.aborted || this._ptyExited) {
          onAbort?.()
          return finish('throttled-abort', false)
        }
        this._term.write(ch)
        if (ClaudeTuiSession.PROMPT_CHAR_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, ClaudeTuiSession.PROMPT_CHAR_DELAY_MS))
        }
      }
      this._term.write('\r')
      return finish('throttled', true)
    } finally {
      // Always restore bracketed-paste mode, even on abort/throw. Write may
      // throw if PTY has exited mid-loop (#4287) — swallow so we don't mask
      // the original error path.
      try { this._term.write('\x1b[?2004h') } catch {}
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
      // #4307: stash the command text so the matching PostToolUse can
      // record the resulting shellId with the original command. Same
      // behaviour as sdk-session.js _handleToolUseBlock — keeps TUI
      // parity for the dashboard "waiting on …" chip.
      if (isRunInBackgroundInput(toolName, payload.tool_input)) {
        const cmd = typeof payload.tool_input?.command === 'string'
          ? payload.tool_input.command : ''
        this._pendingBackgroundCommands.set(toolUseId, cmd)
      }
      // #4307: a BashOutput call means the agent has acknowledged the
      // backgrounded shell. Clear the pending entry so the session is
      // no longer reported as waiting (the agent saw the output or is
      // about to act on it — either way our pending model is stale).
      const bashOutputShellId = parseBashOutputShellId(toolName, payload.tool_input)
      if (bashOutputShellId) {
        this.clearBackgroundShell(bashOutputShellId)
      }
      this.emit('tool_start', {
        messageId: toolUseId,
        toolUseId,
        tool: toolName,
        input: payload.tool_input ?? null,
      })
      // #4628: track this tool_start so _emitResult can sweep it on
      // turn-end if the matching PostToolUse hook is never written
      // (the upstream failure mode observed in #4628).
      this._trackToolStart(toolUseId, toolName)
      // #4278: AskUserQuestion in TUI sessions previously had no special
      // path — the tool_use bubble appeared in the chat with no
      // interactive way to answer, and claude sat on its own TTY-style
      // prompt waiting for stdin until the inactivity hard timeout. Now
      // we ALSO emit user_question (same shape sdk-session emits) so
      // the dashboard renders its QuestionPrompt UI. The user's answer
      // arrives via respondToQuestion() which writes it back to the PTY.
      //
      // tool_start above still fires so the existing tool-pairing path
      // works once PostToolUse arrives — we accept the duplicate display
      // (collapsed bubble + standalone QuestionPrompt) as MVP; #4279
      // makes the bubble usefully expandable so this is acceptable.
      if (toolName === 'AskUserQuestion') {
        const questions = (payload.tool_input && Array.isArray(payload.tool_input.questions))
          ? payload.tool_input.questions
          : []
        // #4290 / #4604 Chunk B: stash the FULL questions array (not just
        // q[0].options) so respondToQuestion can drive multi-question
        // forms keystroke-by-keystroke. `options` is kept on the entry
        // for back-compat with pre-Chunk-B tests/callers that read
        // `_pendingUserAnswer.options` directly — it always points at
        // questions[0].options (the only question the single-q happy
        // path drives).
        const options = (questions[0] && Array.isArray(questions[0].options))
          ? questions[0].options
          : []
        this._pendingUserAnswer = { toolUseId, questions, options }
        // #4604: surface the AskUserQuestion shape in chroxy.log so the
        // multi-question wedge condition is greppable. The bug was
        // diagnosed via /tmp/.../pre-*.json spelunking — never again.
        const questionCount = questions.length
        // #4828: session-scoped — runs strictly post-start when `this._log`
        // is cached. Falls back to module-level `log` only defensively.
        ;(this._log || log).info(`AskUserQuestion pending: tool=${toolUseId} questions=${questionCount} options.q1=${options.length}`)
        if (questionCount > 1) {
          // #4604 Chunk B note: kept the historical "not yet supported"
          // wording so existing test guards (regex on this string) keep
          // matching. The driver IS now multi-question-aware — what's
          // still unsupported is the dashboard sending an answersMap
          // covering all N questions on every client build. The
          // back-compat default-to-option-1 fallback in respondToQuestion
          // means even old dashboards no longer wedge the session, just
          // pick defaults the user can re-prompt past.
          // #4828: session-scoped.
          ;(this._log || log).warn(`AskUserQuestion has ${questionCount} questions — multi-question forms are not yet supported (see #4604). Only question 1 will be answered.`)
          // #4653: surface the deny to the user. The bash permission-hook
          // returns `permissionDecision: deny` for this exact payload
          // shape (questions.length > 1), so this server-side mirror
          // event reports the same decision through the WS wire. Without
          // it, the deny is invisible — the user wonders if the model is
          // being clever (asking one at a time naturally) or if chroxy
          // intervened. Per-toolUseId so the dashboard can dedup repeats
          // when claude TUI re-emits the same multi-q payload (a known
          // failure mode pre-#4668).
          this.emit('multi_question_intervention', {
            toolUseId,
            questionCount,
            reason: 'multi_question',
            timestamp: Date.now(),
          })
        }
        this.emit('user_question', { toolUseId, questions })
      }
      return
    }

    // #4278 (PostToolUse half): claude resolved its own AskUserQuestion
    // prompt — either via the answer chroxy wrote in respondToQuestion()
    // or via the underlying terminal multiplexer if a human typed into
    // the same PTY. Either way, clear the pending state so the next
    // user_question_response doesn't write into a stale context.
    //
    // #4668: clear only THIS specific tool_use's entry from the pending
    // Map, not every entry. Pre-#4668 chroxy used a single field so
    // clearing was all-or-nothing; with the Map there may be sibling
    // pending answers from other tool_uses in the same turn that
    // shouldn't be wiped when this one completes.
    //
    // #4689: clear by the resolved local `toolUseId`, not by raw
    // `payload.tool_use_id`. When the hook payload omits `tool_use_id`
    // (older claude builds, certain MCP tools), `_emitToolHookEvent`
    // synthesizes a stable id at line ~1340 and the PreToolUse branch
    // above stores the pending entry under THAT synthesized id. Gating
    // cleanup on `payload.tool_use_id` would skip the clear for those
    // builds and leak Map entries indefinitely.
    // #4884: forensic timing for the defensive trailing '\r' (#4867 / #4886).
    // If this PostToolUse matches a multi-question form we just drove,
    // log the wall-clock from Submit-'1' write to PostToolUse arrival at
    // INFO. The trailing '\r' is sent ~1ms after Submit-'1' (per-char
    // throttle), so any "spurious empty-prompt activity" theory shows up
    // as an outlier-large delta. After ~10 captured submissions show
    // clean numbers, this log line can be downgraded to DEBUG. MUST run
    // before _clearPendingAnswerByToolUseId below — that helper also
    // clears _multiQuestionSubmitAt in lockstep with _pendingUserAnswers,
    // so the timestamp would be gone by the time we read it.
    if (toolName === 'AskUserQuestion' && toolUseId && this._multiQuestionSubmitAt.has(toolUseId)) {
      const submitAt = this._multiQuestionSubmitAt.get(toolUseId)
      this._multiQuestionSubmitAt.delete(toolUseId)
      const deltaMs = Date.now() - submitAt
      ;(this._log || log).info(`AskUserQuestion multi-question: Submit→PostToolUse=${deltaMs}ms (tool=${toolUseId}) — forensic for #4884 trailing-'\\r' verification`)
    }
    if (toolName === 'AskUserQuestion' && toolUseId) {
      this._clearPendingAnswerByToolUseId(toolUseId)
    }
    // #4669 cleanup: drop the askuserquestion-active sibling lock for THIS
    // tool_use's PostToolUse (the original PostToolUse hook in
    // writeHookSettings() does this via tee/grep/rm — duplicated here for
    // the defensive path where the hook script's cleanup didn't run, e.g.
    // when claude TUI emitted PostToolUse but the hook chain raced with
    // turn teardown). Cheap idempotent rm via the canonical helper so
    // teardown/cleanup behaviour stays consistent (#4692).
    if (toolName === 'AskUserQuestion') {
      this._clearAskUserQuestionLock()
    }
    // #4604: PostToolUse means claude accepted the answer (single-question
    // happy path). Cancel the stall watchdog so it doesn't fire a spurious
    // ASK_USER_QUESTION_STALL error 30s later.
    if (toolName === 'AskUserQuestion' && this._askUserQuestionWatchdog) {
      clearTimeout(this._askUserQuestionWatchdog)
      this._askUserQuestionWatchdog = null
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
    // #4628: matching tool_start resolved — drop from the in-flight map
    // so _emitResult's sweep doesn't double-emit a synthetic for it.
    this._trackToolResult(toolUseId)

    // #4307: scan PostToolUse output for the canonical "Command running
    // in background with ID: <id>" pattern. The PostToolUse hook
    // payload runs through stringify above, so the same regex SDK uses
    // matches against the resulting JSON (the shellId pattern is
    // unique enough that a false positive on stringified-quoted text
    // is improbable). Pull the command stashed at PreToolUse so the
    // pending-shell entry carries it. Note we parse from the
    // post-truncation text intentionally: the canonical message is
    // ~60 chars and lands at the FRONT of the response, so truncation
    // never strips it (and if it ever did we'd accept that — the
    // result event already carries truncated=true, the dashboard chip
    // would just lack the command).
    const shellId = parseBackgroundShellId(result)
    if (shellId) {
      const command = this._pendingBackgroundCommands.get(toolUseId) || ''
      this._pendingBackgroundCommands.delete(toolUseId)
      // #5177: capture the output file path so the completion sweep can reap
      // the shell on quiescence without an explicit BashOutput poll.
      const outputPath = parseBackgroundShellOutputPath(result)
      this.trackBackgroundShell({ shellId, command, outputPath })
    }
  }

  /**
   * Wedge instrumentation (#4678 follow-up): one-line per-turn summary
   * with all the per-stage timings accumulated on _activeTurn during
   * sendMessage. Called from both the success path and _finishTurnError
   * so every turn ends with the same grep-able shape regardless of
   * outcome. Reads from _activeTurn; safe to call when it is null.
   */
  _logSendMessageSummary(reason) {
    const turn = this._activeTurn
    if (!turn) {
      log.info(`sendMessage done (msg=none reason=${reason})`)
      return
    }
    const duration = Date.now() - turn.startedAt
    log.info(`sendMessage done (msg=${turn.messageId} reason=${reason} duration=${duration}` +
      ` waitForPromptMs=${turn.waitForPromptMs ?? 'n/a'} ready=${turn.waitForPromptReady ?? 'n/a'} sawStatus=${turn.waitForPromptSawStatus ?? 'n/a'}` +
      ` writePath=${turn.writePath ?? 'n/a'} writeMs=${turn.writeMs ?? 'n/a'} writeBytes=${turn.writeBytes ?? 'n/a'} writeCompleted=${turn.writeCompleted ?? 'n/a'})`)
  }

  /**
   * #4642: observability-only invariant check. Every `sendMessage` sets
   * `_isBusy=true` AND `_currentMessageId` together (lines 848/851), and
   * every teardown path clears them together. If a teardown site ever
   * observes `_isBusy=true` with `_currentMessageId=null`, the session
   * is in a state the construction contract forbids — the `if(messageId)`
   * guards in `_finishTurnError`, `_handleHardTimeout`,
   * `_handleStreamStall`, and `_onAskUserQuestionStall` would silently
   * skip `stream_end`, recreating the wedge mode #4638 fixed.
   *
   * Cheap (one warn line on violation, no-op otherwise) defensive
   * instrumentation so a future regression that breaks the invariant
   * surfaces in logs rather than as a wedge only triageable from
   * screenshots. Callsite tag is grep-able so an operator can identify
   * which teardown path observed the corruption.
   */
  _assertBusyHasMessageId(callsite) {
    if (this._isBusy && !this._currentMessageId) {
      log.warn(
        `[invariant violation] ${callsite}: _isBusy=true but _currentMessageId=null — ` +
        `construction contract requires both set together (sendMessage) or both cleared together (teardown). ` +
        `Silently skipping stream_end here would recreate the #4638 wedge.`,
      )
    }
  }

  _finishTurnError(message, callerMessageId) {
    this._assertBusyHasMessageId('_finishTurnError')
    this._logSendMessageSummary('error')
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    // #4638: clear the stream-stall watchdog so a turn that fails or
    // aborts before the stall window doesn't fire a stale stream_stall
    // error into the dashboard mid-recovery.
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    // #4732: clear the pre-first-output watchdog for the same reason —
    // an aborted/failed turn must not surface a stale first-output stall
    // into the dashboard mid-recovery.
    this._clearFirstOutputWatchdog()
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
    // #4072: subscription-billed → cost: null so SessionManager skips
    // accumulation. See companion sites above.
    // #4628: sweep orphan tool_starts before result so the dashboard's
    // activeTools clears as part of the same error burst.
    this._emitResult(
      { cost: null, duration, usage: null, sessionId: this._sessionId },
      'turn_finished_with_error',
    )
    // #4022: drop the per-turn attachment dir on every failure path so
    // a stalled/aborted/PTY-exited turn doesn't leak the materialized
    // files until destroy(). No-op when the turn had no attachments.
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    // #4286 / #4802: deliberately do NOT call
    // `_pendingUserAnswers_clearAll()` here. The original #4286 fix
    // wiped the single-field slot to keep late user_question_response
    // events from writing into a dead turn — but post-#4668 the field is
    // a Map, and the audit (P1.2 #4802) flagged that the implicit wipe
    // collapsed sibling AskUserQuestion entries that still had legitimate
    // answers in flight. `_finishTurnError` runs on PTY-exit / Stop-hook
    // timeout / prompt-write failure paths that do NOT issue Ctrl-C, so
    // a parallel sibling's response that's already on the wire (#4668
    // retry-as-singles shape) can still validly consume its entry. Late
    // arrivals after the PTY has truly stopped responding will no-op in
    // `respondToQuestion` (write throws / TUI ignores) — far better than
    // silently dropping the legitimate response and re-creating the
    // #4668 wedge. The other turn-ending sites
    // (`_teardownTurn` / `interrupt()` / `destroy()`) still call
    // `_pendingUserAnswers_clearAll()` because they DO issue Ctrl-C or
    // kill the PTY outright.
    this._clearAskUserQuestionLock()
    // #4604: same symmetry for the stall watchdog. The guard in
    // _onAskUserQuestionStall (`!_pendingUserAnswer && !_isBusy`) would
    // currently no-op the late fire (both are falsy here), but leaving
    // the setTimeout handle live wastes a callback invocation 30s later.
    if (this._askUserQuestionWatchdog) {
      clearTimeout(this._askUserQuestionWatchdog)
      this._askUserQuestionWatchdog = null
    }
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
   * Arm (or re-arm) the soft + hard inactivity + stream-stall timers
   * (#3920, #4638).
   *
   * Soft: fires `inactivity_warning` after _resultTimeoutMs of silence.
   * Session stays alive — the dashboard renders a check-in chip.
   *
   * Hard: force-clears busy state + emits `error` after _hardTimeoutMs.
   * Last-resort kill path for sessions that are genuinely stuck.
   *
   * Stream-stall: active-recovery for the `stream_start fired then
   * nothing` wedge — claude TUI accepting the prompt write, emitting
   * nothing, never returning a Stop hook. #4467 wired the same timer
   * into CliSession + SdkSession; the TUI provider was the outlier, so
   * this wedge surfaced as a "Working…" banner that ticked indefinitely.
   * Default lives in `BaseSession.DEFAULT_STREAM_STALL_TIMEOUT_MS`; only
   * armed when `_streamStallTimeoutMs > 0` (operators can disable via 0).
   *
   * All three are cleared+re-armed on each call, so any progress signal
   * (new hook file processed) resets every window. Mirrors
   * `CliSession._armResultTimeout()`.
   */
  _armResultTimeout() {
    if (this._resultTimeout) clearTimeout(this._resultTimeout)
    if (this._hardTimeout) clearTimeout(this._hardTimeout)
    if (this._streamStallTimeout) clearTimeout(this._streamStallTimeout)
    this._resultTimeout = null
    this._hardTimeout = null
    this._streamStallTimeout = null
    this._resultTimeout = setTimeout(() => {
      this._resultTimeout = null
      this._handleInactivityWarning()
    }, this._resultTimeoutMs)
    this._hardTimeout = setTimeout(() => {
      this._hardTimeout = null
      this._handleHardTimeout()
    }, this._hardTimeoutMs)
    // #4638: only arm if configured > 0 (operators can disable via 0).
    if (this._streamStallTimeoutMs > 0) {
      this._streamStallTimeout = setTimeout(() => {
        this._streamStallTimeout = null
        this._handleStreamStall()
      }, this._streamStallTimeoutMs)
    }
    // #4732: first-output watchdog. Independent from the inter-stream
    // stall timer above — that one only re-arms BETWEEN hook events, so
    // a turn where claude TUI accepts the prompt and emits zero hooks
    // gets no protection from it. The first-output timer arms once per
    // turn here, disarms on the first consumed hook event via
    // `_clearFirstOutputWatchdog()`, and on fire calls
    // `_handleFirstOutputTimeout` which routes through `_teardownTurn`
    // with the stream_stall error code so the dashboard chip surfaces
    // through the same wire path. 0 disables.
    this._armFirstOutputWatchdog()
  }

  /**
   * #4732: arm (or re-arm) the pre-first-output silence watchdog.
   * No-op when `_firstOutputTimeoutMs` is 0 (operator opt-out) or
   * when `_firstOutputDisarmed` is true (a hook event was already
   * consumed this turn — re-arming would defeat the disarm). Always
   * clears any existing handle before re-arming so back-to-back
   * `_armResultTimeout` calls produce exactly one live timer.
   *
   * Called from `_armResultTimeout()`. The matching disarm helper
   * (`_clearFirstOutputWatchdog`) is called from the hook-drain loop
   * on first consumed event and from every teardown path (success,
   * error, hard timeout, stream stall, AskUserQuestion stall,
   * destroy) so a late fire cannot land on an idle session.
   */
  _armFirstOutputWatchdog() {
    if (this._firstOutputTimeout) {
      clearTimeout(this._firstOutputTimeout)
      this._firstOutputTimeout = null
    }
    if (this._firstOutputTimeoutMs <= 0) return
    if (this._firstOutputDisarmed) return
    this._firstOutputArmedAt = Date.now()
    this._firstOutputTimeout = setTimeout(() => {
      this._firstOutputTimeout = null
      this._handleFirstOutputTimeout()
    }, this._firstOutputTimeoutMs)
  }

  /**
   * #4732: disarm the pre-first-output silence watchdog without
   * affecting the inter-stream stall timer. Called from the hook-drain
   * loop the first time any hook file is consumed, and from every
   * teardown path so a late fire cannot land on a torn-down session.
   * Idempotent and safe to call when the timer was never armed.
   *
   * Sets the per-turn `_firstOutputDisarmed` latch so subsequent
   * `_armResultTimeout` calls (one per consumed hook) don't re-arm
   * the watchdog. The latch is reset to false in `sendMessage` at
   * turn start via `_resetFirstOutputWatchdogForTurn` so the NEXT
   * turn gets a fresh arm cycle.
   */
  _clearFirstOutputWatchdog() {
    if (this._firstOutputTimeout) {
      clearTimeout(this._firstOutputTimeout)
      this._firstOutputTimeout = null
    }
    this._firstOutputDisarmed = true
  }

  /**
   * #4732: reset the per-turn `_firstOutputDisarmed` latch so the
   * next turn's `_armResultTimeout` call arms the watchdog fresh.
   * Called from `sendMessage` immediately before the prompt write so
   * a long-lived session with many turns gets first-output protection
   * on every turn (not just the first).
   */
  _resetFirstOutputWatchdogForTurn() {
    this._firstOutputDisarmed = false
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
    this._assertBusyHasMessageId('_handleHardTimeout')
    const friendly = formatIdleDuration(this._hardTimeoutMs)
    log.warn(`Hard-cap timeout (${friendly}) — force-clearing busy state`)
    const duration = this._activeTurn ? Date.now() - this._activeTurn.startedAt : this._hardTimeoutMs
    // #4641: shared teardown helper. Flags preserve exact historical
    // behaviour — hard-timeout emits stream_end unconditionally (even if
    // messageId is null) and emits error BEFORE _emitResult; stream-stall
    // gates stream_end on messageId and emits error AFTER. Both are kept
    // as-is so this refactor is behaviour-preserving.
    this._teardownTurn('hard_timeout', {
      duration,
      errorPayload: { message: `Response timed out after ${friendly}` },
      errorBeforeResult: true,
      gateStreamEndOnMessageId: false,
    })
  }

  /**
   * #4638: stream-stall active recovery. Fires after
   * `_streamStallTimeoutMs` of silence post-stream_start with no Stop
   * hook, no tool hooks, and no PTY output at all — the wedge mode
   * observed live in v0.9.21 where claude TUI accepts the prompt and
   * then emits nothing forever. Mirrors `CliSession._handleStreamStall`
   * (#4467) and `SdkSession._handleStreamStall` (#4616) so the
   * dashboard's recovery path is provider-agnostic.
   *
   * Distinct from the soft inactivity warning (passive chip after 30
   * min) and the hard cap (force-clear after 2h): this is the ACTIVE
   * recovery in minutes, not hours, so a user staring at a stuck
   * "Working…" banner can retry without waiting for the hard backstop
   * or having to click Stop and hope.
   *
   * Sequence: best-effort Ctrl-C into the TUI (so claude TUI itself
   * unsticks for the next turn) → emit stream_end (pairs with the
   * stream_start fired at turn-start) → _emitResult (sweeps orphan
   * tool_starts, fires synthetic result → agent_idle fan-out via the
   * event-normalizer) → emit error with `code: 'stream_stall'` so the
   * dashboard surfaces a dedicated retry affordance distinct from
   * generic errors.
   */
  _handleStreamStall() {
    if (!this._isBusy) return
    this._assertBusyHasMessageId('_handleStreamStall')
    const friendly = formatIdleDuration(this._streamStallTimeoutMs)
    const messageId = this._currentMessageId
    log.warn(
      `Stream stalled (${friendly}, messageId=${messageId}) — clearing busy state for retry`,
    )
    const duration = this._activeTurn ? Date.now() - this._activeTurn.startedAt : this._streamStallTimeoutMs
    // #4641: shared teardown helper. See companion call in _handleHardTimeout
    // for the meaning of the asymmetric flags — preserved here as-is so this
    // refactor introduces no behaviour change.
    this._teardownTurn('stream_stall', {
      duration,
      errorPayload: {
        code: 'stream_stall',
        message: `Stream stalled — no response for ${friendly}. Try sending again.`,
      },
      errorBeforeResult: false,
      gateStreamEndOnMessageId: true,
    })
  }

  /**
   * #4732: pre-first-output silence watchdog handler. Fires once per
   * turn when claude TUI accepts the prompt write (writePtyText
   * completed=true) but emits NO hook events for
   * `_firstOutputTimeoutMs`. Distinct from `_handleStreamStall` —
   * that one fires on silence BETWEEN hook events, this one fires on
   * silence BEFORE the first one.
   *
   * Live failure that motivated this (v0.9.32 dogfooding, #4732):
   * `writePtyText completed=true` at T+0; 200s of `hookPoll
   * heartbeat … consumed=0 stopFound=no` with no recovery. claude TUI
   * subprocess had 2.71s CPU after 4 min wall — consistent with a
   * stuck Anthropic API call. User clicked Stop manually.
   *
   * Reuses the `stream_stall` error code so the dashboard's existing
   * recovery chip surfaces without provider-specific wiring. The
   * distinct teardown reason `'first_output_timeout'` keeps the two
   * stall flavors distinguishable in post-mortem logs / metrics.
   */
  _handleFirstOutputTimeout() {
    if (!this._isBusy) return
    // #4642: mirror the invariant check the other teardown sites
    // (`_finishTurnError`, `_handleHardTimeout`, `_handleStreamStall`,
    // `_onAskUserQuestionStall`) emit so a future regression that
    // breaks the `_isBusy ↔ _currentMessageId` construction contract
    // surfaces from THIS path too.
    this._assertBusyHasMessageId('_handleFirstOutputTimeout')
    const elapsedMs = this._firstOutputArmedAt > 0
      ? Date.now() - this._firstOutputArmedAt
      : this._firstOutputTimeoutMs
    const friendly = formatIdleDuration(this._firstOutputTimeoutMs)
    log.warn(`first-output watchdog fired (elapsedMs=${elapsedMs}) — claude TUI did not respond`)
    const duration = this._activeTurn
      ? Date.now() - this._activeTurn.startedAt
      : this._firstOutputTimeoutMs
    // Mirrors _handleStreamStall's `_teardownTurn` call shape (result
    // before error, gate stream_end on messageId) so the dashboard sees
    // the same fan-out it already handles for the inter-stream stall.
    this._teardownTurn('first_output_timeout', {
      duration,
      errorPayload: {
        code: 'stream_stall',
        message: `No response from claude TUI within ${friendly}. Try sending again.`,
      },
      errorBeforeResult: false,
      gateStreamEndOnMessageId: true,
    })
  }

  /**
   * #4641: shared per-turn teardown for the timeout/stall recovery paths
   * (`_handleHardTimeout`, `_handleStreamStall`). Centralises the cleanup
   * sequence so the next #4286/#4604-class symmetry fix only needs to
   * touch one site.
   *
   * Sequence (matches the historical inline code in both callers):
   *   1. Best-effort Ctrl-C into the PTY so claude TUI unsticks the
   *      in-flight request and returns to its prompt. Doesn't kill the
   *      process — _isBusy=false below lets the next sendMessage proceed.
   *   2. Emit `stream_end` so the dashboard clears `streamingMessageId`.
   *      The two callers disagree on whether to gate on `messageId`
   *      (hard-timeout emits unconditionally, stream-stall gates),
   *      hence the `gateStreamEndOnMessageId` flag — kept asymmetric
   *      because changing either side would alter observable wire
   *      behaviour for a contract-violation edge case (_isBusy=true with
   *      a null _currentMessageId, tracked in #4642).
   *   3. Drop the per-turn attachment dir (#4022), null `_activeTurn`,
   *      clear `_isBusy` + `_currentMessageId`.
   *   4. Clear the pending AskUserQuestion answer slot (#4286), the
   *      askuserquestion-active lock (#4669), and the AskUserQuestion
   *      stall watchdog (#4604) — all symmetric across teardown paths.
   *   5. Emit `error` and `_emitResult` in the order the caller requests.
   *      Hard-timeout historically fired error BEFORE result; stream-stall
   *      after. The order is observable to listeners and the asymmetry
   *      is preserved here verbatim (`errorBeforeResult` flag) so this
   *      refactor is strictly behaviour-preserving — flipping the order
   *      to a single canonical sequence is intentionally OUT OF SCOPE
   *      and tracked separately if ever needed.
   *
   * `errorPayload` is optional — when omitted no error is emitted (none
   * of the current callers exercise this, but it leaves room for future
   * teardown paths that only want the cleanup half).
   */
  _teardownTurn(reason, {
    duration,
    errorPayload = null,
    errorBeforeResult = false,
    gateStreamEndOnMessageId = true,
  } = {}) {
    const messageId = this._currentMessageId
    // #4682: per-turn summary log so the wedge-mode teardown paths
    // (hard_timeout, stream_stall) land the same grep-able
    // `sendMessage done` line as the success and _finishTurnError paths.
    // Placed before any state mutation so the helper sees populated
    // turn fields (messageId, startedAt, waitForPrompt*, write*).
    // PR #4681 added the summary helper for the wedge investigation;
    // missing it on the stream-stall path defeated the whole point.
    this._logSendMessageSummary(reason)
    // 1. Best-effort Ctrl-C into the PTY.
    if (this._term) {
      try { this._term.write('\x03') } catch { /* ignore */ }
    }
    // 2. Emit stream_end (gated per caller).
    if (gateStreamEndOnMessageId) {
      if (messageId) this.emit('stream_end', { messageId })
    } else {
      this.emit('stream_end', { messageId })
    }
    // 3. Per-turn attachment + busy-state cleanup. _cleanupTurnAttachments
    // runs BEFORE _activeTurn is nulled so the helper still has access
    // to attachmentsDir; no-op when the turn had no attachments.
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    // 4. AskUserQuestion-related slot/lock/watchdog symmetry. #4802:
    //    explicit `_pendingUserAnswers_clearAll()` (was an implicit
    //    `_pendingUserAnswer = null` via the back-compat setter). Safe
    //    here because _teardownTurn always issues Ctrl-C above
    //    (step 1), so the TUI has dropped its current AskUserQuestion
    //    form — any sibling pending entry can no longer be served and
    //    leaving it would just risk a late respondToQuestion writing
    //    stale keystrokes into whatever form the next turn brings up.
    this._pendingUserAnswers_clearAll()
    this._clearAskUserQuestionLock()
    if (this._askUserQuestionWatchdog) {
      clearTimeout(this._askUserQuestionWatchdog)
      this._askUserQuestionWatchdog = null
    }
    // #4732: clear the pre-first-output watchdog so a teardown via
    // `_handleHardTimeout` / `_handleStreamStall` / `_handleFirstOutputTimeout`
    // can never leak a live handle that would re-fire on a torn-down turn.
    this._clearFirstOutputWatchdog()
    // 5. Error + result emit, in the order the caller requests. The two
    // existing callers disagree (hard-timeout: error first; stream-stall:
    // result first), and that asymmetry is preserved exactly.
    const emitResult = () => {
      this._emitResult(
        { cost: null, duration, usage: null, sessionId: this._sessionId },
        reason,
      )
    }
    const emitError = () => {
      if (errorPayload) this.emit('error', errorPayload)
    }
    if (errorBeforeResult) {
      emitError()
      emitResult()
    } else {
      emitResult()
      emitError()
    }
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
    // #4278 / #4802: drop any pending AskUserQuestion so a subsequent
    // user_question_response can't write into a torn-down context.
    // Explicit `_pendingUserAnswers_clearAll()` (was an implicit
    // `_pendingUserAnswer = null` → Map.clear() via the back-compat
    // setter). Safe here: interrupt() writes Ctrl-C to the PTY above,
    // so the TUI is no longer waiting on any AskUserQuestion form —
    // every sibling pending entry is now equally stale.
    this._pendingUserAnswers_clearAll()
    this._clearAskUserQuestionLock()
    // #4604: cancel the stall watchdog too. interrupt() does NOT clear
    // _isBusy directly (Ctrl-C surfaces async via _finishTurn*), so without
    // this the watchdog could fire ~30s later and emit a spurious
    // ASK_USER_QUESTION_STALL for a session the user already interrupted.
    if (this._askUserQuestionWatchdog) {
      clearTimeout(this._askUserQuestionWatchdog)
      this._askUserQuestionWatchdog = null
    }
    // #4732: same reasoning for the pre-first-output watchdog. interrupt()
    // doesn't synchronously flip _isBusy=false, so without this clear the
    // watchdog could fire in the 150ms poll-loop window before
    // _finishTurnError runs and emit a spurious stream_stall for a
    // session the user has already interrupted.
    this._clearFirstOutputWatchdog()
  }

  /**
   * Send a response to an AskUserQuestion prompt (#4278, multi-question
   * support added in #4604 Chunk B). The dashboard's QuestionPrompt UI
   * fires this when the user submits. Two paths:
   *
   * - Single-question (`questions.length === 1`, the v0.9.4 happy path):
   *   write the 1-indexed option digit through the throttled writer,
   *   which appends \r. claude TUI's prompt accepts either; Enter is
   *   redundant but harmless. Pin-tested via #4290.
   *
   * - Multi-question (#4604 Chunk B): drive the inline form per the
   *   empirical key sequence captured by scripts/tui-form-recorder.mjs
   *   against claude CLI v2.1.158 (see tui_multi_question_form_keys
   *   memory). For each question:
   *     - single-select → write the digit (auto-advances to next q)
   *     - multi-select  → write each chosen digit (no advance) then
   *                       write Tab `\t` to commit + advance
   *   After the last question, focus lands on the Submit screen
   *   (`❯ 1. Submit answers / 2. Cancel`); write `'1'` to confirm.
   *   The whole sequence is wrapped in bracketed-paste-disable/re-enable
   *   exactly once and every visible char goes through the same
   *   per-char throttle the single-question path uses (#4269 paste
   *   detector defense).
   *
   * `answersMap` keys are the question text (`q.question`), values are
   * either the chosen option's label string (single-select) or a
   * JSON-encoded `["label1","label2"]` array / comma-joined list
   * (multi-select). Back-compat: when the dashboard only sends `text`
   * with no map (old client + multi-question form), defaults every
   * question to its first option and logs a WARN so the wedge is
   * visible in chroxy.log even though the session isn't stalled.
   *
   * No-op when no pending answer.
   *
   * @param {string} text — the chosen answer (single-question path); on the
   *   Other / freeform path (#4651) this is the Other option's label, used
   *   to resolve the 1-indexed TUI digit. Ignored on the multi-question
   *   path when answersMap is populated.
   * @param {object} [answersMap] — `{ [questionText]: string | string[] }`;
   *   required for multi-question forms (Chunk B).
   * @param {string} [toolUseId] — #4668: target the specific pending entry
   *   to answer when multiple AskUserQuestion tool_uses are in flight in
   *   the same turn. When omitted, falls back to the most-recently-set
   *   pending entry via the back-compat getter.
   * @param {object} [opts] — extra options.
   * @param {string} [opts.freeformText] — #4651 single-question Other path:
   *   when set, the session writes the Other digit (resolved from `text`),
   *   waits ~150 ms for claude TUI's option-menu → text-input prompt swap,
   *   then writes `freeformText` + Enter. Dropped when the chosen option
   *   doesn't exist or sits beyond the single-digit hotkey range.
   */
  respondToQuestion(text, answersMap, toolUseId, opts) {
    // #4668: route to the specific pending entry the dashboard answered
    // for. Pre-#4668 chroxy stored a single pending answer in a field
    // and respondToQuestion always read THAT field — so when claude TUI
    // emitted parallel AskUserQuestion tool_use blocks in one turn, the
    // field got overwritten and the user's answer landed in the wrong
    // toolUseId's slot. Now: if the dashboard supplied a toolUseId, look
    // it up in the Map; if not (legacy clients), fall back to the most-
    // recently-set entry via the back-compat getter so behaviour matches
    // pre-#4668 for the single-pending case.
    //
    // #4651: `opts.freeformText` triggers the Other / freeform path —
    // server resolves the chosen option label to its 1-indexed digit,
    // writes the digit to open claude TUI's text-input prompt, waits
    // ~150 ms for the prompt swap, then writes the freeform text + Enter
    // to submit. Mutually exclusive with answersMap (multi-question
    // Other is out of scope per #4648).
    const freeformText = (opts && typeof opts.freeformText === 'string' && opts.freeformText.length > 0)
      ? opts.freeformText
      : null
    let entry = null
    if (toolUseId && this._pendingUserAnswers.has(toolUseId)) {
      entry = this._pendingUserAnswers.get(toolUseId)
    } else if (toolUseId && this._pendingUserAnswers.size > 0) {
      // Dashboard sent a toolUseId we don't have a pending entry for.
      // Common cause: stale answer arriving after the turn's teardown
      // cleared the Map (watchdog fire, user gave up + the late answer
      // came in). Log + drop rather than write keystrokes into whatever
      // form happens to be currently rendered.
      // #4828: session-scoped — respondToQuestion runs strictly post-start.
      ;(this._log || log).warn(`respondToQuestion: dashboard sent toolUseId=${toolUseId} but no matching pending entry (Map.size=${this._pendingUserAnswers.size} keys=${[...this._pendingUserAnswers.keys()].join(',')}) — dropping`)
      return
    } else {
      // Legacy / unidentified path: route to the most-recent entry via
      // the back-compat getter. Maintains the pre-#4668 behaviour for
      // single-pending cases and for callers that haven't been updated
      // to pass toolUseId.
      //
      // #4688: warn when the dashboard omitted toolUseId AND we have
      // multiple pending entries — the back-compat fallback picks the
      // most-recent entry by insertion order, which may not be what
      // the user intended. Loud log so the wedge symptom is greppable.
      if (!toolUseId && this._pendingUserAnswers.size > 1) {
        // #4828: session-scoped.
        ;(this._log || log).warn(`respondToQuestion: dashboard omitted toolUseId but ${this._pendingUserAnswers.size} pending entries exist (keys=${[...this._pendingUserAnswers.keys()].join(',')}) — falling back to most-recent which may misroute`)
      }
      entry = this._pendingUserAnswer
    }
    const prevToolUseId = entry?.toolUseId || null
    const pendingQuestions = entry?.questions || []
    const answersMapKeyCount = answersMap && typeof answersMap === 'object' ? Object.keys(answersMap).length : 0
    // #4828: session-scoped.
    ;(this._log || log).info(`respondToQuestion: tool=${prevToolUseId || '?'} dashboardToolUseId=${toolUseId || 'none'} text.length=${(text || '').length} answersMap.keys=${answersMapKeyCount} questions=${pendingQuestions.length} options=${entry?.options?.length || 0} pendingMapSize=${this._pendingUserAnswers.size}`)
    if (!entry) return
    // Single-question / free-text path requires a non-empty `text`. The
    // multi-question path is driven from answersMap (text is ignored when
    // a map is present) so an empty string is permitted there.
    if (typeof text !== 'string') return
    if (text.length === 0 && answersMapKeyCount === 0) return
    const { options } = entry
    const questions = pendingQuestions
    // #4668: clear only this specific entry; sibling pending answers
    // (from parallel AskUserQuestion calls in the same turn) survive.
    this._clearPendingAnswerByToolUseId(entry.toolUseId)
    if (!this._term) return
    // #4668 diagnostic: capture the PTY output tail just before we write
    // the answer keystroke. The wedge symptom observed 2026-06-01 was
    // "chroxy wrote bytes=1 → TUI silent for 30s → watchdog fires" with
    // no visibility into whether the TUI's input prompt was actually
    // ready to receive a digit. Logging the tail hex dump at write-time
    // tells us exactly what the TUI was showing when our keystroke
    // landed — single-keystroke wedges almost always come from a form
    // misalignment that's visible in the trailing render bytes.
    //
    // #4693: rate-limit to once per turn. The multi-question retry-as-
    // singles wedge fires 4+ respondToQuestion calls in succession; each
    // hex dump is ~70 lines (1024 bytes formatted 16/line + header), so an
    // unbounded emission pumps 280+ lines of diagnostic per affected turn.
    // We stash the emission flag on the active turn object so it resets
    // automatically on every new sendMessage() (which allocates a fresh
    // `_activeTurn`). Subsequent answers in the same turn emit a compact
    // one-line skip notice carrying the tool ids so a log reader can still
    // grep all answer-write events without scanning past 200+ hex lines.
    // #4792: PTY tail hex dumps are the highest-volume, most-sensitive
    // unscoped log lines pre-fix — they emit literal terminal bytes
    // (user prompts, answer text, attachment names) on every
    // respondToQuestion. Routing them through the session-bound logger
    // makes the audit story clean: only operators bound to this session
    // (or unbound) see the dump (#4787 fan-out filter).
    const slog = this._log || log
    const turn = this._activeTurn
    if (turn && !turn.hexDumpEmitted) {
      slog.info(`respondToQuestion PTY tail before write (tool=${prevToolUseId || '?'}):\n${this._outputTailHexDump()}`)
      turn.hexDumpEmitted = true
    } else if (turn) {
      slog.info(`respondToQuestion PTY tail hex dump skipped (tool=${prevToolUseId || '?'}) — already emitted for turn msg=${turn.messageId || '?'}`)
    } else {
      // No active turn (defensive — tests that drive respondToQuestion
      // directly without sendMessage(), late watchdog teardown races).
      // Emit the dump so the diagnostic is still useful in those paths.
      slog.info(`respondToQuestion PTY tail before write (tool=${prevToolUseId || '?'}):\n${this._outputTailHexDump()}`)
    }

    const armWatchdog = () => {
      // #4604: arm a stall watchdog. If claude TUI never emits PostToolUse
      // for this AskUserQuestion (a form shape we don't yet drive),
      // the watchdog clears _isBusy + _pendingUserAnswer and emits
      // ASK_USER_QUESTION_STALL so the dashboard prompts the user to
      // retry. Cancelled on PostToolUse (happy path) and on destroy().
      if (this._askUserQuestionWatchdog) clearTimeout(this._askUserQuestionWatchdog)
      this._askUserQuestionWatchdog = setTimeout(() => {
        this._askUserQuestionWatchdog = null
        this._onAskUserQuestionStall(prevToolUseId)
      }, ASK_USER_QUESTION_WATCHDOG_MS)
    }

    // Single-question / no-questions-array path (back-compat with the
    // pre-Chunk-B happy path). Stay on _writePtyTextThrottled which
    // appends \r — TUI single-select auto-commits on digit, the trailing
    // Enter is redundant but harmless, and the existing test guards
    // (#4290) assert it's present. Requires non-empty `text`: the
    // single-q path is text-driven, not answersMap-driven.
    if (questions.length <= 1) {
      if (text.length === 0) return

      // #4651 — Other / freeform path. The dashboard picked the "Other"
      // option AND typed freeform text. claude TUI accepts this as a
      // two-stage flow: press the Other digit (swaps the option-select
      // menu to a text-input prompt), wait for the swap, then type the
      // freeform text + Enter. Resolve the chosen label → digit via the
      // same 1-indexed lookup as the happy path. When the chosen option
      // doesn't exist (or sits beyond the single-digit hotkey range),
      // drop the answer — blindly writing the freeform text at the
      // digit menu is the #4288 jump-nav footgun and the dashboard
      // shouldn't have been able to send freeformText for an
      // AskUserQuestion without an Other option in the first place.
      if (freeformText) {
        if (!Array.isArray(options) || options.length === 0) {
          // #4828: session-scoped.
          ;(this._log || log).warn(`respondToQuestion: freeformText supplied for question with no options (tool=${prevToolUseId || '?'}) — dropping`)
          return
        }
        const otherIdx = options.findIndex((o) => o && o.label === text)
        if (otherIdx < 0 || otherIdx >= 9) {
          // #4828: session-scoped.
          ;(this._log || log).warn(`respondToQuestion: freeformText supplied but chosen option "${text}" not found (or beyond single-digit hotkey range) in pending options for tool=${prevToolUseId || '?'} — dropping`)
          return
        }
        const otherDigit = String(otherIdx + 1)
        // Stage 1: write the digit. _writePtyTextThrottled appends \r —
        // for the option-select menu the trailing \r commits the digit
        // (same shape as the happy single-select path).
        // Stage 2: after OTHER_FREEFORM_SETTLE_MS, write the freeform
        // text + \r via the same throttled writer. claude TUI's text-
        // input prompt accepts typed input directly (no jump-nav),
        // and the trailing \r submits.
        const tag = prevToolUseId || '?'
        ;(async () => {
          // #4808: destroy() can run during ANY of the awaits below
          // (stage-1 write, settle pause, stage-2 write). Without a
          // guard after each await the IIFE keeps running and:
          //   - re-arms `_askUserQuestionWatchdog` past destroy(),
          //     leaking a 30s timer that pins `this` in its closure
          //     even though `_onAskUserQuestionStall`'s _destroying
          //     guard silences the eventual emit
          //   - calls `_writePtyTextThrottled(freeformText)` against
          //     a `_term` that destroy() set to null, throwing inside
          //     the inner write loop
          // Bail out at every await boundary instead.
          const stage1ok = await this._writePtyTextThrottled(otherDigit).catch((err) => {
            // #4828: session-scoped.
            ;(this._log || log).warn(`respondToQuestion Other-digit PTY write failed: ${err.message} (tool=${tag})`)
            return false
          })
          if (this._destroying) return
          if (!stage1ok) return
          await new Promise((resolve) => setTimeout(resolve, OTHER_FREEFORM_SETTLE_MS))
          if (this._destroying) return
          // Belt-and-braces: destroy() sets _destroying before nulling
          // _term in the same synchronous frame, so the guard above
          // already covers the destroy() race. This null-check is
          // cheap insurance against a future path that releases _term
          // without flipping _destroying (e.g. a PTY-exit handler) —
          // skip the re-arm AND the stage-2 write together so the
          // watchdog never fires for a session that no longer has a
          // PTY behind it.
          if (!this._term) return
          // Re-arm the watchdog so the freeform write phase has a fresh
          // OTHER_FREEFORM_WATCHDOG_MS window — the stage-1 arm already
          // counted the settle delay against the original 30s budget.
          if (this._askUserQuestionWatchdog) clearTimeout(this._askUserQuestionWatchdog)
          this._askUserQuestionWatchdog = setTimeout(() => {
            this._askUserQuestionWatchdog = null
            this._onAskUserQuestionStall(prevToolUseId)
          }, OTHER_FREEFORM_WATCHDOG_MS)
          await this._writePtyTextThrottled(freeformText).catch((err) => {
            // #4828: session-scoped.
            ;(this._log || log).warn(`respondToQuestion Other-freeform PTY write failed: ${err.message} (tool=${tag})`)
          })
        })()
        armWatchdog()
        return
      }

      // #4290: if the chosen label matches one of the structured options
      // exactly, write the 1-indexed TUI shortcut (e.g. "2") instead of
      // the label text. v0.9.3 wrote the raw label and claude TUI's
      // prompt parser single-character-jump-navigated through the menu,
      // landing on "Other" (see #4288 for the empirical trace). Numbered
      // shortcuts hit claude TUI's hotkey path directly. When no exact
      // match is found (user picked "Other" in the dashboard and typed
      // freeform text), fall through to typing the answer literally —
      // claude TUI's Other-path may still mis-parse that, tracked in
      // #4288 as a separate concern.
      let writeText = text
      if (Array.isArray(options) && options.length > 0) {
        const matchIdx = options.findIndex((o) => o && o.label === text)
        // #4292 + #4746 + #4848: single-digit hotkey covers indices 0..8.
        // For matched picks at idx >= 9 we drive the form via arrow-key
        // navigation instead of the hotkey alphabet — Down arrow (`\x1b[B`)
        // N times moves the cursor from the top option (idx 0) to the
        // target idx, and Enter (`\r`) commits the highlighted option
        // (#4848). Pre-#4848 this path tore the turn down with a
        // structured ASK_USER_QUESTION_TOO_MANY_OPTIONS error (#4746)
        // because the empirical multi-digit keystroke for option 10+
        // was unrecorded; arrow-key navigation was always one of the two
        // candidate paths the recorder script (scripts/tui-form-recorder.mjs)
        // called out and is the more conservative bet (single-keystroke
        // menus that auto-commit on the first digit can't be driven via
        // multi-digit chord like '1','0'; arrow keys are the standard
        // claude TUI navigation primitive used elsewhere in its form
        // pickers).
        //
        // #4880 (resolved 2026-06-07): the recorder pass against a 10+ option
        // AskUserQuestion finally ran (docs/empirical/4880-twelve-option-cap.jsonl)
        // and found the form is UNREACHABLE: claude TUI v2.1.168's
        // AskUserQuestion tool hard-caps each question at 4 options. A prompt
        // asking for 12 options fails server-side with
        // `InputValidationError: too_big, maximum: 4, path: questions[0].options`
        // before any form renders — so `matchIdx >= 9` can never be hit via a
        // real AskUserQuestion on this TUI version. This branch is therefore
        // currently DEAD CODE, retained as forward-compat: if a future claude
        // raises the option cap, the arrow-nav drive is ready. The `\x1b[B`
        // (Down) + `\r` (Enter) bytes remain the best-available unverified
        // sequence — they could not be empirically pinned because the form
        // can't be produced. Revisit if/when the cap is raised.
        //
        // Scoped to MATCHED picks at idx >= 9. An unmatched label still
        // falls through to typing the literal text (the v0.9.3 / pre-#4292
        // path) so the Other / freeform back-compat case is preserved.
        if (matchIdx >= 9) {
          const total = options.length
          ;(this._log || log).info(`AskUserQuestion single-question: question has ${total} options and the user picked option ${matchIdx + 1} ("${(text || '').slice(0, 40)}") — driving via arrow-key navigation (#4848) (tool=${prevToolUseId || '?'})`)
          this._writePtyArrowNavSequence(matchIdx).catch((err) => {
            ;(this._log || log).warn(`respondToQuestion arrow-nav PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
          })
          armWatchdog()
          return
        }
        if (matchIdx >= 0 && matchIdx < 9) {
          writeText = String(matchIdx + 1)
        }
      }
      // Fire-and-forget — the write is async due to the per-char throttle,
      // but the caller (handleUserQuestionResponse) is sync. Errors here
      // are non-fatal; worst case the user re-sends the answer.
      this._writePtyTextThrottled(writeText).catch((err) => {
        // #4828: session-scoped.
        ;(this._log || log).warn(`respondToQuestion PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
      })
      armWatchdog()
      return
    }

    // #4604 Chunk B — multi-question form driver. Build the keystroke
    // sequence per the empirical findings, then write through the
    // dedicated multi-question writer (one bracketed-paste wrap around
    // the whole sequence; per-char throttle; no trailing \r).
    const map = (answersMap && typeof answersMap === 'object') ? answersMap : {}
    const haveMap = Object.keys(map).length > 0
    if (!haveMap) {
      // #4828: session-scoped.
      ;(this._log || log).warn(`AskUserQuestion multi-question: dashboard didn't send answersMap (tool=${prevToolUseId || '?'}, questions=${questions.length}) — defaulting every question to option 1. Update the client to populate the per-question answers map.`)
    }

    // #4625 + #4848 — claude TUI's single-digit hotkey alphabet ('1'..'9')
    // covers options at indices 0..8 only. When a question has 10+ options
    // AND the user explicitly picked one at index ≥ 9, we have no
    // representable digit keystroke. Pre-#4625 the driver silently
    // defaulted such picks to option 1; #4625 surfaced a structured
    // ASK_USER_QUESTION_TOO_MANY_OPTIONS error before any PTY write so
    // the dashboard could prompt for a re-ask. #4848 splits this by
    // question kind:
    //   - single-select questions with an explicit pick at idx >= 9:
    //     driven natively via arrow-key navigation in the assembled
    //     sequence below (each Down arrow lands the cursor on the next
    //     option, Enter commits + advances to the next question — same
    //     mechanism the single-question path now uses).
    //   - multi-select questions with a toggle at idx >= 9: KEEP the
    //     structured ASK_USER_QUESTION_TOO_MANY_OPTIONS error. multi-
    //     select form navigation (arrow + Space to toggle + return-to-
    //     start) is empirically unrecorded; mixing arrow nav with the
    //     digit hotkeys for in-range toggles in the same question would
    //     leave the cursor in an unknown state without a tested return-
    //     to-anchor primitive. Reserve the too-many error for this case.
    //
    // Bail BEFORE any PTY write so the form stays in its initial state
    // when the error fires (claude TUI's watchdog or the user's Ctrl-C
    // unsticks it). 10+ option questions with no per-question answer
    // still fall back to option 1 (back-compat for old clients).
    if (haveMap) {
      const unrepresentableMultiSelect = []
      for (const q of questions) {
        const opts = Array.isArray(q.options) ? q.options : []
        if (opts.length <= 9) continue
        if (!q.multiSelect) continue // single-select 10+ now driven via arrow nav
        const raw = map[q.question]
        // Gather every label the user toggled for this multi-select.
        // MUST mirror resolveQuestionKeystrokes' multi-select parsing —
        // array → JSON-encoded array → comma-joined list — so an
        // unrepresentable toggle sent via the comma-joined fallback
        // (e.g. "a,k") isn't accidentally treated as a single 3-char
        // label and missed (Copilot review feedback on #4625).
        let labels = []
        if (Array.isArray(raw)) {
          labels = raw.filter((s) => typeof s === 'string')
        } else if (typeof raw === 'string' && raw.length > 0) {
          let parsed = null
          try { parsed = JSON.parse(raw) } catch { parsed = null }
          if (Array.isArray(parsed)) {
            labels = parsed.filter((s) => typeof s === 'string')
          } else {
            labels = raw.split(',').map((s) => s.trim()).filter(Boolean)
          }
        }
        for (const label of labels) {
          const idx = opts.findIndex((o) => o && o.label === label)
          if (idx >= 9) unrepresentableMultiSelect.push({ question: q.question, label, index: idx, total: opts.length })
        }
      }
      if (unrepresentableMultiSelect.length > 0) {
        const first = unrepresentableMultiSelect[0]
        ;(this._log || log).warn(`AskUserQuestion multi-question: multi-select question has ${first.total} options and the user toggled option ${first.index + 1} ("${(first.label || '').slice(0, 40)}") which is outside claude TUI's 1..9 hotkey alphabet AND beyond the arrow-nav single-select fallback (#4848 deliberately scopes arrow-nav to single-select only) — surfacing ASK_USER_QUESTION_TOO_MANY_OPTIONS (tool=${prevToolUseId || '?'})`)
        // Full AskUserQuestion teardown: synth tool_result + Ctrl-C the
        // TUI + clear inactivity timers + stream_end + _emitResult +
        // error (in that order). Without the full teardown the dashboard
        // would leave the Working banner + Stop button up and the
        // "Running AskUserQuestion · Ns" pill ticking even though
        // chroxy gave up before writing any keystrokes (#4625 hands the
        // form's resolution back to the user via the error toast).
        this._teardownAskUserQuestion(prevToolUseId, {
          synthResult: `AskUserQuestion failed: multi-select question has ${first.total} options and you toggled option ${first.index + 1}, beyond the 9 the claude TUI multi-select form can drive (#4848).`,
          emitResultReason: 'ask_user_question_too_many_options',
          errorCode: 'ASK_USER_QUESTION_TOO_MANY_OPTIONS',
          errorMessage: `Couldn't answer: a multi-select question has ${first.total} options and you toggled option ${first.index + 1}, which is beyond the 9 the claude TUI form can drive for multi-select. Re-prompt the agent to ask with 9 or fewer options for that question.`,
        })
        return
      }
    }

    /** Resolve a single label to its 1-indexed digit; null if no usable digit. */
    const labelToDigit = (q, label) => {
      if (!q || !Array.isArray(q.options) || q.options.length === 0) return null
      const idx = q.options.findIndex((o) => o && o.label === label)
      if (idx >= 0 && idx < 9) return String(idx + 1)
      return null
    }

    /**
     * Resolve a single question's answer entry to an array of keystroke
     * tokens to write. Tokens are arbitrary-length strings — usually a
     * single digit ('1'..'9') or Tab/Enter, but for #4848 a single-select
     * answer at idx >= 9 expands to a multi-token arrow-nav sequence
     * (`'\x1b[B'` × idx + `'\r'`). The writer (`_writePtyMultiQuestionSequence`)
     * doesn't care about token length — it writes each entry as one
     * `term.write` call with a throttle pause after.
     */
    const resolveQuestionKeystrokes = (q, rawAnswer) => {
      const opts = Array.isArray(q.options) ? q.options : []
      const defaultDigit = opts.length > 0 ? '1' : null

      if (q.multiSelect) {
        // multi-select expects 0+ choices. Accept array, JSON-encoded
        // array string, or comma-joined list — the wire schema is
        // `Record<string, string | string[]>` post-#4735 so newer
        // dashboard / app builds send the native array form; pre-#4735
        // builds JSON-stringified the array into a single string for
        // back-compat. Both shapes resolve here.
        let labels = []
        if (Array.isArray(rawAnswer)) {
          labels = rawAnswer.filter((s) => typeof s === 'string')
        } else if (typeof rawAnswer === 'string' && rawAnswer.length > 0) {
          let parsed = null
          try { parsed = JSON.parse(rawAnswer) } catch { parsed = null }
          if (Array.isArray(parsed)) {
            labels = parsed.filter((s) => typeof s === 'string')
          } else {
            // Fallback: comma-joined "label1,label2" — only safe when
            // labels themselves don't contain commas; defensive
            // single-label case also handled here.
            labels = rawAnswer.split(',').map((s) => s.trim()).filter(Boolean)
          }
        }
        const digits = []
        for (const label of labels) {
          const d = labelToDigit(q, label)
          if (d) digits.push(d)
          // Multi-select 10+ toggles already pre-screened above and
          // surfaced as ASK_USER_QUESTION_TOO_MANY_OPTIONS — anything
          // unrepresentable here means the dashboard sent something we
          // couldn't match (defaulted handling below).
        }
        if (digits.length === 0 && defaultDigit) {
          // #4828: session-scoped (closure runs inside respondToQuestion, post-start).
          ;(this._log || log).warn(`AskUserQuestion multi-question: no resolvable answer for q="${(q.question || '').slice(0, 40)}" (multi-select) — defaulting to option 1`)
          digits.push(defaultDigit)
        }
        return digits
      }

      // single-select — exactly one keystroke token.
      let pickedLabel = null
      if (typeof rawAnswer === 'string' && rawAnswer.length > 0) {
        pickedLabel = rawAnswer
      } else if (Array.isArray(rawAnswer) && typeof rawAnswer[0] === 'string') {
        pickedLabel = rawAnswer[0]
      }
      if (pickedLabel !== null) {
        const idx = opts.findIndex((o) => o && o.label === pickedLabel)
        if (idx >= 0 && idx < 9) return [String(idx + 1)]
        if (idx >= 9) {
          // #4848 — option at idx >= 9 in a single-select question.
          // Drive via arrow-key navigation: idx Down arrows from the
          // top option (cursor starts at idx 0) followed by Enter to
          // commit + advance to the next question. The arrow sequence
          // and the Enter are emitted as two distinct keystroke tokens
          // so the throttle pauses BETWEEN them (claude TUI's paste
          // detector treats a single 11-byte burst as a paste). Each
          // arrow is 3 bytes ('\x1b[B'); 10 arrows = 30 bytes is still
          // well under any reasonable paste threshold, but stay safe.
          log.info(`AskUserQuestion multi-question: single-select pick at idx=${idx} (option ${idx + 1}) in q="${(q.question || '').slice(0, 40)}" → arrow-nav (#4848)`)
          const tokens = []
          for (let i = 0; i < idx; i++) tokens.push('\x1b[B')
          tokens.push('\r')
          return tokens
        }
      }
      if (defaultDigit) {
        // #4828: session-scoped (closure runs inside respondToQuestion, post-start).
        if (haveMap) (this._log || log).warn(`AskUserQuestion multi-question: no resolvable answer for q="${(q.question || '').slice(0, 40)}" (single-select) — defaulting to option 1`)
        return [defaultDigit]
      }
      return []
    }

    // Assemble the inner keystroke sequence (no paste-mode toggles —
    // _writePtyMultiQuestionSequence wraps the whole thing). The sequence
    // is a mixed array of strings (chars to write) and numbers (ms to
    // sleep) — the writer dispatches on type.
    const sequence = []
    for (const q of questions) {
      const rawAnswer = map[q.question]
      const keystrokes = resolveQuestionKeystrokes(q, rawAnswer)
      for (const k of keystrokes) sequence.push(k)
      if (q.multiSelect) {
        // Multi-select needs an explicit advance keystroke; single-select
        // auto-advances on digit OR on Enter after arrow-nav (verified
        // empirically for digit; arrow-nav variant pinned by #4848).
        sequence.push('\t')
      }
    }
    // #4635 — when the LAST question is single-select, insert a settling
    // delay before the Submit keystroke. The last digit auto-advances to
    // the Submit screen, but the 1ms per-char throttle races claude TUI's
    // render of that screen so the trailing '1' lands on the still-
    // rendering last-question screen and gets swallowed (the wedge the
    // issue documents). Mixed forms ending in multi-select don't need
    // this — the explicit '\t' already settles the form.
    // #4883 — tighten the lastIsSingleSelect detection so an unexpected TUI
    // question shape surfaces in logs instead of silently picking a branch.
    // Today's TUI omits `multiSelect` on single-select questions and sets it
    // to `true` on multi-select; any other shape (string, null, number, a
    // hypothetical future field rename) is treated as "assume single-select
    // for settle purposes" — but we log a WARN so the shape drift is visible.
    //
    // The "drift" check uses `'multiSelect' in lastQuestion` rather than
    // `!== undefined` so it also catches the in-code pathological case
    // `{ multiSelect: undefined }` (Copilot review on #4902): the key is
    // present but the value isn't boolean — that's still drift worth
    // surfacing, since wire-deserialized shapes can't produce that pattern
    // (JSON.stringify drops undefined-valued keys) but in-code shapes can.
    const lastQuestion = questions.length > 0 ? questions[questions.length - 1] : null
    if (lastQuestion && 'multiSelect' in lastQuestion && typeof lastQuestion.multiSelect !== 'boolean') {
      ;(this._log || log).warn(`AskUserQuestion multi-question: last question has non-boolean multiSelect=${JSON.stringify(lastQuestion.multiSelect)} (q="${(lastQuestion.question || '').slice(0, 40)}") — assuming single-select for settle (#4883)`)
    }
    const lastIsSingleSelect = !!(lastQuestion && lastQuestion.multiSelect !== true)
    if (lastIsSingleSelect) {
      sequence.push(MULTI_QUESTION_SUBMIT_SETTLE_MS)
    }
    // Focus lands on `❯ 1. Submit answers / 2. Cancel` after the last
    // question — press 1 to confirm submission.
    // #4884: tag the Submit position with a marker object so
    // _writePtyMultiQuestionSequence can record the wall-clock at the
    // point the writer reaches Submit (immediately before the `'1'` is
    // written to the PTY, after any preceding settle has elapsed). Used
    // by _emitToolHookEvent's PostToolUse handler to log the
    // Submit→PostToolUse delta — the marker timestamp is the lower bound
    // for when '1' actually leaves the writer (within
    // PROMPT_CHAR_DELAY_MS of the actual write).
    if (prevToolUseId) {
      sequence.push({ type: 'mark', label: 'submit', toolUseId: prevToolUseId })
    }
    sequence.push('1')
    // #4635 — trailing Enter after the Submit `'1'`.
    // #4882 (resolved 2026-06-07): the all-single-select recorder pass
    // (docs/empirical/4882-all-single-select-2q.jsonl) confirmed a human
    // submits the Submit screen with `'1'` ALONE — the trailing `\r` is
    // NOT required (the Submit screen commits on the digit, same as the
    // mixed-form recording and the single-q path's redundant Enter pinned
    // in #4290). The `\r` is RETAINED as confirmed-harmless belt-and-braces:
    // it lands ~1ms after Submit-'1' (per-char throttle) on a form that has
    // already committed, and #4884's Submit→PostToolUse forensics show it
    // arriving without disrupting the round-trip. Kept (not removed) because
    // the recording covered only the 2-question all-single-select shape and
    // this push also feeds the mixed and 3+q paths, which were not re-recorded.
    sequence.push('\r')

    const keystrokeCount = sequence.filter((x) => typeof x === 'string').length
    ;(this._log || log).info(`AskUserQuestion multi-question: tool=${prevToolUseId || '?'} questions=${questions.length} keystrokes=${keystrokeCount} haveAnswersMap=${haveMap}`)

    this._writePtyMultiQuestionSequence(sequence).catch((err) => {
      // #4828: session-scoped.
      ;(this._log || log).warn(`respondToQuestion multi-question PTY write failed: ${err.message} (tool=${prevToolUseId || '?'})`)
    })
    armWatchdog()
  }

  /**
   * Write a sequence of single-char keystrokes (digits, Tab, etc.) to
   * the PTY for the multi-question AskUserQuestion form driver
   * (#4604 Chunk B). The sequence is wrapped in bracketed-paste-disable /
   * re-enable exactly once (same defense as _writePtyTextThrottled) and
   * every char is throttled by PROMPT_CHAR_DELAY_MS so claude TUI's
   * paste detector doesn't reject the rapid digit burst. Unlike
   * _writePtyTextThrottled this writer does NOT append \r — the form
   * driver supplies its own navigation keys (Tab between multi-select
   * questions, '1' at Submit).
   *
   * #4635 — sequence entries may be either strings (chars to write) or
   * numbers (ms to sleep). Numeric entries let the driver insert a
   * render-settling pause between keystrokes (e.g. the Submit screen
   * needs a beat after the last single-select auto-advance — see
   * MULTI_QUESTION_SUBMIT_SETTLE_MS).
   *
   * #4884 — sequence entries may also be `{ type: 'mark', label, toolUseId }`
   * marker objects. Markers are not written to the PTY; they record the
   * wall-clock at the point the writer reaches them (after any preceding
   * settle has elapsed but BEFORE the next byte is written) into
   * `_multiQuestionSubmitAt`. PostToolUse for that toolUseId logs the
   * delta — forensic evidence the defensive trailing '\r' lands harmlessly.
   *
   * @param {Array<string|number|{type:'mark',label:string,toolUseId:string}>} sequence — strings to write, numbers to sleep, marker objects to timestamp
   * @returns {Promise<boolean>} true if completed, false if PTY aborted mid-write
   */
  async _writePtyMultiQuestionSequence(sequence) {
    if (!this._term) return false
    this._term.write('\x1b[?2004l')
    try {
      for (const item of sequence) {
        if (this._activeTurn?.aborted || this._ptyExited) return false
        if (typeof item === 'number') {
          if (item > 0) await new Promise((resolve) => setTimeout(resolve, item))
          continue
        }
        if (item && typeof item === 'object' && item.type === 'mark') {
          // #4884 — record submit-time marker for the PostToolUse delta log.
          if (item.label === 'submit' && item.toolUseId) {
            this._multiQuestionSubmitAt.set(item.toolUseId, Date.now())
          }
          continue
        }
        this._term.write(item)
        if (ClaudeTuiSession.PROMPT_CHAR_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, ClaudeTuiSession.PROMPT_CHAR_DELAY_MS))
        }
      }
      return true
    } finally {
      try { this._term.write('\x1b[?2004h') } catch {}
    }
  }

  /**
   * Write an arrow-key navigation sequence for the single-question
   * AskUserQuestion form when the user picked an option beyond the
   * single-digit hotkey range (idx >= 9). Emits `targetIdx` Down arrow
   * keystrokes (`\x1b[B`, 3 bytes each) — claude TUI's form cursor
   * starts at idx 0, so `targetIdx` downs land on the picked option —
   * followed by Enter (`\r`) to commit (#4848).
   *
   * Wrapped in bracketed-paste-disable / re-enable exactly once (same
   * defense as _writePtyTextThrottled and _writePtyMultiQuestionSequence).
   * A PROMPT_CHAR_DELAY_MS pause runs BETWEEN each Down-arrow write so
   * claude TUI's paste detector doesn't reject the burst. The trailing
   * Enter (`\r`) and the bracketed-paste re-enable write fire
   * immediately after the final delay — no extra pause separates them
   * from the last arrow (the arrival rate at that point is already well
   * under any reasonable paste threshold). Each arrow is one `_term.write`
   * call (3 bytes); 10 arrows ≈ 30 bytes total form-byte payload.
   *
   * **Empirically unreachable (#4880, 2026-06-07):** the recorder pass
   * against a 10+ option AskUserQuestion ran and found the form can't be
   * produced — claude TUI v2.1.168 hard-caps each AskUserQuestion question
   * at 4 options (the call fails server-side with
   * `InputValidationError: too_big, maximum: 4` before any form renders;
   * see docs/empirical/4880-twelve-option-cap.jsonl). So this writer is
   * currently DEAD CODE on real AskUserQuestion forms, kept as forward-compat
   * for a future TUI that raises the cap. The `\x1b[B` + `\r` sequence is the
   * conservative bet (multi-digit chord '1','0' was ruled out — the digit
   * hotkey auto-commits on the first keystroke); it could not be confirmed
   * because the form is unproducible. Revisit if/when the option cap rises.
   *
   * @param {number} targetIdx — 0-indexed option to land on
   * @returns {Promise<boolean>} true if completed, false if PTY aborted mid-write
   */
  async _writePtyArrowNavSequence(targetIdx) {
    if (!this._term) return false
    if (typeof targetIdx !== 'number' || targetIdx < 0) return false
    this._term.write('\x1b[?2004l')
    try {
      for (let i = 0; i < targetIdx; i++) {
        if (this._activeTurn?.aborted || this._ptyExited) return false
        this._term.write('\x1b[B')
        if (ClaudeTuiSession.PROMPT_CHAR_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, ClaudeTuiSession.PROMPT_CHAR_DELAY_MS))
        }
      }
      if (this._activeTurn?.aborted || this._ptyExited) return false
      this._term.write('\r')
      return true
    } finally {
      try { this._term.write('\x1b[?2004h') } catch {}
    }
  }

  /**
   * Watchdog handler for an AskUserQuestion answer that claude TUI never
   * acknowledged via PostToolUse (#4604). Multi-question forms render a
   * per-question form needing more than the single digit chroxy writes,
   * leaving _isBusy=true forever. We tear the turn down end-to-end and
   * surface a structured error so the dashboard renders a retry prompt
   * AND the Working banner / Stop button clear immediately.
   *
   * Pre-#4645 this only cleared `_isBusy` + emitted the stall error,
   * leaving `stream_start` orphaned (no matching `stream_end`) and no
   * `result` for the event-normalizer to fan into `agent_idle`. The
   * dashboard kept showing "Working… Ns ago" + Stop forever (until the
   * 5-min #4638 stream-stall watchdog or the 2h hard cap eventually
   * cleaned up) even though the agent had already given up. Worse: the
   * red error toast told the user to retry, but the Stop button was up
   * and the input box read "Type to send follow-up…" — there was no
   * Send affordance to retry FROM.
   *
   * Now: best-effort Ctrl-C into the TUI (so `claude` itself unsticks
   * from the form screen for the next turn) → emit `stream_end` →
   * `_emitResult` (sweeps orphan tool_starts and fans `result` →
   * `agent_idle` via the event-normalizer, clearing both Working banner
   * and Stop) → emit `error{code:'ASK_USER_QUESTION_STALL'}` last so the
   * dashboard surfaces the user-facing toast AFTER state has settled.
   *
   * Shape mirrors `_handleStreamStall` and `_handleHardTimeout` (which
   * delegate to `_teardownTurn` per #4641). This path is NOT folded into
   * `_teardownTurn` because it has additional side-effects (synthetic
   * `tool_result` emit, clears all three inactivity timers, error
   * payload carries `toolUseId`) that don't generalise to the other two
   * teardown sites — bringing it in would either widen the helper's
   * surface or split the call into multiple stages, neither of which
   * earns its complexity today.
   *
   * No-ops on destroyed sessions and on sessions where PostToolUse
   * already arrived (would have cleared _pendingUserAnswer + busy state
   * in the normal flow before the watchdog timer fired).
   */
  _onAskUserQuestionStall(toolUseId) {
    if (this._destroying) return
    if (!this._pendingUserAnswer && !this._isBusy) return

    this._assertBusyHasMessageId('_onAskUserQuestionStall')
    // #4828: session-scoped — stall watchdog fires strictly post-start.
    ;(this._log || log).warn(`AskUserQuestion stall: tool=${toolUseId} — claude TUI never emitted PostToolUse after answer write (${ASK_USER_QUESTION_WATCHDOG_MS}ms). Likely a multi-question form (#4604). Tearing down turn so the session is recoverable.`)

    this._teardownAskUserQuestion(toolUseId, {
      synthResult: 'AskUserQuestion stalled — no response from claude TUI within 30s. Likely a multi-question form (#4604).',
      emitResultReason: 'ask_user_question_stall',
      errorCode: 'ASK_USER_QUESTION_STALL',
      // #4648: dropped the "likely a multi-question form" jargon. The
      // permission-hook deny path (also #4648) prevents most multi-question
      // forms from reaching this code path at all, and for the cases that
      // slip through, the user doesn't care about chroxy internals — they
      // care about how to recover. The new copy is action-oriented.
      errorMessage: 'Couldn\'t deliver your answers. Tap Retry to resend your original request.',
    })
  }

  /**
   * Shared teardown for AskUserQuestion failure modes. Used by both the
   * 30s post-write stall watchdog (#4604) and the up-front
   * too-many-options detector (#4625). Mirrors the end-to-end teardown
   * order pinned in #4645: synthetic tool_result → Ctrl-C the TUI →
   * clear inactivity timers → null active turn / busy state →
   * stream_end + _emitResult → error event last. The caller supplies the
   * synth result text, _emitResult reason tag, and error code/message so
   * the same teardown serves both call sites.
   *
   * Splitting this out (vs the original inline form in
   * _onAskUserQuestionStall) is intentional: #4625's too-many-options
   * path needs the full teardown so the dashboard's Working banner +
   * Stop button + activeTools entry all clear immediately, but the
   * trigger and copy differ from the 30s stall path. Inlining the
   * teardown twice risked drift; folding both into _teardownTurn would
   * widen the helper's surface (synth tool_result + 3-timer clear +
   * toolUseId-carrying error don't generalise to the other teardown
   * sites), so a dedicated AskUserQuestion teardown helper earns its
   * keep.
   */
  _teardownAskUserQuestion(toolUseId, { synthResult, emitResultReason, errorCode, errorMessage }) {
    const messageId = this._currentMessageId
    const duration = this._activeTurn ? Date.now() - this._activeTurn.startedAt : 0

    // #4691: surgical clear — drop ONLY the entry for the tool that
    // timed out. The other teardown sites (_finishTurnError, hard
    // timeout via _teardownTurn, interrupt, destroy) end the whole
    // turn, so wiping the whole Map there is correct. The watchdog is
    // different: it knows the exact toolUseId that wedged (passed to
    // setTimeout in respondToQuestion) and the rest of the turn is
    // still live — sibling AskUserQuestion entries armed by parallel
    // PreToolUse blocks can still see a PostToolUse arrive. Falling
    // back to `_pendingUserAnswer = null` here would re-trigger the
    // back-compat setter → `_pendingUserAnswers.clear()` and wipe
    // those siblings under their own still-live turns, re-introducing
    // the #4668-class state-shape mismatch (dashboard cleared the
    // QuestionPrompt UI when it sent the answer, but the server-side
    // Map is empty — a late retry-as-singles answer with toolUseId B
    // would hit the "no matching pending entry — dropping" path and
    // wedge the next form silently).
    this._clearPendingAnswerByToolUseId(toolUseId)
    this._clearAskUserQuestionLock()
    // #4616: emit a synthetic tool_result FIRST so the dashboard's
    // activeTools entry for this AskUserQuestion is cleared. Without it
    // the footer "Running AskUserQuestion · Ns" pill keeps ticking
    // forever even though _isBusy is clear and the user sees the error
    // toast. The handler ignores any fields beyond {toolUseId, result,
    // truncated, images} (see store-core handleToolResult); pairing-by-
    // toolUseId is what drives the activeTools removal in store-core handlers.
    this.emit('tool_result', {
      toolUseId,
      result: synthResult,
      truncated: false,
    })
    // #4628: matching tool_start resolved — drop from the in-flight map.
    this._trackToolResult(toolUseId)

    // #4645: best-effort Ctrl-C so claude TUI itself unsticks from the
    // form screen. Without this the next sendMessage's prompt write
    // would queue behind the still-displayed form and silently desync.
    // Mirrors _handleStreamStall / _handleHardTimeout.
    if (this._term) {
      try { this._term.write('\x03') } catch { /* ignore */ }
    }

    // Clear all four inactivity timers — turn is over, nothing to
    // backstop, leaving them armed would fire stale callbacks on a
    // session that's already idle.
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    // #4732: pre-first-output watchdog. AskUserQuestion only fires
    // mid-turn (post-stream_start), so the first-output watchdog has
    // typically been disarmed already, but clear it explicitly so a
    // pathological race can't leak a live handle past the stall.
    this._clearFirstOutputWatchdog()

    // #4022: drop per-turn attachment dir (same as the other teardown
    // paths) so a failed turn doesn't leak materialized files until destroy().
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null

    // #4645: pair the stream_start fired at turn-start with stream_end +
    // result so the dashboard's streamingMessageId + Working banner +
    // Stop button all clear immediately (event-normalizer turns result
    // into result + agent_idle). The if-guard mirrors _handleStreamStall
    // — silent skip is acceptable here because the only way messageId
    // is null is a contract violation (_isBusy=true without an active
    // turn), tracked in #4642.
    if (messageId) this.emit('stream_end', { messageId })
    this._emitResult(
      { cost: null, duration, usage: null, sessionId: this._sessionId },
      emitResultReason,
    )
    this.emit('error', {
      code: errorCode,
      message: errorMessage,
      toolUseId,
    })
  }

  async destroy() {
    this._destroying = true
    this._processReady = false
    this._isBusy = false
    this._activeTurn = null
    // #4278 / #4802: drop any pending AskUserQuestion so a late
    // user_question_response can't write into a dead PTY. Explicit
    // `_pendingUserAnswers_clearAll()` (was an implicit
    // `_pendingUserAnswer = null` → Map.clear() via the back-compat
    // setter). Unambiguous here: destroy() SIGTERMs the PTY below and
    // nulls `_term`, so every pending entry is permanently unservable.
    this._pendingUserAnswers_clearAll()
    this._clearAskUserQuestionLock()
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    // #4638: clear the stream-stall watchdog on destroy too — otherwise
    // a late fire could land in _handleStreamStall after _term is null,
    // skipping the Ctrl-C path but still emitting events into a dead session.
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    // #4732: same reasoning for the pre-first-output watchdog — a late
    // fire post-destroy must not emit a stream_stall error into a torn-
    // down listener set or write Ctrl-C into a killed PTY.
    this._clearFirstOutputWatchdog()
    // #4604: cancel the AskUserQuestion stall watchdog so it can't fire
    // a stale ASK_USER_QUESTION_STALL event into a torn-down listener.
    if (this._askUserQuestionWatchdog) {
      clearTimeout(this._askUserQuestionWatchdog)
      this._askUserQuestionWatchdog = null
    }
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
    // #4307: drop any pending background-shell entries so the session-
    // list snapshot doesn't carry phantom entries past destroy. Done
    // after _clearMessageState (which preserves the pending shells —
    // the #4307 core invariant); the explicit destroy hook is the only
    // path that removes them.
    this._destroyPendingBackgroundShells()
  }
}
