import { createLogger } from './logger.js'

const log = createLogger('tunnel')

/**
 * Verify a Cloudflare tunnel is fully routable before exposing it to users.
 * New tunnel URLs need time for DNS propagation — Quick Tunnels can take
 * 30+ seconds. Uses linear backoff: 1s, 2s, 3s, 4s, 5s (cap), ...
 */
export async function waitForTunnel(httpUrl, { maxAttempts = 20, initialInterval = 1000 } = {}) {
  log.info('Verifying tunnel is routable...')
  const startTime = Date.now()

  for (let i = 0; i < maxAttempts; i++) {
    const attempt = i + 1
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(httpUrl, { signal: controller.signal })
      if (res.ok) {
        log.info(`Tunnel verified on attempt ${attempt}/${maxAttempts} (took ${((Date.now() - startTime) / 1000).toFixed(1)}s)`)
        return
      }
      log.info(`Attempt ${attempt}/${maxAttempts} failed: HTTP ${res.status}`)
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message
      // Only log every few attempts to reduce noise
      if (attempt <= 3 || attempt % 5 === 0 || attempt === maxAttempts) {
        log.info(`Attempt ${attempt}/${maxAttempts} failed: ${reason}`)
      }
    } finally {
      clearTimeout(timeout)
    }

    if (i < maxAttempts - 1) {
      // Backoff: 1s, 2s, 3s, 4s, 5s, 5s, 5s, ...
      const delay = Math.min(initialInterval * (i + 1), 5000)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  // Don't fail — the tunnel might still work, just warn
  log.warn(`Could not verify tunnel after ${maxAttempts} attempts (${((Date.now() - startTime) / 1000).toFixed(0)}s), proceeding anyway`)
}
