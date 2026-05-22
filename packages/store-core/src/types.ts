/**
 * Shared protocol and message types used by both the mobile app and web dashboard.
 *
 * These types represent the wire protocol between the Chroxy server and its clients.
 * Platform-specific types (SessionState, ConnectionState) remain in each consumer.
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

/**
 * #3188 — auto-evaluator rewrite metadata. Attached to a `system` ChatMessage
 * pushed by the dashboard's `evaluator_rewrite` handler so the rewrite-
 * explanation banner can render the original draft + reasoning when the
 * operator clicks the "see why" affordance. Persisted via session_messages
 * so reconnect/replay re-renders the banner without re-firing the
 * (transient) `evaluator_rewrite` event.
 *
 * `evaluatorIterationId` is the server-generated id used to dedup the
 * system message — receiving the same id twice (e.g. local handler +
 * history replay) must NOT insert a duplicate banner.
 */
export interface EvaluatorRewriteMeta {
  kind: 'rewrite';
  evaluatorIterationId: string;
  originalDraft: string;
  rewritten: string;
  reasoning: string;
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
  /**
   * #3188 — auto-evaluator metadata for `system` messages produced by the
   * `evaluator_rewrite` handler. Optional; only present on system entries
   * that should render the rewrite-explanation banner. The `system`
   * message persists via session_messages so reconnect/replay re-renders
   * the banner from the cached metadata.
   */
  evaluator?: EvaluatorRewriteMeta;
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

/** Default context window size (tokens) used when model metadata doesn't specify one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface ModelInfo {
  id: string;
  label: string;
  fullId: string;
  contextWindow?: number;
}

/**
 * Per-session running totals of token usage and USD cost across every
 * `result` event the server has seen for the session. Emitted as part of
 * the `session_list` snapshot (PR #4088) and updated incrementally via
 * the `session_usage` event (#4072). Subscription-billed providers
 * (claude-tui) leave `costUsd` at 0 since their result events emit
 * `cost: null`. Renderers should treat `costUsd === 0` as "don't render
 * a cost badge" (avoids decoration on subscription sessions).
 */
export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turnsBilled: number;
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
  /**
   * Timestamp of the last meaningful session activity. This is user/agent
   * activity, not passive viewing, so clients can derive stale-idle UI state.
   */
  lastActivityAt?: number;
  conversationId: string | null;
  provider?: string;
  worktree?: boolean;
  // #3185: per-session promptEvaluator toggle. Optional in the type so
  // older servers that don't include the field don't break the parser.
  // Renderers should treat `undefined` as `false` (toggle off).
  promptEvaluator?: boolean;
  // #3209: per-session provider capability flags surfaced via
  // session_list. The dashboard reads these to gate UI affordances
  // (e.g. SkillsPanel disables checkboxes when `skillToggle` is
  // false). Loosely typed because future providers may add fields
  // the type definition doesn't yet enumerate.
  capabilities?: Record<string, boolean>;
  // #3540 / #3567 / #3577: latched stdin-forwarding-disabled flag. PR
  // #3564 persists the SidecarProcess `_stdinForwardingDisabled` latch
  // on session metadata and surfaces it via `session_list` so reconnecting
  // clients (and clients connecting after a server restart) can render
  // the "stdin forwarding lost — restart this session" banner without
  // waiting for a fresh `error{code:'stdin_disabled'}` event (which
  // only fires once on the original sidecar process). Optional in the
  // type so older servers and non-SDK providers that omit the field
  // still parse cleanly; renderers should treat `undefined` as `false`.
  stdinForwardingDisabled?: boolean;
  // #4073 / #4074: cumulative per-session token + cost totals. Optional
  // because older servers don't include the field; renderers should
  // treat `undefined` as "no data, hide the badge."
  cumulativeUsage?: CumulativeUsage;
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

/**
 * Optional one-click recovery action attached to a ServerError.
 *
 * #3587: surfaces an actionable button inside the toast so the operator can
 * recover from a structured error (e.g. INVALID_AUTHOR with a corrected
 * `actualAuthor`) without leaving the toast and hunting for the matching
 * row in another panel. The callback is invoked at click time, then the
 * notification is dismissed by the consumer regardless of whether the
 * callback returned cleanly or threw — see contract on `onClick` below.
 */
export interface ServerErrorAction {
  /** Short button label, e.g. "Try as alice". Rendered verbatim. */
  label: string;
  /**
   * Click handler. Synchronous; void return.
   *
   * Throwing is permitted but the consumer (e.g. the dashboard Toast)
   * MUST swallow the exception (logging it for diagnostics) and dismiss
   * the toast anyway, so a buggy callback can't strand a notification on
   * screen. Async work should be fired-and-forgotten — the action is
   * intended for store calls (`grantCommunitySkillTrust`, etc.) that
   * don't need to await a result before the toast disappears.
   */
  onClick: () => void;
}

/**
 * Server-emitted error captured for the notification/toast UI.
 *
 * Produced by the shared `handleServerError` helper from a `server_error`
 * message. Callers slice an array of these into their `serverErrors` state
 * (typically capped at the most recent 10 entries).
 */
export interface ServerError {
  id: string;
  category: 'tunnel' | 'session' | 'permission' | 'general';
  message: string;
  recoverable: boolean;
  timestamp: number;
  /** Set when the server scoped the error to a specific session. */
  sessionId?: string;
  /**
   * #3587: optional inline action rendered as a button inside the toast.
   * When unset (the common path) the toast renders message-only as before.
   * Not part of the wire shape — populated client-side by handlers that
   * have enough context to offer a one-click recovery (e.g. INVALID_AUTHOR
   * suggesting a retry with the correct author).
   */
  action?: ServerErrorAction;
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

export interface SlashCommand {
  name: string;
  description: string;
  source: 'project' | 'user';
}

// Git result element types (#3132). Concrete shapes used by the dashboard
// and app. Moved up from per-client store/types.ts so per-element validation
// in `@chroxy/store-core/handlers` can reference the canonical type.

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unknown';
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
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

export interface Checkpoint {
  id: string;
  name: string;
  description: string;
  messageCount: number;
  createdAt: number;
  hasGitSnapshot: boolean;
}

/**
 * #3899 — soft inactivity warning state. Set when the server emits an
 * `inactivity_warning` for this session and cleared on any subsequent
 * activity event or on the next user_input. The dashboard / mobile app
 * render a one-click "Status update?" affordance off this field.
 *
 * - `idleMs`: elapsed silence the server reported (matches the schema bound)
 * - `prefab`: short text to send when the user clicks the check-in button
 * - `receivedAt`: client wall-clock when the warning arrived; used purely
 *   for rendering ("Quiet for Ns ago") without re-asking the server.
 */
export interface InactivityWarning {
  idleMs: number;
  prefab: string;
  receivedAt: number;
}

/**
 * Base session state shared by both the mobile app and web dashboard.
 *
 * Each consumer extends this with platform-specific fields:
 * - App adds: activityState, sessionRules
 * - Dashboard adds: terminalRawBuffer, selectedFilePath, thinkingLevel
 */
export interface BaseSessionState {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  claudeReady: boolean;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  lastResultCost: number | null;
  lastResultDuration: number | null;
  sessionCost: number | null;
  // #4073 / #4074: rolling per-session totals updated via the
  // `session_usage` event and seeded from the `session_list` snapshot.
  // Null until the first result event lands.
  cumulativeUsage: CumulativeUsage | null;
  // #4075: latched threshold-crossed warning. Set by the
  // `session_cost_threshold_crossed` event; the server fires only once
  // per session, so this field stays populated until the user dismisses
  // it (sets `dismissedAt`). Renderers should hide the banner when
  // `dismissedAt != null`. Null = no warning has fired.
  costThresholdWarning: { costUsd: number; thresholdUsd: number; dismissedAt: number | null } | null;
  isIdle: boolean;
  /**
   * Wall-clock timestamp (Date.now()) of the most recent activity-bearing
   * server event for this session. The canonical set lives in
   * `ACTIVITY_EVENT_TYPES` (utils.ts): stream_start, stream_delta, stream_end,
   * tool_start, tool_result, message, result, user_question,
   * permission_request. Drives the "Working… last activity Ns ago" indicator
   * (#3758) so users can tell a long-but-still-active turn from a frozen one.
   * Null until the first activity event arrives for the session (e.g. fresh
   * connect, just after history replay clears state).
   */
  lastClientActivityAt: number | null;
  health: SessionHealth;
  activeAgents: AgentInfo[];
  isPlanPending: boolean;
  planAllowedPrompts: { tool: string; prompt: string }[];
  primaryClientId: string | null;
  conversationId: string | null;
  sessionContext: SessionContext | null;
  mcpServers: McpServer[];
  devPreviews: DevPreview[];
  // #3899 — most recent soft inactivity warning for this session, or null
  // when none is outstanding. Both the dashboard and mobile app dispatch
  // the shared `handleInactivityWarning` to populate this slot, and clear
  // it on any activity event (`isActivityEvent`), on `sendInput` once the
  // user replies, and on `socket.onclose` since the server does not
  // replay `inactivity_warning` on reconnect.
  inactivityWarning: InactivityWarning | null;
}
