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
export const PROTOCOL_VERSION = 2;
/**
 * Client capability sets advertised in the `auth` handshake.
 * Single source of truth so app and dashboard stay in sync with the server.
 */
export const CLIENT_CAPABILITIES = {
    desktop: ['console', 'environment_panel', 'agent_monitor', 'diff_viewer', 'voice_input'],
    mobile: ['push_notifications', 'biometric_lock', 'voice_input', 'live_activity'],
};
/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export const MIN_PROTOCOL_VERSION = 1;
/**
 * The session provider used when neither `--provider` nor `config.provider`
 * is set. Single source of truth shared by the server (`providers.js`
 * re-exports this), the dashboard, and the mobile app, so the "which provider
 * is the default?" decision lives in exactly one place.
 *
 * Flipped from `claude-sdk` to `claude-tui` ahead of the 2026-06-15
 * programmatic-credit cutover (#5819): on/after that boundary the host
 * claude-sdk / claude-cli providers draw from Anthropic's metered
 * programmatic-credit pool, so a zero-config session would silently spend
 * metered credits. `claude-tui` bills against the flat Claude subscription
 * allowance today (a best-effort bet, not a sanctioned path — see the
 * provider docs). Clients suppress the per-session provider badge for this
 * value, so keeping it here means the next default flip doesn't reintroduce
 * the drift fixed in #5823.
 */
export const DEFAULT_PROVIDER = 'claude-tui';
/**
 * #5835 / #5839: the fixed grid size of the claude-tui PTY. The server spawns
 * the TUI at this size and the dashboard renders the live mirror at exactly this
 * size (letterboxed), so the mirror stays 1:1 faithful. Single-sourced here so
 * the server and dashboard literals can't drift and silently misalign the
 * mirror. Phase 2 (resize sync) makes the size dynamic and retires this.
 */
export const CLAUDE_TUI_PTY_SIZE = Object.freeze({ cols: 120, rows: 30 });
// Re-export schemas for convenience (also available via '@chroxy/protocol/schemas')
export * from "./schemas/index.js";
// Re-export client-side error-category detection (#3151)
export * from "./error-categories.js";
