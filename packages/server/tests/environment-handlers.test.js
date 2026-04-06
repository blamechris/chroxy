import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { featureHandlers as environmentHandlers } from '../src/handlers/feature-handlers.js'
import { waitFor } from './test-helpers.js'

/**
 * Mock WebSocket that records sent messages.
 */
function createMockWs() {
  return { messages: [] }
}

/**
 * Mock client object.
 */
function createMockClient() {
  return { activeSessionId: null, subscribedSessionIds: new Set() }
}

/**
 * Mock context with configurable environmentManager.
 */
function createMockCtx({ environmentManager = null } = {}) {
  const sent = []
  const broadcasts = []
  return {
    send: (_ws, msg) => sent.push(msg),
    broadcast: (msg) => broadcasts.push(msg),
    environmentManager,
    _sent: sent,
    _broadcasts: broadcasts,
  }
}

/**
 * Minimal mock EnvironmentManager for handler tests.
 */
function createMockEnvManager({ environments = new Map() } = {}) {
  return {
    async create(opts) {
      const env = {
        id: 'env-test-123',
        name: opts.name,
        cwd: opts.cwd,
        status: 'running',
        image: opts.image || 'node:22-slim',
        containerId: 'mock-ctr',
        containerUser: 'chroxy',
        containerCliPath: '/usr/local/lib/cli.js',
        sessions: [],
        createdAt: new Date().toISOString(),
        memoryLimit: opts.memoryLimit || '2g',
        cpuLimit: opts.cpuLimit || '2',
      }
      environments.set(env.id, env)
      return env
    },
    async destroy(envId) {
      if (!environments.has(envId)) throw new Error(`Environment not found: ${envId}`)
      environments.delete(envId)
    },
    list() {
      return Array.from(environments.values())
    },
    get(envId) {
      return environments.get(envId) || null
    },
    getContainerInfo(envId) {
      const env = environments.get(envId)
      if (!env) throw new Error(`Environment not found: ${envId}`)
      return {
        containerId: env.containerId,
        containerUser: env.containerUser,
        containerCliPath: env.containerCliPath,
      }
    },
  }
}

describe('create_environment handler', () => {
  it('creates an environment and responds', async () => {
    const ws = createMockWs()
    const client = createMockClient()
    const envManager = createMockEnvManager()
    const ctx = createMockCtx({ environmentManager: envManager })

    const handler = environmentHandlers.create_environment
    handler(ws, client, { type: 'create_environment', name: 'test-env', cwd: process.cwd() }, ctx)

    // Handler is async (uses .then), wait for response
    await waitFor(() => ctx._sent.length >= 1, { label: 'environment_created response' })

    assert.equal(ctx._sent.length, 1)
    assert.equal(ctx._sent[0].type, 'environment_created')
    assert.equal(ctx._sent[0].name, 'test-env')
    assert.ok(ctx._sent[0].environmentId)

    // Should broadcast environment_list
    assert.equal(ctx._broadcasts.length, 1)
    assert.equal(ctx._broadcasts[0].type, 'environment_list')
  })

  it('rejects when name is missing', () => {
    const ws = createMockWs()
    const ctx = createMockCtx({ environmentManager: createMockEnvManager() })
    environmentHandlers.create_environment(ws, createMockClient(), { type: 'create_environment', cwd: process.cwd() }, ctx)
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('name'))
  })

  it('rejects when cwd is missing', () => {
    const ws = createMockWs()
    const ctx = createMockCtx({ environmentManager: createMockEnvManager() })
    environmentHandlers.create_environment(ws, createMockClient(), { type: 'create_environment', name: 'test' }, ctx)
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('cwd'))
  })

  it('rejects when environment management is not enabled', () => {
    const ws = createMockWs()
    const ctx = createMockCtx({ environmentManager: null })
    environmentHandlers.create_environment(ws, createMockClient(), { type: 'create_environment', name: 'test', cwd: process.cwd() }, ctx)
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('not enabled'))
  })
})

describe('list_environments handler', () => {
  it('returns the environment list', () => {
    const envManager = createMockEnvManager()
    const ctx = createMockCtx({ environmentManager: envManager })
    environmentHandlers.list_environments(createMockWs(), createMockClient(), { type: 'list_environments' }, ctx)
    assert.equal(ctx._sent[0].type, 'environment_list')
    assert.ok(Array.isArray(ctx._sent[0].environments))
  })

  it('returns empty list when environment management is not enabled', () => {
    const ctx = createMockCtx({ environmentManager: null })
    environmentHandlers.list_environments(createMockWs(), createMockClient(), { type: 'list_environments' }, ctx)
    assert.equal(ctx._sent[0].type, 'environment_list')
    assert.deepEqual(ctx._sent[0].environments, [])
  })
})

describe('destroy_environment handler', () => {
  it('destroys an environment and responds', async () => {
    const envs = new Map()
    envs.set('env-del', { id: 'env-del', name: 'del', status: 'running', containerId: 'ctr' })
    const envManager = createMockEnvManager({ environments: envs })
    const ctx = createMockCtx({ environmentManager: envManager })

    environmentHandlers.destroy_environment(
      createMockWs(), createMockClient(),
      { type: 'destroy_environment', environmentId: 'env-del' }, ctx
    )

    await waitFor(() => ctx._sent.length >= 1, { label: 'environment_destroyed response' })

    assert.equal(ctx._sent[0].type, 'environment_destroyed')
    assert.equal(ctx._sent[0].environmentId, 'env-del')
    assert.equal(ctx._broadcasts[0].type, 'environment_list')
  })

  it('rejects when environmentId is missing', () => {
    const ctx = createMockCtx({ environmentManager: createMockEnvManager() })
    environmentHandlers.destroy_environment(createMockWs(), createMockClient(), { type: 'destroy_environment' }, ctx)
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('environmentId'))
  })

  it('rejects for unknown environment', async () => {
    const ctx = createMockCtx({ environmentManager: createMockEnvManager() })
    environmentHandlers.destroy_environment(
      createMockWs(), createMockClient(),
      { type: 'destroy_environment', environmentId: 'env-nope' }, ctx
    )
    await waitFor(() => ctx._sent.length >= 1, { label: 'environment_error response' })
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('not found'))
  })
})

describe('get_environment handler', () => {
  it('returns environment info', () => {
    const envs = new Map()
    envs.set('env-info', { id: 'env-info', name: 'info', status: 'running' })
    const envManager = createMockEnvManager({ environments: envs })
    const ctx = createMockCtx({ environmentManager: envManager })

    environmentHandlers.get_environment(
      createMockWs(), createMockClient(),
      { type: 'get_environment', environmentId: 'env-info' }, ctx
    )

    assert.equal(ctx._sent[0].type, 'environment_info')
    assert.equal(ctx._sent[0].environment.name, 'info')
  })

  it('rejects for unknown environment', () => {
    const ctx = createMockCtx({ environmentManager: createMockEnvManager() })
    environmentHandlers.get_environment(
      createMockWs(), createMockClient(),
      { type: 'get_environment', environmentId: 'env-nope' }, ctx
    )
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('not found'))
  })

  it('rejects when environment management is not enabled', () => {
    const ctx = createMockCtx({ environmentManager: null })
    environmentHandlers.get_environment(
      createMockWs(), createMockClient(),
      { type: 'get_environment', environmentId: 'env-x' }, ctx
    )
    assert.equal(ctx._sent[0].type, 'environment_error')
    assert.ok(ctx._sent[0].error.includes('not enabled'))
  })
})
