/**
 * `chroxy providers` CLI subcommands (#5548).
 *
 * `add openrouter` is a one-liner preset that writes the
 * `providers.anthropicCompatible` entry the docs describe by hand — right
 * baseUrl, key seam (OPENROUTER_API_KEY env or a `credentialsKey` in the
 * encrypted store), a sensible default model, and the `modelDiscovery` seam so
 * the picker fills from OpenRouter's live catalog and sessions report real
 * cost instead of $0. No new session class — it generates config the existing
 * anthropicCompatible machinery (#5419/#5458) already registers at startup.
 *
 * Idempotent: if an `openrouter` entry already exists it is left untouched
 * (re-running is a no-op) unless `--force` rewrites it to the current preset.
 */
import { existsSync, readFileSync } from 'fs'
import { writeFileRestricted } from '../platform.js'
import { CONFIG_FILE } from './shared.js'

// The OpenRouter preset, in one place so the CLI and any future dashboard
// affordance write an identical entry. baseUrl is the Anthropic-compat root
// (the SDK appends /v1/messages); modelDiscovery points at the OpenAI-ish
// catalog (a sibling /v1/models, NOT under the messages base).
export const OPENROUTER_PRESET = Object.freeze({
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  credentialsKey: 'openrouterApiKey',
  defaultModel: 'anthropic/claude-sonnet-4',
  modelDiscovery: Object.freeze({
    url: 'https://openrouter.ai/api/v1/models',
    format: 'openrouter',
  }),
})

/**
 * Build the merged config object after adding the openrouter preset. Pure (no
 * I/O) so tests assert the written shape directly. Returns
 * `{ config, status }` where status is one of 'added' | 'exists' | 'updated'.
 *
 * @param {object} fileConfig - parsed config.json (may be {})
 * @param {object} [opts]
 * @param {boolean} [opts.force] - rewrite an existing entry to the preset
 * @param {object} [opts.preset] - override the preset (tests)
 */
export function applyOpenRouterPreset(fileConfig, opts = {}) {
  const preset = opts.preset || OPENROUTER_PRESET
  const config = { ...fileConfig }

  // Normalize providers into the object form {anthropicCompatible: [...]}.
  // The legacy `providers: [..ids..]` array form (written by `chroxy init`) is
  // a DIFFERENT, purely-informational shape (provider selection is driven by
  // `--provider` / the top-level `provider` key, not this list). The
  // anthropicCompatible block only exists under the object form, so when the
  // file carries the legacy array we promote to the object form and report it
  // via `convertedLegacyArray` so the CLI can warn the user.
  let providers = config.providers
  let convertedLegacyArray = false
  if (Array.isArray(providers)) {
    convertedLegacyArray = providers.length > 0
    providers = {}
  } else if (typeof providers !== 'object' || providers === null) {
    providers = {}
  } else {
    providers = { ...providers }
  }

  let list = Array.isArray(providers.anthropicCompatible) ? [...providers.anthropicCompatible] : []
  const idx = list.findIndex((e) => e && typeof e === 'object' && e.id === preset.id)

  let status
  const entry = { ...preset, modelDiscovery: { ...preset.modelDiscovery } }
  if (idx === -1) {
    list = [...list, entry]
    status = 'added'
  } else if (opts.force) {
    list = list.map((e, i) => (i === idx ? entry : e))
    status = 'updated'
  } else {
    // Idempotent: leave the existing entry untouched.
    status = 'exists'
  }

  providers.anthropicCompatible = list
  config.providers = providers

  return { config, status, convertedLegacyArray }
}

/**
 * Run `chroxy providers add openrouter`. `deps` is a test seam
 * (readFileFn / writeFileFn / existsFn / configFilePath / logFn).
 *
 * @returns {{ status: string, written: boolean, configFilePath: string }}
 */
export function runProvidersAddOpenRouter(options = {}, deps = {}) {
  const logFn = deps.logFn || console.log
  const writeFileFn = deps.writeFileFn || writeFileRestricted
  const existsFn = deps.existsFn || existsSync
  const readFileFn = deps.readFileFn || ((p) => readFileSync(p, 'utf-8'))
  const configFilePath = deps.configFilePath || options.config || CONFIG_FILE

  let fileConfig = {}
  if (existsFn(configFilePath)) {
    try {
      fileConfig = JSON.parse(readFileFn(configFilePath))
    } catch (err) {
      logFn(`❌ Config file contains invalid JSON: ${configFilePath}`)
      logFn(`   ${err.message}`)
      logFn(`   Fix the file or run 'npx chroxy init' to recreate it.`)
      return { status: 'invalid-json', written: false, configFilePath }
    }
  } else {
    logFn(`❌ No config found at ${configFilePath}. Run 'npx chroxy init' first.`)
    return { status: 'no-config', written: false, configFilePath }
  }

  const { config, status, convertedLegacyArray } = applyOpenRouterPreset(fileConfig, { force: options.force })

  if (status === 'exists') {
    logFn(`• OpenRouter is already configured in ${configFilePath} — nothing to do.`)
    logFn(`  Re-run with --force to overwrite it with the current preset.`)
    return { status, written: false, configFilePath }
  }

  writeFileFn(configFilePath, JSON.stringify(config, null, 2))

  if (convertedLegacyArray) {
    logFn(`ℹ Converted the legacy 'providers' id-list to the object form to hold the entry.`)
    logFn(`  Provider selection still uses --provider / the 'provider' key — nothing changes there.`)
  }

  logFn(`${status === 'updated' ? '✓ Updated' : '✓ Added'} the OpenRouter provider in ${configFilePath}.`)
  logFn('')
  logFn('Next steps:')
  logFn('  1. Provide your API key (either is fine):')
  logFn(`       export ${OPENROUTER_PRESET.apiKeyEnv}=sk-or-...`)
  logFn(`     or save it as "${OPENROUTER_PRESET.credentialsKey}" in ~/.chroxy/credentials.json (mode 0600)`)
  logFn('  2. Start with OpenRouter as the active provider:')
  logFn(`       npx chroxy start --provider ${OPENROUTER_PRESET.id}`)
  logFn('')
  logFn('  The model picker fills from OpenRouter\'s live catalog and per-model')
  logFn('  pricing is applied automatically — sessions report real cost.')

  return { status, written: true, configFilePath }
}

export function registerProvidersCommand(program) {
  const providers = program
    .command('providers')
    .description('Manage configured session providers')

  const add = providers
    .command('add')
    .description('Add a preset provider to config.json')

  add
    .command('openrouter')
    .description('Add the OpenRouter Anthropic-compatible provider (baseUrl + key seam + model discovery + pricing autofill)')
    .option('-c, --config <path>', 'Path to config file', CONFIG_FILE)
    .option('--force', 'Overwrite an existing openrouter entry with the current preset')
    .action((options) => {
      const result = runProvidersAddOpenRouter(options)
      if (result.status === 'no-config' || result.status === 'invalid-json') {
        process.exitCode = 1
      }
    })
}
