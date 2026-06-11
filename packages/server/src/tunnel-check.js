import { createLogger } from './logger.js'

const log = createLogger('tunnel')

export const QUICK_TUNNEL_DNS_SETTLE_MS = 20_000

/**
 * #5489 — cloudflared returns these statuses when the edge reached the tunnel
 * but the origin (localhost server) is unreachable. The supervisor verifies the
 * tunnel BEFORE forking the server child (#5314 no-orphan ordering), so the
 * origin is intentionally down at verification time. Since this check only
 * confirms routability (the edge resolved and proxied — i.e. DNS has settled),
 * a 502/530 is proof of success, not a failure.
 *   502 Bad Gateway        — origin connection refused / reset
 *   530 (Cloudflare)       — origin unreachable / DNS error at the edge
 */
const ROUTABLE_ORIGIN_DOWN_STATUSES = new Set([502, 530])

/**
 * Verify a Cloudflare tunnel is fully routable before exposing it to users.
 * New tunnel URLs need time for DNS propagation — Quick Tunnels can take
 * 30+ seconds. Uses an optional initial delay, then linear backoff:
 * 1s, 2s, 3s, 4s, 5s (cap), ...
 */
export async function waitForTunnel(httpUrl, { maxAttempts = 20, initialInterval = 1000, initialDelay = 0, onAttempt } = {}) {
  log.info('Verifying tunnel is routable...')
  const startTime = Date.now()

  if (initialDelay > 0) {
    log.info(`Waiting ${(initialDelay / 1000).toFixed(0)}s before first tunnel verification attempt...`)
    await new Promise((r) => setTimeout(r, initialDelay))
  }

  let lastFailure = null

  for (let i = 0; i < maxAttempts; i++) {
    const attempt = i + 1
    if (typeof onAttempt === 'function') onAttempt(attempt, maxAttempts)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(httpUrl, { signal: controller.signal })
      // A successful response OR an "edge reached, origin down" response (#5489)
      // both prove the tunnel is routable — that's all this check verifies.
      if (res.ok || ROUTABLE_ORIGIN_DOWN_STATUSES.has(res.status)) {
        const detail = res.ok ? '' : ` (HTTP ${res.status} — edge routable, origin not yet up)`
        log.info(`Tunnel verified on attempt ${attempt}/${maxAttempts} (took ${((Date.now() - startTime) / 1000).toFixed(1)}s)${detail}`)
        return
      }
      log.info(`Attempt ${attempt}/${maxAttempts} failed: HTTP ${res.status}`)
      lastFailure = `HTTP ${res.status}`
    } catch (err) {
      const reason = err.name === 'AbortError'
        ? 'timeout'
        : [err.cause?.code, err.message].filter(Boolean).join(': ')
      lastFailure = reason
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

  // UX landmine #4: throw instead of silently proceeding. A broken
  // tunnel produces a QR that hangs the app — better to surface the
  // error clearly than show a non-functional QR code.
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
  const err = new Error(
    `Tunnel failed to become routable after ${maxAttempts} attempts (${elapsed}s). ` +
    `${lastFailure ? `Last failure: ${lastFailure}. ` : ''}` +
    'This usually means your network is blocking Cloudflare, or DNS has not propagated yet. ' +
    'Try a named tunnel (--tunnel named) or run `npx chroxy doctor` for diagnostics.'
  )
  err.code = 'TUNNEL_NOT_ROUTABLE'
  throw err
}
