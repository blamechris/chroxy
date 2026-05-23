/**
 * SSRF block-list — pure IP-classification logic extracted from
 * byok-tool-executor.js (#4186).
 *
 * Defense-in-depth check that refuses targets in private / loopback /
 * link-local / reserved / CGNAT / TEST-NET / benchmark / multicast ranges
 * so a model induced into fetching `http://169.254.169.254/`,
 * `http://127.0.0.1:<port>`, an RFC1918 address, or any IPv4-mapped
 * IPv6 form of the same can't hit the user's local / cloud-instance
 * environment.
 *
 * Pure module — no fs, no net, no DNS. Caller (WebFetch / isHostAllowed
 * in byok-tool-executor) does the DNS resolution and `process.env`
 * opt-out check. Keeping this file dependency-free lets the test suite
 * walk a large (ip, expected) table without any HTTP server spin-up.
 *
 * Background: #4132 introduced the original v4 blocklist; #4165 added the
 * v6 path and IPv4-mapped IPv6 recursion; #4167 / #4184 expanded the v4
 * ranges with CGNAT / TEST-NET / benchmark; #4186 extracted to this
 * standalone module so the boundary-test table (#4185) and IPv4-mapped
 * coverage (#4187) could grow without bloating the WebFetch integration
 * suite. Behaviour is identical to the pre-extraction `isPrivateOrSpecialIp`
 * — this is a pure refactor.
 */
import { isIP } from 'node:net'

/**
 * Returns true if `ipStr` is an IP literal in any of the blocked ranges
 * (or an IPv4-mapped IPv6 of one). Returns false for public-routable
 * IPs and for non-IP input (caller should resolve hostnames via DNS
 * first and pass each resolved address through this check).
 */
export function isPrivateOrSpecialIp(ipStr) {
  const v = isIP(ipStr)
  if (v === 4) {
    const [a, b, c] = ipStr.split('.').map((p) => parseInt(p, 10))
    if (a === 127) return true                              // loopback 127.0.0.0/8
    if (a === 10) return true                               // RFC1918 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true        // RFC1918 172.16.0.0/12
    if (a === 192 && b === 168) return true                 // RFC1918 192.168.0.0/16
    if (a === 169 && b === 254) return true                 // link-local 169.254.0.0/16
    if (a === 0) return true                                // 0.0.0.0/8 (this network)
    if (a >= 224) return true                               // multicast + reserved
    // #4167: defense-in-depth — ranges that aren't routable on the public
    // internet and have a history of colliding with internal infra.
    if (a === 100 && b >= 64 && b <= 127) return true       // CGNAT 100.64.0.0/10 (RFC 6598)
    if (a === 192 && b === 0 && c === 2) return true        // TEST-NET-1 192.0.2.0/24 (RFC 5737)
    if (a === 198 && b === 51 && c === 100) return true     // TEST-NET-2 198.51.100.0/24
    if (a === 203 && b === 0 && c === 113) return true      // TEST-NET-3 203.0.113.0/24
    if (a === 198 && (b === 18 || b === 19)) return true    // benchmark 198.18.0.0/15 (RFC 2544)
    return false
  }
  if (v === 6) {
    const lower = ipStr.toLowerCase()
    if (lower === '::1' || lower === '::') return true       // loopback / unspecified
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true  // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true    // ULA fc00::/7
    if (lower.startsWith('ff')) return true                              // multicast
    // IPv4-mapped IPv6: ::ffff:0:0/96 — last 32 bits are the IPv4 address.
    // Two textual forms exist:
    //   ::ffff:1.2.3.4         (dotted-quad tail)
    //   ::ffff:0102:0304       (hex tail — same address)
    // Pre-#4165 only the dotted form was caught; ::ffff:7f00:1
    // (= 127.0.0.1) would have bypassed the SSRF guard. Now we expand
    // the address into 8 hex groups and if it's IPv4-mapped we
    // materialise the v4 dotted form and recurse.
    const v4 = mappedV6ToV4(lower)
    if (v4) return isPrivateOrSpecialIp(v4)
    return false
  }
  // Not an IP literal; caller should resolve first.
  return false
}

/**
 * If `lower` is an IPv4-mapped IPv6 address (::ffff:0:0/96), return the
 * embedded IPv4 in dotted-quad form. Returns null for any other v6 or
 * for malformed input.
 *
 * Handles BOTH textual forms — caller may pass either dotted-tail
 * (::ffff:1.2.3.4) or hex-tail (::ffff:0102:0304). The two forms map
 * to the same v4 and must produce the same answer.
 */
export function mappedV6ToV4(lower) {
  if (typeof lower !== 'string') return null
  // Expand `::` so we have exactly 8 hex groups (or 6 hex + 1 dotted v4).
  let groups
  if (lower.includes('.')) {
    // Dotted-quad tail. Replace the trailing v4 with two hex groups.
    const lastColon = lower.lastIndexOf(':')
    if (lastColon < 0) return null
    const head = lower.slice(0, lastColon)
    const v4 = lower.slice(lastColon + 1)
    if (isIP(v4) !== 4) return null
    const [a, b, c, d] = v4.split('.').map((p) => parseInt(p, 10))
    const hex = `${((a << 8) | b).toString(16).padStart(4, '0')}:${((c << 8) | d).toString(16).padStart(4, '0')}`
    groups = expandV6Groups(`${head}:${hex}`)
  } else {
    groups = expandV6Groups(lower)
  }
  if (!groups || groups.length !== 8) return null
  // IPv4-mapped means groups[0..4] are 0 and groups[5] is ffff.
  for (let i = 0; i < 5; i++) if (groups[i] !== 0) return null
  if (groups[5] !== 0xffff) return null
  const g6 = groups[6]
  const g7 = groups[7]
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`
}

function expandV6Groups(addr) {
  const parts = addr.split('::')
  if (parts.length > 2) return null
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const missing = 8 - (left.length + right.length)
  if (missing < 0) return null
  const middle = parts.length === 2 ? new Array(missing).fill('0') : []
  const all = [...left, ...middle, ...right]
  if (all.length !== 8) return null
  const out = []
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}
