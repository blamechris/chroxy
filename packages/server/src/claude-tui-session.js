import { randomBytes, randomUUID } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
// #6132 (HOL fix from #5337): the per-turn hook-drain hot path uses async fs so a
// slow/stuck sink (FUSE/NFS, full disk, tmpwatch race) can't block the shared
// event loop — which would freeze EVERY claude-tui session (the default provider).
import { readdir, readFile, unlink } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { CLAUDE_TUI_PTY_SIZE } from '@chroxy/protocol'
// #5417 — the TUI shares CliSession's pinned "unknown resume id" patterns
// (RESUME_UNKNOWN_STDERR_PATTERNS, #4929/#4950) via this matcher: the PTY
// merges stdout+stderr, so claude's resume rejection lands in _outputTail.
import { stderrIndicatesUnknownResume } from './cli-session.js'
import { ALLOWED_MODEL_IDS } from './models.js'
import { CLAUDE_FALLBACK_MODELS, claudeModelMetadata } from './claude-model-catalog.js'
import { RespawnRateLimiter } from './utils/respawn-rate-limiter.js'
import { CHROXY_SECRET_DENYLIST } from './utils/spawn-env.js'
import { createLogger, loggerForSession, redactSensitive, redactSensitivePreservingEscapes } from './logger.js'
import { formatIdleDuration } from './session-timeout-manager.js'
import { isOperatorTimeoutInRange } from './duration.js'
import { materializeAttachments, buildAttachmentsPromptSuffix } from './claude-tui-attachments.js'
import { TranscriptTaskScanner, transcriptPathForSessionFile } from './transcript-tasks.js'
import { hasClaudeOAuthCreds } from './auth-probes.js'
import { BILLING_CLASSES } from './billing-class.js'
import {
  parseBackgroundShellId,
  parseBackgroundShellOutputPath,
  isRunInBackgroundInput,
  parseBashOutputShellId,
} from './background-shells.js'
// #5559 — PTY-write / paste-throttle layer + interactive-form driver carved out
// into focused modules. The empirically-pinned helpers, constants and methods
// are moved byte-identically; the *Mixin classes carry the write/form methods,
// applied onto ClaudeTuiSession.prototype via applyMixin() below.
import {
  ANSI_STRIP,
  formatHexDump,
  CLAUDE,
  AUTH_FAILURE_PATTERNS,
  AUTH_REQUIRED_CODE,
  AUTH_REQUIRED_MESSAGE,
  ensureCwdTrusted,
  writeHookSettings,
  PtyDriverMixin,
} from './claude-tui/pty-driver.js'
import {
  ASK_USER_QUESTION_WATCHDOG_MS,
  FormDriver,
  multiSelectReinjectEnabled,
} from './claude-tui/form-driver.js'

// Re-export the public writeHookSettings helper so existing
// `import { writeHookSettings } from './claude-tui-session.js'` callers (and the
// permission-hook test) keep working unchanged after the #5559 split.
export { writeHookSettings }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const log = createLogger('claude-tui-session')

// #5792: how long a DENIED-shape AskUserQuestion pending entry may linger past
// turn-end before the reaper drops it. Derived from (not a re-declared copy of)
// the stall-watchdog window so the two can't drift: long enough for any
// in-flight teardown / reinject to clear the entry on its own (making the reaper
// a no-op), short enough that a leaked entry can't shadow the most-recent
// fallback for long. Same recovery-window class as the answer stall.
const DENIED_QUESTION_REAPER_MS = ASK_USER_QUESTION_WATCHDOG_MS

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

/**
 * #6178: bound an fs promise so a stuck mount can't hold it open forever. Races
 * `promise` against a timer that rejects with a tagged `HOOK_FS_TIMEOUT` error
 * after `ms`. The timer is `unref`'d (never keeps the process alive) and cleared
 * on settle (no leak on the happy path). Used only on the hot-path hook-drain
 * fs ops. Exported for unit testing.
 */
export function withHookFsTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`hook-fs ${label} timed out after ${ms}ms`)
      err.code = 'HOOK_FS_TIMEOUT'
      reject(err)
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class ClaudeTuiSession extends BaseSession {
  // #5858: Claude-family flag — single source of truth for isClaudeProvider().
  // This is the DEFAULT_PROVIDER, so its membership is load-bearing (#5855).
  static claudeFamily = true

  // #5984 (epic #5982): this IS the claude-tui PTY mirror — the only legitimate
  // target for server-initiated PTY writes (mailbox wakeup) and the Control
  // Room isTui flag. See BaseSession.isClaudeTui for why this is a positive
  // discriminator rather than `typeof writeTerminalInput` duck-typing.
  static get isClaudeTui() {
    return true
  }

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
      // #5609: the sidecar rewrite above means a mid-turn switch to 'auto'
      // takes effect on the next tool call WITHOUT a PTY restart — the
      // running turn survives. False keeps the matrix uniform; only CliSession
      // interrupts the turn on the auto-switch.
      interruptsTurnOnAutoSwitch: false,
      planMode: false,
      // #5307 (WP-0.1) — the TUI now persists its upstream conversation uuid
      // (get resumeSessionId) and, on restore, respawns claude with
      // `--resume <id>` so the conversation continues across daemon restart /
      // upgrade / crash-recovery instead of silently starting a fresh chat.
      resume: true,
      terminal: false,
      thinkingLevel: false,
      streaming: false,
      tools: true,
      // #5791 — advertise whether the server will actually honor a single
      // multi-select AskUserQuestion (the #5776 reinject path, gated by
      // CHROXY_TUI_MULTISELECT_REINJECT, default OFF). Clients gate the
      // checkbox-form affordance on this so they don't render a form the
      // server is wired to refuse. Read at access time (listProviders is
      // called per connection), so it reflects the daemon's env.
      multiSelectReinject: multiSelectReinjectEnabled(),
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
   * routes via the OAuth subscription. #5321 (WP-4.1): best-effort on-disk
   * probe instead of the old hardcoded `ready:true`, via the shared
   * `hasClaudeOAuthCreds()` (#3674), which covers all known on-disk stores
   * (`~/.claude/auth.json`, `~/.claude/.credentials.json`, the `claudeAiOauth`
   * block in `~/.claude.json`) and honours `CHROXY_CLAUDE_HOME` /
   * `CHROXY_CLAUDE_CONFIG`. macOS stores the token in the Keychain (no file),
   * so a miss there is inconclusive. Hence:
   *   - creds found on disk            → ready (authenticated)
   *   - absent on darwin               → can't rule out Keychain → ready, flagged
   *   - absent on non-darwin           → logged out → ready:false + `claude login`
   * This is a pre-spawn hint only; the AUTHORITATIVE check is the runtime warmup
   * classifier (#5321), which surfaces AUTH_REQUIRED at session start on every
   * platform regardless of where the token lives.
   *
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth() {
    const envVars = this.preflight.credentials.envVars
    const hasFileCreds = hasClaudeOAuthCreds()
    if (hasFileCreds) {
      return {
        ready: true,
        source: 'oauth',
        envVar: null,
        envVars,
        hint: 'authenticated — Claude OAuth credentials found on disk',
        detail: 'Claude subscription (OAuth credentials on disk)',
        // TUI is an interactive PTY that bypasses programmatic credit metering
        // — flat subscription billing in both eras (#5629 leaves this UNCHANGED).
        billingClass: BILLING_CLASSES.SUBSCRIPTION,
      }
    }
    const keychainPossible = process.platform === 'darwin'
    return {
      // On macOS the token lives in the Keychain (unreadable here), so absence of
      // the file does NOT prove logged-out — stay ready but flag it. On other
      // platforms the file is the only store, so absence means logged out.
      ready: keychainPossible,
      source: 'oauth',
      envVar: null,
      envVars,
      hint: keychainPossible
        ? 'auth not verifiable on disk (macOS Keychain) — run `claude login` if a session reports AUTH_REQUIRED'
        : 'run `claude login` — no Claude OAuth credentials found (subscription required; ANTHROPIC_API_KEY is not accepted)',
      detail: keychainPossible
        ? 'Claude subscription (OAuth in macOS Keychain — not on-disk-verifiable; runtime AUTH_REQUIRED is authoritative)'
        : 'Claude subscription — no on-disk OAuth credentials found (logged out)',
      billingClass: BILLING_CLASSES.SUBSCRIPTION,
    }
  }

  static getFallbackModels() {
    return CLAUDE_FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  static getModelMetadata(modelId) {
    return claudeModelMetadata(modelId)
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
    // #5315 (WP-2.1) — `respawn_exhausted` is emitted by `_scheduleRespawn`
    // when bounded PTY auto-respawn gives up (max attempts reached). WHY it's a
    // custom event and not just an `error`: SessionManager keys its
    // drop-the-session-from-the-list coordination on this distinct signal
    // (`_wireSessionEvents` calls destroySession on it) so the session leaves
    // the list with a clear error instead of lingering as an input-rejecting
    // zombie tab. Listing it here also forwards it to paired clients as a
    // transient `session_event` so the dashboard can surface the give-up reason.
    return ['multi_question_intervention', 'respawn_exhausted']
  }

  constructor(opts = {}) {
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-tui' }))
    // ClaudeTuiSession-local opts (not BaseSession opts — see buildBaseSessionOpts).
    const { port, firstOutputTimeoutMs, skipPermissions, resumeSessionId, monotonicNow } = opts

    // #5332: monotonic clock for turn-duration logging and watchdog poll-loop
    // deadlines (hook poll, waitForPrompt, PTY write). Wall-clock (Date.now())
    // jumps backward on laptop sleep / NTP step, which can make a `while
    // (Date.now() - start < timeout)` deadline never expire (hang) or expire
    // early (false stall). performance.now() is monotonic — immune to both.
    // Truncated to integer ms so it is a drop-in for the Date.now() deltas the
    // instrumentation logs already print. Injectable so tests can step the
    // clock backward and prove the watchdogs don't false-fire. Date.now() is
    // retained ONLY where a real wall-clock epoch is required (file mtime
    // comparison, timestamp payloads to clients, log-throttle bookkeeping).
    // Truncate at the seam (not just the default) so the integer-ms invariant
    // holds for an injected clock too — `performance.now()` and a test clock
    // may both be fractional.
    const rawMonotonicNow = typeof monotonicNow === 'function' ? monotonicNow : () => performance.now()
    this._monotonicNowFn = () => Math.trunc(rawMonotonicNow())

    // #6178: per-call bound for the hot-path hook-drain fs ops. #6132 made the
    // drain async so a stuck sink fs can't block OTHER sessions; this bound lets
    // the stuck session ITSELF self-recover — a hung readdir/readFile/unlink
    // rejects after this many ms so the poll loop re-checks its hard-timeout
    // guard instead of awaiting a frozen mount forever. Overridable in tests.
    this._hookFsTimeoutMs = ClaudeTuiSession.HOOK_FS_TIMEOUT_MS
    // #6178 (review): a timed-out fs op can't be canceled — it stays pending in
    // the libuv threadpool. Re-issuing it every poll pass would pile up stuck
    // work and exhaust the shared 4-thread pool, reintroducing the cross-session
    // impact #6132 fixed. So coalesce: keep ONE outstanding op per (kind,path)
    // and re-race the SAME promise each pass until it settles (see _boundedHookFs).
    this._inFlightHookFs = new Map()

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
    // #5307 (WP-0.1) — seed the upstream conversation uuid from the persisted
    // resume id (SessionManager.restoreState passes it through from the saved
    // sdkSessionId). When present, start() reuses it and spawns claude with
    // `--resume <id>` so the conversation continues across restart; when absent
    // (fresh session, or an older state file) it stays null and start() mints a
    // new uuid spawned with `--session-id <id>`, exactly as before. Provider-
    // local — NOT a BaseSession opt, so it is not forwarded via super() (matches
    // CliSession's seeding pattern, cli-session.js:333).
    this._sessionId = (typeof resumeSessionId === 'string' && resumeSessionId.length > 0)
      ? resumeSessionId
      : null   // upstream claude conversation uuid, assigned at start() when fresh
    this._resumedFromPersisted = this._sessionId !== null
    // #5348 — remember whether this session was SEEDED from a persisted resume
    // id. `_resumedFromPersisted` flips to true on every respawn (the respawn
    // must `--resume` the live conversation), so later code can't use it to
    // tell a restored session from an originally-fresh one. #5417: no longer
    // the retry-FRESH eligibility gate (the PTY-tail classification in
    // _scheduleRespawn is — claude itself must report the conversation id as
    // unknown); kept to word the resume_unknown message honestly (restored =
    // "the persisted conversation is gone from this machine" vs fresh = "it
    // was likely never persisted before the PTY died").
    this._seededFromPersisted = this._resumedFromPersisted
    // #5348 — one-shot latch for the retry-FRESH fallback (mirrors
    // cli-session.js's `_didFallbackFromUnknownResume`). Re-armed by a respawn
    // that survives warmup, so a FUTURE doomed-resume window can fall back
    // again; the #5349 rolling rate cap bounds any flapping alternation.
    this._didFallbackFromUnknownResume = false
    // #5348 — set by _scheduleRespawn when the next respawn attempt must spawn
    // FRESH (`--session-id` with the newly-minted uuid) instead of `--resume`.
    // Consumed (cleared) by _respawnPty before the spawn.
    this._freshRetryPending = false
    // #5348 — the conversation uuid abandoned by the retry-FRESH fallback,
    // surfaced as `attemptedResumeId` on the terminal resume_unknown_exhausted
    // emit (by then `_sessionId` is already the replacement uuid).
    this._abandonedResumeId = null
    // #4792: session-scoped logger. Assigned in start() once _sessionId is
    // generated. Until then, code paths that need to log MUST fall back to
    // the module-level `log` (e.g. trust pre-write failure, sink dir create
    // failure). Per-session log lines (sendMessage, respondToQuestion,
    // attachment materialization) prefer `this._log` so the WsServer log
    // listener can route them to the right bound client (#4787, #4793).
    this._log = null
    this._sinkDir = null     // created on start, removed on destroy
    this._sinkRecoverErrLoggedMs = 0  // #5329: throttle the can't-recreate error log
    this._sinkTransientWarnLoggedMs = 0  // #5329: throttle the dir-exists-but-readdir-failed warn
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
    // #5321 (WP-4.1) — latched true when warmup classifies claude's output as a
    // logged-out / expired-login failure, so start() rejects with AUTH_REQUIRED.
    this._authFailureDetected = false
    // #5315 (WP-2.1) — bounded per-session PTY auto-respawn state, mirroring
    // CliSession (cli-session.js:351). WHY: when the persistent claude PTY dies
    // unexpectedly mid-session, `_onPtyGone` used to tear the session down into
    // a permanently input-rejecting zombie (every later sendMessage rejected
    // "no longer alive"). The TUI provider is becoming the PRIMARY backend, so
    // it must self-heal like CliSession does. Backoff [1s,2s,4s,8s,15s], max 5
    // attempts, then `respawn_exhausted` (SessionManager drops the session).
    this._respawnCount = 0
    this._respawnTimer = null
    this._respawnScheduled = false
    this._respawning = false
    // #5349: a rolling-window cap INDEPENDENT of `_respawnCount` (which resets
    // on every warmup that survives — see _onWarmupComplete). A session that
    // dies shortly after each successful warmup flaps forever under the
    // consecutive cap alone; this gives up once it exceeds the window cap
    // regardless of warmup success. Mirrors the same guard in CliSession.
    this._respawnRateLimiter = new RespawnRateLimiter()
    // #5317 (WP-2.3) — SIGKILL escalation timer armed by destroy() after SIGTERM.
    // Cleared by _onPtyGone the moment the process is confirmed gone (which also
    // closes the pid-reuse window — we only force-kill when onExit never fired).
    this._killTimer = null
    // Ring buffer of recent PTY output bytes — surfaces in error
    // messages when the TUI renders a diagnostic (rate-limit, auth
    // failure, "switch back to API mode") that would otherwise be
    // silently dropped (#3919). Kept small (~4KB) so it doesn't eat
    // memory on long sessions.
    this._outputTail = ''
    // #5794: monotonic count of ALL PTY output bytes ever appended. Unlike
    // _outputTail (capped at PTY_TAIL_BYTES, so its length stops growing once
    // full — e.g. after a long resume transcript), this keeps growing, so the
    // first-turn nudge can detect "output arrived since arm" even when the tail
    // is already at the cap (#5809 review).
    this._totalOutputBytes = 0
    // #4031 (review): _outputTail is ANSI-stripped for readability +
    // probe stability, so the hex-dump diagnostic sourced from it
    // could never surface the very escape/control bytes we wanted to
    // see when the probe missed. Keep an UNSTRIPPED parallel tail —
    // sized in real bytes via Buffer — exclusively for the hex dump
    // so 0x1b/OSC/SS3 sequences land in the log. node-pty returns
    // UTF-8 strings already decoded, but the relevant control bytes
    // are 7-bit ASCII and survive the decode unchanged.
    this._outputTailRaw = Buffer.alloc(0)
    // #6601: PTY output-quiescence readiness signal. `_lastOutputMs` is the
    // monotonic time of the most recent onData chunk; `_sawFirstOutput` gates the
    // signal until claude has actually rendered something on THIS spawn (so the
    // `now - 0` at init doesn't read as "already quiescent"). Together (checkReady)
    // they detect a settled composer when no ~/.claude/sessions file exists.
    this._lastOutputMs = 0
    this._sawFirstOutput = false
    // #5835 Phase 1: live remote-viewer mirror. PTY onData fires very frequently
    // during a TUI redraw, so coalesce bytes into a buffer and flush one
    // `terminal_output` event per tick (MIRROR_FLUSH_MS) — bounding the broadcast
    // rate to the tunnel rather than emitting per byte. Buffer + timer are reset
    // on flush and cleared on teardown.
    this._mirrorBuffer = ''
    this._mirrorTimer = null
    // #5837: gate the coalescer on having ≥1 subscriber. The mirror is OFF until a
    // client opts in (terminal_subscribe), so a claude-tui session nobody is
    // watching pays nothing per PTY redraw (no string concat, no timer, no
    // session_event). WsServer toggles this via setTerminalMirrorActive when the
    // terminal-subscriber count for the session crosses 0↔1 (subscribe / unsubscribe
    // / client departure). Forward-only: a subscriber sees redraws from when it
    // subscribed onward — same as Phase 1, the mirror was never a snapshot.
    this._terminalMirrorActive = false
    // #5835 Phase 2: the live PTY's current grid size. Spawns at the shared
    // default and tracks every applied resize so a respawn re-spawns at the
    // operator's chosen size (not back to the default), and so a newly-
    // subscribing viewer can be told the authoritative size to letterbox to.
    this._ptyCols = CLAUDE_TUI_PTY_SIZE.cols
    this._ptyRows = CLAUDE_TUI_PTY_SIZE.rows
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
    // #5617 — the interactive-form driver is an injected collaborator rather than
    // a prototype mixin; it reaches session state/PTY writers through `this` as
    // its host. `respondToQuestion` (below) delegates to it; the stall watchdog
    // calls `this._formDriver._onAskUserQuestionStall`.
    this._formDriver = new FormDriver(this)
    // #4604 / #5319 (WP-3.2): per-toolUseId stall watchdogs armed in
    // respondToQuestion(). If PostToolUse never arrives after we write an answer
    // (multi-question form wedge), the matching watchdog fires
    // _onAskUserQuestionStall to clear busy state + emit an error so the session
    // is recoverable. Keyed by toolUseId (mirrors the #4668 _pendingUserAnswers
    // Map) so PARALLEL AskUserQuestion calls each get an independent watchdog —
    // answering / stalling one no longer disarms the others. Cleared per-id on
    // PostToolUse and cleared wholesale on the turn-ending paths + destroy().
    this._askUserQuestionWatchdogs = new Map()
    // #5792: denied-shape AskUserQuestion reapers, keyed by toolUseId. A
    // multi-question (questions.length > 1) or multi-select (any question
    // multiSelect:true) AskUserQuestion is DENIED at the permission hook, so
    // claude blocks → Stops with no PostToolUse. The Stop success path
    // (_clearTurnEndState) clears the sibling lock + stall watchdogs but
    // deliberately NOT _pendingUserAnswers (a legit sibling answer may still be
    // in flight — see _pendingUserAnswers_clearAll's doc). For a denied shape
    // there is NO legit answer coming, so that pending entry leaks: a later
    // no-toolUseId respondToQuestion would misroute to it via the most-recent
    // back-compat fallback. This reaper, armed ONLY for denied shapes at
    // pending-creation, drops the still-leaked entry after a short window. It is
    // deliberately keyed/cleared per toolUseId and does NOT touch the global
    // askuserquestion-active lock (already cleared at the denied turn's Stop; a
    // later turn may own a fresh lock by the time the reaper fires).
    this._deniedQuestionReapers = new Map()
    // #5798: observability-only marker for the multi-select reinject "stop and
    // wait" steer. When CHROXY_TUI_MULTISELECT_REINJECT is on and a multi-select
    // AskUserQuestion is denied, the deny reason steers the model to STOP its
    // turn so the reinjected selection (sendMessage) lands as a fresh turn. The
    // FormDriver sets this marker right after the flag-on sendMessage; if the
    // model instead emits another tool_use before the reinjected turn's first
    // output clears it, we log a loud WARN (greppable: reinject_stop_wait_violation
    // / #5798) — the signal the steer was NOT honored. Shape when set:
    // { deniedToolUseId, at } where `at` is _nowMonotonic(). Null = no window
    // open. Set ONLY on the flag-on reinject path; cleared one-shot on the WARN,
    // on the reinjected turn's first consumed hook (_clearFirstOutputWatchdog),
    // and on every teardown/destroy/pty-gone path so a stale marker can't leak.
    // This NEVER changes behavior — it is a measurement aid only.
    this._reinjectStopWaitWatch = null
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
    // #5777: first-message submit nudge. A freshly-spawned TUI can report
    // status:idle (ready) before its composer actually accepts the submit, so
    // the FIRST message's trailing \r lands on a not-yet-interactive prompt and
    // the text sits unsent until a second message nudges it (the manual "go"
    // workaround). On the first turn only, a one-shot timer re-sends a bare \r
    // if no hook output has arrived within the window. 0 disables.
    this._firstTurnSubmitNudgeMs = ClaudeTuiSession.FIRST_TURN_SUBMIT_NUDGE_MS
    this._firstTurnSubmitNudgeTimer = null
    // #5794: per-spawn latch so the nudge arms on the FIRST message after each
    // (re)spawn, not only the lifetime-first message. `_messageCounter` is
    // monotonic (never reset), so keying the nudge on `=== 1` left a mid-session
    // respawn's first turn un-nudged even though the warm-composer wedge can
    // recur on the fresh PTY. Reset to false in _spawnPty (every successful
    // (re)spawn), flipped true the first time sendMessage arms the nudge.
    this._firstTurnNudgedForSpawn = false
    // #6578: cache the session-file path resolved by resolveSessionFile so the
    // per-turn readiness probe doesn't re-scan ~/.claude/sessions every turn.
    // Invalidated on every (re)spawn (reset in _spawnPty alongside the nudge
    // latch) because a respawn under a wrapper shim can land on a new pid, and a
    // retry-FRESH fallback mints a new sessionId → the old path no longer maps.
    this._resolvedSessionFile = null
    // #6578: last time the readiness probe ran the (readdir-heavy) session-file
    // dir-scan, so it can be throttled to ~2/sec during warmup. -Infinity so the
    // first cold-resolve scans immediately; reset on each (re)spawn.
    this._lastSessionDirScanMs = -Infinity
    // #5431: incremental transcript scanner for outstanding background work
    // (run_in_background Bash/Agent, Monitor, ScheduleWakeup). Created
    // lazily by getBackgroundTaskSnapshot() once the per-PID session file
    // resolves to a transcript path; replaced if the transcript path
    // changes (new conversation id after /clear or resume).
    this._transcriptTaskScanner = null
    // #5431: change-detection poll armed while the last snapshot reported
    // outstanding work. Re-scans the transcript so a task-notification that
    // lands while the session is IDLE still clears the dashboard indicator
    // (the TUI re-invokes itself on notifications — chroxy sees no turn).
    this._backgroundTaskPollTimer = null
    this._lastBackgroundTaskKey = null
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
    // #5792: pending entries are gone → their reapers have nothing to guard.
    this._clearAllDeniedQuestionReapers()
  }

  /** Internal: drop a specific pending answer entry (PostToolUse cleanup). */
  _clearPendingAnswerByToolUseId(toolUseId) {
    if (!toolUseId) return
    this._pendingUserAnswers.delete(toolUseId)
    // #5792: the entry is gone → cancel its denied-shape reaper (no-op if none).
    this._clearDeniedQuestionReaper(toolUseId)
    if (this._lastPendingAnswerToolUseId === toolUseId) {
      // Advance the "most recent" pointer to whichever entry was set most
      // recently after the one we just removed (insertion-order via Map
      // iteration). null when the Map is empty.
      const keys = [...this._pendingUserAnswers.keys()]
      this._lastPendingAnswerToolUseId = keys.length > 0 ? keys[keys.length - 1] : null
    }
  }

  /**
   * #5617 — delegate the AskUserQuestion answer to the injected FormDriver.
   * Kept on the session because external callers (input-handlers.js) and the
   * provider contract call `session.respondToQuestion(...)`; the driving logic
   * lives in form-driver.js, reaching session state/PTY writers via its host.
   */
  respondToQuestion(text, answersMap, toolUseId, opts) {
    return this._formDriver.respondToQuestion(text, answersMap, toolUseId, opts)
  }

  /**
   * #5319 (WP-3.2): arm (or re-arm) the per-toolUseId AskUserQuestion stall
   * watchdog. Each toolUseId gets its own timer so a parallel sibling's arm
   * can't clobber this one. On fire it deletes its own Map entry, then calls
   * _formDriver._onAskUserQuestionStall. A null/undefined toolUseId is keyed
   * verbatim (one anonymous slot) so the defensive no-toolUseId path keeps a
   * watchdog. `ms` defaults to the standard window but the Other-freeform
   * two-stage flow passes OTHER_FREEFORM_WATCHDOG_MS for its longer second stage.
   */
  _armAskUserQuestionWatchdog(toolUseId, ms = ASK_USER_QUESTION_WATCHDOG_MS) {
    const existing = this._askUserQuestionWatchdogs.get(toolUseId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this._askUserQuestionWatchdogs.delete(toolUseId)
      this._formDriver._onAskUserQuestionStall(toolUseId)
    }, ms)
    this._askUserQuestionWatchdogs.set(toolUseId, t)
  }

  /** #5319 (WP-3.2): cancel + drop ONE toolUseId's stall watchdog (PostToolUse / per-question teardown). Idempotent. */
  _clearAskUserQuestionWatchdog(toolUseId) {
    const t = this._askUserQuestionWatchdogs.get(toolUseId)
    if (t) {
      clearTimeout(t)
      this._askUserQuestionWatchdogs.delete(toolUseId)
    }
  }

  /** #5319 (WP-3.2): cancel + drop ALL stall watchdogs (turn-ending paths + destroy()). Idempotent. */
  _clearAllAskUserQuestionWatchdogs() {
    for (const t of this._askUserQuestionWatchdogs.values()) clearTimeout(t)
    this._askUserQuestionWatchdogs.clear()
  }

  /**
   * #5792: arm (or re-arm) the denied-shape reaper for one toolUseId. Called
   * from `_emitToolHookEvent` ONLY when the AskUserQuestion payload is a denied
   * shape (multi-question or multi-select) — a legitimate single single-select
   * arms its own stall watchdog in `respondToQuestion` instead and is left
   * alone. On fire, `_reapDeniedQuestion` drops the pending entry if it still
   * leaks. Unlike the stall watchdog (which assumes a live, busy turn), this
   * reaper must OUTLIVE the turn: the denied turn Stops immediately, so the
   * reaper is intentionally NOT cleared by `_clearTurnEndState` — only when the
   * pending entry it guards is cleared (see `_clearPendingAnswerByToolUseId` /
   * `_pendingUserAnswers_clearAll`).
   */
  _armDeniedQuestionReaper(toolUseId, ms = DENIED_QUESTION_REAPER_MS) {
    if (!toolUseId) return
    const existing = this._deniedQuestionReapers.get(toolUseId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this._deniedQuestionReapers.delete(toolUseId)
      this._reapDeniedQuestion(toolUseId)
    }, ms)
    this._deniedQuestionReapers.set(toolUseId, t)
  }

  /** #5792: cancel + drop ONE toolUseId's denied-shape reaper. Idempotent. */
  _clearDeniedQuestionReaper(toolUseId) {
    const t = this._deniedQuestionReapers.get(toolUseId)
    if (t) {
      clearTimeout(t)
      this._deniedQuestionReapers.delete(toolUseId)
    }
  }

  /** #5792: cancel + drop ALL denied-shape reapers (turn-level wipe + destroy()). Idempotent. */
  _clearAllDeniedQuestionReapers() {
    for (const t of this._deniedQuestionReapers.values()) clearTimeout(t)
    this._deniedQuestionReapers.clear()
  }

  /**
   * #5792: drop a denied-shape AskUserQuestion's pending entry if it STILL
   * leaks after the reaper window (deny → Stop → idle with no answer). A no-op
   * when the entry is already gone (PostToolUse arrived, the user answered, or a
   * turn-ending teardown cleared it). Clears only this toolUseId's state — the
   * pending entry and its own (keyed) stall watchdog. It deliberately does NOT
   * touch the global `askuserquestion-active` lock: that lock is already cleared
   * at the denied turn's Stop (`_clearTurnEndState`), and clearing it here could
   * drop a LATER turn's legitimate lock if a fresh AskUserQuestion is in flight
   * when the reaper fires.
   */
  _reapDeniedQuestion(toolUseId) {
    if (this._destroying) return
    if (!this._pendingUserAnswers.has(toolUseId)) return
    ;(this._log || log).warn(`AskUserQuestion denied-shape reaper (#5792): tool=${toolUseId} pending entry never cleared after deny→Stop→idle — dropping leaked entry so a later no-toolUseId answer can't misroute to it`)
    // _clearPendingAnswerByToolUseId re-enters _clearDeniedQuestionReaper; that's
    // an idempotent no-op here (this reaper already self-deleted from the Map
    // before its callback ran).
    this._clearPendingAnswerByToolUseId(toolUseId)
    this._clearAskUserQuestionWatchdog(toolUseId)
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

  // #6178: hot-path hook-drain fs accessors. Thin wrappers over fs/promises so a
  // test can override them to simulate a hung mount; production just forwards.
  // The drain calls them via _boundedHookFs (bound + coalesced), never directly.
  _hookReaddir(dir) { return readdir(dir) }
  _hookReadFile(path) { return readFile(path, 'utf8') }
  _hookUnlink(path) { return unlink(path) }

  /**
   * #6178 (review) — run a hot-path hook-drain fs op bounded by HOOK_FS_TIMEOUT_MS
   * AND coalesced so at most one underlying op per (kind,path) is outstanding.
   *
   * A timed-out fs op can't be canceled: the real readdir/readFile/unlink stays
   * pending in the libuv threadpool until the mount unfreezes. If each poll pass
   * started a fresh op we'd accumulate stuck threadpool work and exhaust the
   * shared 4-thread pool — reintroducing the cross-session blocking #6132 fixed.
   * So we keep the SAME underlying promise per (kind,path) and re-race a fresh
   * timer against it each pass; only after it finally settles is a new op issued.
   *
   * @param {'readdir'|'readFile'|'unlink'} kind
   * @param {string} path  the sink dir (readdir) or a hook file (readFile/unlink)
   * @returns {Promise<*>} the op result, or a HOOK_FS_TIMEOUT rejection
   */
  _boundedHookFs(kind, path) {
    const key = `${kind}:${path}`
    let inflight = this._inFlightHookFs.get(key)
    if (!inflight) {
      inflight = kind === 'readdir' ? this._hookReaddir(path)
        : kind === 'readFile' ? this._hookReadFile(path)
          : this._hookUnlink(path)
      // Free the slot when the real op finally settles (even long after our race
      // gave up), so a recovered mount can issue a fresh op. The then(noop,noop)
      // marks the underlying promise handled so a late rejection is never an
      // unhandledRejection; the guard avoids clobbering a newer entry.
      inflight.then(() => {}, () => {}).finally(() => {
        if (this._inFlightHookFs.get(key) === inflight) this._inFlightHookFs.delete(key)
      })
      this._inFlightHookFs.set(key, inflight)
    }
    return withHookFsTimeout(inflight, this._hookFsTimeoutMs, kind)
  }

  /**
   * #5329 (IP-1): recover the hook sink dir after a readdir failure during the
   * poll loop. The sink lives under /tmp, so a tmpwatch sweep / tmpfs clear /
   * manual rm can delete it mid-turn — and claude's hook commands write to this
   * exact path, so once the dir is gone every `cat > <sink>/…` also fails and
   * the turn wedges silently until the hard timeout.
   *
   * Recreate the SAME path (claude's already-loaded hooks embed it) plus the
   * owner.pid stamp and the permission-mode sidecar (so the hook reads the live
   * mode rather than falling back to the stale spawn-time env var). If
   * recreation itself fails (e.g. /tmp is full → ENOSPC), surface it loudly
   * (throttled) instead of spinning silently.
   *
   * @param {Error} [cause] the readdir error that triggered recovery
   * @returns {boolean} true if the sink is usable afterward
   */
  _recoverSinkDir(cause) {
    if (!this._sinkDir) return false
    const logger = this._log || log
    // Distinguish three states by what's actually AT the sink path:
    //   - a real directory → readdir failed transiently (EACCES/EMFILE); warn
    //     (throttled) but don't thrash recreation.
    //   - nothing → vanished (tmpwatch/rm); recreate.
    //   - a non-directory (file/symlink squatting the path) → readdir would
    //     throw ENOTDIR forever; rm the squatter, then recreate.
    let isDir = false
    try { isDir = statSync(this._sinkDir).isDirectory() } catch { /* missing or unstat-able */ }
    if (isDir) {
      const now = Date.now()
      if (now - this._sinkTransientWarnLoggedMs >= 5000) {
        this._sinkTransientWarnLoggedMs = now
        logger.warn(`hook sink readdir failed though ${this._sinkDir} is a directory: ${cause?.message || cause}`)
      }
      return true
    }
    try {
      // Clear a non-directory squatting the path (no-op if nothing is there)
      // so mkdir can create a real directory.
      try { rmSync(this._sinkDir, { recursive: true, force: true }) } catch { /* best effort */ }
      mkdirSync(this._sinkDir, { recursive: true })
      try { writeFileSync(join(this._sinkDir, 'owner.pid'), String(process.pid)) } catch { /* best effort */ }
      if (this._permissionModeFile) {
        try { this._writePermissionModeSidecarAtomic(this._permissionModeFile, this.permissionMode || 'approve') } catch { /* hook falls back to env var */ }
      }
      this._sinkRecoverErrLoggedMs = 0
      logger.warn(`hook sink ${this._sinkDir} vanished mid-turn and was recreated — hook delivery restored (cause: ${cause?.message || cause})`)
      return true
    } catch (err) {
      // Persistent failure (disk full, parent gone): throttle the error so a
      // 150ms poll loop doesn't flood the log.
      const now = Date.now()
      if (now - this._sinkRecoverErrLoggedMs >= 5000) {
        this._sinkRecoverErrLoggedMs = now
        logger.error(`hook sink ${this._sinkDir} vanished and could NOT be recreated (${err.message}) — tool events for this turn may be lost (disk full?)`)
      }
      return false
    }
  }

  // #5332: monotonic now (integer ms). Used for every turn-duration delta and
  // watchdog poll-loop deadline so a wall-clock jump can't hang or false-fire
  // them. See the _monotonicNowFn note in the constructor.
  _nowMonotonic() { return this._monotonicNowFn() }

  // Tail length to keep + length to include in error diagnostics.
  static get PTY_TAIL_BYTES() { return 4096 }
  static get PTY_TAIL_DIAGNOSTIC_BYTES() { return 1024 }

  // #5835 Phase 1: coalescing window for the live remote-viewer mirror. PTY
  // onData fires many times per redraw; flushing one `terminal_output` per
  // ~50ms caps the broadcast rate (the deliberate latency-for-bandwidth trade —
  // a faithful-but-slightly-laggy mirror) without dropping any bytes.
  static get MIRROR_FLUSH_MS() { return 50 }

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

  // #5777: first-turn submit-nudge interval (ms) and max attempts. A freshly-
  // spawned TUI can report ready before its composer accepts the submit, so the
  // first message's \r is dropped. If no hook output arrives within this window
  // the nudge re-sends a bare \r. 1.5s is long enough that a normally-submitted
  // turn has usually produced its first hook (so the nudge no-ops), short enough
  // that a real wedge unsticks in seconds instead of waiting for the 90s
  // first-output watchdog. Two attempts (≈1.5s, ≈3s) then defer to the watchdog.
  static get FIRST_TURN_SUBMIT_NUDGE_MS() { return 1500 }
  static get FIRST_TURN_SUBMIT_NUDGE_MAX_ATTEMPTS() { return 2 }

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

  /**
   * #6578: resolve the on-disk session file for THIS session, keyed on the
   * deterministic `sessionId` (passed to claude as `--session-id`/`--resume`)
   * rather than only the pty pid. Two breakages on current claude (2.1.186+)
   * made the pid-only path unreliable:
   *   - MODE A: under a wrapper-shim install the real claude pid != pty pid,
   *     so `~/.claude/sessions/<pty-pid>.json` never appears.
   *   - MODE B: the session file carries NO `status` field at all, so the old
   *     status-only signal returned null even when the file WAS found.
   * Since claude writes this file at startup with a matching `sessionId`, the
   * file is resolvable by directory scan regardless of pid, and its mere
   * existence (with a matching sessionId) is itself a startup-readiness signal.
   *
   * Resolution order:
   *   1. Fast path — `sessionFilePath(ptyPid)`; verify its parsed `sessionId`
   *      matches (or accept it verbatim when `sessionId` is falsy, preserving
   *      the legacy pid-keyed behaviour for callers without a known id).
   *   2. Dir-scan — read `~/.claude/sessions` and return the first `*.json`
   *      whose parsed `sessionId === sessionId`.
   *
   * Swallows ALL I/O/parse errors (returns null) — this feeds the readiness
   * path and must NEVER throw. Returns the absolute path or null.
   *
   * @param {string|null} sessionId  the upstream claude conversation uuid
   * @param {number} ptyPid          the pty child pid (fast-path filename)
   * @returns {string|null}
   */
  static resolveSessionFile(sessionId, ptyPid, { allowDirScan = true } = {}) {
    // Fast path: the pty-pid-named file. When we have no sessionId to match on
    // (older callers), accept it verbatim if it exists — matches the legacy
    // pid-keyed behaviour. With a sessionId, only accept it on a match. This is a
    // single stat+read and runs on every poll; the dir-scan below is the costly
    // part and the caller throttles it via `allowDirScan`.
    if (Number.isInteger(ptyPid) && ptyPid > 0) {
      const fast = this.sessionFilePath(ptyPid)
      try {
        const data = JSON.parse(readFileSync(fast, 'utf8'))
        if (!sessionId || data.sessionId === sessionId) return fast
      } catch { /* not written yet / mid-write race / wrong pid — fall through */ }
    }
    // Dir-scan fallback keyed on sessionId. Nothing to scan for without an id, and
    // callers can suppress the scan (allowDirScan=false) to throttle its per-poll
    // cost during the warmup window — the cheap fast-path above still runs.
    if (!sessionId || !allowDirScan) return null
    try {
      const dir = join(homedir(), '.claude', 'sessions')
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const full = join(dir, name)
        try {
          const data = JSON.parse(readFileSync(full, 'utf8'))
          if (data.sessionId === sessionId) return full
        } catch { /* skip unreadable/half-written sibling files */ }
      }
    } catch { /* sessions dir missing / unreadable — degrade to null */ }
    return null
  }

  /**
   * #6578: does `filePath` still map to `sessionId`? Used to validate a cached
   * `_resolvedSessionFile` before reusing it — the file could be deleted or
   * (after a retry-FRESH fallback) now carry a different id. When `sessionId`
   * is falsy the check reduces to "the file still exists AND parses as JSON"
   * (legacy pid-keyed callers). Swallows errors → false (a missing OR
   * unreadable/corrupt file), so a stale cache forces a re-resolve.
   */
  static _sessionFileMatches(filePath, sessionId) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      return sessionId ? data.sessionId === sessionId : true
    } catch {
      return false
    }
  }

  // #5431: cadence for the idle background-task re-scan. 15s mirrors the
  // BackgroundShellTracker sweep — fast enough that a task-notification
  // landing while the session is idle clears the dashboard indicator
  // promptly, slow enough to be negligible I/O (each tick reads only the
  // transcript bytes appended since the last scan).
  static get BACKGROUND_TASK_POLL_MS() { return 15_000 }

  /**
   * #5431 — outstanding background work derived from the session transcript:
   * `{ backgroundTasks: [{ toolUseId, kind, description, startedAt }],
   *    scheduledWakeup: { at, reason } | null }`, or null when no transcript
   * is resolvable (no PTY pid, no per-PID session file, parse failure — the
   * "degrade to plain ready" contract).
   *
   * The per-PID session file that drives the readiness probe carries
   * `sessionId` + `cwd`, which derive the transcript path
   * (`~/.claude/projects/<slug>/<sessionId>.jsonl`). The scanner is
   * incremental (byte offset per instance) so calling this on every
   * readiness edge costs only the new transcript tail.
   *
   * Side effect: arms/disarms the idle re-scan poll (`_backgroundTaskPollTimer`)
   * based on whether the snapshot reports outstanding work, so callers
   * (event-normalizer's `ready` / `result` handlers, ws-history replay)
   * keep the watch fresh without extra wiring. Never throws.
   */
  getBackgroundTaskSnapshot() {
    try {
      const pid = this._term && this._term.pid
      if (!Number.isInteger(pid) || pid <= 0) return null
      const transcriptPath = transcriptPathForSessionFile(ClaudeTuiSession.sessionFilePath(pid))
      if (!transcriptPath) return null
      if (!this._transcriptTaskScanner || this._transcriptTaskScanner.path !== transcriptPath) {
        this._transcriptTaskScanner = new TranscriptTaskScanner(transcriptPath, this._log || log)
      }
      const snapshot = this._transcriptTaskScanner.scan()
      this._lastBackgroundTaskKey = JSON.stringify(snapshot)
      this._refreshBackgroundTaskPoll(snapshot)
      return snapshot
    } catch (err) {
      ;(this._log || log).debug?.(`getBackgroundTaskSnapshot failed: ${err.message} — degrading to plain ready`)
      return null
    }
  }

  /**
   * #5431 — arm the idle re-scan while work is outstanding, stop it when
   * the snapshot drains. The tick skips busy turns (the turn-end `result`
   * path recomputes anyway) and emits `background_tasks_changed` only when
   * the snapshot actually changed, which the event-normalizer maps to an
   * enriched `claude_ready` wire message (empty `backgroundTasks: []` on
   * the final tick clears the client indicator).
   */
  _refreshBackgroundTaskPoll(snapshot) {
    const outstanding = snapshot && (snapshot.backgroundTasks.length > 0 || snapshot.scheduledWakeup)
    if (!outstanding) {
      this._stopBackgroundTaskPoll()
      return
    }
    if (this._backgroundTaskPollTimer || this._destroying) return
    this._backgroundTaskPollTimer = setInterval(() => {
      try {
        if (this._destroying || this._ptyExited) {
          this._stopBackgroundTaskPoll()
          return
        }
        if (this._isBusy || !this._transcriptTaskScanner) return
        const next = this._transcriptTaskScanner.scan()
        const key = JSON.stringify(next)
        if (key === this._lastBackgroundTaskKey) return
        this._lastBackgroundTaskKey = key
        this.emit('background_tasks_changed', next)
        if (next.backgroundTasks.length === 0 && !next.scheduledWakeup) {
          this._stopBackgroundTaskPoll()
        }
      } catch (err) {
        // Never let the poll throw out of a timer tick — stop watching and
        // degrade to "no live updates until the next readiness edge".
        ;(this._log || log).debug?.(`background-task poll failed: ${err.message} — stopping poll`)
        this._stopBackgroundTaskPoll()
      }
    }, ClaudeTuiSession.BACKGROUND_TASK_POLL_MS)
    // Don't keep the event loop alive solely for the background-task watch.
    if (typeof this._backgroundTaskPollTimer.unref === 'function') this._backgroundTaskPollTimer.unref()
  }

  /** #5431 — idempotent stop for the background-task re-scan poll. */
  _stopBackgroundTaskPoll() {
    if (this._backgroundTaskPollTimer) {
      clearInterval(this._backgroundTaskPollTimer)
      this._backgroundTaskPollTimer = null
    }
  }

  /**
   * #5323 (WP-5.1) — boot-time sweep of orphaned hook-sink dirs under
   * `/tmp/chroxy-claude-tui/s-*`. destroy() rmSyncs a session's own sink dir,
   * but a CRASH leaks it forever, so a long-lived host accumulates one dir per
   * crashed session. Mirrors the worktree reaper's dead-pid-lock logic: each
   * dir carries an `owner.pid` (written at start()); a dir is removed only when
   * its owner is DEAD (or the pidfile is missing/garbage). A live owner — this
   * just-booted daemon, or another chroxy on the host — keeps its dirs, so the
   * sweep is safe to run unconditionally at boot (our own pid is alive, so we
   * never delete a dir we are about to use).
   * @param {object} [logger] - logger with info/warn (defaults to module log)
   * @returns {{swept:number, kept:number}}
   */
  static sweepStaleSinkDirs(logger = log) {
    const base = join(tmpdir(), 'chroxy-claude-tui')
    let entries
    try { entries = readdirSync(base) } catch { return { swept: 0, kept: 0 } }
    let swept = 0
    let kept = 0
    for (const name of entries) {
      if (!name.startsWith('s-')) continue
      const dir = join(base, name)
      let ownerPid = null
      try {
        const n = parseInt(readFileSync(join(dir, 'owner.pid'), 'utf8').trim(), 10)
        if (Number.isInteger(n) && n > 0) ownerPid = n
      } catch { /* no/garbage pidfile → orphaned, subject to the grace below */ }
      if (ownerPid !== null) {
        let alive
        try {
          process.kill(ownerPid, 0) // signal 0 = existence probe
          alive = true
        } catch (err) {
          // ESRCH → dead; EPERM → exists but not ours → still alive, keep it.
          alive = err && err.code === 'EPERM'
        }
        if (alive) { kept++; continue }
      } else {
        // #5359 review — a pidfile-less dir might be another process's sink dir
        // caught BETWEEN its mkdir and its owner.pid write (a cross-process race;
        // within one process those are synchronous). Give brand-new pidfile-less
        // dirs a grace window before reaping so we can't delete one mid-creation;
        // a genuinely orphaned dir is older than the grace and still gets swept.
        try {
          // #5332: wall-clock deliberately — compared against the filesystem
          // mtime (also wall-clock). A monotonic clock would be meaningless here.
          if (Date.now() - statSync(dir).mtimeMs < ClaudeTuiSession.SINK_SWEEP_GRACE_MS) {
            kept++
            continue
          }
        } catch { /* stat failed (dir vanished) → fall through to rmSync (no-op) */ }
      }
      try {
        rmSync(dir, { recursive: true, force: true })
        swept++
      } catch (err) {
        logger?.warn?.(`sink-dir sweep: failed to remove ${dir}: ${err.message}`)
      }
    }
    if (swept > 0) logger?.info?.(`Swept ${swept} stale claude-tui sink dir(s) from ${base} (kept ${kept} live)`)
    return { swept, kept }
  }

  // Upper bounds on how long we'll wait for status=idle before falling
  // through (and writing anyway, with a warn). Spawn warmup is generous
  // because cold claude can take a few seconds on a fresh keychain
  // unlock; per-turn is short because between-turn idle->busy->idle
  // transitions are sub-second once the session is up.
  static get SPAWN_WARMUP_MAX_MS() { return 15_000 }
  static get TURN_PROMPT_WAIT_MAX_MS() { return 5_000 }
  // #6601: how long PTY output must be quiet before the composer counts as ready
  // when no session file resolves (current claude's INTERACTIVE TUI writes none,
  // so the file probe never resolves and the caller used to burn the full
  // warmup/turn ceiling then "write anyway"). The composer's render burst settles
  // well within this window; the idle TUI then stays silent for seconds. Validated
  // live: cold composer ready ~1.1s (vs the 15s warmup ceiling), between-turn
  // redraw sub-second (vs the 5s per-turn ceiling). Comfortably above the observed
  // intra-render gaps (~270ms) so it can't false-trigger mid-render; the
  // warmup/turn ceilings still backstop a genuinely-stuck TUI.
  //
  // Override with CHROXY_TUI_READY_QUIESCENCE_MS (positive integer ms) to widen
  // the window on a flaky/slow host — a genuine mid-warmup pause (MCP enumeration,
  // a slow skills-dir read, a loaded host) exceeding 400ms would fire quiescence
  // early and land the throttled prompt on a not-yet-ready composer. In the
  // no-session-file case quiescence is the only readiness signal, so if it fires
  // early the #5794 first-turn nudge (a bare `\r` re-send) is the backstop that
  // recovers the composer — an early fire is a brief wedge at worst (#6603).
  static get READY_QUIESCENCE_MS() {
    const override = parseInt(process.env.CHROXY_TUI_READY_QUIESCENCE_MS || '', 10)
    return Number.isFinite(override) && override > 0 ? override : 400
  }
  // #5317 (WP-2.3) — grace window between destroy()'s SIGTERM and the SIGKILL
  // escalation. Long enough for claude to flush its Stop hook + reap its own
  // tool children on a clean SIGTERM, short enough that a hung claude (or a
  // child holding the PTY open) can't orphan past it.
  static get DESTROY_GRACE_MS() { return 3_000 }
  // #5359 review — grace window before the boot sweep reaps a PIDFILE-LESS sink
  // dir, so a dir caught between another process's mkdir and its owner.pid write
  // (a cross-process race) isn't deleted mid-creation. Dirs with a (dead) pid
  // are reaped immediately; only the pidfile-less ambiguous case waits this out.
  static get SINK_SWEEP_GRACE_MS() { return 60_000 }
  // Wedge instrumentation (#4678 follow-up): hook-poll loop emits a
  // heartbeat log line every HOOK_HEARTBEAT_MS of silent waiting (no
  // stop-hook yet). Sized so healthy short turns (<5s end-to-end) emit
  // zero heartbeats but wedges produce a 5s-cadence trail of state.
  static get HOOK_HEARTBEAT_MS() { return 5_000 }
  // #6178: per-call timeout for the hot-path hook-drain fs ops (readdir/readFile/
  // unlink). A healthy sink read is sub-ms; this generous 2s bound only trips on
  // a genuinely stuck mount (FUSE/NFS freeze), letting the poll loop re-check its
  // hard-timeout guard rather than awaiting a frozen fs forever.
  static get HOOK_FS_TIMEOUT_MS() { return 2_000 }

  get sessionId() {
    return this._sessionId
  }

  // #5307 (WP-0.1) — SessionManager.serializeState reads `resumeSessionId` off
  // the session and persists it as `sdkSessionId`; restoreState passes it back
  // into the constructor so the conversation resumes. Without this getter the
  // read was `undefined` → persisted null → every restart started a brand-new
  // claude conversation while the dashboard replayed stale history (the silent
  // context-amnesia bug, audit TUI-AUDIT-001). Mirrors cli-session.js:386.
  get resumeSessionId() {
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
    // #5323 (WP-5.1) — stamp the owning pid so the boot-time sweep
    // (sweepStaleSinkDirs) can tell a live daemon's sink dir from one orphaned
    // by a prior crash. Best-effort: a missing pidfile just makes the dir
    // sweep-eligible, which is the safe default for an orphan.
    try { writeFileSync(join(this._sinkDir, 'owner.pid'), String(process.pid)) } catch { /* best effort */ }

    // Generate the upstream session uuid here so the JSONL path is
    // predictable + so claude resumes the same conversation across turns.
    // #5307 (WP-0.1) — only mint a fresh uuid when this isn't a restore. When
    // the constructor seeded `_sessionId` from a persisted resume id, keep it
    // so the spawn below can `--resume <id>` the same conversation.
    if (!this._sessionId) this._sessionId = randomUUID()
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
        // Atomic from the first write too (#5334): a respawn / hot-restart can
        // rewrite this sidecar while a hook from a still-draining turn reads it.
        this._writePermissionModeSidecarAtomic(sidecarPath, this.permissionMode || 'approve')
        this._permissionModeFile = sidecarPath
      } catch (err) {
        log.warn(`initial permission-mode sidecar write failed (${err.message}) — falling back to env-var-only mode; mid-session permission switch will not take effect`)
        this._permissionModeFile = null
      }
    }

    // Spawn node-pty + wait for TUI warmup. Extracted so tests can stub
    // the prototype method instead of mocking node-pty at the module level.
    await this._spawnPty(permissionsEnabled)

    // #5316 (WP-2.2) — never resolve start() (and never emit `ready` / set
    // `_processReady`) when the PTY failed to come up. Before this, start()
    // emitted an `error` and *returned*, so SessionManager's
    // `session.start().catch(...)` guard never fired and the dead session sat in
    // the list as an input-rejecting zombie. Worse, the two `_spawnPty`
    // early-return failure paths (node-pty import fail, spawn throw) emit `error`
    // and return WITHOUT setting `_ptyExited` and WITHOUT a live `_term`, so the
    // old `if (this._ptyExited)` guard missed them entirely and fell straight
    // through to `emit('ready')` — marking a session with no process alive
    // (the audit's "never mark a dead PTY ready"). Cover every no-live-PTY shape
    // by rejecting, so SessionManager surfaces the failure (fresh → cleanup;
    // restore → preserve history, mark retryable).
    if (this._destroying) {
      // destroy() raced the spawn; `_spawnPty`'s post-spawn guard already killed
      // the fresh PTY and nulled `_term`. This is a benign abort, not a start
      // failure to surface — resolve quietly without emitting `ready`.
      return
    }
    // #5321 (WP-4.1) — surface a logged-out / expired subscription login as a
    // clear AUTH_REQUIRED error (with `claude login` guidance) BEFORE the generic
    // exit/timeout paths, so the operator gets actionable guidance instead of a
    // bare "PTY exited" or a 90s silent hang. Covers both shapes: claude printed
    // its login banner and sat there (_authFailureDetected, latched in
    // _spawnPty's warmup scan) AND claude printed it then exited (re-scan the
    // tail here, since the warmup loop returns on _ptyExited before scanning).
    if (this._authFailureDetected || this._scanOutputForAuthFailure()) {
      this.emit('error', { code: AUTH_REQUIRED_CODE, message: AUTH_REQUIRED_MESSAGE })
      const err = new Error(AUTH_REQUIRED_MESSAGE)
      err.code = AUTH_REQUIRED_CODE
      throw err
    }
    if (this._ptyExited) {
      // #6576 (Option A) — the dying warmup already went through _onPtyGone →
      // _scheduleRespawn. If claude's own tail CONFIRMED the resume id is unknown,
      // that path armed a retry-FRESH (`_freshRetryPending`) + scheduled a respawn
      // on a brand-new conversation. Do NOT reject start() in that case: a restore
      // start() rejection makes SessionManager (`_handleAsyncStartFailure`) tear
      // down the provider, which cancels the scheduled respawn — the exact
      // restore-on-restart wedge #6576 is about (the background retry never runs).
      // Return quietly instead; the scheduled respawn spawns the fresh conversation
      // and emits `ready` when it warms up, so the session recovers in place with no
      // `session_restore_failed` and no teardown. A genuinely unrecoverable death
      // (no retry armed) still rejects below.
      if (this._freshRetryPending) {
        return
      }
      const message = `claude PTY exited during warmup (code=${this._ptyExitInfo?.exitCode ?? 'unknown'})`
      this.emit('error', { message })
      throw new Error(message)
    }
    if (!this._term) {
      // `_spawnPty` hit an early-return failure path (node-pty unavailable /
      // spawn throw). It already emitted a descriptive `error`; reject so the
      // failure isn't swallowed.
      throw new Error('claude PTY failed to spawn (no live process after _spawnPty)')
    }

    this._processReady = true
    this.emit('ready', { sessionId: this._sessionId, model: this.model, tools: [] })
  }

  /**
   * #5311 (WP-1.1) — single idempotent teardown for "the PTY is gone", reached
   * from onExit (process exit) AND from the 'close'/'error' socket events that
   * fire on a node-pty fault with no process-exit callback. Resets turn state so
   * the next sendMessage() sees a clean idle (it still rejects with "no longer
   * alive", but isn't locked by a stale _isBusy from the interrupted turn,
   * #3924) and emits ONE session-scoped error. Guards on `_ptyExited` so the
   * several wired events collapse to a single teardown + error emit.
   *
   * @param {object|null} info — node-pty exit info ({exitCode, signal}) when known
   * @param {string} source — diagnostic label for the log line
   */
  _onPtyGone(info, source) {
    // Always capture the most specific exit info, even on a repeat event.
    if (info) this._ptyExitInfo = info
    if (this._ptyExited) return
    this._ptyExited = true
    this._processReady = false
    // #5317 (WP-2.3) — the process is confirmed gone (onExit/close/error fired),
    // so cancel any pending SIGKILL escalation destroy() armed. Doing this here
    // (rather than via a timer-only check) is what closes the pid-reuse window:
    // the escalation only fires when onExit NEVER arrives, i.e. the process is
    // genuinely still alive, so the captured pid can't have been recycled.
    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null }
    // #5835: drop any pending live-mirror flush so a dead PTY's leftover frame
    // never broadcasts and the timer doesn't leak.
    this._clearTerminalMirror()
    // Reset turn state so the next sendMessage() sees a clean idle.
    const hadActiveTurn = this._activeTurn !== null
    // #4022: clean up the in-flight turn's attachment dir BEFORE nulling
    // _activeTurn, otherwise sendMessage's poll loop reaches _finishTurnError
    // with activeTurn=null and the helper no-ops → dir leaks until destroy().
    // The cleanup is idempotent (rmSync force:true) so a later call is fine.
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    // #4307: the PTY is gone, so the ephemeral intra-turn run_in_background
    // tool_use→command map can never be resolved by a result on this PTY — drop
    // it (matches _clearTurnEndState / base _clearMessageState). On respawn the
    // next turn starts clean; on destroy _clearMessageState would clear it anyway.
    this._pendingBackgroundCommands.clear()
    // #5777 (#5788): cancel a pending first-turn submit nudge directly here.
    // _onPtyGone is the one teardown path that does NOT route through
    // _clearFirstOutputWatchdog, so without this an armed nudge would only be
    // saved by the tick's !_isBusy guard — fragile. Clear before the
    // _destroying early-return so it runs on both the destroy and respawn paths.
    this._clearFirstTurnSubmitNudge()
    // #5798: _onPtyGone does NOT route through _clearFirstOutputWatchdog, so
    // close the reinject stop-and-wait window explicitly here (before the
    // _destroying early-return, so it runs on both the destroy and respawn
    // paths) — a dead/respawning PTY can't legitimately emit the reinjected
    // turn, and a stale marker must not leak into a later turn. Observability-only.
    this._reinjectStopWaitWatch = null
    if (this._destroying) return
    // #5311 review — the socket 'close'/'error' paths have no exit info, so
    // render a clear "unknown" instead of a bare "code=undefined". The
    // "Claude PTY exited" prefix is preserved (clients/log scrapers key on it).
    const code = this._ptyExitInfo?.exitCode
    const codeStr = (code === undefined || code === null) ? 'unknown' : code
    log.warn(`claude PTY gone (${source}) (code=${codeStr} signal=${this._ptyExitInfo?.signal ?? 'unknown'})`)
    // Suppress the generic error when a turn was in flight — sendMessage's poll
    // loop emits a more specific "PTY exited mid-turn" error instead, so the
    // dashboard sees one root cause not two.
    if (!hadActiveTurn) {
      // #5321 (WP-4.1) — if the PTY died with a logged-out / expired-login
      // banner in its tail, surface AUTH_REQUIRED (actionable) rather than a
      // bare exit code. The respawn below will keep failing the same way until
      // the operator re-logs in, so the categorized error is what matters.
      if (this._scanOutputForAuthFailure()) {
        this.emit('error', { code: AUTH_REQUIRED_CODE, message: AUTH_REQUIRED_MESSAGE })
      } else {
        const tail = this._outputTailDiagnostic()
        const base = `Claude PTY exited (code=${codeStr})`
        this.emit('error', { message: tail ? `${base}\nTUI output tail:\n${tail}` : base })
      }
    }
    // #5315 (WP-2.1) — an UNEXPECTED PTY death (we already returned above when
    // `_destroying`, so this is never a deliberate teardown). Try to bring the
    // session back instead of leaving a zombie. The error(s) above still fire
    // so the dashboard sees the death; the respawn is the recovery layer on top.
    this._scheduleRespawn()
  }

  /**
   * #5315 (WP-2.1) — schedule a bounded PTY respawn with exponential backoff,
   * mirroring CliSession._scheduleRespawn (cli-session.js:556). Backoff is
   * [1s,2s,4s,8s,15s] and caps at 5 attempts (a session whose dying PTY tail
   * confirms the resume id is unknown gets ONE extra drop-and-retry-FRESH
   * attempt at the cap, #5348/#5417); on exhaustion it
   * emits a categorized `error` AND a `respawn_exhausted` event so
   * SessionManager drops the session from its list (no input-rejecting zombie
   * tab — the audit AC).
   * Guarded on `_destroying` / `_respawning` / `_respawnScheduled` so the
   * several wired PTY-fault events (onExit/close/error) can't stack timers.
   */
  _scheduleRespawn() {
    if (this._destroying) return
    if (this._respawning) return
    if (this._respawnScheduled) return

    // #5349: rolling-window cap, checked BEFORE _respawnCount so a session that
    // keeps surviving warmup (resetting _respawnCount) still gives up once it
    // flaps past the window cap.
    if (!this._respawnRateLimiter.record()) {
      const { maxPerWindow, windowMs } = this._respawnRateLimiter
      ;(this._log || log).error(`PTY respawn rate cap reached (>${maxPerWindow} respawns in ${Math.round(windowMs / 60000)}min), giving up — session is flapping`)
      const tail = this._outputTailDiagnostic()
      const base = `Claude PTY is flapping — exceeded ${maxPerWindow} respawns in ${Math.round(windowMs / 60000)} minutes`
      this.emit('error', { code: 'pty_respawn_exhausted', message: tail ? `${base}\nTUI output tail:\n${tail}` : base })
      this.emit('respawn_exhausted', { reason: 'pty_respawn_rate_capped' })
      return
    }

    this._respawnCount++
    // #6576 — fire the retry-FRESH as soon as the dying tail CONFIRMS the resume id
    // is unknown (the `_scanOutputForUnknownResume()` disjunct), not only at the
    // 5-respawn cap. Retrying a `--resume` claude has ALREADY rejected is pointless,
    // and the cap-gated ~30s of backoff exceeds a client's readiness timeout — a
    // ghost resume otherwise broadcast `session_restore_failed` and wedged every
    // real client into a reconnect loop (daemon restarts also reset `_respawnCount`,
    // so the cap was never reached). The one-shot `_didFallbackFromUnknownResume`
    // latch (the `|| this._didFallbackFromUnknownResume` disjunct) keeps a fresh
    // attempt that ALSO dies routing to exhaustion instead of looping; the
    // `_respawnCount > 5` disjunct still governs UNCONFIRMED crash loops (#5417) so a
    // real conversation is never abandoned without claude's own rejection.
    if (this._scanOutputForUnknownResume() || this._didFallbackFromUnknownResume || this._respawnCount > 5) {
      // #5348 — drop-and-retry-FRESH fallback. A FRESH session (spawned with
      // `--session-id`) that died before claude persisted its conversation
      // makes every `--resume` respawn doomed: claude can't find the
      // conversation and exits during warmup. Reaching this cap means 5
      // consecutive respawns never survived warmup — spend ONE extra attempt
      // on a brand-new conversation id before giving up.
      //
      // #5417 — eligibility is the PTY-tail CLASSIFICATION, not the seeding
      // origin. The cap alone proves 5 respawns died during warmup, NOT that
      // the conversation is missing: a crash loop with an unrelated cause
      // (OOM, broken install, claude crashing while loading a large-but-
      // present conversation file) used to trigger the #5348 blunt fallback
      // on originally-fresh sessions and abandon real context a fresh spawn
      // may not even fix. Requiring claude's own resume rejection in the
      // dying output ("No conversation found with session ID …" — the same
      // pinned patterns CliSession's #4929 stderr classifier uses; the PTY
      // merges stdout+stderr so it lands in _outputTail, which _spawnPty
      // resets per attempt so the match describes the LAST death) confines
      // the fallback to the failure it was designed for AND safely extends
      // it to RESTORED sessions (CliSession parity): when claude confirms
      // the persisted conversation is gone (wiped ~/.claude/projects/, state
      // file from another machine), a loud fresh retry beats burning to a
      // destroyed session. No match → exhaustion is the honest outcome for
      // both seeding origins (the TUI-AUDIT-001 amnesia class stays closed:
      // an UNCONFIRMED cause never abandons a conversation id).
      if (this._scanOutputForUnknownResume() && !this._didFallbackFromUnknownResume) {
        this._didFallbackFromUnknownResume = true
        this._freshRetryPending = true
        const abandonedId = this._sessionId
        // Kept for the terminal resume_unknown_exhausted emit below — by the
        // time the fallback attempt fails, _sessionId is already the new uuid.
        this._abandonedResumeId = abandonedId
        this._sessionId = randomUUID()
        this._resumedFromPersisted = false
        // Rebind the session-scoped logger to the new conversation uuid so
        // subsequent lines route under the id the dashboard will see on the
        // re-emitted `ready` (mirrors cli-session.js rebinding on system.init).
        this._log = loggerForSession('claude-tui-session', this._sessionId)
        ;(this._log || log).warn(
          `all --resume respawns died during warmup and the PTY tail confirms claude does not know the ` +
          `conversation id (attemptedResumeId=${abandonedId}) — retrying once with a fresh --session-id`,
        )
        // Loud one-shot signal (same code as cli-session.js) so the dashboard
        // can render "starting fresh" instead of a generic crash toast.
        this.emit('error', {
          code: 'resume_unknown',
          message: this._seededFromPersisted
            ? 'Previous Claude conversation could not be resumed (claude reports the persisted conversation id ' +
              'as unknown on this machine — it may have been wiped from ~/.claude/projects/). Retrying once with ' +
              'a fresh conversation; the model will not see the earlier transcript.'
            : 'Previous Claude conversation could not be resumed (claude reports the conversation id as unknown — ' +
              'it may never have been persisted before the PTY died, or it was removed from this machine). ' +
              'Retrying once with a fresh conversation; the model will not see any earlier transcript.',
          attemptedResumeId: abandonedId,
        })
        // Fall through to the scheduling below — this IS the extra attempt.
      } else {
        // #6576 — with the early retry-FRESH firing, this else can be reached via
        // the `_didFallbackFromUnknownResume` latch (fresh fallback also died) BEFORE
        // the 5-respawn cap, so log the real reason instead of a misleading
        // "Max PTY respawn attempts reached" when the count never hit the cap.
        ;(this._log || log).error(this._didFallbackFromUnknownResume
          ? `Fresh-conversation retry also died during warmup after the resume id was rejected — giving up (${this._respawnCount - 1} attempt(s))`
          : `Max PTY respawn attempts reached (${this._respawnCount - 1}), giving up`)
        const tail = this._outputTailDiagnostic()
        // When the retry-FRESH fallback itself failed, escalate with the same
        // terminal code CliSession uses (resume_unknown_exhausted, #5004) —
        // event-normalizer forwards it + attemptedResumeId, and the dashboard/
        // app already render the distinct "auto-recovery exhausted" affordance.
        // Otherwise keep the provider's own distinct code so the dashboard can
        // render a terminal "give up" state rather than a recoverable crash
        // toast.
        const failedFallback = this._didFallbackFromUnknownResume
        const code = failedFallback ? 'resume_unknown_exhausted' : 'pty_respawn_exhausted'
        const base = failedFallback
          ? 'Auto-recovery exhausted: every --resume respawn died during warmup and a fresh-conversation retry also failed. Start a new session manually to continue.'
          : `Claude PTY failed to stay alive after ${this._respawnCount - 1} respawn attempts`
        const errEnvelope = { code, message: tail ? `${base}\nTUI output tail:\n${tail}` : base }
        if (failedFallback && this._abandonedResumeId) errEnvelope.attemptedResumeId = this._abandonedResumeId
        this.emit('error', errEnvelope)
        // SessionManager listens for this and calls destroySession() so the
        // session leaves the list cleanly (see _wireSessionEvents).
        this.emit('respawn_exhausted', { reason: code, attempts: this._respawnCount - 1 })
        return
      }
    }

    const delays = [1000, 2000, 4000, 8000, 15000]
    const delay = delays[Math.min(this._respawnCount - 1, delays.length - 1)]
    // The #5348 fallback attempt is the one-past-the-cap extra — label it
    // honestly instead of logging a nonsensical "attempt 6/5".
    ;(this._log || log).info(this._freshRetryPending
      ? `Respawning claude PTY in ${delay}ms (fresh-conversation retry after ${this._respawnCount - 1} failed resume attempts)`
      : `Respawning claude PTY in ${delay}ms (attempt ${this._respawnCount}/5)`)

    this._respawnScheduled = true
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null
      this._respawnScheduled = false
      if (this._destroying) return
      this._respawnPty()
    }, delay)
  }

  /**
   * #5315 (WP-2.1) — re-spawn the persistent PTY in place after an unexpected
   * death. Reuses the existing sink dir / settings.json / hook secret (does NOT
   * re-create them) by re-invoking `_spawnPty()` with the same
   * `permissionsEnabled` decision start() made.
   *
   * Two subtleties that are load-bearing:
   *   1. Guard reset — `_onPtyGone` latched `_ptyExited=true` (plus
   *      `_ptyExitInfo` / `_processReady=false`). Without resetting these,
   *      `_onPtyGone`'s `if (this._ptyExited) return` guard stays latched and
   *      the NEXT death would no-op instead of tearing down / respawning again
   *      (the #5315 #1 footgun). Reset them before re-spawning.
   *   2. Conversation continuity — the upstream claude conversation already
   *      exists from the prior PTY run and `_sessionId` is preserved, so the
   *      respawn MUST use `--resume <id>`, NOT `--session-id` (claude rejects a
   *      reused session-id as "already in use"). Set `_resumedFromPersisted`
   *      so `_spawnPty`'s idArgs picks `--resume`; do NOT mint a new id.
   */
  async _respawnPty() {
    if (this._destroying) return
    this._respawning = true
    // (1) reset the teardown latches so a future death re-triggers _onPtyGone.
    this._ptyExited = false
    this._ptyExitInfo = null
    this._processReady = false
    // #5321 (WP-4.1) — clear the auth latch so the respawn's own warmup scan
    // re-evaluates fresh (a re-login between attempts must let the session
    // recover; a still-logged-out respawn re-sets it via _spawnPty's scan).
    this._authFailureDetected = false
    // (2) continue the SAME upstream conversation via --resume — UNLESS
    // #5348's retry-FRESH fallback armed this attempt: then `_sessionId` is a
    // freshly-minted uuid claude has never seen, so the spawn must use
    // `--session-id` (forcing `--resume` here would re-doom the attempt).
    if (this._freshRetryPending) {
      this._freshRetryPending = false
    } else {
      this._resumedFromPersisted = true
    }
    // Recompute permissionsEnabled exactly as start() did — the sink dir, hook
    // secret and settings.json are all still in place from the original start,
    // so we re-use them rather than re-deriving (no re-mint, no re-create).
    const permissionsEnabled = !!(this._port && this._hookSecret) && !this.skipPermissions
    try {
      await this._spawnPty(permissionsEnabled)
    } catch (err) {
      ;(this._log || log).error(`PTY respawn threw: ${err?.message || err}`)
      this._respawning = false
      // Treat a throw like a death: schedule the next attempt (respects the cap).
      this._scheduleRespawn()
      return
    }
    this._respawning = false
    if (this._destroying) {
      // #5315 review (MAJOR-1) — destroy() raced our respawn. _spawnPty's own
      // post-spawn guard kills a PTY it managed to assign, but cover it here too
      // (and so a stubbed _spawnPty in tests can't leave a live _term): kill any
      // PTY that exists and bail without emitting `ready`.
      try { this._term?.kill?.('SIGTERM') } catch {}
      this._term = null
      return
    }
    // #5315 review (MINOR-1) — _spawnPty has early-return paths (node-pty import
    // fail, spawn throw) that emit('error') and return WITHOUT setting
    // _ptyExited and without assigning a live _term. Treat "no live PTY" the
    // same as a death so we don't falsely emit `ready` + mark _processReady on a
    // dead session; reschedule (respects the cap).
    if (!this._term || this._ptyExited) {
      // Respawn warmup failed: the PTY died again during _spawnPty. _onPtyGone
      // DID fire (it set _ptyExited), but its _scheduleRespawn was suppressed
      // by the `_respawning` guard that was true for the whole _spawnPty await.
      // Now that we've cleared `_respawning`, schedule the next attempt here so
      // the backoff chain continues toward the cap (it won't loop forever —
      // _scheduleRespawn enforces the 5-attempt limit).
      this._scheduleRespawn()
      return
    }
    // #5321 (WP-4.1) — the respawn's warmup classified a logged-out / expired
    // login (live PTY sitting at the login banner, never reaching ready). Do NOT
    // emit `ready` on an unauthenticated session — surface AUTH_REQUIRED and stop
    // respawning: every further attempt re-resumes into the same logged-out state
    // until the operator runs `claude login`, so retrying is futile. (start() is
    // not on the respawn path, so this is the only place to catch it here.)
    if (this._authFailureDetected) {
      ;(this._log || log).warn(`claude TUI respawn warmup classified ${AUTH_REQUIRED_CODE} — surfacing instead of marking ready`)
      this.emit('error', { code: AUTH_REQUIRED_CODE, message: AUTH_REQUIRED_MESSAGE })
      this.emit('respawn_exhausted', { reason: AUTH_REQUIRED_CODE, attempts: this._respawnCount })
      return
    }
    // Respawn succeeded and stayed alive through warmup. Reset the count so a
    // FUTURE unrelated death gets the full retry budget again (matches how
    // CliSession resets _respawnCount on system.init, cli-session.js:888), mark
    // ready, and re-emit `ready` so the dashboard knows the session recovered.
    this._respawnCount = 0
    // #5348 — release the one-shot retry-FRESH latch on a warmup that survived
    // (mirrors cli-session.js releasing it on system.init): a FUTURE
    // doomed-resume window may fall back again; the #5349 rolling rate cap
    // bounds any flapping alternation.
    this._didFallbackFromUnknownResume = false
    this._processReady = true
    this.emit('ready', { sessionId: this._sessionId, model: this.model, tools: [] })
  }

  /**
   * Build the env object for the spawned claude TUI PTY.
   *
   * Unlike the claude-cli path (which goes through buildSpawnEnv('claude')),
   * the TUI inherits the operator's full shell env (denylist semantics) so
   * Claude Code tools see the user's environment — but two classes of secret
   * are stripped:
   *   - ANTHROPIC_API_KEY: would pin auth to API billing and defeat the whole
   *     point of this subscription/OAuth provider.
   *   - CHROXY_SECRET_DENYLIST (API_TOKEN): the full-authority primary bearer
   *     token must never reach a tool/MCP/subagent the TUI runs (#6311). The
   *     scoped per-session CHROXY_HOOK_SECRET below is the only chroxy secret
   *     the child legitimately needs.
   *
   * Extracted from _spawnPty so the secret-stripping invariant is unit-testable
   * without spawning a real PTY.
   *
   * @param {boolean} permissionsEnabled
   * @returns {Record<string, string>}
   */
  _buildPtyEnv(permissionsEnabled) {
    const env = { ...process.env }
    // The TUI path must route via OAuth subscription. ANTHROPIC_API_KEY would
    // pin auth to API and defeat the whole point of this provider.
    delete env.ANTHROPIC_API_KEY
    // #6311: strip chroxy-owned daemon secrets (the primary API_TOKEN) so a
    // tool/MCP/subagent/shell the TUI runs can't read them from process.env.
    for (const key of CHROXY_SECRET_DENYLIST) {
      delete env[key]
    }
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
    return env
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
    // Test seam (#6417): a test may inject a capturing node-pty stand-in so the
    // REAL arg-builder below runs against it — catching drift on the actual spawn
    // argv (e.g. a dropped --no-chrome), which a wholesale _spawnPty mock cannot.
    // Undefined in production → the genuine dynamic import runs unchanged.
    if (this._ptyModOverride) {
      ptyMod = this._ptyModOverride
    } else {
      try {
        ptyMod = await import('node-pty')
      } catch (err) {
        this.emit('error', { message: `node-pty unavailable: ${err.message}` })
        return
      }
    }

    const cwdReal = realpathSync(this.cwd)
    const env = this._buildPtyEnv(permissionsEnabled)

    // #5307 (WP-0.1) — on a fresh session, set the conversation uuid with
    // `--session-id <id>` (claude requires a brand-new uuid here). On restore,
    // the same uuid is now claude's existing conversation id, so resume it with
    // `--resume <id>` instead — reusing `--session-id` with an already-used id
    // is rejected by claude. Falls back to the fresh path whenever the session
    // wasn't seeded from a persisted id. Resume-failure handling (claude can't
    // find the conversation, e.g. cleared ~/.claude history) surfaces via the
    // warmup `_ptyExited` error path → bounded respawn (#5315) → and, when 5
    // resume-respawns all died during warmup AND the dying PTY tail confirms
    // claude does not know the conversation id, ONE drop-and-retry-FRESH
    // attempt with a new uuid (#5348/#5417, see _scheduleRespawn) before
    // exhaustion destroys the session.
    const idArgs = this._resumedFromPersisted
      ? ['--resume', this._sessionId]
      : ['--session-id', this._sessionId]
    const args = [
      ...idArgs,
      '--settings', this._settingsPath,
      // Claude Code 2.1.186 added a "Claude in Chrome extension detected"
      // first-run prompt that interactively blocks the TUI (1/2/Enter/Esc) when
      // the browser extension is installed. chroxy's PTY driver can't dismiss
      // that prompt, so the session wedges and the claude PTY exits mid-turn
      // (code=1). A headless chroxy TUI session never drives the browser
      // integration, so disable it at spawn — no prompt, no wedge.
      '--no-chrome',
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
      // node-pty spawns CLAUDE directly — no cmd.exe routing needed even when
      // the Windows resolver lands on a `claude.cmd` shim. node-pty routes
      // through conpty/cmd.exe internally and runs a `.cmd` fine (verified),
      // unlike child_process.spawn which throws EINVAL on a `.cmd` (Node 24) and
      // needs the utils/win-spawn.js escaping the cli-session path uses.
      this._term = ptyMod.spawn(CLAUDE, args, {
        name: 'xterm-256color',
        // #5839: single-sourced default so the dashboard mirror renders at the
        // same grid. #5835 Phase 2: a prior resize is preserved across respawns
        // via _ptyCols/_ptyRows (seeded from CLAUDE_TUI_PTY_SIZE on construct).
        cols: this._ptyCols,
        rows: this._ptyRows,
        cwd: cwdReal,
        env,
      })
    } catch (err) {
      this.emit('error', { message: `Failed to spawn claude under PTY: ${err.message}` })
      return
    }

    // #5315 (WP-2.1) review — destroy() can race an in-flight (re)spawn: it kills
    // the OLD _term and sets _destroying while we're awaiting the spawn above, so
    // the PTY we just created would be orphaned (nothing left to kill it). If a
    // teardown landed during the await, kill the fresh PTY now and bail.
    if (this._destroying) {
      try { this._term.kill('SIGTERM') } catch {}
      this._term = null
      return
    }

    // #5321 (WP-4.1) — reset the output tails for THIS spawn so the warmup auth
    // scan (and a later _onPtyGone / stall scan) can't match a banner left over
    // from a prior process on a respawn. Constructor already empties these for
    // the first spawn; this covers every subsequent _respawnPty.
    this._outputTail = ''
    this._outputTailRaw = Buffer.alloc(0)
    // #6601: re-evaluate output-quiescence readiness for THIS spawn — require
    // fresh output before trusting a quiet stretch, so a leftover _lastOutputMs
    // from the prior process can't read as "ready" the instant we respawn (#6604).
    this._resetQuiescenceForSpawn()

    // #5794: a fresh PTY can swallow the first submit again, so re-arm the
    // first-turn submit nudge for the first message on THIS spawn. Reset after
    // the destroy-race guard above so an aborted (re)spawn doesn't clear it.
    this._firstTurnNudgedForSpawn = false
    // #6578: a (re)spawn can land on a new pid (wrapper shim) or a new sessionId
    // (retry-FRESH fallback), so the cached session-file path is stale — force
    // the next readiness probe to re-resolve (and scan immediately).
    this._resolvedSessionFile = null
    this._lastSessionDirScanMs = -Infinity

    this._term.onData((data) => {
      this._appendToOutputTail(data)
      // #5835 Phase 1: feed the live remote-viewer mirror (the authenticity
      // surface). Same raw bytes that go to _outputTail, but coalesced and
      // broadcast to subscribed clients so they can watch the real TUI redraw.
      this._feedTerminalMirror(data)
    })
    this._term.onExit((info) => this._onPtyGone(info, 'exit'))

    // #5311 (WP-1.1) — keep a per-session PTY fault from crashing the WHOLE
    // daemon (every session on the host) via an uncaught throw. node-pty's
    // internal socket 'error' handler (unixTerminal.js) returns silently for
    // EAGAIN/EIO (the normal child-exit path, which surfaces through onExit
    // above) but for any OTHER error it calls _close() + emits 'close' and then
    // `throw err` UNLESS the Terminal has >= 2 'error' listeners. It never
    // emits 'error' to those listeners — they exist solely to clear that
    // rethrow threshold. So:
    //   - drive the actual teardown off 'close' (which node-pty DOES emit), and
    //   - also off 'error' in case a future node-pty starts emitting it, and
    //   - register a second no-op 'error' listener so the count is >= 2 and the
    //     otherwise-uncaught throw is suppressed.
    // _onPtyGone is idempotent (guards on _ptyExited) so onExit + close + error
    // firing in any order tears down + emits exactly once.
    this._term.on('error', (err) => this._onPtyGone(null, `error: ${err?.message || 'unknown'}`))
    this._term.on('error', () => {}) // bumps listener count >= 2 so node-pty does not rethrow
    this._term.on('close', () => this._onPtyGone(null, 'close'))

    // Wait for the TUI to reach status=idle before returning. The prior
    // implementations (hardcoded sleep, then glyph screen-scrape across
    // #4014/#4031/#4035/#4039) all failed silently when claude's render
    // shape didn't match expectation. #4040 swaps to claude's own
    // session file — `~/.claude/sessions/<pid>.json` carries a `status`
    // field claude updates on every state transition. Atomic, kernel-
    // backed, decoupled from TUI rendering changes. On miss we still
    // proceed so a transient FS race doesn't brick the session.
    const ready = await this._waitForPrompt(ClaudeTuiSession.SPAWN_WARMUP_MAX_MS, { detectAuthFailure: true })
    // #5321 (WP-4.1) — also scan once on the timeout fallback (a logged-out
    // claude may print its login prompt and then sit there without ever exiting
    // or writing a `status`, so the in-loop scan above could miss a late banner).
    if (!ready && !this._ptyExited && !this._authFailureDetected && this._scanOutputForAuthFailure()) {
      this._authFailureDetected = true
    }
    if (this._authFailureDetected) {
      log.warn(`claude TUI auth failure detected during warmup — ${AUTH_REQUIRED_CODE}`)
      // start() inspects _authFailureDetected and rejects with AUTH_REQUIRED.
      return
    }
    if (!ready && !this._ptyExited) {
      ;(this._log || log).warn(
        `TUI session file did not reach status=idle within ${ClaudeTuiSession.SPAWN_WARMUP_MAX_MS}ms${this._degradedProbeSuffix()} — proceeding (first sendMessage may stall)\n` +
        `_outputTail dump:\n${this._outputTailLogDump()}`,
      )
    }
  }

  /**
   * #5328 (WP-5.6) / #6578: build the diagnostic suffix for a readiness-probe
   * timeout. Since #6578 the probe resolves the session file by matching
   * `sessionId` (resolveSessionFile) and treats existence-with-matching-id as
   * ready even when the file carries no `status`, so `_lastProbeSawStatus` now
   * means "resolved a matching session file". That collapses the degraded case
   * to ONE: no session file carrying this session's `sessionId` was found
   * anywhere under ~/.claude/sessions — neither at the pty pid nor via the
   * dir-scan. Likely causes: a wrapper shim whose real claude writes to a
   * DIFFERENT ~/.claude (so no matching file is reachable), or claude never
   * wrote the file. Returns '' when the probe resolved a matching file (found
   * but busy = healthy, real busy).
   */
  _degradedProbeSuffix() {
    if (this._lastProbeSawStatus !== false) return ''
    const pid = this._term && this._term.pid
    const pidNote = Number.isInteger(pid) && pid > 0 ? ` (pty pid ${pid})` : ''
    const idNote = this._sessionId ? ` sessionId ${this._sessionId}` : ' (no sessionId)'
    return ` — no session file for${idNote} found under ~/.claude/sessions${pidNote}; claude may be running under a different pid or a different ~/.claude (a wrapper shim that forks node without exec, or a redirected HOME), so the readiness probe can't resolve its state and readiness gating is effectively disabled for this session`
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
  async _waitForPrompt(timeoutMs, { detectAuthFailure = false } = {}) {
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
    const startMs = this._nowMonotonic()
    const finish = (ready) => {
      const elapsedMs = this._nowMonotonic() - startMs
      if (this._activeTurn) {
        this._activeTurn.waitForPromptMs = elapsedMs
        this._activeTurn.waitForPromptReady = ready
        this._activeTurn.waitForPromptSawStatus = this._lastProbeSawStatus
      }
      log.info(`waitForPrompt (msg=${this._activeTurn?.messageId ?? 'none'} elapsedMs=${elapsedMs} sawStatus=${this._lastProbeSawStatus} ready=${ready})`)
      // #5777 FIX-0 (diagnostic) — readiness is a session-FILE status check,
      // decoupled from what the TUI renders, so claude can report status:idle
      // (ready=true) WHILE a one-shot startup interstitial (trust dialog,
      // release-notes / opus-notice / remote-control upsell / onboarding) is
      // on screen and silently swallowing the injected first prompt → the
      // consumed=0 first_output_timeout wedge (#5777). The existing tail dumps
      // only fire on !ready, so that wedged-but-"ready" screen was invisible.
      // Dump the readable tail ONCE per session on the first ready so the exact
      // interstitial can be named and FIX-1's detector anchored on a real
      // token. Opt-in (CHROXY_TUI_DUMP_READY_TAIL=1) so healthy sessions are
      // untouched; one-shot latch so even when enabled it logs at most once.
      if (ready && !this._readyTailDumped && process.env.CHROXY_TUI_DUMP_READY_TAIL === '1') {
        this._readyTailDumped = true
        // #5322 redaction: route through _outputTailDiagnostic() (redactSensitive
        // + bounded slice) instead of dumping raw _outputTail, so an enabled
        // diagnostic can't leak token-shaped secrets into the server log.
        const tail = this._outputTailDiagnostic()
        log.info(`waitForPrompt ready-path tail (FIX-0 #5777, msg=${this._activeTurn?.messageId ?? 'none'}):\n${tail}`)
      }
      return ready
    }
    const pid = this._term && this._term.pid
    if (!Number.isInteger(pid) || pid <= 0) {
      this._lastProbeSawStatus = false
      return finish(false)
    }
    // #6578: resolve the session file by matching `sessionId` (not just the pty
    // pid) so a wrapper-shim install (real claude pid != pty pid, MODE A) still
    // finds the file, and treat the file's EXISTENCE-with-matching-sessionId as
    // a readiness signal because current claude session files carry no `status`
    // field at all (MODE B). `_lastProbeSawStatus` now means "resolved a
    // matching session file this poll" (not "read a non-null status string").
    let sawStatus = false
    const checkReady = () => {
      // Reuse the cached path when it still resolves to this session's file;
      // re-resolve (dir-scan) when the cache is cold or has gone stale (file
      // deleted / sessionId changed). Caching keeps the per-turn probe from
      // scanning ~/.claude/sessions every poll.
      let sessFile = this._resolvedSessionFile
      if (!sessFile || !ClaudeTuiSession._sessionFileMatches(sessFile, this._sessionId)) {
        // Throttle the readdir-heavy dir-scan to ~2/sec during the cold-resolve
        // warmup window. The cheap fast-path (pty-pid file read) still runs every
        // 100ms poll; only the fallback scan is rate-limited — so a MODE-A file
        // (real pid != pty pid) is still detected within ~500ms of appearing,
        // negligible against the multi-second warmup.
        const now = this._nowMonotonic()
        const allowDirScan = (now - this._lastSessionDirScanMs) >= 500
        if (allowDirScan) this._lastSessionDirScanMs = now
        sessFile = ClaudeTuiSession.resolveSessionFile(this._sessionId, pid, { allowDirScan })
        this._resolvedSessionFile = sessFile
      }
      if (!sessFile) {
        // #6601: no session file resolved. Current claude's INTERACTIVE TUI
        // writes no ~/.claude/sessions/<pid>.json at all, so the file probe
        // never resolves and the caller used to burn the full warmup/turn
        // ceiling then "write anyway" (the degraded path). Fall back to PTY
        // OUTPUT QUIESCENCE: once claude has rendered on this spawn and output
        // has been quiet for READY_QUIESCENCE_MS, the composer's render burst has
        // settled and it is ready for input. Validated live (cold ready ~1.1s,
        // between-turn redraw sub-second). The file path below is UNCHANGED for
        // -p / claude-desktop / any version that DOES write a file; the
        // warmup/turn ceilings still backstop a genuinely-stuck TUI, and the
        // auth-failure scan (poll loop, above this) still runs first so a
        // logged-out banner can't be mistaken for a settled composer.
        return this._sawFirstOutput &&
          (this._nowMonotonic() - this._lastOutputMs) >= ClaudeTuiSession.READY_QUIESCENCE_MS
      }
      // A matching file was resolved → we have this session's readiness signal.
      sawStatus = true
      const status = ClaudeTuiSession.readSessionStatus(sessFile)
      // Ready = a status is present and it's not 'busy' (versions that still
      // write status keep between-turn gating), OR the file exists with no
      // status field at all (current claude — existence IS the ready signal).
      return status === null ? true : status !== 'busy'
    }
    while (this._nowMonotonic() - startMs < timeoutMs) {
      if (this._ptyExited) {
        this._lastProbeSawStatus = sawStatus
        return finish(false)
      }
      // #5321 (WP-4.1) — short-circuit the (up to 90s) warmup wait the moment
      // claude prints a logged-out / expired-login message, so start() can
      // surface AUTH_REQUIRED immediately instead of burning the full timeout
      // on a session that can never become ready. Warmup-only (opt-in) so
      // normal per-turn output is never scanned.
      if (detectAuthFailure && this._scanOutputForAuthFailure()) {
        this._authFailureDetected = true
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
   * #6601: reset the output-quiescence readiness state for a fresh (re)spawn —
   * clear the "saw first output" gate and re-stamp `_lastOutputMs` to now, so a
   * leftover `_lastOutputMs` from the prior process can't read as "ready" the
   * instant we respawn. The counterpart to `_appendToOutputTail` (which SETS
   * these). Extracted from `_spawnPty` so the guard is unit-testable without a
   * real PTY (#6604).
   */
  _resetQuiescenceForSpawn() {
    this._sawFirstOutput = false
    this._lastOutputMs = this._nowMonotonic()
  }

  /**
   * Append a PTY onData chunk to the recent-output tails (#3919).
   *
   * Maintains two tails:
   *   - `_outputTailRaw` — an UNSTRIPPED byte Buffer for the timeout hex
   *     dump (#4031), and the canonical source the readable tail is
   *     derived from.
   *   - `_outputTail` — an ANSI-stripped, human-readable string for inline
   *     error diagnostics and the auth-failure scan.
   *
   * #5325 (WP-5.3): the readable tail is derived by stripping ANSI from
   * the CONCATENATED raw buffer, NOT per-chunk. An escape sequence split
   * across two onData chunks (e.g. "\x1b[" arriving in one chunk, "0m" in
   * the next) survives a per-chunk strip and corrupts the tail; deriving
   * from the merged buffer strips the sequence once it's whole. We don't
   * visual-render the PTY, so the colors aren't useful. Strip pattern
   * covers CSI / OSC / SS3 / single-char terminal-mode codes (#4031).
   */
  _appendToOutputTail(data) {
    // #6601: output-quiescence readiness — stamp the recency of PTY output so
    // checkReady can detect a settled composer (see READY_QUIESCENCE_MS) when no
    // session file exists. Two cheap field writes on a hot (per-redraw) path.
    this._lastOutputMs = this._nowMonotonic()
    this._sawFirstOutput = true
    const rawStr = String(data)
    const chunk = Buffer.from(rawStr, 'utf8')
    // #5794/#5809: monotonic total — never capped, so the nudge's progress check
    // works even when _outputTail is pinned at PTY_TAIL_BYTES.
    this._totalOutputBytes += chunk.length
    const merged = this._outputTailRaw.length === 0
      ? chunk
      : Buffer.concat([this._outputTailRaw, chunk])
    this._outputTailRaw = merged.length > ClaudeTuiSession.PTY_TAIL_BYTES
      ? merged.subarray(-ClaudeTuiSession.PTY_TAIL_BYTES)
      : merged
    this._outputTail = this._outputTailRaw
      .toString('utf8')
      .replace(ANSI_STRIP, '')
      .slice(-ClaudeTuiSession.PTY_TAIL_BYTES)
  }

  /**
   * #5835 Phase 1: feed the live remote-viewer mirror. Appends a raw PTY chunk
   * (ANSI intact — the viewer xterm renders it) to the coalescing buffer and
   * arms a single flush timer if one isn't already pending. The bytes are NOT
   * stripped or transformed: faithful reproduction is the whole point.
   */
  _feedTerminalMirror(data) {
    // #5837: skip ALL coalescer work when nobody is subscribed to this session's
    // mirror. This is the common case (the Output tab is closed), and onData fires
    // very frequently — gating here saves the per-redraw string concat + timer +
    // session_event for the whole life of an unwatched session.
    if (!this._terminalMirrorActive) return
    this._mirrorBuffer += String(data)
    if (this._mirrorTimer) return
    this._mirrorTimer = setTimeout(() => this._flushTerminalMirror(), ClaudeTuiSession.MIRROR_FLUSH_MS)
    // Don't keep the event loop alive for a mirror flush — teardown clears it.
    if (typeof this._mirrorTimer.unref === 'function') this._mirrorTimer.unref()
  }

  /**
   * #5837: turn the live mirror coalescer on/off based on whether any client is
   * subscribed to this session's terminal. WsServer calls this when the
   * terminal-subscriber count crosses 0↔1. When turning OFF, drop any pending
   * buffer/timer (nobody is watching, so a trailing flush is pure waste) — this
   * reuses the same teardown as _clearTerminalMirror.
   */
  setTerminalMirrorActive(active) {
    const next = !!active
    if (next === this._terminalMirrorActive) return
    this._terminalMirrorActive = next
    if (!next) this._clearTerminalMirror()
  }

  /**
   * Emit the coalesced mirror buffer as one `terminal_output` event and reset.
   * No-op when the buffer is empty (e.g. a stray flush after teardown).
   */
  _flushTerminalMirror() {
    this._mirrorTimer = null
    const data = this._mirrorBuffer
    if (!data) return
    this._mirrorBuffer = ''
    this.emit('terminal_output', { data })
  }

  /**
   * #5835 Phase 2: the live PTY's current grid size, for a newly-subscribing
   * viewer to letterbox to (and for tests). Always reflects the last applied
   * resize, or the spawn default before any resize.
   * @returns {{cols: number, rows: number}}
   */
  getTerminalSize() {
    return { cols: this._ptyCols, rows: this._ptyRows }
  }

  /**
   * #5835 Phase 2: resize the live PTY (the remote-viewer mirror). Clamps to the
   * same bounds the protocol schema enforces so a bad caller can't throw inside
   * node-pty, records the size so it survives a respawn, and applies it to the
   * running PTY when one exists (a resize requested before/after the PTY is alive
   * still updates the tracked size, taking effect on the next spawn). The real
   * TUI redraws at the new size; those bytes flow out through the normal mirror.
   * @returns {{cols: number, rows: number}|null} the applied size, or null if the
   *   request was a no-op (unchanged) so the caller can skip a redundant broadcast.
   */
  resizeTerminal(cols, rows) {
    const c = Math.max(1, Math.min(1000, Math.floor(Number(cols))))
    const r = Math.max(1, Math.min(1000, Math.floor(Number(rows))))
    // Load-bearing guard: NaN (e.g. resizeTerminal('x', 'y')) survives
    // Math.floor/min/max unchanged, so the clamp above does NOT guarantee
    // finiteness — without this a NaN would reach _term.resize. Don't remove.
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null
    if (c === this._ptyCols && r === this._ptyRows) return null
    this._ptyCols = c
    this._ptyRows = r
    if (this._term && !this._ptyExited) {
      try {
        this._term.resize(c, r)
      } catch (err) {
        // A resize race against PTY teardown shouldn't crash the daemon; the
        // tracked size still applies on the next spawn.
        log.warn(`claude-tui resize failed (${c}x${r}): ${err?.message || err}`)
      }
    }
    // Tell subscribed viewers the new authoritative size (ws-forwarding routes
    // this to terminal subscribers as `terminal_size`), so observers re-letterbox
    // and the requesting primary renders the confirmed grid.
    this.emit('terminal_resize', { cols: c, rows: r })
    return { cols: c, rows: r }
  }

  /**
   * #6313: force the live PTY to repaint by toggling the grid width one column and
   * back. Each resize sends SIGWINCH, so the real TUI redraws its canvas (and a
   * shell prompt redraws its current line). This is the only recovery for the
   * stateless raw-byte mirror after a WS-backpressure-dropped frame desyncs the
   * xterm grid — there is no app-level snapshot to replay. The width is restored,
   * so the authoritative size is unchanged. No-op (false) when there is no live
   * PTY. Caveat: a process that ignores SIGWINCH won't repaint.
   * @returns {boolean} whether a repaint was driven against a live PTY.
   */
  forceTerminalRepaint() {
    if (!this._term || this._ptyExited) return false
    const { cols, rows } = this.getTerminalSize()
    // Toggle to a definitely-different width (cols-1, or 2 when at the 1-col
    // floor) then restore — each resizeTerminal call changes the width so neither
    // hits its unchanged-size no-op guard, and the original grid is restored.
    const toggleCols = cols > 1 ? cols - 1 : 2
    this.resizeTerminal(toggleCols, rows)
    this.resizeTerminal(cols, rows)
    return true
  }

  /**
   * #5835 Phase 3: write raw client keystrokes to the live PTY — true remote
   * control (the read-only mirror becomes interactive). Bytes are written AS-IS:
   * no prompt throttle (interactive keys arrive naturally paced over the wire;
   * the throttle exists only for bulk programmatic prompts) and no transform
   * (faithful remote keyboard, including control bytes like \x03 / escape seqs).
   * The handler enforces authority (bound session + primary-ownership gate); this
   * just writes. No-op (returns false) when there is no live PTY.
   * @returns {boolean} true if the bytes were written to a live PTY.
   */
  writeTerminalInput(data) {
    if (typeof data !== 'string' || data.length === 0) return false
    if (!this._term || this._ptyExited || this._destroying) return false
    try {
      this._term.write(data)
      return true
    } catch (err) {
      log.warn(`claude-tui terminal input write failed: ${err?.message || err}`)
      return false
    }
  }

  /**
   * Drop any pending mirror flush + buffered bytes. Called on teardown so a
   * dead PTY's leftover frame never broadcasts and no timer leaks.
   */
  _clearTerminalMirror() {
    if (this._mirrorTimer) {
      clearTimeout(this._mirrorTimer)
      this._mirrorTimer = null
    }
    this._mirrorBuffer = ''
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
    //
    // #5322 (WP-4.2, security) — redact token-shaped runs BEFORE hex-encoding so
    // a pasted/echoed OAuth token can't leak via the dump's hex AND ASCII
    // columns. The redact runs on a latin1 (binary) round-trip, which preserves
    // every byte 0–255 losslessly (so 0x1b / OSC / SS3 escape bytes still land
    // in the dump); redactSensitive only rewrites the ASCII token runs.
    // #5358: redactSensitivePreservingEscapes is used ALONE (NOT layered after
    // redactSensitive). It must see the ORIGINAL bytes to reassemble a token the
    // TUI split with a mid-token escape: running redactSensitive first would
    // partially redact a marker-prefixed split token (e.g. `token=sk-ant-AAAA`
    // → `token= [REDACTED]`), consuming the marker so the escape-aware pass can
    // no longer detect the run — and the tail after the escape would LEAK. This
    // pass covers the contiguous case too (same patterns, incl. Bearer / JWT /
    // key=value), scrubbing token chars to 'X' while preserving the escape bytes
    // the dump exists to show.
    const latin1 = this._outputTailRaw.toString('latin1')
    const redacted = Buffer.from(redactSensitivePreservingEscapes(latin1), 'latin1')
    return formatHexDump(redacted, ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES)
  }

  /**
   * Log-facing variant of the PTY tail dump. Token-shaped runs are ALWAYS
   * redacted (#5322/#5358), but the full hex dump still emits prompt/answer
   * CONTENT verbatim (question text, answer text, attachment names) at info
   * level — residual content-at-rest exposure in ~/.chroxy/logs. So the full
   * dump is gated behind CHROXY_DEBUG_PTY_TAIL; by default we emit a compact
   * structural summary (redacted byte length + a bounded 32-byte hex preview,
   * mirroring pty-driver.js's #4805 incident-response footprint). Every log
   * call site routes through here; the unit-tested `_outputTailHexDump()`
   * remains the full redacted dump. (audit P2-12)
   */
  _outputTailLogDump() {
    if (process.env.CHROXY_DEBUG_PTY_TAIL) return this._outputTailHexDump()
    const latin1 = this._outputTailRaw.toString('latin1')
    const redacted = Buffer.from(redactSensitivePreservingEscapes(latin1), 'latin1')
    if (redacted.length === 0) return '<empty>'
    const sampleHex = redacted.slice(0, 32).toString('hex')
    const truncated = redacted.length > 32 ? ',…' : ''
    return `${redacted.length} bytes redacted (set CHROXY_DEBUG_PTY_TAIL=1 for full dump; sample=${sampleHex}${truncated})`
  }

  /**
   * #5321 (WP-4.1) — classify the ANSI-stripped PTY tail as a subscription-auth
   * failure (logged out / expired login). Returns true when claude's output
   * matches an AUTH_FAILURE_PATTERNS entry. Called during warmup (before ready)
   * and once a turn has stalled / the PTY exited — those tails CAN contain
   * rendered response text, so the false-positive defence lives in the patterns
   * themselves: each requires claude's `/login` / `claude login` remediation
   * command token, which a model merely *discussing* authentication won't emit.
   */
  _scanOutputForAuthFailure() {
    const tail = this._outputTail || ''
    if (!tail) return false
    // Collapse whitespace (the TUI wraps/box-pads the banner with newlines +
    // spaces) so a line-wrapped "Please run\n  /login" still matches.
    const normalized = tail.replace(/\s+/g, ' ')
    return AUTH_FAILURE_PATTERNS.some((re) => re.test(normalized))
  }

  /**
   * #5417 — classify the ANSI-stripped PTY tail as a "--resume id unknown"
   * failure. The PTY merges stdout+stderr, so the same diagnostics
   * CliSession's stderr classifier pins ("No conversation found with session
   * ID …" — RESUME_UNKNOWN_STDERR_PATTERNS in cli-session.js, #4929/#4950)
   * land in `_outputTail` when claude rejects a `--resume <id>` and exits
   * during warmup. `_outputTail` is reset at the top of every _spawnPty, so a
   * match always describes the MOST RECENT death, never a stale prior
   * attempt.
   *
   * Matching is PER LINE plus adjacent-line pairs — NOT one collapsed blob.
   * CliSession's classifier tests each stderr line separately, which bounds
   * the `.*` in the #4950 co-occurrence patterns (e.g.
   * `/(fail|error|…).*resum(e|ing).*(session|conversation|\bid\b)/i`) to a
   * single line. Collapsing the whole 4KB tail into one string would let
   * those patterns match "error" + "resume" + "session" scattered across
   * UNRELATED lines — and a `--resume` warmup re-renders the restored
   * transcript into the tail, so ordinary conversation content (the exact
   * large-but-present-conversation crash this gate exists to protect) could
   * false-positive and abandon a real conversation id. Joining each adjacent
   * line pair (whitespace-collapsed, mirroring _scanOutputForAuthFailure's
   * normalization) still catches a rejection the TUI wrapped/box-padded
   * across one rendered line break, while keeping the match window ≤ two
   * lines instead of the whole tail. Consulted by _scheduleRespawn at the
   * respawn cap to decide retry-FRESH eligibility. The tail is only SCANNED
   * here, never logged — every diagnostic surface keeps routing through the
   * redaction helpers (_outputTailDiagnostic / _outputTailHexDump,
   * #5322/#5358).
   */
  _scanOutputForUnknownResume() {
    const tail = this._outputTail || ''
    if (!tail) return false
    const lines = tail
      .split(/[\r\n]+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (lines.length === 0) return false
    const candidates = lines.slice()
    for (let i = 0; i + 1 < lines.length; i++) candidates.push(`${lines[i]} ${lines[i + 1]}`)
    return stderrIndicatesUnknownResume(candidates)
  }

  async sendMessage(prompt, attachments, _options = {}) {
    // #5800: these two guards signal failure to callers via a typed result
    // ({ ok: false, reason }) IN ADDITION to the legacy emit('error', ...).
    // The emit is unchanged (existing error surfacing relies on it); the
    // typed return lets a caller (e.g. the multi-select reinject path in
    // form-driver.js) observe the failure via the call result instead of
    // mirroring these host internals from the outside. The happy path
    // returns undefined as before — callers branch only on the failure
    // shape. input-handlers.js (the non-reinject caller) ignores the
    // resolved value entirely; it only attaches a defensive .catch, which a
    // resolved typed object never trips.
    if (this._isBusy) {
      this.emit('error', { message: 'Already processing a message' })
      return { ok: false, reason: 'busy' }
    }
    if (!this._processReady || !this._term || this._ptyExited) {
      this.emit('error', { message: 'Session not started or PTY no longer alive' })
      return { ok: false, reason: 'not_runnable' }
    }

    this._isBusy = true
    this._messageCounter += 1
    const messageId = `${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId
    const startedAt = this._nowMonotonic()
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
      ;(this._log || log).warn(
        `TUI session file not at status=idle before turn (msg=${messageId})${this._degradedProbeSuffix()} — writing anyway\n` +
        `_outputTail dump:\n${this._outputTailLogDump()}`,
      )
    }
    if (this._ptyExited) {
      const code = this._ptyExitInfo?.exitCode
      const signal = this._ptyExitInfo?.signal
      this._finishTurnError(`Claude PTY exited before prompt write (code=${code}${signal ? ` signal=${signal}` : ''})`, messageId)
      // #5813: return the typed failure (like the up-front busy/not_runnable
      // guards) so callers that key off `result.ok === false` — e.g. the reinject
      // stop-and-wait watch-close in form-driver.js — don't have to rely on
      // _finishTurnError's side-effect to know the turn never started.
      return { ok: false, reason: 'pty_exited' }
    }
    // If the user clicked Stop during the probe wait, interrupt() has
    // already written Ctrl-C to the PTY and marked the turn aborted.
    // Writing the prompt now would queue it behind the cancel and either
    // execute against a half-reset TUI or silently desync busy state
    // (server clears busy via _finishTurnError below, but the TUI might
    // still process the bytes once it returns to prompt). Bail cleanly.
    if (this._activeTurn?.aborted) {
      this._finishTurnError('Turn aborted before prompt write', messageId)
      return { ok: false, reason: 'aborted' } // #5813: typed failure
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
      // #5813: typed failure. _writePtyTextThrottled returns false for BOTH an
      // aborted turn AND a mid-write PTY exit, so report the actual cause (#5848
      // review) rather than always labelling it 'aborted'.
      if (!completed) return { ok: false, reason: this._ptyExited ? 'pty_exited' : 'aborted' }
    } catch (err) {
      this._finishTurnError(`Failed to write prompt to PTY: ${err.message}`, messageId)
      return { ok: false, reason: 'write_failed' } // #5813: typed failure
    }

    // Arm soft + hard inactivity timers (#3920). Each new hook file the
    // poll loop drains re-arms both, so a long turn that's making
    // progress (tool calls firing, intermediate hooks) never trips them.
    // Soft fires once per silent stretch → inactivity_warning;
    // hard fires after the full window of silence → force-clear + error.
    this._armResultTimeout()

    // #5777/#5794: on the FIRST message of each (re)spawn, schedule the submit
    // nudge. A freshly-spawned TUI sometimes reports ready before its composer
    // accepts the trailing \r, so the prompt sits typed-but-unsent. If no hook
    // output arrives within the window, _scheduleFirstTurnSubmitNudge re-sends a
    // bare \r (a no-op on an already-submitted/empty composer, a submit on a
    // stuck one). Two gates keep the blast radius minimal:
    //   - #5794 (1): single-line only. A multi-line prompt takes the
    //     bracketed-paste path in _writePtyTextThrottled (its own `hasNewlines`
    //     check, mirrored here on the SAME promptToSend the write used), where a
    //     bare \r is interpreted as a newline-in-composition / can submit a
    //     partial paste — not a safe re-submit. Skip the nudge for that path.
    //   - #5794 (2): first-message-per-spawn, not lifetime-first. `_messageCounter`
    //     is monotonic and never reset, so the old `=== 1` gate left a post-respawn
    //     wedge un-nudged. The `_firstTurnNudgedForSpawn` latch (reset in
    //     _spawnPty) re-arms once per (re)spawn instead.
    const hasNewlines = /\r?\n/.test(promptToSend || '')
    if (!this._firstTurnNudgedForSpawn && !hasNewlines) {
      this._firstTurnNudgedForSpawn = true
      this._scheduleFirstTurnSubmitNudge(messageId)
    }

    // Poll the sink dir for new hook files. mktemp-named filenames make each
    // turn's Stop / Pre / Post events distinct from previous turns'; the
    // session-level _consumedFiles Set ensures we never re-process a file
    // that an earlier turn already handled.
    const HOOK_TIMEOUT_MS = this._hardTimeoutMs
    const pollStart = this._nowMonotonic()
    let stopPayload = null
    // Wedge instrumentation (#4678 follow-up): track loop progress so
    // a wedge that manifests as "stuck waiting for stop-hook" produces
    // a heartbeat log every HOOK_HEARTBEAT_MS — without this we cannot
    // tell whether the loop is iterating but the sink dir stays empty,
    // or whether the loop itself has stopped iterating.
    let pollIters = 0
    let lastHeartbeatMs = pollStart
    // #5323 (WP-5.1) — track consumed-file count explicitly. We can no longer
    // infer progress from `_consumedFiles.size` because consumed files are now
    // unlinked + dropped from the Set in the same drain, so the Set size doesn't
    // grow. This cumulative counter drives the heartbeat/exit diagnostics.
    let totalConsumed = 0

    const drainHookFiles = async () => {
      let entries
      try {
        entries = await this._boundedHookFs('readdir', this._sinkDir)
      } catch (err) {
        // #6178: a hung sink fs (FUSE/NFS freeze) — DON'T treat it as deletion.
        // Skip this pass and return; the while-guard re-checks HOOK_TIMEOUT_MS so
        // the turn self-terminates via the hard-timeout watchdog instead of
        // awaiting a frozen mount. Recreating the sink (below) would be wrong (the
        // dir isn't gone, it's slow) and its sync mkdir could itself block.
        if (err && err.code === 'HOOK_FS_TIMEOUT') {
          log.warn(`hook drain readdir timed out (${this._hookFsTimeoutMs}ms) — sink fs may be stuck; skipping pass`)
          return
        }
        // #5329 (IP-1): the sink lives under /tmp, which a tmpwatch sweep, a
        // tmpfs clear, or a manual rm can delete mid-turn. A silent return here
        // spins this poll loop to the hard timeout while every claude
        // `cat > <sink>/…` hook write also fails — the turn wedges with no
        // signal. Try to recover the sink (recreate the same path so hook
        // delivery resumes); fail loud if recreation itself fails.
        this._recoverSinkDir(err)
        return
      }
      // Per-drain progress counter — replaces the old `_consumedFiles.size`
      // delta, which no longer changes now that consumed files are unlinked +
      // pruned (#5323). Drives the first-output disarm + timer re-arm below.
      let drainedThisPass = 0
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
          // #6178: bounded + coalesced — a timeout rejects and folds into this
          // skip-and-retry (same as a partial-write/parse failure: re-read next
          // pass), and the SAME readFile is re-raced rather than re-issued.
          const raw = await this._boundedHookFs('readFile', full)
          if (raw.length === 0) continue  // partial write — poll again
          parsed = JSON.parse(raw)
        } catch { continue }
        this._consumedFiles.add(name)
        drainedThisPass++
        totalConsumed++

        if (name.startsWith('stop-')) {
          stopPayload = parsed
        } else {
          try {
            this._emitToolHookEvent(name.startsWith('pre-') ? 'PreToolUse' : 'PostToolUse', parsed, messageId)
          } catch (err) {
            log.warn(`tool hook emit failed: ${err.message}`)
          }
        }
        // #5323 (WP-5.1) — unlink the consumed hook file so the per-session sink
        // dir stays bounded over a long-lived persistent PTY (one file per turn
        // + 2 per tool call accumulate fast). On a successful unlink drop the
        // name from _consumedFiles too — the on-disk file is gone, so it can't be
        // re-read, which keeps the Set bounded as well (filenames are UUID-unique
        // so there's no cross-turn collision to guard against). If unlink fails
        // (rare), KEEP the name in _consumedFiles as the dedup guard so a later
        // readdir can't re-process it.
        try {
          // #6178: bounded — a timeout rejects into the catch below, which keeps
          // the name in _consumedFiles as the dedup guard (same as any unlink
          // failure), so a stuck unlink can't re-process the file or wedge. The
          // file then stays on disk (never re-unlinked); on a permanently stuck
          // mount that's bounded sink growth, with sweepStaleSinkDirs as backstop.
          await this._boundedHookFs('unlink', full)
          this._consumedFiles.delete(name)
        } catch { /* leave the dedup guard in place */ }
      }
      // Any new hook file = progress evidence. Re-arm timers so a turn
      // that's actively producing tool events doesn't trip the soft
      // inactivity warning (#3920). #5323: gate on the per-drain counter, NOT
      // `_consumedFiles.size` (which no longer grows — files are unlinked +
      // pruned), otherwise the disarm/re-arm would stop firing on progress.
      if (drainedThisPass > 0 && this._isBusy) {
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

    while (this._nowMonotonic() - pollStart < HOOK_TIMEOUT_MS) {
      if (this._activeTurn?.aborted) break
      if (this._ptyExited) break
      // _handleHardTimeout clears _isBusy; bail out cleanly if it fired.
      if (!this._isBusy) break
      await drainHookFiles()
      pollIters++
      // Wedge instrumentation (#4678 follow-up): if the loop has been
      // running >= HOOK_HEARTBEAT_MS since the last heartbeat with no
      // stop-hook, emit a progress line. Sized at 5s so a healthy
      // ~2-5s tool turn emits zero heartbeats while a wedge gets
      // logged every 5s with sink-dir state.
      const now = this._nowMonotonic()
      if (now - lastHeartbeatMs >= ClaudeTuiSession.HOOK_HEARTBEAT_MS) {
        lastHeartbeatMs = now
        let sinkFileCount = 0
        // #6178 (review): shares the coalesced readdir slot with the drain, so the
        // heartbeat never enqueues a second stuck readdir on a frozen mount.
        try { sinkFileCount = (await this._boundedHookFs('readdir', this._sinkDir)).length } catch {}
        log.info(`hookPoll heartbeat (msg=${messageId} iters=${pollIters} elapsedMs=${now - pollStart} sinkFiles=${sinkFileCount} consumed=${totalConsumed} stopFound=${stopPayload ? 'yes' : 'no'})`)
      }
      if (stopPayload) break
      await new Promise((r) => setTimeout(r, 150))
    }
    // Wedge instrumentation (#4678 follow-up): always log the loop's
    // exit shape — whether it broke on stopPayload, abort, ptyExited,
    // !isBusy, or timeout. Pair with sendMessage's final summary to
    // reconstruct the wedge stage post-hoc.
    log.info(`hookPoll exit (msg=${messageId} iters=${pollIters} elapsedMs=${this._nowMonotonic() - pollStart} consumed=${totalConsumed} stopFound=${stopPayload ? 'yes' : 'no'} aborted=${this._activeTurn?.aborted ? 'yes' : 'no'} ptyExited=${this._ptyExited ? 'yes' : 'no'} stillBusy=${this._isBusy ? 'yes' : 'no'})`)

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
        reason = `Stop hook timeout after ${Math.round((this._nowMonotonic() - pollStart) / 1000)}s`
      }
      const tail = this._outputTailDiagnostic()
      this._finishTurnError(tail ? `${reason}\nTUI output tail:\n${tail}` : reason, messageId)
      return
    }

    const duration = this._nowMonotonic() - startedAt
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
    // Per-turn teardown: inactivity timers (#3920, #4638, #4732), pre-first-output
    // watchdog, per-turn attachment dir (#4022 — Read results are already in the
    // model's context window), the busy-state triple, and — previously MISSING on
    // this path — the AskUserQuestion sibling lock + stall watchdogs (#4604/#5319).
    // Shared with _finishTurnError so the two can't re-diverge. See helper doc.
    this._clearTurnEndState()
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
      // #5798: observability-only — did the model honor the reinject "stop and
      // wait" steer? When a flag-on multi-select reinject fired, the FormDriver
      // opened a watch window (this._reinjectStopWaitWatch). The model SHOULD
      // have ended its turn so the reinjected selection becomes a fresh turn; a
      // PreToolUse arriving while the window is still open means it kept going
      // and tool-called instead. Log a loud WARN with greppable fields, then
      // clear the marker (one-shot — log once per reinject). The window is also
      // cleared on the reinjected turn's first consumed hook
      // (_clearFirstOutputWatchdog) and on teardown/destroy/pty-gone, so this
      // fires ONLY for a tool_use in the gap between the deny and the reinjected
      // turn's start.
      //
      // Heuristic + honest false-pos/neg profile (this is a tunable measurement
      // aid, not a gate): the detector is "any PreToolUse observed while the
      // post-reinject-deny watch is open". FALSE POSITIVE risk: a leftover
      // pre-*.json hook file from the DENIED turn that drains after the marker is
      // set could trip the WARN even though it predates the reinject (the denied
      // form is denied before it renders, so no PostToolUse is expected, but a
      // racing pre- file is theoretically possible). FALSE NEGATIVE risk: if the
      // reinjected turn's own first legitimate output is a non-tool hook (or its
      // first PreToolUse is preceded by another consumed hook in the same drain
      // pass that clears the window first), a later "didn't stop" tool_use would
      // be missed. Both are acceptable for a default-on gating signal — count the
      // greppable token and tune later if the rate is noisy.
      if (this._reinjectStopWaitWatch) {
        const watch = this._reinjectStopWaitWatch
        this._reinjectStopWaitWatch = null
        const deltaMs = Math.round(this._nowMonotonic() - watch.at)
        ;(this._log || log).warn(`reinject stop-and-wait NOT honored (#5798, reinject_stop_wait_violation): model emitted tool_use after a multi-select reinject deny instead of stopping | deniedToolUseId=${watch.deniedToolUseId || '?'} newTool=${toolName} newToolUseId=${toolUseId} deltaMs=${deltaMs}`)
      }
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
          // #5320 (WP-3.3) — isolate this emit. A synchronous throw from a
          // listener here would skip the `user_question` emit + backstop suspend
          // below, leaving `_pendingUserAnswer` set with no dashboard prompt and
          // no recovery — an orphaned pending. Swallow + log so the question
          // still surfaces.
          try {
            this.emit('multi_question_intervention', {
              toolUseId,
              questionCount,
              reason: 'multi_question',
              timestamp: Date.now(), // #5332: wall-clock epoch — a payload field for clients, not a duration

            })
          } catch (err) {
            ;(this._log || log).warn(`multi_question_intervention listener threw (continuing): ${err?.message || err}`)
          }
        }
        this.emit('user_question', { toolUseId, questions })
        // #5318 (WP-3.1) — we're now blocked on a human answer. Suspend the
        // turn backstops immediately rather than waiting for the next drain-loop
        // _armResultTimeout(); the _armResultTimeout() guard keeps them suspended
        // across any subsequent re-arm until the answer's PostToolUse clears the
        // pending entry.
        this._suspendBackstopsForPendingQuestion()
        // #5792: a DENIED shape (multi-question OR any multi-select question) is
        // rejected at the permission hook, so claude Stops with no PostToolUse
        // and no answer ever arrives — the pending entry above would leak past
        // turn-end (the Stop success path keeps pending). Arm a reaper to drop
        // it. A legitimate single single-select is NOT a denied shape: it gets a
        // PostToolUse (or its own respondToQuestion stall watchdog) and is left
        // untouched.
        const isDeniedShape = questionCount > 1 || questions.some((q) => q && q.multiSelect === true)
        if (isDeniedShape) {
          this._armDeniedQuestionReaper(toolUseId)
        }
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
    // happy path). Cancel THIS tool's stall watchdog so it doesn't fire a
    // spurious ASK_USER_QUESTION_STALL error 30s later. #5319 (WP-3.2): clear
    // only this toolUseId's watchdog — a parallel sibling's watchdog stays armed.
    if (toolName === 'AskUserQuestion' && toolUseId) {
      this._clearAskUserQuestionWatchdog(toolUseId)
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
    const duration = this._nowMonotonic() - turn.startedAt
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

  /**
   * Common per-turn teardown shared by the success path and `_finishTurnError`
   * (audit P1-1). Both previously hand-rolled these clears and the success path
   * had DRIFTED — it omitted the AskUserQuestion sibling-lock clear and the
   * stall-watchdog clear, so a Stop-hook success whose PostToolUse never fired
   * could (a) leak the `askuserquestion-active` lock and spuriously deny the
   * NEXT turn's question inside the 60s stale-reclaim window (#4604), and
   * (b) leave an armed 30s watchdog that could tear down a later unrelated busy
   * turn. Routing both paths through one helper keeps them from re-diverging.
   *
   * Owns: the inactivity timers, the pre-first-output watchdog, the per-turn
   * attachment dir (cleaned BEFORE `_activeTurn` is nulled so it still has the
   * dir), the busy-state triple, the AskUserQuestion sibling lock, and the
   * per-toolUseId stall watchdogs.
   *
   * Deliberately does NOT call `_pendingUserAnswers_clearAll()`: neither caller
   * issues Ctrl-C, so a sibling AskUserQuestion answer already on the wire can
   * still validly consume its entry (#4802). The Ctrl-C / kill paths
   * (`_teardownTurn`, `interrupt`, `destroy`) clear pending answers themselves.
   *
   * DOES clear `_pendingBackgroundCommands` — the ephemeral intra-turn
   * tool_use→command lookup (#4307). Per its base-session contract that map is
   * dropped every turn (CLI/SDK do so via `_clearMessageState`): once a turn
   * ends, any run_in_background `tool_use` that never saw its result this turn is
   * stranded, and the agent re-emits a fresh `tool_use` next turn if it still
   * cares. This is NOT the cross-turn "waiting on background shell" state — that
   * lives in `_backgroundShellTracker` (transient-by-design, quiesced
   * separately) and is untouched here. Leaving the map uncleared per-turn was
   * the leak audit P1-1 flagged: ClaudeTuiSession is the only subclass that
   * didn't run the base per-turn reset.
   */
  _clearTurnEndState() {
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout); this._hardTimeout = null }
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    this._clearFirstOutputWatchdog()
    this._cleanupTurnAttachments(this._activeTurn)
    this._activeTurn = null
    this._isBusy = false
    this._currentMessageId = null
    this._clearAskUserQuestionLock()
    this._clearAllAskUserQuestionWatchdogs()
    this._pendingBackgroundCommands.clear()
  }

  _finishTurnError(message, callerMessageId) {
    this._assertBusyHasMessageId('_finishTurnError')
    this._logSendMessageSummary('error')
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
    // the entry until destroy(). Read messageId/duration BEFORE the teardown
    // helper nulls the turn fields.
    const messageId = callerMessageId || this._currentMessageId
    const duration = this._activeTurn ? this._nowMonotonic() - this._activeTurn.startedAt : 0
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
    // Shared per-turn teardown: timers, pre-first-output watchdog, attachment
    // dir (#4022), the busy-state triple, the AskUserQuestion sibling lock
    // (#4604), and the per-toolUseId stall watchdogs (#5319). The emits above
    // are synchronous, so deferring the timer clears into the helper (vs the
    // old before-emit position) cannot let a timer fire in between. The helper
    // intentionally does NOT clear `_pendingUserAnswers` — see its doc (#4286 /
    // #4802): this path issues no Ctrl-C, so a sibling answer already on the
    // wire can still validly consume its entry; the Ctrl-C/kill paths
    // (`_teardownTurn` / `interrupt()` / `destroy()`) clear pending answers.
    this._clearTurnEndState()
  }

  /**
   * Return the tail of recent PTY output suitable for inclusion in an
   * error message, or '' when there's nothing useful. Collapses
   * whitespace runs so the diagnostic is compact (#3919).
   */
  _outputTailDiagnostic() {
    if (!this._outputTail) return ''
    // #5322 (WP-4.2, security) — this tail rides into `error` events that fan
    // out to clients and the System tab, so redact any token-shaped run (pasted
    // or echoed OAuth token / API key) before it leaves the process.
    // #5357 review — redact BEFORE slicing: a token straddling the
    // PTY_TAIL_DIAGNOSTIC_BYTES boundary must be matched in full (and collapse
    // to [REDACTED]) rather than leaving a trailing fragment the regex can't
    // catch. The slice then bounds the already-scrubbed string.
    return redactSensitive(this._outputTail)
      .slice(-ClaudeTuiSession.PTY_TAIL_DIAGNOSTIC_BYTES)
      .replace(/[\r\n]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
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
  /**
   * #5318 (WP-3.1) — suspend the "claude went silent" backstops while a human is
   * answering an AskUserQuestion: the soft-inactivity, stream-stall, and
   * pre-first-output timers. When a question is pending the HUMAN is the
   * bottleneck, not claude, so these would only fire a misleading
   * force-cancel / stall error / check-in chip mid-answer. The dedicated
   * per-toolUseId `_askUserQuestionWatchdogs` (armed in respondToQuestion) still
   * recover a genuinely wedged form after the answer is written.
   *
   * Deliberately does NOT touch the HARD cap (`_hardTimeout`): that 2h
   * last-resort backstop stays armed even across a pending question, so a human
   * who walks away and never answers still gets force-cleared eventually (and
   * `_handleHardTimeout` keeps its existing pending-answer cleanup). Idempotent.
   */
  _suspendBackstopsForPendingQuestion() {
    if (this._resultTimeout) { clearTimeout(this._resultTimeout); this._resultTimeout = null }
    if (this._streamStallTimeout) { clearTimeout(this._streamStallTimeout); this._streamStallTimeout = null }
    // Disarms + latches the per-turn first-output watchdog. By the time a
    // question is pending the first output (the tool_use) has already arrived,
    // so the watchdog is moot for the rest of this turn anyway.
    this._clearFirstOutputWatchdog()
  }

  _armResultTimeout() {
    if (this._resultTimeout) clearTimeout(this._resultTimeout)
    if (this._hardTimeout) clearTimeout(this._hardTimeout)
    if (this._streamStallTimeout) clearTimeout(this._streamStallTimeout)
    this._resultTimeout = null
    this._hardTimeout = null
    this._streamStallTimeout = null
    // Hard cap ALWAYS arms — it's the last-resort backstop and stays live even
    // while an AskUserQuestion answer is pending (a human who never answers for
    // hours still gets force-cleared). #5318 suspends only the silence-detecting
    // backstops below.
    this._hardTimeout = setTimeout(() => {
      this._hardTimeout = null
      this._handleHardTimeout()
    }, this._hardTimeoutMs)
    // #5318 (WP-3.1) — while an AskUserQuestion answer is pending, keep the
    // silence backstops suspended even though hook drains (or a defensive
    // re-arm) call through here. Resuming is automatic: PostToolUse clears the
    // pending entry, and the next drain-loop _armResultTimeout() falls through.
    if (this._pendingUserAnswers.size > 0) {
      this._suspendBackstopsForPendingQuestion()
      return
    }
    this._resultTimeout = setTimeout(() => {
      this._resultTimeout = null
      this._handleInactivityWarning()
    }, this._resultTimeoutMs)
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
    this._firstOutputArmedAt = this._nowMonotonic()
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
    // #5777: first output (or any teardown) means the submit landed / the turn
    // is over — cancel any pending first-turn submit nudge so a late \r can't
    // land on an idle composer. _clearFirstOutputWatchdog is called from the
    // hook-drain loop on first consumed event and from every teardown path, so
    // this one site covers all of them.
    this._clearFirstTurnSubmitNudge()
    this._firstOutputDisarmed = true
    // #5798: first consumed hook of a turn (or any teardown that routes through
    // here) is the legitimate turn-start boundary — close the reinject
    // stop-and-wait window so a tool_use in a LATER, unrelated turn can't trip
    // the violation WARN. In the hook-drain loop this runs AFTER the per-event
    // _emitToolHookEvent pass (line ~2046 vs the clear at ~2076), so a PreToolUse
    // that IS the first hook of the reinjected turn still fires the WARN first;
    // this clear then prevents any spurious re-fire. Observability-only.
    this._reinjectStopWaitWatch = null
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

  /**
   * #5777: schedule the first-turn submit nudge. A freshly-spawned claude TUI
   * can write status:idle (readiness is a session-FILE check, decoupled from
   * what's rendered) before its composer is actually interactive, so the first
   * message's trailing \r is swallowed and the prompt sits typed-but-unsent
   * until a later keystroke submits it (the manual "go" workaround). This
   * re-sends a bare \r after the nudge window if no hook output has been
   * consumed yet (`!_firstOutputDisarmed`). A bare \r is a no-op on an
   * already-submitted (empty) composer and a submit on a stuck one, so it is
   * safe either way. Retries up to FIRST_TURN_SUBMIT_NUDGE_MAX_ATTEMPTS, then
   * defers to the longer first-output watchdog. Cancelled by
   * _clearFirstOutputWatchdog (first output / any teardown / destroy).
   *
   * #5794 hardening:
   *   - The CALLER (sendMessage) only schedules this for a SINGLE-LINE first
   *     message of each (re)spawn — a multi-line prompt goes through the
   *     bracketed-paste write path where a bare \r is unsafe.
   *   - Belt-and-braces no-op guard: the tick also skips the \r if PTY output
   *     (`_totalOutputBytes`) has grown since arm time. The submit landing
   *     re-renders the TUI (output before any hook), so new output is
   *     independent evidence the composer accepted the submit on a slow-but-
   *     healthy turn — don't risk a stray second submit; defer to the
   *     first-output watchdog instead. Uses the uncapped byte total (not
   *     _outputTail.length, which stops growing at PTY_TAIL_BYTES — #5809).
   *
   * @param {string} messageId
   */
  _scheduleFirstTurnSubmitNudge(messageId) {
    if (!(this._firstTurnSubmitNudgeMs > 0)) return
    this._clearFirstTurnSubmitNudge()
    let attempts = 0
    // #5794 (3): snapshot the total PTY output bytes at arm time. The submit
    // landing makes the TUI re-render (the typed prompt scrolls up, the thinking
    // spinner appears) which arrives as PTY output BEFORE the first hook is
    // written — so growth here is independent evidence the composer accepted the
    // submit, even on a slow-but-healthy turn whose first hook arrives after the
    // window. We re-snapshot before each retry so a nudge that itself produced
    // progress doesn't double-fire. _totalOutputBytes is 0 in the stubbed-term
    // unit tests (no onData wired), so the existing nudge tests still fire.
    // Uses the uncapped byte total, not _outputTail.length — the tail caps at
    // PTY_TAIL_BYTES and would stop growing after a long resume transcript (#5809).
    let bytesAtArm = this._totalOutputBytes
    const tick = () => {
      this._firstTurnSubmitNudgeTimer = null
      // Nothing to nudge if the turn ended/aborted, the PTY died, the composer
      // is gone, or first output already arrived (the submit landed).
      if (!this._isBusy) return
      if (this._activeTurn?.aborted) return
      if (this._ptyExited || !this._term) return
      if (this._firstOutputDisarmed) return
      // #5794 (3): genuine progress since we armed → the submit landed; a stray
      // \r now risks an empty second submit on an already-warm composer. Defer
      // to the first-output watchdog instead of nudging.
      if (this._totalOutputBytes > bytesAtArm) {
        ;(this._log || log).info(`first-turn submit nudge skipped (#5794, msg=${messageId}) — output grew since arm, submit landed`)
        return
      }
      attempts += 1
      try {
        this._term.write('\r')
        ;(this._log || log).info(`first-turn submit nudge #${attempts} (#5777, msg=${messageId}) — no hook output yet, re-sent \\r`)
      } catch (err) {
        ;(this._log || log).warn(`first-turn submit nudge write failed (#5777, msg=${messageId}): ${err.message}`)
        return
      }
      if (attempts < ClaudeTuiSession.FIRST_TURN_SUBMIT_NUDGE_MAX_ATTEMPTS) {
        // Re-snapshot so the next tick's no-progress check measures growth since
        // THIS nudge (if our \r landed the submit, the next tick should skip).
        bytesAtArm = this._totalOutputBytes
        this._firstTurnSubmitNudgeTimer = setTimeout(tick, this._firstTurnSubmitNudgeMs)
      }
    }
    this._firstTurnSubmitNudgeTimer = setTimeout(tick, this._firstTurnSubmitNudgeMs)
  }

  /**
   * #5777: cancel any pending first-turn submit nudge. Idempotent and safe to
   * call when no nudge was ever scheduled.
   */
  _clearFirstTurnSubmitNudge() {
    if (this._firstTurnSubmitNudgeTimer) {
      clearTimeout(this._firstTurnSubmitNudgeTimer)
      this._firstTurnSubmitNudgeTimer = null
    }
  }

  _handleInactivityWarning() {
    if (!this._isBusy) return
    // #5318 (WP-3.1) — defence in depth: never warn while blocked on a human
    // answer (the suspend should already have cleared this timer).
    if (this._pendingUserAnswers.size > 0) return
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
    // #5318 (WP-3.1) — NOTE: intentionally NOT guarded on a pending question.
    // The hard cap is the last-resort backstop and must still fire (and run its
    // pending-answer cleanup, #4691) even if a human never answers.
    this._assertBusyHasMessageId('_handleHardTimeout')
    const friendly = formatIdleDuration(this._hardTimeoutMs)
    log.warn(`Hard-cap timeout (${friendly}) — force-clearing busy state`)
    const duration = this._activeTurn ? this._nowMonotonic() - this._activeTurn.startedAt : this._hardTimeoutMs
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
    // #5318 (WP-3.1) — defence in depth: a pending human answer is not a stall
    // (the suspend should already have cleared this timer).
    if (this._pendingUserAnswers.size > 0) return
    this._assertBusyHasMessageId('_handleStreamStall')
    const friendly = formatIdleDuration(this._streamStallTimeoutMs)
    const messageId = this._currentMessageId
    log.warn(
      `Stream stalled (${friendly}, messageId=${messageId}) — clearing busy state for retry`,
    )
    const duration = this._activeTurn ? this._nowMonotonic() - this._activeTurn.startedAt : this._streamStallTimeoutMs
    // #5321 (WP-4.1) — a turn that stalled WITH a logged-out / expired-login
    // banner in its tail is an auth failure, not a generic stall. Upgrade the
    // error so mid-session expiry gives actionable `claude login` guidance
    // instead of "try sending again" (which would just stall again). The tail
    // still holds rendered RESPONSE text here, so false-positive safety rests on
    // the patterns requiring claude's `/login` / `claude login` command token
    // (see AUTH_FAILURE_PATTERNS) — a model merely DISCUSSING auth won't match.
    const authFail = this._scanOutputForAuthFailure()
    // #4641: shared teardown helper. See companion call in _handleHardTimeout
    // for the meaning of the asymmetric flags — preserved here as-is so this
    // refactor introduces no behaviour change.
    this._teardownTurn('stream_stall', {
      duration,
      errorPayload: authFail
        ? { code: AUTH_REQUIRED_CODE, message: AUTH_REQUIRED_MESSAGE }
        : {
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
    // #5318 (WP-3.1) — defence in depth: don't fire while blocked on a human
    // answer. (Normally moot — first output already arrived before any question
    // — but kept symmetric with the other backstop handlers.)
    if (this._pendingUserAnswers.size > 0) return
    // #4642: mirror the invariant check the other teardown sites
    // (`_finishTurnError`, `_handleHardTimeout`, `_handleStreamStall`,
    // `_onAskUserQuestionStall`) emit so a future regression that
    // breaks the `_isBusy ↔ _currentMessageId` construction contract
    // surfaces from THIS path too.
    this._assertBusyHasMessageId('_handleFirstOutputTimeout')
    const elapsedMs = this._firstOutputArmedAt > 0
      ? this._nowMonotonic() - this._firstOutputArmedAt
      : this._firstOutputTimeoutMs
    const friendly = formatIdleDuration(this._firstOutputTimeoutMs)
    log.warn(`first-output watchdog fired (elapsedMs=${elapsedMs}) — claude TUI did not respond`)
    const duration = this._activeTurn
      ? this._nowMonotonic() - this._activeTurn.startedAt
      : this._firstOutputTimeoutMs
    // #5321 (WP-4.1) — upgrade to AUTH_REQUIRED when the pre-first-output
    // silence came WITH a logged-out / expired-login banner (e.g. an expired
    // login on the very first turn after restore). False-positive safety rests
    // on the command-token patterns (see AUTH_FAILURE_PATTERNS), not on the turn
    // having stalled.
    const authFail = this._scanOutputForAuthFailure()
    // Mirrors _handleStreamStall's `_teardownTurn` call shape (result
    // before error, gate stream_end on messageId) so the dashboard sees
    // the same fan-out it already handles for the inter-stream stall.
    this._teardownTurn('first_output_timeout', {
      duration,
      errorPayload: authFail
        ? { code: AUTH_REQUIRED_CODE, message: AUTH_REQUIRED_MESSAGE }
        : {
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
    // #5319 (WP-3.2): Ctrl-C above dropped the TUI's current form, so every
    // per-toolUseId watchdog is now stale — clear them all.
    this._clearAllAskUserQuestionWatchdogs()
    // #4732: clear the pre-first-output watchdog so a teardown via
    // `_handleHardTimeout` / `_handleStreamStall` / `_handleFirstOutputTimeout`
    // can never leak a live handle that would re-fire on a torn-down turn.
    this._clearFirstOutputWatchdog()
    // #4307: drop the ephemeral intra-turn run_in_background tool_use→command
    // map on this turn-end too (matches _clearTurnEndState / base _clearMessageState).
    this._pendingBackgroundCommands.clear()
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
  // #5374: BaseSession.setPermissionMode owns the validation + guard and fires
  // this hook after `this.permissionMode` is set, only when the mode changed.
  // #5334 (IP-6): atomically write the permission-mode sidecar — write a tmp
  // file then rename(2) over the target. Direct writeFileSync truncates-then-
  // writes, so a concurrent PreToolUse hook `cat` could observe an empty/partial
  // value mid-write and fall through to the stale env var. rename(2) is atomic
  // within the same filesystem, so readers see either the OLD complete value or
  // the NEW complete value — never an empty/partial one. Throws on failure
  // (after best-effort tmp cleanup) so each caller applies its own fallback.
  _writePermissionModeSidecarAtomic(path, value) {
    const tmpPath = `${path}.tmp-${randomUUID()}`
    try {
      writeFileSync(tmpPath, value)
      renameSync(tmpPath, path)
    } catch (err) {
      try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
      throw err
    }
  }

  _onPermissionModeChanged(mode) {
    if (!this._permissionModeFile) {
      // Permissions weren't enabled at start (no port). Mode was already
      // updated on `this.permissionMode` by BaseSession; nothing else to do.
      log.info(`Permission mode changed to ${mode} (no sidecar — hook script not active)`)
      return
    }
    try {
      this._writePermissionModeSidecarAtomic(this._permissionModeFile, mode)
      log.info(`Permission mode changed to ${mode} (sidecar updated, no PTY restart)`)
    } catch (err) {
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
    // #4604: cancel the stall watchdogs too. interrupt() does NOT clear
    // _isBusy directly (Ctrl-C surfaces async via _finishTurn*), so without
    // this a watchdog could fire ~30s later and emit a spurious
    // ASK_USER_QUESTION_STALL for a session the user already interrupted.
    // #5319 (WP-3.2): clear every per-toolUseId watchdog.
    this._clearAllAskUserQuestionWatchdogs()
    // #4732: same reasoning for the pre-first-output watchdog. interrupt()
    // doesn't synchronously flip _isBusy=false, so without this clear the
    // watchdog could fire in the 150ms poll-loop window before
    // _finishTurnError runs and emit a spurious stream_stall for a
    // session the user has already interrupted.
    this._clearFirstOutputWatchdog()
  }

  async destroy() {
    this._destroying = true
    this._processReady = false
    this._isBusy = false
    this._activeTurn = null
    // #5315 (WP-2.1) — cancel any pending respawn so a scheduled _respawnPty
    // can't fire after teardown and spawn a fresh claude into a destroyed
    // session. `_destroying` is already true above, so _scheduleRespawn would
    // short-circuit anyway, but a timer already armed before destroy() must be
    // cleared explicitly. _respawning is reset so a re-create of this instance
    // (defensive) starts from a clean state.
    if (this._respawnTimer) { clearTimeout(this._respawnTimer); this._respawnTimer = null }
    this._respawnScheduled = false
    this._respawning = false
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
    // #4604 / #5319 (WP-3.2): cancel every AskUserQuestion stall watchdog so
    // none can fire a stale ASK_USER_QUESTION_STALL event into a torn-down
    // listener.
    this._clearAllAskUserQuestionWatchdogs()
    // #5431: stop the background-task transcript re-scan so a late tick
    // can't emit background_tasks_changed into a torn-down listener set.
    this._stopBackgroundTaskPoll()
    if (this._term) {
      // #5317 (WP-2.3) — capture the handle + pid BEFORE nulling so the
      // escalation timer (and _onPtyGone's cancel) still have something to act
      // on. SIGTERM first so claude can flush its Stop hook and reap its own
      // tool children; escalate to SIGKILL only if it ignores us.
      const term = this._term
      const pid = term.pid
      this._term = null
      // #5351 review — only signal a PTY we believe is still alive. _onPtyGone
      // does NOT null _term, so after an unexpected exit (crash / respawn
      // exhaustion) destroy() sees `_term` non-null AND `_ptyExited` true. The
      // process has already been reaped by then, so sending ANY signal — even
      // SIGTERM — risks hitting a recycled pid. Skip the whole kill path; the
      // PTY is already gone and there's nothing to reap.
      if (!this._ptyExited) {
        try { term.kill('SIGTERM') } catch { /* already dead */ }
      }
      // Arm the SIGKILL escalation. _onPtyGone clears this timer when the JS
      // onExit/close/error callback runs, which handles the common case. But that
      // is NOT sufficient on its own to rule out pid reuse: node-pty reaps the
      // child with waitpid() on its internal thread BEFORE it schedules the JS
      // onExit callback, so the OS can recycle the pid in the gap between the
      // reap and our latch being set — and the grace timer + the onExit callback
      // are unordered event-loop tasks. So the timer callback re-checks the
      // _ptyExited latch AND probes liveness with signal 0 before escalating, so
      // a blind `process.kill(-pid)` can't land on a recycled process group.
      if (!this._ptyExited && Number.isInteger(pid) && pid > 0) {
        const graceMs = ClaudeTuiSession.DESTROY_GRACE_MS
        this._killTimer = setTimeout(() => {
          this._killTimer = null
          // The onExit callback has run since we armed the timer → process is
          // already gone (and possibly its pid recycled). Never escalate.
          if (this._ptyExited) return
          // Liveness probe: signal 0 throws ESRCH if the pid is gone. This won't
          // catch a pid that was reaped-then-recycled into a live process, but
          // combined with the _ptyExited latch above it narrows escalation to
          // "the latch never fired AND the pid is still alive" — i.e. a genuinely
          // hung claude, not a recycled stranger.
          try { process.kill(pid, 0) } catch { return /* already exited */ }
          log.warn(`claude PTY (pid=${pid}) did not exit ${graceMs}ms after SIGTERM — escalating to SIGKILL`)
          // Reap the whole process group so claude's tool children die too, not
          // just the session leader. node-pty spawns claude with setsid, so it's
          // its own process-group leader (pgid == pid) and `-pid` targets the
          // group. Fall back to the single pid (and node-pty's own kill) when the
          // group signal isn't deliverable (non-POSIX, or the leader already reaped).
          let killed = false
          if (process.platform !== 'win32') {
            try { process.kill(-pid, 'SIGKILL'); killed = true } catch { /* group gone / not a leader */ }
          }
          if (!killed) {
            try { term.kill('SIGKILL') } catch {
              try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
            }
          }
        }, graceMs)
        // Don't keep the event loop alive solely for the grace timer.
        if (typeof this._killTimer.unref === 'function') this._killTimer.unref()
      }
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

// #5559 — copy the moved PTY-write / form-driver methods onto the prototype.
// Class methods are non-enumerable, so Object.assign won't see them; copy the
// own property descriptors verbatim instead (preserving non-enumerability).
// The method bodies are byte-identical to their pre-split form and run with
// `this` bound to the ClaudeTuiSession instance exactly as before.
function applyMixin(targetClass, mixinClass) {
  const proto = mixinClass.prototype
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue
    Object.defineProperty(
      targetClass.prototype,
      name,
      Object.getOwnPropertyDescriptor(proto, name),
    )
  }
}

applyMixin(ClaudeTuiSession, PtyDriverMixin)
// #5617 — FormDriver is no longer mixed onto the prototype; it's an injected
// collaborator constructed per-session (see the constructor) and reached via
// the `respondToQuestion` delegator + `this._formDriver` for the stall callback.
