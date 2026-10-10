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
  // `permission_outcome_stopped_v1` (#8374): the client can label a replayed
  // `permission_outcome` whose outcome is `stopped`. A client without it is sent
  // `expired` instead, because an older build drops an outcome it cannot parse.
  //
  // `history_error_replay_v1` (#6630): the client handles a replayed `error`
  // entry (no usage-limit alert for it, the code-specific chips rebuilt). A client
  // without it is not sent recorded errors in a history replay, because an older
  // build raises its usage-limit alert for one on every replay.
  //
  // `history_thinking_replay_v1` (#6630): the client renders a replayed reasoning entry
  // with no text (`kind: 'thinking'`, empty content) as a thinking bubble. A client
  // without it is not sent one, because an older build renders it as an empty
  // assistant bubble.
  //
  // `history_question_superseded_v1` (#8470): the client reads `superseded: true` on a
  // replayed `user_question` (a newer question replaced it) and shows it as replaced.
  // A client without it is not sent that question, because an older build would
  // render it as a live, answerable card and then as "(resolved)".
  desktop: ['console', 'environment_panel', 'agent_monitor', 'diff_viewer', 'voice_input', 'input_context_v1', 'permission_outcome_stopped_v1', 'history_error_replay_v1', 'history_thinking_replay_v1', 'history_question_superseded_v1'] as const,
  mobile: ['push_notifications', 'biometric_lock', 'voice_input', 'live_activity', 'input_context_v1', 'permission_outcome_stopped_v1', 'history_error_replay_v1', 'history_thinking_replay_v1', 'history_question_superseded_v1'] as const,
} as const

/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export const MIN_PROTOCOL_VERSION = 1

export {
  AGENT_CONNECTION_VERSION,
  AgentConnectionSchema,
} from './agent-connection.ts'
export type {
  AgentConnection,
  AgentConnectionAuthRoute,
} from './agent-connection.ts'

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
export const DEFAULT_PROVIDER = 'claude-sdk'

/**
 * #5986 (epic #5982): the embedded user-shell provider id. A user-shell session
 * is a raw `$SHELL` PTY with NO Claude semantics — terminal-only, no chat, no
 * tools/permissions/streaming. Single-sourced here so the server registry
 * (`providers.js`), the WS create gate, and the clients (which render it
 * terminal-only and gate the "New shell" button on the `userShell` capability)
 * all agree on exactly one string. Server-gated behind `config.userShell.enabled`
 * + a WS primary-token check — see `docs/security/bearer-token-authority.md`.
 */
export const USER_SHELL_PROVIDER = 'user-shell'

/**
 * #5835 / #5839: the fixed grid size of the claude-tui PTY. The server spawns
 * the TUI at this size and the dashboard renders the live mirror at exactly this
 * size (letterboxed), so the mirror stays 1:1 faithful. Single-sourced here so
 * the server and dashboard literals can't drift and silently misalign the
 * mirror. Phase 2 (resize sync) makes the size dynamic and retires this.
 */
export const CLAUDE_TUI_PTY_SIZE = Object.freeze({ cols: 120, rows: 30 })

/**
 * #8254: the smallest grid a viewer may drive the claude-tui PTY to. Below this
 * claude wraps its output a few characters per line, which hides the recovery
 * banners (unknown-resume #7847, logged-out #8223) from every classifier that
 * reads the screen. The server clamps any resize request up to this floor, so a
 * viewer that measured a collapsed or hidden pane (10x6 in the field) cannot
 * blind the daemon. 80 columns is also the narrowest grid that keeps claude's
 * "No conversation found with session ID: <uuid>" line unwrapped.
 */
export const CLAUDE_TUI_PTY_MIN_SIZE = Object.freeze({ cols: 80, rows: 24 })

// #6689: Codex sandbox constants (modes, default, provider id, UI metadata).
// Single-sourced so the wire schema, the server, and both clients agree. Kept
// in a dedicated module so `./schemas/client.ts` can import the mode list for
// `z.enum(CODEX_SANDBOX_MODES)` without a circular import through this entry.
export * from './codex.ts'

// #7730: the thinking / reasoning-effort vocabulary — the bounded syntactic
// guard, the per-model roster resolver, and the legacy Claude triple that is
// the ONLY literal level list in non-test source. Kept in a dedicated module
// for the same reason as `./codex.ts`: `./schemas/client.ts` composes the
// predicate for `set_thinking_level` without a circular import through this
// entry, and store-core / the clients import it without pulling in Zod.
export * from './notification-categories.ts'
export * from './thinking-levels.ts'

// #7822: one canonical serializer keeps the dashboard and mobile wire shape
// identical as optional selected-context fields are negotiated.
export { computeHunks, splitContentLines, DEFAULT_CONTEXT_LINES, MAX_DIFF_LINES } from './hunk-diff.ts'
export type { DiffHunk, DiffHunkLine } from './hunk-diff.ts'

export { buildInputMessage } from './input.ts'
export type { BuildInputMessageOptions } from './input.ts'

// Re-export schemas for convenience (also available via '@chroxy/protocol/schemas')
export * from './schemas/index.ts'

// #4192: explicit named type re-export pins the alias at the package entry
// point. `export *` would silently emit nothing if `ServerErrorEnvelopeMessage`
// were removed from `./schemas/server.ts`; the named re-export below makes
// `tsc --build` fail with "module has no exported member" — closing the
// runtime-test-can't-see-types gap Copilot flagged on #4196. Add a sibling
// line for any future type alias whose existence is a public contract.
export type { ServerErrorEnvelopeMessage } from './schemas/server.ts'

// #5161: pin the Control Room activity-tree contract at the package entry point
// so #5160/#5162/#5163 import `ActivityEntry` / `ServerActivitySnapshotMessage`
// / `ServerActivityDeltaMessage` etc. as a stable public contract — the named
// re-export makes `tsc --build` fail loudly if any alias is removed from
// `./schemas/server.ts` (same rationale as the #4192 line above).
export type {
  ActivityKind,
  ActivityStatus,
  ActivityOutputRef,
  ActivityEntry,
  ServerActivitySnapshotMessage,
  ServerActivityDeltaMessage,
  ServerCancelActivityAckMessage,
  // #5752: resume_budget positive-ack contract.
  ServerBudgetResumeAckMessage,
} from './schemas/server.ts'

// #5171: pin the Host/Repo Status Control Room contract (#5170 epic) at the
// package entry point so sibling issues import `RepoStatus` /
// `ServerHostStatusSnapshotMessage` etc. as a stable public contract — the named
// re-export makes `tsc --build` fail loudly if any alias is removed from
// `./schemas/server.ts` (same rationale as the #4192 / #5161 lines above).
export type {
  RepoVerdict,
  RepoTree,
  RepoStatus,
  HostStatusSummary,
  ServerHostStatusSnapshotMessage,
} from './schemas/server.ts'

// #5253: pin the self-hosted runner status contract at the entry point too, so
// the dashboard panel + store import `RepoRunners` / `RunnerInfo` /
// `ServerRunnerStatusSnapshotMessage` as a stable public contract.
export type {
  RunnerVerdict,
  RunnerServiceState,
  RunnerInfo,
  RepoRunners,
  RunnerStatusSummary,
  ServerRunnerStatusSnapshotMessage,
} from './schemas/server.ts'

// #5499 (epic #5498): pin the Integrations tab contract at the entry point so
// the dashboard panel + store import `RepoMemoryStatus` / `IntegrationRepo` /
// `ServerIntegrationStatusSnapshotMessage` as a stable public contract.
export type {
  RepoMemoryCache,
  RepoMemoryReport,
  RepoMemoryStatus,
  // #5501: repo-relay observability block.
  RepoRelayRun,
  RepoRelayVerdict,
  RepoRelayStatus,
  IntegrationRepo,
  IntegrationStatusSummary,
  IntegrationCliStatus,
  ServerIntegrationStatusSnapshotMessage,
} from './schemas/server.ts'

// #5500 (epic #5498): pin the Integrations Reindex action contract at the
// entry point — request/ack correlation types for the dashboard's Reindex
// button (same rationale as the #4192 / #5499 lines above).
export type {
  IntegrationActionCounts,
  ServerIntegrationActionAckMessage,
} from './schemas/server.ts'

// #5554 (epic #5159): pin the Skills tab contract at the entry point so the
// dashboard panel + store import `SkillInventoryEntry` / `SkillInventoryRepo` /
// `ServerSkillsInventorySnapshotMessage` as a stable public contract.
export type {
  SkillInventoryEntry,
  SkillInventoryRepo,
  ServerSkillsInventorySnapshotMessage,
} from './schemas/server.ts'

// #5171: the client→server request type is pinned at the entry point too so
// consumers can import the alias without reaching into `./schemas/client.ts`.
export type { HostStatusRequestMessage } from './schemas/client.ts'
// #5253: runner survey request alias.
export type { RunnerStatusRequestMessage } from './schemas/client.ts'
// #5499: integrations survey request alias.
export type { IntegrationStatusRequestMessage } from './schemas/client.ts'
// #5500: integrations Reindex action request alias.
export type { IntegrationActionMessage } from './schemas/client.ts'
// #5554: skills inventory survey request alias.
export type { SkillsInventoryRequestMessage } from './schemas/client.ts'
// #6453: canonical WIRE attachment types pinned at the entry point so the app +
// dashboard import one shape (was a loose `WireAttachment` / inline ad-hoc type).
export type { Attachment, BinaryAttachment, FileRefAttachment } from './schemas/client.ts'

// Re-export client-side error-category detection (#3151)
export * from './error-categories.ts'

// #7376: why a turn was terminated under an in-flight tool call, and the shared
// wording the clients and the server's fallback result text agree on.
export * from './turn-termination.ts'

// #7326: how a TURN ended (completed / truncated / refused / stopped), the field
// the `result` frame carries it in, and the wording both clients share.
export * from './turn-outcome.ts'

// #6871: shared scheduled-task HEALTH derivation. Zod-free and pure so BOTH the
// `chroxy schedule` CLI (#6868) and the dashboard panel import one mapping — a
// second copy would be free to drift toward reporting a never-run / refused /
// paused / quarantined schedule as healthy.
export * from './scheduled-task-health.ts'

// #7496: the replay back-pressure park ceiling and the dashboard transcript
// watchdog derived above it, in one module so they cannot be moved independently.
export * from './replay-timing.ts'
