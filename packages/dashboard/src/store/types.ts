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

// Re-export shared protocol types from store-core
export type {
  MessageAttachment,
  ToolResultImage,
  ChatMessage,
  // #3188: re-export auto-evaluator rewrite metadata so dashboard
  // components can type-check banner props without reaching into
  // store-core.
  EvaluatorRewriteMeta,
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
  DiffFile,
  InputSettings,
  LogEntry,
  MessageAttachment,
  ModelInfo,
  GitFileStatus,
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

export interface ProviderCapabilities {
  permissions: boolean;
  inProcessPermissions: boolean;
  modelSwitch: boolean;
  permissionModeSwitch: boolean;
  planMode: boolean;
  resume: boolean;
  terminal: boolean;
  thinkingLevel?: boolean;
  // True if the provider supports session-scoped permission rules
  // (i.e. the "Allow for Session" affordance). Derived server-side from
  // method existence — only providers whose session class implements
  // setPermissionRules report this as true (#3072).
  sessionRules?: boolean;
}

// #3404 audit (F1+F5): per-provider auth state for grey-out + billing panel.
export interface ProviderAuth {
  ready: boolean;
  source: 'env' | 'oauth' | 'none';
  envVar: string | null;
  envVars: string[];
  hint: string;
  detail: string;
}

export interface ProviderInfo {
  name: string;
  capabilities: ProviderCapabilities;
  auth?: ProviderAuth;
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
  // Files tab: selected file path (persists across tab switches)
  selectedFilePath: string | null;
  thinkingLevel: ThinkingLevel;
  // Per-session auto-approval rules (mirrors server-side sessionRules, updated
  // via permission_rules_updated). Used by the "Allow for Session" flow to
  // append new rules without losing existing ones. Optional: undefined until
  // the server confirms rules for this session.
  sessionRules?: PermissionRule[];
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
  /** #3068 — Run the prompt evaluator on a draft. Resolves with the verdict
   * payload, or rejects on disconnect / 60s timeout. Errors from the server
   * arrive as the `error` field on the resolved value, not as a Promise reject. */
  evaluateDraft: (draft: string) => Promise<EvaluatorResultPayload>;
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
  // #3185: toggle the per-session promptEvaluator. Server broadcasts a
  // `prompt_evaluator_changed` event back which updates the session
  // entry — no optimistic update here.
  setPromptEvaluator: (value: boolean) => void;
  // #3805: toggle the per-session Chroxy context hint. Server broadcasts
  // a `chroxy_context_hint_changed` event back which updates the
  // session entry — no optimistic update here.
  setChroxyContextHint: (value: boolean) => void;
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

  // Git status
  setGitStatusCallback: (cb: ((result: GitStatusResult) => void) | null) => void;
  requestGitStatus: () => void;

  // Diff viewer
  setDiffCallback: (cb: ((result: DiffResult) => void) | null) => void;
  requestDiff: (base?: string) => void;

  // Session actions
  switchSession: (sessionId: string) => void;
  createSession: (opts: { name: string; cwd?: string; provider?: string; model?: string; permissionMode?: string; worktree?: boolean; environmentId?: string; skipPermissions?: boolean }) => void;
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

  // Server error actions. #3587: optional `action` attaches a one-click
  // recovery button to the toast. Existing call sites that pass only
  // `message` keep working — `action` is undefined and the toast renders
  // message-only as before.
  addServerError: (message: string, action?: ServerErrorAction, severity?: ServerError['severity']) => void;
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
  refreshByokCredentialsStatus: () => void;
  setByokCredentials: (anthropicApiKey: string) => void;
  clearByokCredentials: () => void;

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
