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

// #4853: runtime type-guard for `VoiceInputMode` — keyed off an
// exhaustive `Record<VoiceInputMode, true>` so widening the union is a
// TS error in the guard, not a silent drop at the call site.
export { isVoiceInputMode } from './types'

// #4875 / #4901: shared typed predicate + type for the AskUserQuestion
// "Other / freeform" answer payload. Mobile store + mobile screen (#4875)
// and the dashboard store + `QuestionPrompt.tsx` (#4901) all narrow off
// this single guard, so widening `SelectOptionValue` to a third object
// shape can't silently misroute it as freeform on either client.
export { isFreeformAnswer } from './freeform-answer'
export type { OtherFreeformAnswer } from './freeform-answer'

export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  // #5016 — one nested wire event from a Task subagent, attached to
  // the parent Task tool_use bubble via `ChatMessage.childAgentEvents[]`.
  ChildAgentEvent,
  // #4604 Chunk B — one entry per question in a multi-question AskUserQuestion form
  ChatMessageQuestion,
  // #3188: auto-evaluator rewrite metadata attached to system ChatMessages
  EvaluatorRewriteMeta,
  SavedConnection,
  ContextUsage,
  CumulativeUsage,
  InputSettings,
  // #4825: consolidated VoiceInputMode union previously declared in
  // packages/app/src/hooks/useSpeechRecognition.ts and
  // packages/dashboard/src/hooks/useVoiceInput.ts.
  VoiceInputMode,
  ModelInfo,
  SessionInfo,
  AgentInfo,
  // #4308: ActiveTool — one entry per in-flight tool call, kept on
  // BaseSessionState.activeTools and driven by tool_start / tool_result.
  ActiveTool,
  // #4307: PendingBackgroundShell — one entry per backgrounded Bash
  // shell the session is still waiting on. Survives turn-end (the
  // whole point of #4307); clears when the agent calls BashOutput or
  // the session is destroyed.
  PendingBackgroundShell,
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
  // #4653: chroxy-side intervention ring (multi-q deny etc.)
  SessionIntervention,
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
  // #4653: ring cap for SessionIntervention list on BaseSessionState
  MAX_SESSION_INTERVENTIONS,
} from './utils'

// #4123: shared cost formatters used by both dashboard sidebar badge
// (#4073) and mobile session-header badge (#4074). Keeping a single
// implementation avoids drift between the two surfaces.
export {
  formatCostBadge,
  formatCostBreakdown,
  // #5039: error-path partial-cost helper shared by dashboard toast
  // sub-line and mobile Alert.alert body.
  formatPartialCostLine,
  // #5058 / #5094: canonical token-count formatters. `formatTokens` is the
  // STANDARD (uppercase K, 2-decimal M) used by the sidebar + breakdown
  // surfaces; `formatTokensCompact` is the COMPACT (lowercase k, 1-decimal
  // M) used by the single-line header meter + context chip.
  formatTokens,
  formatTokensCompact,
} from './cost-format'
export type { ErrorPartialCost } from './cost-format'

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

// #5162 (epic #5159): platform-agnostic Control Room activity reducer. The
// dashboard panel (#5163) and future mobile parity both derive the per-session
// activity tree from this one implementation (snapshot replace + self-healing
// upsert-by-id deltas + terminal-retention prune + tree selector).
export type {
  SessionActivityState,
  ActivityState,
  ActivityTreeNode,
} from './activity-reducer'

// #5163: re-export the wire-level activity types from the protocol through the
// store-core surface so the dashboard panel + future mobile parity consume the
// activity entry/kind/status types from the same single import as the reducer
// and selector (rather than reaching into @chroxy/protocol directly).
export type {
  ActivityEntry,
  ActivityKind,
  ActivityStatus,
  ActivityOutputRef,
} from '@chroxy/protocol'

export {
  MAX_TERMINAL_ENTRIES_PER_SESSION,
  createEmptyActivityState,
  applyActivitySnapshot,
  applyActivityDelta,
  clearSessionActivity,
  selectSessionEntries,
  selectActivityTree,
} from './activity-reducer'

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

// #4806: shared ChatView message pipeline — lifted from dashboard's
// `useChatMessages` hook so both dashboard and mobile derive the same
// chat-view representation (closes the silent #4615 stalled-prompt gap
// on mobile as a side effect).
export type {
  ChatViewMessage,
  ChatViewPipelineResult,
} from './buildChatViewMessages'

export {
  buildChatViewMessages,
  toChatViewMessage,
} from './buildChatViewMessages'

// #4243: shared tool-input summary helpers — both dashboard and mobile
// ToolBubble derive the collapsed-preview string from the same
// field-priority extraction (`command` → `file_path` → `path` →
// `description`) so the Bash early-abort UX (#4063) lights up
// identically on web and React Native.
export {
  getPartialSummary,
  getInputSummary,
} from './tool-summary'

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

// #4569: curated IANA timezone short-list for the notification
// quiet-hours editor. Single source of truth shared by the dashboard's
// SettingsPanel and the mobile SettingsScreen so the two pickers can't
// drift apart when one is extended.
export {
  QUIET_HOURS_TIMEZONE_CHOICES,
  buildQuietHoursTimezoneList,
} from './timezones'

export type {
  SessionPatch,
  PermissionMode,
  PendingPermissionConfirm,
  PlanAllowedPrompt,
  ThinkingLevel,
  DevPreviewBuilder,
  // #4653 — builder for the chroxy-side intervention append/dedup/ring-cap path
  SessionInterventionBuilder,
  AgentInfoBuilder,
  PendingBackgroundShellsBuilder,
  // #4767 — centralised session_list dispatch (GC + cumulativeUsage + pendingShells seeding)
  SessionListPatches,
  ServerMode,
  AuthOkPayload,
  AuthOkWebFeatures,
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
  StreamDeltaContext,
  PendingDelta,
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
  // #4653 — chroxy-side multi-question deny notification
  handleMultiQuestionIntervention,
  applyInterventionBuilder,
  handleDevPreview,
  handleDevPreviewStopped,
  handleAuthOk,
  parseConnectedClients,
  handleAuthFail,
  handleKeyExchangeOk,
  handleServerMode,
  handleCheckpointCreated,
  handleCheckpointList,
  handleCheckpointRestored,
  handleError,
  handleSessionError,
  // #4879: quiet "user-initiated Stop" confirmation handler — flips
  // stoppedAt/stoppedCode on the target session for the inline status strip
  handleSessionStopped,
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
  // #4767 — centralised session_list dispatch helpers (used by both app + dashboard)
  buildSessionListPatches,
  cumulativeUsageEquals,
  chunkSubscribeSessionIds,
  SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
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
  // #5016 — Task subagent nested progress (one wire event per child
  // `tool_start` / `tool_result` / `tool_input_delta` / `stream_delta`).
  handleAgentEvent,
  handleBackgroundWorkChanged,
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
  sharedStreamDelta,
  handleStreamEnd,
  handleResultUsage,
} from './handlers'

// #4591: shared device-list formatters. Eliminates duplicated copies of
// `formatPlatform` + `formatRelativeTime` from dashboard SettingsPanel
// and mobile SettingsScreen (both added in #4587).
export {
  formatPlatform,
  formatRelativeTime,
} from './device-format'

// #4771: shared WS close-code + HTTP health-check error message
// helpers. Previously the app had a well-tested mapping while the
// dashboard reimplemented only the health-check path inline (with a
// less-detailed split) and ignored `event.code` on socket.onclose
// entirely — a 4008 backpressure eviction surfaced as a generic
// "Connection lost" rather than the "server was overwhelmed,
// reconnecting" copy. Centralised here so both surfaces stay in sync.
export {
  getWsCloseMessage,
  getHealthCheckErrorMessage,
} from './ws-errors'
