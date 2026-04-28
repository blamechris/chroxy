/**
 * Shared stateless message handler functions.
 *
 * Each function takes a raw WebSocket message and optional context,
 * returning a state patch or transformed data. No side effects — consumers
 * apply the patches to their own store however they see fit.
 *
 * These extract the shared logic that was duplicated between the mobile app
 * and web dashboard message handlers.
 */

import type {
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ConversationSummary,
  DevPreview,
  SessionInfo,
} from '../types'
import { nextMessageId, stripAnsi } from '../utils'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a string field from a message, returning trimmed value or null. */
function parseStringField(msg: Record<string, unknown>, field: string): string | null {
  const val = msg[field]
  if (typeof val === 'string' && val.trim()) return val.trim()
  return null
}

/**
 * Parse a string field WITHOUT trimming or empty-string coercion.
 *
 * Some legacy inline checks used `typeof v === 'string' ? v : null` — that
 * passes through empty strings and whitespace verbatim. `auth_ok.cwd` is one
 * such field; preserve the prior behaviour so this migration is mechanical.
 */
function parseRawStringField(msg: Record<string, unknown>, field: string): string | null {
  const val = msg[field]
  return typeof val === 'string' ? val : null
}

/**
 * Build a small union-checking helper that returns the value when it matches
 * one of the provided literals, else null. Used for enum fields like
 * `serverMode` and `mode`.
 */
function parseEnumField<T extends string>(
  msg: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | null {
  const val = msg[field]
  return typeof val === 'string' && (allowed as readonly string[]).includes(val)
    ? (val as T)
    : null
}

// ---------------------------------------------------------------------------
// Session-scoped state patches
//
// Many handlers follow a common pattern: resolve a target session ID from
// the message (falling back to the active session), then produce a patch
// for that session's state. The `SessionPatch` type captures this.
// ---------------------------------------------------------------------------

/** A patch to apply to a specific session's state. */
export interface SessionPatch {
  /** Session ID the patch targets (may be null if no session context). */
  sessionId: string | null
  /** Partial session state to shallow-merge. */
  patch: Record<string, unknown>
}

/**
 * Resolve which session a message targets.
 * Most server messages include an optional `sessionId`; when absent, the
 * active session ID is used as a fallback.
 */
export function resolveSessionId(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): string | null {
  return parseStringField(msg, 'sessionId') || activeSessionId
}

// ---------------------------------------------------------------------------
// model_changed
// ---------------------------------------------------------------------------

/** Extract the model value from a `model_changed` message. */
export function handleModelChanged(msg: Record<string, unknown>): { model: string | null } {
  return { model: parseStringField(msg, 'model') }
}

// ---------------------------------------------------------------------------
// permission_mode_changed
// ---------------------------------------------------------------------------

/** Extract the permission mode from a `permission_mode_changed` message. */
export function handlePermissionModeChanged(msg: Record<string, unknown>): { mode: string | null } {
  return { mode: parseStringField(msg, 'mode') }
}

// ---------------------------------------------------------------------------
// available_permission_modes
// ---------------------------------------------------------------------------

export interface PermissionMode {
  id: string
  label: string
}

/** Validate and extract permission modes from an `available_permission_modes` message. */
export function handleAvailablePermissionModes(
  msg: Record<string, unknown>,
): PermissionMode[] | null {
  if (!Array.isArray(msg.modes)) return null
  return (msg.modes as unknown[]).filter(
    (m): m is PermissionMode =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as { id: unknown }).id === 'string' &&
      typeof (m as { label: unknown }).label === 'string',
  )
}

// ---------------------------------------------------------------------------
// session_updated
// ---------------------------------------------------------------------------

/**
 * Apply a `session_updated` message to a sessions list.
 * Returns the updated list, or null if no update was needed.
 */
export function handleSessionUpdated(
  msg: Record<string, unknown>,
  sessions: SessionInfo[],
): SessionInfo[] | null {
  const updatedId = msg.sessionId as string
  const updatedName = msg.name as string
  if (!updatedId || !updatedName) return null
  return sessions.map((s) =>
    s.sessionId === updatedId ? { ...s, name: updatedName } : s,
  )
}

// ---------------------------------------------------------------------------
// confirm_permission_mode
// ---------------------------------------------------------------------------

export interface PendingPermissionConfirm {
  mode: string
  warning: string
}

/**
 * Extract the mode + warning text from a `confirm_permission_mode` message.
 *
 * Returns the pending-confirmation payload when the server included a valid
 * `mode` string, or null when the message is malformed (caller should leave
 * existing pending state alone in that case — matches both clients' prior
 * inline behavior).
 */
export function handleConfirmPermissionMode(
  msg: Record<string, unknown>,
): PendingPermissionConfirm | null {
  const mode = typeof msg.mode === 'string' ? msg.mode : null
  if (!mode) return null
  const warning = typeof msg.warning === 'string' ? msg.warning : 'Are you sure?'
  return { mode, warning }
}

// ---------------------------------------------------------------------------
// claude_ready
// ---------------------------------------------------------------------------

/** State patch for `claude_ready`. */
export function handleClaudeReady(): { claudeReady: true } {
  return { claudeReady: true }
}

// ---------------------------------------------------------------------------
// agent_idle / agent_busy
// ---------------------------------------------------------------------------

/** State patch for `agent_idle`. */
export function handleAgentIdle(): { isIdle: true } {
  return { isIdle: true }
}

/** State patch for `agent_busy`. */
export function handleAgentBusy(): { isIdle: false } {
  return { isIdle: false }
}

// ---------------------------------------------------------------------------
// thinking_level_changed
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'default' | 'high' | 'max'

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['default', 'high', 'max'])

/** Extract and validate the thinking level from a `thinking_level_changed` message. */
export function handleThinkingLevelChanged(msg: Record<string, unknown>): { level: ThinkingLevel } {
  const raw = parseStringField(msg, 'level') || 'default'
  const level = VALID_THINKING_LEVELS.has(raw as ThinkingLevel) ? (raw as ThinkingLevel) : 'default'
  return { level }
}

// ---------------------------------------------------------------------------
// budget_warning
// ---------------------------------------------------------------------------

/** Extract warning text and build a system message for `budget_warning`. */
export function handleBudgetWarning(msg: Record<string, unknown>): {
  warningMessage: string
  systemMessage: ChatMessage
} {
  const warningMessage =
    typeof msg.message === 'string' ? msg.message : 'Approaching cost budget limit'
  return {
    warningMessage,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: warningMessage,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// budget_exceeded
// ---------------------------------------------------------------------------

/** Extract exceeded text and build a system message for `budget_exceeded`. */
export function handleBudgetExceeded(msg: Record<string, unknown>): {
  exceededMessage: string
  systemMessage: ChatMessage
} {
  const exceededMessage =
    typeof msg.message === 'string' ? msg.message : 'Cost budget exceeded'
  return {
    exceededMessage,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `${exceededMessage} — session paused`,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// budget_resumed
// ---------------------------------------------------------------------------

/** Build a system message for `budget_resumed`. */
export function handleBudgetResumed(): { systemMessage: ChatMessage } {
  return {
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: 'Cost budget override — session resumed',
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// plan_started
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a patch resetting plan state to idle.
 *
 * Both clients clear `isPlanPending` and `planAllowedPrompts` when the server
 * announces a new plan run is starting. The caller should only apply the
 * patch when `sessionId` is non-null AND maps to an existing session in its
 * own state (matches the prior inline `if (... && sessionStates[id])` guard).
 */
export function handlePlanStarted(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      isPlanPending: false,
      planAllowedPrompts: [],
    },
  }
}

// ---------------------------------------------------------------------------
// plan_ready
// ---------------------------------------------------------------------------

/**
 * Single allowed prompt the server attaches to a `plan_ready` message.
 *
 * Note: this is the *expected* server-side shape. The handler below validates
 * only array-ness, NOT per-element shape — matches prior inline behaviour in
 * both clients. Tightening element validation would be a behaviour change and
 * is out of scope for the #2661 mechanical migration.
 */
export interface PlanAllowedPrompt {
  tool: string
  prompt: string
}

/**
 * Resolve target session and produce a patch flipping plan state to "ready".
 *
 * Validates `msg.allowedPrompts` is an array; non-array values fall back to
 * an empty array (matches the prior inline `Array.isArray(...) ? ... : []`).
 * Per-element shape is NOT validated — the cast to `PlanAllowedPrompt[]` is
 * unsafe and matches what both clients did before this migration. If a server
 * regression emits malformed entries, downstream consumers see them verbatim.
 *
 * This handler intentionally produces ONLY the universal state patch. The
 * mobile app additionally pushes a session notification on plan-ready via
 * its own `pushSessionNotification` helper — that's a platform-specific UX
 * concern (the dashboard has no equivalent surface) and stays at the call
 * site. The shared handler exposes `sessionId` so the app can route the
 * notification to the right session without re-resolving.
 */
export function handlePlanReady(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  // Behaviour-preserving unsafe cast (see docstring above). `as unknown as`
  // makes it clear at the call site that the element shape isn't checked.
  const prompts: PlanAllowedPrompt[] = Array.isArray(msg.allowedPrompts)
    ? (msg.allowedPrompts as unknown as PlanAllowedPrompt[])
    : []
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      isPlanPending: true,
      planAllowedPrompts: prompts,
    },
  }
}

// ---------------------------------------------------------------------------
// dev_preview / dev_preview_stopped
//
// These handlers are stateful in a way the others aren't: the new devPreviews
// array depends on the existing array (dedup-by-port for `dev_preview`, filter
// for `dev_preview_stopped`). To keep a single sessionId resolution path
// (matching plan_started/plan_ready), the handlers return a builder shape:
// `sessionId` resolved as usual, plus an `applyTo(current)` function the call
// site invokes with the looked-up array. This avoids the double-resolution
// pattern that would otherwise be needed if `currentPreviews` were a
// pre-handler argument.
// ---------------------------------------------------------------------------

/** Builder result for handlers whose patch depends on existing state. */
export interface DevPreviewBuilder {
  /** Session ID the patch targets (may be null if no session context). */
  sessionId: string | null
  /** Apply the builder to the session's current devPreviews. */
  applyTo: (current: DevPreview[]) => { devPreviews: DevPreview[] }
}

/**
 * Resolve target session and produce a builder that appends (or replaces by
 * port) a dev-preview entry. Both clients dedupe by port: a new preview for
 * an already-tracked port replaces the existing entry, otherwise it is
 * appended after the filtered remainder.
 *
 * Behaviour-preserving: `msg.port` and `msg.url` are forwarded verbatim with
 * the same unsafe cast (`port as number, url as string`) the prior inline
 * implementations used. Tightening to runtime validation would be a behaviour
 * change and is out of scope for the #2661 mechanical migration.
 */
export function handleDevPreview(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): DevPreviewBuilder {
  const preview: DevPreview = {
    port: msg.port as number,
    url: msg.url as string,
  }
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => ({
      devPreviews: [...current.filter((p) => p.port !== preview.port), preview],
    }),
  }
}

/**
 * Resolve target session and produce a builder that removes the dev-preview
 * entry matching `msg.port`. If no entry matches the previews list is returned
 * unchanged (matches both clients' prior `filter`-based inline implementation).
 *
 * Behaviour-preserving: `msg.port` is cast verbatim (`port as number`) without
 * runtime validation, matching the prior inline behaviour.
 */
export function handleDevPreviewStopped(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): DevPreviewBuilder {
  const stoppedPort = msg.port as number
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => ({
      devPreviews: current.filter((p) => p.port !== stoppedPort),
    }),
  }
}

// ---------------------------------------------------------------------------
// auth_ok / auth_fail / key_exchange_ok / server_mode
// ---------------------------------------------------------------------------

/**
 * Server modes the WS protocol can advertise.
 *
 * Both clients accept `'cli'`; only the dashboard surfaces `'terminal'` (the
 * mobile app currently treats `'terminal'` as null because there is no
 * terminal view). The shared handler returns the validated raw value; the
 * call site decides whether to narrow further.
 */
export type ServerMode = 'cli' | 'terminal'

const VALID_SERVER_MODES: readonly ServerMode[] = ['cli', 'terminal']

/**
 * Typed payload extracted from an `auth_ok` message.
 *
 * Side-effects (reset replay flags, save connection, start heartbeat, kick
 * off key exchange, register push tokens, sync ConnectionLifecycleStore,
 * update lastConnectedUrl, etc.) stay at the call site — every one of those
 * is platform-specific (the mobile app has push notifications + biometric
 * setup; the dashboard owns lastConnectedUrl tracking) and out of scope for
 * the data-extraction seam.
 *
 * Intentionally NOT extracted into the shared payload:
 *   - `clientId` + `connectedClients` (validation requires the
 *     `ConnectedClient` type which lives at the consumer level)
 *   - `webFeatures` (small but app/dashboard call sites already build it
 *     with platform-specific defaults)
 *   - `encryption` flag and `sessionToken` (only the app uses sessionToken
 *     for the pairing flow; encryption gates a side effect, not state)
 *
 * Tightening any of these would be a behaviour change — see the parent
 * #2661 plan.
 */
export interface AuthOkPayload {
  /** Validated server mode (`'cli'`, `'terminal'`, or null). */
  serverMode: ServerMode | null
  /** Raw `cwd` string (NOT trimmed — empty string preserved). */
  sessionCwd: string | null
  /** Raw `defaultCwd` string. */
  defaultCwd: string | null
  /** Raw `serverVersion` string. */
  serverVersion: string | null
  /** Raw `latestVersion` string. */
  latestVersion: string | null
  /** Raw `serverCommit` string. */
  serverCommit: string | null
  /** Validated integer >= 1, else null. */
  protocolVersion: number | null
}

/** Extract typed server-context fields from an `auth_ok` message. */
export function handleAuthOk(msg: Record<string, unknown>): AuthOkPayload {
  const protoRaw = msg.protocolVersion
  const protocolVersion =
    typeof protoRaw === 'number' &&
    Number.isFinite(protoRaw) &&
    Number.isInteger(protoRaw) &&
    protoRaw >= 1
      ? protoRaw
      : null
  return {
    serverMode: parseEnumField(msg, 'serverMode', VALID_SERVER_MODES),
    sessionCwd: parseRawStringField(msg, 'cwd'),
    defaultCwd: parseRawStringField(msg, 'defaultCwd'),
    serverVersion: parseRawStringField(msg, 'serverVersion'),
    latestVersion: parseRawStringField(msg, 'latestVersion'),
    serverCommit: parseRawStringField(msg, 'serverCommit'),
    protocolVersion,
  }
}

/**
 * Extract the failure reason from an `auth_fail` message, falling back to
 * `'Invalid token'` when missing or non-string. Matches the prior inline
 * `(msg.reason as string) || 'Invalid token'` guard.
 */
export function handleAuthFail(msg: Record<string, unknown>): { reason: string } {
  const raw = msg.reason
  const reason = typeof raw === 'string' && raw ? raw : 'Invalid token'
  return { reason }
}

/**
 * Extract the validated `publicKey` from a `key_exchange_ok` message.
 *
 * Returns null when the field is missing, empty, or non-string — matches the
 * prior inline guard `if (!msg.publicKey || typeof msg.publicKey !== 'string')`.
 *
 * The actual key-derivation side effects (deriveSharedKey, deriveConnectionKey,
 * setting `_encryptionState`, sending post-auth WS messages) stay at the call
 * site — they touch crypto state and the websocket directly.
 */
export function handleKeyExchangeOk(msg: Record<string, unknown>): { publicKey: string | null } {
  const raw = msg.publicKey
  return {
    publicKey: typeof raw === 'string' && raw ? raw : null,
  }
}

/**
 * Extract and validate the mode enum from a `server_mode` message.
 *
 * Returns null for unknown modes; the call site is expected to surface an
 * "Invalid Server Mode" alert (matches dashboard's prior inline behaviour;
 * the app currently ignores `'terminal'` and sets null, which the call site
 * can re-narrow if needed).
 */
export function handleServerMode(msg: Record<string, unknown>): { mode: ServerMode | null } {
  return { mode: parseEnumField(msg, 'mode', VALID_SERVER_MODES) }
}

// ---------------------------------------------------------------------------
// checkpoint_created
// ---------------------------------------------------------------------------

/**
 * Append a newly created checkpoint to the active-session checkpoint list.
 *
 * Both clients gate on `msg.sessionId === activeSessionId` (with the usual
 * "fall back to active when sessionId is absent" rule) and ignore malformed
 * payloads. This handler encodes that gate: returns the new list when the
 * append should happen, or null when the message should be ignored.
 *
 * Per-element shape is NOT validated — the cast to `Checkpoint` matches the
 * inline behaviour in both clients prior to this migration. Tightening would
 * be a behaviour change beyond the scope of #2661.
 */
export function handleCheckpointCreated(
  msg: Record<string, unknown>,
  currentCheckpoints: Checkpoint[],
  activeSessionId: string | null,
): Checkpoint[] | null {
  const targetId = resolveSessionId(msg, activeSessionId)
  if (!targetId || targetId !== activeSessionId) return null
  const cp = msg.checkpoint
  if (!cp || typeof cp !== 'object') return null
  return [...currentCheckpoints, cp as Checkpoint]
}

// ---------------------------------------------------------------------------
// checkpoint_list
// ---------------------------------------------------------------------------

/**
 * Replace the active-session checkpoint list with the server-provided array.
 *
 * Same active-session gate as `handleCheckpointCreated`. Returns the new array
 * (which may be empty) when the replace should happen, or null when the
 * message should be ignored (different session, missing/non-array payload,
 * or no active session to fall back to).
 */
export function handleCheckpointList(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): Checkpoint[] | null {
  const targetId = resolveSessionId(msg, activeSessionId)
  if (!targetId || targetId !== activeSessionId) return null
  if (!Array.isArray(msg.checkpoints)) return null
  return msg.checkpoints as Checkpoint[]
}

// ---------------------------------------------------------------------------
// checkpoint_restored
// ---------------------------------------------------------------------------

/** Parsed payload from a `checkpoint_restored` message. */
export interface CheckpointRestoredPayload {
  newSessionId: string
}

/**
 * Extract and trim the new session ID from a `checkpoint_restored` message.
 *
 * App-only handler today (the dashboard's `checkpoint_restored` is a no-op);
 * extracted here so dashboard can adopt the same handler later if/when it
 * grows that surface. Returns null when the payload is missing, malformed,
 * or empty after trimming — matching the inline guard `if (restoredNewSid.length > 0)`.
 *
 * Restore-flow side effects (e.g. `switchSession`) stay platform-specific and
 * are gated by the caller on a non-null return.
 */
export function handleCheckpointRestored(
  msg: Record<string, unknown>,
): CheckpointRestoredPayload | null {
  const raw = msg.newSessionId
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return { newSessionId: trimmed }
}

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_MESSAGE = 'An unexpected server error occurred'

/**
 * Parse an `error` message into its display fields and a system ChatMessage.
 *
 * Mirrors the inline implementations in both clients:
 * - `code` defaults to "UNKNOWN" when missing/non-string
 * - `message` is ANSI-stripped and trimmed; if the result is empty (including
 *   cases where a non-empty input becomes empty after stripping ANSI codes
 *   and whitespace), it falls back to the default error string. This matches
 *   the app's `(stripAnsi(...).trim() || ...)` pattern and is a safe widening
 *   of the dashboard's behaviour.
 * - `requestId` is exposed so callers can correlate against in-flight
 *   requests (e.g. `set_permission_mode` rejection handling on the app).
 *
 * Toast/banner placement and request-correlation logic stays at the call
 * site — this handler only normalises the payload.
 */
export function handleError(msg: Record<string, unknown>): {
  code: string
  message: string
  requestId: string | null
  systemMessage: ChatMessage
} {
  const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN'
  const rawMessage =
    typeof msg.message === 'string' ? stripAnsi(msg.message).trim() : ''
  const message = rawMessage.length > 0 ? rawMessage : DEFAULT_ERROR_MESSAGE
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  return {
    code,
    message,
    requestId,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: message,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// session_error
// ---------------------------------------------------------------------------

/**
 * Build the default bound-token mismatch hint surfaced to users (#2904).
 * This helper provides the shared/dashboard wording used when normalising
 * `SESSION_TOKEN_MISMATCH`; other clients may intentionally present different
 * copy at the call site (the app's modal mentions "from the desktop" and is
 * built inline rather than consuming this string).
 */
function boundSessionMismatchMessage(boundSessionName: string): string {
  return `This device is paired to session "${boundSessionName}" and can only talk to that session. Disconnect and scan a fresh QR code to create new sessions.`
}

/**
 * Parse a `session_error` message.
 *
 * Two distinct shapes flow through the same WS message type:
 *
 * 1. `category === 'crash'` — the session crashed server-side. Returns a
 *    `sessionPatch` flipping the target session's health to `'crashed'`.
 *    Callers additionally push a session notification (platform-specific UX
 *    that stays at the call site).
 *
 * 2. Everything else — a user-visible error. Returns `message` (rewritten to
 *    the bound-session hint when the server signals SESSION_TOKEN_MISMATCH
 *    with a `boundSessionName`) and a system ChatMessage. Callers display the
 *    error via their preferred surface (web toast, native Alert, etc.).
 *
 * The two shapes are disjoint: when `category === 'crash'`, `message` and
 * `systemMessage` are null; otherwise `sessionPatch` is null.
 */
export function handleSessionError(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): {
  category: string | null
  code: string | null
  boundSessionName: string | null
  message: string | null
  sessionPatch: SessionPatch | null
  systemMessage: ChatMessage | null
} {
  const category = typeof msg.category === 'string' ? msg.category : null
  const code = typeof msg.code === 'string' ? msg.code : null
  const boundSessionName =
    typeof msg.boundSessionName === 'string' && msg.boundSessionName.length > 0
      ? msg.boundSessionName
      : null

  if (category === 'crash') {
    return {
      category,
      code,
      boundSessionName,
      message: null,
      sessionPatch: {
        sessionId: resolveSessionId(msg, activeSessionId),
        patch: { health: 'crashed' },
      },
      systemMessage: null,
    }
  }

  let message: string
  if (code === 'SESSION_TOKEN_MISMATCH' && boundSessionName) {
    message = boundSessionMismatchMessage(boundSessionName)
  } else {
    message = parseStringField(msg, 'message') ?? 'Unknown error'
  }

  return {
    category,
    code,
    boundSessionName,
    message,
    sessionPatch: null,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: message,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// log_entry
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const VALID_LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])

export interface LogEntry {
  id: string
  component: string
  level: LogLevel
  message: string
  timestamp: number
  sessionId?: string
}

/**
 * Parse a `log_entry` message into a typed `LogEntry`.
 *
 * - `component` defaults to `"unknown"` when missing/non-string
 * - `level` is validated against the `LogLevel` enum, falling back to `"info"`
 * - `message` is ANSI-stripped (logs from the server can contain colour codes)
 * - `timestamp` defaults to `Date.now()` when not a number
 * - `sessionId` is omitted entirely when not a string (matches inline impl)
 *
 * Today only the dashboard consumes `log_entry`; the app does not subscribe to
 * server logs. Extracting the parser here lets the app adopt without
 * duplicating logic later.
 */
export function handleLogEntry(msg: Record<string, unknown>): {
  entry: LogEntry
} {
  const component = typeof msg.component === 'string' ? msg.component : 'unknown'
  const level: LogLevel = VALID_LOG_LEVELS.has(msg.level as LogLevel)
    ? (msg.level as LogLevel)
    : 'info'
  const message = typeof msg.message === 'string' ? stripAnsi(msg.message) : ''
  const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
  const entry: LogEntry = {
    id: nextMessageId('log'),
    component,
    level,
    message,
    timestamp,
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
  return { entry }
}

// ---------------------------------------------------------------------------
// Multi-client coordination
// ---------------------------------------------------------------------------

const VALID_DEVICE_TYPES = new Set<ConnectedClient['deviceType']>([
  'phone',
  'tablet',
  'desktop',
  'unknown',
])

/** Result of a `client_joined` handler invocation. */
export interface ClientJoinedResult {
  /** The newly-parsed client (always `isSelf: false`). */
  client: ConnectedClient
  /** Updated roster with the client upserted (existing entry by `clientId` is replaced). */
  roster: ConnectedClient[]
}

/**
 * Parse a `client_joined` message and produce an upserted roster.
 *
 * Returns null when the message is malformed (no client, missing/non-string
 * `clientId`) — caller leaves existing roster alone in that case, matching
 * both clients' prior inline `if (!msg.client || ...) break;` guard.
 *
 * The shared handler returns ONLY the universal data (parsed client + new
 * roster list). Platform-specific UX (system-message broadcast on connect,
 * per-store side stores) stays at the call site.
 */
export function handleClientJoined(
  msg: Record<string, unknown>,
  currentRoster: ConnectedClient[],
): ClientJoinedResult | null {
  const rawClient = msg.client
  if (!rawClient || typeof rawClient !== 'object') return null
  const c = rawClient as Record<string, unknown>
  if (typeof c.clientId !== 'string') return null

  const deviceType = VALID_DEVICE_TYPES.has(c.deviceType as ConnectedClient['deviceType'])
    ? (c.deviceType as ConnectedClient['deviceType'])
    : 'unknown'

  const client: ConnectedClient = {
    clientId: c.clientId,
    deviceName: typeof c.deviceName === 'string' ? c.deviceName : null,
    deviceType,
    platform: typeof c.platform === 'string' ? c.platform : 'unknown',
    isSelf: false,
  }

  const roster = [
    ...currentRoster.filter((existing) => existing.clientId !== client.clientId),
    client,
  ]
  return { client, roster }
}

/** Result of a `client_left` handler invocation. */
export interface ClientLeftResult {
  /** The clientId that left (echoed from the message for convenience). */
  clientId: string
  /** The roster entry being removed, if any (caller may want it for UX labels). */
  departingClient: ConnectedClient | undefined
  /** Roster with the entry filtered out. */
  roster: ConnectedClient[]
}

/**
 * Parse a `client_left` message and produce a filtered roster.
 *
 * Returns null when `msg.clientId` is missing or non-string — matches both
 * clients' prior `if (typeof msg.clientId !== 'string') break;` guard.
 */
export function handleClientLeft(
  msg: Record<string, unknown>,
  currentRoster: ConnectedClient[],
): ClientLeftResult | null {
  if (typeof msg.clientId !== 'string') return null
  const clientId = msg.clientId
  const departingClient = currentRoster.find((c) => c.clientId === clientId)
  const roster = currentRoster.filter((c) => c.clientId !== clientId)
  return { clientId, departingClient, roster }
}

/** Parsed payload for a `primary_changed` message. */
export interface PrimaryChanged {
  /**
   * Target session id. May be null (missing/non-string), the literal `'default'`
   * (server-wide default), or any other session id. The caller decides how to
   * route — both clients currently special-case `null`/`'default'` to apply
   * globally and any other value to apply per-session.
   */
  sessionId: string | null
  /** New primary client id, or null if missing/non-string. */
  primaryClientId: string | null
}

/**
 * Extract the routing payload for a `primary_changed` message.
 *
 * Pure data extraction — does NOT consult the active session id (the message
 * always carries the target sessionId or omits it deliberately). The caller
 * decides whether to apply the change globally or to a session.
 */
export function handlePrimaryChanged(msg: Record<string, unknown>): PrimaryChanged {
  return {
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    primaryClientId: typeof msg.clientId === 'string' ? msg.clientId : null,
  }
}

// ---------------------------------------------------------------------------
// session_list
// ---------------------------------------------------------------------------

/**
 * Validate a `session_list` message and return the parsed sessions array.
 *
 * Returns null when `msg.sessions` is missing or non-array — matches both
 * clients' prior `if (Array.isArray(msg.sessions))` guard.
 *
 * Per-element shape is NOT validated — the cast to `SessionInfo[]` matches
 * the inline behaviour in both clients prior to this migration. Tightening
 * would be a behaviour change beyond the scope of #2661.
 *
 * Heavy state-merge logic (GC of removed sessions, flat-field sync, auto-
 * subscribe, conversationId persistence) stays at the call site — those
 * concerns are platform-specific (the dashboard syncs `activeModel` against
 * `availableModels`; the app additionally auto-subscribes via WS and persists
 * the last conversationId to disk).
 */
export function handleSessionList(msg: Record<string, unknown>): SessionInfo[] | null {
  if (!Array.isArray(msg.sessions)) return null
  return msg.sessions as unknown as SessionInfo[]
}

// ---------------------------------------------------------------------------
// session_context
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a patch updating `sessionContext`.
 *
 * Both clients build the same `{gitBranch, gitDirty, gitAhead, projectName}`
 * shape with `typeof === 'string' ? ... : null` / `typeof === 'number' ? ... : 0`
 * fallbacks. The patch is gated by the caller on `sessionStates[id]` existence,
 * matching prior inline behaviour.
 */
export function handleSessionContext(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      sessionContext: {
        gitBranch: typeof msg.gitBranch === 'string' ? msg.gitBranch : null,
        gitDirty: typeof msg.gitDirty === 'number' ? msg.gitDirty : 0,
        gitAhead: typeof msg.gitAhead === 'number' ? msg.gitAhead : 0,
        projectName: typeof msg.projectName === 'string' ? msg.projectName : null,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// session_timeout
// ---------------------------------------------------------------------------

/** Parsed payload + system message for a `session_timeout` message. */
export interface SessionTimeoutPayload {
  /** Trimmed session id, or null when missing/non-string. */
  sessionId: string | null
  /** Display name (defaults to "Unknown" — matches both clients' prior fallback). */
  name: string
  /** System ChatMessage callers may push into a chat surface. */
  systemMessage: ChatMessage
}

/**
 * Parse a `session_timeout` message into the fields callers need to drive
 * their UX (alert, session-state cleanup) and a system ChatMessage describing
 * the timeout.
 *
 * Side effects (the `Alert.alert("Session Closed", ...)` call, removing the
 * session from `sessions` + `sessionStates`, syncing flat fields when the
 * timed-out session was active, and `clearPersistedSession`) all stay at the
 * call site — they are platform-specific (the dashboard syncs more flat fields
 * than the app, and the persistence adapter differs per client).
 */
export function handleSessionTimeout(msg: Record<string, unknown>): SessionTimeoutPayload {
  const sessionId = parseStringField(msg, 'sessionId')
  const name = parseStringField(msg, 'name') ?? 'Unknown'
  return {
    sessionId,
    name,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `Session "${name}" was closed due to inactivity.`,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// session_restore_failed
// ---------------------------------------------------------------------------

/** Parsed payload + system message for a `session_restore_failed` message. */
export interface SessionRestoreFailedPayload {
  sessionId: string | null
  name: string | null
  provider: string | null
  errorCode: string | null
  errorMessage: string | null
  /** System ChatMessage describing the failure (caller may discard or push to chat). */
  systemMessage: ChatMessage
}

/**
 * Parse a `session_restore_failed` message.
 *
 * Both clients today only `console.warn` the payload — full UX (retry button,
 * needs-attention marker) is a tracked follow-up. The shared handler exposes
 * the parsed fields plus a pre-built system message so the call site can
 * decide whether to log, push to chat, or surface a banner.
 */
export function handleSessionRestoreFailed(
  msg: Record<string, unknown>,
): SessionRestoreFailedPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const name = typeof msg.name === 'string' ? msg.name : null
  const provider = typeof msg.provider === 'string' ? msg.provider : null
  const errorCode = typeof msg.errorCode === 'string' ? msg.errorCode : null
  const errorMessage = typeof msg.errorMessage === 'string' ? msg.errorMessage : null
  const label = name ?? sessionId ?? 'session'
  const reason = errorMessage ?? errorCode ?? 'unknown error'
  return {
    sessionId,
    name,
    provider,
    errorCode,
    errorMessage,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `Failed to restore ${label}: ${reason}`,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// session_warning
// ---------------------------------------------------------------------------

/** Parsed payload + system message for a `session_warning` message. */
export interface SessionWarningPayload {
  /** Trimmed session id, or null when missing/non-string. */
  sessionId: string | null
  /** Display name (defaults to "Session" — matches the app's prior fallback). */
  sessionName: string
  /** Milliseconds remaining before timeout (defaults to 120_000 — matches prior fallback). */
  remainingMs: number
  /** Warning text (defaults to dashboard's prior "Session will timeout soon"). */
  message: string
  /** System ChatMessage callers may push into a chat surface (dashboard does this). */
  systemMessage: ChatMessage
}

/**
 * Parse a `session_warning` message.
 *
 * Both clients diverge on what they do with the warning:
 *   - The dashboard pushes a system ChatMessage into the targeted session and
 *     surfaces an `Alert.alert("Session Warning", ...)` when that session is
 *     not currently active.
 *   - The app stores the warning fields in a `timeoutWarning` state slot
 *     (consumed by a banner UI) and dual-writes into `useNotificationStore`.
 *
 * The shared handler returns ALL of: parsed fields (for the app's banner
 * state), a default warning message (for the dashboard's alert), and a
 * pre-built system ChatMessage (for the dashboard's chat push). Callers pick
 * the parts they need; nothing is forced on either side.
 */
export function handleSessionWarning(msg: Record<string, unknown>): SessionWarningPayload {
  const sessionId = parseStringField(msg, 'sessionId')
  const sessionName = parseStringField(msg, 'name') ?? 'Session'
  const remainingMs = typeof msg.remainingMs === 'number' ? msg.remainingMs : 120000
  const message = parseStringField(msg, 'message') ?? 'Session will timeout soon'
  return {
    sessionId,
    sessionName,
    remainingMs,
    message,
    systemMessage: {
      id: nextMessageId('warn'),
      type: 'system',
      content: message,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// session_switched
// ---------------------------------------------------------------------------

/** Parsed payload from a `session_switched` message. */
export interface SessionSwitchedPayload {
  /** The new active session id (trimmed; renamed from `sessionId` for clarity). */
  newSessionId: string
  /** Optional resume conversation id from the server (trimmed), or null. */
  conversationId: string | null
}

/**
 * Extract the new active session id (and optional conversationId) from a
 * `session_switched` message.
 *
 * Returns null when `msg.sessionId` is missing, non-string, empty, or
 * whitespace-only — matches the prior implicit behaviour (the cast
 * `msg.sessionId as string` would propagate a non-string into
 * `set({activeSessionId: ...})` which the rest of the store can't recover
 * from) and tightens validation against malformed payloads.
 *
 * Both clients consume this handler today. Side effects (replay-dedup gating
 * via `_ctx.pendingSwitchSessionId` on the app, flat-field sync on the
 * dashboard, slash-command/agent refresh, sessionStates initialisation) stay
 * at the call site — they touch the WS socket and several side stores.
 */
export function handleSessionSwitched(
  msg: Record<string, unknown>,
): SessionSwitchedPayload | null {
  const newSessionId = parseStringField(msg, 'sessionId')
  if (newSessionId === null) return null
  const conversationId = parseStringField(msg, 'conversationId')
  return { newSessionId, conversationId }
}

/** Parsed payload for a `client_focus_changed` message. */
export interface ClientFocusChanged {
  clientId: string
  sessionId: string
}

/**
 * Extract the (clientId, sessionId) pair from a `client_focus_changed` message.
 *
 * Returns null when either field is missing or non-string — matches both
 * clients' prior `if (!focusClientId || !focusSessionId) break;` guard.
 *
 * The follow-mode auto-switch logic stays at the call site (depends on each
 * client's `myClientId`/`followMode`/`activeSessionId` state).
 */
export function handleClientFocusChanged(
  msg: Record<string, unknown>,
): ClientFocusChanged | null {
  const clientId = typeof msg.clientId === 'string' ? msg.clientId : null
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  if (!clientId || !sessionId) return null
  return { clientId, sessionId }
}

// ---------------------------------------------------------------------------
// conversation_id
// ---------------------------------------------------------------------------

/** Parsed payload for a `conversation_id` message. */
export interface ConversationIdPayload {
  /**
   * Raw `sessionId` from the message — NOT resolved against an active session.
   *
   * The prior inline implementation read `msg.sessionId as string` and gated
   * the patch on `if (convSessionId && get().sessionStates[convSessionId])`,
   * meaning a missing `sessionId` skipped the update entirely (no fallback to
   * the active session). Preserving that behaviour: this handler returns null
   * when the field is missing or non-string, and the call site is expected to
   * skip the patch in that case.
   */
  sessionId: string | null
  /** Validated `conversationId` string, or null when missing/non-string. */
  conversationId: string | null
}

/**
 * Parse a `conversation_id` message into a `(sessionId, conversationId)` pair.
 *
 * Both clients update the target session's `conversationId` field when the
 * server announces a fresh conversation handle. The session-existence guard
 * (`sessionStates[targetId]`) and the actual `updateSession` call stay at the
 * call site — this handler only normalises the payload.
 */
export function handleConversationId(
  msg: Record<string, unknown>,
): ConversationIdPayload {
  return {
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    conversationId:
      typeof msg.conversationId === 'string' ? msg.conversationId : null,
  }
}

// ---------------------------------------------------------------------------
// conversations_list
// ---------------------------------------------------------------------------

/**
 * Parse a `conversations_list` message into a typed array.
 *
 * App-only handler today — the dashboard's `conversations_list` already lives
 * in the dispatcher map via a small inline function and currently differs in
 * what state slices it touches (`conversationHistoryError` is app-only;
 * `useConversationStore` mirroring is app-only). The shared parser only
 * normalises the array shape so future dashboard adoption can layer on its
 * own state mutation.
 *
 * Per-element shape is NOT validated — the cast to `ConversationSummary[]`
 * matches the inline behaviour in the app prior to this migration. Tightening
 * would be a behaviour change beyond the scope of #2661.
 */
export function handleConversationsList(msg: Record<string, unknown>): {
  conversations: ConversationSummary[]
} {
  const conversations: ConversationSummary[] = Array.isArray(msg.conversations)
    ? (msg.conversations as ConversationSummary[])
    : []
  return { conversations }
}

// ---------------------------------------------------------------------------
// history_replay_start / history_replay_end
//
// Both clients track a module-level `_receivingHistoryReplay` flag (or, in the
// app, `_ctx.receivingHistoryReplay`) that gates how subsequent messages are
// processed. The shared handlers normalise the payload — extracting the
// strict `fullHistory === true` check and resolving the target sessionId for
// the messages-clearing branch — but the actual flag mutation stays at the
// call site (it lives in module state, not store state).
// ---------------------------------------------------------------------------

/** Parsed payload for a `history_replay_start` message. */
export interface HistoryReplayStartPayload {
  /** Always `true` — the flag value the client should set on entry. */
  receivingHistoryReplay: true
  /**
   * Strict `msg.fullHistory === true` check (matches both clients' prior
   * inline guard). Only triggers the messages-clearing branch when literally
   * `true`; truthy values like `1` or `'true'` do NOT count.
   */
  fullHistory: boolean
  /**
   * Resolved target session id for the full-history clearing branch.
   *
   * Falls back to `activeSessionId` when the message omits `sessionId`,
   * matching `(msg.sessionId as string) || get().activeSessionId` exactly —
   * including no whitespace trimming, so `'  sess-1  '` is preserved verbatim
   * and an empty string `''` falls back to `activeSessionId`. The call site
   * only consults this when `fullHistory` is true and only applies the patch
   * when the resolved id maps to an existing session in its store.
   */
  sessionId: string | null
}

/**
 * Parse a `history_replay_start` message.
 *
 * Returns the new flag value (`receivingHistoryReplay: true`), the strict
 * `fullHistory` flag, and the resolved target session id for the clearing
 * branch. Module-level flag mutation, transient-state clearing, and the
 * existence guard on the resolved sessionId stay at the call site.
 *
 * Note: this handler intentionally does NOT use `resolveSessionId()` because
 * the prior inline logic was `(msg.sessionId as string) || activeSessionId`,
 * which preserves whitespace. Switching to the trimming helper would change
 * behaviour (e.g. `'  sess-1  '` would be normalised), and this migration is
 * mechanical.
 */
export function handleHistoryReplayStart(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): HistoryReplayStartPayload {
  const rawSessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId : null
  return {
    receivingHistoryReplay: true,
    fullHistory: msg.fullHistory === true,
    sessionId: rawSessionId || activeSessionId,
  }
}

/** Parsed payload for a `history_replay_end` message. */
export interface HistoryReplayEndPayload {
  /** Always `false` — the flag value the client should set on exit. */
  receivingHistoryReplay: false
}

/**
 * Parse a `history_replay_end` message.
 *
 * Returns the new flag value (`receivingHistoryReplay: false`). Module-level
 * flag mutation and the post-replay prompt-cleanup pass stay at the call site
 * (they touch session state via the consumer's update helper).
 */
export function handleHistoryReplayEnd(): HistoryReplayEndPayload {
  return { receivingHistoryReplay: false }
}

// ---------------------------------------------------------------------------
// permission_request / permission_resolved / permission_expired /
// permission_timeout / permission_rules_updated
// ---------------------------------------------------------------------------

/**
 * Permission rule shape advertised by the server in `permission_rules_updated`.
 *
 * The handler does NOT validate element shape — the cast matches the inline
 * `as PermissionRule[]` both clients used prior to the migration. Tightening
 * would be a behaviour change and is out of scope for #2661.
 */
export interface PermissionRule {
  tool: string
  decision: 'allow' | 'deny'
  pattern?: string
}

/**
 * Parsed payload from a `permission_request` message.
 *
 * App-only handler today (the dashboard parses inline against its own session
 * routing rules); extracted here so dashboard can adopt later. Returns the
 * verbatim wire fields with the same shallow validation the inline impls used.
 *
 * Per-field notes (behaviour-preserving):
 * - `requestId`: null when missing/non-string (caller skips the prompt).
 * - `tool` / `description`: null when missing/non-string. The app uses these
 *   to build the prompt content string `"${tool}: ${description}"` with a
 *   "Permission required" fallback at the call site.
 * - `input`: the raw message payload's `input` when it is a non-null object;
 *   null otherwise. Matches `msg.input && typeof msg.input === 'object'` —
 *   note that arrays satisfy this guard and are forwarded verbatim. The
 *   declared `Record<string, unknown> | null` type is a known shallow lie
 *   for the array case; tightening either the type or the guard requires
 *   downstream changes (`ChatMessage.toolInput`, PermissionDetail) and is
 *   out of scope for this mechanical migration.
 * - `sessionId`: explicit sessionId from the message (no active-session
 *   fallback here — pending-permission routing is platform-specific).
 * - `remainingMs`: numeric value forwarded verbatim, including 0; null for
 *   missing or non-number values. The call site converts to absolute
 *   `expiresAt = Date.now() + remainingMs` only when non-null.
 *
 * Side effects (split streaming response, "Allow for Session" provider gate,
 * push session notification) all stay at the call site — they touch
 * platform-specific state.
 */
export interface PermissionRequestPayload {
  requestId: string | null
  tool: string | null
  description: string | null
  input: Record<string, unknown> | null
  sessionId: string | null
  remainingMs: number | null
}

export function handlePermissionRequest(
  msg: Record<string, unknown>,
): PermissionRequestPayload {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  const tool = typeof msg.tool === 'string' ? msg.tool : null
  const description = typeof msg.description === 'string' ? msg.description : null
  const input =
    msg.input && typeof msg.input === 'object'
      ? (msg.input as Record<string, unknown>)
      : null
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const remainingMs = typeof msg.remainingMs === 'number' ? msg.remainingMs : null
  return { requestId, tool, description, input, sessionId, remainingMs }
}

/**
 * Parsed payload from a `permission_resolved` message.
 *
 * App-only handler today (dashboard parses inline). Returns the requestId and
 * decision string verbatim — the decision is NOT validated against an enum to
 * match the prior inline `msg.decision as string` cast. The call site searches
 * all session states for the matching prompt and applies its own UX side
 * effects (clearing pending state, dismissing notification banners).
 */
export interface PermissionResolvedPayload {
  requestId: string | null
  decision: string | null
}

export function handlePermissionResolved(
  msg: Record<string, unknown>,
): PermissionResolvedPayload {
  return {
    requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
    decision: typeof msg.decision === 'string' ? msg.decision : null,
  }
}

/**
 * Parse a `permission_expired` message into the requestId plus a system
 * ChatMessage (mirrors `handleBudgetExceeded`'s shape).
 *
 * The system message text is the same line both clients append to the
 * matching prompt today: `"(Expired — this permission was already handled or
 * timed out)"`. The handler does NOT decide whether to apply it — the call
 * site gates on `requestId` and on whether the prompt was already resolved
 * (the dashboard's "already handled" race-suppression path stays platform-
 * specific). Banner dismissal also stays at the call site.
 */
export function handlePermissionExpired(msg: Record<string, unknown>): {
  requestId: string | null
  systemMessage: ChatMessage
} {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  return {
    requestId,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: '(Expired — this permission was already handled or timed out)',
      timestamp: Date.now(),
    },
  }
}

/**
 * Parse a `permission_timeout` message (app-only today) into the requestId,
 * the tool name, and a system ChatMessage describing the auto-deny.
 *
 * `tool` defaults to `"permission"` when missing/non-string — matches the
 * inline `typeof msg.tool === 'string' ? msg.tool : 'permission'` guard. The
 * system message follows the inline pattern
 * `"Permission for \"${tool}\" was auto-denied (timed out)"`.
 *
 * The call site uses this to:
 *   - mark matching prompts in any session as auto-denied (UI-side),
 *   - dismiss matching notification banners,
 *   - push a `ServerError` toast with the same wording.
 */
export function handlePermissionTimeout(msg: Record<string, unknown>): {
  requestId: string | null
  tool: string
  systemMessage: ChatMessage
} {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null
  const tool = typeof msg.tool === 'string' ? msg.tool : 'permission'
  return {
    requestId,
    tool,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `Permission for "${tool}" was auto-denied (timed out)`,
      timestamp: Date.now(),
    },
  }
}

/**
 * Parsed payload from a `permission_rules_updated` message.
 *
 * `rules` is the array as-sent by the server when it is an array, else an
 * empty array. Per-element shape is NOT validated — matches the inline
 * `Array.isArray(msg.rules) ? (msg.rules as PermissionRule[]) : []` cast both
 * clients used. Tightening would be a behaviour change and is out of scope.
 *
 * `sessionId` is the message's explicit sessionId or null; the call site
 * applies its own active-session fallback (the app and dashboard both default
 * to `activeSessionId` when missing).
 */
export interface PermissionRulesUpdatedPayload {
  sessionId: string | null
  rules: PermissionRule[]
}

export function handlePermissionRulesUpdated(
  msg: Record<string, unknown>,
): PermissionRulesUpdatedPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const rules: PermissionRule[] = Array.isArray(msg.rules)
    ? (msg.rules as unknown as PermissionRule[])
    : []
  return { sessionId, rules }
}

// ---------------------------------------------------------------------------
// File operations: directory_listing / file_listing / file_content /
// write_file_result
//
// These cases all extract a normalized payload then forward to a platform
// callback. The payload normalisation is the duplication; the callback
// dispatch (`get()._fooCallback` vs `getCallback('foo')`) stays at the call
// site.
//
// Concrete entry types (`DirectoryEntry`, `FileEntry`) live downstream in
// dashboard/app — the shared payloads keep arrays as `unknown[]`. Each call
// site casts to its own concrete type when forwarding to the callback.
// ---------------------------------------------------------------------------

/** Parsed payload for a `directory_listing` message. */
export interface DirectoryListingPayload {
  /** Directory path that was listed (raw string, not trimmed). Null if missing/non-string. */
  path: string | null
  /** Parent directory path (raw string). Null if missing/non-string. */
  parentPath: string | null
  /** Listing entries — forwarded verbatim. Empty array when missing/non-array. */
  entries: unknown[]
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `directory_listing` message into the fields the dashboard and app
 * forward to their `_directoryListingCallback` / `getCallback('directoryListing')`.
 *
 * Behaviour-preserving: matches both clients' inline pattern of
 * `typeof === 'string' ? ... : null` for string fields and
 * `Array.isArray(...) ? ... : []` for `entries`. Per-element shape is NOT
 * validated — callers cast to their own concrete entry type when invoking
 * the callback.
 */
export function handleDirectoryListing(
  msg: Record<string, unknown>,
): DirectoryListingPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    parentPath: typeof msg.parentPath === 'string' ? msg.parentPath : null,
    entries: Array.isArray(msg.entries) ? (msg.entries as unknown[]) : [],
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload for a `file_listing` message. */
export interface FileListingPayload {
  /** Listed path (raw string). Null if missing/non-string. */
  path: string | null
  /** Parent path (raw string). Null if missing/non-string. */
  parentPath: string | null
  /** File entries — forwarded verbatim. Empty array when missing/non-array. */
  entries: unknown[]
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `file_listing` message into a normalised payload.
 *
 * Same shape as `handleDirectoryListing` — both messages share the
 * `(path, parentPath, entries, error)` quadruple, but they target different
 * callback channels (`fileBrowser` vs `directoryListing`). The downstream
 * concrete entry types (`FileEntry` vs `DirectoryEntry`) live in the
 * dashboard/app and are applied via cast at the call site.
 */
export function handleFileListing(msg: Record<string, unknown>): FileListingPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    parentPath: typeof msg.parentPath === 'string' ? msg.parentPath : null,
    entries: Array.isArray(msg.entries) ? (msg.entries as unknown[]) : [],
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload for a `file_content` message. */
export interface FileContentPayload {
  /** File path the content corresponds to. Null if missing/non-string. */
  path: string | null
  /** File contents (raw string, not trimmed). Null if missing/non-string. */
  content: string | null
  /** Detected language (e.g. `'typescript'`). Null if missing/non-string. */
  language: string | null
  /** Reported size in bytes. Null if missing/non-number. */
  size: number | null
  /**
   * Whether the server truncated the content. Strict `=== true` check —
   * truthy strings/numbers do NOT count, matching both clients' prior
   * inline `msg.truncated === true` guard.
   */
  truncated: boolean
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `file_content` message into a normalised payload.
 *
 * Behaviour-preserving: per-field guards match the inline implementations
 * in both clients. Note that `truncated` requires literal `true` — `'true'`,
 * `1`, and other truthy values resolve to `false`.
 */
export function handleFileContent(msg: Record<string, unknown>): FileContentPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    content: typeof msg.content === 'string' ? msg.content : null,
    language: typeof msg.language === 'string' ? msg.language : null,
    size: typeof msg.size === 'number' ? msg.size : null,
    truncated: msg.truncated === true,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload for a `write_file_result` message (app-only today). */
export interface WriteFileResultPayload {
  /** Path that was written. Null if missing/non-string. */
  path: string | null
  /** Error string from the server, if any. Null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `write_file_result` message into a normalised payload.
 *
 * App-only handler today — the dashboard does not yet have a
 * `write_file_result` case. Extracted here so dashboard can adopt the same
 * shape without duplicating logic later.
 */
export function handleWriteFileResult(
  msg: Record<string, unknown>,
): WriteFileResultPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

// ---------------------------------------------------------------------------
// slash_commands / agent_list / provider_list / file_list
//
// All four are list-replacement handlers: validate `Array.isArray(...)`, then
// hand the array back to the caller for `set({ ...: arr as Concrete[] })`.
// `slash_commands` and `agent_list` additionally apply a session-id guard (skip
// when `msg.sessionId` is set AND `activeSessionId` is set AND they differ).
//
// Element shape is NOT validated by these handlers — the cast to the concrete
// list element type stays at the call site (matches both clients' prior inline
// behaviour). The mobile app additionally tightens `provider_list` element
// validation; that extra filtering stays at the call site, layered on top of
// the array returned here.
// ---------------------------------------------------------------------------

/**
 * Apply the `if (msg.sessionId && active && msg.sessionId !== active) skip`
 * guard used by `slash_commands` and `agent_list`. Returns true when the
 * caller should skip the message.
 */
function shouldSkipForSessionMismatch(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): boolean {
  return (
    typeof msg.sessionId === 'string' &&
    msg.sessionId.length > 0 &&
    activeSessionId !== null &&
    msg.sessionId !== activeSessionId
  )
}

/**
 * Parse a `slash_commands` message into the replacement array.
 *
 * Returns null when the session-id guard rejects the message OR when
 * `msg.commands` is missing/non-array — caller should `if (!result) break`.
 * Element shape is NOT validated; downstream casts to the concrete
 * `SlashCommand[]` type.
 */
export function handleSlashCommands(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): { commands: unknown[] } | null {
  if (shouldSkipForSessionMismatch(msg, activeSessionId)) return null
  if (!Array.isArray(msg.commands)) return null
  return { commands: msg.commands as unknown[] }
}

/**
 * Parse an `agent_list` message into the replacement array.
 *
 * Returns null when the session-id guard rejects the message OR when
 * `msg.agents` is missing/non-array — caller should `if (!result) break`.
 * Element shape is NOT validated; downstream casts to the concrete
 * `CustomAgent[]` type.
 */
export function handleAgentList(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): { agents: unknown[] } | null {
  if (shouldSkipForSessionMismatch(msg, activeSessionId)) return null
  if (!Array.isArray(msg.agents)) return null
  return { agents: msg.agents as unknown[] }
}

/**
 * Parse a `provider_list` message into the replacement array.
 *
 * No session-id guard — provider lists are server-wide. Returns null when
 * `msg.providers` is missing/non-array. The mobile app additionally tightens
 * element validation at the call site; this handler only handles the
 * shared array-ness check.
 */
export function handleProviderList(
  msg: Record<string, unknown>,
): { providers: unknown[] } | null {
  if (!Array.isArray(msg.providers)) return null
  return { providers: msg.providers as unknown[] }
}

/**
 * Parse a `file_list` message into the replacement array.
 *
 * Dashboard-only consumer today. No session-id guard. Always returns the
 * `{ files }` shape — defaulting to `[]` when the field is missing or
 * non-array (matches the dashboard's prior inline `Array.isArray(...) ? ... : []`).
 */
export function handleFileList(msg: Record<string, unknown>): { files: unknown[] } {
  const files: unknown[] = Array.isArray(msg.files) ? (msg.files as unknown[]) : []
  return { files }
}
