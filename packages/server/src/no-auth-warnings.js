import { createLogger } from './logger.js'

const log = createLogger('security')

/**
 * Check and emit security warnings for --no-auth usage.
 *
 * @param {object} options
 * @param {boolean} options.authRequired - Whether authentication is enabled
 * @param {string} [options.tunnel] - Tunnel mode ('quick', 'named', 'none', or undefined)
 */
export function checkNoAuthWarnings({ authRequired, tunnel }) {
  if (authRequired) return

  log.warn('[SECURITY] --no-auth disables all authentication. Only safe on isolated networks!')

  if (tunnel && tunnel !== 'none') {
    log.error('[SECURITY] --no-auth with tunnel exposes your server to the internet without authentication!')
  }
}
