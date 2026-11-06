/**
 * Shared WebSocket close-code and HTTP health-check error message
 * helpers (#4771).
 *
 * Both the mobile app and the web dashboard need to surface the same
 * user-readable copy when:
 *
 *   - the server closes the WebSocket with a known code, or
 *   - the pre-WS HTTP `/health` probe fails.
 *
 * Keeping the mapping in one place avoids the dashboard / app
 * divergence noted in #4771 — previously the dashboard's inline
 * ternary for health-check errors omitted the AbortError / HTTP 4xx /
 * HTTP 5xx splits the app had, and the dashboard's `socket.onclose`
 * surfaced every drop as a generic "Connection lost" because it never
 * read `event.code` at all (so a 4008 backpressure eviction looked
 * identical to a plain network blip).
 *
 * Pure functions with no DOM / React Native dependencies — safe to
 * import from either consumer.
 */

/**
 * Application close code the server sends when the credential a connection
 * authenticated with stops being valid (the pairing token was revoked, expired
 * or evicted). Retrying with the same credential can only fail, so a client
 * must not reconnect with it: it forgets that credential and asks to pair again.
 */
export const WS_CLOSE_CREDENTIAL_INVALID = 4401

/** True when a close code means "the credential used for this connection is dead". */
export function isCredentialInvalidClose(code: unknown): boolean {
  return code === WS_CLOSE_CREDENTIAL_INVALID
}

/**
 * Map a WebSocket close code to a user-readable error message.
 *
 * Only codes the server actually sends are given specific messages:
 *   4401 — ws-server.js: the credential this connection authenticated with is no longer valid
 *   1008 — ws-auth.js: key exchange failure (encryption setup failed)
 *   4008 — ws-broadcaster.js / ws-client-sender.js: backpressure eviction
 *   1006 — abnormal closure / network drop (never sent explicitly; set by browser/RN)
 *   1000 — normal close initiated by the server (no error to show)
 *
 * All other codes fall through to a generic message. We intentionally
 * do NOT add arms for codes the server doesn't send (4001/4003/4004
 * etc.) — surfacing a specific cause we never produced would mislead
 * the user during triage.
 */
export function getWsCloseMessage(code: number): string | null {
  switch (code) {
    case WS_CLOSE_CREDENTIAL_INVALID:
      // The stored pairing token was revoked / expired / evicted server-side
      return 'This device is no longer paired with the server — pair it again'
    case 1000:
      // Normal close — no error to surface
      return null
    case 1006:
      // Abnormal closure — network drop, tunnel outage, etc.
      return 'Connection lost — check your network'
    case 1008:
      // Policy violation — server couldn't complete key exchange (E2E encryption)
      return 'Encryption failed — check that your app is up to date'
    case 4008:
      // Server-side backpressure eviction — client was too slow to consume messages
      return 'Connection dropped — the server was overwhelmed, reconnecting'
    default:
      return 'Connection failed — check your network and server status'
  }
}

/**
 * Map an HTTP health check failure to a user-readable error message.
 *
 *   AbortError     — fetch timed out (server not responding)
 *   HTTP 4xx       — refused: a wrong address or token, or a proxy / access gate
 *                    in front of the daemon (/health itself is unauthenticated)
 *   HTTP 5xx       — server-side error / restart in flight
 *   Other HTTP     — unexpected status (3xx etc.) — show the raw status
 *   Network error  — no network / tunnel down (no message / non-HTTP)
 */
export function getHealthCheckErrorMessage(err: { name?: string; message?: string }): string {
  if (err.name === 'AbortError') return 'Server not responding — check your network'
  // /health needs no token, so a 4xx here is as likely a proxy or an access gate in
  // front of the daemon as a bad token (#8385); the copy names both.
  if (err.message?.startsWith('HTTP 4')) return `The server at this address refused the connection (${err.message}) — check the address and token`
  if (err.message?.startsWith('HTTP 5')) return 'Server error — the server may be restarting'
  if (err.message?.startsWith('HTTP ')) return `Server unreachable (${err.message})`
  return 'Could not reach server — check your network'
}
