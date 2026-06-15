// ip-utils.js — minimal, dependency-free IP validation + IPv6 canonicalisation
// shared by the billing canary's egress path (#5831).
//
// get-public-ip.js uses isIpv4/isIpv6 to validate an echo-endpoint body before
// trusting it as an egress IP; doctor-billing.js uses expandIpv6 to prefix-match
// an address against documented datacenter ranges. Both need the SAME notion of
// "a valid IPv6 address", so expansion (which doubles as validation) lives here
// as the single source of truth rather than two slightly-different regexes.

// Each octet 0-255 — a loose \d{1,3} would accept junk like 999.999.999.999
// from a captive-portal / error body.
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4_RE = new RegExp(`^(${OCTET}\\.){3}${OCTET}$`)

/** True for a dotted-quad IPv4 string with every octet in 0-255. */
export function isIpv4(s) {
  return typeof s === 'string' && IPV4_RE.test(s)
}

/**
 * Expand an IPv6 address to its canonical lowercase, fully-grouped form
 * (8 groups of 4 hex digits, e.g. `2a01:04f8:0000:0000:0000:0000:0000:0001`),
 * or null if it is not a valid IPv6 address. Handles `::` zero-compression, a
 * trailing zone id (`%eth0`), and surrounding brackets. IPv4-mapped forms
 * (`::ffff:1.2.3.4`) are intentionally NOT supported — they return null, which
 * the classifier treats as "unknown" (a silent non-hit, never a false hit).
 *
 * Doubling as the validator keeps a single definition of "valid IPv6": prefix
 * matching compares against this canonical form so compressed and padded
 * spellings of the same address compare equal.
 */
export function expandIpv6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return null
  // Strip brackets and any zone id (`fe80::1%eth0`).
  const addr = ip.trim().replace(/^\[/, '').replace(/\]$/, '').split('%')[0]
  const halves = addr.split('::')
  if (halves.length > 2) return null // more than one `::` is invalid

  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []

  let groups
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null // `::` must stand in for at least one zero group
    groups = [...head, ...Array(missing).fill('0'), ...tail]
  } else {
    groups = head // no `::` — must be exactly 8 explicit groups
  }
  if (groups.length !== 8) return null

  const out = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    out.push(g.toLowerCase().padStart(4, '0'))
  }
  return out.join(':')
}

/** True for a valid IPv6 address (anything expandIpv6 can canonicalise). */
export function isIpv6(s) {
  return expandIpv6(s) != null
}

/**
 * Normalise an operator-supplied IPv6 PREFIX (e.g. `2a02:1370:` from
 * config.billing.datacenterPrefixes) into the same zero-padded, lowercase,
 * group-aligned form expandIpv6 produces, so a startsWith() against an expanded
 * address matches regardless of how the operator spelled the groups. A partial
 * prefix is not a full address, so this only pads each group — it does not
 * expand `::`.
 *
 * Operator prefixes must be WHOLE `:`-delimited groups: a partial trailing group
 * pads on its own boundary and won't match across the group, e.g. `2a02:13` →
 * `2a02:0013` does NOT match `2a02:1300::…`. Prefixes ending in `:` (the
 * built-in list, and the natural way to write a block) are immune.
 */
export function normalizeIpv6Prefix(prefix) {
  if (typeof prefix !== 'string') return ''
  return prefix
    .toLowerCase()
    .split(':')
    .map((g) => (g.length ? g.padStart(4, '0') : g))
    .join(':')
}
