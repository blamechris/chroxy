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
      // Added in #2106:
      'add_repo', 'cli', 'get_diff', 'git_branches', 'git_commit', 'git_stage',
      'git_status', 'git_unstage', 'list_conversations', 'list_files',
      'list_providers', 'list_repos', 'pair', 'query_permission_audit',
      'remove_repo', 'request_cost_summary', 'request_session_context',
      'resume_budget', 'resume_conversation', 'search_conversations',
      'subscribe_sessions', 'unsubscribe_sessions',
    ]

    for (const type of expectedTypes) {
      assert.ok(
        Object.values(ClientMessageType).includes(type),
        `ClientMessageType should contain '${type}'`,
      )
    }
  })

  it('ClientMessageType values are snake_case strings', async () => {
    const { ClientMessageType } = await import('../src/index.ts')
    const snakeCase = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
    for (const [key, value] of Object.entries(ClientMessageType)) {
      assert.equal(typeof value, 'string', `${key} should be a string`)
      assert.ok(snakeCase.test(value), `${key} value '${value}' should be snake_case`)
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
      // Added in #2106:
      'diff_result', 'error', 'file_list', 'git_branches_result',
      'git_commit_result', 'git_stage_result', 'git_status_result',
      'git_unstage_result', 'log_entry', 'pair_fail', 'rate_limited',
      'session_activity', 'session_context', 'session_updated',
      'write_file_result', 'agent_spawned', 'agent_completed',
      'provider_list', 'push_token_error', 'cost_update',
      'budget_warning', 'budget_exceeded', 'web_feature_status',
      'discovered_sessions',
    ]

    for (const type of expectedTypes) {
      assert.ok(
        Object.values(ServerMessageType).includes(type),
        `ServerMessageType should contain '${type}'`,
      )
    }
  })

  it('ServerMessageType values are snake_case strings', async () => {
    const { ServerMessageType } = await import('../src/index.ts')
    const snakeCase = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
    for (const [key, value] of Object.entries(ServerMessageType)) {
      assert.equal(typeof value, 'string', `${key} should be a string`)
      assert.ok(snakeCase.test(value), `${key} value '${value}' should be snake_case`)
    }
  })
})

describe('message type enums match ws-server.js protocol docs', () => {
  it('client enum and ws-server.js docs have matching types (bidirectional)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { ClientMessageType } = await import('../src/index.ts')

    const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
    const src = readFileSync(wsServerPath, 'utf-8')

    // Extract the Client -> Server section
    const clientSection = src.match(/\* Client -> Server:\n([\s\S]*?)\n \*\n \* Server -> Client:/)?.[1]
    assert.ok(clientSection, 'Should find Client -> Server section')

    const docTypes = new Set([...clientSection.matchAll(/type: '(\w+)'/g)].map(m => m[1]))
    assert.ok(docTypes.size > 0, 'Should find client message types')

    // 'encrypted' is documented in the Encrypted envelope section (bidirectional)
    // — not in Client -> Server, so add it to the expected set
    docTypes.add('encrypted')

    const enumValues = new Set(Object.values(ClientMessageType))

    // docs ⊆ enum
    for (const type of docTypes) {
      assert.ok(enumValues.has(type),
        `ClientMessageType should contain '${type}' from ws-server.js`)
    }

    // enum ⊆ docs (no extra values in enum without documentation)
    for (const value of enumValues) {
      assert.ok(docTypes.has(value),
        `ClientMessageType value '${value}' should be documented in ws-server.js`)
    }
  })

  it('server enum and ws-server.js docs have matching types (bidirectional)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { ServerMessageType } = await import('../src/index.ts')

    const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
    const src = readFileSync(wsServerPath, 'utf-8')

    // Extract the Server -> Client section
    const serverSection = src.match(/\* Server -> Client:\n([\s\S]*?)\n \*\n \* Encrypted envelope/)?.[1]
    assert.ok(serverSection, 'Should find Server -> Client section')

    const docTypes = new Set([...serverSection.matchAll(/type: '(\w+)'/g)].map(m => m[1]))
    assert.ok(docTypes.size > 0, 'Should find server message types')

    // 'encrypted' is documented in the Encrypted envelope section (bidirectional)
    // — not in Server -> Client, so add it to the expected set
    docTypes.add('encrypted')

    const enumValues = new Set(Object.values(ServerMessageType))

    // docs ⊆ enum
    for (const type of docTypes) {
      assert.ok(enumValues.has(type),
        `ServerMessageType should contain '${type}' from ws-server.js`)
    }

    // enum ⊆ docs (no extra values in enum without documentation)
    for (const value of enumValues) {
      assert.ok(docTypes.has(value),
        `ServerMessageType value '${value}' should be documented in ws-server.js`)
    }
  })
})

describe('message type enums cover ws-schemas.js', () => {
  it('ClientMessageType covers all client schemas in ws-schemas.js', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { ClientMessageType } = await import('../src/index.ts')

    const schemasPath = resolve(import.meta.dirname, '../../server/src/ws-schemas.js')
    const src = readFileSync(schemasPath, 'utf-8')

    // Extract the ClientMessageSchema union — find all z.literal types in its discriminatedUnion
    const clientSection = src.match(/export const ClientMessageSchema[\s\S]*?z\.discriminatedUnion\('type',\s*\[([\s\S]*?)\]\s*\)/)?.[1]
    assert.ok(clientSection, 'Should find ClientMessageSchema discriminatedUnion')

    // Extract all type literals from the schema references
    // The schemas are defined above and referenced by name — extract types from all schema definitions
    const allLiterals = [...src.matchAll(/z\.literal\('([a-z_]+)'\)/g)].map(m => m[1])
    // Filter to client-only types: those that appear in schema objects referenced by ClientMessageSchema
    // We use a simpler approach: get types from the ClientMessageSchema union members
    const clientSchemaNames = [...clientSection.matchAll(/(\w+Schema)/g)].map(m => m[1])

    const clientTypes = new Set()
    for (const schemaName of clientSchemaNames) {
      const schemaDef = src.match(new RegExp(`export const ${schemaName}[\\s\\S]*?type: z\\.literal\\('([a-z_]+)'\\)`))?.[1]
      if (schemaDef) clientTypes.add(schemaDef)
    }

    assert.ok(clientTypes.size > 0, 'Should find client types in ws-schemas.js')

    const enumValues = new Set(Object.values(ClientMessageType))

    // Every client schema type should be in the enum
    // Skip 'encrypted' — it's in the envelope wrapper, not a client-specific schema
    for (const type of clientTypes) {
      assert.ok(enumValues.has(type),
        `ClientMessageType should contain '${type}' from ws-schemas.js`)
    }
  })
})
