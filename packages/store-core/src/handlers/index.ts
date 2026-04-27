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

import type { ChatMessage, DevPreview, SessionInfo } from '../types'
import { nextMessageId } from '../utils'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a string field from a message, returning trimmed value or null. */
function parseStringField(msg: Record<string, unknown>, field: string): string | null {
  const val = msg[field]
  if (typeof val === 'string' && val.trim()) return val.trim()
  return null
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
// dev_preview
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a patch appending (or replacing) a
 * dev-preview entry by port. Both clients dedupe by port: a new preview for
 * an already-tracked port replaces the existing entry, otherwise it is
 * appended.
 *
 * Behaviour-preserving: `msg.port` and `msg.url` are forwarded verbatim with
 * the same unsafe cast (`port as number, url as string`) the prior inline
 * implementations used. Tightening to runtime validation would be a behaviour
 * change and is out of scope for the #2661 mechanical migration.
 *
 * The current devPreviews array is a required input because the dedup needs
 * read access to existing state; the call site passes `session.devPreviews`.
 */
export function handleDevPreview(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  currentPreviews: DevPreview[],
): SessionPatch {
  const preview: DevPreview = {
    port: msg.port as number,
    url: msg.url as string,
  }
  const filtered = currentPreviews.filter((p) => p.port !== preview.port)
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      devPreviews: [...filtered, preview],
    },
  }
}

// ---------------------------------------------------------------------------
// dev_preview_stopped
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a patch removing the dev-preview entry
 * matching `msg.port`. If no entry matches the previews list is returned
 * unchanged (matches both clients' prior `filter`-based inline implementation).
 *
 * Behaviour-preserving: `msg.port` is cast verbatim (`port as number`) without
 * runtime validation, matching the prior inline behaviour.
 */
export function handleDevPreviewStopped(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  currentPreviews: DevPreview[],
): SessionPatch {
  const stoppedPort = msg.port as number
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      devPreviews: currentPreviews.filter((p) => p.port !== stoppedPort),
    },
  }
}
