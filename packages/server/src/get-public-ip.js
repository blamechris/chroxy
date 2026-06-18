// get-public-ip.js — best-effort public egress IP lookup (#5828).
//
// Used ONLY when the operator opts into the billing canary's datacenter-egress
// check (`config.billing.egressCheck`). Off by default — this is the one place
// the daemon reaches out to a third-party service, so it's consent-gated.
//
// Fail-open by design: any error (timeout, network down, non-200, unparseable
// body) resolves to `null`, never throws. A missed lookup just means no egress
// warning — strictly better than crashing a periodic canary tick.

import { isIpv4, isIpv6 } from './ip-utils.js'

// ipify's api64 endpoint returns a bare IP string — the host's IPv6 when it
// egresses over IPv6, otherwise its IPv4. The dual-stack endpoint matters for
// #5831: an IPv6-only cloud host (Hetzner increasingly assigns these) cannot
// reach the IPv4-only `api.ipify.org`, so the datacenter-egress check would
// never fire on exactly the host it exists to catch. Kept as a default so the
// resolver works out of the box; injectable for tests / for an operator who'd
// rather point at their own echo service.
const DEFAULT_IP_ECHO_URL = 'https://api64.ipify.org'
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Resolve the daemon's public egress IP, best-effort.
 *
 * @param {object} [opts]
 * @param {string} [opts.url] - IP-echo endpoint returning a bare IP string.
 * @param {number} [opts.timeoutMs] - abort the request after this long.
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests (defaults to global fetch).
 * @returns {Promise<string|null>} the trimmed IPv4 or IPv6 string, or null on any failure.
 */
export async function resolvePublicIp({ url = DEFAULT_IP_ECHO_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res || !res.ok) return null
    const text = (await res.text()).trim()
    // Keep this strictly an IP-literal parser: a real IP literal is short (IPv6
    // tops out at 45 chars), so cap the body BEFORE the validators — a large
    // captive-portal / error page (which may contain `:`) must not be fed through
    // isIpv6's splitting work. Over the cap → not an IP.
    if (text.length > 45) return null
    // Only accept a plausible IPv4 or IPv6 — the classifier handles both — so a
    // junk/HTML body (captive portal, error page) is never treated as an IP.
    return (isIpv4(text) || isIpv6(text)) ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
