import { readFileSync, existsSync, statSync } from 'fs'
import { join, resolve, dirname, relative, sep, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import QRCode from 'qrcode'
import { readConnectionInfo } from './connection-info.js'
import { createLogger } from './logger.js'
import { metrics } from './metrics.js'
import { buildDiagnosticsSnapshot } from './diagnostics.js'
import { getRateLimitKey } from './rate-limiter.js'
import { listSnapshots, deleteSnapshot } from './snapshots-store.js'
import { handleEventIngest } from './event-ingest.js'
import { handleGithubWebhook } from './github-webhook.js'
import { handleMailboxPing, handleMailboxRegister } from './mailbox-route.js'
import { isPoolEnabled } from './docker-byok-pool.js'
import { getSharedPoolStats } from './docker-byok-pool-stats.js'
import { isValidSlug, mimeForPath } from './pages-store.js'
import { sendOversizeResponse } from './http-oversize.js'
import { resolveOAuthCallback, MCP_OAUTH_CALLBACK_PATH } from './byok-mcp-oauth.js'

/**
 * #5683 — read + JSON-parse a request body with a byte cap. Resolves to the
 * parsed object, or `null` when it has already responded (413 oversize / 400
 * invalid JSON). Mirrors the byte-counted, utf8-safe streaming guard in
 * event-ingest.js (#5433): the violating chunk is never buffered, and the
 * `end` body is wrapped so a parse throw can't escape to uncaughtException.
 */
function readJsonBodyCapped(req, res, maxBytes) {
  return new Promise((resolve) => {
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
        resolve(null)
        return
      }
      body += chunk
    })
    req.on('end', () => {
      // Wrap the WHOLE handler (not just JSON.parse): this listener runs on a
      // later tick inside the Promise executor, OUTSIDE the dispatch try/catch
      // (#5313), so an unguarded throw here (e.g. res write on a torn-down
      // socket) would escape to uncaughtException.
      try {
        if (oversized) return
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid JSON' }))
          resolve(null)
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'body must be a JSON object' }))
          resolve(null)
          return
        }
        resolve(parsed)
      } catch {
        resolve(null)
      }
    })
    // Settle on error AND close so a client abort / half-open socket can never
    // leak a pending promise (resolve is idempotent, so a later `end` is a no-op).
    req.on('error', () => resolve(null))
    req.on('close', () => resolve(null))
  })
}

// #5683 — security headers for every Chroxy Pages response. The `/p/<slug>`
// route is intentionally UNAUTHENTICATED (the slug is the capability).
// `script-src 'none'` + `connect-src 'none'` + `sandbox` make served pages
// fully static (no JS, no network) — exactly right for the HTML reports this
// serves, and defence-in-depth so a served page can never script same-origin
// `/api/*` calls. (Note: `_validateBearerAuth` is HEADER-only — it does not
// read a cookie; the `chroxy_auth` cookie `_authenticateDashboardRequest` sets
// is `Path=/dashboard`-scoped + HttpOnly, so it never reaches `/p/*` or
// `/api/*`. The CSP is belt-and-suspenders, not the sole guard.) See
// docs/security/bearer-token-authority.md.
const PAGE_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

const log = createLogger('ws')

/** Minimal HTML-escape for interpolating an untrusted value into a page body. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version

const ALLOWED_ORIGINS = [
  'tauri://localhost',
  'https://tauri.localhost',
]

/**
 * Render a diagnostics snapshot as a copy-pasteable plaintext block.
 * Used when the caller asks `Accept: text/plain` — convenient for SSH
 * sessions and bug reports.
 */
function formatDiagnosticsText(snap) {
  const lines = []
  const s = snap.server || {}
  lines.push(`chroxy server v${s.version} (${s.mode || 'unknown'}) — pid ${s.pid}, node ${s.nodeVersion}`)
  lines.push(`uptime: ${s.uptime}s — clients: ${snap.clients?.connected ?? 0} connected, ${snap.clients?.authenticated ?? 0} authed`)
  lines.push(`memory: rss=${formatBytes(s.memory?.rss)} heap=${formatBytes(s.memory?.heapUsed)}/${formatBytes(s.memory?.heapTotal)}`)
  lines.push('')
  lines.push(`sessions (${snap.sessions?.length ?? 0}):`)
  for (const sess of snap.sessions || []) {
    lines.push(`  - ${sess.id} [${sess.provider}] busy=${sess.isBusy} mode=${sess.permissionMode}`)
    lines.push(`    pause=${sess.resultTimeoutPaused} count=${sess.permissionPauseCount} cwd=${sess.cwd}`)
    if (sess.pendingPermissions?.length) {
      for (const p of sess.pendingPermissions) {
        const age = p.ageMs != null ? `${Math.round(p.ageMs / 1000)}s` : '?'
        lines.push(`    pending: ${p.tool} (${age} old) — ${p.description || ''}`)
      }
    }
  }
  lines.push('')
  const lg = snap.logs || {}
  lines.push(`log tail (${lg.source}${lg.path ? `: ${lg.path}` : ''}):`)
  for (const line of lg.lines || []) lines.push(`  ${line}`)
  if (lg.note) lines.push(`  (${lg.note})`)
  if (lg.error) lines.push(`  (error: ${lg.error})`)
  return lines.join('\n') + '\n'
}

function formatBytes(n) {
  if (typeof n !== 'number') return '?'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Hard ceiling on `?logTailBytes=N` for `GET /diagnostics` (#3739).
 * 8x the default (8192) — large enough for a wide stall window, small
 * enough that a stolen token can't pull megabytes per request.
 */
const LOG_TAIL_BYTES_MAX = 65536

/**
 * Parse and validate `?logTailBytes=N` from a `/diagnostics` request URL.
 * Returns the clamped positive integer, or `null` if the param is absent
 * or invalid (NaN, non-finite, zero, or negative). Callers fall back to
 * `buildDiagnosticsSnapshot`'s own default when `null` is returned, so
 * "no param" and "garbage param" behave identically — preserving the
 * pre-#3739 default behavior described in docs/troubleshooting.md.
 *
 * Values above the hard cap are clamped to `LOG_TAIL_BYTES_MAX` rather
 * than rejected, so an operator who asks for 1MB still gets a useful
 * 64KB response instead of an error.
 */
function parseLogTailBytes(url) {
  if (!url) return null
  const qIdx = url.indexOf('?')
  if (qIdx === -1) return null
  // Use `new URL` (already used elsewhere in this file for the dashboard
  // route) with a throwaway base, since URLSearchParams as a bare global
  // isn't in the server's ESLint env. We only need the searchParams view.
  let parsed
  try {
    parsed = new URL(url, 'http://_diag.local')
  } catch {
    return null
  }
  const raw = parsed.searchParams.get('logTailBytes')
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const int = Math.trunc(n)
  if (int <= 0) return null
  return Math.min(int, LOG_TAIL_BYTES_MAX)
}

/**
 * Resolve the `removeImage(tag)` callback for the snapshot DELETE route (#5074).
 *
 * Preference order:
 *   1. `server._snapshotRemoveImage` — test injection seam.
 *   2. `server.environmentManager._backend.removeImage` — already
 *      constructed for env-management. Reuses the same `_execFile`
 *      injection path the env tests rely on.
 *   3. A lazily-loaded fresh `DockerBackend()` — env management is
 *      disabled but a snapshot DELETE still needs to call `docker rmi`.
 *      Imported dynamically so tunnel-only installs that never trigger
 *      this code path don't pay the module load. Cached across calls
 *      (#5101) so batch cleanup doesn't re-run the dynamic `import()` and
 *      re-allocate a `DockerBackend` on every DELETE — the `docker rmi`
 *      shell-out still happens per call. The cache only covers this
 *      fallback — the test seam and the env-manager path both pre-empt it.
 */
let _snapshotBackendPromise = null

/** Reset the lazily-cached fallback DockerBackend init promise (#5101). Test-only. */
export function _resetSnapshotBackendCacheForTests() {
  _snapshotBackendPromise = null
}

export async function resolveRemoveImage(server) {
  if (typeof server._snapshotRemoveImage === 'function') {
    return server._snapshotRemoveImage
  }
  const fromEnvMgr = server.environmentManager?._backend?.removeImage
  if (typeof fromEnvMgr === 'function') {
    return (tag) => server.environmentManager._backend.removeImage(tag)
  }
  if (!_snapshotBackendPromise) {
    _snapshotBackendPromise = (async () => {
      const { DockerBackend } = await import('./environments/backends/docker.js')
      const backend = new DockerBackend()
      return (tag) => backend.removeImage(tag)
    })()
  }
  return _snapshotBackendPromise
}

/**
 * Check if an Origin header matches the allowed list.
 * Localhost origins with any port are allowed for dev.
 */
function matchAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.includes(origin)) return origin
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin
  return null
}

/**
 * Create an HTTP request handler for the WsServer.
 * Handles health, version, permission, connect, QR, assets, and dashboard routes.
 *
 * @param {object} server - WsServer instance (accessed at request time for current state)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 */
export function createHttpHandler(server) {
  // #5312 (WP-1.2) — the actual routing logic, wrapped below in a top-level
  // try/catch so an unguarded throw from any route (e.g. buildDiagnosticsSnapshot,
  // readConnectionInfo, or readFileSync(index)) returns 500 instead of rejecting
  // the handler promise → unhandledRejection → process.exit(1), which would take
  // down the whole daemon (every session) on a single bad request.
  const dispatch = async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      const isRestricted = req.url?.startsWith('/qr') || req.url?.startsWith('/connect') || req.url?.startsWith('/pairing-code') || req.url?.startsWith('/pair-discord')
      const corsOrigin = isRestricted
        ? matchAllowedOrigin(req.headers['origin'])
        : '*'
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      }
      if (corsOrigin) {
        headers['Access-Control-Allow-Origin'] = corsOrigin
        if (isRestricted) headers['Vary'] = 'Origin'
      }
      res.writeHead(204, headers)
      res.end()
      return
    }

    // Health check — Cloudflare and app verify connectivity via GET / and GET /health
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      const accept = req.headers['accept'] || ''
      if (req.url === '/' && accept.includes('text/html') && server.apiToken) {
        res.writeHead(302, {
          'Location': '/dashboard',
          'Cache-Control': 'no-store',
          'Vary': 'Accept',
        })
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Vary': 'Accept',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ status: 'ok', mode: server.serverMode, version: SERVER_VERSION }))
      return
    }

    // #5683 — Chroxy Pages: serve a published HTML artifact at an unguessable,
    // UNAUTHENTICATED URL (the slug is the capability). Static-only CSP headers
    // (PAGE_SECURITY_HEADERS) neutralize the cookie-auth risk. Placed in the
    // public section, before the authed routes, and only active when a pages
    // store is wired.
    {
      const pagesPath = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && pagesPath.startsWith('/p/') && server.pagesStore) {
        // Rate-limit BEFORE any filesystem work so the public route can't be
        // used to scan slugs or DoS the disk.
        const limiter = server._pagesRateLimiter
        if (limiter) {
          const socketIp = req.socket?.remoteAddress || ''
          const { allowed, retryAfterMs } = limiter.check(getRateLimitKey(socketIp, req))
          if (!allowed) {
            res.writeHead(429, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Retry-After': Math.ceil(retryAfterMs / 1000),
              ...PAGE_SECURITY_HEADERS,
            })
            res.end('rate limited')
            return
          }
        }

        const notFound = () => {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...PAGE_SECURITY_HEADERS })
          res.end('Not found')
        }

        const m = pagesPath.match(/^\/p\/([^/]+)(?:\/(.*))?$/)
        let slug = null
        let rel = ''
        if (m) {
          try {
            slug = decodeURIComponent(m[1])
            rel = m[2] != null ? decodeURIComponent(m[2]) : ''
          } catch {
            slug = null // malformed percent-encoding
          }
        }
        if (!slug || !isValidSlug(slug) || !server.pagesStore.get(slug)) {
          notFound()
          return
        }
        // Trailing-slash redirect (`/p/<slug>` → `/p/<slug>/`) so a page's
        // relative asset URLs resolve under its own directory.
        if (m[2] == null) {
          res.writeHead(301, { Location: `/p/${encodeURIComponent(slug)}/`, ...PAGE_SECURITY_HEADERS })
          res.end()
          return
        }
        const filePath = server.pagesStore.resolveFile(slug, rel)
        if (!filePath) {
          notFound()
          return
        }
        let body
        try {
          // Defence-in-depth: enforce the per-page size cap on SERVE too, not
          // just at publish time, so a file that somehow grew past the cap (a
          // future publish path, an external write) can't be read unbounded
          // into memory.
          if (statSync(filePath).size > server.pagesStore.maxPageBytes) {
            notFound()
            return
          }
          body = readFileSync(filePath)
        } catch {
          notFound()
          return
        }
        res.writeHead(200, {
          'Content-Type': mimeForPath(filePath),
          'Content-Length': body.byteLength,
          ...PAGE_SECURITY_HEADERS,
        })
        res.end(body)
        return
      }
    }

    // Version endpoint
    if (req.method === 'GET' && req.url === '/version') {
      if (!server._validateBearerAuth(req, res)) {
        log.warn('Rejected unauthenticated GET /version')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        version: SERVER_VERSION,
        latestVersion: server._latestVersion,
        gitCommit: server._gitInfo.commit,
        gitBranch: server._gitInfo.branch,
        uptime: Math.round((Date.now() - server._startedAt) / 1000),
      }))
      return
    }

    // #6822 — MCP OAuth redirect callback. The browser that completed consent
    // (on the user's own device) is redirected here with `?code=...&state=...`.
    // This route is intentionally UNAUTHENTICATED: the redirect carries no bearer
    // token, and the high-entropy `state` value (bound server-side to a specific
    // pending authorization) IS the capability. We hand the code to the matching
    // pending client, which redeems it + persists tokens. When the daemon isn't
    // reachable from the user's browser (remote/tunneled) this page never loads —
    // the user copy-pastes the code back over the wire instead (the universal
    // fallback). Never logs the code.
    const oauthCbPath = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && oauthCbPath === MCP_OAUTH_CALLBACK_PATH) {
      let code = null
      let state = null
      let oauthError = null
      try {
        const parsed = new URL(req.url, 'http://localhost')
        code = parsed.searchParams.get('code')
        state = parsed.searchParams.get('state')
        oauthError = parsed.searchParams.get('error')
      } catch { /* malformed url — handled as missing params below */ }

      const page = (title, body) =>
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a2332;line-height:1.5}` +
        `code{background:#eef1f6;padding:.15rem .35rem;border-radius:.25rem;word-break:break-all}h1{font-size:1.25rem}</style></head><body>${body}</body></html>`

      const sendPage = (status, title, body) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_SECURITY_HEADERS })
        res.end(page(title, body))
      }

      if (oauthError) {
        sendPage(400, 'Authorization failed',
          `<h1>Authorization was not completed</h1><p>The authorization server reported an error. You can close this tab and try authorizing again from Chroxy.</p>`)
        return
      }
      if (!code || !state) {
        sendPage(400, 'Authorization callback',
          `<h1>Missing authorization details</h1><p>This page expects a <code>code</code> and <code>state</code> from the authorization server. If you reached it manually, return to Chroxy and use the paste-code option.</p>`)
        return
      }

      resolveOAuthCallback(state, code)
        .then((outcome) => {
          if (outcome.found && outcome.ok) {
            sendPage(200, 'Authorized',
              `<h1>MCP server authorized</h1><p>You can close this tab and return to Chroxy — the server is reconnecting now.</p>`)
          } else if (outcome.found) {
            // The daemon received the callback but redemption failed. Surface the
            // code so the user can retry via paste (value shown only to the user
            // whose browser holds the redirect; never logged server-side).
            sendPage(200, 'Finish in Chroxy',
              `<h1>Almost there</h1><p>Automatic completion didn't succeed. Copy this authorization code and paste it into Chroxy:</p><p><code>${escapeHtml(code)}</code></p>`)
          } else {
            // No pending authorization matched this state (expired, wrong daemon,
            // or already completed). Offer the paste-code fallback.
            sendPage(200, 'Finish in Chroxy',
              `<h1>Finish in Chroxy</h1><p>Copy this authorization code and paste it into Chroxy to finish connecting:</p><p><code>${escapeHtml(code)}</code></p>`)
          }
        })
        .catch(() => {
          sendPage(200, 'Finish in Chroxy',
            `<h1>Finish in Chroxy</h1><p>Copy this authorization code and paste it into Chroxy to finish connecting:</p><p><code>${escapeHtml(code)}</code></p>`)
        })
      return
    }

    // Metrics endpoint — operational counters for monitoring
    if (req.method === 'GET' && req.url === '/metrics') {
      if (!server._validateBearerAuth(req, res)) return
      const mem = process.memoryUsage()
      const sessions = server.sessionManager?.listSessions() || []
      const payload = {
        uptime: Math.round((Date.now() - server._startedAt) / 1000),
        sessions: {
          active: sessions.length,
        },
        clients: {
          connected: server._clientManager?.clients?.size || 0,
          authenticated: server._clientManager?.authenticatedCount || 0,
        },
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
        process: {
          pid: process.pid,
          nodeVersion: process.version,
        },
        counters: metrics.snapshot(),
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }

    // Snapshot listing endpoint (#5074). Reads docker-byok snapshot
    // metadata sidecars from `${CHROXY_CONFIG_DIR ?? ~/.chroxy}/snapshots/`
    // and returns them as a newest-first array. The dashboard polls this
    // on its SnapshotsPanel.
    const snapPath = (req.url ?? '').split('?')[0]

    // External event ingest (#5413 Phase 3). Accepts ONLY the daemon-level
    // ingest secret (never the primary token — see
    // docs/security/bearer-token-authority.md §6); auth, body cap, schema
    // validation, per-source rate limiting, and the pipeline dispatch all
    // live in event-ingest.js. The handler registers its own body-stream
    // callbacks and guards them per the #5313 pattern.
    if (req.method === 'POST' && snapPath === '/api/events') {
      handleEventIngest(server, req, res)
      return
    }

    // Control Room repo-events feed (#5966): GitHub webhook deliveries. Auth is
    // the X-Hub-Signature-256 HMAC (NOT the ingest secret) — the handler verifies
    // it over the RAW body before parsing, and stays inert (503) until a secret
    // is configured. See github-webhook.js.
    if (req.method === 'POST' && snapPath === '/api/github/webhook') {
      handleGithubWebhook(server, req, res)
      return
    }

    // Mailbox live-interrupt (agent-comm-system delivery). Same daemon-level
    // ingest-secret auth as /api/events (never the primary token). The ping
    // route notifies + wakes a live idle claude-tui recipient; the register
    // route populates the agent-id -> session map. See mailbox-route.js.
    if (req.method === 'POST' && snapPath === '/api/mailbox') {
      handleMailboxPing(server, req, res)
      return
    }

    if (req.method === 'POST' && snapPath === '/api/mailbox/register') {
      handleMailboxRegister(server, req, res)
      return
    }

    if (req.method === 'GET' && snapPath === '/api/snapshots') {
      if (!server._validateBearerAuth(req, res)) return
      try {
        const snapshots = listSnapshots()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ snapshots }))
      } catch (err) {
        log.warn(`GET /api/snapshots failed: ${err.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to list snapshots' }))
      }
      return
    }

    // Snapshot delete endpoint (#5074). Two-step: docker rmi → unlink sidecar.
    // The slug is the sidecar filename without `.json`, exactly what
    // /api/snapshots returns, so the server never has to re-derive it
    // from the tag. Defence-in-depth: snapshots-store re-validates the
    // slug against the filename-safe charset before joining it to a path.
    //
    // Host-level mutation (removes a docker image + sidecar shared across all
    // sessions), so it requires PRIMARY authority — a bound (share-a-session)
    // token must not delete host snapshots. Mirrors the /api/pages DELETE gate.
    // The GET list above stays on _validateBearerAuth (reads are open). (#5074 / audit P1-6)
    if (req.method === 'DELETE' && snapPath.startsWith('/api/snapshots/')) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const rawSlug = snapPath.slice('/api/snapshots/'.length)
      let slug
      try {
        slug = decodeURIComponent(rawSlug)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid slug encoding' }))
        return
      }
      try {
        const removeImage = await resolveRemoveImage(server)
        const result = await deleteSnapshot(slug, { removeImage })
        if (!result.ok) {
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: result.error }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          tag: result.tag,
          imageRemoved: result.imageRemoved,
        }))
      } catch (err) {
        log.warn(`DELETE /api/snapshots/${slug} failed: ${err.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to delete snapshot' }))
      }
      return
    }

    // Paired-devices roster + live revoke (#6678, part of epic #6597). The
    // dashboard "Paired devices" panel lists the RUNNING daemon's paired
    // session tokens (wire-safe ids, bound session, age — never token material)
    // and revokes them live: unlike `chroxy tokens revoke` (which edits the
    // persisted store and needs a daemon restart), these hit PairingManager's
    // in-memory map so the device's next auth fails immediately.
    //
    // PRIMARY-token only on ALL THREE. The roster is host-level pairing state —
    // a scoped/paired device must neither enumerate its siblings (information
    // disclosure) nor revoke them (a host-level mutation beyond one session's
    // scope). Mirrors the DELETE /api/snapshots gate; see
    // docs/security/bearer-token-authority.md §9.
    if (req.method === 'GET' && snapPath === '/api/paired-devices') {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const pm = server._pairingManager
      const devices = pm && typeof pm.listSessionTokens === 'function' ? pm.listSessionTokens() : []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ devices }))
      return
    }

    // Revoke ALL paired devices — the panic button. Exact-path match (no id), so
    // it never collides with the per-device DELETE below.
    if (req.method === 'DELETE' && snapPath === '/api/paired-devices') {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const pm = server._pairingManager
      const revoked = pm && typeof pm.revokeAllSessionTokens === 'function' ? pm.revokeAllSessionTokens() : 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, revoked }))
      return
    }

    // Revoke ONE paired device by its wire id (from GET /api/paired-devices).
    if (req.method === 'DELETE' && snapPath.startsWith('/api/paired-devices/')) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const rawId = snapPath.slice('/api/paired-devices/'.length)
      let id
      try {
        id = decodeURIComponent(rawId)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid id encoding' }))
        return
      }
      const pm = server._pairingManager
      const revoked = pm && typeof pm.revokeSessionTokenById === 'function' ? pm.revokeSessionTokenById(id) : 0
      if (revoked === 0) {
        // The device is already gone (revoked elsewhere, expired, or a stale id
        // from a device that re-paired). 404 so the UI can reconcile its list.
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no such paired device', revoked: 0 }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, revoked }))
      return
    }

    // docker-byok pool stats endpoint (#5053). Returns a rolling
    // observability snapshot — hit/miss counters, hit rate,
    // eviction-by-reason, the recent-evictions tail, and the live per-key
    // parked buckets from pool.inspect(). Bearer-auth gated like every other
    // /api route (primary token = full host authority; see
    // docs/security/bearer-token-authority.md — this is read-only operational
    // telemetry, no narrower scope needed).
    //
    // The pool is default-OFF (CHROXY_DOCKER_BYOK_POOL=1 to enable). When
    // disabled we return a stable `{ enabled: false }` shape (still authed)
    // so the dashboard can hide the panel without special-casing a 404.
    //
    // Test seams: `server._poolStatsEnabled` / `server._poolStats` override
    // the env probe + aggregator so http-routes tests don't depend on
    // process.env or a live pool.
    // #5683 (PR-2) — Chroxy Pages publish/manage API. PRIMARY-token only: each
    // call writes to the host disk and mints a PUBLIC capability URL, so it is
    // host-authority (a bound/pairing token is rejected with primary_token_required,
    // matching the other host-write routes — see bearer-token-authority.md §4).
    if (req.method === 'POST' && snapPath === '/api/pages' && server.pagesStore) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      // Body cap a little above the per-page byte cap to allow JSON overhead.
      const maxBody = server.pagesStore.maxPageBytes + 1024 * 1024
      readJsonBodyCapped(req, res, maxBody)
        .then((parsed) => {
          if (parsed === null) return // 413/400 already sent
          const title = typeof parsed.title === 'string' ? parsed.title : 'Untitled'
          // Accept either { html } (single self-contained page) or
          // { files: [{ path, content }] } (multi-file). `html` is shorthand.
          let files
          if (typeof parsed.html === 'string') {
            files = [{ path: 'index.html', content: parsed.html }]
          } else if (Array.isArray(parsed.files)) {
            // Validate every entry instead of coercing a non-string `content` to
            // '' — silent coercion turns an invalid client payload into a
            // successfully published but empty/garbled page.
            const invalid = parsed.files.find((f) => !f || typeof f.path !== 'string' || typeof f.content !== 'string')
            if (invalid !== undefined) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'each `files` entry requires a string `path` and string `content`' }))
              return
            }
            files = parsed.files.map((f) => ({ path: f.path, content: f.content }))
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'body must include `html` (string) or `files` (array)' }))
            return
          }
          let meta
          try {
            meta = server.pagesStore.publish({ title, files })
          } catch (err) {
            // publish() throws for BOTH client validation errors (plain Errors —
            // bad paths, missing index.html, size/count caps) AND server-side I/O
            // faults (which carry an errno `code` like EACCES/ENOSPC). Don't
            // misreport an I/O fault as a 400, and don't leak fs detail in it.
            if (err && typeof err.code === 'string') {
              log.warn(`POST /api/pages publish I/O error: ${err.code} ${err?.message || ''}`)
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'publish failed' }))
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: err?.message || 'publish failed' }))
            }
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ slug: meta.slug, path: `/p/${meta.slug}/`, title: meta.title, bytes: meta.bytes, createdAt: meta.createdAt }))
        })
        .catch((err) => {
          log.warn(`POST /api/pages failed: ${err?.message || err}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'publish failed' }))
          }
        })
      return
    }

    if (req.method === 'GET' && snapPath === '/api/pages' && server.pagesStore) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const pages = server.pagesStore.list().map((p) => ({
        slug: p.slug, title: p.title, createdAt: p.createdAt, bytes: p.bytes, path: `/p/${p.slug}/`,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ pages }))
      return
    }

    if (req.method === 'DELETE' && snapPath.startsWith('/api/pages/') && server.pagesStore) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      let slug
      try {
        slug = decodeURIComponent(snapPath.slice('/api/pages/'.length))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid slug' }))
        return
      }
      // Idempotent: deleting an absent slug returns 200 { removed: false }
      // rather than 404, so `chroxy pages rm` of an already-gone page reports
      // cleanly instead of failing.
      const removed = server.pagesStore.remove(slug)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ removed }))
      return
    }

    if (req.method === 'GET' && snapPath === '/api/pool/stats') {
      if (!server._validateBearerAuth(req, res)) return
      const enabled = typeof server._poolStatsEnabled === 'boolean'
        ? server._poolStatsEnabled
        : isPoolEnabled(process.env)
      if (!enabled) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ enabled: false }))
        return
      }
      try {
        const aggregator = server._poolStats ?? getSharedPoolStats()
        const stats = aggregator.snapshot()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ enabled: true, ...stats }))
      } catch (err) {
        log.warn(`GET /api/pool/stats failed: ${err.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to read pool stats' }))
      }
      return
    }

    // Diagnostics endpoint — runtime snapshot for triaging stuck sessions (#3732).
    // Returns server state, per-session busy/pending/timeout-pause flags, and
    // a tail of the on-disk log (#3731). Bearer-auth gated; sensitive content
    // (tool inputs) is omitted, only `tool` + `description` surface.
    //
    // #3734 review (Copilot): exact pathname match (allowing query string).
    // The earlier startsWith('/diagnostics') would have shadowed any future
    // `/diagnostics-foo` route — accidental aliasing is a real risk in a
    // codebase that adds endpoints regularly.
    const diagPathname = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && diagPathname === '/diagnostics') {
      // #3737: per-IP rate limit. Check BEFORE auth so a stolen token can't
      // DoS the endpoint, and so an unauthenticated flood doesn't get a free
      // pass to the auth code path. Uses getRateLimitKey so forwarded
      // headers (CF-Connecting-IP / X-Forwarded-For) are trusted only when
      // the TCP peer is loopback — i.e. the request came through the local
      // cloudflared process. Direct connections use the socket address so
      // header spoofing cannot exhaust another IP's bucket.
      const limiter = server._diagnosticsRateLimiter
      if (limiter) {
        const socketIp = req.socket?.remoteAddress || ''
        const rateLimitKey = getRateLimitKey(socketIp, req)
        const { allowed, retryAfterMs } = limiter.check(rateLimitKey)
        if (!allowed) {
          log.warn(`Rate limited GET /diagnostics from ${rateLimitKey}`)
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': Math.ceil(retryAfterMs / 1000),
          })
          res.end(JSON.stringify({ error: 'rate limited', retryAfterMs }))
          return
        }
      }
      if (!server._validateBearerAuth(req, res)) return
      // #3739: optional `?logTailBytes=N` lets operators widen the log
      // window (e.g. to 32KB for a slow stall) or shrink it for a tight
      // repro. Default falls through to buildDiagnosticsSnapshot's own
      // default (8192). Hard-clamp at LOG_TAIL_BYTES_MAX so a stolen
      // token can't slurp megabytes of log into memory per request.
      const diagOpts = { server, serverVersion: SERVER_VERSION }
      const logTailBytes = parseLogTailBytes(req.url)
      if (logTailBytes !== null) diagOpts.logTailBytes = logTailBytes
      const snapshot = buildDiagnosticsSnapshot(diagOpts)
      const accept = req.headers['accept'] || ''
      if (accept.includes('text/plain')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(formatDiagnosticsText(snapshot))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(snapshot, null, 2))
      return
    }

    // Permission hook endpoint
    if (req.method === 'POST' && req.url === '/permission') {
      server._permissions.handlePermissionRequest(req, res)
      return
    }

    // Permission response endpoint (HTTP fallback)
    if (req.method === 'POST' && req.url === '/permission-response') {
      server._permissions.handlePermissionResponseHttp(req, res)
      return
    }

    // Connection info endpoint.
    //
    // Gated on the PRIMARY token class (#5533 sibling audit): when auth is
    // required (the normal case), the response body carries the raw PRIMARY
    // apiToken and a connectionUrl that embeds it (see startup-display.js →
    // writeConnectionInfo). Accepting a pairing-bound session token here would
    // hand a once-paired, session-scoped device the full primary token — a
    // strict privilege escalation, worse than the /qr + /pairing-code leak.
    // The redaction branch below only fires when auth is DISABLED, so it cannot
    // be relied on as the boundary. The dashboard's ConsolePage / tunnel-ready
    // probe both fetch /connect with the primary token, so they keep working.
    if (req.method === 'GET' && req.url === '/connect') {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const connInfo = readConnectionInfo()
      if (!connInfo) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No connection info available' }))
        return
      }
      if (!server.authRequired) {
        if (connInfo.apiToken) connInfo.apiToken = '[REDACTED]'
        delete connInfo.connectionUrl
      }
      const connectCors = matchAllowedOrigin(req.headers['origin'])
      // no-store: the body carries the raw primary apiToken (and a connectionUrl
      // embedding it) when auth is required, so browsers/proxies must not cache
      // it — mirrors /pairing-code, which is also live credential material.
      const connectHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      if (connectCors) {
        connectHeaders['Access-Control-Allow-Origin'] = connectCors
        connectHeaders['Vary'] = 'Origin'
      }
      res.writeHead(200, connectHeaders)
      res.end(JSON.stringify(connInfo))
      return
    }

    // Typeable pairing-code endpoint (#5512): GET /pairing-code returns the
    // current linking-mode pairing code as JSON so the dashboard/CLI can DISPLAY
    // it beside the QR (the QR encodes the same id — one mechanism). Grace-
    // extension mirrors /qr; camera-less devices enter this code by hand.
    //
    // Gated on the PRIMARY token class (#5533): the displayed code is live
    // pairing material — anyone who can read it can onboard a new peer. A
    // pairing-bound session token is scoped to one session, NOT host-level, so
    // letting it read the current code would let a once-paired device
    // transitively mint further peers. The daemon's own dashboard and
    // `chroxy pair-code` both present the primary token, so the display path is
    // unaffected; only the escalation path closes.
    if (req.method === 'GET' && req.url?.split('?')[0] === '/pairing-code') {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const codeCors = matchAllowedOrigin(req.headers['origin'])
      const codeHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      if (codeCors) {
        codeHeaders['Access-Control-Allow-Origin'] = codeCors
        codeHeaders['Vary'] = 'Origin'
      }
      if (!server._pairingManager) {
        res.writeHead(503, codeHeaders)
        res.end(JSON.stringify({ error: 'Pairing not available' }))
        return
      }
      // Someone is actively viewing the code — extend the grace period so it
      // survives long enough to be typed on the other device (mirrors /qr).
      server._pairingManager.extendCurrentId()
      const snap = server._pairingManager.currentPairingCode
      if (!snap) {
        res.writeHead(503, codeHeaders)
        res.end(JSON.stringify({ error: 'Pairing code not available yet' }))
        return
      }
      const expiresInMs = Math.max(0, snap.expiresAtMs - Date.now())
      res.writeHead(200, codeHeaders)
      res.end(JSON.stringify({
        code: snap.code,
        url: snap.url,
        // #5536 — the daemon's pinned E2E identity public key. Absent (null)
        // when encryption is disabled or the daemon predates pinning.
        identityPublicKey: snap.identityPublicKey ?? null,
        expiresAtMs: snap.expiresAtMs,
        expiresInSeconds: Math.ceil(expiresInMs / 1000),
      }))
      return
    }

    // Discord pairing-link delivery (#5513, epic #5509): POST /pair-discord
    // generates a FRESH approval-gated pairing id and posts its chroxy:// link
    // to the configured Discord webhook. Host-triggered only (CLI / dashboard
    // button). The gated id mints no token on redemption — the host must still
    // approve (#5510) — so possession of the channel grants nothing.
    //
    // Gated on the PRIMARY token class from day one (#5533): posting a fresh
    // pairing link is a host-authority action, so a pairing-bound session token
    // (which is scoped, not host-level) is rejected. Mirrors /pairing-code's
    // CORS, but uses _validatePrimaryBearerAuth instead of _validateBearerAuth.
    if (req.method === 'POST' && req.url?.split('?')[0] === '/pair-discord') {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const pdCors = matchAllowedOrigin(req.headers['origin'])
      const pdHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      if (pdCors) {
        pdHeaders['Access-Control-Allow-Origin'] = pdCors
        pdHeaders['Vary'] = 'Origin'
      }
      if (!server._pairingManager) {
        res.writeHead(503, pdHeaders)
        res.end(JSON.stringify({ error: 'Pairing not available' }))
        return
      }
      // Fresh gated id per trigger (60s TTL, single-use). The chroxy:// link is
      // the only material posted — no token.
      const gated = server._pairingManager.createApprovalGatedPairingId()
      if (!gated?.pairingUrl) {
        res.writeHead(503, pdHeaders)
        res.end(JSON.stringify({ error: 'Pairing link not available — server has no public URL yet' }))
        return
      }
      const expiresInSeconds = Number.isFinite(gated.expiresAt)
        ? Math.max(0, Math.ceil((gated.expiresAt - Date.now()) / 1000))
        : 60
      const result = await server._postPairLinkToDiscord({ url: gated.pairingUrl, expiresInSeconds })
      if (result?.posted) {
        res.writeHead(200, pdHeaders)
        res.end(JSON.stringify({ posted: true, expiresInSeconds: result.expiresInSeconds ?? expiresInSeconds }))
        return
      }
      // not_configured → 409 (no webhook set); anything else → 502 (post failed).
      // The webhook URL / token never appears in the response — postPairLinkToDiscord
      // returns only a fixed reason code.
      const status = result?.reason === 'not_configured' ? 409 : 502
      res.writeHead(status, pdHeaders)
      res.end(JSON.stringify({ posted: false, reason: result?.reason || 'post_failed' }))
      return
    }

    // Per-session QR endpoint (#3070): GET /qr/session/:sessionId returns a
    // QR whose pairing URL issues a session-bound token. The scanner can chat
    // into that one session but cannot list/switch/destroy others. Must be
    // matched BEFORE the generic /qr handler since both share the prefix.
    //
    // Gated on the PRIMARY token class (#5533): generating a share QR MINTS a
    // fresh bound pairing id (live pairing material). Letting a pairing-bound
    // token reach this would let a once-paired device transitively mint peers
    // for its session — the same escalation the linking /qr and /pairing-code
    // close. The "Share this session" dashboard button runs on the daemon's own
    // dashboard with the primary token, so the legitimate path is unaffected.
    if (req.method === 'GET' && req.url?.startsWith('/qr/session/')) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const shareCors = matchAllowedOrigin(req.headers['origin'])
      const sharePathParts = req.url.split('?')[0].split('/').filter(Boolean) // ['qr','session','<id>']
      const writeShareErr = (status, body) => {
        const headers = { 'Content-Type': 'application/json' }
        if (shareCors) {
          headers['Access-Control-Allow-Origin'] = shareCors
          headers['Vary'] = 'Origin'
        }
        res.writeHead(status, headers)
        res.end(JSON.stringify(body))
      }
      // decodeURIComponent throws URIError on malformed percent-encoding
      // (e.g. /qr/session/%E0%A4). Without a guard the throw surfaces as an
      // unhandled rejection in this async handler. Return 400 instead.
      let sessionId = null
      if (sharePathParts[2]) {
        try {
          sessionId = decodeURIComponent(sharePathParts[2])
        } catch {
          writeShareErr(400, { error: 'Invalid sessionId encoding' })
          return
        }
      }
      if (!sessionId) {
        writeShareErr(400, { error: 'sessionId required' })
        return
      }
      // Server-side existence check — fail-fast if the session is gone, so
      // the scanner doesn't get a doomed token.
      const sessionExists = server.sessionManager
        ? !!server.sessionManager.getSession?.(sessionId)
        : true // fall through if session manager isn't wired (test contexts)
      if (!sessionExists) {
        writeShareErr(404, { error: 'Session not found' })
        return
      }
      if (!server._pairingManager) {
        writeShareErr(503, { error: 'Pairing not available' })
        return
      }
      let bound
      try {
        bound = server._pairingManager.generateBoundPairing(sessionId)
      } catch (err) {
        writeShareErr(500, { error: err?.message || 'Failed to generate share pairing' })
        return
      }
      if (!bound.pairingUrl) {
        writeShareErr(503, { error: 'Tunnel URL not yet available' })
        return
      }
      try {
        const svg = await QRCode.toString(bound.pairingUrl, {
          type: 'svg',
          color: { dark: '#e0e0e0', light: '#00000000' },
          margin: 1,
        })
        const headers = {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store',
        }
        if (shareCors) {
          headers['Access-Control-Allow-Origin'] = shareCors
          headers['Vary'] = 'Origin'
        }
        res.writeHead(200, headers)
        res.end(svg)
      } catch (_err) {
        writeShareErr(500, { error: 'Failed to generate QR code' })
      }
      return
    }

    // QR code endpoint — uses live pairing URL (not stale file) when available.
    //
    // Gated on the PRIMARY token class (#5533): the linking QR encodes a live
    // pairing URL — scanning it onboards a new peer. A pairing-bound session
    // token is scoped to one session, not host-level, so it must not be able to
    // read the current QR and transitively mint further peers. The daemon's own
    // dashboard fetches /qr with the primary token, so the modal keeps working;
    // only the escalation path closes.
    if (req.method === 'GET' && req.url?.startsWith('/qr')) {
      if (!server._validatePrimaryBearerAuth(req, res)) return
      const qrCors = matchAllowedOrigin(req.headers['origin'])

      // Prefer live pairing URL from PairingManager (always current).
      // Extend the grace period since someone is actively viewing the QR.
      if (server._pairingManager) server._pairingManager.extendCurrentId()
      let qrData = server._pairingManager?.currentPairingUrl
      if (!qrData) {
        // Fall back to connection info file
        const connInfo = readConnectionInfo()
        qrData = connInfo?.connectionUrl
      }
      if (!qrData) {
        const errHeaders = { 'Content-Type': 'application/json' }
        if (qrCors) {
          errHeaders['Access-Control-Allow-Origin'] = qrCors
          errHeaders['Vary'] = 'Origin'
        }
        res.writeHead(503, errHeaders)
        res.end(JSON.stringify({ error: 'Connection info not available yet' }))
        return
      }
      try {
        const svg = await QRCode.toString(qrData, {
          type: 'svg',
          color: { dark: '#e0e0e0', light: '#00000000' },
          margin: 1,
        })
        const qrHeaders = {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store',
        }
        if (qrCors) {
          qrHeaders['Access-Control-Allow-Origin'] = qrCors
          qrHeaders['Vary'] = 'Origin'
        }
        res.writeHead(200, qrHeaders)
        res.end(svg)
      } catch (_err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to generate QR code' }))
      }
      return
    }

    // Static assets (xterm.js, etc.)
    if (req.method === 'GET' && req.url?.startsWith('/assets/')) {
      const readModule = (pkg, file) => {
        const paths = [
          join(__dirname, '../node_modules', pkg, file),
          join(__dirname, '../../../node_modules', pkg, file),
        ]
        for (const p of paths) {
          try { return readFileSync(p) } catch {}
        }
        return null
      }
      const assetMap = {
        '/assets/xterm/xterm.js': { read: () => readModule('@xterm/xterm', 'lib/xterm.js'), type: 'application/javascript' },
        '/assets/xterm/xterm.css': { read: () => readModule('@xterm/xterm', 'css/xterm.css'), type: 'text/css' },
        '/assets/xterm/addon-fit.js': { read: () => readModule('@xterm/addon-fit', 'lib/addon-fit.js'), type: 'application/javascript' },
      }
      const assetPath = req.url.split('?')[0]
      const asset = assetMap[assetPath]
      if (asset) {
        try {
          const content = asset.read()
          if (!content) throw new Error('Module not found')
          res.writeHead(200, {
            'Content-Type': asset.type,
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end(content)
        } catch (_e) {
          res.writeHead(404)
          res.end('Asset not found')
        }
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
      return
    }

    // Dashboard (React app built by Vite)
    if (req.method === 'GET' && /^\/dashboard(\/|$|\?)/.test(req.url || '')) {
      const dashUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

      const securityHeaders = {
        // connect-src allows http:/https: alongside ws:/wss: so the dashboard
        // can reach a REMOTE LAN daemon — both its pre-WS HTTP health-check
        // (connection.ts) and the WebSocket itself. This unlocks the desktop
        // acting as a LAN client + joining a shared session on another host.
        //
        // Why a wide connect-src is safe here:
        //  - ws:/wss: were already scheme-open (any host), so adding http:/https:
        //    is symmetric — no NEW reachable hosts beyond what WebSocket allowed.
        //  - script-src stays 'self' (no inline/eval), so injected content can't
        //    run a fetch() to abuse connect-src in the first place.
        //  - The directives that actually gate *passive* exfil — img-src,
        //    font-src, form-action, and the default-src fallback — all stay
        //    'self'-scoped (img-src also data:), so a widened connect-src opens
        //    no CSS/beacon/form exfil channel. Keep them 'self' if connect-src
        //    is broad. (This CSP also ships on the tunnel-exposed dashboard, not
        //    just the desktop's local view — acceptable in chroxy's single-
        //    tenant model; see #5281 for the decision record.)
        //  - The narrower 127.0.0.1/localhost http sources are subsumed by http:.
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      }

      // Workspace layout: packages/dashboard/dist (dev)
      // Tauri bundle layout: server/src/dashboard-next/dist (bundled)
      const workspaceDist = join(__dirname, '..', '..', 'dashboard', 'dist')
      const bundleDist = join(__dirname, 'dashboard-next', 'dist')
      const distDir = existsSync(workspaceDist) ? workspaceDist : bundleDist
      if (!existsSync(distDir) && !createHttpHandler._distMissWarned) {
        createHttpHandler._distMissWarned = true
        log.warn(`Dashboard dist directory not found: ${distDir} — run "npm run build -w @chroxy/dashboard"`)
      }
      const relPath = dashUrl.pathname.replace(/^\/dashboard\/?/, '') || 'index.html'

      // Serve static assets WITHOUT auth — hashed filenames from Vite build
      if (relPath.startsWith('assets/')) {
        const filePath = resolve(distDir, relPath)
        const assetRel = relative(distDir, filePath)
        // isAbsolute catches the Windows different-drive escape: path.relative across
        // drives (C:\dist -> D:\evil) returns an absolute path that has no leading '..'.
        if (isAbsolute(assetRel) || assetRel.startsWith('..') || assetRel === '' || assetRel.includes(`..${sep}`)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }
        if (existsSync(filePath)) {
          const ext = relPath.split('.').pop()
          const mimeTypes = { js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' }
          try {
            const content = readFileSync(filePath)
            res.writeHead(200, {
              'Content-Type': mimeTypes[ext] || 'application/octet-stream',
              'Cache-Control': 'public, max-age=31536000, immutable',
              'X-Content-Type-Options': 'nosniff',
            })
            res.end(content)
          } catch {
            res.writeHead(500)
            res.end('Internal server error')
          }
          return
        }
        res.writeHead(404)
        res.end('Asset not found')
        return
      }

      // Auth required for HTML pages
      if (!server._authenticateDashboardRequest(req, res, dashUrl, securityHeaders)) return

      // SPA fallback — serve index.html with config injection
      const indexPath = join(distDir, 'index.html')
      if (existsSync(indexPath)) {
        let html = readFileSync(indexPath, 'utf-8')
        const escaped = JSON.stringify({port: server.port, noEncrypt: !server._encryptionEnabled}).replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const configMeta = `<meta name="chroxy-config" content='${escaped}'>`
        html = html.replace('</head>', `${configMeta}\n</head>`)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...securityHeaders,
        })
        res.end(html)
      } else {
        res.writeHead(404)
        res.end('Dashboard not built. Run: npm run build -w @chroxy/dashboard')
      }
      return
    }

    // Fallback 404
    res.writeHead(404)
    res.end()
  }

  // #5312 (WP-1.2) — top-level guard. Any throw/rejection escaping dispatch()
  // becomes a 500, never an unhandledRejection that crashes the daemon. Headers
  // may already be sent (a route threw mid-response); only write 500 if not.
  return async (req, res) => {
    try {
      await dispatch(req, res)
    } catch (err) {
      // #5312 review — log the PATH only, never the raw req.url: query strings on
      // dashboard/connect routes carry the API token (?token=...) which must not
      // leak into server logs.
      const pathOnly = (req.url || '').split('?')[0]
      log.error(`Unhandled error in HTTP handler (${req.method} ${pathOnly}): ${err?.stack || err}`)
      if (!res.headersSent) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        } catch { /* response already torn down */ }
      } else {
        try { res.end() } catch { /* already ended */ }
      }
    }
  }
}
