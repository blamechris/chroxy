/**
 * Shared internal helpers for the stateless message handlers — the field
 * parsers and the session-resolution primitive used across every handler
 * family module.
 *
 * Extracted from the handlers barrel (audit P2-3) so family modules
 * (./git, ./file, ./environment, and the stateful families to follow) can
 * import these without a circular dependency back on ./index. Pure move, no
 * logic change.
 *
 * Visibility note: `resolveSessionId` and the `SessionPatch` type are part of
 * the barrel's public surface and are re-exported from ./index. The three
 * field parsers (`parseStringField`, `parseRawStringField`, `parseEnumField`)
 * were always module-private; they are exported here only so sibling family
 * modules can import them, and are deliberately NOT re-exported from ./index.
 */

/** Parse a string field from a message, returning trimmed value or null. */
export function parseStringField(msg: Record<string, unknown>, field: string): string | null {
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
export function parseRawStringField(msg: Record<string, unknown>, field: string): string | null {
  const val = msg[field]
  return typeof val === 'string' ? val : null
}

/** Parse an unknown[] field, returning the array or [] when missing/non-array. */
export function parseUnknownArrayField(msg: Record<string, unknown>, field: string): unknown[] {
  const val = msg[field]
  return Array.isArray(val) ? (val as unknown[]) : []
}

/** Parse a finite-number field, returning the value or `fallback` (default 0) when missing/non-finite. */
export function parseFiniteNumberField(msg: Record<string, unknown>, field: string, fallback = 0): number {
  const val = msg[field]
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback
}

/**
 * Build a small union-checking helper that returns the value when it matches
 * one of the provided literals, else null. Used for enum fields like
 * `serverMode` and `mode`.
 */
export function parseEnumField<T extends string>(
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
 * Resolve which session a per-message-event targets — **fallback semantics**.
 *
 * Most server messages include an optional `sessionId`; when absent, the
 * active session ID is used as a fallback. The returned value is non-null
 * unless BOTH `msg.sessionId` and `activeSessionId` are missing/empty.
 *
 * Intended for events that should always be applied somewhere (e.g.
 * `message`, `tool_start`, `tool_result`, `permission_request`): if the
 * server omits the explicit routing tag, route to the user's current session.
 *
 * Distinct from {@link shouldSkipForSessionMismatch}, which uses
 * **broadcast guard** semantics (drop the event when the explicit tag does
 * not match).
 */
export function resolveSessionId(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): string | null {
  return parseStringField(msg, 'sessionId') || activeSessionId
}
