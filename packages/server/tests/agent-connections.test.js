import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { AgentConnectionRegistry, validateAgentConnections } from '../src/agent-connections.js'
import { validateConfig } from '../src/config.js'
import { listProviders, registerProvider } from '../src/providers.js'
import { SessionManager } from '../src/session-manager.js'

class ConnectionFixtureSession extends EventEmitter {
  static agentConnectionRoutes = ['api', 'local']
  static agentConnectionCredentialKey = 'OPENAI_API_KEY'
  static capabilities = {}
  static resolveAuth() {
    return { ready: true, source: 'none', envVar: null, envVars: [], hint: '', detail: 'fixture' }
  }
  constructor(opts = {}) {
    super()
    this.model = opts.model || null
    this.permissionMode = opts.permissionMode || 'approve'
    this.resumeSessionId = null
    this.isRunning = false
  }
  start() {}
  destroy() {}
  sendMessage() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
}

const FIXTURE_RUNTIME = `connection-fixture-${process.pid}`
registerProvider(FIXTURE_RUNTIME, ConnectionFixtureSession)
const tempDir = mkdtempSync(join(tmpdir(), 'chroxy-agent-connections-'))
after(() => rmSync(tempDir, { recursive: true, force: true }))

function stateFile(name) {
  return join(tempDir, `${name}.json`)
}

const API_DEF = Object.freeze({
  id: 'fixture-api',
  label: 'Fixture API',
  provider: 'fixture',
  runtime: FIXTURE_RUNTIME,
  authRoute: 'api',
  credentialKey: 'OPENAI_API_KEY',
})

describe('AgentConnectionRegistry', () => {
  it('builds distinct native/API/local/imported outcomes without credential values in descriptors', () => {
    class CodexFixture {
      static agentConnectionRoutes = ['native', 'api']
      static agentConnectionCredentialKey = 'OPENAI_API_KEY'
    }
    class LocalFixture { static agentConnectionRoutes = ['local'] }
    const secret = 'sk-private-fixture-value'
    const registry = new AgentConnectionRegistry({
      definitions: [
        { id: 'codex-native', label: 'Codex subscription', provider: 'openai', runtime: 'codex', authRoute: 'native' },
        { id: 'codex-api', label: 'Codex API', provider: 'openai', runtime: 'codex', authRoute: 'api' },
        { id: 'local', label: 'Local', provider: 'local', runtime: 'ollama', authRoute: 'local' },
        { id: 'imported', label: 'Imported', provider: 'acp', runtime: 'acp-fixture', authRoute: 'imported' },
      ],
      getProvider: (id) => id === 'codex' ? CodexFixture : id === 'ollama' ? LocalFixture : class {},
      buildSpawnEnvFn: () => ({ OPENAI_API_KEY: secret, OPENAI_BASE_URL: 'https://api.example.test', PATH: '/bin' }),
      resolveCredentialFn: () => ({ value: secret, source: 'store' }),
      now: () => new Date('2026-09-13T00:00:00.000Z'),
    })
    const listed = registry.list()
    assert.equal(listed.find((c) => c.id === 'codex-native').readiness.state, 'unknown')
    assert.equal(listed.find((c) => c.id === 'codex-api').entitlement.route, 'api')
    assert.equal(listed.find((c) => c.id === 'local').execution.inference, 'local')
    assert.equal(listed.find((c) => c.id === 'local').readiness.reasonCode, 'LOCAL_SERVICE_UNVERIFIED')
    assert.equal(listed.find((c) => c.id === 'imported').readiness.reasonCode, 'IMPORTED_AUTH_UNSUPPORTED')
    assert.equal(JSON.stringify(listed).includes(secret), false)
  })

  it('isolates concurrent Codex child environments without mutating process.env', () => {
    class CodexFixture {
      static agentConnectionRoutes = ['native', 'api']
      static agentConnectionCredentialKey = 'OPENAI_API_KEY'
    }
    const original = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'ambient-key'
    try {
      const registry = new AgentConnectionRegistry({
        definitions: [
          { id: 'native', label: 'Native', runtime: 'codex', authRoute: 'native' },
          { id: 'api', label: 'API', runtime: 'codex', authRoute: 'api' },
        ],
        getProvider: () => CodexFixture,
        buildSpawnEnvFn: () => ({ OPENAI_API_KEY: 'stored-key', OPENAI_BASE_URL: 'https://api.example.test', PATH: '/bin' }),
        resolveCredentialFn: () => ({ value: 'stored-key', source: 'store' }),
      })
      const native = registry.resolve('native')
      const api = registry.resolve('api')
      assert.equal(native.childEnv.OPENAI_API_KEY, undefined)
      assert.equal(native.childEnv.OPENAI_BASE_URL, undefined)
      assert.equal(api.childEnv.OPENAI_API_KEY, 'stored-key')
      assert.equal(process.env.OPENAI_API_KEY, 'ambient-key')
      native.childEnv.PATH = 'changed'
      assert.equal(api.childEnv.PATH, '/bin')
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original
    }
  })

  it('blocks a missing Claude native login without consulting API credentials', () => {
    class ClaudeFixture {
      static agentConnectionRoutes = ['native']
      static resolvedBinary = '/fixture/claude'
    }
    const registry = new AgentConnectionRegistry({
      definitions: [
        { id: 'claude-native', label: 'Claude subscription', runtime: 'claude-tui', authRoute: 'native' },
      ],
      getProvider: () => ClaudeFixture,
      buildSpawnEnvFn: () => ({ PATH: '/bin' }),
      resolveCredentialFn: () => { throw new Error('native routing must not query API credentials') },
      spawnSyncFn: (_binary, args, opts) => {
        assert.deepEqual(args, ['auth', 'status', '--json'])
        assert.equal(opts.env.ANTHROPIC_API_KEY, undefined)
        return { status: 1, stdout: '' }
      },
    })
    const listed = registry.list()[0]
    assert.equal(listed.readiness.reasonCode, 'NATIVE_LOGIN_REQUIRED')
    assert.match(listed.readiness.recoveryAction, /claude auth login/)
    assert.throws(() => registry.resolve('claude-native'), (err) => err.code === 'NATIVE_LOGIN_REQUIRED')
  })

  it('uses the same isolated environment for Claude native status and the session child', () => {
    class ClaudeFixture {
      static agentConnectionRoutes = ['native']
      static resolvedBinary = '/fixture/claude'
    }
    const alternateRouteEnv = {
      ANTHROPIC_API_KEY: 'fixture-api-key',
      ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_UNIX_SOCKET: '/tmp/anthropic.sock',
      ANTHROPIC_PROFILE: 'bedrock-profile',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '9',
      CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token',
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '10',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
    }
    const registry = new AgentConnectionRegistry({
      definitions: [
        { id: 'claude-native', label: 'Claude subscription', runtime: 'claude-tui', authRoute: 'native' },
      ],
      getProvider: () => ClaudeFixture,
      buildSpawnEnvFn: () => ({ ...alternateRouteEnv, PATH: '/bin', SAFE_TOOL_ENV: 'preserved' }),
      spawnSyncFn: (_binary, _args, opts) => {
        for (const key of Object.keys(alternateRouteEnv)) {
          assert.equal(opts.env[key], undefined, `${key} must not influence the native status probe`)
        }
        assert.equal(opts.env.SAFE_TOOL_ENV, 'preserved')
        return {
          status: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        }
      },
    })

    const resolved = registry.resolve('claude-native')
    assert.equal(resolved.descriptor.readiness.state, 'ready')
    for (const key of Object.keys(alternateRouteEnv)) {
      assert.equal(resolved.childEnv[key], undefined, `${key} must not reach the native session child`)
    }
    assert.equal(resolved.childEnv.SAFE_TOOL_ENV, 'preserved')
  })

  it('fails closed when Claude reports a non-Claude.ai or unverifiable native auth route', () => {
    class ClaudeFixture {
      static agentConnectionRoutes = ['native']
      static resolvedBinary = '/fixture/claude'
    }
    const statuses = [
      { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
      { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: '/login managed key' },
      { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' },
      { loggedIn: true },
    ]

    for (const status of statuses) {
      const registry = new AgentConnectionRegistry({
        definitions: [
          { id: 'claude-native', label: 'Claude subscription', runtime: 'claude-tui', authRoute: 'native' },
        ],
        getProvider: () => ClaudeFixture,
        buildSpawnEnvFn: () => ({ PATH: '/bin' }),
        spawnSyncFn: () => ({ status: 0, stdout: JSON.stringify(status) }),
      })
      const descriptor = registry.list()[0]
      assert.equal(descriptor.readiness.state, 'blocked')
      assert.equal(descriptor.readiness.reasonCode, 'NATIVE_AUTH_ROUTE_MISMATCH')
      assert.throws(() => registry.resolve('claude-native'), (err) => err.code === 'NATIVE_AUTH_ROUTE_MISMATCH')
    }

    const malformed = new AgentConnectionRegistry({
      definitions: [
        { id: 'claude-native', label: 'Claude subscription', runtime: 'claude-tui', authRoute: 'native' },
      ],
      getProvider: () => ClaudeFixture,
      buildSpawnEnvFn: () => ({ PATH: '/bin' }),
      spawnSyncFn: () => ({ status: 0, stdout: '{not-json' }),
    }).list()[0]
    assert.equal(malformed.readiness.state, 'blocked')
    assert.equal(malformed.readiness.reasonCode, 'NATIVE_AUTH_STATUS_UNVERIFIED')
  })

  it('rejects duplicate ids and secret-shaped inline config', () => {
    const warnings = []
    const rows = validateAgentConnections([
      API_DEF,
      { ...API_DEF, label: 'duplicate' },
      { id: 'secret', label: 'bad', runtime: 'codex', authRoute: 'api', apiKey: 'sk-nope' },
    ], warnings)
    assert.equal(rows.length, 1)
    assert.ok(warnings.some((w) => w.includes('duplicate connection id')))
    assert.ok(warnings.some((w) => w.includes('inline credentials are forbidden')))
  })

  it('runs connection validation through the daemon config boundary', () => {
    const valid = validateConfig({ agentConnections: [API_DEF] })
    assert.equal(valid.warnings.filter((warning) => warning.includes('agentConnections')).length, 0)
    const invalid = validateConfig({
      agentConnections: [{ id: 'bad', label: 'Bad', runtime: 'codex', authRoute: 'native', token: 'forbidden' }],
    })
    assert.ok(invalid.warnings.some((warning) => warning.includes('inline credentials are forbidden')))
  })

  it('attaches configured descriptors to the existing provider roster', () => {
    const row = listProviders({ agentConnections: [API_DEF] })
      .find((provider) => provider.name === FIXTURE_RUNTIME)
    assert.equal(row.connections.length, 1)
    assert.equal(row.connections[0].id, API_DEF.id)
    assert.equal(row.connections[0].runtime.id, FIXTURE_RUNTIME)
  })

  it('requires each runtime adapter to declare route isolation itself', () => {
    class DeclaredAdapter {
      static agentConnectionRoutes = ['api']
      static agentConnectionCredentialKey = 'OPENAI_API_KEY'
    }
    class UndeclaredSubclass extends DeclaredAdapter {}
    const registry = new AgentConnectionRegistry({
      definitions: [{ id: 'inherited', label: 'Inherited route', runtime: 'derived', authRoute: 'api' }],
      getProvider: () => UndeclaredSubclass,
      resolveCredentialFn: () => ({ value: 'fixture-secret', source: 'store' }),
    })
    const descriptor = registry.list()[0]
    assert.equal(descriptor.readiness.state, 'unsupported')
    assert.equal(descriptor.readiness.reasonCode, 'AUTH_ROUTE_UNSUPPORTED')
  })

  it('rejects API credential references the runtime cannot apply', () => {
    class CodexFixture {
      static agentConnectionRoutes = ['api']
      static agentConnectionCredentialKey = 'OPENAI_API_KEY'
    }
    const registry = new AgentConnectionRegistry({
      definitions: [{ id: 'wrong-key', label: 'Wrong key', runtime: 'codex', authRoute: 'api', credentialKey: 'OTHER_KEY' }],
      getProvider: () => CodexFixture,
      resolveCredentialFn: () => ({ value: 'fixture-secret', source: 'store' }),
    })
    const descriptor = registry.list()[0]
    assert.equal(descriptor.readiness.state, 'unsupported')
    assert.equal(descriptor.readiness.reasonCode, 'CREDENTIAL_REFERENCE_UNSUPPORTED')
  })
})

describe('SessionManager explicit connection create/restore', () => {
  function manager(file, definitions = [API_DEF]) {
    return new SessionManager({
      skipPreflight: true,
      maxSessions: 5,
      defaultCwd: '/tmp',
      stateFilePath: file,
      agentConnections: definitions,
      agentConnectionDeps: {
        resolveCredentialFn: () => ({ value: 'fixture-secret', source: 'store' }),
      },
    })
  }

  it('persists and restores the exact selected connection snapshot', () => {
    const file = stateFile('restore-ok')
    const first = manager(file)
    const id = first.createSession({ name: 'one', provider: FIXTURE_RUNTIME, connectionId: API_DEF.id })
    const created = first.listSessions().find((s) => s.sessionId === id)
    assert.equal(created.agentConnection.id, API_DEF.id)
    assert.equal(created.agentConnection.entitlement.route, 'api')
    const persisted = first.serializeState().sessions[0]
    assert.equal(persisted.agentConnection.runtime.id, FIXTURE_RUNTIME)
    assert.equal(JSON.stringify(persisted).includes('fixture-secret'), false)
    const second = manager(file)
    second.restoreState()
    assert.equal(second.listSessions()[0].agentConnection.id, API_DEF.id)
    second.destroyAll()
  })

  it('parks a restore when its connection was removed instead of substituting the provider default', () => {
    const file = stateFile('restore-removed')
    const first = manager(file)
    first.createSession({ name: 'one', provider: FIXTURE_RUNTIME, connectionId: API_DEF.id })
    const second = manager(file, [])
    second.restoreState()
    assert.equal(second.listSessions().length, 0)
    const failed = second.getFailedRestores()
    assert.equal(failed.length, 1)
    assert.equal(failed[0].errorCode, 'AGENT_CONNECTION_NOT_FOUND')
    assert.equal(failed[0].agentConnection.id, API_DEF.id)
    second.destroyAll()
  })

  it('rejects a mismatched explicit provider/runtime before construction', () => {
    const mgr = manager(stateFile('mismatch'))
    assert.throws(
      () => mgr.createSession({ provider: 'claude-tui', connectionId: API_DEF.id }),
      (err) => err.code === 'AGENT_CONNECTION_RUNTIME_MISMATCH',
    )
    assert.equal(mgr.listSessions().length, 0)
    mgr.destroyAll()
  })
})
