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

// Re-export shared protocol types from store-core
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  SavedConnection,
  ContextUsage,
  InputSettings,
  ModelInfo,
  SessionInfo,
  AgentInfo,
  ConnectedClient,
  SessionHealth,
  SessionContext,
  McpServer,
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
} from '@chroxy/store-core';

// Import for local use in SessionState/ConnectionState definitions below
import type {
  AgentInfo,
  BaseSessionState,
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ContextUsage,
  ConversationSummary,
  CustomAgent,
  DevPreview,
  InputSettings,
  McpServer,
  MessageAttachment,
  ModelInfo,
  SearchResult,
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

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unknown';
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

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

export interface DiffHunkLine {
  type: 'context' | 'addition' | 'deletion';
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffHunkLine[];
}

export interface DiffFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
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
}

export interface ProviderCapabilities {
  permissions?: boolean;
  inProcessPermissions?: boolean;
  modelSwitch?: boolean;
  permissionModeSwitch?: boolean;
  planMode?: boolean;
  resume?: boolean;
  terminal?: boolean;
  thinkingLevel?: boolean;
  // True if the provider supports session-scoped permission rules
  // (i.e. the "Allow for Session" affordance). Derived server-side from
  // method existence — only providers whose session class implements
  // setPermissionRules report this as true (#3072).
  sessionRules?: boolean;
}

export interface ProviderInfo {
  name: string;
  capabilities?: ProviderCapabilities;
}

export interface SessionState extends BaseSessionState {
  activityState: SessionActivity;
  sessionRules?: PermissionRule[];
}

export interface ServerError {
  id: string;
  category: 'tunnel' | 'session' | 'permission' | 'general';
  message: string;
  recoverable: boolean;
  timestamp: number;
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
 * `useConnectionLifecycleStore`; this interface holds only the live socket.
 */
export interface ConnectionSocketData {
  socket: WebSocket | null;
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
  // Available permission modes from server (CLI mode)
  availablePermissionModes: { id: string; label: string }[];
  // Available providers from server (for session creation UI)
  availableProviders: ProviderInfo[];
  // Pending auto permission mode confirmation from server
  pendingPermissionConfirm: { mode: string; warning: string } | null;
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
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number }) => void;
  disconnect: () => void;
  loadSavedConnection: () => Promise<void>;
  clearSavedConnection: () => Promise<void>;
}

/**
 * Action group 2 — Sessions & multi-client. Session lifecycle (create /
 * switch / destroy / rename / forget), follow-mode toggle, and the
 * convenience accessor for the active session's state.
 */
export interface MultiClientSessionActions {
  switchSession: (sessionId: string, options?: { serverNotify?: boolean; haptic?: boolean }) => void;
  createSession: (name: string, cwd?: string, worktree?: boolean, provider?: string) => void;
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
  addUserMessage: (text: string, attachments?: MessageAttachment[], opts?: { clientMessageId?: string }) => void;
  sendInput: (input: string, wireAttachments?: { type: string; mediaType: string; data: string; name: string }[], options?: { isVoice?: boolean; clientMessageId?: string }) => 'sent' | 'queued' | false;
  sendInterrupt: () => 'sent' | 'queued' | false;
  sendPermissionResponse: (requestId: string, decision: string) => 'sent' | 'queued' | false;
  sendUserQuestionResponse: (answer: string, toolUseId?: string) => 'sent' | 'queued' | false;
  markPromptAnswered: (messageId: string, answer: string) => void;
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
  restoreCheckpoint: (checkpointId: string) => void;
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
  requestFileWrite: (path: string, content: string) => void;
  // Git operations
  setGitStatusCallback: (cb: ((result: GitStatusResult) => void) | null) => void;
  setGitBranchesCallback: (cb: ((result: GitBranchesResult) => void) | null) => void;
  setGitStageCallback: (cb: ((result: GitStageResult) => void) | null) => void;
  setGitCommitCallback: (cb: ((result: GitCommitResult) => void) | null) => void;
  requestGitStatus: () => void;
  requestGitBranches: () => void;
  requestGitStage: (paths: string[]) => void;
  requestGitUnstage: (paths: string[]) => void;
  requestGitCommit: (message: string) => void;
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
