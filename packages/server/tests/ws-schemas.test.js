import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AuthSchema,
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
  KeyExchangeSchema,
  PingSchema,
  RequestSessionContextSchema,
  GetDiffSchema,
  ResumeBudgetSchema,
  ListCheckpointsSchema,
  RestoreCheckpointSchema,
  CreateCheckpointSchema,
  DeleteCheckpointSchema,
  CloseDevPreviewSchema,
  EncryptedEnvelopeSchema,
  ClientMessageSchema,
  // Server -> Client schemas
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
  ServerPlanStartedSchema,
  ServerPlanReadySchema,
  ServerSessionListSchema,
  ServerStatusUpdateSchema,
  ServerErrorSchema,
  ServerShutdownSchema,
  ServerPongSchema,
  ServerMcpServersSchema,
} from '../src/ws-schemas.js'


// -- AuthSchema --
describe('AuthSchema', () => {
  it('accepts valid auth message', () => {
    const result = AuthSchema.safeParse({ type: 'auth', token: 'abc123' })
    assert.ok(result.success)
    assert.equal(result.data.type, 'auth')
    assert.equal(result.data.token, 'abc123')
  })

  it('accepts auth with deviceInfo', () => {
    const result = AuthSchema.safeParse({
      type: 'auth',
      token: 'abc123',
      deviceInfo: {
        deviceId: 'dev1',
        deviceName: 'iPhone',
        deviceType: 'phone',
        platform: 'ios',
      },
    })
    assert.ok(result.success)
    assert.equal(result.data.deviceInfo.deviceType, 'phone')
  })

  it('rejects auth without token', () => {
    const result = AuthSchema.safeParse({ type: 'auth' })
    assert.ok(!result.success)
  })

  it('rejects auth with non-string token', () => {
    const result = AuthSchema.safeParse({ type: 'auth', token: 123 })
    assert.ok(!result.success)
  })

  it('rejects wrong type', () => {
    const result = AuthSchema.safeParse({ type: 'login', token: 'abc' })
    assert.ok(!result.success)
  })
})


// -- InputSchema --
describe('InputSchema', () => {
  it('accepts input with data', () => {
    const result = InputSchema.safeParse({ type: 'input', data: 'hello' })
    assert.ok(result.success)
    assert.equal(result.data.data, 'hello')
  })

  it('accepts input without data (optional)', () => {
    const result = InputSchema.safeParse({ type: 'input' })
    assert.ok(result.success)
  })

  it('accepts input with attachments', () => {
    const result = InputSchema.safeParse({
      type: 'input',
      data: 'check this',
      attachments: [{
        type: 'image',
        mediaType: 'image/png',
        data: 'base64data',
        name: 'screenshot.png',
      }],
    })
    assert.ok(result.success)
    assert.equal(result.data.attachments.length, 1)
  })

  it('accepts input with isVoice flag', () => {
    const result = InputSchema.safeParse({ type: 'input', data: 'hello', isVoice: true })
    assert.ok(result.success)
    assert.ok(result.data.isVoice)
  })

  it('rejects input with invalid attachment shape', () => {
    const result = InputSchema.safeParse({
      type: 'input',
      data: 'test',
      attachments: [{ bad: true }],
    })
    assert.ok(!result.success)
  })
})


// -- ResizeSchema --
describe('ResizeSchema', () => {
  it('accepts valid resize', () => {
    const result = ResizeSchema.safeParse({ type: 'resize', cols: 120, rows: 40 })
    assert.ok(result.success)
  })

  it('rejects non-integer cols', () => {
    const result = ResizeSchema.safeParse({ type: 'resize', cols: 1.5, rows: 40 })
    assert.ok(!result.success)
  })

  it('rejects zero rows', () => {
    const result = ResizeSchema.safeParse({ type: 'resize', cols: 80, rows: 0 })
    assert.ok(!result.success)
  })

  it('rejects missing cols', () => {
    const result = ResizeSchema.safeParse({ type: 'resize', rows: 40 })
    assert.ok(!result.success)
  })
})


// -- ModeSchema --
describe('ModeSchema', () => {
  it('accepts terminal mode', () => {
    const result = ModeSchema.safeParse({ type: 'mode', mode: 'terminal' })
    assert.ok(result.success)
  })

  it('accepts chat mode', () => {
    const result = ModeSchema.safeParse({ type: 'mode', mode: 'chat' })
    assert.ok(result.success)
  })

  it('rejects invalid mode value', () => {
    const result = ModeSchema.safeParse({ type: 'mode', mode: 'debug' })
    assert.ok(!result.success)
  })
})


// -- InterruptSchema --
describe('InterruptSchema', () => {
  it('accepts valid interrupt', () => {
    const result = InterruptSchema.safeParse({ type: 'interrupt' })
    assert.ok(result.success)
  })
})


// -- SetModelSchema --
describe('SetModelSchema', () => {
  it('accepts valid set_model', () => {
    const result = SetModelSchema.safeParse({ type: 'set_model', model: 'claude-sonnet' })
    assert.ok(result.success)
  })

  it('rejects non-string model', () => {
    const result = SetModelSchema.safeParse({ type: 'set_model', model: 42 })
    assert.ok(!result.success)
  })

  it('rejects missing model', () => {
    const result = SetModelSchema.safeParse({ type: 'set_model' })
    assert.ok(!result.success)
  })
})


// -- SetPermissionModeSchema --
describe('SetPermissionModeSchema', () => {
  it('accepts mode without confirmed', () => {
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'approve' })
    assert.ok(result.success)
  })

  it('accepts mode with confirmed', () => {
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'auto', confirmed: true })
    assert.ok(result.success)
    assert.ok(result.data.confirmed)
  })

  it('accepts plan mode', () => {
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'plan' })
    assert.ok(result.success)
  })

  it('accepts acceptEdits mode', () => {
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'acceptEdits' })
    assert.ok(result.success)
  })

  it('rejects missing mode', () => {
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode' })
    assert.ok(!result.success)
  })

  it('rejects invalid mode value', () => {
    const result = SetPermissionModeSchema.safeParse({ type: 'set_permission_mode', mode: 'bypassAll' })
    assert.ok(!result.success)
  })
})


// -- PermissionResponseSchema --
describe('PermissionResponseSchema', () => {
  it('accepts valid response', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1', decision: 'allow' })
    assert.ok(result.success)
  })

  it('accepts allowAlways decision', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1', decision: 'allowAlways' })
    assert.ok(result.success)
  })

  it('accepts deny decision', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1', decision: 'deny' })
    assert.ok(result.success)
  })

  it('rejects missing requestId', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', decision: 'allow' })
    assert.ok(!result.success)
  })

  it('rejects empty requestId', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: '', decision: 'allow' })
    assert.ok(!result.success)
  })

  it('rejects missing decision', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1' })
    assert.ok(!result.success)
  })

  it('rejects invalid decision value', () => {
    const result = PermissionResponseSchema.safeParse({ type: 'permission_response', requestId: 'req-1', decision: 'maybe' })
    assert.ok(!result.success)
  })
})


// -- Session management schemas --
describe('ListSessionsSchema', () => {
  it('accepts valid message', () => {
    const result = ListSessionsSchema.safeParse({ type: 'list_sessions' })
    assert.ok(result.success)
  })
})

describe('SwitchSessionSchema', () => {
  it('accepts valid switch', () => {
    const result = SwitchSessionSchema.safeParse({ type: 'switch_session', sessionId: 'sess-1' })
    assert.ok(result.success)
  })

  it('rejects missing sessionId', () => {
    const result = SwitchSessionSchema.safeParse({ type: 'switch_session' })
    assert.ok(!result.success)
  })
})

describe('CreateSessionSchema', () => {
  it('accepts with no options', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session' })
    assert.ok(result.success)
  })

  it('accepts with name and cwd', () => {
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'dev', cwd: '/tmp' })
    assert.ok(result.success)
  })
})

describe('DestroySessionSchema', () => {
  it('accepts valid destroy', () => {
    const result = DestroySessionSchema.safeParse({ type: 'destroy_session', sessionId: 'sess-1' })
    assert.ok(result.success)
  })

  it('rejects missing sessionId', () => {
    const result = DestroySessionSchema.safeParse({ type: 'destroy_session' })
    assert.ok(!result.success)
  })
})

describe('RenameSessionSchema', () => {
  it('accepts valid rename', () => {
    const result = RenameSessionSchema.safeParse({ type: 'rename_session', sessionId: 'sess-1', name: 'new-name' })
    assert.ok(result.success)
  })

  it('rejects missing name', () => {
    const result = RenameSessionSchema.safeParse({ type: 'rename_session', sessionId: 'sess-1' })
    assert.ok(!result.success)
  })
})


// -- Discovery schemas --
describe('DiscoverSessionsSchema', () => {
  it('accepts valid message', () => {
    const result = DiscoverSessionsSchema.safeParse({ type: 'discover_sessions' })
    assert.ok(result.success)
  })
})

describe('TriggerDiscoverySchema', () => {
  it('accepts valid message', () => {
    const result = TriggerDiscoverySchema.safeParse({ type: 'trigger_discovery' })
    assert.ok(result.success)
  })
})

describe('AttachSessionSchema', () => {
  it('accepts with tmuxSession only', () => {
    const result = AttachSessionSchema.safeParse({ type: 'attach_session', tmuxSession: 'my-session' })
    assert.ok(result.success)
  })

  it('accepts with name', () => {
    const result = AttachSessionSchema.safeParse({ type: 'attach_session', tmuxSession: 'my-session', name: 'Dev' })
    assert.ok(result.success)
  })

  it('rejects missing tmuxSession', () => {
    const result = AttachSessionSchema.safeParse({ type: 'attach_session' })
    assert.ok(!result.success)
  })
})


// -- Push token --
describe('RegisterPushTokenSchema', () => {
  it('accepts valid token', () => {
    const result = RegisterPushTokenSchema.safeParse({ type: 'register_push_token', token: 'ExponentPushToken[abc]' })
    assert.ok(result.success)
  })

  it('rejects missing token', () => {
    const result = RegisterPushTokenSchema.safeParse({ type: 'register_push_token' })
    assert.ok(!result.success)
  })
})


// -- User question --
describe('UserQuestionResponseSchema', () => {
  it('accepts answer only', () => {
    const result = UserQuestionResponseSchema.safeParse({ type: 'user_question_response', answer: 'yes' })
    assert.ok(result.success)
  })

  it('accepts with toolUseId', () => {
    const result = UserQuestionResponseSchema.safeParse({ type: 'user_question_response', answer: 'no', toolUseId: 'tu-1' })
    assert.ok(result.success)
  })

  it('rejects missing answer', () => {
    const result = UserQuestionResponseSchema.safeParse({ type: 'user_question_response' })
    assert.ok(!result.success)
  })
})


// -- File browser --
describe('ListDirectorySchema', () => {
  it('accepts without path', () => {
    const result = ListDirectorySchema.safeParse({ type: 'list_directory' })
    assert.ok(result.success)
  })

  it('accepts with path', () => {
    const result = ListDirectorySchema.safeParse({ type: 'list_directory', path: '/home' })
    assert.ok(result.success)
  })
})

describe('BrowseFilesSchema', () => {
  it('accepts without path', () => {
    const result = BrowseFilesSchema.safeParse({ type: 'browse_files' })
    assert.ok(result.success)
  })

  it('accepts null path', () => {
    const result = BrowseFilesSchema.safeParse({ type: 'browse_files', path: null })
    assert.ok(result.success)
  })

  it('accepts string path', () => {
    const result = BrowseFilesSchema.safeParse({ type: 'browse_files', path: 'subdir' })
    assert.ok(result.success)
  })
})

describe('ReadFileSchema', () => {
  it('accepts with path', () => {
    const result = ReadFileSchema.safeParse({ type: 'read_file', path: '/etc/hosts' })
    assert.ok(result.success)
  })

  it('rejects missing path', () => {
    const result = ReadFileSchema.safeParse({ type: 'read_file' })
    assert.ok(!result.success)
  })
})


// -- Slash commands and agents --
describe('ListSlashCommandsSchema', () => {
  it('accepts valid message', () => {
    const result = ListSlashCommandsSchema.safeParse({ type: 'list_slash_commands' })
    assert.ok(result.success)
  })
})

describe('ListAgentsSchema', () => {
  it('accepts valid message', () => {
    const result = ListAgentsSchema.safeParse({ type: 'list_agents' })
    assert.ok(result.success)
  })
})


// -- History --
describe('RequestFullHistorySchema', () => {
  it('accepts without sessionId', () => {
    const result = RequestFullHistorySchema.safeParse({ type: 'request_full_history' })
    assert.ok(result.success)
  })

  it('accepts with sessionId', () => {
    const result = RequestFullHistorySchema.safeParse({ type: 'request_full_history', sessionId: 'sess-1' })
    assert.ok(result.success)
  })
})


// -- Key exchange --
describe('KeyExchangeSchema', () => {
  it('accepts valid key exchange', () => {
    const result = KeyExchangeSchema.safeParse({ type: 'key_exchange', publicKey: 'base64pubkey' })
    assert.ok(result.success)
  })

  it('rejects missing publicKey', () => {
    const result = KeyExchangeSchema.safeParse({ type: 'key_exchange' })
    assert.ok(!result.success)
  })

  it('rejects non-string publicKey', () => {
    const result = KeyExchangeSchema.safeParse({ type: 'key_exchange', publicKey: 123 })
    assert.ok(!result.success)
  })
})


// -- Ping --
describe('PingSchema', () => {
  it('accepts valid ping', () => {
    const result = PingSchema.safeParse({ type: 'ping' })
    assert.ok(result.success)
  })
})


// -- Session context --
describe('RequestSessionContextSchema', () => {
  it('accepts without sessionId', () => {
    const result = RequestSessionContextSchema.safeParse({ type: 'request_session_context' })
    assert.ok(result.success)
  })

  it('accepts with sessionId', () => {
    const result = RequestSessionContextSchema.safeParse({ type: 'request_session_context', sessionId: 'sess-1' })
    assert.ok(result.success)
  })
})


// -- Get diff --
describe('GetDiffSchema', () => {
  it('accepts valid get_diff message', () => {
    const result = GetDiffSchema.safeParse({ type: 'get_diff' })
    assert.ok(result.success)
  })

  it('rejects wrong type', () => {
    const result = GetDiffSchema.safeParse({ type: 'get_diffs' })
    assert.ok(!result.success)
  })
})


// -- Encrypted envelope --
describe('EncryptedEnvelopeSchema', () => {
  it('accepts valid envelope', () => {
    const result = EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'ciphertext', n: 0 })
    assert.ok(result.success)
  })

  it('accepts positive integer nonce', () => {
    const result = EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'ciphertext', n: 42 })
    assert.ok(result.success)
  })

  it('rejects missing d', () => {
    const result = EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', n: 0 })
    assert.ok(!result.success)
  })

  it('rejects non-number n', () => {
    const result = EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'data', n: 'zero' })
    assert.ok(!result.success)
  })

  it('rejects negative nonce', () => {
    const result = EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'data', n: -1 })
    assert.ok(!result.success)
  })

  it('rejects non-integer nonce', () => {
    const result = EncryptedEnvelopeSchema.safeParse({ type: 'encrypted', d: 'data', n: 1.5 })
    assert.ok(!result.success)
  })
})


// -- CreateCheckpointSchema --
describe('CreateCheckpointSchema', () => {
  it('accepts minimal create_checkpoint', () => {
    const result = CreateCheckpointSchema.safeParse({ type: 'create_checkpoint' })
    assert.ok(result.success)
  })

  it('accepts create_checkpoint with name and description', () => {
    const result = CreateCheckpointSchema.safeParse({ type: 'create_checkpoint', name: 'v1', description: 'First checkpoint' })
    assert.ok(result.success)
    assert.equal(result.data.name, 'v1')
    assert.equal(result.data.description, 'First checkpoint')
  })
})

// -- DeleteCheckpointSchema --
describe('DeleteCheckpointSchema', () => {
  it('accepts valid delete_checkpoint', () => {
    const result = DeleteCheckpointSchema.safeParse({ type: 'delete_checkpoint', checkpointId: 'cp-1' })
    assert.ok(result.success)
    assert.equal(result.data.checkpointId, 'cp-1')
  })

  it('rejects missing checkpointId', () => {
    const result = DeleteCheckpointSchema.safeParse({ type: 'delete_checkpoint' })
    assert.ok(!result.success)
  })
})

// -- CloseDevPreviewSchema --
describe('CloseDevPreviewSchema', () => {
  it('accepts valid close_dev_preview', () => {
    const result = CloseDevPreviewSchema.safeParse({ type: 'close_dev_preview', port: 3000 })
    assert.ok(result.success)
    assert.equal(result.data.port, 3000)
  })

  it('accepts close_dev_preview with sessionId', () => {
    const result = CloseDevPreviewSchema.safeParse({ type: 'close_dev_preview', port: 8080, sessionId: 's-1' })
    assert.ok(result.success)
    assert.equal(result.data.sessionId, 's-1')
  })

  it('rejects missing port', () => {
    const result = CloseDevPreviewSchema.safeParse({ type: 'close_dev_preview' })
    assert.ok(!result.success)
  })

  it('rejects non-integer port', () => {
    const result = CloseDevPreviewSchema.safeParse({ type: 'close_dev_preview', port: 3.14 })
    assert.ok(!result.success)
  })
})


// -- ClientMessageSchema (discriminated union) --
describe('ClientMessageSchema', () => {
  it('dispatches input messages correctly', () => {
    const result = ClientMessageSchema.safeParse({ type: 'input', data: 'hello' })
    assert.ok(result.success)
    assert.equal(result.data.type, 'input')
  })

  it('dispatches permission_response correctly', () => {
    const result = ClientMessageSchema.safeParse({ type: 'permission_response', requestId: 'r1', decision: 'allow' })
    assert.ok(result.success)
    assert.equal(result.data.type, 'permission_response')
  })

  it('dispatches create_session correctly', () => {
    const result = ClientMessageSchema.safeParse({ type: 'create_session', name: 'dev' })
    assert.ok(result.success)
    assert.equal(result.data.type, 'create_session')
  })

  it('rejects unknown message types', () => {
    const result = ClientMessageSchema.safeParse({ type: 'unknown_type' })
    assert.ok(!result.success)
  })

  it('rejects messages with missing required fields', () => {
    const result = ClientMessageSchema.safeParse({ type: 'switch_session' })
    assert.ok(!result.success)
  })

  it('rejects messages without type field', () => {
    const result = ClientMessageSchema.safeParse({ data: 'hello' })
    assert.ok(!result.success)
  })

  it('validates all simple command types', () => {
    const simpleTypes = [
      'interrupt',
      'list_sessions',
      'discover_sessions',
      'trigger_discovery',
      'list_slash_commands',
      'list_agents',
      'get_diff',
      'list_checkpoints',
      'create_checkpoint',
    ]
    for (const type of simpleTypes) {
      const result = ClientMessageSchema.safeParse({ type })
      assert.ok(result.success, `Expected ${type} to be valid`)
    }
  })

  it('produces structured error for malformed messages', () => {
    const result = ClientMessageSchema.safeParse({ type: 'resize', cols: 'wide', rows: 40 })
    assert.ok(!result.success)
    assert.ok(result.error.issues.length > 0)
    // Each issue has a message string
    for (const issue of result.error.issues) {
      assert.equal(typeof issue.message, 'string')
    }
  })
})


// ============================================================
// Server -> Client schemas
// ============================================================

describe('ServerAuthOkSchema', () => {
  it('accepts valid auth_ok', () => {
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'abc123',
      serverMode: 'cli',
      serverVersion: '0.1.0',
      latestVersion: null,
      serverCommit: 'deadbeef',
      cwd: '/tmp',
      connectedClients: [],
      encryption: 'required',
    })
    assert.ok(result.success)
  })

  it('accepts with connected clients', () => {
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'abc',
      serverMode: 'terminal',
      serverVersion: '0.1.0',
      latestVersion: '0.2.0',
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [{
        clientId: 'c1',
        deviceName: 'iPhone',
        deviceType: 'phone',
        platform: 'ios',
      }],
      encryption: 'disabled',
    })
    assert.ok(result.success)
  })

  it('rejects invalid serverMode', () => {
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'abc',
      serverMode: 'pty',
      serverVersion: '0.1.0',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
    })
    assert.ok(!result.success)
  })
})

describe('ServerAuthFailSchema', () => {
  it('accepts valid auth_fail', () => {
    const result = ServerAuthFailSchema.safeParse({ type: 'auth_fail', reason: 'bad token' })
    assert.ok(result.success)
  })

  it('rejects missing reason', () => {
    const result = ServerAuthFailSchema.safeParse({ type: 'auth_fail' })
    assert.ok(!result.success)
  })
})

describe('ServerClaudeReadySchema', () => {
  it('accepts valid claude_ready', () => {
    assert.ok(ServerClaudeReadySchema.safeParse({ type: 'claude_ready' }).success)
  })
})

describe('ServerStreamStartSchema', () => {
  it('accepts valid stream_start', () => {
    const result = ServerStreamStartSchema.safeParse({ type: 'stream_start', messageId: 'msg-1' })
    assert.ok(result.success)
  })

  it('rejects missing messageId', () => {
    assert.ok(!ServerStreamStartSchema.safeParse({ type: 'stream_start' }).success)
  })
})

describe('ServerStreamDeltaSchema', () => {
  it('accepts valid stream_delta', () => {
    const result = ServerStreamDeltaSchema.safeParse({ type: 'stream_delta', messageId: 'msg-1', delta: 'Hello' })
    assert.ok(result.success)
  })
})

describe('ServerStreamEndSchema', () => {
  it('accepts valid stream_end', () => {
    assert.ok(ServerStreamEndSchema.safeParse({ type: 'stream_end', messageId: 'msg-1' }).success)
  })
})

describe('ServerMessageSchema', () => {
  it('accepts response message', () => {
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'response',
      content: 'Hello!',
      timestamp: Date.now(),
    })
    assert.ok(result.success)
  })

  it('accepts error message with tool', () => {
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'error',
      content: 'fail',
      tool: 'Bash',
      timestamp: 1000,
    })
    assert.ok(result.success)
  })

  it('rejects missing content', () => {
    assert.ok(!ServerMessageSchema.safeParse({ type: 'message', messageType: 'response', timestamp: 1 }).success)
  })
})

describe('ServerToolStartSchema', () => {
  it('accepts valid tool_start', () => {
    const result = ServerToolStartSchema.safeParse({
      type: 'tool_start',
      messageId: 'm1',
      toolUseId: 'tu1',
      tool: 'Read',
      input: '/tmp/file.txt',
    })
    assert.ok(result.success)
  })

  it('accepts tool_start with serverName', () => {
    const result = ServerToolStartSchema.safeParse({
      type: 'tool_start',
      messageId: 'm2',
      toolUseId: 'tu2',
      tool: 'mcp__filesystem__read_file',
      input: null,
      serverName: 'filesystem',
    })
    assert.ok(result.success)
    assert.equal(result.data.serverName, 'filesystem')
  })

  it('accepts tool_start without serverName (built-in tool)', () => {
    const result = ServerToolStartSchema.safeParse({
      type: 'tool_start',
      messageId: 'm3',
      toolUseId: 'tu3',
      tool: 'Bash',
      input: null,
    })
    assert.ok(result.success)
    assert.equal(result.data.serverName, undefined)
  })
})

describe('ServerMcpServersSchema', () => {
  it('accepts valid mcp_servers message', () => {
    const result = ServerMcpServersSchema.safeParse({
      type: 'mcp_servers',
      servers: [
        { name: 'filesystem', status: 'connected' },
        { name: 'github', status: 'failed' },
      ],
    })
    assert.ok(result.success)
    assert.equal(result.data.servers.length, 2)
  })

  it('accepts empty servers array', () => {
    const result = ServerMcpServersSchema.safeParse({
      type: 'mcp_servers',
      servers: [],
    })
    assert.ok(result.success)
  })

  it('rejects missing servers field', () => {
    const result = ServerMcpServersSchema.safeParse({
      type: 'mcp_servers',
    })
    assert.ok(!result.success)
  })
})

describe('ServerToolResultSchema', () => {
  it('accepts valid tool_result', () => {
    const result = ServerToolResultSchema.safeParse({
      type: 'tool_result',
      toolUseId: 'tu1',
      result: 'file contents here',
    })
    assert.ok(result.success)
  })
})

describe('ServerResultSchema', () => {
  it('accepts valid result', () => {
    const result = ServerResultSchema.safeParse({
      type: 'result',
      cost: 0.05,
      duration: 3000,
    })
    assert.ok(result.success)
  })

  it('accepts result with all optional fields', () => {
    const result = ServerResultSchema.safeParse({
      type: 'result',
      cost: 0.1,
      duration: 5000,
      usage: { inputTokens: 100, outputTokens: 50 },
      sessionId: 'sdk-abc',
    })
    assert.ok(result.success)
  })
})

describe('ServerModelChangedSchema', () => {
  it('accepts model string', () => {
    assert.ok(ServerModelChangedSchema.safeParse({ type: 'model_changed', model: 'sonnet' }).success)
  })

  it('accepts null model', () => {
    assert.ok(ServerModelChangedSchema.safeParse({ type: 'model_changed', model: null }).success)
  })
})

describe('ServerPermissionModeChangedSchema', () => {
  it('accepts valid mode', () => {
    assert.ok(ServerPermissionModeChangedSchema.safeParse({ type: 'permission_mode_changed', mode: 'approve' }).success)
  })
})

describe('ServerPermissionRequestSchema', () => {
  it('accepts valid permission_request', () => {
    const result = ServerPermissionRequestSchema.safeParse({
      type: 'permission_request',
      requestId: 'req-1',
      tool: 'Bash',
      input: 'ls -la',
    })
    assert.ok(result.success)
  })
})

describe('ServerUserQuestionSchema', () => {
  it('accepts valid user_question', () => {
    const result = ServerUserQuestionSchema.safeParse({
      type: 'user_question',
      toolUseId: 'tu1',
      questions: [{ question: 'Which?', options: ['A', 'B'] }],
    })
    assert.ok(result.success)
  })
})

describe('ServerAgentBusySchema', () => {
  it('accepts valid agent_busy', () => {
    assert.ok(ServerAgentBusySchema.safeParse({ type: 'agent_busy' }).success)
  })
})

describe('ServerAgentIdleSchema', () => {
  it('accepts valid agent_idle', () => {
    assert.ok(ServerAgentIdleSchema.safeParse({ type: 'agent_idle' }).success)
  })
})

describe('ServerAgentSpawnedSchema', () => {
  it('accepts with all fields', () => {
    const result = ServerAgentSpawnedSchema.safeParse({
      type: 'agent_spawned',
      toolUseId: 'tu1',
      description: 'Explore codebase',
      startedAt: Date.now(),
    })
    assert.ok(result.success)
  })
})

describe('ServerAgentCompletedSchema', () => {
  it('accepts valid agent_completed', () => {
    assert.ok(ServerAgentCompletedSchema.safeParse({ type: 'agent_completed', toolUseId: 'tu1' }).success)
  })
})

describe('ServerPlanStartedSchema', () => {
  it('accepts valid plan_started', () => {
    assert.ok(ServerPlanStartedSchema.safeParse({ type: 'plan_started' }).success)
  })
})

describe('ServerPlanReadySchema', () => {
  it('accepts with allowedPrompts', () => {
    const result = ServerPlanReadySchema.safeParse({
      type: 'plan_ready',
      allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
    })
    assert.ok(result.success)
  })

  it('accepts without allowedPrompts', () => {
    assert.ok(ServerPlanReadySchema.safeParse({ type: 'plan_ready' }).success)
  })
})

describe('ServerSessionListSchema', () => {
  it('accepts valid session list', () => {
    const result = ServerSessionListSchema.safeParse({
      type: 'session_list',
      sessions: [{ sessionId: 's1', name: 'Test', isBusy: false }],
    })
    assert.ok(result.success)
  })
})

describe('ServerStatusUpdateSchema', () => {
  it('accepts valid status_update', () => {
    const result = ServerStatusUpdateSchema.safeParse({
      type: 'status_update',
      model: 'sonnet',
      cost: '$0.05',
      messageCount: 10,
      contextTokens: 5000,
      contextPercent: 25,
    })
    assert.ok(result.success)
  })
})

describe('ServerErrorSchema', () => {
  it('accepts valid server_error', () => {
    const result = ServerErrorSchema.safeParse({
      type: 'server_error',
      category: 'tunnel',
      message: 'Connection lost',
      recoverable: true,
    })
    assert.ok(result.success)
  })

  it('rejects missing recoverable', () => {
    assert.ok(!ServerErrorSchema.safeParse({ type: 'server_error', message: 'fail' }).success)
  })
})

describe('ServerShutdownSchema', () => {
  it('accepts valid server_shutdown', () => {
    const result = ServerShutdownSchema.safeParse({
      type: 'server_shutdown',
      reason: 'restart',
      restartEtaMs: 5000,
    })
    assert.ok(result.success)
  })

  it('rejects invalid reason', () => {
    assert.ok(!ServerShutdownSchema.safeParse({ type: 'server_shutdown', reason: 'crash', restartEtaMs: 0 }).success)
  })
})

describe('ServerPongSchema', () => {
  it('accepts valid pong', () => {
    assert.ok(ServerPongSchema.safeParse({ type: 'pong' }).success)
  })
})
