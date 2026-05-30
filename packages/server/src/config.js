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
  // #4209 / #4246: server-wide default for the per-session
  // `skipPermissions` option. Honoured only by the claude-tui provider
  // (spawns claude with `--dangerously-skip-permissions` + elides
  // chroxy's permission hook). Wired from
  // `chroxy start --dangerously-skip-permissions`; can also be pinned
  // in config.json for headless deploys.
  //
  // #4246 — the canonical config-file key is now
  // `dangerouslySkipPermissions` (mirrors the CLI flag). The legacy
  // `skipPermissions` key is still honoured for backwards compatibility
  // but `resolveSkipPermissions()` emits a deprecation warning when only
  // the legacy key is set. Operators should rename the key in their
  // config.json — both keys remain in the schema so a config.json with
  // either key passes validation cleanly.
  dangerouslySkipPermissions: 'boolean',
  skipPermissions: 'boolean',
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
  // Per-session regex source string used by `shouldSkipEvaluator` to extend
  // the default continuation-pattern skip list. Wrapped in try/catch when
  // compiled — malformed sources are logged and ignored, the default
  // pattern still applies. Documented in CONFIG.md. Added in #3187.
  promptEvaluatorSkipPattern: 'string',
  // Per-skill byte cap and global skills-context budget (#3202). Skills
  // exceeding the per-skill cap are rejected; a merged set exceeding the
  // global cap is pruned by ascending priority then alphabetical name.
  // Defaults: 32768 (32KB) per skill, 262144 (256KB) total. Setting either
  // to 0 disables that cap. Documented in CONFIG.md.
  maxSkillBytes: 'number',
  maxTotalSkillBytes: 'number',
  // Per-provider skill allowlist (#3207). An object keyed by provider id
  // (e.g. `codex`, `gemini`) whose value is an array of skill names that
  // are permitted to load for that provider. When this map is omitted
  // entirely, the loader keeps the v1 permissive behaviour (every loaded
  // skill is eligible for every provider). When the map is present:
  //   - Claude-family providers (`claude-sdk`, `claude-cli`, `docker-*`)
  //     stay permissive — Claude has built-in tool gating so skills there
  //     are lower risk.
  //   - For non-Claude providers (`codex`, `gemini`, …) only the skills
  //     listed in the allowlist for that provider load. A missing key
  //     OR an empty array filters out ALL skills for that provider —
  //     fail-secure.
  // Documented in CONFIG.md.
  providerSkillAllowlist: 'object',
  // Skill content-hash mismatch mode (#3204). One of:
  //   - 'warn': a hash mismatch logs a sanitised warn and emits a
  //     `skill_changed` WS event but the skill still loads.
  //   - 'block': same warn + event, but the skill is filtered out of
  //     the active set until the operator explicitly re-trusts it.
  // Invalid values disable trust checking — the operator must
  // explicitly opt into 'warn' or 'block' to enable it. This was an
  // intentional design choice so the trust ledger is opt-in, not
  // implicit.
  // Documented in CONFIG.md.
  trustMismatchMode: 'string',
  // #3749 / #3884 / #3899: SOFT-warning inactivity timeout (ms). When no
  // SDK / CLI event fires within this window, the server emits an
  // `inactivity_warning` event (and push notification) — the session
  // stays alive. Defaults to 1800000 (30 min). Was a hardcoded 5 min
  // before — too aggressive for legitimate slow tools (large fetches,
  // long Bash, extended thinking). Range: 30s minimum, 24h maximum —
  // validateConfig logs a warning for out-of-range values (warn-only,
  // not clamped); the runtime still applies whatever was set.
  // Operators should fix the warning rather than rely on silent
  // normalisation.
  resultTimeoutMs: 'number',
  // #3899: HARD-cap inactivity timeout (ms). When silence continues
  // for this long with no user check-in, the session is force-cleared
  // (the pre-#3899 kill path). Defaults to 7200000 (2h). Same range
  // semantics as resultTimeoutMs — operators can set this shorter if
  // they want tighter runaway-session protection, but it should always
  // be >= resultTimeoutMs (the soft warning fires first).
  hardTimeoutMs: 'number',
  // #4467: stream-stall recovery (ms). Resets on any stream activity from
  // the child; when silence reaches this window while busy, the session
  // emits a recoverable error (code: stream_stall), clears busy state,
  // and the dashboard can offer a retry. Default 300000 (5 min). Set to
  // 0 to disable (operators with legitimately long event gaps).
  streamStallTimeoutMs: 'number',
  // #4482: per-call MCP tools/call timeout (ms). Forwarded to
  // byok-mcp-client.callTool's setTimeout via byok-session →
  // MCPFleet.callTool → MCPClient.callTool. Default 30000 (30s) at the
  // client layer matches DEFAULT_TOOL_CALL_TIMEOUT_MS. Range 1s-10min —
  // below 1s every realistic MCP server times out, above 10min the
  // model conversation is already lost.
  mcpToolCallTimeoutMs: 'number',
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

  // #3749: result-timeout range. Below 30s a slow tool reliably tips into
  // false positives; above 24h the safety net is effectively disabled.
  // Number.isFinite rejects NaN/Infinity (typeof both === 'number') so a
  // sentinel-like sentinel can't silently slip past the bounds check.
  if (Number.isFinite(config.resultTimeoutMs)) {
    if (config.resultTimeoutMs < 30_000) {
      warnings.push(`Invalid value for 'resultTimeoutMs': ${config.resultTimeoutMs} (minimum 30000 / 30s)`)
    } else if (config.resultTimeoutMs > 24 * 60 * 60 * 1000) {
      warnings.push(`Invalid value for 'resultTimeoutMs': ${config.resultTimeoutMs} (maximum 86400000 / 24h)`)
    }
  }

  // #3899: hard-cap range. Same 30s / 24h bounds as resultTimeoutMs.
  // Additionally: warn if hardTimeoutMs < resultTimeoutMs — the soft
  // warning is supposed to fire first; an inverted config would fire
  // the kill before the warning ever surfaces. Warn-only (not clamped)
  // so operators can deliberately set them equal for tight kill
  // semantics if they really want.
  if (Number.isFinite(config.hardTimeoutMs)) {
    if (config.hardTimeoutMs < 30_000) {
      warnings.push(`Invalid value for 'hardTimeoutMs': ${config.hardTimeoutMs} (minimum 30000 / 30s)`)
    } else if (config.hardTimeoutMs > 24 * 60 * 60 * 1000) {
      warnings.push(`Invalid value for 'hardTimeoutMs': ${config.hardTimeoutMs} (maximum 86400000 / 24h)`)
    } else if (Number.isFinite(config.resultTimeoutMs) && config.hardTimeoutMs < config.resultTimeoutMs) {
      warnings.push(`'hardTimeoutMs' (${config.hardTimeoutMs}) is less than 'resultTimeoutMs' (${config.resultTimeoutMs}) — the soft warning will never fire before the hard kill`)
    }
  }

  // #4467: stream-stall range. 0 is valid (disable). Otherwise 5s-24h.
  if (Number.isFinite(config.streamStallTimeoutMs) && config.streamStallTimeoutMs !== 0) {
    if (config.streamStallTimeoutMs < 5_000) {
      warnings.push(`Invalid value for 'streamStallTimeoutMs': ${config.streamStallTimeoutMs} (minimum 5000 / 5s; set 0 to disable)`)
    } else if (config.streamStallTimeoutMs > 24 * 60 * 60 * 1000) {
      warnings.push(`Invalid value for 'streamStallTimeoutMs': ${config.streamStallTimeoutMs} (maximum 86400000 / 24h)`)
    }
  }

  // #4482: per-MCP-call timeout. 1s-10min. Unlike streamStallTimeoutMs,
  // 0 isn't meaningful here — a 0-ms callTool timeout fires immediately
  // and makes every MCP tool look broken — so any non-finite / non-
  // positive value gets a warning and the runtime falls back to the
  // client default (30s) instead of accepting it.
  if (Number.isFinite(config.mcpToolCallTimeoutMs)) {
    if (config.mcpToolCallTimeoutMs < 1_000) {
      warnings.push(`Invalid value for 'mcpToolCallTimeoutMs': ${config.mcpToolCallTimeoutMs} (minimum 1000 / 1s)`)
    } else if (config.mcpToolCallTimeoutMs > 10 * 60 * 1000) {
      warnings.push(`Invalid value for 'mcpToolCallTimeoutMs': ${config.mcpToolCallTimeoutMs} (maximum 600000 / 10min)`)
    }
  }

  // #4556: validate the optional environments.k8s.workspace block (operator
  // surface for the K8sBackend PVC strategy added in #4547 / #4548). Done at
  // config-load time so a typo (missing claimName, wrong type) surfaces at
  // startup rather than on the first environment-creation call. Shape mirrors
  // `K8sBackend.validateWorkspacePVC()` so an operator never sees a different
  // message at load-time vs runtime for the same malformed value.
  //
  // Only fires when the sub-block is present — the common case (Docker
  // operators without any k8s key, or with other k8s settings but no
  // workspace block) passes through untouched.
  if (config.environments && typeof config.environments === 'object' && !Array.isArray(config.environments)) {
    const k8sBlock = config.environments.k8s
    if (k8sBlock && typeof k8sBlock === 'object' && !Array.isArray(k8sBlock)) {
      if (Object.prototype.hasOwnProperty.call(k8sBlock, 'workspace')) {
        const ws = k8sBlock.workspace
        if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) {
          warnings.push(
            `Invalid 'environments.k8s.workspace': must be an object with a claimName property`,
          )
        } else {
          if (!Object.prototype.hasOwnProperty.call(ws, 'claimName')) {
            warnings.push(
              `Missing 'environments.k8s.workspace.claimName': required, non-empty string`,
            )
          } else if (typeof ws.claimName !== 'string') {
            warnings.push(
              `Invalid type for 'environments.k8s.workspace.claimName': expected string, got ${typeof ws.claimName}`,
            )
          } else if (ws.claimName.length === 0) {
            warnings.push(
              `Invalid value for 'environments.k8s.workspace.claimName': must be a non-empty string`,
            )
          }
          if (Object.prototype.hasOwnProperty.call(ws, 'mountPath') && typeof ws.mountPath !== 'string') {
            warnings.push(
              `Invalid type for 'environments.k8s.workspace.mountPath': expected string, got ${typeof ws.mountPath}`,
            )
          }
          if (Object.prototype.hasOwnProperty.call(ws, 'readOnly') && typeof ws.readOnly !== 'boolean') {
            warnings.push(
              `Invalid type for 'environments.k8s.workspace.readOnly': expected boolean, got ${typeof ws.readOnly}`,
            )
          }
        }
      }
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
    providers: 'CHROXY_PROVIDERS',
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
    resultTimeoutMs: 'CHROXY_RESULT_TIMEOUT_MS',
    hardTimeoutMs: 'CHROXY_HARD_TIMEOUT_MS',
    streamStallTimeoutMs: 'CHROXY_STREAM_STALL_TIMEOUT_MS',
    mcpToolCallTimeoutMs: 'CHROXY_MCP_TOOL_CALL_TIMEOUT_MS',
    // #4384 — canonical env var for the #4246 rename. Without this entry
    // the fallback was `key.toUpperCase()` (DANGEROUSLYSKIPPERMISSIONS,
    // no underscores) which is not what we document or what operators
    // would guess. `resolveSkipPermissions()` is still the single read
    // site that decides effective behaviour and surfaces the deprecation
    // warning for the legacy alias below.
    dangerouslySkipPermissions: 'CHROXY_DANGEROUSLY_SKIP_PERMISSIONS',
    // #4384 — legacy env-var alias mirroring the legacy config-file
    // key. mergeConfig is the dumb plumbing layer: it just lands the
    // value under the legacy `skipPermissions` config key so
    // resolveSkipPermissions sees it on the same code path as a
    // file-side legacy key (and therefore emits the same deprecation
    // warning). Operators should migrate to
    // `CHROXY_DANGEROUSLY_SKIP_PERMISSIONS`.
    skipPermissions: 'CHROXY_SKIP_PERMISSIONS',
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

/**
 * Resolve the effective `dangerouslySkipPermissions` value from a merged
 * config object (#4246).
 *
 * Precedence:
 *   1. `dangerouslySkipPermissions` (canonical, mirrors the CLI flag name)
 *   2. `skipPermissions` (legacy alias from #4209 — kept for one
 *      deprecation window; emits a warning that the resolver returns so
 *      the caller can surface it once at boot).
 *
 * The resolver does NOT log directly — it returns a `deprecationWarning`
 * string so the caller decides when/where to surface it (server-cli logs
 * it once at startup; tests assert on the value). When the canonical key
 * is set the legacy key is ignored as a value-source but its mere
 * presence still triggers the warning (to nudge cleanup of stale
 * duplicates).
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   enabled: boolean,
 *   source: 'dangerouslySkipPermissions' | 'skipPermissions' | null,
 *   deprecationWarning: string | null,
 * }}
 */
export function resolveSkipPermissions(config) {
  const c = config || {}
  const canonical = c.dangerouslySkipPermissions
  const legacy = c.skipPermissions
  const legacyPresent = Object.prototype.hasOwnProperty.call(c, 'skipPermissions')

  const deprecationWarning = legacyPresent
    ? "config key 'skipPermissions' is deprecated — rename it to 'dangerouslySkipPermissions' to match the CLI flag name. Both keys are honoured for now; the legacy key will be removed in a future release."
    : null

  if (typeof canonical === 'boolean') {
    return {
      enabled: canonical,
      source: 'dangerouslySkipPermissions',
      // Even when the canonical key wins, surface the warning if the
      // legacy key is also set — operators should clean up the duplicate.
      deprecationWarning,
    }
  }

  if (typeof legacy === 'boolean') {
    return {
      enabled: legacy,
      source: 'skipPermissions',
      deprecationWarning,
    }
  }

  return {
    enabled: false,
    source: null,
    deprecationWarning: null,
  }
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

