#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import readline from 'readline'
import { validateConfig, mergeConfig } from './config.js'

const CONFIG_DIR = join(homedir(), '.chroxy')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const program = new Command()

program
  .name('chroxy')
  .description('Remote terminal for Claude Code from your phone')
  .version('0.1.0')

/**
 * Interactive prompt helper
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * chroxy init — Set up configuration
 */
program
  .command('init')
  .description('Initialize Chroxy configuration')
  .option('-f, --force', 'Overwrite existing configuration')
  .action(async (options) => {
    console.log('\n🔧 Chroxy Setup\n')

    // Check for existing config
    if (existsSync(CONFIG_FILE) && !options.force) {
      console.log(`Config already exists at ${CONFIG_FILE}`)
      const overwrite = await prompt('Overwrite? (y/N): ')
      if (overwrite.toLowerCase() !== 'y') {
        console.log('Keeping existing config. Use --force to overwrite.')
        process.exit(0)
      }
    }

    // Create config directory
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    // Gather configuration
    console.log('We need a few things to get started:\n')

    // Generate API token
    const apiToken = randomUUID()

    // Port
    console.log('1. Local WebSocket port')
    const portInput = await prompt('   Port (default 8765): ')
    const port = parseInt(portInput, 10) || 8765

    // tmux session name (only used with --terminal flag)
    console.log('\n2. tmux session name (only for --terminal mode)')
    const sessionName = (await prompt('   Session (default \'claude-code\'): ')) || 'claude-code'

    // Build config
    const config = {
      apiToken,
      port,
      tmuxSession: sessionName,
      shell: process.env.SHELL || '/bin/zsh',
    }

    // Write config
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

    console.log('\n✅ Configuration saved to:', CONFIG_FILE)
    console.log('\n📱 Your API token (keep this secret):')
    console.log(`   ${apiToken}`)
    console.log('\n🚀 Run \'npx chroxy start\' to launch the server')
    console.log('')
  })

/**
 * chroxy start — Launch the server
 *
 * Configuration precedence (highest to lowest):
 * 1. CLI flags (--port, --model, etc.)
 * 2. Environment variables (PORT, API_TOKEN, etc.)
 * 3. Config file (~/.chroxy/config.json)
 * 4. Defaults
 *
 * Default: CLI headless mode (claude -p, no tmux/PTY needed)
 * --terminal: Legacy PTY/tmux mode (requires node-pty + tmux)
 */
program
  .command('start')
  .description('Start the Chroxy server')
  .option('-c, --config <path>', 'Path to config file', CONFIG_FILE)
  .option('-t, --terminal', 'Use PTY/tmux mode instead of CLI headless mode')
  .option('-r, --resume', 'Resume an existing Claude Code session instead of starting fresh')
  .option('--cwd <path>', 'Working directory for Claude (CLI mode)')
  .option('--model <model>', 'Model to use (CLI mode)')
  .option('--allowed-tools <tools>', 'Comma-separated tools to auto-approve (CLI mode)')
  .option('--discovery-interval <seconds>', 'Auto-discovery polling interval in seconds (PTY mode)')
  .option('--tunnel <mode>', 'Tunnel mode: quick (default), named, or none')
  .option('--tunnel-name <name>', 'Named tunnel name (requires cloudflared login)')
  .option('--tunnel-hostname <host>', 'Named tunnel hostname (e.g., chroxy.example.com)')
  .option('--no-auth', 'Skip API token requirement (local testing only, disables tunnel)')
  .option('--no-supervisor', 'Disable supervisor mode (direct server, no auto-restart)')
  .option('-v, --verbose', 'Show detailed config sources and validation info')
  .action(async (options) => {
    // Load config file
    let fileConfig = {}
    if (existsSync(options.config)) {
      fileConfig = JSON.parse(readFileSync(options.config, 'utf-8'))
    } else if (options.config !== CONFIG_FILE) {
      // User specified a custom config path that doesn't exist
      console.error(`❌ Config file not found: ${options.config}`)
      process.exit(1)
    } else {
      // Default config path doesn't exist
      console.error('❌ No config found. Run \'npx chroxy init\' first.')
      process.exit(1)
    }

    // Validate file config
    validateConfig(fileConfig, options.verbose)

    // Build CLI overrides from command-line flags
    const cliOverrides = {}
    if (options.terminal !== undefined) cliOverrides.terminal = options.terminal
    if (options.resume !== undefined) cliOverrides.resume = options.resume
    if (options.cwd !== undefined) cliOverrides.cwd = options.cwd
    if (options.model !== undefined) cliOverrides.model = options.model
    if (options.allowedTools !== undefined) {
      cliOverrides.allowedTools = options.allowedTools.split(',').map((t) => t.trim())
    }
    if (options.discoveryInterval !== undefined) {
      cliOverrides.discoveryInterval = parseInt(options.discoveryInterval, 10)
    }
    if (options.tunnel !== undefined) cliOverrides.tunnel = options.tunnel
    if (options.tunnelName !== undefined) cliOverrides.tunnelName = options.tunnelName
    if (options.tunnelHostname !== undefined) cliOverrides.tunnelHostname = options.tunnelHostname
    if (options.auth === false) cliOverrides.noAuth = true

    // Define defaults
    const defaults = {
      port: 8765,
      tmuxSession: 'claude-code',
      shell: process.env.SHELL || '/bin/zsh',
      resume: false,
      noAuth: false,
    }

    // Merge config with proper precedence: CLI > ENV > file > defaults
    const config = mergeConfig({
      fileConfig,
      cliOverrides,
      defaults,
      verbose: options.verbose,
    })

    // Validate merged config
    const validation = validateConfig(config, options.verbose)
    if (!validation.valid && options.verbose) {
      console.log('[config] Continuing despite warnings...\n')
    }

    // Set environment variables for backward compatibility with server code
    if (config.apiToken) process.env.API_TOKEN = config.apiToken
    if (config.port) process.env.PORT = String(config.port)
    if (config.tmuxSession) process.env.TMUX_SESSION = config.tmuxSession
    if (config.shell) process.env.SHELL_CMD = config.shell

    // Determine if supervisor should be used
    const tunnelMode = config.tunnel || 'quick'
    const useSupervisor = tunnelMode === 'named'
      && !config.terminal
      && !config.noAuth
      && options.supervisor !== false
      && process.env.CHROXY_SUPERVISED !== '1'

    // Launch appropriate server mode
    if (config.terminal) {
      // Legacy PTY/tmux mode — --no-auth is not supported
      if (config.noAuth) {
        console.error('❌ --no-auth is only supported in CLI headless mode (remove --terminal).')
        process.exit(1)
      }
      const { startServer } = await import('./server.js')
      await startServer(config)
    } else if (useSupervisor) {
      // Named tunnel with supervisor: auto-restart server child on crash
      const { startSupervisor } = await import('./supervisor.js')
      await startSupervisor(config)
    } else {
      // Default: CLI headless mode (direct, no supervisor)
      const { startCliServer } = await import('./server-cli.js')
      await startCliServer(config)
    }
  })

/**
 * chroxy config — Show current configuration
 */
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
    console.log(`   tmux session: ${config.tmuxSession}`)
    const tunnelMode = config.tunnel || 'quick'
    if (tunnelMode === 'named') {
      console.log(`   Tunnel: Named (${config.tunnelName || '?'} -> ${config.tunnelHostname || '?'})`)
    } else if (tunnelMode === 'none') {
      console.log(`   Tunnel: None (local only)`)
    } else {
      console.log(`   Tunnel: Quick (random URL)`)
    }
    console.log(`   API token: ${config.apiToken.slice(0, 8)}...`)
    console.log('\nNote: CLI flags and environment variables can override these values.')
    console.log('Run \'npx chroxy start --verbose\' to see full config resolution.\n')
  })

/**
 * chroxy tunnel setup — Interactive guided setup for Named Tunnels
 */
const tunnelCmd = program
  .command('tunnel')
  .description('Manage Cloudflare tunnel configuration')

tunnelCmd
  .command('setup')
  .description('Set up a Named Tunnel for stable URLs')
  .action(async () => {
    console.log('\n🔧 Named Tunnel Setup\n')
    console.log('A Named Tunnel gives you a stable URL that never changes.')
    console.log('You need: a Cloudflare account + a domain on Cloudflare DNS.\n')

    // Check cloudflared is installed
    const { execSync } = await import('child_process')
    try {
      execSync('cloudflared --version', { stdio: 'pipe' })
    } catch {
      console.error('❌ cloudflared not found. Install with: brew install cloudflared')
      process.exit(1)
    }

    // Step 1: Login
    console.log('Step 1: Authenticate with Cloudflare\n')
    console.log('This will open a browser window to log in to Cloudflare.')
    const loginAnswer = await prompt('Ready to login? (Y/n): ')
    if (loginAnswer.toLowerCase() === 'n') {
      console.log('\nRun \'cloudflared tunnel login\' manually when ready.')
      process.exit(0)
    }

    try {
      execSync('cloudflared tunnel login', { stdio: 'inherit' })
    } catch (err) {
      console.error('\n❌ Login failed. Run \'cloudflared tunnel login\' manually.')
      process.exit(1)
    }

    console.log('\n✅ Authenticated with Cloudflare\n')

    // Step 2: Create tunnel
    console.log('Step 2: Create a tunnel\n')
    const tunnelName = (await prompt('Tunnel name (default \'chroxy\'): ')) || 'chroxy'

    try {
      execSync(`cloudflared tunnel create ${tunnelName}`, { stdio: 'inherit' })
    } catch {
      // Tunnel might already exist — try to continue
      console.log(`\nTunnel '${tunnelName}' may already exist. Continuing...\n`)
    }

    // Step 3: DNS route
    console.log('\nStep 3: Set up DNS route\n')
    console.log('Enter the hostname you want to use (e.g., chroxy.example.com).')
    console.log('The domain must be on Cloudflare DNS.\n')
    const hostname = await prompt('Hostname: ')
    if (!hostname) {
      console.error('❌ Hostname is required.')
      process.exit(1)
    }

    try {
      execSync(`cloudflared tunnel route dns ${tunnelName} ${hostname}`, { stdio: 'inherit' })
    } catch {
      console.log('\nDNS route may already exist. Continuing...\n')
    }

    // Step 4: Save to config
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

    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

    console.log('✅ Configuration saved to:', CONFIG_FILE)
    console.log('')
    console.log('Your stable URLs:')
    console.log(`   HTTP:      https://${hostname}`)
    console.log(`   WebSocket: wss://${hostname}`)
    console.log('')
    console.log('Run \'npx chroxy start\' to launch with your Named Tunnel.')
    console.log('The QR code will always be the same — scan it once, connect forever.\n')
  })

/**
 * chroxy wrap — Create a discoverable tmux session running Claude Code
 */
program
  .command('wrap')
  .description('Create a tmux session running Claude Code (discoverable by chroxy start)')
  .requiredOption('-n, --name <name>', 'Session name (alphanumeric, hyphens, underscores)')
  .option('--cwd <path>', 'Working directory for Claude', process.cwd())
  .action(async (options) => {
    const { execSync } = await import('child_process')
    const { existsSync, statSync } = await import('fs')
    const { resolve } = await import('path')

    const name = options.name

    // Validate name: alphanumeric, hyphens, underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      console.error('Error: Session name must contain only letters, numbers, hyphens, and underscores.')
      process.exit(1)
    }

    // Check tmux is installed
    try {
      execSync('which tmux', { stdio: 'pipe' })
    } catch {
      console.error('Error: tmux is not installed. Install with: brew install tmux')
      process.exit(1)
    }

    const sessionName = `chroxy-${name}`

    // Check session doesn't already exist
    try {
      execSync(`tmux has-session -t ${sessionName}`, { stdio: 'pipe' })
      console.error(`Error: tmux session '${sessionName}' already exists.`)
      console.error(`  Attach to it:  tmux attach -t ${sessionName}`)
      console.error(`  Or kill it:    tmux kill-session -t ${sessionName}`)
      process.exit(1)
    } catch {
      // Session doesn't exist — good, we can create it
    }

    // Resolve and validate cwd
    const cwd = resolve(options.cwd)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      console.error(`Error: Directory does not exist: ${cwd}`)
      process.exit(1)
    }

    // Create tmux session and launch Claude
    execSync(`tmux new-session -d -s ${sessionName} -c ${JSON.stringify(cwd)}`)
    execSync(`tmux send-keys -t ${sessionName} "claude" Enter`)

    console.log(`\nSession '${sessionName}' created in ${cwd}`)
    console.log(`Claude Code is starting inside the tmux session.\n`)
    console.log(`  Attach to it:  tmux attach -t ${sessionName}`)
    console.log(`  Kill it:       tmux kill-session -t ${sessionName}`)
    console.log(`\nRun 'npx chroxy start' to connect from your phone.`)
    console.log(`The session will be auto-discovered.\n`)
  })

program.parse()
