/**
 * Session info, per-session sub-state, and the BaseSessionState both clients extend.
 *
 * Re-exported via ../types (barrel) — see ./index.ts.
 */

import type { ChatMessage } from './chat'

/**
 * Per-turn BILLING token counts from the most recent `result.usage` — the
 * aggregate summed across every agent-loop round of the turn (a 5-round
 * tool-use turn re-reads the conversation from cache 5×, so `cacheRead` here
 * is ≈5× the real window fill). Drives cost estimation and the last-turn
 * billing breakdown — NEVER the context meter (#6769); occupancy comes from
 * {@link ContextOccupancy}.
 */
export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * #6769: end-of-turn context-window OCCUPANCY snapshot — how many tokens the
 * conversation currently occupies in the model's window. Parsed from the
 * `result` message's optional `contextOccupancy` field (see
 * `ServerContextOccupancySnapshotSchema` in @chroxy/protocol for the wire
 * contract and per-provider sources). This is the ONLY honest input for the
 * context meter; the billing `ContextUsage` above over-reads by the turn's
 * agent-loop round count.
 */
export interface ContextOccupancy {
  /** Tokens currently occupying the window (system prompt + tools + messages). */
  totalTokens: number;
  /** Raw context window in tokens when the source reports it (SDK), else null. */
  maxTokens: number | null;
  /**
   * Auto-compact trigger in TOKENS (SDK only) — the real ceiling the meter
   * reads 100% at. Null when the source has no compaction concept (byok).
   */
  autoCompactThreshold: number | null;
  /** Whether auto-compact is enabled (SDK only); null when unknown. */
  isAutoCompactEnabled: boolean | null;
  /** Provenance: authoritative SDK API vs byok final-round estimate. */
  source: 'context-usage-api' | 'final-round-prompt' | null;
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

/**
 * #5630/#5629: era-aware billing class for a session/provider. Mirrors the
 * server's `BILLING_CLASSES` enum (packages/server/src/billing-class.js):
 *   - 'api-key'             — your own key / per-token (byok, docker-byok,
 *                             docker-cli/sdk — they forward an API key into
 *                             the container with no OAuth fallback — and every
 *                             non-Claude provider).
 *   - 'subscription'        — flat Claude subscription, no per-turn dollar
 *                             figure (claude-tui, claude-channel; and the host
 *                             programmatic providers BEFORE 2026-06-15).
 *   - 'programmatic-credit' — Anthropic's metered monthly credit pool (host
 *                             claude-cli / claude-sdk ON/AFTER 2026-06-15).
 */
export type BillingClass = 'api-key' | 'subscription' | 'programmatic-credit';

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
  // #5630/#5629: era-aware billing class for the cost-label renderers.
  // Optional because older servers omit it; consumers fall back to deriving
  // it from `provider`.
  billingClass?: BillingClass;
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
  // #6824: per-server enable/disable state. `enabled` is the toggle's on/off
  // value (false = operator-parked; a distinct signal from a 'dead' status the
  // operator never touched). `canToggle` gates whether the UI renders a toggle
  // — only the BYOK lane (in-daemon MCP fleet) sets it; sdk/cli/tui stay
  // read-only. Both optional so a message from a pre-#6824 emitter round-trips.
  enabled?: boolean;
  canToggle?: boolean;
  // #6822: when `status === 'oauth-required'`, the browser authorization URL the
  // user opens to authorize this remote MCP server. Carries only the public URL
  // (never a token/secret). Absent for every other status.
  authUrl?: string;
}

export interface DevPreview {
  port: number;
  url: string;
}

/**
 * #5937 (epic #5935) — one entry in a session's server-authoritative
 * outgoing-message queue: a follow-up the OWNER sent while the session was
 * still mid-turn, which the server is holding and will auto-send FIFO when the
 * turn completes (mirrored from slice ①'s `message_queued` / `message_dequeued`
 * events, see packages/server/base-session.js `_outgoingQueue`).
 *
 * DISTINCT from {@link QueuedMessage} (the connection-level OFFLINE-send buffer
 * drained on reconnect): this is per-session, server-authoritative, and bounded
 * by the server's queue cap — not a client-side disconnect buffer.
 *
 * - `clientMessageId`: stable id correlating this entry to the sender's
 *   optimistic copy (the resolved user-input id). Undefined when the server did
 *   not echo one (e.g. a queued send with no client id) — such entries can only
 *   be reconciled/removed FIFO, not by id.
 * - `text`: the queued message text, for rendering the queued bubble. May be
 *   empty for attachment-only sends (the server's `message_queued` carries an
 *   empty `text` for a non-string prompt — see #5937 follow-up note).
 * - `queuedAt`: client wall-clock (ms) when this entry entered the local model.
 * - `status`: `'pending'` = added optimistically on send-while-busy, awaiting
 *   the server's `message_queued` confirmation; `'confirmed'` = the server has
 *   acknowledged it is holding the message. Lets a renderer distinguish an
 *   in-flight optimistic entry from a server-confirmed one.
 */
export interface QueuedSessionMessage {
  clientMessageId?: string;
  text: string;
  queuedAt: number;
  status: 'pending' | 'confirmed';
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
 * #5589 / #5281 — THIS client's role for a shared session, derived from the
 * server's `session_role` broadcast. See `handleSessionRole`.
 */
export type SessionRole = 'primary' | 'observer' | 'unclaimed';

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
  /**
   * #6302 — the `clientMessageId` of the send that OWNS the current optimistic
   * "working" turn (the faked-fresh path that sets `streamingMessageId:
   * 'pending'` + a `'thinking'` bubble before any `stream_start` arrives). Set
   * alongside that sentinel and cleared (to null) wherever `streamingMessageId`
   * leaves `'pending'` — the 5s stream-stall safety net, the faked-fresh-turn
   * reconcile, a real `stream_start`/`tool_start` adopting a real id.
   *
   * Load-bearing in a MULTI-CLIENT session: mid-turn sends are echoed across
   * clients, so a client holds queued/user bubbles for OTHER clients' ids too.
   * The faked-fresh-turn reconcile (`reconcileFakedFreshTurn`) must therefore
   * fire only when an incoming `message_queued`'s `clientMessageId` matches THIS
   * field — another client's broadcast queued send must not retire this client's
   * own optimistic turn. Null whenever no faked-fresh turn is outstanding.
   */
  pendingClientMessageId: string | null;
  claudeReady: boolean;
  activeModel: string | null;
  permissionMode: string | null;
  contextUsage: ContextUsage | null;
  // #6769: occupancy snapshot from the latest result that carried one.
  // Persists across turns (a result WITHOUT the field keeps the previous
  // snapshot) and only moves when a new snapshot lands — including DOWN
  // after a compaction. Null until the provider reports occupancy at all
  // (claude-cli / claude-tui / codex / gemini stay null → dash; the byok
  // agent-loop family — incl. ollama / deepseek / anthropic-compatible —
  // reports a final-round snapshot whenever its endpoint returns usage).
  contextOccupancy: ContextOccupancy | null;
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
  /**
   * #5589 / #5281 — THIS client's explicit role for this session, derived from
   * the server's `session_role` broadcast (`primaryClientId` vs own clientId):
   *   - `'primary'`   — this client owns the session (drives input)
   *   - `'observer'`  — another client owns it (input rejected while running)
   *   - `'unclaimed'` — nobody owns it yet (first input/claim takes over)
   * `null` until the first `session_role` for this session arrives (treated as
   * unclaimed by the UI). Distinct from `primaryClientId` (the raw "who owns
   * it" pointer driven by both `primary_changed` and `session_role`).
   */
  sessionRole: SessionRole | null;
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
  /**
   * #5937 (epic #5935) — the session's outgoing-message queue: follow-ups the
   * owner sent mid-turn that the server is holding and will auto-send FIFO on
   * turn-complete. See {@link QueuedSessionMessage}. Driven by slice ①'s
   * `message_queued` / `message_dequeued` events (and an optimistic local
   * enqueue on send-while-busy, reconciled by `clientMessageId`). Empty array
   * when nothing is queued — never `null`, so renderers' `.length`/`.map` are
   * guard-free.
   *
   * Per-session by construction (keyed by sessionId in the store, NOT component
   * state — ChatView is not session-keyed), so a queue in one session never
   * bleeds into another. NOT replayed on reconnect in this slice: the server
   * ships only the live deltas, so a fresh `session_list` snapshot leaves this
   * untouched and a client reconnecting mid-queue won't see pre-existing items
   * until a server→client queue snapshot lands (tracked in #5937 / #5935).
   */
  queuedMessages: QueuedSessionMessage[];
}
