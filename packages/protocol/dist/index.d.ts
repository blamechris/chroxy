/**
 * @chroxy/protocol — shared WebSocket protocol constants
 *
 * Single source of truth for protocol versioning and message types
 * across server, app, and dashboard.
 */
/** Current protocol version. Bump when adding new message types. */
export declare const PROTOCOL_VERSION = 1;
/**
 * Client capability sets advertised in the `auth` handshake.
 * Single source of truth so app and dashboard stay in sync with the server.
 */
export declare const CLIENT_CAPABILITIES: {
    readonly desktop: readonly ["console", "environment_panel", "agent_monitor", "diff_viewer", "voice_input"];
    readonly mobile: readonly ["push_notifications", "biometric_lock", "voice_input", "live_activity"];
};
/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export declare const MIN_PROTOCOL_VERSION = 1;
export * from './schemas/index.ts';
