import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { constants } from 'node:os'

/** Register one bounded cleanup path for normal completion and interruption. */
export function registerKindCleanup({ clusterName, sidecarImage, getKubeconfigDir, run = execFileSync }) {
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true

    // Deleting the cluster also removes any Pod and Secret left by a failed
    // case. Every operation is bounded and independent so one failure cannot
    // leave the temporary kubeconfig behind.
    try {
      run('kind', ['delete', 'cluster', '--name', clusterName], {
        stdio: 'pipe', timeout: 60_000,
      })
      console.log(`[k8s-integration] Deleted cluster ${clusterName}`)
    } catch (err) {
      console.warn(`[k8s-integration] Warning: cluster delete failed: ${err.message}`)
    }

    const kubeconfigDir = getKubeconfigDir()
    if (kubeconfigDir) {
      try {
        rmSync(kubeconfigDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[k8s-integration] Warning: temporary kubeconfig cleanup failed: ${err.message}`)
      }
    }

    try {
      run('docker', ['rmi', sidecarImage], { stdio: 'pipe', timeout: 10_000 })
    } catch {
      // Image may not have been built or may already be gone.
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n[k8s-integration] ${signal} — cleaning up before exit`)
      cleanup()
      process.exit(128 + constants.signals[signal])
    })
  }

  return cleanup
}
