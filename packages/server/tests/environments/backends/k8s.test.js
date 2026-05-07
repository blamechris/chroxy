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
function createMockApi({ createPod, deletePod, readPod, createSecret, deleteSecret, readSecret } = {}) {
  const calls = { create: [], delete: [], read: [], createSecret: [], deleteSecret: [], readSecret: [] }

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

    readNamespacedSecret: readSecret
      ? async (args) => { calls.readSecret.push(args); return readSecret(args) }
      : async (args) => { calls.readSecret.push(args); return {} },
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
// Fake-clock helpers (used by reconnect-loop and kill-semantics tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal hand-rolled fake clock.
 *
 * Returns { setTimeout, clearTimeout, tick } where:
 *   - setTimeout(fn, _delay) queues fn (delay is ignored — all timers are
 *     considered immediately due).  Returns an opaque handle.
 *   - clearTimeout(handle) cancels a pending callback.
 *   - tick() fires every pending callback in FIFO order then returns.
 *
 * Because the reconnect callback is asynchronous (it calls proc._redial()
 * which returns a Promise) the caller must follow tick() with a
 * setImmediate yield so the promise chain can resolve before any assertions.
 * The tickAndFlush() helper below packages that pair.
 */
function createFakeClock() {
  const pending = new Map()
  let nextId = 1

  const fakeSetTimeout = (fn) => {
    const id = nextId++
    pending.set(id, fn)
    return id
  }

  const fakeClearTimeout = (id) => {
    pending.delete(id)
  }

  const tick = () => {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const fn of callbacks) fn()
  }

  return { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, tick }
}

/**
 * Fire all pending fake-clock callbacks then yield one event-loop tick so
 * any promise continuations scheduled inside those callbacks can resolve.
 */
async function tickAndFlush(clock) {
  clock.tick()
  await new Promise(r => setImmediate(r))
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

  it('omits imagePullPolicy from the Pod spec when not configured', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'no-policy', image: 'agent:latest' })

    const container = api.calls.create[0].body.spec.containers[0]
    assert.equal(
      Object.prototype.hasOwnProperty.call(container, 'imagePullPolicy'),
      false,
      'imagePullPolicy must not be present when unspecified (let K8s apply its own default)'
    )
  })

  it('sets imagePullPolicy on the container when specified via constructor', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api, imagePullPolicy: 'IfNotPresent' })

    await backend.createEnvironment({ envId: 'ctor-policy', image: 'agent:latest' })

    const container = api.calls.create[0].body.spec.containers[0]
    assert.equal(container.imagePullPolicy, 'IfNotPresent')
  })

  it('sets imagePullPolicy on the container when specified via per-call opt', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'call-policy',
      image: 'agent:latest',
      imagePullPolicy: 'Never',
    })

    const container = api.calls.create[0].body.spec.containers[0]
    assert.equal(container.imagePullPolicy, 'Never')
  })

  it('per-call imagePullPolicy overrides the constructor-level option', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api, imagePullPolicy: 'Always' })

    await backend.createEnvironment({
      envId: 'override-policy',
      image: 'agent:latest',
      imagePullPolicy: 'IfNotPresent',
    })

    const container = api.calls.create[0].body.spec.containers[0]
    assert.equal(container.imagePullPolicy, 'IfNotPresent',
      'per-call option must take precedence over constructor option')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment — workspace mount (#3316)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment() — workspace mount (#3316)', () => {
  it('mounts opts.cwd as a hostPath volume named "workspace" at /workspace', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'ws-test',
      image: 'agent:latest',
      cwd: '/home/user/myproject',
    })

    const { body } = api.calls.create[0]
    const volumes = body.spec.volumes
    const mounts = body.spec.containers[0].volumeMounts

    assert.ok(Array.isArray(volumes), 'spec.volumes must be an array')
    const wsVol = volumes.find(v => v.name === 'workspace')
    assert.ok(wsVol, 'must have a volume named "workspace"')
    assert.equal(wsVol.hostPath.path, '/home/user/myproject', 'hostPath.path must be opts.cwd')
    assert.equal(wsVol.hostPath.type, 'DirectoryOrCreate')

    assert.ok(Array.isArray(mounts), 'container.volumeMounts must be an array')
    const wsMount = mounts.find(m => m.name === 'workspace')
    assert.ok(wsMount, 'volumeMounts must include the workspace volume')
    assert.equal(wsMount.mountPath, '/workspace')
  })

  it('omits volumes and volumeMounts when opts.cwd is not provided', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'no-cwd', image: 'agent:latest' })

    const { body } = api.calls.create[0]
    assert.equal(body.spec.volumes, undefined, 'spec.volumes must be absent when no cwd')
    assert.equal(
      body.spec.containers[0].volumeMounts, undefined,
      'volumeMounts must be absent when no cwd'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment — resource limits (#3316)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment() — resource limits (#3316)', () => {
  it('sets resources.limits and resources.requests when memoryLimit is provided', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'mem-only',
      image: 'agent:latest',
      memoryLimit: '2Gi',
    })

    const { resources } = api.calls.create[0].body.spec.containers[0]
    assert.ok(resources, 'container.resources must be present')
    assert.equal(resources.limits.memory, '2Gi')
    assert.equal(resources.requests.memory, '2Gi')
    assert.equal(resources.limits.cpu, undefined, 'cpu must not be set when cpuLimit is absent')
  })

  it('sets resources.limits and resources.requests when cpuLimit is provided', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'cpu-only',
      image: 'agent:latest',
      cpuLimit: '2',
    })

    const { resources } = api.calls.create[0].body.spec.containers[0]
    assert.ok(resources, 'container.resources must be present')
    assert.equal(resources.limits.cpu, '2')
    assert.equal(resources.requests.cpu, '2')
    assert.equal(resources.limits.memory, undefined, 'memory must not be set when memoryLimit is absent')
  })

  it('sets both memory and cpu limits when both are provided', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'both-limits',
      image: 'agent:latest',
      memoryLimit: '512Mi',
      cpuLimit: '0.5',
    })

    const { resources } = api.calls.create[0].body.spec.containers[0]
    assert.equal(resources.limits.memory, '512Mi')
    assert.equal(resources.limits.cpu, '0.5')
    assert.equal(resources.requests.memory, '512Mi')
    assert.equal(resources.requests.cpu, '0.5')
  })

  it('normalises Docker-style memory suffix "g" to "Gi"', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'mem-g',
      image: 'agent:latest',
      memoryLimit: '2g',
    })

    const { resources } = api.calls.create[0].body.spec.containers[0]
    assert.equal(resources.limits.memory, '2Gi', '"2g" must be normalised to "2Gi"')
  })

  it('normalises Docker-style memory suffix "m" to "Mi"', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'mem-m',
      image: 'agent:latest',
      memoryLimit: '512m',
    })

    const { resources } = api.calls.create[0].body.spec.containers[0]
    assert.equal(resources.limits.memory, '512Mi', '"512m" must be normalised to "512Mi"')
  })

  it('omits container.resources when neither memoryLimit nor cpuLimit is provided', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'no-limits', image: 'agent:latest' })

    const container = api.calls.create[0].body.spec.containers[0]
    assert.equal(container.resources, undefined, 'resources must be absent when no limits are set')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment — additional mounts (#3316)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment() — additional mounts (#3316)', () => {
  it('translates opts.mounts into hostPath volumes and volumeMounts', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'extra-mounts',
      image: 'agent:latest',
      mounts: [
        '/host/config:/etc/app-config',
        '/host/data:/data',
      ],
    })

    const { body } = api.calls.create[0]
    const volumes = body.spec.volumes
    const mounts = body.spec.containers[0].volumeMounts

    assert.ok(Array.isArray(volumes))
    const v0 = volumes.find(v => v.name === 'extra-vol-0')
    assert.ok(v0, 'extra-vol-0 must exist')
    assert.equal(v0.hostPath.path, '/host/config')

    const v1 = volumes.find(v => v.name === 'extra-vol-1')
    assert.ok(v1, 'extra-vol-1 must exist')
    assert.equal(v1.hostPath.path, '/host/data')

    const m0 = mounts.find(m => m.name === 'extra-vol-0')
    assert.ok(m0)
    assert.equal(m0.mountPath, '/etc/app-config')

    const m1 = mounts.find(m => m.name === 'extra-vol-1')
    assert.ok(m1)
    assert.equal(m1.mountPath, '/data')
  })

  it('sets readOnly: true for ":ro" mounts', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'ro-mount',
      image: 'agent:latest',
      mounts: ['/host/secrets:/run/secrets:ro'],
    })

    const mounts = api.calls.create[0].body.spec.containers[0].volumeMounts
    const m = mounts.find(m => m.name === 'extra-vol-0')
    assert.ok(m)
    assert.equal(m.readOnly, true)
  })

  it('does not set readOnly for rw mounts', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'rw-mount',
      image: 'agent:latest',
      mounts: ['/host/data:/data'],
    })

    const mounts = api.calls.create[0].body.spec.containers[0].volumeMounts
    const m = mounts.find(m => m.name === 'extra-vol-0')
    assert.ok(m)
    assert.equal(m.readOnly, undefined)
  })

  it('combines workspace volume from cwd with extra mounts', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'combined',
      image: 'agent:latest',
      cwd: '/home/user/project',
      mounts: ['/host/certs:/certs:ro'],
    })

    const volumes = api.calls.create[0].body.spec.volumes
    assert.ok(volumes.find(v => v.name === 'workspace'))
    assert.ok(volumes.find(v => v.name === 'extra-vol-0'))
    assert.equal(volumes.length, 2)

    const mounts = api.calls.create[0].body.spec.containers[0].volumeMounts
    assert.ok(mounts.find(m => m.name === 'workspace'))
    assert.ok(mounts.find(m => m.name === 'extra-vol-0'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment — forwardPorts (#3316)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment() — forwardPorts (#3316)', () => {
  it('adds extra containerPort entries from opts.forwardPorts', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'ports-test',
      image: 'agent:latest',
      forwardPorts: [3000, 8080],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.ok(ports.some(p => p.containerPort === 3000))
    assert.ok(ports.some(p => p.containerPort === 8080))
  })

  it('always includes the built-in AGENT_PORT (7681) even when forwardPorts is provided', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'agent-port-present',
      image: 'agent:latest',
      forwardPorts: [9000],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.ok(ports.some(p => p.containerPort === 7681), 'AGENT_PORT 7681 must always be present')
  })

  it('deduplicates AGENT_PORT when forwardPorts includes it', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'dedup-port',
      image: 'agent:latest',
      forwardPorts: [7681, 4000],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    const agentPorts = ports.filter(p => p.containerPort === 7681)
    assert.equal(agentPorts.length, 1, 'AGENT_PORT must not be duplicated')
  })

  it('accepts "hostPort:containerPort" string format', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'colon-port',
      image: 'agent:latest',
      forwardPorts: ['9000:8080'],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.ok(ports.some(p => p.containerPort === 8080), 'containerPort 8080 must be present')
    assert.equal(ports.find(p => p.containerPort === 8080).hostPort, undefined,
      'hostPort must not be set in the Pod spec (not supported at Pod level)')
  })

  it('pod spec has only AGENT_PORT when forwardPorts is absent', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'no-ports', image: 'agent:latest' })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.equal(ports.length, 1, 'only AGENT_PORT when forwardPorts is absent')
    assert.equal(ports[0].containerPort, 7681)
    assert.equal(ports[0].name, 'agent')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment — port range validation (#3386)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment() — port range validation (#3386)', () => {
  it('accepts a valid port (e.g. 8080)', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'valid-port',
      image: 'agent:latest',
      forwardPorts: [8080],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.ok(ports.some(p => p.containerPort === 8080), 'port 8080 must be present')
  })

  it('silently drops port 0 — only AGENT_PORT remains', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'port-zero',
      image: 'agent:latest',
      forwardPorts: [0],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.equal(ports.length, 1, 'port 0 must be dropped')
    assert.equal(ports[0].containerPort, 7681)
  })

  it('silently drops port 65536 — only AGENT_PORT remains', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'port-overflow',
      image: 'agent:latest',
      forwardPorts: [65536],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.equal(ports.length, 1, 'port 65536 must be dropped')
    assert.equal(ports[0].containerPort, 7681)
  })

  it('silently drops a negative port — only AGENT_PORT remains', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'port-negative',
      image: 'agent:latest',
      forwardPorts: [-1],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.equal(ports.length, 1, 'negative port must be dropped')
    assert.equal(ports[0].containerPort, 7681)
  })

  it('silently drops a non-integer string — only AGENT_PORT remains', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'port-nan',
      image: 'agent:latest',
      forwardPorts: ['abc'],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.equal(ports.length, 1, 'non-numeric port must be dropped')
    assert.equal(ports[0].containerPort, 7681)
  })

  it('drops the out-of-range port but keeps a valid sibling port', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({
      envId: 'port-mixed',
      image: 'agent:latest',
      forwardPorts: [99999, 3000],
    })

    const { ports } = api.calls.create[0].body.spec.containers[0]
    assert.ok(!ports.some(p => p.containerPort === 99999), 'port 99999 must be dropped')
    assert.ok(ports.some(p => p.containerPort === 3000), 'port 3000 must be kept')
    assert.ok(ports.some(p => p.containerPort === 7681), 'AGENT_PORT must be kept')
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

  it('spawn frame always carries stdin: pipe (post-#3336 — stdin is wired)', async () => {
    const { backend, ws } = makeBackendWithFakeWs()

    backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: ['-p'], agentToken: 'tok',
    })

    await new Promise(resolve => setImmediate(resolve))

    const frame = JSON.parse(ws.sent[0])
    assert.equal(frame.type, 'spawn')
    assert.equal(frame.stdin, 'pipe',
      'K8sBackend spawn frame uses stdin:pipe — SidecarProcess.stdin is now wired (#3336)')
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

  it('emits exit(-1) when agentToken is missing (no Secret either)', async () => {
    // After the lazy-fetch refactor the missing-token path is asynchronous:
    // _readAgentToken is called, finds no CHROXY_AGENT_TOKEN in the Secret
    // response, returns null, and the Promise chain emits exit(-1).
    const api = createMockApi({
      // Default mock returns {}, so data.CHROXY_AGENT_TOKEN is undefined → null
      readSecret: async () => ({}),
    })
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(ws),
    })

    const proc = backend.streamCliInEnvironment('pod-x', { cmd: 'node', args: [] })
    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setTimeout(r, 20))

    assert.deepEqual(exitCodes, [-1],
      'missing token must drive exit(-1) asynchronously via the lazy-fetch path')
    proc.stdout.resume(); proc.stderr.resume()
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

  it('rejects when agentToken is missing (no Secret either)', async () => {
    // After the lazy-fetch refactor the missing-token path is async: the
    // rejection surfaces as exit(-1) → execInEnvironment rejects.
    const api = createMockApi({
      readSecret: async () => ({}),
    })
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(ws),
    })

    await assert.rejects(
      () => backend.execInEnvironment('pod-x', { cmd: 'echo', args: [], timeout: 500 }),
      /Command exited with code -1/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.streamCliInEnvironment — abort-during-dial leak guard (#3333)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.streamCliInEnvironment() abort-during-dial', () => {
  it('emits exit(-1) and closes WS when kill() fires before dial resolves', async () => {
    let resolveDial
    const dialPromise = new Promise((r) => { resolveDial = r })

    let wsClosed = false
    const { ws } = createFakeWs()
    ws.close = () => { wsClosed = true }

    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => dialPromise,
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    // Kill BEFORE dial resolves (proc._ws is still null)
    proc.kill('SIGTERM')

    // Dial completes after kill
    resolveDial(ws)
    // Allow the .then handler to run
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-1], 'should emit exit(-1) for the killed-during-dial proc')
    assert.equal(wsClosed, true, 'WS should be closed even though kill happened before dial')
  })

  it('emits exit(-1) when AbortSignal is pre-aborted before streamCliInEnvironment', async () => {
    let resolveDial
    const dialPromise = new Promise((r) => { resolveDial = r })

    let wsClosed = false
    const { ws } = createFakeWs()
    ws.close = () => { wsClosed = true }

    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => dialPromise,
    })

    const ac = new AbortController()
    ac.abort() // pre-abort

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok', signal: ac.signal,
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    resolveDial(ws)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-1], 'pre-aborted signal must drive exit(-1)')
    assert.equal(wsClosed, true, 'WS opened during dial must be closed when abort already fired')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.streamCliInEnvironment — error-frame termination (#3338)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.streamCliInEnvironment() error frame handling', () => {
  function makeBackendWithFakeWs() {
    const { ws, controller } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })
    return { backend, ws, controller }
  }

  it('synthesizes exit(-1) when error frame arrives BEFORE any event/stderr', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: '', args: [], agentToken: 'tok',  // bad cmd → agent will error
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))

    // Agent sends error frame before any output (per PROTOCOL.md, spawn rejected)
    controller.receive(JSON.stringify({ type: 'error', message: 'spawn: cmd is required' }))

    assert.deepEqual(exitCodes, [-1],
      'pre-output error frame must synthesize exit(-1) so consumer does not hang')
  })

  it('does NOT synthesize exit when error frame arrives AFTER first event/stderr', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))

    // First an event arrives, then an error frame (mid-stream warning)
    controller.receive(JSON.stringify({ type: 'event', payload: 'ok\n' }))
    controller.receive(JSON.stringify({ type: 'error', message: 'transient warning' }))

    assert.deepEqual(exitCodes, [],
      'mid-stream error frame must NOT terminate — wait for real exit frame')
  })

  it('execInEnvironment surfaces error-before-output as a rejection', async () => {
    const { backend, controller } = makeBackendWithFakeWs()

    const execPromise = backend.execInEnvironment('pod-x', {
      cmd: '', args: [], agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    controller.receive(JSON.stringify({ type: 'error', message: 'spawn: cmd is required' }))

    await assert.rejects(execPromise, /sidecar error: spawn: cmd is required|exited with code -1/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.execInEnvironment — timeout actually kills the underlying process (#3335)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.execInEnvironment() timeout cleanup', () => {
  it('calls proc.kill() and closes WS when timeout fires', async () => {
    let wsClosed = false
    const { ws } = createFakeWs()
    ws.close = () => { wsClosed = true }

    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })

    const execPromise = backend.execInEnvironment('pod-x', {
      cmd: 'sleep', args: ['1000'], agentToken: 'tok', timeout: 50,
    })

    await assert.rejects(execPromise, /timed out/)
    assert.equal(wsClosed, true, 'WS must be closed when exec times out so the in-pod child is SIGTERMd')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend agentToken — registered by createEnvironment, looked up automatically (#3337)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend agentToken auto-registration', () => {
  it('streamCliInEnvironment uses token registered by createEnvironment', async () => {
    let dialCalledWith = null
    const api = createMockApi()
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: (_url, token) => { dialCalledWith = token; return Promise.resolve(ws) },
    })

    const created = await backend.createEnvironment({ envId: 'auto', image: 'ignored' })
    // Caller does NOT have to thread agentToken through opts
    backend.streamCliInEnvironment(created.containerId, { cmd: 'node', args: [] })

    await new Promise(r => setImmediate(r))

    assert.equal(dialCalledWith, created.agentToken,
      'streamCliInEnvironment must use the token registered by createEnvironment')
  })

  it('opts.agentToken still wins over the registered token (test seam)', async () => {
    let dialCalledWith = null
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: (_url, token) => { dialCalledWith = token; return Promise.resolve(ws) },
    })

    await backend.createEnvironment({ envId: 'auto2', image: 'ignored' })
    backend.streamCliInEnvironment('chroxy-env-auto2', {
      cmd: 'node', args: [], agentToken: 'override-token',
    })

    await new Promise(r => setImmediate(r))
    assert.equal(dialCalledWith, 'override-token')
  })

  it('destroyEnvironment removes the registered token', async () => {
    const api = createMockApi({
      readPod: async () => { throw make404Error() },
      // After destroy the Secret is gone — 404 on readNamespacedSecret
      readSecret: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(createFakeWs().ws),
    })

    const { containerId } = await backend.createEnvironment({ envId: 'gone', image: 'ignored' })
    await backend.destroyEnvironment(containerId)

    // After destroy, calling streamCliInEnvironment without an explicit token must
    // fail. The lazy Secret fetch returns null (Secret was deleted), so the async
    // chain emits exit(-1).
    const proc = backend.streamCliInEnvironment(containerId, { cmd: 'node', args: [] })
    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setTimeout(r, 20))
    assert.deepEqual(exitCodes, [-1],
      'after destroyEnvironment, missing Secret must drive exit(-1)')
    proc.stdout.resume(); proc.stderr.resume()
  })

  it('destroyEnvironment derives the Secret name from podName when none is passed', async () => {
    const api = createMockApi({
      readPod: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.destroyEnvironment('chroxy-env-derived')

    assert.equal(api.calls.deleteSecret.length, 1, 'should delete the derived Secret')
    assert.equal(api.calls.deleteSecret[0].name, 'chroxy-token-derived',
      'derived Secret name must follow chroxy-token-<envId>')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.createEnvironment — always uses sidecar image (ignores caller image)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.createEnvironment() sidecar image policy', () => {
  it('always uses the constructor sidecarImage and ignores opts.image', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({
      sidecarImage: 'my-registry/chroxy-pod-agent:v1.2.3',
      _coreV1Api: api,
    })

    await backend.createEnvironment({
      envId: 'sc-img',
      image: 'node:22-slim',  // user-workspace image — must be IGNORED
    })

    const podBody = api.calls.create[0].body
    assert.equal(podBody.spec.containers[0].image, 'my-registry/chroxy-pod-agent:v1.2.3',
      'sidecar image (not user image) must be used')
  })

  it('uses default sidecar image when none configured', async () => {
    const api = createMockApi()
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend.createEnvironment({ envId: 'sc-default', image: 'ubuntu:latest' })

    const podBody = api.calls.create[0].body
    assert.equal(podBody.spec.containers[0].image, 'chroxy-pod-agent:latest',
      'default sidecar image must be used when none configured')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.streamCliInEnvironment — cli.js path remap (#3334)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.streamCliInEnvironment() cli.js remap', () => {
  it('remaps host @anthropic-ai/claude-code/cli.js path to containerCliPath', async () => {
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })

    const containerCliPath = '/opt/installed/lib/node_modules/@anthropic-ai/claude-code/cli.js'

    backend.streamCliInEnvironment('pod-x', {
      cmd: 'node',
      args: ['/host/abs/@anthropic-ai/claude-code/cli.js', '-p'],
      agentToken: 'tok',
      containerCliPath,
    })

    await new Promise(r => setImmediate(r))

    assert.equal(ws.sent.length, 1)
    const frame = JSON.parse(ws.sent[0])
    assert.equal(frame.args[0], containerCliPath, 'cli.js arg must be remapped to container path')
    assert.equal(frame.args[1], '-p', 'remaining args preserved')
  })

  it('falls back to default cli path when none provided', async () => {
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })

    backend.streamCliInEnvironment('pod-x', {
      cmd: 'node',
      args: ['/host/path/@anthropic-ai/claude-code/cli.js'],
      agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    const frame = JSON.parse(ws.sent[0])
    assert.equal(frame.args[0],
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      'must use default container path when none configured')
  })

  it('remaps host cwd to /workspace when hostCwd is supplied', async () => {
    const { ws } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })

    backend.streamCliInEnvironment('pod-x', {
      cmd: 'node', args: [],
      cwd: '/home/user/project/src',
      hostCwd: '/home/user/project',
      agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    const frame = JSON.parse(ws.sent[0])
    assert.equal(frame.cwd, '/workspace/src', 'cwd must be remapped relative to /workspace')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend._dialViaPortForward — TCP listener bridge (#3332)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend._dialViaPortForward() listener bridge', () => {
  it('opens a local TCP listener and forwards each connection to AGENT_PORT (7681)', async () => {
    // Fake net.createServer that captures the listen() callback so we can
    // synchronously assert the listener was created and would dial localhost.
    let serverCreated = false
    let serverListened = false
    let serverClosed = false
    let acceptedSocket = null
    let listenCallback = null

    const fakeServer = {
      listen: (_port, _host, cb) => {
        serverListened = true
        listenCallback = cb
      },
      close: () => { serverClosed = true },
      address: () => ({ port: 54321 }),
      on: () => {},
    }

    const fakeNet = {
      createServer: (handler) => {
        serverCreated = true
        // Simulate an immediate connection so we can verify the bridge
        // calls portForward with AGENT_PORT, not the local listener port.
        setImmediate(() => {
          acceptedSocket = { destroy: () => {} }
          handler(acceptedSocket)
        })
        return fakeServer
      },
    }

    let pfCalledWith = null
    const fakePf = {
      portForward: (ns, pod, ports, _out, _err, _input, outputPorts) => {
        pfCalledWith = { ns, pod, ports, outputPorts }
      },
    }

    let dialedUrl = null
    const { ws } = createFakeWs()

    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _portForward: fakePf,
      _net: fakeNet,
      _dialWs: (url) => { dialedUrl = url; return Promise.resolve(ws) },
    })
    // Force portforward mode by removing the directDial flag explicitly
    backend._directDial = false
    backend._connectMode = 'portforward'

    const dialPromise = backend._dialViaPortForward('pod-x', 'default', 'tok')

    // Trigger the listen() callback to advance the dial chain
    assert.equal(serverListened, true, 'should call server.listen()')
    listenCallback()

    // Wait for the connection handler + dial chain
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const result = await dialPromise

    assert.equal(serverCreated, true, 'must create a TCP server')
    assert.equal(dialedUrl, 'ws://127.0.0.1:54321',
      'must dial the local listener port (not AGENT_PORT directly)')
    assert.ok(pfCalledWith, 'portForward must be called for each accepted connection')
    assert.deepEqual(pfCalledWith.ports, [7681],
      'portForward target port MUST be AGENT_PORT (7681), not the local listener port')
    assert.equal(pfCalledWith.pod, 'pod-x')
    assert.equal(pfCalledWith.ns, 'default')

    // Cleanup callback should close the listener
    assert.equal(typeof result.cleanup, 'function')
    result.cleanup()
    assert.equal(serverClosed, true, 'cleanup must close the listener')
  })

  it('cleanup is invoked on streamCliInEnvironment exit', async () => {
    let serverClosed = false
    const fakeServer = {
      listen: (_port, _host, cb) => { setImmediate(cb) },
      close: () => { serverClosed = true },
      address: () => ({ port: 54322 }),
      on: () => {},
    }
    const fakeNet = { createServer: () => fakeServer }
    const fakePf = { portForward: () => {} }

    const { ws, controller } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _portForward: fakePf,
      _net: fakeNet,
      _dialWs: () => Promise.resolve(ws),
    })
    // Force the actual portforward path (not direct dial)
    backend._directDial = false
    backend._connectMode = 'portforward'
    // Provide a kubeconfig stub so _dialViaPortForward won't bail
    backend._kc = {}

    const proc = backend.streamCliInEnvironment('pod-y', {
      cmd: 'node', args: [], agentToken: 'tok',
    })

    // Allow listener-listen + dial chain
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    // Exit should trigger cleanup
    controller.receive(JSON.stringify({ type: 'exit', code: 0 }))
    await new Promise(r => setImmediate(r))

    assert.equal(serverClosed, true, 'cleanup must run on exit so listener does not leak')

    // Drain proc to avoid lingering handles
    proc.stdout.resume(); proc.stderr.resume()
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

  it('renameEnvironment() is a no-op — resolves without I/O (K8s pods have unique names)', async () => {
    const backend = makeBackend()
    // Must resolve, not reject — the restore flow calls this unconditionally and
    // a rejection would abort the restore.  See Backend interface in types.js.
    await assert.doesNotReject(() => backend.renameEnvironment('pod-id', 'new-name'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.streamCliInEnvironment() reconnect loop (#3321)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.streamCliInEnvironment() reconnect loop', () => {
  /**
   * Build a K8sBackend whose _dialWs is driven by a pre-defined sequence of
   * fake WS + controller pairs.  Each call to _dialWs pops the next item from
   * the sequence.
   *
   * Returns { backend, dials, clock } where dials[i] = { ws, controller } and
   * clock exposes tick() to advance the reconnect timer deterministically.
   */
  function makeBackendWithDials(count) {
    let callIndex = 0
    const dials = Array.from({ length: count }, () => createFakeWs())
    const clock = createFakeClock()

    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => {
        const d = dials[callIndex]
        callIndex += 1
        if (!d) throw new Error(`unexpected extra dial (${callIndex - 1})`)
        return Promise.resolve(d.ws)
      },
      _reconnectDelays: [0],  // delay value is irrelevant — fake clock fires immediately
      _maxRetries: 5,
      _setTimeout: clock.setTimeout,
      _clearTimeout: clock.clearTimeout,
    })

    return { backend, dials, clock }
  }

  it('retries after unexpected WS close, sends resume with correct lastSeq', async () => {
    const { backend, dials, clock } = makeBackendWithDials(2)
    const [dial1, dial2] = dials

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    // Allow first dial + spawn send
    await new Promise(r => setImmediate(r))

    // Agent acknowledges session and sends one event with seq=1
    dial1.controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'sess-1' }))
    dial1.controller.receive(JSON.stringify({ type: 'event', payload: 'hi', seq: 1 }))
    await new Promise(r => setImmediate(r))

    assert.equal(proc._sessionId, 'sess-1')
    assert.equal(proc._lastSeq, 1)

    // Unexpected close (code 1006 — abnormal closure)
    dial1.controller.triggerClose(1006)
    // Advance fake clock so the reconnect timer fires, then yield for the dial promise.
    await tickAndFlush(clock)

    // Second connection should send a resume frame with lastSeq=1
    const sent2 = dial2.ws.sent
    assert.ok(sent2.length > 0, 'second dial must send a frame')
    const resumeFrame = JSON.parse(sent2[sent2.length - 1])
    assert.equal(resumeFrame.type, 'resume', 'must send resume frame on reconnect')
    assert.equal(resumeFrame.sessionId, 'sess-1')
    assert.equal(resumeFrame.lastSeq, 1)

    assert.deepEqual(exitCodes, [], 'must not exit on transient reconnect')

    // Clean up: send exit from second connection
    dial2.controller.receive(JSON.stringify({ type: 'exit', code: 0 }))
    await new Promise(r => setImmediate(r))
    assert.deepEqual(exitCodes, [0])

    proc.stdout.resume(); proc.stderr.resume()
  })

  it('gives up after max retries and emits exit(-2)', async () => {
    // 1 initial dial + 3 reconnect dials = 4 total; _maxRetries=3 so we need 4
    let callIndex = 0
    const dials = Array.from({ length: 4 }, () => createFakeWs())
    const clock = createFakeClock()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => {
        const d = dials[callIndex]
        callIndex += 1
        if (!d) throw new Error(`unexpected extra dial (${callIndex - 1})`)
        return Promise.resolve(d.ws)
      },
      _reconnectDelays: [0],
      _maxRetries: 3,
      _setTimeout: clock.setTimeout,
      _clearTimeout: clock.clearTimeout,
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))

    // Acknowledge session on first dial
    dials[0].controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'sess-2' }))
    await new Promise(r => setImmediate(r))

    // Trigger 3 successive unexpected closes (matching _maxRetries)
    for (let i = 0; i < 3; i++) {
      dials[i].controller.triggerClose(1006)
      await tickAndFlush(clock)
    }

    // After 3 reconnect attempts dials[3] is open; closing it should exceed max
    dials[3].controller.triggerClose(1006)
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-2],
      `expected exit(-2) after max retries, got ${JSON.stringify(exitCodes)}`)

    proc.stdout.resume(); proc.stderr.resume()
  })

  it('emits exit(-2) on session_lost frame', async () => {
    const { backend, dials } = makeBackendWithDials(1)
    const [dial1] = dials

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))

    // Establish session then simulate agent reporting session_lost (e.g. pod restart)
    dial1.controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'sess-3' }))
    await new Promise(r => setImmediate(r))

    dial1.controller.receive(JSON.stringify({ type: 'session_lost', sessionId: 'sess-3' }))
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-2],
      `expected exit(-2) on session_lost, got ${JSON.stringify(exitCodes)}`)

    proc.stdout.resume(); proc.stderr.resume()
  })

  it('does not reconnect when kill() is called before unexpected close', async () => {
    const { backend, dials, clock } = makeBackendWithDials(1)
    const [dial1] = dials

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    // Establish session
    dial1.controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'sess-4' }))
    await new Promise(r => setImmediate(r))

    // Kill proc — sets proc.killed = true and cancels retry timer
    proc.kill()

    // Unexpected close should not trigger reconnect because proc.killed is true.
    // Advance the fake clock to confirm no reconnect timer was queued.
    dial1.controller.triggerClose(1006)
    await tickAndFlush(clock)

    // dials only has 1 entry — if a second dial were attempted, the test would
    // throw "unexpected extra dial".
    assert.equal(dials.length, 1, 'only one dial should have been made')

    proc.stdout.resume(); proc.stderr.resume()
  })

  it('resets retry count on `resumed` frame after successful reconnect (#3348)', async () => {
    // Per PROTOCOL.md the agent emits `{ type: 'resumed', ... }` after replay
    // on a successful resume. The client uses that frame — NOT a synthetic
    // session_started — to reset its per-blip retry budget. This test mirrors
    // real wire behaviour: only `session_started` on the FIRST dial, and
    // `resumed` on every subsequent successful reconnect.
    const { backend, dials, clock } = makeBackendWithDials(2)
    const [dial1, dial2] = dials

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))

    // First session
    dial1.controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'sess-5' }))
    await new Promise(r => setImmediate(r))

    // Simulate prior failures so retry count > 0
    proc._retryAttempt = 2

    // Disconnect and reconnect
    dial1.controller.triggerClose(1006)
    await tickAndFlush(clock)

    // Second dial should have sent a resume frame
    const sent2 = dial2.ws.sent
    assert.ok(sent2.length > 0, 'second dial must have sent a frame')
    const resumeFrame = JSON.parse(sent2[sent2.length - 1])
    assert.equal(resumeFrame.type, 'resume')

    // Agent sends `resumed` (not session_started) on successful resume.
    dial2.controller.receive(JSON.stringify({
      type: 'resumed', sessionId: 'sess-5', lastSeq: 0, replayedCount: 0,
    }))
    await new Promise(r => setImmediate(r))

    assert.equal(proc._retryAttempt, 0,
      `retry count should be reset to 0 after 'resumed' on reconnect, got ${proc._retryAttempt}`)

    // Clean up
    dial2.controller.receive(JSON.stringify({ type: 'exit', code: 0 }))
    await new Promise(r => setImmediate(r))
    assert.deepEqual(exitCodes, [0])

    proc.stdout.resume(); proc.stderr.resume()
  })

  it('retry budget is per-blip — 3 reconnect cycles each reset the counter (#3348)', async () => {
    // Lifetime-budget bug: without per-blip reset, 3 cycles with maxRetries=2
    // would exhaust the counter on the 3rd cycle even though every prior
    // resume succeeded. With per-blip reset all 3 cycles can succeed.
    const dials = Array.from({ length: 4 }, () => createFakeWs())
    let callIndex = 0
    const clock = createFakeClock()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => {
        const d = dials[callIndex]
        callIndex += 1
        if (!d) throw new Error(`unexpected extra dial (${callIndex - 1})`)
        return Promise.resolve(d.ws)
      },
      _reconnectDelays: [0],
      _maxRetries: 2,  // tight budget — would fail on cycle 3 without per-blip reset
      _setTimeout: clock.setTimeout,
      _clearTimeout: clock.clearTimeout,
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))

    // Initial session
    dials[0].controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'sess-life' }))
    await new Promise(r => setImmediate(r))

    // Cycle 1 reconnect → resumed
    dials[0].controller.triggerClose(1006)
    await tickAndFlush(clock)
    dials[1].controller.receive(JSON.stringify({
      type: 'resumed', sessionId: 'sess-life', lastSeq: 0, replayedCount: 0,
    }))
    await new Promise(r => setImmediate(r))
    assert.equal(proc._retryAttempt, 0, 'cycle 1: retry counter must reset on resumed')

    // Cycle 2 reconnect → resumed
    dials[1].controller.triggerClose(1006)
    await tickAndFlush(clock)
    dials[2].controller.receive(JSON.stringify({
      type: 'resumed', sessionId: 'sess-life', lastSeq: 0, replayedCount: 0,
    }))
    await new Promise(r => setImmediate(r))
    assert.equal(proc._retryAttempt, 0, 'cycle 2: retry counter must reset on resumed')

    // Cycle 3 reconnect → resumed
    dials[2].controller.triggerClose(1006)
    await tickAndFlush(clock)
    dials[3].controller.receive(JSON.stringify({
      type: 'resumed', sessionId: 'sess-life', lastSeq: 0, replayedCount: 0,
    }))
    await new Promise(r => setImmediate(r))
    assert.equal(proc._retryAttempt, 0, 'cycle 3: retry counter must reset on resumed')

    // Should still be alive after 3 cycles
    assert.deepEqual(exitCodes, [], 'must not exit after 3 successful reconnect cycles')

    // Drain final exit
    dials[3].controller.receive(JSON.stringify({ type: 'exit', code: 0 }))
    await new Promise(r => setImmediate(r))
    assert.deepEqual(exitCodes, [0])

    proc.stdout.resume(); proc.stderr.resume()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SidecarProcess.kill() — must always emit exit regardless of WS close code (#3346)
// ─────────────────────────────────────────────────────────────────────────────

describe('SidecarProcess.kill() exit semantics', () => {
  /**
   * Build a fake WS whose close() emits a configurable code instead of the
   * default 1000. Real ws clients emit 1006 (abnormal closure) when the
   * remote end drops the TCP connection without a close handshake — exactly
   * the shape that triggered the #3346 hang.
   */
  function fakeWsWithCloseCode(code) {
    const emitter = new EventEmitter()
    const sent = []
    const ws = {
      readyState: 1,
      send: (d) => { sent.push(d) },
      close: () => { emitter.emit('close', code, '') },
      once: (ev, fn) => emitter.once(ev, fn),
      on: (ev, fn) => emitter.on(ev, fn),
    }
    ws.sent = sent
    const controller = {
      receive: (raw) => emitter.emit('message', raw),
      triggerError: (err) => emitter.emit('error', err),
      triggerClose: (c = code) => emitter.emit('close', c, ''),
    }
    return { ws, controller }
  }

  it('emits exit(-1) after kill() even when close fires with code 1006 (#3346)', async () => {
    const { ws } = fakeWsWithCloseCode(1006)
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    // Allow dial + spawn frame + session ack so the close path follows the
    // post-session branch (which previously fell into scheduleReconnect).
    await new Promise(r => setImmediate(r))
    // No session_started — but kill() still must produce exit regardless.
    proc.kill('SIGTERM')

    // proc.kill() calls ws.close() which synchronously emits the 1006.
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-1],
      'kill() must emit exit(-1) regardless of WS close code (1006 was the canonical real-world failure)')
  })

  it('emits exit(-1) after kill() when close fires with 1006 mid-session', async () => {
    const { ws, controller } = fakeWsWithCloseCode(1006)
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
      _reconnectDelays: [1000],  // long enough that no real reconnect timer fires
      _maxRetries: 5,
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))
    // Establish session — this puts the close path into the
    // scheduleReconnect branch, which is where the original bug lived.
    controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'kill-1006' }))
    await new Promise(r => setImmediate(r))

    proc.kill('SIGTERM')
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-1],
      'kill() mid-session must emit exit(-1) instead of falling through to scheduleReconnect')
    // No reconnect timer should be pending after kill
    assert.equal(proc._retryTimer, null, 'kill() must clear any pending reconnect timer')
  })

  it('emits exit(-1) when WS error fires after kill() (#3346)', async () => {
    const { ws, controller } = fakeWsWithCloseCode(1006)
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))
    controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'kill-err' }))
    await new Promise(r => setImmediate(r))

    proc.kill('SIGTERM')
    // Some ws clients emit 'error' alongside (or instead of) close — exit
    // must still fire exactly once.
    controller.triggerError(new Error('socket hang up'))
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-1],
      'kill() must emit exit(-1) even when the underlying ws emits error after kill')
  })

  it('error and close handlers do not double-schedule reconnect (#3191269007)', async () => {
    const { ws, controller } = fakeWsWithCloseCode(1006)
    const dial2 = createFakeWs()
    let dialCount = 0
    const clock = createFakeClock()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => {
        dialCount += 1
        if (dialCount === 1) return Promise.resolve(ws)
        if (dialCount === 2) return Promise.resolve(dial2.ws)
        throw new Error(`unexpected extra dial (${dialCount})`)
      },
      _reconnectDelays: [0],
      _maxRetries: 5,
      _setTimeout: clock.setTimeout,
      _clearTimeout: clock.clearTimeout,
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))
    controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'dbl' }))
    await new Promise(r => setImmediate(r))

    // Real ws clients commonly fire BOTH 'error' and 'close' for the same
    // socket failure. Without a guard the reconnect would be scheduled twice
    // and _retryAttempt would jump from 0 → 2 instead of 0 → 1.
    controller.triggerError(new Error('ECONNRESET'))
    controller.triggerClose(1006)

    // Advance the fake clock — the idempotency guard means only one timer
    // should have been queued despite two failure events.
    await tickAndFlush(clock)

    assert.equal(proc._retryAttempt, 1,
      `retry counter must increment by 1 per drop, got ${proc._retryAttempt}`)
    assert.equal(dialCount, 2, `expected exactly 2 dials (initial + 1 reconnect), got ${dialCount}`)

    proc.stdout.resume(); proc.stderr.resume()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SidecarProcess.session_lost(buffer_overflow) — emits exit(-2) (#3347)
// ─────────────────────────────────────────────────────────────────────────────

describe('SidecarProcess session_lost reasons', () => {
  function makeBackendWithFakeWs() {
    const { ws, controller } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })
    return { backend, ws, controller }
  }

  it('emits exit(-2) on session_lost(buffer_overflow) frame (#3347)', async () => {
    const { backend, controller } = makeBackendWithFakeWs()
    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setImmediate(r))
    controller.receive(JSON.stringify({ type: 'session_started', sessionId: 'gap' }))
    controller.receive(JSON.stringify({
      type: 'session_lost', sessionId: 'gap', reason: 'buffer_overflow',
    }))
    await new Promise(r => setImmediate(r))

    assert.deepEqual(exitCodes, [-2],
      'buffer_overflow session_lost must surface as exit(-2) (unrecoverable)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend._readAgentToken() — Secret-backed token recovery (#3339)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend._readAgentToken()', () => {
  it('fetches the token from the Secret and caches it in _agentTokens', async () => {
    const token = 'abc123-test-token'
    // K8s API returns .data values as base64
    const encoded = Buffer.from(token).toString('base64')

    const api = createMockApi({
      readSecret: async () => ({ data: { CHROXY_AGENT_TOKEN: encoded } }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const result = await backend._readAgentToken('chroxy-env-x', 'default')
    assert.equal(result, token, 'should decode base64 and return the plaintext token')
    assert.equal(backend._agentTokens.get('chroxy-env-x'), token,
      '_agentTokens must be populated after fetch')
  })

  it('returns null and does not throw when Secret is not found (404)', async () => {
    const api = createMockApi({
      readSecret: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const result = await backend._readAgentToken('chroxy-env-missing', 'default')
    assert.equal(result, null, 'should return null for 404')
    assert.equal(backend._agentTokens.has('chroxy-env-missing'), false,
      'should not cache on 404')
  })

  it('re-throws non-404 API errors', async () => {
    const apiErr = Object.assign(new Error('Forbidden'), { code: 403 })
    const api = createMockApi({
      readSecret: async () => { throw apiErr },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.rejects(
      () => backend._readAgentToken('chroxy-env-perm', 'default'),
      /Forbidden/,
      'non-404 API errors must propagate'
    )
  })

  it('returns null when Secret has no CHROXY_AGENT_TOKEN field', async () => {
    const api = createMockApi({
      readSecret: async () => ({ data: {} }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const result = await backend._readAgentToken('chroxy-env-empty', 'default')
    assert.equal(result, null)
  })

  it('caches token so second call does not hit the API', async () => {
    const token = 'cached-token'
    const encoded = Buffer.from(token).toString('base64')
    let apiCalls = 0

    const api = createMockApi({
      readSecret: async () => { apiCalls++; return { data: { CHROXY_AGENT_TOKEN: encoded } } },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await backend._readAgentToken('chroxy-env-cache', 'default')
    // Manually verify the map is populated so the second call short-circuits
    assert.equal(backend._agentTokens.get('chroxy-env-cache'), token)
    // The method itself does NOT short-circuit — it always reads the Secret.
    // Caching is used by streamCliInEnvironment (|| tokenOrPromise chain).
    assert.equal(apiCalls, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend.reconnectAgentToken() (#3339)
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend.reconnectAgentToken()', () => {
  it('returns true and populates _agentTokens when Secret exists', async () => {
    const token = 'reconnect-token'
    const encoded = Buffer.from(token).toString('base64')

    const api = createMockApi({
      readSecret: async () => ({ data: { CHROXY_AGENT_TOKEN: encoded } }),
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const ok = await backend.reconnectAgentToken('chroxy-env-r1')
    assert.equal(ok, true, 'should return true when Secret found')
    assert.equal(backend._agentTokens.get('chroxy-env-r1'), token,
      '_agentTokens must be populated')
  })

  it('returns false when Secret does not exist (404)', async () => {
    const api = createMockApi({
      readSecret: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    const ok = await backend.reconnectAgentToken('chroxy-env-r2')
    assert.equal(ok, false, 'should return false for 404')
  })

  it('propagates non-404 API errors', async () => {
    const apiErr = Object.assign(new Error('ServiceUnavailable'), { code: 503 })
    const api = createMockApi({
      readSecret: async () => { throw apiErr },
    })
    const backend = new K8sBackend({ _coreV1Api: api })

    await assert.rejects(
      () => backend.reconnectAgentToken('chroxy-env-r3'),
      /ServiceUnavailable/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// K8sBackend agentToken lazy-load via Secret on cache miss (#3339)
// After a server restart _agentTokens is empty; streamCliInEnvironment must
// transparently fetch the token from the K8s Secret and succeed.
// ─────────────────────────────────────────────────────────────────────────────

describe('K8sBackend agentToken lazy-load after server restart (#3339)', () => {
  it('fetches token from Secret when cache is empty after restart', async () => {
    const token = 'restart-token'
    const encoded = Buffer.from(token).toString('base64')
    let dialCalledWith = null

    const { ws } = createFakeWs()
    const api = createMockApi({
      readSecret: async () => ({ data: { CHROXY_AGENT_TOKEN: encoded } }),
    })
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: (_url, tok) => { dialCalledWith = tok; return Promise.resolve(ws) },
    })

    // Simulate server restart: _agentTokens is empty, no opts.agentToken
    assert.equal(backend._agentTokens.size, 0, 'precondition: cache empty on restart')

    const proc = backend.streamCliInEnvironment('chroxy-env-lazy', { cmd: 'node', args: [] })

    // Wait for async token fetch + dial to complete
    await new Promise(r => setTimeout(r, 20))

    assert.equal(dialCalledWith, token,
      'dial must use the token fetched from the Secret')
    assert.equal(backend._agentTokens.get('chroxy-env-lazy'), token,
      'token must be cached after lazy fetch')

    proc.stdout.resume(); proc.stderr.resume()
  })

  it('emits exit(-1) when Secret is not found (404) after restart', async () => {
    const { ws } = createFakeWs()
    const api = createMockApi({
      readSecret: async () => { throw make404Error() },
    })
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(ws),
    })

    const proc = backend.streamCliInEnvironment('chroxy-env-gone', { cmd: 'node', args: [] })

    const exitCodes = []
    proc.on('exit', (code) => exitCodes.push(code))

    await new Promise(r => setTimeout(r, 20))

    assert.deepEqual(exitCodes, [-1],
      'Secret-not-found must surface as exit(-1) (same as any pre-session failure)')
  })

  it('after reconnect(), streamCliInEnvironment succeeds without opts.agentToken', async () => {
    const token = 'post-reconnect-token'
    const encoded = Buffer.from(token).toString('base64')
    let dialCalledWith = null

    const { ws } = createFakeWs()
    const api = createMockApi({
      readSecret: async () => ({ data: { CHROXY_AGENT_TOKEN: encoded } }),
    })
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: (_url, tok) => { dialCalledWith = tok; return Promise.resolve(ws) },
    })

    // Simulate EnvironmentManager.reconnect() calling reconnectAgentToken
    await backend.reconnectAgentToken('chroxy-env-post-rc')

    // Now streamCliInEnvironment must succeed without any explicit agentToken
    backend.streamCliInEnvironment('chroxy-env-post-rc', { cmd: 'node', args: [] })
    await new Promise(r => setImmediate(r))

    assert.equal(dialCalledWith, token,
      'after reconnectAgentToken, streamCliInEnvironment uses the cached token')

    ws.close?.()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SidecarProcess stdin wiring (#3336)
// ─────────────────────────────────────────────────────────────────────────────

describe('SidecarProcess stdin wiring (#3336)', () => {
  function makeBackendWithFakeWs() {
    const { ws, controller } = createFakeWs()
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => Promise.resolve(ws),
    })
    return { backend, ws, controller }
  }

  it('spawn frame includes stdin:"pipe"', async () => {
    const { backend, ws } = makeBackendWithFakeWs()

    backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: ['-p'], agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    const spawnFrame = JSON.parse(ws.sent[0])
    assert.equal(spawnFrame.type, 'spawn')
    assert.equal(spawnFrame.stdin, 'pipe',
      'spawn frame must include stdin:"pipe" for stream-json workflow')
  })

  it('writing to proc.stdin sends a stdin frame over WS', async () => {
    const { backend, ws } = makeBackendWithFakeWs()

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: ['-p'], agentToken: 'tok',
    })

    // Wait for dial + spawn frame
    await new Promise(r => setImmediate(r))

    proc.stdin.write('{"prompt":"hello"}\n')

    // Give the data event a chance to fire
    await new Promise(r => setImmediate(r))

    // ws.sent[0] = spawn frame, ws.sent[1] = stdin frame
    assert.ok(ws.sent.length >= 2, 'WS should have a stdin frame after the spawn frame')
    const stdinFrame = JSON.parse(ws.sent[1])
    assert.equal(stdinFrame.type, 'stdin')
    assert.equal(stdinFrame.data, '{"prompt":"hello"}\n')
  })

  it('ending proc.stdin sends a stdin_end frame over WS', async () => {
    const { backend, ws } = makeBackendWithFakeWs()

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: ['-p'], agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    proc.stdin.write('{"prompt":"hi"}\n')
    proc.stdin.end()

    await new Promise(r => setImmediate(r))

    const frames = ws.sent.map(s => JSON.parse(s))
    const stdinEndFrame = frames.find(f => f.type === 'stdin_end')
    assert.ok(stdinEndFrame, 'stdin_end frame must be sent when proc.stdin ends')
  })

  it('writes before WS opens are buffered and flushed on open', async () => {
    // Dial returns a WS that is NOT yet open (readyState=0) — open fires async.
    const { ws: realWs, controller } = createFakeWs()
    // Simulate a WS that starts in CONNECTING state.
    const pendingOpenListeners = []
    const connectingWs = {
      readyState: 0,  // CONNECTING
      sent: realWs.sent,
      send: (data) => realWs.sent.push(data),
      close: realWs.close,
      once: (ev, fn) => {
        if (ev === 'open') {
          pendingOpenListeners.push(fn)
        } else {
          realWs.once(ev, fn)
        }
      },
      on: (ev, fn) => realWs.on(ev, fn),
    }

    const api = createMockApi()
    const backend = new K8sBackend({
      _coreV1Api: api,
      _dialWs: () => Promise.resolve(connectingWs),
    })
    backend._agentTokens.set('pod-x', 'tok')

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    // Write before the WS fires 'open' — should be buffered.
    proc.stdin.write('line1\n')
    proc.stdin.write('line2\n')

    // Sanity: no frames sent yet (WS not open)
    await new Promise(r => setImmediate(r))
    assert.equal(connectingWs.sent.length, 0,
      'no frames should be sent while WS is still connecting')

    // Open the WS — triggers spawn + stdin flush.
    connectingWs.readyState = 1  // OPEN
    for (const fn of pendingOpenListeners) fn()

    await new Promise(r => setImmediate(r))

    const frames = connectingWs.sent.map(s => JSON.parse(s))
    const stdinFrames = frames.filter(f => f.type === 'stdin')
    assert.equal(stdinFrames.length, 2,
      'both buffered stdin chunks should be flushed after WS opens')
    assert.equal(stdinFrames[0].data, 'line1\n')
    assert.equal(stdinFrames[1].data, 'line2\n')
  })

  it('emits error on proc when WS closes mid-stdin-write', async () => {
    const { backend, ws, controller } = makeBackendWithFakeWs()

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    await new Promise(r => setImmediate(r))

    // Simulate WS closing while stdin is still open
    controller.triggerClose(1006)
    await new Promise(r => setImmediate(r))

    // Mark WS as closed so the live listener sees it
    ws.readyState = 3  // CLOSED

    const errors = []
    proc.on('error', (err) => errors.push(err))

    // Write to stdin after WS is gone — should emit error
    proc.stdin.write('data after close\n')

    await new Promise(r => setImmediate(r))

    assert.ok(errors.length > 0, 'proc should emit error when WS is closed during stdin write')
    assert.ok(errors[0].message.includes('WS closed'), 'error message should mention WS closed')
  })

  it('stdin frames are NOT forwarded on the reconnect WS (resume semantics)', async () => {
    // Verify that _wireStdin is NOT called on a reconnect path: the second WS
    // (ws2) should receive only a `resume` frame, never a `stdin` frame, even
    // if the consumer writes to proc.stdin after reconnection.
    const { ws: ws1, controller: ctrl1 } = createFakeWs()
    const { ws: ws2, controller: ctrl2 } = createFakeWs()

    let dialCount = 0
    const backend = new K8sBackend({
      _coreV1Api: createMockApi(),
      _dialWs: () => {
        dialCount += 1
        return Promise.resolve(dialCount === 1 ? ws1 : ws2)
      },
      _reconnectDelays: [10],
      _maxRetries: 5,
    })

    const proc = backend.streamCliInEnvironment('pod-x', {
      cmd: 'claude', args: [], agentToken: 'tok',
    })

    // Attach a no-op error handler so any emitted errors don't throw.
    proc.on('error', () => {})

    // Wait for initial dial + spawn frame on ws1
    await new Promise(r => setImmediate(r))

    // Establish a session via session_started so proc._sessionId is set.
    ctrl1.receive(JSON.stringify({ type: 'session_started', sessionId: 'rsid-1' }))
    await new Promise(r => setImmediate(r))

    // Trigger an unexpected WS close to kick off reconnect to ws2.
    ctrl1.triggerClose(1006)

    // Wait for the reconnect timer (10 ms) + dial + resume frame.
    await new Promise(r => setTimeout(r, 30))

    // ws2 should have received exactly one frame: the resume frame.
    const ws2Frames = ws2.sent.map(s => JSON.parse(s))
    assert.equal(ws2Frames.length, 1, 'reconnect WS should receive only the resume frame')
    assert.equal(ws2Frames[0].type, 'resume',
      'first frame on reconnect WS must be resume, not spawn')

    // Write to stdin AFTER reconnect — it should NOT appear on ws2.
    proc.stdin.write('should not be forwarded on reconnect WS\n')
    await new Promise(r => setImmediate(r))

    const ws2FramesAfter = ws2.sent.map(s => JSON.parse(s))
    const stdinOnReconnect = ws2FramesAfter.filter(f => f.type === 'stdin')
    assert.equal(stdinOnReconnect.length, 0,
      'stdin frames must NOT be forwarded on a reconnect WS — resume picks up output only')

    proc.stdout.resume(); proc.stderr.resume()
  })
})
