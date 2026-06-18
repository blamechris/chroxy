/**
 * Provider credential settings handlers — split out of settings-handlers.js
 * (audit P2-4, pure move). BYOK + generic provider credential get/set/delete/
 * test + OAuth status. Writes require host-level authority (a pairing-bound
 * token is rejected); status reads are open to any authenticated client.
 */
import { sendError } from '../handler-utils.js'
import { getAnthropicApiKeyStatus } from '../byok-credentials.js'
import {
  getCredentialsStatus,
  setStoredCredential,
  deleteStoredCredential,
  isKnownCredentialKey,
} from '../credential-store.js'
import { testCredential } from '../credential-test.js'
import {
  hasClaudeOAuthCreds,
  hasGeminiOAuthCreds,
  hasCodexOAuthCreds,
} from '../auth-probes.js'
import { createLogger, loggerForSession } from '../logger.js'

const log = createLogger('ws')

/**
 * #5155: gate credential WRITES (set/delete/clear) behind the primary token.
 *
 * Reads are safe (status is masked, value-free) and stay open to every
 * authenticated client. But a WRITE lets the caller swap in or clear the
 * operator's provider keys — a pairing-bound (share-a-session) token doing so is
 * a billing-redirection / integrity / DoS risk distinct from "use the existing
 * credentials". So credential mutations now require host-level authority: a
 * pairing-issued session token (client.boundSessionId set) is rejected, exactly
 * like the auto-permission-mode escalation gate above. Only the primary API
 * token (or an unbound linking-mode pairing token, both with boundSessionId
 * unset) can write.
 *
 * Returns true and sends the rejection if the client is bound (caller must
 * early-return); false to proceed. See docs/security/bearer-token-authority.md.
 *
 * @param {object} ws
 * @param {object} client
 * @param {object} msg
 * @returns {boolean} true if the write was rejected.
 */
function rejectCredentialWriteIfBound(ws, client, msg, ctx) {
  if (!client?.boundSessionId) return false
  loggerForSession('ws', client.boundSessionId).warn(`Client ${client.id} (bound to ${client.boundSessionId}) attempted to modify provider credentials — rejected`)
  // #5632: route through ctx.transport so the error is encrypted for a
  // post-handshake host.
  sendError(ws, msg?.requestId, 'CREDENTIAL_WRITE_FORBIDDEN_BOUND_CLIENT',
    'Pairing-issued session tokens cannot modify provider credentials. Use the primary API token from a device with physical access to this machine.', undefined, ctx)
  return true
}
/**
 * BYOK credentials handlers (#4052).
 *
 * Three message types: get status, set the key, clear the key. The full
 * key is never sent back over the wire — only its masked form via
 * `getAnthropicApiKeyStatus`. Errors are surfaced via sendError;
 * success replies go back to the calling ws AND broadcast to all
 * authenticated clients so additional dashboards / tabs stay in sync.
 *
 * Auth posture: status reads are open to any authenticated WS client. WRITES
 * (set/clear) require host-level authority — a pairing-bound session token is
 * rejected via `rejectCredentialWriteIfBound` (#5155).
 *
 * #5867: set/clear now go through the canonical `setStoredCredential` /
 * `deleteStoredCredential` (merge + at-rest encryption) instead of the legacy
 * whole-file overwrite/unlink, so a BYOK write no longer wipes sibling provider
 * keys or downgrades an encrypted store to plaintext. The status surface stays
 * the BYOK-specific `getAnthropicApiKeyStatus` for dashboard back-compat.
 */
function handleByokGetCredentialsStatus(ws, client, msg, ctx) {
  const status = getAnthropicApiKeyStatus()
  ctx.transport.send(ws, { type: 'byok_credentials_status', requestId: msg?.requestId, ...status })
}

function handleByokSetCredentials(ws, client, msg, ctx) {
  if (rejectCredentialWriteIfBound(ws, client, msg, ctx)) return
  // Trim leading/trailing whitespace — pastes often carry surrounding
  // spaces/newlines that would otherwise be persisted into the credentials
  // file and silently fail when the SDK tries to use the key.
  const key = typeof msg?.anthropicApiKey === 'string' ? msg.anthropicApiKey.trim() : msg?.anthropicApiKey
  if (typeof key !== 'string' || key.length === 0) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'anthropicApiKey is required', undefined, ctx)
    return
  }
  // Reject anything that doesn't even look like a key BEFORE persisting (the
  // store validates too, but this gives the nicer BYOK-specific error). The
  // Anthropic key format starts with `sk-ant-`; the prefix check catches
  // obvious wrong-thing pastes (OpenAI keys, OAuth tokens).
  if (!key.startsWith('sk-ant-')) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'API key must start with sk-ant-', undefined, ctx)
    return
  }
  try {
    // Merge into the canonical store (encrypt-at-rest aware) — never the legacy
    // whole-file overwrite that wiped sibling provider keys (#5867).
    setStoredCredential('ANTHROPIC_API_KEY', key)
  } catch (err) {
    log.warn(`byok_set_credentials write failed: ${err?.message}`)
    sendError(ws, msg?.requestId, 'CREDENTIALS_WRITE_FAILED', err?.message || 'write failed', undefined, ctx)
    return
  }
  const status = getAnthropicApiKeyStatus()
  // Reply to the originating client with the requestId for await-resolution.
  ctx.transport.send(ws, { type: 'byok_credentials_status', requestId: msg?.requestId, ...status })
  // Broadcast without requestId so other dashboards / clients update too.
  // Without this, a second dashboard would keep showing stale state until
  // the user re-opened Settings.
  if (typeof ctx.transport.broadcast === 'function') {
    ctx.transport.broadcast({ type: 'byok_credentials_status', ...status })
  }
}

function handleByokClearCredentials(ws, client, msg, ctx) {
  if (rejectCredentialWriteIfBound(ws, client, msg, ctx)) return
  try {
    // Remove only the Anthropic key from the canonical store — siblings (and
    // the encrypted envelope) survive; the file is unlinked only when empty.
    deleteStoredCredential('ANTHROPIC_API_KEY')
  } catch (err) {
    sendError(ws, msg?.requestId, 'CREDENTIALS_CLEAR_FAILED', err?.message || 'clear failed', undefined, ctx)
    return
  }
  const status = getAnthropicApiKeyStatus()
  ctx.transport.send(ws, { type: 'byok_credentials_status', requestId: msg?.requestId, ...status })
  if (typeof ctx.transport.broadcast === 'function') {
    ctx.transport.broadcast({ type: 'byok_credentials_status', ...status })
  }
}

/**
 * Provider Credentials handlers (#3855).
 *
 * Generalizes the BYOK handlers above to every known provider credential key
 * (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY)
 * plus read-only OAuth status. The raw value is NEVER sent back — set/delete
 * reply with the same masked `credentials_status` snapshot the status query
 * returns.
 *
 * Auth posture (#5155): status reads are open to any authenticated WS client
 * (the snapshot is masked and value-free). WRITES (set/delete) require
 * host-level authority — a pairing-bound session token is rejected via
 * `rejectCredentialWriteIfBound`, mirroring the auto-permission-mode escalation
 * gate. Overwriting the operator's provider keys is a billing/integrity/DoS
 * vector distinct from "use the existing credentials a session resolves", so a
 * bound token must not be able to swap or clear them. See
 * docs/security/bearer-token-authority.md.
 */
const CREDENTIAL_OAUTH_HELPERS = Object.freeze({
  hasClaudeOAuthCreds,
  hasGeminiOAuthCreds,
  hasCodexOAuthCreds,
})

// #3855 (Copilot review): the status is sent ONLY to the requesting client —
// no broadcast. The issue acceptance criteria require "no broadcast —
// credentials are admin state, sent only to the requester." Broadcasting (even
// masked) would leak which providers are configured + masked previews to other
// authenticated clients, including pairing-bound ones. Other dashboards refresh
// their own view on open via get_credentials_status instead.
function _sendCredentialsStatus(ctx, ws, requestId) {
  const status = getCredentialsStatus(CREDENTIAL_OAUTH_HELPERS)
  ctx.transport.send(ws, { type: 'credentials_status', requestId: requestId ?? null, ...status })
}

function handleGetCredentialsStatus(ws, client, msg, ctx) {
  _sendCredentialsStatus(ctx, ws, msg?.requestId)
}

function handleSetCredential(ws, client, msg, ctx) {
  if (rejectCredentialWriteIfBound(ws, client, msg, ctx)) return
  const key = typeof msg?.key === 'string' ? msg.key : ''
  if (!isKnownCredentialKey(key)) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', `Unknown credential key: ${key}`, undefined, ctx)
    return
  }
  if (typeof msg?.value !== 'string' || msg.value.trim().length === 0) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'value is required', undefined, ctx)
    return
  }
  try {
    // setStoredCredential trims + validates the value (e.g. sk-ant- / sk-
    // prefix) and persists atomically at mode 0600.
    setStoredCredential(key, msg.value)
  } catch (err) {
    // err.message is validation text or a file-mode reason — never the value.
    log.warn(`set_credential failed for ${key}: ${err?.message}`)
    sendError(ws, msg?.requestId, 'CREDENTIAL_WRITE_FAILED', err?.message || 'write failed', undefined, ctx)
    return
  }
  _sendCredentialsStatus(ctx, ws, msg?.requestId)
}

function handleDeleteCredential(ws, client, msg, ctx) {
  if (rejectCredentialWriteIfBound(ws, client, msg, ctx)) return
  const key = typeof msg?.key === 'string' ? msg.key : ''
  if (!isKnownCredentialKey(key)) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', `Unknown credential key: ${key}`, undefined, ctx)
    return
  }
  try {
    deleteStoredCredential(key)
  } catch (err) {
    sendError(ws, msg?.requestId, 'CREDENTIAL_CLEAR_FAILED', err?.message || 'clear failed', undefined, ctx)
    return
  }
  _sendCredentialsStatus(ctx, ws, msg?.requestId)
}

async function handleTestCredential(ws, client, msg, ctx) {
  const key = typeof msg?.key === 'string' ? msg.key : ''
  if (!isKnownCredentialKey(key)) {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', `Unknown credential key: ${key}`, undefined, ctx)
    return
  }
  let result
  try {
    result = await testCredential(key)
  } catch (err) {
    // testCredential is defensive and shouldn't throw, but never let a raw
    // error escape unmasked.
    log.warn(`test_credential threw for ${key}: ${err?.message}`)
    result = { ok: false, error: 'Credential test failed unexpectedly.' }
  }
  ctx.transport.send(ws, {
    type: 'credential_test_result',
    requestId: msg?.requestId ?? null,
    key,
    ok: Boolean(result.ok),
    ...(result.error ? { error: result.error } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(typeof result.latencyMs === 'number' ? { latencyMs: result.latencyMs } : {}),
  })
}

export const credentialHandlers = {
  byok_get_credentials_status: handleByokGetCredentialsStatus,
  byok_set_credentials: handleByokSetCredentials,
  byok_clear_credentials: handleByokClearCredentials,
  get_credentials_status: handleGetCredentialsStatus,
  set_credential: handleSetCredential,
  delete_credential: handleDeleteCredential,
  test_credential: handleTestCredential,
}
