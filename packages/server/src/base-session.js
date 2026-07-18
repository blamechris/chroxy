/**
 * BaseSession — shared state and behavior for all session providers.
 *
 * Extracts the common state machine (busy/ready flags, message counter,
 * agent tracking) and shared method patterns (setModel guard,
 * setPermissionMode validation, _clearMessageState) so CliSession,
 * SdkSession, and GeminiSession don't duplicate them.
 */
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { resolveModelId } from './models.js'
import {
  formatSkillsForPrompt,
  SKILLS_PROMPT_HEADER,
} from './skills-loader.js'
import { SkillsManager } from './skills-manager.js'
import { BackgroundShellTracker } from './background-shell-tracker.js'
import { isOperatorTimeoutInRange } from './duration.js'
import { createLogger } from './logger.js'
import { ActivityRegistry } from './activity-registry.js'
import { ALLOWED_PERMISSION_MODE_IDS } from './handler-utils.js'

const log = createLogger('base-session')

// #3805: opt-in Chroxy context paragraph. Prepended to `_buildSystemPrompt()`
// output when `chroxyContextHint` is true so the model knows it's running
// inside Chroxy's remote-terminal front-end and can adjust its output for
// mobile clients (narrower code blocks, no wide ASCII diagrams). Kept short
// (~50 words) to minimise token overhead on every turn.
export const CHROXY_CONTEXT_HINT_TEXT =
  'You are running inside Chroxy, a remote-control front-end that bridges this session to a mobile phone over a Cloudflare tunnel. ' +
  'The user may be on a small screen. Prefer concise, copyable answers; keep code blocks narrow (<80 cols); ' +
  'avoid ASCII diagrams and wide tables; chunk long output so it scrolls smoothly on mobile.'

// #4660: per-session user-authored preamble, prepended to `_buildSystemPrompt()`
// output every turn so the user can pre-load context once instead of retyping
// it in every message. Cap at 4000 chars so a hand-edited state file or a
// malicious client can't bloat the system prompt without bound — comfortably
// fits a dense paragraph or two of style/stack notes while keeping the per-
// turn token overhead predictable.
export const SESSION_PREAMBLE_MAX_LENGTH = 4000

// #5936 (epic #5935): explicit overflow cap for the shared outgoing-message
// queue (`_outgoingQueue`). Replaces the SDK's hard-coded mid-turn cap of 3
// (#5711) with one bounded, surfaced limit shared by SDK + CLI. A send-while-
// busy message past this cap is discarded with a visible `error` event
// (`code: 'queue_full'`) — never a silent drop. Generous enough for a realistic
// burst of owner follow-ups while still bounding memory if a client wedges.
export const OUTGOING_QUEUE_MAX = 10

// #3884 / #3749 / #3899: default SOFT inactivity warning (ms). Activity-based
// — every provider event (SDK iterator message, CLI stdout JSONL line)
// resets the timer; the window only bounds *silent stretches*, not wall-
// clock turn duration. Was 5 min → 20 min (#3749) → 30 min (#3884).
//
// Pre-#3899 this was the kill timer (when it fired, the session was
// force-cleared). Post-#3899 it fires the `inactivity_warning` event
// instead — the session stays alive and the client surfaces a check-in
// affordance. The kill path now lives behind `_hardTimeoutMs` below.
//
// Operators can override per server via config.resultTimeoutMs or
// CHROXY_RESULT_TIMEOUT_MS.
export const DEFAULT_RESULT_TIMEOUT_MS = 30 * 60 * 1000

// #3899: HARD-cap timeout (ms). When silence continues for this long
// past `sendMessage` (with no activity to reset it AND no user check-in
// after the soft warning), the session is force-cleared, pending
// permissions are auto-denied, and an error is emitted — the pre-#3899
// behaviour, preserved as the absolute backstop for genuinely stuck
// sessions (dead SDK iterator, host suspended, network hang the OS
// hasn't surfaced yet).
//
// Default 2h: wide enough to cover marathons users actually run
// (/batch-merge over 20+ PRs, multi-hour /tackle-issues sessions);
// tight enough to bound runaway sessions before they accumulate
// real cost / memory.
//
// Operators can override per server via config.hardTimeoutMs or
// CHROXY_HARD_TIMEOUT_MS.
export const DEFAULT_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000

// #4467: stream-stall recovery timeout (ms). Resets on ANY stream event from
// the child (stdout line, stream_delta, tool_start, etc.). When no event has
// arrived for this long while busy, emit a recoverable error (code:
// `stream_stall`) and clear busy state so the user can retry. Distinct from
// the soft inactivity warning — the warning is passive (just a chip); this
// is active recovery.
//
// Default 5 minutes: a stalled HTTPS connection to the Anthropic API
// (half-open TCP, mobile NAT idle, Cloudflare timeout) typically would have
// recovered by then if it was going to; longer-than-5min legitimate gaps
// between events are rare (interactive tools poll faster than that).
//
// Operators with workloads that have long compile-then-edit gaps can raise
// via config.streamStallTimeoutMs or CHROXY_STREAM_STALL_TIMEOUT_MS, or set
// to 0 to disable.
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 5 * 60 * 1000

// #5376: the background-shell sweep/quiesce machinery moved to
// background-shell-tracker.js. Re-exported here so existing importers
// (session-timeout-manager, tests) keep their import path. See that module for
// the #5177 / #5247 / #5265 rationale on each window.
export {
  BACKGROUND_SHELL_SWEEP_MS,
  BACKGROUND_SHELL_QUIESCE_MS,
  BACKGROUND_SHELL_HARD_QUIESCE_MS,
} from './background-shell-tracker.js'

// #5367: canonical list of the opts BaseSession's constructor accepts, in the
// exact order they appear in the destructure below. Single source of truth for
// `buildBaseSessionOpts()` — the picker each subclass uses to forward opts down
// without hand-maintaining a parallel destructure (the "middle-layer trap" that
// re-shipped three times: #3224 / #3231 / #4790). The CI lint
// (lint-session-opt-forwarding.mjs) ASSERTS this array equals the set parsed
// from the constructor destructure, so the two can never drift apart.
export const BASE_SESSION_OPT_KEYS = [
  'cwd',
  'model',
  'permissionMode',
  'skillsDir',
  'repoSkillsDir',
  'maxSkillBytes',
  'maxTotalSkillBytes',
  'provider',
  'activeManualSkills',
  'providerSkillAllowlist',
  'trustStore',
  'trustMismatchMode',
  'promptEvaluator',
  'promptEvaluatorSkipPattern',
  'chroxyContextHint',
  'sessionPreamble',
  'resultTimeoutMs',
  'hardTimeoutMs',
  'streamStallTimeoutMs',
  'backgroundShellHardQuiesceMs',
  'permissionRuleStore',
]

// #5367: pick the BaseSession opts out of a subclass's full opts bag and merge
// per-subclass `overrides` on top (overrides win — e.g. provider/model
// defaults). Uses `if (k in fullOpts)` rather than `??` so an explicitly-passed
// falsy value (notably `backgroundShellHardQuiesceMs: 0`, which disables
// hard-reaping) is preserved, and absent keys are omitted entirely (so
// BaseSession's own `|| default` fallbacks still apply).
export function buildBaseSessionOpts(fullOpts = {}, overrides = {}) {
  const out = {}
  for (const k of BASE_SESSION_OPT_KEYS) {
    if (k in fullOpts) out[k] = fullOpts[k]
  }
  return { ...out, ...overrides }
}

// #3639: validate a constructor-supplied promptEvaluatorSkipPattern. Only
// real regex sources survive — anything else (non-string, malformed
// regex, empty string) falls back to null. Pulled out of the constructor
// body because the same shape is consulted by `setPromptEvaluatorSkipPattern`
// at runtime, but the runtime path needs to distinguish "rejected" from
// "no-op clear" — the constructor only needs the final stored value.
function _coerceSkipPatternOpt(source) {
  if (typeof source !== 'string' || source.length === 0) return null
  try {
    new RegExp(source, 'i')
    return source
  } catch {
    return null
  }
}

// #4660: validate a constructor-supplied sessionPreamble. Only strings are
// accepted; anything else (undefined, null, number, object) yields the
// empty-string default so _buildSystemPrompt() stays byte-identical to
// pre-#4660. Trim whitespace + cap to SESSION_PREAMBLE_MAX_LENGTH so a
// hand-edited state file can't smuggle in unbounded text past the wire-
// level cap enforced by ws-schemas. Empty-after-trim falls back to '' so
// the OFF semantics (no injection) line up with `chroxyContextHint: false`.
function _coerceSessionPreambleOpt(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.length > SESSION_PREAMBLE_MAX_LENGTH) {
    return trimmed.slice(0, SESSION_PREAMBLE_MAX_LENGTH)
  }
  return trimmed
}

export class BaseSession extends EventEmitter {
  /**
   * Custom event names emitted by this provider class that should be proxied
   * by SessionManager in addition to the built-in PROXIED_EVENTS list.
   *
   * Override in a subclass and return an array of event name strings.
   * Each name will be forwarded as a transient session_event (not recorded
   * in history and not replayed on reconnect).
   *
   * @returns {string[]}
   */
  static get customEvents() {
    return []
  }

  /**
   * #5984 (epic #5982): is this session class the claude-tui PTY mirror — the
   * ONLY session type that is a legitimate target for server-initiated
   * PTY-write paths (the mailbox live-interrupt wakeup) and the Control Room's
   * `isTui` flag? Defaults to false; ClaudeTuiSession overrides to true.
   *
   * This replaces the previous `typeof session.writeTerminalInput === 'function'`
   * duck-typing at those sites. The user-shell session (#5983) will ALSO expose
   * `writeTerminalInput` (to receive `terminal_input`), so duck-typing would
   * mis-detect it as claude-tui and let the weaker ingest-secret holder inject
   * an executed line into a root shell (swarm-audit finding C2). A positive
   * class discriminator fails safe: anything not explicitly claude-tui — incl.
   * a future user-shell — is excluded by construction.
   *
   * @returns {boolean}
   */
  static get isClaudeTui() {
    return false
  }

  /**
   * #5985b (epic #5982): is this session class the general-purpose user shell
   * (spawns the operator's `$SHELL` — arbitrary code execution on the dev
   * machine)? Defaults to false; UserShellSession (#5983) overrides to true.
   *
   * The WS create + terminal_* (input / resize / subscribe) gates use this to
   * require the PRIMARY token class for a shell — a much stricter bar than the
   * session-scoped viewer/primary-claim checks that suffice for the claude-tui
   * mirror (swarm-audit findings C1/C4). Read off the instance via
   * `session.constructor?.isUserShell`. False by construction for every existing
   * session type, so these gates are inert until the provider lands (#5983).
   *
   * @returns {boolean}
   */
  static get isUserShell() {
    return false
  }

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
    providerSkillAllowlist,
    trustStore,
    trustMismatchMode,
    promptEvaluator,
    promptEvaluatorSkipPattern,
    // #3805: opt-in flag — when true, _buildSystemPrompt prepends a
    // short paragraph telling the model it's running inside Chroxy so
    // it can adjust output for mobile clients (narrower code blocks,
    // no wide ASCII diagrams). Default false — existing users see no
    // observable change.
    chroxyContextHint,
    // #4660: user-authored preamble prepended to `_buildSystemPrompt()`
    // output every turn. String, trimmed + capped to
    // SESSION_PREAMBLE_MAX_LENGTH on construction. Empty string (or any
    // non-string input) is the byte-identical-to-pre-#4660 default.
    sessionPreamble,
    // #3749 / #3884 / #3899: configurable SOFT-warning timeout (the
    // inactivity safety net). Subclasses arm this timer; when it fires
    // they emit an `inactivity_warning` event so the client can render
    // a check-in affordance ("Status update?"). The session stays alive
    // — pre-#3899 this kill behavior moved to `hardTimeoutMs` below.
    // Default 30 min — wide enough to cover long agent loops (batch
    // ops, big refactors) before the user is prompted. Override via
    // ~/.chroxy/config.json#resultTimeoutMs or CHROXY_RESULT_TIMEOUT_MS.
    resultTimeoutMs,
    // #3899: configurable HARD-cap timeout (the kill-the-session
    // backstop). Subclasses arm this in parallel with the soft timer;
    // when it fires they force-clear busy state, auto-deny pending
    // permissions, and emit an error — the pre-#3899 behavior, kept as
    // the absolute safety valve for genuinely stuck sessions. Default
    // 2h. Override via ~/.chroxy/config.json#hardTimeoutMs or
    // CHROXY_HARD_TIMEOUT_MS.
    hardTimeoutMs,
    // #4467: stream-stall recovery timeout. See DEFAULT_STREAM_STALL_TIMEOUT_MS.
    streamStallTimeoutMs,
    // #5288: HARD-quiesce window (ms) for background shells. A finished-but-
    // never-polled shell is reaped after this much continuous output silence
    // so it stops pinning the session "running". Defaults to
    // BACKGROUND_SHELL_HARD_QUIESCE_MS (4h); 0 disables hard-reaping (revert
    // to #5247 advisory-only). Forwarded from config via SessionManager.
    backgroundShellHardQuiesceMs,
    // #6771 — the daemon-wide durable PermissionRuleStore (persistent per-project
    // "always allow / deny"). A runtime handle (not serialized), forwarded from
    // SessionManager; the in-process permission providers (SDK / BYOK / codex)
    // hand it to their PermissionManager so an `allowAlways` decision persists a
    // project-scoped rule and new sessions in the same cwd seed from it.
    permissionRuleStore,
  } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    // #6771 — durable per-project permission rule store (see the opt doc above).
    // Read by the in-process permission providers when they build their
    // PermissionManager; null on providers/tests that don't wire it.
    this._permissionRuleStore = permissionRuleStore || null
    this.model = model || null
    // Actual model the underlying CLI/SDK reports at init time. May differ
    // from `this.model` (the user's requested override) when no override
    // was set — e.g. user sent create_session with no `model`, the CLI
    // booted with whatever `~/.claude/settings.json` had configured. Used
    // for display only; spawn/respawn still uses `this.model` so a null
    // override keeps following the upstream default after CLI updates.
    // Set by subclasses in their init handlers (#3687).
    this.bootedModel = null
    this.permissionMode = permissionMode || 'approve'
    // #3185: per-session toggle for the auto-evaluator chain (parent epic
    // #3068). Default `false` — the existing manual `evaluate_draft` flow
    // (PR #3089) is unaffected by this flag. Coerced to a strict boolean
    // here so JSON.stringify produces `true`/`false` (not `1`/`null`) on
    // the auth_ok / session_list wires.
    this.promptEvaluator = !!promptEvaluator
    // #3639: per-session regex source string used by `shouldSkipEvaluator`
    // to extend the default continuation/ack skip list. Mirrors the
    // server-wide `config.promptEvaluatorSkipPattern` from #3187 but is
    // evaluated FIRST in input-handlers.js so a per-session override
    // beats the global default. Stored as the source string (not a
    // RegExp) — the prompt-evaluator module owns compilation + caching.
    // Validated here as a real regex source on construction; malformed
    // values fall back to null so a hand-edited state file can't crash
    // session creation. The runtime setter (setPromptEvaluatorSkipPattern)
    // does the same validation but reports the rejection so the operator
    // sees a session_error in the dashboard instead of a silent default.
    this.promptEvaluatorSkipPattern = _coerceSkipPatternOpt(promptEvaluatorSkipPattern)
    // #3805: per-session Chroxy context hint flag. Coerced to a strict
    // boolean so `undefined` (omitted by clients on older protocol
    // versions) yields the safe `false` default and JSON.stringify
    // produces `true`/`false` (not `1`/`null`) on the wire.
    this.chroxyContextHint = !!chroxyContextHint
    // #4660: per-session preamble. String-typed: anything else (undefined,
    // null, number, object) falls back to the empty-string default so the
    // _buildSystemPrompt() output stays byte-identical to pre-#4660. Trim
    // + cap so a hand-edited state file or a malformed restore can't
    // smuggle in unbounded text. The runtime setter (setSessionPreamble)
    // does the same coercion and reports rejection on type mismatch.
    this.sessionPreamble = _coerceSessionPreambleOpt(sessionPreamble)

    this._isBusy = false
    this._processReady = false
    // #5375: user-initiated stop vs crash. Set by interrupt() (markIntentionalStop),
    // captured-and-cleared by the provider's close/error handler
    // (_consumeIntentionalStop) so a clean stop is not reported as an error.
    // Hoisted here from the three providers (#4602/#4881) — see _consumeIntentionalStop
    // and _clearIntentionalStop below. The capture and the safety-net clear are kept
    // as SEPARATE helpers on purpose: SDK relies on a catch-block consume plus a
    // `finally` safety-net clear (the interrupt-races-result case), and collapsing
    // them would reopen that race.
    this._intentionalStop = false
    // #4307/#5177/#5247/#5265: pending background-shell tracking + the reaping
    // sweep live in BackgroundShellTracker (#5376). BaseSession composes one and
    // delegates the public surface (trackBackgroundShell / clearBackgroundShell /
    // getPendingBackgroundShells / _destroyPendingBackgroundShells) plus the
    // test-facing tunables (`_backgroundShell*` get/set shims below) to it;
    // `isRunning` consults its pending count. Events flow from the session via the
    // injected emit. #5288: `backgroundShellHardQuiesceMs` is config-driven; the
    // tracker honours an explicit 0 (disable). See background-shell-tracker.js for
    // the transient-by-design (#4417) and quiescence-window (#4417/#5247/#5265)
    // rationale.
    this._backgroundShellTracker = new BackgroundShellTracker({
      emit: (event, payload) => this.emit(event, payload),
      hardQuiesceMs: backgroundShellHardQuiesceMs,
    })
    // #4307: ephemeral map of recent `Bash` tool_uses dispatched with
    // `run_in_background: true`, keyed by toolUseId. Used to recover the
    // command string when the matching tool_result lands carrying the
    // shellId — the command string is informational (surfaced in the
    // dashboard "waiting on …" chip). Cleared on `_clearMessageState`
    // because once a turn ends, any tool_use blocks that did not see a
    // result this turn are stranded; the agent's next turn re-emits a
    // fresh `tool_use` if it cares to wait again.
    this._pendingBackgroundCommands = new Map()
    // #4628: in-flight tool_start tracking. Each entry is the toolUseId
    // of a tool_start the session has emitted but for which no matching
    // tool_result has fired yet. On `result` (turn end), `_emitResult`
    // sweeps any remaining entries and emits synthetic tool_results so
    // the dashboard's activeTools chip clears. Without this, claude TUI
    // sessions that drop a PostToolUse hook (rare but observed — one
    // Bash out of 35 per the #4628 forensic) leave the chip ticking
    // forever AND persist the orphan to session-state.json. Companion
    // path: SessionMessageHistory.sweepUnresolvedToolStarts (#4617/#4619)
    // catches stragglers at restore-time as a backstop.
    this._inFlightToolStarts = new Map()
    // #5160: per-session activity registry (Control Room). A thin unifying
    // layer that maps the signals BaseSession already emits (tool_start /
    // tool_result / agent_spawned / agent_completed / background_work_changed
    // / permission_request / user_question / permission_resolved) into the
    // `ActivityEntry` wire shape and re-emits `activity_delta` /
    // `activity_snapshot` for the WS layer. NOT a parallel tracker — it
    // listens to this session's own events (wired in _setupActivityRegistry)
    // so it can never drift from the canonical signal source.
    this._activity = new ActivityRegistry({
      sessionId: '',
      emit: (event, payload) => this.emit(event, payload),
    })
    this._setupActivityRegistry()
    this._messageCounter = 0
    // Boot-unique prefix mixed into every emitted messageId (#3700).
    // The dashboard caches up to 100 messages per session in localStorage
    // keyed by server-assigned messageId. Pre-fix, every server boot
    // restarted the counter from 0, so a fresh `msg-1` collided with the
    // dashboard's cached `msg-1` from the previous boot's session — the
    // dashboard's resolveStreamId silently REUSED the old response and
    // appended new deltas to it, leaving the bottom of the chat empty.
    // A 3-byte (6 hex char) random prefix per boot guarantees IDs from
    // different server processes can never share a string namespace, even
    // if the counter happens to land on the same value. 16⁶ ≈ 16.7M
    // values — collision across realistic restart counts is astronomical.
    this._messageIdPrefix = randomBytes(3).toString('hex')
    this._currentMessageId = null
    this._destroying = false
    // #5936 (epic #5935): server-authoritative outgoing-message queue. Holds a
    // follow-up message the OWNER sent while the session was still mid-turn
    // (busy) and flushes it FIFO on the turn-complete `result` event — the
    // single canonical "no more response is coming" signal (where `_isBusy`
    // clears via `_clearMessageState`). Replaces the SDK's ad-hoc `_pendingInput`
    // (cap 3) and the CLI's mid-turn reject, giving both providers one
    // consistent queue → flush-on-complete behaviour. Each entry is
    // `{ prompt, attachments, sendOptions }`; `sendOptions.clientMessageId`
    // (when supplied) lets clients reconcile their optimistic queued bubble.
    // Cross-device arbitration is enforced ABOVE this layer (input-handlers'
    // input_conflict gate) — by the time a send reaches the queue it is the
    // owner's own follow-up, never a way around primary-client arbitration.
    this._outgoingQueue = []
    this._activeAgents = new Map()
    this._resultTimeout = null
    // #3899: parallel hard-cap setTimeout handle. Armed alongside
    // `_resultTimeout` on every activity reset, cleared in lockstep.
    // Fires `_handleHardTimeout` when silence reaches `_hardTimeoutMs`
    // even if the user never engages with the soft check-in prompt.
    this._hardTimeout = null
    // #4467: stream-stall recovery timer. See _streamStallTimeoutMs and
    // CliSession._handleStreamStall for the active-recovery path.
    this._streamStallTimeout = null
    // #3749 / #3884 / #3899: effective SOFT-warning timeout in ms.
    // Defaults to 30 minutes; overrides come from
    // SessionManager(resultTimeoutMs:…) which itself reads
    // ~/.chroxy/config.json#resultTimeoutMs or
    // CHROXY_RESULT_TIMEOUT_MS.
    //
    // #4509: `isOperatorTimeoutInRange` mirrors the ceiling check #4503
    // added to `ws-history.js sendPostAuthInfo`. BaseSession is the final
    // destination — it arms the actual setTimeout against this value — so
    // even when an over-ceiling number sneaks past SessionManager (e.g. a
    // provider that hand-builds providerOpts) we still clamp it here so the
    // inactivity-warning path can't effectively never fire.
    this._resultTimeoutMs =
      isOperatorTimeoutInRange(resultTimeoutMs, { name: 'resultTimeoutMs', log })
        ? resultTimeoutMs
        : DEFAULT_RESULT_TIMEOUT_MS
    // #3899: effective HARD-cap timeout in ms. Defaults to 2 hours.
    // Overrides via SessionManager(hardTimeoutMs:…) ← config.hardTimeoutMs
    // / CHROXY_HARD_TIMEOUT_MS. Operators wanting tight kill-on-stuck
    // semantics can drop this; the soft warning fires first regardless.
    this._hardTimeoutMs =
      isOperatorTimeoutInRange(hardTimeoutMs, { name: 'hardTimeoutMs', log })
        ? hardTimeoutMs
        : DEFAULT_HARD_TIMEOUT_MS
    // #4467: stream-stall recovery timer. 0 disables the active recovery
    // path (the soft warning + hard cap still apply). Non-finite, negative,
    // or above the 24h ceiling falls back to the default.
    this._streamStallTimeoutMs =
      isOperatorTimeoutInRange(streamStallTimeoutMs, { allowZero: true, name: 'streamStallTimeoutMs', log })
        ? streamStallTimeoutMs
        : DEFAULT_STREAM_STALL_TIMEOUT_MS

    // Provider id (registry key from providers.js — `claude-sdk`, `codex`,
    // etc.). Stored so frontmatter `providers:` filtering (#3198) and
    // injection-mode defaulting (#3200) can run at construction. Optional
    // — tests and ad-hoc instantiations may omit it; the loader treats
    // null provider as "no provider scoping" (skills with a `providers:`
    // list are filtered OUT, skills without one still apply).
    this._provider = provider || null

    // #2957/#3199/#3204/#3248: the shared-skills system — the manual-activation
    // set, the immutable load-time inputs (dirs, byte caps, provider allowlist),
    // the trust store, the parse cache, and the loader-built caches — lives in
    // SkillsManager (#5376). BaseSession composes one and exposes compat getters
    // (`_skills`, `_skillsDir`, `_activeManualSkills`, `_trustStore`,
    // `_providerSkillAllowlist`, …) so existing consumers, the prompt builders,
    // and the #5367 opt sentinel keep their surface; activateSkill /
    // deactivateSkill / _loadSkills delegate to it. `_provider` (above) is kept
    // on the session for non-skills use and also passed through here.
    this._skillsManager = new SkillsManager({
      cwd: this.cwd,
      provider,
      activeManualSkills,
      skillsDir,
      repoSkillsDir,
      maxSkillBytes,
      maxTotalSkillBytes,
      providerSkillAllowlist,
      trustStore,
      trustMismatchMode,
      emit: (...args) => this.emit(...args),
    })

    // Skills are scanned at construction. #3209 adds a runtime reload path for
    // manual activation toggles. The construction load deliberately RETURNS its
    // mismatch / community-trust events so they re-emit on `process.nextTick`:
    // SessionManager wires event listeners AFTER the constructor returns, so a
    // synchronous emit here would land on an empty listener set.
    const { trustEvents: pendingTrustEvents, communityTrustEvents: pendingCommunityTrustEvents } = this._skillsManager.loadSkills({ collectTrustEvents: true })
    if (pendingTrustEvents.length > 0 || pendingCommunityTrustEvents.length > 0) {
      process.nextTick(() => {
        for (const ev of pendingTrustEvents) {
          this.emit('skill_changed', ev)
        }
        for (const ev of pendingCommunityTrustEvents) {
          this.emit('skill_trust_request', ev)
        }
      })
    }
  }

  /**
   * #5376: delegate to SkillsManager. Kept as a session method because
   * settings-handlers.js calls `session._loadSkills()` to rebuild after a
   * trust grant. Returns the pending trust / community-trust events for the
   * caller to emit (the construction path emits them on `process.nextTick`).
   *
   * @param {{ collectTrustEvents?: boolean }} [opts]
   * @returns {{ trustEvents: Array<object>, communityTrustEvents: Array<object> }}
   * @private
   */
  _loadSkills(opts = {}) {
    return this._skillsManager.loadSkills(opts)
  }

  /**
   * Indicates whether runtime skill toggles take effect on the wire
   * for this provider (#3209 / #3246). The default is `false` — only
   * SdkSession overrides to `true` because the SDK rebuilds
   * `systemPrompt.append` on every turn from `_buildSystemPrompt()`.
   *
   * Subprocess providers (CliSession, CodexSession, GeminiSession)
   * embed the skills text into the persistent subprocess at start
   * (claude `--append-system-prompt`) or onto the first user message
   * (Codex / Gemini's `_skillsPrepended` flag). Mutating in-memory
   * state mid-session does NOT propagate to the running model, so the
   * WS handler refuses the toggle with `SKILL_TOGGLE_UNSUPPORTED` for
   * those providers and the dashboard hides / disables the checkbox.
   *
   * @returns {boolean}
   */
  supportsRuntimeSkillToggle() {
    return false
  }

  /**
   * Activate a manual skill at runtime (#3209). The skill must
   * actually exist on disk AND declare `activation: manual` —
   * arbitrary strings, typos, and `activation: auto` skill names
   * are rejected (return `false`). Without the existence check, a
   * stale entry would sit in `_activeManualSkills` forever, the
   * loader would silently drop it on every `_loadSkills()` call,
   * and the dashboard checkbox would falsely report success.
   *
   * Returns `true` when the active set actually changed (caller can
   * broadcast `skill_activated` and re-emit). `false` when already
   * active, when the name doesn't correspond to a real manual
   * skill, or when the input shape is invalid.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  activateSkill(skillName) {
    return this._skillsManager.activateSkill(skillName)
  }

  /**
   * Deactivate a manual skill at runtime (#3209). Returns true when the active
   * set actually changed; false otherwise. #5376: delegates to SkillsManager.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  deactivateSkill(skillName) {
    return this._skillsManager.deactivateSkill(skillName)
  }

  /**
   * #4307: a session is "running" — i.e. NOT idle, NOT subject to
   * `SessionTimeoutManager` reaping — when EITHER:
   *   - `_isBusy` is true (the model is mid-turn), OR
   *   - the pending-background-shells map is non-empty (the agent
   *     dispatched a `run_in_background` Bash and is waiting on it).
   *
   * The second clause is the #4307 fix: previously a session that
   * kicked off a long-running background shell and returned looked
   * indistinguishable from a finished session — `_isBusy` had cleared
   * at turn-end. Now it stays "running" until the agent acknowledges
   * the shell (via a `BashOutput` call) or the session is destroyed.
   *
   * #5247: the map size counts shells the mtime sweep has marked
   * `quiesced` too. The sweep is ADVISORY — it clears the dashboard
   * banner (see `getPendingBackgroundShells`) but must NOT flip liveness,
   * because mtime quiescence can't tell "finished" from "idle but alive"
   * (a dev server that logs once then waits for connections). Letting it
   * flip `isRunning` reaped live processes and let `SessionTimeoutManager`
   * time the session out as idle — re-opening #4307. Liveness authority is
   * therefore BashOutput / destroy only, exactly as #4307 intended; the
   * sweep just affects what the banner shows.
   */
  get isRunning() {
    if (this._isBusy) return true
    return this._backgroundShellTracker.size > 0
  }

  /**
   * #4307: read-only snapshot of pending background shells.
   * #5376: delegates to BackgroundShellTracker.
   */
  getPendingBackgroundShells() {
    return this._backgroundShellTracker.getPendingBackgroundShells()
  }

  /**
   * #4307: record a new pending background shell. Idempotent on shellId.
   * #5376: delegates to BackgroundShellTracker. Called by SdkSession /
   * ClaudeTuiSession as a session method.
   *
   * @param {{ shellId: string, command?: string, outputPath?: string }} opts
   * @returns {boolean} true if a new entry was added
   */
  trackBackgroundShell(opts = {}) {
    return this._backgroundShellTracker.trackBackgroundShell(opts)
  }

  /**
   * #4307: clear a pending background shell by id. Returns true when an entry
   * actually existed. #5376: delegates to BackgroundShellTracker.
   *
   * @param {string} shellId
   * @returns {boolean}
   */
  clearBackgroundShell(shellId) {
    return this._backgroundShellTracker.clearBackgroundShell(shellId)
  }

  /**
   * #5936: current depth of the outgoing-message queue. Read-only snapshot for
   * tests + any caller that wants to reflect queued state without reaching into
   * `_outgoingQueue` directly.
   *
   * @returns {number}
   */
  get outgoingQueueLength() {
    return this._outgoingQueue.length
  }

  /**
   * #5936: accept a send-while-busy follow-up into the shared outgoing queue.
   * Called by a provider's `sendMessage` when `_isBusy` (the model is mid-turn)
   * INSTEAD of dropping the message (old SDK) or rejecting with an error (old
   * CLI). The message is held and flushed FIFO on the next `result` via
   * `dequeueNextOutgoing()`.
   *
   * Overflow is surfaced, never silent: past `OUTGOING_QUEUE_MAX` the message is
   * discarded with an `error` event (`code: 'queue_full'`) so the client can
   * tell the user, rather than the queue growing unbounded.
   *
   * Emits `message_queued` (transient; mirrored to clients via the normalizer)
   * on success so both clients can render the queued bubble.
   *
   * @param {{ prompt: any, attachments?: any, sendOptions?: object }} item
   * @returns {boolean} true if the message was queued, false on overflow.
   */
  enqueueOutgoingMessage({ prompt, attachments, sendOptions } = {}) {
    if (this._outgoingQueue.length >= OUTGOING_QUEUE_MAX) {
      this.emit('error', {
        code: 'queue_full',
        message: `Outgoing message queue full (max ${OUTGOING_QUEUE_MAX}) — message discarded`,
        recoverable: true,
      })
      return false
    }
    const opts = sendOptions || {}
    this._outgoingQueue.push({ prompt, attachments, sendOptions: opts })
    this.emit('message_queued', {
      clientMessageId: typeof opts.clientMessageId === 'string' ? opts.clientMessageId : undefined,
      text: typeof prompt === 'string' ? prompt : '',
      queueLength: this._outgoingQueue.length,
    })
    ;(this._log || log).info(`Queued follow-up message (${this._outgoingQueue.length} pending)`)
    return true
  }

  /**
   * #5936: flush the head of the outgoing queue. Called on the turn-complete
   * `result` path (`_clearMessageState` for CLI, the post-turn `finally` for
   * SDK). Shifts exactly ONE item and re-dispatches it via `sendMessage` on a
   * `process.nextTick` — that send re-sets `_isBusy`, so the NEXT `result`
   * drains the following item, preserving FIFO order one-turn-at-a-time without
   * re-entrancy (synchronous `result` listeners finish first).
   *
   * Emits `message_dequeued` with `reason: 'flush'` so clients transition the
   * bubble from queued → sent.
   *
   * @returns {object|null} the dequeued item, or null when nothing to flush.
   */
  dequeueNextOutgoing() {
    if (this._destroying || this._outgoingQueue.length === 0) return null
    const item = this._outgoingQueue.shift()
    const clientMessageId = typeof item.sendOptions?.clientMessageId === 'string'
      ? item.sendOptions.clientMessageId
      : undefined
    // queueLength is captured now (post-shift) but the event + re-dispatch are
    // deferred to the next tick together, so message_dequeued(flush) — which a
    // client reads as "this queued message is being sent" — only fires when we
    // are ACTUALLY about to send (a destroy() landing in this window suppresses
    // both). Deferring also guarantees the event lands AFTER the turn's
    // synchronous `result` broadcast on every turn-end path (the natural-result
    // path emits `result` then drains; the abnormal paths drain via
    // _emitInterruptedTurnResult then emit `result`), so a client never sees the
    // dequeue ahead of the result that triggered it.
    const remaining = this._outgoingQueue.length
    process.nextTick(() => {
      if (this._destroying) return
      this.emit('message_dequeued', { clientMessageId, queueLength: remaining, reason: 'flush' })
      ;(this._log || log).info(`Dequeuing follow-up message (${remaining} remaining)`)
      this.sendMessage(item.prompt, item.attachments, item.sendOptions)
    })
    return item
  }

  /**
   * #5936: drop every queued outgoing message. Called by `interrupt()` so a
   * deliberate Stop cancels the owner's pending follow-ups rather than letting
   * them auto-fire after the turn the user just halted — the canonical interrupt
   * policy for the queue (cancel, not flush; see issue #5936). Emits one
   * `message_dequeued` per cleared item with `reason: 'interrupted'` so clients
   * remove each queued bubble. `emit` defaults true; destroy() passes false to
   * tear the queue down silently (no listeners care once the session is gone).
   *
   * @param {{ emit?: boolean }} [opts]
   * @returns {number} how many messages were cleared.
   */
  clearOutgoingQueue({ emit = true } = {}) {
    if (this._outgoingQueue.length === 0) return 0
    const cleared = this._outgoingQueue.splice(0)
    if (emit) {
      // Report a DESCENDING queueLength as each item is removed (cleared.length
      // - 1, - 2, … 0) so the field keeps its documented "count remaining AFTER
      // this item left" meaning — matching dequeueNextOutgoing. The array is
      // already spliced empty, so derive the count from the index rather than
      // reading `_outgoingQueue.length` (which would report 0 for every item).
      cleared.forEach((item, i) => {
        const clientMessageId = typeof item.sendOptions?.clientMessageId === 'string'
          ? item.sendOptions.clientMessageId
          : undefined
        this.emit('message_dequeued', {
          clientMessageId,
          queueLength: cleared.length - i - 1,
          reason: 'interrupted',
        })
      })
      ;(this._log || log).info(`Cleared ${cleared.length} queued follow-up message(s) (interrupted)`)
    }
    return cleared.length
  }

  /**
   * #5943: cancel ONE queued outgoing message by its `clientMessageId`, leaving
   * the rest of the queue intact. Called by the `cancel_queued` handler so the
   * owner can drop a single send-while-busy follow-up they no longer want,
   * WITHOUT the whole-queue cancellation an `interrupt` performs. Emits
   * `message_dequeued` with `reason: 'cancelled'` (the per-item analogue of
   * `clearOutgoingQueue`'s `'interrupted'`) so every client removes just that
   * queued bubble. `queueLength` carries the count remaining AFTER removal,
   * matching the documented meaning on the other dequeue paths.
   *
   * A no-op (returns false, no event) when the id is missing, empty, or matches
   * nothing — an entry queued without a `clientMessageId` cannot be targeted
   * (only the owner's optimistic copy carries one), and a stale/duplicate cancel
   * for an already-flushed item must not emit a spurious dequeue.
   *
   * Authority is enforced upstream, NOT here: the `cancel_queued` handler
   * resolves the caller to THIS session via the standard binding gate before
   * calling in, and the queue is per-session, so reaching this method already
   * means the caller owns the session. Keep that the ownership boundary if the
   * queue is ever refactored to a cross-session structure.
   *
   * @param {string} clientMessageId
   * @returns {boolean} true if an entry was found and removed.
   */
  cancelQueuedMessage(clientMessageId) {
    if (this._destroying || typeof clientMessageId !== 'string' || clientMessageId.length === 0) {
      return false
    }
    const idx = this._outgoingQueue.findIndex(
      (item) => item.sendOptions?.clientMessageId === clientMessageId,
    )
    if (idx === -1) return false
    this._outgoingQueue.splice(idx, 1)
    const remaining = this._outgoingQueue.length
    this.emit('message_dequeued', { clientMessageId, queueLength: remaining, reason: 'cancelled' })
    ;(this._log || log).info(`Cancelled queued follow-up message ${clientMessageId} (${remaining} remaining)`)
    return true
  }

  /**
   * #5160: wire the activity registry to this session's own lifecycle
   * events. The registry is a pure consumer — it only maps already-emitted
   * signals into `ActivityEntry` records, so listening here keeps it a thin
   * unifying layer rather than a parallel tracker. Listeners are attached on
   * the session itself (an EventEmitter) so every provider that routes
   * through these canonical events feeds the registry for free.
   *
   * @private
   */
  _setupActivityRegistry() {
    this.on('tool_start', (d) => this._activity.onToolStart(d))
    this.on('tool_result', (d) => this._activity.onToolResult(d))
    this.on('agent_spawned', (d) => this._activity.onAgentSpawned(d))
    this.on('agent_completed', (d) => this._activity.onAgentCompleted(d))
    this.on('agent_event', (d) => this._activity.onAgentEvent(d))
    this.on('background_work_changed', (d) => this._activity.onBackgroundWorkChanged(d))
    this.on('permission_request', (d) => this._activity.onPermissionRequest(d))
    this.on('user_question', (d) => this._activity.onUserQuestion(d))
    this.on('permission_resolved', (d) => this._activity.onPermissionResolved(d))
    this.on('permission_expired', (d) => this._activity.onPermissionExpired(d))
  }

  /**
   * #5160: clear the activity registry before any listener teardown. Every
   * provider's `destroy()` routes through `removeAllListeners()` (directly,
   * or via super.destroy() chaining — cli/jsonl/gemini/codex call it; sdk/tui
   * also clear the registry explicitly via `_destroyPendingBackgroundShells`).
   * Overriding here is the single chokepoint that guarantees a destroyed
   * session emits `ended` deltas for any still-open node (so live subscribers
   * see the tree drain) and leaves no stale entries — without having to touch
   * each subclass's bespoke destroy(). Clearing BEFORE super removes the
   * listeners means the `activity_delta` emits still reach the wired
   * forwarder. Idempotent: a second call (or a session that already cleared
   * via `_destroyPendingBackgroundShells`) sees an empty registry and no-ops.
   */
  removeAllListeners(eventName) {
    // Only the full teardown variant (no event name) clears the registry —
    // a targeted removeAllListeners('foo') must not drain the activity tree.
    // Note: `super.removeAllListeners(undefined)` is NOT equivalent to the
    // no-arg call — EventEmitter treats `undefined` as the event named
    // `undefined` and removes nothing. So branch on arity and forward each
    // shape with the right argument count.
    if (eventName === undefined) {
      this._activity.clear()
      // #5177: stop the background-shell sweep on full teardown too. Most
      // providers (cli/jsonl/gemini/codex) destroy via removeAllListeners()
      // and never call _destroyPendingBackgroundShells, so this is the
      // chokepoint that guarantees no provider leaks the recurring timer.
      this._stopBackgroundShellSweep()
      return super.removeAllListeners()
    }
    return super.removeAllListeners(eventName)
  }

  /**
   * #5160: keep the activity registry's session id in sync. Subclasses that
   * learn their canonical session id late (SDK sessions, on `init`) call this
   * so emitted `activity_*` messages carry the right id.
   * @param {string} sessionId
   */
  setActivitySessionId(sessionId) {
    this._activity.setSessionId(sessionId)
  }

  /**
   * #5160: full current activity tree as an `activity_snapshot` message.
   * Served to a fresh subscriber (snapshot-on-subscribe) and on resync.
   * @returns {object} the `activity_snapshot` wire message
   */
  getActivitySnapshot() {
    return this._activity.getSnapshotMessage()
  }

  /**
   * #5269 (Control Room Phase 2a): cancel a single in-flight activity node by
   * its `activityId` (an `activity_snapshot`/`activity_delta` entry id).
   *
   * Default (base) behavior: not supported. Only providers that expose a
   * per-task control surface override this — today that is the Agent-SDK path
   * (`SdkSession`, which maps an `agent` node to the SDK's `query.stopTask`).
   * Background shells and individual tool calls are NOT individually
   * cancellable (chroxy does not own the OS process; see activity-registry.js),
   * and CLI/TUI providers have no per-subagent control surface — they fall
   * through to this default. Whole-turn interruption stays on the existing
   * `interrupt()` path, unchanged.
   *
   * @param {string} _activityId
   * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>}
   */
  async cancelActivity(_activityId) {
    return { ok: false, reason: 'not-supported' }
  }

  /**
   * #5376: the following are thin delegators to BackgroundShellTracker. They
   * stay on BaseSession because `background-shells.test.js` drives them as
   * session methods (and `removeAllListeners` stops the sweep via
   * `_stopBackgroundShellSweep`). The sweep / quiescence logic and the
   * test-injected tunables (`_backgroundShell*` get/set shims below) live on the
   * tracker — see background-shell-tracker.js for the #5177/#5247/#5265 rationale.
   * @private
   */
  _emitBackgroundWorkChanged() {
    return this._backgroundShellTracker._emitBackgroundWorkChanged()
  }

  /** @private #5376: delegates to BackgroundShellTracker. */
  _ensureBackgroundShellSweep() {
    return this._backgroundShellTracker._ensureBackgroundShellSweep()
  }

  /** @private #5376: delegates to BackgroundShellTracker. */
  _stopBackgroundShellSweep() {
    return this._backgroundShellTracker._stopBackgroundShellSweep()
  }

  /** @private #5376: delegates to BackgroundShellTracker. */
  _sweepQuiescedBackgroundShells() {
    return this._backgroundShellTracker._sweepQuiescedBackgroundShells()
  }

  /** @private #5376: delegates to BackgroundShellTracker. */
  _isBackgroundShellHardQuiesced(entry) {
    return this._backgroundShellTracker._isBackgroundShellHardQuiesced(entry)
  }

  /** @private #5376: delegates to BackgroundShellTracker. */
  _isBackgroundShellQuiesced(entry) {
    return this._backgroundShellTracker._isBackgroundShellQuiesced(entry)
  }

  /**
   * #4307: clear the pending map on session destroy. Pulled into a
   * helper so subclasses can call it from their own `destroy()` after
   * the existing teardown — keeping the map alive past destroy would
   * leak memory and confuse late session-list snapshots.
   *
   * @private
   */
  _destroyPendingBackgroundShells() {
    // #5376: the tracker stops its sweep and clears the pending map (#5177 — so
    // no tick fires against a half-torn-down session). The session-level
    // companions are torn down here:
    this._backgroundShellTracker.destroy()
    this._pendingBackgroundCommands.clear()
    // #5160: tear down the activity registry alongside the other transient
    // per-session work maps. Ends every remaining node (the session is gone,
    // so nothing is still in flight) and empties the registry — no leak, and
    // a late session-list snapshot can't surface a destroyed session's tree.
    this._activity.clear()
  }

  // ───────────────────────────────────────────────────────────────────────
  // #5376: compat accessors. The skills + background-shell state moved into
  // SkillsManager / BackgroundShellTracker, but existing consumers (the prompt
  // builders, settings-handlers, the #5367 opt sentinel) and the unchanged
  // background-shells.test.js / base-session.test.js suites read (and a couple
  // write) these as session fields. Each reads through to the collaborator's
  // identically-named field so there is a single source of truth — the
  // collaborator. Setters exist only where a test assigns: `_skillsText`
  // (base-session.test.js prompt-builder cases) and `_providerSkillAllowlist`
  // (settings-handlers.test.js allowlist override). Mutating-collection reads
  // (`_pendingBackgroundShells`, `_activeManualSkills`) return the live
  // reference, so `.set`/`.add`/`.delete` operate on the collaborator's state.
  // ───────────────────────────────────────────────────────────────────────

  // Background-shell tracker
  get _pendingBackgroundShells() { return this._backgroundShellTracker._pendingBackgroundShells }
  get _backgroundShellSweepTimer() { return this._backgroundShellTracker._backgroundShellSweepTimer }
  set _backgroundShellSweepTimer(v) { this._backgroundShellTracker._backgroundShellSweepTimer = v }
  get _backgroundShellSweepMs() { return this._backgroundShellTracker._backgroundShellSweepMs }
  set _backgroundShellSweepMs(v) { this._backgroundShellTracker._backgroundShellSweepMs = v }
  get _backgroundShellQuiesceMs() { return this._backgroundShellTracker._backgroundShellQuiesceMs }
  set _backgroundShellQuiesceMs(v) { this._backgroundShellTracker._backgroundShellQuiesceMs = v }
  get _backgroundShellQuiesceCheck() { return this._backgroundShellTracker._backgroundShellQuiesceCheck }
  set _backgroundShellQuiesceCheck(v) { this._backgroundShellTracker._backgroundShellQuiesceCheck = v }
  get _backgroundShellHardQuiesceMs() { return this._backgroundShellTracker._backgroundShellHardQuiesceMs }
  set _backgroundShellHardQuiesceMs(v) { this._backgroundShellTracker._backgroundShellHardQuiesceMs = v }
  get _backgroundShellHardQuiesceCheck() { return this._backgroundShellTracker._backgroundShellHardQuiesceCheck }
  set _backgroundShellHardQuiesceCheck(v) { this._backgroundShellTracker._backgroundShellHardQuiesceCheck = v }

  // Skills manager
  get _skills() { return this._skillsManager._skills }
  get _skillsByMode() { return this._skillsManager._skillsByMode }
  get _skillsText() { return this._skillsManager._skillsText }
  set _skillsText(v) { this._skillsManager._skillsText = v }
  get _prependSkillsText() { return this._skillsManager._prependSkillsText }
  get _activeManualSkills() { return this._skillsManager._activeManualSkills }
  get _manualSkillNames() { return this._skillsManager._manualSkillNames }
  get _skillsDir() { return this._skillsManager._skillsDir }
  get _repoSkillsDir() { return this._skillsManager._repoSkillsDir }
  get _trustStore() { return this._skillsManager._trustStore }
  get _skillsParseCache() { return this._skillsManager._skillsParseCache }
  get _maxSkillBytes() { return this._skillsManager._maxSkillBytes }
  get _maxTotalSkillBytes() { return this._skillsManager._maxTotalSkillBytes }
  get _providerSkillAllowlist() { return this._skillsManager._providerSkillAllowlist }
  set _providerSkillAllowlist(v) { this._skillsManager._providerSkillAllowlist = v }

  /** Current thinking level. Override in subclasses that support it. */
  get thinkingLevel() { return undefined }

  get isReady() {
    return this._processReady && !this._isBusy
  }

  /**
   * #5375: arm the user-initiated-stop flag. Called by each provider's
   * interrupt() so the subsequent process close/error is treated as a clean
   * stop rather than a crash.
   */
  markIntentionalStop() {
    this._intentionalStop = true
  }

  /**
   * #5375: capture-and-clear the user-initiated-stop flag in one step. The
   * provider's close/error handler calls this at the top to decide the
   * stopped-vs-error branch, disarming the flag so the next natural exit is
   * not misread. Returns whether the flag was armed.
   */
  _consumeIntentionalStop() {
    const was = this._intentionalStop
    this._intentionalStop = false
    return was
  }

  /**
   * #5375: plain disarm, for destroy()/finally safety-nets where we only need
   * to clear the flag without reading it. Kept separate from
   * _consumeIntentionalStop so SDK's catch-then-finally clear (the
   * interrupt-races-result race, #4881) stays a two-step sequence.
   */
  _clearIntentionalStop() {
    this._intentionalStop = false
  }

  /**
   * Change the model. Centralizes the busy/no-op guard + resolve; subclasses
   * that need a provider-specific reaction (CliSession respawn, SdkSession log)
   * override the `_onModelChanged` hook instead of the whole setter (#5374).
   * Returns true if the model actually changed.
   */
  setModel(model) {
    if (this._isBusy) {
      return false
    }
    const newModel = model ? resolveModelId(model) : null
    if (newModel === this.model) {
      return false
    }
    this.model = newModel
    this._onModelChanged(this.model)
    return true
  }

  /**
   * #5374: protected hook fired by setModel() AFTER the busy/no-op guard +
   * alias resolution (resolveModelId) and the field update, only when the model
   * actually changed. Default no-op; subclasses override with their
   * provider-specific action (and their own logging).
   */
  _onModelChanged(_model) {}

  /**
   * Change the permission mode. Centralizes validation + the busy/no-op guard;
   * subclasses override the `_onPermissionModeChanged` hook for their
   * provider-specific action (CliSession respawn, SdkSession drain, TUI sidecar
   * write) instead of the whole setter (#5374).
   * Returns true if the mode actually changed.
   */
  setPermissionMode(mode) {
    if (!ALLOWED_PERMISSION_MODE_IDS.has(mode)) {
      return false
    }
    // 'auto' is the panic-button: a user mid-turn (i.e. _isBusy=true)
    // staring at a permission prompt should be able to flip to bypass and
    // have it actually take effect. The non-auto modes still defer until
    // the turn completes — flipping to 'plan' or 'acceptEdits' mid-turn
    // would change semantics partway through and is intentionally rejected.
    if (this._isBusy && mode !== 'auto') {
      return false
    }
    if (mode === this.permissionMode) {
      return false
    }
    this.permissionMode = mode
    this._onPermissionModeChanged(mode)
    return true
  }

  /**
   * #5374: protected hook fired by setPermissionMode() AFTER validation + the
   * field is set, only when the mode actually changed. Default no-op;
   * subclasses override with their provider-specific action (and their own
   * logging). JsonlSubprocessSession deliberately overrides the whole setter
   * to a no-op (it suppresses the field update too), so it does not use this.
   */
  _onPermissionModeChanged(_mode) {}

  /**
   * Toggle the per-session promptEvaluator flag (#3185). Returns `true`
   * when the value changes (so callers can decide whether to broadcast a
   * `prompt_evaluator_changed` event and persist state) and `false` when
   * the input is invalid OR the value is unchanged. Strict-boolean only —
   * a non-boolean input is rejected without mutating state, defending
   * against malformed WS payloads.
   *
   * Unlike `setPermissionMode`, this is safe to flip while the session is
   * busy: the flag is only read at the start of the next prompt, so a
   * mid-turn change has no in-flight side effects.
   *
   * @param {boolean} value
   * @returns {boolean}
   */
  setPromptEvaluator(value) {
    if (typeof value !== 'boolean') {
      return false
    }
    if (value === this.promptEvaluator) {
      return false
    }
    this.promptEvaluator = value
    return true
  }

  /**
   * Toggle the per-session Chroxy context hint (#3805). Mirrors the
   * `setPromptEvaluator` contract: strict-boolean validation, idempotent
   * (returns `false` on a no-op set), and safe to flip mid-turn because
   * the flag is only consulted at the start of the next prompt assembly
   * via `_buildSystemPrompt()`.
   *
   * Default is OFF — when enabled, the Chroxy context paragraph is
   * prepended to the system prompt so the model can adjust output for
   * the mobile-screen client (narrower code blocks, no wide ASCII
   * diagrams). Off by default because some users explicitly want the
   * full desktop response style.
   *
   * @param {boolean} value
   * @returns {boolean}
   */
  setChroxyContextHint(value) {
    if (typeof value !== 'boolean') {
      return false
    }
    if (value === this.chroxyContextHint) {
      return false
    }
    this.chroxyContextHint = value
    return true
  }

  /**
   * Set the per-session preamble (#4660). Accepts a string (trimmed and
   * capped to SESSION_PREAMBLE_MAX_LENGTH) or empty string (clears).
   * Returns `true` when the stored value changes, `false` for either
   * invalid input (non-string) or an idempotent no-op — same contract as
   * `setChroxyContextHint`.
   *
   * Safe to call mid-turn: the preamble is only consulted at the start
   * of the next prompt assembly via `_buildSystemPrompt()`.
   *
   * @param {string} value
   * @returns {boolean}
   */
  setSessionPreamble(value) {
    if (typeof value !== 'string') {
      return false
    }
    const next = _coerceSessionPreambleOpt(value)
    if (next === this.sessionPreamble) {
      return false
    }
    this.sessionPreamble = next
    return true
  }

  /**
   * Set the per-session promptEvaluatorSkipPattern (#3639). Accepts a
   * regex source string (validated by attempting to compile it), null,
   * or empty string (both clear the override). Returns `true` when the
   * stored value changes and `false` for either invalid input or a
   * redundant set — same idempotent contract as `setPromptEvaluator`.
   *
   * The compiled regex itself isn't stored: `shouldSkipEvaluator` owns
   * the compile cache (LRU keyed by source string) so a stale per-session
   * pattern won't pin a closure here. The validation done here is
   * defence-in-depth — `shouldSkipEvaluator` also try/catches its own
   * compile, so a session that somehow ends up with a bad source still
   * fails-open to default-only skip rules.
   *
   * Safe to call mid-turn: the pattern is read at the start of the next
   * `user_input` handler invocation only.
   *
   * @param {string|null} value
   * @returns {boolean}
   */
  setPromptEvaluatorSkipPattern(value) {
    let next
    if (value === null || value === '') {
      next = null
    } else if (typeof value === 'string') {
      try {
        new RegExp(value, 'i')
      } catch {
        return false
      }
      next = value
    } else {
      return false
    }
    if (next === this.promptEvaluatorSkipPattern) {
      return false
    }
    this.promptEvaluatorSkipPattern = next
    return true
  }

  /**
   * Clear per-message state. Subclasses should call super._clearMessageState()
   * and then clear their own additional state (plan mode, pending permissions, etc.).
   */
  /**
   * Parse a JSONL line from a subprocess stdout.
   * Returns the parsed object or null if the line is empty or invalid JSON.
   * @param {string} line
   * @returns {object|null}
   */
  _parseJsonLine(line) {
    if (!line || !line.trim()) return null
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }

  /**
   * Shared skills system MVP (#2957).
   *
   * Returns the list of active skills discovered at construction. Providers
   * that want a summary for `list_skills` can use this; providers that want
   * the injection-ready text should use `_buildSystemPrompt()`.
   *
   * @returns {Array<{ name: string, body: string, description: string }>}
   */
  _getSkills() {
    return Array.isArray(this._skills) ? this._skills : []
  }

  /**
   * Return the set of currently-active manual-skill names (#3209).
   * The dashboard reads this to know which checkboxes to render
   * checked. Callers MUST treat the return as read-only — mutate via
   * `activateSkill()` / `deactivateSkill()` so the loader rebuild
   * fires.
   *
   * @returns {string[]}
   */
  getActiveManualSkills() {
    return Array.from(this._activeManualSkills)
  }

  /**
   * Return the raw active-manual-skills Set (#3252).
   *
   * Same data as `getActiveManualSkills()` but as the underlying Set
   * so callers can do cheap `.has(name)` membership checks without
   * rebuilding from the array form. The returned Set is the same
   * instance held by this session — callers MUST treat it as
   * read-only and mutate via `activateSkill()` / `deactivateSkill()`
   * so the loader rebuild fires.
   *
   * @returns {Set<string>}
   */
  getActiveManualSkillsRaw() {
    return this._activeManualSkills
  }

  /**
   * Return the wired SkillsTrustStore, or null when trust is disabled
   * (#3252).
   *
   * Trust is opt-in: the operator sets `trustMismatchMode` to 'warn'
   * or 'block' to record per-skill content hashes and surface
   * mismatch warnings. Without that opt-in, the field is null and
   * the dashboard renders the panel without hash / last-verified
   * columns rather than showing fake data.
   *
   * @returns {import('./skills-trust.js').SkillsTrustStore | null}
   */
  getTrustStore() {
    return this._trustStore
  }

  /**
   * Return the formatted skills text for injection into the provider's
   * system prompt (Claude SDK `systemPrompt.append`, CLI
   * `--append-system-prompt`). Returns an empty string when no skills are
   * active.
   *
   * Per-skill injection mode (#3200): this returns ONLY skills whose
   * resolved `injectionMode` is `append` / `system`. Skills that asked
   * for `prepend` are returned by `_buildPrependPrompt()` instead. On
   * Claude (which has both channels available), the system-prompt path
   * is the existing v1 default; on Codex / Gemini there is no system
   * prompt so this returns '' for any skill that explicitly asked for
   * `injection: append` — those callers should fall back through
   * `_buildPrependPrompt()`.
   *
   * @returns {string}
   */
  _buildSystemPrompt() {
    const skillsText = typeof this._skillsText === 'string' ? this._skillsText : ''
    // Order (#4660 + #3805): user preamble → chroxy hint → skills text.
    // The user-authored preamble rides at the FRONT so it takes precedence
    // over the canned chroxy hint and the skills bucket — those are
    // chroxy-controlled context, the preamble is the user's voice.
    //
    // When BOTH the preamble is empty AND the chroxy hint is OFF, the
    // return value is byte-identical to pre-#3805 (skillsText only) so
    // existing users see no observable behaviour change. Each layer is
    // joined by `\n\n` so the model sees clean paragraph breaks.
    const parts = []
    if (this.sessionPreamble) parts.push(this.sessionPreamble)
    if (this.chroxyContextHint) parts.push(CHROXY_CONTEXT_HINT_TEXT)
    if (skillsText) parts.push(skillsText)
    return parts.length === 0 ? '' : parts.join('\n\n')
  }

  /**
   * Return the formatted skills text for prepending to the first user
   * message (Codex, Gemini default; any provider when a skill declares
   * `injection: prepend`). Returns an empty string when no skills are
   * active for this channel.
   *
   * Subprocess providers that have no system-prompt channel should
   * concatenate `_buildSystemPrompt()` + `_buildPrependPrompt()` so a
   * Claude-targeted skill that nonetheless ended up loaded for a Codex
   * session still injects (rare — `providers:` filtering normally
   * prevents this — but defensive against typos in frontmatter).
   *
   * @returns {string}
   */
  _buildPrependPrompt() {
    return typeof this._prependSkillsText === 'string' ? this._prependSkillsText : ''
  }

  /**
   * Return a single skills payload that concatenates BOTH the prepend bucket
   * and the append/system bucket with the `# User skills` header rendered
   * exactly once at the top (#3228). Used by subprocess providers (Codex,
   * Gemini) that have no system-prompt channel and must inline every loaded
   * skill into the first user message.
   *
   * Why this exists: `_buildSystemPrompt()` and `_buildPrependPrompt()` each
   * carry their own `# User skills` header so they're complete payloads when
   * routed to their natural channel. Concatenating their string outputs
   * directly produced two headers in the final user-message prefix — caught
   * in PR #3224 review. Building from the two skill lists with a single
   * call to `formatSkillsForPrompt({ includeHeader: false })` per bucket
   * sidesteps that.
   *
   * Returns an empty string when both buckets are empty so the caller can
   * branch on truthiness without null-checking.
   *
   * @returns {string}
   */
  _buildCombinedSkillsPrefix() {
    const prependList = this._skillsByMode && Array.isArray(this._skillsByMode.prepend)
      ? this._skillsByMode.prepend
      : []
    const appendList = this._skillsByMode && Array.isArray(this._skillsByMode.append)
      ? this._skillsByMode.append
      : []

    if (prependList.length === 0 && appendList.length === 0) return ''

    const parts = []
    const prependText = formatSkillsForPrompt(prependList, { includeHeader: false })
    if (prependText) parts.push(prependText)
    const appendText = formatSkillsForPrompt(appendList, { includeHeader: false })
    if (appendText) parts.push(appendText)
    if (parts.length === 0) return ''

    return `${SKILLS_PROMPT_HEADER}${parts.join('\n\n---\n\n')}`
  }

  /**
   * #4628: track that a tool_start event was emitted. Pair with
   * `_trackToolResult(toolUseId)` once the matching tool_result fires.
   * Idempotent on duplicate ids (overwrites tool/startedAt). Safe to
   * call before/after the actual emit — the tracking is decoupled.
   */
  _trackToolStart(toolUseId, tool) {
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
    this._inFlightToolStarts.set(toolUseId, {
      tool: typeof tool === 'string' && tool.length > 0 ? tool : 'unknown',
      startedAt: Date.now(),
    })
  }

  /**
   * #4628: mark a tool_start resolved (matching tool_result fired).
   * Idempotent — calling for an unknown id is a no-op.
   */
  _trackToolResult(toolUseId) {
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
    this._inFlightToolStarts.delete(toolUseId)
  }

  /**
   * #4628: sweep any tool_starts that never got their matching
   * tool_result and emit synthetic tool_result events for each.
   * Companion to SessionMessageHistory.sweepUnresolvedToolStarts (#4619)
   * — that one runs at restore-time on persisted history; this one runs
   * at turn-end on live in-memory tracking so the orphan never gets
   * persisted in the first place.
   *
   * The synthetic tool_result carries the same shape as a real one (the
   * dashboard's `handleToolResult.applyToActiveTools` only matches on
   * `toolUseId`). Extra fields (`synthetic`, `interrupted`, `reason`)
   * are diagnostic hints — the wire schema strips them on parse but
   * they stay grep-able on disk in the persisted history.
   *
   * @param {string} reason — short identifier for the sweep cause
   * @returns {number} count of sweeps emitted
   */
  _sweepUnresolvedToolStarts(reason = 'stream_completed_without_result') {
    if (this._inFlightToolStarts.size === 0) return 0
    const count = this._inFlightToolStarts.size
    for (const [toolUseId, entry] of this._inFlightToolStarts) {
      this.emit('tool_result', {
        toolUseId,
        result: `Tool ${entry.tool} did not emit a result before the turn ended (reason: ${reason}). Chroxy synthesized this result to clear the stale activeTools entry.`,
        truncated: false,
        synthetic: true,
        interrupted: true,
        isError: true,
        reason,
      })
    }
    this._inFlightToolStarts.clear()
    return count
  }

  /**
   * #4628: emit `result` after sweeping any in-flight tool_starts. Provider
   * sessions should route through this WHEN they need the orphan sweep, so
   * orphan tool_starts get paired with a synthetic tool_result BEFORE the
   * result fires (and BEFORE state is persisted, since session-message-history
   * listens for both events). Some providers deliberately emit `this.emit(
   * 'result', ...)` directly (they don't want the sweep); the queueLength stamp
   * is applied to those too via the emit() override below.
   *
   * @param {object} payload — the result event payload ({cost, duration, usage, sessionId})
   * @param {string} [sweepReason] — optional override for the sweep reason
   */
  _emitResult(payload, sweepReason = 'stream_completed_without_result') {
    this._sweepUnresolvedToolStarts(sweepReason)
    // queueLength is stamped centrally in the emit() override below (#6627/#6706).
    this.emit('result', payload)
  }

  /**
   * #6627 / #6706: single choke point for the turn-boundary queue-length stamp.
   *
   * Every `result` event carries the session's authoritative outgoing-queue
   * length so clients reconcile a stale "Queued" bubble on a turn boundary — a
   * dropped/late `message_dequeued` no longer leaves a stale badge until the
   * next queue event. The count is pre-flush (the imminent dequeue emits its own
   * event); `reconcileQueueLength` only trims confirmed orphans, never a live
   * entry, so it is safe to stamp on every result.
   *
   * Stamping here (rather than at each call site) is deliberate: `_emitResult`
   * is NOT the only emitter — several providers emit `result` directly (CLI /
   * exec-codex / gemini / byok / stall fallbacks) because they don't want the
   * orphan sweep, and the #6705 review missed 3 of the 8 sites. Centralizing on
   * the one method every `result` passes through makes the self-heal uniform
   * and un-forgettable for future emit sites too.
   *
   * Idempotent: a payload that already carries `queueLength` (none today, but a
   * caller could pre-stamp) is left untouched. `_outgoingQueue` is a BaseSession
   * field initialized before any subclass method can run; the `?` guard is
   * belt-and-braces and yields 0 for the should-never-happen case of a subclass
   * emitting `result` inside `super()` before the field is set.
   *
   * @param {string} event
   * @param {...any} args
   * @returns {boolean} whether the event had listeners (EventEmitter contract)
   */
  emit(event, ...args) {
    if (event === 'result') {
      const payload = args[0]
      if (payload && typeof payload === 'object' && payload.queueLength === undefined) {
        args[0] = { ...payload, queueLength: this._outgoingQueue ? this._outgoingQueue.length : 0 }
      }
    }
    return super.emit(event, ...args)
  }

  _clearMessageState() {
    this._isBusy = false
    this._currentMessageId = null

    // #4307: clear the ephemeral tool_use→command lookup. NOT the
    // pending-shells map — those entries survive turn-end intentionally
    // (the whole point of #4307: a session waiting on background work
    // is distinct from an idle session). The commands map is only used
    // to recover the command text for the next tool_result of the SAME
    // turn — once the turn ends, any unmatched entries are stranded
    // and a fresh tool_use would re-populate.
    this._pendingBackgroundCommands.clear()
    // #4628: sweep any orphan tool_starts that didn't get their
    // matching tool_result this turn. Most providers route through
    // _emitResult which sweeps before broadcasting result; this is the
    // belt-and-braces for paths that call _clearMessageState directly
    // (e.g. SDK stream-stall recovery clears state BEFORE emitting the
    // synthetic result). Sweeping here ensures the orphan is paired
    // with a synthetic tool_result rather than silently dropped — so
    // the dashboard's activeTools clears whether result fires next or
    // never fires at all.
    this._sweepUnresolvedToolStarts('message_state_cleared')

    // Emit completions for any tracked agents so the app clears badges
    if (this._activeAgents.size > 0) {
      for (const agent of this._activeAgents.values()) {
        this.emit('agent_completed', { toolUseId: agent.toolUseId })
      }
      this._activeAgents.clear()
    }

    // #5160: turn-end reconciliation for the activity registry. Ends any
    // tool/agent/blocked node still marked running/blocked (orphans the
    // model abandoned at turn end), mirroring _sweepUnresolvedToolStarts.
    // Runs AFTER the agent_completed fan-out above so those completions
    // terminate their nodes first; reset() is the belt-and-braces sweep for
    // anything the canonical signals didn't clear. Shell nodes survive
    // turn-end (#4307) and clear via background_work_changed.
    this._activity.reset()

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
    // #3899: clear the hard-cap timer too. A successful turn end (or
    // explicit cancellation) means there's nothing to backstop anymore;
    // leaving the hard timer armed would fire `_handleHardTimeout` on
    // a session that's already idle, which is harmless but noisy.
    if (this._hardTimeout) {
      clearTimeout(this._hardTimeout)
      this._hardTimeout = null
    }
    // #4467: clear the stream-stall recovery timer too.
    if (this._streamStallTimeout) {
      clearTimeout(this._streamStallTimeout)
      this._streamStallTimeout = null
    }
  }
}
