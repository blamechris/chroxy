/**
 * Configuration schema validation and merging utilities.
 *
 * Config precedence (highest to lowest):
 * 1. CLI flags
 * 2. Environment variables
 * 3. Config file (~/.chroxy/config.json)
 * 4. Defaults
 */

/**
 * Known configuration keys and their expected types.
 */
const CONFIG_SCHEMA = {
  apiToken: 'string',
  port: 'number',
  tmuxSession: 'string',
  shell: 'string',
  cwd: 'string',
  model: 'string',
  allowedTools: 'array',
  resume: 'boolean',
  noAuth: 'boolean',
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

  // Log warnings
  if (warnings.length > 0) {
    console.warn('\n⚠ Configuration warnings:')
    for (const warning of warnings) {
      console.warn(`  - ${warning}`)
    }
    console.warn('')
  }

  if (verbose && warnings.length === 0) {
    console.log('[config] ✓ Configuration validated successfully')
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

  // Log sources in verbose mode
  if (verbose) {
    console.log('\n[config] Configuration sources:')
    for (const [key, source] of Object.entries(sources)) {
      const valueStr = SENSITIVE_KEYS.includes(key) && merged[key]
        ? `${String(merged[key]).slice(0, 8)}...`
        : JSON.stringify(merged[key])
      console.log(`  ${key.padEnd(16)} = ${valueStr.padEnd(24)} (${source})`)
    }
    console.log('')
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
    tmuxSession: 'TMUX_SESSION',
    shell: 'SHELL_CMD',
    cwd: 'CHROXY_CWD',
    model: 'CHROXY_MODEL',
    allowedTools: 'CHROXY_ALLOWED_TOOLS',
    resume: 'CHROXY_RESUME',
    noAuth: 'CHROXY_NO_AUTH',
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
    const num = parseInt(value, 10)
    return isNaN(num) ? value : num
  }

  if (expectedType === 'boolean') {
    return value === 'true' || value === '1'
  }

  if (expectedType === 'array') {
    return value.split(',').map(s => s.trim())
  }

  return value
}
