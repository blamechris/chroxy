/**
 * Verify a Cloudflare tunnel is fully routable before exposing it to users.
 * New tunnel URLs need a few seconds for DNS propagation.
 */
export async function waitForTunnel(httpUrl, { maxAttempts = 10, interval = 2000 } = {}) {
  console.log('[tunnel] Verifying tunnel is routable...')

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(httpUrl, { signal: controller.signal })
      clearTimeout(timeout)

      if (res.ok) {
        console.log(`[tunnel] Tunnel verified (took ${i * interval / 1000}s)`)
        return
      }
    } catch {
      // Not ready yet
    }

    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, interval))
    }
  }

  // Don't fail — the tunnel might still work, just warn
  console.log('[tunnel] Warning: could not verify tunnel, proceeding anyway')
}
