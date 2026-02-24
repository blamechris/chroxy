import { z } from 'zod'

// -- Attachment schema (reusable) --
const AttachmentSchema = z.object({
  type: z.enum(['image', 'document']),
  mediaType: z.string(),
  data: z.string(),
  name: z.string(),
})

// -- Device info (optional in auth) --
const DeviceInfoSchema = z.object({
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']).optional(),
  platform: z.string().optional(),
}).passthrough()

// -- Individual message schemas --

export const AuthSchema = z.object({
  type: z.literal('auth'),
  token: z.string(),
  deviceInfo: DeviceInfoSchema.optional(),
}).passthrough()

export const InputSchema = z.object({
  type: z.literal('input'),
  data: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  isVoice: z.boolean().optional(),
}).passthrough()

export const ResizeSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
}).passthrough()

export const ModeSchema = z.object({
  type: z.literal('mode'),
  mode: z.enum(['terminal', 'chat']),
})

export const InterruptSchema = z.object({
  type: z.literal('interrupt'),
}).passthrough()

export const SetModelSchema = z.object({
  type: z.literal('set_model'),
  model: z.string(),
}).passthrough()

export const SetPermissionModeSchema = z.object({
  type: z.literal('set_permission_mode'),
  mode: z.enum(['approve', 'auto', 'plan', 'acceptEdits']),
  confirmed: z.boolean().optional(),
}).passthrough()

export const PermissionResponseSchema = z.object({
  type: z.literal('permission_response'),
  requestId: z.string().min(1),
  decision: z.enum(['allow', 'allowAlways', 'deny']),
})

export const ListSessionsSchema = z.object({
  type: z.literal('list_sessions'),
})

export const SwitchSessionSchema = z.object({
  type: z.literal('switch_session'),
  sessionId: z.string(),
})

export const CreateSessionSchema = z.object({
  type: z.literal('create_session'),
  name: z.string().optional(),
  cwd: z.string().optional(),
})

export const DestroySessionSchema = z.object({
  type: z.literal('destroy_session'),
  sessionId: z.string(),
})

export const RenameSessionSchema = z.object({
  type: z.literal('rename_session'),
  sessionId: z.string(),
  name: z.string(),
})

export const DiscoverSessionsSchema = z.object({
  type: z.literal('discover_sessions'),
})

export const TriggerDiscoverySchema = z.object({
  type: z.literal('trigger_discovery'),
})

export const AttachSessionSchema = z.object({
  type: z.literal('attach_session'),
  tmuxSession: z.string(),
  name: z.string().optional(),
})

export const RegisterPushTokenSchema = z.object({
  type: z.literal('register_push_token'),
  token: z.string(),
})

export const UserQuestionResponseSchema = z.object({
  type: z.literal('user_question_response'),
  answer: z.string(),
  toolUseId: z.string().optional(),
})

export const ListDirectorySchema = z.object({
  type: z.literal('list_directory'),
  path: z.string().optional(),
})

export const BrowseFilesSchema = z.object({
  type: z.literal('browse_files'),
  path: z.string().nullable().optional(),
}).passthrough()

export const ReadFileSchema = z.object({
  type: z.literal('read_file'),
  path: z.string(),
}).passthrough()

export const ListSlashCommandsSchema = z.object({
  type: z.literal('list_slash_commands'),
}).passthrough()

export const ListAgentsSchema = z.object({
  type: z.literal('list_agents'),
}).passthrough()

export const RequestFullHistorySchema = z.object({
  type: z.literal('request_full_history'),
  sessionId: z.string().optional(),
})

export const KeyExchangeSchema = z.object({
  type: z.literal('key_exchange'),
  publicKey: z.string(),
})

export const PingSchema = z.object({
  type: z.literal('ping'),
})

export const RequestSessionContextSchema = z.object({
  type: z.literal('request_session_context'),
  sessionId: z.string().optional(),
})

export const GetDiffSchema = z.object({
  type: z.literal('get_diff'),
}).passthrough()

export const ResumeBudgetSchema = z.object({
  type: z.literal('resume_budget'),
  sessionId: z.string().optional(),
})

export const ListCheckpointsSchema = z.object({
  type: z.literal('list_checkpoints'),
})

export const RestoreCheckpointSchema = z.object({
  type: z.literal('restore_checkpoint'),
  checkpointId: z.string(),
})

// Encrypted envelope — validated separately (before decryption)
export const EncryptedEnvelopeSchema = z.object({
  type: z.literal('encrypted'),
  d: z.string(),
  n: z.number().int().nonnegative(),
})

// ============================================================
// Server -> Client message schemas (documentation + test validation)
// ============================================================

const ClientInfoSchema = z.object({
  clientId: z.string(),
  deviceName: z.string().nullable(),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
  platform: z.string(),
})

export const ServerAuthOkSchema = z.object({
  type: z.literal('auth_ok'),
  clientId: z.string(),
  serverMode: z.enum(['cli', 'terminal']),
  serverVersion: z.string(),
  latestVersion: z.string().nullable(),
  serverCommit: z.string(),
  cwd: z.string().nullable(),
  connectedClients: z.array(ClientInfoSchema),
  encryption: z.enum(['required', 'disabled']),
}).passthrough()

export const ServerAuthFailSchema = z.object({
  type: z.literal('auth_fail'),
  reason: z.string(),
})

export const ServerClaudeReadySchema = z.object({
  type: z.literal('claude_ready'),
})

export const ServerStreamStartSchema = z.object({
  type: z.literal('stream_start'),
  messageId: z.string(),
})

export const ServerStreamDeltaSchema = z.object({
  type: z.literal('stream_delta'),
  messageId: z.string(),
  delta: z.string(),
})

export const ServerStreamEndSchema = z.object({
  type: z.literal('stream_end'),
  messageId: z.string(),
})

export const ServerMessageSchema = z.object({
  type: z.literal('message'),
  messageType: z.string(),
  content: z.string(),
  tool: z.string().nullable().optional(),
  options: z.any().optional(),
  timestamp: z.number(),
})

export const ServerToolStartSchema = z.object({
  type: z.literal('tool_start'),
  messageId: z.string(),
  toolUseId: z.string(),
  tool: z.string(),
  input: z.any(),
  serverName: z.string().optional(),
})

export const ServerToolResultSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  result: z.any(),
  truncated: z.boolean().optional(),
})

export const ServerResultSchema = z.object({
  type: z.literal('result'),
  cost: z.number().optional(),
  duration: z.number().optional(),
  usage: z.any().optional(),
  sessionId: z.string().nullable().optional(),
})

export const ServerModelChangedSchema = z.object({
  type: z.literal('model_changed'),
  model: z.string().nullable(),
})

export const ServerPermissionModeChangedSchema = z.object({
  type: z.literal('permission_mode_changed'),
  mode: z.string(),
})

export const ServerPermissionRequestSchema = z.object({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  description: z.string().optional(),
  input: z.any(),
  remainingMs: z.number().optional(),
})

export const ServerUserQuestionSchema = z.object({
  type: z.literal('user_question'),
  toolUseId: z.string(),
  questions: z.array(z.any()),
})

export const ServerAgentBusySchema = z.object({
  type: z.literal('agent_busy'),
})

export const ServerAgentIdleSchema = z.object({
  type: z.literal('agent_idle'),
})

export const ServerAgentSpawnedSchema = z.object({
  type: z.literal('agent_spawned'),
  toolUseId: z.string(),
  description: z.string().optional(),
  startedAt: z.number().optional(),
})

export const ServerAgentCompletedSchema = z.object({
  type: z.literal('agent_completed'),
  toolUseId: z.string(),
})

export const ServerMcpServersSchema = z.object({
  type: z.literal('mcp_servers'),
  servers: z.array(z.object({
    name: z.string(),
    status: z.string(),
  })),
})

export const ServerPlanStartedSchema = z.object({
  type: z.literal('plan_started'),
})

export const ServerPlanReadySchema = z.object({
  type: z.literal('plan_ready'),
  allowedPrompts: z.array(z.any()).optional(),
})

export const ServerSessionListSchema = z.object({
  type: z.literal('session_list'),
  sessions: z.array(z.any()),
})

export const ServerStatusUpdateSchema = z.object({
  type: z.literal('status_update'),
  model: z.string().optional(),
  cost: z.any().optional(),
  messageCount: z.number().optional(),
  contextTokens: z.number().optional(),
  contextPercent: z.number().optional(),
}).passthrough()

export const ServerErrorSchema = z.object({
  type: z.literal('server_error'),
  category: z.string().optional(),
  message: z.string(),
  recoverable: z.boolean(),
})

export const ServerShutdownSchema = z.object({
  type: z.literal('server_shutdown'),
  reason: z.enum(['restart', 'shutdown']),
  restartEtaMs: z.number(),
})

export const ServerPongSchema = z.object({
  type: z.literal('pong'),
})

export const ServerCostUpdateSchema = z.object({
  type: z.literal('cost_update'),
  sessionCost: z.number().nullable().optional(),
  totalCost: z.number().nullable().optional(),
  budget: z.number().nullable().optional(),
})

export const ServerBudgetWarningSchema = z.object({
  type: z.literal('budget_warning'),
  sessionCost: z.number(),
  budget: z.number(),
  percent: z.number(),
  message: z.string(),
})

export const ServerBudgetExceededSchema = z.object({
  type: z.literal('budget_exceeded'),
  sessionCost: z.number(),
  budget: z.number(),
  percent: z.number(),
  message: z.string(),
})

// -- Discriminated union of all client->server message types --
// Note: auth, key_exchange, and encrypted are handled before the main
// switch and are not included in this union. They are validated inline
// in _handleMessage for protocol ordering reasons. ping is also handled
// earlier but is only checked by type, not validated with PingSchema.
export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputSchema,
  ResizeSchema,
  ModeSchema,
  InterruptSchema,
  SetModelSchema,
  SetPermissionModeSchema,
  PermissionResponseSchema,
  ListSessionsSchema,
  SwitchSessionSchema,
  CreateSessionSchema,
  DestroySessionSchema,
  RenameSessionSchema,
  DiscoverSessionsSchema,
  TriggerDiscoverySchema,
  AttachSessionSchema,
  RegisterPushTokenSchema,
  UserQuestionResponseSchema,
  ListDirectorySchema,
  BrowseFilesSchema,
  ReadFileSchema,
  ListSlashCommandsSchema,
  ListAgentsSchema,
  RequestFullHistorySchema,
  RequestSessionContextSchema,
  GetDiffSchema,
  ResumeBudgetSchema,
  ListCheckpointsSchema,
  RestoreCheckpointSchema,
])
