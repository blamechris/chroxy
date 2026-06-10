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
  IntegrationRepo,
  IntegrationStatusSummary,
  IntegrationCliStatus,
  ServerIntegrationStatusSnapshotMessage,
} from './schemas/server.ts'

// #5171: the client→server request type is pinned at the entry point too so
// consumers can import the alias without reaching into `./schemas/client.ts`.
export type { HostStatusRequestMessage } from './schemas/client.ts'
// #5253: runner survey request alias.
export type { RunnerStatusRequestMessage } from './schemas/client.ts'
// #5499: integrations survey request alias.
export type { IntegrationStatusRequestMessage } from './schemas/client.ts'

// Re-export client-side error-category detection (#3151)
export * from './error-categories.ts'
