/**
 * Mask a token for terminal display, showing only prefix and suffix.
 * @param {string | null | undefined} token
 * @returns {string}
 */
export function maskToken(token) {
  if (!token) return ''
  if (token.length <= 8) return token
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}
