import { query, forkSession } from '@anthropic-ai/claude-agent-sdk'
import { join } from 'path'
import { homedir } from 'os'
import { updateModels, saveModelsCache, updateContextWindow, getModels, ALLOWED_MODEL_IDS } from './models.js'
import { CLAUDE_FALLBACK_MODELS, claudeModelMetadata } from './claude-model-catalog.js'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { normalizeSdkModelUsage } from './usage-normalize.js'
import { buildContentBlocks } from './content-blocks.js'
import { MessageTransformPipeline } from './message-transform.js'
import { emitToolResults } from './tool-result.js'
import {
  parseBackgroundShellId,
  parseBackgroundShellOutputPath,
  isRunInBackgroundInput,
  parseBashOutputShellId,
} from './background-shells.js'
import { buildToolStartData, extractToolInputSemantics } from './claude-stream-parser.js'
import { createLogger, loggerForSession } from './logger.js'
import { PermissionManager, wirePermissionManager } from './permission-manager.js'
import { formatBytes } from './utils/format-bytes.js'
import { formatIdleDuration } from './session-timeout-manager.js'
import { detectThinkingKeyword } from './detect-thinking-keyword.js'
import { BILLING_CLASSES, isProgrammaticCreditEra } from './billing-class.js'

const log = createLogger('sdk')

/**
 * Manages a Claude Code session using the Agent SDK.
 *
 * Same EventEmitter interface as CliSession so SessionManager and WsServer
 * work identically regardless of which session type is in use.
 *
 * Key advantages over CliSession:
 *   - In-process permission handling via canUseTool (no HTTP hook pipeline)
 *   - setModel/setPermissionMode work live without process restart
 *   - One query() call per user message, SDK manages conversation state
 *
 * Events emitted (identical to CliSession):
 *   ready        { sessionId, model, tools }
 *   stream_start { messageId }
 *   stream_delta { messageId, delta }
 *   stream_end   { messageId }
 *   message      { type, content, timestamp }
 *   tool_start   { messageId, tool, input }
 *   result       { cost, duration, usage, sessionId }
 *   error        { message }
 *   permission_request { requestId, tool, description, input }
 *   user_question      { toolUseId, questions }
 *   agent_spawned      { toolUseId, description, startedAt }
 *   agent_completed    { toolUseId }
 *   tool_result        { toolUseId, result, truncated }
 */

// Default max accumulated size for tool_use input (~256KB)
const DEFAULT_MAX_TOOL_INPUT_LENGTH = 262144
// #5936 (epic #5935): the mid-turn follow-up queue moved to BaseSession's shared
// `_outgoingQueue` (capped at OUTGOING_QUEUE_MAX), so both SDK and CLI now QUEUE
// send-while-busy follow-ups and flush them FIFO on `result` — replacing the
// SDK's old `_pendingInput` (cap 3, #5711) and the CLI's "Already processing a
// message" reject with one consistent queue → flush-on-complete behaviour.

// Marker stamped on a proc the first time _attachSidecarProcessListeners()
// wires its default listeners (#3504 review).  Subsequent calls on the same
// proc short-circuit instead of attaching duplicate listeners — without this
// guard a re-wiring caller (resume/reconnect path, future K8s session class
// re-spawning into the same proc) would emit N copies of every warn-log.
// Symbol-keyed so it cannot collide with consumer code or test stubs.
const SIDECAR_LISTENERS_ATTACHED = Symbol('sdk-session.sidecarListenersAttached')

// Cumulative byte threshold for escalating stdin_dropped to error (#3506).
// Defaults to 10 MiB — equivalent to ten full pre-dial-cap chunks.  Once the
// running total of dropped bytes meets or exceeds this, a single error log
// is emitted (one-shot per crossing) so operators triaging "why did my
// prompt vanish?" get a loud signal even on a flood of small drops.
export const STDIN_DROPPED_BYTES_ERROR_THRESHOLD = 10 * 1024 * 1024

// Drop-count cadence for re-escalating stdin_dropped to error (#3506).
// In addition to the byte threshold, every Nth drop event is logged at error
// level so a stream of zero-byte / unknown-size drops still raises a loud
// signal.  Set to 10 to balance signal-to-noise.
export const STDIN_DROPPED_ESCALATION_EVERY_N = 10

// Minimum interval between refused-sendMessage warn logs (#3575).
// PR #3560 (#3539) added a warn on every refused sendMessage when
// `_stdinForwardingDisabled` is latched, but a stuck client retrying in a
// hot loop floods operator logs with the same line. The per-call `error`
// event still fires every time so client UI feedback is unaffected — only
// the log line is gated. 30s balances visibility ("the session is still
// stuck") with noise control.
export const REFUSED_SENDMESSAGE_WARN_INTERVAL_MS = 30 * 1000

export class SdkSession extends BaseSession {
  // #5858: marks this as a Claude-family provider — the single source of truth
  // for `isClaudeProvider()` (drives the createSession soft-fallback for stale
  // model ids + the shared models registry). Docker subclasses inherit it.
  static claudeFamily = true

  /**
   * Human-readable label shown in the startup banner and anywhere else the
   * server needs to name this provider (#2953). Each provider owns its own
   * display name so `server-cli.js` no longer has to maintain a hardcoded
   * `PROVIDER_LABELS` map that drifts every time a new provider lands.
   */
  static get displayLabel() {
    return 'Claude Code (SDK)'
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
      inProcessPermissions: true,
      modelSwitch: true,
      permissionModeSwitch: true,
      // #5609: SDK applies a mid-turn switch to 'auto' in-process (clears
      // rules + auto-resolves pending prompts at the next tool check) without
      // killing the turn. Declared false so the capability matrix is uniform —
      // CliSession is the only provider where the auto-switch is destructive.
      interruptsTurnOnAutoSwitch: false,
      planMode: false,
      resume: true,
      terminal: false,
      thinkingLevel: true,
      // #3932: explicit `streaming` so the capability matrix is uniform across
      // providers — claude-tui sets this to false (deliver-on-complete), all
      // others stream incremental deltas via stream_delta during a turn.
      streaming: true,
      // #3209/#3246: SDK rebuilds systemPrompt.append on every turn
      // (see sdk-session.js#_callQuery), so a runtime toggle of
      // _activeManualSkills + _loadSkills() takes effect on the next
      // user message. Subprocess providers don't get this for free —
      // they snapshot the skills text at session start.
      skillToggle: true,
    }
  }

  /**
   * Custom event names this provider emits beyond the BaseSession defaults.
   *
   * #3544: `stdin_dropped_totals` carries the cumulative running total of
   * bytes dropped at the SidecarProcess pre-dial cap so operators (mobile
   * users, dashboard-only operators) who can't tail the server log still
   * see how much input has been silently lost. SessionManager forwards
   * customEvents as transient session_events — they aren't recorded in
   * history and aren't replayed on reconnect, but the cumulative counters
   * are session-lifetime so a fresh emit on the next drop re-publishes
   * the running total.
   *
   * @returns {string[]}
   */
  static get customEvents() {
    return ['stdin_dropped_totals']
  }

  /**
   * #3209: SDK is the only provider that rebuilds the system prompt
   * each turn, so manual-skill toggles propagate to the wire here.
   * Subprocess providers (CliSession, CodexSession, GeminiSession)
   * inherit the BaseSession default of `false`.
   */
  supportsRuntimeSkillToggle() {
    return true
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   * SDK mode spawns the `claude` binary under the hood, so the same
   * binary check applies. Credentials can come from ANTHROPIC_API_KEY,
   * CLAUDE_CODE_OAUTH_TOKEN, or a prior `claude login` subscription.
   */
  static get preflight() {
    return {
      label: 'Claude SDK',
      binary: {
        name: 'claude',
        args: ['--version'],
        candidates: [
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
        ],
        installHint: 'install Claude Code CLI (required by the Agent SDK)',
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
   * Tries env vars first; falls back to the on-disk `claude login` OAuth
   * probe so the dashboard reports ready when the user has logged in via
   * subscription without exporting a key. Without the probe the dashboard
   * would lie about ready=true after #3674.
   *
   * @param {NodeJS.ProcessEnv} env
   * @param {{ hasClaudeOAuthCreds: () => boolean }} helpers
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth(env, helpers) {
    const credSpec = this.preflight.credentials
    const envVars = credSpec.envVars
    const hint = credSpec.hint || `set ${envVars.join(' or ')}`
    // Era read at call time so a long-running daemon flips OAuth/credit-pool
    // copy at the 2026-06-15 boundary without a restart (#5629).
    const era = isProgrammaticCreditEra()

    const matched = envVars.find(v => env[v])
    if (matched) {
      // An explicit ANTHROPIC_API_KEY is a raw API account (per-token billing),
      // NOT the subscription/credit pool — bill it `api-key` in BOTH eras
      // (#5630 refinement). CLAUDE_CODE_OAUTH_TOKEN and any other matched var
      // is the OAuth/credit-pool path, era-gated like the on-disk OAuth branch.
      const isApiKey = matched === 'ANTHROPIC_API_KEY'
      if (isApiKey) {
        return {
          ready: true,
          source: 'env',
          envVar: matched,
          envVars,
          hint: '',
          detail: `Anthropic API (${matched} set)`,
          billingClass: BILLING_CLASSES.API_KEY,
        }
      }
      const identity = matched === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? 'Anthropic API (OAuth token)'
        : 'Claude subscription'
      return {
        ready: true,
        source: 'env',
        envVar: matched,
        envVars,
        hint: '',
        detail: era
          ? `Programmatic credit pool — monthly metered credits (${matched} set)`
          : `${identity} (${matched} set)`,
        billingClass: era ? BILLING_CLASSES.PROGRAMMATIC_CREDIT : BILLING_CLASSES.SUBSCRIPTION,
      }
    }

    if (helpers.hasClaudeOAuthCreds()) {
      return {
        ready: true,
        source: 'oauth',
        envVar: null,
        envVars,
        hint,
        detail: era
          ? 'Programmatic credit pool — monthly metered credits (OAuth from `claude login`)'
          : 'Claude subscription (OAuth from `claude login`)',
        billingClass: era ? BILLING_CLASSES.PROGRAMMATIC_CREDIT : BILLING_CLASSES.SUBSCRIPTION,
      }
    }

    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint: hint || 'run `claude login` or set ANTHROPIC_API_KEY',
      detail: `Not configured — ${hint || 'run \`claude login\` or set ANTHROPIC_API_KEY'}`,
      // Unconfigured: default to the era-gated credit-pool class (this is the
      // claude-sdk default auth path once configured via `claude login`).
      billingClass: era ? BILLING_CLASSES.PROGRAMMATIC_CREDIT : BILLING_CLASSES.SUBSCRIPTION,
    }
  }

  /**
   * Minimal model list for the per-provider registry (#2956). The live
   * Agent SDK push (`supportedModels()`) replaces this at runtime; the
   * fallback ships only short aliases so the dropdown is never empty
   * before the first SDK response arrives.
   */
  static getFallbackModels() {
    return CLAUDE_FALLBACK_MODELS
  }

  static getAllowedModels() {
    return [...ALLOWED_MODEL_IDS]
  }

  /**
   * Claude-style metadata: strip the `claude-` prefix for the short id,
   * reuse the shared context-window heuristic. Used by the per-provider
   * registry for both lookup and validation (#2956). Delegates to the shared
   * claudeModelMetadata() so all Claude providers stay in lockstep (#6201 OCP).
   *
   * @param {string} modelId - Full model id (e.g. 'claude-sonnet-4-6').
   * @returns {{id:string,label:string,fullId:string,contextWindow:number,description?:string}|null}
   */
  static getModelMetadata(modelId) {
    return claudeModelMetadata(modelId)
  }

  /** Token budgets for thinking levels. null = adaptive (SDK default). */
  static THINKING_BUDGETS = { default: null, high: 32000, max: 128000 }

  /** Error patterns mapped to user-friendly messages. */
  static _ERROR_PATTERNS = [
    { test: /credit|billing|quota|usage.limit/i,
      msg: 'Insufficient API credits or billing limit reached. Check your API provider dashboard.' },
    { test: /rate.limit|too many requests|429/i,
      msg: 'API rate limit exceeded. Please wait a moment and try again.' },
    { test: /authentication|invalid.api.key|401|unauthorized/i,
      msg: 'API authentication failed. Check your API key configuration.' },
    { test: /overloaded|503|529|temporarily unavailable/i,
      msg: 'The API is temporarily overloaded. Please try again in a few minutes.' },
    { test: /SIGABRT|SIGKILL|SIGSEGV|terminated by signal/i,
      msg: 'Claude Code process crashed. This is often caused by API errors (insufficient credits, invalid key, or rate limits). Check your API provider dashboard.' },
  ]

  static _enrichErrorMessage(raw) {
    if (!raw) return 'Unknown error'
    for (const { test, msg } of SdkSession._ERROR_PATTERNS) {
      if (test.test(raw)) return msg
    }
    return raw
  }

  get thinkingLevel() { return this._thinkingLevel }

  constructor(opts = {}) {
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-sdk' }))
    // SdkSession-local opts (not BaseSession opts — see buildBaseSessionOpts).
    const { resumeSessionId, transforms, maxToolInput, sandbox, stdinForwardingDisabled } = opts
    this._maxToolInput = maxToolInput || DEFAULT_MAX_TOOL_INPUT_LENGTH
    this._transformPipeline = new MessageTransformPipeline(transforms || [])
    this._sandbox = sandbox || null

    this._sdkSessionId = resumeSessionId || null
    this._sessionId = null
    // #4828: session-scoped logger, lazily bound on the SDK's first `init`
    // message (where session_id becomes known). Pre-init log lines stay on
    // the module-level `log` — same fallback pattern as ClaudeTuiSession.
    // No reset on destroy/respawn (unlike CliSession): SdkSession lacks a
    // _killAndRespawn path so session_id is stable for the instance
    // lifetime; the binding stays valid until destroy() drops the instance.
    this._log = null
    this._query = null
    this._thinkingLevel = null

    // #6766: last SDK transcript message UUID seen this session. Captured from
    // each full `assistant` message in the query loop and used as the fork
    // boundary (`upToMessageId`) when a checkpoint created just after this
    // point is later restored — so rewind truncates the conversation to the
    // checkpoint instead of resuming the full latest transcript. Only the SDK
    // provider tracks this; subprocess providers leave `lastMessageUuid` null.
    this._lastMessageUuid = null
    // #6766: injectable handle for the SDK's standalone `forkSession` so tests
    // can stub the on-disk transcript fork without a live session (mirrors the
    // instance-level `_query` injection the rest of the suite uses).
    this._forkSessionImpl = forkSession

    // #5269 (Control Room Phase 2a): map a Task subagent's tool_use_id (the id
    // chroxy keys activity/agent nodes by) → the SDK's separate `task_id`,
    // captured from `task_started` system messages. cancelActivity() needs the
    // task_id to call query.stopTask(); the wire/activity layer only knows the
    // tool_use_id. Cleared per entry on the terminal `task_notification` and
    // wholesale at the start of each new turn (after `_callQuery`) and in
    // destroy().
    this._taskIdByToolUseId = new Map()

    // Permission handling — delegated to PermissionManager. The pause/resume
    // hooks keep the inactivity timer suspended while a permission is pending:
    // waiting on user input is NOT inactivity, and without this a session with
    // a pending prompt silently goes unresponsive after 5 min (#2831). The
    // pause uses a reference count so concurrent prompts keep the timer
    // suspended until the last one resolves. (Shared wiring extracted in P2-9.)
    // #6794 — pass cwd so the protected-path floor can resolve relative tool
    // targets (.git/.claude/.env…) against this session's working directory.
    this._permissions = new PermissionManager({ log, cwd: this.cwd })
    wirePermissionManager(this, this._permissions, {
      onRequest: () => this._pauseResultTimeoutForPermission(),
      onResolved: () => this._resumeResultTimeoutForPermission(),
    })

    // Permission pause bookkeeping for _resultTimeout (#2831)
    this._permissionPauseCount = 0
    this._resultTimeoutPaused = false
    this._resetResultTimeout = null

    // stdin_dropped accounting (#3506) — every chunk dropped at the
    // SidecarProcess pre-dial cap accumulates here so operators can
    // see the running cost of dropped input.  The default listener
    // (see _attachSidecarProcessListeners) escalates to an error log
    // on the first drop, every Nth drop, and when the cumulative byte
    // total crosses STDIN_DROPPED_BYTES_ERROR_THRESHOLD.  Subsequent
    // drops fall back to warn so a hot-loop drop flood doesn't spam.
    this._stdinDroppedBytesTotal = 0
    this._stdinDroppedCount = 0
    this._stdinDroppedThresholdLogged = false

    // #3540: SESSION-STICKY stdin_disabled flag (latched by the
    // _attachSidecarProcessListeners 'stdin_disabled' handler, see #3501).
    // Initialised here so SessionManager.serializeState can read the field
    // unconditionally and so a hydrated value from restoreState survives
    // until the next process tick.  The metadata field is the canonical
    // signal for restored sessions: clients connecting after restart see
    // the disabled state in session_list / listSessions, no replayed
    // `error` event needed (the original event already fired and was
    // proxied; cold restart treats the persisted flag as authoritative).
    this._stdinForwardingDisabled = !!stdinForwardingDisabled

    // #3575: rate-limit the refused-sendMessage warn log. A stuck client that
    // retries on every error event would otherwise flood operator logs with
    // the same line on every attempt. Tracks the last Date.now() that the
    // refusal warn fired; the warn is gated on
    // `now - _lastRefusedWarnTs >= REFUSED_SENDMESSAGE_WARN_INTERVAL_MS`.
    // The per-call `error` event still fires on every refused sendMessage so
    // client UI feedback is unaffected.
    this._lastRefusedWarnTs = 0

    // #4881: provider parity with CliSession's #4602 _intentionalStop flag.
    // Set by `interrupt()` immediately before aborting the active SDK query
    // generator, then consumed inside `_callQuery`'s try/catch/finally so a
    // user-initiated Stop:
    //   - suppresses the normal "Query error: AbortError" error emit, and
    //   - emits a single transient `stopped` event (no `code` — SdkSession is
    //     in-process, no child-process exit status to carry).
    // Cleared on every consume path (close, error, destroy) so the flag never
    // leaks past one turn — matches the single-use semantic CliSession pins
    // in `_handleChildClose` (capture-and-clear up front).
    // The flag itself is declared+initialized on BaseSession (#5375).
  }

  get sessionId() {
    return this._sessionId
  }

  /** Public accessor for the SDK session ID used to resume conversations. */
  get resumeSessionId() {
    return this._sdkSessionId
  }

  /**
   * #6766: the transcript UUID of the last full assistant message seen this
   * session, or null before the first turn completes. Checkpoint creation reads
   * this to record a fork boundary; `null` on providers that don't track it.
   * @returns {string|null}
   */
  get lastMessageUuid() {
    return this._lastMessageUuid || null
  }

  /**
   * #6766: whether this provider can fork/truncate a resumed conversation to a
   * message boundary. True for the SDK provider (the Agent SDK exposes
   * `forkSession({ upToMessageId })`); overridden false where the transcript is
   * not reachable by the host-side fork (see DockerSdkSession — the transcript
   * lives inside the container). The checkpoint restore path gates the real
   * conversation rewind on this; when false it degrades to a files-only restore.
   * @returns {boolean}
   */
  get supportsConversationFork() {
    return true
  }

  /**
   * #6766: record the fork boundary from a full SDK message. Guarded so a
   * message without a string `uuid` leaves the previous boundary intact.
   * Extracted from the query loop so it can be unit-tested directly.
   * @param {object} msg - An SDK stream message (expects a `uuid` field).
   */
  _captureBoundaryMessage(msg) {
    if (msg && typeof msg.uuid === 'string' && msg.uuid) {
      this._lastMessageUuid = msg.uuid
    }
  }

  /**
   * #6766: fork a conversation into a new, independent SDK session truncated to
   * a message boundary. Wraps the Agent SDK's standalone `forkSession`, which
   * copies the source transcript (remapping UUIDs) up to and including
   * `upToMessageId`, then returns the new session's id — resumable like any
   * other conversation id. This is what makes checkpoint "Rewind" actually
   * branch the conversation (not just the files) for the SDK provider.
   *
   * @param {object} params
   * @param {string} [params.sessionId] - Source conversation id to fork.
   *   Defaults to this session's current SDK id.
   * @param {string} [params.upToMessageId] - Fork boundary (inclusive). Omitted
   *   → full copy.
   * @returns {Promise<string|null>} The forked conversation id, or null if the
   *   SDK returned no id.
   */
  async forkConversation({ sessionId, upToMessageId } = {}) {
    const source = sessionId || this._sdkSessionId
    if (!source) throw new Error('Cannot fork conversation: no source session id')
    const opts = {}
    if (typeof upToMessageId === 'string' && upToMessageId) opts.upToMessageId = upToMessageId
    // Scope the transcript search to this session's project dir when known; the
    // SDK falls back to searching all project dirs when `dir` is omitted.
    if (this.cwd) opts.dir = this.cwd
    const result = await this._forkSessionImpl(source, opts)
    return result?.sessionId || null
  }

  /**
   * Public accessor for the cumulative stdin_dropped totals (#3544).
   *
   * Returns a snapshot of the session-lifetime counters maintained by
   * `_attachSidecarProcessListeners`. Operators can poll this from a test
   * client or session-info handler; the same numbers are published as a
   * `stdin_dropped_totals` session_event whenever a fresh drop arrives.
   *
   * @returns {{ bytes: number, count: number }}
   */
  get stdinDroppedTotals() {
    return {
      bytes: this._stdinDroppedBytesTotal,
      count: this._stdinDroppedCount,
    }
  }


  /**
   * Start the SDK session. Creates the long-lived streaming input generator
   * and begins the query loop.
   */
  start() {
    this._processReady = true
    log.info('Ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })
  }

  /**
   * Send a message to Claude via the Agent SDK.
   * Each call creates a new query() with resume to maintain conversation.
   */
  async sendMessage(prompt, attachments, sendOptions = {}) {
    // #3539: once `_stdinForwardingDisabled` latches (see #3502/#3402), any
    // further sendMessage calls would be silently dropped on the SidecarProcess
    // PassThrough — the user sees a hung turn instead of an error. Refuse the
    // write up front, surface the same machine-readable `code: 'stdin_disabled'`
    // contract that #3502 established, and drain any queued follow-ups so the
    // post-finally dequeue path (#3541) does not re-trigger writes after the
    // flag flips. Decision: one-shot reject (per-call). The session is
    // unrecoverable until restart, so queueing for "flush on resume" would only
    // hide the problem; clients must handle the error and prompt for restart.
    if (this._stdinForwardingDisabled) {
      // #3575: rate-limit the refused-sendMessage warn so a stuck client
      // retrying in a hot loop does not flood operator logs. The per-call
      // `error` event below still fires on every attempt — only the log line
      // is gated. The "Discarding queued follow-ups" warn is also gated by
      // this same window because it only ever fires alongside the refusal
      // warn (one drain per latch transition).
      const now = Date.now()
      const warnSuppressed = (now - this._lastRefusedWarnTs) < REFUSED_SENDMESSAGE_WARN_INTERVAL_MS
      if (!warnSuppressed) {
        // #4828: session-scoped when init has fired (sendMessage typically
        // arrives after init; first-message pre-init path falls back to `log`).
        ;(this._log || log).warn(
          'Refusing sendMessage — stdin forwarding is disabled for this session; ' +
          'restart the session to recover'
        )
        this._lastRefusedWarnTs = now
      }
      // Drop any messages that piled up in the queue while the flag was
      // flipping. Without this, the post-turn dequeue would call
      // sendMessage(...) once per queued item and emit one error per message —
      // noisy, and pointless because none of them can be sent. #5936: the queue
      // is now the shared `_outgoingQueue`; clear it silently (no per-item
      // message_dequeued — these are discarded, not flushed) and surface the
      // single stdin_disabled error below.
      if (this._outgoingQueue.length) {
        if (!warnSuppressed) {
          // #4828: session-scoped when init has fired.
          ;(this._log || log).warn(
            `Discarding ${this._outgoingQueue.length} queued follow-up message(s) — ` +
            'stdin forwarding is disabled'
          )
        }
        this.clearOutgoingQueue({ emit: false })
      }
      this.emit('error', {
        code: 'stdin_disabled',
        message: 'Cannot send message — stdin forwarding is disabled; restart this session',
        recoverable: false,
      })
      return
    }

    if (this._isBusy) {
      // #5936 (epic #5935): a send-while-busy follow-up goes into the shared
      // outgoing queue (BaseSession) — flushed FIFO on the next `result`. The
      // overflow cap + the `message_queued` mirror event live in
      // enqueueOutgoingMessage; nothing to do here but enqueue and return.
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      return
    }

    // Apply message transforms if configured
    let transformedPrompt = prompt
    if (this._transformPipeline.hasTransforms && typeof prompt === 'string') {
      transformedPrompt = this._transformPipeline.apply(prompt, {
        cwd: this.cwd,
        model: this.model,
        isVoiceInput: !!sendOptions.isVoice,
        platform: process.platform,
      })
    }

    this._isBusy = true
    this._messageCounter++
    // `msg-{bootPrefix}-{counter}` — see BaseSession constructor for why
    // the boot-unique prefix is needed (#3700). Format change does not
    // affect the wire schema; clients treat messageId as opaque string.
    const messageId = `msg-${this._messageIdPrefix}-${this._messageCounter}`
    this._currentMessageId = messageId
    // Shared ref so _handleResultTimeout can observe the latest value
    // when it fires (the timer was armed when hasStreamStarted was still
    // false, but the turn may have streamed before the timeout landed).
    const streamState = { hasStreamStarted: false }
    let didStreamText = false
    // #6756 — extended-thinking forwarding. Each thinking / redacted_thinking
    // content block gets a DISTINCT thinking messageId (`<turnId>-thinking-<n>`)
    // so its stream never collides with the response text stream. `thinkingBlocks`
    // maps the SDK stream event `index` → that thinking id so the thinking_delta
    // and content_block_stop events (which carry only the index) route correctly.
    const thinkingBlocks = new Map()
    let thinkingBlockCount = 0
    let didStreamThinking = false

    const sdkPermMode = this._sdkPermissionMode()
    // Skills MVP (#2957) — append shared skills via SDK systemPrompt.append.
    // Per-skill injection mode (#3200): the append bucket flows through
    // systemPrompt.append; the prepend bucket is concatenated onto the
    // first user message, once per session.
    const skillsText = this._buildSystemPrompt()
    const systemPrompt = { type: 'preset', preset: 'claude_code' }
    if (skillsText) {
      systemPrompt.append = skillsText
    }
    // Don't flip `_skillsPrepended` until _callQuery() has accepted the
    // prompt (#3225). If the call throws synchronously — bad SDK args,
    // missing claude binary in DockerSdkSession's spawnClaudeCodeProcess,
    // etc. — the prepend bucket needs to ride on the next attempt.
    let firstMessagePrefix = ''
    let willPrependSkills = false
    if (!this._skillsPrepended) {
      const prependText = typeof this._buildPrependPrompt === 'function'
        ? this._buildPrependPrompt()
        : ''
      if (prependText) {
        firstMessagePrefix = `${prependText}\n\n---\n\n`
      }
      willPrependSkills = true
    }
    const options = {
      cwd: this.cwd,
      permissionMode: sdkPermMode,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt,
      tools: { type: 'preset', preset: 'claude_code' },
    }

    // SDK requires this flag when using bypassPermissions
    if (sdkPermMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true
    }

    if (this.model) {
      options.model = this.model
    }

    // Apply thinking level if set
    if (this._thinkingLevel) {
      const budget = SdkSession.THINKING_BUDGETS[this._thinkingLevel]
      if (budget != null) options.maxThinkingTokens = budget
    }

    // #4306 — magic thinking-keyword escalation. The native Claude Code CLI's
    // interactive REPL scans the user's prompt for keywords (`think`,
    // `think hard`, `think harder`, `megathink`, `ultrathink`) and escalates
    // the thinking budget for that turn. The Agent SDK's `query()` path does
    // NOT do this — the scanner lives in the REPL only. Re-implement it here
    // so the keyword behaviour is consistent between Chroxy and the native CLI.
    //
    // Important: the keyword detection runs against the ORIGINAL prompt
    // (`prompt`), not the transformed one. Voice / typo / etc. transforms
    // (#3203, MessageTransformPipeline) may legitimately rewrite the user's
    // input, but the keyword is a user-intent signal that must come from
    // their literal typed text.
    //
    // The detected budget takes precedence over the dropdown-driven level
    // ONLY when the keyword's budget is larger — otherwise a `think` keyword
    // could *lower* a session that the user already set to `max`. Matches
    // the native CLI's "more thinking, never less" semantic.
    const detectedKeyword = typeof prompt === 'string' ? detectThinkingKeyword(prompt) : null
    if (detectedKeyword) {
      const existing = options.maxThinkingTokens ?? 0
      if (detectedKeyword.budget > existing) {
        options.maxThinkingTokens = detectedKeyword.budget
        // #4828: session-scoped when init has fired.
        ;(this._log || log).info(`Thinking keyword "${detectedKeyword.keyword}" detected — escalating maxThinkingTokens to ${detectedKeyword.budget} for this turn`)
      } else {
        ;(this._log || log).debug(`Thinking keyword "${detectedKeyword.keyword}" detected but session already at higher budget (${existing}) — leaving unchanged`)
      }
    }

    // Sandbox settings (lightweight isolation without Docker)
    if (this._sandbox) {
      options.sandbox = this._sandbox
    }

    // In-process permission handling (only when not bypassing).
    // We forward the SDK-provided `suggestions` to the permission manager
    // so the 'allow always' flow can echo them back via updatedPermissions.
    // Without this, respondToPermission('allowAlways') had nothing to
    // attach to the PermissionResult — and worse, the 2026-04-11 audit
    // (Skeptic) found the old code passed behavior:'allowAlways' which
    // isn't a valid PermissionResult.behavior (SDK only accepts
    // 'allow'|'deny'). The correct shape per the SDK's "always allow"
    // documentation is { behavior: 'allow', updatedPermissions:
    // <suggestions from callback options> }.
    if (this.permissionMode !== 'auto') {
      options.canUseTool = (toolName, input, { signal, suggestions }) =>
        this._handlePermission(toolName, input, signal, suggestions)
    }

    // Resume existing session if we have one
    if (this._sdkSessionId) {
      options.resume = this._sdkSessionId
    }

    // Safety timeouts: SOFT warning + HARD cap + STREAM-STALL recovery,
    // all armed on every SDK event. Soft fires `inactivity_warning`
    // (session stays alive); hard fires the existing kill path (force-
    // clear, auto-deny pending perms, emit error); stall (#4467) fires
    // the active-recovery path — clears busy state and emits
    // `error{code:'stream_stall'}` so the dashboard's StreamStallChip
    // can offer a retry without the user having to click Stop. All
    // three paused while a permission prompt is outstanding (#2831) —
    // awaiting user input is not inactivity / not a stall. Windows
    // configurable per server (#3749 / #3899 / #4467) — see BaseSession.
    const SOFT_TIMEOUT_MS = this._resultTimeoutMs
    const HARD_TIMEOUT_MS = this._hardTimeoutMs
    const STALL_TIMEOUT_MS = this._streamStallTimeoutMs
    const resetResultTimeout = () => {
      if (this._resultTimeout) clearTimeout(this._resultTimeout)
      if (this._hardTimeout) clearTimeout(this._hardTimeout)
      if (this._streamStallTimeout) clearTimeout(this._streamStallTimeout)
      this._resultTimeout = null
      this._hardTimeout = null
      this._streamStallTimeout = null
      if (this._resultTimeoutPaused) return
      this._resultTimeout = setTimeout(() => {
        this._resultTimeout = null
        this._handleInactivityWarning(messageId)
      }, SOFT_TIMEOUT_MS)
      this._hardTimeout = setTimeout(() => {
        this._hardTimeout = null
        this._handleHardTimeout(messageId, streamState.hasStreamStarted)
      }, HARD_TIMEOUT_MS)
      // #4467: only arm the stall timer when the operator has not
      // disabled the active-recovery path (value > 0). Soft + hard
      // still apply regardless. Mirrors CliSession._armResultTimeout.
      if (STALL_TIMEOUT_MS > 0) {
        this._streamStallTimeout = setTimeout(() => {
          this._streamStallTimeout = null
          this._handleStreamStall(messageId, streamState.hasStreamStarted)
        }, STALL_TIMEOUT_MS)
      }
    }
    this._resetResultTimeout = resetResultTimeout
    resetResultTimeout()

    try {
      // Allow subclasses to augment query options (e.g. DockerSdkSession
      // injects spawnClaudeCodeProcess here)
      this._augmentQueryOptions(options)

      // If attachments present, build multimodal content blocks
      const promptWithSkills = firstMessagePrefix
        ? `${firstMessagePrefix}${transformedPrompt}`
        : transformedPrompt
      const queryArgs = { prompt: promptWithSkills, options }
      if (attachments?.length) {
        queryArgs.prompt = buildContentBlocks(promptWithSkills, attachments)
      }
      this._query = this._callQuery(queryArgs)
      // #5269: a fresh turn — drop any task_id mappings left over from a prior
      // turn (every subagent should clear via task_notification, but a turn
      // aborted before its notifications would otherwise strand entries).
      this._taskIdByToolUseId.clear()

      // _callQuery returned an iterable without throwing — the prepend
      // bucket is committed to this turn's prompt, so flip the flag (#3225).
      // If _callQuery threw synchronously, control falls into the catch
      // below with the flag still false, ensuring the next retry
      // re-includes the prepend skills.
      if (willPrependSkills) {
        this._skillsPrepended = true
      }

      for await (const msg of this._query) {
        if (this._destroying) break
        resetResultTimeout() // Any SDK event = activity, reset inactivity timer

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init') {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
              // #4828: bind the session-scoped logger now that session_id
              // is known. Subsequent log lines route through the WsServer
              // log fan-out (#4787) to dashboards bound to this session.
              this._log = loggerForSession('sdk', msg.session_id)
              // #3687: persist the actual model the SDK booted with so
              // sendSessionInfo (replay on reconnect / tab switch) reports
              // the truth instead of `null` when the user didn't specify a
              // model.
              if (typeof msg.model === 'string' && msg.model) {
                this.bootedModel = msg.model
              }
              ;(this._log || log).info(`Session initialized: ${msg.session_id} (model: ${msg.model})`)
              this.emit('ready', {
                sessionId: msg.session_id,
                model: msg.model,
                tools: msg.tools || [],
              })
              // Emit MCP server status if present (including empty list to clear stale state)
              if (Array.isArray(msg.mcp_servers)) {
                if (msg.mcp_servers.length > 0) {
                  // #4828: session-scoped (post-init).
                  ;(this._log || log).info(`MCP servers: ${msg.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ')}`)
                }
                this.emit('mcp_servers', { servers: msg.mcp_servers })
              }
              // Fetch dynamic model list from SDK (non-blocking)
              this._fetchSupportedModels()
            } else if (msg.subtype === 'task_started') {
              // #5269: a Task subagent started. The SDK message carries BOTH
              // the subagent's `task_id` (needed by query.stopTask) and the
              // originating `tool_use_id` (the id chroxy keys agent nodes by).
              // Capture the mapping so cancelActivity() can translate an
              // activity id back to a stoppable task. No client-facing emit —
              // the agent node already exists via agent_spawned.
              this._captureTaskId(msg.tool_use_id, msg.task_id)
              break
            } else if (msg.subtype === 'task_notification') {
              // #5269: a Task subagent reached a terminal state (completed /
              // failed / stopped — the last one is what query.stopTask emits).
              // Finalize the agent node promptly and drop the task mapping so a
              // cancel feels responsive instead of waiting for the turn-end
              // sweep. Idempotent (no-op if already finalized).
              this._finalizeAgentByToolUseId(msg.tool_use_id)
              break
            } else {
              // Forward non-init system events (e.g. /usage, /cost, other
              // slash command responses) as system messages to the client
              const text = msg.message || msg.text || msg.subtype || 'System event'
              // #4828: session-scoped (non-init system event arrives after init).
              ;(this._log || log).info(`System event (${msg.subtype || 'unknown'}): ${typeof text === 'string' ? text.slice(0, 120) : text}`)
              this.emit('message', {
                type: 'system',
                content: text,
                timestamp: Date.now(),
              })
            }
            break
          }

          case 'stream_event': {
            // Handle partial message events (content_block_start/delta/stop)
            const event = msg.event
            if (!event) break

            switch (event.type) {
              case 'content_block_start': {
                const blockType = event.content_block?.type
                if (blockType === 'text') {
                  if (!streamState.hasStreamStarted) {
                    streamState.hasStreamStarted = true
                    this.emit('stream_start', { messageId })
                  }
                } else if (blockType === 'tool_use') {
                  // Delegate to the shared parser so CliSession + SdkSession
                  // emit identical tool_start payloads (see
                  // claude-stream-parser.js for the toolId-derivation rules).
                  const toolStartData = buildToolStartData(messageId, event.content_block)
                  this.emit('tool_start', toolStartData)
                  // #4628: defense-in-depth — track so _emitResult sweep
                  // catches any orphan if the API ever drops a tool_result.
                  this._trackToolStart(toolStartData.toolUseId, event.content_block.name)
                } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
                  // #6756 — extended-thinking block opened. Open a thinking
                  // stream on a distinct id so reasoning content streams into a
                  // `type: 'thinking'` bubble (not the response slot).
                  // Copilot review on #6817: if a reordered thinking_delta for
                  // this block index already lazily opened the stream, REUSE its
                  // id and don't re-emit stream_start — one block must never
                  // produce two streams.
                  let thinkingId = thinkingBlocks.get(event.index)
                  if (!thinkingId) {
                    thinkingId = `${messageId}-thinking-${thinkingBlockCount++}`
                    thinkingBlocks.set(event.index, thinkingId)
                    this.emit('stream_start', { messageId: thinkingId, thinking: true })
                  }
                  didStreamThinking = true
                  if (blockType === 'redacted_thinking') {
                    // Redacted thinking carries encrypted `data`, never readable
                    // text — forward a marker so the block is never silently
                    // dropped (its content_block_stop still closes the stream).
                    this.emit('stream_delta', {
                      messageId: thinkingId,
                      delta: '[redacted thinking]',
                      thinking: true,
                    })
                  }
                }
                break
              }

              case 'content_block_delta': {
                const delta = event.delta
                if (!delta) break
                if (delta.type === 'text_delta') {
                  if (!streamState.hasStreamStarted) {
                    streamState.hasStreamStarted = true
                    this.emit('stream_start', { messageId })
                  }
                  didStreamText = true
                  // #5515 (epic #5514): stamp the monotonic emit time so
                  // ws-forwarding can measure emit→broadcast (the server-side
                  // coalescing cost). Monotonic (hrtime) — not wall-clock —
                  // because both ends are this same process; it's a true
                  // elapsed duration, unlike the cross-machine serverTs field.
                  this.emit('stream_delta', { messageId, delta: delta.text, _emitMonoMs: Number(process.hrtime.bigint() / 1_000_000n) })
                } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                  // #6756 — reasoning delta. Route to the thinking id opened on
                  // this block's content_block_start; lazy-open if the start was
                  // reordered/dropped so a delta is never lost. `signature_delta`
                  // (the block's signature, not content) falls through untouched.
                  let thinkingId = thinkingBlocks.get(event.index)
                  if (!thinkingId) {
                    thinkingId = `${messageId}-thinking-${thinkingBlockCount++}`
                    thinkingBlocks.set(event.index, thinkingId)
                    this.emit('stream_start', { messageId: thinkingId, thinking: true })
                  }
                  didStreamThinking = true
                  this.emit('stream_delta', { messageId: thinkingId, delta: delta.thinking, thinking: true })
                }
                break
              }

              case 'content_block_stop': {
                // #6756 — close the thinking stream for this block so the client
                // finalises its "Thinking… → Thought" label. Only thinking
                // blocks are tracked here; text/tool_use blocks are a no-op.
                const thinkingId = thinkingBlocks.get(event.index)
                if (thinkingId) {
                  thinkingBlocks.delete(event.index)
                  this.emit('stream_end', { messageId: thinkingId, thinking: true })
                }
                break
              }
            }
            break
          }

          case 'assistant': {
            // #6766: remember this message's transcript UUID as the fork
            // boundary. A checkpoint auto-created at the start of the NEXT turn
            // captures this as its boundary, so restoring that checkpoint can
            // fork the conversation truncated to exactly this point.
            this._captureBoundaryMessage(msg)
            // Full assistant message — process content blocks for tool detection
            const content = msg.message?.content
            if (!Array.isArray(content)) break

            for (const block of content) {
              if (block.type === 'text' && block.text && !didStreamText && !streamState.hasStreamStarted) {
                // Fallback for non-streamed text
                this.emit('message', {
                  type: 'response',
                  content: block.text,
                  timestamp: Date.now(),
                })
              }

              // #6756 — fallback for thinking delivered only on the full
              // assistant message (partial-message streaming off, or a block the
              // stream_event path never surfaced). Only fires when NOTHING was
              // streamed this turn, so the streaming path is never double-emitted.
              if ((block.type === 'thinking' || block.type === 'redacted_thinking') && !didStreamThinking) {
                const thinkingId = `${messageId}-thinking-${thinkingBlockCount++}`
                const text = block.type === 'redacted_thinking'
                  ? '[redacted thinking]'
                  : (typeof block.thinking === 'string' ? block.thinking : '')
                this.emit('stream_start', { messageId: thinkingId, thinking: true })
                if (text) this.emit('stream_delta', { messageId: thinkingId, delta: text, thinking: true })
                this.emit('stream_end', { messageId: thinkingId, thinking: true })
              }

              if (block.type === 'tool_use') {
                this._handleToolUseBlock(messageId, block)
              }
            }
            break
          }

          case 'user': {
            // Tool result content blocks appear in user-role messages during the tool loop
            emitToolResults(msg.message?.content, this)
            // #4307: scan tool_result blocks for the canonical
            // "Command running in background with ID: <id>" pattern so
            // we can record the shell as pending background work. Done
            // alongside emitToolResults rather than inside it so the
            // tracker stays out of the existing image-extraction /
            // truncation surface (tool-result.js is also used by
            // CliSession + GeminiSession, which don't share this
            // BaseSession path).
            this._recordBackgroundShellsFromToolResults(msg.message?.content)
            break
          }

          case 'result': {
            if (streamState.hasStreamStarted) {
              this.emit('stream_end', { messageId })
            }

            if (msg.session_id) {
              this._sdkSessionId = msg.session_id
              this._sessionId = msg.session_id
            }

            // Correct any static context-window guess using the SDK's
            // authoritative per-model values. Only cache + broadcast when
            // a value actually changed to avoid thrashy writes / UI churn.
            let contextWindowChanged = false
            if (msg.modelUsage && typeof msg.modelUsage === 'object') {
              const missingIds = []
              for (const [modelId, usage] of Object.entries(msg.modelUsage)) {
                if (usage && typeof usage.contextWindow === 'number') {
                  if (updateContextWindow(modelId, usage.contextWindow)) {
                    contextWindowChanged = true
                  }
                } else {
                  missingIds.push(modelId)
                }
              }
              // Drift signal: at least one modelUsage entry was missing a
              // numeric contextWindow. Catches both total drift (field renamed
              // or removed upstream) and partial drift (schema updated for one
              // model family before another). Log a redacted sample so a
              // future regression is diagnosable without flooding info-level
              // output.
              if (missingIds.length > 0) {
                const sampleId = missingIds[0]
                const sampleKeys = Object.keys(msg.modelUsage[sampleId] || {})
                // #4828: session-scoped (result handler runs strictly post-init).
                ;(this._log || log).debug(
                  `modelUsage partial drift: contextWindow missing for modelIds=${JSON.stringify(missingIds)} sampleKeys=${JSON.stringify(sampleKeys)}`
                )
              }
            }
            if (contextWindowChanged) {
              saveModelsCache()
              // Notify connected clients so the picker / budget UI picks up
              // the corrected window without waiting for the next refresh.
              this.emit('models_updated', { models: getModels() })
            }

            // #4628: sweep any orphan tool_starts before emitting result
            // so the dashboard's activeTools clears as part of the same
            // turn-end burst. _clearMessageState (called next) would also
            // clear the in-flight map but without broadcasting synthetic
            // tool_results to the dashboard.
            this._emitResult({
              sessionId: msg.session_id || this._sdkSessionId,
              cost: msg.total_cost_usd,
              duration: msg.duration_ms,
              usage: msg.usage,
              // #6692: surface the per-model split + turn metadata the SDK
              // already reports instead of discarding them. Additive — every
              // existing result consumer ignores unknown fields.
              numTurns: Number.isFinite(msg.num_turns) ? msg.num_turns : null,
              apiDurationMs: Number.isFinite(msg.duration_api_ms) ? msg.duration_api_ms : null,
              modelUsage: normalizeSdkModelUsage(msg.modelUsage),
            }, 'turn_ended_with_orphan_tool_start')

            this._clearMessageState()
            break
          }
        }
      }
    } catch (err) {
      if (streamState.hasStreamStarted) {
        this.emit('stream_end', { messageId })
      }
      // #4881: capture-and-clear before any branch so the flag never leaks
      // past this turn even when _destroying short-circuits the emits below.
      // Mirrors CliSession._handleChildClose (#4602).
      const wasIntentionalStop = this._consumeIntentionalStop()
      if (!this._destroying) {
        if (wasIntentionalStop) {
          // #4881: user clicked Stop — interrupt() set the flag, the SDK
          // generator threw an AbortError as a result. Skip the loud "Query
          // error" surface and emit the quiet `stopped` event for parity
          // with CliSession. No `code` because SDK runs in-process — there
          // is no child-process exit status to carry.
          ;(this._log || log).info('Query aborted after user stop')
          this.emit('stopped', {})
        } else {
          // #4828: session-scoped when init has fired; falls back to module
          // `log` for pre-init query failures (e.g. spawn refused).
          ;(this._log || log).error(`Query error: ${err.message}`)
          this.emit('error', { message: SdkSession._enrichErrorMessage(err.message) })
        }
      }
      this._clearMessageState()
    } finally {
      this._query = null
      // #4881: safety-net clear of _intentionalStop. The catch block clears
      // it on the throw path (AbortError after interrupt()), but if
      // query.interrupt() races a `result` message arriving first, the
      // for-await loop exits normally, skipping the catch. Without this
      // clear, the flag would stay armed until the next turn's catch and
      // mis-trigger a spurious `stopped` emit there. Idempotent — the
      // catch path already cleared it on the throw path.
      this._clearIntentionalStop()
      // Dequeue any follow-up messages that arrived while busy (#5936: the
      // shared `_outgoingQueue`; flush one item via dequeueNextOutgoing, whose
      // re-dispatched sendMessage re-sets _isBusy so the next `result` drains
      // the following item — FIFO, one turn at a time).
      if (this._outgoingQueue.length && !this._destroying) {
        // #3562: if the SidecarProcess latched stdin_disabled mid-turn (e.g.
        // the PassThrough closed while _callQuery was still streaming), the
        // entry-gate at the top of sendMessage has already been bypassed
        // for this turn. Without this short-circuit, we would shift one
        // follow-up, schedule a process.nextTick recursion, and only then
        // hit the entry gate — wasting a hop and emitting a per-message
        // error. Drain the queue at the dequeue site for symmetry with
        // the entry-gate drain (#3539/PR #3560), log a single warn, and
        // skip the recursion entirely.
        if (this._stdinForwardingDisabled) {
          // #4828: session-scoped (finally block runs strictly post-init).
          ;(this._log || log).warn(
            `Discarding ${this._outgoingQueue.length} queued follow-up message(s) after turn finish — ` +
            'stdin forwarding is disabled'
          )
          // Silent clear — these are discarded (stdin gone), not flushed, so no
          // message_dequeued (which signals "sent") should fire for them.
          this.clearOutgoingQueue({ emit: false })
          return
        }
        this.dequeueNextOutgoing()
      }
    }
  }

  /**
   * Invoke the SDK query function. Extracted for testability.
   * @param {object} queryArgs - { prompt, options }
   * @returns {AsyncIterable} SDK message stream
   */
  _callQuery(queryArgs) {
    return query(queryArgs)
  }

  /**
   * Hook for subclasses to modify query options before they're passed to query().
   * Default implementation is a no-op. Override in subclasses that need to inject
   * additional options (e.g. spawnClaudeCodeProcess for container isolation).
   * @param {object} options - The query options object (mutated in place)
   */
  _augmentQueryOptions(_options) {
    // No-op — override in subclasses
  }

  /**
   * Attach default log listeners for SidecarProcess stdin failure
   * signals (#3402, #3474, #3506).
   *
   * SidecarProcess (used by container/k8s spawnClaudeCodeProcess paths)
   * emits two stdin failure events the SDK itself does not surface:
   *
   *   - `stdin_disabled`  — fired when forwarding becomes unrecoverable
   *     (post-reconnect or live WS close mid-write). One-shot.
   *     Logged at warn level.
   *   - `stdin_dropped`   — fired for every chunk that exceeds the 1 MiB
   *     pre-dial cap. Payload: `{ bytes, reason: 'pre-dial-cap' }`.
   *     #3506: every drop logs with a cumulative running total
   *     (`_stdinDroppedBytesTotal` + `_stdinDroppedCount`); the level
   *     escalates to error on the first drop, every Nth drop
   *     (`STDIN_DROPPED_ESCALATION_EVERY_N`), and when the cumulative
   *     byte total crosses `STDIN_DROPPED_BYTES_ERROR_THRESHOLD`. All
   *     other drops log at warn.
   *
   * Both signal silent data loss from the consumer's perspective: the
   * underlying PassThrough still accepts writes, so without an explicit
   * listener the user sees a hung turn instead of an error.  This helper
   * provides the "log at minimum" guarantee — subclasses or future
   * K8s-aware paths may override to escalate further (e.g. emit a
   * session error event, abort the turn).
   *
   * Idempotent on two axes:
   *   1. Safe on non-SidecarProcess procs — Node ChildProcess (Docker path)
   *      never emits these events, so the listeners simply never fire.
   *   2. Safe on repeat calls — the proc is stamped with a Symbol marker
   *      after the first wiring; subsequent calls short-circuit so a
   *      resume/reconnect caller cannot accumulate duplicate listeners
   *      (and therefore duplicate logs) on the same proc.
   *
   * @param {EventEmitter|null|undefined} proc — the spawned process from
   *   `spawnClaudeCodeProcess`.  May be a Node ChildProcess (Docker path)
   *   or a SidecarProcess (K8s path); only the latter emits these events.
   */
  _attachSidecarProcessListeners(proc) {
    if (!proc || typeof proc.on !== 'function') return
    // Re-wiring guard (#3504 review): stamp the proc on first attach so
    // duplicate calls don't pile up listeners.  Symbol-keyed so it can't
    // collide with consumer code or arbitrary EventEmitters used as stubs.
    if (proc[SIDECAR_LISTENERS_ATTACHED]) return
    proc[SIDECAR_LISTENERS_ATTACHED] = true

    proc.on('stdin_dropped', (info) => {
      // #3506: track a cumulative byte counter and escalate to error
      // level on the first drop, every Nth drop, and when the running
      // total crosses STDIN_DROPPED_BYTES_ERROR_THRESHOLD.  Other drops
      // log at warn so the signal stays loud without flooding logs.
      const rawBytes = info?.bytes
      const knownBytes = typeof rawBytes === 'number' && Number.isFinite(rawBytes)
      const bytesLabel = knownBytes ? `${rawBytes} bytes` : 'unknown bytes'
      const reason = info?.reason ?? 'unknown'

      this._stdinDroppedCount += 1
      if (knownBytes && rawBytes > 0) {
        this._stdinDroppedBytesTotal += rawBytes
      }

      const cumulative = this._stdinDroppedBytesTotal
      const dropCount = this._stdinDroppedCount

      const isFirstDrop = dropCount === 1
      const crossedByteThreshold =
        !this._stdinDroppedThresholdLogged &&
        cumulative >= STDIN_DROPPED_BYTES_ERROR_THRESHOLD
      const hitCountCadence =
        dropCount > 1 && dropCount % STDIN_DROPPED_ESCALATION_EVERY_N === 0

      const escalate = isFirstDrop || crossedByteThreshold || hitCountCadence
      if (crossedByteThreshold) {
        this._stdinDroppedThresholdLogged = true
      }

      // #3543: keep the raw byte count for scriptable log consumers and
      // append a humanised KiB/MiB/GiB suffix so threshold-cross lines are
      // easier to scan at a glance.  Format: `cumulative=N bytes (X.X MiB)`.
      const cumulativeHuman = formatBytes(cumulative)
      const message =
        `Sidecar stdin chunk dropped (${bytesLabel}, reason=${reason}, ` +
        `cumulative=${cumulative} bytes (${cumulativeHuman}) over ${dropCount} drops) — ` +
        'turn input was truncated; consumer may need to retry'

      // #4828: session-scoped when init has fired; falls back to module
      // `log` for stdin drops that occur pre-init (rare — SidecarProcess
      // listener attach happens after spawn, before init normally arrives).
      if (escalate) {
        ;(this._log || log).error(message)
      } else {
        ;(this._log || log).warn(message)
      }

      // #3544: surface the cumulative totals as a session-level event so
      // SessionManager can proxy it onto the unified `session_event`
      // envelope. Dashboards and the mobile app see "X bytes lost over N
      // drops" instead of a hung turn. Emitted on every drop (not only
      // escalations) so the dashboard counter stays live; the `escalated`
      // flag lets the UI distinguish a "first drop / threshold-cross /
      // every-Nth" loud signal from routine warn-level updates.
      this.emit('stdin_dropped_totals', {
        bytes: cumulative,
        count: dropCount,
        reason,
        escalated: escalate,
      })
    })

    proc.on('stdin_disabled', () => {
      // #3468 + #3501: SESSION-STICKY semantics.  Once any spawn under this
      // session emits 'stdin_disabled' we latch `_stdinForwardingDisabled`
      // and log a single warn for the lifetime of the session.  Subsequent
      // spawns (next turn, post-reconnect retry) that fire their own
      // 'stdin_disabled' are intentionally silenced.
      //
      // Trade-off (decided in #3501): per-spawn warns would surface every
      // reconnect-induced loss but spam the operator log on a session that
      // is already known to be in the disabled state — the actionable signal
      // (reconnect/restart) was already delivered.  The session-sticky path
      // keeps the warn high-signal: one warn = "this session lost stdin
      // forwarding"; the latched flag is the persistent diagnostic for
      // anything more granular (e.g. metrics, dashboards).  If a future
      // K8s-aware subclass wants per-spawn visibility it can override this
      // method or read `_stdinForwardingDisabled` directly.
      if (this._stdinForwardingDisabled) return
      this._stdinForwardingDisabled = true
      // #3536 review: SidecarProcess explicitly does NOT re-wire stdin on
      // WS reconnect (see k8s.js `stdin_disabled signal` block) — once this
      // signal fires forwarding is permanently lost for the lifetime of the
      // session.  Recommend a session restart only; mentioning reconnect
      // contradicts `recoverable: false` and misleads users into a path
      // that cannot work.
      const message = 'Sidecar stdin forwarding is disabled — further writes will be ' +
        'silently dropped; restart this session to recover'
      // #4828: session-scoped when known; falls back to module `log` for
      // the rare pre-init case (same rationale as the stdin_dropped path).
      ;(this._log || log).warn(message)
      // #3502: surface the disabled flag to paired clients via the session
      // `error` channel.  SessionManager._wireSessionEvents proxies `error`
      // into the unified `session_event` envelope, so dashboards and the
      // mobile app receive a structured frame and can render a "stdin lost
      // — restart this session" banner instead of seeing a hung turn.
      // Single emit per session: gated by the same _stdinForwardingDisabled
      // short-circuit above so a flapping sidecar can't spam errors.
      this.emit('error', {
        code: 'stdin_disabled',
        message,
        recoverable: false,
      })
    })
  }

  /**
   * Handle tool_use blocks from assistant messages.
   * Detects Task tool for agent monitoring.
   *
   * Note: AskUserQuestion is NOT handled here — it flows through the
   * canUseTool callback in _handleAskUserQuestion(), which emits
   * user_question and waits for respondToQuestion().
   */
  _handleToolUseBlock(messageId, block) {
    // Guard against oversized tool inputs
    const inputStr = JSON.stringify(block.input || {})
    if (Buffer.byteLength(inputStr, 'utf8') > this._maxToolInput) {
      // #4828: session-scoped (tool_use only arrives after init).
      ;(this._log || log).warn(`Tool input for ${block.name} exceeded ${this._maxToolInput} bytes, skipping`)
      this.emit('error', {
        message: `Tool input too large (>${Math.round(this._maxToolInput / 1024)}KB) for ${block.name} — tool use was skipped`,
      })
      return
    }

    // #4307: stash the command text against the tool_use_id so the
    // matching tool_result (carrying the shellId Claude prints) can
    // recover it. Strict-boolean run_in_background check; non-Bash
    // tools and missing inputs are no-ops. The map is the ephemeral
    // turn-local one — entries that never see a tool_result clear at
    // turn-end.
    if (isRunInBackgroundInput(block.name, block.input)) {
      const cmd = typeof block.input?.command === 'string' ? block.input.command : ''
      this._pendingBackgroundCommands.set(block.id, cmd)
    }
    // #4307: when the agent calls BashOutput on a previously-tracked
    // shell, drop the pending entry. Whether output was complete or
    // not, the agent has acknowledged the shell — our local model of
    // "session is waiting on background work" is stale either way.
    const bashOutputId = parseBashOutputShellId(block.name, block.input)
    if (bashOutputId) {
      this.clearBackgroundShell(bashOutputId)
    }

    // Delegate Task / EnterPlanMode / ExitPlanMode interpretation to the
    // shared parser so SdkSession and CliSession cannot drift on tool
    // semantics. AskUserQuestion is intentionally skipped here — it flows
    // through the canUseTool callback in _handleAskUserQuestion() and
    // never reaches this code path.
    const semantics = extractToolInputSemantics(block.name, block.input)
    if (!semantics) return
    if (semantics.kind === 'task') {
      // #4778: when block.id is missing, mirror the synthesized fallback
      // used by buildToolStartData (`${messageId}-tool`) so the
      // agent_spawned toolUseId + _activeAgents key match the wire-emitted
      // tool_start id. Without this, _activeAgents.set(undefined, ...)
      // collides on undefined for any fallback-path Task spawn.
      const toolUseId = block.id || `${messageId}-tool`
      const agentInfo = {
        toolUseId,
        description: semantics.payload.description,
        startedAt: Date.now(),
      }
      this._activeAgents.set(toolUseId, agentInfo)
      this.emit('agent_spawned', agentInfo)
    }
    // EnterPlanMode / ExitPlanMode are not currently surfaced by SdkSession
    // (plan-mode flow is CliSession-only today). Extracting via the shared
    // parser leaves the door open without changing observable behavior.
  }

  /**
   * #4307: scan a user-role message's tool_result content blocks for
   * the canonical `Command running in background with ID: <id>` text
   * and register each pending background shell against the matching
   * command stashed earlier by `_handleToolUseBlock`.
   *
   * Defensive against non-array content (the SDK sometimes ships a
   * single string for content) and content blocks without `tool_use_id`
   * (no-op) — the standard tool-loop flow always populates both.
   *
   * @param {unknown} content
   * @private
   */
  _recordBackgroundShellsFromToolResults(content) {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue
      // Flatten the result text the same way `emitToolResults` does so
      // a shellId in a multi-block content array still matches.
      let text = ''
      if (typeof block.content === 'string') {
        text = block.content
      } else if (Array.isArray(block.content)) {
        text = block.content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
      }
      const shellId = parseBackgroundShellId(text)
      if (!shellId) continue
      const command = this._pendingBackgroundCommands.get(block.tool_use_id) || ''
      this._pendingBackgroundCommands.delete(block.tool_use_id)
      // #5177: capture the output file path from the same tool_result so the
      // completion sweep can reap the shell on quiescence without a poll.
      const outputPath = parseBackgroundShellOutputPath(text)
      this.trackBackgroundShell({ shellId, command, outputPath })
    }
  }

  /**
   * In-process permission handler for canUseTool callback.
   * Delegates to the PermissionManager.
   */
  _handlePermission(toolName, input, signal, suggestions) {
    return this._permissions.handlePermission(toolName, input, signal, this.permissionMode, suggestions)
  }

  /**
   * Resolve a pending permission request (called by WsServer when
   * the app sends permission_response).
   */
  respondToPermission(requestId, decision, editedInput) {
    return this._permissions.respondToPermission(requestId, decision, editedInput)
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   * In SDK mode, the canUseTool callback is holding a Promise open.
   * This method resolves it with the user's answer as structured updatedInput.
   */
  respondToQuestion(text, answersMap) {
    this._permissions.respondToQuestion(text, answersMap)
  }

  /**
   * Change the model. In SDK mode this doesn't require process restart.
   * #5374: BaseSession.setModel owns the guard + resolve and fires this hook.
   */
  _onModelChanged() {
    // #4828: session-scoped when init has fired.
    ;(this._log || log).info(`Model changed to ${this.model || 'default'}`)
  }

  _onPermissionModeChanged(mode) {
    this._permissions.clearRules()
    // #3729: switching TO auto is a "panic button" — drain any pending
    // permission prompts so the user isn't left staring at modals after
    // declaring "approve everything". Without this, prompts that were
    // emitted under the previous mode hang until the user resolves them
    // or they hit the 5-min timeout, contradicting the bypass semantics.
    if (mode === 'auto') {
      this._permissions.autoAllowPending()
    }
    // #4828: session-scoped when init has fired.
    ;(this._log || log).info(`Permission mode changed to ${mode}`)
  }

  /**
   * Set per-session permission rules. Delegates to PermissionManager.
   * @param {Array<{tool: string, decision: string}>} rules
   */
  setPermissionRules(rules) {
    if (typeof this._permissions.setRules === 'function') {
      this._permissions.setRules(rules)
    }
  }

  /**
   * Get current per-session permission rules. Delegates to PermissionManager.
   * @returns {Array<{tool: string, decision: string}>}
   */
  getPermissionRules() {
    if (typeof this._permissions.getRules === 'function') {
      return this._permissions.getRules()
    }
    return []
  }

  /**
   * Clear all per-session permission rules. Delegates to PermissionManager.
   */
  clearPermissionRules() {
    if (typeof this._permissions.clearRules === 'function') {
      this._permissions.clearRules()
    }
  }

  /**
   * Set thinking level by adjusting max thinking tokens.
   * @param {string} level - 'default' | 'high' | 'max'
   */
  async setThinkingLevel(level) {
    const budget = SdkSession.THINKING_BUDGETS[level] ?? null
    this._thinkingLevel = level === 'default' ? null : level

    if (this._query && typeof this._query.setMaxThinkingTokens === 'function') {
      try {
        await this._query.setMaxThinkingTokens(budget)
        // #4828: session-scoped (setThinkingLevel only takes effect with
        // an active query — strictly post-init).
        ;(this._log || log).info(`Thinking level set to ${level} (${budget ?? 'adaptive'} tokens)`)
      } catch (err) {
        ;(this._log || log).warn(`Failed to set thinking level: ${err.message}`)
      }
    }

    // Note: thinking_level_changed is broadcast by the WS handler, not emitted here
  }

  /**
   * Map internal permission mode to SDK PermissionMode.
   */
  _sdkPermissionMode() {
    switch (this.permissionMode) {
      case 'auto': return 'bypassPermissions'
      case 'plan': return 'plan'
      default: return 'default'
    }
  }

  /**
   * Query the SDK for available models and emit models_updated.
   * Called after session init — non-blocking, failures are logged and ignored.
   */
  async _fetchSupportedModels() {
    if (!this._query || typeof this._query.supportedModels !== 'function') return

    try {
      const sdkModels = await this._query.supportedModels()
      const converted = updateModels(sdkModels)
      if (converted && converted.length > 0) {
        // #4828: session-scoped (called from init handler so _log is set).
        ;(this._log || log).info(`Dynamic model list: ${converted.map(m => m.id).join(', ')}`)
        saveModelsCache()
        this.emit('models_updated', { models: converted })
      }
    } catch (err) {
      ;(this._log || log).warn(`Failed to fetch supported models: ${err.message}`)
    }
  }

  /**
   * #5269: record a Task subagent's `task_id ↔ tool_use_id` mapping. Tolerant
   * of either id arriving missing (the SDK marks `tool_use_id` optional on
   * task messages) and of `task_started` racing ahead of `agent_spawned` — the
   * map is keyed by tool_use_id and read lazily at cancel time, so order does
   * not matter.
   * @param {unknown} toolUseId
   * @param {unknown} taskId
   * @private
   */
  _captureTaskId(toolUseId, taskId) {
    if (typeof toolUseId !== 'string' || !toolUseId) return
    if (typeof taskId !== 'string' || !taskId) return
    this._taskIdByToolUseId.set(toolUseId, taskId)
  }

  /**
   * #5269: finalize a Task subagent identified by its `tool_use_id` — drop the
   * task-id mapping and, if the agent is still tracked, balance the
   * `agent_spawned` with a matching `agent_completed` + `_activeAgents` delete
   * so the activity node terminates immediately (the turn-end sweep would
   * otherwise be the only finalizer on the SDK path). Idempotent.
   * @param {unknown} toolUseId
   * @private
   */
  _finalizeAgentByToolUseId(toolUseId) {
    if (typeof toolUseId !== 'string' || !toolUseId) return
    this._taskIdByToolUseId.delete(toolUseId)
    if (this._activeAgents.has(toolUseId)) {
      this._activeAgents.delete(toolUseId)
      this.emit('agent_completed', { toolUseId })
    }
  }

  /**
   * #5269 (Control Room Phase 2a): cancel a single in-flight subagent by its
   * activity id (which, for an `agent` node, IS the Task's `tool_use_id`).
   * Translates the id to the SDK `task_id` and calls `query.stopTask()`. The
   * SDK responds with a `task_notification` (status `stopped`), which
   * `_finalizeAgentByToolUseId` turns into the terminal activity delta; we also
   * finalize optimistically on success so the node clears without waiting.
   *
   * Only `agent` nodes are cancellable — shells/tools are not individually
   * stoppable (chroxy doesn't own them). Returns a structured result rather
   * than throwing so the WS handler can map it to a reply.
   *
   * @param {string} activityId
   * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>}
   */
  async cancelActivity(activityId) {
    if (typeof activityId !== 'string' || !activityId) return { ok: false, reason: 'invalid-id' }
    const entry = this._activity.getEntry(activityId)
    if (!entry) return { ok: false, reason: 'not-found' }
    if (entry.kind !== 'agent') {
      // Shells and tool calls have no per-node cancel surface. Distinguish the
      // shell case so the UI can explain "use Interrupt turn" rather than
      // implying a transient error.
      return { ok: false, reason: entry.kind === 'shell' ? 'shell-not-cancellable' : 'not-cancellable' }
    }
    // A finished agent isn't retained in the registry (terminal nodes are
    // dropped on _end), so a stale cancel for one resolves as not-found above —
    // no separate already-finished branch is reachable here.
    const taskId = this._taskIdByToolUseId.get(activityId)
    if (!taskId) {
      // agent_spawned landed but task_started hasn't (or this SDK build doesn't
      // emit task lifecycle messages) — we have no id to stop.
      return { ok: false, reason: 'no-task-id' }
    }
    // Feature-detect stopTask (mirrors the supportedModels / setMaxThinkingTokens
    // guards) — older SDK builds may not expose it even though interrupt() works.
    if (!this._query || typeof this._query.stopTask !== 'function') {
      return { ok: false, reason: 'not-supported' }
    }
    ;(this._log || log).info(`Cancelling subagent ${activityId} (task ${taskId})`)
    try {
      await this._query.stopTask(taskId)
    } catch (err) {
      ;(this._log || log).warn(`stopTask failed for ${activityId}: ${err.message}`)
      return { ok: false, reason: 'stop-failed', error: err.message }
    }
    // Optimistic finalize — idempotent with the incoming task_notification.
    this._finalizeAgentByToolUseId(activityId)
    return { ok: true }
  }

  /**
   * Interrupt the current query.
   */
  async interrupt() {
    // #5936: a deliberate Stop cancels the owner's queued follow-ups (cancel,
    // not flush) — clear BEFORE the abort so the turn-end `result` flush in the
    // `finally` sees an empty queue and nothing auto-fires after the halt.
    // Runs even when there is no active `_query` (queued sends with the turn
    // already settling) so an interrupt never strands a queued message.
    this.clearOutgoingQueue()

    if (!this._query) return

    // #4881: mark the imminent query teardown as user-initiated so the
    // _callQuery catch block suppresses the AbortError-flavored "Query error"
    // emit and instead surfaces a quiet `stopped` event. Cleared in the
    // catch/finally (single-use, mirrors CliSession#4602).
    this.markIntentionalStop()

    // #4828: session-scoped (interrupt() only meaningful with an active query).
    ;(this._log || log).info('Interrupting query')
    try {
      await this._query.interrupt()
    } catch (err) {
      ;(this._log || log).warn(`Interrupt error: ${err.message}`)
    }
  }

  /**
   * Handle the SOFT inactivity warning (#3899) — `_resultTimeoutMs` of
   * silence with no SDK event to reset it (default 30 min). Unlike
   * `_handleHardTimeout`, this does NOT clear busy state, does NOT
   * auto-deny pending permissions, and does NOT emit `error`. It just
   * emits a transient `inactivity_warning` event so the client can
   * render a check-in chip ("Status update?") and (if push is wired)
   * deliver an Expo notification.
   *
   * The hard-cap timer continues running in parallel — if the user
   * never engages, the kill path eventually fires anyway. The soft
   * timer is NOT re-armed here; each silent stretch fires exactly
   * one warning (any subsequent activity resets both timers, so the
   * next stretch fires a fresh warning).
   */
  _handleInactivityWarning(messageId) {
    if (!this._isBusy) return
    const idleMs = this._resultTimeoutMs
    const friendly = formatIdleDuration(idleMs)
    // #4828: session-scoped (inactivity warning fires from active turn).
    ;(this._log || log).info(`Inactivity warning (${friendly}) — session alive, prompting check-in`)
    this.emit('inactivity_warning', {
      messageId,
      idleMs,
      prefab: 'Status update?',
    })
  }

  /**
   * Handle the HARD-cap timeout (#3899; pre-#3899 this was the only
   * handler, named `_handleResultTimeout` — kept as the absolute
   * backstop for genuinely stuck sessions when the user never check-
   * ins on the soft warning). Emits stream_end (if streaming), auto-
   * denies any pending permissions, emits `permission_expired` for
   * each so the client UI clears stale prompts, then clears state and
   * emits an error. Issue #2831 added the permission cleanup so late
   * user approvals don't resolve into an abandoned SDK turn.
   */
  _handleHardTimeout(messageId, hasStreamStarted) {
    if (!this._isBusy) return
    const friendly = formatIdleDuration(this._hardTimeoutMs)
    // #4828: session-scoped (hard-cap fires from active turn).
    ;(this._log || log).warn(`Hard-cap timeout (${friendly} inactivity) — force-clearing busy state`)
    if (hasStreamStarted) {
      this.emit('stream_end', { messageId })
    }
    // Fire permission_expired for every outstanding permission BEFORE
    // clearing state — the underlying Map is cleared by _clearMessageState
    // → PermissionManager.clearAll() below.
    if (this._pendingPermissions && this._pendingPermissions.size > 0) {
      for (const [requestId] of this._pendingPermissions) {
        this.emit('permission_expired', { requestId, message: 'Permission request expired (session timeout)' })
      }
    }
    // Attempt to abort the SDK query generator so no further events land
    // into a cleared message. Best-effort — the SDK's generator may not
    // support .return()/.throw() uniformly.
    this._abortActiveQuery()
    this._clearMessageState()
    this.emit('error', { message: `Response timed out after ${friendly} of inactivity` })
  }

  /**
   * Handle the STREAM-STALL recovery timer (#4467). Fires when the SDK
   * has been silent for `_streamStallTimeoutMs` despite the session
   * being busy — typically a half-open HTTPS to the Anthropic API that
   * the OS hasn't surfaced as an error yet. Distinct from the SOFT
   * inactivity warning (which is passive — just a chip) and the HARD
   * cap (which is the absolute backstop at 2h): this is the ACTIVE
   * recovery path so the user can retry without clicking Stop.
   *
   * On fire: log with context (messageId, elapsed) for triage; abort
   * the in-flight query so further events don't land in a cleared
   * context; emit `stream_end` (if streaming) then `error` with
   * `code: 'stream_stall'` so the dashboard's StreamStallChip can
   * render a dedicated retry affordance distinct from generic errors;
   * clear message state so `_isBusy` flips false and the next
   * `sendMessage` is no longer rejected by the busy guard.
   */
  _handleStreamStall(messageId, hasStreamStarted) {
    if (!this._isBusy) return
    const friendly = formatIdleDuration(this._streamStallTimeoutMs)
    // #4828: session-scoped (stall fires from active turn).
    ;(this._log || log).warn(
      `Stream stalled (${friendly}, messageId=${messageId}) — clearing busy state for retry`,
    )
    if (hasStreamStarted) {
      this.emit('stream_end', { messageId })
    }
    // Attempt to abort the SDK query generator so no further events land
    // into a cleared message context. Best-effort — matches _handleHardTimeout.
    this._abortActiveQuery()
    // #4616: snapshot sessionId BEFORE _clearMessageState wipes it so the
    // synthetic `result` event below carries the correct identifier.
    const sessionId = this._sdkSessionId || this._sessionId
    this._clearMessageState()
    // #4616: emit a synthetic `result` so event-normalizer fans it to
    // `agent_idle`. Per #4308 handleAgentIdle clears `activeTools: []`
    // as a safety net, which is what stops the dashboard's footer pill
    // from ticking after the stall. CLI does the equivalent via
    // _emitInterruptedTurnResult (stream_end + result); the SDK was
    // previously missing the `result` half of the pair. cost:null skips
    // session-manager billing accumulation (mirrors CLI).
    this.emit('result', { cost: null, duration: this._streamStallTimeoutMs, usage: null, sessionId })
    this.emit('error', {
      code: 'stream_stall',
      message: `Stream stalled — no response for ${friendly}. Try sending again.`,
    })
  }

  /**
   * Best-effort abort of the active SDK query generator. Used when the
   * session times out mid-turn so tool results don't stream into a
   * cleared message context (#2831).
   */
  _abortActiveQuery() {
    const q = this._query
    if (!q) return
    try {
      if (typeof q.interrupt === 'function') {
        const p = q.interrupt()
        if (p && typeof p.catch === 'function') {
          // #4828: session-scoped (abort runs strictly post-init).
          p.catch((err) => (this._log || log).warn(`Query interrupt (timeout) failed: ${err.message}`))
        }
      } else if (typeof q.return === 'function') {
        q.return()
      }
    } catch (err) {
      // #4828: session-scoped.
      ;(this._log || log).warn(`Query abort (timeout) failed: ${err.message}`)
    }
  }

  /**
   * Pause the inactivity timer because a permission prompt is
   * outstanding. Ref-counted so concurrent prompts all have to resolve
   * before the timer re-arms. #2831.
   */
  _pauseResultTimeoutForPermission() {
    this._permissionPauseCount++
    if (this._permissionPauseCount === 1) {
      this._resultTimeoutPaused = true
      // #3899: clear BOTH the soft warning and hard cap. Awaiting user
      // input on a permission is not inactivity; both re-arm together
      // via `_resetResultTimeout()` when the last prompt resolves.
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
   * Resume the inactivity timer when a permission prompt is resolved.
   * Only re-arms once the last concurrent prompt clears. #2831.
   */
  _resumeResultTimeoutForPermission() {
    if (this._permissionPauseCount === 0) return
    this._permissionPauseCount--
    if (this._permissionPauseCount === 0) {
      this._resultTimeoutPaused = false
      if (this._isBusy && typeof this._resetResultTimeout === 'function') {
        this._resetResultTimeout()
      }
    }
  }

  /**
   * Clear per-message state, marking us as ready for the next message.
   */
  _clearMessageState() {
    super._clearMessageState()
    this._permissions.clearAll()
    // Pause counter is tied to the previous message — reset so the next
    // message starts with a fresh counter.
    this._permissionPauseCount = 0
    this._resultTimeoutPaused = false
    this._resetResultTimeout = null
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this._destroying = true
    // #5936: tear down the shared outgoing queue silently — no message_dequeued
    // (which signals "sent") for a session that's going away.
    this.clearOutgoingQueue({ emit: false })
    // #4881: clear so a teardown after interrupt() never leaks the flag past
    // this session instance. Mirrors CliSession.destroy() (#4602).
    this._clearIntentionalStop()
    // #5269: drop subagent task-id mappings on teardown.
    this._taskIdByToolUseId.clear()

    if (this._resultTimeout) {
      clearTimeout(this._resultTimeout)
      this._resultTimeout = null
    }
    if (this._hardTimeout) {
      clearTimeout(this._hardTimeout)
      this._hardTimeout = null
    }
    // #4467: clear stall timer on destroy so a stale fire can't run
    // against a torn-down session.
    if (this._streamStallTimeout) {
      clearTimeout(this._streamStallTimeout)
      this._streamStallTimeout = null
    }

    // Interrupt active query
    if (this._query) {
      this._query.interrupt().catch((err) => {
        // #4828: session-scoped when init has fired.
        ;(this._log || log).warn(`Failed to interrupt active query: ${err.message} (non-critical, session destroying)`)
      })
      this._query = null
    }

    // Emit completions for any tracked agents and clear busy state
    this._clearMessageState()

    // #4307: drop any pending background-shell entries so the session-
    // list snapshot doesn't carry phantom entries for a destroyed
    // session and the map can't leak. Done after _clearMessageState so
    // the canonical "turn-end keeps pending shells" invariant from
    // _clearMessageState is preserved — the explicit destroy hook is
    // the only path that removes them.
    this._destroyPendingBackgroundShells()

    // Clean up permission manager
    this._permissions.destroy()

    this._processReady = false
    this.removeAllListeners()
  }
}
