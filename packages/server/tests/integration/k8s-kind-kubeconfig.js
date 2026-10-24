import { execFileSync } from 'node:child_process'
import { KubeConfig } from '@kubernetes/client-node'

/** Return the complete kubeconfig for the cluster this suite just created. */
export function loadNamedKindKubeconfig(clusterName, run = execFileSync) {
  const config = run('kind', ['get', 'kubeconfig', '--name', clusterName], {
    encoding: 'utf8', timeout: 10_000,
  })
  const kc = new KubeConfig()
  kc.loadFromString(config)
  const context = `kind-${clusterName}`
  if (kc.getCurrentContext() !== context) {
    throw new Error(`kind kubeconfig context must be ${context}, got ${kc.getCurrentContext() || '(none)'}`)
  }
  const cluster = kc.getCurrentCluster()
  if (cluster?.name !== context) {
    throw new Error(`kind kubeconfig cluster must be ${context}, got ${cluster?.name || '(none)'}`)
  }
  if (!cluster || new URL(cluster.server).protocol !== 'https:') {
    throw new Error(`kind kubeconfig must use an HTTPS API endpoint, got ${cluster?.server || '(none)'}`)
  }
  if (!cluster.caData && !cluster.caFile) {
    throw new Error('kind kubeconfig must include a certificate authority for TLS verification')
  }
  return config
}
