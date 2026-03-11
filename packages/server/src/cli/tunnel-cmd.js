/**
 * chroxy tunnel — Tunnel management commands
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { getTunnel, listTunnels } from '../tunnel/registry.js'
import { writeFileRestricted } from '../platform.js'
import { CONFIG_DIR, CONFIG_FILE, prompt } from './shared.js'

export function registerTunnelCommand(program) {
  const tunnelCmd = program
    .command('tunnel')
    .description('Manage tunnel configuration')

  tunnelCmd
    .command('setup')
    .description('Interactive tunnel setup (defaults to Cloudflare)')
    .option('--provider <name>', 'Tunnel provider to set up (default: cloudflare)', 'cloudflare')
    .action(async (options) => {
      const providerName = options.provider

      await import('../tunnel/index.js')
      let TunnelAdapter
      try {
        TunnelAdapter = getTunnel(providerName)
      } catch (_err) {
        const available = listTunnels().map(t => t.name).join(', ')
        console.error(`❌ Unknown tunnel provider "${providerName}". Available: ${available}`)
        process.exit(1)
      }

      const binary = TunnelAdapter.checkBinary()
      if (!binary.available) {
        console.error(`❌ ${TunnelAdapter.capabilities.binaryName || providerName} not found.${binary.hint ? ' ' + binary.hint : ''}`)
        process.exit(1)
      }

      if (providerName === 'cloudflare') {
        await setupCloudflare()
      } else {
        await TunnelAdapter.setup({ prompt, configDir: CONFIG_DIR, configFile: CONFIG_FILE })
      }
    })
}

async function setupCloudflare() {
  const { execFileSync } = await import('child_process')

  console.log('\n🔧 Named Tunnel Setup\n')
  console.log('A Named Tunnel gives you a stable URL that never changes.')
  console.log('You need: a Cloudflare account + a domain on Cloudflare DNS.\n')

  console.log('Step 1: Authenticate with Cloudflare\n')
  console.log('This will open a browser window to log in to Cloudflare.')
  const loginAnswer = await prompt('Ready to login? (Y/n): ')
  if (loginAnswer.toLowerCase() === 'n') {
    console.log('\nRun \'cloudflared tunnel login\' manually when ready.')
    process.exit(0)
  }

  try {
    execFileSync('cloudflared', ['tunnel', 'login'], { stdio: 'inherit' })
  } catch (_err) {
    console.error('\n❌ Login failed. Run \'cloudflared tunnel login\' manually.')
    process.exit(1)
  }

  console.log('\n✅ Authenticated with Cloudflare\n')

  console.log('Step 2: Create a tunnel\n')
  const tunnelName = (await prompt('Tunnel name (default \'chroxy\'): ')) || 'chroxy'

  try {
    execFileSync('cloudflared', ['tunnel', 'create', tunnelName], { stdio: 'inherit' })
  } catch {
    console.log(`\nTunnel '${tunnelName}' may already exist. Continuing...\n`)
  }

  console.log('\nStep 3: Set up DNS route\n')
  console.log('Enter the hostname you want to use (e.g., chroxy.example.com).')
  console.log('The domain must be on Cloudflare DNS.\n')
  const hostname = await prompt('Hostname: ')
  if (!hostname) {
    console.error('❌ Hostname is required.')
    process.exit(1)
  }

  try {
    execFileSync('cloudflared', ['tunnel', 'route', 'dns', tunnelName, hostname], { stdio: 'inherit' })
  } catch {
    console.log('\nDNS route may already exist. Continuing...\n')
  }

  console.log('\nStep 4: Saving configuration\n')

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }

  let config = {}
  if (existsSync(CONFIG_FILE)) {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }

  config.tunnel = 'named'
  config.tunnelName = tunnelName
  config.tunnelHostname = hostname

  writeFileRestricted(CONFIG_FILE, JSON.stringify(config, null, 2))

  console.log('✅ Configuration saved to:', CONFIG_FILE)
  console.log('')
  console.log('Your stable URLs:')
  console.log(`   HTTP:      https://${hostname}`)
  console.log(`   WebSocket: wss://${hostname}`)
  console.log('')
  console.log('Run \'npx chroxy start\' to launch with your Named Tunnel.')
  console.log('The QR code will always be the same — scan it once, connect forever.\n')
}
