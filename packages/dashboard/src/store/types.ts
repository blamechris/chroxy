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
  BaseSessionState,
  ChatMessage,
  Checkpoint,
  ConnectedClient,
  ConnectionPhase,
  ContextUsage,
  ConversationSummary,
  CustomAgent,
  InputSettings,
  MessageAttachment,
  ModelInfo,
  SavedConnection,
  SearchResult,
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

export interface ProviderCapabilities {
  permissions: boolean;
  inProcessPermissions: boolean;
  modelSwitch: boolean;
  permissionModeSwitch: boolean;
  planMode: boolean;
  resume: boolean;
  terminal: boolean;
  thinkingLevel?: boolean;
}

export interface ProviderInfo {
  name: string;
  capabilities: ProviderCapabilities;
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
}

export interface GitStatusEntry {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unknown';
}

export interface GitStatusResult {
  branch: string | null;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
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

export type ThinkingLevel = 'default' | 'high' | 'max';

/**
 * Session-scoped auto-approval rule. Mirrors the app-side shape so the
 * "Allow for Session" flow can register auto-approval for a tool.
 */
export interface PermissionRule {
  tool: string;
  decision: 'allow' | 'deny';
  pattern?: string;
}

/**
 * Decision stored when the user resolves a permission prompt. Persists
 * across tab switches (fixes #2833) so the prompt component does not
 * re-render with Allow/Deny buttons after the user already answered.
 *
 * `'allowSession'` means the user clicked "Allow for Session" — the wire
 * decision sent to the server is `'allow'`, and a follow-up
 * `set_permission_rules` message registers a rule for the tool.
 */
export type PermissionDecision = 'allow' | 'deny' | 'allowSession';

export interface LogEntry {
  id: string;
  component: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  sessionId?: string;
}

export interface ServerError {
  id: string;
  category: 'tunnel' | 'session' | 'permission' | 'general';
  message: string;
  recoverable: boolean;
  timestamp: number;
  sessionId?: string;
}

export interface SessionNotification {
  id: string;
  sessionId: string;
  sessionName: string;
  eventType: 'permission' | 'question' | 'completed' | 'error';
  message: string;
  timestamp: number;
  requestId?: string;
}

export interface FilePickerItem {
  path: string;
  type: 'file';
  size: number | null;
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
}

export interface SessionState extends BaseSessionState {
  terminalRawBuffer: string;
  // Files tab: selected file path (persists across tab switches)
  selectedFilePath: string | null;
  thinkingLevel: ThinkingLevel;
  // Per-session auto-approval rules (mirrors server-side sessionRules, updated
  // via permission_rules_updated). Used by the "Allow for Session" flow to
  // append new rules without losing existing ones. Optional: undefined until
  // the server confirms rules for this session.
  sessionRules?: PermissionRule[];
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

  // User explicitly disconnected — prevents auto-reconnect on ConnectScreen mount
  userDisconnected: boolean;

  // Server mode: 'cli' (headless) or 'terminal' (PTY/tmux)
  serverMode: 'cli' | 'terminal' | null;

  // Server context (from auth_ok)
  sessionCwd: string | null;
  defaultCwd: string | null;
  serverVersion: string | null;
  latestVersion: string | null;
  serverCommit: string | null;
  serverProtocolVersion: number | null;

  // Multi-session state
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>;

  // Legacy flat state (used when server doesn't send session_list, i.e. PTY mode)
  claudeReady: boolean;
  streamingMessageId: string | null;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  isIdle: boolean;
  messages: ChatMessage[];

  // Available providers from server
  availableProviders: ProviderInfo[];

  // Available models from server (CLI mode)
  availableModels: ModelInfo[];
  // Server-reported default model short id (from SDK)
  defaultModelId: string | null;

  // Available permission modes from server (CLI mode)
  availablePermissionModes: { id: string; label: string }[];

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

  // Resolved permission decisions keyed by requestId. Persists the
  // user's Allow/Deny/AllowSession choice across component remounts
  // (tab switches), fixing #2833 where the prompt re-rendered as
  // unanswered after the session/output tabs were toggled.
  resolvedPermissions: Record<string, PermissionDecision>;

  // Claude Code Web (cloud task delegation)
  webFeatures: WebFeatureStatus;
  webTasks: WebTask[];

  // Server startup phase (from server_status events)
  // #2836: 'tunnel_warming' is the current name for the DNS-propagation
  // window; 'tunnel_verifying' is retained as a legacy alias that
  // message-handler normalizes to 'tunnel_warming'.
  serverPhase: 'tunnel_warming' | 'tunnel_verifying' | 'ready' | null;
  tunnelProgress: { attempt: number; maxAttempts: number } | null;

  // Shutdown state (reason + ETA for restarting banner countdown)
  shutdownReason: 'restart' | 'shutdown' | 'crash' | null;
  restartEtaMs: number | null;
  restartingSince: number | null;

  // Pending auto permission mode confirmation from server
  pendingPermissionConfirm: { mode: string; warning: string } | null;

  // Slash commands from server
  slashCommands: SlashCommand[];

  // File picker items from list_files
  filePickerFiles: FilePickerItem[] | null;

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

  // Git status callback
  _gitStatusCallback: ((result: GitStatusResult) => void) | null;

  // Diff viewer callback
  _diffCallback: ((result: DiffResult) => void) | null;

  // Offline cached session viewing (shows session screen when disconnected)
  viewingCachedSession: boolean;

  // Environments
  environments: EnvironmentInfo[];

  // Pairing refresh counter — incremented each time the server broadcasts
  // pairing_refreshed so the dashboard can auto-refresh the QR code (#2916).
  pairingRefreshedCount: number;

  // View mode
  viewMode: 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'environments';

  // Input settings
  inputSettings: InputSettings;

  // Raw terminal output buffer (ANSI-stripped, for plain text fallback)
  terminalBuffer: string;

  // Raw terminal buffer with ANSI codes intact (for xterm.js replay on view switch)
  terminalRawBuffer: string;

  // Imperative write callback for xterm.js (bypasses React state for performance)
  _terminalWriteCallback: ((data: string) => void) | null;

  // Actions
  connect: (url: string, token: string, options?: { silent?: boolean; _retryCount?: number }) => void;
  disconnect: () => void;
  loadSavedConnection: () => void;
  clearSavedConnection: () => void;
  setViewMode: (mode: 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'environments') => void;
  addMessage: (message: ChatMessage) => void;
  addUserMessage: (text: string, attachments?: MessageAttachment[], opts?: { clientMessageId?: string }) => void;
  appendTerminalData: (data: string) => void;
  clearTerminalBuffer: () => void;
  setTerminalWriteCallback: (cb: ((data: string) => void) | null) => void;
  updateInputSettings: (settings: Partial<InputSettings>) => void;
  sendInput: (input: string, wireAttachments?: { type: string; name: string; [key: string]: string }[], options?: { isVoice?: boolean }) => 'sent' | 'queued' | false;
  sendInterrupt: () => 'sent' | 'queued' | false;
  sendPermissionResponse: (requestId: string, decision: PermissionDecision) => 'sent' | 'queued' | false;
  /** Mark a permission request as resolved in the store (separate from the
   * wire-level response). Used by PermissionPrompt to render its answered
   * state across remounts (#2833). Safe to call for an already-resolved
   * requestId — last write wins. */
  markPermissionResolved: (requestId: string, decision: PermissionDecision) => void;
  sendUserQuestionResponse: (answer: string, toolUseId?: string) => 'sent' | 'queued' | false;
  markPromptAnswered: (messageId: string, answer: string) => void;
  markPromptAnsweredByRequestId: (requestId: string, answer: string) => void;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
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

  // Git status
  setGitStatusCallback: (cb: ((result: GitStatusResult) => void) | null) => void;
  requestGitStatus: () => void;

  // Diff viewer
  setDiffCallback: (cb: ((result: DiffResult) => void) | null) => void;
  requestDiff: (base?: string) => void;

  // Session actions
  switchSession: (sessionId: string) => void;
  createSession: (opts: { name: string; cwd?: string; provider?: string; model?: string; permissionMode?: string; worktree?: boolean; environmentId?: string }) => void;
  destroySession: (sessionId: string) => void;
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
  restoreCheckpoint: (checkpointId: string) => void;
  deleteCheckpoint: (checkpointId: string) => void;

  // Plan mode actions
  clearPlanState: () => void;

  // Log entry actions
  clearLogEntries: () => void;

  // Server error actions
  addServerError: (message: string) => void;
  dismissServerError: (id: string) => void;

  // Info notification actions
  addInfoNotification: (message: string) => void;
  dismissInfoNotification: (id: string) => void;

  // Session notification actions
  dismissSessionNotification: (id: string) => void;

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

  // Multi-server registry actions
  addServer: (name: string, wsUrl: string, token: string) => ServerEntry;
  removeServer: (serverId: string) => void;
  updateServer: (serverId: string, patch: Partial<Pick<ServerEntry, 'name' | 'wsUrl' | 'token'>>) => void;
  /** Switch to a different server — disconnects, clears session, connects fresh. */
  switchServer: (serverId: string) => void;
  /** Reconnect to a server without clearing session state (auto-reconnect/startup). */
  connectToServer: (serverId: string) => void;

  // Environment actions
  requestEnvironments: () => void;
  createEnvironment: (opts: { name: string; cwd: string; image?: string; memoryLimit?: string; cpuLimit?: string }) => void;
  destroyEnvironment: (environmentId: string) => void;

  // Convenience accessor
  getActiveSessionState: () => SessionState;
}
