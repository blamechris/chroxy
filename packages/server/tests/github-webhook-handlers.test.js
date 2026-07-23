import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubWebhookHandlers } from '../src/handlers/github-webhook-handlers.js'
import { readStoredField, setStoredField } from '../src/credential-store.js'
import { WebhookDeliveryRing, WEBHOOK_SECRET_FIELD } from '../src/github-webhook.js'
import { nsCtx } from './test-helpers.js'

/**
 * #6540 (item 3 of #6536): WS handler tests for the repo-events webhook-secret
 * config surface. Guards:
 *   - github_webhook_config_request → value-free config (source, payload URL,
 *     recommended events, delivery readout); open to any authenticated client.
 *   - github_webhook_set_secret → persists ENCRYPTED at 0600, replies with the
 *     masked config (NEVER the secret), refreshes the in-process cache; a
 *     pairing-bound token is REJECTED (host-authority gate).
 *   - github_webhook_clear_secret → removes the stored secret; bound token rejected.
 *
 * A temp HOME isolates the credentials store; the test bootstrap disables the
 * keychain (CHROXY_CRED_DISABLE_KEYCHAIN=1), so writes land as 0600 plaintext.
 */

const SECRET = 'whsec-a-strong-webhook-secret'
const PAYLOAD = Object.freeze({ url: 'https://abc.trycloudflare.com/api/github/webhook', lanOnly: false, note: null })

function makeWs() {
  return { readyState: 1, send: mock.fn() }
}

// The set/config handlers reply via ctx.transport.send (object); errors via
// ws.send (JSON string). Return whichever fired last.
function lastReply(ws, ctx) {
  if (ws.send.mock.callCount() > 0) {
    return JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1].arguments[0])
  }
  if (ctx.transport.send.mock.callCount() > 0) {
    return ctx.transport.send.mock.calls[ctx.transport.send.mock.calls.length - 1].arguments[1]
  }
  return null
}

function makeCtx({ deliveries = null, cache = { value: undefined } } = {}) {
  return nsCtx({
    send: mock.fn(),
    broadcast: mock.fn(),
    webhookPayloadUrl: PAYLOAD,
    repoWebhookDeliveries: deliveries,
    setWebhookSecretCache: mock.fn((v) => { cache.value = v }),
  })
}

describe('github webhook-secret WS handlers (#6540)', () => {
  let tmpHome
  let originalHome
  let savedEnv

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-webhook-handlers-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    savedEnv = process.env.GITHUB_WEBHOOK_SECRET
    delete process.env.GITHUB_WEBHOOK_SECRET
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (savedEnv === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
    else process.env.GITHUB_WEBHOOK_SECRET = savedEnv
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  describe('github_webhook_config_request', () => {
    it('replies with a value-free config (source none when nothing set)', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      githubWebhookHandlers.github_webhook_config_request(ws, {}, { type: 'github_webhook_config_request', requestId: 'r1' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'github_webhook_config')
      assert.equal(reply.requestId, 'r1')
      assert.equal(reply.configured, false)
      assert.equal(reply.source, 'none')
      assert.equal(reply.payloadUrl, PAYLOAD.url)
      assert.equal(reply.lanOnly, false)
      assert.deepEqual(reply.recommendedEvents, ['pull_request', 'issues', 'push', 'release'])
      assert.deepEqual(reply.deliveries, { total: 0, verified: 0, rejected: 0, lastAt: null, lastResult: null, lastKind: null })
    })

    it('reports source=store + the delivery readout when configured', () => {
      setStoredField(WEBHOOK_SECRET_FIELD, SECRET)
      const ring = new WebhookDeliveryRing()
      ring.record({ verified: true, kind: 'pull_request' })
      ring.record({ verified: false })
      const ws = makeWs()
      const ctx = makeCtx({ deliveries: ring })
      githubWebhookHandlers.github_webhook_config_request(ws, {}, { type: 'github_webhook_config_request' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.configured, true)
      assert.equal(reply.source, 'store')
      assert.equal(reply.deliveries.total, 2)
      assert.equal(reply.deliveries.verified, 1)
      assert.equal(reply.deliveries.rejected, 1)
      assert.equal(reply.deliveries.lastResult, 'rejected')
      // The secret value must never appear anywhere in the reply.
      assert.equal(JSON.stringify(reply).includes(SECRET), false)
    })

    it('is OPEN to a pairing-bound client (value-free read)', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      githubWebhookHandlers.github_webhook_config_request(ws, { id: 'c1', boundSessionId: 's1' }, { type: 'github_webhook_config_request' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'github_webhook_config')
    })
  })

  describe('github_webhook_set_secret', () => {
    it('persists the secret encrypted-at-rest (0600), replies masked, refreshes the cache', () => {
      const cache = { value: undefined }
      const ws = makeWs()
      const ctx = makeCtx({ cache })
      githubWebhookHandlers.github_webhook_set_secret(ws, {}, { type: 'github_webhook_set_secret', requestId: 'w1', secret: SECRET }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'github_webhook_config')
      assert.equal(reply.configured, true)
      assert.equal(reply.source, 'store')
      // The reply must never carry the secret.
      assert.equal(JSON.stringify(reply).includes(SECRET), false)
      // Persisted + readable back through the store.
      assert.equal(readStoredField(WEBHOOK_SECRET_FIELD).value, SECRET)
      // 0600 file mode (POSIX).
      if (process.platform !== 'win32') {
        const file = join(tmpHome, '.chroxy', 'credentials.json')
        assert.equal(statSync(file).mode & 0o777, 0o600)
      }
      // In-process hot cache refreshed for live deliveries.
      assert.equal(cache.value, SECRET)
    })

    it('rotation overwrites the stored value and re-caches', () => {
      setStoredField(WEBHOOK_SECRET_FIELD, 'old-secret-value')
      const cache = { value: undefined }
      const ws = makeWs()
      const ctx = makeCtx({ cache })
      githubWebhookHandlers.github_webhook_set_secret(ws, {}, { type: 'github_webhook_set_secret', secret: SECRET }, ctx)
      assert.equal(readStoredField(WEBHOOK_SECRET_FIELD).value, SECRET)
      assert.equal(cache.value, SECRET)
    })

    it('REJECTS a pairing-bound (session-scoped) token without writing', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      githubWebhookHandlers.github_webhook_set_secret(ws, { id: 'c1', boundSessionId: 's1' }, { type: 'github_webhook_set_secret', requestId: 'w2', secret: SECRET }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'WEBHOOK_SECRET_WRITE_FORBIDDEN_BOUND_CLIENT')
      // Nothing persisted.
      assert.equal(readStoredField(WEBHOOK_SECRET_FIELD).value, null)
      assert.equal(existsSync(join(tmpHome, '.chroxy', 'credentials.json')), false)
    })

    it('rejects an empty / too-short secret', () => {
      const ws = makeWs()
      const ctx = makeCtx()
      githubWebhookHandlers.github_webhook_set_secret(ws, {}, { type: 'github_webhook_set_secret', secret: 'short' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'INVALID_REQUEST')
      assert.equal(readStoredField(WEBHOOK_SECRET_FIELD).value, null)
    })
  })

  describe('github_webhook_clear_secret', () => {
    it('removes the stored secret, replies with source=none, clears the cache', () => {
      setStoredField(WEBHOOK_SECRET_FIELD, SECRET)
      const cache = { value: SECRET }
      const ws = makeWs()
      const ctx = makeCtx({ cache })
      githubWebhookHandlers.github_webhook_clear_secret(ws, {}, { type: 'github_webhook_clear_secret', requestId: 'c1' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'github_webhook_config')
      assert.equal(reply.configured, false)
      assert.equal(reply.source, 'none')
      assert.equal(readStoredField(WEBHOOK_SECRET_FIELD).value, null)
      assert.equal(cache.value, null)
    })

    it('REJECTS a pairing-bound token without clearing', () => {
      setStoredField(WEBHOOK_SECRET_FIELD, SECRET)
      const ws = makeWs()
      const ctx = makeCtx()
      githubWebhookHandlers.github_webhook_clear_secret(ws, { id: 'c1', boundSessionId: 's1' }, { type: 'github_webhook_clear_secret' }, ctx)
      const reply = lastReply(ws, ctx)
      assert.equal(reply.type, 'error')
      assert.equal(reply.code, 'WEBHOOK_SECRET_WRITE_FORBIDDEN_BOUND_CLIENT')
      assert.equal(readStoredField(WEBHOOK_SECRET_FIELD).value, SECRET)
    })
  })
})
