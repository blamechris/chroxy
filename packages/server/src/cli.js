#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import readline from 'readline'
import { validateConfig, mergeConfig } from './config.js'
import { isWindows, defaultShell, writeFileRestricted } from './platform.js'
import { parseTunnelArg, getTunnel, listTunnels } from './tunnel/registry.js'

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
      shell: defaultShell(),
    }

    // Write config with restricted permissions
    writeFileRestricted(CONFIG_FILE, JSON.stringify(config, null, 2))

    console.log('\n✅ Configuration saved to:', CONFIG_FILE)
    console.log('\n📱 Your API token (keep this secret):')
    console.log(`   ${apiToken}`)
    console.log('\n🚀 Run \'npx chroxy start\' to launch the server')
    console.log('')
  })

/**
 * Load config file, build CLI overrides, merge, validate, and set env vars.
 * Shared between `chroxy start` and `chroxy dev` commands.
 *
 * @param {object} options - Commander options object
 * @param {object} [extraOverrides] - Additional CLI overrides (e.g. terminal, discoveryInterval)
 * @returns {object} Merged and validated config
 */
function loadAndMergeConfig(options, extraOverrides = {}) {
  // Load config file
  let fileConfig = {}
  if (existsSync(options.config)) {
    try {
      fileConfig = JSON.parse(readFileSync(options.config, 'utf-8'))
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error(`❌ Config file contains invalid JSON: ${options.config}`)
        console.error(`   ${err.message}`)
        console.error(`   Fix the file or delete it and run 'npx chroxy init' to recreate.`)
        process.exit(1)
      }
      throw err
    }
  } else if (options.config !== CONFIG_FILE) {
    console.error(`❌ Config file not found: ${options.config}`)
    process.exit(1)
  } else {
    console.error('❌ No config found. Run \'npx chroxy init\' first.')
    process.exit(1)
  }

  validateConfig(fileConfig, options.verbose)

  // Build CLI overrides from common command-line flags
  const cliOverrides = { ...extraOverrides }
  if (options.resume !== undefined) cliOverrides.resume = options.resume
  if (options.cwd !== undefined) cliOverrides.cwd = options.cwd
  if (options.model !== undefined) cliOverrides.model = options.model
  if (options.allowedTools !== undefined) {
    cliOverrides.allowedTools = options.allowedTools.split(',').map((t) => t.trim())
  }
  if (options.maxRestarts !== undefined) {
    cliOverrides.maxRestarts = parseInt(options.maxRestarts, 10)
  }
  if (options.tunnel !== undefined) cliOverrides.tunnel = options.tunnel
  if (options.tunnelName !== undefined) cliOverrides.tunnelName = options.tunnelName
  if (options.tunnelHostname !== undefined) cliOverrides.tunnelHostname = options.tunnelHostname
  if (options.legacyCli) cliOverrides.legacyCli = true
  if (options.provider !== undefined) cliOverrides.provider = options.provider

  const defaults = {
    port: 8765,
    tmuxSession: 'claude-code',
    shell: defaultShell(),
    resume: false,
    noAuth: false,
  }

  const config = mergeConfig({
    fileConfig,
    cliOverrides,
    defaults,
    verbose: options.verbose,
  })

  const validation = validateConfig(config, options.verbose)
  if (!validation.valid) {
    // Type errors are fatal; unknown-key warnings are non-fatal
    const typeErrors = validation.warnings.filter(w => w.startsWith('Invalid type'))
    if (typeErrors.length > 0) {
      console.error('❌ Configuration has type errors:')
      for (const err of typeErrors) {
        console.error(`   ${err}`)
      }
      console.error('   Fix your config file or CLI flags and try again.')
      process.exit(1)
    }
  }

  // Set environment variables for backward compatibility with server code
  if (config.apiToken) process.env.API_TOKEN = config.apiToken
  if (config.port) process.env.PORT = String(config.port)
  if (config.tmuxSession) process.env.TMUX_SESSION = config.tmuxSession
  if (config.shell) process.env.SHELL_CMD = config.shell

  return config
}

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
  .option('-t, --terminal', '[DEPRECATED] Use PTY/tmux mode instead of CLI headless mode')
  .option('-r, --resume', '[DEPRECATED] Resume a PTY-mode session (PTY mode is deprecated)')
  .option('--cwd <path>', 'Working directory for Claude (CLI mode)')
  .option('--model <model>', 'Model to use (CLI mode)')
  .option('--allowed-tools <tools>', 'Comma-separated tools to auto-approve (CLI mode)')
  .option('--discovery-interval <seconds>', '[DEPRECATED] Auto-discovery polling interval in seconds (PTY mode)')
  .option('--max-restarts <count>', 'Max supervisor restart attempts before exit (default: 10)')
  .option('--tunnel <mode>', 'Tunnel: quick (default), named, none, or provider:mode (e.g., cloudflare:named)')
  .option('--tunnel-name <name>', 'Named tunnel name (requires cloudflared login)')
  .option('--tunnel-hostname <host>', 'Named tunnel hostname (e.g., chroxy.example.com)')
  .option('--no-auth', 'Skip API token requirement (local testing only, disables tunnel)')
  .option('--no-encrypt', 'Disable end-to-end encryption (dev/testing only)')
  .option('--no-discovery', '[DEPRECATED] Skip tmux auto-discovery (PTY mode only)')
  .option('--no-supervisor', 'Disable supervisor mode (direct server, no auto-restart)')
  .option('--legacy-cli', 'Use legacy CLI process mode instead of Agent SDK')
  .option('--provider <name>', 'Session provider to use (e.g. claude-sdk, claude-cli)')
  .option('--max-payload <bytes>', 'WebSocket max message size in bytes (default: 1048576)')
  .option('--max-tool-input <bytes>', 'Maximum tool input size in bytes (default: 262144)')
  .option('-v, --verbose', 'Show detailed config sources and validation info')
  .action(async (options) => {
    // Build start-specific overrides
    const extraOverrides = {}
    if (options.terminal !== undefined) extraOverrides.terminal = options.terminal
    if (options.maxPayload !== undefined) {
      const parsed = parseInt(options.maxPayload, 10)
      extraOverrides.maxPayload = Number.isNaN(parsed) ? options.maxPayload : parsed
    }
    if (options.maxToolInput !== undefined) {
      const parsed = parseInt(options.maxToolInput, 10)
      extraOverrides.maxToolInput = Number.isNaN(parsed) ? options.maxToolInput : parsed
    }
    if (options.discoveryInterval !== undefined) {
      const parsed = parseInt(options.discoveryInterval, 10)
      extraOverrides.discoveryInterval = Number.isNaN(parsed) ? options.discoveryInterval : parsed
    }
    if (options.auth === false) extraOverrides.noAuth = true
    if (options.discovery === false) extraOverrides.noDiscovery = true
    if (options.encrypt === false) extraOverrides.noEncrypt = true

    const config = loadAndMergeConfig(options, extraOverrides)

    // Deprecation warning for PTY/tmux mode
    if (config.terminal) {
      console.warn('⚠️  PTY/tmux mode (--terminal) is deprecated and will be removed in a future release.')
      console.warn('   The default CLI headless mode is recommended for all new usage.')
      console.warn('   See: https://github.com/blamechris/chroxy#server-modes')
    }
    if (config.resume) {
      console.warn('⚠️  --resume is deprecated (PTY mode only). Use the default CLI headless mode.')
    }
    if (config.noDiscovery) {
      console.warn('⚠️  --no-discovery is deprecated (PTY mode only). Use the default CLI headless mode.')
    }

    // Block PTY/tmux mode on Windows
    if (isWindows && config.terminal) {
      console.error('PTY/tmux mode (--terminal) is not supported on Windows.')
      console.error('Use the default CLI headless mode instead: npx chroxy start')
      process.exit(1)
    }

    // Determine if supervisor should be used
    const parsedTunnel = parseTunnelArg(config.tunnel || 'quick')
    const isNamedTunnel = parsedTunnel && parsedTunnel.mode === 'named'
    const useSupervisor = isNamedTunnel
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
  .description('Manage tunnel configuration')

tunnelCmd
  .command('setup')
  .description('Interactive tunnel setup (defaults to Cloudflare)')
  .option('--provider <name>', 'Tunnel provider to set up (default: cloudflare)', 'cloudflare')
  .action(async (options) => {
    const providerName = options.provider

    // Validate provider exists in registry (import triggers registration)
    await import('./tunnel/index.js')
    let TunnelAdapter
    try {
      TunnelAdapter = getTunnel(providerName)
    } catch (err) {
      const available = listTunnels().map(t => t.name).join(', ')
      console.error(`❌ Unknown tunnel provider "${providerName}". Available: ${available}`)
      process.exit(1)
    }

    // Check binary availability via adapter
    const binary = TunnelAdapter.checkBinary()
    if (!binary.available) {
      console.error(`❌ ${TunnelAdapter.capabilities.binaryName || providerName} not found.${binary.hint ? ' ' + binary.hint : ''}`)
      process.exit(1)
    }

    // Delegate to provider-specific setup
    if (providerName === 'cloudflare') {
      await _setupCloudflare()
    } else {
      // Future providers implement static setup() on their adapter class
      await TunnelAdapter.setup({ prompt, configDir: CONFIG_DIR, configFile: CONFIG_FILE })
    }
  })

/**
 * Cloudflare-specific interactive setup flow.
 * Extracted from the inline action for reuse via the adapter registry.
 */
async function _setupCloudflare() {
  const { execFileSync } = await import('child_process')

  console.log('\n🔧 Named Tunnel Setup\n')
  console.log('A Named Tunnel gives you a stable URL that never changes.')
  console.log('You need: a Cloudflare account + a domain on Cloudflare DNS.\n')

  // Step 1: Login
  console.log('Step 1: Authenticate with Cloudflare\n')
  console.log('This will open a browser window to log in to Cloudflare.')
  const loginAnswer = await prompt('Ready to login? (Y/n): ')
  if (loginAnswer.toLowerCase() === 'n') {
    console.log('\nRun \'cloudflared tunnel login\' manually when ready.')
    process.exit(0)
  }

  try {
    execFileSync('cloudflared', ['tunnel', 'login'], { stdio: 'inherit' })
  } catch (err) {
    console.error('\n❌ Login failed. Run \'cloudflared tunnel login\' manually.')
    process.exit(1)
  }

  console.log('\n✅ Authenticated with Cloudflare\n')

  // Step 2: Create tunnel
  console.log('Step 2: Create a tunnel\n')
  const tunnelName = (await prompt('Tunnel name (default \'chroxy\'): ')) || 'chroxy'

  try {
    execFileSync('cloudflared', ['tunnel', 'create', tunnelName], { stdio: 'inherit' })
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
    execFileSync('cloudflared', ['tunnel', 'route', 'dns', tunnelName, hostname], { stdio: 'inherit' })
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

/**
 * chroxy wrap — Create a discoverable tmux session running Claude Code
 */
program
  .command('wrap')
  .description('Create a tmux session running Claude Code (discoverable by chroxy start)')
  .requiredOption('-n, --name <name>', 'Session name (alphanumeric, hyphens, underscores)')
  .option('--cwd <path>', 'Working directory for Claude', process.cwd())
  .action(async (options) => {
    const { execFileSync } = await import('child_process')
    const { existsSync, statSync } = await import('fs')
    const { resolve } = await import('path')

    const name = options.name

    // Validate name: alphanumeric, hyphens, underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      console.error('❌ Session name must contain only letters, numbers, hyphens, and underscores.')
      process.exit(1)
    }

    // Check tmux is installed
    try {
      execFileSync('which', ['tmux'], { stdio: 'pipe' })
    } catch {
      console.error('❌ tmux is not installed. Install it with your system package manager.')
      process.exit(1)
    }

    const sessionName = `chroxy-${name}`

    // Check session doesn't already exist
    try {
      execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'pipe' })
      console.error(`❌ tmux session '${sessionName}' already exists.`)
      console.error(`  Attach to it:  tmux attach -t ${sessionName}`)
      console.error(`  Or kill it:    tmux kill-session -t ${sessionName}`)
      process.exit(1)
    } catch {
      // Session doesn't exist — good, we can create it
    }

    // Resolve and validate cwd
    const cwd = resolve(options.cwd)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      console.error(`❌ Directory does not exist: ${cwd}`)
      process.exit(1)
    }

    // Create tmux session and launch Claude
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd])
      execFileSync('tmux', ['send-keys', '-t', sessionName, 'claude', 'Enter'])
    } catch (err) {
      // Clean up stray session on failure
      try { execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'pipe' }) } catch {}
      console.error(`❌ Failed to create tmux session: ${err.message}`)
      process.exit(1)
    }

    console.log(`\nSession '${sessionName}' created in ${cwd}`)
    console.log(`Claude Code is starting inside the tmux session.\n`)
    console.log(`  Attach to it:  tmux attach -t ${sessionName}`)
    console.log(`  Kill it:       tmux kill-session -t ${sessionName}`)
    console.log(`\nRun 'npx chroxy start' to connect from your phone.`)
    console.log(`The session will be auto-discovered.\n`)
  })

/**
 * chroxy dev — Development mode with supervisor auto-restart
 *
 * Like `chroxy start` but always uses the supervisor process for auto-restart,
 * regardless of tunnel type. Designed for self-modification workflows: Claude
 * modifies server code, `chroxy deploy` restarts, the phone stays connected.
 */
program
  .command('dev')
  .description('Start in development mode (supervisor + auto-restart, no terminal/PTY)')
  .option('-c, --config <path>', 'Path to config file', CONFIG_FILE)
  .option('-r, --resume', 'Resume an existing Claude Code session instead of starting fresh')
  .option('--cwd <path>', 'Working directory for Claude (CLI mode)')
  .option('--model <model>', 'Model to use (CLI mode)')
  .option('--allowed-tools <tools>', 'Comma-separated tools to auto-approve (CLI mode)')
  .option('--max-restarts <count>', 'Max supervisor restart attempts before exit (default: 10)')
  .option('--tunnel <mode>', 'Tunnel: quick (default), named, none, or provider:mode (e.g., cloudflare:named)')
  .option('--tunnel-name <name>', 'Named tunnel name (requires cloudflared login)')
  .option('--tunnel-hostname <host>', 'Named tunnel hostname (e.g., chroxy.example.com)')
  .option('--legacy-cli', 'Use legacy CLI process mode instead of Agent SDK')
  .option('--provider <name>', 'Session provider to use (e.g. claude-sdk, claude-cli)')
  .option('--max-payload <bytes>', 'WebSocket max message size in bytes (default: 1048576)')
  .option('--max-tool-input <bytes>', 'Maximum tool input size in bytes (default: 262144)')
  .option('-v, --verbose', 'Show detailed config sources and validation info')
  .action(async (options) => {
    const extraOverrides = {}
    if (options.maxPayload !== undefined) {
      const parsed = parseInt(options.maxPayload, 10)
      extraOverrides.maxPayload = Number.isNaN(parsed) ? options.maxPayload : parsed
    }
    if (options.maxToolInput !== undefined) {
      const parsed = parseInt(options.maxToolInput, 10)
      extraOverrides.maxToolInput = Number.isNaN(parsed) ? options.maxToolInput : parsed
    }
    const config = loadAndMergeConfig(options, extraOverrides)

    // Dev mode does not support terminal (PTY) mode
    if (config.terminal) {
      console.error('❌ chroxy dev does not support terminal (PTY) mode; remove "terminal" from your config')
      process.exit(1)
    }

    // Dev mode requires an API token (supervisor needs it)
    if (config.noAuth) {
      console.error('❌ chroxy dev does not support noAuth mode; an API token is required')
      process.exit(1)
    }

    // Dev mode always uses supervisor, regardless of tunnel type
    if (process.env.CHROXY_SUPERVISED === '1') {
      // Already running as a supervised child — start directly
      const { startCliServer } = await import('./server-cli.js')
      await startCliServer(config)
    } else {
      const { startSupervisor } = await import('./supervisor.js')
      await startSupervisor(config)
    }
  })

/**
 * chroxy doctor — Check dependencies and environment
 */
program
  .command('doctor')
  .description('Check that all dependencies are installed and configured correctly')
  .option('-p, --port <port>', 'Port to check availability (default: 8765)')
  .action(async (options) => {
    const { runDoctorChecks } = await import('./doctor.js')

    const port = options.port ? parseInt(options.port, 10) : undefined
    const { checks, passed } = await runDoctorChecks({ port })

    console.log('\nChroxy Doctor\n')

    const STATUS_ICONS = { pass: '\x1b[32m OK \x1b[0m', warn: '\x1b[33mWARN\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m' }

    for (const check of checks) {
      console.log(`  [${STATUS_ICONS[check.status]}] ${check.name.padEnd(12)} ${check.message}`)
    }

    console.log('')
    if (passed) {
      console.log('All checks passed. Ready to start.\n')
    } else {
      console.log('Some checks failed. Fix the issues above and try again.\n')
      process.exitCode = 1
    }
  })

/**
 * chroxy deploy — Validate and restart the running server
 *
 * Pre-checks working tree, validates changed JS files, tags the current
 * commit as known-good, then signals the supervisor to gracefully restart
 * the server child.
 */
program
  .command('deploy')
  .description('Validate and restart the running Chroxy server')
  .option('--dry-run', 'Validate only, do not restart')
  .option('--skip-tests', 'Skip running server tests')
  .action(async (options) => {
    const { execFileSync } = await import('child_process')

    const PID_FILE = join(CONFIG_DIR, 'supervisor.pid')
    const LOCK_FILE = join(CONFIG_DIR, 'update.lock')
    const KNOWN_GOOD_FILE = join(CONFIG_DIR, 'known-good-ref')

    let lockAcquired = false
    try {
      // 1. Pre-checks
      console.log('\n[deploy] Pre-checks...')

      // Check working tree is clean
      const gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim()
      if (gitStatus) {
        console.error('[deploy] Working tree is not clean. Commit or stash changes first.')
        console.error(gitStatus)
        process.exitCode = 1
        return
      }

      // Check lock file
      if (existsSync(LOCK_FILE)) {
        const lockPid = readFileSync(LOCK_FILE, 'utf-8').trim()
        // Check if the locking process is still alive
        try {
          process.kill(parseInt(lockPid, 10), 0)
          console.error(`[deploy] Another deploy is in progress (pid: ${lockPid})`)
          process.exitCode = 1
          return
        } catch {
          // Dead lock — clean it up
          unlinkSync(LOCK_FILE)
        }
      }

      // Write lock file
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
      writeFileSync(LOCK_FILE, String(process.pid))
      lockAcquired = true

      // 2. Validate JS files
      console.log('[deploy] Validating JavaScript files...')
      const knownGoodRef = existsSync(KNOWN_GOOD_FILE)
        ? readFileSync(KNOWN_GOOD_FILE, 'utf-8').trim()
        : null

      // Diff against known-good ref if available, otherwise validate all tracked files
      const jsFiles = knownGoodRef
        ? execFileSync('git', ['diff', '--name-only', knownGoodRef, '--', 'packages/server/src/'], { encoding: 'utf-8' })
            .trim().split('\n').filter((f) => f.endsWith('.js'))
        : execFileSync('git', ['ls-files', '--', 'packages/server/src/'], { encoding: 'utf-8' })
            .trim().split('\n').filter((f) => f.endsWith('.js'))

      let validationErrors = 0
      for (const file of jsFiles) {
        if (!file) continue
        const fullPath = join(process.cwd(), file)
        if (!existsSync(fullPath)) continue // File was deleted
        try {
          execFileSync('node', ['--check', fullPath], { stdio: 'pipe' })
        } catch (err) {
          console.error(`[deploy] Syntax error in ${file}:`)
          console.error(err.stderr?.toString() || err.message)
          validationErrors++
        }
      }

      if (validationErrors > 0) {
        console.error(`[deploy] ${validationErrors} file(s) failed validation`)
        process.exitCode = 1
        return
      }
      console.log(`[deploy] ${jsFiles.filter(Boolean).length || 0} file(s) validated`)

      // 3. Run tests (unless --skip-tests)
      if (!options.skipTests) {
        const testDir = join(process.cwd(), 'packages', 'server', 'tests')
        if (existsSync(testDir)) {
          console.log('[deploy] Running server tests...')
          try {
            execFileSync('node', ['--test', testDir], {
              stdio: 'inherit',
              timeout: 120000,
            })
            console.log('[deploy] Tests passed')
          } catch {
            console.error('[deploy] Tests failed')
            process.exitCode = 1
            return
          }
        }
      } else {
        console.log('[deploy] Skipping tests (--skip-tests)')
      }

      if (options.dryRun) {
        console.log('[deploy] Dry run complete. No restart performed.')
        return
      }

      // 4. Tag known-good commit
      const headHash = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      const tagName = `known-good-${Date.now()}`
      execFileSync('git', ['tag', tagName])
      writeFileSync(KNOWN_GOOD_FILE, headHash)
      console.log(`[deploy] Tagged ${headHash.slice(0, 8)} as ${tagName}`)

      // Prune old known-good tags, keeping the 5 most recent
      try {
        const allTags = execFileSync('git', ['tag', '--list', 'known-good-*', '--sort=-creatordate'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
        const stale = allTags.slice(5)
        for (const old of stale) {
          execFileSync('git', ['tag', '-d', old], { stdio: 'pipe' })
        }
        if (stale.length > 0) console.log(`[deploy] Pruned ${stale.length} old known-good tag(s)`)
      } catch (err) {
        console.warn(`[deploy] Warning: failed to prune old tags: ${err.message}`)
      }

      // 5. Signal supervisor
      if (!existsSync(PID_FILE)) {
        console.error('[deploy] Supervisor PID file not found. Is chroxy running with supervisor mode?')
        process.exitCode = 1
        return
      }

      const supervisorPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
      if (isNaN(supervisorPid)) {
        console.error('[deploy] Invalid supervisor PID')
        process.exitCode = 1
        return
      }

      // Verify supervisor is alive
      try {
        process.kill(supervisorPid, 0)
      } catch {
        console.error(`[deploy] Supervisor (pid ${supervisorPid}) is not running`)
        process.exitCode = 1
        return
      }

      if (isWindows) {
        console.error('[deploy] Deploy restart via SIGUSR2 is not supported on Windows.')
        console.error('   Restart the server manually: npx chroxy start')
        process.exitCode = 1
        return
      }

      console.log(`[deploy] Signaling supervisor (pid ${supervisorPid}) to restart...`)
      process.kill(supervisorPid, 'SIGUSR2')
      console.log('[deploy] Deploy signal sent. Server will restart momentarily.\n')

    } finally {
      // Clean up lock file if we acquired it
      if (lockAcquired) {
        try { unlinkSync(LOCK_FILE) } catch {}
      }
    }
  })

/**
 * chroxy sessions — List saved sessions with conversation IDs
 *
 * Reads ~/.chroxy/session-state.json directly (works when server is stopped).
 * Shows each session with name, cwd, conversation ID, and resume command.
 */
program
  .command('sessions')
  .description('List saved sessions with conversation IDs for terminal handoff')
  .action(() => {
    const stateFile = join(CONFIG_DIR, 'session-state.json')

    if (!existsSync(stateFile)) {
      console.log('\nNo saved sessions found.')
      console.log('Sessions are saved when the server runs.\n')
      process.exit(0)
    }

    let state
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    } catch (err) {
      console.error(`Failed to read session state: ${err.message}`)
      process.exit(1)
    }

    if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
      console.log('\nNo saved sessions.\n')
      process.exit(0)
    }

    console.log(`\nSaved Sessions (${state.sessions.length})\n`)

    for (const session of state.sessions) {
      const convId = session.conversationId || session.sdkSessionId || null
      console.log(`  ${session.name}`)
      console.log(`    cwd: ${session.cwd}`)
      if (convId) {
        console.log(`    conversation: ${convId}`)
        console.log(`    resume: claude --resume ${convId}`)
      } else {
        console.log(`    conversation: (none — no messages sent yet)`)
      }
      console.log('')
    }

    if (state.timestamp) {
      const age = Math.round((Date.now() - state.timestamp) / 60000)
      console.log(`  Last saved: ${age} minute(s) ago\n`)
    }
  })

/**
 * chroxy resume — Resume a Chroxy session in your terminal
 *
 * Reads session state, picks the session, and launches `claude --resume <id>`
 * directly in your terminal. One command to hand off from phone to terminal.
 */
program
  .command('resume')
  .description('Resume a Chroxy session in your terminal')
  .argument('[session]', 'Session name or number (default: most recent)')
  .option('--dangerously-skip-permissions', 'Pass --dangerously-skip-permissions to claude')
  .action(async (sessionArg, options) => {
    const { execFileSync } = await import('child_process')
    const stateFile = join(CONFIG_DIR, 'session-state.json')

    if (!existsSync(stateFile)) {
      console.error('No saved sessions found. Start the server first.')
      process.exit(1)
    }

    let state
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    } catch (err) {
      console.error(`Failed to read session state: ${err.message}`)
      process.exit(1)
    }

    if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
      console.error('No saved sessions.')
      process.exit(1)
    }

    // Find sessions with conversation IDs
    const resumable = state.sessions
      .map((s, i) => ({ ...s, index: i, convId: s.conversationId || s.sdkSessionId }))
      .filter(s => s.convId)

    if (resumable.length === 0) {
      console.error('No sessions have conversation IDs yet. Send a message first.')
      process.exit(1)
    }

    let target
    if (sessionArg) {
      // Match by name (case-insensitive) or by 1-based number
      const num = parseInt(sessionArg, 10)
      if (!isNaN(num) && num >= 1 && num <= resumable.length) {
        target = resumable[num - 1]
      } else {
        target = resumable.find(s => s.name.toLowerCase() === sessionArg.toLowerCase())
      }
      if (!target) {
        console.error(`Session "${sessionArg}" not found. Available:`)
        resumable.forEach((s, i) => console.error(`  ${i + 1}. ${s.name}`))
        process.exit(1)
      }
    } else if (resumable.length === 1) {
      target = resumable[0]
    } else {
      // Multiple sessions — show picker
      const readline = await import('readline')
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      console.log('\nAvailable sessions:\n')
      resumable.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.name} (${s.cwd})`)
      })
      const answer = await new Promise(resolve => {
        rl.question(`\nPick session [1]: `, resolve)
      })
      rl.close()
      const pick = parseInt(answer, 10) || 1
      if (pick < 1 || pick > resumable.length) {
        console.error('Invalid selection.')
        process.exit(1)
      }
      target = resumable[pick - 1]
    }

    console.log(`\nResuming "${target.name}" in ${target.cwd}`)
    console.log(`Conversation: ${target.convId}\n`)

    const args = ['--resume', target.convId]
    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions')
    }

    try {
      execFileSync('claude', args, {
        stdio: 'inherit',
        cwd: target.cwd,
      })
    } catch (err) {
      // claude exiting with non-zero is normal (user Ctrl+C, etc.)
      if (err.status != null) process.exit(err.status)
      throw err
    }
  })


/**
 * chroxy service — Manage Chroxy as a system daemon
 */
const serviceCmd = program
  .command('service')
  .description('Manage Chroxy as a system daemon')

serviceCmd
  .command('install')
  .description('Register Chroxy as a system daemon (launchd/systemd)')
  .option('--cwd <path>', 'Working directory for Claude sessions')
  .option('--start-at-login', 'Start automatically on login')
  .action(async (options) => {
    const {
      getServicePaths,
      resolveNode22Path,
      resolveChroxyBin,
      loadServiceState,
      installService,
    } = await import('./service.js')

    // Check platform
    if (isWindows) {
      console.error('Error: Service install is not supported on Windows.')
      console.error('Only macOS (launchd) and Linux (systemd) are supported.')
      process.exit(1)
    }

    // Check if already installed
    const existing = loadServiceState()
    if (existing) {
      console.error('Chroxy service is already installed.')
      console.error(`  Service file: ${existing.servicePath}`)
      console.error('  Run "chroxy service uninstall" first to remove it.')
      process.exit(1)
    }

    // Resolve paths
    let nodePath
    try {
      nodePath = resolveNode22Path()
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }

    let chroxyBin
    try {
      chroxyBin = resolveChroxyBin()
    } catch (err) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }

    const cwd = options.cwd || homedir()

    if (options.cwd && !existsSync(options.cwd)) {
      console.error(`Error: Working directory "${options.cwd}" does not exist.`)
      process.exit(1)
    }

    const startAtLogin = options.startAtLogin || false

    try {
      installService({
        nodePath,
        chroxyBin,
        cwd,
        startAtLogin,
      })

      const paths = getServicePaths()
      const servicePath = paths.type === 'launchd' ? paths.plistPath : paths.unitPath

      console.log('\n\u2705 Chroxy service installed successfully!\n')
      console.log(`  Node:         ${nodePath}`)
      console.log(`  Chroxy CLI:   ${chroxyBin}`)
      console.log(`  Service file: ${servicePath}`)
      console.log(`  Log dir:      ${paths.logDir}`)
      console.log(`  Working dir:  ${cwd}`)
      console.log(`  Start on login: ${startAtLogin}`)
      if (paths.type === 'launchd') {
        console.log('\nThe service is installed but not running. To start it now:')
        console.log('  launchctl start com.chroxy.server')
      } else {
        console.log('\nThe service is enabled and running. To restart it:')
        console.log('  systemctl --user restart chroxy.service')
      }
    } catch (err) {
      console.error(`Error installing service: ${err.message}`)
      process.exit(1)
    }
  })

serviceCmd
  .command('uninstall')
  .description('Remove the Chroxy system daemon')
  .action(async () => {
    const { uninstallService, loadServiceState } = await import('./service.js')

    const state = loadServiceState()
    if (!state) {
      console.error('Chroxy service is not installed. Nothing to uninstall.')
      process.exit(1)
    }

    try {
      uninstallService()
      console.log('\n\u2705 Chroxy service uninstalled successfully.\n')
      console.log('  Service file and state have been removed.')
      if (state.platform === 'darwin') {
        console.log('  The launchd job has been unloaded.')
      } else {
        console.log('  The systemd unit has been disabled and stopped.')
      }
    } catch (err) {
      console.error(`Error uninstalling service: ${err.message}`)
      process.exit(1)
    }
  })


serviceCmd
  .command('start')
  .description('Start the Chroxy daemon')
  .action(async () => {
    const { getServiceStatus, startService } = await import('./service.js')
    const status = getServiceStatus()

    if (!status.installed) {
      console.error('Chroxy service is not installed. Run: chroxy service install')
      process.exit(1)
    }
    if (status.running) {
      console.error('Chroxy service is already running (PID ' + status.pid + ')')
      process.exit(1)
    }

    try {
      startService()
      console.log('Chroxy service started')
      console.log('Check status: chroxy service status')
    } catch (err) {
      console.error('Failed to start service:', err.message)
      process.exit(1)
    }
  })

serviceCmd
  .command('stop')
  .description('Stop the Chroxy daemon')
  .action(async () => {
    const { getServiceStatus, stopService } = await import('./service.js')
    const status = getServiceStatus()

    if (!status.installed) {
      console.error('Chroxy service is not installed.')
      process.exit(1)
    }
    if (!status.running) {
      console.error('Chroxy service is not running.')
      process.exit(1)
    }

    try {
      stopService()
      console.log('Chroxy service stopped')
    } catch (err) {
      console.error('Failed to stop service:', err.message)
      process.exit(1)
    }
  })

serviceCmd
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    const { getFullServiceStatus } = await import('./service.js')
    const status = await getFullServiceStatus()

    console.log('\nChroxy Service Status\n')

    if (!status.installed) {
      console.log('  Installed:  No')
      console.log('  Run: chroxy service install\n')
      return
    }

    console.log('  Installed:  Yes')

    if (!status.running) {
      if (status.stale) {
        console.log('  Running:    No (stale PID file)')
      } else {
        console.log('  Running:    No')
      }
      console.log('  Run: chroxy service start\n')
      return
    }

    console.log('  Running:    Yes (PID ' + status.pid + ')')

    if (status.health) {
      console.log('  Status:     ' + status.health.status)
    }

    if (status.connection) {
      console.log('  URL:        ' + status.connection.wsUrl)
      const token = status.connection.apiToken
      if (token) console.log('  Token:      ' + token.slice(0, 8) + '...')
    }

    if (status.recentLogs && status.recentLogs.length > 0) {
      console.log('\n  Recent logs:')
      for (const line of status.recentLogs) {
        console.log('    ' + line)
      }
    }

    console.log('')
  })

program.parse()
