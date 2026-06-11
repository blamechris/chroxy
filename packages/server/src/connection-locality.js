/**
 * Connection-locality classification (#5516, epic #5514).
 *
 * Decides whether an inbound WebSocket upgrade came from a LOCAL / LAN peer
 * (this machine over loopback, or another device on the local network) versus
 * through the Cloudflare tunnel / a remote proxy.
 *
 * Used to skip permessage-deflate for local/LAN peers: on a fast local link the
 * CPU cost of gzip-per-message buys nothing — the link isn't the bottleneck, so
 * compressing just adds latency and burns cycles on the (already busy) dev
 * machine. Tunnel connections KEEP deflate, where the WAN bandwidth saving is
 * real.
 *
 * SECURITY: this mirrors the trust model in rate-limiter.js. Proxy headers
 * (cf-connecting-ip / x-forwarded-for) are attacker-controllable over the
 * network, so they can only make us treat a connection as REMOTE (keep deflate
 * — the safe, unchanged default). They can never make a connection look local.
 * The only inputs that can flip a connection to "local" are the kernel-supplied
 * socket peer address (loopback or RFC1918) AND the ABSENCE of proxy headers.
 * Worst case for a spoofer: deflate stays on. No security property depends on
 * this classification — it's a pure transport-efficiency hint.
 */

import { isLoopbackHost } from './bind-host.js'
import { isPrivateOrSpecialIp } from './ssrf-guard.js'

function hasProxyHeaders(headers) {
  if (!headers) return false
  // A tunnel / reverse proxy stamps the original client IP here. Presence means
  // the TCP peer is a proxy, not the real client — treat as remote.
  return Boolean(headers['cf-connecting-ip'] || headers['x-forwarded-for'])
}

/**
 * True when the upgrade request comes directly from this machine (loopback) or
 * a LAN peer — i.e. NOT through the tunnel / a reverse proxy.
 *
 * @param {object} req - Node IncomingMessage. Reads `req.socket.remoteAddress`
 *   (kernel-supplied, unspoofable) and the proxy headers.
 * @returns {boolean}
 */
export function isLocalOrLanPeer(req) {
  const socketIp = req?.socket?.remoteAddress
  if (typeof socketIp !== 'string' || socketIp.length === 0) return false
  // Any proxy header => the TCP peer is a proxy (tunnel/CDN). Keep deflate.
  if (hasProxyHeaders(req.headers)) return false
  // Direct loopback (same machine) — definitely local.
  if (isLoopbackHost(socketIp)) return true
  // Direct RFC1918 / link-local peer with no proxy in front — a LAN device.
  if (isPrivateOrSpecialIp(socketIp)) return true
  return false
}
