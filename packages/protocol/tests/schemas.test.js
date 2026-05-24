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

  // #3760/#3765: resultTimeoutMs is the server's effective inactivity timeout,
  // surfaced so clients can render the ActivityIndicator warning at the right
  // moment. Optional for back-compat with servers from before #3763.
  it('validates auth_ok with resultTimeoutMs (#3760)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.18',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      resultTimeoutMs: 20 * 60 * 1000,
    })
    assert.ok(result.success, 'Should validate auth_ok with resultTimeoutMs')
    assert.equal(result.data.resultTimeoutMs, 1_200_000)
  })

  it('accepts auth_ok without resultTimeoutMs (older servers)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.16',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    })
    assert.ok(result.success, 'Should accept auth_ok without resultTimeoutMs')
    assert.equal(result.data.resultTimeoutMs, undefined)
  })

  it('rejects auth_ok with invalid resultTimeoutMs (non-positive, non-integer, non-finite, or non-number)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    for (const bad of [0, -1, 1.5, Infinity, NaN, '20']) {
      const result = ServerAuthOkSchema.safeParse({
        type: 'auth_ok',
        clientId: 'c',
        serverMode: 'cli',
        serverVersion: '0.7.18',
        latestVersion: null,
        serverCommit: 'abc',
        cwd: null,
        connectedClients: [],
        encryption: 'disabled',
        protocolVersion: 1,
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
        resultTimeoutMs: bad,
      })
      assert.ok(!result.success, `Should reject bad resultTimeoutMs: ${String(bad)}`)
    }
  })

  // #3768: 24h ceiling — guards against env-var typos (e.g.
  // `CHROXY_RESULT_TIMEOUT_MS=999999999999999`) pushing a value onto
  // the wire that passes integer/positive/finite but overflows the
  // client's `Date.now() + ms` math.
  it('rejects auth_ok with resultTimeoutMs above 24h ceiling (#3768)', async () => {
    const { ServerAuthOkSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = {
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.18',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    }
    assert.ok(ServerAuthOkSchema.safeParse({ ...base, resultTimeoutMs: MAX }).success, 'exactly 24h should pass')
    assert.ok(!ServerAuthOkSchema.safeParse({ ...base, resultTimeoutMs: MAX + 1 }).success, '24h + 1ms should reject')
    assert.ok(!ServerAuthOkSchema.safeParse({ ...base, resultTimeoutMs: 999_999_999_999_999 }).success, 'env-typo huge value should reject')
  })

  // #3905: hardTimeoutMs broadcast on auth_ok so clients can render
  // the check-in chip's "kill in Xh" countdown against the real
  // configured value instead of assuming the 2h default.
  it('validates auth_ok with hardTimeoutMs (#3905)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.8.0',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      resultTimeoutMs: 30 * 60 * 1000,
      hardTimeoutMs: 2 * 60 * 60 * 1000,
    })
    assert.ok(result.success, 'Should validate auth_ok with hardTimeoutMs')
    assert.equal(result.data.hardTimeoutMs, 7_200_000)
  })

  it('accepts auth_ok without hardTimeoutMs (older servers, pre-#3905)', async () => {
    const { ServerAuthOkSchema } = await import('../src/schemas/server.ts')
    const result = ServerAuthOkSchema.safeParse({
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.7.18',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
      resultTimeoutMs: 30 * 60 * 1000,
    })
    assert.ok(result.success, 'Should accept auth_ok without hardTimeoutMs')
    assert.equal(result.data.hardTimeoutMs, undefined)
  })

  it('rejects auth_ok with invalid hardTimeoutMs (#3905)', async () => {
    const { ServerAuthOkSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = {
      type: 'auth_ok',
      clientId: 'c',
      serverMode: 'cli',
      serverVersion: '0.8.0',
      latestVersion: null,
      serverCommit: 'abc',
      cwd: null,
      connectedClients: [],
      encryption: 'disabled',
      protocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    }
    for (const bad of [0, -1, 1.5, Infinity, NaN, '120', MAX + 1]) {
      const result = ServerAuthOkSchema.safeParse({ ...base, hardTimeoutMs: bad })
      assert.ok(!result.success, `Should reject bad hardTimeoutMs: ${String(bad)}`)
    }
    assert.ok(ServerAuthOkSchema.safeParse({ ...base, hardTimeoutMs: MAX }).success, 'exactly 24h should pass')
  })

  // #3768: same ceiling applied to other ms-typed fields.
  it('rejects permission_request with remainingMs above 24h ceiling (#3768)', async () => {
    const { ServerPermissionRequestSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = { type: 'permission_request', requestId: 'r', tool: 't', input: {} }
    assert.ok(ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: MAX }).success, 'exactly 24h should pass')
    assert.ok(ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: 0 }).success, '0 should pass (request just expired)')
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: MAX + 1 }).success, '24h + 1ms should reject')
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: -1 }).success, 'negative should reject')
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: Infinity }).success, 'Infinity should reject')
    // #3785: ms duration must be a whole number — guards against accidental
    // fractional values from a future emitter (e.g. `Date.now() / 2`).
    assert.ok(!ServerPermissionRequestSchema.safeParse({ ...base, remainingMs: 100.5 }).success, 'fractional ms should reject')
  })

  it('rejects server_shutdown with restartEtaMs above 24h ceiling (#3768)', async () => {
    const { ServerShutdownSchema, MAX_SANE_DURATION_MS: MAX } = await import('../src/schemas/server.ts')
    const base = { type: 'server_shutdown', reason: 'restart' }
    assert.ok(ServerShutdownSchema.safeParse({ ...base, restartEtaMs: MAX }).success, 'exactly 24h should pass')
    assert.ok(ServerShutdownSchema.safeParse({ ...base, restartEtaMs: 0 }).success, '0 should pass (not coming back)')
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: MAX + 1 }).success, '24h + 1ms should reject')
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: -1 }).success, 'negative should reject')
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: Infinity }).success, 'Infinity should reject')
    // #3785: ms duration must be a whole number.
    assert.ok(!ServerShutdownSchema.safeParse({ ...base, restartEtaMs: 100.5 }).success, 'fractional ms should reject')
  })

  // Wire-contract alignment surfaced by #3768 review:
  // server emits permission_request with sessionId, and server_shutdown
  // with reason='crash'. Schema must accept both.
  it('accepts permission_request with sessionId (#3773)', async () => {
    const { ServerPermissionRequestSchema } = await import('../src/schemas/server.ts')
    const result = ServerPermissionRequestSchema.safeParse({
      type: 'permission_request',
      requestId: 'r',
      tool: 't',
      input: {},
      sessionId: 'sess-abc',
    })
    assert.ok(result.success, 'Should accept permission_request with sessionId')
    assert.equal(result.data.sessionId, 'sess-abc')
  })

  it('accepts server_shutdown with reason=crash (#3773)', async () => {
    const { ServerShutdownSchema } = await import('../src/schemas/server.ts')
    const result = ServerShutdownSchema.safeParse({
      type: 'server_shutdown',
      reason: 'crash',
      restartEtaMs: 0,
    })
    assert.ok(result.success, 'Should accept reason=crash (emitted on uncaughtException)')
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
      'client_visible',
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

  it('validates ServerSkillsListSchema with ISO-8601 firstSeen / lastVerified (#3250)', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{
        name: 'commit',
        firstSeen: '2026-03-18T10:00:00.000Z',
        lastVerified: '2026-05-03T12:34:56Z',
      }],
    })
    assert.ok(result.success, 'Should validate ISO-8601 datetimes')
  })

  it('rejects ServerSkillsListSchema with non-ISO firstSeen (#3250)', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit', firstSeen: '2026-03-18 10:00:00' }],
    })
    assert.ok(!result.success, 'Should reject space-separated date instead of ISO-8601')
  })

  it('rejects ServerSkillsListSchema with non-ISO lastVerified (#3250)', async () => {
    const { ServerSkillsListSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillsListSchema.safeParse({
      type: 'skills_list',
      skills: [{ name: 'commit', lastVerified: 'Sun May 03 2026' }],
    })
    assert.ok(!result.success, 'Should reject Date.toString() form')
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

  // #3234: skill_changed event schema (server-broadcast trust mismatch).
  it('validates ServerSkillChangedSchema with warn mode + 8-char hash prefixes', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'coding-style',
      sessionId: 'sess-42',
      oldHashPrefix: 'abcdef01',
      newHashPrefix: '01234567',
      mode: 'warn',
    })
    assert.ok(result.success, 'Should validate well-formed warn-mode skill_changed')
    assert.equal(result.data.skillName, 'coding-style')
    assert.equal(result.data.mode, 'warn')
  })

  it('validates ServerSkillChangedSchema with block mode + null sessionId (legacy single-CLI)', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'coding-style',
      sessionId: null,
      oldHashPrefix: 'aaaaaaaa',
      newHashPrefix: 'bbbbbbbb',
      mode: 'block',
    })
    assert.ok(result.success, 'Should accept null sessionId for legacy single-CLI mode')
    assert.equal(result.data.sessionId, null)
    assert.equal(result.data.mode, 'block')
  })

  it('rejects ServerSkillChangedSchema with hash prefix shorter than 8 chars', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'short',
      newHashPrefix: 'bbbbbbbb',
      mode: 'warn',
    })
    assert.ok(!result.success, 'Should reject hash prefix shorter than 8 chars')
  })

  it('rejects ServerSkillChangedSchema with non-hex hash prefix', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'XYZGHIJK', // not lowercase hex
      newHashPrefix: 'bbbbbbbb',
      mode: 'warn',
    })
    assert.ok(!result.success, 'Should reject non-hex hash prefix')
  })

  it('rejects ServerSkillChangedSchema with unknown mode', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_changed',
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'aaaaaaaa',
      newHashPrefix: 'bbbbbbbb',
      mode: 'banana',
    })
    assert.ok(!result.success, 'Should reject mode that is not warn or block')
  })

  it('rejects ServerSkillChangedSchema with wrong type literal', async () => {
    const { ServerSkillChangedSchema } = await import('../src/schemas/server.ts')
    const result = ServerSkillChangedSchema.safeParse({
      type: 'skill_change', // missing 'd'
      skillName: 'x',
      sessionId: null,
      oldHashPrefix: 'aaaaaaaa',
      newHashPrefix: 'bbbbbbbb',
      mode: 'warn',
    })
    assert.ok(!result.success, 'Should reject when type is not "skill_changed"')
  })

  // #3100: ServerEvaluateDraftResultSchema gained an optional numeric `status`
  // on the error branch. Lock the wire contract here so a future regression
  // (e.g. someone widens the type to string, or drops the optional flag)
  // can't slip through with only server/dashboard tests staying green.
  describe('ServerEvaluateDraftResultSchema (#3100)', () => {
    it('validates the success branch (forward verdict)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-1',
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'Looks clear.',
      })
      assert.ok(result.success, 'Should validate forward verdict success payload')
    })

    it('validates the error branch with optional status (429)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-2',
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator rate limited', status: 429 },
      })
      assert.ok(result.success, 'Should validate error payload carrying numeric status')
      if (result.success && 'error' in result.data && result.data.error) {
        assert.equal(result.data.error.status, 429)
      }
    })

    it('validates the error branch when status is omitted (network error / NO_API_KEY)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-3',
        error: { code: 'EVALUATOR_NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set' },
      })
      assert.ok(result.success, 'Should validate error payload without status')
      if (result.success && 'error' in result.data && result.data.error) {
        assert.equal(result.data.error.status, undefined)
      }
    })

    it('rejects a non-numeric status on the error branch', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-4',
        error: { code: 'EVALUATOR_API_ERROR', message: 'rate limited', status: '429' },
      })
      assert.ok(!result.success, 'Should reject string status — wire contract is z.number().int()')
    })

    it('rejects a non-integer status on the error branch', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-5',
        error: { code: 'EVALUATOR_API_ERROR', message: 'x', status: 429.5 },
      })
      assert.ok(!result.success, 'Should reject non-integer status — wire contract is z.number().int()')
    })

    it('rejects mixed payload (verdict + error)', async () => {
      const { ServerEvaluateDraftResultSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluateDraftResultSchema.safeParse({
        type: 'evaluate_draft_result',
        requestId: 'req-6',
        verdict: 'forward',
        reasoning: 'ok',
        error: { code: 'EVALUATOR_API_ERROR', message: 'no' },
      })
      assert.ok(!result.success, 'Discriminated union should reject mixed success+error')
    })
  })

  // #3538: skill_trust_grant INVALID_AUTHOR error must carry actualAuthor as
  // a structured field on the wire — clients must NOT regex-parse `message`.
  describe('ServerSkillTrustGrantInvalidAuthorSchema (#3538)', () => {
    it('validates a well-formed INVALID_AUTHOR payload with actualAuthor', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: 'req-1',
        code: 'INVALID_AUTHOR',
        message: "Community skill 'foo' is owned by 'alice', not 'bob'.",
        actualAuthor: 'alice',
      })
      assert.ok(result.success, 'Should validate INVALID_AUTHOR error carrying actualAuthor')
      if (result.success) {
        assert.equal(result.data.actualAuthor, 'alice')
      }
    })

    it('accepts null requestId', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: null,
        code: 'INVALID_AUTHOR',
        message: 'wrong author',
        actualAuthor: 'alice',
      })
      assert.ok(result.success, 'requestId must accept null')
    })

    it('rejects payload missing actualAuthor', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: 'req-2',
        code: 'INVALID_AUTHOR',
        message: 'wrong author',
      })
      assert.ok(!result.success, 'actualAuthor is required for the cross-author variants')
    })

    it('rejects wrong code literal', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'error',
        requestId: 'req-3',
        code: 'SKILL_NOT_FOUND',
        message: 'oops',
        actualAuthor: 'alice',
      })
      assert.ok(!result.success, 'Schema must lock code to literal INVALID_AUTHOR')
    })

    it('rejects wrong type literal', async () => {
      const { ServerSkillTrustGrantInvalidAuthorSchema } = await import('../src/schemas/server.ts')
      const result = ServerSkillTrustGrantInvalidAuthorSchema.safeParse({
        type: 'server_error',
        requestId: 'req-4',
        code: 'INVALID_AUTHOR',
        message: 'oops',
        actualAuthor: 'alice',
      })
      assert.ok(!result.success, 'Schema must lock type to literal "error"')
    })
  })

  // #3544: pin the wire contract for the cumulative stdin_dropped totals so a
  // server-side regression (e.g. dropping the `escalated` flag, widening
  // `bytes` to a string, forgetting the nullable `sessionId`) is caught here
  // before it reaches the dashboard schema-validation layer.
  describe('ServerStdinDroppedTotalsSchema (#3544)', () => {
    it('validates a multi-session payload', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: 1048576,
        count: 4,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(result.success, 'Should validate multi-session totals payload')
    })

    it('accepts null sessionId (legacy single-CLI mode)', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: null,
        bytes: 0,
        count: 0,
        reason: 'unknown',
        escalated: false,
      })
      assert.ok(result.success, 'Should validate null sessionId for legacy mode')
    })

    it('rejects negative bytes', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: -1,
        count: 1,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(!result.success, 'Should reject negative bytes — counters are nonnegative')
    })

    it('rejects non-integer count', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: 100,
        count: 1.5,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(!result.success, 'Should reject non-integer count')
    })

    it('rejects missing escalated flag', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'stdin_dropped_totals',
        sessionId: 'sess-1',
        bytes: 100,
        count: 1,
        reason: 'pre-dial-cap',
      })
      assert.ok(!result.success, 'escalated is required for the loud-signal UX')
    })

    it('rejects wrong type literal', async () => {
      const { ServerStdinDroppedTotalsSchema } = await import('../src/schemas/server.ts')
      const result = ServerStdinDroppedTotalsSchema.safeParse({
        type: 'wrong_type',
        sessionId: 'sess-1',
        bytes: 100,
        count: 1,
        reason: 'pre-dial-cap',
        escalated: true,
      })
      assert.ok(!result.success, 'type must be "stdin_dropped_totals"')
    })
  })

  // #3573: session_list entry shape now documents the cumulative
  // stdin_dropped totals so a reconnecting client can hydrate the live
  // counter from the handshake. The entry schema is `passthrough()` so
  // older clients ignore unknown fields and newer clients can rely on
  // the documented optional fields below.
  describe('ServerSessionListEntrySchema (#3573)', () => {
    it('validates an entry with stdinDroppedBytes and stdinDroppedCount', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        model: 'claude-sonnet-4-6',
        permissionMode: 'approve',
        isBusy: false,
        stdinForwardingDisabled: false,
        stdinDroppedBytes: 4096,
        stdinDroppedCount: 3,
      })
      assert.ok(result.success, 'session_list entry must accept stdinDropped totals')
      assert.equal(result.data.stdinDroppedBytes, 4096)
      assert.equal(result.data.stdinDroppedCount, 3)
    })

    it('validates an entry with zeroed totals (non-SDK provider)', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-cli',
        name: 'Cli Session',
        cwd: '/tmp/cli',
        stdinDroppedBytes: 0,
        stdinDroppedCount: 0,
      })
      assert.ok(result.success, 'zero counters from non-SDK providers must validate')
    })

    it('rejects negative stdinDroppedBytes', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        stdinDroppedBytes: -1,
        stdinDroppedCount: 0,
      })
      assert.ok(!result.success, 'byte counter must be non-negative')
    })

    it('rejects fractional stdinDroppedCount', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        stdinDroppedBytes: 0,
        stdinDroppedCount: 1.5,
      })
      assert.ok(!result.success, 'drop count must be an integer')
    })

    it('treats stdinDroppedTotals as optional (older servers omit them)', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
      })
      assert.ok(result.success, 'older servers without #3573 fields must still validate')
    })

    it('passes through unknown fields for forward compat', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cwd: '/tmp/project',
        someFutureField: { foo: 'bar' },
      })
      assert.ok(result.success, 'passthrough() must allow unknown fields')
      assert.equal(result.data.someFutureField.foo, 'bar')
    })

    it('validates a full session_list payload through ServerSessionListSchema', async () => {
      const { ServerSessionListSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListSchema.safeParse({
        type: 'session_list',
        sessions: [
          {
            sessionId: 'sess-1',
            name: 'Session 1',
            cwd: '/tmp/project',
            stdinDroppedBytes: 1024,
            stdinDroppedCount: 2,
          },
          {
            sessionId: 'sess-2',
            name: 'Session 2',
            cwd: '/tmp/project-2',
            stdinDroppedBytes: 0,
            stdinDroppedCount: 0,
          },
        ],
      })
      assert.ok(result.success, 'session_list with stdinDropped totals must validate end-to-end')
      assert.equal(result.data.sessions[0].stdinDroppedBytes, 1024)
      assert.equal(result.data.sessions[1].stdinDroppedCount, 0)
    })
  })

  // #3208: auto-evaluator broadcast events. Two transient events arriving without
  // a triggering client request, so the dashboard knows to render the
  // rewrite-explanation banner or the clarify-question modal.
  describe('ServerEvaluatorRewriteSchema (#3208)', () => {
    it('validates a well-formed evaluator_rewrite payload', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'fix it',
        rewritten: 'Please fix the failing test in foo.js',
        reasoning: 'Original was too vague.',
        evaluatorIterationId: 'iter-abc-1',
      })
      assert.ok(result.success, 'Should validate well-formed evaluator_rewrite')
      assert.equal(result.data.sessionId, 'sess-1')
      assert.equal(result.data.evaluatorIterationId, 'iter-abc-1')
    })

    it('rejects evaluator_rewrite with wrong type literal', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(!result.success, 'Should reject when type is not "evaluator_rewrite"')
    })

    it('rejects evaluator_rewrite missing rewritten field', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(!result.success, 'rewritten is required for the rewrite verdict')
    })

    it('rejects evaluator_rewrite missing evaluatorIterationId', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
      })
      assert.ok(!result.success, 'evaluatorIterationId is required for dashboard dedup')
    })

    it('rejects evaluator_rewrite with non-string sessionId', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 42,
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(!result.success, 'sessionId must be a string')
    })

    // #3627: pin the empty-string and extra-field policies so a future
    // tightening (z.string().min(1) or .strict()) is a deliberate decision
    // with a failing test, not a silent regression that breaks older
    // servers when newer fields land.
    it('accepts empty originalDraft / rewritten / reasoning (empty-string policy)', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: '',
        rewritten: '',
        reasoning: '',
        evaluatorIterationId: 'iter-1',
      })
      assert.ok(result.success, 'empty strings must validate — auto-evaluator may produce empty reasoning under timeout fallback')
    })

    it('strips unknown fields for forward compat (Zod default behavior)', async () => {
      const { ServerEvaluatorRewriteSchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorRewriteSchema.safeParse({
        type: 'evaluator_rewrite',
        sessionId: 'sess-1',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        someFutureField: { nested: 'value' },
      })
      assert.ok(result.success, 'unknown fields must NOT reject — newer servers may emit fields older clients don\'t recognize')
      assert.equal(result.data.someFutureField, undefined, 'Zod default strips unknown fields from the parsed output')
    })
  })

  describe('ServerEvaluatorClarifySchema (#3208)', () => {
    it('validates a well-formed evaluator_clarify payload', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'fix it',
        clarification: 'Which file are you referring to?',
        reasoning: 'The draft does not specify a file.',
        evaluatorIterationId: 'iter-abc-2',
        evaluatorIteration: 1,
      })
      assert.ok(result.success, 'Should validate well-formed evaluator_clarify')
      assert.equal(result.data.evaluatorIteration, 1)
    })

    it('validates evaluator_clarify at max iteration (3)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 3,
      })
      assert.ok(result.success, 'Should accept iteration 3 (max)')
    })

    it('rejects evaluator_clarify with iteration above sanity ceiling (11)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 11,
      })
      assert.ok(!result.success, 'iteration must be capped at the wire-schema sanity ceiling (10)')
    })

    it('rejects evaluator_clarify with iteration 0', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 0,
      })
      assert.ok(!result.success, 'iteration counter is 1-based')
    })

    it('rejects evaluator_clarify with non-integer iteration', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1.5,
      })
      assert.ok(!result.success, 'iteration must be an integer')
    })

    it('rejects evaluator_clarify missing clarification', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      })
      assert.ok(!result.success, 'clarification is required for the clarify verdict')
    })

    it('rejects evaluator_clarify with wrong type literal', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      })
      assert.ok(!result.success, 'Should reject when type is not "evaluator_clarify"')
    })

    // #3627: same empty-string + extra-field policies as the rewrite schema —
    // pin them so a future tightening is a deliberate decision.
    it('accepts empty originalDraft / clarification / reasoning (empty-string policy)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: '',
        clarification: '',
        reasoning: '',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      })
      assert.ok(result.success, 'empty strings must validate — auto-evaluator may produce empty reasoning under timeout fallback')
    })

    it('strips unknown fields for forward compat (Zod default behavior)', async () => {
      const { ServerEvaluatorClarifySchema } = await import('../src/schemas/server.ts')
      const result = ServerEvaluatorClarifySchema.safeParse({
        type: 'evaluator_clarify',
        sessionId: 'sess-1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
        someFutureField: { nested: 'value' },
      })
      assert.ok(result.success, 'unknown fields must NOT reject — newer servers may emit fields older clients don\'t recognize')
      assert.equal(result.data.someFutureField, undefined, 'Zod default strips unknown fields from the parsed output')
    })
  })

  describe('CumulativeUsage + session_usage + session_cost_threshold_crossed (#4091)', () => {
    it('CumulativeUsageSchema validates a full block', async () => {
      const { CumulativeUsageSchema } = await import('../src/schemas/server.ts')
      const result = CumulativeUsageSchema.safeParse({
        inputTokens: 1234,
        outputTokens: 567,
        cacheReadTokens: 8000,
        cacheCreationTokens: 200,
        costUsd: 0.0345,
        turnsBilled: 3,
      })
      assert.ok(result.success)
    })

    it('CumulativeUsageSchema rejects when a numeric field is missing', async () => {
      const { CumulativeUsageSchema } = await import('../src/schemas/server.ts')
      const result = CumulativeUsageSchema.safeParse({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        // costUsd intentionally missing
        turnsBilled: 0,
      })
      assert.ok(!result.success, 'all six fields are required by the schema')
    })

    it('ServerSessionUsageSchema validates with sessionId injected by broadcaster', async () => {
      const { ServerSessionUsageSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionUsageSchema.safeParse({
        type: 'session_usage',
        sessionId: 'sess-1',
        cumulativeUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
          turnsBilled: 1,
        },
      })
      assert.ok(result.success)
    })

    it('ServerSessionUsageSchema permits omitting sessionId (pre-broadcast shape)', async () => {
      // _broadcastToSession injects sessionId via spread; the EventNormalizer
      // emits without it. Schema must accept both shapes.
      const { ServerSessionUsageSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionUsageSchema.safeParse({
        type: 'session_usage',
        cumulativeUsage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheCreationTokens: 0, costUsd: 0, turnsBilled: 0,
        },
      })
      assert.ok(result.success)
    })

    it('ServerSessionCostThresholdCrossedSchema validates the threshold-crossed payload', async () => {
      const { ServerSessionCostThresholdCrossedSchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionCostThresholdCrossedSchema.safeParse({
        type: 'session_cost_threshold_crossed',
        sessionId: 'sess-1',
        costUsd: 5.23,
        thresholdUsd: 5.00,
      })
      assert.ok(result.success)
    })

    it('ServerSessionListEntrySchema accepts an entry with cumulativeUsage', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
        cumulativeUsage: {
          inputTokens: 100, outputTokens: 50, cacheReadTokens: 0,
          cacheCreationTokens: 0, costUsd: 0.001, turnsBilled: 1,
        },
      })
      assert.ok(result.success)
      assert.equal(result.data.cumulativeUsage?.costUsd, 0.001)
    })

    it('ServerSessionListEntrySchema accepts an entry without cumulativeUsage (older servers)', async () => {
      const { ServerSessionListEntrySchema } = await import('../src/schemas/server.ts')
      const result = ServerSessionListEntrySchema.safeParse({
        sessionId: 'sess-1',
        name: 'Session 1',
      })
      assert.ok(result.success)
      assert.equal(result.data.cumulativeUsage, undefined)
    })
  })

  // #4141: BYOK credentials status — dashboard previously raw-cast the payload.
  // The schema constrains status/source to enum values so a malformed server
  // can't store unknown strings into the store.
  describe('ServerByokCredentialsStatusSchema (#4141)', () => {
    it('accepts the full documented shape', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        requestId: 'req-1',
        status: 'set',
        source: 'file',
        masked: 'sk-ant-***...xyz',
        fileExists: true,
      })
      assert.ok(r.success)
      assert.equal(r.data.status, 'set')
      assert.equal(r.data.source, 'file')
      assert.equal(r.data.masked, 'sk-ant-***...xyz')
      assert.equal(r.data.fileExists, true)
    })

    it('rejects unknown status values (enum constraint)', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        status: 'unknown',
        source: 'file',
      })
      assert.equal(r.success, false)
    })

    it('rejects unknown source values (enum constraint)', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        status: 'missing',
        source: 'magic',
      })
      assert.equal(r.success, false)
    })

    it('accepts minimal status without optional fields', async () => {
      const { ServerByokCredentialsStatusSchema } = await import('../src/schemas/server.ts')
      const r = ServerByokCredentialsStatusSchema.safeParse({
        type: 'byok_credentials_status',
        status: 'missing',
        source: 'none',
      })
      assert.ok(r.success)
      assert.equal(r.data.masked, undefined)
      assert.equal(r.data.fileExists, undefined)
    })
  })

  // #4192: ServerErrorEnvelopeMessage type alias — exported alongside the
  // schema so downstream consumers (mobile/dashboard/future tools) can write
  // `import type { ServerErrorEnvelopeMessage }` instead of re-running
  // `z.infer<typeof ServerErrorEnvelopeSchema>` at every call site. The
  // type itself is erased at runtime; these tests pin the schema shape that
  // the type represents so any future schema edit (renamed field, dropped
  // optional, narrowed enum) surfaces here before silently breaking typed
  // consumers.
  describe('ServerErrorEnvelopeMessage type alias (#4192)', () => {
    it('exports a type alias importable as TS-only re-export', async () => {
      // The export is type-only and erased at runtime, so we verify the
      // schema this alias is derived from is present and importable.
      // CI's Store Core Type Check / Dashboard Type Check perform the
      // actual type-level verification when consumers import the alias.
      const mod = await import('../src/schemas/server.ts')
      assert.ok(mod.ServerErrorEnvelopeSchema, 'ServerErrorEnvelopeSchema must remain exported')
    })

    it('schema shape accepts all fields the type alias surfaces', async () => {
      const { ServerErrorEnvelopeSchema } = await import('../src/schemas/server.ts')
      const result = ServerErrorEnvelopeSchema.safeParse({
        type: 'error',
        requestId: 'req-1',
        code: 'STREAM_ERROR',
        message: 'boom',
        fatal: false,
        correlationId: 'c-1',
        details: 'stack trace',
      })
      assert.ok(result.success, 'must accept the full documented envelope shape')
      // Pin the inferred shape — if any of these fields are dropped/renamed,
      // typed consumers break. Asserting at runtime catches the schema edit
      // before it reaches downstream type-checks.
      assert.equal(result.data.type, 'error')
      assert.equal(result.data.code, 'STREAM_ERROR')
      assert.equal(result.data.fatal, false)
      assert.equal(result.data.correlationId, 'c-1')
      assert.equal(result.data.details, 'stack trace')
    })

    it('schema preserves passthrough fields the type alias inherits', async () => {
      const { ServerErrorEnvelopeSchema } = await import('../src/schemas/server.ts')
      // .passthrough() lets code-specific extension fields (e.g.
      // actualAuthor on INVALID_AUTHOR, boundSessionId on SESSION_TOKEN_MISMATCH)
      // pass through the generic envelope. The type alias inherits this —
      // consumers can narrow on `code` and treat extras as `unknown`.
      const result = ServerErrorEnvelopeSchema.safeParse({
        type: 'error',
        message: 'mismatch',
        code: 'SESSION_TOKEN_MISMATCH',
        boundSessionId: 'sess-abc',
        actualAuthor: 'someone-else',
      })
      assert.ok(result.success)
      assert.equal(result.data.boundSessionId, 'sess-abc')
      assert.equal(result.data.actualAuthor, 'someone-else')
    })
  })

  describe('BYOK credential client messages (#4052)', () => {
    it('ByokGetCredentialsStatusSchema accepts type only', async () => {
      const { ByokGetCredentialsStatusSchema } = await import('../src/schemas/client.ts')
      assert.ok(ByokGetCredentialsStatusSchema.safeParse({ type: 'byok_get_credentials_status' }).success)
      assert.ok(ByokGetCredentialsStatusSchema.safeParse({ type: 'byok_get_credentials_status', requestId: 'r1' }).success)
    })

    it('ByokSetCredentialsSchema requires anthropicApiKey', async () => {
      const { ByokSetCredentialsSchema } = await import('../src/schemas/client.ts')
      assert.equal(ByokSetCredentialsSchema.safeParse({ type: 'byok_set_credentials' }).success, false)
      assert.equal(ByokSetCredentialsSchema.safeParse({ type: 'byok_set_credentials', anthropicApiKey: '' }).success, false)
      assert.ok(ByokSetCredentialsSchema.safeParse({ type: 'byok_set_credentials', anthropicApiKey: 'sk-ant-test' }).success)
    })

    it('ByokClearCredentialsSchema accepts type only', async () => {
      const { ByokClearCredentialsSchema } = await import('../src/schemas/client.ts')
      assert.ok(ByokClearCredentialsSchema.safeParse({ type: 'byok_clear_credentials' }).success)
    })
  })
})
