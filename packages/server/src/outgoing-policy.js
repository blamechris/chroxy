/**
 * Which server-to-client frames a session-scoped connection may receive.
 *
 * The mirror of bound-client-policy.js. That module decides what a session-scoped
 * connection may ASK for; this one decides what it may be SENT, at the single
 * point every frame to a client passes through (`WsServer._send`). The broadcaster
 * already withholds frames tagged with another session; the frames below carry no
 * session tag and describe the host (configuration, credentials, spend, other
 * connections' devices, tasks, environments), so they are never delivered to a
 * session-scoped connection however they were produced.
 *
 * Every frame type that has an outbound schema is in exactly one list:
 *   - BOUND_OUTGOING_DENIED: host-wide; dropped for a session-scoped connection.
 *   - BOUND_OUTGOING_REDACTED: delivered with the host-wide fields removed.
 *   - BOUND_OUTGOING_ALLOWED: session-scoped or per-connection; delivered (the
 *     broadcaster still withholds one tagged with another session).
 * Frames with no outbound schema are classified by hand below. Delivery is
 * DENY BY DEFAULT: a type that is in none of the lists is not delivered.
 * tests/outgoing-policy.test.js checks both directions (every schema-backed type
 * and every type the source emits by name is classified; every classified name
 * is real).
 */

/** @type {readonly string[]} */
export const BOUND_OUTGOING_DENIED = Object.freeze([
  'archived_session_history', 'archived_sessions_list', 'billing_canary',
  'byok_credentials_status', 'byok_pool_action_ack', 'byok_pool_status_snapshot',
  'containers_action_ack', 'containers_status_snapshot', 'credential_test_result',
  'credentials_status', 'daemon_update_action_result', 'daemon_update_confirm_required',
  'daemon_update_status', 'delete_archived_session_result', 'directory_listing',
  'emulator_action_ack', 'emulator_status_snapshot', 'environment_created',
  'environment_destroyed', 'environment_error', 'environment_info', 'environment_list',
  'external_sessions_snapshot', 'failed_restore_history', 'failed_restores_list',
  'git_commit_result', 'git_create_pr_result', 'git_repo_check_result', 'github_webhook_config',
  'host_prune_action_ack', 'host_prune_status_snapshot', 'host_status_snapshot',
  'integration_action_ack', 'integration_status_snapshot', 'mailbox_status_snapshot',
  'monthly_budget', 'notification_prefs', 'orchestration_action_ack', 'orchestration_run_delta',
  'orchestration_run_snapshot', 'orchestration_runs_snapshot', 'pair_pending',
  'pair_request_pending', 'pair_resolved', 'repo_events_delta', 'repo_events_snapshot',
  'repo_runtime_config_snapshot', 'restore_archived_session_result', 'retry_failed_restore_result',
  'runner_status_snapshot', 'scheduled_tasks', 'session_archive_policy_result',
  'session_preset_snapshot', 'shell_pending_approval', 'simulator_action_ack',
  'simulator_status_snapshot', 'skill_trust_accepted', 'skill_trust_grant_ok',
  'skill_trust_granted', 'skill_trust_request', 'skills_inventory_snapshot', 'statusline_output',
  'web_feature_status', 'web_task_created', 'web_task_error', 'web_task_list', 'web_task_updated',
  'wsl_action_ack', 'wsl_status_snapshot', 'provider_list',
])

/** @type {readonly string[]} */
export const BOUND_OUTGOING_REDACTED = Object.freeze(['auth_bootstrap', 'auth_ok', 'cost_update', 'mcp_servers'])

/** @type {readonly string[]} */
export const BOUND_OUTGOING_ALLOWED = Object.freeze([
  'activity_delta', 'activity_snapshot', 'agent_busy', 'agent_completed', 'agent_event',
  'agent_idle', 'agent_spawned', 'append_memory_result', 'auth_fail', 'available_models',
  'background_work_changed', 'budget_exceeded', 'budget_resume_ack', 'budget_warning',
  'cancel_activity_ack', 'checkpoint_created', 'checkpoint_list', 'checkpoint_restored',
  'chroxy_context_hint_changed', 'claude_ready', 'client_focus_changed', 'client_joined',
  'client_left', 'code_search_results', 'conversation_id', 'credential_invalidated', 'dev_preview_status',
  'diff_result', 'error', 'evaluate_draft_result', 'evaluator_clarify', 'evaluator_rewrite',
  'extension_message', 'file_content', 'git_branches_result', 'git_stage_result',
  'git_status_result', 'git_unstage_result', 'inactivity_warning', 'input_ack', 'key_exchange_ok',
  'memory_stack_result', 'message', 'message_dequeued', 'message_queued', 'model_changed',
  'multi_question_intervention', 'pair_fail', 'pair_result', 'permission_audit_result',
  'permission_expired', 'permission_input', 'permission_mode_changed', 'permission_outcome',
  'permission_request', 'permission_resolved', 'plan_ready', 'plan_started', 'pong',
  'prompt_evaluator_changed', 'prompt_evaluator_skip_pattern_changed', 'provider_runtime_info',
  'push_token_error', 'rate_limited', 'references_result', 'result', 'server_error',
  'server_shutdown', 'session_activity', 'session_cost_threshold_crossed', 'session_error',
  'session_list', 'session_persist_failed', 'session_pr_status', 'session_pr_threads',
  'session_preamble_changed', 'session_restore_failed', 'session_status', 'session_stopped', 'session_timeout',
  'session_updated', 'session_usage', 'session_warning', 'skill_activated', 'skill_changed',
  'skill_deactivated', 'skills_list', 'stdin_dropped_totals', 'stream_delta', 'stream_end',
  'stream_start', 'summarize_session_result', 'symbol_location', 'symbols_snapshot',
  'terminal_output', 'terminal_size', 'thinking_level_changed', 'tool_input_delta', 'tool_result',
  'tool_start', 'tunnel_url_changed', 'user_question', 'write_file_result',
])

/**
 * Frames with NO outbound schema. They are emitted by name from handlers, the
 * forwarder and the server itself, so the schema roster cannot see them; they are
 * listed here by hand and tests/outgoing-policy.test.js derives the emitted names
 * from the source (both directions) so a new one must be decided.
 * @type {readonly string[]}
 */
export const BOUND_OUTGOING_SCHEMALESS_ALLOWED = Object.freeze([
  'agent_list', 'available_permission_modes', 'budget_resumed', 'confirm_permission_mode',
  'conversations_list', 'file_list', 'file_listing', 'history_replay_end', 'history_replay_start',
  'log_entry', 'permission_rules_updated', 'primary_changed', 'search_results', 'server_mode',
  'server_status', 'session_context', 'session_destroyed', 'session_role', 'session_switched',
  'slash_commands', 'status', 'subscriptions_updated', 'user_input',
])

/** Schema-less frames a session-scoped connection never receives. @type {readonly string[]} */
export const BOUND_OUTGOING_SCHEMALESS_DENIED = Object.freeze([
  // Carries the daemon's own credential. The one exception is the token-less
  // revoke notice (see frameForBoundClient): without it a connection whose
  // authentication was stripped is never told to re-authenticate.
  'token_rotated',
  // A host-wide signal.
  'pairing_refreshed',
  // Host-wide rosters and spend; their requests are unavailable to these connections.
  'repo_list', 'cost_summary',
  // Previews are unavailable to these connections.
  'dev_preview', 'dev_preview_stopped',
])

/**
 * Names the source emits that are not frames to a client (agent-control and
 * supervisor messages, provider stream events, backend plumbing). Listed so the
 * emitted-name scan in the roster test can tell them apart from a new frame.
 * @type {readonly string[]}
 */
export const NOT_CLIENT_FRAMES = Object.freeze([
  'budget_cap_reached', 'drain', 'drain_complete', 'input', 'interrupt', 'list_sessions',
  'permission_response', 'ping', 'ready', 'response', 'shutdown', 'stdin', 'stdin_end',
  'subscribe_sessions', 'system',
])

const DENIED = new Set([...BOUND_OUTGOING_DENIED, ...BOUND_OUTGOING_SCHEMALESS_DENIED])
const ALLOWED = new Set([...BOUND_OUTGOING_ALLOWED, ...BOUND_OUTGOING_SCHEMALESS_ALLOWED])
const REDACTED = new Set(BOUND_OUTGOING_REDACTED)

/** The user-level catalog entries are host-wide: only project-level ones pass. */
const projectLevel = (list) => (Array.isArray(list) ? list.filter((e) => e?.source !== 'user') : list)

/**
 * The frame a session-scoped connection should receive for `message`, or null
 * when it must receive nothing. DENY BY DEFAULT: a frame type that is not
 * classified (allowed, or redacted below) is not delivered.
 * @param {object} message
 * @returns {object|null}
 */
export function frameForBoundClient(message) {
  const type = message?.type
  if (typeof type !== 'string') return null
  if (type === 'token_rotated') {
    // The daemon's credential is never sent to this connection. Only the revoke
    // notice passes, with any token removed: it tells a connection whose
    // authentication was stripped that it must re-authenticate.
    if (message.reason !== 'revoke') return null
    return { type: 'token_rotated', reason: 'revoke' }
  }
  if (DENIED.has(type)) return null
  if (REDACTED.has(type)) {
    if (type === 'mcp_servers' && Array.isArray(message.servers)) {
      // An authorization URL carries the one-time state that completes a flow
      // writing a credential shared by every session: it is not for this connection.
      return {
        ...message,
        servers: message.servers.map((s) => {
          if (!s || typeof s !== 'object' || !('authUrl' in s)) return s
          const { authUrl: _omitted, ...rest } = s
          return rest
        }),
      }
    }
    if (type === 'cost_update') {
      // The host-wide running total is not this session's cost.
      const { totalCost: _t, ...rest } = message
      return rest
    }
    if (type === 'auth_ok') {
      // Host-wide fields: the billing snapshot, the host's feature flags and its
      // exposure summary.
      const { billingCanary: _b, webFeatures: _w, exposure: _e, ...rest } = message
      return rest
    }
    if (type === 'auth_bootstrap') {
      // The provider list carries the host's credential readiness and
      // connections; the catalogs are the project's own entries only.
      return {
        ...message,
        providers: [],
        ...(Array.isArray(message.slashCommands) ? { slashCommands: projectLevel(message.slashCommands) } : {}),
        ...(Array.isArray(message.agents) ? { agents: projectLevel(message.agents) } : {}),
      }
    }
    return message
  }
  if (ALLOWED.has(type)) return message
  return null
}
