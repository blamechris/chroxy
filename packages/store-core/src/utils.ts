/**
 * Pure utility functions shared between the Chroxy app and dashboard.
 *
 * No platform dependencies — safe to import anywhere.
 */

import type { BaseSessionState } from './types'

/** Strip ANSI escape codes for plain text display */
export function stripAnsi(str: string): string {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
    '',
  );
}

/**
 * Message ID Convention
 *
 * Message IDs are used to uniquely identify and track messages in the chat history.
 * The default format produced by nextMessageId is: `{prefix}-{counter}-{timestamp}`.
 *
 * Prefixes used with nextMessageId:
 * - 'user'        — User-sent messages
 * - messageType   — Server-forwarded messages where the prefix is the messageType
 *                    (e.g. 'response', 'error', 'prompt', etc.)
 * - 'tool'        — Tool use messages
 * - 'perm'        — Permission request prompts from Claude Code (tool permission dialogs)
 * - 'msg'         — Generic messages (default when no prefix is provided)
 *
 * Special IDs (not produced by nextMessageId):
 * - 'thinking'    — Ephemeral thinking placeholder (singleton, no counter/timestamp; not
 *                    persisted/filtered from transcript export, but rendered in the chat UI)
 *
 * Note on ID assignment:
 * - Most locally-created and non-streaming messages use nextMessageId(prefix).
 * - Messages that already include a server-assigned ID (e.g., streaming events such as
 *   `stream_start`/`stream_delta`, or history replay messages) keep that server-provided
 *   messageId instead of generating a new one.
 *
 * Example ID formats:
 * - 'user-1-1700000000000'
 * - 'response-2-1700000001000'
 * - 'tool-3-1700000002000'
 * - 'perm-4-1700000003000'
 */

// Monotonic message ID counter (avoids Math.random() collisions)
let messageIdCounter = 0;
export function nextMessageId(prefix = 'msg'): string {
  return `${prefix}-${++messageIdCounter}-${Date.now()}`;
}

/** Add up to 50% random jitter to a delay to prevent thundering herd on reconnect */
export function withJitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * delayMs * 0.5);
}

/** Filter out thinking placeholder messages (any message array with an id field) */
export function filterThinking<T extends { id: string }>(messages: T[]): T[] {
  return messages.filter((m) => m.id !== 'thinking');
}

/** Create a fresh BaseSessionState with default values for all shared fields */
export function createEmptyBaseSessionState(): BaseSessionState {
  return {
    messages: [],
    streamingMessageId: null,
    pendingClientMessageId: null,
    inputDeliveries: {},
    claudeReady: false,
    activeModel: null,
    permissionMode: null,
    contextUsage: null,
    contextOccupancy: null,
    lastResultCost: null,
    lastResultDuration: null,
    sessionCost: null,
    cumulativeUsage: null,
    costThresholdWarning: null,
    isIdle: true,
    lastClientActivityAt: null,
    health: 'healthy',
    // #4879: null = session not in stopped state. Set to Date.now() when
    // session_stopped wire message arrives; cleared on next claude_ready.
    stoppedAt: null,
    stoppedCode: null,
    // #7603: null = this session's container is not known to be gone. Set from
    // a LIVE error{code:'CONTAINER_VANISHED'}; cleared by a completed turn or
    // an explicit dismiss (never by claude_ready — see the field docs).
    containerLostAt: null,
    containerReattachError: null,
    activeAgents: [],
    activeTools: [],
    // #4307: empty until the first background_work_changed event or
    // session_list snapshot arrives; null would force every renderer to
    // .length-check against null, so an empty array is the safer default.
    pendingBackgroundShells: [],
    // #5431: transcript-derived outstanding work — empty/null until an
    // enriched claude_ready arrives.
    transcriptBackgroundTasks: [],
    scheduledWakeup: null,
    isPlanPending: false,
    planAllowedPrompts: [],
    primaryClientId: null,
    // #5589 / #5281: null until the first session_role for this session arrives
    // (the UI treats null as unclaimed).
    sessionRole: null,
    conversationId: null,
    sessionContext: null,
    // #6791: null until the first statusline_output arrives (or no statusLine
    // configured). Additive to the cost/context StatusBar.
    statusLine: null,
    mcpServers: [],
    devPreviews: [],
    inactivityWarning: null,
    // #4653: empty ring for chroxy-side interventions. Never null so the
    // dashboard's `.length`/`map` call sites don't need a guard.
    interventions: [],
    // #5937: empty outgoing-message queue. Never null so renderers' .length/.map
    // are guard-free; populated by message_queued / optimistic enqueue.
    queuedMessages: [],
  };
}

/**
 * #7411 — pure patch computation for the transient streaming/plan state that
 * must be cleared for EVERY session (not just the active one) when the
 * socket closes. A background session mid-stream otherwise keeps a phantom
 * "thinking" bubble (`streamingMessageId`) and a stale pending plan across a
 * reconnect (the exact symptom #5731 T4 already fixed on the dashboard —
 * the app's onclose handler used `updateActiveSession` here instead, so a
 * background session's copy of these three fields never got swept).
 *
 * Single-sourced here so the two clients' onclose sweeps can't drift again
 * on this trio the way they just did: previously the dashboard swept all
 * sessions and the app swept only the active one, and nothing caught it.
 * Both clients now call this SAME function; a future change to what counts
 * as "transient" only has one place to edit.
 *
 * Scoped to the fields that live on `BaseSessionState` and are common to
 * both clients. The dashboard's own onclose sweep also clears
 * `pendingEvaluatorClarify` (dashboard-only — the app has no
 * evaluator-clarify feature/field) and `inactivityWarning` /
 * `sessionRole` / `primaryClientId` (also `BaseSessionState` fields, but
 * already correctly swept by both clients via their own separate
 * all-sessions helpers predating this fix — see
 * `TRANSIENT_SESSION_SWEEP_FIELDS`, which enumerates the full set so a
 * parity test can guard it even where the clearing code itself stays
 * per-client).
 *
 * Pure shape: returns `{}` when nothing needs clearing, so callers can skip
 * the store write entirely and avoid churning referential equality.
 */
export function clearTransientSessionState(
  ss: Pick<BaseSessionState, 'streamingMessageId' | 'isPlanPending' | 'planAllowedPrompts'>,
): Partial<Pick<BaseSessionState, 'streamingMessageId' | 'isPlanPending' | 'planAllowedPrompts'>> {
  const patch: Partial<Pick<BaseSessionState, 'streamingMessageId' | 'isPlanPending' | 'planAllowedPrompts'>> = {}
  if (ss.streamingMessageId) patch.streamingMessageId = null
  if (ss.isPlanPending) {
    patch.isPlanPending = false
    patch.planAllowedPrompts = []
  }
  return patch
}

/**
 * #7411 — canonical list of `BaseSessionState` fields that MUST be reset to
 * their "no transient state" value on EVERY session (not just the active
 * one) when the socket closes. Both clients' onclose sweeps are tested
 * against this ONE list rather than each hand-maintaining its own — a field
 * added to one client's sweep without the other is exactly how #7411
 * happened, and a shared enumeration turns that into a failing test instead
 * of a silent gap.
 *
 * `pendingEvaluatorClarify` is deliberately excluded: it lives only on the
 * dashboard's `SessionState` (no evaluator-clarify feature exists on the
 * app yet), so there is no app-side field to hold it to parity against.
 */
export const TRANSIENT_SESSION_SWEEP_FIELDS = [
  'streamingMessageId',
  'isPlanPending',
  'planAllowedPrompts',
  'inactivityWarning',
  'sessionRole',
  'primaryClientId',
] as const satisfies readonly (keyof BaseSessionState)[]

/**
 * #4653 — cap on the per-session intervention ring buffer. The dashboard
 * counter only ever shows a number + a list of "recent" entries, so we don't
 * need to keep more than this — a sustained intervention storm (e.g. a model
 * fighting the multi-question deny) would otherwise bloat the in-memory state
 * indefinitely. Chosen at 50 to comfortably show "the last batch" without
 * imposing a UX cliff if the user is mid-debug-session.
 */
export const MAX_SESSION_INTERVENTIONS = 50

/**
 * WS message types that count as agent activity for the
 * `lastClientActivityAt` indicator (#3758). Any incoming message with one of
 * these types bumps the active session's last-activity timestamp so the
 * "Working… last activity Ns ago" indicator resets. The set intentionally
 * excludes passive housekeeping events (pong, server_status, session_list,
 * key_exchange, etc.) so background chatter doesn't reset the elapsed
 * counter and mask a genuinely-stalled agent.
 *
 * Stream events cover the per-token path; tool_* cover tool calls; message
 * covers non-streamed assistant turns and history replays; result covers
 * turn completion; user_question / permission_request are stalls the agent
 * is waiting on the user for — still "alive", so they reset too.
 */
export const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'stream_start',
  'stream_delta',
  'stream_end',
  'tool_start',
  // #4081: long tool inputs (e.g. Bash `command`) stream as a long run
  // of `tool_input_delta` events between `tool_start` and `tool_result`.
  // Without this entry, the "Working… last activity Ns ago" indicator
  // would falsely report the agent as stalled mid-assembly of a large
  // tool input. Mirrors the rationale for including `stream_delta`.
  'tool_input_delta',
  'tool_result',
  'message',
  'result',
  'user_question',
  'permission_request',
])

/**
 * Returns true if the incoming WS message should reset the active session's
 * last-activity timestamp. Caller is responsible for applying the bump to
 * the right `sessionStates[sessionId]` slot. Centralised here so the mobile
 * app and dashboard agree on what counts as activity (#3758).
 */
export function isActivityEvent(msgType: unknown): boolean {
  return typeof msgType === 'string' && ACTIVITY_EVENT_TYPES.has(msgType)
}
