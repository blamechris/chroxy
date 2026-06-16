/**
 * Shared stateless handlers for multi-client coordination messages
 * (client_joined / client_left / primary_changed / session_role).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. These
 * parse the connected-client roster and per-session role assignments. See
 * ./index.ts for the stateless-handler contract.
 */

import type { ConnectedClient, SessionRole } from '../types'

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
// session_role (#5589 / #5281)
// ---------------------------------------------------------------------------

export interface SessionRoleInfo {
  /**
   * Target session id. Unlike `primary_changed`, the server always sends
   * `session_role` with an explicit `sessionId` (it is broadcast per-session
   * via `_broadcastToSession`); null only on a malformed payload.
   */
  sessionId: string | null
  /**
   * The session's primary client id, or null when the session is unclaimed
   * (nobody-until-claim — e.g. after the previous primary disconnected).
   */
  primaryClientId: string | null
  /**
   * THIS client's role, derived from `primaryClientId` vs the client's own id:
   *   - `'primary'`   — this client owns the session (drives input)
   *   - `'observer'`  — another client owns it (read-only while running; can
   *                     still adopt an idle session per #5589)
   *   - `'unclaimed'` — nobody owns it yet
   */
  role: SessionRole
}

/**
 * Extract THIS client's role from a `session_role` message (#5589).
 *
 * Pure derivation: the server names the primary (`primaryClientId`, null when
 * unclaimed); the client computes its own role by comparing that to its own
 * id (`myClientId`, learned from `auth_ok`). Identical across both clients —
 * the storage of the result diverges (the app's dedicated `useMultiClientStore`
 * vs the dashboard's flat + per-session slots), so only this parse is shared,
 * mirroring `handlePrimaryChanged`.
 *
 * When `myClientId` is unknown (null — e.g. a pre-auth race) the role is
 * `'unclaimed'` if the slot is empty, else `'observer'` (we cannot be the
 * primary if we don't yet know our own id).
 */
export function handleSessionRole(
  msg: Record<string, unknown>,
  myClientId: string | null,
): SessionRoleInfo {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const primaryClientId =
    typeof msg.primaryClientId === 'string' ? msg.primaryClientId : null
  let role: SessionRole
  if (!primaryClientId) {
    role = 'unclaimed'
  } else if (myClientId && primaryClientId === myClientId) {
    role = 'primary'
  } else {
    role = 'observer'
  }
  return { sessionId, primaryClientId, role }
}

// ---------------------------------------------------------------------------
// parseConnectedClients — auth_ok roster parser (shares VALID_DEVICE_TYPES
// with the client_joined/left roster handlers above). No internal callers in
// the barrel; consumed by app/dashboard when processing auth_ok.
// ---------------------------------------------------------------------------

/**
 * Parse the `connectedClients` array from an `auth_ok` message, marking the
 * caller's own entry via `myClientId`.
 *
 * Behaviour-preserving — matches the inline `filter().map()` block previously
 * duplicated across app and dashboard (#4766):
 *   - drops entries that aren't objects or lack a string `clientId`
 *   - narrows `deviceType` to the validated enum, falling back to `'unknown'`
 *   - falls back `deviceName` to null and `platform` to `'unknown'` for
 *     missing/non-string values
 *   - sets `isSelf: true` only when the entry's clientId matches `myClientId`
 *
 * Returns `[]` when `rawClients` isn't an array — call sites no longer need
 * the `Array.isArray` guard.
 */
export function parseConnectedClients(
  rawClients: unknown,
  myClientId: string | null,
): ConnectedClient[] {
  if (!Array.isArray(rawClients)) return []
  return rawClients
    .filter(
      (c: unknown): c is { clientId: string } =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).clientId === 'string',
    )
    .map((c) => {
      const entry = c as Record<string, unknown>
      const deviceType: ConnectedClient['deviceType'] = VALID_DEVICE_TYPES.has(
        entry.deviceType as ConnectedClient['deviceType'],
      )
        ? (entry.deviceType as ConnectedClient['deviceType'])
        : 'unknown'
      return {
        clientId: c.clientId,
        deviceName: typeof entry.deviceName === 'string' ? entry.deviceName : null,
        deviceType,
        platform: typeof entry.platform === 'string' ? entry.platform : 'unknown',
        isSelf: c.clientId === myClientId,
      }
    })
}
