import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEnvironmentBackend,
  resolveRancherToken,
  buildEnvironmentBackend,
  validateConfig,
} from '../src/config.js'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * #5144 — config-driven environment backend selection.
 *
 * `buildEnvironmentBackend` is exercised with an injected `_loadBackends`
 * factory so no real `@kubernetes/client-node` / Docker is touched: the fake
 * backend classes simply record the options they were constructed with, and the
 * tests assert which class was instantiated for each `environments.backend`
 * value and that the right options flowed through.
 */

// Fake backend classes — each captures its constructor opts for assertion.
class FakeDockerBackend {
  constructor(opts = {}) { this.kind = 'docker'; this.opts = opts }
}
class FakeK8sBackend {
  constructor(opts = {}) { this.kind = 'k8s'; this.opts = opts }
}
class FakeRancherBackend {
  constructor(opts = {}) { this.kind = 'rancher'; this.opts = opts }
}

const fakeLoader = async () => ({
  DockerBackend: FakeDockerBackend,
  K8sBackend: FakeK8sBackend,
  RancherBackend: FakeRancherBackend,
})

describe('resolveEnvironmentBackend (#5144)', () => {
  it('defaults to docker when environments is absent', () => {
    assert.equal(resolveEnvironmentBackend({}), 'docker')
    assert.equal(resolveEnvironmentBackend(undefined), 'docker')
    assert.equal(resolveEnvironmentBackend(null), 'docker')
  })

  it('defaults to docker when backend is absent', () => {
    assert.equal(resolveEnvironmentBackend({ environments: { enabled: true } }), 'docker')
  })

  it('returns the selected backend for each valid value', () => {
    assert.equal(resolveEnvironmentBackend({ environments: { backend: 'docker' } }), 'docker')
    assert.equal(resolveEnvironmentBackend({ environments: { backend: 'k8s' } }), 'k8s')
    assert.equal(resolveEnvironmentBackend({ environments: { backend: 'rancher' } }), 'rancher')
  })

  it('falls back to docker on an unrecognised value (warning surfaced by validateConfig)', () => {
    assert.equal(resolveEnvironmentBackend({ environments: { backend: 'nomad' } }), 'docker')
    assert.equal(resolveEnvironmentBackend({ environments: { backend: 42 } }), 'docker')
  })
})

describe('buildEnvironmentBackend (#5144)', () => {
  it('constructs DockerBackend by default and forwards _execFile', async () => {
    const execFile = () => {}
    const { backend, type } = await buildEnvironmentBackend(
      { environments: { enabled: true } },
      { _execFile: execFile, _loadBackends: fakeLoader },
    )
    assert.equal(type, 'docker')
    assert.ok(backend instanceof FakeDockerBackend)
    assert.equal(backend.opts._execFile, execFile)
  })

  it('constructs DockerBackend for an explicit docker selector', async () => {
    const { backend, type } = await buildEnvironmentBackend(
      { environments: { backend: 'docker' } },
      { _loadBackends: fakeLoader },
    )
    assert.equal(type, 'docker')
    assert.ok(backend instanceof FakeDockerBackend)
  })

  it('constructs DockerBackend for an unrecognised selector (safe default)', async () => {
    const { backend, type } = await buildEnvironmentBackend(
      { environments: { backend: 'nomad' } },
      { _loadBackends: fakeLoader },
    )
    assert.equal(type, 'docker')
    assert.ok(backend instanceof FakeDockerBackend)
  })

  it('constructs K8sBackend and forwards the k8s connection options', async () => {
    const config = {
      environments: {
        backend: 'k8s',
        k8s: {
          namespace: 'chroxy',
          inCluster: true,
          kubeconfigPath: '/k/config',
          sidecarImage: 'agent:1',
          imagePullPolicy: 'IfNotPresent',
          connectMode: 'clusterip',
          namespaceQuota: { cpu: '8', memory: '16Gi', pods: 10 },
          namespaceLimitRange: { cpu: '250m', cpuLimit: '1' },
          // workspace lives here too but is wired separately via the manager;
          // it should NOT be passed into the K8sBackend constructor here.
          workspace: { claimName: 'pvc' },
        },
      },
    }
    const { backend, type } = await buildEnvironmentBackend(config, { _loadBackends: fakeLoader })
    assert.equal(type, 'k8s')
    assert.ok(backend instanceof FakeK8sBackend)
    assert.equal(backend.opts.namespace, 'chroxy')
    assert.equal(backend.opts.inCluster, true)
    assert.equal(backend.opts.kubeconfigPath, '/k/config')
    assert.equal(backend.opts.sidecarImage, 'agent:1')
    assert.equal(backend.opts.imagePullPolicy, 'IfNotPresent')
    assert.equal(backend.opts.connectMode, 'clusterip')
    assert.deepEqual(backend.opts.namespaceQuota, { cpu: '8', memory: '16Gi', pods: 10 })
    assert.deepEqual(backend.opts.namespaceLimitRange, { cpu: '250m', cpuLimit: '1' })
    assert.ok(!('workspace' in backend.opts))
  })

  it('constructs K8sBackend with empty opts when no k8s block is configured', async () => {
    const { backend, type } = await buildEnvironmentBackend(
      { environments: { backend: 'k8s' } },
      { _loadBackends: fakeLoader },
    )
    assert.equal(type, 'k8s')
    assert.ok(backend instanceof FakeK8sBackend)
    assert.equal(backend.opts.namespace, undefined)
  })

  it('constructs RancherBackend and forwards both k8s and rancher options', async () => {
    const config = {
      environments: {
        backend: 'rancher',
        k8s: {
          namespace: 'chroxy',
          connectMode: 'clusterip',
          namespaceQuota: { cpu: '8', memory: '16Gi' },
          namespaceLimitRange: { cpuLimit: '1' },
        },
        rancher: {
          rancherUrl: 'https://rancher.example.com',
          clusterId: 'c-m-abc123',
          token: 'inline-token',
          caData: 'YmFzZTY0',
          skipTLSVerify: true,
          defaultProjectId: 'p-xyz',
        },
      },
    }
    const { backend, type } = await buildEnvironmentBackend(config, { _loadBackends: fakeLoader })
    assert.equal(type, 'rancher')
    assert.ok(backend instanceof FakeRancherBackend)
    // k8s knobs flow through
    assert.equal(backend.opts.namespace, 'chroxy')
    assert.equal(backend.opts.connectMode, 'clusterip')
    assert.deepEqual(backend.opts.namespaceQuota, { cpu: '8', memory: '16Gi' })
    assert.deepEqual(backend.opts.namespaceLimitRange, { cpuLimit: '1' })
    // rancher block flows through
    assert.equal(backend.opts.rancherUrl, 'https://rancher.example.com')
    assert.equal(backend.opts.clusterId, 'c-m-abc123')
    assert.equal(backend.opts.token, 'inline-token')
    assert.equal(backend.opts.caData, 'YmFzZTY0')
    assert.equal(backend.opts.skipTLSVerify, true)
    assert.equal(backend.opts.defaultProjectId, 'p-xyz')
  })

  it('resolves the Rancher token from an env var (secret-friendly source)', async () => {
    process.env.CHROXY_TEST_RANCHER_TOKEN = 'env-sourced-token'
    try {
      const config = {
        environments: {
          backend: 'rancher',
          rancher: {
            rancherUrl: 'https://rancher.example.com',
            clusterId: 'c-m-abc123',
            tokenEnv: 'CHROXY_TEST_RANCHER_TOKEN',
          },
        },
      }
      const { backend } = await buildEnvironmentBackend(config, { _loadBackends: fakeLoader })
      assert.equal(backend.opts.token, 'env-sourced-token')
    } finally {
      delete process.env.CHROXY_TEST_RANCHER_TOKEN
    }
  })
})

describe('resolveRancherToken (#5144)', () => {
  let tempDir
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'chroxy-rancher-token-')) })
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

  it('prefers tokenEnv over tokenFile and inline token', () => {
    process.env.CHROXY_TEST_TKN = 'from-env'
    const file = join(tempDir, 'tok')
    writeFileSync(file, 'from-file\n')
    try {
      const tok = resolveRancherToken({ tokenEnv: 'CHROXY_TEST_TKN', tokenFile: file, token: 'inline' })
      assert.equal(tok, 'from-env')
    } finally {
      delete process.env.CHROXY_TEST_TKN
    }
  })

  it('falls back to tokenFile (trimmed) when tokenEnv is unset', () => {
    const file = join(tempDir, 'tok')
    writeFileSync(file, '  from-file-trimmed  \n')
    const tok = resolveRancherToken({ tokenEnv: 'CHROXY_TEST_UNSET_VAR', tokenFile: file, token: 'inline' })
    assert.equal(tok, 'from-file-trimmed')
  })

  it('falls back to inline token when neither env nor file resolve', () => {
    const tok = resolveRancherToken({ tokenFile: join(tempDir, 'does-not-exist'), token: 'inline' })
    assert.equal(tok, 'inline')
  })

  it('returns undefined when no source resolves', () => {
    assert.equal(resolveRancherToken({}), undefined)
    assert.equal(resolveRancherToken({ tokenEnv: 'CHROXY_TEST_NONE' }), undefined)
  })

  it('ignores an empty env var value and falls through', () => {
    process.env.CHROXY_TEST_EMPTY = ''
    try {
      assert.equal(resolveRancherToken({ tokenEnv: 'CHROXY_TEST_EMPTY', token: 'inline' }), 'inline')
    } finally {
      delete process.env.CHROXY_TEST_EMPTY
    }
  })
})

// #5380 — validateRancherBlock makes a security promise (never echo the token
// value) and carries non-trivial gating + format-validation logic. It had no
// direct coverage; config-backend-selection only covered resolveRancherToken.
// Reached through validateConfig({ environments: { rancher } }).
describe('validateRancherBlock via validateConfig (#5380)', () => {
  const rancher = (extra) => validateConfig({ environments: { rancher: extra } })
  const rancherWarnings = (r) => r.warnings.filter((w) => /rancher/.test(w))

  it('never echoes the token value in a warning', () => {
    const token = 'kubeconfig-user-SUPERSECRET-abc123'
    // Valid token (string) but a malformed clusterId so a warning DOES fire —
    // and assert that warning never contains the token value.
    const r = rancher({ rancherUrl: 'https://rancher.example.com', clusterId: 'NOT-A-CLUSTER-ID', token })
    assert.ok(r.warnings.some((w) => /clusterId/.test(w)), 'malformed clusterId should warn')
    assert.ok(!r.warnings.some((w) => w.includes(token)), 'the token value must never be echoed in any warning')
  })

  it('configured-gate: a partial block (no token source) emits no rancher warnings', () => {
    // rancherUrl + clusterId but no token/tokenEnv/tokenFile → "not configured
    // yet" → only the top-level shape is checked, no format spam during setup.
    const r = rancher({ rancherUrl: 'https://rancher.example.com', clusterId: 'c-abcde' })
    assert.deepEqual(rancherWarnings(r), [], `expected no rancher warnings, got: ${JSON.stringify(rancherWarnings(r))}`)
  })

  it('a complete, valid block produces no rancher warnings', () => {
    const r = rancher({ rancherUrl: 'https://rancher.example.com', clusterId: 'c-abcde', token: 'tok' })
    assert.deepEqual(rancherWarnings(r), [], `valid block should not warn, got: ${JSON.stringify(rancherWarnings(r))}`)
  })

  it('warns on a non-http(s) rancherUrl', () => {
    const r = rancher({ rancherUrl: 'ftp://rancher.example.com', clusterId: 'c-abcde', token: 'tok' })
    assert.ok(r.warnings.some((w) => /rancherUrl.*http/.test(w)), `expected protocol warning, got: ${JSON.stringify(r.warnings)}`)
  })

  it('warns on a malformed clusterId (must be c-...)', () => {
    const r = rancher({ rancherUrl: 'https://rancher.example.com', clusterId: 'cluster-1', token: 'tok' })
    assert.ok(r.warnings.some((w) => /clusterId.*c-/.test(w)), `expected clusterId warning, got: ${JSON.stringify(r.warnings)}`)
  })

  it('warns on a malformed defaultProjectId (must be p-...)', () => {
    const r = rancher({ rancherUrl: 'https://rancher.example.com', clusterId: 'c-abcde', token: 'tok', defaultProjectId: 'project-x' })
    assert.ok(r.warnings.some((w) => /defaultProjectId.*p-/.test(w)), `expected projectId warning, got: ${JSON.stringify(r.warnings)}`)
  })

  it('warns when caData is a non-string', () => {
    const r = rancher({ rancherUrl: 'https://rancher.example.com', clusterId: 'c-abcde', token: 'tok', caData: 12345 })
    assert.ok(r.warnings.some((w) => /caData/.test(w)), `expected caData warning, got: ${JSON.stringify(r.warnings)}`)
  })
})
