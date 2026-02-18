export { BaseTunnelAdapter } from './base.js'
export { registerTunnel, getTunnel, listTunnels, parseTunnelArg } from './registry.js'
export { CloudflareTunnelAdapter } from './cloudflare.js'

// Register built-in tunnel adapter
import { registerTunnel } from './registry.js'
import { CloudflareTunnelAdapter } from './cloudflare.js'

registerTunnel('cloudflare', CloudflareTunnelAdapter)
