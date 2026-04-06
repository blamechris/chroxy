/**
 * Configuration schema validation and merging utilities.
 *
 * Config precedence (highest to lowest):
 * 1. CLI flags
 * 2. Environment variables
 * 3. Config file (~/.chroxy/config.json)
 * 4. Defaults
 */

import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { writeFileRestricted } from './platform.js'
import { parseDuration } from './duration.js'
import { createLogger } from './logger.js'

const log = createLogger('config')

/**
 * Known configuration keys and their expected types.
 */
const CONFIG_SCHEMA = {
  apiToken: 'string',
  port: 'number',
  cwd: 'string',
  model: 'string',
  allowedTools: 'array',
  noAuth: 'boolean',
  maxRestarts: 'number',
  tunnel: 'string',
  tunnelName: 'string',
  tunnelHostname: 'string',
  tunnelConfig: 'object',
  legacyCli: 'boolean',
  provider: 'string',
  maxPayload: 'number',
  maxToolInput: 'number',
  noEncrypt: 'boolean',
  transforms: 'array',
  tokenExpiry: 'string',
  sessionTimeout: 'string',
  costBudget: 'number',
  externalUrl: 'string',
  repos: 'array',
  maxSessions: 'number',
  maxHistory: 'number',
  showToken: 'boolean',
  logFormat: 'string',
  environments: 'object',
  sandbox: 'object',
}

/**
 * Config keys that should be masked in verbose output.
 */
const SENSITIVE_KEYS = ['apiToken']

/**
 * Validate config object against schema.
 * Logs warnings for unknown keys and type mismatches.
 *
 * @param {object} config - Config object to validate
 * @param {boolean} verbose - If true, log detailed validation info
 * @returns {object} Validation result { valid: boolean, warnings: string[] }
 */
export function validateConfig(config, verbose = false) {
  const warnings = []

  // Check for unknown keys
  for (const key of Object.keys(config)) {
    if (!(key in CONFIG_SCHEMA)) {
      warnings.push(`Unknown config key: '${key}' (will be ignored)`)
    }
  }

  // Check types for known keys
  for (const [key, expectedType] of Object.entries(CONFIG_SCHEMA)) {
    if (key in config) {
      const value = config[key]
      const actualType = Array.isArray(value) ? 'array' : typeof value

      if (actualType !== expectedType) {
        warnings.push(`Invalid type for '${key}': expected ${expectedType}, got ${actualType}`)
      }
    }
  }

  // Range validation for numeric and duration fields (only when type is correct)
  if (typeof config.port === 'number' && (config.port < 1 || config.port > 65535)) {
    warnings.push(`Invalid value for 'port': ${config.port} (must be 1-65535)`)
  }

  if (typeof config.maxSessions === 'number' && config.maxSessions < 1) {
    warnings.push(`Invalid value for 'maxSessions': ${config.maxSessions} (must be >= 1)`)
  }

  if (typeof config.sessionTimeout === 'string' && config.sessionTimeout.length > 0) {
    const ms = parseDuration(config.sessionTimeout)
    if (ms == null) {
      warnings.push(`Invalid duration format for 'sessionTimeout': '${config.sessionTimeout}'`)
    } else if (ms < 30_000) {
      warnings.push(`Value for 'sessionTimeout' is too low: '${config.sessionTimeout}' (minimum 30s)`)
    }
  }

  if (typeof config.maxPayload === 'number') {
    if (config.maxPayload < 1024) {
      warnings.push(`Invalid value for 'maxPayload': ${config.maxPayload} (minimum 1KB / 1024 bytes)`)
    } else if (config.maxPayload > 100 * 1024 * 1024) {
      warnings.push(`Invalid value for 'maxPayload': ${config.maxPayload} (maximum 100MB)`)
    }
  }

  // Validate externalUrl format if provided
  if (config.externalUrl && typeof config.externalUrl === 'string') {
    try {
      const parsed = new URL(config.externalUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        warnings.push(`externalUrl should use http:// or https:// protocol, got '${parsed.protocol}'`)
      }
    } catch {
      warnings.push(`Invalid URL format for 'externalUrl': ${config.externalUrl}`)
    }
  }

  // Log warnings
  if (warnings.length > 0) {
    log.warn('Configuration warnings:')
    for (const warning of warnings) {
      log.warn(`  - ${warning}`)
    }
  }

  if (verbose && warnings.length === 0) {
    log.info('Configuration validated successfully')
  }

  return {
    valid: warnings.length === 0,
    warnings,
  }
}

/**
 * Merge configuration from multiple sources with proper precedence.
 *
 * Precedence order (highest to lowest):
 * 1. CLI options (provided via cli.js commands)
 * 2. Environment variables
 * 3. Config file
 * 4. Defaults
 *
 * @param {object} options - Options object from CLI
 * @param {object} options.fileConfig - Config loaded from file
 * @param {object} options.cliOverrides - CLI flag overrides
 * @param {object} options.defaults - Default values
 * @param {boolean} options.verbose - Log source of each config value
 * @returns {object} Merged config object
 */
export function mergeConfig({ fileConfig = {}, cliOverrides = {}, defaults = {}, verbose = false }) {
  const merged = {}
  const sources = {}

  // Helper to set value and track source
  const setValue = (key, value, source) => {
    merged[key] = value
    sources[key] = source
  }

  // Get all possible keys from defaults, fileConfig, cliOverrides, AND known schema keys with env vars
  const allKeys = new Set([
    ...Object.keys(defaults),
    ...Object.keys(fileConfig),
    ...Object.keys(cliOverrides),
    ...Object.keys(CONFIG_SCHEMA),
  ])

  // Apply precedence for each key
  for (const key of allKeys) {
    if (cliOverrides[key] !== undefined) {
      setValue(key, cliOverrides[key], 'CLI')
    } else {
      const envKey = envKeyForConfig(key)
      if (process.env[envKey] !== undefined) {
        const envValue = parseEnvValue(key, process.env[envKey])
        setValue(key, envValue, 'ENV')
      } else if (fileConfig[key] !== undefined) {
        setValue(key, fileConfig[key], 'config file')
      } else if (defaults[key] !== undefined) {
        setValue(key, defaults[key], 'default')
      }
    }
  }

  // Map legacy legacyCli flag to provider if no explicit provider set
  if (merged.legacyCli && !merged.provider) {
    merged.provider = 'claude-cli'
    sources.provider = 'legacyCli mapping'
  }

  // Log sources in verbose mode (after mapping so provider is included)
  if (verbose) {
    log.info('Configuration sources:')
    for (const [key, source] of Object.entries(sources)) {
      const valueStr = SENSITIVE_KEYS.includes(key) && merged[key]
        ? `${String(merged[key]).slice(0, 8)}...`
        : JSON.stringify(merged[key])
      log.info(`  ${key.padEnd(16)} = ${valueStr.padEnd(24)} (${source})`)
    }
  }

  return merged
}

/**
 * Convert config key to corresponding environment variable name.
 * @param {string} key - Config key
 * @returns {string} Environment variable name
 */
function envKeyForConfig(key) {
  const envMap = {
    apiToken: 'API_TOKEN',
    port: 'PORT',
    cwd: 'CHROXY_CWD',
    model: 'CHROXY_MODEL',
    allowedTools: 'CHROXY_ALLOWED_TOOLS',
    noAuth: 'CHROXY_NO_AUTH',
    maxRestarts: 'CHROXY_MAX_RESTARTS',
    tunnel: 'CHROXY_TUNNEL',
    tunnelName: 'CHROXY_TUNNEL_NAME',
    tunnelHostname: 'CHROXY_TUNNEL_HOSTNAME',
    tunnelConfig: 'CHROXY_TUNNEL_CONFIG',
    legacyCli: 'CHROXY_LEGACY_CLI',
    provider: 'CHROXY_PROVIDER',
    maxPayload: 'CHROXY_MAX_PAYLOAD',
    maxToolInput: 'CHROXY_MAX_TOOL_INPUT',
    noEncrypt: 'CHROXY_NO_ENCRYPT',
    transforms: 'CHROXY_TRANSFORMS',
    tokenExpiry: 'CHROXY_TOKEN_EXPIRY',
    sessionTimeout: 'CHROXY_SESSION_TIMEOUT',
    costBudget: 'CHROXY_COST_BUDGET',
    externalUrl: 'CHROXY_EXTERNAL_URL',
    maxSessions: 'CHROXY_MAX_SESSIONS',
    maxHistory: 'CHROXY_MAX_HISTORY',
    showToken: 'CHROXY_SHOW_TOKEN',
    repos: 'CHROXY_REPOS',
    logFormat: 'CHROXY_LOG_FORMAT',
    sandbox: 'CHROXY_SANDBOX',
  }
  return envMap[key] || key.toUpperCase()
}

/**
 * Parse environment variable value to appropriate type.
 * @param {string} key - Config key
 * @param {string} value - Raw env var value
 * @returns {*} Parsed value
 */
function parseEnvValue(key, value) {
  const expectedType = CONFIG_SCHEMA[key]

  if (expectedType === 'number') {
    const num = parseFloat(value)
    return isNaN(num) ? value : num
  }

  if (expectedType === 'boolean') {
    return value === 'true' || value === '1'
  }

  if (expectedType === 'array') {
    return value.split(',').map(s => s.trim())
  }

  if (expectedType === 'object') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.chroxy', 'config.json')

/**
 * Read the repos array from a config file.
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 * @returns {Array<{ path: string, name?: string }>} Repos array, or [] if missing/invalid.
 */
export function readReposFromConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!existsSync(configPath)) return []
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    return Array.isArray(raw.repos) ? raw.repos : []
  } catch {
    return []
  }
}

/**
 * Write the repos array to a config file, preserving other fields.
 * @param {Array<{ path: string, name?: string }>} repos - Repos array to write.
 * @param {string} [configPath] - Path to config.json. Defaults to ~/.chroxy/config.json.
 */
export function writeReposToConfig(repos, configPath = DEFAULT_CONFIG_PATH) {
  let existing = {}
  try {
    if (existsSync(configPath)) {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'))
    }
  } catch {
    // Start fresh if parse fails
  }
  existing.repos = repos
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  writeFileRestricted(configPath, JSON.stringify(existing, null, 2))
}

