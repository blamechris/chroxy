// Bundled acceptance must not silently depend on a development server/proxy.
import { spawnSync } from 'node:child_process'

const result = spawnSync('lsof', ['-nP', '-iTCP:8081', '-sTCP:LISTEN'], {
  encoding: 'utf8', timeout: 5000
})
if (result.error || result.status !== 1 || result.stdout.trim() || result.stderr.trim()) {
  console.error('ERROR: Cannot establish that port 8081 has no Metro/proxy listener')
  process.exitCode = 1
} else {
  console.log('Verified no Metro/proxy listener on port 8081')
}
