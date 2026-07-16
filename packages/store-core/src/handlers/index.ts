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

// Shared field parsers + session resolution live in ./_shared (audit P2-3).
import {
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
// Outgoing-message queue handlers (message_queued / message_dequeued #5937 —
// the per-session mid-turn send-queue mirror, with optimistic-enqueue + remove
// helpers) live in ./outgoing-queue.ts. Re-exported here so the barrel's public
// surface is unchanged.
// ---------------------------------------------------------------------------
export * from './outgoing-queue'

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
// Cost/usage handlers (cost_update / session_usage) live in ./usage.ts
// (audit P2-3 split). Re-exported here so the barrel's public surface is
// unchanged.
// ---------------------------------------------------------------------------
export * from './usage'

// ---------------------------------------------------------------------------
// Orchestration / delegation harness ("committee") reducers (epic #6691, S-1):
// pure runs-list upsert + seq-gapped run-delta application. Client wiring is a
// later step (dashboard S-3 #6702); these are shared, tested groundwork.
// ---------------------------------------------------------------------------
export * from './orchestration'

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
// The former ./misc.ts catch-all (audit P2-3 leftover) was split into
// cohesively-named slices (#6034); each is re-exported here so the barrel's
// public surface is unchanged:
//   - ./session-config — session/agent runtime config + readiness
//     (model_changed, claude_ready, agent_idle / agent_busy,
//     thinking_level_changed + ThinkingLevel).
//   - ./inventory — server-side inventory list-replacement (slash_commands /
//     agent_list / provider_list / file_list, available_models, mcp_servers).
//   - ./alerts — client-side alert / banner state
//     (session_cost_threshold_crossed, notification_prefs).
//   - ./permission-stream-split — the #554 resolvePermissionStreamSplit
//     mid-stream permission-boundary split resolver.
// ---------------------------------------------------------------------------
export * from './session-config'
export * from './inventory'
export * from './alerts'
export * from './permission-stream-split'
