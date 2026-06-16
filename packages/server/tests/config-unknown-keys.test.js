import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

/**
 * #5878 (audit P2-6 part 2): validateConfig now warns on unrecognised keys in
 * the k8s / billing / worktreeGc / rancher blocks (mirroring the existing
 * notifications.discord typo-catch), so `billing.creditTeir`,
 * `worktreeGc.autoRepa`, `k8s.imagePulPolicy`, `rancher.clustreId` surface a
 * NON-FATAL warning instead of being silently dropped.
 *
 * The known-key sets were verified against the consumers (K8sBackend wiring +
 * the workspace sub-block, billing-budget/canary, worktree-reaper, rancher.js),
 * so the "every real key accepted" assertions are the regression guard against a
 * too-narrow set false-warning on a working config.
 */

function warningsFor(config, includes) {
  return validateConfig(config).warnings.filter((w) => w.includes(includes))
}

describe('validateConfig — unknown-key typo-catch (#5878)', () => {
  describe('environments.k8s', () => {
    it('warns on a typo and uses non-fatal "Invalid value … unknown key" wording', () => {
      const ws = warningsFor({ environments: { k8s: { imagePulPolicy: 'Always' } } }, 'environments.k8s.imagePulPolicy')
      assert.equal(ws.length, 1)
      assert.match(ws[0], /^Invalid value for 'environments\.k8s\.imagePulPolicy': unknown key/)
      assert.doesNotMatch(ws[0], /Invalid type/)
    })

    it('accepts every real key without an unknown-key warning (incl. workspace + quota blocks)', () => {
      const cfg = {
        environments: {
          k8s: {
            namespace: 'ns', inCluster: true, kubeconfigPath: '/k', sidecarImage: 'img:1',
            imagePullPolicy: 'IfNotPresent', connectMode: 'portforward',
            namespaceQuota: { hard: {} }, namespaceLimitRange: { default: {} },
            workspace: { claimName: 'pvc-1', mountPath: '/w', readOnly: true },
          },
        },
      }
      const unknown = validateConfig(cfg).warnings.filter((w) => w.includes('unknown key') && w.includes('environments.k8s'))
      assert.deepEqual(unknown, [], 'no real k8s key should warn as unknown')
    })
  })

  describe('billing', () => {
    it('warns on a typo (creditTeir)', () => {
      const ws = warningsFor({ billing: { creditTeir: 'pro' } }, 'billing.creditTeir')
      assert.equal(ws.length, 1)
      assert.match(ws[0], /unknown key/)
    })

    it('accepts every real key (incl. egressCheck / datacenterPrefixes)', () => {
      const cfg = {
        billing: {
          creditTier: 'max5x', monthlyCreditBudgetUsd: 50, budgetWarningPercent: 75,
          egressCheck: true, datacenterPrefixes: ['1.2.3.0/24'],
        },
      }
      const unknown = validateConfig(cfg).warnings.filter((w) => w.includes('unknown key') && w.includes('billing.'))
      assert.deepEqual(unknown, [])
    })
  })

  describe('worktreeGc', () => {
    it('warns on a typo (autoRepa)', () => {
      const ws = warningsFor({ worktreeGc: { autoRepa: true } }, 'worktreeGc.autoRepa')
      assert.equal(ws.length, 1)
      assert.match(ws[0], /unknown key/)
    })

    it('accepts every real key (autoReap / reapIntervalMs / maxLockAgeMs)', () => {
      const cfg = { worktreeGc: { autoReap: true, reapIntervalMs: 60000, maxLockAgeMs: 0 } }
      const unknown = validateConfig(cfg).warnings.filter((w) => w.includes('unknown key') && w.includes('worktreeGc.'))
      assert.deepEqual(unknown, [])
    })
  })

  describe('environments.rancher', () => {
    it('warns on a typo even in a half-filled (not-yet-configured) block', () => {
      // No token source → "not configured" gate; the unknown-key check still runs.
      const ws = warningsFor({ environments: { rancher: { clustreId: 'c-abc' } } }, 'environments.rancher.clustreId')
      assert.equal(ws.length, 1)
      assert.match(ws[0], /unknown key/)
    })

    it('accepts every real key (all 8 connection/token fields)', () => {
      const cfg = {
        environments: {
          rancher: {
            rancherUrl: 'https://rancher.example.com', clusterId: 'c-abc123',
            token: 'tok', tokenEnv: 'RANCHER_TOKEN', tokenFile: '/run/tok',
            caData: 'YWJj', skipTLSVerify: false, defaultProjectId: 'p-xyz789',
          },
        },
      }
      const unknown = validateConfig(cfg).warnings.filter((w) => w.includes('unknown key') && w.includes('environments.rancher'))
      assert.deepEqual(unknown, [])
    })
  })

  it('a cosmetic typo in any block never throws (non-fatal)', () => {
    assert.doesNotThrow(() => validateConfig({
      billing: { creditTeir: 'x' },
      worktreeGc: { autoRepa: true },
      environments: { k8s: { imagePulPolicy: 'x' }, rancher: { clustreId: 'c-1' } },
    }))
  })
})
