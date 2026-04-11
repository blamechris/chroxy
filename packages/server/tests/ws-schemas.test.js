import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AuthSchema,
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
  ListProvidersSchema,
  RequestFullHistorySchema,
  KeyExchangeSchema,
  PingSchema,
  RequestSessionContextSchema,
  GetDiffSchema,
  GitStageSchema,
  GitCommitSchema,
  ResumeBudgetSchema,
  ListCheckpointsSchema,
  RestoreCheckpointSchema,
  CreateCheckpointSchema,
  DeleteCheckpointSchema,
  CloseDevPreviewSchema,
  EncryptedEnvelopeSchema,
  ClientMessageSchema,
  ServerAuthOkSchema,
  ServerAuthFailSchema,
  ServerClaudeReadySchema,
  ServerStreamStartSchema,
  ServerStreamDeltaSchema,
  ServerStreamEndSchema,
  ServerMessageSchema,
  ServerToolStartSchema,
  ServerToolResultSchema,
  ServerResultSchema,
  ServerModelChangedSchema,
  ServerPermissionModeChangedSchema,
  ServerPermissionRequestSchema,
  ServerUserQuestionSchema,
  ServerAgentBusySchema,
  ServerAgentIdleSchema,
  ServerAgentSpawnedSchema,
  ServerAgentCompletedSchema,
  ServerClientFocusChangedSchema,
  ServerPlanStartedSchema,
  ServerPlanReadySchema,
  ServerSessionListSchema,
  ServerProviderListSchema,
  ServerErrorSchema,
  ServerShutdownSchema,
  ServerPongSchema,
  ServerMcpServersSchema,
  ServerCostUpdateSchema,
  ServerBudgetWarningSchema,
  ServerBudgetExceededSchema,
  SearchConversationsSchema,
  SubscribeSessionsSchema,
  UnsubscribeSessionsSchema,
  ListReposSchema,
  AddRepoSchema,
  RemoveRepoSchema,
  LaunchWebTaskSchema,
  ListWebTasksSchema,
  TeleportWebTaskSchema,
  ServerWebFeatureStatusSchema,
  ServerWebTaskCreatedSchema,
  ServerWebTaskUpdatedSchema,
  ServerWebTaskErrorSchema,
  ServerWebTaskListSchema,
} from '../src/ws-schemas.js'

// ============================================================
// Client -> Server: schemas with custom validators / enums
// ============================================================

describe('AuthSchema', () => {
  it('accepts valid auth with deviceInfo', () => {
    const result = AuthSchema.safeParse({
      type: 'auth', token: 'abc123',
      deviceInfo: { deviceId: 'dev1', deviceName: 'iPhone', deviceType: 'phone', platform: 'ios' },
    })
    assert.ok(result.success)
    assert.equal(result.data.deviceInfo.deviceType, 'phone')
  })

  it('rejects wrong type literal', () => {
    assert.ok(!AuthSchema.safeParse({ type: 'login', token: 'abc' }).success)
  })
})

describe('InputSchema', () => {
  it('accepts input with attachments and isVoice', () => {
    const result = InputSchema.safeParse({
      type: 'input', data: 'check this', isVoice: true,
      attachments: [{ type: 'image', mediaType: 'image/png', data: 'base64data', name: 'screenshot.png' }],
    })
    assert.ok(result.success)
    assert.equal(result.data.attachments.length, 1)
  })

  it('enforces max data length (#1920)', () => {
    assert.ok(!InputSchema.safeParse({ type: 'input', data: 'x'.repeat(100_001) }).success)
    assert.ok(InputSchema.safeParse({ type: 'input', data: 'x'.repeat(100_000) }).success)
  })

  it('rejects invalid attachment shape', () => {
    assert.ok(!InputSchema.safeParse({ type: 'input', data: 'test', attachments: [{ bad: true }] }).success)
  })
})

describe('SetPermissionModeSchema', () => {
  it('accepts all valid modes with confirmed flag', () => {
    for (const mode of ['approve', 'auto', 'plan', 'acceptEdits']) {
      assert.ok(SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode }).success)
    }
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'auto', confirmed: true })
    assert.ok(result.success && result.data.confirmed)
  })

  it('rejects invalid mode value', () => {
    assert.ok(!SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'bypassAll' }).success)
  })
})

describe('PermissionResponseSchema', () => {
  it('accepts all valid decisions', () => {
    for (const decision of ['allow', 'allowAlways', 'deny']) {
      assert.ok(PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1', decision }).success)
    }
  })

  it('rejects empty requestId and invalid decision', () => {
    assert.ok(!PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: '', decision: 'allow' }).success)
    assert.ok(!PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1', decision: 'maybe' }).success)
  })
})

describe('CreateSessionSchema', () => {
  it('preserves provider field through validation', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', cwd: '/tmp', provider: 'claude-sdk' })
    assert.ok(result.success)
    assert.equal(result.data.provider, 'claude-sdk')
  })

  it('rejects name exceeding max length (#1920)', () => {
    assert.ok(!CreateSessionSchema.safeParse({ type: 'create_session', name: 'x'.repeat(201) }).success)
  })

  it('preserves model and permissionMode fields', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', model: 'opus', permissionMode: 'auto' })
    assert.ok(result.success)
    assert.equal(result.data.model, 'opus')
    assert.equal(result.data.permissionMode, 'auto')
  })

  it('rejects invalid permissionMode values', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', permissionMode: 'invalid' })
    assert.ok(!result.success)
  })

  it('accepts all valid permissionMode values', () => {
    for (const mode of ['approve', 'acceptEdits', 'auto', 'plan']) {
      const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', permissionMode: mode })
      assert.ok(result.success, `Should accept permissionMode "${mode}"`)
    }
  })

  it('accepts all valid isolation values (#2475)', () => {
    for (const isolation of ['none', 'worktree', 'sandbox', 'container']) {
      const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', isolation })
      assert.ok(result.success, `Should accept isolation "${isolation}"`)
      assert.equal(result.data.isolation, isolation)
    }
  })

  it('rejects invalid isolation values (#2475)', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', isolation: 'docker' })
    assert.ok(!result.success)
  })

  it('isolation field is optional (#2475)', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev' })
    assert.ok(result.success)
    assert.equal(result.data.isolation, undefined)
  })
})

describe('RenameSessionSchema', () => {
  it('accepts valid rename', () => {
    assert.ok(RenameSessionSchema.safeParse({ type: 'rename_session', sessionId: 'sess-1', name: 'new-name' }).success)
  })

  it('rejects name exceeding max length (#1920)', () => {
    assert.ok(!RenameSessionSchema.safeParse({ type: 'rename_session', sessionId: 'sess-1', name: 'x'.repeat(201) }).success)
  })
})

describe('EncryptedEnvelopeSchema', () => {
  it('accepts valid envelope', () => {
    assert.ok(EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'ciphertext', n: 42 }).success)
  })

  it('rejects invalid nonce values', () => {
    assert.ok(!EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'data', n: -1 }).success)
    assert.ok(!EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'data', n: 1.5 }).success)
  })
})

describe('CloseDevPreviewSchema', () => {
  it('accepts valid close_dev_preview', () => {
    const result = CloseDevPreviewSchema.safeParse({ type: 'close_dev_preview', port: 8080, sessionId: 's-1' })
    assert.ok(result.success)
    assert.equal(result.data.sessionId, 's-1')
  })

  it('rejects non-integer port', () => {
    assert.ok(!CloseDevPreviewSchema.safeParse({ type: 'close_dev_preview', port: 3.14 }).success)
  })
})

// -- Simple client schemas: one smoke test each --
describe('simple client schemas', () => {
  const cases = [
    ['InterruptSchema', InterruptSchema, { type: 'interrupt' }],
    ['SetModelSchema', SetModelSchema, { type: 'set_model', model: 'claude-sonnet' }],
    ['ListSessionsSchema', ListSessionsSchema, { type: 'list_sessions' }],
    ['SwitchSessionSchema', SwitchSessionSchema, { type: 'switch_session', sessionId: 'sess-1' }],
    ['DestroySessionSchema', DestroySessionSchema, { type: 'destroy_session', sessionId: 'sess-1' }],
    ['RegisterPushTokenSchema', RegisterPushTokenSchema, { type: 'register_push_token', token: 'ExponentPushToken[abc]' }],
    ['UserQuestionResponseSchema', UserQuestionResponseSchema, { type: 'user_question_response', answer: 'yes', toolUseId: 'tu-1' }],
    ['ListDirectorySchema', ListDirectorySchema, { type: 'list_directory', path: '/home' }],
    ['BrowseFilesSchema', BrowseFilesSchema, { type: 'browse_files', path: null }],
    ['ReadFileSchema', ReadFileSchema, { type: 'read_file', path: '/etc/hosts' }],
    ['ListFilesSchema', ListFilesSchema, { type: 'list_files', query: 'index' }],
    ['ListSlashCommandsSchema', ListSlashCommandsSchema, { type: 'list_slash_commands' }],
    ['ListAgentsSchema', ListAgentsSchema, { type: 'list_agents' }],
    ['ListProvidersSchema', ListProvidersSchema, { type: 'list_providers' }],
    ['RequestFullHistorySchema', RequestFullHistorySchema, { type: 'request_full_history', sessionId: 'sess-1' }],
    ['KeyExchangeSchema', KeyExchangeSchema, { type: 'key_exchange', publicKey: 'base64pubkey', salt: 'base64salt' }],
    ['PingSchema', PingSchema, { type: 'ping' }],
    ['RequestSessionContextSchema', RequestSessionContextSchema, { type: 'request_session_context', sessionId: 'sess-1' }],
    ['GetDiffSchema', GetDiffSchema, { type: 'get_diff' }],
    ['ResumeBudgetSchema', ResumeBudgetSchema, { type: 'resume_budget' }],
    ['ListCheckpointsSchema', ListCheckpointsSchema, { type: 'list_checkpoints' }],
    ['RestoreCheckpointSchema', RestoreCheckpointSchema, { type: 'restore_checkpoint', checkpointId: 'cp-1' }],
    ['DeleteCheckpointSchema', DeleteCheckpointSchema, { type: 'delete_checkpoint', checkpointId: 'cp-1' }],
  ]
  for (const [name, schema, input] of cases) {
    it(`${name} accepts valid message`, () => {
      assert.ok(schema.safeParse(input).success)
    })
  }

  it('CreateCheckpointSchema accepts with name and description', () => {
    const result = CreateCheckpointSchema.safeParse({ type: 'create_checkpoint', name: 'v1', description: 'First checkpoint' })
    assert.ok(result.success)
    assert.equal(result.data.name, 'v1')
  })
})

// -- ClientMessageSchema (discriminated union) --
describe('ClientMessageSchema', () => {
  it('dispatches typed messages correctly', () => {
    const result1 = ClientMessageSchema.safeParse({ type: 'input', data: 'hello' })
    assert.ok(result1.success)
    assert.equal(result1.data.type, 'input')

    const result2 = ClientMessageSchema.safeParse({ type: 'permission_response', requestId: 'r1', decision: 'allow' })
    assert.ok(result2.success)
    assert.equal(result2.data.type, 'permission_response')
  })

  it('rejects unknown types and missing type field', () => {
    assert.ok(!ClientMessageSchema.safeParse({ type: 'unknown_type' }).success)
    assert.ok(!ClientMessageSchema.safeParse({ type: 'switch_session' }).success)
    assert.ok(!ClientMessageSchema.safeParse({ data: 'hello' }).success)
  })

  it('validates all simple command types', () => {
    for (const type of ['interrupt', 'list_sessions', 'list_slash_commands', 'list_agents', 'get_diff', 'list_checkpoints', 'create_checkpoint', 'list_repos', 'list_providers']) {
      assert.ok(ClientMessageSchema.safeParse({ type }).success, `Expected ${type} to be valid`)
    }
  })

  it('produces structured error for malformed messages', () => {
    const result = ClientMessageSchema.safeParse({ type: 'resize', cols: 'wide', rows: 40 })
    assert.ok(!result.success)
    assert.ok(result.error.issues.length > 0)
    for (const issue of result.error.issues) {
      assert.equal(typeof issue.message, 'string')
    }
  })
})

// ============================================================
// Server -> Client schemas
// ============================================================

describe('ServerAuthOkSchema', () => {
  it('accepts valid auth_ok with connected clients', () => {
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok', clientId: 'abc', serverMode: 'cli', serverVersion: '0.1.0',
      latestVersion: '0.2.0', serverCommit: 'abc', cwd: null,
      connectedClients: [{ clientId: 'c1', deviceName: 'iPhone', deviceType: 'phone', platform: 'ios' }],
      encryption: 'disabled', protocolVersion: 1, minProtocolVersion: 1, maxProtocolVersion: 1,
    })
    assert.ok(result.success)
  })

  it('rejects invalid serverMode', () => {
    for (const badMode of ['pty', 'terminal', 'unknown']) {
      const result = ServerAuthOkSchema.safeParse({
        type: 'auth_ok', clientId: 'abc', serverMode: badMode, serverVersion: '0.1.0',
        latestVersion: null, serverCommit: 'abc', cwd: null, connectedClients: [],
        encryption: 'disabled', protocolVersion: 1, minProtocolVersion: 1, maxProtocolVersion: 1,
      })
      assert.ok(!result.success, `Expected '${badMode}' to be rejected`)
    }
  })

  it('requires protocolVersion as integer', () => {
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok', clientId: 'abc', serverMode: 'cli', serverVersion: '0.1.0',
      latestVersion: null, serverCommit: 'abc', cwd: null, connectedClients: [],
      encryption: 'disabled', protocolVersion: 1.5, minProtocolVersion: 1, maxProtocolVersion: 1,
    })
    assert.ok(!result.success, 'Should reject non-integer protocolVersion')
  })
})

describe('ServerShutdownSchema', () => {
  it('accepts valid and rejects invalid reason enum', () => {
    assert.ok(ServerShutdownSchema.safeParse({ type: 'server_shutdown', reason: 'restart', restartEtaMs: 5000 }).success)
    assert.ok(!ServerShutdownSchema.safeParse({ type: 'server_shutdown', reason: 'crash', restartEtaMs: 0 }).success)
  })
})

describe('ServerErrorSchema', () => {
  it('accepts valid server_error', () => {
    assert.ok(ServerErrorSchema.safeParse({ type: 'server_error', category: 'tunnel', message: 'Connection lost', recoverable: true }).success)
  })

  it('rejects missing recoverable', () => {
    assert.ok(!ServerErrorSchema.safeParse({ type: 'server_error', message: 'fail' }).success)
  })
})

describe('ServerProviderListSchema', () => {
  it('accepts providers with and without capabilities', () => {
    assert.ok(ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ name: 'claude-sdk', capabilities: { permissions: true, modelSwitch: true } }, { name: 'cli' }],
    }).success)
  })

  it('rejects missing providers array', () => {
    assert.ok(!ServerProviderListSchema.safeParse({ type: 'provider_list' }).success)
  })
})

describe('ServerMcpServersSchema', () => {
  it('accepts valid mcp_servers message', () => {
    const result = ServerMcpServersSchema.safeParse({
      type: 'mcp_servers', servers: [{ name: 'filesystem', status: 'connected' }, { name: 'github', status: 'failed' }],
    })
    assert.ok(result.success)
    assert.equal(result.data.servers.length, 2)
  })

  it('rejects missing servers field', () => {
    assert.ok(!ServerMcpServersSchema.safeParse({ type: 'mcp_servers' }).success)
  })
})

// -- Simple server schemas: one smoke test each --
describe('simple server schemas', () => {
  const cases = [
    ['ServerAuthFailSchema', ServerAuthFailSchema, { type: 'auth_fail', reason: 'bad token' }],
    ['ServerClaudeReadySchema', ServerClaudeReadySchema, { type: 'claude_ready' }],
    ['ServerStreamStartSchema', ServerStreamStartSchema, { type: 'stream_start', messageId: 'msg-1' }],
    ['ServerStreamDeltaSchema', ServerStreamDeltaSchema, { type: 'stream_delta', messageId: 'msg-1', delta: 'Hello' }],
    ['ServerStreamEndSchema', ServerStreamEndSchema, { type: 'stream_end', messageId: 'msg-1' }],
    ['ServerMessageSchema', ServerMessageSchema, { type: 'message', messageType: 'response', content: 'Hello!', timestamp: Date.now() }],
    ['ServerToolResultSchema', ServerToolResultSchema, { type: 'tool_result', toolUseId: 'tu1', result: 'contents' }],
    ['ServerModelChangedSchema', ServerModelChangedSchema, { type: 'model_changed', model: null }],
    ['ServerPermissionModeChangedSchema', ServerPermissionModeChangedSchema, { type: 'permission_mode_changed', mode: 'approve' }],
    ['ServerPermissionRequestSchema', ServerPermissionRequestSchema, { type: 'permission_request', requestId: 'req-1', tool: 'Bash', input: 'ls -la' }],
    ['ServerUserQuestionSchema', ServerUserQuestionSchema, { type: 'user_question', toolUseId: 'tu1', questions: [{ question: 'Which?', options: ['A', 'B'] }] }],
    ['ServerAgentBusySchema', ServerAgentBusySchema, { type: 'agent_busy' }],
    ['ServerAgentIdleSchema', ServerAgentIdleSchema, { type: 'agent_idle' }],
    ['ServerAgentSpawnedSchema', ServerAgentSpawnedSchema, { type: 'agent_spawned', toolUseId: 'tu1', description: 'Explore', startedAt: Date.now() }],
    ['ServerAgentCompletedSchema', ServerAgentCompletedSchema, { type: 'agent_completed', toolUseId: 'tu1' }],
    ['ServerClientFocusChangedSchema', ServerClientFocusChangedSchema, { type: 'client_focus_changed', clientId: 'c1', sessionId: 'sess-a', timestamp: 1709100000000 }],
    ['ServerPlanStartedSchema', ServerPlanStartedSchema, { type: 'plan_started' }],
    ['ServerPlanReadySchema', ServerPlanReadySchema, { type: 'plan_ready', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] }],
    ['ServerSessionListSchema', ServerSessionListSchema, { type: 'session_list', sessions: [{ sessionId: 's1', name: 'Test', isBusy: false }] }],
    ['ServerPongSchema', ServerPongSchema, { type: 'pong' }],
    ['ServerCostUpdateSchema', ServerCostUpdateSchema, { type: 'cost_update', sessionCost: 0.5, totalCost: 1.2, budget: 5.0 }],
    ['ServerBudgetWarningSchema', ServerBudgetWarningSchema, { type: 'budget_warning', sessionCost: 4.5, budget: 5.0, percent: 90, message: 'Almost at budget' }],
    ['ServerBudgetExceededSchema', ServerBudgetExceededSchema, { type: 'budget_exceeded', sessionCost: 5.5, budget: 5.0, percent: 110, message: 'Budget exceeded' }],
  ]
  for (const [name, schema, input] of cases) {
    it(`${name} accepts valid message`, () => {
      assert.ok(schema.safeParse(input).success)
    })
  }

  it('ServerToolStartSchema accepts with serverName', () => {
    const result = ServerToolStartSchema.safeParse({
      type: 'tool_start', messageId: 'm2', toolUseId: 'tu2',
      tool: 'mcp__filesystem__read_file', input: null, serverName: 'filesystem',
    })
    assert.ok(result.success)
    assert.equal(result.data.serverName, 'filesystem')
  })

  it('ServerResultSchema accepts with all optional fields', () => {
    assert.ok(ServerResultSchema.safeParse({
      type: 'result', cost: 0.1, duration: 5000, usage: { inputTokens: 100, outputTokens: 50 }, sessionId: 'sdk-abc',
    }).success)
  })
})

// ============================================================
// SearchConversationsSchema — trim transform + boundary constraints
// ============================================================

describe('SearchConversationsSchema (#1076)', () => {
  it('accepts valid search with maxResults', () => {
    const result = SearchConversationsSchema.safeParse({ type: 'search_conversations', query: 'test', maxResults: 25 })
    assert.ok(result.success)
    assert.equal(result.data.maxResults, 25)
  })

  it('trims whitespace from query', () => {
    const result = SearchConversationsSchema.safeParse({ type: 'search_conversations', query: '  trimmed  ' })
    assert.ok(result.success)
    assert.equal(result.data.query, 'trimmed')
  })

  it('rejects whitespace-only query (trims to empty)', () => {
    assert.ok(!SearchConversationsSchema.safeParse({ type: 'search_conversations', query: '   ' }).success)
  })

  it('enforces query length bounds', () => {
    assert.ok(!SearchConversationsSchema.safeParse({ type: 'search_conversations', query: 'x'.repeat(501) }).success)
    assert.ok(SearchConversationsSchema.safeParse({ type: 'search_conversations', query: 'x'.repeat(500) }).success)
  })

  it('enforces maxResults constraints', () => {
    assert.ok(!SearchConversationsSchema.safeParse({ type: 'search_conversations', query: 'test', maxResults: 0 }).success)
    assert.ok(!SearchConversationsSchema.safeParse({ type: 'search_conversations', query: 'test', maxResults: 101 }).success)
    assert.ok(!SearchConversationsSchema.safeParse({ type: 'search_conversations', query: 'test', maxResults: 2.5 }).success)
  })

  it('dispatches through ClientMessageSchema', () => {
    const result = ClientMessageSchema.safeParse({ type: 'search_conversations', query: 'test query' })
    assert.ok(result.success)
    assert.equal(result.data.type, 'search_conversations')
  })
})

// ============================================================
// Session subscription schemas — array bounds (min 1, max 20)
// ============================================================

describe('SubscribeSessionsSchema', () => {
  it('accepts valid subscribe_sessions', () => {
    const result = SubscribeSessionsSchema.safeParse({ type: 'subscribe_sessions', sessionIds: ['sess-1', 'sess-2'] })
    assert.ok(result.success)
    assert.deepEqual(result.data.sessionIds, ['sess-1', 'sess-2'])
  })

  it('enforces array bounds', () => {
    assert.ok(!SubscribeSessionsSchema.safeParse({ type: 'subscribe_sessions', sessionIds: [] }).success)
    const ids = Array.from({ length: 21 }, (_, i) => `sess-${i}`)
    assert.ok(!SubscribeSessionsSchema.safeParse({ type: 'subscribe_sessions', sessionIds: ids }).success)
  })
})

describe('UnsubscribeSessionsSchema', () => {
  it('accepts valid unsubscribe_sessions', () => {
    assert.ok(UnsubscribeSessionsSchema.safeParse({ type: 'unsubscribe_sessions', sessionIds: ['sess-1'] }).success)
  })

  it('enforces array bounds', () => {
    assert.ok(!UnsubscribeSessionsSchema.safeParse({ type: 'unsubscribe_sessions', sessionIds: [] }).success)
    const ids = Array.from({ length: 21 }, (_, i) => `sess-${i}`)
    assert.ok(!UnsubscribeSessionsSchema.safeParse({ type: 'unsubscribe_sessions', sessionIds: ids }).success)
  })
})

// ============================================================
// Repo management schemas — min(1) on path
// ============================================================

describe('AddRepoSchema', () => {
  it('accepts add_repo with name', () => {
    const result = AddRepoSchema.safeParse({ type: 'add_repo', path: '/tmp/repo', name: 'my-repo' })
    assert.ok(result.success)
    assert.equal(result.data.name, 'my-repo')
  })

  it('rejects empty path', () => {
    assert.ok(!AddRepoSchema.safeParse({ type: 'add_repo', path: '' }).success)
  })
})

describe('RemoveRepoSchema', () => {
  it('accepts valid remove_repo', () => {
    assert.ok(RemoveRepoSchema.safeParse({ type: 'remove_repo', path: '/home/user/project' }).success)
  })

  it('rejects empty path', () => {
    assert.ok(!RemoveRepoSchema.safeParse({ type: 'remove_repo', path: '' }).success)
  })
})

// ============================================================
// Web task schemas — boundary constraints + status enum
// ============================================================

describe('LaunchWebTaskSchema', () => {
  it('accepts valid launch_web_task with cwd', () => {
    const result = LaunchWebTaskSchema.safeParse({ type: 'launch_web_task', prompt: 'fix the bug', cwd: '/tmp' })
    assert.ok(result.success)
    assert.equal(result.data.cwd, '/tmp')
  })

  it('enforces prompt length bounds', () => {
    assert.ok(!LaunchWebTaskSchema.safeParse({ type: 'launch_web_task', prompt: '' }).success)
    assert.ok(!LaunchWebTaskSchema.safeParse({ type: 'launch_web_task', prompt: 'x'.repeat(10_001) }).success)
    assert.ok(LaunchWebTaskSchema.safeParse({ type: 'launch_web_task', prompt: 'x'.repeat(10_000) }).success)
  })
})

describe('TeleportWebTaskSchema', () => {
  it('accepts valid and rejects empty taskId', () => {
    assert.ok(TeleportWebTaskSchema.safeParse({ type: 'teleport_web_task', taskId: 'abc123' }).success)
    assert.ok(!TeleportWebTaskSchema.safeParse({ type: 'teleport_web_task', taskId: '' }).success)
  })
})

describe('server web task schemas', () => {
  it('ListWebTasksSchema accepts valid message', () => {
    assert.ok(ListWebTasksSchema.safeParse({ type: 'list_web_tasks' }).success)
  })

  it('ListReposSchema accepts valid message', () => {
    assert.ok(ListReposSchema.safeParse({ type: 'list_repos' }).success)
  })

  it('ServerWebFeatureStatusSchema accepts valid and rejects missing fields', () => {
    assert.ok(ServerWebFeatureStatusSchema.safeParse({ type: 'web_feature_status', available: true, remote: true, teleport: false }).success)
    assert.ok(!ServerWebFeatureStatusSchema.safeParse({ type: 'web_feature_status', remote: true, teleport: false }).success)
  })

  it('ServerWebTaskCreatedSchema accepts valid and rejects invalid status', () => {
    const valid = ServerWebTaskCreatedSchema.safeParse({
      type: 'web_task_created',
      task: { taskId: 'abc', prompt: 'fix', status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null, cwd: '/tmp' },
    })
    assert.ok(valid.success)
    assert.equal(valid.data.task.cwd, '/tmp')

    assert.ok(!ServerWebTaskCreatedSchema.safeParse({
      type: 'web_task_created',
      task: { taskId: 'abc', prompt: 'fix', status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null },
    }).success)
  })

  it('ServerWebTaskUpdatedSchema accepts valid', () => {
    assert.ok(ServerWebTaskUpdatedSchema.safeParse({
      type: 'web_task_updated',
      task: { taskId: 'abc', prompt: 'fix', status: 'running', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null },
    }).success)
  })

  it('ServerWebTaskErrorSchema handles nullable/optional taskId', () => {
    assert.ok(ServerWebTaskErrorSchema.safeParse({ type: 'web_task_error', taskId: null, message: 'Not available' }).success)
    assert.ok(ServerWebTaskErrorSchema.safeParse({ type: 'web_task_error', message: 'Error occurred' }).success)
    assert.ok(!ServerWebTaskErrorSchema.safeParse({ type: 'web_task_error', taskId: 'x' }).success)
  })

  it('ServerWebTaskListSchema accepts valid and empty lists', () => {
    const result = ServerWebTaskListSchema.safeParse({
      type: 'web_task_list',
      tasks: [{ taskId: 't1', prompt: 'do stuff', status: 'completed', createdAt: 1000, updatedAt: 2000, result: 'done', error: null }],
    })
    assert.ok(result.success)
    assert.equal(result.data.tasks.length, 1)
    assert.ok(ServerWebTaskListSchema.safeParse({ type: 'web_task_list', tasks: [] }).success)
    assert.ok(!ServerWebTaskListSchema.safeParse({ type: 'web_task_list' }).success)
  })
})

// ============================================================
// Max-length constraints (#2694) — OOM DoS prevention
// ============================================================

describe('max-length constraints (#2694)', () => {
  it('rejects auth token exceeding 512 characters', () => {
    assert.ok(!AuthSchema.safeParse({ type: 'auth', token: 'a'.repeat(513) }).success)
  })

  it('accepts auth token at the limit', () => {
    assert.ok(AuthSchema.safeParse({ type: 'auth', token: 'a'.repeat(512) }).success)
  })

  it('rejects path fields exceeding 4096 characters', () => {
    const longPath = 'a'.repeat(4097)
    assert.ok(!ListDirectorySchema.safeParse({ type: 'list_directory', path: longPath }).success)
    assert.ok(!BrowseFilesSchema.safeParse({ type: 'browse_files', path: longPath }).success)
    assert.ok(!ReadFileSchema.safeParse({ type: 'read_file', path: longPath }).success)
    assert.ok(!WriteFileSchema.safeParse({ type: 'write_file', path: longPath, content: 'data' }).success)
    assert.ok(!AddRepoSchema.safeParse({ type: 'add_repo', path: longPath }).success)
    assert.ok(!RemoveRepoSchema.safeParse({ type: 'remove_repo', path: longPath }).success)
    assert.ok(!LaunchWebTaskSchema.safeParse({ type: 'launch_web_task', prompt: 'test', cwd: longPath }).success)
  })

  it('accepts path fields at the limit', () => {
    const path = 'a'.repeat(4096)
    assert.ok(ReadFileSchema.safeParse({ type: 'read_file', path }).success)
    assert.ok(WriteFileSchema.safeParse({ type: 'write_file', path, content: 'data' }).success)
  })

  it('rejects write_file content exceeding 10MB', () => {
    const result = WriteFileSchema.safeParse({ type: 'write_file', path: '/tmp/f', content: 'x'.repeat(10_000_001) })
    assert.ok(!result.success)
  })

  it('accepts write_file content at the 10MB limit', () => {
    const result = WriteFileSchema.safeParse({ type: 'write_file', path: '/tmp/f', content: 'x'.repeat(10_000_000) })
    assert.ok(result.success)
  })

  it('rejects list_files query exceeding 1000 characters', () => {
    assert.ok(!ListFilesSchema.safeParse({ type: 'list_files', query: 'q'.repeat(1001) }).success)
  })

  it('accepts list_files query at the limit', () => {
    assert.ok(ListFilesSchema.safeParse({ type: 'list_files', query: 'q'.repeat(1000) }).success)
  })

  it('rejects git_stage file path exceeding 4096 characters', () => {
    assert.ok(!GitStageSchema.safeParse({ type: 'git_stage', files: ['a'.repeat(4097)] }).success)
  })

  it('rejects git_commit message exceeding 10000 characters', () => {
    assert.ok(!GitCommitSchema.safeParse({ type: 'git_commit', message: 'm'.repeat(10_001) }).success)
  })

  it('accepts git_commit message at the limit', () => {
    assert.ok(GitCommitSchema.safeParse({ type: 'git_commit', message: 'm'.repeat(10_000) }).success)
  })

  it('rejects register_push_token token exceeding 512 characters', () => {
    assert.ok(!RegisterPushTokenSchema.safeParse({ type: 'register_push_token', token: 't'.repeat(513) }).success)
  })

  it('rejects encrypted envelope ciphertext exceeding 10MB', () => {
    assert.ok(!EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'x'.repeat(10_000_001), n: 1 }).success)
  })

  it('accepts encrypted envelope ciphertext at the 10MB limit', () => {
    assert.ok(EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'x'.repeat(10_000_000), n: 1 }).success)
  })

  it('rejects create_session cwd path exceeding 4096 characters', () => {
    assert.ok(!CreateSessionSchema.safeParse({ type: 'create_session', cwd: 'a'.repeat(4097) }).success)
  })

  it('rejects teleport_web_task taskId exceeding 256 characters', () => {
    assert.ok(!TeleportWebTaskSchema.safeParse({ type: 'teleport_web_task', taskId: 'x'.repeat(257) }).success)
  })
})

// ============================================================
// Dead code removal verification (#940)
// ============================================================

describe('dead code removal', () => {
  it('rejects mode message type in ClientMessageSchema', () => {
    assert.ok(!ClientMessageSchema.safeParse({ type: 'mode', mode: 'terminal' }).success, 'mode message type should no longer be accepted')
  })

  it('does not export ModeSchema', async () => {
    const exports = await import('../src/ws-schemas.js')
    assert.equal(exports.ModeSchema, undefined, 'ModeSchema should not be exported')
  })

  it('codex-session.js exports CodexSession', async () => {
    const mod = await import('../src/codex-session.js')
    assert.ok(mod.CodexSession, 'CodexSession should be exported')
    assert.equal(typeof mod.CodexSession, 'function', 'CodexSession should be a class/constructor')
  })

  it('SetPermissionRulesSchema rejects more than 1000 rules', async () => {
    const { SetPermissionRulesSchema } = await import('../src/ws-schemas.js')
    const makeRules = (n) => Array.from({ length: n }, () => ({ tool: 'Bash', decision: 'allow' }))
    assert.equal(SetPermissionRulesSchema.safeParse({ type: 'set_permission_rules', rules: makeRules(1000) }).success, true)
    assert.equal(SetPermissionRulesSchema.safeParse({ type: 'set_permission_rules', rules: makeRules(1001) }).success, false)
  })

  it('UserQuestionResponseSchema rejects more than 100 answer entries', async () => {
    const { UserQuestionResponseSchema } = await import('../src/ws-schemas.js')
    const mkAnswers = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']))
    assert.equal(UserQuestionResponseSchema.safeParse({ type: 'user_question_response', answer: 'a', answers: mkAnswers(100) }).success, true)
    assert.equal(UserQuestionResponseSchema.safeParse({ type: 'user_question_response', answer: 'a', answers: mkAnswers(101) }).success, false)
  })

  it('SandboxSchema rejects arrays larger than 256', async () => {
    const { SandboxSchema } = await import('@chroxy/protocol')
    const mk = (n) => Array.from({ length: n }, (_, i) => `item${i}`)
    assert.equal(SandboxSchema.safeParse({ network: { allowedDomains: mk(256) } }).success, true)
    assert.equal(SandboxSchema.safeParse({ network: { allowedDomains: mk(257) } }).success, false)
    assert.equal(SandboxSchema.safeParse({ filesystem: { allowedPaths: mk(257) } }).success, false)
    assert.equal(SandboxSchema.safeParse({ filesystem: { deniedPaths: mk(257) } }).success, false)
    assert.equal(SandboxSchema.safeParse({ bash: { allowedCommands: mk(257) } }).success, false)
  })

  it('QueryPermissionAuditSchema bounds limit to 1..10000', async () => {
    const { QueryPermissionAuditSchema } = await import('../src/ws-schemas.js')
    assert.equal(QueryPermissionAuditSchema.safeParse({ type: 'query_permission_audit', limit: 10_000 }).success, true)
    assert.equal(QueryPermissionAuditSchema.safeParse({ type: 'query_permission_audit', limit: 10_001 }).success, false)
    assert.equal(QueryPermissionAuditSchema.safeParse({ type: 'query_permission_audit', limit: 0 }).success, false)
  })

  it('session-db.js does not exist', async () => {
    try {
      await import('../src/session-db.js')
      assert.fail('session-db.js should have been deleted')
    } catch (err) {
      assert.ok(err.code === 'ERR_MODULE_NOT_FOUND' || err.message.includes('Cannot find'))
    }
  })
})
