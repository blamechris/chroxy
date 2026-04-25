/**
 * Server → Client message Zod schemas.
 *
 * Moved from packages/server/src/ws-schemas.js to enable shared validation
 * across server, app, and dashboard.
 */
import { z } from 'zod'

const ClientInfoSchema = z.object({
  clientId: z.string(),
  deviceName: z.string().nullable(),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'unknown']),
  platform: z.string(),
})

export const ServerAuthOkSchema = z.object({
  type: z.literal('auth_ok'),
  clientId: z.string(),
  serverMode: z.literal('cli'),
  serverVersion: z.string(),
  latestVersion: z.string().nullable(),
  serverCommit: z.string(),
  cwd: z.string().nullable(),
  connectedClients: z.array(ClientInfoSchema),
  encryption: z.enum(['required', 'disabled']),
  protocolVersion: z.number().int().min(1),
  minProtocolVersion: z.number().int().min(1),
  maxProtocolVersion: z.number().int().min(1),
}).passthrough()

export const ServerAuthFailSchema = z.object({
  type: z.literal('auth_fail'),
  reason: z.string(),
})

export const ServerPairFailSchema = z.object({
  type: z.literal('pair_fail'),
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
  code: z.string().max(64).optional(),
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

export const ServerClientFocusChangedSchema = z.object({
  type: z.literal('client_focus_changed'),
  clientId: z.string(),
  sessionId: z.string(),
  timestamp: z.number(),
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

/**
 * Emitted when a session in the persisted state file could not be restored
 * at server startup (e.g. missing env var for a Codex/Gemini provider).
 *
 * History on disk is preserved (`originalHistoryPreserved: true`) so the user
 * can retry after fixing the underlying issue. Dashboards / mobile UIs should
 * surface the failed session in a "needs attention" state with the reported
 * error and a retry affordance. See issue #2954 (Guardian FM-01).
 */
export const ServerSessionRestoreFailedSchema = z.object({
  type: z.literal('session_restore_failed'),
  sessionId: z.string(),
  name: z.string(),
  provider: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
  originalHistoryPreserved: z.boolean(),
})

export const ServerProviderListSchema = z.object({
  type: z.literal('provider_list'),
  providers: z.array(z.object({
    name: z.string(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
  })),
})

export const ServerSkillsListSchema = z.object({
  type: z.literal('skills_list'),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
  })),
})

export const ServerErrorSchema = z.object({
  type: z.literal('server_error'),
  category: z.string().optional(),
  message: z.string(),
  recoverable: z.boolean(),
})

export const ServerPushTokenErrorSchema = z.object({
  type: z.literal('push_token_error'),
  message: z.string(),
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

// -- Web task schemas --

const WebTaskSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  createdAt: z.number(),
  updatedAt: z.number(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  cwd: z.string().optional(),
})

export const ServerWebFeatureStatusSchema = z.object({
  type: z.literal('web_feature_status'),
  available: z.boolean(),
  remote: z.boolean(),
  teleport: z.boolean(),
})

export const ServerWebTaskCreatedSchema = z.object({
  type: z.literal('web_task_created'),
  task: WebTaskSchema,
})

export const ServerWebTaskUpdatedSchema = z.object({
  type: z.literal('web_task_updated'),
  task: WebTaskSchema,
})

/**
 * Emitted when a web (cloud) task command fails. Two failure shapes share this
 * envelope:
 *
 * 1. **Generic task failure** — only `taskId` and `message` are populated
 *    (e.g. missing prompt, validation error, downstream task error).
 * 2. **`SESSION_TOKEN_MISMATCH` rejection** — emitted when a client bound to
 *    one session attempts a `web_task_*` command against a different session.
 *    In this case the payload also carries the canonical four-field contract
 *    documented in `docs/error-taxonomy.md`: `code`, `message`, `boundSessionId`,
 *    `boundSessionName`. The same four fields appear on every envelope that
 *    can carry SESSION_TOKEN_MISMATCH (`session_error`, `error`, this schema,
 *    and the HTTP 403 body) and originate from
 *    `buildSessionTokenMismatchPayload()` in `packages/server/src/handler-utils.js`.
 */
export const ServerWebTaskErrorSchema = z.object({
  type: z.literal('web_task_error'),
  taskId: z.string().nullable().optional(),
  message: z.string(),
  /**
   * Machine-readable error code. Currently only `'SESSION_TOKEN_MISMATCH'` is
   * emitted on this envelope; absent for generic task failures. Clients
   * branch on this field to drive bound-session recovery flows. See
   * `docs/error-taxonomy.md` § SESSION_TOKEN_MISMATCH.
   */
  code: z.string().optional(),
  /**
   * The session ID the client's auth token is bound to. Populated on
   * `SESSION_TOKEN_MISMATCH` rejections so the client can surface which
   * session the device is paired to. `null` when the caller has no binding
   * (HTTP fallback path); a stale or unresolvable session ID is preserved
   * as-is. Sourced from `buildSessionTokenMismatchPayload()`.
   */
  boundSessionId: z.string().nullable().optional(),
  /**
   * Display name of the bound session, looked up at emit time via
   * `sessionManager.getSession()`. `null` when `boundSessionId` is null or
   * the session can no longer be resolved. Used by clients to render
   * actionable messages like "Device paired to _My Project_". Sourced from
   * `buildSessionTokenMismatchPayload()`.
   */
  boundSessionName: z.string().nullable().optional(),
})

export const ServerWebTaskListSchema = z.object({
  type: z.literal('web_task_list'),
  tasks: z.array(WebTaskSchema),
})

// -- Extension message (server → client) --

export const ServerExtensionMessageSchema = z.object({
  type: z.literal('extension_message'),
  provider: z.string().min(1),
  subtype: z.string().min(1),
  data: z.unknown(),
  sessionId: z.string().optional(),
})

// -- Inferred TypeScript types --

export type ServerAuthOkMessage = z.infer<typeof ServerAuthOkSchema>
export type ServerStreamDeltaMessage = z.infer<typeof ServerStreamDeltaSchema>
export type ServerPermissionRequestMessage = z.infer<typeof ServerPermissionRequestSchema>
export type ServerErrorMessage = z.infer<typeof ServerErrorSchema>
export type ServerCostUpdateMessage = z.infer<typeof ServerCostUpdateSchema>
export type ServerExtensionMessage = z.infer<typeof ServerExtensionMessageSchema>
export type ServerSkillsListMessage = z.infer<typeof ServerSkillsListSchema>
