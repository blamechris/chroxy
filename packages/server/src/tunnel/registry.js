/**
 * Tunnel adapter registry.
 *
 * Mirrors the provider registry pattern (providers.js). Tunnel adapters
 * register by name; consumers look them up via getTunnel().
 */

const tunnels = new Map()

/**
 * Register a tunnel adapter class by name.
 * @param {string} name - Tunnel provider identifier (e.g. 'cloudflare')
 * @param {Function} AdapterClass - Tunnel adapter class extending BaseTunnelAdapter
 */
export function registerTunnel(name, AdapterClass) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Tunnel name must be a non-empty string')
  }
  if (typeof AdapterClass !== 'function') {
    throw new Error(`Tunnel "${name}" must be a class/constructor`)
  }
  tunnels.set(name, AdapterClass)
}

/**
 * Get a registered tunnel adapter class by name.
 * @param {string} name - Tunnel provider identifier
 * @returns {Function} Tunnel adapter class
 * @throws {Error} If tunnel provider is not registered
 */
export function getTunnel(name) {
  const AdapterClass = tunnels.get(name)
  if (!AdapterClass) {
    const available = [...tunnels.keys()].join(', ')
    throw new Error(`Unknown tunnel provider "${name}". Available: ${available}`)
  }
  return AdapterClass
}

/**
 * List all registered tunnel providers with their capabilities.
 * @returns {Array<{ name: string, capabilities: object }>}
 */
export function listTunnels() {
  const list = []
  for (const [name, AdapterClass] of tunnels) {
    list.push({
      name,
      capabilities: AdapterClass.capabilities || {},
    })
  }
  return list
}

/**
 * Parse a --tunnel flag value into { provider, mode } or null (for 'none').
 *
 * Backward-compatible shortcuts:
 *   'quick'  → { provider: 'cloudflare', mode: 'quick' }
 *   'named'  → { provider: 'cloudflare', mode: 'named' }
 *   'none'   → null
 *
 * Explicit provider syntax:
 *   'cloudflare'       → { provider: 'cloudflare', mode: 'quick' }
 *   'cloudflare:quick' → { provider: 'cloudflare', mode: 'quick' }
 *   'cloudflare:named' → { provider: 'cloudflare', mode: 'named' }
 *   'ngrok'            → { provider: 'ngrok', mode: 'default' }
 *
 * @param {string} value - Raw --tunnel flag value
 * @returns {{ provider: string, mode: string } | null}
 */
export function parseTunnelArg(value) {
  if (!value || value === 'none') return null

  // Backward-compat shortcuts
  if (value === 'quick') return { provider: 'cloudflare', mode: 'quick' }
  if (value === 'named') return { provider: 'cloudflare', mode: 'named' }

  // Explicit provider:mode syntax
  if (value.includes(':')) {
    const [provider, mode] = value.split(':', 2)
    return { provider, mode }
  }

  // Provider name only — use default mode
  // For cloudflare, default mode is 'quick' for backward compat
  if (value === 'cloudflare') return { provider: 'cloudflare', mode: 'quick' }

  return { provider: value, mode: 'default' }
}
