/**
 * Shared type definitions for the connection store.
 *
 * Extracted from connection.ts to reduce file size and allow
 * other modules (message-handler, utils) to import types without
 * creating circular dependencies.
 */

/** Attachment metadata stored on a ChatMessage (base64 data cleared after send) */
export interface MessageAttachment {
  id: string;
  type: 'image' | 'document';
  uri: string;
  name: string;
  mediaType: string;
  size: number;
}

/** Base64 image from a tool result (e.g. computer use screenshots) */
export interface ToolResultImage {
  mediaType: string;
  data: string;
}

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking' | 'prompt' | 'error' | 'system';
  content: string;
  tool?: string;
  options?: { label: string; value: string }[];
  requestId?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  toolResultTruncated?: boolean;
  /** Base64 images from tool results (e.g. computer use screenshots) */
  toolResultImages?: ToolResultImage[];
  answered?: string;
  /** Timestamp when the user answered a permission prompt */
  answeredAt?: number;
  expiresAt?: number;
  timestamp: number;
  /** Attachments on user_input messages (images, documents) */
  attachments?: MessageAttachment[];
  /** MCP server name (for tool_use messages from MCP tools) */
  serverName?: string;
}

export interface SavedConnection {
  url: string;
  token: string;
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface InputSettings {
  chatEnterToSend: boolean;
  terminalEnterToSend: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  fullId: string;
}

export interface SessionInfo {
  sessionId: string;
  name: string;
  cwd: string;
  type: 'cli';
  hasTerminal: boolean;
  model: string | null;
  permissionMode: string | null;
  isBusy: boolean;
  createdAt: number;
  conversationId: string | null;
  provider?: string;
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

export interface Checkpoint {
  id: string;
  name: string;
  description: string;
  messageCount: number;
  createdAt: number;
  hasGitSnapshot: boolean;
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

export interface ConversationSummary {
  conversationId: string;
  project: string | null;
  projectName: string;
  modifiedAt: string;
  modifiedAtMs: number;
  sizeBytes: number;
  preview: string | null;
  cwd: string | null;
}

export interface SearchResult {
  conversationId: string;
  projectName: string;
  project: string | null;
  cwd: string | null;
  preview: string | null;
  snippet: string;
  matchCount: number;
}

export interface AgentInfo {
  toolUseId: string;
  description: string;
  startedAt: number;
}

export interface ConnectedClient {
  clientId: string;
  deviceName: string | null;
  deviceType: 'phone' | 'tablet' | 'desktop' | 'unknown';
  platform: string;
  isSelf: boolean;
}

export type SessionHealth = 'healthy' | 'crashed';

export interface SessionContext {
  gitBranch: string | null;
  gitDirty: number;
  gitAhead: number;
  projectName: string | null;
}

export interface McpServer {
  name: string;
  status: string;
}

export interface DevPreview {
  port: number;
  url: string;
}

export interface WebTask {
  taskId: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  result: string | null;
  error: string | null;
}

export interface WebFeatureStatus {
  available: boolean;
  remote: boolean;
  teleport: boolean;
}

export interface SessionState {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  claudeReady: boolean;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  sessionCost: number | null;
  isIdle: boolean;
  health: SessionHealth;
  activeAgents: AgentInfo[];
  isPlanPending: boolean;
  planAllowedPrompts: { tool: string; prompt: string }[];
  primaryClientId: string | null;
  conversationId: string | null;
  sessionContext: SessionContext | null;
  mcpServers: McpServer[];
  devPreviews: DevPreview[];
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

export interface SlashCommand {
  name: string;
  description: string;
  source: 'project' | 'user';
}

export interface CustomAgent {
  name: string;
  description: string;
  source: 'project' | 'user';
}

export type ConnectionPhase =
  | 'disconnected'        // Not connected, no auto-reconnect
  | 'connecting'          // Initial connection attempt
  | 'connected'           // WebSocket open + authenticated
  | 'reconnecting'        // Auto-reconnecting after unexpected disconnect
  | 'server_restarting';  // Health check returns { status: 'restarting' }

/** Context captured from connect() closure for use by the extracted handleMessage(). */
export interface ConnectionContext {
  url: string;
  token: string;
  isReconnect: boolean;
  silent: boolean;
  socket: WebSocket;
}

/** Queued message for offline send buffer */
export interface QueuedMessage {
  type: string;
  payload: unknown;
  queuedAt: number;
  maxAge: number;
}

export interface ConnectionState {
  // Connection
  connectionPhase: ConnectionPhase;
  wsUrl: string | null;
  apiToken: string | null;
  socket: WebSocket | null;

  // Saved connection for quick reconnect
  savedConnection: SavedConnection | null;

  // User explicitly disconnected — prevents auto-reconnect on ConnectScreen mount
  userDisconnected: boolean;

  // Server mode (always 'cli' since v0.2.0)
  serverMode: 'cli' | null;

  // Server context (from auth_ok)
  sessionCwd: string | null;
  serverVersion: string | null;
  latestVersion: string | null;
  serverCommit: string | null;
  serverProtocolVersion: number | null;

  // Multi-session state
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>;

  // Legacy flat state (used when server doesn't send session_list)
  claudeReady: boolean;
  streamingMessageId: string | null;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  isIdle: boolean;
  messages: ChatMessage[];

  // Cost tracking
  totalCost: number | null;
  costBudget: number | null;

  // Available models from server (CLI mode)
  availableModels: ModelInfo[];

  // Available permission modes from server (CLI mode)
  availablePermissionModes: { id: string; label: string }[];

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

  // Server errors forwarded over WebSocket (last 10)
  serverErrors: ServerError[];

  // Background session notifications (permission, question, completed, error)
  sessionNotifications: SessionNotification[];

  // Claude Code Web (cloud task delegation)
  webFeatures: WebFeatureStatus;
  webTasks: WebTask[];

  // Shutdown state (reason + ETA for restarting banner countdown)
  shutdownReason: 'restart' | 'shutdown' | 'crash' | null;
  restartEtaMs: number | null;
  restartingSince: number | null;

  // Pending auto permission mode confirmation from server
  pendingPermissionConfirm: { mode: string; warning: string } | null;

  // Slash commands from server
  slashCommands: SlashCommand[];

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
  _fileWriteCallback: ((result: FileWriteResult) => void) | null;

  // Git callbacks
  _gitStatusCallback: ((result: GitStatusResult) => void) | null;
  _gitBranchesCallback: ((result: GitBranchesResult) => void) | null;
  _gitStageCallback: ((result: GitStageResult) => void) | null;
  _gitCommitCallback: ((result: GitCommitResult) => void) | null;

  // Diff viewer callback
  _diffCallback: ((result: DiffResult) => void) | null;

  // Offline cached session viewing (shows session screen when disconnected)
  viewingCachedSession: boolean;

  // View mode
  viewMode: 'chat' | 'terminal' | 'files';

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
  loadSavedConnection: () => Promise<void>;
  clearSavedConnection: () => Promise<void>;
  setViewMode: (mode: 'chat' | 'terminal' | 'files') => void;
  addMessage: (message: ChatMessage) => void;
  addUserMessage: (text: string, attachments?: MessageAttachment[]) => void;
  appendTerminalData: (data: string) => void;
  clearTerminalBuffer: () => void;
  setTerminalWriteCallback: (cb: ((data: string) => void) | null) => void;
  updateInputSettings: (settings: Partial<InputSettings>) => void;
  sendInput: (input: string, wireAttachments?: { type: string; mediaType: string; data: string; name: string }[], options?: { isVoice?: boolean }) => 'sent' | 'queued' | false;
  sendInterrupt: () => 'sent' | 'queued' | false;
  sendPermissionResponse: (requestId: string, decision: string) => 'sent' | 'queued' | false;
  sendUserQuestionResponse: (answer: string, toolUseId?: string) => 'sent' | 'queued' | false;
  markPromptAnswered: (messageId: string, answer: string) => void;
  markPromptAnsweredByRequestId: (requestId: string, answer: string) => void;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
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

  // Session actions
  switchSession: (sessionId: string, options?: { serverNotify?: boolean; haptic?: boolean }) => void;
  createSession: (name: string, cwd?: string) => void;
  destroySession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  forgetSession: () => void;

  // Slash commands
  fetchSlashCommands: () => void;

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
  sendPlanResponse: (sessionId: string, approve: boolean) => void;

  // Server error actions
  dismissServerError: (id: string) => void;

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

  // Convenience accessor
  getActiveSessionState: () => SessionState;
}
