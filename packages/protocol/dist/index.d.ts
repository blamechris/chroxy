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
export declare const PROTOCOL_VERSION = 2;
/**
 * Client capability sets advertised in the `auth` handshake.
 * Single source of truth so app and dashboard stay in sync with the server.
 */
export declare const CLIENT_CAPABILITIES: {
    readonly desktop: readonly ["console", "environment_panel", "agent_monitor", "diff_viewer", "voice_input", "input_context_v1"];
    readonly mobile: readonly ["push_notifications", "biometric_lock", "voice_input", "live_activity", "input_context_v1"];
};
/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export declare const MIN_PROTOCOL_VERSION = 1;
export { AGENT_CONNECTION_VERSION, AgentConnectionSchema, } from './agent-connection.ts';
export type { AgentConnection, AgentConnectionAuthRoute, } from './agent-connection.ts';
/**
 * The session provider used when neither `--provider` nor `config.provider`
 * is set. Single source of truth shared by the server (`providers.js`
 * re-exports this), the dashboard, and the mobile app, so the "which provider
 * is the default?" decision lives in exactly one place.
 *
 * `claude-sdk` again since #8266. It was flipped to `claude-tui` ahead of a
 * programmatic-credit billing change announced for 2026-06-15 (#5819); that
 * change was paused the day it was due and never shipped (#7333,
 * `billing-class.js`), so claude-sdk bills as the flat subscription and the
 * reason for the detour is gone. claude-tui stays selectable.
 *
 * This constant names the DEFAULT, not claude-tui: code that means "is this
 * the claude-tui provider" compares against the literal id.
 */
export declare const DEFAULT_PROVIDER = "claude-sdk";
/**
 * #5986 (epic #5982): the embedded user-shell provider id. A user-shell session
 * is a raw `$SHELL` PTY with NO Claude semantics — terminal-only, no chat, no
 * tools/permissions/streaming. Single-sourced here so the server registry
 * (`providers.js`), the WS create gate, and the clients (which render it
 * terminal-only and gate the "New shell" button on the `userShell` capability)
 * all agree on exactly one string. Server-gated behind `config.userShell.enabled`
 * + a WS primary-token check — see `docs/security/bearer-token-authority.md`.
 */
export declare const USER_SHELL_PROVIDER = "user-shell";
/**
 * #5835 / #5839: the fixed grid size of the claude-tui PTY. The server spawns
 * the TUI at this size and the dashboard renders the live mirror at exactly this
 * size (letterboxed), so the mirror stays 1:1 faithful. Single-sourced here so
 * the server and dashboard literals can't drift and silently misalign the
 * mirror. Phase 2 (resize sync) makes the size dynamic and retires this.
 */
export declare const CLAUDE_TUI_PTY_SIZE: Readonly<{
    cols: 120;
    rows: 30;
}>;
/**
 * #8254: the smallest grid a viewer may drive the claude-tui PTY to. Below this
 * claude wraps its output a few characters per line, which hides the recovery
 * banners (unknown-resume #7847, logged-out #8223) from every classifier that
 * reads the screen. The server clamps any resize request up to this floor, so a
 * viewer that measured a collapsed or hidden pane (10x6 in the field) cannot
 * blind the daemon. 80 columns is also the narrowest grid that keeps claude's
 * "No conversation found with session ID: <uuid>" line unwrapped.
 */
export declare const CLAUDE_TUI_PTY_MIN_SIZE: Readonly<{
    cols: 80;
    rows: 24;
}>;
export * from './codex.ts';
export * from './thinking-levels.ts';
export { buildInputMessage } from './input.ts';
export type { BuildInputMessageOptions } from './input.ts';
export * from './schemas/index.ts';
export type { ServerErrorEnvelopeMessage } from './schemas/server.ts';
export type { ActivityKind, ActivityStatus, ActivityOutputRef, ActivityEntry, ServerActivitySnapshotMessage, ServerActivityDeltaMessage, ServerCancelActivityAckMessage, ServerBudgetResumeAckMessage, } from './schemas/server.ts';
export type { RepoVerdict, RepoTree, RepoStatus, HostStatusSummary, ServerHostStatusSnapshotMessage, } from './schemas/server.ts';
export type { RunnerVerdict, RunnerServiceState, RunnerInfo, RepoRunners, RunnerStatusSummary, ServerRunnerStatusSnapshotMessage, } from './schemas/server.ts';
export type { RepoMemoryCache, RepoMemoryReport, RepoMemoryStatus, RepoRelayRun, RepoRelayVerdict, RepoRelayStatus, IntegrationRepo, IntegrationStatusSummary, IntegrationCliStatus, ServerIntegrationStatusSnapshotMessage, } from './schemas/server.ts';
export type { IntegrationActionCounts, ServerIntegrationActionAckMessage, } from './schemas/server.ts';
export type { SkillInventoryEntry, SkillInventoryRepo, ServerSkillsInventorySnapshotMessage, } from './schemas/server.ts';
export type { HostStatusRequestMessage } from './schemas/client.ts';
export type { RunnerStatusRequestMessage } from './schemas/client.ts';
export type { IntegrationStatusRequestMessage } from './schemas/client.ts';
export type { IntegrationActionMessage } from './schemas/client.ts';
export type { SkillsInventoryRequestMessage } from './schemas/client.ts';
export type { Attachment, BinaryAttachment, FileRefAttachment } from './schemas/client.ts';
export * from './error-categories.ts';
export * from './scheduled-task-health.ts';
