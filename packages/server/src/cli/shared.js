/**
 * Shared CLI utilities and option definitions.
 *
 * Dependency root for all CLI command modules — provides shared options,
 * config loading, and helper functions.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import readline from 'readline'
import { validateConfig, mergeConfig } from '../config.js'
import { defaultShell } from '../platform.js'

export const CONFIG_DIR = join(homedir(), '.chroxy')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/**
 * Interactive prompt helper
 */
export function prompt(question) {
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
 * Add shared server options to a Commander command.
 * Used by both `start` and `dev` commands.
 */
export function addServerOptions(cmd) {
  return cmd
    .option('-c, --config <path>', 'Path to config file', CONFIG_FILE)
    .option('--cwd <path>', 'Working directory for Claude')
    .option('--model <model>', 'Model to use')
    .option('--allowed-tools <tools>', 'Comma-separated tools to auto-approve')
    .option('--max-restarts <count>', 'Max supervisor restart attempts before exit (default: 10)')
    .option('--tunnel <mode>', 'Tunnel: quick (default), named, none, or provider:mode (e.g., cloudflare:named)')
    .option('--tunnel-name <name>', 'Named tunnel name (requires cloudflared login)')
    .option('--tunnel-hostname <host>', 'Named tunnel hostname (e.g., chroxy.example.com)')
    .option('--legacy-cli', 'Use legacy CLI process mode instead of Agent SDK')
    .option('--provider <name>', 'Session provider to use (e.g. claude-sdk, claude-cli)')
    .option('--max-payload <bytes>', 'WebSocket max message size in bytes (default: 1048576)')
    .option('--max-tool-input <bytes>', 'Maximum tool input size in bytes (default: 262144)')
    .option('--session-timeout <duration>', 'Idle session timeout (e.g. 2h, 30m). Disabled by default')
    .option('--cost-budget <dollars>', 'Per-session cost budget in dollars (e.g., 5.00)')
    .option('-v, --verbose', 'Show detailed config sources and validation info')
}

/**
 * Parse extra overrides from common CLI option values.
 */
export function parseExtraOverrides(options) {
  const extra = {}
  if (options.maxPayload !== undefined) {
    const parsed = parseInt(options.maxPayload, 10)
    extra.maxPayload = Number.isNaN(parsed) ? options.maxPayload : parsed
  }
  if (options.maxToolInput !== undefined) {
    const parsed = parseInt(options.maxToolInput, 10)
    extra.maxToolInput = Number.isNaN(parsed) ? options.maxToolInput : parsed
  }
  if (options.costBudget !== undefined) {
    const parsed = parseFloat(options.costBudget)
    extra.costBudget = Number.isNaN(parsed) ? options.costBudget : parsed
  }
  if (options.sessionTimeout !== undefined) extra.sessionTimeout = options.sessionTimeout
  return extra
}

/**
 * Load config file, build CLI overrides, merge, validate, and set env vars.
 *
 * @param {object} options - Commander options object
 * @param {object} [extraOverrides] - Additional CLI overrides
 * @returns {object} Merged and validated config
 */
export function loadAndMergeConfig(options, extraOverrides = {}) {
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

  const cliOverrides = { ...extraOverrides }
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
    shell: defaultShell(),
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

  if (config.apiToken) process.env.API_TOKEN = config.apiToken
  if (config.port) process.env.PORT = String(config.port)
  if (config.shell) process.env.SHELL_CMD = config.shell

  return config
}
