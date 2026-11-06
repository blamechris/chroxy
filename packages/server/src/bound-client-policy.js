/**
 * Which WebSocket message types a session-scoped connection may use.
 *
 * A session-scoped ("bound") connection is one authenticated with a pairing
 * token that names a single session (`client.boundSessionId`). It exists to
 * work on THAT session and nothing else, so the registry is closed by default:
 * a message type is dispatched for a bound connection only when it is listed in
 * `BOUND_ALLOWED_MESSAGE_TYPES` below. Everything else is listed in
 * `BOUND_DENIED_MESSAGE_TYPES` (with the reason) or, if nobody has classified it
 * yet, is refused anyway — a handler added without a decision is unavailable to
 * a session-scoped connection rather than silently open to it.
 *
 * The decision is made ONCE, at the dispatch point (`handleSessionMessage` in
 * ws-message-handlers.js), not inside each handler. A per-handler check can be
 * forgotten by the next handler; a check the dispatcher applies to every message
 * cannot.
 *
 * Every allowed entry is one of:
 *   - session-local by construction: it only ever reads or acts on the
 *     connection's own session (the handler resolves the session through the
 *     bound id, and refuses a different one); or
 *   - guarded: it touches something shared, and the handler carries its own
 *     ownership check, named in the reason.
 *
 * tests/bound-client-policy.test.js asserts the classification is total, in
 * both directions: every registered handler is allowed or denied (exactly one),
 * and every name listed here is a real handler.
 */

/** @type {Readonly<Record<string, string>>} */
export const BOUND_ALLOWED_MESSAGE_TYPES = Object.freeze({
  // -- session-local: input and control of the connection's own session --
  input: 'session-local: sends to the resolved (bound) session only',
  interrupt: 'session-local: refuses a sessionId other than the bound one',
  cancel_queued: 'session-local: refuses a sessionId other than the bound one',
  cancel_activity: 'session-local: refuses a sessionId other than the bound one',
  resume_budget: 'session-local: resumes the budget pause of the resolved session',
  user_question_response: 'session-local: only answers a question routed to the bound session',
  terminal_input: 'session-local: refuses a sessionId other than the bound one',
  terminal_subscribe: 'session-local: subscription index refuses other sessions',
  terminal_unsubscribe: 'connection-local: drops this connection\'s own subscription',
  terminal_resize: 'session-local: acts on the bound session\'s terminal',
  terminal_resync: 'session-local: replays the bound session\'s terminal',
  client_visible: 'connection-local: records this connection\'s own visibility',

  // -- session roster / navigation: filtered or refused for other sessions --
  list_sessions: 'guarded: the list is filtered to the bound session',
  switch_session: 'guarded: refuses any target other than the bound session',
  subscribe_sessions: 'guarded: subscriptions to other sessions are refused',
  unsubscribe_sessions: 'connection-local: drops this connection\'s own subscriptions',
  rename_session: 'guarded: refuses a target other than the bound session',
  destroy_session: 'guarded: refuses a target other than the bound session',
  claim_primary: 'guarded: refuses a target other than the bound session',

  // -- per-session settings and permissions --
  set_model: 'session-local: resolves the bound session or refuses',
  set_thinking_level: 'session-local: resolves the bound session or refuses',
  set_permission_mode: 'guarded: bound session only, and the unattended mode is refused',
  set_prompt_evaluator: 'session-local: resolves the bound session or refuses',
  set_chroxy_context_hint: 'session-local: resolves the bound session or refuses',
  set_session_preamble: 'session-local: resolves the bound session or refuses',
  set_mcp_server_enabled: 'guarded: per-session toggle, bound session only',
  permission_response: 'guarded: only the bound session\'s own prompts; a standing "always allow" is downgraded to a one-time allow',
  get_permission_input: 'guarded: only the bound session\'s own prompts',
  query_permission_audit: 'guarded: refused unless it names the bound session',
  register_push_token: 'guarded: the registration is limited to notifications of the bound session',

  // -- skills, files, git, IDE: confined to the bound session's directory --
  list_skills: 'guarded: the bound session\'s own skills; nothing without a resolved session',
  skill_activate: 'session-local: resolves the bound session or refuses',
  skill_deactivate: 'session-local: resolves the bound session or refuses',
  browse_files: 'guarded: confined to the bound session\'s directory',
  list_files: 'guarded: confined to the bound session\'s directory',
  read_file: 'guarded: confined to the bound session\'s directory',
  memory_read: 'guarded: the bound session\'s directory; nothing without a resolved session',
  get_diff: 'guarded: limited to paths inside the bound session\'s directory',
  git_status: 'guarded: limited to paths inside the bound session\'s directory',
  git_branches: 'guarded: the bound session\'s own checkout only',
  list_slash_commands: 'guarded: the project\'s commands only (not the user-level catalog); nothing without a resolved session',
  list_agents: 'guarded: the project\'s agents only (not the user-level catalog); nothing without a resolved session',
  list_symbols: 'guarded: the workspace of the resolved (bound) session',
  resolve_symbol: 'guarded: the workspace of the resolved (bound) session',
  search_content: 'guarded: the workspace of the resolved (bound) session',
  find_references: 'guarded: the workspace of the resolved (bound) session',

  // -- history and conversations --
  list_conversations: 'guarded: only the conversation of the bound session',
  search_conversations: 'guarded: only the conversation of the bound session',
  request_conversation_transcript: 'guarded: only the conversation of the bound session; reads are concurrency-limited',
  request_full_history: 'session-local: refuses a sessionId other than the bound one',
  request_session_context: 'session-local: refuses a sessionId other than the bound one',
  summarize_session: 'session-local: binding is checked before the session is looked up',
  evaluate_draft: 'session-local: resolves the bound session or refuses',
  session_pr_status_request: 'session-local: binding is checked before the lookup',
  session_pr_threads_request: 'session-local: binding is checked before the lookup',
  extension_message: 'session-local: delivered to the resolved (bound) session only',

  // -- checkpoints: snapshots of the bound session (restoring one is denied) --
  create_checkpoint: 'session-local: records a checkpoint for the bound session',
  list_checkpoints: 'session-local: lists the bound session\'s checkpoints',
  delete_checkpoint: 'guarded: only a checkpoint of the bound session',
})

/** @type {Readonly<Record<string, string>>} */
export const BOUND_DENIED_MESSAGE_TYPES = Object.freeze({
  // -- creating or reaching other sessions --
  create_session: 'creates a new session',
  resume_conversation: 'creates a new session',
  list_failed_restores: 'host-wide roster',
  retry_failed_restore: 'acts on sessions other than the bound one',
  get_failed_restore_history: 'host-wide roster',
  list_archived_sessions: 'host-wide roster',
  get_archived_session_history: 'host-wide roster',
  delete_archived_session: 'host-wide roster',
  restore_archived_session: 'creates a session',
  set_session_archive_policy: 'host-wide policy',
  request_cost_summary: 'host-wide roster, totals and budget',

  // -- host-wide configuration and credentials --
  set_permission_rules: 'standing rules shared across sessions',
  set_prompt_evaluator_skip_pattern: 'a pattern the daemon runs on its own event loop for every input',
  add_mcp_server: 'host-wide server configuration',
  remove_mcp_server: 'host-wide server configuration',
  submit_mcp_auth_code: 'stores a credential shared by every session using the server',
  list_providers: 'host-wide configuration status',
  byok_get_credentials_status: 'host-wide credential status',
  get_credentials_status: 'host-wide credential status',
  byok_set_credentials: 'host-wide credentials',
  byok_clear_credentials: 'host-wide credentials',
  set_credential: 'host-wide credentials',
  delete_credential: 'host-wide credentials',
  test_credential: 'uses a host-wide credential',
  skill_trust_accept: 'host-wide skill trust',
  skill_trust_grant: 'host-wide skill trust',
  github_webhook_config_request: 'host-wide configuration',
  github_webhook_set_secret: 'host-wide configuration',
  github_webhook_clear_secret: 'host-wide configuration',
  notification_prefs_get: 'host-wide notification settings',
  notification_prefs_set: 'host-wide notification settings',
  session_preset_get: 'host-wide presets',
  session_preset_set: 'host-wide presets',
  session_preset_approve: 'host-wide presets',
  session_preset_revoke: 'host-wide presets',
  daemon_update_action: 'host lifecycle',
  revoke_token: 'credential management',
  pair_approve: 'credential management',
  pair_deny: 'credential management',

  // -- repositories, directories, workspace mutation --
  list_repos: 'host-wide repository inventory',
  add_repo: 'host-wide repository configuration',
  remove_repo: 'host-wide repository configuration',
  list_directory: 'enumerates directories outside the bound session',
  check_git_repo: 'probes arbitrary host directories',
  write_file: 'mutates the workspace',
  append_memory: 'mutates the workspace',
  git_stage: 'mutates the workspace',
  git_unstage: 'mutates the workspace',
  git_commit: 'mutates the workspace',
  git_create_pr: 'mutates the workspace and the remote',
  restore_checkpoint: 'rewrites the workspace, which other sessions may share',

  // -- web tasks, previews, environments --
  launch_web_task: 'starts independent execution',
  teleport_web_task: 'starts independent execution',
  list_web_tasks: 'tasks carry no owning session',
  open_dev_preview: 'publishes a host service',
  close_dev_preview: 'host service lifecycle',
  create_environment: 'host-wide environments',
  list_environments: 'host-wide environments',
  destroy_environment: 'host-wide environments',
  get_environment: 'host-wide environments',

  // -- control room, orchestration, scheduling --
  host_status_request: 'host-wide survey',
  runner_status_request: 'host-wide survey',
  containers_status_request: 'host-wide survey',
  repo_runtime_config_request: 'host-wide survey',
  byok_pool_status_request: 'host-wide survey',
  host_prune_status_request: 'host-wide survey',
  simulator_status_request: 'host-wide survey',
  emulator_status_request: 'host-wide survey',
  wsl_status_request: 'host-wide survey',
  integration_status_request: 'host-wide survey',
  skills_inventory_request: 'host-wide survey',
  mailbox_status_request: 'host-wide survey',
  external_sessions_request: 'host-wide survey',
  repo_events_request: 'host-wide survey',
  containers_action: 'host-wide action',
  byok_pool_action: 'host-wide action',
  host_prune_action: 'host-wide action',
  simulator_action: 'host-wide action',
  emulator_action: 'host-wide action',
  wsl_action: 'host-wide action',
  integration_action: 'host-wide action',
  orchestration_runs_request: 'host-wide runs',
  orchestration_run_detail_request: 'host-wide runs',
  orchestration_run_start: 'host-wide runs',
  orchestration_gate_response: 'host-wide runs',
  orchestration_run_action: 'host-wide runs',
  orchestration_run_annotate: 'host-wide runs',
  scheduled_tasks_request: 'host-wide schedule',
  scheduled_task_action: 'host-wide schedule',
  set_scheduler_enabled: 'host-wide schedule',
})

/**
 * May a session-scoped connection use this message type? Closed by default:
 * only an explicit allowed entry passes, and own-property lookup keeps
 * `__proto__` / `constructor` style type strings from matching.
 * @param {unknown} type
 * @returns {boolean}
 */
export function isBoundAllowedMessageType(type) {
  return typeof type === 'string' && Object.hasOwn(BOUND_ALLOWED_MESSAGE_TYPES, type)
}
