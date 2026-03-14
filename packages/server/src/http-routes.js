import { readFileSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import QRCode from 'qrcode'
import { readConnectionInfo } from './connection-info.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version

const ALLOWED_ORIGINS = [
  'tauri://localhost',
  'https://tauri.localhost',
]

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
        console.warn('[ws] Rejected unauthenticated GET /version')
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
      const metrics = {
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
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(metrics))
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

    // QR code endpoint — uses live pairing URL (not stale file) when available
    if (req.method === 'GET' && req.url?.startsWith('/qr')) {
      if (!server._validateBearerAuth(req, res)) return
      const qrCors = matchAllowedOrigin(req.headers['origin'])

      // Prefer live pairing URL from PairingManager (always current)
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

    // Redirect legacy /dashboard-next URLs to /dashboard
    if (req.method === 'GET' && /^\/dashboard-next(\/|$|\?)/.test(req.url || '')) {
      const redirectUrl = req.url.replace('/dashboard-next', '/dashboard')
      res.writeHead(301, { 'Location': redirectUrl, 'Cache-Control': 'no-store' })
      res.end()
      return
    }

    // Dashboard (React app built by Vite)
    if (req.method === 'GET' && /^\/dashboard(\/|$|\?)/.test(req.url || '')) {
      const dashUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

      const securityHeaders = {
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:*; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
      }

      const distDir = join(__dirname, 'dashboard-next', 'dist')
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
        const configMeta = `<meta name="chroxy-config" content='${JSON.stringify({port: server.port, noEncrypt: !server._encryptionEnabled})}'>`
        html = html.replace('</head>', `${configMeta}\n</head>`)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...securityHeaders,
        })
        res.end(html)
      } else {
        res.writeHead(404)
        res.end('Dashboard not built. Run: npm run dashboard:build')
      }
      return
    }

    // Fallback 404
    res.writeHead(404)
    res.end()
  }
}
