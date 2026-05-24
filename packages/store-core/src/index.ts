/**
 * @chroxy/store-core — shared store logic for Chroxy app and dashboard.
 *
 * This package provides platform-agnostic interfaces and adapters
 * for the Zustand-based state management shared between the mobile
 * app (React Native) and web dashboard.
 *
 * Platform-specific behavior (alerts, haptics, push notifications,
 * storage) is injected via the PlatformAdapters interface.
 */

export { DEFAULT_CONTEXT_WINDOW } from './types'

export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  // #3188: auto-evaluator rewrite metadata attached to system ChatMessages
  EvaluatorRewriteMeta,
  SavedConnection,
  ContextUsage,
  CumulativeUsage,
  InputSettings,
  ModelInfo,
  SessionInfo,
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
  ConnectionContext,
  QueuedMessage,
  Checkpoint,
  BaseSessionState,
  InactivityWarning,
  // Git result element types (#3132)
  GitFileStatus,
  GitBranch,
  DiffHunkLine,
  DiffHunk,
  DiffFile,
} from './types'

export type {
  AlertAdapter,
  AlertButton,
  HapticAdapter,
  PlatformAdapters,
  PushAdapter,
  StorageAdapter,
} from './platform'

export {
  consoleAlert,
  noopHaptic,
  noopPush,
} from './platform'

export {
  createStorageAdapter,
  createAsyncStorageAdapter,
} from './storage'

export type {
  ParsedUserInput,
} from './user-input-handler'

export {
  parseUserInputMessage,
} from './user-input-handler'

export type {
  IncomingReplayEntry,
} from './replay-dedup'

export {
  isReplayDuplicate,
} from './replay-dedup'

export type {
  TokenType,
  Token,
  SyntaxRule,
  LanguageDef,
} from './syntax'

export {
  SYNTAX_COLORS,
  getLanguage,
  getSyntaxRules,
  tokenize,
  highlightCode,
} from './syntax'

export type {
  KeyPair,
  EncryptedEnvelope,
  EncryptionState,
} from './crypto'

export {
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
  initPRNG,
  createKeyPair,
  deriveSharedKey,
  nonceFromCounter,
  encrypt,
  decrypt,
  generateConnectionSalt,
  deriveConnectionKey,
} from './crypto'

export {
  stripAnsi,
  nextMessageId,
  withJitter,
  filterThinking,
  createEmptyBaseSessionState,
  ACTIVITY_EVENT_TYPES,
  isActivityEvent,
} from './utils'

// #4123: shared cost formatters used by both dashboard sidebar badge
// (#4073) and mobile session-header badge (#4074). Keeping a single
// implementation avoids drift between the two surfaces.
export {
  formatCostBadge,
  formatCostBreakdown,
} from './cost-format'

export type {
  SessionVisualStatus,
  SessionVisualStatusInput,
} from './session-visual-status'

export {
  SESSION_STALE_AFTER_MS,
  deriveSessionVisualStatus,
} from './session-visual-status'

export type {
  StreamIdResult,
} from './stream-id'

export {
  resolveStreamId,
} from './stream-id'

export {
  applyOrphanDeltas,
} from './orphan-deltas'

// #4242: cheap structural gate for `JSON.parse` on streaming
// `tool_input_delta` accumulators. Amortises N-1 throws on long
// streams (every Bash invocation, every Edit).
export {
  tryParseCompleteJson,
} from './partial-json'

export type {
  DisplayGroup,
} from './group-messages'

export {
  groupMessages,
  applyStreamingOverlay,
  countToolUses,
  summarizeToolCounts,
  formatToolBreakdown,
  formatToolName,
} from './group-messages'

export {
  PASTE_COLLAPSE_CHAR_THRESHOLD,
  PASTE_COLLAPSE_LINE_THRESHOLD,
  PASTE_MARKER_REGEX,
  shouldCollapsePaste,
  formatPasteMarker,
  expandPasteMarkers,
  findActiveMarkerIds,
  detectPasteFromDiff,
} from './paste-text'

export {
  PROVIDER_LABELS,
  getProviderLabel,
  getProviderInfo,
} from './provider-labels'

export type {
  ProviderType,
  ProviderDisplayInfo,
} from './provider-labels'

export type {
  SessionPatch,
  PermissionMode,
  PendingPermissionConfirm,
  PlanAllowedPrompt,
  ThinkingLevel,
  DevPreviewBuilder,
  AgentInfoBuilder,
  ServerMode,
  AuthOkPayload,
  CheckpointRestoredPayload,
  LogLevel,
  LogEntry,
  ClientJoinedResult,
  ClientLeftResult,
  PrimaryChanged,
  ClientFocusChanged,
  ConversationIdPayload,
  HistoryReplayStartPayload,
  HistoryReplayEndPayload,
  PermissionRule,
  PermissionRequestPayload,
  PermissionResolvedPayload,
  PermissionRulesUpdatedPayload,
  SessionTimeoutPayload,
  SessionRestoreFailedPayload,
  SessionWarningPayload,
  SessionSwitchedPayload,
  DirectoryListingPayload,
  FileListingPayload,
  FileContentPayload,
  WriteFileResultPayload,
  DiffResultPayload,
  GitStatusResultPayload,
  GitBranchesResultPayload,
  GitStageResultPayload,
  GitCommitResultPayload,
  AvailableModelsPayload,
  ServerErrorPayload,
  ServerShutdownPayload,
  ServerStatusLegacyPayload,
  WebTaskUpsertPayload,
  WebTaskErrorPayload,
  WebTaskListPayload,
  WebFeatureStatusPayload,
  SearchResultsPayload,
  UserQuestionPayload,
  UserInputPayload,
  MessagePayload,
  ToolStartPayload,
  ToolResultPayload,
  ToolInputDeltaPayload,
  StreamStartPayload,
  StreamEndPayload,
  ResultUsagePayload,
} from './handlers'

export {
  OTHER_OPTION_VALUE,
  OTHER_OPTION_LABEL,
  resolveSessionId,
  handleModelChanged,
  handlePermissionModeChanged,
  handleAvailablePermissionModes,
  handleSessionUpdated,
  handleConfirmPermissionMode,
  handleClaudeReady,
  handleAgentIdle,
  handleAgentBusy,
  handleThinkingLevelChanged,
  handleBudgetWarning,
  handleBudgetExceeded,
  handleBudgetResumed,
  handlePlanStarted,
  handlePlanReady,
  handleInactivityWarning,
  handleDevPreview,
  handleDevPreviewStopped,
  handleAuthOk,
  handleAuthFail,
  handleKeyExchangeOk,
  handleServerMode,
  handleCheckpointCreated,
  handleCheckpointList,
  handleCheckpointRestored,
  handleError,
  handleSessionError,
  handleLogEntry,
  handleClientJoined,
  handleClientLeft,
  handlePrimaryChanged,
  handleClientFocusChanged,
  handleConversationId,
  handleConversationsList,
  handleHistoryReplayStart,
  handleHistoryReplayEnd,
  handlePermissionRequest,
  handlePermissionResolved,
  handlePermissionExpired,
  handlePermissionTimeout,
  handlePermissionRulesUpdated,
  handleSessionList,
  handleSessionContext,
  handleSessionTimeout,
  handleSessionRestoreFailed,
  handleSessionWarning,
  handleSessionSwitched,
  handleDirectoryListing,
  handleFileListing,
  handleFileContent,
  handleWriteFileResult,
  handleSlashCommands,
  handleAgentList,
  handleProviderList,
  handleFileList,
  handleDiffResult,
  handleGitStatusResult,
  handleGitBranchesResult,
  handleGitStageResult,
  handleGitCommitResult,
  handleAgentSpawned,
  handleAgentCompleted,
  handleEnvironmentList,
  handleEnvironmentError,
  handleAvailableModels,
  handleMcpServers,
  handleCostUpdate,
  handleSessionUsage,
  handleServerError,
  handleServerShutdown,
  handleServerStatusLegacy,
  handleWebTaskUpsert,
  handleWebTaskError,
  handleWebTaskList,
  handleWebFeatureStatus,
  handleSearchResults,
  handleUserQuestion,
  handleUserInput,
  handleMessage,
  handleToolStart,
  handleToolResult,
  handleToolInputDelta,
  handleStreamStart,
  handleStreamEnd,
  handleResultUsage,
} from './handlers'
