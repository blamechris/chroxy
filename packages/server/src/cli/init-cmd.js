/**
 * chroxy init — Set up configuration
 */
import { existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { CONFIG_DIR, CONFIG_FILE, prompt } from './shared.js'
import { defaultShell, writeFileRestricted } from '../platform.js'

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Initialize Chroxy configuration')
    .option('-f, --force', 'Overwrite existing configuration')
    .action(async (options) => {
      console.log('\n🔧 Chroxy Setup\n')

      if (existsSync(CONFIG_FILE) && !options.force) {
        console.log(`Config already exists at ${CONFIG_FILE}`)
        const overwrite = await prompt('Overwrite? (y/N): ')
        if (overwrite.toLowerCase() !== 'y') {
          console.log('Keeping existing config. Use --force to overwrite.')
          process.exit(0)
        }
      }

      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true })
      }

      console.log('We need a few things to get started:\n')

      const apiToken = randomBytes(32).toString('base64url')

      console.log('1. Local WebSocket port')
      const portInput = await prompt('   Port (default 8765): ')
      const port = parseInt(portInput, 10) || 8765

      const config = {
        apiToken,
        port,
        shell: defaultShell(),
      }

      writeFileRestricted(CONFIG_FILE, JSON.stringify(config, null, 2))

      console.log('\n✅ Configuration saved to:', CONFIG_FILE)
      console.log('\n📱 Your API token (keep this secret):')
      console.log(`   ${apiToken}`)
      console.log('\n🚀 Run \'npx chroxy start\' to launch the server')
      console.log('')
    })
}
