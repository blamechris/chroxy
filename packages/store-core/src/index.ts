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

// #5424: shared context-window resolution. The 200k default is a Claude
// default — for providers that legitimately report no window (ollama sends
// `contextWindow: null` on purpose) `resolveContextWindow` returns null and
// clients render an "unknown window" state instead of a % against 200k.
// #6769: context-window fill from the occupancy SNAPSHOT (result.contextUsage
// wire field), never from billing usage — a result's `usage` is summed across
// agent-loop rounds and over-reads occupancy ≈N× on an N-round turn. See
// context-window.ts for the full semantic model and per-provider sources.
export {
  isClaudeBackedProvider,
  resolveContextWindow,
  CLAUDE_BACKED_DOCKER_IDS,
  contextOccupancyTokens,
  contextMeterCeiling,
  effectiveContextWindow,
  contextFillPercent,
  CONTEXT_AUTO_COMPACT_RESERVE,
} from './context-window'

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
export { buildProviderLimitationNote } from './provider-capabilities'
export type { DegradableCapabilities } from './provider-capabilities'
export type { OtherFreeformAnswer } from './freeform-answer'

// #6774 — combined "approve plan + auto-accept edits" action. Shared so both
// clients dispatch the mode switch and the approval in the same (mode-first)
// order — the server drops a mid-turn permission-mode change.
export { approvePlanWithAcceptEdits, ACCEPT_EDITS_MODE } from './plan-approval'
export type { ApprovePlanWithAcceptEditsDeps } from './plan-approval'

// #6861 (epic #6760) — `#`-prefix composer quick-append: the shared prefix
// parser, the ack payload parser, and the confirmation formatter (both clients).
export {
  parseMemoryAppend,
  handleAppendMemoryResult,
  formatMemoryAppendNotice,
} from './memory'
export type { MemoryAppendParse, AppendMemoryResultPayload } from './memory'

// #5555.3 / #5555.4 — lastSeq cursor tracking + no-blank-flash replay reconcile.
export {
  resetReplayReconcile,
  recordHistorySeq,
  getHistoryCursors,
  getHistoryCursor,
  reconcileReplayStart,
  reconcileReplayEnd,
  isRebuildInProgress,
  replayDedupCache,
} from './replay-reconcile'

export type {
  // #5589 / #5281 — this client's derived role for a shared session
  SessionRole,
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
  // #6769: occupancy snapshot type (the context meter's only honest input).
  ContextOccupancy,
  CumulativeUsage,
  InputSettings,
  // #4825: consolidated VoiceInputMode union previously declared in
  // packages/app/src/hooks/useSpeechRecognition.ts and
  // packages/dashboard/src/hooks/useVoiceInput.ts.
  VoiceInputMode,
  ModelInfo,
  SessionInfo,
  // #5630/#5629: era-aware billing class union.
  BillingClass,
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
  // #5937: per-session outgoing-message queue entry (mid-turn send queue)
  QueuedSessionMessage,
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
  SigningKeyPair,
  EncryptedEnvelope,
  EncryptionState,
} from './crypto'

export {
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
  initPRNG,
  createKeyPair,
  createSigningKeyPair,
  signExchangeKey,
  verifyExchangeKeySignature,
  // #5616 — identity-rotation continuity-cert primitives (produce + verify).
  // Verify is used internally by key-pinning; both are part of the public
  // rotation API the server (mint, #6198) and tests consume.
  signIdentityRotation,
  verifyIdentityRotation,
  deriveSharedKey,
  nonceFromCounter,
  encrypt,
  decrypt,
  generateConnectionSalt,
  deriveConnectionKey,
} from './crypto'

export type {
  KeyPinDecision,
  KeyPinInput,
} from './key-pinning'

export {
  KEY_PIN_MISMATCH_MESSAGE,
  KEY_PIN_DOWNGRADE_MESSAGE,
  decideKeyPin,
  decideKeyPinWithPairingIdentity,
  decodeEncryptionGate,
} from './key-pinning'

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

// #6453 — shared one-line summary for an answered question prompt (was a
// duplicated copy in the app + dashboard).
export { formatQuestionAnswerSummary } from './question-answer-summary'

// #4123: shared cost formatters used by both dashboard sidebar badge
// (#4073) and mobile session-header badge (#4074). Keeping a single
// implementation avoids drift between the two surfaces.
export {
  formatCostBadge,
  // #6201: session-overview detail register (em-dash empty-state + "<$0.01"
  // friendly label), moved out of the app's SessionOverview so all cost
  // formatters live in this one module.
  formatCostOverview,
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

// #6201: shared duration formatters used by the app + dashboard activity
// indicators (terse "Running Bash · 12s") and stream-stall chip (verbose
// "No response for 5 minutes"). Single-sourced here to stop both surfaces
// re-inlining the same two registers.
export { formatDurationTerse, formatDurationVerbose } from './duration'

// #6201: shared elapsed-time formatters. `formatElapsedAgo` (the fine-grained
// "Ns ago" form) was duplicated in the app + dashboard ActivityIndicator;
// `formatElapsedSince` (the no-suffix terse form) in the app + dashboard
// CheckInChip. Single-sourced here. (Distinct from device-format's coarse
// `formatRelativeTime`, which does "1 min ago / 2 days ago" for last-seen.)
export { formatElapsedSince, formatElapsedAgo } from './elapsed'

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
  // #6182 (Control Room v2 phase 2 / #5964): cross-session aggregation selector.
  SessionDerivedStatus,
  CrossSessionRollup,
  CrossSessionMeta,
  CrossSessionGroupSession,
  CrossSessionGroup,
  CrossSessionActivity,
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
  // #6182: cross-session aggregation (group by repo+worktree + rollups).
  deriveSessionStatus,
  selectCrossSessionActivity,
} from './activity-reducer'

// Chat redesign #6389 (Phase 0 #6390): canonical per-session chat activity
// state machine (idle/thinking/busy/waiting/error) — the input the presence
// rail + composer lozenge read. Distinct from `deriveSessionStatus` above
// (the Control Room cross-session rollup). Mobile re-exports this under its
// original names; the dashboard adopts it in Phase 1.
export { deriveChatActivity } from './chat-activity'
export type { ChatActivityState, SessionChatActivity, ChatActivityInput } from './chat-activity'

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
  BuildChatViewMessagesOptions,
} from './buildChatViewMessages'

export {
  buildChatViewMessages,
  toChatViewMessage,
  // #6799 — shared predicate for the global compact chat filter (mobile parity).
  isHiddenInCompactMode,
  // #6391 — shared thinking footer-stat formatters (both clients render the
  // same `thought for Xs · N tokens` string).
  formatThinkingDuration,
  formatThinkingFooter,
} from './buildChatViewMessages'

// #5793: single source of truth for "is this an AskUserQuestion teardown
// error the user can recover from by resending?" The server's form-driver
// emits ASK_USER_QUESTION_STALL + five MULTISELECT/MULTI_QUESTION codes whose
// copy ends in "Tap Retry"; both clients narrow off this predicate so all of
// them get the stall-chip / retry path (not a dead generic error bubble).
export {
  RETRYABLE_ASK_USER_QUESTION_ERROR_CODES,
  isRetryableAskUserQuestionError,
} from './ask-user-question-errors'

// #4243: shared tool-input summary helpers — both dashboard and mobile
// ToolBubble derive the collapsed-preview string from the same
// field-priority extraction (`command` → `file_path` → `path` →
// `description`) so the Bash early-abort UX (#4063) lights up
// identically on web and React Native.
export {
  getPartialSummary,
  getInputSummary,
  SUPPRESS_RAW_INPUT_TOOLS,
  shouldSuppressRawToolInput,
} from './tool-summary'

// Chat redesign #6389 (Phase 0 #6390): canonical tool-presentation registry
// — verb (label) → kind → icon glyph → color token, defined once so the
// dashboard and mobile op-card renderers can't drift.
export {
  TOOL_KIND_META,
  getToolKind,
  getToolPresentation,
} from './tool-presentation'
export type { ToolKind, ToolPresentation } from './tool-presentation'

// Chat redesign #6389 (Phase 2 #6392): canonical error-presentation registry
// — error code → kind → ARIA role → default headline, defined once so the
// dashboard + mobile ChatErrorFrame can't drift on error copy / a11y.
export { getErrorPresentation } from './error-presentation'
export type { ErrorKind, ErrorPresentation } from './error-presentation'

// Chat redesign #6391 (Phase 1): shared tool-output auto-collapse thresholds —
// the dashboard + mobile ToolBubble collapse a long result past the same line
// boundary.
export {
  TOOL_OUTPUT_COLLAPSE_LINE_THRESHOLD,
  TOOL_OUTPUT_COLLAPSE_HEAD_LINES,
} from './tool-output'

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
  providerSupportsMultiQuestion,
  providerSupportsSingleMultiSelect,
} from './provider-labels'

export type {
  ProviderType,
  ProviderDisplayInfo,
  ProviderRenderCapabilities,
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
  // #5937 — builder for the outgoing-message queue reconcile/dequeue path
  QueuedMessagesBuilder,
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
  SessionRoleInfo,
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
  // #6756 — thinking-stream handler payload shapes.
  ThinkingStreamStartPayload,
  ThinkingDeltaPayload,
  ThinkingStreamEndPayload,
  ResultUsagePayload,
  // #5454 — remaining both-sides duplicates extracted into store-core
  PairFailPayload,
  SessionCostThresholdCrossedPayload,
  NotificationPrefsState,
  NotificationPrefsPayload,
  // #6691 (S-3): orchestration held-detail shape consumed by the dashboard store
  HeldRunDetail,
} from './handlers'

export {
  OTHER_OPTION_VALUE,
  OTHER_OPTION_LABEL,
  resolveSessionId,
  handleModelChanged,
  handleModelChangedPatch,
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
  // #5937 — outgoing-message queue (mid-turn send queue) handlers + helpers
  handleMessageQueued,
  handleMessageDequeued,
  enqueueOptimisticQueuedMessage,
  removeQueuedMessage,
  // #5950 — orphan-badge safety net: reconcile local queue length to the
  // server's authoritative count so a dropped message_dequeued self-heals.
  reconcileQueueLength,
  // #6627 — reconcile the queue on a turn-complete result too, so a stale
  // "Queued" bubble self-heals on the next turn boundary (not only queue events).
  handleResultQueueReconcile,
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
  handleCheckpointFilesRestored,
  handleError,
  handleSessionError,
  // #4879: quiet "user-initiated Stop" confirmation handler — flips
  // stoppedAt/stoppedCode on the target session for the inline status strip
  handleSessionStopped,
  handleLogEntry,
  handleClientJoined,
  handleClientLeft,
  handlePrimaryChanged,
  handleSessionRole,
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
  // #5555 — connect-time bootstrap burst (providers + slash commands + agents)
  handleAuthBootstrap,
  // #5555 (sub-item 7) — quick-tunnel URL rotation push
  handleTunnelUrlChanged,
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
  handleRateLimited,
  handleWebTaskUpsert,
  // #5556 slice 4 — shared filter-and-append upsert for web_task_created/updated.
  applyWebTaskUpsert,
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
  // #6756 — extended-thinking (reasoning) stream handlers.
  handleThinkingStreamStart,
  handleThinkingDelta,
  handleThinkingStreamEnd,
  finalizeThinkingStreams,
  MAX_THINKING_CONTENT_LEN,
  handleResultUsage,
  // #5454 — remaining both-sides duplicates extracted into store-core
  handleRawOutput,
  handleTokenRotated,
  handlePairFail,
  PAIR_FAIL_MESSAGES,
  handleSessionCostThresholdCrossed,
  handleNotificationPrefs,
  // #5454 — pure core of the #554 stream-split block (permission_request)
  resolvePermissionStreamSplit,
  // #6691 (S-3): orchestration list/detail reducers (dashboard-only v1) — the
  // dashboard message handlers are thin wrappers over these; never reimplement
  // the merge/seq logic client-side.
  upsertRunSummary,
  applyRunDelta,
  RUN_TIMELINE_MAX,
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

// #5515 (epic #5514): latency instrumentation primitives — a bounded p50/p95
// ring buffer and the skew-safe RTT splitter, shared so the app and dashboard
// measure token-to-render and uplink/downlink identically.
export { RollingPercentiles, splitRtt } from './latency-stats'
export type { RttSplit, RttSplitInput } from './latency-stats'

// #5516 (epic #5514): dev-only render counter — a process-global tally used by
// the bubble-memoization tests to prove non-tail bubbles don't re-render (and
// re-parse markdown) on a streaming delta flush. Never read on the hot path.
export {
  bumpRenderCount,
  getRenderCount,
  resetRenderCounts,
  renderCountSnapshot,
} from './render-counter'

// #5516 (epic #5514): adaptive client delta-flush interval. Replaces the fixed
// 100ms client flush with an RTT-aware floor (16-33ms on a cheap link, scaling
// toward 100ms when EWMA RTT is poor). Shared so the app and dashboard adapt
// identically; pure + testable with a constant override at each call site.
export {
  resolveDeltaFlushMs,
  DELTA_FLUSH_MIN_MS,
  DELTA_FLUSH_FLOOR_MS,
  DELTA_FLUSH_MAX_MS,
  DELTA_FLUSH_CHEAP_RTT_MS,
  DELTA_FLUSH_POOR_RTT_MS,
  // #5556 (epic #5514): shared stateful EWMA RTT smoother — one implementation
  // for the app/dashboard heartbeat handlers, replacing two hand-copied
  // accumulators with identical first-sample/α-weighting/reset semantics.
  RttSmoother,
  DEFAULT_RTT_EWMA_ALPHA,
  // #5556 (epic #5514): shared delta-flusher wiring — owns the `pendingDeltas`
  // accumulator + coalescing timer + test override, leaving each client only
  // its `applyDeltas` store-mutation closure. Replaces the hand-copied
  // accumulator/timer/scheduleFlush glue in both message-handlers.
  createDeltaFlusher,
} from './delta-flush'
export type {
  DeltaFlusher,
  CreateDeltaFlusherOptions,
  DeltaFlushScheduler,
} from './delta-flush'

// epic #5556, sub-item 3: shared client message dispatch table. A
// `Record<msgType, handler>` registry of pure-delegation cases that were
// byte-identical between the app and dashboard switches, driven through a thin
// per-client `ClientStoreAdapter`. Clients dispatch through `runDispatch`
// first; a table miss falls through to their existing switch, so migration
// stays incremental. Divergent cases stay platform-local (not registered).
export {
  createDispatchTable,
  runDispatch,
  DISPATCH_TABLE_TYPES,
} from './dispatch-table'
export type {
  ClientStoreAdapter,
  DispatchTable,
  DispatchHandler,
  DispatchMessageMap,
  DispatchMessageType,
  // #5653 — file-ops / git wrapper-case adapter surface.
  DispatchCallbackName,
  DispatchCallbackPayload,
} from './dispatch-table'

// epic #5556, sub-item 4: shared client connect-flow orchestration. Owns the
// retry-ladder math, the probe → restart → connect decision tree, and the
// per-socket reconnect dedup that the app and dashboard hand-copied into two
// drifting `connect()` orchestrations. Each client supplies its store
// writes / give-up UX / pairing wiring as callbacks. The `resolveEndpoint`
// callback is the #5597/#5537 LAN/tunnel re-resolution seam, and
// `selectReconnectEndpoint` is the #5537 LAN→tunnel fast-fallback decision.
export {
  runConnectAttempt,
  createReconnectScheduler,
  retryDelayForAttempt,
  selectReconnectEndpoint,
  CONNECT_MAX_RETRIES,
  CONNECT_RETRY_DELAYS,
  RECONNECT_MAX_RUNG,
  LAN_FALLBACK_THRESHOLD,
} from './connect-flow'
export type {
  ProbeResult,
  ConnectEndpoint,
  ConnectFlowScheduler,
  RunConnectAttemptOptions,
  CreateReconnectSchedulerOptions,
  ReconnectScheduler,
  SelectReconnectEndpointInput,
} from './connect-flow'

// #6035 — shared client connection RUNTIME: the heartbeat ping loop and the
// handshake-window timeout, lifted from the two clients' identical
// `startHeartbeat`/`stopHeartbeat`/`armHandshakeTimer`/`clearHandshakeTimer`/
// `_onPong` copies in their message-handler.ts files. The timer mechanics live
// here once; each client injects its `wsSend` (encryption envelope), its
// quality-write sink, and its owned `RttSmoother` (also read by the
// delta-flusher). `createReconnectCounter` packages the backoff-ladder counter
// whose `next` is the `nextRung` the `createReconnectScheduler` above consumes;
// the clients keep their `reconnectAttempt` live binding for now (their suites
// read it directly), so the counter is exported for future single-sourcing.
export {
  createHeartbeatController,
  createReconnectCounter,
  rttQuality,
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  LATENCY_LOG_INTERVAL_MS,
} from './connection-runtime'
export type {
  HeartbeatScheduler,
  HeartbeatSocket,
  HeartbeatController,
  CreateHeartbeatControllerOptions,
  ConnectionQuality,
  ReconnectCounter,
} from './connection-runtime'

// epic #5556, sub-item 5: shared behavioral-contract fixtures. The
// `(wire message in → expected store mutation out)` table is DATA, consumed by
// BOTH clients' test suites (app jest, dashboard vitest) to drive the same rows
// through each client's REAL `handleMessage` switch and assert they agree. Pure
// data + types — exported from the index so both clients resolve it via the
// guaranteed `@chroxy/store-core` entry point (no fragile subpath resolution).
export {
  DISPATCH_FIXTURES,
  SWITCH_FIXTURES,
} from './contract-fixtures/fixtures'
export type {
  ContractFixture,
  FixtureInitialState,
  FixtureExpectation,
} from './contract-fixtures/fixtures'

// epic #5556, sub-item 6: the encrypted-handshake fake-WS driver. The real
// client handshake state machine + a fake server holding real test keypairs;
// both clients run it against their OWN store via a thin HandshakeStoreAdapter
// (same per-client-adapter pattern as the contract fixtures). Exported so the
// app/dashboard suites can drive a replay-into-real-store handshake.
export {
  FakeHandshakeServer,
  FakeHandshakeClient,
  makeMemoryStore,
} from './handshake-e2e/fake-ws'
export type {
  HandshakeStoreAdapter,
  HandshakePhase,
  DriverMessage,
  ReplayEntrySpec,
  FakeServerOptions,
  HandshakeClientOptions,
  MemoryStore,
} from './handshake-e2e/fake-ws'

// #5800 — shared AskUserQuestion multi-question form state machine. Both the
// dashboard's `QuestionPrompt.MultiQuestionForm` and the app's
// `MultiQuestionForm` render against these pure helpers (store-core has no
// `react` dependency, so this exports pure reducers/derivers rather than a
// hook; each client keeps its own tiny `useState`). `isSingleMultiSelectForm`
// replaces the shape-check that was computed independently in both renderers.
export {
  toggleMultiSelect,
  setSingleSelect,
  buildAnswersMap,
  computeCanSubmit,
  isSingleMultiSelectForm,
} from './multi-question-form'
export type {
  MultiQuestionAnswersMap,
  MultiQuestionFormState,
} from './multi-question-form'

// #5800 — shared tool-result-envelope unwrap, hoisted from the dashboard's
// `lib/tool-result-text.ts` so the `{stdout,stderr}` → terminal-text
// normalisation is AVAILABLE for future app use (#5813: the app has no
// tool-result-envelope Output surface today and doesn't call it — no current
// parity gap). Zero behavior change for the dashboard.
export {
  unwrapToolResultText,
} from './tool-result-text'

// #5759 — shared pending-permission derivation (single source of truth for the
// "live, unanswered permission prompt" predicate across both clients).
export {
  isLivePermissionPrompt,
  firstLivePermissionPrompt,
  livePermissionPrompts,
  countLivePermissionPrompts,
  derivePendingPermissionCounts,
  derivePendingPermissionSessions,
  totalPendingPermissions,
  selectNextPendingSession,
} from './pending-permissions'

// #6542 (IDE P3.1): client-side line hunk diff + per-hunk apply — the shared
// foundation for the edit-in-place / per-hunk-review surfaces (#6543 feature B,
// #6544 feature A). The server's git getDiff can't produce a pre-write diff, so
// original → proposed is diffed on the client into the canonical DiffHunk shape;
// applyHunks reconstructs a file from an operator-selected subset of hunks.
export {
  computeHunks,
  applyHunks,
  DEFAULT_CONTEXT_LINES,
  MAX_DIFF_LINES,
} from './hunk-diff'
