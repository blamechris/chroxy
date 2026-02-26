import { networkInterfaces } from 'os'

/**
 * Return the first non-internal IPv4 address, or null if none found.
 * Used for connection URLs when running without a tunnel.
 */
export function getLanIp() {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return null
}
