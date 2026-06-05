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
import type { ServerHostStatusSnapshotMessage } from '@chroxy/protocol'
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
  // #5026: true when the provider runs sessions inside an isolated Docker
  // container (docker-cli, docker-sdk, docker-byok). The dashboard surfaces
  // this with a visual badge + container settings knobs (image / memory /
  // cpu / containerUser) in the New Session modal's advanced section.
  containerized?: boolean;
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
   * #5175 (epic #5170) — Host/Repo Status Control Room: the latest
   * `host_status_snapshot` the server sent in reply to a `host_status_request`.
   * `null` until the first snapshot lands (the Control Room section renders an
   * empty/loading state). Replaced wholesale on each snapshot — the survey is a
   * full picture, not a delta stream.
   */
  hostStatus: ServerHostStatusSnapshotMessage | null;
  /**
   * #5175 — true between dispatching a `host_status_request` and the matching
   * `host_status_snapshot` arriving, so the Refresh button can show a spinner /
   * disabled state. Cleared when a snapshot lands.
   */
  hostStatusLoading: boolean;

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

  // View mode. #5204 — 'control-room' removed: the Control Room is now a
  // session-independent top-level tab in App, not a per-session view mode.
  viewMode: 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'environments' | 'snapshots' | 'pool';

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
  setViewMode: (mode: 'chat' | 'terminal' | 'files' | 'diff' | 'system' | 'console' | 'environments' | 'snapshots' | 'pool') => void;
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
