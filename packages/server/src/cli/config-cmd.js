/**
 * chroxy config — Show current configuration
 */
import { existsSync, readFileSync } from 'fs'
import { CONFIG_FILE } from './shared.js'

export function registerConfigCommand(program) {
  program
    .command('config')
    .description('Show current configuration')
    .action(() => {
      if (!existsSync(CONFIG_FILE)) {
        console.log('No config found. Run \'npx chroxy init\' first.')
        process.exit(1)
      }

      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))

      console.log('\n📋 Current Configuration\n')
      console.log(`   Config file: ${CONFIG_FILE}`)
      console.log(`   Port: ${config.port}`)
      const tunnelMode = config.tunnel || 'quick'
      if (tunnelMode === 'named') {
        console.log(`   Tunnel: Named (${config.tunnelName || '?'} -> ${config.tunnelHostname || '?'})`)
      } else if (tunnelMode === 'none') {
        console.log(`   Tunnel: None (local only)`)
      } else {
        console.log(`   Tunnel: Quick (random URL)`)
      }
      console.log(`   API token: ${config.apiToken}`)
      console.log('\nNote: CLI flags and environment variables can override these values.')
      console.log('Run \'npx chroxy start --verbose\' to see full config resolution.\n')
    })
}
