/**
 * chroxy pair-discord — post an approval-gated pairing link to Discord (#5513,
 * epic #5509).
 *
 * Host-triggered convenience delivery for a camera-less device: the daemon
 * generates a FRESH approval-gated pairing id and posts its `chroxy://…?pair=`
 * link to the configured private Discord webhook channel. Tapping the link on
 * the new device starts a pair REQUEST — the host must still approve it (#5510),
 * so possession of the channel grants nothing on its own.
 *
 * Hits POST /pair-discord on the local daemon, which is gated on the PRIMARY
 * token class (#5533). Exits non-zero on any failure (not running, no token,
 * webhook not configured, post failed) with a legible reason.
 */

function portFromUrl(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/:(\d+)(?:\/|$)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Trigger a Discord pairing-link post on the local daemon. Exposed for testing.
 * @param {object} [deps]
 * @param {function} [deps.readConnectionInfo]
 * @param {function} [deps.fetchFn]
 * @param {number}   [deps.defaultPort]
 * @returns {Promise<{ ok: true, expiresInSeconds: number }
 *                  | { ok: false, reason: 'not_running'|'no_token'|'not_configured'|'post_failed'|'unavailable', message?: string }>}
 */
export async function postPairDiscord(deps = {}) {
  const readConnectionInfo =
    deps.readConnectionInfo ||
    (await import('../connection-info.js')).readConnectionInfo
  const fetchFn = deps.fetchFn || globalThis.fetch
  const defaultPort = deps.defaultPort || 8765

  const info = readConnectionInfo()
  if (!info) return { ok: false, reason: 'not_running' }
  if (!info.apiToken) return { ok: false, reason: 'no_token' }

  const port = portFromUrl(info.httpUrl) || portFromUrl(info.wsUrl) || defaultPort
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/pair-discord`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${info.apiToken}`, Accept: 'application/json' },
    })
    let body = null
    try { body = await res.json() } catch { /* keep null */ }
    if (res && res.ok && body?.posted) {
      return { ok: true, expiresInSeconds: body.expiresInSeconds }
    }
    // Map the daemon's structured reason through; fall back to a status string.
    const reason = body?.reason || (res ? `http_${res.status}` : 'unavailable')
    return { ok: false, reason }
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err?.message || 'request failed' }
  }
}

/** Render a one-line success message. */
export function formatPairDiscordResult(result) {
  const ttl = Number.isFinite(result.expiresInSeconds) ? result.expiresInSeconds : 60
  return `Posted pairing link to Discord — expires in ${ttl}s. Approval required on the host before the device connects.`
}

export async function runPairDiscordCmd(_options = {}, deps = {}) {
  const result = await postPairDiscord(deps)
  const write = deps.write || console.log
  const writeErr = deps.writeErr || console.error
  if (result.ok) {
    write(formatPairDiscordResult(result))
    return result
  }
  if (result.reason === 'not_running') {
    writeErr('Chroxy server is not running. Start it with `chroxy start`.')
  } else if (result.reason === 'no_token') {
    writeErr('Server is running without an auth token — pairing is unavailable.')
  } else if (result.reason === 'not_configured') {
    writeErr('No Discord webhook is configured. Set CHROXY_DISCORD_WEBHOOK_URL or add discordWebhookUrl to ~/.chroxy/credentials.json.')
  } else if (result.reason === 'post_failed') {
    writeErr('Discord rejected the post — check the webhook is still valid.')
  } else {
    writeErr(`Could not post pairing link to Discord: ${result.message || result.reason}`)
  }
  return result
}

export function registerPairDiscordCommand(program) {
  program
    .command('pair-discord')
    .description('Post an approval-gated pairing link to the configured Discord channel')
    .action(async (options) => {
      const result = await runPairDiscordCmd(options)
      if (!result.ok) process.exitCode = 1
    })
}
