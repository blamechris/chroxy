/**
 * @chroxy/protocol — shared WebSocket protocol constants
 *
 * Single source of truth for protocol versioning and message types
 * across server, app, and dashboard.
 */

/**
 * Current protocol version. Bumped only for breaking wire-shape changes.
 *
 * Version history:
 *   v1 — baseline message set.
 *   v2 — `server_status` gained a structured `phase` field
 *        ('tunnel_warming' | 'ready'). Old (v1) clients render unknown
 *        `server_status` payloads as plain chat messages; the server
 *        only emits the structured form to clients that advertised
 *        v2+ in the auth handshake.
 */
export const PROTOCOL_VERSION = 2

/**
 * Client capability sets advertised in the `auth` handshake.
 * Single source of truth so app and dashboard stay in sync with the server.
 */
export const CLIENT_CAPABILITIES = {
  desktop: ['console', 'environment_panel', 'agent_monitor', 'diff_viewer', 'voice_input'] as const,
  mobile: ['push_notifications', 'biometric_lock', 'voice_input', 'live_activity'] as const,
} as const

/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export const MIN_PROTOCOL_VERSION = 1

// Re-export schemas for convenience (also available via '@chroxy/protocol/schemas')
export * from './schemas/index.ts'
