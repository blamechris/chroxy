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

/**
 * #4604 Chunk B — one entry per question in a multi-question
 * AskUserQuestion form. `questions[0]` always mirrors the legacy
 * top-level `content` + `options` on the ChatMessage so single-question
 * renderers stay byte-compatible; renderers that handle multi-question
 * forms iterate `questions[]` directly and call `onSelect(answersMap)`
 * with one entry per question.
 */
export interface ChatMessageQuestion {
  question: string;
  options: { label: string; value: string }[];
  /** `true` for multi-select questions (renderer shows checkboxes, server emits Tab between digits) */
  multiSelect?: boolean;
}

export interface ChatMessage {
  id: string;
  type: 'response' | 'user_input' | 'tool_use' | 'thinking' | 'prompt' | 'error' | 'system';
  content: string;
  tool?: string;
  options?: { label: string; value: string }[];
  /**
   * #4604 Chunk B — full N-question payload for AskUserQuestion `prompt`
   * messages. Always populated for `type === 'prompt'` messages produced
   * by `handleUserQuestion`; `questions[0].question` always equals the
   * top-level `content` and `questions[0].options` always equals the
   * top-level `options` so legacy single-question renderers keep
   * working without consulting this field. Renderers that drive
   * multi-question forms iterate this array.
   */
  questions?: ChatMessageQuestion[];
  requestId?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  toolResultTruncated?: boolean;
  /**
   * #4476: structured error code for `type: 'error'` bubbles. Mirrors the
   * `code` field on `ServerMessageSchema` — populated when the server tags
   * an error with a known machine-readable identifier (e.g. `'stream_stall'`
   * from #4475). Renderers can switch on this to surface a distinct
   * affordance (chip + retry button) instead of the generic red bubble.
   * Undefined for legacy errors that carry no code.
   */
  code?: string;
  /**
   * #4947 / #5006: only set on `type: 'error'` bubbles whose `code` is one
   * of the two resume-failure codes emitted by CliSession's
   * `_handleChildClose` resume-failure path:
   *   - `'resume_unknown'` (server PR #4944) — recoverable: the CLI
   *     rejected `--resume <id>` and chroxy has already auto-fallen-back
   *     to a fresh conversation.
   *   - `'resume_unknown_exhausted'` (server PR #5004) — terminal: the
   *     post-fallback retry ALSO matched the unknown-resume pattern; the
   *     server has stopped auto-respawning and the user must start a
   *     fresh session manually.
   *
   * Carries the conversation id chroxy passed to `claude --resume <id>`
   * before the CLI rejected it. The dashboard / mobile
   * `ResumeUnknownChip` surfaces this as small mono-spaced subtext under
   * the headline so operators investigating a recurring resume failure
   * can correlate against the persisted state file
   * (`resumeConversationId` in `~/.chroxy/session-state.json`) without
   * grepping logs. Undefined for every other error code and for
   * pre-#4944 servers that don't emit the field.
   */
  attemptedResumeId?: string;
  /** Base64 images from tool results (e.g. computer use screenshots) */
  toolResultImages?: ToolResultImage[];
  /**
   * #4081: accumulated partial JSON streamed via `tool_input_delta`
   * (server PR #4080). Concatenated string of every `partialJson` chunk
   * the server has emitted for this tool_use, in arrival order. Set on
   * `tool_use` ChatMessages only; remains undefined on bubbles whose
   * server-emitted input arrived in one shot (legacy non-streaming
   * providers, or short inputs that the SDK never split into deltas).
   *
   * Renderers show this as a code block while streaming. Best-effort
   * JSON.parse — partial JSON mid-stream is inherently unparseable, so
   * unparseable chunks render verbatim rather than as an error. Once
   * `toolResult` is populated the bubble switches to the standard
   * result view and `toolInputPartial` becomes informational only
   * (preserved for history/replay).
   */
  toolInputPartial?: string;
  /**
   * #4263 — set to `true` exactly once when `tool_input_delta`
   * accumulation hits {@link MAX_TOOL_INPUT_PARTIAL_LEN} and subsequent
   * chunks are dropped. The boolean is the canonical "truncated"
   * indicator on a `tool_use` bubble; pre-#4263 code relied on the
   * literal `...[truncated]` suffix appended to `toolInputPartial`,
   * which mis-fired on the rare case where a legitimate input ended
   * with that 14-char string at a chunk boundary. Renderers MAY surface
   * a "truncated" affordance from this flag; consumers checking for
   * the terminal state (e.g. handleToolInputDelta's idempotent drop)
   * MUST prefer this boolean and fall back to the legacy suffix check
   * only for backwards compatibility with rehydrated state.
   */
  toolInputPartialTruncated?: boolean;
  answered?: string;
  /**
   * #4973 — structured per-question answers map recorded when the user
   * submits a multi-question AskUserQuestion form. Keyed by question text,
   * with single-select values as a `string` and multi-select values as a
   * `string[]` of chosen option values. The flat `answered` field still
   * holds the comma-joined human-readable summary (for chat history /
   * legacy renderers); this field lets the multi-question summary chip
   * map chosen values back to their option labels per question without
   * re-parsing the delimited summary string.
   */
  answeredAnswers?: Record<string, string | string[]>;
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
  /**
   * #5016 — Task subagent child progress, attached to the parent's
   * `tool_use` (Task) bubble. Each entry is one wire event the child
   * emitted (re-emitted by the parent as `agent_event` and routed back
   * to the parent bubble by `handleAgentEvent`). Renderers iterate this
   * list to surface nested sub-bubbles inside the Task tool_call.
   *
   * Only set on `type: 'tool_use'` bubbles whose `toolUseId` matches a
   * Task tool_use whose subagent emitted at least one progress event.
   * Undefined for all other bubbles and for Task tool_use bubbles whose
   * child finished without intermediate output (rare — child went
   * straight from spawn to final text in one shot).
   */
  childAgentEvents?: ChildAgentEvent[];
}

/**
 * #5016 — One nested wire event emitted by a Task subagent. Kept
 * shape-loose because the underlying payload mirrors the server's
 * `tool_start` / `tool_result` / `tool_input_delta` / `stream_delta`
 * event shapes, and a strict union here would duplicate that surface.
 * Renderers switch on `type` and access the fields they recognise.
 */
export interface ChildAgentEvent {
  /** Wire event name (`'tool_start'`, `'tool_result'`, `'tool_input_delta'`, `'stream_delta'`). */
  type: string;
  /** Verbatim payload from the child's event (shape depends on `type`). */
  payload: Record<string, unknown>;
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

/**
 * Voice input behaviour. `'continuous'` keeps the mic open across silence
 * gaps until the user explicitly clicks stop (the hook restarts Web Speech
 * recognition on each silence-triggered `onend`). `'auto-pause'` lets the
 * browser auto-stop on silence — the previous behaviour, kept for users who
 * prefer it (#4785). Defaults to `'continuous'` so new users get the
 * click-to-start / click-to-stop experience by default.
 *
 * #4825: consolidated here so the mobile `useSpeechRecognition` hook, the
 * dashboard `useVoiceInput` hook, the dashboard `SettingsPanel` change
 * handler, and the mobile `SettingsScreen` picker all share one declaration.
 *
 * Compile-time enforcement is only as strong as the consuming pattern: sites
 * that exhaustively key a `Record<VoiceInputMode, …>` (e.g. the dashboard
 * `SettingsPanel` change handler, the mobile `SettingsScreen` picker tuple
 * typed as `{ value: VoiceInputMode; … }[]`) will be flagged by TS when the
 * union widens. Sites that validate untrusted runtime input (localStorage
 * rehydrate, SecureStore rehydrate, wire payloads) MUST use the
 * {@link isVoiceInputMode} guard below — it is keyed off the same exhaustive
 * `Record<VoiceInputMode, true>` map, so widening the union to a new mode
 * without updating that map is a TS error (missing property). Canonical
 * rehydrate-path consumers:
 * - `packages/dashboard/src/store/connection.ts` — localStorage (#4853)
 * - `packages/app/src/store/connection.ts` — SecureStore (#4872)
 */
export type VoiceInputMode = 'continuous' | 'auto-pause';

/**
 * #4853 — exhaustive `Record<VoiceInputMode, true>` map driving
 * {@link isVoiceInputMode}. Adding a new variant to the `VoiceInputMode`
 * union without listing it here is a TS error (missing property), so the
 * guard cannot silently drop a new mode the way a hand-written `===`
 * chain would. The same pattern is used inline by the dashboard
 * `SettingsPanel` change handler (#4825); the guard centralises it for
 * every other validation site (localStorage rehydrate, wire payload
 * validation, etc.) so they all share one source of truth.
 *
 * Module-scope `const` rather than a closure-local literal so the
 * underlying object identity is stable and the V8 hidden class doesn't
 * thrash on hot rehydrate paths.
 */
const VOICE_INPUT_MODES: Record<VoiceInputMode, true> = {
  continuous: true,
  'auto-pause': true,
};

/**
 * #4853 — runtime type-guard for `VoiceInputMode`. Returns `true` only
 * when `value` is exactly one of the union members declared above; every
 * non-string input (undefined, null, number, object, array) returns
 * `false` without throwing. Use at boundary sites that accept untrusted
 * input — localStorage rehydrate, JSON.parse of a wire payload, etc.
 *
 * The narrowing predicate (`value is VoiceInputMode`) lets callers
 * assign directly without an unsafe cast once the guard passes.
 */
export function isVoiceInputMode(value: unknown): value is VoiceInputMode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(VOICE_INPUT_MODES, value);
}

export interface InputSettings {
  chatEnterToSend: boolean;
  terminalEnterToSend: boolean;
  voiceInputMode: VoiceInputMode;
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
 * priced `result` event the server has seen for the session.
 *
 * Subscription-billed providers (claude-tui) emit `cost: null` on their
 * result events; the server's `_trackUsage` is gated on
 * `Number.isFinite(data.cost)` (#4088) and skips entirely for those —
 * so subscription sessions' totals stay at all-zero, NOT just `costUsd`.
 * Renderers should treat `costUsd === 0` (or the whole field being null)
 * as "no cost badge."
 *
 * Surfaced via the `session_list` snapshot (#4088) and incrementally
 * updated via the `session_usage` event (#4072).
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
  // #3805: per-session opt-in Chroxy context hint flag. Optional so
  // older servers (pre-#3805) that omit the field don't break the
  // parser. Renderers should treat `undefined` as `false` (toggle off).
  chroxyContextHint?: boolean;
  // #4660: per-session user-authored preamble prepended to the system
  // prompt every turn. Optional so older servers (pre-#4660) that omit
  // the field don't break the parser. Renderers should treat
  // `undefined` as empty string (no preamble injected).
  sessionPreamble?: string;
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
  /**
   * #4307: snapshot of backgrounded shells the session is still waiting
   * on. Optional because pre-#4307 servers omit the field; consumers
   * should treat `undefined` as `[]`. Always an array when present
   * (#4307-aware servers send `[]` when no work is pending). The
   * SessionInfo entry's value is the late-joiner seed; the live update
   * channel is the `background_work_changed` event.
   */
  pendingBackgroundShells?: PendingBackgroundShell[];
}

export interface AgentInfo {
  toolUseId: string;
  description: string;
  startedAt: number;
}

/**
 * #4308 — one entry per in-flight tool call. Pushed when `tool_start`
 * arrives, removed (by `toolUseId`) when the matching `tool_result` lands,
 * and cleared en-masse on `agent_idle` / `result` as a safety net so a
 * dropped/missed result can't leave a phantom running indicator.
 *
 * An array (not a singleton) because there can legitimately be multiple
 * in-flight tools at once: a sub-agent's tool call while the parent agent
 * is still mid-turn, or parallel tool calls from a single assistant turn.
 * Renderers that only have room for one label can use
 * `activeTools[activeTools.length - 1]` to surface the most-recent.
 *
 * Distinct from `messages[].type === 'tool_use'` (which derives in-flight
 * state by walking the array): `activeTools` is a small, fast slot driven
 * by the wire events directly. The derive-from-messages path remains a
 * fallback for history replay and other paths that don't fire tool_start
 * (#4319 / #4337).
 *
 * `tool` is the tool's logical name (`'Bash'`, `'Read'`, etc.) — same value
 * the server sends on `tool_start`. `serverName` is set only for MCP tools
 * so renderers can route through `formatToolName(tool, serverName)`. `input`
 * is the raw tool input verbatim from the wire (best-effort; may be missing
 * when the input streams via `tool_input_delta`).
 */
export interface ActiveTool {
  toolUseId: string;
  tool: string;
  serverName?: string;
  input?: unknown;
  startedAt: number;
}

/**
 * #4307 — one entry per backgrounded `Bash` shell the session is still
 * waiting on. Mirrors the server-side `ServerPendingBackgroundShellSchema`.
 *
 * Driven by the `background_work_changed` event and seeded from the
 * `session_list` snapshot's `pendingBackgroundShells` field for late
 * joiners. The entry persists across turn-end (the whole point: the
 * agent's turn finished but the shell is still running); it clears when
 * the agent calls `BashOutput` on the matching id, or when the session
 * is destroyed.
 *
 * `shellId` is the short alphanumeric token Claude prints in its
 * "Command running in background with ID: <id>" tool_result (e.g.
 * `brk57kt6pm`). `command` is the original Bash command text so the
 * activity indicator can show "waiting on `<command>`" without a
 * round-trip. `startedAt` is the server-side wall-clock at register
 * time so elapsed-time display doesn't depend on client clock skew.
 */
export interface PendingBackgroundShell {
  shellId: string;
  command: string;
  startedAt: number;
}

/**
 * #5431 — one outstanding background task derived from the session
 * transcript: a `run_in_background` Bash or Agent call, or a Monitor
 * stream, whose completion task-notification hasn't landed yet.
 * `toolUseId` is the launching tool_use id (the pairing key);
 * `description` is the tool call's human-readable description (or a
 * truncated Agent prompt); `startedAt` is epoch ms from the transcript
 * entry's timestamp.
 */
export interface TranscriptBackgroundTask {
  toolUseId: string;
  kind: 'bash' | 'agent' | 'monitor';
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
  /**
   * #4148: severity used by the toast UI to differentiate non-fatal
   * server signals (e.g. MAX_TOOL_ROUNDS_REACHED) from destructive
   * STREAM_ERROR / ABORT events. Defaults to 'error' when unset so
   * existing callers continue to render as red error toasts.
   */
  severity?: 'error' | 'warning';
  /**
   * #5039: optional partial-cost sub-line surfaced when PR #5037 folded
   * any parent + Task subagent rounds onto an error envelope before the
   * error fired. Rendered as a small secondary text under the main
   * toast message; absent for every error path that didn't carry a
   * usable partial snapshot. Pre-formatted (via
   * `formatPartialCostLine`) so the dashboard and mobile surfaces can
   * share copy without re-implementing the cost/token formatting.
   */
  partialCostLine?: string;
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
  /**
   * Origin of the command.
   * - `builtin`: provider-baked (e.g. `/clear`, `/compact`, `/model`) — see
   *   packages/server/src/builtin-commands.js. Always rendered with a "built-in" badge
   *   and pinned above project/user entries in the picker (#3856).
   * - `project`: markdown file in `<cwd>/.claude/commands/`.
   * - `user`: markdown file in `~/.claude/commands/`.
   */
  source: 'builtin' | 'project' | 'user';
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
 * #4653 — one entry per chroxy-side intervention surfaced to the user.
 *
 * Currently only `multi_question` (the permission-hook deny for multi-question
 * AskUserQuestion forms shipped in #4648). The shape is intentionally
 * extensible so future intervention kinds (e.g. sibling-deny from #4668,
 * stream-stall auto-recovery from #4475) can land here without a wire
 * version bump.
 *
 * - `kind`: discriminator the renderer switches on for icon + copy
 * - `toolUseId`: stable id of the original tool_use; the dashboard dedups
 *   repeats by this so a stuck model re-emitting the same payload doesn't
 *   inflate the counter falsely
 * - `count`: secondary detail (e.g. number of questions in the denied form)
 * - `timestamp`: server wall-clock when the deny happened
 */
export interface SessionIntervention {
  kind: 'multi_question';
  toolUseId: string;
  count: number;
  timestamp: number;
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
  // `session_usage` event and seeded from the `session_list` snapshot
  // (which always carries an all-zero block when the session has no
  // priced result events yet). Null only when no snapshot has arrived
  // — the field stays an all-zero CumulativeUsage even for sessions
  // that have never priced a turn (e.g. subscription-billed).
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
  /**
   * #4879 — quiet "user-initiated Stop" confirmation marker. Set by the
   * `session_stopped` handler (which receives the server-broadcast wire
   * message wired in #4868) to `Date.now()` when the child process exits
   * cleanly after the user tapped Stop. Null at all other times.
   *
   * Distinct from `health: 'crashed'` (loud unexpected-exit error UX) and
   * from `claudeReady: false` (transient between-turns idle). Renderers
   * use this to surface a calm, informational status strip ("Session
   * stopped." / "Session stopped. (exit N)") that the operator can choose
   * to act on — typically by sending another message (which clears
   * `stoppedAt` on the next `claude_ready`) or by deleting the session.
   *
   * Cleared when a fresh `claude_ready` arrives for the same session
   * (server restarted the child after the next user input) — the call
   * sites in app/dashboard message-handler clear it alongside the
   * `claudeReady: true` patch returned from `handleClaudeReady`.
   */
  stoppedAt: number | null;
  /**
   * #4879 — child process exit code reported by the server alongside
   * `session_stopped`. Null when the wire message omitted it (e.g.
   * future in-process providers per the #4756 follow-up) or when the
   * session is not currently in the stopped state (`stoppedAt == null`).
   * Renderers surface a non-zero code as a small "(exit N)" suffix; code
   * 0 is the common clean-exit case and renders bare.
   */
  stoppedCode: number | null;
  activeAgents: AgentInfo[];
  /**
   * #4308 — in-flight tool calls for this session, in arrival order. See
   * {@link ActiveTool}. Driven by tool_start / tool_result; cleared on
   * agent_idle / result as a safety net. Empty when the session is idle
   * or between tool calls.
   *
   * TODO(#4307): when the server starts tracking background-shell tasks,
   * surface them here too (or in a sibling `activeBackgroundTasks` slot)
   * so the activity indicator can name pending background work the same
   * way it names in-flight tools. The exact shape depends on the
   * server-side schema landed by #4307.
   */
  activeTools: ActiveTool[];
  /**
   * #4307 — backgrounded shells the session is still waiting on. See
   * {@link PendingBackgroundShell}. Driven by the
   * `background_work_changed` event and seeded from the `session_list`
   * snapshot for late joiners. Empty array when no work is pending —
   * never `null` so the renderer's `.length` check is safe.
   *
   * Distinct from `activeTools`: those are in-flight tool calls in the
   * CURRENT turn; pending background shells persist ACROSS turns until
   * the agent acknowledges them (via `BashOutput`) or the session is
   * destroyed. A session with no `activeTools` but a non-empty
   * `pendingBackgroundShells` is the "waiting on background work"
   * state the activity indicator surfaces.
   */
  pendingBackgroundShells: PendingBackgroundShell[];
  /**
   * #5431 — outstanding background work derived from the session
   * TRANSCRIPT (run_in_background Bash/Agent calls and Monitor streams
   * without a matching task-notification yet). Arrives on enriched
   * `claude_ready` messages. Complements `pendingBackgroundShells`
   * (PTY-side tracker, Bash only, mtime-quiescence reaping): transcript
   * pairing is exact, so silent watcher loops the quiescence sweep
   * falsely reaps still surface here. An absent field on `claude_ready`
   * leaves this unchanged; an explicit `[]` clears it.
   */
  transcriptBackgroundTasks: TranscriptBackgroundTask[];
  /**
   * #5431 — a pending ScheduleWakeup: the agent ended its turn but
   * arranged to be re-invoked at `at` (epoch ms). Null when none is
   * scheduled or it already fired.
   */
  scheduledWakeup: { at: number; reason: string } | null;
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
  /**
   * #4653 — chroxy-side interventions surfaced to the user for this session.
   * Append-only ring (max ~50 entries — see {@link MAX_SESSION_INTERVENTIONS}).
   * Empty array when no intervention has fired; never `null` so the renderer's
   * `.length` check is safe.
   *
   * Currently driven only by `multi_question_intervention` (the permission-hook
   * deny for multi-question AskUserQuestion shipped in #4648); future
   * intervention kinds (sibling-deny #4668, stream-stall auto-recovery #4475)
   * append entries with their own discriminator without a wire version bump.
   *
   * NOT persisted across reconnects — the server does not replay intervention
   * events, so the array resets on a fresh session_list snapshot. This is
   * acceptable: the counter is a "what just happened" affordance, not an
   * audit log.
   */
  interventions: SessionIntervention[];
}
