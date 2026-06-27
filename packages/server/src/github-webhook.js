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
import { createLogger } from './logger.js'

const log = createLogger('github-webhook')

/** Max accepted delivery body. GitHub caps payloads at 25 MiB; most are tiny. */
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024 // 2 MiB
/** Bounded repo-event ring capacity. */
export const REPO_EVENT_STORE_CAP = 200

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

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders })
  res.end(payload)
}

/**
 * Resolve the webhook secret. Prefers an explicit `server._githubWebhookSecret`
 * (set from config at startup), falling back to `$GITHUB_WEBHOOK_SECRET`.
 */
function resolveWebhookSecret(server) {
  if (typeof server?._githubWebhookSecret === 'string' && server._githubWebhookSecret.length > 0) {
    return server._githubWebhookSecret
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
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buf.length
    if (bytes > MAX_WEBHOOK_BYTES) {
      oversized = true
      return
    }
    chunks.push(buf)
  })
  req.on('error', () => sendJson(res, 400, { error: 'read error' }))
  req.on('end', () => {
    if (oversized) {
      sendJson(res, 413, { error: 'payload too large' })
      return
    }
    const raw = Buffer.concat(chunks)
    const sig = req.headers['x-hub-signature-256']
    if (!verifyGithubSignature(raw, sig, secret)) {
      log.warn('Rejected GitHub webhook: invalid or missing X-Hub-Signature-256')
      sendJson(res, 401, { error: 'invalid signature' })
      return
    }
    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' })
      return
    }
    const eventType = String(req.headers['x-github-event'] || '')
    const event = normalizeGithubEvent(eventType, payload)
    if (!event) {
      // Authentic delivery, but an event type the Control Room doesn't surface.
      sendJson(res, 202, { accepted: true, surfaced: false })
      return
    }
    if (!server._repoEventStore) server._repoEventStore = new RepoEventStore()
    server._repoEventStore.push(event)
    sendJson(res, 202, { accepted: true, surfaced: true, kind: event.kind })
  })
}
