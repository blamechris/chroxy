import { networkInterfaces } from 'os'

/** Interface name prefixes commonly used by VPN clients (macOS/Linux). */
const VPN_PREFIXES = ['utun', 'tun', 'tap', 'tailscale', 'ts', 'wg']

function isVpnInterface(name) {
  const lower = name.toLowerCase()
  return VPN_PREFIXES.some((p) => lower.startsWith(p))
}

/**
 * Return the first non-internal, non-VPN IPv4 address, or null if none found.
 * Used for connection URLs when running without a tunnel.
 *
 * VPN interfaces (WireGuard, OpenVPN, Tailscale) are skipped because phones
 * on the local WiFi cannot reach VPN-only addresses. Falls back to any
 * non-internal address if no non-VPN interface is found.
 */
export function getLanIp() {
  const nets = networkInterfaces()
  let fallback = null

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (!isVpnInterface(name)) {
          return net.address
        }
        if (!fallback) {
          fallback = net.address
        }
      }
    }
  }

  return fallback
}
