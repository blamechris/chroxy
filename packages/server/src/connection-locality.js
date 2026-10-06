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

import { isIPv4 } from 'node:net'
import { isLoopbackHost } from './bind-host.js'
import { isPrivateOrSpecialIp } from './ssrf-guard.js'

function hasProxyHeaders(headers) {
  if (!headers) return false
  // A tunnel / reverse proxy stamps the original client IP here. Presence means
  // the TCP peer is a proxy, not the real client — treat as remote. Test for
  // PRESENCE (!= null), not truthiness: a proxy that forwards an empty-string
  // header value still means "a proxy is in front", so it must keep deflate —
  // never be misclassified as a direct local peer.
  return headers['cf-connecting-ip'] != null || headers['x-forwarded-for'] != null
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

/**
 * Strict loopback parse for AUTHORIZATION use. Not `isLoopbackHost`, which is a
 * bind-host helper that accepts anything starting `::ffff:7f` — so
 * `::ffff:7f00:1:2`, which is not an address at all, would pass. Accepts exactly:
 *   - a dotted IPv4 literal in 127.0.0.0/8,
 *   - `::1`,
 *   - an IPv4-mapped `::ffff:a.b.c.d` whose dotted part is in 127.0.0.0/8.
 */
function isStrictLoopbackAddress(ip) {
  const addr = ip.toLowerCase()
  if (isIPv4(addr)) return addr.split('.')[0] === '127'
  if (addr === '::1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr)
  return !!mapped && isIPv4(mapped[1]) && mapped[1].split('.')[0] === '127'
}

/**
 * Any header a tunnel, CDN or reverse proxy leaves behind. Wider than
 * `hasProxyHeaders` on purpose: Cloudflare can strip the visitor-IP headers
 * (a managed transform), and then `cf-connecting-ip` is absent on a request
 * that very much came through the tunnel. What survives is the rest of the
 * family — `cf-ray`, `cf-visitor`, `cdn-loop`, `x-forwarded-proto`. Presence of
 * the NAME is the test; the value is never trusted.
 */
function hasAnyProxyHint(headers) {
  if (!headers) return false
  for (const name of Object.keys(headers)) {
    const n = name.toLowerCase()
    if (n.startsWith('cf-') || n.startsWith('cdn-loop') || n.startsWith('forwarded') ||
        n.startsWith('x-forwarded-') || n === 'x-real-ip') return true
  }
  return false
}

/**
 * True only when the request comes DIRECTLY from this machine over loopback —
 * no LAN peers, and nothing that arrived through the tunnel (#8324).
 *
 * Stricter than `isLocalOrLanPeer`. That function is a transport-efficiency
 * hint with no security property riding on it; this one is an AUTHORIZATION
 * input (the local-only `/api/daemon/idle` probe), so it fails closed twice
 * over: the socket address is parsed strictly, and ANY proxy-family header
 * disqualifies the request.
 *
 * cloudflared connects to the daemon from 127.0.0.1, so the socket address
 * alone proves nothing. Headers can be forged by a remote caller only in the
 * direction that makes a request look remote; a request that merely OMITS them
 * is not made local by that, because the tunnel adds its own. This gate is
 * defence in depth — the primary bearer token is the authority.
 *
 * @param {object} req - Node IncomingMessage.
 * @returns {boolean}
 */
export function isLoopbackPeer(req) {
  const socketIp = req?.socket?.remoteAddress
  if (typeof socketIp !== 'string' || socketIp.length === 0) return false
  if (hasAnyProxyHint(req.headers)) return false
  return isStrictLoopbackAddress(socketIp)
}
