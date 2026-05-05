import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { K8sBackend } from '../../../src/environments/backends/k8s.js'

// ─── Mock CoreV1Api factory ───────────────────────────────────────────────────

/**
 * Creates a mock CoreV1Api that records calls and returns configured results.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.createPod] - Override for `createNamespacedPod` call
 * @param {Function} [opts.deletePod] - Override for `deleteNamespacedPod` call
 * @param {Function} [opts.readPod]   - Override for `readNamespacedPod` (poll) call
 */
function createMockApi({ createPod, deletePod, readPod } = {}) {
  const calls = { create: [], delete: [], read: [] }

  const api = {
    createNamespacedPod: createPod
      ? async (args) => { calls.create.push(args); return createPod(args) }
      : async (args) => { calls.create.push(args); return {} },

    deleteNamespacedPod: deletePod
      ? async (args) => { calls.delete.push(args); return deletePod(args) }
      : async (args) => { calls.delete.push(args); return {} },

    readNamespacedPod: readPod
      ? async (args) => { calls.read.push(args); return readPod(args) }
      : async (args) => { calls.read.push(args); return {} },
  }

  api.calls = calls
  return api
}

// Mirrors the real `@kubernetes/client-node` `ApiException` shape: the HTTP
// status is exposed on `err.code` (not `err.statusCode`).
// See node_modules/@kubernetes/client-node/dist/gen/apis/exception.d.ts
function make404Error() {
  return Object.assign(new Error('Not Found'), { code: 404 })
}

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment()', () => {
  it('calls createNamespacedPod with correct Pod manifest', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    const result = await backend.createEnvironment({
      envId: 'env-test',
      image: 'node:22-slim',
    })

    assert.equal(result.containerId, 'chroxy-env-env-test')
    assert.ok(result.containerCliPath.includes('cli.js'))

    assert.equal(api.calls.create.length, 1)
    const { namespace, body } = api.calls.create[0]
    assert.equal(namespace, 'default')
    assert.equal(body.kind, 'Pod')
    assert.equal(body.metadata.name, 'chroxy-env-env-test')
    assert.equal(body.spec.containers[0].image, 'node:22-slim')
    assert.equal(body.spec.containers[0].command[0], 'sleep')
  })

  it('names the Pod chroxy-env-{envId}', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'abc123', image: 'node:22-slim' })

    const { body } = api.calls.create[0]
    assert.equal(body.metadata.name, 'chroxy-env-abc123')
  })

  it('uses constructor namespace by default', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ namespace: 'staging', _coreV1Api: api })

    await backend.createEnvironment({ envId: 'env-ns', image: 'node:22-slim' })

    assert.equal(api.calls.create[0].namespace, 'staging')
  })

  it('allows per-call namespace override', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ namespace: 'default', _coreV1Api: api })

    await backend.createEnvironment({ envId: 'env-ns', image: 'node:22-slim', namespace: 'production' })

    assert.equal(api.calls.create[0].namespace, 'production')
  })

  it('maps containerEnv to Pod env array', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'env-env',
      image: 'node:22-slim',
      containerEnv: { NODE_ENV: 'development', DEBUG: 'true' },
    })

    const { env } = api.calls.create[0].body.spec.containers[0]
    assert.ok(env.some(e => e.name === 'NODE_ENV' && e.value === 'development'))
    assert.ok(env.some(e => e.name === 'DEBUG' && e.value === 'true'))
  })

  it('sets chroxy management labels on the Pod', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'labeled', image: 'node:22-slim' })

    const { labels } = api.calls.create[0].body.metadata
    assert.equal(labels['app.kubernetes.io/managed-by'], 'chroxy')
    assert.equal(labels['chroxy-env-id'], 'labeled')
  })

  it('rejects when the API call fails', async () => {
    const api = createMockApi({
      createPod: async () => { throw new Error('API server unreachable') },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.rejects(
      () => backend.createEnvironment({ envId: 'fail', image: 'node:22-slim' }),
      /API server unreachable/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.destroyEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.destroyEnvironment()', () => {
  it('calls deleteNamespacedPod then polls until 404', async () => {
    let readCount = 0
    const api = createMockApi({
      readPod: async () => {
        readCount++
        if (readCount < 2) return {}      // Pod still exists first call
        throw make404Error()              // Gone on second call
      },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.destroyEnvironment('chroxy-env-env-del')

    assert.equal(api.calls.delete.length, 1)
    assert.equal(api.calls.delete[0].name, 'chroxy-env-env-del')
    assert.equal(api.calls.delete[0].namespace, 'default')
    assert.ok(readCount >= 1, 'should poll at least once')
  })

  it('resolves immediately (idempotent) when Pod is already gone on delete', async () => {
    const api = createMockApi({
      deletePod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    // Must not reject
    await assert.doesNotReject(() => backend.destroyEnvironment('already-gone'))
    // Should not have polled at all since delete returned 404
    assert.equal(api.calls.read.length, 0)
  })

  it('resolves even when delete API call fails with non-404 (best-effort)', async () => {
    const api = createMockApi({
      deletePod: async () => { throw new Error('internal server error') },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.doesNotReject(() => backend.destroyEnvironment('bad-ctr'))
  })

  it('uses constructor namespace by default', async () => {
    const api = createMockApi({
      readPod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ namespace: 'prod', _coreV1Api: api })

    await backend.destroyEnvironment('chroxy-env-x')

    assert.equal(api.calls.delete[0].namespace, 'prod')
  })

  it('allows per-call namespace override', async () => {
    const api = createMockApi({
      readPod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ namespace: 'default', _coreV1Api: api })

    await backend.destroyEnvironment('chroxy-env-x', { namespace: 'staging' })

    assert.equal(api.calls.delete[0].namespace, 'staging')
  })

  it('resolves when poll receives a non-404 error (best-effort)', async () => {
    const api = createMockApi({
      readPod: async () => { throw new Error('connection reset') },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.doesNotReject(() => backend.destroyEnvironment('flaky-pod'))
  })

  it('detects ApiException with code=404 on delete (real client-node shape)', async () => {
    // @kubernetes/client-node v1.x throws ApiException with `.code` (not `.statusCode`).
    // Regression guard for #3317.
    const api = createMockApi({
      deletePod: async () => {
        throw Object.assign(new Error('pods "ghost" not found'), { code: 404 })
      },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.doesNotReject(() => backend.destroyEnvironment('ghost'))
    // Idempotent 404 fast-path: no polling.
    assert.equal(api.calls.read.length, 0)
  })

  it('detects ApiException with code=404 during poll (real client-node shape)', async () => {
    // Verifies the poll-loop success signal also matches `err.code === 404`.
    // Regression guard for #3317.
    const api = createMockApi({
      readPod: async () => {
        throw Object.assign(new Error('pods "gone" not found'), { code: 404 })
      },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.destroyEnvironment('gone')

    // Single poll, then fast-path exit on 404.
    assert.equal(api.calls.read.length, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase-1 stub methods — must throw NotImplementedError
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend Phase-1 stubs', () => {
  function makeBackend() {
    return new K8sBackend({ _coreV1Api: createMockApi() })
  }

  const stubs = [
    ['createComposeEnvironment', b => b.createComposeEnvironment({})],
    ['destroyComposeEnvironment', b => b.destroyComposeEnvironment({})],
    ['removeImage', b => b.removeImage('tag')],
    ['execInEnvironment', b => b.execInEnvironment('id', { cmd: 'echo hi' })],
    ['getEnvironmentStatus', b => b.getEnvironmentStatus('id')],
    ['listEnvironments', b => b.listEnvironments()],
    ['commitEnvironment', b => b.commitEnvironment('id', 'tag')],
    ['renameEnvironment', b => b.renameEnvironment('id', 'new')],
    ['restoreEnvironment', b => b.restoreEnvironment({})],
  ]

  for (const [name, call] of stubs) {
    it(`${name}() rejects with NotImplementedError`, async () => {
      const backend = makeBackend()
      await assert.rejects(
        () => call(backend),
        err => {
          assert.equal(err.name, 'NotImplementedError', `expected NotImplementedError, got ${err.name}`)
          assert.ok(err.message.includes(name), `expected message to mention "${name}"`)
          return true
        }
      )
    })
  }
})
