/**
 * Shared type definitions for the connection store.
 *
 * Extracted from connection.ts to reduce file size and allow
 * other modules (message-handler, utils) to import types without
 * creating circular dependencies.
 *
 * Protocol and message types are imported from @chroxy/store-core.
 * Platform-specific types (SessionState, ConnectionState) are defined here.
 */

// #4019: PermissionMode imported for local use at line 466 (re-export below
// puts it on the public surface but doesn't bring it into this file's
// type-name scope).
import type { PermissionMode } from '@chroxy/store-core'
// #5175: Host/Repo Status Control Room snapshot type (epic #5170). The store
// holds the latest `host_status_snapshot` so the Control Room section can render
// the fleet table; the type is the protocol contract pinned in @chroxy/protocol.
import type { ServerHostStatusSnapshotMessage, ServerRunnerStatusSnapshotMessage, ServerContainersStatusSnapshotMessage, ServerRepoRuntimeConfigSnapshotMessage, ServerByokPoolStatusSnapshotMessage, ServerHostPruneStatusSnapshotMessage, ServerSimulatorStatusSnapshotMessage, ServerEmulatorStatusSnapshotMessage, ServerWslStatusSnapshotMessage, ServerIntegrationStatusSnapshotMessage, ServerSkillsInventorySnapshotMessage, ServerMailboxStatusSnapshotMessage, ServerExternalSessionsSnapshotMessage, ServerRepoEventsSnapshotMessage, ServerGithubWebhookConfigMessage, ServerPermissionInputMessage, ServerSymbolsSnapshotMessage, ServerSearchResultsMessage, ServerReferencesResultMessage, IntegrationActionCounts, ServerPairPendingMessage, ServerSessionPresetFull, Attachment, ServerOrchestrationRunsSnapshot, CodexSandboxMode } from '@chroxy/protocol'
import type { HeldRunDetail } from '@chroxy/store-core'
// #5184: header cost-badge display mode. Defined in a plain lib module
// (which owns the union + runtime guard) — the store only needs the type
// for its state slot, and avoids importing a `.tsx` component here.
import type { CostBadgeMode } from '../lib/cost-badge-mode'

// Re-export shared protocol types from store-core
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  // #3188: re-export auto-evaluator rewrite metadata so dashboard
  // components can type-check banner props without reaching into
  // store-core.
  EvaluatorRewriteMeta,
  // #6768: re-export the compaction-boundary marker metadata so the
  // CompactionMarker component can type-check its props the same way.
  CompactBoundaryMeta,
  SavedConnection,
  ContextUsage,
  // #6769: occupancy snapshot type (the context meter's only honest input).
  ContextOccupancy,
  InputSettings,
  ModelInfo,
  SessionInfo,
  // #5630/#5629: era-aware billing class union.
  BillingClass,
  AgentInfo,
  ConnectedClient,
  SessionHealth,
  SessionContext,
  McpServer,
  ServerError,
  ServerErrorAction,
  DevPreview,
  WebTask,
  WebFeatureStatus,
  ConversationSummary,
  SearchResult,
  SlashCommand,
  CustomAgent,
  ConnectionPhase,
  // #4019: typed permission-mode shape — `description` flows through to the
  // dashboard pickers so they share one source of truth with the server.
  PermissionMode,
  ConnectionContext,
  QueuedMessage,
  Checkpoint,
  BaseSessionState,
  PendingPermissionConfirm,
  // Re-export shared log types so consumers in the dashboard import them via
  // dashboard/store/types — eliminates the local LogEntry/LogLevel duplication
  // (#3114).
  LogEntry,
  LogLevel,
  // Re-export shared git result element types (#3132). Local definitions
  // are now redundant; canonical types live in @chroxy/store-core.
  DiffFile,
  DiffHunk,
  DiffHunkLine,
  // #3181: re-export GitFileStatus from store-core in place of the old
  // dashboard-local GitStatusEntry. Same shape (path + status union) — was
  // missed by the #3132 dedup sweep that moved DiffFile/Hunk/HunkLine.
  GitFileStatus,
  // #6780 — re-export GitBranch from store-core for the dashboard git panel's
  // branch listing (mirrors the app's GitBranchesResult.branches shape).
  GitBranch,
  // #5163 (epic #5159): Control Room activity state. The reducer + selector
  // live in store-core (#5162); the dashboard holds one `ActivityState` on
  // the connection store and the Control Room panel renders it via
  // `selectActivityTree`.
  ActivityState,
  ActivityEntry,
  ActivityTreeNode,
} from '@chroxy/store-core';

// Import for local use in SessionState/ConnectionState definitions below
import type {
  BaseSessionState,
  BillingClass,
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ConnectionPhase,
  ContextUsage,
  ContextOccupancy,
  ConversationSummary,
  CustomAgent,
  DiffFile,
  InputSettings,
  LogEntry,
  MessageAttachment,
  ModelInfo,
  GitFileStatus,
  GitBranch,
  PendingPermissionConfirm,
  SavedConnection,
  SearchResult,
  ServerError,
  ServerErrorAction,
  SessionInfo,
  SlashCommand,
  WebFeatureStatus,
  WebTask,
} from '@chroxy/store-core';

export interface EnvironmentInfo {
  id: string;
  name: string;
  cwd: string;
  image: string;
  containerId: string;
  containerUser: string;
  containerCliPath: string;
  status: 'running' | 'stopped' | 'error';
  sessions: string[];
  createdAt: string;
  memoryLimit: string;
  cpuLimit: string;
}

// #6767: selective checkpoint-restore mode. 'files' reverts only the working
// tree (current session/conversation continue), 'conversation' branches the
// conversation at the checkpoint (working tree kept), 'both' does both (default).
export type RestoreCheckpointMode = 'files' | 'conversation' | 'both';

export interface ProviderCapabilities {
  permissions: boolean;
  inProcessPermissions: boolean;
  modelSwitch: boolean;
  permissionModeSwitch: boolean;
  // #5609: true when switching to 'auto' mid-turn interrupts the running
  // turn (CLI respawns its `claude -p` subprocess — the #3729 panic-button).
  // SDK/TUI apply the switch in-place and leave the turn running, so they
  // report false / omit it. The dashboard uses this + the active session's
  // streaming state to word the auto-mode confirm dialog accurately.
  interruptsTurnOnAutoSwitch?: boolean;
  planMode: boolean;
  // #6312: true when the provider streams partial responses. claude-tui reports
  // false (it can only deliver complete turns); other providers omit it (treated
  // as capable). Consumed by the session-creation limitation note so the
  // `streaming: false` flag isn't silently dropped client-side.
  streaming?: boolean;
  resume: boolean;
  terminal: boolean;
  thinkingLevel?: boolean;
  // True if the provider supports session-scoped permission rules
  // (i.e. the "Allow for Session" affordance). Derived server-side from
  // method existence — only providers whose session class implements
  // setPermissionRules report this as true (#3072).
  sessionRules?: boolean;
  // #5026: true when the provider runs sessions inside an isolated Docker
  // container (docker-cli, docker-sdk, docker-byok). The dashboard surfaces
  // this with a visual badge + container settings knobs (image / memory /
  // cpu / containerUser) in the New Session modal's advanced section.
  containerized?: boolean;
  // #5791 — claude-tui only: true when the daemon will reinject a single
  // multi-select AskUserQuestion answer (CHROXY_TUI_MULTISELECT_REINJECT).
  // Gates the multi-select checkbox affordance so the client doesn't offer a
  // form the server refuses.
  multiSelectReinject?: boolean;
  // #6767: true when the provider can fork/branch a resumed conversation at a
  // message boundary (SDK provider). Gates the checkpoint restore-mode picker's
  // "Conversation" option — providers that can't fork (CLI/TUI/BYOK/Gemini/Codex
  // and containerized SDK) omit it / report false, so the option is disabled.
  conversationFork?: boolean;
  // #6888: true when an operator's free-text deny reason (PermissionPrompt's
  // "sent with Deny" textarea) actually reaches the agent. SDK/BYOK (+ their
  // Docker variants, DeepSeek, Ollama) report true — the reason feeds back as
  // the tool's denial message on the in-process PermissionManager path. Legacy
  // CLI, claude-tui, Gemini, and the legacy codex `exec` driver never take that
  // path and omit the field (falsy). codex app-server explicitly reports false:
  // it HAS an in-process respondToPermission but its RPC response back to codex
  // drops the message (tracked by #6885). The dashboard gates the deny-reason
  // textarea on this so it never promises delivery a provider won't honor.
  denyReason?: boolean;
}

// #3404 audit (F1+F5): per-provider auth state for grey-out + billing panel.
export interface ProviderAuth {
  ready: boolean;
  source: 'env' | 'oauth' | 'none';
  envVar: string | null;
  envVars: string[];
  hint: string;
  detail: string;
  // #5630/#5629: era-aware billing class. Optional — older servers omit it.
  billingClass?: BillingClass;
}

export interface ProviderInfo {
  name: string;
  capabilities: ProviderCapabilities;
  auth?: ProviderAuth;
}

// #3855: one provider-credential row in the Settings "Provider Credentials"
// pane. Mirrors the server's masked, value-free status entry — the raw value
// is never present here.
export interface ProviderCredentialEntry {
  key: string;
  provider: string;
  label: string;
  kind: 'api-key' | 'oauth-token';
  status: 'set' | 'missing';
  source: 'env' | 'store' | 'oauth' | 'none';
  masked?: string;
  oauth: boolean;
}

// #3855: result of a `test_credential` ping for one key.
export interface ProviderCredentialTestResult {
  ok: boolean;
  error?: string;
  model?: string;
  latencyMs?: number;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

export interface DirectoryListing {
  path: string | null;
  parentPath: string | null;
  entries: DirectoryEntry[];
  error: string | null;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number | null;
}

export interface FileListing {
  path: string | null;
  parentPath: string | null;
  entries: FileEntry[];
  error: string | null;
}

export interface FileContent {
  path: string | null;
  content: string | null;
  language: string | null;
  size: number | null;
  truncated: boolean;
  error: string | null;
  // #6502 — the request nonce echoed from the originating `read_file`, used to
  // drop replies from superseded requests. Null when the server didn't echo one.
  requestId: string | null;
}

// #3181: GitStatusEntry was structurally identical to @chroxy/store-core's
// `GitFileStatus` (path + status union). Dropped in favour of the canonical
// re-export above so the dashboard and app share a single shape for staged/
// unstaged entries — same dedup the #3132 sweep applied to DiffFile/Hunk.
export interface GitStatusResult {
  branch: string | null;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  error: string | null;
}

// #6780 — dashboard adoption of the git_branches_result / git_stage_result /
// git_unstage_result / git_commit_result payloads. Mirrors the app's
// packages/app/src/store/types.ts shapes 1:1 (same wire messages, same
// store-core parsers — @chroxy/store-core's handleGitBranchesResult /
// handleGitStageResult / handleGitCommitResult).

export interface GitBranchesResult {
  branches: GitBranch[];
  currentBranch: string | null;
  error: string | null;
}

// Shared by both git_stage_result and git_unstage_result (identical payload
// shape — only an optional error string).
export interface GitStageResult {
  error: string | null;
}

export interface GitCommitResult {
  hash: string | null;
  message: string | null;
  error: string | null;
}

// #6876 — in-app PR creation result. `url` is the created PR's URL (null on any
// failure), `number` its integer id (best-effort), `branch`/`base` echo the
// head/base used, and `error` carries a clear message on failure. Dashboard-only
// for v1 (mobile PR-creation UI is a tracked follow-up).
// #6938 — `existingUrl` is set (non-null) only on the "a pull request already
// exists for this branch" error path, so the UI can render it as a real link
// instead of the URL only ever appearing embedded inside `error` text.
export interface GitCreatePrResult {
  url: string | null;
  number: number | null;
  branch: string | null;
  base: string | null;
  error: string | null;
  existingUrl?: string | null;
}

// `DiffHunkLine`, `DiffHunk`, and `DiffFile` are now re-exported from
// `@chroxy/store-core` above (#3132).

export interface DiffResult {
  files: DiffFile[];
  error: string | null;
}

export type ThinkingLevel = 'default' | 'high' | 'max';

/**
 * Session-scoped auto-approval rule. Mirrors the app-side shape so the
 * "Allow for Session" flow can register auto-approval for a tool.
 */
export interface PermissionRule {
  tool: string;
  decision: 'allow' | 'deny';
  pattern?: string;
  // #6771: set to 'project' on a DURABLE rule (backed by the daemon's per-project
  // rule store — survives restarts). Absent on a session-scoped rule.
  persist?: 'project';
}

/**
 * #6772 — one entry from the server's permission audit trail (permission-audit.js
 * ring buffer), returned by a `query_permission_audit` pull. Heterogeneous `type`s
 * share this shape; per-type fields are optional (mirrors the wire
 * `ServerPermissionAuditEntrySchema`). Known kinds: 'mode_change' /
 * 'whitelist_change' / 'decision' — but `type` is an OPEN string (PR #6836
 * review): a future server-side audit kind must not fail the payload parse, and
 * the view renders unknown kinds with a generic label. Rendered read-only in the
 * SettingsPanel "Permission history" view.
 *
 * #6830 — `decision` entries are enriched with `tool` (the tool the decision
 * applied to) and, for a durable grant, `persist:'project'` + `projectKey` (the
 * project cwd the rule is scoped to). Set on an `allowAlways` that actually
 * persisted a project rule, and on a `reason:'persisted_rule'` entry — a
 * durable rule silently auto-approving a tool call with NO prompt ever shown
 * (clientId is null, no requestId). Persisted-rule entries are COALESCED
 * server-side per (sessionId, tool, projectKey): `count` is how many
 * approvals folded into the entry, `firstAt` the first one's time,
 * `timestamp` the latest (PR #6842 review — keeps the audit ring from being
 * flooded at tool-call speed).
 */
export interface PermissionAuditEntry {
  type: string;
  clientId?: string | null;
  sessionId?: string | null;
  timestamp: number;
  // mode_change
  previousMode?: string;
  newMode?: string;
  // whitelist_change
  rules?: { tool: string; decision: string }[];
  // decision
  requestId?: string;
  decision?: string;
  reason?: string;
  tool?: string | null;
  persist?: string | null;
  projectKey?: string | null;
  count?: number;
  firstAt?: number;
}

/**
 * Decision stored when the user resolves a permission prompt. Persists
 * across tab switches (fixes #2833) so the prompt component does not
 * re-render with Allow/Deny buttons after the user already answered.
 *
 * `'allowSession'` means the user clicked "Allow for Session" — the wire
 * decision sent to the server is `'allow'`, and a follow-up
 * `set_permission_rules` message registers a rule for the tool.
 *
 * #6771: `'allowAlways'` means the user clicked "Always allow (this project)".
 * Unlike `allowSession`, the wire decision `'allowAlways'` is sent VERBATIM —
 * the server persists a durable per-project rule (no follow-up needed).
 */
export type PermissionDecision = 'allow' | 'deny' | 'allowSession' | 'allowAlways';

// #3188: auto-evaluator clarify-pending state. Populated by the
// `evaluator_clarify` handler when the auto-evaluator hook (#3186) lands
// on the clarify verdict; cleared when the operator answers (sends a
// regular `user_input`) or when a follow-up `evaluator_rewrite` arrives
// for the same session. Transient — NOT persisted across reconnects.
// The server re-fires the event on the next user_input cycle, so a
// reconnect mid-clarify drops the inline prompt block; the operator
// re-types and the next round-trip reproduces it.
export interface PendingEvaluatorClarify {
  /** Server-generated id used to dedup events on replay. */
  evaluatorIterationId: string;
  /** 1-based clarify-loop counter, capped at MAX_EVALUATOR_ITERATIONS (3). */
  evaluatorIteration: number;
  /** Operator's draft that triggered the clarify verdict. */
  originalDraft: string;
  /** The clarifying question the evaluator wants the operator to answer. */
  clarification: string;
  /** Why the evaluator decided to ask instead of forwarding/rewriting. */
  reasoning: string;
}

/**
 * #3188 — server-side cap on the auto-evaluator clarify loop (mirrors the
 * default `maxIterations` in #3186). Used to render `Iteration N/MAX`.
 */
export const MAX_EVALUATOR_ITERATIONS = 3;

// #3068: payload returned by the prompt evaluator. One of `verdict` or `error`
// is populated per response — clients should check `error` first.
export interface EvaluatorResultPayload {
  verdict?: 'forward' | 'rewrite' | 'clarify';
  rewritten?: string | null;
  clarification?: string | null;
  reasoning?: string;
  // #3100: optional numeric upstream HTTP status (401/403/429/5xx) so the UI
  // can pick a recovery hint without parsing the message string. Omitted for
  // non-API errors (NO_API_KEY, BAD_RESPONSE) and network failures.
  error?: { code: string; message: string; status?: number };
}

/**
 * #5665 — machine-wide monthly programmatic-credit budget meter snapshot.
 * Mirrors the server's `monthly_budget` wire payload (minus the one-shot
 * justWarned/justExceeded crossing flags). `budgetUsd`/`percent` are null when
 * no cap is configured (chroxy can't detect the plan tier).
 */
export interface MonthlyBudgetState {
  month: string; // "YYYY-MM" (UTC)
  spentUsd: number;
  turnsBilled: number;
  budgetUsd: number | null;
  warningPercent: number;
  percent: number | null;
  warning: boolean;
  exceeded: boolean;
}

export interface SessionNotification {
  id: string;
  sessionId: string;
  sessionName: string;
  eventType: 'permission' | 'question' | 'completed' | 'error';
  message: string;
  timestamp: number;
  requestId?: string;
  /**
   * #4890 — Slack-style read/unread tracking. Set to `Date.now()` when the
   * operator has acknowledged the alert via an explicit action: clicking a
   * row in the notifications widget (which both marks read and switches
   * sessions), the per-row "mark as read" affordance, "Mark all read", or
   * by switching to the alert's session via any session-switch path.
   * Absent means unread; presence means the alert no longer counts toward
   * the widget's unread badge count. Note: simply opening the widget panel
   * does NOT mark notifications as read on its own.
   *
   * Tracked in memory only — `sessionNotifications` itself is transient and
   * resets on reload/reconnect, so persisting `readAt` would outlive the
   * matching alert. Cross-device read sync is out of scope for v1 and would
   * need a server-side persistence model (see PR #4890 follow-ups).
   */
  readAt?: number;
}

/**
 * #4982 — state for the SessionNotFoundChip banner.
 *
 * Set by message-handler when the server emits
 * `session_error{code:'SESSION_NOT_FOUND', attemptedSessionId, message}`,
 * surfaced as a calm banner over the empty pane (the operator's old
 * activeSessionId is also cleared so chat sends don't loop the same error).
 * The banner offers a Dismiss action that clears this field; clicking a
 * different session in the sidebar also clears it (operator picked a new
 * live id, lost-id surface is no longer relevant).
 */
export interface SessionNotFoundErrorState {
  /** The id chroxy passed before the server rejected it. May be null. */
  attemptedSessionId: string | null;
  /** Server-provided message text (verbatim). */
  message: string;
}

export interface FilePickerItem {
  path: string;
  type: 'file';
  size: number | null;
}

/**
 * #6823 — an MCP-server resource surfaced in the `@`-picker for BYOK sessions.
 * `server` routes a later read back to the owning MCP server; `uri` is that
 * server's own identifier for the resource.
 */
export interface MCPResourceItem {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  server: string;
}

/** A registered remote Chroxy server */
export interface ServerEntry {
  /** Unique ID for this server (stable across renames) */
  id: string;
  /** User-defined display name */
  name: string;
  /** WebSocket URL (e.g. wss://my-server.example.com/ws) */
  wsUrl: string;
  /** Auth token for this server */
  token: string;
  /** Timestamp of last successful connection */
  lastConnectedAt: number | null;
  /**
   * #5536 — the daemon's pinned E2E identity public key (base64 Ed25519),
   * captured from the trusted pairing URL (`idk=`) and pinned on first connect.
   * Every later handshake verifies the server's signed exchange key against it;
   * a mismatch refuses the connection. Absent for entries paired before this
   * change / daemons with no identity — those stay TOFU and pin on first use.
   */
  pinnedIdentityKey?: string;
}

// #3209: per-session skill metadata. Loaded via list_skills, mutated
// in-place by skill_activated / skill_deactivated broadcasts. The
// dashboard uses this to render manual-skill toggles.
//
// #3205: extended with audit metadata (`version` from frontmatter,
// `hashPrefix` + `firstSeen` + `lastVerified` from the trust store).
// All optional so the SkillsPanel can render even when the active
// session has no trust store wired or the skill predates these fields.
export interface SessionSkillInfo {
  name: string;
  description?: string;
  source?: 'global' | 'repo';
  activation?: 'auto' | 'manual';
  active?: boolean;
  version?: string;
  // 8-char prefix of the SHA-256 — matches the on-wire format from
  // `skill_changed` so a mismatch indicator can compare prefixes
  // without the full SHA leaving the server.
  hashPrefix?: string;
  // ISO-8601 timestamps from the SkillsTrustStore.
  firstSeen?: string;
  lastVerified?: string;
  // #3298: community-skill first-activation trust state. Set by the
  // server loader when the skill lives under community/<author>/. Only
  // present on community skills; absent for global/repo skills.
  trustState?: 'pending' | 'trusted';
  communityAuthor?: string;
}

// #3298: one pending community skill awaiting first-activation trust
// grant. Populated by skill_trust_request, cleared by skill_trust_granted.
// #3310: extended with optional description and path so the SkillsPanel
// can surface them in the "Pending review" row — the data is already on
// the wire (ServerSkillTrustRequestSchema), the handler just wasn't
// capturing it. Optional so existing serialised state (pre-#3310
// reconnects) and tests that only set {name, author} remain valid.
export interface PendingCommunitySkill {
  name: string;
  author: string;
  /** Skill description text from the skill frontmatter (may be empty). */
  description?: string;
  /** Absolute path on disk where the skill file lives. */
  path?: string;
}

// #3588: one in-flight `skill_trust_grant` request. Tracked per session
// so the SkillsPanel "Pending review" row can show an in-flight state
// (disabled button + spinner) and operators get feedback that their
// click was processed even when the server returns an error
// (INVALID_AUTHOR / TRUST_NOT_ENABLED / TRUST_FLUSH_FAILED) instead of
// the success broadcast. The entry is added when grantCommunitySkillTrust
// fires the WS message and removed on EITHER skill_trust_grant_ok (success)
// OR an `error` envelope whose requestId matches.
export interface PendingTrustGrant {
  /** WS requestId — used to correlate the ack/error envelope. */
  requestId: string;
  /** Community skill name being granted trust for. */
  skillName: string;
  /** Community author whose trust is being granted. */
  author: string;
}

export interface SessionState extends BaseSessionState {
  terminalRawBuffer: string;
  // #5835 Phase 2: the authoritative live-PTY grid size the server last reported
  // for this session (terminal_size). The mirror renders at exactly this size,
  // letterboxed. Undefined until the server reports it; the view falls back to
  // the shared default (CLAUDE_TUI_PTY_SIZE) meanwhile.
  terminalSize?: { cols: number; rows: number };
  // Files tab: selected file path (persists across tab switches)
  selectedFilePath: string | null;
  thinkingLevel: ThinkingLevel;
  // Per-session auto-approval rules (mirrors server-side sessionRules, updated
  // via permission_rules_updated). Used by the "Allow for Session" flow to
  // append new rules without losing existing ones. Optional: undefined until
  // the server confirms rules for this session.
  sessionRules?: PermissionRule[];
  // #6771: durable per-project rules ("always allow / deny"), each tagged
  // `persist:'project'`. Written by permission_rules_updated (persistentRules
  // field). Distinct from sessionRules so standing project grants aren't
  // conflated with the session-scoped set. Optional until the server reports.
  persistentRules?: PermissionRule[];
  // #3209: cached skills list for the active session. Populated by
  // list_skills response, mutated in-place by skill_activated /
  // skill_deactivated broadcasts. Optional — undefined until the
  // first list_skills is requested.
  skills?: SessionSkillInfo[];
  // #3205: skill names whose hash mismatched the trust store's
  // recorded value during this session (delivered via the
  // `skill_changed` WS event). The dashboard renders a red-flag
  // indicator next to mismatched skills in the SkillsPanel so the
  // operator can audit before activating. Resets on session
  // destruction; not persisted across reconnects (the next
  // skills load re-checks hashes, so the loader will re-emit any
  // mismatches that still apply).
  mismatchedSkillNames?: string[];
  // #3298: community skills pending first-activation trust grant
  // (skill_trust_request events). Cleared when the operator grants
  // trust (skill_trust_granted) or on session destruction. Not
  // persisted across reconnects — the server re-emits trust_request
  // events each time skills are loaded.
  pendingCommunitySkills?: PendingCommunitySkill[];
  // #3588: in-flight skill_trust_grant requests. Added by
  // grantCommunitySkillTrust when it fires the WS message; removed by
  // skill_trust_grant_ok (success ack) or the matching `error` envelope
  // (INVALID_AUTHOR / TRUST_NOT_ENABLED / TRUST_FLUSH_FAILED). Drives
  // the SkillsPanel "Pending review" row's in-flight state (disabled
  // Trust button + spinner) so operators get feedback even on the
  // error path. Not persisted across reconnects — the WS request would
  // be stale anyway, and the disconnect handler clears the field.
  pendingTrustGrants?: PendingTrustGrant[];
  // #3188: pending clarify question from the auto-evaluator (#3186).
  // Set when an `evaluator_clarify` event arrives for this session and
  // cleared on the next user_input echo or follow-up `evaluator_rewrite`.
  // Transient — NOT persisted across reconnects: the server re-emits
  // the event on the next user_input cycle, so dropping the pending
  // state on reconnect is acceptable for v1.
  // #3646: always-present, defaulted to `null` by `createEmptySessionState`.
  // The handler clears with `null`, never `undefined`. Tests / call
  // sites should use `toBeNull()` consistently instead of branching on
  // `toBeUndefined()` for the initial state.
  pendingEvaluatorClarify: PendingEvaluatorClarify | null;
}

/**
 * #5500 — outcome of the last repo-memory Reindex action for one repo, kept
 * for inline display in its Integrations row. Exactly one of `counts` /
 * `error` is meaningful: a successful ack records `counts` (which is itself
 * null when the server couldn't parse the CLI report) with `error: null`; an
 * INTEGRATION_ACTION_FAILED session_error records the message with
 * `counts: null`. `at` is the local receipt time (epoch ms).
 */
export interface ReindexResult {
  counts: IntegrationActionCounts | null;
  error: string | null;
  at: number;
}

/**
 * #5502 — outcome of the last repo-relay Re-run action for one repo, kept
 * for inline display in its Integrations row. A successful ack records
 * `error: null` (the row shows "re-run requested" and invites a refresh —
 * the new run appears as in_progress on the next survey); an
 * INTEGRATION_ACTION_FAILED session_error records the message. `at` is the
 * local receipt time (epoch ms).
 */
export interface RelayRerunResult {
  error: string | null;
  at: number;
}

/**
 * #6134 (epic #5530) — outcome of the last container lifecycle action
 * (stop / restart / destroy) for one environment, kept for inline display in
 * its Containers row. A successful `containers_action_ack` records the echoed
 * `action` + resulting `status` with `error: null`; a CONTAINER_ACTION_FAILED
 * session_error records the message with `status: null`. `at` is the local
 * receipt time (epoch ms).
 */
export interface ContainerActionResult {
  action: string;
  status: string | null;
  error: string | null;
  at: number;
}

/**
 * #6135 slice 3 (epic #5530) — outcome of the last BYOK pool mutating action
 * (drain / recycle / resize) for one action target, kept for inline display.
 * The target id is `'drain'`, `'recycle:<bucket key>'`, or `'resize'` (the pool
 * is a single process-wide singleton — drain/resize are pool-wide, recycle is
 * per-resource-shape bucket). A successful `byok_pool_action_ack` records the
 * echoed `action` + a human `note` (drained/evicted counts) with `error: null`;
 * a BYOK_POOL_ACTION_FAILED session_error records the message with `note: null`.
 * `at` is the local receipt time (epoch ms).
 */
export interface ByokPoolActionResult {
  action: string;
  note: string | null;
  error: string | null;
  at: number;
}

/**
 * #6140 slice 2 (epic #5530) — outcome of the last host prune action (kind
 * containers/images/all), kept for inline display. The target id is the `kind`.
 * A successful `host_prune_action_ack` records a human `note` (removed counts +
 * reclaimed bytes, and any per-resource failures) with `error: null`; a
 * HOST_PRUNE_ACTION_FAILED session_error records the message with `note: null`.
 * `at` is the local receipt time (epoch ms).
 */
export interface HostPruneActionResult {
  kind: string;
  note: string | null;
  error: string | null;
  at: number;
}

/**
 * #6136 slice 3 (epic #5530) — outcome of the last simulator action (boot /
 * shutdown), kept for inline display. The target id is the device `udid`. A
 * successful `simulator_action_ack` records a human `note` (the new state) with
 * `error: null`; a SIMULATOR_ACTION_FAILED session_error records the message
 * with `note: null`. `at` is the local receipt time (epoch ms).
 */
export interface SimulatorActionResult {
  action: string;
  note: string | null;
  error: string | null;
  at: number;
}

/**
 * #6137 (epic #5530) — outcome of the last Android emulator action (boot /
 * kill), kept for inline display. The target id is the avd (boot) or serial
 * (kill). A successful `emulator_action_ack` records a human `note` with
 * `error: null`; an EMULATOR_ACTION_FAILED session_error records the message
 * with `note: null`. `at` is the local receipt time (epoch ms).
 */
export interface EmulatorActionResult {
  action: string;
  note: string | null;
  error: string | null;
  at: number;
}

/**
 * #6138 (epic #5530) — outcome of the last WSL2 distro action (start /
 * terminate), kept for inline display. The target id is the distro `name`. A
 * successful `wsl_action_ack` records an action-oriented human `note`
 * ("Started" / "Terminated", with the echoed status appended only when it's
 * unexpected) and `error: null`; a WSL_ACTION_FAILED session_error records the
 * message with `note: null`. `at` is the local receipt time (epoch ms).
 */
export interface WslActionResult {
  action: string;
  note: string | null;
  error: string | null;
  at: number;
}

export interface ConnectionState {
  // Connection
  connectionPhase: ConnectionPhase;
  wsUrl: string | null;
  apiToken: string | null;
  socket: WebSocket | null;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;

  // Multi-server registry
  serverRegistry: ServerEntry[];
  activeServerId: string | null;
  /** A same-origin local daemon connection is available ("this machine"). */
  hasLocalServer: boolean;

  // User explicitly disconnected — prevents auto-reconnect on ConnectScreen mount
  userDisconnected: boolean;

  // Server mode: 'cli' (headless). The wire protocol only emits 'cli' (#4810);
  // `null` covers pre-`auth_ok` state and any non-`'cli'` value the parser
  // couldn't validate (degrades to the "Invalid Server Mode" alert path).
  serverMode: 'cli' | null;

  // Server context (from auth_ok)
  sessionCwd: string | null;
  defaultCwd: string | null;
  serverVersion: string | null;
  latestVersion: string | null;
  serverCommit: string | null;
  serverProtocolVersion: number | null;
  /**
   * #3760 — effective server inactivity timeout in ms, as advertised in
   * auth_ok. Used by ActivityIndicator to render the "approaching timeout"
   * warning against the real configured value instead of a hardcoded 20-min
   * reference. Null when connecting to an older server that doesn't broadcast
   * the field (the indicator falls back to its built-in default).
   */
  serverResultTimeoutMs: number | null;
  /**
   * #4497 — effective server stream-stall (no-stream-data) inactivity
   * window in ms, as advertised on auth_ok (server PR #4483 / #4477).
   * Threaded to `StreamStallChip` so the headline can humanise to
   * "No response for 5 minutes — retry?" instead of a static phrase.
   * Null when the server omits the field (older servers, or explicit 0
   * "disabled" sentinel — the chip then falls back to the static copy).
   */
  streamStallTimeoutMs: number | null;

  // Multi-session state
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>;

  /**
   * #5163 (epic #5159) — Control Room activity state: the per-session live
   * tree of in-flight subagents / background shells / long-running tools,
   * fed by `activity_snapshot` + `activity_delta` through the store-core
   * reducer. The Control Room sidebar panel renders the active session's
   * tree via `selectActivityTree(activity, activeSessionId)`. Read-only in
   * v1 — control actions are a tracked phase-2 follow-up on the epic.
   */
  activity: import('@chroxy/store-core').ActivityState;
  /**
   * #5277: activity ids with an in-flight cancel_activity request — set when
   * sendCancelActivity is called, cleared on the cancel_activity_ack (success)
   * or the CANCEL_ACTIVITY_FAILED session_error (failure). Lets the
   * ActivityTree show a "Cancelling…" pending state instead of guessing from
   * the terminal activity_delta.
   */
  cancellingActivityIds: Set<string>;

  /**
   * #5175 (epic #5170) — Host/Repo Status Control Room: the latest
   * `host_status_snapshot` the server sent in reply to a `host_status_request`.
   * `null` until the first snapshot lands (the Control Room section renders an
   * empty/loading state). Replaced wholesale on each snapshot — the survey is a
   * full picture, not a delta stream.
   */
  /**
   * #5510 (epic #5509) — pairing-approval primitive: outstanding pending
   * pair requests fanned out to this host-level surface via `pair_pending`.
   * Each entry carries the requesting device's name, the 6-digit verify code to
   * compare against the new device's screen, and its expiry. Entries are added
   * on `pair_pending`, removed on `pair_resolved` (approved/denied/expired
   * elsewhere) or after the local Approve/Deny action. `deviceName` is
   * attacker-controlled and rendered as plain text (React escapes).
   */
  pendingPairRequests: ServerPairPendingMessage[];

  /**
   * #5513 (epic #5509) — a `?pair=` link the dashboard tried to redeem turned
   * out to be approval-gated (a Discord-delivered link): the server replied
   * `pair_fail { reason: 'requires_approval' }`. Possession of the link is never
   * sufficient — the device must REQUEST pairing and the host must approve it.
   * The pair_fail handler records the failed host here so the UI can
   * transparently open the request-pair flow (RequestPairPanel) for that host
   * instead of just surfacing a dead-end alert. Cleared once the panel opens
   * (clearPendingApprovalPairHost) or the request resolves.
   */
  pendingApprovalPairHost: { name: string; wsUrl: string } | null;

  hostStatus: ServerHostStatusSnapshotMessage | null;
  /**
   * #5175 — true between dispatching a `host_status_request` and the matching
   * `host_status_snapshot` arriving, so the Refresh button can show a spinner /
   * disabled state. Cleared when a snapshot lands.
   */
  hostStatusLoading: boolean;

  /**
   * #6471 (epic #6469) — opt-in IDE workspace symbol table from the last
   * `symbols_snapshot`. Null until the first `list_symbols` reply lands; the
   * symbol panel (#6472) renders `symbols.symbols`. Only populated when the
   * server advertises the `ide` capability (features.ide).
   */
  symbols: ServerSymbolsSnapshotMessage | null;
  /**
   * #6471 — true between dispatching a `list_symbols` request and the matching
   * `symbols_snapshot` arriving, so the symbol panel can show a loading state.
   * Cleared when a snapshot lands.
   */
  symbolsLoading: boolean;

  // Mailbox (#5914 follow-up) — Control Room "Mailbox" tab snapshot (live
  // agentCommId→session registrations + recent live-interrupt deliveries). Null
  // until the first survey lands.
  mailboxStatus: ServerMailboxStatusSnapshotMessage | null;
  /** True between a `mailbox_status_request` and its `mailbox_status_snapshot`. */
  mailboxStatusLoading: boolean;

  /**
   * #5553 — per-repo session presets, keyed by cwd. `undefined` = not yet
   * fetched; `null` = fetched, no preset for that repo; a value = the resolved
   * preset (full preamble + seed text for the drawer). Populated by
   * `session_preset_snapshot` replies (the per-repo drawer + the create-session
   * modal disclosure both read from here).
   */
  sessionPresetSnapshots: Record<string, ServerSessionPresetFull | null>;

  /**
   * #5553 — server-provided composer SEEDs keyed by sessionId. A create-confirm
   * (`session_switched`) carrying an active repo preset's seed stashes it here;
   * App's create-confirm effect drains it into the new session's composer
   * EDITABLE (never auto-sent), then removes the entry.
   */
  pendingServerSeed: Record<string, string>;

  /**
   * #5253 — Control Room self-hosted runner survey: the latest
   * `runner_status_snapshot` from the server. `null` until the first snapshot
   * lands (the runner section renders an empty/loading state). Replaced
   * wholesale on each snapshot (full picture, no delta stream).
   */
  runnerStatus: ServerRunnerStatusSnapshotMessage | null;
  /**
   * #5253 — true between dispatching a `runner_status_request` and the matching
   * `runner_status_snapshot` arriving, so the runner-tab Refresh button can
   * spin. Cleared when a snapshot lands.
   */
  runnerStatusLoading: boolean;

  /**
   * #6133 (epic #5530) — Control Room containers & environments survey: the
   * latest `containers_status_snapshot` from the server. `null` until the first
   * snapshot lands (the Containers section renders an empty/loading state).
   * Replaced wholesale on each snapshot (full picture, no delta stream).
   */
  containersStatus: ServerContainersStatusSnapshotMessage | null;
  /**
   * #6133 — true between dispatching a `containers_status_request` and the
   * matching `containers_status_snapshot` arriving, so the Containers-tab
   * Refresh button can spin. Cleared when a VALID snapshot lands (a malformed
   * payload is dropped and leaves this true, matching the sibling surveys).
   */
  containersStatusLoading: boolean;

  /**
   * #6139 (epic #5530) — Control Room per-repo runtime config survey: the
   * latest `repo_runtime_config_snapshot`, or null before the first one lands
   * (the Repo Runtime Config section renders an empty/loading state). Replaced
   * wholesale on each snapshot (full picture, no delta stream).
   */
  repoRuntimeConfig: ServerRepoRuntimeConfigSnapshotMessage | null;
  /**
   * #6139 — true between dispatching a `repo_runtime_config_request` and the
   * matching `repo_runtime_config_snapshot` arriving, so the tab's Refresh
   * button can spin. Cleared when a VALID snapshot lands (a malformed payload
   * is dropped and leaves this true, matching the sibling surveys).
   */
  repoRuntimeConfigLoading: boolean;

  /**
   * #6135 (epic #5530) — Control Room BYOK pool survey: the latest
   * `byok_pool_status_snapshot` (enabled flag, configured limits, live stats +
   * per-shape warm buckets), or null before the first one lands (the BYOK Pool
   * section renders an empty/loading state). Replaced wholesale on each snapshot
   * (full picture, no delta stream).
   */
  byokPoolStatus: ServerByokPoolStatusSnapshotMessage | null;
  /**
   * #6140 (epic #5530) — Control Room host prune survey: the latest
   * `host_prune_status_snapshot` (reclaimable chroxy-scoped orphan docker
   * pressure), or null before the first one lands. Replaced wholesale on each
   * snapshot (full picture, no delta stream).
   */
  hostPruneStatus: ServerHostPruneStatusSnapshotMessage | null;
  /**
   * #6140 — true between dispatching a `host_prune_status_request` and the
   * matching snapshot arriving, so the tab's Refresh button can spin. Cleared
   * when a VALID snapshot lands (a malformed payload is dropped and leaves this
   * true, matching the sibling surveys).
   */
  hostPruneStatusLoading: boolean;
  /**
   * #6135 — true between dispatching a `byok_pool_status_request` and the
   * matching `byok_pool_status_snapshot` arriving, so the tab's Refresh button
   * can spin. Cleared when a VALID snapshot lands (a malformed payload is
   * dropped and leaves this true, matching the sibling surveys).
   */
  byokPoolStatusLoading: boolean;

  /**
   * #5499 (epic #5498) — Control Room Integrations survey: the latest
   * `integration_status_snapshot` from the server (per-repo repo-memory
   * status). `null` until the first snapshot lands (the Integrations section
   * renders an empty/loading state). Replaced wholesale on each snapshot
   * (full picture, no delta stream).
   */
  integrationStatus: ServerIntegrationStatusSnapshotMessage | null;
  /**
   * #5499 — true between dispatching an `integration_status_request` and the
   * matching `integration_status_snapshot` arriving, so the Integrations-tab
   * Refresh button can spin. Cleared when a snapshot lands.
   */
  integrationStatusLoading: boolean;
  /**
   * #5554 — latest Control Room Skills inventory survey snapshot (global tier +
   * per-repo overlays, with descriptions / trust / hashes / usage). `null`
   * until the first snapshot lands (the Skills section renders an empty/loading
   * state). Replaced wholesale on each snapshot (no delta stream).
   */
  skillsInventory: ServerSkillsInventorySnapshotMessage | null;
  /**
   * #5554 — true between dispatching a `skills_inventory_request` and the
   * matching `skills_inventory_snapshot` arriving, so the Skills-tab Refresh
   * button can spin. Cleared when a snapshot lands.
   */
  skillsInventoryLoading: boolean;
  /**
   * #5500 — repo paths with an in-flight `integration_action` reindex request:
   * set when sendRepoMemoryReindex is called, cleared on the
   * `integration_action_ack` (success) or the INTEGRATION_ACTION_FAILED
   * session_error (failure). Keyed by the repoPath the dashboard sent (the
   * server echoes it verbatim), same pattern as `cancellingActivityIds`.
   */
  reindexingRepoPaths: Set<string>;
  /**
   * #5500 — last reindex outcome per repo path, for inline display in the
   * Integrations row: the ack's scanned/summarized/fresh/skipped counts
   * (null when the server couldn't parse the CLI output), or the
   * INTEGRATION_ACTION_FAILED message as `error`. Replaced when the repo is
   * reindexed again.
   */
  reindexResults: Record<string, ReindexResult>;
  /**
   * #6543 (IDE P3 feature B) — the pulled full (secret-redacted) tool input for
   * a pending permission, keyed by requestId, fed by the `permission_input`
   * handler in reply to `requestPermissionInput`. Used to build the per-hunk
   * pre-write diff on the permission prompt. `found:false` entries are stored so
   * the UI can distinguish "not fetched yet" from "unavailable".
   */
  permissionInputs: Record<string, ServerPermissionInputMessage>;
  /**
   * #5502 — repo paths with an in-flight `integration_action` relay re-run:
   * set when sendRepoRelayRerun is called, cleared on the
   * `integration_action_ack` / INTEGRATION_ACTION_FAILED session_error. A
   * separate bucket from `reindexingRepoPaths` so a rerun outcome can never
   * clear (or be cleared by) a reindex on the same repo.
   */
  relayRerunningRepoPaths: Set<string>;
  /**
   * #5502 — last relay re-run outcome per repo path, for inline display in
   * the Integrations row. Replaced when the repo is re-run again.
   */
  relayRerunResults: Record<string, RelayRerunResult>;
  /**
   * #6134 (epic #5530) — environment ids with an in-flight `containers_action`
   * (stop / restart / destroy): set when sendContainersAction is called,
   * cleared on the `containers_action_ack` / CONTAINER_ACTION_FAILED
   * session_error. Keyed by environmentId so each row's buttons disable
   * independently while their action is on the wire.
   */
  containerActioningIds: Set<string>;
  /**
   * #6134 — last container lifecycle action outcome per environment id, for
   * inline display in the Containers row. Replaced when the row is actioned
   * again.
   */
  containerActionResults: Record<string, ContainerActionResult>;
  /**
   * #6135 slice 3 (epic #5530) — action target ids with an in-flight
   * `byok_pool_action`: set when sendByokPoolAction is called, cleared on the
   * `byok_pool_action_ack` / BYOK_POOL_ACTION_FAILED session_error. Keyed by the
   * action target (`'drain'`, `'recycle:<bucket key>'`, `'resize'`) so each
   * control disables independently while its action is on the wire.
   */
  byokPoolActioningIds: Set<string>;
  /**
   * #6135 slice 3 — last BYOK pool action outcome per target id, for inline
   * display. Replaced when the same target is actioned again.
   */
  byokPoolActionResults: Record<string, ByokPoolActionResult>;
  /**
   * #6140 slice 2 (epic #5530) — host prune action kinds with an in-flight
   * `host_prune_action` (keyed by `kind`): set when sendHostPruneAction is
   * called, cleared on the `host_prune_action_ack` / HOST_PRUNE_ACTION_FAILED
   * session_error.
   */
  hostPruneActioningIds: Set<string>;
  /** #6140 slice 2 — last host prune outcome per kind, for inline display. */
  hostPruneActionResults: Record<string, HostPruneActionResult>;
  /**
   * #6136 (epic #5530) — Control Room iOS simulator survey: the latest
   * `simulator_status_snapshot` (devices + "Ready for Maestro" verdict), or null
   * before the first one lands. Replaced wholesale on each snapshot (full
   * picture, no delta stream). `available:false` off macOS is a valid state.
   */
  simulatorStatus: ServerSimulatorStatusSnapshotMessage | null;
  /**
   * #6136 — true between dispatching a `simulator_status_request` and the
   * matching snapshot arriving, so the tab's Refresh button can spin. Cleared
   * when a VALID snapshot lands (a malformed payload is dropped and leaves this
   * true, matching the sibling surveys).
   */
  simulatorStatusLoading: boolean;
  /**
   * #6136 slice 3 (epic #5530) — device udids with an in-flight
   * `simulator_action` (boot / shutdown): set when sendSimulatorAction is
   * called, cleared on the `simulator_action_ack` / SIMULATOR_ACTION_FAILED
   * session_error. Keyed by udid so each device row's buttons disable
   * independently while their action is on the wire.
   */
  simulatorActioningIds: Set<string>;
  /**
   * #6136 slice 3 — last simulator action outcome per udid, for inline display
   * in the device row. Replaced when the same device is actioned again.
   */
  simulatorActionResults: Record<string, SimulatorActionResult>;
  /**
   * #6137 (epic #5530) — Control Room Android emulator survey: the latest
   * `emulator_status_snapshot` (devices + "Ready for Maestro" verdict), or null
   * before the first one lands. `available:false` (no Android SDK) is a valid
   * state. Replaced wholesale on each snapshot.
   */
  emulatorStatus: ServerEmulatorStatusSnapshotMessage | null;
  /**
   * #6137 — true between dispatching an `emulator_status_request` and the
   * matching snapshot arriving (Refresh spinner). Cleared when a VALID snapshot
   * lands (a malformed payload is dropped and leaves this true).
   */
  emulatorStatusLoading: boolean;
  /**
   * #6137 — emulator action targets (avd for boot / serial for kill) with an
   * in-flight `emulator_action`: set when sendEmulatorAction is called, cleared
   * on the `emulator_action_ack` / EMULATOR_ACTION_FAILED session_error. Keyed
   * by target so each device row's buttons disable independently.
   */
  emulatorActioningIds: Set<string>;
  /**
   * #6137 — last emulator action outcome per target id, for inline display.
   * Replaced when the same target is actioned again.
   */
  emulatorActionResults: Record<string, EmulatorActionResult>;
  /**
   * #6138 (epic #5530) — Control Room WSL2 distro survey: the latest
   * `wsl_status_snapshot` (distros + default), or null before the first one
   * lands. `available:false` (off Windows / no wsl.exe) is a valid state.
   * Replaced wholesale on each snapshot.
   */
  wslStatus: ServerWslStatusSnapshotMessage | null;
  /**
   * #5969 (epic #5422 phase 4) — Control Room mission control: the latest
   * `external_sessions_snapshot` (live external sessions ingested via
   * /api/events, read-only), or null before the first one lands. Replaced
   * wholesale on each snapshot.
   */
  externalSessionsSnapshot: ServerExternalSessionsSnapshotMessage | null;
  /** #5969 — true between dispatching an `external_sessions_request` and its snapshot. */
  externalSessionsLoading: boolean;
  /**
   * #5966 (epic #5422 phase 5) — Control Room repo-events pane: the latest
   * `repo_events_snapshot` (GitHub-webhook activity buffered by the daemon,
   * read-only), or null before the first one lands. Replaced wholesale on each
   * snapshot.
   */
  repoEventsSnapshot: ServerRepoEventsSnapshotMessage | null;
  /** #5966 — true between dispatching a `repo_events_request` and its snapshot. */
  repoEventsLoading: boolean;
  /**
   * #6540 (item 3 of #6536) — Control Room repo-events webhook-secret config: the
   * latest `github_webhook_config` (is a secret set + source, the payload URL,
   * recent delivery status — never the secret value), or null before the first
   * one lands. Replaced wholesale on each config message.
   */
  githubWebhookConfig: ServerGithubWebhookConfigMessage | null;
  /** #6540 — true between dispatching a webhook-config request/write and its reply. */
  githubWebhookConfigLoading: boolean;
  /**
   * #6691 (S-3) — the orchestration runs-list snapshot (wire shape, replaced
   * wholesale per survey; delta.run upserts rows between surveys), or null
   * before the first one lands.
   */
  orchestrationRuns: ServerOrchestrationRunsSnapshot | null;
  /** #6691 — true between dispatching `orchestration_runs_request` and its snapshot. */
  orchestrationRunsLoading: boolean;
  /**
   * #6691 — per-run held detail (store-core HeldRunDetail: the RunDetail plus
   * the wire-seq high-water mark it was last consistent at). Deltas apply via
   * the store-core reducer under the strict seq===held+1 contract.
   */
  orchestrationRunDetails: Record<string, HeldRunDetail>;
  /** #6691 — runIds with an in-flight `orchestration_run_detail_request`. */
  orchestrationRunDetailLoading: Set<string>;
  /** #6691 — degraded `run: null` replies, keyed by runId. */
  orchestrationRunDetailErrors: Record<string, { code: string; message: string }>;
  /** #6691 — runIds whose held detail hit a delta seq gap (resync pending). */
  orchestrationRunDetailStale: Record<string, boolean>;
  /**
   * #6691 — outstanding mutating actions keyed by requestId; cleared by the
   * matching `orchestration_action_ack` or `session_error{ORCHESTRATION_ACTION_FAILED}`.
   */
  orchestrationPendingActions: Record<string, { kind: string; runId: string; gateId?: string; at: number }>;
  /** #6691 — terminal results for recent orchestration actions, keyed by requestId. */
  orchestrationActionResults: Record<string, { ok: boolean; error: string | null; at: number }>;
  /** #6691 — the run selected in the Runs tab (detail panel target). */
  selectedRunId: string | null;
  /**
   * #6138 — true between dispatching a `wsl_status_request` and the matching
   * snapshot arriving (Refresh spinner). Cleared when a VALID snapshot lands (a
   * malformed payload is dropped and leaves this true).
   */
  wslStatusLoading: boolean;
  /**
   * #6138 — WSL distro names with an in-flight `wsl_action`: set when
   * sendWslAction is called, cleared on the `wsl_action_ack` /
   * WSL_ACTION_FAILED session_error. Keyed by distro so each row's buttons
   * disable independently.
   */
  wslActioningIds: Set<string>;
  /**
   * #6138 — last WSL action outcome per distro name, for inline display.
   * Replaced when the same distro is actioned again.
   */
  wslActionResults: Record<string, WslActionResult>;

  // Legacy flat state (used when server doesn't send session_list, i.e. PTY mode)
  claudeReady: boolean;
  streamingMessageId: string | null;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  // #6769: occupancy snapshot mirror for the active session (meter input).
  contextOccupancy: ContextOccupancy | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  isIdle: boolean;
  messages: ChatMessage[];

  // Available providers from server
  availableProviders: ProviderInfo[];

  // Available models from server (CLI mode)
  availableModels: ModelInfo[];
  // Provider that sourced the current availableModels list.
  availableModelsProvider: string | null;
  // Server-reported default model short id (from SDK)
  defaultModelId: string | null;

  // Available permission modes from server (CLI mode).
  // #4019: PermissionMode is the typed shape from store-core; the optional
  // `description` field flows through to the chat dropdown + creation modal
  // so the two surfaces share one source of truth.
  availablePermissionModes: PermissionMode[];

  // Previous permission mode (for Shift+Tab plan mode toggle)
  previousPermissionMode: string | null;

  // Connected clients (multi-client awareness)
  myClientId: string | null;
  connectedClients: ConnectedClient[];
  primaryClientId: string | null;

  // Follow mode: auto-switch sessions when another client switches
  followMode: boolean;

  // Connection quality (measured via ping/pong RTT)
  latencyMs: number | null;
  connectionQuality: 'good' | 'fair' | 'poor' | null;

  // Connection error feedback
  connectionError: string | null;
  connectionRetryCount: number;

  // Server startup logs (fetched via Tauri IPC on startup failure)
  serverStartupLogs: string[] | null;

  // Server log entries (ring buffer, last 500)
  logEntries: LogEntry[];

  // Server errors forwarded over WebSocket (last 10)
  serverErrors: ServerError[];

  // Info-level notifications (update available, etc.) — last 10
  infoNotifications: ServerError[];

  // Background session notifications (permission, question, completed, error)
  sessionNotifications: SessionNotification[];

  // #5665 — machine-wide monthly programmatic-credit budget meter snapshot,
  // set from the server's `monthly_budget` event (sent on connect and after
  // each programmatic-credit-billed turn). null until the first one arrives or
  // when the server predates the feature.
  monthlyBudget: MonthlyBudgetState | null;

  // #4982 — set when the server emits `session_error{code:'SESSION_NOT_FOUND'}`.
  // Activated by message-handler.ts:case 'session_error' on the
  // SESSION_NOT_FOUND branch; cleared by the SessionNotFoundChip dismiss
  // action OR by a subsequent successful switchSession (the operator picked
  // a new live session, so the lost-id chip is no longer relevant).
  //
  // Co-occurs with `activeSessionId === null` — clearing the stale id is
  // what stops the dashboard from re-sending against the dead id and
  // looping the same toast (#4935 wedge UX).
  sessionNotFoundError: SessionNotFoundErrorState | null;

  // Resolved permission decisions keyed by requestId. Persists the
  // user's Allow/Deny/AllowSession choice across component remounts
  // (tab switches), fixing #2833 where the prompt re-rendered as
  // unanswered after the session/output tabs were toggled.
  resolvedPermissions: Record<string, PermissionDecision>;

  // Claude Code Web (cloud task delegation)
  webFeatures: WebFeatureStatus;
  webTasks: WebTask[];

  // #3272: server-advertised capability map keyed by feature name. Lets
  // the dashboard gate UI affordances on the server actually supporting
  // the matching WS message — e.g. `skillTrustAccept` (#3270 Accept
  // button) requires the #3269 handler. Older servers don't emit the
  // field, so missing keys are treated as `false` (fail-closed).
  serverCapabilities: Record<string, boolean>;

  // Server startup phase (from server_status events)
  // #2836: 'tunnel_warming' is the current name for the DNS-propagation
  // window; 'tunnel_verifying' is retained as a legacy alias that
  // message-handler normalizes to 'tunnel_warming'.
  serverPhase: 'tunnel_warming' | 'tunnel_verifying' | 'ready' | null;
  tunnelProgress: { attempt: number; maxAttempts: number } | null;

  // #5356: exposure snapshot from auth_ok (`lanBind` = server bound to a
  // non-loopback interface so LAN peers can reach its auth/pairing
  // endpoints; `quickTunnel` = a public trycloudflare quick tunnel is
  // CONFIGURED — the server records it before tunnel startup, so treat it
  // as a posture signal, not proof the tunnel is established).
  // null = server didn't report (pre-#5356 server) — no banner. quickTunnel
  // is also flipped true by a `server_status { phase: 'ready',
  // tunnelMode: 'quick' }` broadcast (which DOES mean the tunnel is live)
  // for clients that connected mid-warming.
  serverExposure: { lanBind: boolean; quickTunnel: boolean } | null;
  // #5356: user dismissed the exposure warning banner. Reset on a fresh
  // (non-reconnect) auth so a new connection re-surfaces the warning, but
  // preserved across silent reconnects to the same server.
  exposureBannerDismissed: boolean;
  dismissExposureBanner: () => void;

  // #5821: current billing-canary snapshot — seeded from auth_ok and updated by
  // `billing_canary` broadcasts. null = server didn't report (older server).
  // `warnings` empty = all clear (no banner). See the BillingWarningBanner.
  billingCanary: {
    eraStarted: boolean;
    defaultProvider: string;
    defaultBillingClass: string;
    warnings: Array<{ code: string; message: string; provider?: string; sessionId?: string; costUsd?: number }>;
  } | null;
  // #5821: user dismissed the billing banner. Reset when the warning set
  // changes (a NEW warning re-surfaces it) and on a fresh connect; preserved
  // across silent reconnects and unchanged re-broadcasts.
  billingBannerDismissed: boolean;
  dismissBillingBanner: () => void;

  // Shutdown state (reason + ETA for restarting banner countdown)
  shutdownReason: 'restart' | 'shutdown' | 'crash' | null;
  restartEtaMs: number | null;
  restartingSince: number | null;

  // Pending auto permission mode confirmation from server
  pendingPermissionConfirm: PendingPermissionConfirm | null;

  // Slash commands from server
  slashCommands: SlashCommand[];

  // File picker items from list_files
  filePickerFiles: FilePickerItem[] | null;
  // #6823 — MCP-server resources from the same list_files/file_list response,
  // surfaced in the `@`-picker for BYOK sessions. Null until the first
  // file_list arrives; empty array for non-BYOK sessions.
  mcpResources: MCPResourceItem[] | null;
  // #6473 — a Cmd+P quick-open request the FileBrowserPanel watches: open this
  // path in the viewer. The nonce lets repeated opens of the same path re-fire.
  fileBrowserPendingOpen: { path: string; line?: number; nonce: number } | null;
  // #6476 — whole-workspace symbol table for the symbol-search modal (a path===null
  // snapshot). Separate from the per-file `symbols` (#6472) so they don't clobber.
  workspaceSymbols: ServerSymbolsSnapshotMessage | null;
  workspaceSymbolsLoading: boolean;
  // #6475 — the latest go-to-definition result (a `symbol_location` reply). On a
  // hit `file`/`line` point at the declaration and FileBrowserPanel jumps there;
  // on a miss `error` is set and the viewer shows a transient 'not found' pill.
  // The nonce lets a repeated resolve of the same symbol re-fire the jump effect.
  symbolLocation: { symbol: string; file: string | null; line: number | null; error: string | null; nonce: number } | null;
  // #6474 — the latest find-in-project result set (a `search_results` reply) that
  // feeds the Cmd+Shift+F palette. Named `codeSearch*` to avoid colliding with the
  // cross-session `searchResults` below. Null until the first search this session.
  codeSearchResults: ServerSearchResultsMessage | null;
  // #6474 — true between dispatching a `search_content` request and its reply.
  codeSearchLoading: boolean;
  // #6477 — find-all-references (alt/option+click a token). `referencesResult` is
  // the latest `references_result` reply; `referencesSymbol` is the requested name
  // (for the modal title while the reply is in flight); `referencesOpen` controls
  // the references palette; `referencesLoading` is true between request and reply.
  referencesResult: ServerReferencesResultMessage | null;
  referencesSymbol: string;
  referencesOpen: boolean;
  referencesLoading: boolean;
  // #6772 — permission audit history (query_permission_audit reply). `permissionAudit`
  // holds the entries from the latest pull (null until the first query this session);
  // `permissionAuditLoading` is true between dispatching the query and its reply.
  // `permissionAuditError` is true when the reply failed the wire-schema parse
  // (PR #6836 review) — the view shows a generic load-failed hint and the button
  // stays actionable instead of wedging on a stuck loading flag. Scoped to the
  // active session by the query action (the server filters by sessionId).
  permissionAudit: PermissionAuditEntry[] | null;
  permissionAuditLoading: boolean;
  permissionAuditError: boolean;

  // Custom agents from server
  customAgents: CustomAgent[];

  // Conversation history (for resuming past conversations)
  conversationHistory: ConversationSummary[];
  conversationHistoryLoading: boolean;

  // Cross-session search
  searchResults: SearchResult[];
  searchLoading: boolean;
  searchQuery: string;

  // Checkpoints for session rewind
  checkpoints: Checkpoint[];

  // Directory listing callback for file browser
  _directoryListingCallback: ((listing: DirectoryListing) => void) | null;

  // File browser callbacks
  _fileBrowserCallback: ((listing: FileListing) => void) | null;
  _fileContentCallback: ((content: FileContent) => void) | null;
  // #6502 — nonce of the most recent read_file request. A file_content reply
  // whose echoed requestId differs is from a superseded request and is dropped.
  lastFileContentRequestId: string | null;

  // Git status callback
  _gitStatusCallback: ((result: GitStatusResult) => void) | null;

  // #6780 — git branches / stage-unstage / commit callbacks. Mirrors the
  // app's imperative-callback slots (gitBranches / gitStage / gitCommit).
  _gitBranchesCallback: ((result: GitBranchesResult) => void) | null;
  // Shared by requestGitStage and requestGitUnstage (git_stage_result and
  // git_unstage_result carry the same payload shape).
  _gitStageCallback: ((result: GitStageResult) => void) | null;
  _gitCommitCallback: ((result: GitCommitResult) => void) | null;
  // #6876 — in-app PR creation callback (git_create_pr_result). Dashboard-only.
  _gitCreatePrCallback: ((result: GitCreatePrResult) => void) | null;

  // Diff viewer callback
  _diffCallback: ((result: DiffResult) => void) | null;

  // Offline cached session viewing (shows session screen when disconnected)
  viewingCachedSession: boolean;

  // Environments
  environments: EnvironmentInfo[];

  // Pairing refresh counter — incremented each time the server broadcasts
  // pairing_refreshed so the dashboard can auto-refresh the QR code (#2916).
  pairingRefreshedCount: number;

  // View mode. #5204 — 'control-room' removed: the Control Room is now a
  // session-independent top-level tab in App, not a per-session view mode.
  viewMode: 'chat' | 'terminal' | 'files' | 'diff' | 'git' | 'system' | 'console' | 'snapshots' | 'pool' | 'pages' | 'devices';

  // Input settings
  inputSettings: InputSettings;

  // Raw terminal output buffer (ANSI-stripped, for plain text fallback)
  terminalBuffer: string;

  // Raw terminal buffer with ANSI codes intact (for xterm.js replay on view switch)
  terminalRawBuffer: string;

  // Imperative write callback for xterm.js (bypasses React state for performance)
  _terminalWriteCallback: ((data: string) => void) | null;

  // Actions
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number; _pairingId?: string }) => void;
  disconnect: () => void;
  loadSavedConnection: () => void;
  clearSavedConnection: () => void;
  setViewMode: (mode: 'chat' | 'terminal' | 'files' | 'diff' | 'git' | 'system' | 'console' | 'snapshots' | 'pool' | 'pages' | 'devices') => void;
  addMessage: (message: ChatMessage) => void;
  addUserMessage: (text: string, attachments?: MessageAttachment[], opts?: { clientMessageId?: string; queued?: boolean }) => void;
  appendTerminalData: (data: string) => void;
  clearTerminalBuffer: () => void;
  setTerminalWriteCallback: (cb: ((data: string) => void) | null) => void;
  // #5835 Phase 1 (PR2): opt in / out of a claude-tui session's live PTY mirror
  // (terminal_output). Sent when the Output tab is shown for a claude-tui session.
  subscribeTerminalMirror: (sessionId: string) => void;
  unsubscribeTerminalMirror: (sessionId: string) => void;
  // #5835 Phase 2: record the authoritative PTY size the server reported for a
  // session (from a terminal_size message), and request a resize of a session's
  // live PTY (terminal_resize) when the viewer pane can fit a different grid.
  setTerminalSize: (sessionId: string, cols: number, rows: number) => void;
  requestTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  // #6313: force a fresh repaint of a session's live PTY mirror (sent on
  // (re)subscribe and via a manual "refresh terminal" affordance) so a
  // backpressure-dropped frame that desynced the xterm grid is recovered.
  requestTerminalResync: (sessionId: string) => void;
  // #5835 Phase 3: forward raw keystrokes to a session's live PTY (true remote
  // control). Best-effort; the server enforces the single-driver authority.
  sendTerminalInput: (sessionId: string, data: string) => void;
  updateInputSettings: (settings: Partial<InputSettings>) => void;
  // #6453 — canonical WIRE attachment type (was an inline loose shape with a
  // `[key: string]: string` index); the dashboard sends both file_ref + image.
  sendInput: (input: string, wireAttachments?: Attachment[], options?: { isVoice?: boolean; previewAttachments?: MessageAttachment[] }) => 'sent' | 'queued' | false;
  // #6861 — `#`-prefix composer quick-append: send the note to the server, which
  // appends it to the session cwd's project CLAUDE.md and acks with
  // `append_memory_result`. Not offline-queued; returns false when disconnected.
  appendMemory: (note: string) => 'sent' | false;
  /**
   * Interrupt the current turn. Defaults to the active session; pass an explicit
   * `sessionId` to interrupt a specific session (e.g. the Control Room
   * per-repo drill-down, which targets the repo's session, not necessarily the
   * active one). #5272.
   */
  sendInterrupt: (sessionId?: string) => 'sent' | 'queued' | false;
  /**
   * #5272 (Control Room Phase 2a): cancel a single in-flight activity node (a
   * subagent) by its activity-tree entry id. Targets `sessionId` if given, else
   * the active session. The terminal `activity_delta` updates the tree; a
   * failure surfaces as the existing `session_error` toast.
   */
  sendCancelActivity: (activityId: string, sessionId?: string) => 'sent' | 'queued' | false;
  /**
   * #5943 (epic #5935 ④): cancel ONE queued send-while-busy follow-up by its
   * `clientMessageId` (the optimistic bubble id). Sends `cancel_queued`; the
   * server removes the queued entry and emits `message_dequeued(reason:
   * 'cancelled')`, which clears the queued badge. Optimistically removes the
   * local queued entry too so the badge clears immediately. NOT queued offline
   * — a cancel that drains seconds later races the flush, so it only fires on a
   * live socket. Targets `sessionId` if given, else the active session.
   */
  sendCancelQueued: (clientMessageId: string, sessionId?: string) => 'sent' | false;
  /** #3068 — Run the prompt evaluator on a draft. Resolves with the verdict
   * payload, or rejects on disconnect / 60s timeout. Errors from the server
   * arrive as the `error` field on the resolved value, not as a Promise reject. */
  evaluateDraft: (draft: string) => Promise<EvaluatorResultPayload>;
  sendPermissionResponse: (requestId: string, decision: PermissionDecision, editedInput?: Record<string, string> | null, reason?: string) => 'sent' | 'queued' | false;
  /** Mark a permission request as resolved in the store (separate from the
   * wire-level response). Used by PermissionPrompt to render its answered
   * state across remounts (#2833). Safe to call for an already-resolved
   * requestId — last write wins. */
  markPermissionResolved: (requestId: string, decision: PermissionDecision) => void;
  /**
   * #6772/#6829 — replace the active session's session-scoped permission rules
   * (the SettingsPanel "Session Rules" viewer's remove / clear-all affordance).
   * Sends `set_permission_rules` with the given list for the active session.
   * Mirrors the mobile SettingsScreen `setPermissionRules`.
   */
  setPermissionRules: (rules: PermissionRule[]) => void;
  /**
   * #6772/#6829 — replace the active session's DURABLE per-project ("always allow")
   * rule set. Used to remove a persistent rule (send the reduced list) or clear all.
   * Re-sends the current session rules alongside so the server's single
   * `set_permission_rules` handler doesn't clobber them. Mirrors the mobile
   * SettingsScreen `setProjectPermissionRules`.
   */
  setProjectPermissionRules: (projectRules: PermissionRule[]) => void;
  /**
   * #6824 — enable or disable an already-configured MCP server for the active
   * session (BYOK lane). Sends `set_mcp_server_enabled`; the toggle is
   * broadcast-driven — no optimistic store mutation. The server re-emits
   * `mcp_servers` with the new per-server status on success (converging every
   * connected device), so the SidebarMcpView switch reflects the re-emitted
   * truth after the round-trip; a rejected toggle simply never moves. No-op
   * when the socket is closed or there is no active session (mirrors
   * `setPermissionRules`).
   */
  setMcpServerEnabled: (server: string, enabled: boolean) => void;
  /**
   * #6822 — submit a pasted OAuth authorization code for a remote MCP server that
   * reported `status: 'oauth-required'` (BYOK lane). Sends `submit_mcp_auth_code`;
   * the daemon redeems the code, persists the tokens encrypted at rest, and
   * reconnects the server authenticated, then re-emits `mcp_servers` with the new
   * status (converging every device). No-op when the socket is closed or there is
   * no active session. `code` is a one-time authorization code — never persisted
   * client-side.
   */
  submitMcpAuthCode: (server: string, code: string) => void;
  /**
   * #6772 — pull the permission audit history for the active session
   * (`query_permission_audit`). Sets `permissionAuditLoading`; the reply lands in
   * `permissionAudit`. No-op when disconnected.
   */
  queryPermissionAudit: () => void;
  /**
   * #4604 Chunk B / #4621 / #4651 / #4735 — answer may be one of three shapes:
   * - `string`: legacy single-question / free-text path (back-compat).
   * - `Record<string, string | string[]>`: multi-question form, keyed
   *   by question text. Multi-select values are emitted as native
   *   `string[]` (#4621 / #4735) so consumers don't have to JSON.parse
   *   to recover the chosen labels. Pre-#4621 builds JSON-stringified
   *   the array into a single string for back-compat (still accepted by
   *   the server). The Record path populates the wire's `answers` field.
   * - `{otherLabel, freeformText}`: single-question "Other" with freeform
   *   text (#4651). The store sets `answer` to `otherLabel` (so the server
   *   can resolve it to a 1-indexed TUI digit) and `freeformText` to the
   *   typed text. The server writes the digit first, waits for claude
   *   TUI's text-input prompt swap, then writes the freeform text + Enter.
   *
   * All paths populate `answer` with a human-readable summary so older
   * servers stay functional.
   */
  sendUserQuestionResponse: (
    answer: string | Record<string, string | string[]> | { otherLabel: string; freeformText: string },
    toolUseId?: string,
  ) => 'sent' | 'queued' | false;
  markPromptAnswered: (messageId: string, answer: string) => void;
  markPromptAnsweredByRequestId: (requestId: string, answer: string) => void;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  // #3185: toggle the per-session promptEvaluator. Server broadcasts a
  // `prompt_evaluator_changed` event back which updates the session
  // entry — no optimistic update here.
  setPromptEvaluator: (value: boolean) => void;
  // #3805: toggle the per-session Chroxy context hint. Server broadcasts
  // a `chroxy_context_hint_changed` event back which updates the
  // session entry — no optimistic update here.
  setChroxyContextHint: (value: boolean) => void;
  // #4660: set the per-session preamble. Server broadcasts a
  // `session_preamble_changed` event back which updates the session
  // entry — no optimistic update here. The dashboard debounces user
  // input before calling this so per-keystroke WS chatter is bounded.
  setSessionPreamble: (value: string) => void;
  // #3209: skills runtime API. `requestListSkills` fetches the current
  // skills list (auto + manual + active state) for the bound session.
  // `activateSkill`/`deactivateSkill` toggle a manual skill — the
  // server broadcasts `skill_activated` / `skill_deactivated` back so
  // multi-client UIs stay in sync; no optimistic update.
  requestListSkills: () => void;
  activateSkill: (skillName: string) => void;
  deactivateSkill: (skillName: string) => void;
  // #3270/#3235: re-trust a skill after a content-hash mismatch.
  // Sends `skill_trust_accept`; the server broadcasts
  // `skill_trust_accepted` which the message-handler uses to clear
  // the SkillsPanel red-flag indicator. Errors come back via the
  // existing `error` envelope and surface through `serverErrors`:
  //   - `TRUST_NOT_ENABLED` — bound session has no trust store wired
  //   - `SKILL_NOT_FOUND` — name doesn't match any loaded skill
  //   - `TRUST_FLUSH_FAILED` — accepted in memory but persist failed
  acceptSkillTrust: (skillName: string) => void;
  // #3298: grant first-activation trust to a community skill author.
  // Sends `skill_trust_grant`; the server broadcasts
  // `skill_trust_granted` (clears the pending row) and then
  // `skill_trust_grant_ok` (ack to the requesting client). The next
  // skills_list broadcast reflects the newly-trusted skill.
  grantCommunitySkillTrust: (skillName: string, author: string) => void;
  confirmPermissionMode: (mode: string) => void;
  cancelPermissionConfirm: () => void;
  resize: (cols: number, rows: number) => void;

  // Directory listing
  setDirectoryListingCallback: (cb: ((listing: DirectoryListing) => void) | null) => void;
  requestDirectoryListing: (path?: string) => void;

  // File browser
  setFileBrowserCallback: (cb: ((listing: FileListing) => void) | null) => void;
  setFileContentCallback: (cb: ((content: FileContent) => void) | null) => void;
  requestFileListing: (path?: string) => void;
  requestFileContent: (path: string) => void;
  // #6472 (epic #6469) — request the per-file/dir IDE symbol table (pass a `path`).
  // Sets symbolsLoading; the reply lands in `symbols`. NOTE: a path-less scan routes
  // to `workspaceSymbols` instead (#6476) — use requestWorkspaceSymbols for that.
  requestSymbols: (path?: string) => void;
  // #6473 — open a file in the FileBrowserPanel viewer (switches to the Files view
  // and signals the panel via fileBrowserPendingOpen). Used by Cmd+P quick-open.
  // #6476 — optional `line` scrolls the viewer to that 1-indexed line after load.
  openFileInBrowser: (path: string, line?: number) => void;
  // #6476 — request the whole-workspace symbol table for the symbol-search modal.
  requestWorkspaceSymbols: () => void;
  // #6475 — resolve a clicked symbol NAME to its definition (go-to-definition).
  // `file` is the originating file (a ranking tie-break hint). The reply lands in
  // `symbolLocation`; FileBrowserPanel reacts to jump there or show 'not found'.
  requestResolveSymbol: (symbol: string, file?: string) => void;
  // #6474 — find-in-project: grep the workspace for `query` (2+ chars). Sets
  // codeSearchLoading; the reply lands in `codeSearchResults` (Cmd+Shift+F palette).
  requestSearchContent: (query: string) => void;
  // #6477 — find-all-references for a clicked symbol. Opens the references palette
  // (referencesOpen) + sets referencesLoading; the reply lands in referencesResult.
  requestFindReferences: (symbol: string, file?: string) => void;

  // Git status
  setGitStatusCallback: (cb: ((result: GitStatusResult) => void) | null) => void;
  requestGitStatus: () => void;

  // #6780 — git branches (read-only listing) + stage/unstage/commit mutations.
  // Wire messages (git_branches / git_stage / git_unstage / git_commit) and
  // their *_result replies were already server-side (packages/server/src/ws-file-ops/git.js)
  // and app-side (packages/app/src/store/connection.ts); this is the dashboard's
  // adoption of the same request/callback pair shape.
  setGitBranchesCallback: (cb: ((result: GitBranchesResult) => void) | null) => void;
  requestGitBranches: () => void;
  setGitStageCallback: (cb: ((result: GitStageResult) => void) | null) => void;
  // Mutation requests return false when the socket is closed (frame not
  // sent) so callers can surface a "not connected" error instead of arming a
  // callback that will never resolve (mirrors the app's #6288 fix).
  requestGitStage: (paths: string[]) => boolean;
  requestGitUnstage: (paths: string[]) => boolean;
  setGitCommitCallback: (cb: ((result: GitCommitResult) => void) | null) => void;
  requestGitCommit: (message: string) => boolean;
  // #6876 — in-app PR creation. `requestGitCreatePr` returns false when the
  // socket is closed (same not-connected guard as stage/commit/unstage).
  setGitCreatePrCallback: (cb: ((result: GitCreatePrResult) => void) | null) => void;
  requestGitCreatePr: (params: { title: string; body?: string; base?: string; draft?: boolean }) => boolean;

  // Diff viewer
  setDiffCallback: (cb: ((result: DiffResult) => void) | null) => void;
  requestDiff: (base?: string) => void;

  // Session actions
  switchSession: (sessionId: string) => void;
  /**
   * #5589 / #5281 — request primary (driver) ownership of a shared session.
   * `force` overrides the current owner (operator-driven take-over). The
   * resulting `session_role` broadcast is the authoritative role update.
   */
  claimPrimary: (sessionId: string, options?: { force?: boolean }) => void;
  /**
   * #6285 — returns whether the create_session request went on the wire.
   * `false` means the socket was closed and nothing was sent, so the caller
   * must skip latching its "Creating…" spinner (no reply will arrive to clear it).
   */
  createSession: (opts: { name: string; cwd?: string; provider?: string; model?: string; permissionMode?: string; worktree?: boolean; environmentId?: string; skipPermissions?: boolean; codexSandbox?: CodexSandboxMode }) => boolean;
  destroySession: (sessionId: string, force?: boolean) => void;
  /** #6006 — operator panic button: request an immediate token revoke (primary-token only). */
  revokeToken: () => void;
  renameSession: (sessionId: string, name: string) => void;
  forgetSession: () => void;
  _resetSessionMemory: () => void;

  // Providers
  fetchProviders: () => void;

  // Slash commands
  fetchSlashCommands: () => void;

  // File picker
  fetchFileList: (query?: string) => void;

  // Custom agents
  fetchCustomAgents: () => void;

  // Conversation history (resume past conversations)
  fetchConversationHistory: () => void;
  resumeConversation: (conversationId: string, cwd?: string) => void;

  // Cross-session search
  searchConversations: (query: string) => void;
  clearSearchResults: () => void;

  // Full history sync (session portability)
  requestFullHistory: (sessionId?: string) => void;

  // Checkpoint actions
  createCheckpoint: (name?: string) => void;
  listCheckpoints: () => void;
  // #6767: selective restore — 'files' reverts only the working tree (current
  // session continues), 'conversation' branches the conversation (files kept),
  // 'both' (default) does both. Omitted → server default 'both'.
  restoreCheckpoint: (checkpointId: string, mode?: RestoreCheckpointMode) => void;
  deleteCheckpoint: (checkpointId: string) => void;

  // Plan mode actions
  clearPlanState: () => void;

  // Log entry actions
  clearLogEntries: () => void;

  // Server error actions. #3587: optional `action` attaches a one-click
  // recovery button to the toast. Existing call sites that pass only
  // `message` keep working — `action` is undefined and the toast renders
  // message-only as before.
  // #5039: optional `partialCostLine` surfaces the PR #5037 partial-cost
  // sub-line under the main toast message when the failed turn folded
  // any parent + Task subagent rounds before erroring out.
  addServerError: (
    message: string,
    action?: ServerErrorAction,
    severity?: ServerError['severity'],
    partialCostLine?: string,
  ) => void;
  dismissServerError: (id: string) => void;

  // Info notification actions
  addInfoNotification: (message: string) => void;
  dismissInfoNotification: (id: string) => void;

  // Session notification actions
  dismissSessionNotification: (id: string) => void;
  /**
   * #4890 — Slack-style notifications widget read/unread tracking.
   *
   * `markSessionNotificationRead(id)` stamps `readAt = Date.now()` on a single
   * alert so it no longer counts toward the unread badge. Idempotent: calling
   * twice keeps the first read timestamp (we don't want re-opens to look
   * like a brand-new acknowledge).
   *
   * `markAllSessionNotificationsRead()` is the "Mark all read" affordance —
   * stamps every currently-unread alert in one batch.
   */
  markSessionNotificationRead: (id: string) => void;
  markAllSessionNotificationsRead: () => void;

  // #4982 — session-not-found chip state
  setSessionNotFoundError: (err: SessionNotFoundErrorState | null) => void;
  dismissSessionNotFoundError: () => void;

  // Dev server preview
  closeDevPreview: (port: number) => void;

  // Web tasks (Claude Code Web)
  launchWebTask: (prompt: string, cwd?: string) => 'sent' | false;
  listWebTasks: () => void;
  teleportWebTask: (taskId: string) => void;

  // Offline cached session viewing
  viewCachedSession: () => void;
  exitCachedSession: () => void;

  // Follow mode
  setFollowMode: (enabled: boolean) => void;

  // Theme
  activeTheme: string;
  setTheme: (themeId: string) => void;

  // Session defaults
  defaultProvider: string;
  setDefaultProvider: (provider: string) => void;
  defaultModel: string;
  setDefaultModel: (model: string) => void;

  // #5184: header cost-badge display mode (provider-model | cost | tokens |
  // context-pct | session-type). Persisted to localStorage; defaults to
  // 'provider-model'. Typed as `CostBadgeMode` at the component layer.
  costBadgeMode: CostBadgeMode;
  setCostBadgeMode: (mode: CostBadgeMode) => void;

  // #5206: whether closing a session tab prompts a confirmation dialog first.
  // Persisted to localStorage ('true'/'false'); defaults to enabled (true).
  confirmSessionClose: boolean;
  setConfirmSessionClose: (enabled: boolean) => void;

  // #4052: BYOK credentials state + actions. The raw key is NEVER stored
  // here — only the masked preview from the server's reply.
  byokCredentialsStatus: {
    status: 'set' | 'missing';
    source: 'env' | 'file' | 'none';
    masked?: string;
    reason?: string;
    // #4144: surface stale-file state. true when ~/.chroxy/credentials.json
    // exists on disk, regardless of which source wins precedence. Lets the
    // Remove button stay enabled even when source is 'env' (the file is
    // shadowed but the user can still want it cleared).
    fileExists?: boolean;
  } | null;
  /**
   * #4559: actions return a boolean indicating whether the WS message was
   * sent. `true` = the socket was OPEN and the patch went on the wire;
   * `false` = the socket was closed and the action was a silent no-op.
   * Callers MUST surface an inline error when `false` is returned so the
   * user knows their change did not reach the server.
   */
  refreshByokCredentialsStatus: () => boolean;
  setByokCredentials: (anthropicApiKey: string) => boolean;
  clearByokCredentials: () => boolean;

  // #3855: generalized provider-credential state. Mirrors the masked,
  // value-free `credentials_status` snapshot from the server — one entry per
  // known provider credential key. The raw value is NEVER stored here. `null`
  // until the first snapshot lands.
  credentialsStatus: {
    credentials: ProviderCredentialEntry[];
    fileExists?: boolean;
    fileError?: string | null;
  } | null;
  // #3855: latest `credential_test_result` keyed by credential key, so each
  // row can render its own inline test outcome.
  credentialTestResults: Record<string, ProviderCredentialTestResult>;
  refreshCredentialsStatus: () => boolean;
  setCredential: (key: string, value: string) => boolean;
  deleteCredential: (key: string) => boolean;
  testCredential: (key: string) => boolean;

  // #5175 (epic #5170): request a Host/Repo Status survey. Dispatches a
  // `host_status_request`; the server replies with a single
  // `host_status_snapshot` handled into `hostStatus`. Returns whether the
  // message went on the wire (false = socket closed; the Control Room Refresh
  // button surfaces a "not connected" state). Sets `hostStatusLoading` while in
  // flight so the button can show a spinner.
  requestHostStatus: () => boolean;

  // Mailbox (#5914 follow-up) — sends a `mailbox_status_request`; the reply is a
  // single `mailbox_status_snapshot` handled into `mailboxStatus`. Returns
  // whether the message went on the wire (false = socket closed). Sets
  // `mailboxStatusLoading` while in flight.
  requestMailboxStatus: () => boolean;
  /** #5969 — request the live external-session snapshot for mission control. */
  requestExternalSessions: () => boolean;
  /** #5966 — request the buffered repo-events snapshot for the Control Room pane. */
  requestRepoEvents: () => boolean;
  /**
   * #6540 — request the current GitHub webhook config (secret status + payload
   * URL + delivery readout). Sets `githubWebhookConfigLoading`; the reply lands
   * in `githubWebhookConfig`. Returns false (without setting loading) when the
   * socket is closed.
   */
  requestGithubWebhookConfig: () => boolean;
  /**
   * #6540 — set (or rotate) the GitHub webhook secret. Host-authority gated
   * server-side. The value is sent once and never stored in the dashboard store.
   * Returns false (without setting loading) when the socket is closed.
   */
  setGithubWebhookSecret: (secret: string) => boolean;
  /** #6540 — clear the stored GitHub webhook secret. Host-authority gated. */
  clearGithubWebhookSecret: () => boolean;
  /** #6691 (S-3) — request the orchestration runs-list snapshot for the Runs tab. */
  requestOrchestrationRuns: () => boolean;
  /** #6691 — request one run's full detail snapshot (also the seq-gap resync path). */
  requestOrchestrationRunDetail: (runId: string) => boolean;
  /** #6691 — select a run in the Runs tab (detail panel target). */
  selectRun: (runId: string | null) => void;
  /** #6691 (S-3c) — start an orchestration run. Returns the requestId (or null if not sent). */
  startOrchestrationRun: (opts: { preset?: string; epicPrompt?: string; cwd: string; title?: string; budgetUsd?: number; autoApprovePlan?: boolean; roles?: Record<string, { provider: string; model: string }> }) => string | null;
  /** #6691 (S-3c) — respond to a run gate. Returns the requestId (or null if not sent). */
  sendOrchestrationGateResponse: (runId: string, gateId: string, decision: 'approve' | 'reject' | 'revise' | 'skip', note?: string, budgetUsd?: number) => string | null;
  /** #6691 (S-3c) — cancel/pause/resume a run. Returns the requestId (or null if not sent). */
  sendOrchestrationRunAction: (runId: string, action: 'cancel' | 'pause' | 'resume') => string | null;
  /** #6691 (S-3c) — annotate a run (baseline session + verdict quality). Returns the requestId (or null if not sent). */
  sendOrchestrationRunAnnotate: (runId: string, opts: { baselineSessionId?: string; verdictQuality?: string }) => string | null;
  /** #6543 — pull the full redacted tool input for a pending permission (for the pre-write diff). */
  requestPermissionInput: (requestId: string) => boolean;

  // #5553 — per-repo session preset surface (host-authority). Each returns
  // whether the message went on the wire. Replies arrive as
  // `session_preset_snapshot` and land in `sessionPresetSnapshots[cwd]`.
  requestSessionPreset: (cwd: string) => boolean;
  setSessionPresetOverride: (cwd: string, preset: { preamble?: string; seed?: string; enabled?: boolean } | null) => boolean;
  approveSessionPreset: (cwd: string) => boolean;
  revokeSessionPreset: (cwd: string) => boolean;
  // Drain a server-provided composer seed for a session (returns it + removes
  // the entry). Used by App's create-confirm effect.
  takePendingServerSeed: (sessionId: string) => string | null;

  // #5510 (epic #5509): approve a pending pair request, sending `pair_approve`.
  // Optimistically drops the request from `pendingPairRequests` (the server also
  // retracts it via `pair_resolved`). Returns whether the message went on the
  // wire (false = socket closed).
  approvePairRequest: (requestId: string) => boolean;
  // #5510: deny a pending pair request, sending `pair_deny`. Same optimistic
  // drop + wire-result contract as approvePairRequest.
  denyPairRequest: (requestId: string) => boolean;

  // #5513: clear the approval-gated redemption signal (`pendingApprovalPairHost`)
  // after the UI has opened the request-pair flow for it.
  clearPendingApprovalPairHost: () => void;

  // #5253: request a self-hosted runner survey. Dispatches a
  // `runner_status_request`; the server replies with a single
  // `runner_status_snapshot` handled into `runnerStatus`. Returns whether the
  // message went on the wire (false = socket closed). Sets `runnerStatusLoading`
  // while in flight.
  requestRunnerStatus: () => boolean;

  // #6133 (epic #5530): request a containers & environments survey. Dispatches a
  // `containers_status_request`; the server replies with a single
  // `containers_status_snapshot` handled into `containersStatus`. Returns whether
  // the message went on the wire (false = socket closed). Sets
  // `containersStatusLoading` while in flight.
  requestContainersStatus: () => boolean;

  // #6135 (epic #5530): request a BYOK pool survey. Dispatches a
  // `byok_pool_status_request`; the server replies with a single
  // `byok_pool_status_snapshot` handled into `byokPoolStatus`. Returns whether
  // the message went on the wire (false = socket closed). Sets
  // `byokPoolStatusLoading` while in flight.
  requestByokPoolStatus: () => boolean;

  // #6140 (epic #5530): request a host prune survey. Dispatches a
  // `host_prune_status_request`; the server replies with a single
  // `host_prune_status_snapshot` handled into `hostPruneStatus`. Returns whether
  // the message went on the wire (false = socket closed). Sets
  // `hostPruneStatusLoading` while in flight.
  requestHostPruneStatus: () => boolean;

  // #6136 (epic #5530): request an iOS simulator survey. Dispatches a
  // `simulator_status_request`; the server replies with a single
  // `simulator_status_snapshot` handled into `simulatorStatus`. Returns whether
  // the message went on the wire (false = socket closed). Sets
  // `simulatorStatusLoading` while in flight.
  requestSimulatorStatus: () => boolean;

  // #6137 (epic #5530): request an Android emulator survey. Dispatches an
  // `emulator_status_request`; the server replies with a single
  // `emulator_status_snapshot` handled into `emulatorStatus`. Returns whether
  // the message went on the wire (false = socket closed). Sets
  // `emulatorStatusLoading` while in flight.
  requestEmulatorStatus: () => boolean;

  // #6138 (epic #5530): request a WSL2 distro survey. Dispatches a
  // `wsl_status_request`; the server replies with a single `wsl_status_snapshot`
  // handled into `wslStatus`. Returns whether the message went on the wire
  // (false = socket closed). Sets `wslStatusLoading` while in flight.
  requestWslStatus: () => boolean;

  // #6139 (epic #5530): request a per-repo runtime config survey. Dispatches a
  // `repo_runtime_config_request`; the server replies with a single
  // `repo_runtime_config_snapshot` handled into `repoRuntimeConfig`. Returns
  // whether the message went on the wire (false = socket closed). Sets
  // `repoRuntimeConfigLoading` while in flight.
  requestRepoRuntimeConfig: () => boolean;

  // #5499 (epic #5498): request an Integrations survey. Dispatches an
  // `integration_status_request`; the server replies with a single
  // `integration_status_snapshot` handled into `integrationStatus`. Returns
  // whether the message went on the wire (false = socket closed). Sets
  // `integrationStatusLoading` while in flight.
  requestIntegrationStatus: () => boolean;

  // #5554 (epic #5159): request a Skills inventory survey. Dispatches a
  // `skills_inventory_request`; the server replies with a single
  // `skills_inventory_snapshot` handled into `skillsInventory`. Returns whether
  // the message went on the wire (false = socket closed). Sets
  // `skillsInventoryLoading` while in flight.
  requestSkillsInventory: () => boolean;

  // #5500 (epic #5498): run the repo-memory Reindex action for one surveyed
  // repo. Dispatches an `integration_action` (action: repo_memory_reindex)
  // tagged with a requestId the server echoes on the `integration_action_ack`
  // / INTEGRATION_ACTION_FAILED session_error. Marks the repo in
  // `reindexingRepoPaths` (and drops its stale `reindexResults` entry) ONLY
  // when the message actually went on the wire — an offline send returns
  // false without queuing, so the row can't strand "Reindexing…".
  sendRepoMemoryReindex: (repoPath: string) => boolean;

  // #5502 (epic #5498): re-run a FAILED repo-relay workflow run for one
  // surveyed repo. Dispatches an `integration_action` (action:
  // repo_relay_rerun) carrying the runId the observability snapshot surfaced
  // — the server re-validates it against a fresh `gh run list` before any
  // exec. Same wire-or-nothing contract as sendRepoMemoryReindex: marks the
  // repo in `relayRerunningRepoPaths` (and drops its stale
  // `relayRerunResults` entry) ONLY when the message actually went on the
  // wire; an offline send (or a non-integer runId) returns false.
  sendRepoRelayRerun: (repoPath: string, runId: number) => boolean;

  // #6134 (epic #5530): run a container lifecycle action (stop / restart /
  // destroy) for one surveyed environment. Dispatches a `containers_action`
  // tagged with a requestId the server echoes on the `containers_action_ack`
  // / CONTAINER_ACTION_FAILED session_error. Marks the environment in
  // `containerActioningIds` (and drops its stale `containerActionResults`
  // entry) ONLY when the message actually went on the wire — an offline send
  // (or an empty environmentId / unknown action) returns false without
  // queuing, so the row can't strand mid-action. Destroy confirmation is the
  // caller's responsibility (the UI gates it behind a ConfirmDialog).
  sendContainersAction: (environmentId: string, action: 'stop' | 'restart' | 'destroy') => boolean;

  // #6135 slice 3 (epic #5530): run a BYOK pool mutating action. The pool is a
  // single process-wide singleton, so the actions differ by shape:
  //   - 'drain'   — evict all idle warm containers (no target).
  //   - 'recycle' — evict one resource-shape bucket; pass `opts.key` (the
  //     bucket key the survey enumerated; the server re-validates it against the
  //     live pool before any exec).
  //   - 'resize'  — set runtime caps; pass `opts.maxPerKey` / `opts.maxTotal`
  //     (the server clamps each to the operator-configured ceiling).
  // Dispatches a `byok_pool_action` tagged with a requestId the server echoes on
  // the `byok_pool_action_ack` / BYOK_POOL_ACTION_FAILED session_error. Marks
  // the action target (`'drain'` / `'recycle:<key>'` / `'resize'`) in
  // `byokPoolActioningIds` (and drops its stale result) ONLY when the message
  // actually went on the wire; an offline send (or a recycle with no key) returns
  // false without queuing. Drain/recycle confirmation is the caller's
  // responsibility (the UI gates them behind a ConfirmDialog).
  sendByokPoolAction: (
    action: 'drain' | 'recycle' | 'resize',
    opts?: { key?: string; maxPerKey?: number; maxTotal?: number },
  ) => boolean;

  // #6140 slice 2 (epic #5530): run a host prune. `kind` selects what to remove
  // (stopped chroxy containers / chroxy snapshot images / both). The server
  // takes no target list — it re-surveys the chroxy-scoped orphan set and removes
  // only those ids. Dispatches a `host_prune_action` tagged with a requestId the
  // server echoes on the `host_prune_action_ack` / HOST_PRUNE_ACTION_FAILED
  // session_error. Marks the `kind` in `hostPruneActioningIds` (dropping its
  // stale result) ONLY when the message actually went on the wire; an offline
  // send returns false. Confirmation is the caller's responsibility (the UI
  // gates it behind a ConfirmDialog — it's destructive).
  sendHostPruneAction: (kind: 'containers' | 'images' | 'all') => boolean;

  // #6136 slice 3 (epic #5530): boot / shut down an iOS simulator. `udid` names a
  // device the survey enumerated — the server re-surveys and re-validates it (the
  // udid is a lookup key, never a trusted target) plus state-gates the action.
  // Dispatches a `simulator_action` tagged with a requestId the server echoes on
  // the `simulator_action_ack` / SIMULATOR_ACTION_FAILED session_error. Marks the
  // `udid` in `simulatorActioningIds` (dropping its stale result) ONLY when the
  // message actually went on the wire; an offline send (or an empty udid)
  // returns false without queuing. Non-destructive, so no confirm gate.
  sendSimulatorAction: (action: 'boot' | 'shutdown', udid: string) => boolean;

  // #6137 (epic #5530): boot an AVD / kill a running Android emulator. boot
  // targets an `avd` (the survey enumerated, currently stopped) with an optional
  // `headless` (`-no-window`); kill targets a running `serial`. The server
  // re-surveys + re-validates the target (lookup key, never a trusted path) and
  // state-gates the action. Dispatches an `emulator_action` tagged with a
  // requestId the server echoes on the `emulator_action_ack` /
  // EMULATOR_ACTION_FAILED session_error. Marks the target (avd or serial) in
  // `emulatorActioningIds` (dropping its stale result) ONLY when the message
  // actually went on the wire; an offline send (or a missing target) returns
  // false without queuing. Non-destructive, so no confirm gate.
  sendEmulatorAction: (action: 'boot' | 'kill', opts: { avd?: string; serial?: string; headless?: boolean }) => boolean;

  // #6138 (epic #5530): start / terminate a WSL2 distro. `distro` names a distro
  // the survey enumerated — the server re-surveys `wsl.exe -l -v` and re-validates
  // it (the name is a lookup key, never a trusted target) plus state-gates the
  // action (start requires Stopped, terminate requires Running). Dispatches a
  // `wsl_action` tagged with a requestId the server echoes on the
  // `wsl_action_ack` / WSL_ACTION_FAILED session_error. Marks the `distro` in
  // `wslActioningIds` (dropping its stale result) ONLY when the message actually
  // went on the wire; an offline send (or an empty distro) returns false without
  // queuing. Non-destructive (no data loss), so no confirm gate.
  sendWslAction: (action: 'start' | 'terminate', distro: string) => boolean;

  // #5547: request a server-side one-shot summary of a session's persisted
  // history (the sidebar "Summarize & start new session" action). Dispatches a
  // `summarize_session` tagged with a requestId the server echoes on the
  // `summarize_session_result` / SUMMARIZE_FAILED session_error. Returns a
  // promise that resolves with the continuation brief (+ truncation flag) or
  // rejects with the failure message — the caller seeds the brief into the
  // create-session composer on resolve. Rejects immediately if the socket is
  // not open (never queued — a summary that drains later has no live UI to
  // land in).
  summarizeSession: (sessionId: string) => Promise<{ summary: string; truncated: boolean }>;

  // #4542: per-category notification preferences. Mirrors the server
  // snapshot received over WS (`notification_prefs`). `null` until the
  // first snapshot lands. Categories is open-ended (server-side keys
  // come from RATE_LIMITS in push.js — adding a new category there does
  // not require a protocol bump).
  //
  // #4544 extends the shape with `timezone` on the quiet-hours window,
  // a globally-applied `bypassCategories` list (defaults to
  // permission + activity_error — categories that fire even at 3am), and
  // optional per-device overrides for quietHours / bypassCategories.
  // Per-device REPLACES the global value entirely (see notification-prefs.js
  // for the precedence rationale).
  notificationPrefs: {
    categories: Record<string, boolean>;
    devices: Record<string, {
      categories?: Record<string, boolean>;
      quietHours?: { start: string; end: string; timezone: string } | null;
      bypassCategories?: string[];
    }>;
    quietHours: { start: string; end: string; timezone: string } | null;
    bypassCategories?: string[];
  } | null;
  /**
   * #4559: same fail-loud contract as the BYOK actions. Returns `true` when
   * the WS message was sent, `false` when the socket was closed and the
   * action no-op'd. UI must surface inline error feedback on `false`.
   */
  refreshNotificationPrefs: () => boolean;
  /**
   * Patch a single category's enabled flag. Sends a `notification_prefs_set`
   * with a minimal shallow-merge patch (server merges over the existing
   * categories map, so other toggles are preserved).
   *
   * #4559: returns `false` when the socket is closed (silent-drop is gone —
   * SettingsPanel surfaces an inline error to keep the user honest).
   */
  setNotificationPrefsCategory: (category: string, enabled: boolean) => boolean;
  /**
   * #4543: stable per-device key used to address THIS client in the
   * `notification_prefs.devices` map. Sourced once at store init from
   * localStorage (`chroxy_device_id` — the same id sent in `deviceInfo` on
   * auth). `null` only when storage was completely unavailable AND we never
   * minted a key — in practice a long-lived browser tab always has one, but
   * UI code MUST tolerate null so a missing key can't ship a `devices[null]`
   * patch.
   */
  currentDeviceKey: string | null;
  /**
   * #4543: patch a per-device category override. Sends a single
   * `notification_prefs_set` with `{ devices: { [deviceKey]: { categories:
   * { [category]: enabled } } } }`. Server shallow-merges so other device
   * entries — and other categories under THIS device — survive untouched.
   * `enabled = false` mutes the category on this device only; `true` is the
   * explicit-unmute path (overrides a `false` global default).
   *
   * #4559: returns `true` when the WS message was sent, `false` when the
   * socket was closed OR the deviceKey was empty (both cases yield a
   * no-op). UI surfaces an inline error on `false` so the toggle revert
   * isn't mistaken for the user mis-clicking.
   */
  setNotificationPrefsDevice: (deviceKey: string, category: string, enabled: boolean) => boolean;
  /**
   * #4564: drop a per-device override entry entirely. Sends
   * `notification_prefs_set` with `{ devices: { [deviceKey]: null } }`,
   * which the server interprets as "remove this device from the persisted
   * map". Used by the "Clear" buttons in the Notifications settings list
   * to drain orphan entries left behind by push-token refresh, app
   * reinstall, or browser-storage wipe.
   *
   * Returns `true` when the WS message was sent, `false` when the socket
   * was closed OR the deviceKey was empty (both yield a no-op so we never
   * ship a `devices[""]` / `devices[null]` patch). UI surfaces an inline
   * error on `false` so a botched clear isn't silent.
   */
  deleteNotificationPrefsDevice: (deviceKey: string) => boolean;
  /**
   * #4544: patch the global quiet-hours window. `null` clears the window;
   * a window object (with `timezone`) sets it. The server broadcasts the
   * merged snapshot so all clients update in lockstep.
   *
   * #4559: returns `false` when the socket is closed.
   */
  setNotificationPrefsQuietHours: (window: { start: string; end: string; timezone: string } | null) => boolean;
  /**
   * #4544: patch the global bypass-category list. Sends the full list
   * (replacement, not delta) so an empty array maps to "nothing bypasses,
   * not even errors".
   *
   * #4559: returns `false` when the socket is closed.
   */
  setNotificationPrefsBypassCategories: (categories: string[]) => boolean;

  // Multi-server registry actions
  addServer: (name: string, wsUrl: string, token: string) => ServerEntry;
  removeServer: (serverId: string) => void;
  updateServer: (serverId: string, patch: Partial<Pick<ServerEntry, 'name' | 'wsUrl' | 'token' | 'pinnedIdentityKey'>>) => void;
  /** Switch to a different server — disconnects, clears session, connects fresh. */
  switchServer: (serverId: string) => void;
  /** Reconnect to a server without clearing session state (auto-reconnect/startup). */
  connectToServer: (serverId: string) => void;
  /** Connect to the local same-origin daemon ("this machine"); registry-less local target. */
  connectLocal: () => void;
  /** Add a server from a pairing URL and connect via the ephemeral pairing
      handshake (no permanent token); the issued session token replaces the
      entry's empty token. (#5281 ③ PR 2) */
  pairServer: (name: string, wsUrl: string, pairingId: string, identityKey?: string) => ServerEntry;
  /**
   * Reconnect to whatever server is currently active — the registry server when
   * `activeServerId` is set, otherwise the local same-origin daemon. Preserves
   * session state (it's a retry, not a switch). Used by the manual "Retry"
   * affordance so a dropped remote LAN connection retries the remote, not local
   * (#5284).
   */
  retryConnection: () => void;

  // Environment actions
  requestEnvironments: () => void;
  createEnvironment: (opts: { name: string; cwd: string; image?: string; memoryLimit?: string; cpuLimit?: string }) => void;
  destroyEnvironment: (environmentId: string) => void;

  // Convenience accessor
  getActiveSessionState: () => SessionState;
}
