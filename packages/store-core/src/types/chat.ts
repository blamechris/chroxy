/**
 * Chat message + tool-render types shared by the app and dashboard chat views.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
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
  /**
   * #5667: the chroxy session that originated this message, captured at
   * creation time. Set on permission `prompt` messages so the renderer can
   * label *which* session is asking — without this, a prompt routed to a
   * background session is indistinguishable from the active session's own
   * prompts once the operator switches tabs. Distinct from the message's
   * physical location (`sessionStates[id].messages`): this is self-describing
   * data that survives independent of which array the message lives in, and
   * mirrors the on-the-fly lookup `PermissionHistoryScreen` already does.
   * Undefined for messages with no owning session (top-level fallback) and for
   * pre-#5667 messages.
   */
  originSessionId?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  toolResultTruncated?: boolean;
  /**
   * #6712: whether the tool_result represents a FAILED tool execution (a failed
   * codex `mcpToolCall`, or a synthetic orphan-sweep result). Renderers surface
   * an error affordance (red tint / warning icon) when `true`. Optional: only
   * `true` is meaningful — a missing/`false` value is a normal result. store-core
   * defaults a missing wire `isError` to `false`.
   */
  toolResultIsError?: boolean;
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
  /**
   * #6756 — set on a `type: 'thinking'` bubble while its reasoning content is
   * still streaming from the provider (extended-thinking `thinking_delta`
   * chunks are arriving). Flipped to `false` on the thinking block's
   * `stream_end`. Renderers show a "Thinking…" label while `true` and "Thought"
   * once `false`. Distinct from the connection-wide `streamingMessageId` (which
   * tracks the visible response text), so a thinking bubble finalises its label
   * independently of the response stream. Undefined on non-thinking bubbles and
   * on the ephemeral `'thinking'` placeholder.
   */
  thinkingStreaming?: boolean;
  /**
   * #6756 — set to `true` once a thinking bubble's accumulated reasoning
   * content hits {@link MAX_THINKING_CONTENT_LEN} and subsequent
   * `thinking_delta` chunks are dropped. Mirrors `toolInputPartialTruncated`;
   * a defence-in-depth bound so a runaway/adversarial thinking stream can't
   * balloon client `messages` state. Renderers MAY surface a "truncated"
   * affordance.
   */
  thinkingTruncated?: boolean;
  /**
   * #6391 (chat-redesign footer-stat) — on a `type: 'thinking'` bubble, the
   * server-measured elapsed wall time (ms) the reasoning block took, from its
   * first streamed token to its close. Threaded off the thinking `stream_end`
   * by {@link handleThinkingStreamEnd}. Renderers show it as a quiet
   * `thought for 4.2s` turn footer in place of the plain "Thought" label.
   * Undefined on old sessions / servers and on the synchronous fallback path
   * (no measurable elapsed time) — the footer degrades to "Thought".
   */
  thinkingDurationMs?: number;
  /**
   * #6391 (chat-redesign footer-stat) — on a `type: 'thinking'` bubble, the
   * reasoning block's token count, rendered as ` · N tokens` after the
   * duration. Optional and NOT populated by the claude SDK/BYOK providers:
   * Anthropic's usage folds thinking tokens into `output_tokens` with no
   * per-block breakdown, so there is nothing clean to report (tracked follow-up).
   * Present only for a provider that cleanly separates reasoning tokens; the
   * footer omits the token clause when absent rather than fabricating a number.
   */
  thinkingTokens?: number;
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
