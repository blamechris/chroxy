import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { K8sBackend } from '../../../src/environments/backends/k8s.js'

// ─── Mock CoreV1Api factory ───────────────────────────────────────────────────

/**
 * Creates a mock CoreV1Api that records calls and returns configured results.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.createPod]    - Override for `createNamespacedPod` call
 * @param {Function} [opts.deletePod]    - Override for `deleteNamespacedPod` call
 * @param {Function} [opts.readPod]      - Override for `readNamespacedPod` (poll) call
 * @param {Function} [opts.createSecret] - Override for `createNamespacedSecret` call
 * @param {Function} [opts.deleteSecret] - Override for `deleteNamespacedSecret` call
 */
function createMockApi({ createPod, deletePod, readPod, createSecret, deleteSecret } = {}) {
  const calls = { create: [], delete: [], read: [], createSecret: [], deleteSecret: [] }

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

    createNamespacedSecret: createSecret
      ? async (args) => { calls.createSecret.push(args); return createSecret(args) }
      : async (args) => { calls.createSecret.push(args); return {} },

    deleteNamespacedSecret: deleteSecret
      ? async (args) => { calls.deleteSecret.push(args); return deleteSecret(args) }
      : async (args) => { calls.deleteSecret.push(args); return {} },
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

// ─── Fake WS factory ─────────────────────────────────────────────────────────

/**
 * Creates a controllable fake WS + a controller object.
 * controller.receive(raw)    — simulate incoming message from agent
 * controller.triggerError(e) — simulate WS error
 * controller.triggerClose(code) — simulate WS close
 */
function createFakeWs() {
  const emitter = new EventEmitter()
  const sent = []

  const ws = {
    readyState: 1, // OPEN
    send: (data) => { sent.push(data) },
    close: () => { emitter.emit('close', 1000, '') },
    once: (ev, fn) => emitter.once(ev, fn),
    on: (ev, fn) => emitter.on(ev, fn),
  }

  ws.sent = sent

  const controller = {
    receive: (raw) => emitter.emit('message', raw),
    triggerError: (err) => emitter.emit('error', err),
    triggerClose: (code = 1006) => emitter.emit('close', code, ''),
  }

  return { ws, controller }
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
      image: 'chroxy-pod-agent:latest',
    })

    assert.equal(result.containerId, 'chroxy-env-env-test')
    assert.ok(result.containerCliPath.includes('cli.js'))
    assert.ok(typeof result.agentToken === 'string' && result.agentToken.length > 0,
      'should return agentToken')
    assert.ok(result.secretName, 'should return secretName')

    assert.equal(api.calls.create.length, 1)
    const { namespace, body } = api.calls.create[0]
    assert.equal(namespace, 'default')
    assert.equal(body.kind, 'Pod')
    assert.equal(body.metadata.name, 'chroxy-env-env-test')
    assert.equal(body.spec.containers[0].image, 'chroxy-pod-agent:latest')
  })

  it('names the Pod chroxy-env-{envId}', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'abc123', image: 'agent:latest' })

    const { body } = api.calls.create[0]
    assert.equal(body.metadata.name, 'chroxy-env-abc123')
  })

  it('creates a Secret before the Pod', async () => {
    const callOrder = []

    const api = createMockApi({
      createSecret: async () => { callOrder.push('secret'); return {} },
      createPod: async () => { callOrder.push('pod'); return {} },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'order-test', image: 'agent:latest' })

    assert.equal(callOrder[0], 'secret', 'Secret must be created before Pod')
    assert.equal(callOrder[1], 'pod')
  })

  it('Secret is named chroxy-token-{envId}', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    const result = await backend.createEnvironment({ envId: 'tok-test', image: 'agent:latest' })

    assert.equal(result.secretName, 'chroxy-token-tok-test')
    assert.equal(api.calls.createSecret[0].body.metadata.name, 'chroxy-token-tok-test')
  })

  it('Secret contains CHROXY_AGENT_TOKEN in stringData', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    const result = await backend.createEnvironment({ envId: 'secret-data', image: 'agent:latest' })

    const secretBody = api.calls.createSecret[0].body
    assert.equal(secretBody.stringData.CHROXY_AGENT_TOKEN, result.agentToken)
  })

  it('Pod mounts token via secretKeyRef', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'secret-ref', image: 'agent:latest' })

    const podEnv = api.calls.create[0].body.spec.containers[0].env
    const tokenEnv = podEnv.find(e => e.name === 'CHROXY_AGENT_TOKEN')
    assert.ok(tokenEnv, 'Pod env must include CHROXY_AGENT_TOKEN entry')
    assert.ok(tokenEnv.valueFrom?.secretKeyRef, 'must reference Secret via secretKeyRef')
    assert.equal(tokenEnv.valueFrom.secretKeyRef.name, 'chroxy-token-secret-ref')
    assert.equal(tokenEnv.valueFrom.secretKeyRef.key, 'CHROXY_AGENT_TOKEN')
  })

  it('Pod has liveness and readiness probes pointing at /healthz', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'probes', image: 'agent:latest' })

    const container = api.calls.create[0].body.spec.containers[0]
    assert.ok(container.livenessProbe?.httpGet?.path === '/healthz', 'livenessProbe required')
    assert.ok(container.readinessProbe?.httpGet?.path === '/healthz', 'readinessProbe required')
  })

  it('uses constructor namespace by default', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ namespace: 'staging', _coreV1Api: api })

    await backend.createEnvironment({ envId: 'env-ns', image: 'agent:latest' })

    assert.equal(api.calls.create[0].namespace, 'staging')
    assert.equal(api.calls.createSecret[0].namespace, 'staging')
  })

  it('allows per-call namespace override', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ namespace: 'default', _coreV1Api: api })

    await backend.createEnvironment({ envId: 'env-ns', image: 'agent:latest', namespace: 'production' })

    assert.equal(api.calls.create[0].namespace, 'production')
    assert.equal(api.calls.createSecret[0].namespace, 'production')
  })

  it('maps containerEnv to Pod env array (alongside the secretKeyRef entry)', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'env-env',
      image: 'agent:latest',
      containerEnv: { NODE_ENV: 'development', DEBUG: 'true' },
    })

    const { env } = api.calls.create[0].body.spec.containers[0]
    assert.ok(env.some(e => e.name === 'NODE_ENV' && e.value === 'development'))
    assert.ok(env.some(e => e.name === 'DEBUG' && e.value === 'true'))
  })

  it('sets chroxy management labels on the Pod', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'labeled', image: 'agent:latest' })

    const { labels } = api.calls.create[0].body.metadata
    assert.equal(labels['app.kubernetes.io/managed-by'], 'chroxy')
    assert.equal(labels['chroxy-env-id'], 'labeled')
  })

  it('deletes the Secret and re-throws when Pod creation fails', async () => {
    const api = createMockApi({
      createPod: async () => { throw new Error('Pod quota exceeded') },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.rejects(
      () => backend.createEnvironment({ envId: 'fail', image: 'agent:latest' }),
      /Pod quota exceeded/
    )

    assert.equal(api.calls.deleteSecret.length, 1, 'Secret must be cleaned up on Pod failure')
  })

  it('returns a unique agentToken each call', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    const r1 = await backend.createEnvironment({ envId: 'tok-a', image: 'agent:latest' })
    const r2 = await backend.createEnvironment({ envId: 'tok-b', image: 'agent:latest' })

    assert.notEqual(r1.agentToken, r2.agentToken, 'tokens must be unique per environment')
  })

  it('rejects when the API call fails', async () => {
    const api = createMockApi({
      createSecret: async () => { throw new Error('API server unreachable') },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.rejects(
      () => backend.createEnvironment({ envId: 'fail', image: 'agent:latest' }),
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

  it('deletes the Secret alongside the Pod', async () => {
    const api = createMockApi({
      readPod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.destroyEnvironment('chroxy-env-x', { secretName: 'chroxy-token-x' })

    assert.equal(api.calls.deleteSecret.length, 1)
    assert.equal(api.calls.deleteSecret[0].name, 'chroxy-token-x')
  })

  it('deletes Secret even when Pod was already gone', async () => {
    const api = createMockApi({
      deletePod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.destroyEnvironment('already-gone', { secretName: 'chroxy-token-x' })

    assert.equal(api.calls.deleteSecret.length, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.getEnvironmentStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.getEnvironmentStatus()', () => {
  it('returns true when Pod phase is Running', async () => {
    const api = createMockApi({
      readPod: async () => ({ status: { phase: 'Running' } }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const running = await backend.getEnvironmentStatus('my-pod')
    assert.equal(running, true)
  })

  it('returns false when Pod phase is Pending', async () => {
    const api = createMockApi({
      readPod: async () => ({ status: { phase: 'Pending' } }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const running = await backend.getEnvironmentStatus('my-pod')
    assert.equal(running, false)
  })

  it('returns false when Pod phase is Succeeded', async () => {
    const api = createMockApi({
      readPod: async () => ({ status: { phase: 'Succeeded' } }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const running = await backend.getEnvironmentStatus('my-pod')
    assert.equal(running, false)
  })

  it('returns false when Pod phase is Failed', async () => {
    const api = createMockApi({
      readPod: async () => ({ status: { phase: 'Failed' } }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const running = await backend.getEnvironmentStatus('my-pod')
    assert.equal(running, false)
  })

  it('throws when the Pod does not exist', async () => {
    const api = createMockApi({
      readPod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.rejects(
      () => backend.getEnvironmentStatus('missing-pod'),
      { code: 404 }
    )
  })

  it('uses namespace override', async () => {
    const api = createMockApi({
      readPod: async (args) => {
        assert.equal(args.namespace, 'prod')
        return { status: { phase: 'Running' } }
      },
    })
    const backend = new K8sBackend({ namespace: 'default', _coreV1Api: api })

    await backend.getEnvironmentStatus('pod-x', { namespace: 'prod' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.streamCliInEnvironment — WS bridge
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.streamCliInEnvironment()', () => {
  /**
   * Build a backend with a fake dial function that returns a controllable WS.
   */
  function makeBackendWithFakeWs() {
    const { ws, controller } = createFakeWs()
    const api = createMockApi()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: (_url, _token) => Promise.resolve(ws),
    })
    return { backend, ws, controller }
  }

  it('returns a handle with stdout, stderr, stdin streams', () => {
    const { backend } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: ['cli.js'], agentToken: 'tok',
    })

    assert.ok(proc.stdout, 'stdout must be present')
    assert.ok(proc.stderr, 'stderr must be present')
    assert.ok(proc.stdin, 'stdin must be present')
    // Verify stream API
    assert.equal(typeof proc.stdout.on, 'function')
    assert.equal(typeof proc.stderr.on, 'function')
  })

  it('sends a spawn frame over WS after connection opens', async () => {
    const { backend, ws } = makeBackendWithFakeWs()

    backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: ['cli.js', '-p'], env: { CLAUDE_HEADLESS: '1' }, cwd: '/workspace',
      agentToken: 'tok',
    })

    // Wait for the async dial + spawn
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(ws.sent.length, 1, 'should send exactly one frame')
    const frame = JSON.parse(ws.sent[0])
    assert.equal(frame.type, 'spawn')
    assert.equal(frame.cmd, 'node')
    assert.deepEqual(frame.args, ['cli.js', '-p'])
    assert.deepEqual(frame.env, { CLAUDE_HEADLESS: '1' })
    assert.equal(frame.cwd, '/workspace')
  })

  it('pushes NDJSON line to stdout on event frame', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(d.toString()))

    controller.receive(JSON.stringify({
      type: 'event',
      payload: { type: 'assistant', message: { role: 'assistant', content: [] } },
    }))

    assert.ok(chunks.length > 0, 'stdout should have received data')
    const line = chunks.join('')
    assert.ok(line.includes('"assistant"'), 'stdout data should be serialized JSON')
    assert.ok(line.endsWith('\n'), 'stdout line should end with newline')
  })

  it('pushes raw string payload directly to stdout on event frame', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(d.toString()))

    controller.receive(JSON.stringify({ type: 'event', payload: 'raw output line' }))

    assert.ok(chunks.join('').includes('raw output line'))
  })

  it('pushes data to stderr on stderr frame', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const errChunks = []
    proc.stderr.on('data', (d) => errChunks.push(d.toString()))

    controller.receive(JSON.stringify({ type: 'stderr', data: 'warn: something\n' }))

    assert.equal(errChunks.join(''), 'warn: something\n')
  })

  it('emits exit event with exit code on exit frame', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    controller.receive(JSON.stringify({ type: 'exit', code: 0 }))

    assert.deepEqual(exitCodes, [0])
  })

  it('emits exit(-1) on WS error', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    controller.triggerError(new Error('ECONNRESET'))

    assert.deepEqual(exitCodes, [-1])
  })

  it('emits exit(-1) on unexpected WS close', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    controller.triggerClose(1006)

    assert.deepEqual(exitCodes, [-1])
  })

  it('emits exit(-1) when dial fails', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.reject(new Error('connection refused')),
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(exitCodes, [-1])
  })

  it('throws synchronously when agentToken is missing', () => {
    const { backend } = makeBackendWithFakeWs()

    assert.throws(
      () => backend.streamCliInEnvironment('pod-x', { cmd: 'node', args: [] }),
      /agentToken is required/
    )
  })

  it('kills by closing WS when abort signal fires', async () => {
    let wsClosed = false
    const { ws } = createFakeWs()
    ws.close = () => { wsClosed = true }

    const api = createMockApi()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(ws),
    })

    const ac = new AbortController()
    backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok', signal: ac.signal,
    })

    await new Promise(resolve => setImmediate(resolve))

    ac.abort()

    assert.ok(wsClosed, 'WS should be closed when abort signal fires')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.execInEnvironment — wrapper over streamCliInEnvironment
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.execInEnvironment()', () => {
  function makeBackendCapturing() {
    let capturedOpts = null
    const { ws, controller } = createFakeWs()
    const api = createMockApi()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(ws),
    })
    return { backend, ws, controller, getCapturedOpts: () => capturedOpts }
  }

  it('returns { stdout, stderr } aggregated from streaming output', async () => {
    const { backend, controller } = makeBackendCapturing()

    const execPromise = backend.execInEnvironment('pod-x', {
      cmd: 'echo', args: ['hello'], agentToken: 'tok',
    })

    // Wait for dial + spawn frame to be sent
    await new Promise(resolve => setImmediate(resolve))

    controller.receive(JSON.stringify({ type: 'event', payload: 'hello\n' }))
    controller.receive(JSON.stringify({ type: 'stderr', data: 'warning\n' }))
    controller.receive(JSON.stringify({ type: 'exit', code: 0 }))

    const result = await execPromise
    assert.ok(result.stdout.includes('hello'), 'stdout should contain output')
    assert.ok(result.stderr.includes('warning'), 'stderr should contain errors')
  })

  it('rejects on non-zero exit code', async () => {
    const { backend, controller } = makeBackendCapturing()

    const execPromise = backend.execInEnvironment('pod-x', {
      cmd: 'false', args: [], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    controller.receive(JSON.stringify({ type: 'stderr', data: 'command failed\n' }))
    controller.receive(JSON.stringify({ type: 'exit', code: 1 }))

    await assert.rejects(execPromise, /command failed/)
  })

  it('rejects when agentToken is missing', async () => {
    const { backend } = makeBackendCapturing()

    await assert.rejects(
      () => backend.execInEnvironment('pod-x', { cmd: 'echo', args: [] }),
      /agentToken is required/
    )
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
