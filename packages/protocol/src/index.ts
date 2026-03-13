/**
 * @chroxy/protocol — shared WebSocket protocol constants
 *
 * Single source of truth for protocol versioning and message types
 * across server, app, and dashboard.
 */

/** Current protocol version. Bump when adding new message types. */
export const PROTOCOL_VERSION = 1

/**
 * Minimum protocol version the server will accept from clients.
 * Clients below this version are rejected during auth.
 */
export const MIN_PROTOCOL_VERSION = 1

/** Client → Server message types */
export const ClientMessageType = {
  Auth: 'auth',
  Input: 'input',
  Interrupt: 'interrupt',
  SetModel: 'set_model',
  SetPermissionMode: 'set_permission_mode',
  PermissionResponse: 'permission_response',
  ListSessions: 'list_sessions',
  SwitchSession: 'switch_session',
  CreateSession: 'create_session',
  DestroySession: 'destroy_session',
  RenameSession: 'rename_session',
  RegisterPushToken: 'register_push_token',
  UserQuestionResponse: 'user_question_response',
  ListDirectory: 'list_directory',
  BrowseFiles: 'browse_files',
  ReadFile: 'read_file',
  WriteFile: 'write_file',
  ListSlashCommands: 'list_slash_commands',
  ListAgents: 'list_agents',
  RequestFullHistory: 'request_full_history',
  KeyExchange: 'key_exchange',
  CreateCheckpoint: 'create_checkpoint',
  ListCheckpoints: 'list_checkpoints',
  RestoreCheckpoint: 'restore_checkpoint',
  DeleteCheckpoint: 'delete_checkpoint',
  CloseDevPreview: 'close_dev_preview',
  LaunchWebTask: 'launch_web_task',
  ListWebTasks: 'list_web_tasks',
  TeleportWebTask: 'teleport_web_task',
  Ping: 'ping',
  Encrypted: 'encrypted',
  // File & git operations
  AddRepo: 'add_repo',
  Cli: 'cli',
  GetDiff: 'get_diff',
  GitBranches: 'git_branches',
  GitCommit: 'git_commit',
  GitStage: 'git_stage',
  GitStatus: 'git_status',
  GitUnstage: 'git_unstage',
  ListFiles: 'list_files',
  ListRepos: 'list_repos',
  RemoveRepo: 'remove_repo',
  // Conversations
  ListConversations: 'list_conversations',
  ResumeConversation: 'resume_conversation',
  SearchConversations: 'search_conversations',
  // Providers & budgets
  ListProviders: 'list_providers',
  RequestCostSummary: 'request_cost_summary',
  ResumeBudget: 'resume_budget',
  // Pairing & session context
  Pair: 'pair',
  QueryPermissionAudit: 'query_permission_audit',
  RequestSessionContext: 'request_session_context',
  // Session subscriptions
  SubscribeSessions: 'subscribe_sessions',
  UnsubscribeSessions: 'unsubscribe_sessions',
} as const

export type ClientMessageTypeValue = typeof ClientMessageType[keyof typeof ClientMessageType]

/** Server → Client message types */
export const ServerMessageType = {
  AuthOk: 'auth_ok',
  KeyExchangeOk: 'key_exchange_ok',
  AuthFail: 'auth_fail',
  ServerMode: 'server_mode',
  Message: 'message',
  StreamStart: 'stream_start',
  StreamDelta: 'stream_delta',
  StreamEnd: 'stream_end',
  ToolStart: 'tool_start',
  ToolResult: 'tool_result',
  McpServers: 'mcp_servers',
  Result: 'result',
  Status: 'status',
  ClaudeReady: 'claude_ready',
  ModelChanged: 'model_changed',
  AvailableModels: 'available_models',
  PermissionRequest: 'permission_request',
  ConfirmPermissionMode: 'confirm_permission_mode',
  PermissionModeChanged: 'permission_mode_changed',
  AvailablePermissionModes: 'available_permission_modes',
  SessionList: 'session_list',
  SessionSwitched: 'session_switched',
  SessionCreated: 'session_created',
  SessionDestroyed: 'session_destroyed',
  SessionError: 'session_error',
  HistoryReplayStart: 'history_replay_start',
  HistoryReplayEnd: 'history_replay_end',
  ConversationId: 'conversation_id',
  UserQuestion: 'user_question',
  AgentBusy: 'agent_busy',
  AgentIdle: 'agent_idle',
  PlanStarted: 'plan_started',
  PlanReady: 'plan_ready',
  ServerShutdown: 'server_shutdown',
  ServerStatus: 'server_status',
  ServerError: 'server_error',
  DirectoryListing: 'directory_listing',
  FileListing: 'file_listing',
  FileContent: 'file_content',
  SlashCommands: 'slash_commands',
  AgentList: 'agent_list',
  ClientJoined: 'client_joined',
  ClientLeft: 'client_left',
  ClientFocusChanged: 'client_focus_changed',
  CheckpointCreated: 'checkpoint_created',
  CheckpointList: 'checkpoint_list',
  CheckpointRestored: 'checkpoint_restored',
  PrimaryChanged: 'primary_changed',
  Pong: 'pong',
  PermissionExpired: 'permission_expired',
  TokenRotated: 'token_rotated',
  SessionWarning: 'session_warning',
  SessionTimeout: 'session_timeout',
  DevPreview: 'dev_preview',
  DevPreviewStopped: 'dev_preview_stopped',
  WebTaskCreated: 'web_task_created',
  WebTaskUpdated: 'web_task_updated',
  WebTaskError: 'web_task_error',
  WebTaskList: 'web_task_list',
  Encrypted: 'encrypted',
  // File & git results
  DiffResult: 'diff_result',
  Error: 'error',
  FileList: 'file_list',
  GitBranchesResult: 'git_branches_result',
  GitCommitResult: 'git_commit_result',
  GitStageResult: 'git_stage_result',
  GitStatusResult: 'git_status_result',
  GitUnstageResult: 'git_unstage_result',
  WriteFileResult: 'write_file_result',
  // Session activity & context
  LogEntry: 'log_entry',
  SessionActivity: 'session_activity',
  SessionContext: 'session_context',
  SessionUpdated: 'session_updated',
  DiscoveredSessions: 'discovered_sessions',
  // Pairing
  PairFail: 'pair_fail',
  RateLimited: 'rate_limited',
  // Agent lifecycle
  AgentSpawned: 'agent_spawned',
  AgentCompleted: 'agent_completed',
  // Providers & costs
  ProviderList: 'provider_list',
  PushTokenError: 'push_token_error',
  CostUpdate: 'cost_update',
  BudgetWarning: 'budget_warning',
  BudgetExceeded: 'budget_exceeded',
  WebFeatureStatus: 'web_feature_status',
} as const

export type ServerMessageTypeValue = typeof ServerMessageType[keyof typeof ServerMessageType]
