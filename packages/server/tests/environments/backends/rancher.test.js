import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RancherBackend,
  isRancherConfigured,
  __test__,
} from '../../../src/environments/backends/rancher.js'

const { buildProxyUrl, validateRancherOptions, isAlreadyExists, PROJECT_ID_ANNOTATION } = __test__

// ─── Mock CoreV1Api factory ───────────────────────────────────────────────────
//
// Mirrors the K8s test fake: records calls and returns configured results.
// RancherBackend only adds createNamespace on top of the K8s surface, so we
// only need that method plus the pod/secret methods K8sBackend touches.
function createMockApi({ createNamespace, createPod, createSecret } = {}) {
  const calls = { createNamespace: [], create: [], createSecret: [] }
  const api = {
    createNamespace: createNamespace
      ? async (args) => { calls.createNamespace.push(args); return createNamespace(args) }
      : async (args) => { calls.createNamespace.push(args); return {} },
    createNamespacedPod: createPod
      ? async (args) => { calls.create.push(args); return createPod(args) }
      : async (args) => { calls.create.push(args); return {} },
    createNamespacedSecret: createSecret
      ? async (args) => { calls.createSecret.push(args); return createSecret(args) }
      : async (args) => { calls.createSecret.push(args); return {} },
  }
  api.calls = calls
  return api
}

function makeConflictError() {
  return Object.assign(new Error('namespaces "x" already exists'), { code: 409 })
}

// ─────────────────────────────────────────────────────────────────────────────
// validateRancherOptions
// ─────────────────────────────────────────────────────────────────────────────

describe('validateRancherOptions', () => {
  const ok = { rancherUrl: 'https://rancher.example.com', clusterId: 'c-m-abc123', token: 'tok' }

  it('accepts a complete, well-formed config and defaults skipTLSVerify to false', () => {
    const cfg = validateRancherOptions(ok)
    assert.equal(cfg.rancherUrl, ok.rancherUrl)
    assert.equal(cfg.clusterId, ok.clusterId)
    assert.equal(cfg.token, ok.token)
    assert.equal(cfg.skipTLSVerify, false)
    assert.equal(cfg.caData, undefined)
  })

  it('accepts legacy c-<short> cluster IDs', () => {
    assert.doesNotThrow(() => validateRancherOptions({ ...ok, clusterId: 'c-abcde' }))
  })

  it('throws on missing rancherUrl', () => {
    assert.throws(() => validateRancherOptions({ ...ok, rancherUrl: undefined }), /rancherUrl must be a non-empty string/)
  })

  it('throws on a non-URL rancherUrl', () => {
    assert.throws(() => validateRancherOptions({ ...ok, rancherUrl: 'not a url' }), /not a valid URL/)
  })

  it('throws on a non-http(s) rancherUrl protocol', () => {
    assert.throws(() => validateRancherOptions({ ...ok, rancherUrl: 'ftp://rancher.example.com' }), /must use http/)
  })

  it('throws on a malformed clusterId', () => {
    assert.throws(() => validateRancherOptions({ ...ok, clusterId: 'm-abc123' }), /cluster-ID format/)
  })

  it('throws on a missing/empty token', () => {
    assert.throws(() => validateRancherOptions({ ...ok, token: '' }), /non-empty bearer token/)
  })

  it('throws on a non-string caData', () => {
    assert.throws(() => validateRancherOptions({ ...ok, caData: 123 }), /caData/)
  })

  it('throws on a non-boolean skipTLSVerify', () => {
    assert.throws(() => validateRancherOptions({ ...ok, skipTLSVerify: 'yes' }), /skipTLSVerify must be a boolean/)
  })

  it('never echoes the token in error messages', () => {
    try {
      validateRancherOptions({ ...ok, clusterId: 'bad', token: 'SUPER-SECRET-TOKEN' })
      assert.fail('expected throw')
    } catch (err) {
      assert.ok(!err.message.includes('SUPER-SECRET-TOKEN'), 'token must not appear in error')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildProxyUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('buildProxyUrl', () => {
  it('forms the Rancher kube-API proxy path', () => {
    assert.equal(
      buildProxyUrl('https://rancher.example.com', 'c-m-abc123'),
      'https://rancher.example.com/k8s/clusters/c-m-abc123',
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    assert.equal(
      buildProxyUrl('https://rancher.example.com/', 'c-m-abc123'),
      'https://rancher.example.com/k8s/clusters/c-m-abc123',
    )
  })

  it('collapses multiple trailing slashes', () => {
    assert.equal(
      buildProxyUrl('https://rancher.example.com///', 'c-m-x'),
      'https://rancher.example.com/k8s/clusters/c-m-x',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isRancherConfigured (opt-in gate)
// ─────────────────────────────────────────────────────────────────────────────

describe('isRancherConfigured', () => {
  it('is false for empty / undefined opts (default K8s path)', () => {
    assert.equal(isRancherConfigured(), false)
    assert.equal(isRancherConfigured({}), false)
    assert.equal(isRancherConfigured({ namespace: 'default' }), false)
  })

  it('is false when any of url/clusterId/token is missing', () => {
    assert.equal(isRancherConfigured({ rancherUrl: 'https://r', clusterId: 'c-m-1' }), false)
    assert.equal(isRancherConfigured({ rancherUrl: 'https://r', token: 't' }), false)
    assert.equal(isRancherConfigured({ clusterId: 'c-m-1', token: 't' }), false)
  })

  it('is true only when url + clusterId + token are all present', () => {
    assert.equal(isRancherConfigured({ rancherUrl: 'https://r', clusterId: 'c-m-1', token: 't' }), true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isAlreadyExists
// ─────────────────────────────────────────────────────────────────────────────

describe('isAlreadyExists', () => {
  it('matches the various 409 shapes the kube client surfaces', () => {
    assert.equal(isAlreadyExists({ code: 409 }), true)
    assert.equal(isAlreadyExists({ statusCode: 409 }), true)
    assert.equal(isAlreadyExists({ response: { statusCode: 409 } }), true)
    assert.equal(isAlreadyExists({ body: { code: 409 } }), true)
    assert.equal(isAlreadyExists({ body: { reason: 'AlreadyExists' } }), true)
  })

  it('does not match unrelated errors', () => {
    assert.equal(isAlreadyExists({ code: 404 }), false)
    assert.equal(isAlreadyExists(new Error('boom')), false)
    assert.equal(isAlreadyExists(null), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// constructor — kube-client construction & opt-in default safety
// ─────────────────────────────────────────────────────────────────────────────

describe('RancherBackend constructor', () => {
  it('validates Rancher options when no client is injected (rejects bad clusterId without touching a real cluster)', () => {
    assert.throws(
      () => new RancherBackend({ rancherUrl: 'https://r', clusterId: 'bad', token: 't' }),
      /cluster-ID format/,
    )
  })

  it('builds a real kube client pointed at the Rancher proxy when given a full config (no network call at construct time)', () => {
    const backend = new RancherBackend({
      rancherUrl: 'https://rancher.example.com',
      clusterId: 'c-m-abc123',
      token: 'secret-token',
    })
    assert.equal(backend.clusterId, 'c-m-abc123')
    // The kube client exists and is the object K8sBackend methods use.
    assert.ok(backend._api, 'expected a CoreV1Api on the backend')
    // The bearer token must NOT be copied onto the instance identity block.
    assert.equal(backend._rancher.token, undefined)
    assert.ok(!JSON.stringify(backend._rancher).includes('secret-token'))
  })

  it('rejects a malformed defaultProjectId', () => {
    assert.throws(
      () => new RancherBackend({
        rancherUrl: 'https://r', clusterId: 'c-m-1', token: 't', defaultProjectId: 'bad',
      }),
      /project-ID format/,
    )
  })

  it('accepts an injected CoreV1Api seam and skips Rancher client construction', () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123', namespace: 'team-a' })
    assert.equal(backend._api, api)
    assert.equal(backend.clusterId, 'c-m-abc123')
  })

  it('forwards K8s opts (namespace) to the K8sBackend base', () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, namespace: 'team-a', clusterId: 'c-m-1' })
    assert.equal(backend._namespace, 'team-a')
  })

  it('validates clusterId on the injected-client seam when provided (rejects malformed)', () => {
    assert.throws(
      () => new RancherBackend({ _coreV1Api: createMockApi(), clusterId: 'bad' }),
      /cluster-ID format/,
    )
  })

  it('validates defaultProjectId on the injected-client seam when provided (rejects malformed)', () => {
    assert.throws(
      () => new RancherBackend({ _coreV1Api: createMockApi(), clusterId: 'c-m-1', defaultProjectId: 'bad' }),
      /project-ID format/,
    )
  })

  it('tolerates omitted Rancher identity on the injected-client seam', () => {
    assert.doesNotThrow(() => new RancherBackend({ _coreV1Api: createMockApi() }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ensureProjectNamespace — project-scoped namespace creation (core AC)
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureProjectNamespace', () => {
  it('creates a namespace annotated with field.cattle.io/projectId (<clusterId>:<projectId>)', async () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })

    const result = await backend.ensureProjectNamespace('team-alpha', { projectId: 'p-xyz789' })

    assert.equal(api.calls.createNamespace.length, 1)
    const body = api.calls.createNamespace[0].body
    assert.equal(body.kind, 'Namespace')
    assert.equal(body.metadata.name, 'team-alpha')
    assert.equal(body.metadata.annotations[PROJECT_ID_ANNOTATION], 'c-m-abc123:p-xyz789')
    assert.deepEqual(result, { namespace: 'team-alpha', projectId: 'p-xyz789', created: true })
  })

  it('uses the constructor defaultProjectId when no per-call projectId is given', async () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })
    backend._rancher.defaultProjectId = 'p-default'

    const result = await backend.ensureProjectNamespace('team-beta')

    const body = api.calls.createNamespace[0].body
    assert.equal(body.metadata.annotations[PROJECT_ID_ANNOTATION], 'c-m-abc123:p-default')
    assert.equal(result.projectId, 'p-default')
  })

  it('is idempotent — a 409 AlreadyExists is treated as success (created:false) and does NOT claim an unverified binding', async () => {
    const api = createMockApi({ createNamespace: () => { throw makeConflictError() } })
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })

    // Even though a projectId was requested, the namespace pre-existed so this
    // call did not apply the annotation — projectId must come back null so the
    // caller does not assume a binding we didn't make.
    const result = await backend.ensureProjectNamespace('team-alpha', { projectId: 'p-xyz789' })
    assert.deepEqual(result, { namespace: 'team-alpha', projectId: null, created: false })
  })

  it('rethrows non-conflict API errors', async () => {
    const api = createMockApi({ createNamespace: () => { throw Object.assign(new Error('forbidden'), { code: 403 }) } })
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })
    await assert.rejects(
      () => backend.ensureProjectNamespace('team-alpha', { projectId: 'p-xyz789' }),
      /forbidden/,
    )
  })

  it('falls back to a plain namespace (no project binding) when no projectId is available', async () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })

    const result = await backend.ensureProjectNamespace('plain-ns')

    const body = api.calls.createNamespace[0].body
    assert.equal(body.metadata.annotations, undefined)
    assert.equal(result.projectId, null)
    assert.equal(result.created, true)
  })

  it('falls back to a plain namespace when a projectId is requested but no clusterId is configured', async () => {
    const api = createMockApi()
    // No clusterId — e.g. injected-client test path with partial Rancher identity.
    const backend = new RancherBackend({ _coreV1Api: api })

    const result = await backend.ensureProjectNamespace('plain-ns', { projectId: 'p-xyz789' })

    const body = api.calls.createNamespace[0].body
    assert.equal(body.metadata.annotations, undefined, 'must not form a malformed annotation without clusterId')
    assert.equal(result.projectId, null)
  })

  it('rejects a malformed per-call projectId', async () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })
    await assert.rejects(
      () => backend.ensureProjectNamespace('team-alpha', { projectId: 'bad' }),
      /project-ID format/,
    )
  })

  it('validates the namespace against RFC 1123 (reuses K8sBackend validation)', async () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-abc123' })
    await assert.rejects(
      () => backend.ensureProjectNamespace('Bad_NS', { projectId: 'p-xyz789' }),
      /RFC 1123/,
    )
    assert.equal(api.calls.createNamespace.length, 0, 'no API call for an invalid namespace')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Inherited K8sBackend behaviour still works through the Rancher proxy client
// ─────────────────────────────────────────────────────────────────────────────

describe('RancherBackend inherits K8sBackend', () => {
  it('is an instanceof K8sBackend (so EnvironmentManager treats it identically)', async () => {
    const { K8sBackend } = await import('../../../src/environments/backends/k8s.js')
    const backend = new RancherBackend({ _coreV1Api: createMockApi(), clusterId: 'c-m-1' })
    assert.ok(backend instanceof K8sBackend)
  })

  it('createEnvironment uses the injected (Rancher proxy) api and honours the namespace', async () => {
    const api = createMockApi()
    const backend = new RancherBackend({ _coreV1Api: api, clusterId: 'c-m-1', namespace: 'team-a' })

    await backend.createEnvironment({ envId: 'e1' })

    // Secret + Pod created in the configured namespace via the same client.
    assert.equal(api.calls.createSecret.length, 1)
    assert.equal(api.calls.createSecret[0].namespace, 'team-a')
    assert.equal(api.calls.create.length, 1)
    assert.equal(api.calls.create[0].namespace, 'team-a')
  })
})
