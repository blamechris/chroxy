/** Read auth token from URL query param (preferred) or cookie (fallback) */
export function getAuthToken(): string | null {
  const params = new URLSearchParams(window.location.search)
  const queryToken = params.get('token')
  if (queryToken) return queryToken
  const match = document.cookie.match(/(?:^|;\s*)chroxy_auth=([^;]*)/)
  if (!match || !match[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
