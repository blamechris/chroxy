/**
 * chroxy tunnel — Tunnel management commands
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { CloudflareTunnelAdapter } from '../tunnel/index.js'
import { writeFileRestricted } from '../platform.js'
import { configDir, configFile, prompt } from './shared.js'

/**
 * #7296 — writer-side check on the interactively-prompted tunnel name.
 *
 * The prompt is the ONLY producer of `config.tunnelName`, and that value later
 * lands in three bare positional slots (`tunnel create <name>`,
 * `tunnel route dns <name> <hostname>`, and `tunnel run … <name>` in
 * tunnel/cloudflare.js). Each of those argvs now carries a `--` separator, but
 * a partial guard is how this defect class survives — so the name is refused
 * at the writer as well, and can never be option-shaped in the first place.
 *
 * Cloudflare tunnel names are alphanumerics plus `.`, `_` and `-`; requiring
 * the FIRST character to be alphanumeric is what excludes the option shape.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidTunnelName(name) {
  return typeof name === 'string' &&
    name.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/**
 * argv for `cloudflared tunnel create <name>`, with option parsing terminated
 * immediately before the positional (#7296). Measured on cloudflared 2026.8.3
 * with a bogus `--origincert`: `tunnel create --help` prints help,
 * `tunnel create -- --help` does not.
 *
 * @param {string} tunnelName
 * @returns {string[]}
 */
export function cloudflaredCreateArgv(tunnelName) {
  return ['tunnel', 'create', '--', tunnelName]
}

/**
 * argv for `cloudflared tunnel route dns <name> <hostname>`, with option
 * parsing terminated immediately before the positionals (#7296).
 *
 * @param {string} tunnelName
 * @param {string} hostname
 * @returns {string[]}
 */
export function cloudflaredRouteDnsArgv(tunnelName, hostname) {
  return ['tunnel', 'route', 'dns', '--', tunnelName, hostname]
}

export function registerTunnelCommand(program) {
  const tunnelCmd = program
    .command('tunnel')
    .description('Manage tunnel configuration')

  tunnelCmd
    .command('setup')
    .description('Interactive Cloudflare Named Tunnel setup')
    .action(async () => {
      const binary = CloudflareTunnelAdapter.checkBinary()
      if (!binary.available) {
        console.error(`❌ cloudflared not found.${binary.hint ? ' ' + binary.hint : ''}`)
        process.exit(1)
      }

      await setupCloudflare()
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
  if (!isValidTunnelName(tunnelName)) {
    console.error(`\n❌ Invalid tunnel name: ${JSON.stringify(tunnelName.slice(0, 64))}`)
    console.error('   Use letters, digits, \'.\', \'_\' or \'-\', starting with a letter or digit.')
    process.exit(1)
  }

  try {
    execFileSync('cloudflared', cloudflaredCreateArgv(tunnelName), { stdio: 'inherit' })
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
    execFileSync('cloudflared', cloudflaredRouteDnsArgv(tunnelName, hostname), { stdio: 'inherit' })
  } catch {
    console.log('\nDNS route may already exist. Continuing...\n')
  }

  console.log('\nStep 4: Saving configuration\n')

  if (!existsSync(configDir())) {
    mkdirSync(configDir(), { recursive: true })
  }

  let config = {}
  if (existsSync(configFile())) {
    config = JSON.parse(readFileSync(configFile(), 'utf-8'))
  }

  config.tunnel = 'named'
  config.tunnelName = tunnelName
  config.tunnelHostname = hostname

  writeFileRestricted(configFile(), JSON.stringify(config, null, 2))

  console.log('✅ Configuration saved to:', configFile())
  console.log('')
  console.log('Your stable URLs:')
  console.log(`   HTTP:      https://${hostname}`)
  console.log(`   WebSocket: wss://${hostname}`)
  console.log('')
  console.log('Run \'chroxy start\' to launch with your Named Tunnel.')
  console.log('The QR code will always be the same — scan it once, connect forever.\n')
}
