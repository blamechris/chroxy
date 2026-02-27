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
 *   - Expose properties: model, permissionMode, isRunning, resumeSessionId
 *   - Emit events: ready, stream_start, stream_delta, stream_end, message,
 *     tool_start, result, error, user_question, agent_spawned, agent_completed
 *   - Implement `static get capabilities()` returning ProviderCapabilities
 */

const providers = new Map()

/**
 * Register a provider class by name.
 * @param {string} name - Provider identifier (e.g. 'claude-sdk')
 * @param {Function} ProviderClass - Session class with static capabilities getter
 */
export function registerProvider(name, ProviderClass) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Provider name must be a non-empty string')
  }
  if (typeof ProviderClass !== 'function') {
    throw new Error(`Provider "${name}" must be a class/constructor`)
  }
  providers.set(name, ProviderClass)
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
 * @returns {Array<{ name: string, capabilities: ProviderCapabilities }>}
 */
export function listProviders() {
  const list = []
  for (const [name, ProviderClass] of providers) {
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

registerProvider('claude-cli', CliSession)
registerProvider('claude-sdk', SdkSession)
