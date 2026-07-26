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
  let outcome
  try {
    // Encrypt-at-rest aware, atomic 0600 write into the credentials store — never
    // plaintext config.json. err.message is validation/file-mode text, never the value.
    //
    // #6964: `durable: true` — this is credential ROTATION of a secret SHARED with
    // GitHub. The operator gets a success ack and then re-points the GitHub webhook
    // at the new secret, so losing the write to a power loss inside the OS writeback
    // window would leave the daemon verifying deliveries with the old secret and
    // rejecting every real one. A THROW here means nothing was published (the write
    // itself failed, or its PRE-rename fsync did) — the old secret still stands, so
    // report WEBHOOK_SECRET_WRITE_FAILED and do not touch the cache.
    outcome = setStoredField(WEBHOOK_SECRET_FIELD, secret, { durable: true })
  } catch (err) {
    sendError(ws, msg?.requestId, 'WEBHOOK_SECRET_WRITE_FAILED', err?.message || 'write failed', undefined, ctx)
    return
  }
  // Update the in-process hot cache so live webhook deliveries pick up the new
  // secret without a keychain re-read (and so a rotate never serves the stale
  // lazily-cached value). Guarded — a minimal test ctx may omit it.
  //
  // This runs for `outcome.durabilityUnconfirmed` too, and must: that outcome means
  // the new secret IS live on disk and only the durability of the rename is unproven.
  // Skipping it would leave the running daemon verifying deliveries with the OLD
  // secret while the NEW one is what a restart loads — a silent, delayed outage.
  if (typeof ctx?.services?.setWebhookSecretCache === 'function') {
    ctx.services.setWebhookSecretCache(secret)
  }
  // The reply is the success config: the rotation took effect. Reporting a failure
  // for a write that landed would send the operator to re-point GitHub back at the
  // old secret that the daemon no longer accepts.
  sendWebhookConfig(ws, ctx, msg?.requestId)
  if (outcome?.durabilityUnconfirmed) {
    // ...but the operator still learns the fsync failed. Deliberately requestId-LESS:
    // the config above is this request's reply, and a client correlating an error to
    // its in-flight requestId must not read this as the rotation's verdict.
    sendError(
      ws,
      null,
      'WEBHOOK_SECRET_DURABILITY_UNCONFIRMED',
      'The new webhook secret is saved and live, but the filesystem could not confirm the write is durable ' +
      `(${outcome.durabilityUnconfirmed}) — a power loss could roll the rotation back. ` +
      'Resolve the storage error, then re-check the configured secret after the next restart.',
      undefined,
      ctx,
    )
  }
}

function handleGithubWebhookClearSecret(ws, client, msg, ctx) {
  if (rejectWebhookSecretWriteIfBound(ws, client, msg, ctx)) return
  let outcome
  try {
    // #7056: durable, for the same reason the rotation is. An operator clears a
    // shared secret precisely because they believe it leaked — a clear that is
    // acked but still sitting in the OS writeback window can restore the leaked
    // value on the next start after a power loss.
    outcome = deleteStoredField(WEBHOOK_SECRET_FIELD, { durable: true })
  } catch (err) {
    sendError(ws, msg?.requestId, 'WEBHOOK_SECRET_CLEAR_FAILED', err?.message || 'clear failed', undefined, ctx)
    return
  }
  // Drop the hot cache so the next delivery re-resolves (store now empty → env or none).
  if (typeof ctx?.services?.setWebhookSecretCache === 'function') {
    ctx.services.setWebhookSecretCache(null)
  }
  // The reply is the success config: the secret IS cleared. Reporting a failure for
  // a clear that landed would send the operator to re-clear an already-cleared value.
  sendWebhookConfig(ws, ctx, msg?.requestId)
  if (outcome?.durabilityUnconfirmed) {
    // ...but the operator still learns the fsync failed. Deliberately requestId-LESS,
    // mirroring the rotation path: the config above is this request's reply, and a
    // client correlating an error to its in-flight requestId must not read this as
    // the clear's verdict.
    sendError(
      ws,
      null,
      'WEBHOOK_SECRET_DURABILITY_UNCONFIRMED',
      'The webhook secret is cleared, but the filesystem could not confirm the removal is durable ' +
      `(${outcome.durabilityUnconfirmed}) — a power loss could restore the cleared secret. ` +
      'Resolve the storage error, then re-check the configured secret after the next restart.',
      undefined,
      ctx,
    )
  }
}

export const githubWebhookHandlers = {
  github_webhook_config_request: handleGithubWebhookConfigRequest,
  github_webhook_set_secret: handleGithubWebhookSetSecret,
  github_webhook_clear_secret: handleGithubWebhookClearSecret,
}
