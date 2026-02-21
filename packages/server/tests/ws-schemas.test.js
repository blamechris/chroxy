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
  EncryptedEnvelopeSchema,
  ClientMessageSchema,
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
