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
 * auth used by POST /api/events.
 */
import { createLogger } from './logger.js'
import { safeTokenCompare } from './token-compare.js'
import { resolveIngestSecret } from './event-ingest.js'
import { sendOversizeResponse } from './http-oversize.js'

const log = createLogger('mailbox-route')

// Mailbox payloads are tiny ({ to, from, id, subject, unread_count }).
export const MAX_MAILBOX_BODY_BYTES = 8192

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
  if (!checkIngestAuth(server, req, res)) return
  readCappedJson(req, res, MAX_MAILBOX_BODY_BYTES, (body) => {
    const agentCommId = typeof body.agentCommId === 'string' ? body.agentCommId.trim() : ''
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
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
  if (!checkIngestAuth(server, req, res)) return
  readCappedJson(req, res, MAX_MAILBOX_BODY_BYTES, (body) => {
    const to = typeof body.to === 'string' ? body.to.trim() : ''
    if (!to) {
      sendJson(res, 400, { error: 'to is required' })
      return
    }
    const from = typeof body.from === 'string' ? body.from : 'unknown'
    const unreadCount =
      typeof body.unread_count === 'number' && Number.isFinite(body.unread_count)
        ? body.unread_count
        : null

    // Notify (best-effort; a sink failure must never fail the response).
    let notified = false
    try {
      const countText = unreadCount != null ? `${unreadCount} unread` : 'new message'
      server.pushManager?.send?.('mailbox', 'New mail', `${to}: ${countText} from ${from}`, {
        to,
        from,
        id: typeof body.id === 'string' ? body.id : null,
        unread_count: unreadCount,
        external: true,
      })
      notified = true
    } catch (err) {
      log.warn(`mailbox notify failed: ${err?.message || err}`)
    }

    const reason = injectWakeup(server, to, unreadCount)
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
  if (typeof session.writeTerminalInput !== 'function') return 'not-tui'
  // `isRunning` is true mid-turn or with background shells — inject only at a
  // quiet prompt so we never corrupt an in-flight turn's input.
  if (session.isRunning) return 'busy'
  const countText = unreadCount != null ? `${unreadCount} unread mailbox message(s)` : 'unread mailbox messages'
  const text = `You have ${countText} — run receive_next to process them.\r`
  const ok = session.writeTerminalInput(text)
  return ok ? 'injected' : 'pty-dead'
}
