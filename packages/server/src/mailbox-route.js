/**
 * Mailbox live-interrupt routes (agent-comm-system delivery layer).
 *
 * The `agent-comm-system` MCP fires a best-effort webhook on every send
 * (AGENT_COMM_EMIT_WEBHOOK -> POST { to, from, id, subject, unread_count }).
 * Point that at this daemon's `/api/mailbox` and chroxy will:
 *   1. notify (rides the existing PushManager pipeline), and
 *   2. wake the recipient NOW when it is a live, idle claude-tui session —
 *      by injecting a "process your mailbox" prompt into its PTY. When the
 *      recipient is mid-turn, not a TUI session, or unknown, chroxy notifies
 *      only and the portable idle Stop hook delivers at the next turn boundary.
 *
 * Routing needs an agent-id -> session map, populated via `/api/mailbox/register`.
 *
 * Both routes accept ONLY the daemon-level ingest secret (never the primary
 * token — see docs/security/bearer-token-authority.md §6), reusing the exact
 * auth used by POST /api/events, behind a pre-auth per-IP rate limit.
 */
import { createLogger } from './logger.js'
import { safeTokenCompare } from './token-compare.js'
import { resolveIngestSecret } from './event-ingest.js'
import { sendOversizeResponse } from './http-oversize.js'
import { settlePush } from './push.js'
import { RateLimiter, getRateLimitKey } from './rate-limiter.js'

const log = createLogger('mailbox-route')

// Mailbox payloads are tiny ({ to, from, id, subject, unread_count }).
export const MAX_MAILBOX_BODY_BYTES = 8192
// Cap on log-visible / routing-key fields so a secret-holder can neither bloat
// the routing map nor inject control chars into logs + notifications.
const MAX_FIELD_LENGTH = 200
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
// Pre-auth per-IP rate limit (mirrors event-ingest.js): bound online
// brute-force of the secret AND invalid-token warn-log spam, BEFORE the
// constant-time secret check.
const MAILBOX_WINDOW_MS = 60_000
const MAILBOX_IP_MAX = 240
const MAILBOX_IP_BURST = 30

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

/** 401, fail closed: no body detail about WHY auth failed. */
function sendUnauthorized(res) {
  res.writeHead(401)
  res.end()
}

/**
 * Normalize a log-visible / routing-key field: trim, reject empty, reject
 * control characters (log/notification injection), and cap the length (keeps
 * the routing map bounded). Returns the cleaned value, or null when invalid.
 */
function cleanField(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > MAX_FIELD_LENGTH || CONTROL_CHARS.test(v)) return null
  return v
}

/**
 * Pre-auth per-IP rate limit, lazily created on the server object (mirrors
 * event-ingest.js). Returns true when the request may proceed; otherwise
 * responds 429 + Retry-After and returns false.
 */
function checkIpRateLimit(server, req, res, routeName) {
  if (!server._mailboxIpRateLimiter) {
    server._mailboxIpRateLimiter = new RateLimiter({
      windowMs: MAILBOX_WINDOW_MS,
      maxMessages: MAILBOX_IP_MAX,
      burst: MAILBOX_IP_BURST,
      name: 'mailbox-ip',
    })
  }
  const clientIp = getRateLimitKey(req.socket?.remoteAddress || '', req)
  const { allowed, retryAfterMs } = server._mailboxIpRateLimiter.check(clientIp)
  if (!allowed) {
    log.warn(`Rate limited ${routeName} from ${clientIp}`)
    sendJson(res, 429, { error: 'rate limited', retryAfterMs })
    return false
  }
  return true
}

/**
 * Bearer auth against the daemon ingest secret (constant-time; same token
 * class as POST /api/events). Returns true when authorized; otherwise responds
 * 401 and returns false.
 */
function checkIngestAuth(server, req, res) {
  const secret = resolveIngestSecret(server)
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  // safeTokenCompare on every request (even when the secret failed to load, via
  // the null check) — no early-exit timing oracle, no raw token logged.
  if (!secret || !safeTokenCompare(token, secret)) {
    log.warn('Rejected mailbox request: invalid or missing ingest auth')
    sendUnauthorized(res)
    return false
  }
  return true
}

/**
 * Capped utf8 body read + defensive JSON parse. Invokes `onParsed(obj)` with a
 * plain object, or responds (413/400) and does not call back. Mirrors the
 * event-ingest.js streaming pattern (counts BYTES, reassembles multi-byte).
 */
function readCappedJson(req, res, maxBytes, onParsed) {
  req.setEncoding('utf8')
  let body = ''
  let bytes = 0
  let oversized = false
  req.on('data', (chunk) => {
    if (oversized) return
    bytes += Buffer.byteLength(chunk, 'utf8')
    if (bytes > maxBytes) {
      oversized = true
      sendOversizeResponse(req, res, { error: 'body too large' })
      return
    }
    body += chunk
  })
  req.on('end', () => {
    if (oversized) return
    let parsed
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' })
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'invalid body' })
      return
    }
    onParsed(parsed)
  })
  req.on('error', () => {
    if (!oversized) sendJson(res, 400, { error: 'read error' })
  })
}

/**
 * POST /api/mailbox/register — map a mailbox id (AGENT_COMM_ID) to a live
 * sessionId so POST /api/mailbox can wake the right session.
 * Body: { agentCommId, sessionId }
 */
export function handleMailboxRegister(server, req, res) {
  if (!checkIpRateLimit(server, req, res, 'POST /api/mailbox/register')) return
  if (!checkIngestAuth(server, req, res)) return
  readCappedJson(req, res, MAX_MAILBOX_BODY_BYTES, (body) => {
    const agentCommId = cleanField(body.agentCommId)
    const sessionId = cleanField(body.sessionId)
    if (!agentCommId || !sessionId) {
      sendJson(res, 400, { error: 'agentCommId and sessionId are required' })
      return
    }
    const ok = server.sessionManager?.registerAgentCommId?.(sessionId, agentCommId) === true
    if (!ok) {
      sendJson(res, 404, { error: 'unknown session' })
      return
    }
    log.info(`Registered mailbox id "${agentCommId}" -> session ${sessionId}`)
    sendJson(res, 200, { ok: true })
  })
}

/**
 * POST /api/mailbox — "new mail" ping from agent-comm-system's emit hook.
 * Body: { to, from, id, subject?, unread_count }
 * Notifies and, when `to` is a live idle claude-tui session, injects a wakeup.
 */
export function handleMailboxPing(server, req, res) {
  if (!checkIpRateLimit(server, req, res, 'POST /api/mailbox')) return
  if (!checkIngestAuth(server, req, res)) return
  readCappedJson(req, res, MAX_MAILBOX_BODY_BYTES, (body) => {
    const to = cleanField(body.to)
    if (!to) {
      sendJson(res, 400, { error: 'to is required' })
      return
    }
    const from = cleanField(body.from) || 'unknown'
    // Non-negative integer only — a negative / fractional count would render
    // odd notification text and wakeup prompts.
    const unreadCount =
      typeof body.unread_count === 'number' &&
      Number.isInteger(body.unread_count) &&
      body.unread_count >= 0
        ? body.unread_count
        : null

    // Notify (fire-and-forget; settlePush logs a failed delivery/rejection
    // instead of leaving the async send's rejection unhandled).
    const notified = Boolean(server.pushManager)
    if (notified) {
      const countText = unreadCount != null ? `${unreadCount} unread` : 'new message'
      settlePush(
        server.pushManager.send('mailbox', 'New mail', `${to}: ${countText} from ${from}`, {
          to,
          from,
          id: cleanField(body.id),
          unread_count: unreadCount,
          external: true,
        }),
        'mailbox',
        log,
      )
    }

    const reason = injectWakeup(server, to, unreadCount)
    // Record the delivery for the Control Room "Mailbox" tab (observability;
    // recordMailboxEvent never throws into the delivery path).
    server.sessionManager?.recordMailboxEvent?.({ to, from, unreadCount, outcome: reason })
    sendJson(res, 200, { ok: true, notified, injected: reason === 'injected', reason })
  })
}

/**
 * Inject a wakeup prompt into the recipient's live session when it is safe —
 * a claude-tui session at a quiet prompt. Uses only public session surface
 * (`writeTerminalInput` + the `isRunning` getter). Returns the outcome reason.
 * @returns {'injected'|'busy'|'not-tui'|'no-session'|'pty-dead'}
 */
function injectWakeup(server, to, unreadCount) {
  const session = server.sessionManager?.resolveSessionByAgentCommId?.(to) ?? null
  if (!session) return 'no-session'
  // #5984 (epic #5982): gate on the positive claude-tui discriminator, NOT
  // `typeof session.writeTerminalInput` — a user-shell session (#5983) will
  // also expose writeTerminalInput, and duck-typing here would let the weaker
  // ingest-secret holder inject an executed line into a root shell (swarm-audit
  // finding C2). Only the claude-tui PTY mirror is a legitimate wakeup target.
  // Strict `!== true` (not truthiness): this gate is security-load-bearing, so a
  // buggy override returning a truthy non-boolean must NOT be treated as tui.
  if (session.constructor?.isClaudeTui !== true) return 'not-tui'
  // Defense-in-depth: isClaudeTui===true implies writeTerminalInput exists today
  // (only ClaudeTuiSession sets the marker AND defines the method), so this is
  // unreachable in practice — but it guards against a future class that sets the
  // marker without the method rather than throwing on the write below.
  if (typeof session.writeTerminalInput !== 'function') return 'not-tui'
  // `isRunning` is true mid-turn or with background shells — inject only at a
  // quiet prompt so we never corrupt an in-flight turn's input.
  if (session.isRunning) return 'busy'
  const countText = unreadCount != null ? `${unreadCount} unread mailbox message(s)` : 'unread mailbox messages'
  const text = `You have ${countText} — run receive_next to process them.\r`
  const ok = session.writeTerminalInput(text)
  return ok ? 'injected' : 'pty-dead'
}
