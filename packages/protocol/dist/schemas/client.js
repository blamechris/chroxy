/**
 * Client → Server message Zod schemas.
 *
 * Moved from packages/server/src/ws-schemas.js to enable shared validation
 * across server, app, and dashboard.
 */
import { z } from 'zod';
// -- Attachment schema (reusable) --
const BinaryAttachmentSchema = z.object({
    type: z.enum(['image', 'document']),
    mediaType: z.string().max(256),
    data: z.string().max(10_000_000),
    name: z.string().max(256),
});
const FileRefAttachmentSchema = z.object({
    type: z.literal('file_ref'),
    path: z.string().max(4096),
    name: z.string().max(256).optional(),
});
const AttachmentSchema = z.union([BinaryAttachmentSchema, FileRefAttachmentSchema]);
// -- Device info (optional in auth) --
const DeviceInfoSchema = z.object({
    deviceId: z.string().max(256).optional(),
    deviceName: z.string().max(256).optional(),
    deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']).optional(),
    platform: z.string().max(256).optional(),
}).passthrough();
// -- Individual message schemas --
export const AuthSchema = z.object({
    type: z.literal('auth'),
    token: z.string().max(512),
    protocolVersion: z.number().int().min(0).optional(),
    deviceInfo: DeviceInfoSchema.optional(),
    capabilities: z.array(z.string()).optional().catch([]).default([]),
}).passthrough();
export const PairSchema = z.object({
    type: z.literal('pair'),
    pairingId: z.string().min(1).max(256),
    protocolVersion: z.number().int().min(0).optional(),
    deviceInfo: DeviceInfoSchema.optional(),
    capabilities: z.array(z.string()).optional().catch([]).default([]),
}).passthrough();
export const InputSchema = z.object({
    type: z.literal('input'),
    data: z.string().max(100_000).optional(),
    attachments: z.array(AttachmentSchema).optional(),
    isVoice: z.boolean().optional(),
}).passthrough();
export const InterruptSchema = z.object({
    type: z.literal('interrupt'),
}).passthrough();
export const SetModelSchema = z.object({
    type: z.literal('set_model'),
    model: z.string().max(256),
}).passthrough();
export const SetPermissionModeSchema = z.object({
    type: z.literal('set_permission_mode'),
    mode: z.enum(['approve', 'auto', 'plan', 'acceptEdits']),
    confirmed: z.boolean().optional(),
}).passthrough();
export const SetThinkingLevelSchema = z.object({
    type: z.literal('set_thinking_level'),
    level: z.enum(['default', 'high', 'max']),
    sessionId: z.string().max(256).optional(),
}).passthrough();
export const PermissionRuleSchema = z.object({
    tool: z.string().min(1).max(256),
    decision: z.enum(['allow', 'deny']),
});
export const SetPermissionRulesSchema = z.object({
    type: z.literal('set_permission_rules'),
    rules: z.array(PermissionRuleSchema).max(1000),
    sessionId: z.string().max(256).optional(),
});
export const PermissionResponseSchema = z.object({
    type: z.literal('permission_response'),
    requestId: z.string().min(1).max(256),
    decision: z.enum(['allow', 'allowAlways', 'deny']),
});
export const QueryPermissionAuditSchema = z.object({
    type: z.literal('query_permission_audit'),
    sessionId: z.string().max(256).optional(),
    auditType: z.enum(['mode_change', 'decision']).optional(),
    since: z.number().optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
});
export const ListSessionsSchema = z.object({
    type: z.literal('list_sessions'),
});
export const SwitchSessionSchema = z.object({
    type: z.literal('switch_session'),
    sessionId: z.string().max(256),
});
// -- Sandbox settings schema (mirrors SDK SandboxSettings) --
// Exported for reuse by clients; nested objects use .passthrough() to avoid
// silently stripping fields added by newer SDK versions.
export const SandboxSchema = z.object({
    network: z.object({
        allowedDomains: z.array(z.string().max(256)).max(256).optional(),
    }).passthrough().optional(),
    filesystem: z.object({
        allowedPaths: z.array(z.string().max(4096)).max(256).optional(),
        deniedPaths: z.array(z.string().max(4096)).max(256).optional(),
    }).passthrough().optional(),
    bash: z.object({
        allowedCommands: z.array(z.string().max(256)).max(256).optional(),
    }).passthrough().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
}).passthrough();
export const CreateSessionSchema = z.object({
    type: z.literal('create_session'),
    name: z.string().max(200).optional(),
    cwd: z.string().max(4096).optional(),
    provider: z.string().max(256).optional(),
    model: z.string().max(256).optional(),
    permissionMode: z.enum(['approve', 'acceptEdits', 'auto', 'plan']).optional(),
    worktree: z.boolean().optional(),
    sandbox: SandboxSchema.optional(),
    isolation: z.enum(['none', 'worktree', 'sandbox', 'container']).optional(),
    environmentId: z.string().max(256).optional(),
});
export const DestroySessionSchema = z.object({
    type: z.literal('destroy_session'),
    sessionId: z.string().max(256),
});
export const RenameSessionSchema = z.object({
    type: z.literal('rename_session'),
    sessionId: z.string().max(256),
    name: z.string().max(200),
});
export const RegisterPushTokenSchema = z.object({
    type: z.literal('register_push_token'),
    token: z.string().min(1).max(512),
});
export const UserQuestionResponseSchema = z.object({
    type: z.literal('user_question_response'),
    answer: z.string().max(100_000),
    answers: z.record(z.string(), z.string().max(100_000)).refine((obj) => Object.keys(obj).length <= 100, { message: 'Too many answers (max 100)' }).optional(),
    toolUseId: z.string().max(256).optional(),
});
export const ListDirectorySchema = z.object({
    type: z.literal('list_directory'),
    path: z.string().max(4096).optional(),
});
export const BrowseFilesSchema = z.object({
    type: z.literal('browse_files'),
    path: z.string().max(4096).nullable().optional(),
}).passthrough();
export const ReadFileSchema = z.object({
    type: z.literal('read_file'),
    path: z.string().max(4096),
}).passthrough();
export const WriteFileSchema = z.object({
    type: z.literal('write_file'),
    path: z.string().max(4096),
    content: z.string().max(10_000_000),
}).passthrough();
export const ListFilesSchema = z.object({
    type: z.literal('list_files'),
    query: z.string().max(1000).optional(),
}).passthrough();
export const ListSlashCommandsSchema = z.object({
    type: z.literal('list_slash_commands'),
}).passthrough();
export const ListAgentsSchema = z.object({
    type: z.literal('list_agents'),
}).passthrough();
export const RequestFullHistorySchema = z.object({
    type: z.literal('request_full_history'),
    sessionId: z.string().max(256).optional(),
});
export const KeyExchangeSchema = z.object({
    type: z.literal('key_exchange'),
    publicKey: z.string().max(512),
    salt: z.string().max(512).optional(), // base64-encoded 32-byte connection salt for per-connection key derivation
});
export const PingSchema = z.object({
    type: z.literal('ping'),
});
export const RequestSessionContextSchema = z.object({
    type: z.literal('request_session_context'),
    sessionId: z.string().max(256).optional(),
});
export const GetDiffSchema = z.object({
    type: z.literal('get_diff'),
}).passthrough();
export const GitStatusSchema = z.object({
    type: z.literal('git_status'),
}).passthrough();
export const GitBranchesSchema = z.object({
    type: z.literal('git_branches'),
}).passthrough();
export const GitStageSchema = z.object({
    type: z.literal('git_stage'),
    files: z.array(z.string().max(4096)).min(1),
}).passthrough();
export const GitUnstageSchema = z.object({
    type: z.literal('git_unstage'),
    files: z.array(z.string().max(4096)).min(1),
}).passthrough();
export const GitCommitSchema = z.object({
    type: z.literal('git_commit'),
    message: z.string().min(1).max(10_000),
}).passthrough();
export const ResumeBudgetSchema = z.object({
    type: z.literal('resume_budget'),
    sessionId: z.string().max(256).optional(),
});
export const ListCheckpointsSchema = z.object({
    type: z.literal('list_checkpoints'),
});
export const RestoreCheckpointSchema = z.object({
    type: z.literal('restore_checkpoint'),
    checkpointId: z.string().max(256),
});
export const CreateCheckpointSchema = z.object({
    type: z.literal('create_checkpoint'),
    name: z.string().max(256).optional(),
    description: z.string().max(1000).optional(),
});
export const DeleteCheckpointSchema = z.object({
    type: z.literal('delete_checkpoint'),
    checkpointId: z.string().max(256),
});
export const CloseDevPreviewSchema = z.object({
    type: z.literal('close_dev_preview'),
    port: z.number().int(),
    sessionId: z.string().max(256).optional(),
});
// -- Web task schemas --
export const LaunchWebTaskSchema = z.object({
    type: z.literal('launch_web_task'),
    prompt: z.string().min(1).max(10_000),
    cwd: z.string().max(4096).optional(),
});
export const ListWebTasksSchema = z.object({
    type: z.literal('list_web_tasks'),
});
export const TeleportWebTaskSchema = z.object({
    type: z.literal('teleport_web_task'),
    taskId: z.string().min(1).max(256),
});
// -- Conversation history schemas --
export const ListConversationsSchema = z.object({
    type: z.literal('list_conversations'),
});
export const ResumeConversationSchema = z.object({
    type: z.literal('resume_conversation'),
    conversationId: z.string().max(256),
    cwd: z.string().max(4096).optional(),
    name: z.string().max(200).optional(),
});
export const SearchConversationsSchema = z.object({
    type: z.literal('search_conversations'),
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().min(1).max(100).optional(),
});
export const RequestCostSummarySchema = z.object({
    type: z.literal('request_cost_summary'),
});
// -- Session subscription schemas --
export const SubscribeSessionsSchema = z.object({
    type: z.literal('subscribe_sessions'),
    sessionIds: z.array(z.string().max(256)).min(1).max(20),
});
export const UnsubscribeSessionsSchema = z.object({
    type: z.literal('unsubscribe_sessions'),
    sessionIds: z.array(z.string().max(256)).min(1).max(20),
});
// -- Repo management schemas --
export const ListProvidersSchema = z.object({
    type: z.literal('list_providers'),
});
export const ListReposSchema = z.object({
    type: z.literal('list_repos'),
});
export const AddRepoSchema = z.object({
    type: z.literal('add_repo'),
    path: z.string().min(1).max(4096),
    name: z.string().max(256).optional(),
});
export const RemoveRepoSchema = z.object({
    type: z.literal('remove_repo'),
    path: z.string().min(1).max(4096),
});
// -- Extension message --
export const ExtensionMessageSchema = z.object({
    type: z.literal('extension_message'),
    provider: z.string().min(1).max(256),
    subtype: z.string().min(1).max(256),
    data: z.unknown(),
    sessionId: z.string().max(256).optional(),
});
// -- Environment management --
export const CreateEnvironmentSchema = z.object({
    type: z.literal('create_environment'),
    name: z.string().max(200),
    cwd: z.string().max(4096),
    image: z.string().max(256).optional(),
    memoryLimit: z.string().max(64).optional(),
    cpuLimit: z.string().max(64).optional(),
});
export const ListEnvironmentsSchema = z.object({
    type: z.literal('list_environments'),
});
export const DestroyEnvironmentSchema = z.object({
    type: z.literal('destroy_environment'),
    environmentId: z.string().max(256),
});
export const GetEnvironmentSchema = z.object({
    type: z.literal('get_environment'),
    environmentId: z.string().max(256),
});
// -- Encrypted envelope --
export const EncryptedEnvelopeSchema = z.object({
    type: z.literal('encrypted'),
    d: z.string().max(10_000_000),
    n: z.number().int().nonnegative(),
});
// -- Discriminated union of all client->server message types --
// Note: auth, key_exchange, pair, ping, and encrypted are handled before
// the main switch in ws-server.js and are not included in this union.
export const ClientMessageSchema = z.discriminatedUnion('type', [
    InputSchema,
    InterruptSchema,
    SetModelSchema,
    SetPermissionModeSchema,
    SetThinkingLevelSchema,
    SetPermissionRulesSchema,
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
    ExtensionMessageSchema,
    CreateEnvironmentSchema,
    ListEnvironmentsSchema,
    DestroyEnvironmentSchema,
    GetEnvironmentSchema,
]);
