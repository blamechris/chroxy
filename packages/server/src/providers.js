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
 * List all registered providers with their capabilities.
 * Excludes aliases (e.g. 'docker') to prevent duplicate entries in UI.
 * @returns {Array<{ name: string, capabilities: object }>}
 */
export function listProviders() {
  const list = []
  for (const [name, ProviderClass] of Object.entries(PROVIDERS)) {
    if (HIDDEN.has(name)) continue
    list.push({
      name,
      capabilities: ProviderClass.capabilities || {},
    })
  }
  return list
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
