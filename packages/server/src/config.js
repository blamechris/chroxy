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
  // Providers the user opted into during `chroxy init`. Informational
  // today — `provider` remains the authoritative runtime selector — but
  // recording the user's intent here lets future features (dashboard,
  // multi-provider routing) know which backends are expected to be
  // configured without re-prompting. Entries should be valid provider
  // ids from the `providers.js` registry (e.g. 'claude-sdk', 'codex',
  // 'gemini'). Added with the `chroxy init` provider picker (#2950).
  providers: 'array',
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
  maxMessages: 'number',
  showToken: 'boolean',
  logFormat: 'string',
  environments: 'object',
  sandbox: 'object',
  // Optional allowlist of absolute directory paths that sessions may use
  // as their working directory. When set (non-empty array), session
  // cwds MUST be within one of these realpath-resolved roots;
  // otherwise creation is rejected. When unset/empty, falls back to the
  // legacy "must be inside $HOME" check. Defense-in-depth (credential
  // directory deny-list) is active in BOTH modes — see validateCwdAllowed
  // in handler-utils.js. Added in the 2026-04-11 audit blocker 1 fix.
  workspaceRoots: 'array',
  // Gates the auto permission mode (bypass all permission checks). When
  // not explicitly set to true, clients that attempt to flip to auto
  // mode are rejected with AUTO_MODE_DISABLED_BY_CONFIG. Defaults to
  // undefined/false so fresh installs are secure-by-default. Operators
  // who want to run Claude unattended can opt in by editing their
  // config file on the dev machine (physical-access proxy for real
  // user confirmation). Added in the 2026-04-11 audit Adversary A5 fix.
  allowAutoPermissionMode: 'boolean',
  // Allowlist of Docker image patterns that create_environment may use.
  // Each entry is either an exact image name or a prefix pattern like
  // `mcr.microsoft.com/devcontainers/*`. When set, client-supplied
  // images must match at least one entry; otherwise the request is
  // rejected with DOCKER_IMAGE_NOT_ALLOWED. When unset, falls back to
  // a built-in DEFAULT_ALLOWED_DOCKER_IMAGES list (see
  // docker-image-allowlist.js) covering common base images. Added in
  // the 2026-04-11 audit Adversary A7 fix to close the "register any
  // attacker-controlled image and run it" attack path.
  allowedDockerImages: 'array',
}

/**
 * Config keys that should be masked in verbose output and sanitized logs.
 */
const SENSITIVE_KEYS = ['apiToken', 'pushToken']

/**
 * Return a copy of config with sensitive fields replaced by '***'.
 * Use this whenever the config object is serialized to logs or debug output.
 *
 * @param {object} config - Config object to sanitize
 * @returns {object} Shallow copy with sensitive fields masked
 */
export function sanitizeConfig(config) {
  const safe = { ...config }
  for (const key of SENSITIVE_KEYS) {
    if (safe[key]) safe[key] = '***'
  }
  return safe
}

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
    const safe = sanitizeConfig(merged)
    log.info('Configuration sources:')
    for (const [key, source] of Object.entries(sources)) {
      log.info(`  ${key.padEnd(16)} = ${JSON.stringify(safe[key]).padEnd(24)} (${source})`)
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
    maxMessages: 'CHROXY_MAX_MESSAGES',
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

