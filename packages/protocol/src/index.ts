/**
 * @chroxy/protocol — shared WebSocket protocol constants
 *
 * Single source of truth for protocol versioning across server, app, and dashboard.
 */

/** Current protocol version. Bump when adding new message types. */
export const PROTOCOL_VERSION = 1

/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export const MIN_PROTOCOL_VERSION = 1
