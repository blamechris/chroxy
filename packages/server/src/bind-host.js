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

const LOOPBACK_HOSTS = new Set(['localhost', '::1'])

/**
 * True for any loopback bind address (127.0.0.0/8, ::1, localhost).
 * @param {*} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  if (LOOPBACK_HOSTS.has(host)) return true
  if (host.startsWith('127.')) return true
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1.
  if (host.startsWith('::ffff:127.') || host.startsWith('::ffff:7f')) return true
  return false
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
