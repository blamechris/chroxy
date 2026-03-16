import { CloudflareTunnelAdapter } from './cloudflare.js'

export { BaseTunnelAdapter } from './base.js'
export { CloudflareTunnelAdapter } from './cloudflare.js'

/**
 * Parse a --tunnel flag value into { mode } or null (for 'none').
 *
 * Accepted values:
 *   'quick'            → { mode: 'quick' }
 *   'named'            → { mode: 'named' }
 *   'cloudflare'       → { mode: 'quick' }
 *   'cloudflare:quick' → { mode: 'quick' }
 *   'cloudflare:named' → { mode: 'named' }
 *   'none' / ''        → null
 *
 * @param {string} value - Raw --tunnel flag value
 * @returns {{ mode: string } | null}
 */
export function parseTunnelArg(value) {
  if (!value || value === 'none') return null

  if (value === 'quick') return { mode: 'quick' }
  if (value === 'named') return { mode: 'named' }
  if (value === 'cloudflare') return { mode: 'quick' }

  if (value.startsWith('cloudflare:')) {
    const mode = value.slice('cloudflare:'.length)
    if (!mode) {
      throw new Error(`Invalid tunnel format "${value}". Expected "cloudflare:quick" or "cloudflare:named"`)
    }
    return { mode }
  }

  throw new Error(`Unknown tunnel value "${value}". Use: quick, named, cloudflare, cloudflare:quick, cloudflare:named, or none`)
}

/**
 * Create a CloudflareTunnelAdapter instance from a config object.
 *
 * @param {{ port: number, mode: string, tunnelConfig?: object, tunnelName?: string, tunnelHostname?: string }} config
 * @returns {CloudflareTunnelAdapter}
 */
export function createTunnel(config) {
  return new CloudflareTunnelAdapter({
    port: config.port,
    mode: config.mode,
    config: {
      ...config.tunnelConfig,
      tunnelName: config.tunnelName || null,
      tunnelHostname: config.tunnelHostname || null,
    },
  })
}
