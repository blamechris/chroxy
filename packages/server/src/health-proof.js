import { createHmac } from 'node:crypto'

/**
 * `GET /health?challenge=<nonce>` answers with a proof that the daemon holds the
 * API token. A client that knows the token (the desktop app reads it from its
 * config) sends a fresh random nonce and checks the proof; a process that does
 * not hold the token cannot produce one.
 *
 * proof = hex(HMAC-SHA256(key = apiToken, "chroxy-health-v1:" + port + ":" + nonce))
 *
 * The port is part of the message, so a proof for one port is no proof for
 * another. The desktop app has the same function (`health_proof.rs`).
 */
export const HEALTH_PROOF_PREFIX = 'chroxy-health-v1:'

const NONCE_RE = /^[0-9a-f]{64}$/

/** True for exactly 64 lowercase hex characters. */
export function isValidChallenge(nonce) {
  return typeof nonce === 'string' && NONCE_RE.test(nonce)
}

/** The proof for `nonce` on `port`, keyed by `apiToken`. */
export function computeHealthProof(apiToken, port, nonce) {
  return createHmac('sha256', apiToken)
    .update(`${HEALTH_PROOF_PREFIX}${port}:${nonce}`)
    .digest('hex')
}

/**
 * The valid challenge in a request URL's query, or `null`. Exactly one
 * `challenge` parameter is accepted; a repeated, empty or malformed one is
 * treated as absent.
 */
export function challengeFromUrl(url) {
  const q = typeof url === 'string' ? url.indexOf('?') : -1
  if (q < 0) return null
  const values = new URLSearchParams(url.slice(q + 1)).getAll('challenge')
  return values.length === 1 && isValidChallenge(values[0]) ? values[0] : null
}
