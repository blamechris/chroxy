import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@chroxy/protocol schemas', () => {
  it('exports ClientMessageSchema from schemas entry point', async () => {
    const { ClientMessageSchema } = await import('../src/schemas/index.ts')
    assert.ok(ClientMessageSchema, 'ClientMessageSchema should be exported')

    // Validate a known message type
    const result = ClientMessageSchema.safeParse({ type: 'interrupt' })
    assert.ok(result.success, 'Should validate interrupt message')
  })

  it('exports ClientMessageSchema from main entry point', async () => {
    const { ClientMessageSchema } = await import('../src/index.ts')
    assert.ok(ClientMessageSchema, 'ClientMessageSchema should be re-exported from main')
  })

  it('validates input message with attachments', async () => {
    const { InputSchema } = await import('../src/schemas/client.ts')
    const result = InputSchema.safeParse({
      type: 'input',
      data: 'hello',
      attachments: [{ type: 'image', mediaType: 'image/png', data: 'base64data', name: 'screenshot.png' }],
    })
    assert.ok(result.success, 'Should validate input with image attachment')
  })

  it('rejects input with data exceeding max length', async () => {
    const { InputSchema } = await import('../src/schemas/client.ts')
    const result = InputSchema.safeParse({
      type: 'input',
      data: 'x'.repeat(100_001),
    })
    assert.ok(!result.success, 'Should reject data over 100k chars')
  })

  it('validates server auth_ok message', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'client-1',
      serverMode: 'cli',
      serverVersion: '0.5.0',
      latestVersion: null,
      serverCommit: 'abc123',
      cwd: '/home/user',
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    })
    assert.ok(result.success, 'Should validate auth_ok message')
  })

  it('validates encrypted envelope', async () => {
    const { EncryptedEnvelopeSchema } = await import('../src/schemas/client.ts')
    const result = EncryptedEnvelopeSchema.safeParse({
      type: 'encrypted',
      d: 'ciphertext',
      n: 0,
    })
    assert.ok(result.success, 'Should validate encrypted envelope')
  })

  it('rejects encrypted envelope with negative nonce', async () => {
    const { EncryptedEnvelopeSchema } = await import('../src/schemas/client.ts')
    const result = EncryptedEnvelopeSchema.safeParse({
      type: 'encrypted',
      d: 'ciphertext',
      n: -1,
    })
    assert.ok(!result.success, 'Should reject negative nonce')
  })

  it('exports inferred TypeScript types', async () => {
    // Just verify the types are exported (they're used at compile time)
    const mod = await import('../src/schemas/client.ts')
    assert.ok('AuthSchema' in mod, 'Should export AuthSchema')
    assert.ok('ClientMessageSchema' in mod, 'Should export ClientMessageSchema')
    assert.ok('EncryptedEnvelopeSchema' in mod, 'Should export EncryptedEnvelopeSchema')
  })

  it('validates create_session with sandbox option', async () => {
    const { CreateSessionSchema } = await import('../src/schemas/client.ts')
    const result = CreateSessionSchema.safeParse({
      type: 'create_session',
      name: 'Test Session',
      cwd: '/tmp',
      sandbox: {
        network: { allowedDomains: ['example.com'] },
        filesystem: { allowedPaths: ['/tmp'], deniedPaths: ['/etc'] },
        bash: { allowedCommands: ['ls', 'cat'] },
        autoAllowBashIfSandboxed: true,
      },
    })
    assert.ok(result.success, 'Should validate create_session with sandbox')
    assert.deepEqual(result.data.sandbox, {
      network: { allowedDomains: ['example.com'] },
      filesystem: { allowedPaths: ['/tmp'], deniedPaths: ['/etc'] },
      bash: { allowedCommands: ['ls', 'cat'] },
      autoAllowBashIfSandboxed: true,
    })
  })

  it('validates create_session without sandbox option', async () => {
    const { CreateSessionSchema } = await import('../src/schemas/client.ts')
    const result = CreateSessionSchema.safeParse({
      type: 'create_session',
      name: 'Test Session',
    })
    assert.ok(result.success, 'Should validate create_session without sandbox')
    assert.equal(result.data.sandbox, undefined)
  })

  it('discriminatedUnion covers all expected message types', async () => {
    const { ClientMessageSchema } = await import('../src/schemas/client.ts')

    const expectedTypes = [
      'input', 'interrupt', 'set_model', 'set_permission_mode',
      'permission_response', 'list_sessions', 'switch_session', 'create_session',
      'destroy_session', 'rename_session', 'register_push_token',
      'user_question_response', 'list_directory', 'browse_files', 'read_file',
      'write_file', 'list_files', 'list_slash_commands', 'list_agents',
      'request_full_history', 'request_session_context',
      'get_diff', 'git_status', 'git_branches', 'git_stage', 'git_unstage', 'git_commit',
      'resume_budget', 'list_checkpoints', 'restore_checkpoint', 'create_checkpoint',
      'delete_checkpoint', 'close_dev_preview',
      'launch_web_task', 'list_web_tasks', 'teleport_web_task',
      'list_conversations', 'resume_conversation', 'search_conversations',
      'request_cost_summary', 'subscribe_sessions', 'unsubscribe_sessions',
      'list_providers', 'list_repos', 'add_repo', 'remove_repo',
      'query_permission_audit',
    ]

    for (const type of expectedTypes) {
      const result = ClientMessageSchema.safeParse({ type })
      // Some types need required fields — just verify the type is recognized
      // (safeParse may fail on missing fields but the discriminator should match)
      if (!result.success) {
        const errors = result.error.issues || result.error.errors || []
        const hasTypeError = errors.some(e =>
          e.path?.includes('type') || e.message?.includes('type')
        )
        assert.ok(!hasTypeError,
          `Type '${type}' should be recognized by ClientMessageSchema discriminator`)
      }
    }
  })

  it('accepts ServerMessageSchema with optional code field for structured errors', async () => {
    const { ServerMessageSchema } = await import('../src/schemas/server.ts')
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'error',
      content: 'Docker is not running.',
      timestamp: Date.now(),
      code: 'docker_not_running',
    })
    assert.ok(result.success, 'Should validate message with code field')
    assert.equal(result.data.code, 'docker_not_running')
  })

  it('accepts ServerMessageSchema without code field (backward compatible)', async () => {
    const { ServerMessageSchema } = await import('../src/schemas/server.ts')
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'assistant',
      content: 'hello',
      timestamp: Date.now(),
    })
    assert.ok(result.success, 'Should validate message without code field')
  })

  it('rejects ServerMessageSchema with code exceeding 64 chars', async () => {
    const { ServerMessageSchema } = await import('../src/schemas/server.ts')
    const result = ServerMessageSchema.safeParse({
      type: 'message',
      messageType: 'error',
      content: 'err',
      timestamp: Date.now(),
      code: 'x'.repeat(65),
    })
    assert.ok(!result.success, 'Should reject code longer than 64 chars')
  })

  it('validates ServerProviderListSchema with capabilities', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [
        { name: 'claude', capabilities: { sandbox: true, push: false } },
        { name: 'codex', capabilities: {} },
      ],
    })
    assert.ok(result.success, 'Should validate provider_list with capabilities')
    assert.equal(result.data.providers.length, 2)
    assert.equal(result.data.providers[0].name, 'claude')
    assert.deepEqual(result.data.providers[0].capabilities, { sandbox: true, push: false })
  })

  it('validates ServerProviderListSchema without optional capabilities', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ name: 'claude' }],
    })
    assert.ok(result.success, 'Should validate provider_list when capabilities is omitted')
    assert.equal(result.data.providers[0].capabilities, undefined)
  })

  it('validates ServerProviderListSchema with empty providers array', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [],
    })
    assert.ok(result.success, 'Should validate provider_list with empty providers array')
  })

  it('rejects ServerProviderListSchema with wrong type literal', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'providers',
      providers: [{ name: 'claude' }],
    })
    assert.ok(!result.success, 'Should reject when type is not "provider_list"')
  })

  it('rejects ServerProviderListSchema missing providers field', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
    })
    assert.ok(!result.success, 'Should reject when providers field is missing')
  })

  it('rejects ServerProviderListSchema when provider entry missing name', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ capabilities: { sandbox: true } }],
    })
    assert.ok(!result.success, 'Should reject provider entry without name')
  })

  it('rejects ServerProviderListSchema when capabilities values are not booleans', async () => {
    const { ServerProviderListSchema } = await import('../src/schemas/server.ts')
    const result = ServerProviderListSchema.safeParse({
      type: 'provider_list',
      providers: [{ name: 'claude', capabilities: { sandbox: 'yes' } }],
    })
    assert.ok(!result.success, 'Should reject non-boolean capability values')
  })

  it('validates ServerSkillsListSchema with description', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [
        { name: 'review', description: 'Review a pull request' },
        { name: 'commit', description: 'Create a git commit' },
      ],
    })
    assert.ok(result.success, 'Should validate skills_list with descriptions')
    assert.equal(result.data.skills.length, 2)
    assert.equal(result.data.skills[0].name, 'review')
    assert.equal(result.data.skills[0].description, 'Review a pull request')
  })

  it('validates ServerSkillsListSchema without optional description', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit' }],
    })
    assert.ok(result.success, 'Should validate skills_list when description is omitted')
    assert.equal(result.data.skills[0].description, undefined)
  })

  it('validates ServerSkillsListSchema with empty skills array', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [],
    })
    assert.ok(result.success, 'Should validate skills_list with empty skills array')
  })

  it('rejects ServerSkillsListSchema with wrong type literal', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills',
      skills: [{ name: 'commit' }],
    })
    assert.ok(!result.success, 'Should reject when type is not "skills_list"')
  })

  it('rejects ServerSkillsListSchema missing skills field', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
    })
    assert.ok(!result.success, 'Should reject when skills field is missing')
  })

  it('rejects ServerSkillsListSchema when skill entry missing name', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ description: 'No name' }],
    })
    assert.ok(!result.success, 'Should reject skill entry without name')
  })

  it('rejects ServerSkillsListSchema when description is not a string', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit', description: 42 }],
    })
    assert.ok(!result.success, 'Should reject non-string description')
  })

  it('validates ServerWebTaskErrorSchema with generic-task-failure shape', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: 'task-1',
      message: 'Task prompt is required',
    })
    assert.ok(result.success, 'Should validate generic web_task_error without code/boundSession*')
  })

  it('validates ServerWebTaskErrorSchema with SESSION_TOKEN_MISMATCH four-field contract', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: null,
      message: 'Not authorized to access this session',
      code: 'SESSION_TOKEN_MISMATCH',
      boundSessionId: 'session-42',
      boundSessionName: 'My Project',
    })
    assert.ok(result.success, 'Should validate full SESSION_TOKEN_MISMATCH payload')
    assert.equal(result.data.code, 'SESSION_TOKEN_MISMATCH')
    assert.equal(result.data.boundSessionId, 'session-42')
    assert.equal(result.data.boundSessionName, 'My Project')
  })

  it('validates ServerWebTaskErrorSchema with null boundSessionId/boundSessionName', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: null,
      message: 'Not authorized to access this session',
      code: 'SESSION_TOKEN_MISMATCH',
      boundSessionId: null,
      boundSessionName: null,
    })
    assert.ok(result.success, 'Should validate SESSION_TOKEN_MISMATCH with null bound fields')
    assert.equal(result.data.boundSessionId, null)
    assert.equal(result.data.boundSessionName, null)
  })

  it('rejects ServerWebTaskErrorSchema when code exceeds 64 chars', async () => {
    const { ServerWebTaskErrorSchema } = await import('../src/schemas/server.ts')
    const result = ServerWebTaskErrorSchema.safeParse({
      type: 'web_task_error',
      taskId: 'task-1',
      message: 'oops',
      code: 'X'.repeat(65),
    })
    assert.ok(!result.success, 'Should reject web_task_error code longer than 64 chars')
  })
})
