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
 *   'cloudflare:none'  → null
 *   'none' / ''        → null
 *
 * Fails closed: any other `cloudflare:<mode>` throws. It used to be passed through
 * as an arbitrary mode, and the adapter treated every mode other than `named` as a
 * PUBLIC quick tunnel, so a typo (`cloudflare:naemd`) opened one.
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
    if (mode === 'none') return null
    if (mode !== 'quick' && mode !== 'named') {
      throw new Error(`Unknown tunnel mode "${mode}" in "${value}". Use: cloudflare:quick, cloudflare:named, or none. Refusing to start a tunnel.`)
    }
    return { mode }
  }

  throw new Error(`Unknown tunnel value "${value}". Use: quick, named, cloudflare, cloudflare:quick, cloudflare:named, or none`)
}

/**
 * Create a CloudflareTunnelAdapter instance from a config object.
 *
 * @param {{ port: number, mode: string, tunnelConfig?: object, tunnelName?: string, tunnelHostname?: string, binaryProvenance?: object }} config
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
      // #6858: opt-in provenance gate for the cloudflared spawn. A plain-ish bag
      // ({ mode, signatureGate, ledger }); undefined ⇒ the gate is skipped.
      binaryProvenance: config.binaryProvenance || null,
    },
  })
}
