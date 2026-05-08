/**
 * Provider registry for session backends.
 *
 * Built-in providers are a plain object literal below. Docker providers are
 * registered lazily by registerDockerProvider() when environments are enabled
 * and the Docker daemon is reachable.
 *
 * To add a new first-class provider: import the session class and add it to
 * the PROVIDERS literal. To add one externally (rare), call registerProvider()
 * — but editing this file is preferred.
 *
 * Session classes must extend EventEmitter and expose start/destroy/sendMessage/
 * interrupt/setModel/setPermissionMode plus a static `capabilities` getter.
 * See sdk-session.js or cli-session.js for a worked example.
 */
import { CliSession } from './cli-session.js'
import { SdkSession } from './sdk-session.js'
import { GeminiSession } from './gemini-session.js'
import { CodexSession } from './codex-session.js'
import { registerProviderRegistry } from './models.js'

const PROVIDERS = {
  'claude-cli': CliSession,
  'claude-sdk': SdkSession,
  'gemini': GeminiSession,
  'codex': CodexSession,
}

// Names hidden from listProviders() (backward-compat aliases, etc.)
const HIDDEN = new Set()

// Seed per-provider registries for built-in providers so models.js can
// resolve provider-scoped model metadata without waiting for registerProvider.
for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
  registerProviderRegistry(name, ProviderClass)
}

/** Required methods every provider class prototype must expose. */
const REQUIRED_METHODS = ['sendMessage', 'interrupt', 'setModel', 'setPermissionMode', 'start', 'destroy']

/** Methods required when the provider handles permissions in-process. */
const IN_PROCESS_PERMISSION_METHODS = ['respondToPermission', 'respondToQuestion']

/**
 * Validates that a provider class implements the ProviderSession interface.
 * Checks the class prototype so no instance is created during registration.
 * When `ProviderClass.capabilities.inProcessPermissions` is true, also validates
 * that `respondToPermission` and `respondToQuestion` are present.
 * @param {Function} ProviderClass - Session class to validate
 * @param {string} name - Provider name for error messages
 * @throws {Error} If any required method is missing from the prototype
 */
export function validateProviderClass(ProviderClass, name) {
  if (typeof ProviderClass !== 'function' || !ProviderClass.prototype) {
    throw new Error(`Provider '${name}' must be a constructable class`)
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof ProviderClass.prototype[method] !== 'function') {
      throw new Error(`Provider '${name}' missing required method: ${method}`)
    }
  }
  if (ProviderClass.capabilities?.inProcessPermissions) {
    for (const method of IN_PROCESS_PERMISSION_METHODS) {
      if (typeof ProviderClass.prototype[method] !== 'function') {
        throw new Error(`Provider '${name}' has inProcessPermissions=true but is missing required method: ${method}`)
      }
    }
  }
}

/**
 * Register a provider class by name.
 * @param {string} name - Provider identifier (e.g. 'claude-sdk')
 * @param {Function} ProviderClass - Session class with static capabilities getter
 * @param {{ alias?: boolean }} [opts] - Mark as alias to exclude from listProviders()
 */
export function registerProvider(name, ProviderClass, opts) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Provider name must be a non-empty string')
  }
  if (typeof ProviderClass !== 'function') {
    throw new Error(`Provider "${name}" must be a class/constructor`)
  }
  validateProviderClass(ProviderClass, name)
  PROVIDERS[name] = ProviderClass
  if (opts?.alias) HIDDEN.add(name)
  // Expose the class to models.js so the per-provider model registry
  // (#2956) can source its fallback list and ID convention from the
  // provider itself instead of hard-coding Claude behaviour globally.
  registerProviderRegistry(name, ProviderClass)
}

/**
 * Get a registered provider class by name.
 * @param {string} name - Provider identifier
 * @returns {Function} Provider class
 * @throws {Error} If provider is not registered
 */
export function getProvider(name) {
  const ProviderClass = PROVIDERS[name]
  if (!ProviderClass) {
    const available = Object.keys(PROVIDERS).join(', ')
    throw new Error(`Unknown provider "${name}". Available: ${available}`)
  }
  return ProviderClass
}

/**
 * Resolve a human-readable label for a provider name (#2953).
 *
 * Reads the class's `static get displayLabel()` so each provider owns its own
 * display name. Falls back to the raw provider id for unknown providers so
 * the server still boots with a readable banner even if someone registers a
 * custom provider without a label, and returns `'unknown'` for empty input.
 *
 * @param {string | undefined | null} name - Provider identifier
 * @returns {string} Human-readable label
 */
export function resolveProviderLabel(name) {
  if (!name || typeof name !== 'string') return 'unknown'
  const ProviderClass = PROVIDERS[name]
  if (ProviderClass && typeof ProviderClass.displayLabel === 'string' && ProviderClass.displayLabel.length > 0) {
    return ProviderClass.displayLabel
  }
  return name
}

/**
 * Collect the unique data directories for all registered (non-hidden) providers
 * that expose a static `dataDir` getter (#2965).
 *
 * Consumers (conversation-scanner, ws-file-ops) call this instead of hardcoding
 * ~/.claude so that every registered provider's data is included automatically.
 * Docker aliases are excluded (they share the same dataDir as their base) and
 * providers that do not define dataDir are skipped silently.
 *
 * @returns {string[]} Deduplicated list of absolute data directory paths.
 */
export function getProviderDataDirs() {
  const seen = new Set()
  const dirs = []
  for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
    if (HIDDEN.has(name)) continue
    const dir = ProviderClass.dataDir
    if (typeof dir !== 'string' || dir.length === 0) continue
    if (seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * List all registered providers with their capabilities.
 * Excludes aliases (e.g. 'docker') to prevent duplicate entries in UI.
 *
 * `sessionRules` capability is derived from method existence: a provider
 * supports session-scoped rules iff its prototype has `setPermissionRules`.
 * Clients use this to gate the "Allow for Session" UI affordance (#3072).
 *
 * `auth` (#3404 audit F1+F5) summarises whether the provider can actually run
 * sessions right now and which billing identity is on the hook. Lets the
 * dashboard grey-out unusable providers and surface a billing-confidence
 * panel without making the user shell out and run `chroxy doctor`.
 *
 * @returns {Array<{ name: string, capabilities: object, auth: object }>}
 */
export function listProviders() {
  const list = []
  for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
    if (HIDDEN.has(name)) continue
    list.push({
      name,
      capabilities: {
        ...(ProviderClass.capabilities || {}),
        sessionRules: typeof ProviderClass.prototype.setPermissionRules === 'function',
      },
      auth: getProviderAuthInfo(name, ProviderClass),
    })
  }
  return list
}

/**
 * Resolve the auth/billing state for a single provider.
 *
 * The Claude CLI provider (and its docker-cli variant) explicitly strips
 * `ANTHROPIC_API_KEY` before spawning the binary — see spawn-env.js's
 * `claude` denylist — so it always bills the claude.ai subscription
 * regardless of whether the env var is present. Other providers route to
 * whichever credential they find first.
 *
 * Returns:
 *   ready    : boolean — false only when required creds are missing
 *   source   : 'env' | 'oauth' | 'none'
 *   envVar   : matched env var name (null when source !== 'env')
 *   envVars  : env var candidates checked
 *   hint     : human-readable fix hint
 *   detail   : human-readable summary including billing identity
 *
 * @param {string} name
 * @param {Function} ProviderClass
 */
function getProviderAuthInfo(name, ProviderClass) {
  const spec = ProviderClass.preflight
  const credSpec = spec?.credentials
  const envVars = (credSpec && Array.isArray(credSpec.envVars)) ? credSpec.envVars : []
  const optional = !!credSpec?.optional
  const hint = credSpec?.hint || (envVars.length ? `set ${envVars.join(' or ')}` : '')

  // Providers that opt out of preflight credentials checking (custom/external
  // providers, or any class that doesn't declare a `credentials` block) have
  // no env-var requirement we can verify — treat as ready so the UI doesn't
  // disable a working provider just because it skipped declaring preflight.
  if (!credSpec) {
    return {
      ready: true,
      source: 'none',
      envVar: null,
      envVars: [],
      hint: '',
      detail: 'No credential check declared by this provider',
    }
  }

  // Bare claude-cli on the host always bills subscription: spawn-env.js's
  // `claude` denylist strips ANTHROPIC_API_KEY before the subprocess starts,
  // and the CLI auths via the host's ~/.claude OAuth state.
  // Note: docker-cli is NOT in this set — see container-provider handling below.
  const isHostClaudeCli = name === 'claude-cli'

  // Container providers (docker-cli / docker-sdk) explicitly forward
  // process.env.ANTHROPIC_API_KEY to the container at `docker run` time
  // (see docker-session.js _startContainer + docker-sdk-session.js _startContainer).
  // Inside the container there is no ~/.claude OAuth state, so the env var
  // is the only auth path — no OAuth fallback even though the host-side
  // preflight marks credentials as optional.
  const isContainerProvider = name === 'docker-cli' || name === 'docker-sdk'

  if (isHostClaudeCli) {
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint: 'run `claude login` if not yet authed',
      detail: 'Claude subscription (CLI strips ANTHROPIC_API_KEY before spawn)',
    }
  }

  // Look for any matching env var.
  const matched = envVars.find(v => process.env[v])

  if (matched) {
    return {
      ready: true,
      source: 'env',
      envVar: matched,
      envVars,
      hint: '',
      detail: `${describeBillingIdentity(name, matched)} (${matched} set)`,
    }
  }

  // Container providers can't reach host OAuth state — required-only.
  if (isContainerProvider) {
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint: hint || 'set ANTHROPIC_API_KEY (forwarded to the container at run time)',
      detail: 'Not configured — container providers need ANTHROPIC_API_KEY on the host (no OAuth fallback inside the container)',
    }
  }

  // No env var matched — optional creds (host claude-sdk) get an OAuth fallback.
  if (optional) {
    return {
      ready: true,
      source: 'oauth',
      envVar: null,
      envVars,
      hint,
      detail: `${describeBillingIdentity(name, null)} (OAuth fallback — run \`claude login\` to verify)`,
    }
  }

  // Required creds missing — provider can't run.
  return {
    ready: false,
    source: 'none',
    envVar: null,
    envVars,
    hint,
    detail: envVars.length
      ? `Not configured — ${hint}`
      : 'Not configured',
  }
}

function describeBillingIdentity(name, envVar) {
  // Claude SDK family + ANTHROPIC_API_KEY → API; else OAuth fallback → subscription.
  if (name === 'claude-sdk') {
    if (envVar === 'ANTHROPIC_API_KEY') return 'Anthropic API'
    if (envVar === 'CLAUDE_CODE_OAUTH_TOKEN') return 'Anthropic API (OAuth token)'
    return 'Claude subscription'
  }
  // Container providers always bill API (no in-container OAuth fallback).
  if (name === 'docker-cli' || name === 'docker-sdk') {
    if (envVar === 'ANTHROPIC_API_KEY') return 'Anthropic API (forwarded to container)'
    if (envVar === 'CLAUDE_CODE_OAUTH_TOKEN') return 'Anthropic API (OAuth token forwarded to container)'
    return 'Anthropic API (forwarded to container)'
  }
  if (name === 'codex') return 'OpenAI API'
  if (name === 'gemini') return 'Google API'
  return 'External provider'
}

/**
 * Register docker providers when environments are enabled.
 * Probes `docker info` to confirm Docker is available; skips silently if not.
 *
 * Registers:
 *   - 'docker-cli': DockerSession (CLI-based, extends CliSession)
 *   - 'docker-sdk': DockerSdkSession (SDK-based, extends SdkSession)
 *   - 'docker': backward-compatible alias for 'docker-cli'
 *
 * @param {object} config - Merged server config
 */
export async function registerDockerProvider(config) {
  if (!config?.environments?.enabled) return

  const { createLogger } = await import('./logger.js')
  const log = createLogger('providers')

  const { execFileSync } = await import('child_process')
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
  } catch {
    log.warn('Docker not available — docker providers disabled')
    return
  }

  const { DockerSession } = await import('./docker-session.js')
  registerProvider('docker-cli', DockerSession)

  const { DockerSdkSession } = await import('./docker-sdk-session.js')
  registerProvider('docker-sdk', DockerSdkSession)

  // Backward compatibility: 'docker' maps to 'docker-cli' (hidden from listProviders)
  registerProvider('docker', DockerSession, { alias: true })

  log.info('Docker providers registered (docker-cli, docker-sdk)')
}
