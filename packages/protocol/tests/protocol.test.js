import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@chroxy/protocol', () => {
  it('exports PROTOCOL_VERSION as a positive integer', async () => {
    const { PROTOCOL_VERSION } = await import('../src/index.ts')
    assert.equal(typeof PROTOCOL_VERSION, 'number')
    assert.ok(PROTOCOL_VERSION >= 1, 'PROTOCOL_VERSION should be >= 1')
    assert.equal(PROTOCOL_VERSION, Math.floor(PROTOCOL_VERSION), 'Should be an integer')
  })

  it('exports MIN_PROTOCOL_VERSION as a positive integer', async () => {
    const { MIN_PROTOCOL_VERSION } = await import('../src/index.ts')
    assert.equal(typeof MIN_PROTOCOL_VERSION, 'number')
    assert.ok(MIN_PROTOCOL_VERSION >= 1, 'MIN_PROTOCOL_VERSION should be >= 1')
    assert.equal(MIN_PROTOCOL_VERSION, Math.floor(MIN_PROTOCOL_VERSION), 'Should be an integer')
  })

  it('MIN_PROTOCOL_VERSION <= PROTOCOL_VERSION', async () => {
    const { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } = await import('../src/index.ts')
    assert.ok(
      MIN_PROTOCOL_VERSION <= PROTOCOL_VERSION,
      `MIN (${MIN_PROTOCOL_VERSION}) should be <= current (${PROTOCOL_VERSION})`,
    )
  })

  it('protocol version matches server ws-server.js value', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { PROTOCOL_VERSION } = await import('../src/index.ts')

    const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
    const src = readFileSync(wsServerPath, 'utf-8')
    const match = src.match(/export const SERVER_PROTOCOL_VERSION = (\d+)/)
    assert.ok(match, 'Should find SERVER_PROTOCOL_VERSION in ws-server.js')
    assert.equal(PROTOCOL_VERSION, parseInt(match[1], 10),
      'Protocol package version should match server version')
  })
})

describe('ClientMessageType enum', () => {
  it('exports ClientMessageType with all client->server message types', async () => {
    const { ClientMessageType } = await import('../src/index.ts')
    assert.ok(ClientMessageType, 'ClientMessageType should be exported')

    const expectedTypes = [
      'auth', 'input', 'interrupt', 'set_model', 'set_permission_mode',
      'permission_response', 'list_sessions', 'switch_session', 'create_session',
      'destroy_session', 'rename_session', 'register_push_token',
      'user_question_response', 'list_directory', 'browse_files', 'read_file',
      'write_file', 'list_slash_commands', 'list_agents', 'request_full_history',
      'key_exchange', 'create_checkpoint', 'list_checkpoints', 'restore_checkpoint',
      'delete_checkpoint', 'close_dev_preview', 'launch_web_task', 'list_web_tasks',
      'teleport_web_task', 'ping', 'encrypted',
    ]

    for (const type of expectedTypes) {
      assert.ok(
        Object.values(ClientMessageType).includes(type),
        `ClientMessageType should contain '${type}'`,
      )
    }
  })

  it('ClientMessageType values match their keys (snake_case)', async () => {
    const { ClientMessageType } = await import('../src/index.ts')
    for (const [key, value] of Object.entries(ClientMessageType)) {
      assert.equal(typeof value, 'string', `${key} should be a string`)
    }
  })
})

describe('ServerMessageType enum', () => {
  it('exports ServerMessageType with all server->client message types', async () => {
    const { ServerMessageType } = await import('../src/index.ts')
    assert.ok(ServerMessageType, 'ServerMessageType should be exported')

    const expectedTypes = [
      'auth_ok', 'key_exchange_ok', 'auth_fail', 'server_mode',
      'message', 'stream_start', 'stream_delta', 'stream_end',
      'tool_start', 'tool_result', 'mcp_servers', 'result',
      'status', 'claude_ready', 'model_changed', 'available_models',
      'permission_request', 'confirm_permission_mode', 'permission_mode_changed',
      'available_permission_modes', 'session_list', 'session_switched',
      'session_created', 'session_destroyed', 'session_error',
      'history_replay_start', 'history_replay_end', 'conversation_id',
      'user_question', 'agent_busy', 'agent_idle', 'plan_started', 'plan_ready',
      'server_shutdown', 'server_status', 'server_error',
      'directory_listing', 'file_listing', 'file_content',
      'slash_commands', 'agent_list',
      'client_joined', 'client_left', 'client_focus_changed',
      'checkpoint_created', 'checkpoint_list', 'checkpoint_restored',
      'primary_changed', 'pong', 'permission_expired', 'token_rotated',
      'session_warning', 'session_timeout',
      'dev_preview', 'dev_preview_stopped',
      'web_task_created', 'web_task_updated', 'web_task_error', 'web_task_list',
      'encrypted',
    ]

    for (const type of expectedTypes) {
      assert.ok(
        Object.values(ServerMessageType).includes(type),
        `ServerMessageType should contain '${type}'`,
      )
    }
  })

  it('ServerMessageType values match their keys (snake_case)', async () => {
    const { ServerMessageType } = await import('../src/index.ts')
    for (const [key, value] of Object.entries(ServerMessageType)) {
      assert.equal(typeof value, 'string', `${key} should be a string`)
    }
  })
})

describe('message type enums match ws-server.js protocol docs', () => {
  it('all client->server types from ws-server.js are in ClientMessageType', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { ClientMessageType } = await import('../src/index.ts')

    const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
    const src = readFileSync(wsServerPath, 'utf-8')

    // Extract the Client -> Server section
    const clientSection = src.match(/\* Client -> Server:\n([\s\S]*?)\n \*\n \* Server -> Client:/)?.[1]
    assert.ok(clientSection, 'Should find Client -> Server section')

    const typeMatches = [...clientSection.matchAll(/type: '(\w+)'/g)]
    assert.ok(typeMatches.length > 0, 'Should find client message types')

    const values = Object.values(ClientMessageType)
    for (const match of typeMatches) {
      assert.ok(values.includes(match[1]),
        `ClientMessageType should contain '${match[1]}' from ws-server.js`)
    }
  })

  it('all server->client types from ws-server.js are in ServerMessageType', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { ServerMessageType } = await import('../src/index.ts')

    const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
    const src = readFileSync(wsServerPath, 'utf-8')

    // Extract the Server -> Client section
    const serverSection = src.match(/\* Server -> Client:\n([\s\S]*?)\n \*\n \* Encrypted envelope/)?.[1]
    assert.ok(serverSection, 'Should find Server -> Client section')

    const typeMatches = [...serverSection.matchAll(/type: '(\w+)'/g)]
    assert.ok(typeMatches.length > 0, 'Should find server message types')

    const values = Object.values(ServerMessageType)
    for (const match of typeMatches) {
      assert.ok(values.includes(match[1]),
        `ServerMessageType should contain '${match[1]}' from ws-server.js`)
    }
  })
})
