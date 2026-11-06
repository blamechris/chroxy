import { getAuthToken } from './auth'

/**
 * True only when the serving daemon said, in the `<meta name="chroxy-config">`
 * it injects into the dashboard page, that it does not require auth (`--no-auth`).
 * Strictly `=== false`: a missing, malformed or non-boolean flag means auth is
 * required, so the default stays the normal disconnected state (#9033).
 */
function serverRequiresNoAuth(): boolean {
  if (typeof document === 'undefined') return false
  const content = document.querySelector('meta[name="chroxy-config"]')?.getAttribute('content')
  if (!content) return false
  try {
    return (JSON.parse(content) as { authRequired?: unknown }).authRequired === false
  } catch {
    return false
  }
}

/**
 * The credential for the same-origin "this machine" connection: the page token
 * when there is one, an empty token when the daemon runs without auth, else null
 * (no local connection is possible).
 */
export function getLocalConnectionToken(): string | null {
  const token = getAuthToken()
  if (token) return token
  return serverRequiresNoAuth() ? '' : null
}

/**
 * `Authorization` header for a token from `getLocalConnectionToken()`: none for
 * the empty `--no-auth` token (never send a bare `Bearer `), so only a real
 * token produces a header (#9046).
 */
export function bearerHeaders(token: string | null): { Authorization: string } | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined
}
