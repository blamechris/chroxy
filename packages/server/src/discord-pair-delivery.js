/**
 * Discord pairing-link delivery (#5513, epic #5509).
 *
 * A ONE-OFF webhook POST of an approval-gated chroxy:// pairing link to the
 * configured private channel. Deliberately NOT the per-project status embed
 * (discord-webhook-sink.js): no message-id tracking, no PATCH/DELETE lifecycle,
 * no state machine — a single `webhook execute` POST and done. The two share
 * only credential resolution (env > 0600 credentials.json) and the id/token
 * extraction, which is the seam the issue calls for.
 *
 * Security:
 *   - The link carries an APPROVAL-GATED id (PairingManager
 *     .createApprovalGatedPairingId). Redeeming it never mints a token on its
 *     own — the host must approve. So possession of the channel grants nothing.
 *   - No token material beyond the ephemeral gated id is posted.
 *   - The webhook URL is a SECRET. It is resolved here but NEVER logged and
 *     NEVER returned in a result / reason string (a thrown fetch error may
 *     embed the URL; we discard the error text and return a fixed reason).
 *
 * Host-triggered only (CLI `chroxy pair-discord`, dashboard button) — never
 * automatic. Each trigger generates a fresh gated id upstream and calls this.
 */

import {
  cachedResolveDiscordWebhookUrl,
  isValidDiscordWebhookUrl,
  extractWebhookIdToken,
} from './discord-credentials.js'

const FETCH_TIMEOUT_MS = 10_000

/**
 * Build the minimal Discord message for a pairing link. Plain `content` (no
 * embeds, no state-machine fields). The only ephemeral material is the gated
 * id already embedded in `url`.
 *
 * @param {{ url: string, expiresInSeconds?: number }} args
 * @returns {{ content: string }}
 */
export function buildPairLinkMessage({ url, expiresInSeconds } = {}) {
  const ttl = Number.isFinite(expiresInSeconds) ? Math.max(0, Math.round(expiresInSeconds)) : 60
  // Minimal, masked-friendly: the link + the two facts a recipient needs.
  // Approval is required on the host, so a leaked channel grants nothing.
  const content = [
    'Chroxy pairing link:',
    url,
    `Expires in ${ttl}s · approval required on the host.`,
  ].join('\n')
  return { content }
}

/**
 * POST a pairing link to the configured Discord webhook. Resolves a plain
 * result object; never throws, never logs or returns the webhook URL/token.
 *
 * @param {{ url: string, expiresInSeconds?: number }} link
 * @param {object} [deps]
 * @param {Function} [deps.resolveWebhookUrl] - injection seam; defaults to the
 *   cached env > 0600-credentials resolver.
 * @param {Function} [deps.fetchFn] - injection seam; defaults to global fetch.
 * @returns {Promise<{ posted: true, expiresInSeconds: number }
 *                  | { posted: false, reason: 'not_configured'|'invalid'|'post_failed' }>}
 */
export async function postPairLinkToDiscord(link, deps = {}) {
  const resolveWebhookUrl = deps.resolveWebhookUrl || cachedResolveDiscordWebhookUrl
  const fetchFn = deps.fetchFn || globalThis.fetch

  const url = link?.url
  if (typeof url !== 'string' || url.length === 0) {
    return { posted: false, reason: 'invalid' }
  }

  let resolved
  try {
    resolved = resolveWebhookUrl()
  } catch {
    return { posted: false, reason: 'not_configured' }
  }
  const webhookUrl = resolved?.url
  if (typeof webhookUrl !== 'string' || !isValidDiscordWebhookUrl(webhookUrl)) {
    return { posted: false, reason: 'not_configured' }
  }

  const parts = extractWebhookIdToken(webhookUrl)
  if (!parts) return { posted: false, reason: 'not_configured' }
  const endpoint = `https://discord.com/api/webhooks/${parts.id}/${parts.token}`

  const message = buildPairLinkMessage(link)
  const expiresInSeconds = Number.isFinite(link?.expiresInSeconds)
    ? Math.max(0, Math.round(link.expiresInSeconds))
    : 60

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    if (!res || !res.ok) {
      return { posted: false, reason: 'post_failed' }
    }
    return { posted: true, expiresInSeconds }
  } catch {
    // The thrown error text may embed the secret webhook URL — discard it and
    // return a fixed reason. NEVER surface err.message.
    return { posted: false, reason: 'post_failed' }
  } finally {
    clearTimeout(timer)
  }
}
