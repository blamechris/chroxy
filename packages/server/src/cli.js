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
  .option('--no-auth', 'Skip API token requirement (local testing only, disables tunnel)')
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

    // Launch appropriate server mode
    if (config.terminal) {
      // Legacy PTY/tmux mode — --no-auth is not supported
      if (config.noAuth) {
        console.error('❌ --no-auth is only supported in CLI headless mode (remove --terminal).')
        process.exit(1)
      }
      const { startServer } = await import('./server.js')
      await startServer(config)
    } else {
      // Default: CLI headless mode
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
    console.log(`   Tunnel: Cloudflare (automatic)`)
    console.log(`   API token: ${config.apiToken.slice(0, 8)}...`)
    console.log('\nNote: CLI flags and environment variables can override these values.')
    console.log('Run \'npx chroxy start --verbose\' to see full config resolution.\n')
  })

program.parse()
