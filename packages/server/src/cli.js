#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import readline from 'readline'

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
  .action(async (options) => {
    // Load config
    if (!existsSync(options.config)) {
      console.error('❌ No config found. Run \'npx chroxy init\' first.')
      process.exit(1)
    }

    const config = JSON.parse(readFileSync(options.config, 'utf-8'))
    config.resume = !!options.resume

    // Set environment variables for the server
    process.env.API_TOKEN = config.apiToken
    process.env.PORT = String(config.port)
    process.env.TMUX_SESSION = config.tmuxSession
    process.env.SHELL_CMD = config.shell

    if (options.terminal) {
      // Legacy PTY/tmux mode — --no-auth is not supported
      if (options.auth === false) {
        console.error('❌ --no-auth is only supported in CLI headless mode (remove --terminal).')
        process.exit(1)
      }
      const { startServer } = await import('./server.js')
      await startServer(config)
    } else {
      // Default: CLI headless mode
      if (options.cwd) config.cwd = options.cwd
      if (options.model) config.model = options.model
      if (options.allowedTools) {
        config.allowedTools = options.allowedTools.split(',').map((t) => t.trim())
      }
      if (options.auth === false) config.noAuth = true
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
    console.log('')
  })

program.parse()
