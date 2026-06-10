/**
 * Bind-address resolution for the chroxy server.
 *
 * Default behaviour (unchanged): with auth on and no explicit host, the
 * server binds 0.0.0.0 (all interfaces) so the mobile app and LAN clients can
 * reach it. `--no-auth` forces loopback. An explicit `config.host` (e.g.
 * `--host 127.0.0.1` or `CHROXY_HOST=127.0.0.1`) binds that interface with
 * auth STILL enabled — opt-in loopback-only for single-device setups that
 * want defence-in-depth on top of the bearer token.
 */

import { isIPv4, isIPv6 } from 'node:net'

const LOOPBACK_HOSTS = new Set(['localhost', '::1'])

/**
 * True for any loopback bind address (127.0.0.0/8, ::1, localhost).
 * Hostname comparison is case-insensitive; the 127.* check applies only to
 * valid IPv4 literals so a hostname like `127.example.com` is not mistaken
 * for loopback.
 * @param {*} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const h = host.toLowerCase()
  if (LOOPBACK_HOSTS.has(h)) return true
  // 127.0.0.0/8, but only for real IPv4 literals.
  if (isIPv4(h) && h.startsWith('127.')) return true
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1.
  if (h.startsWith('::ffff:127.') || h.startsWith('::ffff:7f')) return true
  return false
}

/**
 * Format a host for use in a URL authority — bracketing IPv6 literals so
 * `ws://[::1]:8765` is well-formed (a bare `ws://::1:8765` is not).
 * @param {string} host
 * @returns {string}
 */
export function formatHostForUrl(host) {
  return isIPv6(host) ? `[${host}]` : host
}

/**
 * Resolve the address to pass to `httpServer.listen()`.
 *
 * @param {object} opts
 * @param {boolean} opts.noAuth - `--no-auth` forces loopback.
 * @param {string} [opts.host] - explicit `config.host` override.
 * @returns {string|undefined} bind address, or `undefined` for the default
 *   0.0.0.0 bind (so behaviour is unchanged when no host is configured).
 */
export function resolveBindHost({ noAuth, host } = {}) {
  if (noAuth) return '127.0.0.1'
  if (typeof host === 'string' && host.length > 0) return host
  return undefined
}

/**
 * #5356 (visibility layer): emit a single startup warning when the server is
 * about to bind a non-loopback interface — the default `undefined` →
 * 0.0.0.0 bind included. LAN peers can then reach the unauthenticated
 * surface (`/health` fingerprint, dashboard assets, rate-limited auth and
 * pairing attempts). This does NOT change any default — it only makes the
 * existing posture visible and points at the existing restriction knob.
 *
 * @param {object} opts
 * @param {string} [opts.bindHost] - resolved bind host (`undefined` = 0.0.0.0).
 * @param {{ warn: (msg: string) => void }} opts.log - logger to warn through.
 * @returns {boolean} true when the warning was emitted.
 */
export function maybeWarnNonLoopbackBind({ bindHost, log }) {
  if (isLoopbackHost(bindHost)) return false
  const shown = bindHost || '0.0.0.0 (all interfaces)'
  log.warn(
    `Listening on ${shown} — devices on your local network can reach this server's ` +
    'auth and pairing endpoints (bearer-token gated, but the server is fingerprintable via /health). ' +
    'To restrict to this machine only, start with --host 127.0.0.1, set CHROXY_HOST=127.0.0.1, or set "host": "127.0.0.1" in ~/.chroxy/config.json'
  )
  return true
}
