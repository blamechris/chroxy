import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerKindCleanup } from '../k8s-roundtrip-cleanup.js'

const root = process.env.K8S_CLEANUP_FIXTURE_ROOT
const kubeconfigDir = join(root, 'kubeconfig')
mkdirSync(kubeconfigDir, { mode: 0o700 })
writeFileSync(join(kubeconfigDir, 'config'), 'fixture only', { mode: 0o600 })

const cleanup = registerKindCleanup({
  clusterName: 'fixture-cluster',
  sidecarImage: 'fixture-image',
  getKubeconfigDir: () => kubeconfigDir,
  run: (command, args, options) => {
    appendFileSync(join(root, 'commands'), `${command} ${args.join(' ')} timeout=${options.timeout}\n`)
    if (command === 'kind' && process.env.K8S_CLEANUP_FAIL_KIND === '1') {
      throw new Error('fixture kind failure')
    }
  },
})

if (process.env.K8S_CLEANUP_MANUAL === '1') {
  cleanup()
  cleanup()
  process.stdout.write('DONE\n')
} else {
  process.stdout.write('READY\n')
  setInterval(() => {}, 1_000)
}
