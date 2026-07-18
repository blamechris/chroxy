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

// #6453 — canonical WIRE attachment type for the sendInput signature (was an
// inline `{ type; mediaType; data; name }[]`; the app only sends binary).
import type { BinaryAttachment, ServerPermissionInputMessage } from '@chroxy/protocol';

// Re-export shared protocol types from store-core
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  SavedConnection,
  ContextUsage,
  // #6769: occupancy snapshot type (the context meter's only honest input).
  ContextOccupancy,
  InputSettings,
  ModelInfo,
  SessionInfo,
  AgentInfo,
  ConnectedClient,
  SessionHealth,
  SessionContext,
  McpServer,
  ServerError,
  DevPreview,
  WebTask,
  WebFeatureStatus,
  ConversationSummary,
  SearchResult,
  SlashCommand,
  CustomAgent,
  ConnectionPhase,
  ConnectionContext,
  QueuedMessage,
  Checkpoint,
  BaseSessionState,
  PendingPermissionConfirm,
  // #4213: typed permission-mode shape — `description` flows through to the
  // mobile SettingsBar so the chips share one source of truth with the server
  // (matches the dashboard #4019 plumbing).
  PermissionMode,
  // Re-export shared git result element types (#3132). Local definitions
  // are now redundant; canonical types live in @chroxy/store-core.
  GitFileStatus,
  GitBranch,
  DiffFile,
  DiffHunk,
  DiffHunkLine,
} from '@chroxy/store-core';

// Import for local use in SessionState/ConnectionState definitions below
import type {
  AgentInfo,
  BaseSessionState,
  // #5630/#5629: era-aware billing class union.
  BillingClass,
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ContextUsage,
  ContextOccupancy,
  ConversationSummary,
  CustomAgent,
  DevPreview,
  DiffFile,
  GitBranch,
  GitFileStatus,
  InputSettings,
  McpServer,
  MessageAttachment,
  ModelInfo,
  PendingPermissionConfirm,
  SavedConnection,
  // #4213: typed permission-mode shape used by the
  // ModelsAndPermissionsData slice below.
  PermissionMode,
  SearchResult,
  ServerError,
  SessionContext,
  SessionHealth,
  SessionInfo,
  SlashCommand,
  WebFeatureStatus,
  WebTask,
} from '@chroxy/store-core';

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
}

export interface FileWriteResult {
  path: string | null;
  error: string | null;
}

// `GitFileStatus`, `GitBranch`, `DiffHunkLine`, `DiffHunk`, and `DiffFile`
// are now re-exported from `@chroxy/store-core` above (#3132).

export interface GitStatusResult {
  branch: string | null;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: string[];
  error: string | null;
}

export interface GitBranchesResult {
  branches: GitBranch[];
  currentBranch: string | null;
  error: string | null;
}

export interface GitStageResult {
  error: string | null;
}

export interface GitCommitResult {
  hash: string | null;
  message: string | null;
  error: string | null;
}

export interface DiffResult {
  files: DiffFile[];
  error: string | null;
}

import type { SessionActivity, ActivityState } from './session-activity';
export type { SessionActivity, ActivityState };

export interface PermissionRule {
  tool: string;
  decision: 'allow' | 'deny';
  pattern?: string;
  // #6771: set to 'project' on a DURABLE rule (backed by the daemon's per-project
  // rule store — survives restarts). Absent on a session-scoped rule.
  persist?: 'project';
}

export interface ProviderCapabilities {
  permissions?: boolean;
  inProcessPermissions?: boolean;
  modelSwitch?: boolean;
  permissionModeSwitch?: boolean;
  // #5609: true when switching to 'auto' mid-turn interrupts the running turn
  // (CLI respawns its `claude -p` subprocess — the #3729 panic-button). The
  // app renders the server-provided `confirm_permission_mode` warning verbatim,
  // so this flag is informational on the app side; the server derives the
  // warning copy from it.
  interruptsTurnOnAutoSwitch?: boolean;
  planMode?: boolean;
  // #6312: true when the provider streams partial responses. claude-tui reports
  // false; other providers omit it (treated as capable). Consumed by the
  // session-creation limitation note so `streaming: false` isn't dropped client-side.
  streaming?: boolean;
  resume?: boolean;
  terminal?: boolean;
  thinkingLevel?: boolean;
  // True if the provider supports session-scoped permission rules
  // (i.e. the "Allow for Session" affordance). Derived server-side from
  // method existence — only providers whose session class implements
  // setPermissionRules report this as true (#3072).
  sessionRules?: boolean;
  // #5791 — claude-tui only: true when the daemon will reinject a single
  // multi-select AskUserQuestion answer (CHROXY_TUI_MULTISELECT_REINJECT).
  // Gates the multi-select checkbox affordance so the client doesn't offer a
  // form the server refuses.
  multiSelectReinject?: boolean;
  // #6767: true when the provider can fork/branch a resumed conversation at a
  // message boundary (SDK provider). Gates the checkpoint restore-mode picker's
  // "Conversation" option — providers that can't fork omit it / report false.
  conversationFork?: boolean;
}

// #6767: selective checkpoint-restore mode. 'files' reverts only the working
// tree (current session/conversation continue), 'conversation' branches the
// conversation at the checkpoint (working tree kept), 'both' does both (default).
export type RestoreCheckpointMode = 'files' | 'conversation' | 'both';

// #3404 audit (F1+F5): per-provider auth state for grey-out + billing detail.
export interface ProviderAuth {
  ready: boolean;
  source: 'env' | 'oauth' | 'none';
  envVar: string | null;
  envVars: string[];
  hint: string;
  detail: string;
  // #5630/#5629: era-aware billing class. Optional — older servers omit it.
  // The app's mapProviderList passes auth through verbatim (no strict Zod
  // strip), so an unknown key was never rejected — this just types it.
  billingClass?: BillingClass;
}

export interface ProviderInfo {
  name: string;
  capabilities?: ProviderCapabilities;
  auth?: ProviderAuth;
}

export interface SessionState extends BaseSessionState {
  activityState: SessionActivity;
  sessionRules?: PermissionRule[];
  // #6771: durable per-project rules ("always allow / deny"), tagged
  // `persist:'project'`. Written by permission_rules_updated (persistentRules
  // field via the shared dispatch table). Surfaced in the SessionRules screen.
  persistentRules?: PermissionRule[];
}

export interface SessionNotification {
  id: string;
  sessionId: string;
  sessionName: string;
  eventType: 'permission' | 'question' | 'completed' | 'error' | 'plan';
  message: string;
  timestamp: number;
  requestId?: string;
  tool?: string;
  description?: string;
  inputPreview?: string;
}

/**
 * Group 1 — Connection & socket. Lifecycle phase/URL/token live in
 * `useConnectionLifecycleStore`; this interface holds the live socket plus the
 * reactive mirror of the outgoing-queue depth (see `queuedMessageCount`).
 */
export interface ConnectionSocketData {
  socket: WebSocket | null;
  // #5699 — reactive mirror of the number of queued *user input* messages (the
  // queue itself lives in message-handler's module context, which is
  // non-reactive). Counts only `input`, not ephemeral `interrupt` control
  // signals. Surfaced so the reconnect banner can show "N queued" and the
  // manual-disconnect path can warn before discarding unsent messages.
  queuedMessageCount: number;
}

/**
 * Group 2 — Sessions & multi-client awareness. The session list, active
 * session, per-session UI state, and the connected-clients roster used for
 * follow-mode/primary-client logic.
 */
export interface MultiClientSessionData {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>;
  // #5968 — the store-core cross-session activity reducer state, consumed by the
  // mobile MissionControlScreen via `selectCrossSessionActivity`. Imported inline
  // to avoid colliding with the app's own `ActivityState` enum
  // (store/session-activity.ts), re-exported above under the same name. The live
  // feeder (dispatching activity_snapshot/activity_delta) is PR2; until it lands
  // this stays at `createEmptyActivityState()` and the view shows its empty state.
  activity: import('@chroxy/store-core').ActivityState;
  // Connected clients (multi-client awareness)
  myClientId: string | null;
  connectedClients: ConnectedClient[];
  primaryClientId: string | null;
  // Follow mode: auto-switch sessions when another client switches
  followMode: boolean;
}

/**
 * Group 3 — Models & permissions. Provider/model catalogues fetched from the
 * server plus the pending auto-mode confirmation prompt.
 */
export interface ModelsAndPermissionsData {
  // Available models from server (CLI mode)
  availableModels: ModelInfo[];
  // Server-reported default model short id (from SDK)
  defaultModelId: string | null;
  // Available permission modes from server (CLI mode).
  // #4213: typed PermissionMode from store-core; the optional `description`
  // field flows through to the SettingsBar hint so the mobile picker shares
  // one source of truth with the server's PERMISSION_MODES table (matches
  // the dashboard #4019 plumbing).
  availablePermissionModes: PermissionMode[];
  // Available providers from server (for session creation UI)
  availableProviders: ProviderInfo[];
  // Pending auto permission mode confirmation from server
  pendingPermissionConfirm: PendingPermissionConfirm | null;
  // #6543 (feature B): pulled full (secret-redacted) tool inputs for pre-write
  // diffs, keyed by requestId. Fed by the `permission_input` reply to a
  // `get_permission_input` pull (see requestPermissionInput).
  permissionInputs: Record<string, ServerPermissionInputMessage>;
  // #6543 (feature B): the server's advertised capability map from `auth_ok`
  // (`{ ide: true, … }`). Gates the mobile pre-write-diff review to servers with
  // `features.ide` on, mirroring the dashboard's `serverCapabilities?.ide` gate.
  // Absent/non-object capabilities parse to `{}` (no advertised capabilities).
  serverCapabilities: Record<string, boolean>;
}

/**
 * Group 4 — Cost & budget. Cumulative cost tracking + the configured budget
 * cap broadcast by the server.
 */
export interface CostBudgetData {
  totalCost: number | null;
  costBudget: number | null;
}

/**
 * Group 5 — Server events & notifications. Errors, session-level
 * notifications (permission/question/completed/etc.), shutdown banner state,
 * and the per-session idle-timeout warning.
 */
export interface ServerNotificationData {
  // Server errors forwarded over WebSocket (last 10)
  serverErrors: ServerError[];
  // Background session notifications (permission, question, completed, error)
  sessionNotifications: SessionNotification[];
  // Shutdown state (reason + ETA for restarting banner countdown)
  shutdownReason: 'restart' | 'shutdown' | 'crash' | null;
  restartEtaMs: number | null;
  restartingSince: number | null;
  // Session timeout warning (from server session_warning event)
  timeoutWarning: { sessionId: string; sessionName: string; remainingMs: number; receivedAt: number } | null;
  // #4542: per-category notification preferences. Mirrors the latest
  // `notification_prefs` snapshot received from the server. `null` until
  // the first snapshot arrives. Server is the single source of truth —
  // ~/.chroxy/notification-prefs.json on the host.
  //
  // #4544 extends the shape with `timezone` on the quiet-hours window, a
  // globally-applied `bypassCategories` list (defaults to
  // permission + activity_error — categories that fire even at 3am), and
  // optional per-device overrides for quietHours / bypassCategories.
  // Per-device REPLACES the global value entirely (see
  // packages/server/src/notification-prefs.js for the precedence
  // rationale).
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
  // #4543: registered Expo push token for THIS device. Used as the key
  // into `notificationPrefs.devices` so the SettingsScreen can patch a
  // per-device override that survives across reconnects. Set once by
  // `registerPushToken` in message-handler.ts after a successful
  // `register_push_token` ack, cleared on disconnect so a fresh connect
  // cycle re-fetches. Null when the device has no push capability (e.g.
  // simulator) — the per-device UI hides itself in that case.
  pushToken: string | null;
}

/**
 * Group 6 — Discovery data fetched from the server: slash commands, custom
 * agents, conversation history, cross-session search, checkpoints, and the
 * Claude Code Web task surface.
 */
export interface DiscoveryData {
  // Slash commands from server
  slashCommands: SlashCommand[];
  // Custom agents from server
  customAgents: CustomAgent[];
  // Conversation history (for resuming past conversations)
  conversationHistory: ConversationSummary[];
  conversationHistoryLoading: boolean;
  conversationHistoryError: string | null;
  // Cross-session search
  searchResults: SearchResult[];
  searchLoading: boolean;
  searchQuery: string;
  searchError: string | null;
  // Checkpoints for session rewind
  checkpoints: Checkpoint[];
  // Claude Code Web (cloud task delegation)
  webFeatures: WebFeatureStatus;
  webTasks: WebTask[];
}

/**
 * Group 7 — UI & view state. View-mode toggles, offline-cached-session flag,
 * input settings, and the dual terminal buffers (stripped + raw ANSI).
 */
export interface UIViewData {
  // Offline cached session viewing (shows session screen when disconnected)
  viewingCachedSession: boolean;
  // View mode
  viewMode: 'chat' | 'terminal' | 'files' | 'system';
  // Input settings
  inputSettings: InputSettings;
  // Terminal output buffer with ANSI codes stripped (for plain text fallback)
  terminalBuffer: string;
  // Raw terminal buffer with ANSI codes intact (for xterm.js replay on view switch)
  terminalRawBuffer: string;
}

/**
 * Action group 1 — Connection lifecycle. Connect/disconnect plus the
 * persisted-connection helpers used by ConnectScreen / SessionScreen on app
 * start.
 */
export interface ConnectionActions {
  connect: (
    url: string,
    token: string,
    // #5555 — `healthPrecheck` carries connectAuto's fresh `/health` result so
    // connect() can skip its own redundant probe (one connect == one probe).
    options?: { silent?: boolean; _retryCount?: number; healthPrecheck?: { ts: number; status: 'ok' } },
  ) => void;
  /**
   * #5518 — auto-select the best endpoint for a saved connection (races a
   * `/health` probe against the verified LAN candidate, else tunnel) then
   * connects. Auto-reconnect paths use this; manual flows call `connect()`.
   */
  connectAuto: (
    saved: SavedConnection,
    // #5633 — `force` skips connectAuto's "already connected to this URL" no-op
    // guard so the resume zombie-socket path can force a fresh reconnect even
    // when the socket still claims OPEN on an unchanged tunnel URL.
    options?: { silent?: boolean; preferTunnel?: boolean; force?: boolean },
  ) => Promise<void>;
  disconnect: () => void;
  // #5725 (#5698) — user-initiated retry from the terminal `server_down` state:
  // resets the reconnect ladder, then reconnects to the saved connection.
  retryConnection: () => void;
  loadSavedConnection: () => Promise<void>;
  clearSavedConnection: () => Promise<void>;
}

/**
 * Options accepted by {@link MultiClientSessionActions.createSession}.
 *
 * Mirrors the dashboard's `createSession` signature
 * (`packages/dashboard/src/store/types.ts`) so the shape stays identical
 * across platforms — adding a new field is a single-place change. (#3611)
 */
export interface CreateSessionOptions {
  name: string;
  cwd?: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
  worktree?: boolean;
  /**
   * Container/dev environment id. Reserved for parity with the dashboard
   * (which manages environments); the mobile app currently has no UI for
   * selecting one but forwards it on the wire if a future caller passes it.
   */
  environmentId?: string;
}

/**
 * Action group 2 — Sessions & multi-client. Session lifecycle (create /
 * switch / destroy / rename / forget), follow-mode toggle, and the
 * convenience accessor for the active session's state.
 */
export interface MultiClientSessionActions {
  switchSession: (sessionId: string, options?: { serverNotify?: boolean; haptic?: boolean }) => void;
  /**
   * #5589 / #5281 — request primary (driver) ownership of a shared session.
   * `force` overrides the current owner (operator-driven take-over). The
   * resulting `session_role` broadcast is the authoritative role update.
   */
  claimPrimary: (sessionId: string, options?: { force?: boolean }) => void;
  createSession: (opts: CreateSessionOptions) => void;
  destroySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  forgetSession: () => void;
  setFollowMode: (enabled: boolean) => void;
  getActiveSessionState: () => SessionState;
}

/**
 * Action group 3 — Message input & responses. User-message construction,
 * input/interrupt sending, and the permission/question response paths plus
 * their local mark-as-answered helpers.
 */
export interface MessageInputActions {
  addMessage: (message: ChatMessage) => void;
  // #5938 — `queued: true` records the bubble as a send-while-streaming
  // follow-up: append it WITHOUT re-arming the thinking indicator / stream id
  // and seed an optimistic `queuedMessages` entry (rendered with a "Queued"
  // badge) instead of starting a fresh turn.
  addUserMessage: (text: string, attachments?: MessageAttachment[], opts?: { clientMessageId?: string; queued?: boolean }) => void;
  sendInput: (input: string, wireAttachments?: BinaryAttachment[], options?: { isVoice?: boolean; clientMessageId?: string }) => 'sent' | 'queued' | false;
  sendInterrupt: () => 'sent' | 'queued' | false;
  // #5938 (#5943) — cancel one queued follow-up by its clientMessageId before
  // it flushes. Returns false (refused) while disconnected; never offline-queued.
  sendCancelQueued: (clientMessageId: string, sessionId?: string) => 'sent' | false;
  // #6451 — locally drop an optimistic 'Queued' badge whose send failed outright
  // (no server confirm/dequeue will arrive), so it can't linger forever.
  clearOptimisticQueuedMessage: (clientMessageId: string, sessionId?: string) => void;
  sendPermissionResponse: (requestId: string, decision: string, editedInput?: Record<string, string> | null) => 'sent' | 'queued' | false;
  /** #6543: pull the full redacted tool input for a pending permission (a `permission_input` reply lands in `permissionInputs`). */
  requestPermissionInput: (requestId: string) => boolean;
  /**
   * Send a `user_question_response` answer to the server.
   *
   * Accepts three answer shapes:
   * - `string` — legacy single-question / free-text path. Wire shape stays
   *   `{ type, answer, toolUseId? }` so older servers keep working.
   * - `Record<string, string | string[]>` — multi-question form path
   *   (#4604 / #4621 / #4735 / #4761). Populates the `answers` field per
   *   `UserQuestionResponseSchema` and a flattened string `answer` summary.
   * - `{ otherLabel, freeformText }` — single-question Other / freeform
   *   path (#4755, mobile parity with dashboard #4651). Wire payload is
   *   `{answer: <otherLabel>, freeformText: <typed text>}` so the server
   *   drives the two-stage TUI write (Other digit → text-input prompt →
   *   freeform text + Enter).
   */
  sendUserQuestionResponse: (
    answer: string | Record<string, string | string[]> | { otherLabel: string; freeformText: string },
    toolUseId?: string,
  ) => 'sent' | 'queued' | false;
  markPromptAnswered: (messageId: string, answer: string) => void;
  /**
   * #4973 — record a multi-question form submission: stores the
   * comma-joined summary in `answered` and the structured per-question
   * answers map in `answeredAnswers`.
   */
  markPromptAnsweredMulti: (
    messageId: string,
    answers: Record<string, string | string[]>,
  ) => void;
  markPromptAnsweredByRequestId: (requestId: string, answer: string) => void;
}

/**
 * Action group 4 — Models & permissions. Setters for the active model and
 * permission mode (including the auto-mode confirmation flow), plus
 * session-rule registration.
 */
export interface ModelsAndPermissionsActions {
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
  confirmPermissionMode: (mode: string) => void;
  cancelPermissionConfirm: () => void;
  setPermissionRules: (rules: PermissionRule[]) => void;
  // #6771 — replace the durable per-project ("always allow") rule set for the
  // active session's project cwd (SessionRules screen removal path).
  setProjectPermissionRules: (projectRules: PermissionRule[]) => void;
  // #6824 — enable/disable an already-configured MCP server for the active
  // session (BYOK lane). Sends `set_mcp_server_enabled`; the server re-emits
  // `mcp_servers` on success so the SettingsBar switch converges from the
  // broadcast (no optimistic mutation to roll back). The toggle is gated on the
  // server's `canToggle` flag so this only reaches a provider that supports it.
  setMcpServerEnabled: (server: string, enabled: boolean) => void;
}

/**
 * Action group 5 — Discovery fetchers. Server-side data fetching and
 * resume/search flows. Mirrors the `DiscoveryData` slice except for
 * checkpoint mutators (which live with their plan-mode siblings in
 * `CheckpointAndPlanActions`) and web task/web feature actions (which
 * live in `WebTaskActions`).
 */
export interface DiscoveryActions {
  fetchProviders: () => void;
  fetchSlashCommands: () => void;
  fetchCustomAgents: () => void;
  fetchConversationHistory: () => void;
  resumeConversation: (conversationId: string, cwd?: string) => void;
  searchConversations: (query: string) => void;
  clearSearchResults: () => void;
  requestFullHistory: (sessionId?: string) => void;
}

/**
 * Action group 6 — Checkpoint & plan-mode. CRUD for session checkpoints +
 * the plan-mode approve/reject flow. Bundled because both gate continued
 * conversation progress.
 */
export interface CheckpointAndPlanActions {
  createCheckpoint: (name?: string) => void;
  listCheckpoints: () => void;
  // #6767: selective restore — 'files' reverts only the working tree (current
  // session continues), 'conversation' branches the conversation (files kept),
  // 'both' (default) does both. Omitted → server default 'both'.
  restoreCheckpoint: (checkpointId: string, mode?: RestoreCheckpointMode) => void;
  deleteCheckpoint: (checkpointId: string) => void;
  clearPlanState: () => void;
  sendPlanResponse: (sessionId: string, approve: boolean) => void;
}

/**
 * Action group 7 — File system / git / diff operations. All file-browser,
 * directory-listing, git-status/branches/stage/commit, and diff requests
 * plus their result-callback registrations.
 */
export interface FileGitDiffActions {
  // Directory listing
  setDirectoryListingCallback: (cb: ((listing: DirectoryListing) => void) | null) => void;
  requestDirectoryListing: (path?: string) => void;
  // File browser
  setFileBrowserCallback: (cb: ((listing: FileListing) => void) | null) => void;
  setFileContentCallback: (cb: ((content: FileContent) => void) | null) => void;
  requestFileListing: (path?: string) => void;
  requestFileContent: (path: string) => void;
  setFileWriteCallback: (cb: ((result: FileWriteResult) => void) | null) => void;
  // Returns false when the socket is closed (frame not sent) so callers can
  // surface a "not connected" error instead of arming a never-resolving
  // callback / timeout (#6288).
  requestFileWrite: (path: string, content: string) => boolean;
  // Git operations
  setGitStatusCallback: (cb: ((result: GitStatusResult) => void) | null) => void;
  setGitBranchesCallback: (cb: ((result: GitBranchesResult) => void) | null) => void;
  setGitStageCallback: (cb: ((result: GitStageResult) => void) | null) => void;
  setGitCommitCallback: (cb: ((result: GitCommitResult) => void) | null) => void;
  requestGitStatus: () => void;
  requestGitBranches: () => void;
  // Return false when the socket is closed (frame not sent) so callers can
  // surface a "not connected" error instead of arming a never-resolving
  // callback (#6288).
  requestGitStage: (paths: string[]) => boolean;
  requestGitUnstage: (paths: string[]) => boolean;
  requestGitCommit: (message: string) => boolean;
  // Diff viewer
  setDiffCallback: (cb: ((result: DiffResult) => void) | null) => void;
  requestDiff: (base?: string) => void;
}

/**
 * Action group 8 — Server-event dismissals. Mirrors `ServerNotificationData`:
 * dismiss errors, session notifications, and the idle-timeout warning.
 */
export interface ServerNotificationActions {
  dismissServerError: (id: string) => void;
  dismissSessionNotification: (id: string) => void;
  dismissTimeoutWarning: () => void;
  // #4542: notification-prefs round-trip. `refresh` sends
  // `notification_prefs_get`; `setCategory` sends `notification_prefs_set`
  // with a single-category patch (server shallow-merges so other toggles
  // are preserved).
  //
  // #4559: each action returns a boolean indicating whether the WS message
  // actually went on the wire. `true` = sent; `false` = socket was closed
  // and the write was a no-op. Pre-#4559 the silent-drop made the toggle
  // look unresponsive; SettingsScreen now surfaces an inline error so the
  // user knows to retry after reconnect.
  refreshNotificationPrefs: () => boolean;
  setNotificationPrefsCategory: (category: string, enabled: boolean) => boolean;
  // #4543: patch a per-device category override. Sends a single
  // `notification_prefs_set` with `{ devices: { [deviceKey]: { categories:
  // { [category]: enabled } } } }`. Server shallow-merges so other device
  // entries — and other categories under THIS device — survive. `enabled =
  // false` mutes the category on this device only; `true` is the
  // explicit-unmute path that overrides a `false` global default. No-op
  // when deviceKey is empty or the socket is closed.
  //
  // #4559: returns `true` when sent, `false` for both no-op branches
  // (empty deviceKey OR closed socket).
  setNotificationPrefsDevice: (deviceKey: string, category: string, enabled: boolean) => boolean;
  // #4564: drop an entire per-device override entry. Sends
  // `notification_prefs_set` with `{ devices: { [deviceKey]: null } }`, the
  // server interprets the null sentinel as "remove this token from the
  // persisted devices map". Used by the per-row "Clear" button in the
  // known-devices section to drain orphans left when an Expo push token
  // refreshes, an app is reinstalled, or a browser tab loses its
  // localStorage device id — without this surface the on-disk file
  // accumulates dead entries forever.
  //
  // Returns `true` when the WS message was sent, `false` for both no-op
  // branches (empty deviceKey OR closed socket).
  deleteNotificationPrefsDevice: (deviceKey: string) => boolean;
  // #4544: patch the global quiet-hours window. `null` clears the window;
  // a window object (with `timezone`) sets it. Server broadcasts the
  // merged snapshot so all clients update in lockstep.
  //
  // #4559: returns `false` when the socket is closed.
  setNotificationPrefsQuietHours: (window: { start: string; end: string; timezone: string } | null) => boolean;
  // #4544: replace the global bypass-category list wholesale. An empty
  // array means "nothing bypasses, not even errors" — the UI should
  // always send the desired final list.
  //
  // #4559: returns `false` when the socket is closed.
  setNotificationPrefsBypassCategories: (categories: string[]) => boolean;
}

/**
 * Action group 9 — Web tasks (Claude Code Web cloud delegation) and the
 * dev-server preview tunnel close. Bundled because both cover external /
 * out-of-process surfaces the session can hand work off to.
 */
export interface WebTaskActions {
  launchWebTask: (prompt: string, cwd?: string) => 'sent' | false;
  listWebTasks: () => void;
  teleportWebTask: (taskId: string) => void;
  closeDevPreview: (port: number) => void;
}

/**
 * Action group 10 — UI / view / terminal. View-mode toggles, offline cached
 * session entry/exit, input-settings updater, terminal write surface, and
 * the resize handshake. Mirrors `UIViewData`.
 */
export interface UIViewActions {
  setViewMode: (mode: 'chat' | 'terminal' | 'files' | 'system') => void;
  viewCachedSession: () => void;
  exitCachedSession: () => void;
  updateInputSettings: (settings: Partial<InputSettings>) => void;
  appendTerminalData: (data: string) => void;
  clearTerminalBuffer: () => void;
  setTerminalWriteCallback: (cb: ((data: string) => void) | null) => void;
  resize: (cols: number, rows: number) => void;
  // #5835 / #5987 — live PTY mirror channel (read-only on mobile in PR1).
  // Opt in/out of a session's terminal_output stream and report the viewer's
  // grid size. Used by user-shell sessions; claude-tui keeps its legacy 'raw'
  // + `resize` path. Interactive stdin (terminal_input) is deferred — see #6003.
  subscribeTerminalMirror: (sessionId: string) => void;
  unsubscribeTerminalMirror: (sessionId: string) => void;
  sendTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  /** #6313 — force a fresh PTY repaint (sent on (re)subscribe + via a manual "refresh terminal" affordance) so a backpressure-dropped frame that desynced the xterm grid is recovered. */
  requestTerminalResync: (sessionId: string) => void;
  /** #6003 — forward keystrokes from an interactive (user-shell) terminal to the PTY (chunked under the 100k cap). */
  sendTerminalInput: (sessionId: string, data: string) => void;
}

/**
 * ConnectionState — Zustand store shape for the mobile app's connection layer.
 *
 * Composed from per-group data sub-interfaces (#3050 / phase 3a of #2662)
 * AND per-group action sub-interfaces (#3051 / phase 3b of #2662) so the
 * shape is discoverable without scanning the whole file.
 *
 * Encryption state (`encryptionState`, `pendingKeyPair`, `pendingSalt`) lives
 * on `MessageHandlerContext` in `message-handler.ts` (#3049 extracted that
 * `EncryptionContext` sub-interface) — not on this store.
 */
export interface ConnectionState extends
  // Data groups (phase 3a)
  ConnectionSocketData,
  MultiClientSessionData,
  ModelsAndPermissionsData,
  CostBudgetData,
  ServerNotificationData,
  DiscoveryData,
  UIViewData,
  // Action groups (phase 3b)
  ConnectionActions,
  MultiClientSessionActions,
  MessageInputActions,
  ModelsAndPermissionsActions,
  DiscoveryActions,
  CheckpointAndPlanActions,
  FileGitDiffActions,
  ServerNotificationActions,
  WebTaskActions,
  UIViewActions {}
