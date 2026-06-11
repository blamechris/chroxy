/**
 * POST /api/events — authenticated local event ingest (#5413 Phase 3).
 *
 * Lets chroxy become aware of Claude Code sessions it did NOT launch:
 * external hook emitters (Phase 4's packages/claude-hooks) POST normalized
 * events here, and they flow through the EXISTING notification pipeline
 * (PushManager.send → per-category rate limit → prefs → sink fan-out), so
 * the Discord status embed and Expo push both light up with zero new
 * delivery machinery.
 *
 * Auth — the "ingest secret", a fourth daemon-level token class (see
 * docs/security/bearer-token-authority.md §6):
 *   - External sessions have no per-session hook secret (chroxy never
 *     spawned them), and putting the PRIMARY token in every hook process's
 *     environment would grant full session authority to anything that can
 *     read a hook's env. So the endpoint accepts exactly one credential: a
 *     dedicated secret generated once and stored 0600 at
 *     `~/.chroxy/ingest-secret` (CHROXY_CONFIG_DIR honored), where the
 *     same-user hook emitters can read it.
 *   - Constant-time compared (safeTokenCompare), never logged, scoped to
 *     this single endpoint. The daemon may be tunnel-exposed, so this is
 *     bearer-gated exactly like POST /permission — possession of the
 *     secret is the boundary, not network position.
 *   - Fail closed: missing/invalid auth → 401 with no body detail; if the
 *     secret cannot be loaded or created, every request is rejected.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { safeTokenCompare } from './token-compare.js'
import { sendOversizeResponse } from './http-oversize.js'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'
import { RateLimiter, getRateLimitKey } from './rate-limiter.js'
import { SubagentCounter } from './subagent-counter.js'
import { TurnTracker } from './turn-tracker.js'
import { IngestEventSchema } from '@chroxy/protocol'

const log = createLogger('ingest')

/** Body cap — matches POST /permission's MAX_BODY (ws-permissions.js). */
export const MAX_INGEST_BODY_BYTES = 65536

/**
 * Per-source rate limit: 60 events/min (+10 burst) per `source` bucket.
 * A runaway hook loop saturates its own bucket and gets 429s instead of
 * flooding the pipeline (PushManager's per-category limits are the second
 * layer; Discord's own 429 handling is the third).
 */
const INGEST_WINDOW_MS = 60_000
const INGEST_MAX_EVENTS = 60
const INGEST_BURST = 10

/**
 * Pre-auth per-IP ceiling (#5432 review S1/S2): the per-source buckets
 * above are keyed on a caller-chosen string, so a secret-holder rotating
 * `source` per request would otherwise mint a fresh bucket every time.
 * The per-IP limit is the hard total — sized above the per-source limit
 * because one machine legitimately runs several emitting sessions.
 */
const INGEST_IP_MAX_EVENTS = 240
const INGEST_IP_BURST = 30

/**
 * Event type → notification category + default title/body. Categories ride
 * the existing PushManager machinery (RATE_LIMITS in push.js) and map onto
 * Discord embed states via STATE_FOR_CATEGORY in discord-webhook-sink.js:
 *
 *   session_start  → session_online   (embed: online — DELETE old + fresh POST,
 *                                      the bash original's SessionStart)
 *   session_end    → session_offline  (embed: offline — routine PATCH)
 *   subagent_*     → session_activity (embed: online — routine PATCH, throttled;
 *                                      counting moves server-side in Phase 4)
 *   post_tool_use  → session_activity
 *   notification   → activity_waiting (existing category: input/approval needed —
 *                                      ping-worthy, like the bash Notification arm)
 *                    EXCEPT data.notificationType === 'idle_prompt' (#5439
 *                    GAP A) → activity_update (embed: idle — 🦀 ready ping
 *                    with idle→idle dedup, the bash idle_prompt arm)
 */
export const INGEST_CATEGORY_FOR_TYPE = {
  session_start: { category: 'session_online', title: 'Session online', body: 'External session started' },
  session_end: { category: 'session_offline', title: 'Session offline', body: 'External session ended' },
  subagent_start: { category: 'session_activity', title: 'Subagent started', body: 'A subagent is running' },
  subagent_stop: { category: 'session_activity', title: 'Subagent finished', body: 'A subagent completed' },
  notification: { category: 'activity_waiting', title: 'Input needed', body: 'Claude is waiting' },
  post_tool_use: { category: 'session_activity', title: 'Tool activity', body: 'Tool use completed' },
  // #5541 turn edges. user_prompt_submit is the authoritative turn START:
  // session_activity (online embed) so the embed flips off "Ready for input"
  // immediately, and it sets turn-in-flight for the (source, sessionId) so
  // the sink's GAP C idle-hold no longer applies. stop is the authoritative
  // turn END: activity_update (idle embed, 🦀 "Ready for input") — Stop fires
  // immediately, where Claude Code's idle Notification only fires after ~60s,
  // and it clears turn-in-flight. The existing idle→idle dedup in the sink
  // absorbs the later idle Notification.
  user_prompt_submit: { category: 'session_activity', title: 'Turn started', body: 'User submitted a prompt' },
  stop: { category: 'activity_update', title: 'Ready for input', body: 'Claude is waiting for input' },
}

/**
 * #5439 GAP A: the hooks' Notification emitter forwards the matcher
 * discriminator as data.notificationType. `idle_prompt` is the bash
 * original's highest-volume ping ("ready for input") and must ride the
 * activity_update category — the Discord sink maps it to the `idle` embed
 * state (project color, idle→idle dedup). `permission_prompt` (and any
 * payload without the discriminator) keeps the activity_waiting default
 * above (permission embed, always re-pings).
 */
export const INGEST_IDLE_PROMPT_MAPPING = {
  category: 'activity_update',
  title: 'Ready for input',
  body: 'Claude is waiting for input',
}

/** Default on-disk location for the ingest secret (0600, same-user reads). */
export function defaultIngestSecretPath() {
  const configDir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(configDir, 'ingest-secret')
}

/**
 * Read the ingest secret from disk, generating + persisting it (0600,
 * temp+rename via writeFileRestricted) when missing. Throws on I/O failure
 * — callers decide whether that's fatal (the route fails closed; startup
 * logs and carries on).
 */
export function loadOrCreateIngestSecret(secretPath = defaultIngestSecretPath()) {
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf-8').trim()
    if (existing.length > 0) return existing
  }
  const secret = randomBytes(32).toString('base64url')
  mkdirSync(dirname(secretPath), { recursive: true })
  writeFileRestricted(secretPath, secret + '\n')
  return secret
}

/**
 * Startup helper: make sure the secret file exists BEFORE any hook tries to
 * read it (chicken-and-egg: emitters authenticate with the file's content).
 * Never throws — ingest is an optional surface; a failure here just means
 * the route rejects everything (fail closed) until the operator fixes the
 * config dir. Never logs the secret itself.
 */
export function ensureIngestSecret(secretPath = defaultIngestSecretPath()) {
  try {
    loadOrCreateIngestSecret(secretPath)
    return true
  } catch (err) {
    log.warn(`Could not provision ingest secret at ${secretPath}: ${err.message}`)
    return false
  }
}

/**
 * Derive a project name from a working directory by walking up to the
 * nearest `.git` (directory OR file — worktrees use a `.git` file) and
 * taking that directory's basename. Falls back to `basename(cwd)` when no
 * git root is found, and `null` for unusable input. Pure fs probing — never
 * shells out (this runs per ingested event).
 */
export function deriveProjectFromCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let dir
  try {
    dir = resolve(cwd)
  } catch {
    return null
  }
  let current = dir
  // Bounded walk — terminates at the fs root anyway; the cap is paranoia
  // against pathological/cyclic resolutions.
  for (let i = 0; i < 256; i++) {
    try {
      if (existsSync(join(current, '.git'))) {
        const name = basename(current)
        return name.length > 0 ? name : null
      }
    } catch {
      return null
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const fallback = basename(dir)
  return fallback.length > 0 ? fallback : null
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(body))
}

/** 401, fail closed: no body detail, nothing about WHY auth failed. */
function sendUnauthorized(res) {
  res.writeHead(401)
  res.end()
}

/**
 * Resolve the secret the route compares against. `server._ingestSecret` is
 * the test seam; otherwise load (and lazily create) from
 * `server._ingestSecretPath` / the default path, cached on the server
 * object so the fs probe doesn't run per event. Returns null on failure —
 * the caller MUST reject (fail closed).
 */
function resolveIngestSecret(server) {
  if (typeof server._ingestSecret === 'string' && server._ingestSecret.length > 0) {
    return server._ingestSecret
  }
  if (typeof server._ingestSecretCached === 'string') return server._ingestSecretCached
  try {
    const secret = loadOrCreateIngestSecret(server._ingestSecretPath || defaultIngestSecretPath())
    server._ingestSecretCached = secret
    return secret
  } catch (err) {
    log.warn(`Ingest secret unavailable: ${err.message}`)
    return null
  }
}

/**
 * Handle POST /api/events. Order of gates:
 *   1. bearer auth against the ingest secret (constant-time; 401, no detail)
 *   2. body size cap (413) + defensive JSON parse (400)
 *   3. IngestEventSchema validation (400 with field-level messages)
 *   4. per-source rate limit (429 + Retry-After)
 *   5. map type → category, derive project, dispatch into PushManager
 *
 * Responds 200 as soon as the event is dispatched — delivery (Discord
 * retries etc.) is the pipeline's business; hook emitters must stay fast
 * and fail-silent (<100ms budget in Phase 4).
 */
export function handleEventIngest(server, req, res) {
  // Pre-auth per-IP limit (#5432 review S1/S2), mirroring POST /permission's
  // #3980 limiter: caps total throughput per client BEFORE auth (cheap 429s
  // for brute-force probing) and — crucially — bounds the post-auth abuse
  // where a secret-holder rotates `source` per request to mint a fresh
  // per-source bucket each time. Wider window than per-source (several
  // concurrent sessions emit through one IP) but a hard ceiling all the same.
  // getRateLimitKey prefers the forwarded client IP for loopback/tunneled
  // peers so one noisy client can't exhaust everyone's bucket, and falls
  // back to the kernel socket address for direct peers (unspoofable).
  if (!server._ingestIpRateLimiter) {
    server._ingestIpRateLimiter = new RateLimiter({
      windowMs: INGEST_WINDOW_MS,
      maxMessages: INGEST_IP_MAX_EVENTS,
      burst: INGEST_IP_BURST,
      name: 'ingest-ip',
    })
  }
  const clientIp = getRateLimitKey(req.socket?.remoteAddress || '', req)
  {
    const { allowed, retryAfterMs } = server._ingestIpRateLimiter.check(clientIp)
    if (!allowed) {
      log.warn(`Rate limited POST /api/events from ${clientIp}`)
      sendJson(res, 429, { error: 'rate limited', retryAfterMs }, {
        'Retry-After': Math.ceil(retryAfterMs / 1000),
      })
      return
    }
  }

  const secret = resolveIngestSecret(server)
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  // safeTokenCompare on every request (even when the secret failed to load,
  // via the null → '' coercion rejecting) — no early-exit timing oracle and
  // no raw token ever logged.
  if (!secret || !safeTokenCompare(token, secret)) {
    log.warn('Rejected POST /api/events: invalid or missing ingest auth')
    sendUnauthorized(res)
    return
  }

  // utf8 decoding so multi-byte chars split across TCP chunks reassemble
  // correctly, and the cap below counts BYTES (Buffer.byteLength), not
  // UTF-16 code units — body.length undercounts non-ASCII ~3x.
  req.setEncoding('utf8')
  let body = ''
  let bodyBytes = 0
  let oversized = false
  req.on('data', (chunk) => {
    if (oversized) return
    bodyBytes += Buffer.byteLength(chunk, 'utf8')
    if (bodyBytes > MAX_INGEST_BODY_BYTES) {
      oversized = true
      // #5433: respond BEFORE teardown — destroying the socket here would
      // suppress 'end' and the client would see a reset instead of the 413.
      // The helper stops consumption and closes the connection after the
      // response flushes. Cap checked BEFORE append: the violating chunk is
      // never buffered, so `body` never exceeds the cap in memory.
      sendOversizeResponse(req, res, { error: 'body too large' })
      return
    }
    body += chunk
  })
  req.on('end', () => {
    // #5313 pattern: this callback runs on a later tick, OUTSIDE the HTTP
    // dispatch try/catch (#5312) — wrap everything so a throw here can't
    // escape to uncaughtException and take the daemon down.
    try {
      // #5433: the 413 was already sent from the 'data' handler.
      if (oversized) return

      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }

      const result = IngestEventSchema.safeParse(parsed)
      if (!result.success) {
        const details = result.error.issues
          .slice(0, 10)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        sendJson(res, 400, { error: 'invalid event', details })
        return
      }
      const event = result.data

      // Per-source rate limit. Lazily constructed so http-routes' mock
      // servers get one for free; ws-server can pre-seed `_ingestRateLimiter`
      // if tighter knobs are ever needed.
      if (!server._ingestRateLimiter) {
        server._ingestRateLimiter = new RateLimiter({
          windowMs: INGEST_WINDOW_MS,
          maxMessages: INGEST_MAX_EVENTS,
          burst: INGEST_BURST,
          name: 'ingest',
        })
      }
      const { allowed, retryAfterMs } = server._ingestRateLimiter.check(`source:${event.source}`)
      if (!allowed) {
        log.warn(`Rate limited POST /api/events from source "${event.source}"`)
        sendJson(res, 429, { error: 'rate limited', retryAfterMs }, {
          'Retry-After': Math.ceil(retryAfterMs / 1000),
        })
        return
      }

      const pushManager = server.pushManager
      if (!pushManager || typeof pushManager.send !== 'function') {
        sendJson(res, 503, { error: 'notification pipeline unavailable' })
        return
      }

      let mapping = INGEST_CATEGORY_FOR_TYPE[event.type]
      // Schema enum and this map are kept in lockstep; belt-and-braces only.
      if (!mapping) {
        sendJson(res, 400, { error: 'invalid event', details: [`type: unsupported type ${event.type}`] })
        return
      }

      // Explicit `project` wins; otherwise derive from data.cwd (git-root
      // walk). The Discord sink's _projectKey prefers data.project, so this
      // is what keys the per-project status embed.
      const data = event.data || {}

      // #5439 GAP A: split the Notification hook by its discriminator —
      // idle prompts are "ready for input" (idle embed), not approvals.
      if (event.type === 'notification' && data.notificationType === 'idle_prompt') {
        mapping = INGEST_IDLE_PROMPT_MAPPING
      }
      const project = event.project
        || (typeof data.cwd === 'string' ? deriveProjectFromCwd(data.cwd) : null)

      // Server-side subagent counting (#5413 Phase 4): fold subagent_start/
      // subagent_stop into the per-(source, sessionId) aggregate (session_end
      // clears it), and surface the active count on every event so the
      // Discord embed's `data.subagents` field and the notification text can
      // use it. Lazily constructed like the rate limiters; tests can pre-seed
      // `_subagentCounter` for clock injection.
      //
      // #5463: the surfaced count is the PER-PROJECT total, not the event's
      // own session count. The embed is keyed per project, and several
      // sessions emit into one project (main session + worktree agents
      // remapped to the parent by the hooks' GAP B filter) — stamping each
      // event with its own session's count made the embed flip between
      // unrelated numbers, and a zero from session B falsely fired session
      // A's armed count→0 ready re-ping. `project` here is the post-remap
      // name (explicit envelope project wins over cwd derivation), i.e. the
      // same key _projectKey uses for the embed. Events without a project
      // fall back to the per-session count — the embed key falls back to
      // the sessionId in that case too, so the scopes still match.
      if (!server._subagentCounter) {
        server._subagentCounter = new SubagentCounter()
      }
      const counted = server._subagentCounter.record(event.type, event.source, event.sessionId, project)
      const activeSubagents = project
        ? server._subagentCounter.getProjectTotal(project)
        : (counted !== null
          ? counted
          : server._subagentCounter.getCount(event.source, event.sessionId))

      // #5541: turn-in-flight tracking, wired exactly like the subagent
      // counter above. user_prompt_submit sets it, stop/session_end clear it;
      // the per-project aggregate (anyTurnInFlight) rides every event as
      // `data.turnInFlight` so the Discord sink can rescope its GAP C
      // idle-hold (the embed must stay online while the main agent is busy,
      // even when its subagents are still running). A daemon restart empties
      // this in-memory map, so the flag defaults to false — today's behavior.
      if (!server._turnTracker) {
        server._turnTracker = new TurnTracker()
      }
      server._turnTracker.record(event.type, event.source, event.sessionId, project)
      const turnInFlight = project
        ? server._turnTracker.anyTurnInFlight(project)
        : (event.sessionId ? server._turnTracker.isInFlight(event.source, event.sessionId) : false)

      const title = typeof data.title === 'string' && data.title.length > 0 ? data.title : mapping.title
      let notifyBody = typeof data.message === 'string' && data.message.length > 0 ? data.message : mapping.body
      if (event.sessionId) {
        if (event.type === 'subagent_start' || event.type === 'subagent_stop') {
          notifyBody = `${notifyBody} (${activeSubagents} active)`
        } else if (activeSubagents > 0) {
          notifyBody = `${notifyBody} — ${activeSubagents} subagent${activeSubagents === 1 ? '' : 's'} active`
        }
      }

      // Fire-and-forget: the pipeline owns delivery (category rate limits,
      // prefs, sink retries). A hard sink failure is logged, not surfaced —
      // emitters can't act on it anyway.
      Promise.resolve(
        pushManager.send(mapping.category, title, notifyBody, {
          ...data,
          source: event.source,
          external: true,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(project ? { project } : {}),
          // `subagents` is the key the Discord sink already renders
          // (discord-webhook-sink.js `data.subagents` → embed field).
          ...(event.sessionId ? { subagents: activeSubagents } : {}),
          // #5541: per-project turn-in-flight flag — the Discord sink reads
          // `data.turnInFlight` to decide whether GAP C's idle-hold applies.
          turnInFlight,
          ts: event.ts,
        })
      ).then((ok) => {
        if (ok === false) log.warn(`Ingest event ${event.type} from "${event.source}" failed sink delivery`)
      }).catch((err) => {
        log.warn(`Ingest event ${event.type} dispatch error: ${err?.message || err}`)
      })

      sendJson(res, 200, { ok: true, category: mapping.category, ...(project ? { project } : {}) })
    } catch (err) {
      log.error(`POST /api/events handler error: ${err?.stack || err}`)
      if (!res.headersSent) {
        try { sendJson(res, 500, { error: 'Internal server error' }) } catch { /* torn down */ }
      } else {
        try { res.end() } catch { /* already ended */ }
      }
    }
  })
}
