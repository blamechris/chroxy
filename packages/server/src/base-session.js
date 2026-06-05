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
import { statSync } from 'fs'
import { resolveModelId } from './models.js'
import {
  loadActiveSkillsLayered,
  formatSkillsForPrompt,
  groupSkillsByInjectionMode,
  findRepoSkillsDir,
  DEFAULT_SKILLS_DIR,
  SKILLS_PROMPT_HEADER,
} from './skills-loader.js'
import { SkillsTrustStore } from './skills-trust.js'
import { isOperatorTimeoutInRange } from './duration.js'
import { createLogger } from './logger.js'
import { ActivityRegistry } from './activity-registry.js'

const log = createLogger('base-session')

const VALID_PERMISSION_MODES = ['approve', 'auto', 'plan', 'acceptEdits']

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

// #5177: how often the background-shell sweep runs (ms). A completed
// background shell that the agent never polls via `BashOutput` is reaped on
// the next tick after its output file quiesces. 15s is a tradeoff: snappy
// enough that the dashboard banner clears within a sensible window of the
// command actually finishing, slow enough that the per-tick stat() of each
// pending output file is negligible. Only armed while shells are pending.
export const BACKGROUND_SHELL_SWEEP_MS = 15 * 1000

// #5177: quiescence window (ms). A pending shell whose NON-EMPTY output
// file has not been modified for at least this long is treated as complete
// and reaped. 60s is conservative — comfortably longer than the inter-line
// gap of a typical periodic background command (e.g. a 2s-sleep loop) so a
// command that is merely slow between writes is not reaped while still
// running. Combined with the non-empty guard in `_isBackgroundShellComplete`
// (a silent command that emits no output is NEVER reaped via the file path),
// the false-positive surface is small: only a command that produced output,
// then went silent for >60s, then is still running, would be reaped early —
// and even then the agent re-discovers reality on its next BashOutput poll.
// An over-eager clear is a far smaller UX harm than the banner sticking
// forever (the bug this fixes).
export const BACKGROUND_SHELL_QUIESCE_MS = 60 * 1000

// Default per-provider injection mode (#3200). Subprocess providers without
// a system-prompt flag (Codex, Gemini) prepend skills to the first user
// message; Claude (SDK or CLI) appends to the system prompt. Maps the
// session's provider id to the channel that the existing skills text
// pipeline already uses, so a skill without `injection:` keeps its
// behaviour from v1.
const DEFAULT_INJECTION_BY_PROVIDER = {
  'claude-sdk': 'append',
  'claude-cli': 'append',
  'docker-sdk': 'append',
  'docker-cli': 'append',
  'docker': 'append',
  'codex': 'prepend',
  'gemini': 'prepend',
}
const FALLBACK_INJECTION_MODE = 'append'

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
  } = {}) {
    super()
    this.cwd = cwd || process.cwd()
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
    // #4307: per-session map of backgrounded Bash shells the agent is
    // still waiting on. Keyed by the shellId Claude prints in the
    // `Command running in background with ID: <id>` tool_result. Lives
    // beyond `_clearMessageState` (turn-end) on purpose — the whole
    // point of #4307 is that a session waiting on background work is
    // distinct from an idle session and must NOT be reaped by
    // `SessionTimeoutManager`. Entries clear in two paths:
    //   1. Matching `BashOutput` tool call (the agent acknowledged the
    //      shell — either it polled and saw output, or it asked to be
    //      killed; either way our model of pending work is stale).
    //   2. `destroy()` (no leak — see `_destroyPendingBackgroundShells`).
    // SDK provider: if the agent never calls `BashOutput`, the entry
    // persists until destroy. Documented behaviour — we deliberately do
    // not try to tail the output file ourselves (that's a separate
    // sidecar lifecycle problem, out of scope).
    // TUI provider: same parity — the agent's next turn surfaces the
    // BashOutput call and clears the entry naturally.
    //
    // #4417: TRANSIENT BY DESIGN — this map is in-memory only and is
    // NOT serialized to `~/.chroxy/session-state.json`. A server
    // restart drops every entry. This is the correct behaviour, not an
    // oversight:
    //   - The actual OS-level background shells are owned by the
    //     claude TUI / SDK runtime, not by chroxy. On server restart
    //     those processes have either died with the parent or have
    //     been orphaned beyond chroxy's ability to correlate (we never
    //     held the PID, only the opaque shellId Claude printed).
    //   - Persisting the list would therefore re-surface a "waiting
    //     on <command>" indicator that is at best stale and at worst a
    //     UX lie — chroxy can't deliver a clear signal because the
    //     shellId is meaningless to the new claude process.
    //   - The agent re-discovers reality on its next turn via its own
    //     context (a fresh `BashOutput` poll, or a `Bash` re-dispatch).
    //     The user-facing consequence of dropping the map is that the
    //     activity chip briefly shows idle until the next agent turn —
    //     a minor, recoverable UX nit, not data loss.
    // If a future change ever needs to persist this state, it MUST
    // also reconcile with the (unknown) post-restart claude side —
    // blindly restoring a stale Map will lock the indicator on forever.
    this._pendingBackgroundShells = new Map()
    // #5177: periodic sweep that reaps COMPLETED background shells without
    // waiting for the agent to call `BashOutput`. Before #5177 a shell that
    // finished (e.g. `for i in $(seq 1 30); …`, exit 0) stayed pending
    // forever — `isRunning` never returned to false and the dashboard's
    // "Waiting on background work" banner stuck, because the only clear
    // signal was an explicit BashOutput poll that never comes after the
    // turn ends. The sweep observes completion via the output file claude
    // names in the tool_result (`Output is being written to: <path>`): a
    // finished command stops appending, so a quiesced mtime reaps it. The
    // timer is armed only while the pending map is non-empty (lazy) and
    // stopped when it drains or the session is destroyed (no leak / no idle
    // wakeups). Interval + completion check are injectable for tests.
    this._backgroundShellSweepTimer = null
    this._backgroundShellSweepMs = BACKGROUND_SHELL_SWEEP_MS
    // Quiescence window: a shell whose output file has not been written to
    // for this long is treated as complete. Conservative so a command that
    // pauses output mid-run is not reaped prematurely; the agent's own
    // BashOutput poll still clears faster when it happens.
    this._backgroundShellQuiesceMs = BACKGROUND_SHELL_QUIESCE_MS
    // Injectable completion check — `(entry) => boolean`. Default reads the
    // output file's mtime; tests override this to drive deterministic
    // completion without touching the filesystem or real timers.
    this._backgroundShellCompletionCheck = null
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

    // Per-session manually-activated skill names (#3199). Skills declared
    // `activation: manual` are off by default and only load when their
    // name is in this Set. #3209 adds the WS toggle path
    // (activateSkill/deactivateSkill) that mutates this Set + reloads.
    this._activeManualSkills = activeManualSkills instanceof Set
      ? new Set(activeManualSkills)
      : (Array.isArray(activeManualSkills) ? new Set(activeManualSkills) : new Set())

    // Cache the immutable load-time inputs so the runtime toggle path
    // (#3209) can rebuild layerOpts without re-parsing constructor args.
    // These are set once at construction and never mutate.
    this._skillsDir = skillsDir || DEFAULT_SKILLS_DIR
    this._repoSkillsDir = repoSkillsDir !== undefined
      ? repoSkillsDir
      : findRepoSkillsDir(this.cwd)
    this._maxSkillBytes = Number.isFinite(maxSkillBytes) ? maxSkillBytes : null
    this._maxTotalSkillBytes = Number.isFinite(maxTotalSkillBytes) ? maxTotalSkillBytes : null
    this._providerSkillAllowlist = providerSkillAllowlist != null
      && typeof providerSkillAllowlist === 'object'
      && !Array.isArray(providerSkillAllowlist)
      ? providerSkillAllowlist
      : null

    // Trust store (#3204). Two activation paths:
    //   - `trustStore: <SkillsTrustStore-like>` — caller-supplied store
    //     (tests pin a temp file path here so the real
    //     ~/.chroxy/skills-trust.json is never touched).
    //   - `trustMismatchMode: 'warn' | 'block'` — opt into the default
    //     store at ~/.chroxy/skills-trust.json with the chosen mode.
    //     SessionManager always passes one of these strings through;
    //     direct BaseSession construction without it (existing tests,
    //     ad-hoc instantiation) keeps the legacy no-op behaviour.
    let resolvedTrustStore = null
    if (trustStore) {
      resolvedTrustStore = trustStore
    } else if (trustMismatchMode === 'warn' || trustMismatchMode === 'block') {
      resolvedTrustStore = new SkillsTrustStore({ mode: trustMismatchMode })
    }
    this._trustStore = resolvedTrustStore

    // #3248: per-session parse cache. Map keyed by realpath; values
    // hold `{ mtimeMs, size, body, frontmatter, finalBody, description }`
    // so subsequent _loadSkills() calls (every activate/deactivate
    // toggle) skip readFileSync / parseFrontmatter for files whose
    // mtimeMs is unchanged. The loader writes through to this Map —
    // invalidation is automatic when the on-disk mtimeMs moves.
    this._skillsParseCache = new Map()

    // Skills are scanned at construction. #3209 adds a runtime reload
    // path for manual activation toggles. Mismatch events are
    // collected during the synchronous loader call and re-emitted on
    // `process.nextTick` because SessionManager wires event listeners
    // AFTER the constructor returns — a synchronous emit here would
    // land on an empty listener set.
    const { trustEvents: pendingTrustEvents, communityTrustEvents: pendingCommunityTrustEvents } = this._loadSkills({ collectTrustEvents: true })
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
   * Build the layered-loader options + run the loader, populating the
   * skill caches (`_skills`, `_skillsByMode`, `_skillsText`,
   * `_prependSkillsText`). Used by both the constructor and the
   * runtime activate/deactivate toggle (#3209) so the loader-side
   * state stays the single source of truth.
   *
   * @param {{ collectTrustEvents?: boolean }} [opts]
   * @returns {{ trustEvents: Array<object>, communityTrustEvents: Array<object> }}
   *   `trustEvents` — pending skill_changed events (mismatch) when collectTrustEvents=true.
   *   `communityTrustEvents` — pending skill_trust_request events for untrusted community skills.
   * @private
   */
  _loadSkills({ collectTrustEvents = false } = {}) {
    const layerOpts = {
      globalDir: this._skillsDir,
      repoDir: this._repoSkillsDir,
      provider: this._provider,
      activeManualSkills: this._activeManualSkills,
      defaultInjectionMode: DEFAULT_INJECTION_BY_PROVIDER[this._provider] || FALLBACK_INJECTION_MODE,
      // #3253: include inactive manual skills in the unified scan so
      // `activateSkill` can validate names against `_manualSkillNames`
      // without paying for a second validation-only scan. The active
      // subset is partitioned out below before populating the
      // prompt-context caches — inactive entries never reach the
      // model. Cost: a few metadata-only entries; bodies are not
      // loaded for inactive manual skills (skills-loader.js:646).
      includeInactive: true,
    }
    if (this._maxSkillBytes !== null) layerOpts.maxSkillBytes = this._maxSkillBytes
    if (this._maxTotalSkillBytes !== null) layerOpts.maxTotalSkillBytes = this._maxTotalSkillBytes
    if (this._providerSkillAllowlist) layerOpts.providerSkillAllowlist = this._providerSkillAllowlist
    // #3248: hand the per-session parse cache to the loader. Cache
    // hits skip readFileSync + parseFrontmatter; misses populate.
    if (this._skillsParseCache instanceof Map) layerOpts.parseCache = this._skillsParseCache

    const pendingTrustEvents = []
    const pendingCommunityTrustEvents = []
    if (this._trustStore) {
      layerOpts.trustStore = this._trustStore
      if (collectTrustEvents) {
        layerOpts.onTrustMismatch = (info) => { pendingTrustEvents.push(info) }
      }
      // Hash recording happens via `trustStore.inspect()` inside the
      // loader regardless of whether `onTrustMismatch` is wired — the
      // callback is just the mismatch-event delivery channel. On
      // runtime reload (collectTrustEvents=false) we deliberately
      // omit the callback so a user-initiated toggle does NOT
      // re-emit `skill_changed` events that already fired at session
      // construction.

      // #3297: community trust checker — allows the loader to gate
      // community skills pending a first-activation grant.
      if (typeof this._trustStore.isCommunityTrusted === 'function') {
        layerOpts.communityTrustChecker = this._trustStore.isCommunityTrusted.bind(this._trustStore)
      }
      // Always collect community trust pending events (fired on both
      // construction and runtime reload so re-entry from other sessions
      // sees the prompt after a grant clears an earlier block).
      layerOpts.onCommunityTrustPending = (info) => { pendingCommunityTrustEvents.push(info) }
    }

    const all = loadActiveSkillsLayered(layerOpts)
    if (this._trustStore && typeof this._trustStore.flush === 'function') {
      try { this._trustStore.flush() } catch { /* ignore */ }
    }

    // #3253: partition the unified scan into the active subset (used
    // for prompt injection) and a Set of all manual-skill names (used
    // by activateSkill to validate without re-scanning). Inactive
    // entries carry `active: false` from the loader; auto skills
    // don't carry the field at all and are always active.
    const manualNames = new Set()
    const active = []
    for (const s of all) {
      const activation = typeof s.metadata?.activation === 'string'
        ? s.metadata.activation.trim().toLowerCase()
        : null
      if (activation === 'manual') manualNames.add(s.name)
      if (s.active !== false) active.push(s)
    }
    this._skills = active
    this._manualSkillNames = manualNames

    const grouped = groupSkillsByInjectionMode(this._skills)
    this._skillsByMode = grouped
    this._skillsText = formatSkillsForPrompt(grouped.append)
    this._prependSkillsText = formatSkillsForPrompt(grouped.prepend)

    return { trustEvents: pendingTrustEvents, communityTrustEvents: pendingCommunityTrustEvents }
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
    if (typeof skillName !== 'string' || skillName === '') return false
    if (this._activeManualSkills.has(skillName)) return false

    // #3253: speculatively add and reload — the unified `_loadSkills`
    // scan populates both the prompt-context caches AND the
    // `_manualSkillNames` validation set, so we can reuse one scan
    // for validation + reload rather than running a separate
    // validation-only scan first. On the rare failure path (typo /
    // auto-skill name) we run a rollback scan to restore the active
    // set; the common success path stays at one layered scan.
    this._activeManualSkills.add(skillName)
    const { communityTrustEvents } = this._loadSkills()
    if (!this._manualSkillNames.has(skillName)) {
      this._activeManualSkills.delete(skillName)
      this._loadSkills()
      return false
    }
    for (const ev of communityTrustEvents) {
      this.emit('skill_trust_request', ev)
    }
    return true
  }

  /**
   * Deactivate a manual skill at runtime (#3209). Returns true when
   * the active set actually changed; false otherwise. The
   * `_listManualSkillNames` validation isn't strictly needed here
   * (deactivating a name that isn't currently active is already a
   * no-op via the `has()` check), but mirroring `activateSkill`
   * keeps the contract symmetric.
   *
   * @param {string} skillName
   * @returns {boolean}
   */
  deactivateSkill(skillName) {
    if (typeof skillName !== 'string' || skillName === '') return false
    if (!this._activeManualSkills.has(skillName)) return false
    this._activeManualSkills.delete(skillName)
    const { communityTrustEvents } = this._loadSkills()
    for (const ev of communityTrustEvents) {
      this.emit('skill_trust_request', ev)
    }
    return true
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
   */
  get isRunning() {
    if (this._isBusy) return true
    return this._pendingBackgroundShells.size > 0
  }

  /**
   * #4307: read-only snapshot of pending background shells, ordered by
   * insertion (so the dashboard surfaces the most-recently-started shell
   * last). Returns a plain array of `{ shellId, startedAt, command }`
   * objects so the caller can stringify directly onto a wire payload.
   */
  getPendingBackgroundShells() {
    // #5177: project to the stable wire shape — `outputPath` is an internal
    // sweep detail and must not leak onto the snapshot the dashboard caches.
    return Array.from(this._pendingBackgroundShells.values()).map(
      ({ shellId, startedAt, command }) => ({ shellId, startedAt, command }),
    )
  }

  /**
   * #4307: record a new pending background shell. Idempotent on
   * shellId — re-registering an existing id is a no-op (preserves the
   * original startedAt + command so a duplicate tool_result, which
   * does happen on certain claude paths, can't bump the timestamp or
   * overwrite the original command text).
   *
   * Emits `background_work_changed` with the full pending snapshot
   * after a change. `SessionManager` proxies this transient event onto
   * the WS wire (see `customEvents`-style integration).
   *
   * #5177: `outputPath` (when known — parsed from the canonical
   * tool_result) is stashed so the completion sweep can observe the shell
   * finishing via the output file's mtime. It is internal-only and is NOT
   * surfaced on the wire snapshot (see getPendingBackgroundShells).
   *
   * @param {{ shellId: string, command?: string, outputPath?: string }} opts
   * @returns {boolean} true if a new entry was added
   */
  trackBackgroundShell({ shellId, command, outputPath } = {}) {
    if (typeof shellId !== 'string' || shellId.length === 0) return false
    if (this._pendingBackgroundShells.has(shellId)) return false
    this._pendingBackgroundShells.set(shellId, {
      shellId,
      startedAt: Date.now(),
      command: typeof command === 'string' ? command : '',
      outputPath: typeof outputPath === 'string' && outputPath.length > 0 ? outputPath : null,
    })
    // #5177: start the reaping sweep now that there is work to watch.
    this._ensureBackgroundShellSweep()
    this._emitBackgroundWorkChanged()
    return true
  }

  /**
   * #4307: clear a pending background shell by id. Returns true when
   * an entry actually existed, false when the id was not tracked —
   * matches the idempotent contract of other BaseSession setters so
   * the caller can decide whether to log / emit.
   *
   * Emits `background_work_changed` with the post-clear snapshot when
   * the change is observable (entry actually existed).
   *
   * @param {string} shellId
   * @returns {boolean}
   */
  clearBackgroundShell(shellId) {
    if (typeof shellId !== 'string' || shellId.length === 0) return false
    if (!this._pendingBackgroundShells.delete(shellId)) return false
    // #5177: stop the sweep once the last shell drains so an idle session
    // has no recurring timer (no wakeups, no leak). Re-armed by the next
    // trackBackgroundShell.
    if (this._pendingBackgroundShells.size === 0) this._stopBackgroundShellSweep()
    this._emitBackgroundWorkChanged()
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
   * #4307: emit the current pending-shells snapshot on the
   * `background_work_changed` event. Pulled into a helper so both
   * `trackBackgroundShell` and `clearBackgroundShell` use one shape.
   * The full snapshot is sent on each change (not just the delta) so a
   * late-joining client subscribed to the event sees the canonical
   * state without needing to replay a delta stream.
   *
   * @private
   */
  _emitBackgroundWorkChanged() {
    this.emit('background_work_changed', {
      pending: this.getPendingBackgroundShells(),
    })
  }

  /**
   * #5177: arm the periodic reaping sweep if it is not already running and
   * there is pending work to watch. Idempotent — a second call while the
   * timer is live is a no-op, so every `trackBackgroundShell` can call it
   * unconditionally. The interval is `unref()`'d so a lone pending shell
   * can never keep the process alive on its own (mirrors how chroxy treats
   * its other background timers — the shell is owned by claude, not us).
   *
   * @private
   */
  _ensureBackgroundShellSweep() {
    if (this._backgroundShellSweepTimer) return
    if (this._pendingBackgroundShells.size === 0) return
    if (!(this._backgroundShellSweepMs > 0)) return
    this._backgroundShellSweepTimer = setInterval(
      () => this._sweepCompletedBackgroundShells(),
      this._backgroundShellSweepMs,
    )
    // unref so the sweep never blocks process exit on its own.
    if (typeof this._backgroundShellSweepTimer.unref === 'function') {
      this._backgroundShellSweepTimer.unref()
    }
  }

  /**
   * #5177: stop the reaping sweep. Idempotent.
   * @private
   */
  _stopBackgroundShellSweep() {
    if (!this._backgroundShellSweepTimer) return
    clearInterval(this._backgroundShellSweepTimer)
    this._backgroundShellSweepTimer = null
  }

  /**
   * #5177: one sweep tick — reap every pending shell that has completed.
   * Completion is decided by `_isBackgroundShellComplete`. Reaping a shell
   * goes through `clearBackgroundShell`, so it emits the SAME
   * `background_work_changed` snapshot the BashOutput / destroy paths emit —
   * the dashboard's "Waiting on background work" indicator consumes that
   * snapshot and clears with no new wire contract. Iterating over a copied
   * key list keeps the mutation (clearBackgroundShell deletes from the map)
   * safe.
   *
   * @private
   */
  _sweepCompletedBackgroundShells() {
    for (const shellId of Array.from(this._pendingBackgroundShells.keys())) {
      const entry = this._pendingBackgroundShells.get(shellId)
      if (!entry) continue
      if (this._isBackgroundShellComplete(entry)) {
        this.clearBackgroundShell(shellId)
      }
    }
  }

  /**
   * #5177: decide whether a pending background shell has completed.
   *
   * Tests inject `_backgroundShellCompletionCheck` for deterministic control
   * without touching the filesystem or real time. The production default
   * uses the shell's output file mtime: claude tails the command's
   * stdout/stderr into the file named in the tool_result, so a NON-EMPTY
   * file that has not been written to for `_backgroundShellQuiesceMs` means
   * the command produced output and then stopped — the strongest completion
   * signal available given chroxy never holds the shell's PID (the id is
   * opaque, owned by claude). A shell with no known output path, or whose
   * output file is still empty (a silent command like `sleep 600`), can't be
   * reaped this way and stays pending until BashOutput / destroy — the
   * existing #4307 behaviour, preserved as the conservative fallback so a
   * long, silent job is never flipped to idle while still running.
   *
   * Defensive: a stat() error (file removed, races) is treated as NOT
   * complete so a transient FS hiccup can't reap a still-running shell. The
   * banner sticking briefly is recoverable; a false clear is worse.
   *
   * @param {{ shellId: string, outputPath?: string|null, startedAt: number }} entry
   * @returns {boolean}
   * @private
   */
  _isBackgroundShellComplete(entry) {
    if (typeof this._backgroundShellCompletionCheck === 'function') {
      return this._backgroundShellCompletionCheck(entry) === true
    }
    if (!entry || typeof entry.outputPath !== 'string' || entry.outputPath.length === 0) {
      return false
    }
    try {
      const st = statSync(entry.outputPath)
      // #5177 (review): a SILENT command — one that produces no output and
      // only exits much later (`sleep 600`, a long compute that prints only
      // at the end) — leaves the output file empty and untouched after
      // creation. Reaping on mtime alone would clear it ~quiesceMs after
      // start while it is still running, flipping isRunning to false and
      // letting SessionTimeoutManager treat the session as idle. Guard with
      // a non-empty check: an empty output file is NEVER reaped via this
      // path, so silent shells fall back to the existing BashOutput /
      // destroy clear (the conservative #4307 behaviour). The sweep only
      // reaps shells that demonstrably produced output and then went quiet —
      // the strong signal that the command ran and finished.
      if (st.size <= 0) return false
      const lastWrite = st.mtimeMs
      return Date.now() - lastWrite >= this._backgroundShellQuiesceMs
    } catch {
      return false
    }
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
    // #5177: stop the reaping sweep before clearing the map so no tick can
    // fire against a half-torn-down session.
    this._stopBackgroundShellSweep()
    this._pendingBackgroundShells.clear()
    this._pendingBackgroundCommands.clear()
    // #5160: tear down the activity registry alongside the other transient
    // per-session work maps. Ends every remaining node (the session is gone,
    // so nothing is still in flight) and empties the registry — no leak, and
    // a late session-list snapshot can't surface a destroyed session's tree.
    this._activity.clear()
  }

  /** Current thinking level. Override in subclasses that support it. */
  get thinkingLevel() { return undefined }

  get isReady() {
    return this._processReady && !this._isBusy
  }

  /**
   * Change the model. Subclasses that need to restart (CliSession) should
   * override and call super.setModel() for the guard + resolve, then act.
   * Returns true if the model actually changed (subclass should act).
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
    return true
  }

  /**
   * Change the permission mode. Subclasses that need to restart (CliSession)
   * should override and call super.setPermissionMode() for validation.
   * Returns true if the mode actually changed.
   */
  setPermissionMode(mode) {
    if (!VALID_PERMISSION_MODES.includes(mode)) {
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
    return true
  }

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
   * #4628: emit `result` after sweeping any in-flight tool_starts. All
   * provider sessions should route through this rather than calling
   * `this.emit('result', ...)` directly, so orphan tool_starts get
   * paired with a synthetic tool_result BEFORE the result fires (and
   * BEFORE state is persisted, since session-message-history listens
   * for both events).
   *
   * @param {object} payload — the result event payload ({cost, duration, usage, sessionId})
   * @param {string} [sweepReason] — optional override for the sweep reason
   */
  _emitResult(payload, sweepReason = 'stream_completed_without_result') {
    this._sweepUnresolvedToolStarts(sweepReason)
    this.emit('result', payload)
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
