/**
 * Shared stateless message handler functions.
 *
 * Each function takes a raw WebSocket message and optional context,
 * returning a state patch or transformed data. No side effects — consumers
 * apply the patches to their own store however they see fit.
 *
 * These extract the shared logic that was duplicated between the mobile app
 * and web dashboard message handlers.
 */

import type {
  ActiveTool,
  ModelInfo,
  TranscriptBackgroundTask,
} from '../types'
// Established Zod-handler pattern (#3138).
import { ServerAvailableModelsEntrySchema, ServerNotificationPrefsSchema } from '@chroxy/protocol'

// Shared field parsers + session resolution live in ./_shared (audit P2-3).
import {
  parseStringField,
  resolveSessionId,
} from './_shared'
import type { SessionPatch } from './_shared'
// ---------------------------------------------------------------------------
// Shared helpers (parseStringField / parseRawStringField / parseEnumField /
// resolveSessionId) and the SessionPatch type now live in ./_shared.ts
// (audit P2-3, imported above). resolveSessionId + SessionPatch are part of
// the barrel's public surface, so they are re-exported here; the three field
// parsers were always private and are intentionally not re-exported.
// ---------------------------------------------------------------------------
export { resolveSessionId }
export type { SessionPatch }

// ---------------------------------------------------------------------------
// model_changed
// ---------------------------------------------------------------------------

/** Extract the model value from a `model_changed` message. */
export function handleModelChanged(msg: Record<string, unknown>): { model: string | null } {
  return { model: parseStringField(msg, 'model') }
}

// ---------------------------------------------------------------------------
// Permission-mode handlers (permission_mode_changed, available_permission_modes
// — handleAvailablePermissionModes + PermissionMode, confirm_permission_mode)
// live in ./permission.ts (audit P2-3 split), alongside the permission-request
// handlers. Re-exported via the ./permission barrel line below. handleAuthOk
// imports handleAvailablePermissionModes + PermissionMode back from there.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session-lifecycle handlers (session_updated, session_error, session_stopped,
// log_entry) live in ./session-lifecycle.ts (audit P2-3 split). Re-exported
// here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './session-lifecycle'

// ---------------------------------------------------------------------------
// confirm_permission_mode (handleConfirmPermissionMode + PendingPermissionConfirm)
// moved to ./permission.ts (audit P2-3 split). Re-exported via the ./permission
// barrel line below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// claude_ready
// ---------------------------------------------------------------------------

/**
 * State patch for `claude_ready`.
 *
 * `stoppedAt`/`stoppedCode` are reset to null here so the quiet "Session
 * stopped." status strip introduced for #4879 clears the moment the
 * server reports the child is ready again (typically because the user
 * sent another message after tapping Stop). This is purely additive for
 * sessions that were never stopped — both fields stay null end-to-end.
 */
export function handleClaudeReady(msg?: Record<string, unknown>): {
  claudeReady: true
  stoppedAt: null
  stoppedCode: null
  transcriptBackgroundTasks?: TranscriptBackgroundTask[]
  scheduledWakeup?: { at: number; reason: string } | null
} {
  const patch: ReturnType<typeof handleClaudeReady> = {
    claudeReady: true,
    stoppedAt: null,
    stoppedCode: null,
  }
  // #5431: enriched ready — `backgroundTasks` present (even as []) means the
  // server computed a fresh transcript snapshot, so it is authoritative for
  // BOTH fields: a snapshot with tasks but no wakeup means any previously
  // stored wakeup has fired/been superseded. Absent means a pre-#5431 server
  // or no transcript access — leave the stored fields untouched.
  if (Array.isArray(msg?.backgroundTasks)) {
    patch.transcriptBackgroundTasks = msg.backgroundTasks.filter(
      (t): t is TranscriptBackgroundTask =>
        !!t && typeof t === 'object' &&
        typeof (t as TranscriptBackgroundTask).toolUseId === 'string' &&
        ['bash', 'agent', 'monitor'].includes((t as TranscriptBackgroundTask).kind) &&
        typeof (t as TranscriptBackgroundTask).description === 'string' &&
        Number.isFinite((t as TranscriptBackgroundTask).startedAt),
    )
    const wakeup = msg.scheduledWakeup as { at?: unknown; reason?: unknown } | undefined
    patch.scheduledWakeup =
      wakeup && typeof wakeup.at === 'number' && typeof wakeup.reason === 'string'
        ? { at: wakeup.at, reason: wakeup.reason }
        : null
  }
  return patch
}

// ---------------------------------------------------------------------------
// agent_idle / agent_busy
// ---------------------------------------------------------------------------

/** State patch for `agent_idle`.
 *
 * Also clears `streamingMessageId` so the stop button hides if the agent
 * reaches idle without a closing `stream_end`/`result` (abnormal Agent SDK
 * shutdown). Pre-#3170 the 5s safety timer in `sendInput` recovered this
 * case; post-#3170 the timer is bypassed once `tool_start` bumps the value,
 * so `agent_idle` is the remaining recovery hook. See #3171.
 *
 * #4308 — also clears `activeTools` as a safety net: a missed `tool_result`
 * (server crash mid-turn, dropped broadcast, etc.) would otherwise leave a
 * phantom "Running X" indicator visible for the rest of the session. Idle
 * is a guaranteed turn-boundary, so it's the right place to drop any
 * still-tracked in-flight tools.
 */
export function handleAgentIdle(): {
  isIdle: true
  streamingMessageId: null
  activeTools: ActiveTool[]
} {
  return { isIdle: true, streamingMessageId: null, activeTools: [] }
}

/** State patch for `agent_busy`. */
export function handleAgentBusy(): { isIdle: false } {
  return { isIdle: false }
}

// ---------------------------------------------------------------------------
// thinking_level_changed
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'default' | 'high' | 'max'

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['default', 'high', 'max'])

/** Extract and validate the thinking level from a `thinking_level_changed` message. */
export function handleThinkingLevelChanged(msg: Record<string, unknown>): { level: ThinkingLevel } {
  const raw = parseStringField(msg, 'level') || 'default'
  const level = VALID_THINKING_LEVELS.has(raw as ThinkingLevel) ? (raw as ThinkingLevel) : 'default'
  return { level }
}

// ---------------------------------------------------------------------------
// Cost-budget handlers (budget_warning / budget_exceeded / budget_resumed /
// budget_resume_ack) live in ./budget.ts (audit P2-3 split). Re-exported here
// so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './budget'

// ---------------------------------------------------------------------------
// Plan-mode handlers (plan_started / plan_ready / inactivity_warning) live in
// ./plan.ts (audit P2-3 split). Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './plan'

// ---------------------------------------------------------------------------
// Intervention handlers (multi_question_intervention #4653 —
// handleMultiQuestionIntervention + applyInterventionBuilder) live in
// ./intervention.ts (audit P2-3 split). Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './intervention'

// ---------------------------------------------------------------------------
// Dev-preview handlers (dev_preview, dev_preview_stopped) live in
// ./dev-preview.ts (audit P2-3 split). Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './dev-preview'

// ---------------------------------------------------------------------------
// auth + connection handlers — auth_ok / auth_fail / key_exchange_ok /
// server_mode (with ServerMode + AuthOk* types), the auth_bootstrap +
// tunnel_url_changed pair, and token_rotated + pair_fail — live in ./auth.ts
// (audit P2-3 split). Re-exported here so the barrel's public surface is
// unchanged. handleAuthOk imports handleAvailablePermissionModes + PermissionMode
// from ./permission (no cycle).
// ---------------------------------------------------------------------------
export * from './auth'

// ---------------------------------------------------------------------------
// Checkpoint handlers (checkpoint_created / checkpoint_list /
// checkpoint_restored) live in ./checkpoint.ts (audit P2-3 split). Re-exported
// here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './checkpoint'

// ---------------------------------------------------------------------------
// Error handlers (client `error` envelope via handleError + pickFiniteTokenCount,
// and the server-lifecycle family server_error / server_shutdown /
// server_status legacy) live in ./error.ts (audit P2-3 split). Re-exported here
// so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './error'

// ---------------------------------------------------------------------------
// session_error / session_stopped / log_entry handlers moved to
// ./session-lifecycle.ts (audit P2-3 split). Exported via the
// ./session-lifecycle re-export above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-client coordination handlers (client_joined / client_left /
// primary_changed / session_role) live in ./client.ts (audit P2-3 split).
// Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './client'

// ---------------------------------------------------------------------------
// session_list handlers (session_list parsing + buildSessionListPatches /
// cumulativeUsageEquals / chunkSubscribeSessionIds / SESSION_LIST_SUBSCRIBE_
// CHUNK_SIZE / SessionListPatches) and the #4307 background_work_changed
// handler (handleBackgroundWorkChanged / PendingBackgroundShellsBuilder, which
// buildSessionListPatches calls internally) live in ./session-list.ts (audit
// P2-3 split). Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './session-list'

// ---------------------------------------------------------------------------
// Session-status / client-focus handlers (session_context, session_timeout,
// session_restore_failed, session_warning, session_switched,
// client_focus_changed) live in ./session-status.ts (audit P2-3 split).
// Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './session-status'

// ---------------------------------------------------------------------------
// Conversation handlers (conversation_id, conversations_list,
// history_replay_start, history_replay_end) live in ./conversation.ts (audit
// P2-3 split). Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './conversation'

// ---------------------------------------------------------------------------
// Permission handlers — request lifecycle (permission_request / _resolved /
// _expired / _timeout / _rules_updated + the PermissionRule type) AND the
// permission-mode controls (permission_mode_changed / available_permission_modes
// / confirm_permission_mode) — live in ./permission.ts (audit P2-3 split).
// Re-exported here so the barrel's public surface is unchanged. handleAuthOk
// imports handleAvailablePermissionModes + PermissionMode back from there.
// ---------------------------------------------------------------------------
export * from './permission'

// ---------------------------------------------------------------------------
// File-operation result handlers (directory_listing / file_listing /
// file_content / write_file_result) live in ./file.ts (audit P2-3 split).
// Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './file'

// ---------------------------------------------------------------------------
// slash_commands / agent_list / provider_list / file_list
//
// All four are list-replacement handlers: validate `Array.isArray(...)`, then
// hand the array back to the caller for `set({ ...: arr as Concrete[] })`.
// `slash_commands` and `agent_list` additionally apply a session-id guard (skip
// when `msg.sessionId` is set AND `activeSessionId` is set AND they differ).
//
// Element shape is NOT validated by these handlers — the cast to the concrete
// list element type stays at the call site (matches both clients' prior inline
// behaviour). The mobile app additionally tightens `provider_list` element
// validation; that extra filtering stays at the call site, layered on top of
// the array returned here.
// ---------------------------------------------------------------------------

/**
 * Apply the `if (msg.sessionId && active && msg.sessionId !== active) skip`
 * guard used by `slash_commands` and `agent_list` — **broadcast-guard semantics**.
 *
 * Returns true when the caller should DROP the message because the explicit
 * `msg.sessionId` does not match the user's current `activeSessionId`. When
 * either side is missing, the message is allowed through (either because it
 * was a server-wide broadcast or because there is no active session yet to
 * mismatch against).
 *
 * Distinct from {@link resolveSessionId}, which uses **fallback semantics**
 * (default to the active session when the message omits the tag). This guard
 * is the right primitive for list-replacement events (`slash_commands`,
 * `agent_list`) where applying a stale session's list to the wrong session
 * would clobber unrelated UI state.
 *
 * Mirrors the prior inline truthiness-based guard exactly: any truthy
 * `msg.sessionId` (including non-string values like `123`) counts as "set",
 * any truthy `activeSessionId` counts as "active", and the strict-inequality
 * comparison is then applied. Non-string `sessionId` values are still
 * skipped when they don't match an active session — preserving the
 * dashboard/app behaviour.
 */
function shouldSkipForSessionMismatch(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): boolean {
  return (
    !!msg.sessionId &&
    !!activeSessionId &&
    msg.sessionId !== activeSessionId
  )
}

/**
 * Parse a `slash_commands` message into the replacement array.
 *
 * Returns null when the session-id guard rejects the message OR when
 * `msg.commands` is missing/non-array — caller should `if (!result) break`.
 * Element shape is NOT validated; downstream casts to the concrete
 * `SlashCommand[]` type.
 */
export function handleSlashCommands(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): { commands: unknown[] } | null {
  if (shouldSkipForSessionMismatch(msg, activeSessionId)) return null
  if (!Array.isArray(msg.commands)) return null
  return { commands: msg.commands as unknown[] }
}

/**
 * Parse an `agent_list` message into the replacement array.
 *
 * Returns null when the session-id guard rejects the message OR when
 * `msg.agents` is missing/non-array — caller should `if (!result) break`.
 * Element shape is NOT validated; downstream casts to the concrete
 * `CustomAgent[]` type.
 */
export function handleAgentList(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): { agents: unknown[] } | null {
  if (shouldSkipForSessionMismatch(msg, activeSessionId)) return null
  if (!Array.isArray(msg.agents)) return null
  return { agents: msg.agents as unknown[] }
}

/**
 * Parse a `provider_list` message into the replacement array.
 *
 * No session-id guard — provider lists are server-wide. Returns null when
 * `msg.providers` is missing/non-array. The mobile app additionally tightens
 * element validation at the call site; this handler only handles the
 * shared array-ness check.
 */
export function handleProviderList(
  msg: Record<string, unknown>,
): { providers: unknown[] } | null {
  if (!Array.isArray(msg.providers)) return null
  return { providers: msg.providers as unknown[] }
}

/**
 * Parse a `file_list` message into the replacement array.
 *
 * Dashboard-only consumer today. No session-id guard. Always returns the
 * `{ files }` shape — defaulting to `[]` when the field is missing or
 * non-array (matches the dashboard's prior inline `Array.isArray(...) ? ... : []`).
 */
export function handleFileList(msg: Record<string, unknown>): { files: unknown[] } {
  const files: unknown[] = Array.isArray(msg.files) ? (msg.files as unknown[]) : []
  return { files }
}

// ---------------------------------------------------------------------------
// Git operation result handlers (diff_result / git_status_result /
// git_branches_result / git_stage_result / git_unstage_result /
// git_commit_result) live in ./git.ts (audit P2-3 split). Re-exported here so
// the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './git'
// ---------------------------------------------------------------------------
// Agent-tracking handlers (agent_spawned / agent_completed / agent_event) and
// AgentInfoBuilder live in ./agent.ts (audit P2-3 split). Re-exported here so
// the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './agent'

// ---------------------------------------------------------------------------
// #4307 background_work_changed (handleBackgroundWorkChanged /
// PendingBackgroundShellsBuilder) moved to ./session-list.ts (audit P2-3
// split) alongside buildSessionListPatches, which calls it to seed each
// session's pendingBackgroundShells from the snapshot. It is also dispatched
// independently for the background_work_changed wire message (dispatch-table).
// Exported via the ./session-list re-export above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Environment message handlers (environment_list / environment_error) live in
// ./environment.ts (audit P2-3 split). Re-exported here so the barrel's
// public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './environment'

// ---------------------------------------------------------------------------
// available_models
//
// Validates and normalizes the `models` array on an `available_models`
// message. Each entry can be either:
//
//  - A `ModelInfo` object with at least `id`, `label`, `fullId` (all non-empty
//    after trim). `contextWindow` is preserved only when it's a number > 0.
//  - A bare string (trimmed; non-empty), which gets expanded into
//    `{id, label: capitalized, fullId}` (label = first char uppercased).
//
// Malformed entries are dropped. Also extracts `defaultModelId` from
// `msg.defaultModel` via `parseStringField` (trim + reject empty/whitespace),
// aligning both clients on the stricter normalisation (#3137).
// ---------------------------------------------------------------------------

/**
 * Parsed payload from an `available_models` message: the validated/normalized
 * model list and the server-default model id.
 */
export interface AvailableModelsPayload {
  /** Cleaned/normalized list of models. Empty when input is missing or non-array. */
  models: ModelInfo[]
  /** Default model id from `msg.defaultModel` when string, else null. */
  defaultModelId: string | null
}

/**
 * Parse and normalize an `available_models` message.
 *
 * Behaviour-preserving (matches the dashboard's prior inline implementation):
 * - Object entries are parsed with `ServerAvailableModelsEntrySchema` from
 *   `@chroxy/protocol` (#3138 — first migrated handler in the established
 *   Zod-handler pattern). After Zod parse, additional empty-string trim
 *   rejection is applied to `id`, `label`, and `fullId`. Fields are NOT
 *   trimmed in the output (preserves verbatim values).
 * - `contextWindow` is included only when `typeof === 'number' && > 0`.
 * - String entries are trimmed; the trimmed value is used as `id` and `fullId`,
 *   and `label` is the trimmed value with its first character uppercased.
 * - `defaultModel` is normalised via `parseStringField` — trimmed; empty or
 *   whitespace-only inputs return `null` (#3137). The model picker treats
 *   empty string the same as null, so this aligns the two clients.
 */
export function handleAvailableModels(
  msg: Record<string, unknown>,
): AvailableModelsPayload {
  if (!Array.isArray(msg.models)) {
    return { models: [], defaultModelId: null }
  }
  const cleaned = (msg.models as unknown[])
    .map((m: unknown): ModelInfo | null => {
      if (typeof m === 'object' && m !== null) {
        const parsed = ServerAvailableModelsEntrySchema.safeParse(m)
        if (parsed.success) {
          const { id, label, fullId, contextWindow } = parsed.data
          // Reject whitespace-only / empty fields after Zod parse — schema
          // requires `string` but does not enforce non-empty trimming.
          if (id.trim() !== '' && label.trim() !== '' && fullId.trim() !== '') {
            const info: ModelInfo = { id, label, fullId }
            if (typeof contextWindow === 'number' && contextWindow > 0) {
              info.contextWindow = contextWindow
            }
            return info
          }
        }
      }
      if (typeof m === 'string' && m.trim().length > 0) {
        const s = m.trim()
        return { id: s, label: s.charAt(0).toUpperCase() + s.slice(1), fullId: s }
      }
      return null
    })
    .filter((m: ModelInfo | null): m is ModelInfo => m !== null)
  const defaultModelId = parseStringField(msg, 'defaultModel')
  return { models: cleaned, defaultModelId }
}

// ---------------------------------------------------------------------------
// mcp_servers
//
// Session-scoped list-replacement: writes the `mcpServers` array into the
// target session's state. The element type is left as `unknown[]` here — both
// callers cast to their own `McpServer[]` type at the call site.
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a session patch that replaces the
 * `mcpServers` list. Defaults to an empty array when the message has no
 * (or non-array) `servers` field.
 *
 * Session resolution matches the prior inline behaviour exactly:
 * `(msg.sessionId as string) || activeSessionId` (raw string passthrough; no
 * trim, no whitespace coercion). A whitespace-only `sessionId` is preserved
 * verbatim so the downstream `sessionStates[id]` lookup misses, rather than
 * silently falling back to the active session and patching the wrong one.
 * Mirrors the pattern used by `handleHistoryReplayStart`.
 */
export function handleMcpServers(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  const servers: unknown[] = Array.isArray(msg.servers)
    ? (msg.servers as unknown[])
    : []
  const rawSessionId =
    typeof msg.sessionId === 'string' ? msg.sessionId : null
  return {
    sessionId: rawSessionId || activeSessionId,
    patch: { mcpServers: servers },
  }
}

// ---------------------------------------------------------------------------
// Cost/usage handlers (cost_update / session_usage) live in ./usage.ts
// (audit P2-3 split). Re-exported here so the barrel's public surface is
// unchanged.
// ---------------------------------------------------------------------------
export * from './usage'

// ---------------------------------------------------------------------------
// server_error / server_shutdown / server_status (legacy) handlers moved to
// ./error.ts (audit P2-3 split). Exported via the ./error re-export above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Web-task + search handlers (web_task_created/updated upsert, web_task_error,
// web_task_list, web_feature_status, search_results) live in ./web-task.ts
// (audit P2-3 split). Re-exported here so the barrel's public surface is
// unchanged.
// ---------------------------------------------------------------------------
export * from './web-task'

// ---------------------------------------------------------------------------
// User-question + user-input handlers (user_question, user_input — plus the
// OTHER_OPTION_VALUE/LABEL sentinels) live in ./user-question.ts (audit P2-3
// split). Re-exported here so the barrel's public surface is unchanged.
// ---------------------------------------------------------------------------
export * from './user-question'

// ---------------------------------------------------------------------------
// Message / tool / stream rendering handlers (message, tool_start /
// tool_result / tool_input_delta, stream_start / stream_end, result_usage,
// raw_output, sharedStreamDelta + PendingDelta / StreamDeltaContext) live in
// ./stream.ts (audit P2-3 split). Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './stream'

// ---------------------------------------------------------------------------
// session_cost_threshold_crossed (#4075)
// ---------------------------------------------------------------------------

/** Parsed payload from a `session_cost_threshold_crossed` message. */
export interface SessionCostThresholdCrossedPayload {
  /**
   * Explicit sessionId from the message, or null. There is deliberately NO
   * active-session fallback (matches both prior inline impls): the soft
   * "you've spent $X" warning fires once per session and must never be
   * misattributed to whichever session happens to be active.
   */
  sessionId: string | null
  /** Session-state patch that arms the dismissible warning banner. */
  patch: { costThresholdWarning: { costUsd: number; thresholdUsd: number; dismissedAt: null } }
}

/**
 * Parse a `session_cost_threshold_crossed` message into a session patch.
 *
 * `costUsd` / `thresholdUsd` fall back to `0` for missing / non-number /
 * non-finite values — identical to the prior inline guards on both clients.
 * The caller applies the patch only when the target session exists in its
 * store (the server doesn't replay this event, so a missed banner stays
 * missed by design).
 */
export function handleSessionCostThresholdCrossed(
  msg: Record<string, unknown>,
): SessionCostThresholdCrossedPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  const costUsd =
    typeof msg.costUsd === 'number' && Number.isFinite(msg.costUsd) ? msg.costUsd : 0
  const thresholdUsd =
    typeof msg.thresholdUsd === 'number' && Number.isFinite(msg.thresholdUsd)
      ? msg.thresholdUsd
      : 0
  return {
    sessionId,
    patch: { costThresholdWarning: { costUsd, thresholdUsd, dismissedAt: null } },
  }
}

// ---------------------------------------------------------------------------
// notification_prefs (#4542 / #4544)
// ---------------------------------------------------------------------------

/**
 * Notification-prefs snapshot shape both clients store (mirrors the
 * `notificationPrefs` state slice that existed verbatim on each side before
 * this extraction).
 */
export interface NotificationPrefsState {
  categories: Record<string, boolean>
  devices: Record<
    string,
    {
      categories?: Record<string, boolean>
      quietHours?: { start: string; end: string; timezone: string } | null
      bypassCategories?: string[]
    }
  >
  quietHours: { start: string; end: string; timezone: string } | null
  /**
   * #4544: optional globally-applied bypass list (categories that fire even
   * during quiet hours). Omitted entirely when the wire payload lacks it —
   * clients fall back to the documented defaults (permission +
   * activity_error).
   */
  bypassCategories?: string[]
}

/** Result of parsing a `notification_prefs` message. */
export interface NotificationPrefsPayload {
  /** Validated snapshot ready to store, or null when validation failed. */
  notificationPrefs: NotificationPrefsState | null
  /** Zod issues when validation failed, else null (for the call-site warn). */
  issues: unknown[] | null
}

/**
 * Validate and extract a `notification_prefs` snapshot.
 *
 * Emitted in response to `notification_prefs_get` and broadcast after every
 * `notification_prefs_set` so multiple connected clients stay in lockstep.
 * Validated against `ServerNotificationPrefsSchema` (the wire schema is
 * permissive — `z.record(string, boolean)` for categories — so adding a
 * category server-side does not require a client rebuild). On failure the
 * caller logs `issues` and leaves existing state alone, exactly as both
 * inline implementations did.
 */
export function handleNotificationPrefs(
  msg: Record<string, unknown>,
): NotificationPrefsPayload {
  const parsed = ServerNotificationPrefsSchema.safeParse(msg)
  if (!parsed.success) {
    return { notificationPrefs: null, issues: parsed.error.issues }
  }
  const prefs = parsed.data.prefs
  // #4544: wire snapshot carries an optional `bypassCategories`. Older
  // servers omit it — spread-include only when it's a real array so the
  // stored object matches the prior inline shape key-for-key.
  const bypassCategories = (prefs as { bypassCategories?: string[] }).bypassCategories
  return {
    notificationPrefs: {
      categories: prefs.categories,
      devices: prefs.devices,
      quietHours: prefs.quietHours,
      ...(Array.isArray(bypassCategories) ? { bypassCategories } : {}),
    },
    issues: null,
  }
}

// ---------------------------------------------------------------------------
// permission_request — #554 stream-split resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the #554 "split streaming response at permission boundary" decision
 * for a `permission_request` message.
 *
 * Both clients carried a near line-for-line copy of this block: when a
 * permission prompt arrives mid-stream, the in-flight assistant message must
 * be split so the prompt doesn't get visually fused onto it. The pure part —
 * deciding whether a split applies and reverse-mapping the client-side stream
 * id back to the server-origin id through the delta-remap table — lives here.
 *
 * Returns null when there is nothing to split: no current stream, or the
 * `'pending'` placeholder id (stream_start not yet processed).
 *
 * Side effects stay at the call site, in this order (matching both prior
 * inline copies): clear the pending delta-flush timer, flush pending deltas,
 * add `serverStreamId` to the post-permission-splits set, and clear the
 * target session's `streamingMessageId`.
 */
export function resolvePermissionStreamSplit(
  currentStreamId: string | null,
  deltaIdRemaps: ReadonlyMap<string, string>,
): { serverStreamId: string } | null {
  if (!currentStreamId || currentStreamId === 'pending') return null
  let serverStreamId = currentStreamId
  for (const [origId, remappedId] of deltaIdRemaps) {
    if (remappedId === currentStreamId) {
      serverStreamId = origId
      break
    }
  }
  return { serverStreamId }
}
