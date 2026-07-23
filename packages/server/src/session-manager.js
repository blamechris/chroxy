import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { statSync, mkdirSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { getProvider, getProviderAuthInfo, DEFAULT_PROVIDER } from './providers.js'
import { isClaudeProvider } from './models.js'
import { billingClassForProvider, BILLING_CLASSES } from './billing-class.js'
import { MonthlyProgrammaticBudgetManager } from './billing-budget.js'
import { runProviderPreflight, ProviderBinaryNotFoundError, ProviderBinaryQuarantinedError, ProviderCredentialMissingError } from './utils/preflight.js'
import { GIT } from './git.js'
import { sweepOrphanChroxyWorktrees } from './worktree-gc.js'
import { resolveJsonlPath, readConversationHistoryAsync } from './jsonl-reader.js'
import { readSessionContext } from './session-context.js'
import { parseDuration, isOperatorTimeoutInRange } from './duration.js'
import { SessionLockManager } from './session-lock.js'
import { CostBudgetManager } from './cost-budget-manager.js'
import { SessionStatePersistence } from './session-state-persistence.js'
import { SessionTimeoutManager, formatIdleDuration } from './session-timeout-manager.js'
import { SessionMessageHistory } from './session-message-history.js'
import { SkillsUsageRecorder } from './skills-usage.js'
import { resolveSessionPreset, foldPreamble } from './session-preset.js'
import { SessionPresetTrustStore } from './session-preset-trust.js'
import { PermissionRuleStore } from './permission-rule-store.js'
import { ScheduledTaskStore, defaultScheduledTasksPath } from './scheduled-task-store.js'
import { createLogger } from './logger.js'
import { ExternalSessionRegistry } from './external-session-registry.js'
import { metrics } from './metrics.js'
import { auditShellDestroy } from './shell-audit.js'
import { recordShell, forgetShell, reapOrphanShells } from './user-shell-registry.js'
import { getErrorMessage } from './utils/error-message.js'
import {
  forwardPerSessionSettingsToProviderOpts,
  serializePerSessionSettings,
  restorePerSessionSettings,
} from './per-session-settings.js'

const log = createLogger('session-manager')
const DEFAULT_STATE_FILE = join(homedir(), '.chroxy', 'session-state.json')
// #5982 — grace before auto-removing an exited user-shell session, so a live
// viewer sees the "[shell exited]" marker before the session vanishes.
const AUTO_REMOVE_ON_EXIT_DELAY_MS = 1500

/**
 * Zero-initialized cumulative usage record (#4072). Lives on the session
 * entry; increments on every priced `result` event. Field names are
 * camelCase here even though the SDK delivers snake_case usage — the
 * client-facing API (`session_usage` event, `listSessions()` snapshot)
 * uses camelCase to match chroxy's protocol convention.
 */
function makeZeroCumulativeUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turnsBilled: 0,
  }
}

/**
 * Base error class for session management operations.
 */
export class SessionError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}

/**
 * Thrown when maximum session limit is reached.
 */
export class SessionLimitError extends SessionError {
  constructor(maxSessions) {
    super(`Maximum sessions (${maxSessions}) reached`, 'SESSION_LIMIT_REACHED')
    this.name = 'SessionLimitError'
    this.maxSessions = maxSessions
  }
}

/**
 * Thrown when session directory validation fails.
 */
export class SessionDirectoryError extends SessionError {
  constructor(message, path) {
    super(message, 'INVALID_DIRECTORY')
    this.name = 'SessionDirectoryError'
    this.path = path
  }
}

/**
 * #5985 (epic #5982): thrown when a `user-shell` session is requested but the
 * server has not opted in (`userShell.enabled !== true`). Secure-by-default —
 * a user shell is arbitrary code execution on the dev machine, so it is off
 * until an explicit local config edit enables it.
 */
export class UserShellDisabledError extends SessionError {
  constructor() {
    super(
      'User-shell sessions are disabled on this server. To enable, set userShell.enabled:true in the server config file (requires local filesystem access). Default is disabled for security.',
      'USER_SHELL_DISABLED'
    )
    this.name = 'UserShellDisabledError'
  }
}

/**
 * Thrown when worktree creation fails (e.g. non-git directory).
 */
export class WorktreeError extends SessionError {
  constructor(message) {
    super(message, 'WORKTREE_ERROR')
    this.name = 'WorktreeError'
  }
}

/**
 * Thrown when an initial session model is not valid for the selected provider.
 */
export class ProviderModelNotSupportedError extends SessionError {
  constructor({ provider, model, supported }) {
    const suffix = Array.isArray(supported) && supported.length > 0
      ? ` Supported models: ${supported.join(', ')}.`
      : ''
    super(`Model '${model}' is not supported by provider '${provider}'.${suffix}`, 'MODEL_NOT_SUPPORTED_BY_PROVIDER')
    this.name = 'ProviderModelNotSupportedError'
    this.provider = provider
    this.model = model
    this.supported = supported || []
  }
}

/**
 * Default base directory for session worktrees.
 * @type {string}
 */
const DEFAULT_WORKTREE_BASE = join(homedir(), '.chroxy', 'worktrees')

/**
 * Manages the lifecycle of multiple CLI sessions.
 *
 * Events emitted:
 *   session_event     { sessionId, event, data }   — proxied from each session
 *     Events: ready, stream_start, stream_delta, stream_end, message, tool_start, result, error
 *   session_created   { sessionId, name, cwd }
 *   session_destroyed { sessionId }
 *   session_updated   { sessionId, name }
 *   session_warning   { sessionId, name, reason, message, remainingMs } — session nearing idle timeout
 *   session_timeout   { sessionId, name, idleMs } — session destroyed due to idle timeout
 *   session_restore_failed { sessionId, name, provider, cwd, model, permissionMode, errorCode, errorMessage, originalHistoryPreserved, historyLength }
 *     — emitted when a session in the persisted state file fails to restore (e.g. missing env var).
 *       History on disk is preserved so the user can retry after fixing the underlying issue.
 *   session_create_failed { sessionId, name, provider, cwd, model, errorCode, errorMessage } — #5731 T6:
 *     a FRESH session whose async provider start() rejected (e.g. claude-tui's PTY failed to spawn).
 *     The session is fully destroyed (no history to preserve); this carries the reason so the
 *     forwarder can surface a `session_error` toast before the `session_destroyed` lands.
 *   session_persist_failed { sessionId, name } — #5701: a synchronous flush of a
 *     session-list mutation (create/rename/destroy) failed to write to disk
 *     (disk full / locked file / read-only home), so the change may be lost on
 *     restart. Observable signal; a client-facing surface is a follow-up.
 */

// Re-export formatIdleDuration from SessionTimeoutManager for backward compatibility
export { formatIdleDuration }

// Re-export preflight errors so call sites that catch createSession() failures
// can detect/branch on PROVIDER_BINARY_NOT_FOUND / PROVIDER_BINARY_QUARANTINED /
// PROVIDER_CREDENTIAL_MISSING without taking a separate dependency on
// utils/preflight.js.
export { ProviderBinaryNotFoundError, ProviderBinaryQuarantinedError, ProviderCredentialMissingError }

/**
 * @typedef {Object} SessionManagerConfig
 *
 * Server identity
 * @property {number}  [port]                    - Server port (used in push notification metadata)
 * @property {string}  [apiToken]                - API token for authentication
 *
 * Session defaults
 * @property {number}  [maxSessions=5]           - Maximum concurrent sessions
 * @property {string}  [defaultCwd]              - Default working directory (falls back to process.cwd())
 * @property {string}  [defaultModel]            - Default Claude model identifier
 * @property {string}  [defaultPermissionMode='approve'] - Default permission mode
 * @property {boolean} [defaultSkipPermissions=false] - Default for `skipPermissions` on
 *                                                       createSession() — used to seed the
 *                                                       auto-created Default session at boot
 *                                                       when the server was launched with
 *                                                       `chroxy start --dangerously-skip-permissions`
 *                                                       (#4209). TUI-only at the spawn site;
 *                                                       other providers ignore it harmlessly.
 * @property {string}  [providerType='claude-sdk'] - Provider type from providers.js registry
 *
 * Session behavior
 * @property {string}  [sessionTimeout]          - Idle timeout duration string (e.g. '30m', '2h'), parsed by parseDuration()
 * @property {number}  [maxToolInput]            - Max characters for tool input display
 * @property {Array}   [transforms=[]]           - Message transform functions
 * @property {object}  [sandbox]                 - SDK sandbox settings for lightweight isolation
 * @property {number}  [costBudget]              - Per-session cost budget in dollars (e.g. 5.00).
 *                                                  Applied independently to each session; not a shared/global pool.
 *
 * State persistence
 * @property {string}  [stateFilePath]           - Path to session state JSON file (default: ~/.chroxy/session-state.json)
 * @property {number}  [stateTtlMs]              - Max age of persisted state before discard (default: 24 hours)
 * @property {number}  [persistDebounceMs=2000]  - Debounce interval for state file writes
 *
 * Message history
 * @property {number}  [maxMessages=1000]        - Max history messages per session (alias: maxHistory)
 * @property {number}  [maxHistory]              - Legacy alias for maxMessages
 */
export class SessionManager extends EventEmitter {
  /**
   * @param {SessionManagerConfig} config
   */
  constructor({
    // Server identity
    port,
    apiToken,

    // Session defaults
    maxSessions = 5,
    defaultCwd,
    defaultModel,
    defaultPermissionMode,
    // #4209: opt-in default for skipPermissions on the auto-created Default
    // session and for any createSession() call that omits the field. Plumbed
    // through from `chroxy start --dangerously-skip-permissions` so the
    // TUI session boots already in unmediated mode without requiring the
    // dashboard checkbox round-trip.
    defaultSkipPermissions = false,
    // #5985 (epic #5982): gate for the embedded user-shell terminal. When false
    // (default — secure-by-default), createSession rejects a `user-shell`
    // provider with UserShellDisabledError. Wired from `isUserShellEnabled(config)`
    // in server-cli. Enforced HERE (not in the WS handler) so it covers every
    // spawn path — WS create, restoreState, and any internal caller — per the
    // #5985 swarm-audit C3 finding.
    userShellEnabled = false,
    // #6378: provider names that opt OUT of static model-allowlist validation
    // at create time (config.providers.allowAnyModel) — an unlisted-but-API-
    // valid model id passes through verbatim instead of throwing
    // ProviderModelNotSupportedError, so a new model needs no release. A Set of
    // strings; wired from `getAllowAnyModelProviders(config)` in server-cli.
    // Default empty → OFF (strict validation, the secure default).
    allowAnyModelProviders = new Set(),
    // #6276 test seam: inject {isAlive, commOf, kill} for the boot-time
    // orphan-shell reaper so the reap+audit path is exercisable without
    // signalling a real process. Undefined in production → the reaper uses its
    // own defaults (process.kill / ps).
    userShellReapSeams = undefined,
    // Shadowed in production (server-cli.js always passes providerType
    // explicitly), but kept on the single source of truth so the fallback
    // can't silently diverge from the server's default (#5819).
    providerType = DEFAULT_PROVIDER,

    // Session behavior
    sessionTimeout,
    maxToolInput,
    transforms,
    sandbox,
    costBudget,
    // #4075: per-session "you've spent $X" soft warning. Distinct from
    // `costBudget` (which hard-blocks at the cap). Fires once per session
    // per crossing; subscription-billed providers never trigger it
    // because their cumulativeUsage.costUsd stays at 0.
    // Default: 5.00 (USD). Set to 0 to DISABLE. Omitting the field, or
    // passing null/undefined/NaN/Infinity/negative, falls back to the
    // 5.00 default (see _normalizeCostThreshold).
    costThresholdUsd,
    // #5665: the `billing` config block (creditTier / monthlyCreditBudgetUsd /
    // budgetWarningPercent) driving the monthly programmatic-credit meter.
    billing,
    maxSkillBytes,
    maxTotalSkillBytes,
    providerSkillAllowlist,
    trustMismatchMode,
    resultTimeoutMs,
    // #3899: HARD-cap inactivity timeout (ms). Forwarded to providers via
    // providerOpts. null = use BaseSession's DEFAULT_HARD_TIMEOUT_MS (2h).
    hardTimeoutMs,
    // #4467: stream-stall recovery timeout (ms). Forwarded via providerOpts.
    // null = use BaseSession's DEFAULT_STREAM_STALL_TIMEOUT_MS (5min).
    streamStallTimeoutMs,
    // #5288: background-shell HARD-quiesce window (ms). Forwarded via
    // providerOpts. null = use BaseSession's BACKGROUND_SHELL_HARD_QUIESCE_MS
    // (4h); 0 disables hard-reaping (advisory-only, #5247 behaviour).
    backgroundShellHardQuiesceMs,
    // #4601: per-provider override map for streamStallTimeoutMs. Keys are
    // provider ids (e.g. 'codex', 'gemini'); values are stall windows in
    // ms (or 0 to disable for that provider). When a session is created
    // for a provider listed here, that entry wins over the global
    // `streamStallTimeoutMs`; otherwise the global value (or BaseSession
    // default) applies. Each entry is validated with the same allowZero
    // + MAX_SANE_DURATION_MS ceiling as `streamStallTimeoutMs` — bogus
    // entries are dropped (with a warn) and the call falls through to
    // the global value, so a single mis-typed entry can't silently
    // produce a >24h timer.
    providerStreamStallTimeoutMs,
    // #4482: per-MCP-call timeout (ms). Forwarded via providerOpts to
    // byok-session, which threads it into MCPFleet.callTool. null = use
    // byok-mcp-client's DEFAULT_TOOL_CALL_TIMEOUT_MS (30s).
    mcpToolCallTimeoutMs,
    // #4456: wall-clock cap on MCPFleet.start() (ms). Forwarded via
    // providerOpts to byok-session, which threads it into the MCPFleet
    // constructor. null = use byok-mcp-fleet's DEFAULT_FLEET_START_CAP_MS
    // (1500ms). Bounds the worst-case session-start latency on a broken
    // MCP config — see byok-mcp-fleet.MCPFleet.start() for the trade-off.
    mcpStartCapMs,

    // State persistence
    stateFilePath,
    stateTtlMs,
    persistDebounceMs = 2000,

    // #5554: per-skill usage recorder. Records which skills activate in each
    // session, powering the Control Room Skills tab's "previously used" surface.
    // Tests pass their own (temp-pathed) recorder; production wires a default
    // whose file sits next to the session-state file (so a temp stateFilePath
    // keeps the usage log out of the real ~/.chroxy too).
    skillsUsageRecorder,

    // #5553: trust ledger for repo-local session presets
    // (.chroxy/session.json). Tests pass their own temp-pathed store; production
    // wires a default whose file sits next to the session-state file so a temp
    // stateFilePath also redirects the ledger out of the real ~/.chroxy.
    presetTrustStore,
    // #5553: config path for the daemon-side preset override map. Tests point
    // this at a temp config.json; production uses the default ~/.chroxy/config.json.
    presetConfigPath,
    // #6771: durable per-project permission rule store (persistent "always
    // allow / deny"). Tests pass their own temp-pathed store; production wires a
    // default whose file (permission-rules.json) sits next to the session-state
    // file so a temp stateFilePath keeps it out of the real ~/.chroxy.
    permissionRuleStore,

    // #6862: durable scheduled-task registry (standing schedules that run on a
    // future/recurring cadence — SEPARATE from live session state and from the
    // intra-session ScheduleWakeup). Tests pass their own temp-pathed store;
    // production wires a default whose file (scheduled-tasks.json) sits next to
    // the session-state file so a temp stateFilePath keeps it out of the real
    // ~/.chroxy. No firing here — the engine is a sibling slice (#6865).
    scheduledTaskStore,

    // Message history
    maxMessages,
    maxHistory,

    // #5859 (audit P1-7): opt-in boot-time sweep of orphaned chroxy session
    // worktrees (dirs under the worktree base whose session id is no longer
    // live). Off by default — server-cli enables it from config.worktreeGc.autoReap,
    // mirroring the agent-worktree reaper's opt-in. Always clean-tree-guarded.
    sweepOrphanWorktrees = false,

    // Test-only: skip preflight checks (binary + credential). Production must
    // leave this false so missing providers surface cleanly at createSession.
    skipPreflight = false,
  } = {}) {
    super()

    // Server identity
    this._port = port || null
    this._apiToken = apiToken || null
    this._skipPreflight = skipPreflight

    // Session defaults
    this.maxSessions = maxSessions
    this._defaultCwd = defaultCwd || process.cwd()
    this._defaultModel = defaultModel || null
    this._defaultPermissionMode = defaultPermissionMode || 'approve'
    // #4209: coerced to a strict boolean so a non-boolean from config can't
    // partially enable the flag. Forwarded to providerOpts.skipPermissions
    // for every createSession() call that omits the field.
    this._defaultSkipPermissions = !!defaultSkipPermissions
    // #5985: strict `=== true` (not `!!`) so the fail-closed / no-coercion
    // contract holds at the SessionManager layer too — a direct caller passing
    // a truthy non-boolean (`'true'`, `1`) must NOT open the shell gate. Matches
    // isUserShellEnabled()'s strictness; production passes that helper's boolean.
    this._userShellEnabled = userShellEnabled === true
    // #6378: normalize to a Set so `.has()` is always safe even if a caller
    // passes undefined/null/array. Default = empty Set (strict validation).
    this._allowAnyModelProviders = allowAnyModelProviders instanceof Set
      ? allowAnyModelProviders
      : new Set(Array.isArray(allowAnyModelProviders) ? allowAnyModelProviders : [])
    this._userShellReapSeams = userShellReapSeams
    this._sweepOrphanWorktrees = !!sweepOrphanWorktrees
    this._providerType = providerType

    // Session behavior
    this._maxToolInput = maxToolInput || null
    this._transforms = transforms || []
    this._sandbox = sandbox || null
    // #3749: per-server inactivity timeout (ms) forwarded to providers
    // via providerOpts. null = use BaseSession's DEFAULT_RESULT_TIMEOUT_MS.
    //
    // #4509: the ceiling check inside `isOperatorTimeoutInRange` mirrors the
    // wire-side guard #4503 added to `ws-history.js sendPostAuthInfo`. An
    // operator typo (`CHROXY_RESULT_TIMEOUT_MS=99999999999`, extra digit)
    // would otherwise pass `Number.isFinite > 0` here and silently produce a
    // >24h internal inactivity timer; the helper instead falls back to null
    // (→ BaseSession default) and warns once.
    this._resultTimeoutMs =
      isOperatorTimeoutInRange(resultTimeoutMs, { name: 'resultTimeoutMs', log })
        ? resultTimeoutMs
        : null
    // #3899: same shape as resultTimeoutMs — null means "let BaseSession
    // use DEFAULT_HARD_TIMEOUT_MS (2h)"; a positive finite value (≤ ceiling)
    // flows through providerOpts to each session subclass.
    this._hardTimeoutMs =
      isOperatorTimeoutInRange(hardTimeoutMs, { name: 'hardTimeoutMs', log })
        ? hardTimeoutMs
        : null
    // #4467: 0 explicitly disables stream-stall recovery; null = use default;
    // positive finite value sets the recovery window. `allowZero: true` keeps
    // the explicit-disable behaviour intact while #4509's ceiling gate clamps
    // pathological over-24h values back to the default.
    this._streamStallTimeoutMs =
      isOperatorTimeoutInRange(streamStallTimeoutMs, { allowZero: true, name: 'streamStallTimeoutMs', log })
        ? streamStallTimeoutMs
        : null
    // #5288: background-shell hard-quiesce window. `allowZero: true` keeps 0 as
    // "disable hard-reaping"; null falls through to BaseSession's 4h default.
    // Same ceiling guard as the timeouts (over-24h falls back + warns).
    this._backgroundShellHardQuiesceMs =
      isOperatorTimeoutInRange(backgroundShellHardQuiesceMs, { allowZero: true, name: 'backgroundShellHardQuiesceMs', log })
        ? backgroundShellHardQuiesceMs
        : null
    // #4601: sanitise the per-provider override map at construction time —
    // each entry runs through the same `isOperatorTimeoutInRange` guard as
    // the global value (`allowZero: true` + 24h ceiling). Bad entries are
    // dropped and the warn log identifies which provider's entry was
    // ignored so an operator can correlate it back to their config.json
    // key path. Storing the SANITISED map means createSession() doesn't
    // have to re-validate on every session boot.
    this._providerStreamStallTimeoutMs = this._sanitizeProviderTimeoutMap(
      providerStreamStallTimeoutMs,
      { name: 'providerStreamStallTimeoutMs', allowZero: true },
    )
    // #4482: per-MCP-call timeout. Unlike streamStallTimeoutMs, 0 is not a
    // valid disable here — a 0-ms callTool timeout fires immediately. Only
    // positive finite values are accepted; null falls through to byok-mcp-
    // client's 30s default.
    // #4517: ceiling check via `isOperatorTimeoutInRange` (same as the three
    // sibling timeouts in #4509) — a typoed CHROXY_MCP_TOOL_CALL_TIMEOUT_MS
    // (extra digit / accidental exponent) falls back to null and warns.
    this._mcpToolCallTimeoutMs =
      isOperatorTimeoutInRange(mcpToolCallTimeoutMs, { name: 'mcpToolCallTimeoutMs', log })
        ? mcpToolCallTimeoutMs
        : null
    // #4456: same defensive shape as mcpToolCallTimeoutMs — only positive
    // finite values are forwarded; bogus values fall back to the fleet's
    // default cap. 0 is rejected (a 0 ms cap would fire before any
    // handshake could complete).
    this._mcpStartCapMs =
      Number.isFinite(mcpStartCapMs) && mcpStartCapMs > 0
        ? mcpStartCapMs
        : null
    this._costBudget = new CostBudgetManager({ budget: costBudget })
    // #4075: per-session crossing threshold. Stored as a runtime-mutable
    // field so the settings panel can update it without restarting the
    // server. Operators set this via setCostThresholdUsd() to pin the
    // soft warning point (default $5).
    this._costThresholdUsd = this._normalizeCostThreshold(costThresholdUsd, 5.00)
    // Skills size budgets (#3202). null = use loader defaults (32KB / 256KB).
    // Setting either to 0 in config disables that cap.
    this._maxSkillBytes = Number.isFinite(maxSkillBytes) ? maxSkillBytes : null
    this._maxTotalSkillBytes = Number.isFinite(maxTotalSkillBytes) ? maxTotalSkillBytes : null
    // Per-provider skill allowlist (#3207). Stored verbatim and forwarded
    // to BaseSession via providerOpts; the loader applies the gate after
    // the per-skill / per-budget filters so an out-of-allowlist skill is
    // dropped before its body reaches the prompt. `null` (or any
    // non-object) means "no allowlist configured" — keeps the legacy
    // permissive behaviour.
    this._providerSkillAllowlist = (
      providerSkillAllowlist && typeof providerSkillAllowlist === 'object' && !Array.isArray(providerSkillAllowlist)
    )
      ? providerSkillAllowlist
      : null
    // Skill content-hash trust mode (#3204). One of 'warn' / 'block' /
    // null. Null = trust check disabled (the loader skips hashing
    // entirely; behaviour identical to the pre-#3204 server). Operators
    // opt in via the `trustMismatchMode` config key. Tests that don't
    // pass this option keep the legacy no-op behaviour, so the default
    // trust file at ~/.chroxy/skills-trust.json is never touched
    // unless explicitly enabled.
    this._trustMismatchMode = (trustMismatchMode === 'warn' || trustMismatchMode === 'block')
      ? trustMismatchMode
      : null

    // State persistence (delegated to SessionStatePersistence)
    this._persistence = new SessionStatePersistence({
      stateFilePath: stateFilePath || DEFAULT_STATE_FILE,
      stateTtlMs,
      persistDebounceMs,
    })
    // Backward-compatible accessors for tests that reference internal state
    this._stateFilePath = this._persistence._stateFilePath
    // #6276: orphan-shell reaper sidecar, colocated with the state file so a
    // test's temp stateFilePath keeps it out of the real ~/.chroxy.
    this._userShellSidecarPath = join(dirname(this._stateFilePath), 'user-shells.json')
    this._stateTtlMs = this._persistence._stateTtlMs
    this._persistDebounceMs = this._persistence._persistDebounceMs

    // #5554: usage recorder. Use the caller-supplied one (tests pin a temp
    // path), else default to a file alongside the session-state file so a temp
    // stateFilePath also redirects the usage log away from the real home — the
    // sandbox guard (#4633) then never fires from a SessionManager constructed
    // with a temp stateFilePath.
    this.skillsUsageRecorder = skillsUsageRecorder
      || new SkillsUsageRecorder({ filePath: join(dirname(this._stateFilePath), 'skills-usage.json') })
    // #5665: monthly programmatic-credit budget meter. Its running-total state
    // file sits next to the session-state file (same temp-redirect reasoning as
    // skillsUsageRecorder), so a test's temp stateFilePath keeps it out of the
    // real ~/.chroxy and the sandbox guard never fires.
    this._creditBudget = new MonthlyProgrammaticBudgetManager({
      billingConfig: billing || {},
      statePath: join(dirname(this._stateFilePath), 'monthly-budget-state.json'),
    })
    // #5553: per-repo session-preset trust ledger. Same temp-redirect logic as
    // skillsUsageRecorder — the default file sits next to the session-state
    // file so a test's temp stateFilePath keeps the ledger out of the real home.
    this.presetTrustStore = presetTrustStore
      || new SessionPresetTrustStore({ filePath: join(dirname(this._stateFilePath), 'session-preset-trust.json') })
    // Config path the preset resolver reads the daemon override map from.
    // Defaults to undefined → resolveSessionPreset uses its own DEFAULT_CONFIG_PATH.
    this.presetConfigPath = typeof presetConfigPath === 'string' ? presetConfigPath : null
    // #6771: durable per-project permission rule store. Same temp-redirect logic
    // as the sidecars above — the default file sits next to the session-state
    // file so a test's temp stateFilePath keeps the rules out of the real home.
    // Only the DEFAULT store is loaded here (so restored + newly-created sessions
    // in a known cwd seed their persistent rules from prior grants); a
    // caller-supplied store owns its own load() lifecycle.
    if (permissionRuleStore) {
      this.permissionRuleStore = permissionRuleStore
    } else {
      this.permissionRuleStore = new PermissionRuleStore({ filePath: join(dirname(this._stateFilePath), 'permission-rules.json') })
      this.permissionRuleStore.load()
    }
    // #6862: durable scheduled-task registry. Same temp-redirect logic as the
    // sidecars above — the default file sits next to the session-state file so a
    // test's temp stateFilePath keeps schedules out of the real home. Loaded once
    // here on daemon start; a caller-supplied store owns its own load() lifecycle.
    // Nothing fires it — the store just persists tasks + computes next-run; the
    // engine slice (#6865) reads it off `sessionManager.scheduledTaskStore`.
    if (scheduledTaskStore) {
      this.scheduledTaskStore = scheduledTaskStore
    } else {
      this.scheduledTaskStore = new ScheduledTaskStore({ filePath: defaultScheduledTasksPath(this._stateFilePath) })
      this.scheduledTaskStore.load()
    }
    Object.defineProperty(this, '_persistTimer', {
      get: () => this._persistence._persistTimer,
      set: (v) => { this._persistence._persistTimer = v },
      enumerable: false,
      configurable: true,
    })

    // Message history (delegated to SessionMessageHistory)
    this._history = new SessionMessageHistory({ maxMessages: maxMessages ?? maxHistory, maxToolInput })
    // Backward-compatible accessors for tests that reference internal state
    this._maxHistory = this._history.maxHistory
    this._messageHistory = this._history._messageHistory
    this._pendingStreams = this._history.pendingStreams
    this._historyTruncated = this._history._historyTruncated

    // Wire auto_label events from history to session_updated emissions
    this._history.on('auto_label', ({ sessionId, label }) => {
      this.emit('session_updated', { sessionId, name: label })
    })

    // Internal state
    this._sessions = new Map() // sessionId -> { session, name, cwd, createdAt, agentCommId? }
    this._agentCommIds = new Map() // agentCommId -> sessionId (mailbox live-interrupt routing)
    this._mailboxEvents = [] // bounded ring buffer of recent mailbox deliveries (Control Room observability)
    this._externalSessions = new ExternalSessionRegistry() // #5969 — live external (/api/events) sessions for mission control
    this._sessionLastActivityAt = new Map() // sessionId -> last meaningful user/agent activity timestamp
    this._sessionCounter = 0   // monotonically incrementing; used for auto-naming
    this._locks = new SessionLockManager()

    // Failed-restore tracking (#2954 — Guardian FM-01): sessions whose on-disk
    // state could not be re-hydrated (e.g. missing API key env var). We keep
    // the original saved payload in-memory so serializeState() can rewrite it
    // back to disk unchanged — the user's history must not be dropped just
    // because the provider happened to be misconfigured at boot.
    this._failedRestores = new Map() // sessionId -> { saved, error }

    // Set to true by destroyAll() so any subsequent persist call is a no-op
    // — prevents a duplicate shutdown pass writing 0 sessions over the good
    // state already on disk (#3697).
    this._destroying = false

    // Session idle timeout (delegated to SessionTimeoutManager)
    const parsedTimeout = sessionTimeout ? parseDuration(sessionTimeout) : null
    if (sessionTimeout != null && parsedTimeout == null) {
      log.warn(`Invalid sessionTimeout value "${sessionTimeout}". Session timeouts are disabled.`)
    }
    this._sessionTimeoutMs = parsedTimeout
    this._timeoutManager = new SessionTimeoutManager({ sessionTimeoutMs: parsedTimeout })

    // Wire timeout manager events to SessionManager events
    this._timeoutManager.on('warning', ({ sessionId, remainingMs }) => {
      const entry = this._sessions.get(sessionId)
      if (!entry) return
      const friendly = formatIdleDuration(remainingMs)
      log.info(`Session ${sessionId} idle warning (${friendly} remaining)`)
      this.emit('session_warning', {
        sessionId,
        name: entry.name,
        reason: 'idle_timeout',
        message: `Session "${entry.name}" will be closed in ${friendly} due to inactivity`,
        remainingMs,
      })
    })

    this._timeoutManager.on('timeout', ({ sessionId, idleMs }) => {
      const entry = this._sessions.get(sessionId)
      if (!entry) return
      const friendly = formatIdleDuration(idleMs)
      log.info(`Session ${sessionId} timed out after ${friendly} idle`)
      this.emit('session_timeout', { sessionId, name: entry.name, idleMs })
      this.destroySession(sessionId)
    })

    // Wire isRunning check so timeout manager can skip busy sessions
    this._timeoutManager.setIsRunningFn((sessionId) => {
      const entry = this._sessions.get(sessionId)
      return entry ? entry.session.isRunning : false
    })

    // Validate provider exists at construction time for fail-fast behavior
    getProvider(this._providerType)
  }

  /**
   * Remove a session from all session-scoped maps and sets (#1204).
   * Called by destroySession(), sync catch, and async .catch() paths.
   * @param {string} sessionId
   */
  _cleanupSessionMaps(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (entry && entry.agentCommId) {
      this._agentCommIds.delete(entry.agentCommId)
    }
    this._sessions.delete(sessionId)
    this._sessionLastActivityAt.delete(sessionId)
    this._timeoutManager.removeSession(sessionId)
    this._history.cleanupSession(sessionId)
    this._costBudget.removeSession(sessionId)
  }

  /**
   * Register a mailbox identity (AGENT_COMM_ID) for a live session so the
   * mailbox live-interrupt route (POST /api/mailbox) can resolve agent -> session.
   * One id maps to one session: re-registering an id, or registering a new id
   * for a session, replaces the prior mapping. Returns true when the session
   * exists and was registered.
   * @param {string} sessionId
   * @param {string} agentCommId
   */
  registerAgentCommId(sessionId, agentCommId) {
    if (typeof sessionId !== 'string' || typeof agentCommId !== 'string') return false
    if (!sessionId) return false
    // Authoritative id contract (single source of truth for both the
    // POST /api/mailbox/register route and createSession's auto-register),
    // matching the route's cleanField bounds: trim, reject empty, cap length,
    // reject control chars. The trim canonicalises the stored key so an
    // untrimmed/whitespace-only id can't create a confusing/unresolvable
    // mapping. Control chars are rejected for id hygiene and parity with the
    // route — the id is only a routing key and never itself reaches the PTY
    // wakeup string (a fixed template + unread count; see mailbox-route.js).
    const id = agentCommId.trim()
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) return false
    const entry = this._sessions.get(sessionId)
    if (!entry) return false
    // Drop a prior holder of this id (id -> some other session).
    const priorSessionId = this._agentCommIds.get(id)
    if (priorSessionId && priorSessionId !== sessionId) {
      const priorEntry = this._sessions.get(priorSessionId)
      if (priorEntry && priorEntry.agentCommId === id) priorEntry.agentCommId = null
    }
    // Drop a prior id this session held (session -> some other id).
    if (entry.agentCommId && entry.agentCommId !== id) {
      this._agentCommIds.delete(entry.agentCommId)
    }
    entry.agentCommId = id
    this._agentCommIds.set(id, sessionId)
    return true
  }

  /**
   * Remove a mailbox identity mapping. Returns true when something was removed.
   * @param {string} agentCommId
   */
  unregisterAgentCommId(agentCommId) {
    if (typeof agentCommId !== 'string' || !agentCommId) return false
    const sessionId = this._agentCommIds.get(agentCommId)
    if (!sessionId) return false
    this._agentCommIds.delete(agentCommId)
    const entry = this._sessions.get(sessionId)
    if (entry && entry.agentCommId === agentCommId) entry.agentCommId = null
    return true
  }

  /**
   * Resolve the live session object registered for a mailbox id, or null.
   * @param {string} agentCommId
   */
  resolveSessionByAgentCommId(agentCommId) {
    if (typeof agentCommId !== 'string' || !agentCommId) return null
    const sessionId = this._agentCommIds.get(agentCommId)
    if (!sessionId) return null
    const entry = this._sessions.get(sessionId)
    return entry ? entry.session : null
  }

  /** Max recent mailbox delivery events retained for the Control Room snapshot. */
  static MAILBOX_EVENT_LIMIT = 50

  /**
   * Record one mailbox live-interrupt delivery attempt for the Control Room
   * "Mailbox" tab. Bounded ring buffer (oldest dropped past the limit). Pure
   * observability — never throws into the delivery path, so the caller
   * (handleMailboxPing) can fire-and-forget. Invalid input is ignored.
   * @param {{ to: string, from?: string, unreadCount?: number|null, outcome: string }} ev
   */
  recordMailboxEvent(ev) {
    if (!ev || typeof ev.to !== 'string' || typeof ev.outcome !== 'string') return
    const unreadCount =
      typeof ev.unreadCount === 'number' && Number.isInteger(ev.unreadCount) && ev.unreadCount >= 0
        ? ev.unreadCount
        : null
    this._mailboxEvents.push({
      at: Date.now(),
      to: ev.to,
      from: typeof ev.from === 'string' && ev.from ? ev.from : 'unknown',
      unreadCount,
      outcome: ev.outcome,
    })
    const overflow = this._mailboxEvents.length - SessionManager.MAILBOX_EVENT_LIMIT
    if (overflow > 0) this._mailboxEvents.splice(0, overflow)
  }

  /** Recent mailbox delivery events, newest first (a copy — safe to serialize). */
  getMailboxEvents() {
    return [...this._mailboxEvents].reverse()
  }

  /**
   * Fold one ingested external-session event (#5969) into the registry that
   * backs the Control Room mission-control read-only section. Pure
   * observability — never throws into the ingest path, so the caller
   * (handleEventIngest) can fire-and-forget. Events without a sessionId are
   * ignored by the registry.
   * @param {string} type ingest event type (session_start, user_prompt_submit, stop, subagent_start, subagent_stop, session_end, …)
   * @param {string} source the emitter source from the event envelope
   * @param {string} sessionId the external session id
   * @param {{ project?: string|null, cwd?: string|null, ts?: number }} [meta]
   */
  recordExternalSessionEvent(type, source, sessionId, meta) {
    try {
      this._externalSessions.record(type, source, sessionId, meta || {})
    } catch { /* observability only — never disturb the ingest path */ }
  }

  /** Live external (/api/events) sessions for mission control, newest-activity first. */
  getExternalSessions() {
    return this._externalSessions.getSessions()
  }

  /**
   * Snapshot of the live agentCommId -> session registrations for the Control
   * Room "Mailbox" tab: which mailbox ids are addressable, the session each
   * resolves to, and whether that session is busy / claude-tui (the conditions
   * the live-interrupt route injects under). Skips ids whose session has gone.
   * @returns {Array<{agentCommId: string, sessionId: string, sessionName: string|null, isBusy: boolean, isTui: boolean}>}
   */
  listAgentCommRegistrations() {
    const out = []
    for (const [agentCommId, sessionId] of this._agentCommIds) {
      const entry = this._sessions.get(sessionId)
      if (!entry) continue
      const session = entry.session
      out.push({
        agentCommId,
        sessionId,
        sessionName: typeof entry.name === 'string' ? entry.name : null,
        isBusy: !!(session && session.isRunning),
        // #5984 (epic #5982): positive claude-tui discriminator, not
        // `typeof writeTerminalInput` duck-typing (a user-shell session will
        // also expose it). Strict `=== true` (matches the mailbox gate) so a
        // buggy override returning a truthy non-boolean isn't treated as tui.
        isTui: session?.constructor?.isClaudeTui === true,
      })
    }
    return out
  }

  /**
   * Resolve the validated "create plan" for a session (#6036 — the front-half
   * SRP extraction out of {@link SessionManager#createSession}). Owns exactly
   * the preflight + isolation + provider/preset resolution responsibilities:
   *
   *   1. session-limit guard + cwd existence check (throws on failure),
   *   2. id generation (preserve-id validation #4983) + name,
   *   3. provider resolution + the #2962 preflight (binary/credential) + the
   *      user-shell fail-closed gate (#5985) + the #3403 model soft-fallback,
   *   4. worktree isolation (fresh `git worktree add` OR the #5310 restore
   *      rebind with the path-safety check),
   *   5. per-repo session-preset resolution + preamble fold (#5553).
   *
   * Returns a plain plan object; {@link SessionManager#createSession} consumes
   * it to build `providerOpts`, construct the session, register it, and start.
   * Splitting the validation from the wiring keeps them close enough to read
   * together — the "middle-layer trap" (#3224/#3231/#4790) recurs when they
   * drift apart. Behaviour is identical to the previous inline front-half: the
   * same checks run in the same order and throw the same errors.
   *
   * @param {object} args The (already-destructured) createSession options that
   *   the plan depends on.
   * @returns {{
   *   sessionId: string,
   *   sessionName: string,
   *   resolvedCwd: string,
   *   resolvedModel: (string|null),
   *   resolvedPermissionMode: string,
   *   resolvedProvider: string,
   *   ProviderClass: Function,
   *   worktreePath: (string|null),
   *   worktreeRepoDir: (string|null),
   *   presetDescriptor: (object|null),
   *   effectiveSessionPreamble: (string|undefined),
   * }} the validated create plan.
   */
  _resolveCreateSessionPlan({ name, cwd, model, permissionMode, provider, worktree, restoreWorktreePath, restoreWorktreeRepoDir, sessionPreamble, preserveId, isRestore = false } = {}) {
    if (this._sessions.size >= this.maxSessions) {
      log.error(`Cannot create session: limit reached (${this._sessions.size}/${this.maxSessions})`)
      throw new SessionLimitError(this.maxSessions)
    }

    const baseCwd = cwd || this._defaultCwd
    // #6064/#3403: only an OMITTED model (`undefined`) falls back to the
    // server-config default. An explicit `null` is the #3403 "use the provider's
    // own default" marker and must SURVIVE. `null` is NOT a valid value on the WS
    // wire (`create_session.model` is `z.string().optional()`, so a remote client
    // sends a string or omits the field — never null); in practice it arrives via
    // restoreState (the production path: a session that soft-fell-back to the
    // provider default persists `model: null`) or an explicit internal/test
    // caller passing it deliberately. Coalescing that `null` to `_defaultModel`
    // would re-pin it to a server-config id that may itself be stale — exactly
    // the staleness #3403 avoids — so the marker must be reproduced faithfully.
    // (The prior `??` coalesced null too, contradicting this and the comment that
    // claimed null survived; #6064.)
    let resolvedModel = model === undefined ? this._defaultModel : model
    const resolvedPermissionMode = permissionMode || this._defaultPermissionMode

    // Validate cwd exists
    try {
      const stat = statSync(baseCwd)
      if (!stat.isDirectory()) {
        throw new SessionDirectoryError(`Not a directory: ${baseCwd}`, baseCwd)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new SessionDirectoryError(`Directory does not exist: ${baseCwd}`, baseCwd)
      }
      throw err
    }

    // #4983 — preserve persisted ID on restoreState so dashboard's
    // localStorage-cached activeSessionId still resolves after a daemon
    // restart. Validate the format strictly (32 lower-case hex chars,
    // matching the randomBytes(16).toString('hex') output below) so a
    // corrupted state file can't inject a malformed id; also guard
    // against accidental collisions with sessions that already exist in
    // this manager (defense in depth — restoreState runs at boot before
    // any other createSession call, but the param is API-exposed and
    // future callers shouldn't be able to clobber a live entry).
    const preserve =
      typeof preserveId === 'string' &&
      /^[a-f0-9]{32}$/.test(preserveId) &&
      !this._sessions.has(preserveId)
        ? preserveId
        : null
    const sessionId = preserve ?? randomBytes(16).toString('hex')
    const sessionName = name || `Session ${++this._sessionCounter}`

    // Pre-flight: verify the provider's binary exists and required credential
    // env vars are set BEFORE constructing/spawning. Without this, a missing
    // binary surfaces as an opaque ENOENT after the session has already
    // appeared in the UI. Runs BEFORE worktree creation so a failed preflight
    // doesn't leave an orphan worktree behind. (#2962)
    const resolvedProviderType = provider || this._providerType
    const PreflightProviderClass = getProvider(resolvedProviderType)
    // #5985 (epic #5982): fail-closed gate for the embedded user-shell terminal.
    // Enforced here (before any spawn) so it covers EVERY create path — WS
    // create_session, restoreState, and internal callers — not just the WS
    // handler (swarm-audit C3: a handler-only gate is bypassed on restore). Keyed
    // on the resolved provider CLASS (`isUserShell`), not the provider-name
    // string, so any user-shell provider is caught regardless of its registry id
    // — consistent with the serialize-skip and terminal_* gates.
    if (PreflightProviderClass?.isUserShell === true && !this._userShellEnabled) {
      throw new UserShellDisabledError()
    }
    if (!this._skipPreflight) {
      runProviderPreflight(PreflightProviderClass)
    }
    // #6378: a provider opted into `config.providers.allowAnyModel` skips static
    // allowlist validation entirely — the model id passes through verbatim and
    // the upstream API validates it (mirrors ollama's null-allowlist behaviour),
    // so a new model the provider's API already exposes needs no release.
    const modelUnrestricted = this._allowAnyModelProviders.has(resolvedProviderType)
    if (resolvedModel && !modelUnrestricted && typeof PreflightProviderClass.getAllowedModels === 'function') {
      let providerAllowedModels = null
      try {
        const list = PreflightProviderClass.getAllowedModels()
        providerAllowedModels = Array.isArray(list) ? list : null
      } catch {
        providerAllowedModels = null
      }
      if (providerAllowedModels && providerAllowedModels.length > 0 && !providerAllowedModels.includes(resolvedModel)) {
        // Claude providers (claude-sdk, claude-cli, docker variants) share a
        // dynamic model registry fed by the Agent SDK's `supportedModels()`.
        // The dashboard caches `defaultModel` (e.g. `opus-4-6`) and ships it
        // back on every `create_session` — when the model retires (e.g.
        // opus-4-7 supersedes 4-6) the inherited id is no longer valid and
        // a hard rejection breaks otherwise-valid session creation. Soft-
        // fallback to the provider's own default (model:null, which both
        // SdkSession and CliSession treat as "use the upstream default")
        // and log a warning so operators can spot the drift in logs (#3403).
        if (isClaudeProvider(resolvedProviderType, PreflightProviderClass)) {
          log.warn(`Requested model '${resolvedModel}' is not in the current registry for provider '${resolvedProviderType}'; falling back to provider default. Supported: ${providerAllowedModels.slice(0, 8).join(', ')}${providerAllowedModels.length > 8 ? ', …' : ''}`)
          resolvedModel = null
        } else {
          // Non-Claude providers (Codex, Gemini, custom) have small static
          // allowlists — strict rejection still applies because falling
          // back would otherwise mask a real misconfiguration (e.g. a
          // Claude model id sent to a Gemini session).
          throw new ProviderModelNotSupportedError({
            provider: resolvedProviderType,
            model: resolvedModel,
            supported: providerAllowedModels,
          })
        }
      }
    }

    // Worktree isolation — create a detached git worktree for this session
    let resolvedCwd = baseCwd
    let worktreePath = null
    let worktreeRepoDir = null
    if (restoreWorktreePath) {
      // #5310 (WP-0.4) — restore path: REBIND to the worktree this session
      // already owns instead of creating a new one. Worktree dirs under
      // ~/.chroxy/worktrees/<id> survive a daemon restart, so recreating would
      // fail ("already exists") and — worse — without rebinding, the restored
      // entry carries worktreePath:null and never GCs the dir on destroy
      // (orphan accrual) and reports isolation:'none'. The original repo dir
      // can't be derived from the persisted cwd (which IS the worktree), so it
      // is persisted + threaded through here for `git worktree remove`. If the
      // worktree dir was deleted out from under us (e.g. `chroxy worktree gc`),
      // the generic baseCwd existence check above already fails the restore
      // cleanly and #2954 preserves it for retry.
      //
      // SECURITY (#5310 review): restoreWorktreePath is read from the on-disk
      // state file and later becomes a recursive-deletion target in
      // _removeWorktree (git worktree remove, then an rmSync -rf fallback). A
      // corrupted or tampered state file could otherwise point it at an
      // arbitrary directory and have destroySession() delete it. Worktree dirs
      // are always created deterministically at join(base, sessionId), so a
      // restored path that doesn't resolve to exactly that is rejected: we
      // safe-degrade to a non-worktree session (worktreePath stays null ⇒ no
      // deletion target) and log loudly, rather than rebind an unsafe path.
      const expectedWorktreeDir = resolve(join(this._worktreeBase || DEFAULT_WORKTREE_BASE, sessionId))
      if (resolve(restoreWorktreePath) === expectedWorktreeDir) {
        worktreePath = restoreWorktreePath
        worktreeRepoDir = restoreWorktreeRepoDir || null
        resolvedCwd = restoreWorktreePath
      } else {
        log.warn(`Restored worktreePath "${restoreWorktreePath}" for session ${sessionId} does not match the expected per-session worktree dir "${expectedWorktreeDir}" — ignoring the rebind (treating as non-worktree) so a corrupted state file can't make destroySession() delete an arbitrary path`)
      }
    } else if (worktree) {
      // Verify cwd is inside a git repository
      try {
        execFileSync(GIT, ['-C', baseCwd, 'rev-parse', '--git-dir'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        })
      } catch {
        throw new WorktreeError(`Not a git repository: ${baseCwd}`)
      }

      // Create worktree directory
      const worktreeBase = this._worktreeBase || DEFAULT_WORKTREE_BASE
      const worktreeDir = join(worktreeBase, sessionId)
      mkdirSync(worktreeBase, { recursive: true })

      try {
        execFileSync(GIT, ['-C', baseCwd, 'worktree', 'add', '--detach', worktreeDir, 'HEAD'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        })
      } catch (err) {
        const msg = err?.stderr?.trim() || err?.message || String(err)
        throw new WorktreeError(`Failed to create worktree: ${msg}`)
      }

      resolvedCwd = worktreeDir
      worktreePath = worktreeDir
      worktreeRepoDir = baseCwd
      log.info(`Created worktree for session ${sessionId} at ${worktreeDir}`)
    }

    const resolvedProvider = resolvedProviderType
    const ProviderClass = PreflightProviderClass

    // #5553: resolve the per-repo session preset now that the cwd is known.
    // The resolver walks up from resolvedCwd to the nearest `.chroxy/session.json`
    // (worktrees inherit the parent repo's preset via the same walk), applies
    // the daemon-override precedence, and consults the trust ledger. A repo-local
    // preset is INERT until the operator approves its content hash; a daemon
    // override is pre-trusted. Everything is wrapped so a preset resolution
    // failure can never break session creation (fail closed = no preset).
    //
    // Skip on restore: a restored session already had its (folded) preamble
    // persisted, and re-folding here would double-apply the repo preamble.
    let presetDescriptor = null
    let effectiveSessionPreamble = sessionPreamble
    if (!isRestore) {
      try {
        const resolved = resolveSessionPreset(resolvedCwd, {
          trustStore: this.presetTrustStore,
          configPath: this.presetConfigPath || undefined,
        })
        if (resolved) {
          // Fold the preamble only when the preset is ACTIVE (trusted + enabled).
          // A pending/disabled preset is still surfaced to the client for
          // disclosure + approval, but never injected.
          let folded = { value: '', capped: false }
          if (resolved.active && resolved.preamble) {
            folded = foldPreamble(resolved.preamble, sessionPreamble)
            effectiveSessionPreamble = folded.value
          }
          presetDescriptor = {
            source: resolved.source,
            active: resolved.active,
            trustState: resolved.trustState,
            enabled: resolved.enabled,
            // Only surface the seed when the preset is active — a pending preset
            // never stages text into the composer.
            seed: resolved.active ? resolved.seed : '',
            preambleLength: resolved.preambleLength,
            seedLength: resolved.seedLength,
            // `capped` reflects EITHER a read-time over-budget flag OR the fold
            // truncating the concatenated preamble — so the UI always discloses
            // a truncation.
            capped: resolved.capped || folded.capped,
            repoPath: resolved.repoPath,
            path: resolved.path,
          }
        }
      } catch (err) {
        // Leak guard: never echo preset contents in the failure path.
        log.warn(`Session preset resolution failed for session ${sessionId} (non-fatal): ${getErrorMessage(err, 'error')}`)
        presetDescriptor = null
        effectiveSessionPreamble = sessionPreamble
      }
    }

    return {
      sessionId,
      sessionName,
      resolvedCwd,
      resolvedModel,
      resolvedPermissionMode,
      resolvedProvider,
      ProviderClass,
      worktreePath,
      worktreeRepoDir,
      presetDescriptor,
      effectiveSessionPreamble,
    }
  }

  /**
   * Create a new session.
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {string} [options.cwd]
   * @param {string} [options.model]
   * @param {string} [options.permissionMode]
   * @param {string} [options.resumeSessionId]
   * @param {string} [options.provider]
   * @param {boolean} [options.worktree] - When true, creates a git worktree for isolation
   * @param {object} [options.sandbox] - SDK sandbox settings for lightweight isolation
   * @param {boolean} [options.promptEvaluator] - Per-session toggle for the auto-evaluator
   *   chain (#3185). Default false — the manual `evaluate_draft` flow remains unaffected.
   * @param {boolean} [options.chroxyContextHint] - Per-session opt-in toggle for
   *   the Chroxy context-prefix in the system prompt (#3805). Default false —
   *   when true, BaseSession._buildSystemPrompt prepends a short paragraph
   *   telling the model it's running inside Chroxy so it can adjust output
   *   for mobile clients. Persisted across reconnects.
   * @param {string} [options.sessionPreamble] - Per-session user-authored
   *   preamble prepended to the system prompt every turn (#4660). Default
   *   empty string — when set, BaseSession._buildSystemPrompt puts the
   *   preamble at the FRONT (before the optional chroxy hint and the
   *   skills text). Trimmed + capped to SESSION_PREAMBLE_MAX_LENGTH by
   *   BaseSession. Persisted across reconnects.
   * @param {string} [options.promptEvaluatorSkipPattern] - Per-session regex source
   *   string consulted by `shouldSkipEvaluator` BEFORE the server-wide
   *   `config.promptEvaluatorSkipPattern` (the global knob landed in #3187;
   *   this per-session override lands here in #3639). Pairs with the
   *   per-session promptEvaluator toggle so different sessions can use
   *   different skip heuristics (e.g. PR-review session skips 'lgtm',
   *   triage session skips 'ack'). Default null — the global pattern from
   *   #3187 still applies as the fallback.
   * @param {boolean} [options.stdinForwardingDisabled] - Internal: hydrate the SidecarProcess
   *   stdin_disabled latch (#3540) on a session being restored from disk. Only used by
   *   `restoreState()`. Truthy = the prior process latched the flag; the new SdkSession
   *   reports it via `listSessions` and `serializeState` round-trips it on the next write.
   * @param {string} [options.bootedModel] - Internal/restore-only: pre-seed
   *   `session.bootedModel` so the dashboard can show the actual model on a restored
   *   session immediately, instead of falling back to the registry default until the
   *   next CLI init event lands (#3700b). Empty / non-string ignored.
   * @param {number} [options.messageCounter] - Internal/restore-only: pre-seed
   *   `session._messageCounter` so a restored session's next sendMessage generates
   *   `msg-{N+1}` instead of restarting from `msg-1` and colliding with messages
   *   the dashboard cached from the previous process (#3700). Non-finite or
   *   negative values ignored.
   * @param {boolean} [options.skipPersist] - Internal: skip the sync persist flush. Used by
   *   `restoreState()`, which must seed history and budget after createSession before the
   *   state file is rewritten; otherwise each flush would overwrite the on-disk file with
   *   empty history and destroy the very data we're restoring.
   * @param {boolean} [options.skipPermissions] - #4208 / #4209: spawn the claude TUI with
   *   `--dangerously-skip-permissions` (and elide chroxy's permission hook + sidecar
   *   entirely). Forwarded to ClaudeTuiSession; other providers ignore it harmlessly via
   *   destructuring. When omitted, falls back to the SessionManager-wide
   *   `defaultSkipPermissions` (set from `chroxy start --dangerously-skip-permissions`).
   * @param {string} [options.preserveId] - Optional 32-char lower-case hex session id to
   *   reuse instead of generating a fresh `randomBytes(16).toString('hex')`. Invalid
   *   format OR a collision with an already-live entry falls back to a fresh random id
   *   so callers can safely pass any value. Primary use: `restoreState` reusing the
   *   persisted id so dashboard's localStorage-cached `activeSessionId` still resolves
   *   after a daemon restart (#4983).
   * @param {boolean} [options.isRestore] - Internal (#5316): marks a session created by
   *   `restoreState()`. When a provider's start() rejects ASYNCHRONOUSLY, the rejection
   *   handler preserves the restored history + worktree (registers a failed-restore)
   *   instead of fully destroying the session. Fresh sessions omit it and take the
   *   full-destroy path on start failure.
   * @param {object|null} [options.metadata] - #6691 (E-4): opaque per-session annotations
   *   set by an in-process caller (the orchestration engine tags its sessions with
   *   `{ orchestrationRunId, orchestrationRole }`, surfaced as optional session-list badge
   *   fields). NOT settable over the wire (the create_session handler whitelists its
   *   fields), and NOT persisted — in-memory only in v1; restart-reconcile re-establishes
   *   it (#6743).
   * @returns {string} sessionId
   */
  createSession({ name, cwd, model, permissionMode, resumeSessionId, provider, worktree, restoreWorktreePath, restoreWorktreeRepoDir, sandbox, codexSandbox, containerId, containerUser, containerCliPath, promptEvaluator, promptEvaluatorSkipPattern, chroxyContextHint, sessionPreamble, stdinForwardingDisabled, disabledMcpServers, bootedModel, messageCounter, skipPermissions, agentCommId, metadata = null, skipPersist = false, preserveId, isRestore = false } = {}) {
    // #6036 — front-half SRP extraction: preflight + isolation + provider/preset
    // resolution (incl. the limit guard, cwd check, id/name, #2962 preflight,
    // #5985 user-shell gate, #3403 model fallback, worktree create/restore, and
    // #5553 preset fold) all live in `_resolveCreateSessionPlan`. It throws the
    // same errors in the same order the inline code did; this method then
    // consumes the validated plan to build providerOpts, construct, register,
    // and start. Both halves stay in the same file so the BaseSession opt
    // forwarding stays readable next to the construction it feeds.
    const plan = this._resolveCreateSessionPlan({
      name,
      cwd,
      model,
      permissionMode,
      provider,
      worktree,
      restoreWorktreePath,
      restoreWorktreeRepoDir,
      sessionPreamble,
      preserveId,
      isRestore,
    })
    const {
      sessionId,
      sessionName,
      resolvedCwd,
      resolvedModel,
      resolvedPermissionMode,
      resolvedProvider,
      ProviderClass,
      worktreePath,
      worktreeRepoDir,
      presetDescriptor,
      effectiveSessionPreamble,
    } = plan

    const providerOpts = {
      cwd: resolvedCwd,
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
      port: this._port,
      apiToken: this._apiToken,
      resumeSessionId: resumeSessionId || null,
      transforms: this._transforms,
      // Provider id flows into BaseSession so the skills loader can apply
      // the `providers:` filter (#3198) and pick a per-provider injection
      // default (#3200). Same string SessionManager uses to pick the
      // ProviderClass via getProvider() — the registry key.
      provider: resolvedProvider,
    }
    // #6638: per-session codex sandbox mode (read-only / workspace-write /
    // danger-full-access). Codex-specific opt read directly by CodexAppServerSession;
    // ignored by other providers.
    if (codexSandbox) providerOpts.codexSandbox = codexSandbox
    if (this._maxToolInput) providerOpts.maxToolInput = this._maxToolInput
    if (this._resultTimeoutMs != null) providerOpts.resultTimeoutMs = this._resultTimeoutMs
    if (this._hardTimeoutMs != null) providerOpts.hardTimeoutMs = this._hardTimeoutMs
    // #5288: forward the operator-configured hard-quiesce window (incl. 0 =
    // disable). null = unset → BaseSession applies its 4h default.
    if (this._backgroundShellHardQuiesceMs != null) providerOpts.backgroundShellHardQuiesceMs = this._backgroundShellHardQuiesceMs
    // #4601: per-provider streamStallTimeoutMs override resolution. Lookup
    // is by RESOLVED provider id (the same key SessionManager used to fetch
    // the ProviderClass from `getProvider()` above) so a session whose
    // explicit `provider` arg differs from the server default picks up the
    // override for its actual provider rather than the default. When the
    // map has an entry for `resolvedProvider` it wins over the global value;
    // `hasOwnProperty` keeps `0` (explicit per-provider disable) honoured.
    // When the entry is absent we fall back to the global
    // `_streamStallTimeoutMs` (or omit the key entirely so BaseSession's
    // 5min default applies).
    const perProviderStall = this._providerStreamStallTimeoutMs
    if (perProviderStall && Object.prototype.hasOwnProperty.call(perProviderStall, resolvedProvider)) {
      providerOpts.streamStallTimeoutMs = perProviderStall[resolvedProvider]
    } else if (this._streamStallTimeoutMs != null) {
      providerOpts.streamStallTimeoutMs = this._streamStallTimeoutMs
    }
    if (this._mcpToolCallTimeoutMs != null) providerOpts.mcpToolCallTimeoutMs = this._mcpToolCallTimeoutMs
    if (this._mcpStartCapMs != null) providerOpts.mcpStartCapMs = this._mcpStartCapMs
    // Skills size budgets — pass through if configured. BaseSession forwards
    // these to loadActiveSkillsLayered. (#3202)
    if (this._maxSkillBytes !== null) providerOpts.maxSkillBytes = this._maxSkillBytes
    if (this._maxTotalSkillBytes !== null) providerOpts.maxTotalSkillBytes = this._maxTotalSkillBytes
    // Per-provider skill allowlist — passed through verbatim. BaseSession
    // resolves the per-provider entry against the session's `provider`
    // key when constructing the loader options. (#3207)
    if (this._providerSkillAllowlist !== null) {
      providerOpts.providerSkillAllowlist = this._providerSkillAllowlist
    }
    // Skill content-hash trust mode (#3204). Only forwarded when the
    // operator explicitly configured one of 'warn' / 'block' — leaves
    // BaseSession's no-op default in place when omitted.
    if (this._trustMismatchMode !== null) {
      providerOpts.trustMismatchMode = this._trustMismatchMode
    }
    // #4664: per-session toggle/string settings (promptEvaluator,
    // chroxyContextHint, sessionPreamble) are forwarded through the
    // registry so adding a new knob is one entry in
    // PER_SESSION_SETTINGS rather than another `if (typeof x === ...)`
    // block here. Each registry entry's `acceptFromWire` predicate
    // mirrors the original per-knob shape — non-matching values are
    // dropped so BaseSession's constructor coerce applies the default.
    forwardPerSessionSettingsToProviderOpts(providerOpts, {
      promptEvaluator,
      chroxyContextHint,
      // #5553: the repo preamble is folded into the session-level preamble
      // (repo first, capped) above. Forward the FOLDED result so the repo
      // preamble lands in `sessionPreamble` and reaches every provider via
      // BASE_SESSION_OPT_KEYS.
      sessionPreamble: effectiveSessionPreamble,
    })
    // #3639: per-session promptEvaluatorSkipPattern. Kept out of the
    // per-session-settings registry because the wire shape ('non-empty
    // string OR null/empty to clear', with pre-validation regex compile)
    // doesn't fit the boolean/string factory. Only string sources are
    // forwarded; null, empty string, or non-string values use
    // BaseSession's `null` default. Validation (regex compile) happens
    // inside BaseSession so a hand-edited state file with a malformed
    // source falls back to null without crashing session creation.
    if (typeof promptEvaluatorSkipPattern === 'string' && promptEvaluatorSkipPattern.length > 0) {
      providerOpts.promptEvaluatorSkipPattern = promptEvaluatorSkipPattern
    }
    // #3540: hydrate the persisted stdin_disabled flag onto the new
    // session so restoreState() round-trips correctly. Only forwarded
    // when explicitly true — undefined/false uses the SdkSession
    // constructor default (`false`). Forwarded blindly to providerOpts
    // (non-Sdk providers ignore the unknown key via destructuring; the
    // signal only originates from SidecarProcess paths).
    if (stdinForwardingDisabled === true) {
      providerOpts.stdinForwardingDisabled = true
    }
    // #6824: per-session parked (disabled) MCP server names. Byok-local opt —
    // forwarded only when it's a non-empty array of strings so non-BYOK
    // providers (which ignore the unknown key via the opt picker) never see a
    // meaningless value, and older state files (no field) restore cleanly. The
    // BYOK session filters this against its own config, so a stale name is a
    // harmless no-op.
    if (Array.isArray(disabledMcpServers) && disabledMcpServers.length > 0) {
      providerOpts.disabledMcpServers = disabledMcpServers.filter((n) => typeof n === 'string')
    }
    // #4208 / #4209: per-session skipPermissions, with the server-wide
    // default as fallback. Only forwarded when truthy so non-TUI providers
    // never see a `skipPermissions: false` key they have to destructure
    // around (kept consistent with the existing "forward only when set"
    // discipline above). Boolean coerce defensively in case a hand-edited
    // state file or future protocol drift sends a truthy non-boolean.
    const resolvedSkipPermissions = typeof skipPermissions === 'boolean'
      ? skipPermissions
      : this._defaultSkipPermissions
    if (resolvedSkipPermissions) providerOpts.skipPermissions = true
    // Sandbox: per-session overrides server-level default
    const resolvedSandbox = sandbox || this._sandbox
    if (resolvedSandbox) providerOpts.sandbox = resolvedSandbox
    // External container support (EnvironmentManager integration)
    if (containerId) providerOpts.containerId = containerId
    if (containerUser) providerOpts.containerUser = containerUser
    if (containerCliPath) providerOpts.containerCliPath = containerCliPath
    // #6771: hand the durable per-project permission rule store to the session so
    // its PermissionManager (SDK / BYOK / codex-app-server) can seed persistent
    // rules for this cwd and persist an `allowAlways` decision. A runtime handle,
    // forwarded via BASE_SESSION_OPT_KEYS.
    providerOpts.permissionRuleStore = this.permissionRuleStore
    const session = new ProviderClass(providerOpts)
    // Pre-seed `bootedModel` from a restored snapshot so the dashboard can
    // surface the session's actual model immediately on reconnect, without
    // waiting for the next CLI init event to repopulate it (#3700b). Only
    // accept non-empty strings so older state files (no field) round-trip
    // as `null`.
    if (typeof bootedModel === 'string' && bootedModel.length > 0) {
      session.bootedModel = bootedModel
    }
    // Pre-seed `_messageCounter` so the next sendMessage on a restored
    // session generates `msg-{N+1}` instead of restarting from `msg-1`
    // and colliding with messages the dashboard cached from the
    // previous process (#3700). Only accept finite non-negative numbers.
    if (typeof messageCounter === 'number' && Number.isFinite(messageCounter) && messageCounter >= 0) {
      session._messageCounter = messageCounter
    }

    // Derive isolation mode from actual session state, ignoring client-provided value
    // when it conflicts with reality (e.g. isolation:'container' with a non-container provider)
    let resolvedIsolation = 'none'
    if (worktreePath) resolvedIsolation = 'worktree'
    else if (ProviderClass.capabilities?.containerized) resolvedIsolation = 'container'
    else if (resolvedSandbox) resolvedIsolation = 'sandbox'

    const entry = {
      session,
      name: sessionName,
      cwd: resolvedCwd,
      provider: resolvedProvider,
      createdAt: Date.now(),
      worktreePath,
      // Original repo dir needed for `git worktree remove` during cleanup.
      // #5310: set in both the create and restore-rebind branches above so it
      // survives a restart (was `worktreePath ? baseCwd : null`, which on
      // restore wrongly resolved to the worktree dir / null).
      worktreeRepoDir,
      isolation: resolvedIsolation,
      // #5316 (WP-2.2) — marks a session created by restoreState(). When a
      // provider's start() rejects ASYNCHRONOUSLY (claude-tui spawns its PTY in
      // an async start()), the .catch() below must preserve the restored history
      // + worktree binding instead of destroying them. Fresh sessions (false)
      // have nothing to preserve and take the full-destroy path.
      _isRestore: isRestore === true,
      // #4072: cumulative usage accumulator (tokens + cost) populated by
      // _trackUsage on every priced `result` event. Subscription-only
      // providers (e.g. claude-tui) emit `result` without `cost`, so the
      // accumulator stays at zero for them and the dashboard / app side
      // knows to skip the cost badge.
      cumulativeUsage: makeZeroCumulativeUsage(),
      // #5553: the resolved per-repo session-preset descriptor (or null). The
      // create_session handler reads this off the entry to (a) disclose the
      // preset metadata on the session_switched reply and (b) stage the seed
      // editable into the new session's composer. Not persisted — it is
      // re-resolved from disk on every fresh create, and restores skip folding.
      sessionPreset: presetDescriptor,
      // #6691 (E-4): opaque per-session annotations set by the caller (the
      // orchestration engine tags its sessions with { orchestrationRunId,
      // orchestrationRole } for the session-list badges). In-memory only in v1 —
      // not persisted; a restart-reconcile re-establishes it (E-3 part 3).
      metadata: metadata || null,
    }

    this._sessions.set(sessionId, entry)
    // Mailbox (#5914 follow-up): auto-register the session's AGENT_COMM_ID so the
    // live-interrupt route resolves agent -> session WITHOUT a separate POST
    // /api/mailbox/register. registerAgentCommId is the authoritative validator
    // (drops control chars / over-length to a no-op) and must run AFTER the entry
    // is in _sessions. Cleared on removal by _cleanupSessionMaps.
    if (agentCommId) this.registerAgentCommId(sessionId, agentCommId)
    metrics.inc('sessions.created')
    this.touchActivity(sessionId)
    this._wireSessionEvents(sessionId, session)

    try {
      const result = session.start()
      // Guard: if start() returns a thenable, catch async rejections (#1141).
      // claude-tui's start() spawns its PTY asynchronously and (as of #5316)
      // REJECTS when the PTY fails to come up, so this is the primary failure
      // signal for that provider.
      if (result && typeof result.catch === 'function') {
        result.catch((err) => this._handleAsyncStartFailure(sessionId, err))
      }
    } catch (err) {
      // Clean up phantom session on start() failure (Guardian FM-03)
      // Mirror destroySession() teardown order: detach listeners before destroy
      session.removeAllListeners()
      session.on('error', () => {})
      try {
        session.destroy()
      } catch (destroyErr) {
        log.error(`Failed to destroy session ${sessionId} during start() failure cleanup: ${destroyErr?.stack || destroyErr}`)
      }
      this._cleanupSessionMaps(sessionId)
      // Clean up the worktree ONLY if we freshly created it this call. #5310:
      // on a restore-rebind, worktreePath points at a PRE-EXISTING worktree
      // (with possibly uncommitted work) that we must NOT delete just because
      // the provider's start() failed — destroying it would lose the user's
      // work AND make the #2954-preserved retry unrecoverable (the next attempt
      // would hit the missing-worktree statSync failure). Only the fresh-create
      // branch should roll back its own creation. Use worktreeRepoDir (the
      // original repo) for the remove, consistent with the destroy paths.
      if (worktreePath && !restoreWorktreePath) {
        this._removeWorktree(worktreePath, worktreeRepoDir, sessionId)
      }
      throw err
    }

    log.info(`Created session ${sessionId} "${sessionName}" (${this._sessions.size}/${this.maxSessions})`)
    this.emit('session_created', { sessionId, name: sessionName, cwd: resolvedCwd })

    // #5554 Phase 2: record the skills that ACTIVATED for this fresh session.
    // The narrowest reliable point — `session._skills` is the active set the
    // loader actually injected into this session's prompt (provider-scoped,
    // manual-activation-resolved), and the sessionId + repo (resolvedCwd) are
    // now known. Skip restores (re-hydrating a session is not a new use) and
    // guard everything so a usage-log failure can never break session creation.
    if (!isRestore) {
      try {
        const activeSkills = Array.isArray(session?._skills)
          ? session._skills.map(s => (s && typeof s.name === 'string' ? s.name : null)).filter(Boolean)
          : []
        if (activeSkills.length > 0) {
          this.skillsUsageRecorder?.record({ sessionId, repo: resolvedCwd, skills: activeSkills })
        }
      } catch (err) {
        log.debug(`skills-usage: failed to record activation for ${sessionId} (non-fatal): ${getErrorMessage(err, err)}`)
      }
    }
    // Flush synchronously — a new session must survive an abrupt shutdown,
    // otherwise rebuilds / crashes during the 2s debounce window lose it.
    // Exception: restoreState calls us in a loop and seeds history/budget
    // AFTER this returns; flushing here would write empty history to disk
    // and permanently discard the data being restored.
    if (!skipPersist) this._flushPersistOrWarn(sessionId)
    return sessionId
  }

  /**
   * Handle a provider start() that rejects ASYNCHRONOUSLY (#1141 guard path).
   * claude-tui spawns its PTY in an async start() that, as of #5316 (WP-2.2),
   * rejects when the PTY fails to come up.
   *
   * For a FRESH session there is no history worth keeping, so fully destroy it
   * (removes the worktree it created this call) — the pre-#5316 behaviour.
   *
   * For a RESTORED session, destroySession() would erase the restored history
   * AND remove the pre-existing worktree it rebound to (losing uncommitted work
   * and making the #2954 retry unrecoverable). So instead snapshot the entry
   * into a failed-restore payload — which serializeState() writes back to disk,
   * preserving history + worktree binding for a future retry — tear down only
   * the live (dead) provider, and surface session_restore_failed so the client
   * shows the "needs attention" / retry affordance.
   * @param {string} sessionId
   * @param {Error} err - The rejection from start()
   * @private
   */
  _handleAsyncStartFailure(sessionId, err) {
    const entry = this._sessions.get(sessionId)
    // Already gone — destroyed elsewhere (e.g. a concurrent destroySession or a
    // respawn_exhausted teardown) before this rejection landed. Nothing to do.
    if (!entry) return
    const message = err?.message || String(err)
    log.error(`Async start() rejected for session ${sessionId}: ${message}${err?.stack ? '\n' + err.stack : ''}`)

    if (!entry._isRestore) {
      // #5731 T6: a fresh session whose async start() rejects (claude-tui's
      // PTY failing to spawn is the main case) would otherwise vanish with
      // only a `session_destroyed` — the client that just received
      // `session_created` + a success ack for createSession gets no reason for
      // the disappearance. Surface the failure FIRST so the client shows an
      // error toast, THEN tear down. There's no history worth preserving, so
      // this stays a full destroy (unlike the restore-rebind path below, which
      // round-trips history for a retry). Stamp a default code so the message
      // is consistent with the restore path's START_FAILED.
      if (err && !err.code) err.code = 'START_FAILED'
      this.emit('session_create_failed', {
        sessionId,
        name: entry.name,
        provider: entry.provider || this._providerType,
        cwd: entry.cwd,
        model: entry.session?.model || null,
        errorCode: err?.code || 'START_FAILED',
        errorMessage: message,
      })
      // Full teardown (removes the freshly-created worktree). The emit above
      // ran synchronously, so subscribers received the error while the session
      // was still mapped, before this broadcasts `session_destroyed`.
      this.destroySession(sessionId)
      return
    }

    // Restore-rebind: preserve history + worktree, mark the session as a failed
    // restore so it round-trips to disk and surfaces in the needs-attention UI.
    const saved = this._serializeSessionEntry(sessionId, entry)
    // Detach + destroy ONLY the live provider (frees the dead PTY). This does
    // NOT remove the worktree — that's a SessionManager concern (_removeWorktree),
    // and we deliberately keep the rebound worktree intact for the retry.
    entry.session.removeAllListeners()
    entry.session.on('error', () => {}) // swallow stray error during destroy
    try {
      entry.session.destroy()
    } catch (destroyErr) {
      log.error(`Failed to destroy provider for failed restore ${sessionId}: ${destroyErr?.stack || destroyErr}`)
    }
    // Snapshot is captured above, so dropping the live history map is safe.
    this._cleanupSessionMaps(sessionId)
    // Stamp the code so the live `session_restore_failed` emit below and a
    // LATER reconnect via getFailedRestores() (which defaults a code-less error
    // to 'RESTORE_FAILED') report the SAME errorCode for this failure. claude-tui
    // rejects start() with a bare Error (no .code), so without this the same
    // failure would surface as START_FAILED to clients present at failure time
    // and RESTORE_FAILED to clients that reconnect afterwards.
    if (err && !err.code) err.code = 'START_FAILED'
    this._failedRestores.set(sessionId, { saved, error: err })
    this.emit('session_restore_failed', {
      sessionId,
      name: saved.name,
      provider: saved.provider || this._providerType,
      cwd: saved.cwd,
      model: saved.model || null,
      permissionMode: saved.permissionMode || null,
      errorCode: err?.code || 'START_FAILED',
      errorMessage: message,
      originalHistoryPreserved: true,
      historyLength: Array.isArray(saved.history) ? saved.history.length : 0,
    })
    // Persist now so the preserved history survives an abrupt shutdown before
    // the next debounced write.
    this._flushPersist()
  }

  /**
   * Remove a git worktree, logging errors non-fatally.
   * @param {string} worktreePath - Absolute path to the worktree directory
   * @param {string} repoDir - The original git repo directory (needed for git context)
   * @param {string} sessionId - Used for log messages only
   */
  _removeWorktree(worktreePath, repoDir, sessionId) {
    try {
      execFileSync(GIT, ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      })
      log.info(`Removed worktree for session ${sessionId}: ${worktreePath}`)
      return
    } catch (err) {
      log.warn(`git worktree remove failed for session ${sessionId}, falling back to direct removal: ${err?.stderr?.trim() || err?.message || String(err)}`)
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true })
      log.info(`Removed worktree directory for session ${sessionId}: ${worktreePath}`)
    } catch (err) {
      log.error(`Failed to remove worktree directory ${worktreePath}: ${err.message}`)
    }
  }

  /**
   * Get a session entry by ID.
   * Returns null if the session does not exist or is currently being destroyed.
   * @returns {{ session: object, name: string, cwd: string, createdAt: number } | null}
   */
  getSession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry || entry._destroying) return null
    return entry
  }

  /**
   * #5553: read the resolved per-repo session preset for a session entry, in
   * the shape the create_session reply discloses to clients. Returns null when
   * the session has no preset (or is unknown). Never includes the preamble
   * TEXT (it's already folded into the prompt) — only its length + the seed
   * text (operator-facing, staged editable into the composer) + trust metadata.
   *
   * @param {string} sessionId
   * @returns {null | {
   *   source: 'daemon' | 'repo',
   *   active: boolean,
   *   trustState: 'trusted' | 'pending',
   *   enabled: boolean,
   *   seed: string,
   *   preambleLength: number,
   *   seedLength: number,
   *   capped: boolean,
   *   repoPath: string | null,
   * }}
   */
  getSessionPreset(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry || !entry.sessionPreset) return null
    const p = entry.sessionPreset
    return {
      source: p.source,
      active: p.active,
      trustState: p.trustState,
      enabled: p.enabled,
      seed: p.seed || '',
      preambleLength: p.preambleLength,
      seedLength: p.seedLength,
      capped: !!p.capped,
      repoPath: p.repoPath || null,
    }
  }

  /**
   * #5553: resolve the per-repo session preset for an arbitrary cwd WITHOUT
   * creating a session. Powers the create-session modal's pre-create
   * disclosure ("this repo's preset applies") and the per-repo settings drawer.
   * Surfaces full preset metadata INCLUDING the preamble + seed text so the
   * drawer can show a read-only preview. Trust-gated identically to
   * createSession. Returns null when there is no preset.
   *
   * @param {string} cwd
   * @returns {null | object}
   */
  resolveSessionPresetForCwd(cwd) {
    try {
      return resolveSessionPreset(cwd, {
        trustStore: this.presetTrustStore,
        configPath: this.presetConfigPath || undefined,
      })
    } catch (err) {
      log.warn(`resolveSessionPresetForCwd failed (non-fatal): ${getErrorMessage(err, 'error')}`)
      return null
    }
  }

  /**
   * #5553: approve the CURRENT content hash of a repo-local preset so it
   * becomes trusted (and active for future sessions). Re-resolves the preset
   * from disk to obtain the live hash (so a stale client-supplied hash can't
   * pin a different version). Returns the updated descriptor or null when the
   * cwd has no trust-gated repo-local preset (e.g. a daemon override, which is
   * pre-trusted, or no preset at all).
   *
   * @param {string} cwd
   * @returns {null | object}
   */
  approveSessionPreset(cwd) {
    const resolved = this.resolveSessionPresetForCwd(cwd)
    if (!resolved || resolved.source !== 'repo' || !resolved.path) return null
    this.presetTrustStore.approve(resolved.path, resolved.hash)
    return this.resolveSessionPresetForCwd(cwd)
  }

  /**
   * #5553: revoke trust for a repo-local preset so it goes inert (pending)
   * again. Returns the updated descriptor or null.
   *
   * @param {string} cwd
   * @returns {null | object}
   */
  revokeSessionPreset(cwd) {
    const resolved = this.resolveSessionPresetForCwd(cwd)
    if (!resolved || resolved.source !== 'repo' || !resolved.path) return null
    this.presetTrustStore.revoke(resolved.path)
    return this.resolveSessionPresetForCwd(cwd)
  }

  /**
   * List all sessions with summary info.
   * @returns {Array<{ sessionId, name, cwd, model, permissionMode, isBusy, createdAt, lastActivityAt, stdinForwardingDisabled, stdinDroppedBytes, stdinDroppedCount }>}
   */
  listSessions() {
    const list = []
    for (const [sessionId, entry] of this._sessions) {
      if (entry._destroying) continue
      const ProviderClass = entry.session.constructor
      // #3573: hydrate cumulative stdin_dropped totals on reconnect.
      // SdkSession exposes the running counters via the `stdinDroppedTotals`
      // getter (added in #3544). Other providers (CliSession, Codex, Gemini)
      // do not drop stdin at the SidecarProcess pre-dial cap, so they
      // round-trip as `0` — matching the strict-boolean pattern used by
      // `stdinForwardingDisabled` so reconnecting clients see a stable
      // numeric shape regardless of provider.
      const totals = entry.session.stdinDroppedTotals
      const stdinDroppedBytes = totals && Number.isFinite(totals.bytes) ? totals.bytes : 0
      const stdinDroppedCount = totals && Number.isFinite(totals.count) ? totals.count : 0
      const resolvedProvider = entry.provider || this._providerType
      // #5630/#5629: per-session billing class for the dashboard cost labels.
      // Prefer the provider's live resolveAuth().billingClass (it already folds
      // in the era gate + the claude-sdk/claude-cli explicit-key refinement);
      // fall back to billingClassForProvider() for any provider whose
      // resolveAuth predates the field. Wrapped defensively so a misbehaving
      // custom provider's resolveAuth can't crash the snapshot.
      let billingClass
      try {
        billingClass = getProviderAuthInfo(resolvedProvider, ProviderClass)?.billingClass
      } catch {
        billingClass = undefined
      }
      if (!billingClass) {
        billingClass = billingClassForProvider(resolvedProvider, Date.now())
      }
      list.push({
        sessionId,
        name: entry.name,
        cwd: entry.cwd,
        // #3687: prefer the user's explicit override (`model`) so a later
        // `setModel()` isn't masked by a stale `bootedModel` (SdkSession's
        // setModel doesn't restart, so bootedModel only refreshes on the
        // next init). Fall back to bootedModel so the session list shows
        // what's actually running when no override was set. State
        // persistence (snapshotState below) keeps using `entry.session.model`
        // only — we want to remember the user's intent (null = "follow
        // CLI default") across restarts.
        model: entry.session.model || entry.session.bootedModel || null,
        permissionMode: entry.session.permissionMode || 'approve',
        isBusy: entry.session.isRunning,
        createdAt: entry.createdAt,
        lastActivityAt: this._sessionLastActivityAt.get(sessionId) || entry.createdAt,
        conversationId: entry.session.resumeSessionId || null,
        provider: resolvedProvider,
        // #5630/#5629: era-aware billing class so the dashboard labels the
        // cost row per class (api-key → "Cost (BYOK)", programmatic-credit →
        // "Credit spend", subscription → "Included (subscription)").
        billingClass,
        capabilities: ProviderClass.capabilities || {},
        worktree: entry.worktreePath != null,
        repoCwd: entry.worktreeRepoDir || null,
        isolation: entry.isolation || 'none',
        // #6691 (E-4): orchestration badges — present only for engine-owned
        // sessions (architect / worker.*), absent otherwise. Optional on the wire
        // (ServerSessionListEntry), so a plain session omits them entirely.
        ...(entry.metadata?.orchestrationRunId ? { orchestrationRunId: entry.metadata.orchestrationRunId } : {}),
        ...(entry.metadata?.orchestrationRole ? { orchestrationRole: entry.metadata.orchestrationRole } : {}),
        // #4664: per-session toggle/string settings (promptEvaluator,
        // chroxyContextHint, sessionPreamble) surface through the
        // registry so the dashboard can hydrate every knob's current
        // state without a separate round-trip. Each registry entry's
        // `coerce` doubles as the defensive cast guarding against a
        // custom provider that skipped BaseSession's field initialiser.
        ...serializePerSessionSettings(entry.session),
        // #3639: surface the per-session skip-pattern source so the
        // dashboard can show / edit the per-session override without
        // having to introspect via a separate request. `null` when
        // unset — the global config.promptEvaluatorSkipPattern still
        // applies as a fallback (see input-handlers.js). Treat empty
        // string as unset so the wire shape stays stable across the
        // setter/constructor (which normalise '' to null) and a
        // serialise -> restore round-trip. Kept out of the registry
        // because the empty-as-null shape doesn't fit the
        // boolean/string factory.
        promptEvaluatorSkipPattern:
          typeof entry.session.promptEvaluatorSkipPattern === 'string' &&
          entry.session.promptEvaluatorSkipPattern.length > 0
            ? entry.session.promptEvaluatorSkipPattern
            : null,
        // #3540: surface the latched stdin_disabled flag so reconnecting
        // clients (and clients connecting after a server restart) see
        // the disabled state without waiting for a fresh `error` event.
        // This is the canonical signal for cold restarts — the runtime
        // `error` event remains the live signal for newly-disabled
        // sessions in the same process. Strict-boolean coerce so
        // non-Sdk providers round-trip as `false`.
        stdinForwardingDisabled: !!entry.session._stdinForwardingDisabled,
        // #3573: hydrate cumulative stdin_dropped totals on reconnect so a
        // dashboard / mobile client that joins after one or more drops
        // already happened can paint the live "X bytes lost over N drops"
        // indicator without waiting for the next drop to fire. The runtime
        // `stdin_dropped_totals` event remains the live signal; this field
        // is the authoritative seed for clients connecting late.
        stdinDroppedBytes,
        stdinDroppedCount,
        // #4072: hydrate cumulative token usage + cost so a dashboard /
        // mobile client connecting after a session has already racked up
        // turns sees the running totals immediately instead of waiting
        // for the next `session_usage` event. Overlay the entry's stored
        // values on top of the zero template so the snapshot ALWAYS has
        // every key — a custom provider or future restoreState path that
        // stores a partial object can't produce a wire shape with
        // missing fields (#4088 review). Shallow-copy on the wire so a
        // client that mutates the payload can't corrupt the canonical
        // accumulator. Subscription-only sessions never emit `cost` so
        // this stays zero — the UI uses `turnsBilled === 0` or
        // `costUsd === 0` to suppress the cost badge.
        cumulativeUsage: { ...makeZeroCumulativeUsage(), ...(entry.cumulativeUsage || {}) },
        // #4307: hydrate pending background-shell entries so a client
        // joining mid-flight (fresh tab, server reconnect, app
        // resume) sees the waiting-on-shell state without needing to
        // wait for the next `background_work_changed` event. Always
        // an array — sessions with no pending work serialize as `[]`
        // (no defensive `undefined` on the wire, mirrors how
        // `cumulativeUsage` always carries a zero block). Empty array
        // is the common path; the dashboard's renderer treats it as
        // "no waiting indicator." Defensive guard: providers that
        // skip BaseSession's field initialiser (older custom
        // providers, hypothetical) round-trip an empty array rather
        // than crashing `getPendingBackgroundShells()` on undefined.
        pendingBackgroundShells:
          typeof entry.session.getPendingBackgroundShells === 'function'
            ? entry.session.getPendingBackgroundShells()
            : [],
      })
    }
    return list
  }

  /**
   * Read git/project context for a session's working directory.
   * @param {string} [sessionId] - If omitted, uses first session
   * @returns {Promise<{ sessionId: string, gitBranch: string|null, gitDirty: number, gitAhead: number, projectName: string|null } | null>}
   */
  async getSessionContext(sessionId) {
    const entry = sessionId
      ? this._sessions.get(sessionId)
      : this._sessions.values().next().value
    if (!entry) return null
    const id = sessionId || this._sessions.keys().next().value
    const ctx = await readSessionContext(entry.cwd)
    return { sessionId: id, ...ctx }
  }

  /**
   * Check if a session is currently locked for mutation.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSessionLocked(sessionId) {
    return this._locks.isLocked(sessionId)
  }

  /**
   * Acquire a mutation lock for a session. Returns a release function.
   * @param {string} sessionId
   * @returns {Promise<() => void>}
   */
  acquireSessionLock(sessionId) {
    return this._locks.acquire(sessionId)
  }

  /**
   * Rename a session with mutation lock.
   * @returns {Promise<boolean>}
   */
  async renameSessionLocked(sessionId, name) {
    const release = await this._locks.acquire(sessionId)
    try {
      return this.renameSession(sessionId, name)
    } finally {
      release()
    }
  }

  /**
   * Destroy a session with mutation lock.
   * Sets _destroying immediately (before lock acquisition) so concurrent
   * getSession() calls see the session as unavailable right away.
   * @returns {Promise<boolean>}
   */
  async destroySessionLocked(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (entry) entry._destroying = true
    const release = await this._locks.acquire(sessionId)
    try {
      return this.destroySession(sessionId)
    } finally {
      release()
    }
  }

  /**
   * Rename a session.
   * @returns {boolean}
   */
  renameSession(sessionId, name) {
    const entry = this._sessions.get(sessionId)
    if (!entry) {
      log.error(`Cannot rename: session ${sessionId} not found`)
      return false
    }
    entry.name = name
    entry._autoLabeled = true // prevent auto-label from overwriting manual rename
    log.info(`Renamed session ${sessionId} to "${name}"`)
    this.emit('session_updated', { sessionId, name })
    // Flush synchronously — before this, renames were never persisted at all,
    // so a restart would show the pre-rename label.
    this._flushPersistOrWarn(sessionId, name)
    return true
  }

  /**
   * Destroy a specific session.
   * Sets _destroying = true at the start so concurrent getSession() calls
   * treat the session as unavailable while cleanup is in progress.
   * @returns {boolean}
   */
  destroySession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) {
      log.error(`Cannot destroy: session ${sessionId} not found`)
      return false
    }
    // Mark as destroying immediately — getSession() will return null from here on
    entry._destroying = true
    metrics.inc('sessions.destroyed')
    // Detach listeners BEFORE destroy to prevent orphaned events (FM-04)
    entry.session.removeAllListeners()
    // Prevent unhandled 'error' throw if session emits error during destroy
    entry.session.on('error', () => {})
    // Emit synthetic stream_end for any in-flight streams so clients see termination
    const closedMessageIds = this._history.closePendingStreams(sessionId)
    for (const messageId of closedMessageIds) {
      this.emit('session_event', { sessionId, event: 'stream_end', data: { messageId } })
    }
    try {
      entry.session.destroy()
    } catch (destroyErr) {
      log.error(`Error destroying session ${sessionId} "${entry.name}": ${destroyErr?.stack || destroyErr}`)
    }
    this._cleanupSessionMaps(sessionId)
    if (entry.worktreePath) {
      this._removeWorktree(entry.worktreePath, entry.worktreeRepoDir, sessionId)
    }
    log.info(`Destroyed session ${sessionId} "${entry.name}" (${this._sessions.size}/${this.maxSessions})`)
    // #5985 audit — close the user-shell trail opened at create. Exit code is
    // the shell's natural code if it ended before this teardown, else null (the
    // destroy() above SIGTERMs a live shell asynchronously). Read off the
    // session, set in UserShellSession._onShellExit.
    if (entry.session?.constructor?.isUserShell === true) {
      auditShellDestroy({
        sessionId,
        exitCode: entry.session._exitCode ?? null,
        reason: entry.session._exitReason ?? 'destroyed',
      })
      // #6276: a clean teardown SIGTERMs the shell, so drop its orphan-reaper
      // record — otherwise the next boot would try to reap an already-dead pid.
      forgetShell(this._userShellSidecarPath, sessionId)
    }
    this.emit('session_destroyed', { sessionId })
    // Flush synchronously so the deletion survives an abrupt shutdown. The
    // entry is already out of `_sessions` by now, so pass its name explicitly.
    this._flushPersistOrWarn(sessionId, entry.name)
    return true
  }

  /**
   * Sever every live user-shell session — the #6006 token-revoke primitive.
   *
   * Iterates a SNAPSHOT of the session map (destroySession() mutates it) and
   * destroys each session whose provider CLASS is a user-shell, leaving every
   * other session untouched. Called by WsServer's `token_rotated` handler when
   * an operator REVOKES the token (the panic button), never on a scheduled
   * rotation — a periodic re-key must not kill long-running shells.
   *
   * The destroy trail is closed by destroySession()'s #5985 audit; `reason` is
   * stamped onto each still-live shell first so the trail records WHY it died
   * (e.g. 'revoked') without clobbering a shell that already exited naturally.
   *
   * @param {string} [reason='revoked'] - audit reason recorded on each shell
   * @returns {number} count of shells severed
   */
  destroyAllUserShellSessions(reason = 'revoked') {
    let severed = 0
    // Snapshot: destroySession() deletes from _sessions mid-iteration.
    for (const [sessionId, entry] of [...this._sessions]) {
      if (entry.session?.constructor?.isUserShell !== true) continue
      // Record the reason only for a still-live shell — preserve a natural
      // exit reason already set by UserShellSession._onShellExit.
      if (entry.session._exitReason == null) {
        entry.session._exitReason = reason
      }
      if (this.destroySession(sessionId)) severed++
    }
    if (severed > 0) {
      log.warn(`Severed ${severed} user-shell session(s): ${reason}`)
    }
    return severed
  }

  /**
   * Destroy all sessions (shutdown cleanup).
   *
   * Sets `_destroying` so any persist call after this point — whether from a
   * duplicate shutdown handler invocation or from a stray late-arriving event
   * — is a no-op. Without that guard, a second shutdown pass ran
   * `serializeState()` against the already-cleared `_sessions` Map and wrote
   * 0 sessions to disk, erasing the user's restored state across upgrade/quit
   * cycles (#3697).
   */
  destroyAll() {
    this.stopSessionTimeouts()
    this._persistence.cancelPersist()
    try {
      this.serializeState()
    } catch (err) {
      // #5701: this is the final write before the process exits — a failure
      // here loses the whole session list on the next start. Log loudly so the
      // operator can act (disk space / permissions) rather than discovering it
      // silently gone after restart.
      log.error(`CRITICAL: failed to serialize session state during shutdown — sessions may NOT be restored on next start (check disk space and write permissions for ${this._stateFilePath}): ${err?.stack || err}`)
    }
    // Set the destroying flag AFTER the final write — every persist call from
    // here on (duplicate shutdown handler, late-arriving session event) will
    // be a no-op so the good state on disk survives (#3697).
    this._destroying = true
    for (const [sessionId, entry] of this._sessions) {
      entry.session.removeAllListeners()
      entry.session.on('error', () => {})
      try {
        entry.session.destroy()
      } catch (destroyErr) {
        log.error(`Error destroying session ${sessionId} "${entry.name}" during destroyAll(): ${destroyErr?.stack || destroyErr}`)
      }
      // Do NOT remove the worktree here. destroyAll() is a process-shutdown
      // teardown, not a user-initiated session destroy: the session was just
      // serialized as live above, and on the next start restoreState() rebinds
      // it to this exact worktree dir (#5310). Deleting it now orphaned the
      // restore — the worktree session came back pointing at a directory that
      // no longer existed, losing any uncommitted work in it. Worktree removal
      // belongs only in destroySessionLocked() (the explicit per-session
      // destroy). Orphan worktrees from sessions that DON'T come back are
      // swept at boot — see worktree-gc (P1-7 follow-up).
      // #5985 audit — user-shells are non-persisted, so a live shell at
      // shutdown is torn down here (not via destroySession); close its trail.
      if (entry.session?.constructor?.isUserShell === true) {
        auditShellDestroy({
          sessionId,
          exitCode: entry.session._exitCode ?? null,
          reason: entry.session._exitReason ?? 'shutdown',
        })
      }
      this.emit('session_destroyed', { sessionId })
    }
    this._sessions.clear()
    this._timeoutManager.destroy()
    this._history.clear()
    this._costBudget.clear()
    // #5554: persist any pending usage records on shutdown (best-effort).
    try { this.skillsUsageRecorder?.flush() } catch { /* non-fatal */ }
  }

  /**
   * Get the first session ID (used as default).
   * @returns {string | null}
   */
  get firstSessionId() {
    for (const [id, entry] of this._sessions) {
      if (!entry._destroying) return id
    }
    return null
  }

  get defaultCwd() {
    return this._defaultCwd
  }

  /**
   * Current max messages per session (from SessionMessageHistory).
   * @returns {number}
   */
  get maxMessages() {
    return this._history.maxMessages
  }

  /**
   * Serialize session state to disk for graceful restart.
   * Called during drain before the process exits.
   * @returns {object|null} The serialized state, or `null` if `destroyAll()`
   *   has already run — late callers (duplicate shutdown handler, stray
   *   session event) cannot overwrite the on-disk state (#3697).
   */
  serializeState() {
    // After destroyAll() has cleared the in-memory Map, any further write
    // would persist 0 sessions and overwrite the good state already on disk.
    // Skip silently — the destroyAll() call did the final write itself
    // (#3697).
    if (this._destroying) return null
    const state = { version: 1, timestamp: Date.now(), sessions: [] }
    for (const [id, entry] of this._sessions) {
      // #5983 (epic #5982): never persist a user-shell session. Restoring one
      // would re-spawn a $SHELL on boot — bypassing the userShell.enabled gate
      // if it was since turned off (swarm-audit C3 / Skeptic finding 4) — and a
      // shell has no resumable conversation state worth keeping anyway.
      if (entry.session?.constructor?.isUserShell === true) continue
      state.sessions.push(this._serializeSessionEntry(id, entry))
    }

    // Preserve sessions that failed to restore (#2954 — Guardian FM-01).
    // Without this, the next successful write drops them from disk and the
    // user's history is permanently lost. We write them back exactly as
    // they were loaded so a retry (after the user sets the missing env var
    // and restarts) can fully re-hydrate history.
    for (const [, { saved }] of this._failedRestores) {
      state.sessions.push(saved)
    }

    // Persist cost tracking so budget survives restarts
    const budgetState = this._costBudget.serialize()
    state.costs = budgetState.costs
    state.budgetWarned = budgetState.budgetWarned
    state.budgetExceeded = budgetState.budgetExceeded
    state.budgetPaused = budgetState.budgetPaused

    return this._persistence.serializeState(state)
  }

  /**
   * Serialize a single live session entry to the on-disk persisted shape.
   * Extracted from serializeState() so the async start-failure path (#5316,
   * WP-2.2) can snapshot a restored session into a failed-restore payload that
   * round-trips through restoreState() identically. Keep this in lockstep with
   * the restore-side reader in restoreState().
   * @param {string} id - The session id
   * @param {object} entry - The in-memory session entry
   * @returns {object} The persisted session payload
   * @private
   */
  _serializeSessionEntry(id, entry) {
    const history = this._history.getHistory(id).map(e => this._history.truncateEntry(e))
    return {
        id,
        sdkSessionId: (typeof entry.session.resumeSessionId !== 'undefined' ? entry.session.resumeSessionId : null),
        conversationId: entry.session.resumeSessionId || null,
        cwd: entry.cwd,
        model: entry.session.model,
        // Persist the model the underlying CLI actually booted with (#3700b).
        // `model` reflects an explicit user override; `bootedModel` is what
        // the provider chose when no override was set. Surfacing this on
        // restore lets the dashboard show the real model in the dropdown
        // immediately, instead of falling back to the registry default
        // until the next init event lands.
        bootedModel: entry.session.bootedModel || null,
        // Persist the per-session messageId counter so a server restart
        // doesn't restart from `msg-1` and collide with messages the
        // dashboard already has cached in localStorage from the previous
        // process — the dashboard's stream-id collision logic would
        // silently REUSE the old `msg-1` response message and append
        // the new turn's text to it, leaving the bottom of the chat
        // empty (#3700). Falsy/missing on older state files round-trips
        // as 0 which is the original constructor default.
        messageCounter: entry.session._messageCounter || 0,
        permissionMode: entry.session.permissionMode,
        provider: entry.provider || null,
        name: entry.name,
        // #5310 (WP-0.4) — persist the worktree binding so a restored session
        // rebinds to its existing worktree (rather than losing it). worktreePath
        // is also the session's cwd, but worktreeRepoDir (the ORIGINAL repo,
        // needed for `git worktree remove`) is NOT derivable from cwd, so both
        // must round-trip. Null for non-worktree sessions; older state files
        // (pre-#5310) restore as null → treated as a non-worktree session.
        worktreePath: entry.worktreePath || null,
        worktreeRepoDir: entry.worktreeRepoDir || null,
        // Mailbox (#5914 follow-up): persist the registered AGENT_COMM_ID so a
        // session keeps its mailbox identity across a daemon restart (re-applied
        // via createSession on restore below). Null when the session never
        // registered one; older state files (no field) restore as null.
        agentCommId: entry.agentCommId || null,
        lastActivityAt: this._sessionLastActivityAt.get(id) || entry.createdAt,
        history,
        // #4664: persist per-session toggle/string settings via the
        // shared registry — each entry's coerce produces the same
        // strict-boolean/string-default shape the pre-refactor per-knob
        // code wrote (so an old state file round-trips identically).
        ...serializePerSessionSettings(entry.session),
        // #3639: persist the per-session skip-pattern source. Null when
        // unset — old state files (pre-#3639) restore as null (the
        // BaseSession default) so this is fully backward compatible.
        // Treat empty string as null too: the setter and restoreState
        // both normalise '' to null, so persisting '' would not
        // round-trip and would violate the non-empty-string-or-null
        // invariant.
        promptEvaluatorSkipPattern:
          typeof entry.session.promptEvaluatorSkipPattern === 'string' &&
          entry.session.promptEvaluatorSkipPattern.length > 0
            ? entry.session.promptEvaluatorSkipPattern
            : null,
        // #3540: persist the SidecarProcess `stdin_disabled` latch so a
        // server restart preserves the disabled state. Without this, a
        // client connecting after restart would not see the banner — the
        // original `error` event fired against the previous process and
        // was not replayed. Strict-boolean coerce so non-Sdk providers
        // (which never set this field) round-trip as `false`.
        stdinForwardingDisabled: !!entry.session._stdinForwardingDisabled,
        // #6824: persist the per-session parked (disabled) MCP server set so a
        // respawn skips starting those servers. Only the BYOK lane exposes the
        // getter; other providers round-trip as [] (their MCP config is owned
        // by the claude binary, not toggleable here). Older state files (no
        // field) restore as [] → nothing parked.
        disabledMcpServers:
          typeof entry.session.getDisabledMcpServers === 'function'
            ? entry.session.getDisabledMcpServers()
            : [],
        // #4089: persist cumulativeUsage so the dashboard sidebar badge
        // (#4073) and mobile session-header badge (#4074) survive a
        // server restart. Without this, the badge resets to $0 on
        // restart even though the operator's spending continues. Round-
        // trips through restoreState below as the entry's
        // `cumulativeUsage` field. Older state files (pre-#4089) restore
        // as null — restoreState seeds an all-zero block in that case.
        cumulativeUsage: entry.cumulativeUsage || null,
        // #4124: persist the per-session threshold-notified latch so the
        // "you've spent $X" warning fires once per LOGICAL session, not
        // once per process. Without this the warning re-fires on every
        // restart even after the user has already seen and dismissed it.
        //
        // Strict-boolean check (not `!!`) so a stray truthy non-boolean
        // value (an accidentally-stored string, etc.) does not silently
        // round-trip as `true` — only an explicit `true` latches.
        // Mirrors the restore side which gates on `=== true`.
        costThresholdNotified: entry.costThresholdNotified === true,
    }
  }

  /**
   * Restore session state from disk after a restart.
   * Creates new sessions using saved parameters. SdkSession can resume
   * via resumeSessionId; CliSession starts fresh (process state is ephemeral).
   * @returns {string|null} The first restored session ID, or null
   */
  restoreState() {
    // #6276: reap orphaned user-shell PTYs FIRST — before the no-prior-state
    // early return below — so it runs on EVERY boot. A SIGKILL/crash skips
    // destroySession's SIGTERM, leaving a `$SHELL` reparented to init with no
    // destroy-audit entry; the daemon may have no session state to restore yet
    // still have a live orphaned shell recorded in the sidecar, so this cannot
    // hang off state restoration. Runs unconditionally (independent of the
    // userShell.enabled gate, so a shell from when the feature was enabled is
    // cleaned up after it's turned off). No-op when the sidecar is absent (the
    // clean-shutdown case). Best-effort — a reaper hiccup never affects boot.
    try {
      const { reaped, skipped } = reapOrphanShells(this._userShellSidecarPath, this._userShellReapSeams)
      for (const r of reaped) {
        auditShellDestroy({ sessionId: r.sessionId, exitCode: null, reason: 'orphan_reaper' })
      }
      if (reaped.length || skipped.length) {
        log.warn(`user-shell orphan reaper: reaped=${reaped.length} skipped=${skipped.length}`)
      }
    } catch (err) {
      log.warn(`user-shell orphan reaper failed (non-fatal): ${err?.message || err}`)
    }

    const state = this._persistence.restoreState()
    if (!state) return null

    const hasVersion = typeof state.version === 'number'

    let firstId = null
    let anyFailure = false
    const oldToNew = new Map() // old serialized session ID → new session ID
    for (const saved of state.sessions) {
      try {
        // skipPersist: we rewrite the state file once at the end of
        // restoreState, after history and cost budget have been reseeded.
        // Flushing per-session here would overwrite the on-disk file with
        // empty history for all not-yet-processed sessions, erasing the
        // data we're trying to restore.
        const sessionId = this.createSession({
          // #4983 — reuse the persisted ID so dashboard's localStorage-
          // cached activeSessionId still resolves after a daemon restart.
          // createSession validates the format (32-char lower-case hex);
          // a malformed or duplicate id falls back to randomBytes so the
          // call still succeeds. The dashboard's #4982 SESSION_NOT_FOUND
          // chip is the safety net for the malformed/missing/cross-host
          // cases that this preservation can't help with.
          preserveId: saved.id,
          name: saved.name,
          cwd: saved.cwd,
          model: saved.model,
          permissionMode: saved.permissionMode,
          resumeSessionId: saved.sdkSessionId,
          provider: saved.provider || undefined,
          // #5310 (WP-0.4) — rebind to the existing worktree (don't recreate).
          // Only string paths flow through; non-worktree sessions and older
          // state files (no field) pass undefined and take the normal path.
          restoreWorktreePath: typeof saved.worktreePath === 'string' && saved.worktreePath.length > 0
            ? saved.worktreePath
            : undefined,
          restoreWorktreeRepoDir: typeof saved.worktreeRepoDir === 'string' && saved.worktreeRepoDir.length > 0
            ? saved.worktreeRepoDir
            : undefined,
          // #4664: restore per-session toggle/string settings via the
          // shared registry. Each registry entry's `acceptFromConstructor`
          // predicate drops malformed values to `undefined` so
          // createSession applies BaseSession's default — exact match for
          // the pre-refactor per-knob behaviour, and older state files
          // (without these fields) round-trip cleanly.
          ...restorePerSessionSettings(saved),
          // #3639: forward the persisted skip-pattern source. Non-string /
          // empty values are dropped (createSession ignores them) so older
          // state files restore as null. Kept out of the registry because
          // the empty-string-as-null wire shape doesn't fit the
          // boolean/string factory.
          promptEvaluatorSkipPattern: typeof saved.promptEvaluatorSkipPattern === 'string' && saved.promptEvaluatorSkipPattern.length > 0
            ? saved.promptEvaluatorSkipPattern
            : undefined,
          // #3540: forward the persisted stdin_disabled latch. Only
          // truthy values flip the flag; pre-#3540 state files (no
          // field) restore as `false`. The SdkSession constructor
          // initialises `_stdinForwardingDisabled` from this opt and
          // the existing `_attachSidecarProcessListeners` short-circuit
          // ensures no warn/error is re-emitted on restore — clients
          // observe the disabled state via session_list metadata.
          stdinForwardingDisabled: saved.stdinForwardingDisabled === true ? true : undefined,
          // #6824: forward the persisted parked MCP server set so the respawned
          // BYOK fleet skips starting them. Non-array / empty values are
          // dropped (createSession only forwards a non-empty string array), so
          // older state files restore with nothing parked.
          disabledMcpServers: Array.isArray(saved.disabledMcpServers) && saved.disabledMcpServers.length > 0
            ? saved.disabledMcpServers.filter((n) => typeof n === 'string')
            : undefined,
          // Restore the previously-booted model (#3700b) so the dashboard
          // dropdown shows the real model on reconnect, not the registry
          // fallback. createSession() ignores non-string / empty values so
          // older state files (pre-#3700b) restore cleanly as null.
          bootedModel: typeof saved.bootedModel === 'string' && saved.bootedModel.length > 0
            ? saved.bootedModel
            : undefined,
          // Restore the messageId counter so new turns don't reuse old IDs
          // and collide with dashboard-cached messages (#3700).
          messageCounter: typeof saved.messageCounter === 'number' && Number.isFinite(saved.messageCounter) && saved.messageCounter >= 0
            ? saved.messageCounter
            : undefined,
          // Mailbox (#5914 follow-up): re-register the persisted AGENT_COMM_ID so
          // a restored session is reachable by the live-interrupt route again.
          // createSession validates it (drops bad values to a no-op); older
          // state files (no field) restore with no mailbox identity.
          agentCommId: typeof saved.agentCommId === 'string' && saved.agentCommId.length > 0
            ? saved.agentCommId
            : undefined,
          skipPersist: true,
          // #5316 (WP-2.2) — mark this as a restore so an ASYNC provider
          // start() rejection (claude-tui PTY warmup death) preserves the
          // restored history + worktree instead of destroying them.
          isRestore: true,
        })
        if (saved.id) oldToNew.set(saved.id, sessionId)
        // #4089 / #4124: restore the per-session running totals + the
        // threshold-notified latch onto the freshly-created entry. We do
        // this AFTER createSession so the entry exists, and BEFORE
        // history replay so a synthetic result event during replay
        // (unlikely but defensive) doesn't double-count. Validate shape:
        // missing / corrupt cumulativeUsage falls back to all-zero;
        // non-boolean costThresholdNotified falls back to false.
        //
        // Per-field clamps:
        //   - Token counts + turnsBilled are monotonic counters; corrupt
        //     state with negatives clamps to 0.
        //   - costUsd accepts negatives per #4099 (refund / credit
        //     adjustments). Only non-finite values fall back to 0.
        const restoredEntry = this._sessions.get(sessionId)
        const nonNegFinite = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)
        if (restoredEntry) {
          if (saved.cumulativeUsage && typeof saved.cumulativeUsage === 'object') {
            const u = saved.cumulativeUsage
            restoredEntry.cumulativeUsage = {
              inputTokens: nonNegFinite(u.inputTokens),
              outputTokens: nonNegFinite(u.outputTokens),
              cacheReadTokens: nonNegFinite(u.cacheReadTokens),
              cacheCreationTokens: nonNegFinite(u.cacheCreationTokens),
              costUsd: Number.isFinite(u.costUsd) ? u.costUsd : 0,
              turnsBilled: nonNegFinite(u.turnsBilled),
            }
          }
          if (saved.costThresholdNotified === true) {
            restoredEntry.costThresholdNotified = true
          }
        }
        // Keep _sessionCounter ahead of any restored "Session N" names so the
        // first new auto-named session after restore never collides (#2338).
        if (saved.name) {
          const match = saved.name.match(/^Session (\d+)$/)
          if (match) {
            const n = parseInt(match[1], 10)
            if (n > this._sessionCounter) this._sessionCounter = n
          }
        }
        // Restore message history if present (v1+).
        // Sweep any `tool_start` that lacks a matching `tool_result` and
        // splice in a synthetic interrupted result (#4617) BEFORE seeding
        // history so the subsequent dashboard history replay never sees a
        // dangling tool_start. Without this, an unresolved tool_use from
        // before shutdown re-enters `activeTools` on replay and never gets
        // cleared — the footer shows "Running X · Nh Mm" forever.
        if (hasVersion && Array.isArray(saved.history) && saved.history.length > 0) {
          const swept = SessionMessageHistory.sweepUnresolvedToolStarts(saved.history)
          this._history.setHistory(sessionId, swept)
        }
        if (typeof saved.lastActivityAt === 'number' && Number.isFinite(saved.lastActivityAt) && saved.lastActivityAt > 0) {
          this._sessionLastActivityAt.set(sessionId, saved.lastActivityAt)
        }
        if (!firstId) firstId = sessionId
        log.info(`Restored session "${saved.name}" (SDK resume: ${saved.sdkSessionId || 'none'})`)
      } catch (err) {
        // Guardian FM-01 (#2954): don't silently drop the session. Track it
        // so serializeState() rewrites it back to disk (preserving history)
        // and surface an event so clients can show a "needs attention" UI.
        anyFailure = true
        const failedId = this._registerFailedRestore(saved, err)
        // Advance _sessionCounter past failed "Session N" names too, so any
        // new sessions created during this boot don't collide with the name
        // still occupying disk state.
        if (saved.name) {
          const match = saved.name.match(/^Session (\d+)$/)
          if (match) {
            const n = parseInt(match[1], 10)
            if (n > this._sessionCounter) this._sessionCounter = n
          }
        }
        log.error(`Failed to restore session "${saved.name}" (${saved.provider || 'default'}): ${err.message}`)
        this.emit('session_restore_failed', {
          sessionId: failedId,
          name: saved.name,
          provider: saved.provider || this._providerType,
          cwd: saved.cwd,
          model: saved.model || null,
          permissionMode: saved.permissionMode || null,
          errorCode: err?.code || 'RESTORE_FAILED',
          errorMessage: err?.message || String(err),
          originalHistoryPreserved: true,
          historyLength: Array.isArray(saved.history) ? saved.history.length : 0,
        })
      }
    }

    // Restore cost tracking data (v1+), remapping old IDs to new IDs.
    this._costBudget.restore(state, oldToNew.size > 0 ? oldToNew : null)

    // Swarm-audit: drop failed-restore entries whose session has been inactive
    // past the TTL. A chronically-failing session (e.g. a missing env var the
    // user never fixes) otherwise re-fails + re-persists on EVERY boot, growing
    // _failedRestores + session-state.json without bound (clearFailedRestore is
    // only called on a user retry/dismiss, which may never come). Runs BEFORE the
    // flush (so the prune lands on disk) and BEFORE the worktree sweep (so a
    // pruned session's worktree is reclaimed too).
    this._pruneStaleFailedRestores()

    // Now that history and budget are reseeded, flush once so the on-disk
    // state reflects the restored state (and so any subsequent abrupt
    // shutdown preserves it). Flush if we restored any session OR had any
    // failure — otherwise the next successful save would drop failed-restore
    // entries. (serializeState() re-includes them from _failedRestores.)
    if (firstId || anyFailure) this._flushPersist()

    // #5859 (audit P1-7): now that the live session set is rebuilt, sweep
    // orphaned chroxy session worktrees — dirs under the worktree base whose
    // session id is no longer live (left by a SIGKILL / crash / dropped state
    // file; P0-3 stopped deleting them on clean shutdown, so they accrue). Opt-in
    // and clean-tree-guarded (never deletes uncommitted/untracked/ignored work);
    // best-effort so a GC hiccup never affects boot.
    if (this._sweepOrphanWorktrees) {
      try {
        // The live set MUST include FAILED-restore sessions: those are kept in
        // _failedRestores keyed by their original id (= the worktree dir
        // basename) with worktreePath preserved on disk for a later retry
        // (#2954). Treating their clean worktree as an orphan would delete the
        // very checkout #2954 preserves — and a --detach worktree's commits
        // would become unreachable. Union both so neither live nor failed-but-
        // retained sessions are ever swept.
        const liveSessionIds = new Set([...this._sessions.keys(), ...this._failedRestores.keys()])
        const report = sweepOrphanChroxyWorktrees({
          worktreeBase: this._worktreeBase || DEFAULT_WORKTREE_BASE,
          liveSessionIds,
        })
        if (report.removed.length || report.skippedDirty.length || report.skippedError.length) {
          log.info(`worktree orphan sweep: removed=${report.removed.length} skippedDirty=${report.skippedDirty.length} skippedError=${report.skippedError.length} (scanned ${report.scanned})`)
        }
      } catch (err) {
        log.warn(`worktree orphan sweep failed (non-fatal): ${err?.message || err}`)
      }
    }

    return firstId
  }

  /**
   * Register a failed-restore entry so its history is preserved on disk.
   * Returns the synthetic session ID used for external reporting.
   * @param {object} saved - The saved session payload from the state file
   * @param {Error} err - The error thrown during restore
   * @returns {string} sessionId
   * @private
   */
  _registerFailedRestore(saved, err) {
    // Reuse the saved id when present so the client-visible identity is
    // stable across restart attempts; fall back to a random id otherwise.
    const sessionId = saved.id || randomBytes(16).toString('hex')
    this._failedRestores.set(sessionId, { saved, error: err })
    return sessionId
  }

  /**
   * Drop failed-restore entries whose session has been inactive longer than the
   * TTL, so a chronically-failing session can't grow _failedRestores +
   * session-state.json without bound across boots. Conservative by design: a
   * recently-active failure is KEPT (it still surfaces in the "needs attention"
   * UI for retry), and an entry with no usable timestamp is kept rather than
   * guessed-stale. Failed-restore entries are display + retry only, so pruning a
   * long-dead one has no operational effect beyond removing the stale UI entry.
   * Worktree-backed failed-restores are NEVER pruned (guard below) so the #2954
   * worktree-preservation contract is never widened by this cleanup.
   * @param {number} [now]
   * @returns {number} count pruned
   */
  _pruneStaleFailedRestores(now = Date.now()) {
    const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
    let pruned = 0
    for (const [sessionId, entry] of this._failedRestores) {
      const saved = entry?.saved
      // NEVER prune a worktree-backed failed-restore. Removing its id from the
      // live set exposes its worktree to the orphan sweep, whose clean-tree guard
      // can't see committed-but-UNREACHABLE commits on a --detach worktree (#2954)
      // and would reclaim (then GC) that work. Bounding only the worktree-less
      // entries still closes the common unbounded-growth case (config-error
      // restores) without widening the #2954 worktree-preservation contract.
      if (saved?.worktreePath) continue
      const last = (typeof saved?.lastActivityAt === 'number' && saved.lastActivityAt > 0)
        ? saved.lastActivityAt
        : (typeof saved?.createdAt === 'number' && saved.createdAt > 0 ? saved.createdAt : null)
      if (last !== null && Number.isFinite(last) && now - last > TTL_MS) {
        this._failedRestores.delete(sessionId)
        pruned++
        log.info(`Pruned stale failed-restore "${saved?.name || sessionId}" (inactive since ${new Date(last).toISOString()})`)
      }
    }
    if (pruned > 0) log.info(`Pruned ${pruned} stale failed-restore session(s) (inactive > 30d)`)
    return pruned
  }

  /**
   * Return the list of sessions that failed to restore at startup.
   * UI uses this to show a "needs attention" state with a retry affordance.
   * @returns {Array<{ sessionId, name, provider, errorCode, errorMessage, needsAttention, historyLength }>}
   */
  getFailedRestores() {
    const list = []
    for (const [sessionId, { saved, error }] of this._failedRestores) {
      list.push({
        sessionId,
        name: saved.name,
        provider: saved.provider || this._providerType,
        cwd: saved.cwd,
        model: saved.model || null,
        permissionMode: saved.permissionMode || null,
        errorCode: error?.code || 'RESTORE_FAILED',
        errorMessage: error?.message || String(error),
        needsAttention: true,
        historyLength: Array.isArray(saved.history) ? saved.history.length : 0,
      })
    }
    return list
  }

  /**
   * Clear a failed-restore entry. Called after a successful retry (or when
   * the user dismisses the failed session so it stops reappearing).
   * @param {string} sessionId
   * @returns {boolean} true if an entry was cleared
   */
  clearFailedRestore(sessionId) {
    if (!this._failedRestores.has(sessionId)) return false
    this._failedRestores.delete(sessionId)
    this._flushPersist()
    return true
  }

  /**
   * Check if all sessions are idle (not busy).
   * Used by drain protocol to wait for in-flight work.
   * @returns {boolean}
   */
  allIdle() {
    for (const [, entry] of this._sessions) {
      if (entry.session.isRunning) return false
    }
    return true
  }

  /**
   * Get message history for a session.
   * @returns {Array<{ type, ...data }>}
   */
  getHistory(sessionId) {
    return this._history.getHistory(sessionId)
  }

  /**
   * Get the count of messages in the ring buffer for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getHistoryCount(sessionId) {
    return this._history.getHistoryCount(sessionId)
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  isHistoryTruncated(sessionId) {
    return this._history.isHistoryTruncated(sessionId)
  }

  /**
   * #5555.3 — seq of the oldest history entry still retained in the ring
   * buffer (null when empty). The cursor-replay path compares a client's
   * `lastSeq` against this to detect a trim gap.
   * @param {string} sessionId
   * @returns {number|null}
   */
  getOldestHistorySeq(sessionId) {
    return this._history.getOldestSeq(sessionId)
  }

  /**
   * #5555.3 — seq of the newest history entry (0 when empty). When a client's
   * `lastSeq >= this`, there is nothing newer to replay.
   * @param {string} sessionId
   * @returns {number}
   */
  getLatestHistorySeq(sessionId) {
    return this._history.getLatestSeq(sessionId)
  }

  /**
   * Get the conversation ID (SDK session ID) for a session.
   * @returns {string|null}
   */
  getConversationId(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return null
    return entry.session.resumeSessionId || null
  }

  /**
   * Get full conversation history asynchronously by reading the JSONL file.
   * Avoids blocking the event loop for large files (use in WS handlers).
   * Falls back to the ring buffer if JSONL is unavailable.
   * @returns {Promise<Array<{ type, content, tool?, timestamp, messageId? }>>}
   */
  async getFullHistoryAsync(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry || entry._destroying) return []

    const conversationId = entry.session.resumeSessionId
    if (conversationId) {
      try {
        const filePath = resolveJsonlPath(entry.cwd, conversationId)
        const history = await readConversationHistoryAsync(filePath)
        if (history.length > 0) return history
      } catch (err) {
        log.error(`Failed to read JSONL history for session ${sessionId}: ${err?.message || err}`)
      }
    }

    // Fallback to ring buffer
    return this.getHistory(sessionId)
  }

  /**
   * Record a user input message in the session's history ring buffer.
   * Public API for ws-server to record user messages so they survive reconnect replay.
   *
   * On the first non-empty input, auto-labels sessions with default names
   * ("Session N" or "New Session") to a truncation of the input text.
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {string} [messageId] - Stable ID propagated to replay and the
   *   live-echo broadcast so clients can dedup their optimistic copy against
   *   rehydrated history on reconnect (issue #2902).
   */
  recordUserInput(sessionId, text, messageId) {
    const entry = this._sessions.get(sessionId)
    this._history.recordUserInput(sessionId, text, entry || undefined, messageId)
  }

  /**
   * Record an event into the session's message history ring buffer.
   * Delegates to SessionMessageHistory and triggers persist when needed.
   */
  _recordHistory(sessionId, event, data) {
    const { persistNeeded, truncated } = this._history.recordHistory(sessionId, event, data)
    if (persistNeeded) {
      this._schedulePersist()
    }
    if (truncated) {
      // #6431 — an over-size stream delta was dropped from history. The client
      // still received it (forwarded independently via the stream_delta proxy),
      // so its local copy now diverges from the persisted message. Surface a
      // client-visible error so the truncation is observable instead of a silent
      // desync. Emitted once per stream (the history layer dedupes).
      // The event-normalizer's generic `error` builder forwards only `message`
      // + `code` to clients, so the payload is kept to exactly what reaches them
      // — no dead `messageId` / `recoverable` fields that would imply a
      // correlation the wire never delivers (#6431 review).
      this.emit('session_event', {
        sessionId,
        event: 'error',
        data: {
          code: 'stream_truncated',
          message: 'A response exceeded the server buffer limit and was truncated server-side; the saved message may be incomplete.',
        },
      })
    }
  }

  /**
   * Push an entry to the history array, trimming to max size.
   * Backward-compatible delegate to SessionMessageHistory._pushHistory.
   * @param {Array} history - The session history array to push to
   * @param {object} entry - The history entry to add
   * @param {string} sessionId - The session ID (used for truncation tracking)
   */
  _pushHistory(history, entry, sessionId) {
    this._history._pushHistory(history, entry, sessionId)
  }

  /**
   * Schedule a debounced persist. Multiple rapid calls reset the timer.
   * No-op once `destroyAll()` has run — see `serializeState()` (#3697).
   */
  _schedulePersist() {
    if (this._destroying) return
    this._persistence.schedulePersist(() => this.serializeState())
  }

  /**
   * Flush persist synchronously, bypassing the debounce. Use for session-list
   * mutations (create/rename/destroy) where losing the write on abrupt
   * shutdown erases a user's session. History/budget updates should keep
   * using the debounced path to avoid write amplification.
   */
  _flushPersist() {
    return this._persistence.flushPersist(() => this.serializeState())
  }

  /**
   * #5701: flush a session-list mutation and surface a failure instead of
   * swallowing it. flushPersist used to catch-and-log write errors (disk full,
   * locked file, read-only home), so a create/rename/destroy could succeed in
   * memory yet never reach disk and silently revert on the next restart. Now a
   * failed flush is logged at error level with an operator-actionable hint and
   * emits `session_persist_failed` so it is observable. (A client-facing banner
   * is a follow-up — it needs a new wire message type; `session_warning` is
   * reserved for the idle-timeout countdown UI and must not be overloaded.)
   * @param {string} sessionId
   * @param {string|null} name - pass explicitly to control the logged label:
   *   the new name on rename, or the entry's name on destroy (where the entry
   *   is already removed from `_sessions` before this flush, so a lookup would
   *   be nameless). Omit to look it up from `_sessions`.
   * @returns {boolean} true if the write succeeded.
   */
  _flushPersistOrWarn(sessionId, name = null) {
    if (this._flushPersist()) return true
    const resolvedName = name || this._sessions.get(sessionId)?.name || null
    log.error(`Session state for ${sessionId}${resolvedName ? ` ("${resolvedName}")` : ''} was NOT persisted — it may be lost on restart. Check disk space and write permissions for ${this._stateFilePath}.`)
    this.emit('session_persist_failed', { sessionId, name: resolvedName })
    return false
  }

  /**
   * Wire session events to unified session_event emission.
   * Handles both CliSession and PtySession events.
   */
  _wireSessionEvents(sessionId, session) {
    // #5431: background_tasks_changed — claude-tui's idle transcript re-scan
    // reporting that outstanding background work changed (a task-notification
    // landed or a wakeup fired while no turn was running). Deliberately NOT
    // an ACTIVITY_EVENT: the session is idle by definition when it fires, so
    // it must not reset the idle timeout.
    const PROXIED_EVENTS = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result', 'result', 'error', 'user_question', 'background_tasks_changed']
    // Events that indicate meaningful activity (reset idle timeout)
    const ACTIVITY_EVENTS = new Set(['message', 'stream_start', 'tool_start', 'result', 'user_question'])
    // Session-scoped logger — entries are tagged with sessionId for per-session routing
    const sessionLog = log.withSession(sessionId)
    // Events worth logging to the System tab (skip noisy delta/tool_result)
    const LOGGED_EVENTS = new Set(['ready', 'stream_start', 'stream_end', 'result', 'error'])

    // #5835 Phase 1: claude-tui live PTY mirror (the "remote viewer" / authenticity
    // surface). These are transient, high-frequency redraw bytes — proxy them to
    // subscribed clients but keep them OUT of _recordHistory (not conversation
    // history) and OUT of touchActivity (a mirror frame is not user activity).
    // Wired separately from PROXIED_EVENTS for exactly that reason.
    session.on('terminal_output', (data) => {
      this.emit('session_event', { sessionId, event: 'terminal_output', data })
    })

    // #5835 Phase 2: authoritative live-PTY size changes (a primary viewer drove
    // a resize). Like terminal_output, transient and kept out of history/activity
    // — ws-forwarding broadcasts it to terminal subscribers as `terminal_size`.
    session.on('terminal_resize', (data) => {
      this.emit('session_event', { sessionId, event: 'terminal_resize', data })
    })

    // #5982 — auto-remove a user-shell session when its PTY exits on its own
    // (the user typed `exit`, or the shell died). A short grace lets a live
    // viewer read the "[shell exited]" marker, then the session is destroyed so
    // no dead zombie shells linger in the list. UserShellSession emits
    // `shell_exited` ONLY from its natural-exit path; an explicit destroySession
    // detaches this listener first (removeAllListeners), so a deliberate
    // teardown never schedules a redundant auto-remove. The timer is unref'd so
    // it can't keep the process alive, and re-checks the session still exists
    // (and isn't already tearing down) before destroying.
    if (session.constructor?.isUserShell === true) {
      // #6276: record the live PTY pid to the orphan-reaper sidecar so a shell
      // left running by an ungraceful daemon death (SIGKILL/crash, which skips
      // destroySession's SIGTERM) can be reaped + audited on the next boot. The
      // matching record is dropped by destroySession on a clean teardown.
      session.on('shell_spawned', ({ pid } = {}) => {
        recordShell(this._userShellSidecarPath, { sessionId, pid, shell: session._shellPath })
      })
      session.on('shell_exited', () => {
        const timer = setTimeout(() => {
          const entry = this._sessions.get(sessionId)
          if (entry && !entry._destroying) {
            log.info(`Auto-removing exited user-shell session ${sessionId}`)
            // Calls destroySession directly, intentionally bypassing the
            // handler-layer "cannot destroy the last session" guard: that guard
            // stops a USER from emptying their list, not a dead shell from being
            // reaped — a zombie shell shouldn't be force-kept just because it's
            // the last session.
            this.destroySession(sessionId)
          }
        }, AUTO_REMOVE_ON_EXIT_DELAY_MS)
        if (typeof timer.unref === 'function') timer.unref()
      })
    }

    for (const event of PROXIED_EVENTS) {
      session.on(event, (data) => {
        if (ACTIVITY_EVENTS.has(event)) this.touchActivity(sessionId)
        this._recordHistory(sessionId, event, data)
        this.emit('session_event', { sessionId, event, data })
        if (LOGGED_EVENTS.has(event)) {
          const detail = event === 'error' ? `: ${data?.message || ''}` : ''
          const logFn = event === 'error' ? sessionLog.error : sessionLog.info
          logFn(`[${event}]${detail}`)
        }

        // When SDK session reports ready, emit conversation_id if available
        if (event === 'ready' && session.resumeSessionId) {
          this.emit('session_event', {
            sessionId,
            event: 'conversation_id',
            data: { conversationId: session.resumeSessionId },
          })
        }

        // Track cumulative cost and token usage on turn-terminal events.
        // Both `result` (success path) AND `error` (failure path, partial
        // spend surfaced by #5037) fold into the same cumulative tracker —
        // otherwise the user-billed tokens on a failed turn would silently
        // drop out of cumulativeUsage / sessionCost / budget gates (#5038).
        //
        // Billing-class cost contract (#5630/#5629): which turns produce a
        // real dollar figure depends on the session's billing class.
        //   - subscription (claude-tui/claude-channel, and HOST claude-cli/sdk
        //     BEFORE 2026-06-15): `total_cost_usd: null` → no per-turn dollar
        //     charge; the cost accumulator stays zero and the UI shows the
        //     no-dollar "Included (subscription)" chip.
        //   - programmatic-credit (HOST claude-cli/sdk ON/AFTER 2026-06-15):
        //     real metered credit spend — the provider now forwards a finite
        //     `total_cost_usd`, so the finite-cost gate below accumulates it
        //     exactly like api-key spend.
        //   - api-key (byok, docker-byok, docker-cli/sdk — which forward an
        //     ANTHROPIC_API_KEY into the container with no OAuth fallback — and
        //     every non-Claude provider): real per-token spend, always a finite
        //     cost (or `null` when pricing is unknown — see computePromptCostUsd,
        //     which now degrades 0→null; the finite gate skips a null without
        //     poisoning the accumulator).
        //
        // Two independent gates (#5115):
        //   1. COST gate — `Number.isFinite(data?.cost)`. Drives _trackCost
        //      (the $ accumulator + budget thresholds). Subscription-billed
        //      runs report `total_cost_usd: null`, so this stays zero for
        //      them (no dollar budget applies to a flat subscription).
        //   2. USAGE gate — finite cost OR finite `usage.input_tokens`.
        //      Drives _trackUsage (the cumulativeUsage token accumulator
        //      that lights up the dashboard header meter). A subscription
        //      `claude -p` turn carries real token counts with `cost: null`
        //      (#5095 / #5108 verified cli-session forwards the full usage
        //      payload verbatim), so the meter must ratchet on tokens, not
        //      cost. _trackUsage itself drops a non-finite cost via an
        //      explicit Number.isFinite coercion, so cumulativeCost is never
        //      poisoned even when this gate passes on tokens alone.
        //
        // Single-counting guarantee: each priced/usage-bearing turn folds
        // in exactly once.
        //   - Happy path: a single `result` (finite cost AND usage) per turn.
        //   - Subscription path: a single `result` (cost null, finite
        //     input_tokens) per turn → counted via the usage gate.
        //   - byok-session error path: a single `error` (finite cost for the
        //     partial spend, see #5037).
        //   - Stream-stall path (sdk-session._handleStreamStall and
        //     cli-session._handleStreamStall — the latter calls
        //     _emitInterruptedTurnResult for the synthetic `result` and
        //     then emits the `error` itself): emits BOTH a synthetic
        //     `result` AND `error` for the same turn — but the synthetic
        //     `result` carries `cost: null` AND `usage: null`, so BOTH gates
        //     filter it. The `error` half is plain stream-stall metadata
        //     (no cost / no usage field), also filtered by both gates.
        // No emit topology change is needed to add new failure paths as long
        // as they keep this invariant (terminal turn ⇒ at most one event
        // carrying a finite cost and/or finite input_tokens).
        //
        // Number.isFinite also guards against NaN / Infinity (provider
        // bugs) poisoning cumulative totals or triggering spurious budget
        // events (#4088 review).
        if (event === 'result' || event === 'error') {
          const hasFiniteCost = Number.isFinite(data?.cost)
          const hasFiniteTokens = Number.isFinite(data?.usage?.input_tokens)
          if (hasFiniteCost) {
            const sessionEntry = this._sessions.get(sessionId)
            const model = session.currentModel || sessionEntry?.model || null
            this._trackCost(sessionId, data.cost, model)
          }
          // #4072 / #5115: accumulate token usage for cumulative-display.
          // Runs when EITHER cost OR input_tokens is finite, so
          // subscription-only providers (cost: null, finite tokens) ratchet
          // the header meter (#5115) while NaN/Infinity-only payloads still
          // can't poison the accumulator.
          //
          // #5038: an errored turn DOES count as a billed turn — the user
          // was charged for the partial work — so `turnsBilled` ticks
          // exactly as it would on the success path.
          if (hasFiniteCost || hasFiniteTokens) {
            this._trackUsage(sessionId, data)
          }
        }
      })
    }

    // Transient events — forwarded but not recorded in history (not replayed on reconnect).
    // `skill_changed` (#3204) lands here so a paired dashboard / mobile client can
    // surface a "this skill's content has changed since first activation" prompt
    // without the event being replayed on every reconnect (the loader re-checks
    // the hash every time skills are scanned, so the latest state is always
    // canonical).
    // #4756: `stopped` is a transient signal — CliSession emits it when the
    // child process exits cleanly after a user-initiated Stop (see
    // cli-session.js `_handleChildClose`, gated on `_intentionalStop`). It
    // pairs with `error` (which fires for unexpected crashes that trigger
    // auto-respawn) so a paired dashboard / mobile client can render a quiet
    // "Session stopped." confirmation distinct from the louder crash toast.
    // Transient so it isn't replayed on reconnect — by the time a client
    // reconnects, either the session was destroyed or the user already saw
    // the confirmation.
    // #5016: `agent_event` carries a Task subagent's intermediate wire
    // events (tool_start / tool_result / tool_input_delta / stream_delta)
    // tagged with the parent's toolUseId. Transient (not replayed on
    // reconnect — the canonical Task tool_result fold lands in history).
    // #5160: `activity_delta` / `activity_snapshot` carry the Control Room
    // activity tree (ActivityRegistry on BaseSession). Transient — not
    // replayed from history; a reconnecting client gets the full tree from
    // the snapshot-on-subscribe in ws-history.sendSessionInfo.
    // #6832: `mcp_servers` (sdk/cli parse it off the live stream-json
    // `system/init`; claude-tui re-derives the CONFIGURED list on warmup /
    // respawn, #6820/#6831) is likewise transient — not recorded in history —
    // but a reconnecting/late-joining client still gets the current server
    // list via BaseSession's cached last payload, replayed in
    // ws-history.sendSessionInfo's snapshot-on-subscribe (getMcpServersSnapshot).
    // #5936: message_queued / message_dequeued mirror the server-authoritative
    // outgoing-message queue (BaseSession `_outgoingQueue`). Transient (like
    // activity_delta) — they are delta events, NOT replayed from history. This
    // slice ships only the deltas; a server→client queue SNAPSHOT (so a
    // reconnecting client can rehydrate any still-queued state) is the
    // store-core follow-up (#5937). Until then a client that reconnects
    // mid-queue won't see the pre-existing queued items — acceptable for the
    // foundation slice, tracked in #5937.
    const builtinTransient = ['permission_request', 'permission_resolved', 'permission_expired', 'agent_spawned', 'agent_completed', 'agent_event', 'plan_started', 'plan_ready', 'mcp_servers', 'skill_changed', 'skill_trust_request', 'skill_trust_granted', 'inactivity_warning', 'background_work_changed', 'stopped', 'activity_delta', 'activity_snapshot', 'message_queued', 'message_dequeued']
    const customEvents = Array.isArray(session.constructor.customEvents) ? session.constructor.customEvents : []
    const TRANSIENT_EVENTS = [...new Set([...builtinTransient, ...customEvents])]
    for (const event of TRANSIENT_EVENTS) {
      session.on(event, (data) => {
        this.emit('session_event', { sessionId, event, data })
      })
    }

    // models_updated is global (not per-session) — forward as transient event
    session.on('models_updated', (data) => {
      this.emit('session_event', { sessionId, event: 'models_updated', data })
    })

    // #5315 (WP-2.1) — a provider that exhausts its bounded PTY auto-respawn
    // budget emits `respawn_exhausted`. The transient-events loop above already
    // forwarded it to clients (it's in ClaudeTuiSession.customEvents); here we
    // ALSO drop the session from the list so the audit AC holds: the session
    // leaves the list with a clear error instead of lingering as an
    // input-rejecting zombie tab. Mirrors the session_timeout → destroySession
    // coordination (this file, ~457). Guard on _sessions.has so a duplicate
    // signal doesn't log a spurious "session not found" error — destroySession
    // logs + returns false on a missing id rather than no-opping silently.
    session.on('respawn_exhausted', (data) => {
      if (!this._sessions.has(sessionId)) return
      sessionLog.error(`[respawn_exhausted] ${data?.reason || 'pty respawn gave up'} — destroying session`)
      this.destroySession(sessionId)
    })
  }

  // ---------------------------------------------------------------------------
  // Session idle timeout (delegated to SessionTimeoutManager)
  // ---------------------------------------------------------------------------

  /**
   * Set the function used to check if a session has active WebSocket viewers.
   * Called by WsServer after construction to wire the two components together.
   * @param {(sessionId: string) => boolean} fn
   */
  setActiveViewersFn(fn) {
    this._timeoutManager.setActiveViewersFn(fn)
  }

  /**
   * Record activity for a session (resets idle timer).
   * Called internally on relevant events, and publicly by WsServer on user input.
   */
  touchActivity(sessionId) {
    this._sessionLastActivityAt.set(sessionId, Date.now())
    this._timeoutManager.touchActivity(sessionId)
  }

  /**
   * Expose internal timeout tracking state for backward compatibility.
   * Tests and internal code may reference these directly.
   */
  get _lastActivity() {
    return this._timeoutManager._lastActivity
  }

  get _sessionWarned() {
    return this._timeoutManager._sessionWarned
  }

  // ---------------------------------------------------------------------------
  // Cost budget tracking
  // ---------------------------------------------------------------------------

  /**
   * Track cumulative cost for a session and check budget thresholds.
   * @param {string} sessionId
   * @param {number} cost - Cost of the latest query in dollars
   */
  _trackCost(sessionId, cost, model = null) {
    const budgetEvent = this._costBudget.trackCost(sessionId, cost, model)
    const cumulative = this._costBudget.getSessionCost(sessionId)

    // Emit cost_update for every result so app can track cumulative cost
    const entry = this._sessions.get(sessionId)
    this.emit('session_event', {
      sessionId,
      event: 'cost_update',
      data: {
        sessionCost: cumulative,
        totalCost: this._costBudget.getTotalCost(),
        budget: this._costBudget.getBudget(),
      },
    })

    if (budgetEvent) {
      const budget = this._costBudget.getBudget()
      this.emit('session_event', {
        sessionId,
        event: budgetEvent.event,
        data: {
          ...budgetEvent.data,
          message: budgetEvent.event === 'budget_exceeded'
            ? `Session "${entry?.name || sessionId}" has exceeded the $${budget.toFixed(2)} budget ($${cumulative.toFixed(4)})`
            : `Session "${entry?.name || sessionId}" has used ${budgetEvent.data.percent}% of the $${budget.toFixed(2)} budget ($${cumulative.toFixed(4)})`,
        },
      })
    }
  }

  /**
   * Accumulate per-session token usage + cost across turns and broadcast
   * a `session_usage` event so subscribed clients can update their
   * cost/token badges live (#4072 — sub-task of #4054).
   *
   * Reads SDK-style usage shape (`input_tokens`, `output_tokens`,
   * `cache_read_input_tokens`, `cache_creation_input_tokens`) and the
   * `cost` field added by #4056. Emits the camelCased aggregate shape
   * for the UI.
   *
   * Defensive: if the entry has no `cumulativeUsage` (e.g. a custom
   * provider built the entry directly without going through createSession),
   * lazily initialize on first use so subsequent calls accumulate.
   * @param {string} sessionId
   * @param {{ usage?: object, cost?: number }} resultData
   */
  _trackUsage(sessionId, resultData) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return
    if (!entry.cumulativeUsage) entry.cumulativeUsage = makeZeroCumulativeUsage()
    const u = resultData?.usage || {}
    const acc = entry.cumulativeUsage
    // #5115: coerce each delta defensively before accumulating. Plain
    // `Number(x) || 0` does NOT reject Infinity (Infinity is truthy), so a
    // provider bug that reports Infinity tokens / cost would poison the
    // accumulator. Now that the usage gate lets `cost: null` / non-finite
    // cost through (so subscription tokens ratchet), the cost line in
    // particular MUST drop a non-finite cost rather than add it — exactly
    // the cumulativeCost-poison guard called out in #5115's acceptance
    // criteria and #4088.
    //
    // Per-field coercion mirrors the restore-time clamp (restoreState's
    // `nonNegFinite`) and CumulativeUsageSchema (@chroxy/protocol):
    //   - Token fields are monotonic NON-NEGATIVE integer counters. A
    //     negative provider delta (bug) would drive them below zero and
    //     violate the schema's `.nonnegative()` contract, so drop any delta
    //     that isn't a finite, >= 0 number.
    //   - costUsd is finite but intentionally SIGNED — a refund / credit
    //     adjustment turn (#4099) legitimately subtracts — so only reject
    //     a non-finite cost.
    const tokenDelta = (x) => (Number.isFinite(x) && x >= 0 ? x : 0)
    const finiteCost = (x) => (Number.isFinite(x) ? x : 0)
    acc.inputTokens += tokenDelta(Number(u.input_tokens))
    acc.outputTokens += tokenDelta(Number(u.output_tokens))
    acc.cacheReadTokens += tokenDelta(Number(u.cache_read_input_tokens))
    acc.cacheCreationTokens += tokenDelta(Number(u.cache_creation_input_tokens))
    acc.costUsd += finiteCost(Number(resultData?.cost))
    acc.turnsBilled += 1
    // #5630/#5629: carry the per-session billing class on the live usage
    // event so a client that joined before the first session_list (or after a
    // mid-session era flip) labels the cost row correctly without a refetch.
    // Resolved the same way as listSessions; defensive so a misbehaving
    // provider can't break the usage broadcast.
    const usageProvider = entry.provider || this._providerType
    let billingClass
    try {
      billingClass = getProviderAuthInfo(usageProvider, entry.session.constructor)?.billingClass
    } catch {
      billingClass = undefined
    }
    if (!billingClass) billingClass = billingClassForProvider(usageProvider, Date.now())
    // Shallow-copy on emit so a subscriber that mutates the payload
    // can't corrupt the canonical accumulator (#4072 review-prep).
    this.emit('session_event', {
      sessionId,
      event: 'session_usage',
      data: { cumulativeUsage: { ...acc }, billingClass },
    })
    // #5665: feed this turn's cost into the machine-wide monthly
    // programmatic-credit meter, but ONLY for programmatic-credit sessions
    // (claude-cli/sdk on/after the 2026-06-15 era). The era gate is implicit:
    // billingClass only resolves to PROGRAMMATIC_CREDIT post-boundary. Broadcast
    // the updated meter to ALL clients (it's per-machine, not per-session).
    if (billingClass === BILLING_CLASSES.PROGRAMMATIC_CREDIT) {
      // Pass the RAW cost (not finiteCost-coerced) so recordSpend's own
      // Number.isFinite guard drops a non-finite turn entirely — coercing to 0
      // here would still bump turnsBilled for a turn with no real cost.
      const { status, justWarned, justExceeded } = this._creditBudget.recordSpend(Number(resultData?.cost), Date.now())
      this.emit('session_event', {
        sessionId,
        event: 'monthly_budget',
        data: { ...status, justWarned, justExceeded },
      })
    }
    // #4075: soft threshold crossing. Fire ONCE per session: the latch
    // (`costThresholdNotified`) stays true for the session's lifetime so
    // a tool-heavy turn that crosses the threshold doesn't spam the
    // banner. Subscription-billed providers never trigger this because
    // their cost stays at 0 — the `> 0` gate on the threshold itself
    // also short-circuits when an operator disables the feature.
    //
    // Both the latch and `cumulativeUsage` are persisted in the
    // session-state snapshot (#4089 / #4124), so the warning fires once
    // per LOGICAL session — survives server restarts and matches what
    // the dashboard / mobile UI shows.
    if (
      this._costThresholdUsd > 0 &&
      !entry.costThresholdNotified &&
      acc.costUsd >= this._costThresholdUsd
    ) {
      entry.costThresholdNotified = true
      this.emit('session_event', {
        sessionId,
        event: 'session_cost_threshold_crossed',
        data: {
          costUsd: acc.costUsd,
          thresholdUsd: this._costThresholdUsd,
        },
      })
    }
  }

  /**
   * #5665: current monthly programmatic-credit meter snapshot (machine-wide).
   * Sent to a client on connect so a freshly-loaded dashboard shows the meter
   * without waiting for the next billed turn. Shape mirrors the `monthly_budget`
   * event payload (minus the one-shot justWarned/justExceeded flags).
   */
  getMonthlyBudgetStatus() {
    return this._creditBudget.getStatus(Date.now())
  }

  /**
   * #4075: Validate + clamp a costThresholdUsd input. Accepts finite
   * non-negative numbers; coerces null/undefined to the supplied default;
   * rejects strings, NaN, Infinity, negatives.
   * @param {unknown} value
   * @param {number} fallback
   * @returns {number} threshold in USD; 0 means "disabled"
   */
  _normalizeCostThreshold(value, fallback) {
    if (value === null || value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fallback
    }
    return value
  }

  /**
   * #4601: Sanitise a per-provider timeout-override map at construction time.
   *
   * Returns a NEW plain object containing only the entries whose value passed
   * `isOperatorTimeoutInRange`. Non-object inputs return `null` (no overrides
   * apply). Each rejected entry logs ONE warn line tagged with the offending
   * provider id so an operator scanning logs can correlate it back to the
   * config.json key path.
   *
   * Keeping the validation here (vs. inlining it in createSession) means
   * each session boot does a single map lookup instead of revalidating
   * every entry on every call.
   *
   * @param {unknown} input — raw config map (object | null | undefined | bogus)
   * @param {object} opts
   * @param {string} opts.name — config-key prefix used in warn logs
   *   (e.g. `providerStreamStallTimeoutMs`); each rejected entry is logged as
   *   `<name>.<providerId>` so the warn matches the operator's config path.
   * @param {boolean} [opts.allowZero=false] — passed through to
   *   `isOperatorTimeoutInRange` (set true for stream-stall, which uses 0 as
   *   an explicit per-provider disable).
   * @returns {object|null} sanitised entries, or null if the input wasn't a
   *   plain object.
   */
  _sanitizeProviderTimeoutMap(input, { name, allowZero = false }) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const sanitised = {}
    const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000
    for (const [providerId, value] of Object.entries(input)) {
      const ok = isOperatorTimeoutInRange(value, { allowZero, name: `${name}.${providerId}`, log })
      if (ok) {
        sanitised[providerId] = value
        continue
      }
      // `isOperatorTimeoutInRange` already emits a tagged warn for the
      // over-ceiling case (see duration.js:39); avoid duplicating it
      // here. The lower-bound / non-finite / negative paths return
      // false silently, so we still need to surface those — emit ONE
      // warn so an operator scanning logs can correlate the dropped
      // entry back to the config.json key path.
      const numericValue = typeof value === 'number' ? value : NaN
      if (Number.isFinite(numericValue) && numericValue > MAX_SANE_DURATION_MS) continue
      log.warn(`ignoring invalid entry '${name}.${providerId}'=${String(value)} — falling back to global / default`)
    }
    return sanitised
  }

  /**
   * #4075: Get the current cost threshold (USD). 0 means disabled.
   * @returns {number}
   */
  getCostThresholdUsd() {
    return this._costThresholdUsd
  }

  /**
   * #4075: Update the cost threshold at runtime (e.g. from the dashboard
   * settings panel). Setting to 0 disables the soft warning. Does NOT
   * reset per-session latches — operators raising the threshold mid-
   * session won't re-trigger an already-fired warning on the SAME session,
   * since the latch records "we already warned." Lowering the threshold
   * causes the next turn that crosses the new threshold to fire as
   * expected on sessions that haven't yet been notified.
   *
   * Invalid input (negative, NaN, Infinity, non-number) is silently
   * coerced to the CURRENT value via `_normalizeCostThreshold`'s
   * fallback — bad input is a no-op. Callers that want to validate
   * up-front should compare the return value against the input.
   * @param {number} value USD; must be a finite non-negative number
   * @returns {number} the applied value (unchanged if input was invalid)
   */
  setCostThresholdUsd(value) {
    this._costThresholdUsd = this._normalizeCostThreshold(value, this._costThresholdUsd)
    return this._costThresholdUsd
  }

  /**
   * Read the current cumulative usage for a session, or null if missing.
   * Returns a shallow copy so callers can't mutate the canonical entry.
   * @param {string} sessionId
   */
  getCumulativeUsage(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry?.cumulativeUsage) return null
    return { ...entry.cumulativeUsage }
  }

  /**
   * Start periodic session timeout checks.
   * Only starts if sessionTimeout was configured.
   */
  startSessionTimeouts() {
    this._timeoutManager.start()
  }

  /**
   * Stop periodic session timeout checks.
   */
  stopSessionTimeouts() {
    this._timeoutManager.stop()
  }

  getSessionCost(sessionId) {
    return this._costBudget.getSessionCost(sessionId)
  }

  getTotalCost() {
    return this._costBudget.getTotalCost()
  }

  getCostBudget() {
    return this._costBudget.getBudget()
  }

  isBudgetPaused(sessionId) {
    return this._costBudget.isPaused(sessionId)
  }

  resumeBudget(sessionId) {
    this._costBudget.resume(sessionId)
    this._schedulePersist()
    log.info(`Budget pause overridden for session ${sessionId}`)
  }

  getCostByModel() {
    return this._costBudget.getCostByModel()
  }

  getSpendRate() {
    return this._costBudget.getSpendRate()
  }
}
