import { query, forkSession } from '@anthropic-ai/claude-agent-sdk'
import { join } from 'path'
import { homedir } from 'os'
import { performance } from 'node:perf_hooks'
import { CLAUDE_BINARY_CANDIDATES, resolveClaudeBinary } from './utils/claude-binary.js'
import { labelBinarySpawnFailure } from './utils/verify-binary.js'
import { sdkClaudeCodeVersion, CLAUDE_SDK_MIN_CLI_VERSION } from './utils/agent-sdk-version.js'
import { updateModels, saveModelsCache, updateContextWindow, getModels, ALLOWED_MODEL_IDS } from './models.js'
import { CLAUDE_FALLBACK_MODELS, claudeModelMetadata } from './claude-model-catalog.js'
import { BaseSession, buildBaseSessionOpts, reportInputAdmission } from './base-session.js'
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
import { buildToolStartData, extractToolInputSemantics, parseCompactBoundaryMeta, formatCompactBoundaryContent, formatStatusContent } from './claude-stream-parser.js'
import { createLogger, loggerForSession } from './logger.js'
import { PermissionManager, wirePermissionManager } from './permission-manager.js'
import { formatBytes } from './utils/format-bytes.js'
import { formatIdleDuration } from './session-timeout-manager.js'
import { detectThinkingKeyword } from './detect-thinking-keyword.js'
import { BILLING_CLASSES, isProgrammaticCreditEra } from './billing-class.js'
import { CLAUDE_LOGIN_COMMAND } from './utils/claude-login-command.js'
import { buildSpawnEnv } from './utils/spawn-env.js'
import { turnOutcomeField, outcomeFromSdkResult } from './turn-outcome.js'

const log = createLogger('sdk')

// #8223: an authentication failure is surfaced with this code so the clients can
// render a "sign in" card instead of a raw error line. Same wire code claude-tui
// emits (claude-tui/pty-driver.js AUTH_REQUIRED_CODE) — kept as a local literal
// because that module resolves the claude binary at import time, which this one
// must not do.
const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED'
// The SDK reads credentials from ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN or a
// prior `claude auth login`, and nothing at the point of failure says which one
// this host meant to use — so the message covers both.
const AUTH_REQUIRED_MESSAGE = `Claude authentication failed on this host. If you use a Claude subscription, run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal on the host; if you use an API key, check ANTHROPIC_API_KEY. Then retry.`
// A containerised session has no login command to run (see
// DockerSdkSession.preflight): its credentials are the container's env.
const AUTH_REQUIRED_CONTAINER_MESSAGE = 'Claude authentication failed inside the session container. Check that ANTHROPIC_API_KEY is set for it, then retry.'

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

// #8300: the text Claude Code writes into a tool_result when IT cancelled the
// tool call — the turn had no permission/hook channel left — rather than
// relaying a decision from this session's PermissionManager. A decision made
// here always reaches the CLI with chroxy's own reason text, so a tool_result
// that starts with one of these can only mean the control channel was gone
// (stdin closed under the CLI, or its permission request stream aborted). The
// second prefix is the Approve-mode spelling (`canUseTool` could not be asked:
// "Tool permission request failed: AbortError: Stream closed"). Matched by
// prefix; the CLI appends nothing stable after the sentence.
export const SDK_TOOL_CANCELLED_PREFIXES = [
  "The user doesn't want to take this action right now.",
  'Tool permission request failed:',
]

/**
 * #8300: does this tool_result text mean Claude Code cancelled the tool call
 * itself, without consulting chroxy's permission pipeline?
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSdkToolCancellationText(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trimStart()
  return SDK_TOOL_CANCELLED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * #7376: did the Claude CLI process die under the query (a crash or an external
 * kill) rather than the query ending on its own? Distinct from
 * {@link isQueryCloseError}, which is a DELIBERATE close.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isProcessExitError(err) {
  if (!err) return false
  const text = typeof err.message === 'string' ? err.message : String(err)
  // The SDK transport's two shapes for a CLI process that died under the query
  // (sdk.mjs: `Claude Code process exited with code ${code}` and
  // `Claude Code process terminated by signal ${signal}`), ANCHORED to the start
  // of the message so an unrelated error that merely mentions a subprocess
  // exiting ("subprocess exited with code 1", "the Claude Code process exited
  // with code 1 in the hook") is not read as the CLI dying. A CLI that exits 1
  // on an API or auth failure is still a process exit, and is labelled one.
  return /^Claude Code process (?:exited with code -?\d+|terminated by signal SIG[A-Z0-9]+)\b/.test(text)
}

/**
 * #8300: is this the error the SDK's generator throws after the session
 * itself closed the query (`Query.close()` aborts the transport and kills the
 * CLI)? Only these are swallowed after a deliberate close; anything else is
 * still a turn failure and is surfaced.
 * @param {unknown} err
 * @returns {boolean}
 */
function isQueryCloseError(err) {
  if (!err) return false
  if (err.name === 'AbortError') return true
  const text = typeof err.message === 'string' ? err.message : String(err)
  // The SDK's own shapes for a close: "… aborted …" from the abort controller,
  // and the transport's "terminated by signal SIGTERM/SIGKILL" from the kill
  // close() sends. A nonzero "process exited with code N" is a crash, never a
  // close, and stays surfaced even after a deliberate close.
  return /\baborted?\b|terminated by signal SIG(TERM|KILL)\b/i.test(text)
}

/**
 * #8300/#8302: is this a `task_updated` `patch.status` that closes the task?
 * One predicate for the two sites that care (the live roster and the shell
 * tracker), so they cannot disagree about which statuses are terminal.
 * @param {unknown} status
 * @returns {boolean}
 */
function isTerminalTaskStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * Flatten a tool_result block's content to its text, the same way
 * `emitToolResults` (tool-result.js) does, so a pattern match over the text
 * sees the same string whether the CLI sent a string or a block array.
 * @param {object} block - a `tool_result` content block
 * @returns {string}
 */
function toolResultText(block) {
  if (typeof block?.content === 'string') return block.content
  if (Array.isArray(block?.content)) {
    return block.content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

export class SdkSession extends BaseSession {
  // #5858: marks this as a Claude-family provider — the single source of truth
  // for `isClaudeProvider()` (drives the createSession soft-fallback for stale
  // model ids + the shared models registry). Docker subclasses inherit it.
  static claudeFamily = true

  // #6769: cap on how long the end-of-turn getContextUsage() control request
  // may delay the `result` broadcast. The CLI answers in milliseconds when
  // alive; the cap only bites when the process is already shutting down —
  // in which case the snapshot is skipped and the result emits without it.
  static CONTEXT_USAGE_SNAPSHOT_TIMEOUT_MS = 2000

  // #8300: how long a zero-turn `result` is held before it is taken as the
  // prompt's own. On `--resume`, Claude Code first replays an orphaned
  // background task (a shell or subagent that was still running when the
  // previous turn's process exited) as its own zero-cost turn: `init` →
  // `result` with `num_turns: 0` → a second `init` for the real prompt, about
  // 20–80 ms later. That first result must not end the turn (ending the input
  // there is exactly the lost-channel bug). A real prompt that produces no
  // assistant turn is the other reading of the same message, and the CLI then
  // just waits on stdin — so the held result is confirmed by the next `init`
  // or, failing that, taken as the real one when this window elapses.
  static ORPHAN_NOTICE_CONFIRM_MS = 2000

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
      // #7825: Auto installs an SDK PreToolUse callback that routes every tool
      // through PermissionManager. Benign calls short-circuit immediately;
      // protected paths reach the shared interactive floor.
      permissionFloor: true,
      autoPermissionMode: true,
      modelSwitch: true,
      permissionModeSwitch: true,
      // #5609: SDK applies a mid-turn switch to 'auto' in-process (clears
      // rules + auto-resolves pending prompts at the next tool check) without
      // killing the turn. Declared false so the capability matrix is uniform —
      // CliSession is the only provider where the auto-switch is destructive.
      interruptsTurnOnAutoSwitch: false,
      // #8153: was `false` since the provider adapter's introduction (#583),
      // stale even then — `_sdkPermissionMode()` has always passed `'plan'`
      // straight through as the SDK's own native `PermissionMode`, which
      // query() forwards as a literal `--permission-mode plan` flag to the
      // same `claude` CLI binary CliSession spawns (query() execs
      // `pathToClaudeCodeExecutable`, #7986) — same binary, same read-only
      // enforcement, same EnterPlanMode/ExitPlanMode tool-use protocol. The
      // only missing piece was event wiring (now added in
      // _handleToolUseBlock + the 'result' case in _callQuery), not a
      // structural gap, so the capability is now `true` to match reality.
      planMode: true,
      resume: true,
      terminal: false,
      thinkingLevel: true,
      // #7725: true ONLY where the SERVER escalates on the magic keywords
      // ("think" / "think hard" / "ultrathink" …). SdkSession is the sole
      // importer of detect-thinking-keyword.js — it maps a detected keyword to
      // a per-turn maxThinkingTokens budget in _callQuery. Every other provider
      // declares false: the keyword is just prose to them, so a client that
      // highlighted it there would promise an escalation that never happens.
      // Separate from `thinkingLevel` on purpose — a provider can accept a
      // reasoning-effort dropdown without honouring the Claude-only keywords.
      thinkingKeywords: true,
      // #3932: explicit `streaming` so the capability matrix is uniform across
      // providers — claude-tui sets this to false (deliver-on-complete), all
      // others stream incremental deltas via stream_delta during a turn.
      streaming: true,
      // #6888: true when an operator's free-text deny reason (PermissionPrompt's
      // "sent with Deny" textarea) actually reaches the agent. The in-process
      // PermissionManager path feeds it back as the tool's denial message
      // (permission-manager.js buildDenyMessage) on the very next turn — the SDK
      // honors this end to end. Gates the dashboard's deny-reason affordance so
      // it isn't shown on providers that silently drop it (legacy-CLI, codex).
      denyReason: true,
      // #3209/#3246: SDK rebuilds systemPrompt.append on every turn
      // (see sdk-session.js#_callQuery), so a runtime toggle of
      // _activeManualSkills + _loadSkills() takes effect on the next
      // user message. Subprocess providers don't get this for free —
      // they snapshot the skills text at session start.
      skillToggle: true,
      // #6767: the SDK can fork/truncate a resumed conversation to a message
      // boundary (`forkSession({ upToMessageId })`), so a checkpoint restore
      // can branch the conversation ('conversation' / 'both' modes), not just
      // the files. Advertised so the checkpoint UI enables the "Conversation"
      // restore-mode option only where the server can actually honor it.
      // DockerSdkSession overrides this to false — see the instance-level
      // `supportsConversationFork` getter (transcript lives in-container).
      conversationFork: true,
      // #8301: the provider-neutral turn-input seam. `sendMessage` dispatches when
      // idle, queues via `enqueueOutgoingMessage` when busy (flushed at turn end,
      // cleared by `interrupt()`), and reports admission through
      // `onInputAdmission` — so a daemon-authored line (the CI-completion wake)
      // can travel it as an ordinary user turn. session-wake.js gates on this with
      // strict `=== true`; absent means NOT supported. Never duck-typed.
      daemonTurnInput: true,
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
   * #7346: `tool_input_delta` delivers the SANITIZED full tool input as
   * a single chunk from `_handleToolUseBlock`, once the full
   * assistant-message `block.input` is known — mirroring
   * byok-session.js's wire shape/client handler exactly. Per #8135
   * (review), this does NOT stream raw per-chunk `input_json_delta`
   * partials the way BYOK does — the Agent SDK's `stream_event` does
   * carry those (same `includePartialMessages: true` config CliSession
   * reads), but a secret can straddle chunk boundaries and mid-stream
   * partial JSON can't be run through the sanitizer, so this only ever
   * emits once, already-safe. Listing it here is what makes
   * `session-manager.js`'s `_wireSessionEvents` bridge the emit onto the
   * `session_event` channel at all.
   *
   * @returns {string[]}
   */
  static get customEvents() {
    return ['stdin_dropped_totals', 'tool_input_delta']
  }

  /**
   * #8301: with stdin forwarding latched off, `sendMessage` emits a
   * user-visible `stdin_disabled` error AND silently discards the user's own
   * queued follow-ups (`clearOutgoingQueue({ emit: false })`). A daemon wake
   * must not trigger either.
   *
   * @returns {string|null}
   */
  daemonTurnRefusal() {
    return this._stdinForwardingDisabled ? 'stdin-disabled' : null
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
   * #7986 — the exact path `query()` will spawn via `pathToClaudeCodeExecutable`
   * (see the per-turn options builder below). Preflight prefers this over a
   * fresh candidate resolve when a provider exposes it (#6708 defect #3), so
   * the existence/quarantine/provenance/version gates and the real spawn can
   * never diverge onto different binaries. Re-resolves fresh on every access —
   * NOT a frozen module-load const — so a `claude update` after daemon start
   * is picked up on the next session-create.
   */
  static get resolvedBinary() {
    return resolveClaudeBinary()
  }

  /**
   * Preflight dependency spec used by `chroxy doctor`.
   *
   * SDK mode spawns the user's INSTALLED `claude` binary under the hood via
   * `pathToClaudeCodeExecutable` (#7986) — the desktop bundle does not ship
   * the Agent SDK's own platform binary, and `query()` throws if neither is
   * available. So the same binary check every other claude-family provider
   * runs applies here too, using the shared candidate list.
   *
   * Version floor is a HYBRID, hard-min + soft-advisory pair (#8031),
   * replacing the single hard `minVersion` derived straight from the
   * installed SDK's `claudeCodeVersion` field that #7986 originally shipped.
   * That field is the `claude` CLI build the SDK release was *published
   * alongside* — a pairing, not a genuine minimum — and the CLI's patch
   * number is its release counter, so every SDK bump instantly hard-blocked
   * any `claude` on a release channel that hadn't also updated yet (e.g. npm
   * `stable`, which trails `latest`). Now:
   *   - `minVersion: CLAUDE_SDK_MIN_CLI_VERSION` — a small, hand-raised,
   *     deliberately-conservative constant — is the HARD floor: below it,
   *     preflight still throws `ProviderBinaryVersionError` exactly as before.
   *   - `recommendedVersion: () => sdkClaudeCodeVersion()` — the SDK's own
   *     pairing — is a SOFT floor: below it (but at/above the hard floor),
   *     preflight logs a warning and returns an advisory instead of blocking.
   * A `claude` older than what this SDK build was tested against still gets
   * a `claude update` remediation either way — just a throw below the hard
   * floor, an advisory otherwise. Credentials can come from
   * ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or a prior `claude login`
   * subscription.
   */
  static get preflight() {
    return {
      label: 'Claude SDK',
      binary: {
        name: 'claude',
        args: ['--version'],
        candidates: CLAUDE_BINARY_CANDIDATES,
        minVersion: CLAUDE_SDK_MIN_CLI_VERSION,
        recommendedVersion: () => sdkClaudeCodeVersion(),
        // #7986 review S2: the Agent SDK spawns `pathToClaudeCodeExecutable`
        // directly via `child_process.spawn`, no shell — a Windows npm shim
        // (`claude.cmd`/`claude.bat`) can never actually run under that. This
        // makes the refusal explicit and unconditional (see isShellShim +
        // ProviderBinaryUnsupportedError in utils/preflight.js) instead of
        // relying on it falling out of the version probe's EINVAL.
        requiresDirectExec: true,
        installHint: 'install Claude Code, or run `claude update` if it is installed — the SDK provider runs your installed claude',
        updateHint: 'run `claude update`',
      },
      credentials: {
        envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        hint: `run \`${CLAUDE_LOGIN_COMMAND}\` or set ANTHROPIC_API_KEY`,
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
    // Built once rather than as a template nested inside the `detail` template below:
    // scripts/lint-session-opt-forwarding.mjs finds class bodies with a bracket matcher
    // that does not understand a template nested in a `${}`, and one went blind to this
    // class (the session-subclass count dropped from 11 to 10) while that was written.
    const fallbackHint = `run \`${CLAUDE_LOGIN_COMMAND}\` or set ANTHROPIC_API_KEY`
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
      hint: hint || fallbackHint,
      detail: `Not configured — ${hint || fallbackHint}`,
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
    // #8223: carries `code: AUTH_REQUIRED`; `msg` is only the fallback — a session
    // swaps in its own host/container wording via `_authRequiredMessage()`.
    // `failed to authenticate` and `oauth session|token … expired|revoked|invalid`
    // are the OAuth-login wording ("Failed to authenticate: OAuth session expired
    // and could not be refreshed"), which the pre-existing alternatives missed.
    // `401` and `unauthorized` are bound, because a match now yields a no-retry
    // sign-in card and these tokens turn up in unrelated text: a hex id
    // (`container 7f3a4018c9e2…`), a request id (`req_011CTx401Qabc`), a port
    // (`127.0.0.1:4010`) and a version path (`versions/2.1.401/claude`). The `401`
    // bound is a lookaround rather than `\b401\b`, since `\b` still matches inside
    // `2.1.401/`: not after a word char or `.`, not before a word char or `.digit`.
    { test: /authentication|invalid.api.key|(?<![\w.])401(?!\w|\.\d)|\bunauthorized\b|failed to authenticate|oauth (?:session|token)\b[^.\n]{0,80}\b(?:expired|revoked|invalid)/i,
      msg: AUTH_REQUIRED_MESSAGE,
      code: AUTH_REQUIRED_CODE },
    { test: /overloaded|503|529|temporarily unavailable/i,
      msg: 'The API is temporarily overloaded. Please try again in a few minutes.' },
    { test: /SIGABRT|SIGKILL|SIGSEGV|terminated by signal/i,
      msg: 'Claude Code process crashed. This is often caused by API errors (insufficient credits, invalid key, or rate limits). Check your API provider dashboard.' },
  ]

  static _enrichErrorMessage(raw) {
    return SdkSession._classifyError(raw).message
  }

  /**
   * #8223: `_enrichErrorMessage` plus the row's `code`, when it has one. First
   * matching row wins, exactly as before, so a message that reads as a billing or
   * rate-limit failure is never reclassified as an auth one.
   * @returns {{ message: string, code?: string }}
   */
  static _classifyError(raw) {
    if (!raw) return { message: 'Unknown error' }
    for (const { test, msg, code } of SdkSession._ERROR_PATTERNS) {
      if (test.test(raw)) return code ? { message: msg, code } : { message: msg }
    }
    return { message: raw }
  }

  /** #8223: the AUTH_REQUIRED text for THIS session — container-aware. */
  _authRequiredMessage() {
    return this.constructor.capabilities?.containerized
      ? AUTH_REQUIRED_CONTAINER_MESSAGE
      : AUTH_REQUIRED_MESSAGE
  }

  get thinkingLevel() { return this._thinkingLevel }

  constructor(opts = {}) {
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-sdk' }))
    // SdkSession-local opts (not BaseSession opts — see buildBaseSessionOpts).
    const { resumeSessionId, transforms, maxToolInput, sandbox, stdinForwardingDisabled } = opts
    // #8030 / #8035: per-spawn re-verification gate. Stored by BaseSession's
    // constructor as `this._spawnPreflight` (see base-session.js's ctor param
    // doc and `_gatedSpawnBinary`) — moved there so JsonlSubprocessSession's
    // picker subclasses (Gemini/Codex-exec) inherit the same wiring instead of
    // this middle layer reading `opts.spawnPreflight` on its own and silently
    // dropping it for every subclass that forwards opts via the picker.
    this._maxToolInput = maxToolInput || DEFAULT_MAX_TOOL_INPUT_LENGTH
    this._transformPipeline = new MessageTransformPipeline(transforms || [])
    this._sandbox = sandbox || null

    this._sdkSessionId = resumeSessionId || null
    this._sessionId = null
    // #8153: plan-mode bookkeeping, mirroring CliSession's _inPlanMode /
    // _planAllowedPrompts (see _handleToolUseBlock + the 'result' case in
    // _callQuery, and _clearMessageState's stale-flag reset).
    this._inPlanMode = false
    this._planAllowedPrompts = null
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

    // #8300: tasks the CLI reported with `task_started` and has not yet closed
    // with `task_notification`, keyed by the SDK `task_id`. Read at the
    // prompt's own `result`: a task still here then would outlive the turn's
    // process, and the SDK provider cannot service it past the turn (its tool
    // calls would be cancelled, see SDK_TOOL_CANCELLED_PREFIXES), so the turn
    // end stops it and says so. Turn-local: cleared alongside
    // `_taskIdByToolUseId` at the start of each turn.
    this._liveBackgroundTasks = new Map()

    // #8300: the current turn's streaming input handle (`_createTurnInput`),
    // so destroy() can release the CLI's stdin without waiting for the
    // message loop to observe `_destroying`. Null between turns.
    this._turnInput = null

    // Permission handling — delegated to PermissionManager. The pause/resume
    // hooks keep the inactivity timer suspended while a permission is pending:
    // waiting on user input is NOT inactivity, and without this a session with
    // a pending prompt silently goes unresponsive after 5 min (#2831). The
    // pause uses a reference count so concurrent prompts keep the timer
    // suspended until the last one resolves. (Shared wiring extracted in P2-9.)
    // #6794 — pass cwd so the protected-path floor can resolve relative tool
    // targets (.git/.claude/.env…) against this session's working directory.
    // #6771 — pass the durable rule store so an `allowAlways` decision persists
    // a project-scoped rule and this session seeds from prior grants for its cwd.
    this._permissions = new PermissionManager({ log, cwd: this.cwd, ruleStore: this._permissionRuleStore })
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

    // #8363: tool_use ids whose permission prompt is awaiting a decision right
    // now (added when the provider asks, dropped when it settles), and the subset
    // that was still waiting when Stop was pressed. Stopping a turn makes the SDK
    // resolve a pending prompt as a denial and write ITS OWN tool_result, whose
    // text says the user did not want to proceed -- but nobody refused anything.
    // The tool_result path (`_terminatedReasonForToolResult`) uses the second set
    // to tag that result as a Stop. A decision the user actually gave never joins
    // it: it leaves `_pendingPermissionToolUseIds` first.
    this._pendingPermissionToolUseIds = new Set()
    this._stopCancelledToolUseIds = new Set()

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
      reportInputAdmission(sendOptions, {
        status: 'rejected', delivery: 'not_dispatched', retrySafe: true,
        reason: 'stdin_disabled', message: 'The provider input channel is disabled; restart the session before retrying.',
      })
      return
    }

    if (this._isBusy) {
      // #5936 (epic #5935): a send-while-busy follow-up goes into the shared
      // outgoing queue (BaseSession) — flushed FIFO on the next `result`. The
      // overflow cap + the `message_queued` mirror event live in
      // enqueueOutgoingMessage; nothing to do here but enqueue and return.
      const queued = this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      reportInputAdmission(sendOptions, queued
        ? { status: 'queued', delivery: 'queued' }
        : {
            status: 'rejected', delivery: 'not_dispatched', retrySafe: true,
            reason: 'queue_full', message: 'The provider input queue is full; retry after queued work advances.',
          })
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
    // #7376: a turn starts with no Stop requested, whatever the last one did.
    this._stopRequestedThisTurn = false
    this._stopCancelledToolUseIds.clear() // #8363
    // #8430: ...and with no user Stop in flight, whatever the last turn left (a
    // turn superseded before its teardown never reaches `_clearMessageState`).
    this._permissions.clearUserStopInFlight()
    // #8300: a per-session monotonic turn token. `supersededByNewerTurn`
    // compares against it: unlike a handle comparison it never reverts once
    // a follow-up turn has started and ended.
    this._turnSeq = (this._turnSeq || 0) + 1
    const turnSeq = this._turnSeq
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
    // #6391 (chat-redesign footer-stat) — thinkingId -> performance.now() when
    // the reasoning block opened, so its content_block_stop can stamp the
    // elapsed `thinkingDurationMs` on the thinking stream_end. Turn-local;
    // entries are deleted alongside thinkingBlocks when the block closes.
    // #6943: monotonic clock (perf_hooks), not Date.now() — wall-clock jumps
    // (NTP step, manual change, DST) would otherwise clamp a backward jump to
    // 0 or inflate a forward jump.
    const thinkingStartMs = new Map()
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
      // The environment for the `claude` child query() spawns, built per turn
      // by the same spawn-env builder every other provider child goes
      // through: the full parent env minus the daemon-owned secrets and any
      // ambiently inherited per-session chroxy values, plus the host
      // identity. A containerised subclass receives it through
      // spawnClaudeCodeProcess's `env` and applies its own allowlist.
      env: buildSpawnEnv('claude-sdk'),
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

    // In-process permission handling. In normal modes the SDK's canUseTool
    // request reaches PermissionManager. `bypassPermissions` suppresses those
    // native permission requests, so Auto uses the SDK's PreToolUse hook seam
    // instead: PreToolUse runs before every tool even under bypass, and the
    // callback routes the same (tool,input) pair through PermissionManager.
    // That keeps permission-floor.js as the one protected-path predicate.
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
      options.canUseTool = (toolName, input, { signal, suggestions, toolUseID }) =>
        this._handlePermission(toolName, input, signal, suggestions, toolUseID)
    } else {
      options.hooks = {
        PreToolUse: [{
          hooks: [(input, toolUseId, { signal }) => this._handleAutoPreToolUse(input, signal, toolUseId)],
          // PermissionManager's default human-decision timeout is 300s. Give
          // its hook callback a small completion margin so the manager owns the
          // timeout result instead of the SDK aborting it first.
          timeout: 310,
        }],
      }
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

    // #8030: declared OUTSIDE the try below so the catch block can see them.
    // spawnRefused distinguishes "the binary gate refused this spawn before
    // query() was ever called" from every other turn failure — it must never
    // be routed through the same error-enrichment/container-classification
    // path a real query failure gets. spawnPath is the path this turn actually
    // asked the SDK to spawn (whichever of spawnPreflight()/resolvedBinary won
    // below), used by the post-preflight spawn-failure backstop further down.
    let spawnRefused = false
    let spawnPath = null
    // #8030: flips true on the first message this turn's `for await` loop
    // receives. Gates the spawn-failure backstop below: a labelBinarySpawnFailure
    // re-verify only makes sense for a failure BEFORE any SDK output — once a
    // message has streamed, the binary plainly launched fine and a later
    // failure is something else entirely.
    let receivedAnyMessage = false
    // #8223: an authentication failure can reach this turn twice — as an assistant
    // message carrying `error: 'authentication_failed'`, and again as the query
    // throwing. Declared outside the try for the same reason as the flags above;
    // the first one to surface it wins, so a turn shows one AUTH_REQUIRED.
    let authRequiredEmitted = false
    // #8300: the turn's streaming input handle (set once `_createTurnInput`
    // runs inside the try); the `finally` ends it on every exit path.
    let input = null
    // #8300: a zero-turn `result` held back as a probable orphan-task notice
    // (see ORPHAN_NOTICE_CONFIRM_MS), the timer that takes it as the real
    // result if no `init` follows, and whether this turn has seen the prompt
    // actually run (assistant output, stream events or tool results) — a
    // result after that is the prompt's own whatever its num_turns says.
    let heldNoticeResult = null
    let noticeTimer = null
    let promptActivitySeen = false
    // #8300: set when `finishTurn` closed the query on purpose (background
    // work still live at the prompt's result), so the abort the SDK then
    // throws is logged, not surfaced as a turn error.
    let closedAfterResult = false
    // #8300: the held-result window finalizes the turn itself (see the
    // timer in `case 'result'`); the loop awaits that work before its finally
    // runs, so the two can never finish the same turn twice.
    let timerFinish = null
    // #8300: this turn's own query handle, so the `finally` only clears
    // `this._query` when it still points here — a follow-up turn that started
    // while this one was draining must keep its handle.
    let turnQuery = null
    // #8300: the task ids THIS turn saw start. The roster is shared per
    // session, so a turn that finishes after a follow-up turn has started
    // must only stop and report the tasks it owns, never the successor's.
    const turnTaskIds = new Set()
    // #8302: the background SHELL ids this turn's tool_results announced. A shell
    // is owned by the process that started it, and on this provider that is the
    // turn's own per-turn process: once the turn's query is closed nothing can
    // ever read the shell's output or hear its completion, so it must not keep
    // the session "running". Kept apart from `turnTaskIds` because a shell can
    // be tracked without a `task_started` ever naming it (an older CLI build,
    // `skip_transcript`), and that is exactly the shell no other path releases.
    const turnShellIds = new Set()
    // #8302: release every shell this turn started. `clearBackgroundShell` is a
    // no-op for an id that is not tracked, so this is idempotent and is called
    // from both the normal turn end and the `finally`. It never touches a shell
    // another turn tracked: a follow-up turn that took the session owns its own.
    const reapTurnShells = () => {
      for (const shellId of turnShellIds) this.clearBackgroundShell(shellId)
    }
    // #8302: set when the turn's query threw. Its control channel is then gone,
    // so a stop request cannot be made (and must not be pretended to have been).
    let queryFailed = false
    let queryClosed = false
    // #8302: THE routine that asks the CLI to stop the turn's still-tracked
    // shells and turns the answers into reports. Used by the prompt's own result
    // (`finishTurn`, for shells no live task names) AND by the `finally` (every
    // other exit: a throw, an abort), so an abnormal exit cannot drop a spawned
    // shell silently. Idempotent: it only sees shells still tracked, and a shell
    // it handled is released by the caller, so the second call finds nothing.
    //
    // `outcome` per shell:
    //   'stopped'     the CLI acknowledged the stop
    //   'unconfirmed' it did not — rejected (a shell-only id the CLI never
    //                 named, a task already gone), timed out, or the channel was
    //                 not usable to ask at all. Termination is UNKNOWN, and is
    //                 worded that way: "it may still be running" would claim more
    //                 than we know, "could not be stopped" more than we tried.
    const turnShellsToStop = () => [...turnShellIds]
      .filter((shellId) => this._pendingBackgroundShells.has(shellId))
      .filter((shellId) => !reportedShellIds.has(shellId))
      .map((shellId) => ({
        taskId: shellId,
        toolUseId: null,
        taskType: 'local_bash',
        description: this._pendingBackgroundShells.get(shellId)?.command || shellId,
        background: true,
      }))
    const reportedShellIds = new Set()
    const stopTurnShells = (shells, channelUsable) => Promise.all(shells.map(async (task) => {
      if (channelUsable) {
        ;(this._log || log).warn(`Background shell "${task.description}" (${task.taskId}) was still running at the turn's end; stopping it with the turn`)
      }
      const stopped = channelUsable ? await this._stopLiveTask(turnQuery, task.taskId) : false
      return { task, outcome: stopped ? 'stopped' : 'unconfirmed', asked: channelUsable }
    }))
    const reportTurnShells = (results) => {
      for (const { task, outcome, asked } of results) {
        if (reportedShellIds.has(task.taskId)) continue
        reportedShellIds.add(task.taskId)
        const tail = 'A claude-sdk session runs background work only within the turn that started it.'
        this.emit('error', {
          code: 'background_task_ended_with_turn',
          message: outcome === 'stopped'
            ? `Background shell "${task.description}" was still running when the turn ended and was stopped with it; ${tail}`
            : asked
              ? `Background shell "${task.description}" was still running when the turn ended; the CLI did not acknowledge a stop request, so its termination is UNCONFIRMED. ${tail}`
              : `Background shell "${task.description}" was still tracked when the turn ended abnormally; the turn's query was no longer usable, so it could not be asked to stop and its termination is UNCONFIRMED. ${tail}`,
          toolUseId: null,
          taskId: task.taskId,
          stopped: outcome === 'stopped',
          unconfirmed: outcome !== 'stopped',
          recoverable: true,
        })
      }
    }
    // #8300: true once a follow-up turn owns the session (it started while
    // this one was still draining or stopping work, after a hard timeout or
    // stream stall cleared busy). This turn then only reports and ends its
    // own process; it must not clear busy state or flush the queue, which
    // belong to the newer turn.
    const supersededByNewerTurn = () => this._turnSeq !== turnSeq

    try {
      // #7986 / #8030: point the SDK at the installed `claude` binary on every
      // turn. The desktop bundle does not ship the SDK's own platform binary,
      // and without pathToClaudeCodeExecutable query() throws ("Native CLI
      // binary ... not found") even when a subclass supplies
      // spawnClaudeCodeProcess. The SDK execs a NEW process per turn, so
      // "verified at session-create" only covers turn one — `_gatedSpawnBinary`
      // (BaseSession; the gate is SessionManager's `spawnPreflight` opt)
      // re-runs the full binary gate against the create-time-pinned path
      // before every subsequent spawn too. Falls back to a plain
      // `resolvedBinary` read when no gate was wired (a direct `new
      // SdkSession(...)` caller that bypassed SessionManager, or a test).
      // Set BEFORE _augmentQueryOptions so a subclass can read it; a subclass
      // that CHANGES it is refused below, since the new path was never checked.
      //
      // Everything in this inner try runs before query() and decides WHAT would
      // be exec'd, so any throw here is a pre-dispatch refusal (spawnRefused).
      try {
        // #8035: an empty path would leave pathToClaudeCodeExecutable unset,
        // and the SDK would then fall back to its own bundled binary —
        // unverified. `_gatedSpawnBinary` (BaseSession) throws
        // PROVIDER_BINARY_UNVERIFIED for that case; any error the gate itself
        // throws propagates unchanged.
        spawnPath = this._gatedSpawnBinary('claude')
        options.pathToClaudeCodeExecutable = spawnPath

        // Allow subclasses to augment query options (e.g. DockerSdkSession
        // injects spawnClaudeCodeProcess here)
        this._augmentQueryOptions(options)
        if (options.pathToClaudeCodeExecutable !== spawnPath) {
          const err = new Error('A provider hook changed the claude binary path after it was verified; this turn was not sent.')
          err.code = 'PROVIDER_BINARY_UNVERIFIED'
          throw err
        }

        // #8030 review: a containerised subclass runs claude INSIDE its
        // container through spawnClaudeCodeProcess, and pathToClaudeCodeExecutable
        // is the HOST binary, which no gate has checked (containerised providers
        // get no spawnPreflight). Without the hook — e.g. DockerSdkSession before
        // `docker run` has returned a container id — query() would exec the host
        // claude outside the container. Refuse instead.
        if (this.constructor.capabilities?.containerized && typeof options.spawnClaudeCodeProcess !== 'function') {
          const err = new Error('The session container is not ready, so this turn was not sent (it would otherwise run the host claude outside the container). Retry once the container has started.')
          err.code = 'CONTAINER_SPAWN_UNAVAILABLE'
          throw err
        }
      } catch (err) {
        spawnRefused = true
        throw err
      }

      // If attachments present, build multimodal content blocks
      const promptWithSkills = firstMessagePrefix
        ? `${firstMessagePrefix}${transformedPrompt}`
        : transformedPrompt
      const promptContent = attachments?.length
        ? buildContentBlocks(promptWithSkills, attachments)
        : [{ type: 'text', text: typeof promptWithSkills === 'string' ? promptWithSkills : String(promptWithSkills ?? '') }]
      // #8300: the prompt goes to query() as a STREAMING input (an async
      // iterable of one user message), never as a plain string. With a string
      // the Agent SDK marks the query single-turn and closes the CLI's stdin at
      // the FIRST `result` it sees — and on `--resume` the first result can be
      // the orphan-task notice turn, not the prompt's: the prompt then runs
      // with no channel for `canUseTool`/PreToolUse, every tool call is
      // cancelled with the generic "user doesn't want to take this action"
      // text, and no permission_request ever reaches a client. With an
      // iterable the SDK closes stdin only after the iterable ENDS, and this
      // turn ends it in `finishTurn` — after the result that answers the
      // prompt — or in the `finally` below, so stdin is never left open past
      // the turn either.
      input = this._createTurnInput({
        type: 'user',
        session_id: this._sdkSessionId || '',
        message: { role: 'user', content: promptContent },
        parent_tool_use_id: null,
      })
      this._turnInput = input
      const queryArgs = { prompt: input.iterable, options }
      this._query = this._callQuery(queryArgs)
      turnQuery = this._query
      reportInputAdmission(sendOptions, { status: 'accepted', delivery: 'dispatch_started' })
      // #5269: a fresh turn — drop any task_id mappings left over from a prior
      // turn (every subagent should clear via task_notification, but a turn
      // aborted before its notifications would otherwise strand entries).
      this._taskIdByToolUseId.clear()
      // #8300: the live-task roster is NOT cleared here: a previous turn may
      // still be finishing (stopping its own tasks) and reads its entries by
      // the ids it saw start; a stale entry can never match a later turn.

      // _callQuery returned an iterable without throwing — the prepend
      // bucket is committed to this turn's prompt, so flip the flag (#3225).
      // If _callQuery threw synchronously, control falls into the catch
      // below with the flag still false, ensuring the next retry
      // re-includes the prepend skills.
      if (willPrependSkills) {
        this._skillsPrepended = true
      }

      // #8300: a held zero-turn result turned out to be the orphan-task
      // notice — the CLI went on with the prompt in the same process. Called
      // from the next `init` (the usual confirmation), from any prompt
      // activity, and from a further result; each is stronger evidence than
      // the 2 s window, which must never fire under a running prompt.
      const confirmHeldNotice = (how) => {
        if (heldNoticeResult === null) return
        heldNoticeResult = null
        if (noticeTimer) {
          clearTimeout(noticeTimer)
          noticeTimer = null
        }
        ;(this._log || log).info(`Claude Code replayed a background task left over from an earlier turn (${how}); the prompt runs in the same process`)
        this.emit('message', {
          type: 'system',
          subtype: 'orphan_task_notice',
          content: 'A background task from an earlier turn ended with that turn; Claude Code noted it and is now running this prompt.',
          timestamp: Date.now(),
        })
      }

      // #8300: the prompt's own result ends the turn. A closure rather than a
      // `case` body so the held-notice timer and the post-loop fallback can
      // run the identical turn end. Idempotent: whichever of the three callers
      // gets here first finishes the turn, the others return. `heldPath` says
      // this is a held zero-turn result taken as the prompt's own (the CLI is
      // idle or already gone), so no context-usage snapshot is requested.
      let turnFinished = false
      // #8300: end this turn's own process, once. Used when live work would
      // keep it alive past the result, when a finished turn keeps receiving
      // messages (the process lingered), and when destroy() lands mid-stop.
      // (`queryClosed` itself is declared with the turn's other flags, above the
      // try, because the `finally` reads it too — #8302.)
      // #8300: set once finishTurn's stop requests have been answered (or
      // timed out). A message that lands during the stops must not close the
      // query first: the real SDK rejects pending control requests on close,
      // and a stop the CLI had already carried out would be reported as failed.
      let stopsDone = false
      const closeTurnQuery = () => {
        if (queryClosed || !turnQuery) return
        queryClosed = true
        closedAfterResult = true
        try {
          if (typeof turnQuery.close === 'function') turnQuery.close()
        } catch (closeErr) {
          ;(this._log || log).warn(`Query close after result failed: ${closeErr?.message || closeErr}`)
        }
      }
      const finishTurn = async (msg, { heldPath = false } = {}) => {
        if (turnFinished) return
        turnFinished = true
        // #8300: background work the CLI started this turn and has not
        // closed. The turn's process cannot outlive the turn, and the SDK
        // provider cannot service a task past the result (its tool calls
        // would be cancelled and its notification turn left unserviced), so
        // the work is stopped with the turn and each loss is said out loud —
        // never a silent cancellation.
        //
        // Stops go to THIS turn's query (`turnQuery`), never `this._query`,
        // which a follow-up turn may own by now. Asked in parallel and
        // bounded, so N hung tasks cost one STOP_TASK_TIMEOUT_MS, not N.
        const liveWork = this._liveBackgroundWork().filter((task) => turnTaskIds.has(task.taskId))
        // Only this turn's own tasks leave the roster: a follow-up turn that
        // took the session owns whatever else is in it.
        for (const task of liveWork) this._liveBackgroundTasks.delete(task.taskId)
        // #8302: a shell this turn's tool_result announced that no live task
        // names (no `task_started`, or a `skip_transcript` one) is still a shell
        // the CLI spawned, and a spawned shell can outlive the query (verified
        // live, above). Releasing it silently would leave it running, unreported.
        // So it goes through the SAME bounded stop pass and the SAME report as a
        // rostered task, and is released afterwards. Only shells still tracked:
        // one a notification already closed is gone from the tracker.
        const rosteredIds = new Set(liveWork.map((task) => task.taskId))
        const shellOnlyWork = turnShellsToStop().filter((task) => !rosteredIds.has(task.taskId))
        const stopWork = [...liveWork, ...shellOnlyWork]
        const [stopResults, shellOnlyResults] = await Promise.all([Promise.all(liveWork.map((task) => {
          const kind = task.taskType === 'local_bash' ? 'shell' : 'subagent'
          ;(this._log || log).warn(`Background ${kind} "${task.description}" (${task.taskId}) was still running at the turn's result; stopping it with the turn`)
          // Ask the CLI to stop the task while the control channel is still
          // open: closing the query alone ends the CLI, not a shell it spawned
          // (verified live: the shell outlived `close()`), so the report below
          // says which of the two happened.
          return this._stopLiveTask(turnQuery, task.taskId).then((stopped) => ({ task, kind, stopped }))
        })), stopTurnShells(shellOnlyWork, true)])
        // destroy() may have landed during the stops: it owns the UX from here
        // and has removed every listener, so nothing is emitted — but the
        // process is still ended, or a live task would keep it (and this
        // parked loop) alive for good.
        stopsDone = true
        if (this._destroying) {
          if (input) input.end()
          closeTurnQuery()
          return
        }
        // A hard timeout or stream stall during the stops may have cleared
        // busy and let a follow-up turn start: the session's state is then
        // that turn's, and this one only reports and ends its own process.
        const superseded = supersededByNewerTurn()
        for (const { task, kind, stopped } of stopResults) {
          this.emit('error', {
            code: 'background_task_ended_with_turn',
            message: stopped
              ? `Background ${kind} "${task.description}" was still running when the turn ended and was stopped with it; a claude-sdk session runs background work only within the turn that started it.`
              : `Background ${kind} "${task.description}" was still running when the turn ended and could not be stopped; it may still be running. A claude-sdk session runs background work only within the turn that started it.`,
            toolUseId: task.toolUseId,
            taskId: task.taskId,
            stopped,
            recoverable: true,
          })
          // A background shell's `task_id` is the shell id the tool_result
          // announced ("Command running in background with ID: <id>"), which
          // `_recordBackgroundShellsFromToolResults` tracked as pending work
          // (#4307). The shell dies with the turn's process, so drop it now:
          // left in place it keeps the roster busy ("waiting on background
          // work") for a shell nothing will ever read (#8302's shape).
          if (task.taskType === 'local_bash') this.clearBackgroundShell(task.taskId)
        }
        // #8302: and any shell this turn tracked that no live task named (see
        // `turnShellIds`), reported through the same routine the abnormal-exit
        // path uses. The process that could report on it ends with the turn.
        // Before the result is emitted, so the idle snapshot a client takes at
        // the result already reads idle.
        reportTurnShells(shellOnlyResults)
        reapTurnShells()

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

        // #6769: end-of-turn occupancy snapshot via the SDK's
        // getContextUsage() control API — the same number Claude Code's
        // own /context shows. Queried while `this._query` is still live
        // (we're inside the for-await; the CLI process is alive until
        // the generator completes). `msg.usage` below is the per-turn
        // BILLING aggregate (summed across agent-loop rounds) and must
        // never be read as occupancy — see context-window.ts (#6769).
        // Null on timeout/old-CLI/error → field omitted → clients keep
        // their previous snapshot (or the honest dash state).
        // The snapshot asks the session's current query, which a superseding
        // turn would own; a superseded turn reports without one.
        const contextUsageSnapshot = (heldPath || superseded) ? null : await this._getContextUsageSnapshot()

        // #8153: emit plan_ready before result — mirrors CliSession's
        // "the turn that calls ExitPlanMode ends with a normal result
        // event" ordering. `_planAllowedPrompts` is only non-null once
        // ExitPlanMode's tool_use block has been parsed (see
        // _handleToolUseBlock's 'exit_plan' branch above).
        if (!superseded && this._inPlanMode && this._planAllowedPrompts !== null) {
          this.emit('plan_ready', { allowedPrompts: this._planAllowedPrompts })
          this._inPlanMode = false
          this._planAllowedPrompts = null
        }

        // #4628: sweep any orphan tool_starts before emitting result
        // so the dashboard's activeTools clears as part of the same
        // turn-end burst. _clearMessageState (called next) would also
        // clear the in-flight map but without broadcasting synthetic
        // tool_results to the dashboard.
        // A superseded turn emits its result directly: `_emitResult` would
        // sweep the shared in-flight tool_starts, which are the successor's.
        ;(superseded ? (payload) => this.emit('result', payload) : (payload, reason, opts) => this._emitResult(payload, reason, opts))({
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
          // #6769: occupancy snapshot (or absent when unavailable).
          // Wire field is contextOccupancy — NOT contextUsage — so it can
          // never be confused with the billing `usage` aggregate above.
          ...(contextUsageSnapshot ? { contextOccupancy: contextUsageSnapshot } : {}),
          // #7326: why the turn ended (truncated by max_tokens / max turns /
          // budget, refused, ...). Omitted when the SDK reported nothing we map.
          ...turnOutcomeField(outcomeFromSdkResult(msg)),
        }, 'turn_ended_with_orphan_tool_start', { completion: 'normal' }) // #7376

        // #7340: NOT `{ turnEndedCleanly: true }`, however much this looks
        // like CliSession's `result` branch -- and the difference is the
        // whole reason that flag is opt-in.
        //
        // CliSession owns a PERSISTENT stream-json child that spans turns,
        // so after its `result` a backgrounded subagent's
        // `task_notification` still arrives. SdkSession creates one
        // `query()` PER TURN (`sendMessage`: "Each call creates a new
        // query() with resume"), and this turn ends it a few lines below:
        // the streaming input is released, and with live background work
        // the query is closed outright (#8300). No `task_notification` can
        // arrive for an agent spared here -- and every recovery route is
        // closed too: `_handleHardTimeout` / `_handleStreamStall`
        // early-return on `!_isBusy`, `interrupt()` early-returns on a null
        // `_query`, and `cancelActivity` answers `not-supported`. The agent
        // would be stranded until `destroy()`, pinning the session as
        // working -- the failure #7340 names as the worse one.
        //
        // The subagent dies with the query, so completing it here is not
        // merely safe, it is accurate -- and #8300 says so to the client
        // (the `background_task_ended_with_turn` error above) instead of
        // leaving the loss silent. Exempting on this path needs the query
        // kept alive past `result`, which is a much larger change.
        if (!superseded) this._clearMessageState({ completion: 'normal' }) // #7376

        // #8300: the prompt is answered — release the streaming input so the
        // SDK closes the CLI's stdin and the process exits once idle. With
        // live background work the process would NOT go idle (the task keeps
        // it alive with its tools cancelled), so the query is closed outright;
        // the abort that follows is expected (see `closedAfterResult`).
        streamState.hasStreamStarted = false
        if (input) input.end()
        if (stopWork.length) closeTurnQuery()
      }

      for await (const msg of this._query) {
        if (this._destroying) break
        // #8300: a finished turn expects nothing more; a message after the
        // finish means the process lingered (work this turn could not see
        // kept it alive). It is not relayed into a turn that is over — the
        // process is ended instead, and the first such message is logged.
        if (turnFinished) {
          // Only another turn's traffic means the process lingered: an init,
          // assistant output, stream events or tool results. Bookkeeping
          // that routinely follows a result (task_updated/task_notification
          // after a stop, status, hook events) is dropped quietly.
          const lingering = msg?.type === 'assistant' || msg?.type === 'stream_event' || msg?.type === 'user' ||
            (msg?.type === 'system' && msg?.subtype === 'init')
          if (lingering && stopsDone && !queryClosed) {
            ;(this._log || log).warn(`SDK message after the turn's result (${msg?.type}/${msg?.subtype || ''}); ending the lingering process`)
            closeTurnQuery()
          }
          continue
        }
        receivedAnyMessage = true // #8030: gates the spawn-failure backstop below
        // A superseded turn's traffic must not re-arm the session's
        // inactivity timers against the successor.
        if (!supersededByNewerTurn()) resetResultTimeout() // Any SDK event = activity, reset inactivity timer

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init') {
              // #8300: a second `init` right after a zero-turn `result` is the
              // CLI starting the prompt's own turn in the same process — the
              // held result was the orphan-task notice. Say so once and keep
              // the turn open; the prompt's result is still to come.
              confirmHeldNotice('a second init followed it')
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
              // #8300: remember the task until its `task_notification`. Only a
              // task the CLI itself flags `is_backgrounded` counts as live work
              // at the prompt's result: a foreground Bash is ALSO reported as a
              // `local_bash` task (with `is_backgrounded: false`) and settles
              // before the result, so the task type alone says nothing. A
              // `task_updated` patch can flip the flag later (Ctrl+B-style
              // backgrounding). `skip_transcript` marks ambient housekeeping
              // work the user never started; it is never reported as a loss.
              if (typeof msg.task_id === 'string' && msg.task_id && msg.skip_transcript !== true) {
                turnTaskIds.add(msg.task_id)
                this._liveBackgroundTasks.set(msg.task_id, {
                  taskId: msg.task_id,
                  toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : null,
                  taskType: typeof msg.task_type === 'string' ? msg.task_type : 'unknown',
                  description: typeof msg.description === 'string' && msg.description
                    ? msg.description
                    : 'Background task',
                  background: msg.is_backgrounded === true,
                })
              }
              // #7340: `task_started` is the provider's OWN lifecycle event and
              // carries `is_backgrounded` — authoritative where the tool input
              // is only the model's request. It also arrives regardless of what
              // the subagent tool is NAMED, so tracking survives a future
              // rename the way the `Task` -> `Agent` one was not survived.
              // `task_type` distinguishes a subagent (`local_agent`) from a
              // backgrounded Bash (`local_bash`), which is #4307's surface and
              // must not be tracked as an agent.
              if (msg.task_type === 'local_agent') {
                this._trackAgent({
                  toolUseId: msg.tool_use_id,
                  description: typeof msg.description === 'string' && msg.description
                    ? msg.description
                    : 'Background task',
                  background: msg.is_backgrounded === true,
                  // #7340: authoritative -- this is the provider's own account,
                  // so it overwrites the model's request in BOTH directions.
                  // It is also the evidence that this build emits task
                  // lifecycle messages at all, which is what makes the
                  // turn-end exemption safe: `task_notification` can arrive.
                  authoritative: true,
                })
              }
              break
            } else if (msg.subtype === 'task_notification') {
              // #5269: a Task subagent reached a terminal state (completed /
              // failed / stopped — the last one is what query.stopTask emits).
              // Finalize the agent node promptly and drop the task mapping so a
              // cancel feels responsive instead of waiting for the turn-end
              // sweep. Idempotent (no-op if already finalized).
              this._finalizeAgentByToolUseId(msg.tool_use_id)
              // #8300: the task is closed; it no longer counts as live work at
              // the prompt's result.
              if (typeof msg.task_id === 'string') {
                this._liveBackgroundTasks.delete(msg.task_id)
                // #8302: a background shell's `task_id` IS the shell id its
                // tool_result announced, and a terminal notification is the
                // only completion signal that still exists (current Claude Code
                // has no `BashOutput` tool, so the acknowledgement clear can
                // never fire). Untracked ids are a no-op.
                this.clearBackgroundShell(msg.task_id)
              }
              break
            } else if (msg.subtype === 'task_updated') {
              // #8300: a task backgrounded after it started (`patch.is_backgrounded`)
              // becomes live work; a terminal `patch.status` closes it.
              const live = typeof msg.task_id === 'string' ? this._liveBackgroundTasks.get(msg.task_id) : null
              const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : null
              if (live && patch) {
                if (patch.is_backgrounded === true) live.background = true
                if (typeof patch.description === 'string' && patch.description) live.description = patch.description
                if (isTerminalTaskStatus(patch.status)) {
                  this._liveBackgroundTasks.delete(msg.task_id)
                }
              }
              // #8302: a terminal status closes the task's shell too — whether
              // or not the roster holds the task (a `skip_transcript` task is
              // never on it, yet its shell may still be tracked). Same id
              // equality and same no-op as the `task_notification` branch.
              if (patch && typeof msg.task_id === 'string' && isTerminalTaskStatus(patch.status)) {
                this.clearBackgroundShell(msg.task_id)
              }
              break
            } else if (msg.subtype === 'compact_boundary') {
              // #6768: the SDK compacted the conversation (auto-triggered
              // near the context limit, or manually via `/compact`). Parse
              // the structured `compact_metadata` into a distinct marker
              // instead of letting it fall through to the generic
              // "unknown system event" branch below, which would forward
              // the literal string `compact_boundary` as `content` with no
              // human-readable text and drop trigger/token/duration data
              // entirely.
              const meta = parseCompactBoundaryMeta(msg.compact_metadata)
              ;(this._log || log).info(
                `Context compacted (${meta.trigger}): ${meta.preTokens ?? '?'} -> ${meta.postTokens ?? '?'} tokens` +
                  (meta.durationMs != null ? ` in ${meta.durationMs}ms` : '')
              )
              this.emit('message', {
                type: 'system',
                subtype: 'compact_boundary',
                content: formatCompactBoundaryContent(meta),
                compactMetadata: meta,
                timestamp: Date.now(),
              })
              break
            } else if (msg.subtype === 'status') {
              // #8153 (review nit): `SDKStatusMessage` carries no
              // `message`/`text` field, just `status: 'compacting' |
              // 'requesting' | null` — the generic fallback below would
              // otherwise forward the bare literal string "status" as a
              // chat bubble. `status: null` means the previous status
              // cleared, nothing new to show, so it's suppressed entirely
              // rather than emitted as an empty/placeholder bubble.
              const statusText = formatStatusContent(msg.status)
              if (statusText) {
                this.emit('message', {
                  type: 'system',
                  subtype: 'status',
                  content: statusText,
                  timestamp: Date.now(),
                })
              }
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
            promptActivitySeen = true // #8300: the prompt is running
            confirmHeldNotice('stream events followed it')
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
                    // #6391 footer-stat: mark the block's start for the
                    // content_block_stop elapsed-time computation. #6943:
                    // performance.now() (monotonic), not Date.now().
                    thinkingStartMs.set(thinkingId, performance.now())
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
                    // #6391 footer-stat: mark the block's start (lazy-open path)
                    // for the content_block_stop elapsed-time computation.
                    // #6943: performance.now() (monotonic), not Date.now().
                    thinkingStartMs.set(thinkingId, performance.now())
                    this.emit('stream_start', { messageId: thinkingId, thinking: true })
                  }
                  didStreamThinking = true
                  this.emit('stream_delta', { messageId: thinkingId, delta: delta.thinking, thinking: true })
                }
                // #8135 (review on #7346): the Agent SDK's `input_json_delta`
                // chunks (present, since `includePartialMessages: true` is
                // set) are deliberately NOT forwarded here — a secret can
                // straddle chunk boundaries and mid-stream partial JSON
                // can't be sanitized. The sanitized FULL input is delivered
                // once instead, from `_handleToolUseBlock` below, once the
                // complete assistant-message `block.input` is known.
                break
              }

              case 'content_block_stop': {
                // #6756 — close the thinking stream for this block so the client
                // finalises its "Thinking… → Thought" label. Only thinking
                // blocks are tracked here; text/tool_use blocks are a no-op.
                const thinkingId = thinkingBlocks.get(event.index)
                if (thinkingId) {
                  thinkingBlocks.delete(event.index)
                  // #6391 footer-stat: elapsed monotonic time from the block's
                  // open to now → the client's `thought for Xs` footer. Omit
                  // when the start wasn't tracked (defensive) so we never send
                  // a bogus 0. No token count: Anthropic's usage folds thinking
                  // tokens into output_tokens with no per-block breakdown (see
                  // follow-up). #6943: startMs is a performance.now() sample
                  // (monotonic, immune to wall-clock jumps), so elapsed can
                  // never legitimately be negative — Math.max(0, …) is a
                  // defensive floor only, not a correctness requirement.
                  const startMs = thinkingStartMs.get(thinkingId)
                  thinkingStartMs.delete(thinkingId)
                  const streamEndMsg = { messageId: thinkingId, thinking: true }
                  if (typeof startMs === 'number') {
                    streamEndMsg.thinkingDurationMs = Math.max(0, Math.round(performance.now() - startMs))
                  }
                  this.emit('stream_end', streamEndMsg)
                }
                break
              }
            }
            break
          }

          case 'assistant': {
            // #8223: the SDK marks a synthetic assistant message with the failure
            // class (`SDKAssistantMessage.error`). For `authentication_failed` its
            // text block is the raw "Failed to authenticate: …" line; surface the
            // typed error INSTEAD of that text as a chat response, and do not take
            // this non-turn message as the fork boundary below.
            if (msg.error === 'authentication_failed') {
              if (!authRequiredEmitted) {
                authRequiredEmitted = true
                ;(this._log || log).warn('Assistant message reported authentication_failed')
                this.emit('error', { code: AUTH_REQUIRED_CODE, message: this._authRequiredMessage() })
              }
              break
            }
            // #6766: remember this message's transcript UUID as the fork
            // boundary. A checkpoint auto-created at the start of the NEXT turn
            // captures this as its boundary, so restoring that checkpoint can
            // fork the conversation truncated to exactly this point.
            this._captureBoundaryMessage(msg)
            promptActivitySeen = true // #8300: the prompt is running
            confirmHeldNotice('assistant output followed it')
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
            promptActivitySeen = true // #8300: the prompt is running
            confirmHeldNotice('tool results followed it')
            // #8300: a tool_result carrying Claude Code's own cancellation text
            // means the CLI dropped the call WITHOUT asking this session's
            // PermissionManager — there was no channel to ask on. That is a
            // runtime fault of the turn, not a decision anyone took, so it is
            // surfaced as a session error naming the tool and its id (the
            // tool_result still follows, flagged isError, so the tool_start
            // it answers is closed). Read BEFORE emitToolResults, which drops
            // the in-flight entry that carries the tool name.
            if (Array.isArray(msg.message?.content)) {
              for (const block of msg.message.content) {
                if (block?.type !== 'tool_result' || !block.tool_use_id) continue
                // The CLI's cancellation block is always `is_error: true`; a
                // tool's OWN output that happens to start with the sentence (a
                // fetched page, a file, an echo) is not an error block.
                if (block.is_error !== true) continue
                // #8363: Stop cancelled this tool's pending prompt; the result is
                // tagged as a Stop below, and is not a provider-side fault.
                if (this._stopCancelledToolUseIds.has(block.tool_use_id)) continue
                const text = toolResultText(block)
                if (!isSdkToolCancellationText(text)) continue
                const tool = this._inFlightToolStarts.get(block.tool_use_id)?.tool || 'unknown'
                const firstLine = text.trim().split('\n')[0].slice(0, 200)
                ;(this._log || log).error(
                  `Claude Code cancelled the ${tool} tool call ${block.tool_use_id} without consulting the permission pipeline: ${firstLine}`,
                )
                this.emit('error', {
                  code: 'tool_cancelled_by_provider',
                  message: `Claude Code cancelled the ${tool} tool call (${block.tool_use_id}) before it reached the permission pipeline: ${firstLine}`,
                  tool,
                  toolUseId: block.tool_use_id,
                  recoverable: true,
                })
              }
            }
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
            this._recordBackgroundShellsFromToolResults(msg.message?.content, turnShellIds)
            break
          }

          case 'result': {
            // #8300: on `--resume` the CLI can run an orphan-task notice as its
            // own zero-cost turn BEFORE the prompt: `init` → this result with
            // `num_turns: 0` → a second `init`. Taking it as the prompt's
            // result would end the turn (and the input) under the prompt.
            // Hold it: the next `init` confirms the notice; if none comes
            // within ORPHAN_NOTICE_CONFIRM_MS it was the prompt's own, the
            // input is released so the CLI exits, and the loop's end finishes
            // the held result below.
            // A further result while one is held: the held one was the notice
            // (the CLI ran another turn after it); this one is judged afresh.
            confirmHeldNotice('a further result followed it')
            if (msg.num_turns === 0 && msg.is_error !== true && !promptActivitySeen) {
              heldNoticeResult = msg
              ;(this._log || log).info(`Holding a zero-turn result (${msg.duration_ms ?? '?'}ms): probable orphan-task notice; waiting ${SdkSession.ORPHAN_NOTICE_CONFIRM_MS}ms for the prompt's own init`)
              // On expiry the held result is finished HERE, while the loop is
              // parked on the generator and the query is still live: finishTurn
              // releases the input and, if background work is keeping the
              // process alive, stops it and closes the query — so the turn can
              // never depend on an EOF that such work would withhold.
              noticeTimer = setTimeout(() => {
                noticeTimer = null
                if (heldNoticeResult === null || this._destroying) return
                const held = heldNoticeResult
                heldNoticeResult = null
                ;(this._log || log).info('No init followed the zero-turn result within the window; taking it as the prompt\'s own')
                timerFinish = finishTurn(held, { heldPath: true }).catch((err) => {
                  ;(this._log || log).warn(`Finishing the held result failed: ${err?.message || err}`)
                })
              }, SdkSession.ORPHAN_NOTICE_CONFIRM_MS)
              break
            }
            await finishTurn(msg)
            break
          }
        }
      }
      // #8300: the loop ended (the CLI exited on its own) with a zero-turn
      // result still held and no init after it — it was the prompt's own.
      if (timerFinish) await timerFinish
      if (heldNoticeResult !== null && !this._destroying) {
        const held = heldNoticeResult
        heldNoticeResult = null
        await finishTurn(held, { heldPath: true })
      }
    } catch (err) {
      // #8302: the query threw; its control channel is gone (see `queryFailed`).
      queryFailed = true
      // #8300: a held zero-turn result dies with the loop — its timer must
      // not finish a turn that is being reported as failed below.
      if (noticeTimer) {
        clearTimeout(noticeTimer)
        noticeTimer = null
      }
      heldNoticeResult = null
      // #8300: a timer-driven finish may be mid-flight (stopping live work);
      // let it complete so its result precedes any error surfaced below and
      // nothing it emits lands after `_clearMessageState`.
      if (timerFinish) {
        try { await timerFinish } catch { /* logged where it was started */ }
      }
      if (streamState.hasStreamStarted) {
        this.emit('stream_end', { messageId })
      }
      // #4881: capture-and-clear before any branch so the flag never leaks
      // past this turn even when _destroying short-circuits the emits below.
      // Mirrors CliSession._handleChildClose (#4602).
      // A superseded turn leaves the Stop flag to the turn it belongs to.
      const wasIntentionalStop = supersededByNewerTurn() ? false : this._consumeIntentionalStop()
      if (!this._destroying) {
        if (closedAfterResult && isQueryCloseError(err)) {
          // #8300: finishTurn already emitted this turn's result and closed
          // the query on purpose (background work was still live); the abort
          // the SDK throws for that is expected, not a turn failure. Any
          // OTHER error after the close is still surfaced below.
          ;(this._log || log).debug(`Query closed after the turn's result: ${err?.message || err}`)
        } else if (wasIntentionalStop) {
          // #4881: user clicked Stop — interrupt() set the flag, the SDK
          // generator threw an AbortError as a result. Skip the loud "Query
          // error" surface and emit the quiet `stopped` event for parity
          // with CliSession. No `code` because SDK runs in-process — there
          // is no child-process exit status to carry.
          ;(this._log || log).info('Query aborted after user stop')
          this.emit('stopped', {})
        } else if (spawnRefused) {
          // #8030: the turn was refused BEFORE query() was ever called — by the
          // per-spawn binary gate (a block-mode hash mismatch, quarantine, a
          // vanished pinned binary, …) or because a containerised session has
          // no in-container spawn hook yet. Two things this branch deliberately
          // does NOT do:
          //   - route through _enrichErrorMessage: a provenance message
          //     embeds a hex hash prefix (e.g. "...a4291b0c...") that can
          //     match the rate-limit ("429") or auth ("401") patterns in
          //     _ERROR_PATTERNS and get silently rewritten into a wrong,
          //     misleading "rate limit"/"auth failed" message instead of the
          //     real cause.
          //   - run container classification: the turn never reached the
          //     SDK, so there is no container to have vanished.
          // #8035: hoisted onto BaseSession (`_refuseTurnBeforeDispatch`) so
          // JsonlSubprocessSession's per-turn spawn gets byte-identical wire
          // shape instead of a second hand-rolled copy.
          this._refuseTurnBeforeDispatch(err, sendOptions, this._log || log)
        } else {
          // #7599: let a containerized subclass classify this turn failure as a
          // vanished container (a distinct, recoverable state) before the
          // generic query-error surface. Base returns null; DockerSdkSession
          // probes the container and returns a CONTAINER_VANISHED payload.
          const containerGone = await this._classifyContainerFailure(err)
          // #7599: _classifyContainerFailure can await a real `docker exec` probe
          // (up to 10s). A destroy() landing in that window has already torn the
          // session down and removed its listeners, so emitting here would fire
          // on a dead EventEmitter (Node throws on an unhandled 'error'). Re-check
          // teardown after the await before surfacing anything.
          if (this._destroying) {
            // fall through to _clearMessageState below; destroy() owns the UX
          } else if (containerGone) {
            ;(this._log || log).warn(`Container vanished during turn: ${containerGone.message}`)
            this.emit('error', containerGone)
          } else {
            // #8030 backstop: a spawn failure AFTER preflight passed (the
            // pinned binary was quarantined/moved/removed between the gate
            // call above and the actual exec, or the gate wasn't wired at
            // all) surfaces from the SDK as generic text ("native binary ...
            // failed to launch"). Re-verify the ATTEMPTED path and label the
            // real cause + fix, the same backstop cli-session.js /
            // jsonl-subprocess-session.js run for their own spawns — but only
            // when this is plausibly a launch failure: no SDK message has
            // arrived yet this turn, a path was actually attempted, and the
            // provider isn't containerised (its binary lives inside a
            // container a host-side verify can't see).
            const labeled = (!receivedAnyMessage && spawnPath && !this.constructor.capabilities?.containerized)
              ? labelBinarySpawnFailure({ attemptedPath: spawnPath, binary: 'claude' })
              : null
            // #4828: session-scoped when init has fired; falls back to module
            // `log` for pre-init query failures (e.g. spawn refused).
            ;(this._log || log).error(`Query error: ${err.message}`)
            // #8223: an auth-shaped failure carries AUTH_REQUIRED (so the clients
            // render the sign-in card) unless this turn already surfaced one from
            // the assistant message. A binary-launch label wins over classification,
            // exactly as it wins over enrichment.
            const classified = labeled ? { message: labeled } : SdkSession._classifyError(err.message)
            if (classified.code === AUTH_REQUIRED_CODE) {
              if (!authRequiredEmitted) {
                authRequiredEmitted = true
                this.emit('error', { code: AUTH_REQUIRED_CODE, message: this._authRequiredMessage() })
              }
            } else {
              this.emit('error', { message: classified.message })
            }
          }
        }
      }
      // #7376: a Stop that aborted the query leaves its in-flight tools "stopped",
      // and a CLI process that exited under the query leaves them cut off by the
      // exit; neither is a failed command. Any other throw has no considered
      // cause and keeps the generic sweep.
      if (!supersededByNewerTurn()) {
        this._clearMessageState(
          wasIntentionalStop
            ? { terminatedReason: 'user_stop' }
            : isProcessExitError(err) ? { terminatedReason: 'process_exit' } : undefined,
        )
      }
    } finally {
      // #8300: whatever ended the loop — the prompt's result, a throw, a
      // destroy() break — the streaming input is released here, so the SDK
      // closes the CLI's stdin and the process can exit. Idempotent; the
      // normal path already ended it in finishTurn. A still-pending notice
      // timer is dropped with the turn.
      if (noticeTimer) {
        clearTimeout(noticeTimer)
        noticeTimer = null
      }
      if (timerFinish) {
        try { await timerFinish } catch { /* logged where it was started */ }
      }
      if (input) input.end()
      if (this._turnInput === input) this._turnInput = null
      if (this._query === turnQuery) this._query = null
      // #8300: whatever this turn saw start is gone with its process.
      for (const taskId of turnTaskIds) this._liveBackgroundTasks.delete(taskId)
      // #8302: ...and so is every shell it started, whatever ended the loop (a
      // throw, a destroy, a result with no live task to report). Without this a
      // shell that died or was never acknowledged left the session reading busy
      // forever on a provider that has no `BashOutput` to clear it.
      //
      // On the normal path `finishTurn` has already stopped, reported and
      // released them. What reaches here are the abnormal exits (an AbortError, a
      // crash): ask the CLI to stop each still-tracked shell while the channel is
      // still usable, and where it is not, SAY each one is unconfirmed instead of
      // forgetting it. destroy() owns its own UX and reports nothing.
      if (!this._destroying) {
        const leftover = turnShellsToStop()
        if (leftover.length > 0) {
          const channelUsable = !queryFailed && !queryClosed && !!turnQuery
          const results = await stopTurnShells(leftover, channelUsable)
          if (!this._destroying) reportTurnShells(results)
        }
      }
      reapTurnShells()
      // #4881: safety-net clear of _intentionalStop. The catch block clears
      // it on the throw path (AbortError after interrupt()), but if
      // query.interrupt() races a `result` message arriving first, the
      // for-await loop exits normally, skipping the catch. Without this
      // clear, the flag would stay armed until the next turn's catch and
      // mis-trigger a spurious `stopped` emit there. Idempotent — the
      // catch path already cleared it on the throw path. Not for a
      // superseded turn: the flag is then the successor's.
      if (!supersededByNewerTurn()) this._clearIntentionalStop()
      // Dequeue any follow-up messages that arrived while busy (#5936: the
      // shared `_outgoingQueue`; flush one item via dequeueNextOutgoing, whose
      // re-dispatched sendMessage re-sets _isBusy so the next `result` drains
      // the following item — FIFO, one turn at a time).
      if (this._outgoingQueue.length && !this._destroying && !supersededByNewerTurn()) {
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
   * #8300: the turn's streaming input — an async iterable that yields the
   * prompt's user message once and then stays open until `end()` is called.
   *
   * The Agent SDK decides when to close the CLI's stdin from the SHAPE of
   * `prompt`: a string marks the query single-turn and stdin closes at the
   * first `result`; an iterable keeps stdin open until the iterable ends. The
   * turn therefore owns the close: `finishTurn` ends the iterable once the
   * result that answers the prompt has been processed, and `sendMessage`'s
   * `finally` ends it on every other exit so the CLI is never left waiting.
   *
   * @param {object} userMessage - the SDKUserMessage to send
   * @returns {{ iterable: AsyncIterable<object>, end: () => void, readonly ended: boolean }}
   */
  _createTurnInput(userMessage) {
    let release
    const released = new Promise((resolve) => { release = resolve })
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      release()
    }
    const iterable = (async function* () {
      yield userMessage
      await released
    })()
    return {
      iterable,
      end,
      get ended() { return ended },
    }
  }

  /**
   * #8300: background work the CLI reported as started and never closed. Read
   * at the prompt's result; anything still here would outlive the turn's
   * process.
   *
   * @returns {Array<{taskId:string,toolUseId:string|null,taskType:string,description:string,background:boolean}>}
   */
  _liveBackgroundWork() {
    // A `local_bash` task whose shell the tool_result announced ("Command
    // running in background with ID: <id>", tracked by
    // `_recordBackgroundShellsFromToolResults`) is background work whatever
    // `task_started` said: a foreground Bash never produces that text. This
    // keeps shell detection working if a CLI build stops sending the
    // undocumented `is_backgrounded` field on `task_started`.
    return [...this._liveBackgroundTasks.values()].filter((task) =>
      task.background === true ||
      (task.taskType === 'local_bash' && this._pendingBackgroundShells.has(task.taskId)))
  }

  // #8300: bound on `Query.stopTask()` at the turn's result. The CLI answers
  // the control request in milliseconds when alive; the cap only bites when
  // it is already gone, in which case the task is reported as not stopped.
  static STOP_TASK_TIMEOUT_MS = 3000

  /**
   * #8300: ask the CLI to stop a task that would outlive the turn, via the
   * SDK's `stopTask` control request. Resolves true when the CLI acknowledged
   * the stop, false when the query has no `stopTask`, it threw, or it did not
   * answer within STOP_TASK_TIMEOUT_MS. Never throws.
   *
   * @param {object|null} q - the turn's own query handle
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  async _stopLiveTask(q, taskId) {
    if (!q || typeof q.stopTask !== 'function') return false
    let timer = null
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), SdkSession.STOP_TASK_TIMEOUT_MS)
      })
      const ok = await Promise.race([q.stopTask(taskId).then(() => true), timeout])
      if (!ok) (this._log || log).warn(`stopTask(${taskId}) did not answer within ${SdkSession.STOP_TASK_TIMEOUT_MS}ms`)
      return ok === true
    } catch (err) {
      ;(this._log || log).warn(`stopTask(${taskId}) failed: ${err?.message || err}`)
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * #7599 — hook for a containerized subclass to classify a turn failure as a
   * vanished container. Called from the query catch before the generic error
   * surface. The base in-process SdkSession has no container, so it never
   * classifies a failure this way.
   *
   * @param {Error} _err the error the query threw
   * @returns {Promise<{code:string,message:string,recoverable?:boolean}|null>}
   *   a session-error payload to emit instead of the generic one, or null
   */
  async _classifyContainerFailure(_err) {
    return null
  }

  /**
   * #6769: fetch the end-of-turn context-window OCCUPANCY snapshot from the
   * SDK's `getContextUsage()` control API (verified on
   * @anthropic-ai/claude-agent-sdk 0.2.114: sdk.d.ts declares
   * `Query.getContextUsage(): Promise<SDKControlGetContextUsageResponse>` with
   * `totalTokens` / `maxTokens` / `percentage` / `autoCompactThreshold` (in
   * TOKENS — the CLI compares it directly against token counts) /
   * `isAutoCompactEnabled`).
   *
   * This is the ONLY honest occupancy source for this provider: the result
   * message's own `usage` is the per-turn billing aggregate summed across
   * agent-loop rounds (+ subagents) and over-reads window fill ≈N× on an
   * N-round turn.
   *
   * Fail-soft by design — returns null (result emits without the field) when:
   *   - the query is gone or the installed SDK predates the API (typeof guard)
   *   - the control request errors (CLI already shutting down post-result)
   *   - the response doesn't arrive within the timeout (bounds the latency
   *     this adds to the turn-end result broadcast)
   *   - the response lacks a finite totalTokens
   * Clients treat a missing field as "keep the previous snapshot / dash".
   *
   * @returns {Promise<{totalTokens: number, maxTokens: number|null, autoCompactThreshold: number|null, isAutoCompactEnabled: boolean|null, source: 'context-usage-api'}|null>}
   */
  async _getContextUsageSnapshot() {
    const q = this._query
    if (!q || typeof q.getContextUsage !== 'function') return null
    let timer = null
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), SdkSession.CONTEXT_USAGE_SNAPSHOT_TIMEOUT_MS)
        // Don't hold the process open for a race that already resolved (#6027).
        if (typeof timer.unref === 'function') timer.unref()
      })
      const res = await Promise.race([q.getContextUsage(), timeout])
      if (!res || typeof res.totalTokens !== 'number' || !Number.isFinite(res.totalTokens) || res.totalTokens < 0) {
        if (!res) {
          ;(this._log || log).debug('getContextUsage() timed out or returned nothing — result emits without occupancy')
        }
        return null
      }
      const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
      return {
        totalTokens: res.totalTokens,
        maxTokens: pos(res.maxTokens),
        autoCompactThreshold: pos(res.autoCompactThreshold),
        isAutoCompactEnabled: typeof res.isAutoCompactEnabled === 'boolean' ? res.isAutoCompactEnabled : null,
        source: 'context-usage-api',
      }
    } catch (err) {
      ;(this._log || log).debug(`getContextUsage() failed (${err?.message || err}) — result emits without occupancy`)
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
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

    // #7346: backfill the finalized input onto the in-flight tool_start
    // tracking entry (`_trackToolStart` / base-session.js
    // `_recordToolInput`, which sanitizes + size-caps it — see
    // #8135/#8136) so `tool-result.js`'s `emitToolResults` can attach it
    // to the matching `tool_result` (`_getTrackedToolInput`). Runs for
    // EVERY tool_use block, not just the Task/plan-mode ones handled
    // below: the full "assistant" message this function is called from
    // always carries the complete `block.input`, so (unlike CliSession,
    // which must accumulate `input_json_delta` chunks) no buffering is
    // needed. Mirrors the `${messageId}-tool` fallback `buildToolStartData`
    // uses (and the Task branch below reuses) so the id always matches
    // whatever `_trackToolStart` was called with at `content_block_start`.
    const toolUseId = block.id || `${messageId}-tool`
    const sanitizedInput = this._recordToolInput(toolUseId, block.input ?? null)
    // #8135 (review): deliver the SANITIZED input as a single-shot
    // `tool_input_delta` here — this is the earliest point SdkSession
    // knows the full value, milliseconds after the block finalized and
    // well before the tool finishes executing. `null`/`undefined` means
    // "known to have no input" (the placeholder logic covers that on
    // its own); don't ship a literal "null" chunk for it.
    if (sanitizedInput !== null && sanitizedInput !== undefined) {
      this.emit('tool_input_delta', {
        messageId,
        toolUseId,
        partialJson: JSON.stringify(sanitizedInput),
      })
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
      // (#7346: reuses the same `toolUseId` computed above — one fallback
      // derivation, not two.)
      // #7340: this records the MODEL'S REQUEST (`run_in_background`) into
      // `background`. It does NOT exempt the agent from the turn-end sweep —
      // `backgroundConfirmed` does, and only `task_started` can set that.
      // (On this provider nothing is exempted at all; see the `result` branch.)
      // Whichever signal lands first wins via `_trackAgent`'s upgrade.
      this._trackAgent({
        toolUseId,
        description: semantics.payload.description,
        background: semantics.payload.background,
      })
    }
    // #8153: EnterPlanMode / ExitPlanMode wiring, mirroring CliSession's
    // _applyToolInputSemantics. `permissionMode: 'plan'` is a literal
    // `--permission-mode plan` pass-through to the same `claude` CLI binary
    // CliSession spawns (query() execs `pathToClaudeCodeExecutable`, #7986),
    // so the native read-only enforcement and EnterPlanMode/ExitPlanMode tool
    // calls are identical on both providers — only the event wiring was
    // missing here. Unlike CliSession (which buffers `toolInputChunks` across
    // stream deltas), SdkSession receives the full `block.input` directly, so
    // there is no overflow-discard case to special-case.
    if (semantics.kind === 'enter_plan') {
      this._inPlanMode = true
      this.emit('plan_started')
    } else if (semantics.kind === 'exit_plan') {
      this._planAllowedPrompts = semantics.payload.allowedPrompts
    }
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
   * @param {Set<string>|null} [ownedShellIds] - #8302: the calling turn's set;
   *   every shell newly tracked here is added to it.
   * @private
   */
  _recordBackgroundShellsFromToolResults(content, ownedShellIds = null) {
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
      // #8302: remember which turn started it, so that turn's end can release it.
      if (this.trackBackgroundShell({ shellId, command, outputPath })) ownedShellIds?.add(shellId)
    }
  }

  /**
   * In-process permission handler for canUseTool callback.
   * Delegates to the PermissionManager.
   */
  _handlePermission(toolName, input, signal, suggestions, toolUseId = undefined) {
    return this._trackPermissionDecision(
      toolUseId,
      this._permissions.handlePermission(toolName, input, signal, this.permissionMode, suggestions, toolUseId),
    )
  }

  /**
   * #8363: follow a permission decision from the moment the provider asks until
   * it settles, so `interrupt()` knows which tool calls Stop caught mid-prompt.
   * Passes the decision through unchanged. An `allow` removes the call from the
   * stopped set again: if the user approved it in the instant between Stop and
   * the abort, the tool may run and its result is a real one.
   * @param {string|undefined} toolUseId
   * @param {Promise<{behavior: string}>} decision
   * @returns {Promise<{behavior: string}>}
   */
  _trackPermissionDecision(toolUseId, decision) {
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) return decision
    this._pendingPermissionToolUseIds.add(toolUseId)
    // #8430: asked AFTER the user's Stop but before the SDK's abort landed. The
    // snapshot in `interrupt()` could not see it; the abort that is coming will
    // cancel it all the same, so it joins the set here. One flag serves this and
    // the permission manager's `stopped` reason.
    if (this._permissions.isUserStopInFlight()) this._stopCancelledToolUseIds.add(toolUseId)
    const settled = (result) => {
      this._pendingPermissionToolUseIds.delete(toolUseId)
      if (result?.behavior === 'allow') this._stopCancelledToolUseIds.delete(toolUseId)
    }
    return Promise.resolve(decision).then(
      (result) => { settled(result); return result },
      (err) => { settled(undefined); throw err },
    )
  }

  /**
   * #8363: the termination reason for a provider `tool_result`, or undefined.
   * Consulted by `emitToolResults` for every result block. A result is a Stop's
   * when the call's permission prompt was still pending at the moment Stop was
   * pressed and the provider's block is an error (the denial it wrote itself).
   * Single-use: the id is dropped on the way out.
   * @param {string} toolUseId
   * @param {{is_error?: boolean}} block
   * @returns {string|undefined}
   */
  _terminatedReasonForToolResult(toolUseId, block) {
    if (!this._stopCancelledToolUseIds.delete(toolUseId)) return undefined
    return block?.is_error === true ? 'user_stop_before_run' : undefined
  }

  /**
   * SDK PreToolUse bridge for Auto turns (#7825). The hook contract supplies
   * the same tool name/input that canUseTool receives, but its response uses
   * hookSpecificOutput rather than PermissionResult.
   */
  async _handleAutoPreToolUse(hookInput, signal, hookToolUseId = undefined) {
    const toolName = hookInput?.tool_name
    const input = hookInput?.tool_input
    if (typeof toolName !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Malformed tool request',
        },
      }
    }

    // #8336: the provider's id for this tool call -- the hook's second argument,
    // else the same id on the hook payload.
    const toolUseId = typeof hookToolUseId === 'string' && hookToolUseId.length > 0
      ? hookToolUseId
      : hookInput?.tool_use_id
    const result = await this._trackPermissionDecision(
      toolUseId,
      this._permissions.handlePermission(toolName, input, signal, this.permissionMode, undefined, toolUseId),
    )
    const allow = result?.behavior === 'allow'
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allow ? 'allow' : 'deny',
        ...(allow && result.updatedInput ? { updatedInput: result.updatedInput } : {}),
        ...(!allow ? { permissionDecisionReason: result?.message || 'Permission denied' } : {}),
      },
    }
  }

  /**
   * Resolve a pending permission request (called by WsServer when
   * the app sends permission_response).
   */
  respondToPermission(requestId, decision, editedInput, reason) {
    return this._permissions.respondToPermission(requestId, decision, editedInput, reason)
  }

  /**
   * Send a response to an AskUserQuestion prompt.
   * In SDK mode, the canUseTool callback is holding a Promise open.
   * This method resolves it with the user's answer as structured updatedInput.
   */
  respondToQuestion(text, answersMap, toolUseId) {
    // #8460: the id lets the manager refuse an answer meant for a different question.
    return this._permissions.respondToQuestion(text, answersMap, toolUseId)
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
    // #3729: switching TO auto drains ordinary pending permission prompts so
    // the user isn't left staring at stale modals. PermissionManager preserves
    // protected-path prompts because the floor still applies in Auto.
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
   * #6771 — durable (project-scoped) permission rules currently applied to this
   * session, tagged `persist:'project'`. Delegates to PermissionManager.
   * @returns {Array<{tool: string, decision: string, persist: 'project'}>}
   */
  getPersistentPermissionRules() {
    if (typeof this._permissions.getPersistentRules === 'function') {
      return this._permissions.getPersistentRules()
    }
    return []
  }

  /**
   * #6771 — re-seed this session's in-memory durable rule set (does NOT persist;
   * the caller owns the store write). Delegates to PermissionManager.
   * @param {Array<{tool: string, decision: string}>} rules
   */
  setPersistentPermissionRules(rules) {
    if (typeof this._permissions.setPersistentRules === 'function') {
      this._permissions.setPersistentRules(rules)
    }
  }

  /**
   * Set thinking level by adjusting max thinking tokens.
   * A key of `SdkSession.THINKING_BUDGETS` — the Claude budget table. An
   * unknown key resolves to a null budget (adaptive), so this method never
   * rejects: the per-model membership decision belongs to the
   * `set_thinking_level` handler, which knows the session's model (#7730).
   * @param {string} level
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
    // #7340: the agent half is BaseSession's `_completeAgent` (idempotent, and
    // the single implementation shared with CliSession and ByokSession). This
    // wrapper adds only the SDK-specific task-id mapping cleanup above.
    this._completeAgent(toolUseId)
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
    this._noteTurnStopRequested() // #7376
    // #8363: every permission prompt still waiting is about to be resolved by the
    // abort, not by the user. Snapshot them BEFORE the abort -- the SDK writes the
    // tool_result for each as soon as it sees the interrupt, which can be before
    // this session's abort listeners have run.
    //
    // Only a prompt that is STILL waiting. A decision delivered in this same
    // synchronous tick (the scheduler denies, then interrupts, back to back) has
    // already left the permission manager's pending state, though its id leaves
    // `_pendingPermissionToolUseIds` a microtask later; that call was refused,
    // not stopped.
    for (const id of this._pendingPermissionToolUseIds) {
      if (this._permissions.hasPendingForToolUse(id)) this._stopCancelledToolUseIds.add(id)
    }

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
    // #7376: name the cause so a tool left in flight reads as "the turn was
    // terminated under it", not as a failed command.
    this._clearMessageState({ terminatedReason: 'hard_timeout' })
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
    this._clearMessageState({ terminatedReason: 'stream_stall' }) // #7376
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
  // #7340: forward the opts to super. `turnEndedCleanly` decides whether a
  // confirmed-backgrounded subagent survives BaseSession's turn-end sweep;
  // an override that drops it silently disables the exemption.
  _clearMessageState(opts) {
    super._clearMessageState(opts)
    this._permissions.clearAll()
    // Pause counter is tied to the previous message — reset so the next
    // message starts with a fresh counter.
    this._permissionPauseCount = 0
    this._resultTimeoutPaused = false
    this._resetResultTimeout = null
    // #8153: mirrors CliSession's stale-flag reset. If plan mode is active
    // but ExitPlanMode never arrived (interrupt/crash), the flag is stale —
    // reset it. In normal flow, _planAllowedPrompts is non-null (set by
    // ExitPlanMode) and plan_ready has already been emitted + both flags
    // reset before we reach here (see the 'result' case in _callQuery).
    if (this._inPlanMode && this._planAllowedPrompts === null) {
      this._inPlanMode = false
    }
    this._planAllowedPrompts = null
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

    // #8300: release the turn's streaming input first, so the CLI's stdin
    // closes even if the message loop never gets to observe `_destroying`
    // (it is parked on the generator's next message).
    if (this._turnInput) {
      this._turnInput.end()
      this._turnInput = null
    }

    // Interrupt active query, then close it: with the input released an idle
    // CLI exits on its own, but one kept alive by background work would not,
    // and the parked message loop would never end (#8300).
    if (this._query) {
      const q = this._query
      this._query = null
      q.interrupt().catch((err) => {
        // The close below rejects the pending interrupt ("Query closed
        // before response received"); that is the expected outcome here.
        const expected = /closed before/i.test(err?.message || '')
        // #4828: session-scoped when init has fired.
        ;(this._log || log)[expected ? 'debug' : 'warn'](`Failed to interrupt active query: ${err.message} (non-critical, session destroying)`)
      })
      try {
        if (typeof q.close === 'function') q.close()
      } catch (err) {
        ;(this._log || log).warn(`Failed to close query on destroy: ${err?.message || err}`)
      }
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
