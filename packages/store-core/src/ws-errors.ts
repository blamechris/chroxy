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
 * Map a WebSocket close code to a user-readable error message.
 *
 * Only codes the server actually sends are given specific messages:
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
 *   HTTP 4xx       — bad token / not authorised
 *   HTTP 5xx       — server-side error / restart in flight
 *   Other HTTP     — unexpected status (3xx etc.) — show the raw status
 *   Network error  — no network / tunnel down (no message / non-HTTP)
 */
export function getHealthCheckErrorMessage(err: { name?: string; message?: string }): string {
  if (err.name === 'AbortError') return 'Server not responding — check your network'
  if (err.message?.startsWith('HTTP 4')) return 'Server rejected the connection — check your token'
  if (err.message?.startsWith('HTTP 5')) return 'Server error — the server may be restarting'
  if (err.message?.startsWith('HTTP ')) return `Server unreachable (${err.message})`
  return 'Could not reach server — check your network'
}
