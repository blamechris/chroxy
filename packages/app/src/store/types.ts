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

export interface ConnectionState {
  // Connection socket (lifecycle fields live in useConnectionLifecycleStore)
  socket: WebSocket | null;

  // Multi-session state
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStates: Record<string, SessionState>;

  // Cost tracking
  totalCost: number | null;
  costBudget: number | null;

  // Available models from server (CLI mode)
  availableModels: ModelInfo[];
  // Server-reported default model short id (from SDK)
  defaultModelId: string | null;

  // Available permission modes from server (CLI mode)
  availablePermissionModes: { id: string; label: string }[];

  // Connected clients (multi-client awareness)
  myClientId: string | null;
  connectedClients: ConnectedClient[];
  primaryClientId: string | null;

  // Follow mode: auto-switch sessions when another client switches
  followMode: boolean;

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

  // Session timeout warning (from server session_warning event)
  timeoutWarning: { sessionId: string; sessionName: string; remainingMs: number; receivedAt: number } | null;

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
  createSession: (name: string, cwd?: string, worktree?: boolean) => void;
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

  // Session rules actions
  setPermissionRules: (rules: PermissionRule[]) => void;

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

  // Session timeout warning
  dismissTimeoutWarning: () => void;

  // Follow mode
  setFollowMode: (enabled: boolean) => void;

  // Convenience accessor
  getActiveSessionState: () => SessionState;
}
