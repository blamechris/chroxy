/**
 * Permission handlers (audit P2-3 split).
 *
 * Permission-request lifecycle: `permission_request`, `permission_resolved`,
 * `permission_expired` (auto-handled system notice), `permission_timeout`
 * (auto-deny system notice), and `permission_rules_updated` (the
 * PermissionRule[] snapshot).
 *
 * Permission-mode controls: `permission_mode_changed`,
 * `available_permission_modes` (`handleAvailablePermissionModes` +
 * `PermissionMode`), and `confirm_permission_mode`. `handleAvailablePermissionModes`
 * + `PermissionMode` are also consumed by `handleAuthOk` in ./auth, which
 * imports them back from here (no cycle — this file never imports ./auth or
 * ./index).
 *
 * All routing + UX side effects stay at the call site; these only normalise the
 * wire payload. Re-exported from ./index (the barrel) so the public surface is
 * unchanged.
 */

import type { ChatMessage } from '../types'
import { nextMessageId } from '../utils'
import { parseRawStringField, parseStringField, parseUnknownArrayField } from './_shared'

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
  /**
   * #6771: present + set to `'project'` on a DURABLE (persistent) rule — one
   * backed by the daemon's per-project rule store that survives a restart, as
   * opposed to a session-scoped rule (marker absent). Clients use it to badge
   * the rule and route its removal through the project-rule path.
   */
  persist?: 'project'
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
 * - `input`: the raw message payload's `input` when it is a non-null
 *   non-array object; null otherwise (#3123). The declared
 *   `Record<string, unknown> | null` type now matches the runtime guard —
 *   arrays are rejected so the type is no longer a shallow lie.
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
  const requestId = parseRawStringField(msg, 'requestId')
  const tool = parseRawStringField(msg, 'tool')
  const description = parseRawStringField(msg, 'description')
  const input =
    msg.input && typeof msg.input === 'object' && !Array.isArray(msg.input)
      ? (msg.input as Record<string, unknown>)
      : null
  const sessionId = parseRawStringField(msg, 'sessionId')
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
    requestId: parseRawStringField(msg, 'requestId'),
    decision: parseRawStringField(msg, 'decision'),
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
  const requestId = parseRawStringField(msg, 'requestId')
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
  const requestId = parseRawStringField(msg, 'requestId')
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
  /**
   * #6771: durable per-project rules ("always allow / deny"), each tagged
   * `persist:'project'` by the server. Empty array when the message omits the
   * field (older server) or carries no persistent rules. Kept SEPARATE from
   * `rules` so the session-rule round-trip (set_permission_rules) is unchanged.
   */
  persistentRules: PermissionRule[]
}

export function handlePermissionRulesUpdated(
  msg: Record<string, unknown>,
): PermissionRulesUpdatedPayload {
  const sessionId = parseRawStringField(msg, 'sessionId')
  const rules = parseUnknownArrayField(msg, 'rules') as PermissionRule[]
  const persistentRules = parseUnknownArrayField(msg, 'persistentRules') as PermissionRule[]
  return { sessionId, rules, persistentRules }
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
  /**
   * #4019: optional human-readable explainer for the mode (e.g. "Auto-approve
   * every tool call without prompting"). The server's PERMISSION_MODES table
   * exports a description for every mode; we keep the field optional here so
   * older servers that pre-date the description plumbing still parse cleanly.
   */
  description?: string
}

/** Validate and extract permission modes from an `available_permission_modes` message. */
export function handleAvailablePermissionModes(
  msg: Record<string, unknown>,
): PermissionMode[] | null {
  if (!Array.isArray(msg.modes)) return null
  return (msg.modes as unknown[])
    .filter(
      (m): m is { id: string; label: string; description?: unknown } =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as { id: unknown }).id === 'string' &&
        typeof (m as { label: unknown }).label === 'string',
    )
    .map((m) => {
      const out: PermissionMode = { id: m.id, label: m.label }
      // #4019: pass through description when present + string-typed. Non-
      // strings (number, object, etc.) get dropped at the type boundary
      // rather than poisoning the typed shape downstream consumers see.
      if (typeof m.description === 'string') out.description = m.description
      return out
    })
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
  const mode = parseRawStringField(msg, 'mode')
  if (!mode) return null
  const warning = typeof msg.warning === 'string' ? msg.warning : 'Are you sure?'
  return { mode, warning }
}
