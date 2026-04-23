/**
 * chroxy init — Set up configuration
 */
import { existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { CONFIG_DIR, CONFIG_FILE, prompt } from './shared.js'
import { writeFileRestricted } from '../platform.js'
import { setToken, isKeychainAvailable } from '../keychain.js'

/**
 * Catalog of user-selectable providers shown in the `chroxy init` picker.
 *
 * Each entry is the on-disk provider id (written to config.providers), a
 * short display label for the UI, and a "next-step hint" explaining what
 * the user still needs to do to make that provider usable — e.g. export
 * an API key or log in via another CLI. The hint is printed only when the
 * user selects the provider so we don't spam instructions for things
 * they never asked for.
 *
 * Keep this list in sync with the built-in providers registered in
 * `src/providers.js` — if a new first-class provider is added there, add
 * it here too and bump the numbering in tests/prompts accordingly.
 */
export const PROVIDER_CHOICES = [
  {
    id: 'claude-sdk',
    label: 'Claude (Agent SDK)',
    hint: 'Run \'claude login\' (or set ANTHROPIC_API_KEY) if not already authenticated.',
  },
  {
    id: 'codex',
    label: 'Codex (OpenAI)',
    hint: 'Set OPENAI_API_KEY in your environment before starting the server.',
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    hint: 'Set GEMINI_API_KEY in your environment before starting the server.',
  },
]

/**
 * Parse a comma-separated provider selection answer from the init prompt.
 *
 * Accepted forms:
 *   - empty / whitespace     → default (claude-sdk)
 *   - "all"                  → every known provider
 *   - "1", "2", "1,3", "1, 3" → numeric indices (1-based) into PROVIDER_CHOICES
 *
 * Invalid tokens (non-numeric, out-of-range) are silently dropped. If the
 * result is empty we fall back to the default so the user always ends up
 * with at least one working provider.
 *
 * @param {string} input
 * @param {Array<{id: string}>} [choices]
 * @returns {string[]} provider ids, order-preserving and de-duplicated
 */
export function parseProviderSelection(input, choices = PROVIDER_CHOICES) {
  const raw = (input || '').trim().toLowerCase()
  if (raw === '') return [choices[0].id]
  if (raw === 'all') return choices.map((c) => c.id)

  const ids = []
  for (const token of raw.split(',')) {
    const n = parseInt(token.trim(), 10)
    if (Number.isNaN(n)) continue
    const idx = n - 1
    if (idx < 0 || idx >= choices.length) continue
    const id = choices[idx].id
    if (!ids.includes(id)) ids.push(id)
  }

  if (ids.length === 0) return [choices[0].id]
  return ids
}

/**
 * Run the `chroxy init` flow. Exposed as a pure(-ish) function so tests
 * can inject prompt/log/fs/keychain stubs instead of touching stdin,
 * stdout, or the user's real ~/.chroxy directory.
 *
 * @param {object} [deps]
 * @param {boolean} [deps.force] - Overwrite existing config without asking
 * @param {(q: string) => Promise<string>} [deps.promptFn] - Reads one line from the user
 * @param {(msg: string) => void} [deps.logFn] - Prints user-visible output
 * @param {(path: string, contents: string) => void} [deps.writeFileFn] - Persists the config
 * @param {(path: string) => boolean} [deps.existsFn] - fs existsSync stub
 * @param {(path: string) => void} [deps.ensureDirFn] - mkdir -p equivalent
 * @param {() => boolean} [deps.isKeychainAvailableFn] - OS keychain probe
 * @param {(token: string) => void} [deps.setTokenFn] - Store token in keychain
 * @param {string} [deps.configFilePath] - Config file location
 * @param {string} [deps.configDirPath] - Config directory location
 * @param {() => string} [deps.generateTokenFn] - Token generator (for deterministic tests)
 * @returns {Promise<{written: boolean, config: object, apiToken: string|null}>}
 */
export async function runInitCmd(deps = {}) {
  const promptFn = deps.promptFn || prompt
  const logFn = deps.logFn || console.log
  const writeFileFn = deps.writeFileFn || writeFileRestricted
  const existsFn = deps.existsFn || existsSync
  const ensureDirFn = deps.ensureDirFn || ((p) => mkdirSync(p, { recursive: true }))
  const isKeychainAvailableFn = deps.isKeychainAvailableFn || isKeychainAvailable
  const setTokenFn = deps.setTokenFn || setToken
  const configFilePath = deps.configFilePath || CONFIG_FILE
  const configDirPath = deps.configDirPath || CONFIG_DIR
  const generateTokenFn =
    deps.generateTokenFn || (() => randomBytes(32).toString('base64url'))

  logFn('\n🔧 Chroxy Setup\n')

  if (existsFn(configFilePath) && !deps.force) {
    logFn(`Config already exists at ${configFilePath}`)
    const overwrite = await promptFn('Overwrite? (y/N): ')
    if (overwrite.toLowerCase() !== 'y') {
      logFn('Keeping existing config. Use --force to overwrite.')
      return { written: false, config: null, apiToken: null }
    }
  }

  if (!existsFn(configDirPath)) {
    ensureDirFn(configDirPath)
  }

  logFn('We need a few things to get started:\n')

  const apiToken = generateTokenFn()

  logFn('1. Local WebSocket port')
  const portInput = await promptFn('   Port (default 8765): ')
  const port = parseInt(portInput, 10) || 8765

  // Provider picker — see PROVIDER_CHOICES for the menu. Default is
  // Claude-only, so existing users who just hit enter end up with the
  // same behaviour they had before this prompt was added.
  logFn('\n2. Which providers do you want to use?')
  for (let i = 0; i < PROVIDER_CHOICES.length; i++) {
    logFn(`   ${i + 1}. ${PROVIDER_CHOICES[i].label}`)
  }
  logFn('   (comma-separated numbers, or "all". Default: 1 — Claude only)')
  const providersInput = await promptFn('   Providers: ')
  const providers = parseProviderSelection(providersInput)

  const config = {
    port,
    providers,
  }

  // Store token in OS keychain if available, otherwise in config file
  if (isKeychainAvailableFn()) {
    setTokenFn(apiToken)
    logFn('\n🔐 API token stored in OS keychain')
  } else {
    config.apiToken = apiToken
    logFn('\n⚠ OS keychain unavailable — token stored in config file (chmod 600)')
  }

  writeFileFn(configFilePath, JSON.stringify(config, null, 2))

  logFn(`✅ Configuration saved to: ${configFilePath}`)

  // Per-provider next-step hints — only show instructions for providers
  // the user actually selected to avoid noise.
  const selectedChoices = PROVIDER_CHOICES.filter((c) => providers.includes(c.id))
  if (selectedChoices.length > 0) {
    logFn('\n📦 Next steps for your selected providers:')
    for (const choice of selectedChoices) {
      logFn(`   • ${choice.label}: ${choice.hint}`)
    }
  }

  logFn('\n📱 Your API token (keep this secret):')
  logFn(`   ${apiToken}`)
  logFn('\n🚀 Run \'npx chroxy start\' to launch the server')
  logFn('')

  return { written: true, config, apiToken }
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Initialize Chroxy configuration')
    .option('-f, --force', 'Overwrite existing configuration')
    .action(async (options) => {
      const result = await runInitCmd({ force: options.force })
      if (!result.written) process.exit(0)
    })
}
