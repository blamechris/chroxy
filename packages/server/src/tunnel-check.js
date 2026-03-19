import { createLogger } from './logger.js'

const log = createLogger('tunnel')

/**
 * Verify a Cloudflare tunnel is fully routable before exposing it to users.
 * New tunnel URLs need a few seconds for DNS propagation.
 */
export async function waitForTunnel(httpUrl, { maxAttempts = 10, interval = 2000 } = {}) {
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
      log.info(`Attempt ${attempt}/${maxAttempts} failed: ${reason}`)
    } finally {
      clearTimeout(timeout)
    }

    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, interval))
    }
  }

  // Don't fail — the tunnel might still work, just warn
  log.warn(`Could not verify tunnel after ${maxAttempts} attempts, proceeding anyway`)
}
