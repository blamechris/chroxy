/**
 * Minimal structured logger.
 * Usage: const log = createLogger('supervisor')
 *        log.info('Server ready')
 *   =>   2026-02-09T12:34:56.789Z [supervisor] Server ready
 */
export function createLogger(component) {
  const prefix = () => `${new Date().toISOString()} [${component}]`

  return {
    info(msg) {
      console.log(`${prefix()} ${msg}`)
    },
    warn(msg) {
      console.warn(`${prefix()} ${msg}`)
    },
    error(msg) {
      console.error(`${prefix()} ${msg}`)
    },
  }
}
