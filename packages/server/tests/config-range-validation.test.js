import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

describe('validateConfig range validation', () => {
  it('warns when port is 0', () => {
    const result = validateConfig({ port: 0 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('1-65535')))
  })

  it('warns when port is negative', () => {
    const result = validateConfig({ port: -1 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('1-65535')))
  })

  it('warns when port exceeds 65535', () => {
    const result = validateConfig({ port: 70000 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('1-65535')))
  })

  it('accepts valid port numbers', () => {
    for (const port of [1, 80, 443, 8765, 65535]) {
      const result = validateConfig({ port })
      assert.equal(result.valid, true, `port ${port} should be valid`)
    }
  })

  it('warns when maxSessions is 0', () => {
    const result = validateConfig({ maxSessions: 0 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxSessions') && w.includes('>= 1')))
  })

  it('warns when maxSessions is negative', () => {
    const result = validateConfig({ maxSessions: -1 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxSessions') && w.includes('>= 1')))
  })

  it('accepts maxSessions >= 1', () => {
    for (const maxSessions of [1, 5, 100]) {
      const result = validateConfig({ maxSessions })
      assert.equal(result.valid, true, `maxSessions ${maxSessions} should be valid`)
    }
  })

  it('warns when sessionTimeout is too low (1ms parsed as "1" = 1s)', () => {
    // '1ms' is not parseable by parseDuration (no ms unit), so it returns null
    // But '1s' parses to 1000ms which is below 30s minimum
    const result = validateConfig({ sessionTimeout: '1s' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sessionTimeout') && w.includes('30s')))
  })

  it('warns when sessionTimeout is below 30 seconds', () => {
    const result = validateConfig({ sessionTimeout: '10s' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sessionTimeout') && w.includes('30s')))
  })

  it('warns when sessionTimeout is "1ms" (unparseable)', () => {
    // '1ms' doesn't match parseDuration patterns — warn about invalid format
    const result = validateConfig({ sessionTimeout: '1ms' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sessionTimeout')))
  })

  it('accepts valid sessionTimeout values', () => {
    for (const sessionTimeout of ['30s', '5m', '1h', '2h30m']) {
      const result = validateConfig({ sessionTimeout })
      assert.equal(result.valid, true, `sessionTimeout '${sessionTimeout}' should be valid`)
    }
  })

  it('warns when maxPayload is below 1KB (1024)', () => {
    const result = validateConfig({ maxPayload: 512 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxPayload') && w.includes('1KB')))
  })

  it('warns when maxPayload exceeds 100MB', () => {
    const result = validateConfig({ maxPayload: 200 * 1024 * 1024 })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('maxPayload') && w.includes('100MB')))
  })

  it('accepts valid maxPayload values', () => {
    for (const maxPayload of [1024, 64 * 1024, 1024 * 1024, 100 * 1024 * 1024]) {
      const result = validateConfig({ maxPayload })
      assert.equal(result.valid, true, `maxPayload ${maxPayload} should be valid`)
    }
  })

  it('valid config with all range-checked fields passes with no warnings', () => {
    const config = {
      port: 8765,
      maxSessions: 5,
      sessionTimeout: '30m',
      maxPayload: 64 * 1024,
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('skips range validation when type is wrong (type check catches it first)', () => {
    const result = validateConfig({ port: 'abc' })
    // Should have type warning but not range warning
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('expected number')))
    assert.ok(!result.warnings.some(w => w.includes('1-65535')))
  })
})

/**
 * #4556 — chroxy-config surface for K8sBackend's workspacePVC strategy.
 *
 * Validates `config.environments.k8s.workspace` at load time so the operator
 * sees errors at startup, not at first environment creation. The block is
 * optional; when present its shape mirrors `K8sBackend.validateWorkspacePVC()`
 * so the operator never sees one error message at startup and a different one
 * at create-time for the same malformed value.
 *
 * Schema:
 *   environments.k8s.workspace = {
 *     claimName: string (required, non-empty),
 *     mountPath: string (optional),
 *     readOnly:  boolean (optional),
 *   }
 *
 * Validation is purely additive — the field is optional, so a config without
 * the block (the common case for single-node Docker operators) passes
 * unchanged. The whole `environments` key already accepts arbitrary objects
 * (`'object'` in CONFIG_SCHEMA); these checks only fire when the workspace
 * sub-block is actually present.
 */
describe('validateConfig environments.k8s.workspace (#4556)', () => {
  it('accepts a valid workspace block with all fields', () => {
    const config = {
      environments: {
        k8s: {
          workspace: { claimName: 'shared-pvc', mountPath: '/workspace', readOnly: true },
        },
      },
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('accepts a workspace block with only claimName (other fields optional)', () => {
    const config = { environments: { k8s: { workspace: { claimName: 'minimal-pvc' } } } }
    const result = validateConfig(config)
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('warns when workspace.claimName is missing', () => {
    const config = { environments: { k8s: { workspace: { mountPath: '/workspace' } } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(
      result.warnings.some(w => /claimName/.test(w) && /required|non-empty/.test(w)),
      `expected claimName-required warning, got: ${result.warnings.join('; ')}`
    )
  })

  it('warns when workspace.claimName is an empty string', () => {
    const config = { environments: { k8s: { workspace: { claimName: '' } } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /claimName/.test(w) && /non-empty/.test(w)))
  })

  it('warns when workspace.claimName is not a string', () => {
    const config = { environments: { k8s: { workspace: { claimName: 42 } } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /claimName/.test(w) && /string/.test(w)))
  })

  it('warns when workspace.mountPath is not a string', () => {
    const config = { environments: { k8s: { workspace: { claimName: 'p', mountPath: 123 } } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /mountPath/.test(w) && /string/.test(w)))
  })

  it('warns when workspace.readOnly is not a boolean', () => {
    const config = { environments: { k8s: { workspace: { claimName: 'p', readOnly: 'yes' } } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /readOnly/.test(w) && /boolean/.test(w)))
  })

  it('warns when workspace is not an object', () => {
    const config = { environments: { k8s: { workspace: 'shared-pvc' } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /workspace/.test(w) && /object/.test(w)))
  })

  it('warns when workspace is an array (objects only, no array shorthand)', () => {
    const config = { environments: { k8s: { workspace: ['shared-pvc'] } } }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /workspace/.test(w) && /object/.test(w)))
  })

  it('passes when environments.k8s is present but workspace block is absent', () => {
    // Only the workspace sub-block is validated; other k8s fields are passed
    // through untouched (future K8s settings may live there too).
    const config = { environments: { k8s: { namespace: 'chroxy' } } }
    const result = validateConfig(config)
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('passes when environments.enabled is set without any k8s block (Docker operator)', () => {
    const config = { environments: { enabled: true } }
    const result = validateConfig(config)
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })
})

/**
 * #5144 — config-driven backend selection. Validates the `environments.backend`
 * selector and the `environments.k8s` connection sub-block (the `workspace`
 * sub-block is covered by the #4556 suite above).
 */
describe('validateConfig environments.backend (#5144)', () => {
  it('accepts docker', () => {
    const result = validateConfig({ environments: { backend: 'docker' } })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('accepts k8s', () => {
    const result = validateConfig({ environments: { backend: 'k8s' } })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('accepts rancher (without a configured rancher block — selector alone is fine)', () => {
    const result = validateConfig({ environments: { backend: 'rancher' } })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('warns on an unrecognised backend value', () => {
    const result = validateConfig({ environments: { backend: 'nomad' } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.backend/.test(w) && /nomad/.test(w)))
  })

  it('warns when backend is not a string', () => {
    const result = validateConfig({ environments: { backend: 123 } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.backend/.test(w) && /string/.test(w)))
  })

  it('passes when the backend key is absent (default path unchanged)', () => {
    const result = validateConfig({ environments: { enabled: true } })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })
})

describe('validateConfig environments.k8s connection block (#5144)', () => {
  it('accepts a full valid k8s block', () => {
    const config = {
      environments: {
        backend: 'k8s',
        k8s: {
          namespace: 'chroxy',
          inCluster: true,
          kubeconfigPath: '/home/user/.kube/config',
          sidecarImage: 'chroxy-pod-agent:latest',
          imagePullPolicy: 'IfNotPresent',
          connectMode: 'clusterip',
        },
      },
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('warns when namespace is not a string', () => {
    const result = validateConfig({ environments: { k8s: { namespace: 5 } } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.k8s\.namespace/.test(w) && /string/.test(w)))
  })

  it('warns when inCluster is not a boolean', () => {
    const result = validateConfig({ environments: { k8s: { inCluster: 'yes' } } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.k8s\.inCluster/.test(w) && /boolean/.test(w)))
  })

  it('warns on an invalid imagePullPolicy', () => {
    const result = validateConfig({ environments: { k8s: { imagePullPolicy: 'Sometimes' } } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /imagePullPolicy/.test(w) && /Sometimes/.test(w)))
  })

  it('warns on an invalid connectMode', () => {
    const result = validateConfig({ environments: { k8s: { connectMode: 'tunnel' } } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /connectMode/.test(w) && /tunnel/.test(w)))
  })

  it('passes when k8s block has only a workspace sub-block (other fields absent)', () => {
    const result = validateConfig({ environments: { k8s: { workspace: { claimName: 'pvc' } } } })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })
})

describe('validateConfig environments.rancher block (#5144)', () => {
  const fullRancher = {
    rancherUrl: 'https://rancher.example.com',
    clusterId: 'c-m-abc123',
    token: 'token-secret-xyz',
  }

  it('accepts a complete valid rancher block', () => {
    const result = validateConfig({ environments: { backend: 'rancher', rancher: { ...fullRancher } } })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('accepts an optional caData / skipTLSVerify / defaultProjectId', () => {
    const result = validateConfig({
      environments: {
        rancher: { ...fullRancher, caData: 'YmFzZTY0', skipTLSVerify: true, defaultProjectId: 'p-xyz' },
      },
    })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('treats a partial block (no token) as "not configured" — no warnings', () => {
    const result = validateConfig({
      environments: { rancher: { rancherUrl: 'https://rancher.example.com', clusterId: 'c-m-abc' } },
    })
    assert.equal(result.valid, true, `warnings: ${result.warnings.join('; ')}`)
  })

  it('warns on a malformed rancherUrl when the block is complete', () => {
    const result = validateConfig({
      environments: { rancher: { ...fullRancher, rancherUrl: 'not-a-url' } },
    })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.rancher\.rancherUrl/.test(w)))
  })

  it('warns on a non-http(s) rancherUrl protocol', () => {
    const result = validateConfig({
      environments: { rancher: { ...fullRancher, rancherUrl: 'ftp://rancher.example.com' } },
    })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.rancher\.rancherUrl/.test(w) && /http/.test(w)))
  })

  it('warns on a clusterId that does not match the Rancher format', () => {
    const result = validateConfig({
      environments: { rancher: { ...fullRancher, clusterId: 'bogus' } },
    })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.rancher\.clusterId/.test(w)))
  })

  it('warns on a malformed defaultProjectId', () => {
    const result = validateConfig({
      environments: { rancher: { ...fullRancher, defaultProjectId: 'bad' } },
    })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /defaultProjectId/.test(w)))
  })

  it('warns when caData is an empty string', () => {
    const result = validateConfig({
      environments: { rancher: { ...fullRancher, caData: '' } },
    })
    // empty caData means "configured? false" since token present but caData
    // empty -> still configured (url+cluster+token present). caData '' triggers.
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /caData/.test(w)))
  })

  it('warns when rancher is not an object', () => {
    const result = validateConfig({ environments: { rancher: 'https://rancher.example.com' } })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => /environments\.rancher/.test(w) && /object/.test(w)))
  })

  it('never echoes the token value in a warning', () => {
    const result = validateConfig({
      environments: { rancher: { ...fullRancher, clusterId: 'bogus' } },
    })
    assert.ok(!result.warnings.some(w => w.includes('token-secret-xyz')))
  })
})
