/**
 * Client → Server message Zod schemas.
 *
 * Moved from packages/server/src/ws-schemas.js to enable shared validation
 * across server, app, and dashboard.
 */
import { z } from 'zod'

// -- Attachment schema (reusable) --
const BinaryAttachmentSchema = z.object({
  type: z.enum(['image', 'document']),
  mediaType: z.string(),
  data: z.string(),
  name: z.string(),
})

const FileRefAttachmentSchema = z.object({
  type: z.literal('file_ref'),
  path: z.string(),
  name: z.string().optional(),
})

const AttachmentSchema = z.union([BinaryAttachmentSchema, FileRefAttachmentSchema])

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
  protocolVersion: z.number().int().min(0).optional(),
  deviceInfo: DeviceInfoSchema.optional(),
}).passthrough()

export const PairSchema = z.object({
  type: z.literal('pair'),
  pairingId: z.string().min(1),
  protocolVersion: z.number().int().min(0).optional(),
  deviceInfo: DeviceInfoSchema.optional(),
}).passthrough()

export const InputSchema = z.object({
  type: z.literal('input'),
  data: z.string().max(100_000).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  isVoice: z.boolean().optional(),
}).passthrough()

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

export const QueryPermissionAuditSchema = z.object({
  type: z.literal('query_permission_audit'),
  sessionId: z.string().optional(),
  auditType: z.enum(['mode_change', 'decision']).optional(),
  since: z.number().optional(),
  limit: z.number().optional(),
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
  name: z.string().max(200).optional(),
  cwd: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.enum(['approve', 'acceptEdits', 'auto', 'plan']).optional(),
})

export const DestroySessionSchema = z.object({
  type: z.literal('destroy_session'),
  sessionId: z.string(),
})

export const RenameSessionSchema = z.object({
  type: z.literal('rename_session'),
  sessionId: z.string(),
  name: z.string().max(200),
})

export const RegisterPushTokenSchema = z.object({
  type: z.literal('register_push_token'),
  token: z.string().min(1),
})

export const UserQuestionResponseSchema = z.object({
  type: z.literal('user_question_response'),
  answer: z.string(),
  answers: z.record(z.string(), z.string()).optional(),
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

export const WriteFileSchema = z.object({
  type: z.literal('write_file'),
  path: z.string(),
  content: z.string(),
}).passthrough()

export const ListFilesSchema = z.object({
  type: z.literal('list_files'),
  query: z.string().optional(),
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

export const GitStatusSchema = z.object({
  type: z.literal('git_status'),
}).passthrough()

export const GitBranchesSchema = z.object({
  type: z.literal('git_branches'),
}).passthrough()

export const GitStageSchema = z.object({
  type: z.literal('git_stage'),
  files: z.array(z.string()).min(1),
}).passthrough()

export const GitUnstageSchema = z.object({
  type: z.literal('git_unstage'),
  files: z.array(z.string()).min(1),
}).passthrough()

export const GitCommitSchema = z.object({
  type: z.literal('git_commit'),
  message: z.string().min(1),
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

export const CreateCheckpointSchema = z.object({
  type: z.literal('create_checkpoint'),
  name: z.string().optional(),
  description: z.string().optional(),
})

export const DeleteCheckpointSchema = z.object({
  type: z.literal('delete_checkpoint'),
  checkpointId: z.string(),
})

export const CloseDevPreviewSchema = z.object({
  type: z.literal('close_dev_preview'),
  port: z.number().int(),
  sessionId: z.string().optional(),
})

// -- Web task schemas --

export const LaunchWebTaskSchema = z.object({
  type: z.literal('launch_web_task'),
  prompt: z.string().min(1).max(10_000),
  cwd: z.string().optional(),
})

export const ListWebTasksSchema = z.object({
  type: z.literal('list_web_tasks'),
})

export const TeleportWebTaskSchema = z.object({
  type: z.literal('teleport_web_task'),
  taskId: z.string().min(1),
})

// -- Conversation history schemas --

export const ListConversationsSchema = z.object({
  type: z.literal('list_conversations'),
})

export const ResumeConversationSchema = z.object({
  type: z.literal('resume_conversation'),
  conversationId: z.string(),
  cwd: z.string().optional(),
  name: z.string().max(200).optional(),
})

export const SearchConversationsSchema = z.object({
  type: z.literal('search_conversations'),
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(100).optional(),
})

export const RequestCostSummarySchema = z.object({
  type: z.literal('request_cost_summary'),
})

// -- Session subscription schemas --

export const SubscribeSessionsSchema = z.object({
  type: z.literal('subscribe_sessions'),
  sessionIds: z.array(z.string()).min(1).max(20),
})

export const UnsubscribeSessionsSchema = z.object({
  type: z.literal('unsubscribe_sessions'),
  sessionIds: z.array(z.string()).min(1).max(20),
})

// -- Repo management schemas --

export const ListProvidersSchema = z.object({
  type: z.literal('list_providers'),
})

export const ListReposSchema = z.object({
  type: z.literal('list_repos'),
})

export const AddRepoSchema = z.object({
  type: z.literal('add_repo'),
  path: z.string().min(1),
  name: z.string().optional(),
})

export const RemoveRepoSchema = z.object({
  type: z.literal('remove_repo'),
  path: z.string().min(1),
})

// -- Encrypted envelope --

export const EncryptedEnvelopeSchema = z.object({
  type: z.literal('encrypted'),
  d: z.string(),
  n: z.number().int().nonnegative(),
})

// -- Discriminated union of all client->server message types --
// Note: auth, key_exchange, pair, ping, and encrypted are handled before
// the main switch in ws-server.js and are not included in this union.
export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputSchema,
  InterruptSchema,
  SetModelSchema,
  SetPermissionModeSchema,
  PermissionResponseSchema,
  ListSessionsSchema,
  SwitchSessionSchema,
  CreateSessionSchema,
  DestroySessionSchema,
  RenameSessionSchema,
  RegisterPushTokenSchema,
  UserQuestionResponseSchema,
  ListDirectorySchema,
  BrowseFilesSchema,
  ReadFileSchema,
  WriteFileSchema,
  ListFilesSchema,
  ListSlashCommandsSchema,
  ListAgentsSchema,
  RequestFullHistorySchema,
  RequestSessionContextSchema,
  GetDiffSchema,
  GitStatusSchema,
  GitBranchesSchema,
  GitStageSchema,
  GitUnstageSchema,
  GitCommitSchema,
  ResumeBudgetSchema,
  ListCheckpointsSchema,
  RestoreCheckpointSchema,
  CreateCheckpointSchema,
  DeleteCheckpointSchema,
  CloseDevPreviewSchema,
  LaunchWebTaskSchema,
  ListWebTasksSchema,
  TeleportWebTaskSchema,
  ListConversationsSchema,
  ResumeConversationSchema,
  SearchConversationsSchema,
  RequestCostSummarySchema,
  SubscribeSessionsSchema,
  UnsubscribeSessionsSchema,
  ListProvidersSchema,
  ListReposSchema,
  AddRepoSchema,
  RemoveRepoSchema,
  QueryPermissionAuditSchema,
])

// -- Inferred TypeScript types --

export type AuthMessage = z.infer<typeof AuthSchema>
export type PairMessage = z.infer<typeof PairSchema>
export type InputMessage = z.infer<typeof InputSchema>
export type InterruptMessage = z.infer<typeof InterruptSchema>
export type SetModelMessage = z.infer<typeof SetModelSchema>
export type SetPermissionModeMessage = z.infer<typeof SetPermissionModeSchema>
export type PermissionResponseMessage = z.infer<typeof PermissionResponseSchema>
export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>
