/**
 * chroxy update — Check for available updates
 */
import { createRequire } from 'module'
import { isNewer } from '../semver.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

export function registerUpdateCommand(program) {
  program
    .command('update')
    .description('Check for available updates')
    .action(async () => {
      try {
        const res = await fetch('https://api.github.com/repos/blamechris/chroxy/releases/latest', {
          headers: { 'User-Agent': 'chroxy-cli' },
        })
        if (!res.ok) {
          console.error('Failed to check for updates:', res.statusText)
          process.exit(1)
        }
        const release = await res.json()
        const latest = release.tag_name.replace(/^v/, '')
        const current = version

        if (!isNewer(latest, current)) {
          console.log(`\nChroxy v${current} is up to date.\n`)
        } else {
          console.log(`\nUpdate available: v${current} → v${latest}`)
          console.log(`\nRelease: ${release.html_url}`)
          console.log('\nTo update (git clone):')
          console.log('  git pull && npm ci\n')

          const dmg = release.assets?.find(a => a.name.endsWith('.dmg'))
          if (dmg) {
            console.log(`Desktop app: ${dmg.browser_download_url}\n`)
          }
        }
      } catch (err) {
        console.error('Failed to check for updates:', err.message)
        process.exit(1)
      }
    })
}
