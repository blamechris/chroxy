/**
 * GitHub webhook receiver for the Control Room repo-events feed (#5966, epic #5422).
 *
 * Accepts GitHub webhook deliveries (`POST /api/github/webhook`), verifies the
 * `X-Hub-Signature-256` HMAC against the configured secret (constant-time, over
 * the RAW body before any parse), normalizes the events the Control Room surfaces
 * (push / pull_request / issues / ping) into a compact repo-event, and pushes it
 * onto a bounded in-memory store the Control Room pane drains. (The WS broadcast +
 * dashboard pane that read this store are separate #5966 sub-tasks.)
 *
 * Security: the HMAC is the ONLY auth — an unsigned / mis-signed delivery is
 * rejected 401 with no detail, constant-time, BEFORE the payload is parsed or
 * trusted. With no secret configured the endpoint is inert (503), so it can ship
 * dark and light up only once the operator sets a secret + points GitHub at it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { RateLimiter, getRateLimitKey } from './rate-limiter.js'
import { sendOversizeResponse } from './http-oversize.js'
import { readStoredField } from './credential-store.js'
import { createLogger } from './logger.js'

const log = createLogger('github-webhook')

/** Max accepted delivery body. GitHub caps payloads at 25 MiB; most are tiny. */
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024 // 2 MiB
/** Bounded repo-event ring capacity. */
export const REPO_EVENT_STORE_CAP = 200

/**
 * #6540 — the credentials-store field name the webhook secret is persisted under
 * (encrypted at rest, mode 0600 — see credential-store.js). A NON-provider-key
 * field like `discordWebhookUrl`; it is NOT injected into any spawned child.
 */
export const WEBHOOK_SECRET_FIELD = 'githubWebhookSecret'

/**
 * #6540 — the GitHub event types the Control Room surfaces, offered as the
 * recommended webhook subscription for copy-paste into GitHub's webhook form.
 */
export const RECOMMENDED_WEBHOOK_EVENTS = Object.freeze(['pull_request', 'issues', 'push', 'release'])

/** #6540 — bounded in-memory recent-delivery ring capacity. */
export const WEBHOOK_DELIVERY_RING_CAP = 50

const WEBHOOK_WINDOW_MS = 60_000
const WEBHOOK_MAX_PER_WINDOW = 120
const WEBHOOK_BURST = 30

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw request body.
 * Constant-time for equal-length inputs; returns false on ANY malformed input
 * (missing secret, wrong prefix, length mismatch) and never throws.
 *
 * @param {Buffer|string} rawBody  - the EXACT bytes GitHub signed
 * @param {unknown} signatureHeader - the `X-Hub-Signature-256` header value
 * @param {string} secret           - the configured webhook secret
 * @returns {boolean}
 */
export function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return false
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8')
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const got = Buffer.from(signatureHeader)
  const want = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch — guard so a wrong-length signature
  // is a plain `false`, not an exception path (and no length-based timing oracle).
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

/**
 * Normalize a GitHub webhook payload into a compact repo-event. Returns null for
 * event types the Control Room does not surface (the caller then accepts-and-skips).
 *
 * @param {string} eventType - the `X-GitHub-Event` header value
 * @param {object} payload   - the parsed webhook body
 * @param {{ now?: () => Date }} [deps]
 * @returns {object|null}
 */
export function normalizeGithubEvent(eventType, payload, { now = () => new Date() } = {}) {
  if (!payload || typeof payload !== 'object') return null
  const repo = payload.repository?.full_name || payload.repository?.name || null
  const actor = payload.sender?.login || null
  const base = { kind: eventType, repo, actor, at: now().toISOString() }

  switch (eventType) {
    case 'push': {
      const ref = typeof payload.ref === 'string' ? payload.ref : null
      const branch = ref ? ref.replace(/^refs\/heads\//, '') : null
      const count = Array.isArray(payload.commits) ? payload.commits.length : 0
      const head = typeof payload.head_commit?.message === 'string' ? payload.head_commit.message.split('\n')[0] : null
      return {
        ...base,
        branch,
        title: head,
        url: payload.head_commit?.url || payload.compare || null,
        summary: `pushed ${count} commit${count === 1 ? '' : 's'} to ${branch ?? ref ?? '(unknown ref)'}`,
      }
    }
    case 'pull_request': {
      const pr = payload.pull_request || {}
      return {
        ...base,
        action: payload.action || null,
        number: typeof pr.number === 'number' ? pr.number : null,
        title: pr.title || null,
        url: pr.html_url || null,
        summary: `${payload.action || 'updated'} PR #${pr.number ?? '?'}`,
      }
    }
    case 'issues': {
      const issue = payload.issue || {}
      return {
        ...base,
        action: payload.action || null,
        number: typeof issue.number === 'number' ? issue.number : null,
        title: issue.title || null,
        url: issue.html_url || null,
        summary: `${payload.action || 'updated'} issue #${issue.number ?? '?'}`,
      }
    }
    case 'ping':
      return { ...base, title: payload.zen || null, url: null, summary: 'webhook configured (ping)' }
    default:
      return null // unsurfaced event type
  }
}

/** Bounded FIFO store of normalized repo-events. The Control Room pane drains it. */
export class RepoEventStore {
  constructor({ cap = REPO_EVENT_STORE_CAP } = {}) {
    this._cap = cap > 0 ? cap : REPO_EVENT_STORE_CAP
    this._events = []
  }

  push(event) {
    this._events.push(event)
    const overflow = this._events.length - this._cap
    if (overflow > 0) this._events.splice(0, overflow)
    return event
  }

  /** Most-recent-last; `limit` returns the tail. */
  list({ limit } = {}) {
    return typeof limit === 'number' && limit >= 0 ? this._events.slice(-limit) : this._events.slice()
  }

  get size() {
    return this._events.length
  }
}

/**
 * #6540 — bounded in-memory ring of recent webhook-delivery outcomes. Powers the
 * config surface's "recent delivery status" readout (count / last / verify
 * result). Deliberately in-memory (the plan's recommended default): it is
 * observability, not durable state, and resets on daemon restart. Only deliveries
 * that reached the HMAC-verify step are recorded — rate-limited (429), oversize
 * (413), and no-secret (503) responses never touch the ring.
 */
export class WebhookDeliveryRing {
  constructor({ cap = WEBHOOK_DELIVERY_RING_CAP } = {}) {
    this._cap = cap > 0 ? cap : WEBHOOK_DELIVERY_RING_CAP
    this._items = []
    this._total = 0
  }

  /** Record one delivery outcome. `verified` is the HMAC result; `kind` the X-GitHub-Event. */
  record({ verified, kind = null, at = new Date().toISOString() } = {}) {
    const entry = { at, verified: !!verified, kind: kind || null }
    this._items.push(entry)
    const overflow = this._items.length - this._cap
    if (overflow > 0) this._items.splice(0, overflow)
    this._total++
    return entry
  }

  get total() {
    return this._total
  }

  get size() {
    return this._items.length
  }

  list() {
    return this._items.slice()
  }

  /** Value-free summary for the `github_webhook_config` reply. */
  summary() {
    const last = this._items.length > 0 ? this._items[this._items.length - 1] : null
    let verified = 0
    let rejected = 0
    for (const it of this._items) {
      if (it.verified) verified++
      else rejected++
    }
    return {
      total: this._total,
      verified,
      rejected,
      lastAt: last ? last.at : null,
      lastResult: last ? (last.verified ? 'verified' : 'rejected') : null,
      lastKind: last ? last.kind : null,
    }
  }
}

/**
 * #6540 — lazily record a delivery outcome onto the server's delivery ring,
 * creating it on first use. Guarded — a bare/stubbed server (tests) still works.
 */
export function recordWebhookDelivery(server, entry) {
  if (!server) return
  if (!server._repoWebhookDeliveries) server._repoWebhookDeliveries = new WebhookDeliveryRing()
  server._repoWebhookDeliveries.record(entry)
}

/**
 * #6540 — derive the public `…/api/github/webhook` payload URL an operator pastes
 * into GitHub, from the server's live origin. Pure + inputs-only so it is unit
 * testable without a running server. Precedence:
 *   1. tunnel URL (a `wss://`/`ws://` endpoint) → `https://host/api/github/webhook`
 *   2. operator-supplied external URL (SKIP_TUNNEL mode) → normalized the same way
 *   3. LAN / loopback fallback → `http://<lanIp-or-host>:<port>/api/github/webhook`,
 *      flagged `lanOnly` with a note (GitHub.com cannot reach it — e.g. `--tunnel none`)
 *
 * @param {{ tunnelUrl?: string|null, externalUrl?: string|null, boundHost?: string, port?: number, lanIp?: string|null, isLoopbackHost?: (h: string) => boolean }} inputs
 * @returns {{ url: string|null, lanOnly: boolean, note: string|null }}
 */
export function deriveWebhookPayloadUrl(inputs = {}) {
  const { tunnelUrl, externalUrl, boundHost, port, lanIp, isLoopbackHost } = inputs
  const PATH = '/api/github/webhook'

  const fromEndpoint = (endpoint) => {
    try {
      const u = new URL(endpoint)
      const scheme = u.protocol === 'wss:' || u.protocol === 'https:'
        ? 'https:'
        : (u.protocol === 'ws:' || u.protocol === 'http:' ? 'http:' : 'https:')
      return `${scheme}//${u.host}${PATH}`
    } catch {
      return null
    }
  }

  // 1. Public tunnel URL (the QR-shared wss:// endpoint).
  if (typeof tunnelUrl === 'string' && tunnelUrl.length > 0) {
    const url = fromEndpoint(tunnelUrl)
    if (url) return { url, lanOnly: false, note: null }
  }

  // 2. Operator-supplied external URL (SKIP_TUNNEL: the operator fronts the daemon).
  if (typeof externalUrl === 'string' && externalUrl.length > 0) {
    const url = fromEndpoint(externalUrl)
    if (url) return { url, lanOnly: false, note: null }
  }

  // 3. LAN / loopback fallback — GitHub.com cannot deliver to this.
  const isLoopback = typeof isLoopbackHost === 'function' ? isLoopbackHost : () => false
  const p = typeof port === 'number' && port > 0 ? port : null
  if (boundHost !== undefined && isLoopback(boundHost)) {
    return {
      url: p ? `http://127.0.0.1:${p}${PATH}` : null,
      lanOnly: true,
      note: 'Loopback bind — GitHub cannot reach this address. Start a tunnel (chroxy tunnel) or bind to your LAN to receive public webhook deliveries.',
    }
  }
  const host = typeof lanIp === 'string' && lanIp.length > 0 ? lanIp : 'YOUR_LAN_IP'
  return {
    url: p ? `http://${host}:${p}${PATH}` : null,
    lanOnly: true,
    note: 'No tunnel active — this LAN address is only reachable from your local network. GitHub.com cannot deliver to it; start a tunnel (chroxy tunnel) for public webhooks.',
  }
}

/**
 * #6540 — determine whether a webhook secret is configured and from which source,
 * WITHOUT reading the value. `store` (the encrypted credentials file) wins over
 * `env` (`GITHUB_WEBHOOK_SECRET`) for the "manageable from the dashboard" signal,
 * matching `resolveWebhookSecret`'s precedence. Pure/injectable for tests.
 *
 * @param {{ readField?: (field: string) => { value: string|null }, env?: string|undefined }} [deps]
 * @returns {'store'|'env'|'none'}
 */
export function webhookSecretSource({ readField = readStoredField, env = process.env.GITHUB_WEBHOOK_SECRET } = {}) {
  const stored = readField(WEBHOOK_SECRET_FIELD)
  if (stored && typeof stored.value === 'string' && stored.value.length > 0) return 'store'
  if (typeof env === 'string' && env.length > 0) return 'env'
  return 'none'
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders })
  res.end(payload)
}

/**
 * Resolve the webhook secret. Precedence (#6540):
 *   1. an explicit in-process override / hot cache (`server._githubWebhookSecret`)
 *      — the config handler sets it on a set/rotate so live deliveries pick up the
 *      new secret without a keychain re-read, and it is also the test seam;
 *   2. the encrypted credentials store (`githubWebhookSecret` field). On a hit we
 *      lazily cache it into `server._githubWebhookSecret` so subsequent deliveries
 *      skip the keychain decrypt (the config handler resets this cache on
 *      set/rotate/clear, so it can never go stale);
 *   3. `$GITHUB_WEBHOOK_SECRET` (back-compat for env-configured deployments).
 *
 * @param {object} server
 * @param {{ readField?: (field: string) => { value: string|null } }} [deps]
 * @returns {string}
 */
export function resolveWebhookSecret(server, { readField = readStoredField } = {}) {
  if (typeof server?._githubWebhookSecret === 'string' && server._githubWebhookSecret.length > 0) {
    return server._githubWebhookSecret
  }
  const stored = readField(WEBHOOK_SECRET_FIELD)
  if (stored && typeof stored.value === 'string' && stored.value.length > 0) {
    // Lazy hot-cache: skip the keychain decrypt on later deliveries. Kept
    // consistent with the store by the config handler (it overwrites/clears
    // `_githubWebhookSecret` on every set/rotate/clear).
    if (server) server._githubWebhookSecret = stored.value
    return stored.value
  }
  const env = process.env.GITHUB_WEBHOOK_SECRET
  return typeof env === 'string' && env.length > 0 ? env : ''
}

/**
 * Handle `POST /api/github/webhook`. Gate order:
 *   1. per-IP rate limit (pre-auth; 429 + Retry-After)
 *   2. secret configured? (503 if not — inert until set)
 *   3. read RAW body (capped; 413)
 *   4. HMAC-verify the X-Hub-Signature-256 over the raw body (401, constant-time)
 *   5. parse JSON (400) + normalize the X-GitHub-Event (202 accept-and-skip if unsurfaced)
 *   6. push onto the bounded RepoEventStore (lazily created on the server) → 202
 */
export function handleGithubWebhook(server, req, res) {
  if (!server._githubWebhookRateLimiter) {
    server._githubWebhookRateLimiter = new RateLimiter({
      windowMs: WEBHOOK_WINDOW_MS,
      maxMessages: WEBHOOK_MAX_PER_WINDOW,
      burst: WEBHOOK_BURST,
      name: 'github-webhook',
    })
  }
  const clientIp = getRateLimitKey(req.socket?.remoteAddress || '', req)
  const limit = server._githubWebhookRateLimiter.check(clientIp)
  if (!limit.allowed) {
    sendJson(res, 429, { error: 'rate limited' }, { 'Retry-After': Math.ceil(limit.retryAfterMs / 1000) })
    return
  }

  const secret = resolveWebhookSecret(server)
  if (!secret) {
    sendJson(res, 503, { error: 'github webhook receiver not configured' })
    return
  }

  const chunks = []
  let bytes = 0
  let oversized = false
  req.on('data', (chunk) => {
    if (oversized) return
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buf.length
    if (bytes > MAX_WEBHOOK_BYTES) {
      oversized = true
      // #5433: respond + STOP consuming from inside the 'data' handler. The
      // helper removes the data listener, pauses the stream (TCP backpressure),
      // and sends the 413 with Connection: close — never drain an unbounded body.
      // Cap checked BEFORE push: the violating chunk is never buffered.
      sendOversizeResponse(req, res, { error: 'payload too large' })
      return
    }
    chunks.push(buf)
  })
  req.on('error', () => {
    // Body-stream error (e.g. client reset mid-send). Guard the response — the
    // socket may already be gone.
    try {
      sendJson(res, 400, { error: 'read error' })
    } catch {
      /* socket already torn down */
    }
  })
  req.on('end', () => {
    // #5313 pattern: this callback runs on a later tick, OUTSIDE the HTTP
    // dispatch try/catch — wrap everything so a throw here (e.g. writeHead on a
    // torn-down socket) can't escape to uncaughtException and crash the daemon.
    try {
      if (oversized) return // 413 already sent from the 'data' handler
      const raw = Buffer.concat(chunks)
      const sig = req.headers['x-hub-signature-256']
      if (!verifyGithubSignature(raw, sig, secret)) {
        // #6540: record the rejected delivery for the config-surface readout.
        recordWebhookDelivery(server, { verified: false })
        log.warn('Rejected GitHub webhook: invalid or missing X-Hub-Signature-256')
        sendJson(res, 401, { error: 'invalid signature' })
        return
      }
      const eventType = String(req.headers['x-github-event'] || '')
      // #6540: authentic (signature-verified) delivery — record it regardless of
      // whether the event type is one the Control Room surfaces. `eventType` comes
      // from the header (available pre-parse), so a verified-but-malformed body
      // still counts as an authentic delivery.
      recordWebhookDelivery(server, { verified: true, kind: eventType || null })
      let payload
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }
      const event = normalizeGithubEvent(eventType, payload)
      if (!event) {
        // Authentic delivery, but an event type the Control Room doesn't surface.
        sendJson(res, 202, { accepted: true, surfaced: false })
        return
      }
      if (!server._repoEventStore) server._repoEventStore = new RepoEventStore()
      server._repoEventStore.push(event)
      // #6536: push the normalized event to connected host-level Control Room
      // panes so the repo-events feed updates live (no Refresh). Guarded — a
      // bare/stubbed server (tests) may not wire the WS broadcast.
      if (typeof server._broadcastRepoEvent === 'function') server._broadcastRepoEvent(event)
      sendJson(res, 202, { accepted: true, surfaced: true, kind: event.kind })
    } catch (err) {
      log.error(`github webhook handler error: ${err?.stack || err}`)
      try {
        sendJson(res, 500, { error: 'internal error' })
      } catch {
        /* socket already torn down */
      }
    }
  })
}
