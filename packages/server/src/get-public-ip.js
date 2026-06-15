// get-public-ip.js — best-effort public egress IP lookup (#5828).
//
// Used ONLY when the operator opts into the billing canary's datacenter-egress
// check (`config.billing.egressCheck`). Off by default — this is the one place
// the daemon reaches out to a third-party service, so it's consent-gated.
//
// Fail-open by design: any error (timeout, network down, non-200, unparseable
// body) resolves to `null`, never throws. A missed lookup just means no egress
// warning — strictly better than crashing a periodic canary tick.

// ipify returns a bare IPv4/IPv6 string for the text endpoint. Kept as a
// default so the resolver works out of the box; injectable for tests / for an
// operator who'd rather point at their own echo service.
const DEFAULT_IP_ECHO_URL = 'https://api.ipify.org'
const DEFAULT_TIMEOUT_MS = 5000

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

/**
 * Resolve the daemon's public egress IP, best-effort.
 *
 * @param {object} [opts]
 * @param {string} [opts.url] - IP-echo endpoint returning a bare IP string.
 * @param {number} [opts.timeoutMs] - abort the request after this long.
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests (defaults to global fetch).
 * @returns {Promise<string|null>} the trimmed IPv4 string, or null on any failure.
 */
export async function resolvePublicIp({ url = DEFAULT_IP_ECHO_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res || !res.ok) return null
    const text = (await res.text()).trim()
    // Only accept a plausible IPv4 — the classifier is IPv4-prefix based, and a
    // junk/HTML body (captive portal, error page) must not be treated as an IP.
    return IPV4_RE.test(text) ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
