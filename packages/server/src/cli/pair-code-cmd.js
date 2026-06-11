/**
 * chroxy pair-code — print the host's current typeable pairing code.
 *
 * For camera-less devices (the TV-app pattern, #5512, epic #5509): the host shows
 * a short, human-typable code; the new device types it on the dashboard's "Have a
 * code?" form. Because the code is read off the host's OWN screen (physical
 * presence), pairing needs no extra approval — same trust as a scanned QR. Codes
 * delivered via any other channel must use the #5510 approval primitive instead.
 *
 * Prints once with the remaining TTL and exits (scriptable). It does NOT loop —
 * the code rotates every ~60s, so re-run to get a fresh one.
 */

function portFromUrl(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/:(\d+)(?:\/|$)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Fetch the current pairing code from the local daemon. Exposed for testing.
 * @param {object} [deps]
 * @param {function} [deps.readConnectionInfo]
 * @param {function} [deps.fetchFn]
 * @param {number}   [deps.defaultPort]
 * @returns {Promise<{ ok: true, code: string, url: string|null, expiresInSeconds: number, wsUrl: string|null }
 *                  | { ok: false, reason: 'not_running'|'no_token'|'unavailable', message?: string }>}
 */
export async function fetchPairingCode(deps = {}) {
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
    const res = await fetchFn(`http://127.0.0.1:${port}/pairing-code`, {
      signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${info.apiToken}`, Accept: 'application/json' },
    })
    if (!res || !res.ok) {
      let message = res ? `HTTP ${res.status}` : 'no response'
      try {
        const body = await res.json()
        if (body?.error) message = body.error
      } catch { /* keep default */ }
      return { ok: false, reason: 'unavailable', message }
    }
    const body = await res.json()
    return {
      ok: true,
      code: body.code,
      url: body.url ?? null,
      expiresInSeconds: body.expiresInSeconds,
      wsUrl: info.wsUrl || info.httpUrl || null,
    }
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err?.message || 'request failed' }
  }
}

/** Render a single human line: `<code>  (expires in NNs)  host: <ws url>`. */
export function formatPairingCode(result) {
  const ttl = Number.isFinite(result.expiresInSeconds) ? result.expiresInSeconds : '?'
  const host = result.wsUrl || '(unknown)'
  return `${result.code}  (expires in ${ttl}s)  host: ${host}`
}

export async function runPairCodeCmd(options = {}, deps = {}) {
  const result = await fetchPairingCode(deps)
  const write = deps.write || console.log
  const writeErr = deps.writeErr || console.error
  if (options.json) {
    write(JSON.stringify(result, null, 2))
    return result
  }
  if (!result.ok) {
    if (result.reason === 'not_running') {
      writeErr('Chroxy server is not running. Start it with `chroxy start`.')
    } else if (result.reason === 'no_token') {
      writeErr('Server is running without an auth token — pairing codes are unavailable.')
    } else {
      writeErr(`Could not fetch pairing code: ${result.message || result.reason}`)
    }
    return result
  }
  write(formatPairingCode(result))
  return result
}

export function registerPairCodeCommand(program) {
  program
    .command('pair-code')
    .description('Print the current typeable pairing code for a camera-less device to enter')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      const result = await runPairCodeCmd(options)
      if (!result.ok) process.exitCode = 1
    })
}
