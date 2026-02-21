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
})

export const ModeSchema = z.object({
  type: z.literal('mode'),
  mode: z.enum(['terminal', 'chat']),
})

export const InterruptSchema = z.object({
  type: z.literal('interrupt'),
})

export const SetModelSchema = z.object({
  type: z.literal('set_model'),
  model: z.string(),
})

export const SetPermissionModeSchema = z.object({
  type: z.literal('set_permission_mode'),
  mode: z.string(),
  confirmed: z.boolean().optional(),
})

export const PermissionResponseSchema = z.object({
  type: z.literal('permission_response'),
  requestId: z.string(),
  decision: z.string(),
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
  path: z.string().optional(),
})

export const ReadFileSchema = z.object({
  type: z.literal('read_file'),
  path: z.string(),
})

export const ListSlashCommandsSchema = z.object({
  type: z.literal('list_slash_commands'),
})

export const ListAgentsSchema = z.object({
  type: z.literal('list_agents'),
})

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

// Encrypted envelope — validated separately (before decryption)
export const EncryptedEnvelopeSchema = z.object({
  type: z.literal('encrypted'),
  d: z.string(),
  n: z.number(),
})

// -- Discriminated union of all client->server message types --
// Note: auth, key_exchange, ping, and encrypted are handled before the
// main switch and are not included in this union. They are validated
// inline in _handleMessage for protocol ordering reasons.
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
])
