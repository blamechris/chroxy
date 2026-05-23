/**
 * Unit tests for the SSRF block-list (#4186).
 *
 * Previously this logic was tested only indirectly via WebFetch HTTP
 * integration tests in byok-tool-executor.test.js. Extracting into a
 * pure module lets us walk a large (ip, expected) table without
 * spinning up an HTTP server per case, which makes adding new ranges
 * cheap and the suite fast.
 *
 * This file also closes:
 *   - #4185 (outside-range boundary tests for the #4184 additions)
 *   - #4187 (IPv4-mapped IPv6 coverage for the same ranges, both
 *            textual forms — dotted-tail and hex-tail)
 *
 * The contract: isPrivateOrSpecialIp(ipStr) returns
 *   true  → ip is in a private / loopback / link-local / reserved /
 *           CGNAT / TEST-NET / benchmark / multicast range, OR
 *           it's an IPv4-mapped IPv6 of one of the above.
 *   false → public-routable IP, OR a non-IP literal (caller should
 *           resolve via DNS first).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateOrSpecialIp, mappedV6ToV4 } from '../src/ssrf-guard.js'

// Each entry: [ip, expectedBlocked, why].
// `why` is rendered in the assertion message so a regression points at
// the exact range that broke instead of "expected true got false".
const IPV4_BLOCKED = [
  // RFC1918 + loopback
  ['127.0.0.1', true, 'loopback 127/8 (canonical)'],
  ['127.255.255.254', true, 'loopback 127/8 (high end)'],
  ['10.0.0.1', true, 'RFC1918 10/8 (low end)'],
  ['10.255.255.255', true, 'RFC1918 10/8 (high end)'],
  ['172.16.0.1', true, 'RFC1918 172.16/12 (low end)'],
  ['172.31.255.255', true, 'RFC1918 172.16/12 (high end)'],
  ['192.168.0.1', true, 'RFC1918 192.168/16 (low end)'],
  ['192.168.255.255', true, 'RFC1918 192.168/16 (high end)'],
  // link-local / this-network / multicast
  ['169.254.1.1', true, 'link-local 169.254/16'],
  ['169.254.169.254', true, 'AWS/GCE metadata endpoint'],
  ['0.0.0.0', true, 'this-network 0/8'],
  ['0.1.2.3', true, 'this-network 0/8 (non-zero)'],
  ['224.0.0.1', true, 'multicast 224/4 (low end)'],
  ['239.255.255.255', true, 'multicast 224/4 (high end)'],
  ['255.255.255.255', true, 'reserved/broadcast 240+'],
  // #4184 additions — defense in depth
  ['100.64.0.1', true, 'CGNAT 100.64/10 (low end, RFC 6598)'],
  ['100.127.255.254', true, 'CGNAT 100.64/10 (high end)'],
  ['192.0.2.1', true, 'TEST-NET-1 192.0.2/24'],
  ['198.51.100.1', true, 'TEST-NET-2 198.51.100/24'],
  ['203.0.113.1', true, 'TEST-NET-3 203.0.113/24'],
  ['198.18.0.1', true, 'benchmark 198.18/15 (low end, RFC 2544)'],
  ['198.19.255.254', true, 'benchmark 198.18/15 (high end)'],
]

// #4185: just-outside cases. These addresses are ONE STEP outside the
// blocked range — if a range constant ever gets fat-fingered (off-by-one
// on the high or low boundary), one of these flips true and we catch the
// regression instantly. Each pair brackets the boundary at both ends
// where applicable.
const IPV4_PUBLIC = [
  // Real public ips for sanity
  ['8.8.8.8', false, 'Google DNS (sanity public)'],
  ['1.1.1.1', false, 'Cloudflare DNS (sanity public)'],
  // RFC1918 boundaries
  ['11.0.0.0', false, 'just past 10/8'],
  ['172.15.255.255', false, 'one below 172.16/12'],
  ['172.32.0.0', false, 'one past 172.16/12'],
  ['192.167.255.255', false, 'one below 192.168/16'],
  ['192.169.0.0', false, 'one past 192.168/16'],
  // link-local boundaries
  ['169.253.255.255', false, 'one below 169.254/16'],
  ['169.255.0.0', false, 'one past 169.254/16'],
  // multicast boundary
  ['223.255.255.255', false, 'one below 224/4 (multicast lower bound)'],
  // CGNAT boundaries (#4185)
  ['100.63.255.255', false, 'one below 100.64/10 (CGNAT lower bound)'],
  ['100.128.0.0', false, 'one past 100.64/10 (CGNAT upper bound)'],
  // TEST-NET boundaries (#4185)
  ['192.0.1.255', false, 'one below TEST-NET-1'],
  ['192.0.3.0', false, 'one past TEST-NET-1'],
  ['198.51.99.255', false, 'one below TEST-NET-2'],
  ['198.51.101.0', false, 'one past TEST-NET-2'],
  ['203.0.112.255', false, 'one below TEST-NET-3'],
  ['203.0.114.0', false, 'one past TEST-NET-3'],
  // Benchmark boundaries (#4185)
  ['198.17.255.255', false, 'one below 198.18/15 (benchmark lower bound)'],
  ['198.20.0.0', false, 'one past 198.18/15 (benchmark upper bound)'],
  // Adjacent allocations that share a /16 prefix with TEST-NET / benchmark
  // but are NOT in the blocked range — defense against a sloppy /16 check.
  ['192.0.0.1', false, '192.0.0/24 (IANA Special Use, but we only block 192.0.2/24)'],
  ['198.51.0.1', false, '198.51/16 outside the /24 TEST-NET hole'],
  ['203.0.0.1', false, '203.0/16 outside the /24 TEST-NET hole'],
]

const IPV6_BLOCKED = [
  ['::1', true, 'IPv6 loopback'],
  ['::', true, 'IPv6 unspecified'],
  ['fe80::1', true, 'IPv6 link-local fe80::/10 (canonical)'],
  ['feb0::1', true, 'IPv6 link-local fe80::/10 (high prefix)'],
  ['fc00::1', true, 'IPv6 ULA fc00::/7'],
  ['fd12:3456:789a::1', true, 'IPv6 ULA fd00:: variant'],
  ['ff02::1', true, 'IPv6 multicast'],
]

const IPV6_PUBLIC = [
  ['2606:4700:4700::1111', false, 'Cloudflare public IPv6'],
  ['2001:4860:4860::8888', false, 'Google public IPv6'],
  ['fec0::1', false, 'old site-local (deprecated, but not in our block-list)'],
]

// #4187: IPv4-mapped IPv6 must trip the IPv4 check for EVERY blocked v4
// range, in BOTH textual forms (dotted-tail and hex-tail). Pre-Copilot
// the hex-tail form would have bypassed the SSRF guard for several
// ranges; we keep a row per (range, form) so a regression on the
// mappedV6ToV4 expander surfaces at the range that breaks.
const IPV4_MAPPED_V6 = [
  // dotted-tail form
  ['::ffff:127.0.0.1', true, 'mapped loopback (dotted tail)'],
  ['::ffff:10.0.0.1', true, 'mapped RFC1918 10/8 (dotted tail)'],
  ['::ffff:172.20.0.1', true, 'mapped RFC1918 172.16/12 (dotted tail)'],
  ['::ffff:192.168.1.1', true, 'mapped RFC1918 192.168/16 (dotted tail)'],
  ['::ffff:169.254.169.254', true, 'mapped metadata endpoint (dotted tail)'],
  ['::ffff:100.64.0.1', true, 'mapped CGNAT (dotted tail) — #4187'],
  ['::ffff:192.0.2.1', true, 'mapped TEST-NET-1 (dotted tail) — #4187'],
  ['::ffff:198.51.100.1', true, 'mapped TEST-NET-2 (dotted tail) — #4187'],
  ['::ffff:203.0.113.1', true, 'mapped TEST-NET-3 (dotted tail) — #4187'],
  ['::ffff:198.18.0.1', true, 'mapped benchmark (dotted tail) — #4187'],
  // hex-tail form (must produce the same v4 → same verdict)
  ['::ffff:7f00:1', true, 'mapped loopback (hex tail) — 127.0.0.1'],
  ['::ffff:0a00:1', true, 'mapped RFC1918 10/8 (hex tail) — 10.0.0.1'],
  ['::ffff:ac14:1', true, 'mapped RFC1918 172.20/16 (hex tail) — 172.20.0.1'],
  ['::ffff:c0a8:101', true, 'mapped RFC1918 192.168/16 (hex tail) — 192.168.1.1'],
  ['::ffff:a9fe:a9fe', true, 'mapped metadata endpoint (hex tail) — 169.254.169.254'],
  ['::ffff:6440:1', true, 'mapped CGNAT (hex tail) — 100.64.0.1 — #4187'],
  ['::ffff:c000:201', true, 'mapped TEST-NET-1 (hex tail) — 192.0.2.1 — #4187'],
  ['::ffff:c633:6401', true, 'mapped TEST-NET-2 (hex tail) — 198.51.100.1 — #4187'],
  ['::ffff:cb00:7101', true, 'mapped TEST-NET-3 (hex tail) — 203.0.113.1 — #4187'],
  ['::ffff:c612:1', true, 'mapped benchmark (hex tail) — 198.18.0.1 — #4187'],
  // public v4 mapped → MUST stay false (otherwise we break legitimate fetches)
  ['::ffff:8.8.8.8', false, 'mapped public v4 (dotted tail) — Google DNS'],
  ['::ffff:0808:0808', false, 'mapped public v4 (hex tail) — same Google DNS'],
]

const NON_IP_INPUT = [
  ['', false, 'empty string'],
  ['not-an-ip', false, 'arbitrary string'],
  ['example.com', false, 'hostname (caller must resolve first)'],
  ['256.256.256.256', false, 'invalid IPv4 literal'],
  ['gg::1', false, 'invalid IPv6 literal'],
]

describe('isPrivateOrSpecialIp — IPv4 block-list', () => {
  for (const [ip, expected, why] of IPV4_BLOCKED) {
    it(`blocks ${ip} (${why})`, () => {
      assert.equal(isPrivateOrSpecialIp(ip), expected, `${ip} should be blocked: ${why}`)
    })
  }
})

describe('isPrivateOrSpecialIp — IPv4 outside-range boundaries (#4185)', () => {
  for (const [ip, expected, why] of IPV4_PUBLIC) {
    it(`allows ${ip} (${why})`, () => {
      assert.equal(isPrivateOrSpecialIp(ip), expected, `${ip} should be allowed: ${why}`)
    })
  }
})

describe('isPrivateOrSpecialIp — IPv6 block-list', () => {
  for (const [ip, expected, why] of IPV6_BLOCKED) {
    it(`blocks ${ip} (${why})`, () => {
      assert.equal(isPrivateOrSpecialIp(ip), expected, `${ip} should be blocked: ${why}`)
    })
  }
})

describe('isPrivateOrSpecialIp — IPv6 allow', () => {
  for (const [ip, expected, why] of IPV6_PUBLIC) {
    it(`allows ${ip} (${why})`, () => {
      assert.equal(isPrivateOrSpecialIp(ip), expected, `${ip} should be allowed: ${why}`)
    })
  }
})

describe('isPrivateOrSpecialIp — IPv4-mapped IPv6 (#4187, both forms)', () => {
  for (const [ip, expected, why] of IPV4_MAPPED_V6) {
    it(`${expected ? 'blocks' : 'allows'} ${ip} (${why})`, () => {
      assert.equal(isPrivateOrSpecialIp(ip), expected, `${ip}: ${why}`)
    })
  }
})

describe('isPrivateOrSpecialIp — non-IP input', () => {
  for (const [ip, expected, why] of NON_IP_INPUT) {
    it(`returns false for ${JSON.stringify(ip)} (${why})`, () => {
      assert.equal(isPrivateOrSpecialIp(ip), expected, `${ip}: ${why}`)
    })
  }
})

describe('mappedV6ToV4 — IPv4 extraction from IPv6', () => {
  it('extracts dotted-tail form', () => {
    assert.equal(mappedV6ToV4('::ffff:1.2.3.4'), '1.2.3.4')
  })

  it('extracts hex-tail form (#4187)', () => {
    assert.equal(mappedV6ToV4('::ffff:0102:0304'), '1.2.3.4')
  })

  it('extracts hex-tail for 127.0.0.1', () => {
    assert.equal(mappedV6ToV4('::ffff:7f00:1'), '127.0.0.1')
  })

  it('returns null for pure IPv6 (not mapped)', () => {
    assert.equal(mappedV6ToV4('2606:4700:4700::1111'), null)
  })

  it('returns null for ULA fc00:: (not mapped)', () => {
    assert.equal(mappedV6ToV4('fc00::1'), null)
  })

  it('returns null for malformed input', () => {
    assert.equal(mappedV6ToV4('not-an-address'), null)
  })

  it('returns null when high bits are not the IPv4-mapped prefix', () => {
    // Same low 32 bits as ::ffff:7f00:1 but with ffff in a different
    // group — must not be treated as IPv4-mapped.
    assert.equal(mappedV6ToV4('::feff:7f00:1'), null)
  })
})
