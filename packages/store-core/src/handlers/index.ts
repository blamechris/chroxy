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

import type { ChatMessage, Checkpoint, DevPreview, SessionInfo } from '../types'
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
 * - `message` is ANSI-stripped and trimmed; empty/whitespace falls back to the
 *   default error string (matches the app's `(stripAnsi(...).trim() || ...)`
 *   pattern, which is also a safe widening of the dashboard's behaviour
 *   since `stripAnsi` on a non-empty input never produces an empty trimmed
 *   string in practice — this strict variant is the conservative choice).
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
 * Build the bound-token mismatch hint surfaced to users (#2904). Both clients
 * use the same wording — pulled into a constant so the dashboard alert and
 * the app's modal share a single source of truth.
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
    message = typeof msg.message === 'string' ? msg.message : 'Unknown error'
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
