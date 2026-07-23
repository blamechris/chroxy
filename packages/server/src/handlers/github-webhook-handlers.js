/**
 * GitHub webhook-secret config handlers (#6540, item 3 of #6536).
 *
 * The Control Room repo-events feed's ingest (github-webhook.js) is inert until
 * an operator sets a webhook secret and points a GitHub webhook at
 * `POST /api/github/webhook`. These handlers let that be configured from the
 * dashboard instead of an env var / CLI:
 *
 *   - github_webhook_config_request — read the current config (is a secret set +
 *     source, the payload URL to paste into GitHub, recent delivery status). Open
 *     to any authenticated client (the reply is value-free), like
 *     get_credentials_status.
 *   - github_webhook_set_secret     — set / rotate the secret (host-authority
 *     gated).
 *   - github_webhook_clear_secret   — clear the stored secret (host-authority
 *     gated).
 *
 * SECURITY: the secret is HMAC key material. It is stored ENCRYPTED AT REST in
 * the OS-keychain-backed credentials store (never plaintext config.json), and is
 * NEVER echoed back — the reply carries only whether a secret is configured. The
 * WRITE handlers are host-authority gated exactly like the provider-credential
 * writes (`rejectCredentialWriteIfBound`, #5155): a pairing-bound
 * (share-a-session) token can read the value-free config but cannot set/rotate or
 * clear the host webhook secret. See docs/security/bearer-token-authority.md §4.
 */
import { sendError } from '../handler-utils.js'
import { setStoredField, deleteStoredField } from '../credential-store.js'
import {
  WEBHOOK_SECRET_FIELD,
  RECOMMENDED_WEBHOOK_EVENTS,
  webhookSecretSource,
} from '../github-webhook.js'
import { loggerForSession } from '../logger.js'

const EMPTY_DELIVERIES = Object.freeze({
  total: 0,
  verified: 0,
  rejected: 0,
  lastAt: null,
  lastResult: null,
  lastKind: null,
})

/** Minimum accepted secret length (after trim) — a weak/typo'd secret weakens the HMAC. */
const MIN_SECRET_LENGTH = 8

/**
 * #6540: gate webhook-secret WRITES behind host-level authority, mirroring the
 * provider-credential `rejectCredentialWriteIfBound` (#5155). The webhook secret
 * is host-wide HMAC key material — a pairing-bound (share-a-session) token can
 * read the value-free config but must not be able to swap in a secret it controls
 * or clear it (integrity / DoS). Only an unbound client (the primary token or an
 * unbound linking-mode pairing token, both with `boundSessionId` unset) may write.
 *
 * Returns true and sends the rejection if the client is bound (caller early-returns);
 * false to proceed. See docs/security/bearer-token-authority.md.
 */
function rejectWebhookSecretWriteIfBound(ws, client, msg, ctx) {
  if (!client?.boundSessionId) return false
  loggerForSession('ws', client.boundSessionId).warn(
    `Client ${client.id} (bound to ${client.boundSessionId}) attempted to modify the GitHub webhook secret — rejected`,
  )
  sendError(ws, msg?.requestId, 'WEBHOOK_SECRET_WRITE_FORBIDDEN_BOUND_CLIENT',
    'Pairing-issued session tokens cannot modify the GitHub webhook secret. Use the primary API token from a device with physical access to this machine.', undefined, ctx)
  return true
}

/**
 * Build the value-free `github_webhook_config` reply. Assembles the secret
 * source (store / env / none — via `webhookSecretSource`, which reads the store
 * but never the value), the derived payload URL (`ctx.services.webhookPayloadUrl`),
 * and the recent-delivery readout (`ctx.services.repoWebhookDeliveries`). The
 * secret value is never part of this object.
 */
function buildWebhookConfig(ctx, requestId) {
  const source = webhookSecretSource()
  const payload = ctx?.services?.webhookPayloadUrl || { url: null, lanOnly: false, note: null }
  const ring = ctx?.services?.repoWebhookDeliveries
  const deliveries = ring && typeof ring.summary === 'function' ? ring.summary() : { ...EMPTY_DELIVERIES }
  return {
    type: 'github_webhook_config',
    requestId: requestId ?? null,
    generatedAt: new Date().toISOString(),
    configured: source !== 'none',
    source,
    payloadUrl: typeof payload.url === 'string' ? payload.url : null,
    lanOnly: Boolean(payload.lanOnly),
    note: payload.note ?? null,
    recommendedEvents: [...RECOMMENDED_WEBHOOK_EVENTS],
    deliveries,
  }
}

function sendWebhookConfig(ws, ctx, requestId) {
  ctx.transport.send(ws, buildWebhookConfig(ctx, requestId))
}

function handleGithubWebhookConfigRequest(ws, client, msg, ctx) {
  sendWebhookConfig(ws, ctx, msg?.requestId)
}

function handleGithubWebhookSetSecret(ws, client, msg, ctx) {
  if (rejectWebhookSecretWriteIfBound(ws, client, msg, ctx)) return
  const secret = typeof msg?.secret === 'string' ? msg.secret.trim() : ''
  if (secret.length === 0) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'secret is required', undefined, ctx)
    return
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', `secret must be at least ${MIN_SECRET_LENGTH} characters`, undefined, ctx)
    return
  }
  try {
    // Encrypt-at-rest aware, atomic 0600 write into the credentials store — never
    // plaintext config.json. err.message is validation/file-mode text, never the value.
    setStoredField(WEBHOOK_SECRET_FIELD, secret)
  } catch (err) {
    sendError(ws, msg?.requestId, 'WEBHOOK_SECRET_WRITE_FAILED', err?.message || 'write failed', undefined, ctx)
    return
  }
  // Update the in-process hot cache so live webhook deliveries pick up the new
  // secret without a keychain re-read (and so a rotate never serves the stale
  // lazily-cached value). Guarded — a minimal test ctx may omit it.
  if (typeof ctx?.services?.setWebhookSecretCache === 'function') {
    ctx.services.setWebhookSecretCache(secret)
  }
  sendWebhookConfig(ws, ctx, msg?.requestId)
}

function handleGithubWebhookClearSecret(ws, client, msg, ctx) {
  if (rejectWebhookSecretWriteIfBound(ws, client, msg, ctx)) return
  try {
    deleteStoredField(WEBHOOK_SECRET_FIELD)
  } catch (err) {
    sendError(ws, msg?.requestId, 'WEBHOOK_SECRET_CLEAR_FAILED', err?.message || 'clear failed', undefined, ctx)
    return
  }
  // Drop the hot cache so the next delivery re-resolves (store now empty → env or none).
  if (typeof ctx?.services?.setWebhookSecretCache === 'function') {
    ctx.services.setWebhookSecretCache(null)
  }
  sendWebhookConfig(ws, ctx, msg?.requestId)
}

export const githubWebhookHandlers = {
  github_webhook_config_request: handleGithubWebhookConfigRequest,
  github_webhook_set_secret: handleGithubWebhookSetSecret,
  github_webhook_clear_secret: handleGithubWebhookClearSecret,
}
