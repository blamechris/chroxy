import { readFileSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import QRCode from 'qrcode'
import { readConnectionInfo } from './connection-info.js'
import { createLogger } from './logger.js'
import { metrics } from './metrics.js'
import { buildDiagnosticsSnapshot } from './diagnostics.js'
import { getRateLimitKey } from './rate-limiter.js'
import { listSnapshots, deleteSnapshot } from './snapshots-store.js'
import { isPoolEnabled } from './docker-byok-pool.js'
import { getSharedPoolStats } from './docker-byok-pool-stats.js'

const log = createLogger('ws')

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
  return async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      const isRestricted = req.url?.startsWith('/qr') || req.url?.startsWith('/connect')
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
    if (req.method === 'DELETE' && snapPath.startsWith('/api/snapshots/')) {
      if (!server._validateBearerAuth(req, res)) return
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

    // Connection info endpoint
    if (req.method === 'GET' && req.url === '/connect') {
      if (!server._validateBearerAuth(req, res)) return
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
      const connectHeaders = { 'Content-Type': 'application/json' }
      if (connectCors) {
        connectHeaders['Access-Control-Allow-Origin'] = connectCors
        connectHeaders['Vary'] = 'Origin'
      }
      res.writeHead(200, connectHeaders)
      res.end(JSON.stringify(connInfo))
      return
    }

    // Per-session QR endpoint (#3070): GET /qr/session/:sessionId returns a
    // QR whose pairing URL issues a session-bound token. The scanner can chat
    // into that one session but cannot list/switch/destroy others. Must be
    // matched BEFORE the generic /qr handler since both share the prefix.
    if (req.method === 'GET' && req.url?.startsWith('/qr/session/')) {
      if (!server._validateBearerAuth(req, res)) return
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

    // QR code endpoint — uses live pairing URL (not stale file) when available
    if (req.method === 'GET' && req.url?.startsWith('/qr')) {
      if (!server._validateBearerAuth(req, res)) return
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
        if (!filePath.startsWith(distDir + '/')) {
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
}
