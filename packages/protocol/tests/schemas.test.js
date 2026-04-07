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
})
