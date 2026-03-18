/**
 * Provider registry for session backends.
 *
 * Decouples SessionManager from specific session implementations.
 * New providers can be registered without modifying SessionManager or WsServer.
 *
 * Built-in providers:
 *   - 'claude-sdk': Agent SDK session (SdkSession) — default
 *   - 'claude-cli': Legacy CLI process session (CliSession)
 *
 * Docker providers (registered at runtime when environments are enabled):
 *   - 'docker-cli': Docker-isolated CLI session (DockerSession)
 *   - 'docker-sdk': Docker-isolated SDK session (DockerSdkSession)
 *   - 'docker': backward-compatible alias for 'docker-cli'
 *
 * Example: Registering a custom provider
 * ```js
 * import { EventEmitter } from 'events'
 * import { registerProvider } from './providers.js'
 *
 * class CustomSession extends EventEmitter {
 *   constructor({ cwd, model, permissionMode, port, apiToken }) {
 *     super()
 *     this.cwd = cwd
 *     this.model = model
 *     this.permissionMode = permissionMode
 *     this.isRunning = false
 *     this.resumeSessionId = null
 *   }
 *
 *   static get capabilities() {
 *     return {
 *       permissions: true,
 *       inProcessPermissions: false,
 *       modelSwitch: true,
 *       permissionModeSwitch: true,
 *       planMode: false,
 *       resume: false,
 *       terminal: false,
 *       thinkingLevel: false,
 *     }
 *   }
 *
 *   start() { ... }
 *   destroy() { ... }
 *   sendMessage(text) { ... }
 *   setModel(model) { ... }
 *   setPermissionMode(mode) { ... }
 * }
 *
 * registerProvider('my-custom-provider', CustomSession)
 * // Now use: npx chroxy start --provider my-custom-provider
 * ```
 *
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} permissions      - Supports permission handling
 * @property {boolean} inProcessPermissions - Handles permissions in-process (no HTTP hook)
 * @property {boolean} modelSwitch      - Supports live model switching
 * @property {boolean} permissionModeSwitch - Supports live permission mode switching
 * @property {boolean} planMode         - Emits plan mode events
 * @property {boolean} resume           - Supports conversation resume via resumeSessionId
 * @property {boolean} terminal         - Provides raw terminal output
 *
 * Provider classes must:
 *   - Extend EventEmitter
 *   - Accept a config object in constructor: { cwd, model, permissionMode, ... }
 *   - Expose: start(), destroy(), sendMessage(text), setModel(model), setPermissionMode(mode)
 *   - start() MUST be synchronous (throw on failure, don't return a rejected promise)
 *   - Expose properties: model, permissionMode, isRunning, resumeSessionId
 *   - Emit events: ready, stream_start, stream_delta, stream_end, message,
 *     tool_start, result, error, user_question, agent_spawned, agent_completed
 *   - Implement `static get capabilities()` returning ProviderCapabilities
 */

const providers = new Map()
const aliases = new Set()

/**
 * Register a provider class by name.
 * @param {string} name - Provider identifier (e.g. 'claude-sdk')
 * @param {Function} ProviderClass - Session class with static capabilities getter
 * @param {{ alias: boolean }} [opts] - Mark as alias to exclude from listProviders()
 */
export function registerProvider(name, ProviderClass, opts) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Provider name must be a non-empty string')
  }
  if (typeof ProviderClass !== 'function') {
    throw new Error(`Provider "${name}" must be a class/constructor`)
  }
  providers.set(name, ProviderClass)
  if (opts?.alias) aliases.add(name)
}

/**
 * Get a registered provider class by name.
 * @param {string} name - Provider identifier
 * @returns {Function} Provider class
 * @throws {Error} If provider is not registered
 */
export function getProvider(name) {
  const ProviderClass = providers.get(name)
  if (!ProviderClass) {
    const available = [...providers.keys()].join(', ')
    throw new Error(`Unknown provider "${name}". Available: ${available}`)
  }
  return ProviderClass
}

/**
 * List all registered providers with their capabilities.
 * Excludes aliases (e.g. 'docker') to prevent duplicate entries in UI.
 * @returns {Array<{ name: string, capabilities: ProviderCapabilities }>}
 */
export function listProviders() {
  const list = []
  for (const [name, ProviderClass] of providers) {
    if (aliases.has(name)) continue
    list.push({
      name,
      capabilities: ProviderClass.capabilities || {},
    })
  }
  return list
}

// Register built-in providers
import { CliSession } from './cli-session.js'
import { SdkSession } from './sdk-session.js'
import { GeminiSession } from './gemini-session.js'
import { CodexSession } from './codex-session.js'

registerProvider('claude-cli', CliSession)
registerProvider('claude-sdk', SdkSession)
registerProvider('gemini', GeminiSession)
registerProvider('codex', CodexSession)

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
