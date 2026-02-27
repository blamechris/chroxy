import { createServer } from 'http'
import { execFileSync } from 'child_process'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { toShortModelId, getModels } from './models.js'
import { createKeyPair, deriveSharedKey, encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT, safeTokenCompare } from './crypto.js'
import { ClientMessageSchema, AuthSchema, KeyExchangeSchema, EncryptedEnvelopeSchema } from './ws-schemas.js'
import { EventNormalizer } from './event-normalizer.js'
import { readConnectionInfo } from './connection-info.js'
import { createFileOps } from './ws-file-ops.js'
import { createPermissionHandler } from './ws-permissions.js'
import { setupForwarding } from './ws-forwarding.js'
import { handleSessionMessage, handleCliMessage, PERMISSION_MODES } from './ws-message-handlers.js'
import { getDashboardHtml } from './dashboard.js'
import QRCode from 'qrcode'
import { CheckpointManager } from './checkpoint-manager.js'
import { DevPreviewManager } from './dev-preview.js'
import { WebTaskManager } from './web-task-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version

/** Protocol version — bumped when the WS message set changes */
export const SERVER_PROTOCOL_VERSION = 1

/** Cached latest version from npm registry (null if unavailable) */
let _latestVersionCache = { version: null, checkedAt: 0 }
const VERSION_CHECK_TTL = 3600_000 // 1 hour

async function checkLatestVersion(packageName) {
  const now = Date.now()
  if (_latestVersionCache.checkedAt > 0 && (now - _latestVersionCache.checkedAt) < VERSION_CHECK_TTL) {
    return _latestVersionCache.version
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      })
      clearTimeout(timeout)
      if (res.ok) {
        const data = await res.json()
        if (data.version) {
          _latestVersionCache = { version: data.version, checkedAt: now }
          return data.version
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // npm registry unreachable or package not published — expected
  }
  _latestVersionCache = { version: null, checkedAt: now }
  return null
}

function getGitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    return { commit, branch }
  } catch {
    return { commit: 'unknown', branch: 'unknown' }
  }
}

/**
 * WebSocket server that bridges the phone client to the backend.
 *
 * Supports two modes:
 *   - Multi-session (sessionManager): multiple concurrent CliSession instances
 *   - Single CLI (cliSession): headless `claude -p` with structured JSON (legacy)
 *
 * Protocol (JSON messages over WebSocket):
 *
 * Client -> Server:
 *   { type: 'auth',      token: '...', deviceInfo? }   — authenticate (deviceInfo: { deviceId, deviceName, deviceType, platform })
 *   { type: 'input',     data: '...' }               — send text to active session
 *   { type: 'interrupt' }                             — interrupt active session
 *   { type: 'set_model', model: '...' }              — change model on active session
 *   { type: 'set_permission_mode', mode: '...', confirmed? } — change permission mode (confirmed: true required for 'auto')
 *   { type: 'permission_response', requestId, decision } — respond to permission prompt
 *   { type: 'list_sessions' }                         — request session list
 *   { type: 'switch_session', sessionId }             — switch to a different session
 *   { type: 'create_session', name?, cwd? }           — create a new session
 *   { type: 'destroy_session', sessionId }            — destroy a session
 *   { type: 'rename_session', sessionId, name }       — rename a session
 *   { type: 'register_push_token', token }             — register Expo push token for notifications
 *   { type: 'user_question_response', answer }         — respond to AskUserQuestion prompt
 *   { type: 'list_directory', path? }                  — request directory listing for file browser
 *   { type: 'browse_files', path? }                   — request file/directory listing for file browser
 *   { type: 'read_file', path }                       — request file content for file viewer
 *   { type: 'list_slash_commands' }                     — request available slash commands
 *   { type: 'list_agents' }                             — request available custom agents
 *   { type: 'request_full_history', sessionId? }         — request full JSONL history for a session
 *   { type: 'key_exchange', publicKey }                  — client's ephemeral X25519 public key (E2E encryption)
 *   { type: 'create_checkpoint', name?, description? }  — create a checkpoint for active session
 *   { type: 'list_checkpoints' }                         — request checkpoint list for active session
 *   { type: 'restore_checkpoint', checkpointId }         — rewind to a checkpoint (creates new session)
 *   { type: 'delete_checkpoint', checkpointId }          — delete a checkpoint
 *   { type: 'close_dev_preview', port, sessionId? }     — close a dev server preview tunnel
 *   { type: 'launch_web_task', prompt, cwd? }           — launch a Claude Code Web cloud task
 *   { type: 'list_web_tasks' }                          — request list of web tasks
 *   { type: 'teleport_web_task', taskId }               — pull cloud task into local session
 *   { type: 'ping' }                                    — client heartbeat (server responds with pong)
 *
 * Server -> Client:
 *   All session-scoped messages include a `sessionId` field for background sync.
 *   { type: 'auth_ok', clientId, serverMode, serverVersion, latestVersion, serverCommit, cwd, connectedClients, encryption } — auth succeeded (encryption: 'required'|'disabled')
 *   { type: 'key_exchange_ok', publicKey }               — server's ephemeral X25519 public key (E2E encryption)
 *   { type: 'auth_fail',    reason: '...' }           — auth failed
 *   { type: 'server_mode',  mode: 'cli' }             — which backend mode is active
 *   { type: 'message',      ... }                     — parsed chat message
 *   { type: 'stream_start', messageId: '...' }        — beginning of streaming response
 *   { type: 'stream_delta', messageId, delta }         — token-by-token text
 *   { type: 'stream_end',   messageId: '...' }        — streaming response complete
 *   { type: 'tool_start',   messageId, toolUseId, tool, input, serverName? } — tool invocation (serverName present for MCP tools)
 *   { type: 'tool_result',  toolUseId, result, truncated, images? }  — tool result (images: [{mediaType, data}])
 *   { type: 'mcp_servers',  servers: [{ name, status }] }     — connected MCP servers
 *   { type: 'result',       ... }                     — query stats
 *   { type: 'status',       connected: true }         — connection status
 *   { type: 'claude_ready' }                          — Claude Code ready for input
 *   { type: 'model_changed', model: '...' }          — active model updated
 *   { type: 'available_models', models: [...] }       — models the server accepts
 *   { type: 'permission_request', requestId, tool, description, input, remainingMs } — permission prompt
 *   { type: 'confirm_permission_mode', mode, warning } — server challenges auto mode (client must re-send with confirmed: true)
 *   { type: 'permission_mode_changed', mode: '...' } — permission mode updated
 *   { type: 'available_permission_modes', modes: [...] } — permission modes
 *   { type: 'session_list', sessions: [...] }         — all sessions
 *   { type: 'session_switched', sessionId, name, cwd, conversationId? } — switched active session
 *   { type: 'session_created', sessionId, name }      — new session created
 *   { type: 'session_destroyed', sessionId }          — session removed
 *   { type: 'session_error', message, category?, sessionId?, recoverable? } — session operation error
 *   { type: 'history_replay_start', sessionId, fullHistory?, truncated? } — beginning of history replay
 *   { type: 'history_replay_end', sessionId }         — end of history replay
 *   { type: 'conversation_id', sessionId, conversationId } — SDK conversation ID for session portability
 *   { type: 'user_question', toolUseId, questions }   — AskUserQuestion prompt from Claude
 *   { type: 'agent_busy' }                           — agent started processing (per-session)
 *   { type: 'agent_idle' }                           — agent finished processing (per-session)
 *   { type: 'plan_started' }                         — Claude entered plan mode (transient)
 *   { type: 'plan_ready', allowedPrompts }           — plan complete, awaiting approval (transient)
 *   { type: 'server_shutdown', reason, restartEtaMs } — server shutting down (reason: 'restart'|'shutdown')
 *   { type: 'server_status', message }               — non-error status update (e.g., recovery)
 *   { type: 'server_error', category, message, recoverable } — server-side error forwarded to app
 *   { type: 'directory_listing', path, parentPath, entries, error } — directory listing response for file browser
 *   { type: 'file_listing', path, parentPath, entries, error } — file browser listing response
 *   { type: 'file_content', path, content, language, size, truncated, error } — file content response
 *   { type: 'slash_commands', commands: [{ name, description, source }] } — available slash commands
 *   { type: 'agent_list', agents: [{ name, description, source }] } — available custom agents
 *   { type: 'client_joined', client: { clientId, deviceName, deviceType, platform } } — new client connected
 *   { type: 'client_left', clientId }                — client disconnected
 *   { type: 'checkpoint_created', sessionId, checkpoint } — checkpoint created (auto or manual)
 *   { type: 'checkpoint_list', sessionId, checkpoints }   — list of checkpoints
 *   { type: 'checkpoint_restored', checkpointId, newSessionId, name } — checkpoint restored (new session created)
 *   { type: 'primary_changed', sessionId, clientId } — last-writer-wins primary changed (null on disconnect)
 *   { type: 'pong' }                                    — heartbeat response
 *   { type: 'permission_expired', requestId, sessionId, message }  — permission response could not be routed (expired/handled)
 *   { type: 'token_rotated', expiresAt }                — API token was rotated, client must re-authenticate
 *   { type: 'session_warning', sessionId, name, reason, message, remainingMs } — session about to timeout
 *   { type: 'session_timeout', sessionId, name, idleMs }         — session destroyed due to idle timeout
 *   { type: 'dev_preview', port, url, sessionId }       — dev server preview tunnel opened
 *   { type: 'dev_preview_stopped', port, sessionId }    — dev server preview tunnel closed
 *   { type: 'web_task_created', task }                  — cloud task launched
 *   { type: 'web_task_updated', task }                  — cloud task status changed
 *   { type: 'web_task_error', taskId?, message }        — cloud task error
 *   { type: 'web_task_list', tasks }                    — response to list_web_tasks
 *
 * Encrypted envelope (bidirectional, wraps any message above after key exchange):
 *   { type: 'encrypted', d: '<base64 ciphertext>', n: <nonce counter> }
 */
export class WsServer {
  constructor({ port, apiToken, cliSession, sessionManager, defaultSessionId, authRequired = true, pushManager = null, maxPayload, noEncrypt, keyExchangeTimeoutMs, localhostBypass, tokenManager } = {}) {
    this.port = port
    this.apiToken = apiToken
    this._tokenManager = tokenManager || null
    this._maxPayload = maxPayload || 10 * 1024 * 1024 // default 10MB (supports image/doc attachments)
    this.authRequired = authRequired
    this._encryptionEnabled = !noEncrypt
    this._keyExchangeTimeoutMs = keyExchangeTimeoutMs ?? 10_000
    this._localhostBypass = localhostBypass ?? true
    this.clients = new Map() // ws -> { id, authenticated, mode, activeSessionId, isAlive, deviceInfo }
    this.httpServer = null
    this.wss = null
    this._pingInterval = null
    this._pendingPermissions = new Map() // requestId -> { resolve, timer }
    this._permissionSessionMap = new Map() // requestId -> sessionId (for routing responses to correct session)
    this._questionSessionMap = new Map() // toolUseId -> sessionId (for routing question responses)
    this._primaryClients = new Map() // sessionId -> clientId (last-writer-wins)
    // Late-binding wrappers: allows tests to monkey-patch _send/_broadcast
    const self = this
    const sendFn = (ws, msg) => self._send(ws, msg)
    const broadcastFn = (msg, filter) => self._broadcast(msg, filter)
    this._fileOps = createFileOps(sendFn)
    this._permissions = createPermissionHandler({
      sendFn,
      broadcastFn,
      validateBearerAuth: (req, res) => self._validateBearerAuth(req, res),
      pushManager,
      pendingPermissions: this._pendingPermissions,
      permissionSessionMap: this._permissionSessionMap,
      getSessionManager: () => self.sessionManager,
    })
    // Handler context: late-bound via getters for test compat (tests may reassign properties)
    this._handlerCtx = {
      send: sendFn,
      broadcast: broadcastFn,
      broadcastToSession: (sid, msg, filter) => self._broadcastToSession(sid, msg, filter),
      broadcastSessionList: () => self._broadcast({ type: 'session_list', sessions: self.sessionManager.listSessions() }),
      get sessionManager() { return self.sessionManager },
      get cliSession() { return self.cliSession },
      get pushManager() { return self.pushManager },
      get checkpointManager() { return self._checkpointManager },
      get devPreview() { return self._devPreview },
      get webTaskManager() { return self._webTaskManager },
      primaryClients: this._primaryClients,
      get clients() { return self.clients },
      permissionSessionMap: this._permissionSessionMap,
      questionSessionMap: this._questionSessionMap,
      pendingPermissions: this._pendingPermissions,
      fileOps: this._fileOps,
      permissions: this._permissions,
      updatePrimary: (sid, cid) => self._updatePrimary(sid, cid),
      sendSessionInfo: (ws, sid) => self._sendSessionInfo(ws, sid),
      replayHistory: (ws, sid) => self._replayHistory(ws, sid),
      get draining() { return self._draining },
    }
    this.pushManager = pushManager

    // Auth rate limiting: track failed attempts per IP
    this._authFailures = new Map() // ip -> { count, firstFailure, blockedUntil }
    this._authCleanupInterval = null

    // Multi-session support: prefer sessionManager, fall back to single cliSession
    this.sessionManager = sessionManager || null
    this.defaultSessionId = defaultSessionId || null
    this._checkpointManager = new CheckpointManager()

    // Clean up checkpoints when sessions are destroyed
    if (sessionManager && typeof sessionManager.on === 'function') {
      sessionManager.on('session_destroyed', ({ sessionId }) => {
        try {
          this._checkpointManager.clearCheckpoints(sessionId)
        } catch (err) {
          console.warn(`[ws] Failed to clear checkpoints for destroyed session ${sessionId}: ${err.message}`)
        }
      })
    }

    // Dev server preview tunneling
    this._devPreview = new DevPreviewManager()

    // Web task manager (Claude Code Web cloud delegation)
    this._webTaskManager = new WebTaskManager({ cwd: sessionManager?._defaultCwd || process.cwd() })

    // Legacy single-session mode: wrap cliSession in a minimal shim
    if (!sessionManager && cliSession) {
      this.cliSession = cliSession
    } else {
      this.cliSession = null
    }

    this.serverMode = 'cli'
    this._normalizer = new EventNormalizer()
    this._gitInfo = getGitInfo()
    this._startedAt = Date.now()
    this._draining = false
    this._latestVersion = null

    // Background version check (non-blocking, skipped in test/CI)
    if (process.env.NODE_ENV !== 'test') {
      checkLatestVersion(packageJson.name).then((v) => { this._latestVersion = v }).catch(() => {})
    }

    // Wire TokenManager rotation events — broadcast new token to all clients
    this._tokenRotatedHandler = null
    if (this._tokenManager) {
      this._tokenRotatedHandler = ({ newToken, expiresAt }) => {
        // Update our reference so subsequent auth checks use the new token
        this.apiToken = newToken
        // Notify clients that a rotation occurred — do NOT broadcast the new token.
        // Clients must re-authenticate (re-scan QR or re-enter token).
        this._broadcast({ type: 'token_rotated', expiresAt })
        console.log(`[ws] Broadcasted token_rotated notification to all clients`)
      }
      this._tokenManager.on('token_rotated', this._tokenRotatedHandler)
    }
  }

  /**
   * Check whether a token is valid. Delegates to TokenManager (supports
   * rotated + grace-period tokens) when available, otherwise falls back
   * to constant-time comparison against the static apiToken.
   */
  _isTokenValid(token) {
    if (!token) return false
    if (this._tokenManager) return this._tokenManager.validate(token)
    return safeTokenCompare(token, this.apiToken)
  }

  /**
   * Validate Bearer token on an HTTP request. Returns true if auth passes
   * (or auth is disabled). On failure, writes a 403 response and returns false.
   */
  _validateBearerAuth(req, res) {
    if (!this.authRequired) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || !this._isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    return true
  }

  start(host) {
    // Create HTTP server that handles health checks, permission hooks, and WebSocket upgrades
    this.httpServer = createServer(async (req, res) => {
      // Health check endpoint — Cloudflare and the app verify connectivity via GET / and GET /health
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        // Browser visitors (Accept: text/html) get redirected to the dashboard
        const accept = req.headers['accept'] || ''
        if (req.url === '/' && accept.includes('text/html') && this.apiToken) {
          res.writeHead(302, {
            'Location': '/dashboard',
            'Cache-Control': 'no-store',
            'Vary': 'Accept',
          })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Vary': 'Accept' })
        res.end(JSON.stringify({ status: 'ok', mode: this.serverMode, version: SERVER_VERSION }))
        return
      }

      // Version endpoint — returns server version, git info, and uptime
      if (req.method === 'GET' && req.url === '/version') {
        if (!this._validateBearerAuth(req, res)) {
          console.warn('[ws] Rejected unauthenticated GET /version')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          version: SERVER_VERSION,
          latestVersion: this._latestVersion,
          gitCommit: this._gitInfo.commit,
          gitBranch: this._gitInfo.branch,
          uptime: Math.round((Date.now() - this._startedAt) / 1000),
        }))
        return
      }

      // Permission hook endpoint — receives requests from permission-hook.sh,
      // holds the HTTP response open until the mobile app responds via WebSocket
      if (req.method === 'POST' && req.url === '/permission') {
        this._permissions.handlePermissionRequest(req, res)
        return
      }

      // Permission response endpoint — receives Approve/Deny from iOS notification actions
      // (HTTP fallback when WebSocket is disconnected)
      if (req.method === 'POST' && req.url === '/permission-response') {
        this._permissions.handlePermissionResponseHttp(req, res)
        return
      }

      // Connection info endpoint — returns connection.json for programmatic access
      if (req.method === 'GET' && req.url === '/connect') {
        if (!this._validateBearerAuth(req, res)) return
        const connInfo = readConnectionInfo()
        if (!connInfo) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'No connection info available' }))
          return
        }
        // Redact secrets when auth is disabled to prevent exposure on the network (#742, #753)
        if (!this.authRequired) {
          if (connInfo.apiToken) {
            connInfo.apiToken = '[REDACTED]'
          }
          // connectionUrl contains the token embedded in the query string (chroxy://host?token=...)
          delete connInfo.connectionUrl
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(connInfo))
        return
      }

      // QR code endpoint — generates SVG QR from connection URL
      // Auth required: QR contains the connection token
      if (req.method === 'GET' && req.url?.startsWith('/qr')) {
        if (!this._validateBearerAuth(req, res)) return
        const connInfo = readConnectionInfo()
        if (!connInfo || !connInfo.connectionUrl) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Connection info not available yet' }))
          return
        }
        try {
          const svg = await QRCode.toString(connInfo.connectionUrl, {
            type: 'svg',
            color: { dark: '#e0e0e0', light: '#00000000' },
            margin: 1,
          })
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
          })
          res.end(svg)
        } catch (_err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Failed to generate QR code' }))
        }
        return
      }

      // Static assets for dashboard (xterm.js, etc.)
      if (req.method === 'GET' && req.url?.startsWith('/assets/')) {
        // Resolve from local or hoisted (monorepo root) node_modules
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

      // Dashboard endpoint
      if (req.method === 'GET' && req.url?.startsWith('/dashboard')) {
        const dashUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const queryToken = dashUrl.searchParams.get('token')

        // Security headers shared across all /dashboard responses (200 + 403)
        const securityHeaders = {
          'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:${this.port} wss://localhost:${this.port}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
        }

        if (this.authRequired) {
          const bearerToken = (req.headers['authorization'] || '').startsWith('Bearer ')
            ? req.headers['authorization'].slice(7) : null
          const token = queryToken || bearerToken
          if (!token || !this._isTokenValid(token)) {
            res.writeHead(403, { 'Content-Type': 'text/html', ...securityHeaders })
            res.end('<h1>403 Forbidden</h1><p>Invalid or missing token. Append ?token=YOUR_TOKEN to the URL.</p>')
            return
          }
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...securityHeaders,
        })
        res.end(getDashboardHtml(this.port, this.apiToken, !this._encryptionEnabled))
        return
      }
      res.writeHead(404)
      res.end()
    })

    // WebSocket server in noServer mode — we handle the upgrade manually
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this._maxPayload,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        zlibInflateOptions: { chunkSize: 16 * 1024 },
        threshold: 1024,
        concurrencyLimit: 10,
      },
    })

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const clientId = uuidv4().slice(0, 8)
      // Best-effort client IP for logging and rate limiting.
      // Prefers Cloudflare's cf-connecting-ip (set by the tunnel proxy),
      // then x-forwarded-for, then the raw socket address.
      const ip = req.headers['cf-connecting-ip']
        || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown'
      // SECURITY: For localhost bypass decisions (e.g. skipping encryption),
      // use ONLY the raw TCP socket address. Proxy headers like x-forwarded-for
      // and cf-connecting-ip can be spoofed by an attacker to fake a localhost
      // origin and bypass encryption. req.socket.remoteAddress is set by the
      // kernel and cannot be forged over the network.
      const socketIp = req.socket.remoteAddress || 'unknown'
      this.clients.set(ws, {
        id: clientId,
        authenticated: false,
        mode: 'chat', // default to chat view
        activeSessionId: null,
        isAlive: true,
        deviceInfo: null,
        ip,
        socketIp,
        _seq: 0,                  // monotonic sequence number for outbound messages
        encryptionState: null,    // { sharedKey, sendNonce, recvNonce } when active
        encryptionPending: false, // true while waiting for key_exchange
        postAuthQueue: null,      // queued messages during key exchange
      })

      // Track pong responses for keepalive detection
      ws.on('pong', () => {
        const client = this.clients.get(ws)
        if (client) client.isAlive = true
      })

      console.log(`[ws] Client ${clientId} connected (awaiting auth)`)

      // When auth is disabled, auto-authenticate immediately
      if (!this.authRequired) {
        const client = this.clients.get(ws)
        client.authenticated = true
        client.authTime = Date.now()
        this._sendPostAuthInfo(ws)
        this._broadcastClientJoined(client, ws)
        console.log(`[ws] Client ${clientId} auto-authenticated (--no-auth)`)
      }

      // Auto-disconnect if not authenticated within 10s (skip when auth is disabled)
      const authTimeout = this.authRequired
        ? setTimeout(() => {
            const client = this.clients.get(ws)
            if (client && !client.authenticated) {
              this._send(ws, { type: 'auth_fail', reason: 'timeout' })
              ws.close()
            }
          }, 10_000)
        : null

      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return // ignore non-JSON
        }
        // Decrypt incoming encrypted messages
        const client = this.clients.get(ws)
        if (msg.type === 'encrypted' && client?.encryptionState) {
          const envParsed = EncryptedEnvelopeSchema.safeParse(msg)
          if (!envParsed.success) {
            console.error(`[ws] Invalid encrypted message envelope from ${client.id}`)
            ws.close()
            return
          }
          try {
            msg = decrypt(msg, client.encryptionState.sharedKey, client.encryptionState.recvNonce, DIRECTION_CLIENT)
            client.encryptionState.recvNonce++
          } catch (err) {
            console.error(`[ws] Decryption failed from ${client.id}:`, err.message)
            ws.close()
            return
          }
        }
        this._handleMessage(ws, msg).catch((err) => {
          console.error('[ws] Unhandled error in message handler:', err)
        })
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const client = this.clients.get(ws)
        if (client?._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
        console.log(`[ws] Client ${client?.id} disconnected`)
        if (client?.authenticated) {
          this._handleClientDeparture(client)
        }
        this.clients.delete(ws)
      })

      ws.on('error', (err) => {
        console.error(`[ws] Client error:`, err.message)
      })
    })

    this.httpServer.listen(this.port, host)

    // Detect Claude Code Web features (non-blocking)
    this._webTaskManager.detectFeatures().then(({ remote, teleport }) => {
      if (remote || teleport) {
        console.log(`[ws] Claude Code Web features detected: remote=${remote}, teleport=${teleport}`)
      }
    }).catch(() => {})

    // Forward web task events to all authenticated clients
    this._webTaskManager.on('task_created', (task) => this._broadcast({ type: 'web_task_created', task }))
    this._webTaskManager.on('task_updated', (task) => this._broadcast({ type: 'web_task_updated', task }))
    this._webTaskManager.on('task_error', ({ taskId, message }) => this._broadcast({ type: 'web_task_error', taskId, message }))

    // Wire up unified event forwarding via EventNormalizer
    setupForwarding({
      normalizer: this._normalizer,
      sessionManager: this.sessionManager,
      cliSession: this.cliSession,
      devPreview: this._devPreview,
      pushManager: this.pushManager,
      permissionSessionMap: this._permissionSessionMap,
      questionSessionMap: this._questionSessionMap,
      broadcast: (msg, filter) => this._broadcast(msg, filter),
      broadcastToSession: (sid, msg, filter) => this._broadcastToSession(sid, msg, filter),
    })

    // Ping all authenticated clients every 30s to keep connections alive through
    // Cloudflare/mobile OS idle timeouts. Terminate unresponsive clients.
    this._pingInterval = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.authenticated) continue
        if (ws.readyState !== 1) continue
        if (!client.isAlive) {
          console.log(`[ws] Client ${client.id} unresponsive, terminating`)
          this._handleClientDeparture(client)
          this.clients.delete(ws)
          try { ws.terminate() } catch {}
          continue
        }
        client.isAlive = false
        try { ws.ping() } catch {}
      }
    }, 30_000)

    // Prune stale auth failure entries every 60s
    this._authCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000
      for (const [ip, entry] of this._authFailures) {
        if (entry.firstFailure < cutoff) {
          this._authFailures.delete(ip)
        }
      }
    }, 60_000)

    console.log(`[ws] Server listening on ${host || '0.0.0.0'}:${this.port} (${this.serverMode} mode)`)
  }

  /** Send post-auth info (server mode, readiness, models, sessions, etc.) */
  _sendPostAuthInfo(ws) {
    const client = this.clients.get(ws)

    // Get initial session info for auth_ok payload
    let sessionInfo = {}
    if (this.sessionManager) {
      // Multi-session mode: include first/default session's cwd
      let activeId = this.defaultSessionId
      let entry = activeId ? this.sessionManager.getSession(activeId) : null
      if (!entry) {
        activeId = this.sessionManager.firstSessionId
        entry = activeId ? this.sessionManager.getSession(activeId) : null
      }
      if (entry) {
        sessionInfo.cwd = entry.cwd
      }
    } else if (this.cliSession) {
      // Legacy single CLI mode
      sessionInfo.cwd = this.cliSession.cwd
    }
    if (!sessionInfo.cwd) {
      sessionInfo.cwd = null
    }

    // Skip encryption for localhost connections
    // ws://localhost traffic never leaves the machine — E2E encryption adds no security value
    // SECURITY: Use socketIp (req.socket.remoteAddress) — NOT client.ip which may
    // include proxy headers (x-forwarded-for, cf-connecting-ip) that can be spoofed.
    const isLocalhost = this._localhostBypass && (client.socketIp === '127.0.0.1' || client.socketIp === '::1' || client.socketIp === '::ffff:127.0.0.1')
    const requireEncryption = this._encryptionEnabled && !isLocalhost

    this._send(ws, {
      type: 'auth_ok',
      clientId: client.id,
      serverMode: this.serverMode,
      serverVersion: SERVER_VERSION,
      latestVersion: this._latestVersion,
      serverCommit: this._gitInfo.commit,
      cwd: sessionInfo.cwd,
      connectedClients: this._getConnectedClientList(),
      encryption: requireEncryption ? 'required' : 'disabled',
      protocolVersion: SERVER_PROTOCOL_VERSION,
      webFeatures: this._webTaskManager.getFeatureStatus(),
    })

    // If encryption required, queue all subsequent messages until key exchange completes
    if (requireEncryption) {
      client.encryptionPending = true
      client.postAuthQueue = []
      // Key exchange timeout: if no key_exchange arrives, disconnect (never downgrade to plaintext)
      client._keyExchangeTimeout = setTimeout(() => {
        if (client.encryptionPending) {
          console.error(`[ws] Key exchange timeout for ${client.id} — disconnecting (encryption required)`)
          client.encryptionPending = false
          client.postAuthQueue = null
          try {
            ws.send(JSON.stringify({ type: 'server_error', message: 'Encryption required but key exchange timed out. Please reconnect.', recoverable: false }))
          } catch (_) {}
          ws.close(1008, 'Key exchange timeout')
        }
      }, this._keyExchangeTimeoutMs)
    }

    this._send(ws, { type: 'server_mode', mode: this.serverMode })
    this._send(ws, { type: 'status', connected: true })

    // Multi-session mode
    if (this.sessionManager) {
      // Send session list
      this._send(ws, { type: 'session_list', sessions: this.sessionManager.listSessions() })

      // Resolve active session: prefer defaultSessionId, fall back to first available
      let activeId = this.defaultSessionId
      let entry = activeId ? this.sessionManager.getSession(activeId) : null
      if (!entry) {
        activeId = this.sessionManager.firstSessionId
        entry = activeId ? this.sessionManager.getSession(activeId) : null
      }

      client.activeSessionId = activeId

      if (entry) {
        this._send(ws, { type: 'session_switched', sessionId: activeId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
        this._sendSessionInfo(ws, activeId)
        this._replayHistory(ws, activeId)
      }

      this._send(ws, { type: 'available_models', models: getModels() })
      this._send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })

      // Re-emit any pending permission requests across all sessions
      this._permissions.resendPendingPermissions(ws)
      return
    }

    // Legacy single-session mode
    if (this.cliSession) {
      if (this.cliSession.isReady) {
        this._send(ws, { type: 'claude_ready' })
      }
      this._send(ws, {
        type: 'model_changed',
        model: this.cliSession.model ? toShortModelId(this.cliSession.model) : null,
      })
      this._send(ws, {
        type: 'available_models',
        models: getModels(),
      })
      this._send(ws, {
        type: 'permission_mode_changed',
        mode: this.cliSession.permissionMode || 'approve',
      })
      this._send(ws, {
        type: 'available_permission_modes',
        modes: PERMISSION_MODES,
      })
    }

    // Re-emit any pending permission requests (CLI single-session mode)
    this._permissions.resendPendingPermissions(ws)
  }

  /** Replay message history for a session to a single client.
   *  Only replays the last conversation turn (last Claude response + result +
   *  any in-progress work) to avoid flooding the app with old tool calls.
   */
  _replayHistory(ws, sessionId) {
    if (!this.sessionManager) return
    const fullHistory = this.sessionManager.getHistory(sessionId)
    if (fullHistory.length === 0) return

    // Find the last response message and replay from there to the end.
    // This gives: last Claude response + result + any in-progress messages.
    let startIdx = 0
    for (let i = fullHistory.length - 1; i >= 0; i--) {
      if (fullHistory[i].type === 'message' && fullHistory[i].messageType === 'response') {
        startIdx = i
        break
      }
    }

    const history = fullHistory.slice(startIdx)

    const truncated = this.sessionManager.isHistoryTruncated(sessionId)
    this._send(ws, { type: 'history_replay_start', sessionId, truncated })
    for (const entry of history) {
      this._send(ws, entry)
    }
    this._send(ws, { type: 'history_replay_end', sessionId })
  }

  /** Send session-specific info (model, permission, ready status) to a client */
  _sendSessionInfo(ws, sessionId) {
    const entry = this.sessionManager?.getSession(sessionId)
    if (!entry) return
    const session = entry.session

    if (session.isReady) {
      this._send(ws, { type: 'claude_ready' })
    }
    this._send(ws, {
      type: 'model_changed',
      model: session.model ? toShortModelId(session.model) : null,
    })
    this._send(ws, {
      type: 'permission_mode_changed',
      mode: session.permissionMode || 'approve',
    })
  }

  /** Route incoming client messages */
  async _handleMessage(ws, msg) {
    const client = this.clients.get(ws)
    if (!client) return

    // Auth must come first
    if (!client.authenticated) {
      if (msg.type !== 'auth') return

      // Validate auth message shape
      const authParsed = AuthSchema.safeParse(msg)
      if (!authParsed.success) {
        this._send(ws, { type: 'auth_fail', reason: 'invalid_message' })
        ws.close()
        return
      }

      // Check rate limit before processing auth
      const ip = client.socketIp
      const failure = this._authFailures.get(ip)
      if (failure && failure.blockedUntil > Date.now()) {
        console.warn(`[ws] Auth rate-limited for IP ${ip} (${failure.count} failures)`)
        this._send(ws, { type: 'auth_fail', reason: 'rate_limited' })
        ws.close()
        return
      }

      if (!this.authRequired || this._isTokenValid(msg.token)) {
        client.authenticated = true
        client.authTime = Date.now()
        // Clear rate limit on successful auth
        this._authFailures.delete(ip)
        // Extract optional device info from auth message
        if (msg.deviceInfo && typeof msg.deviceInfo === 'object') {
          client.deviceInfo = {
            deviceId: typeof msg.deviceInfo.deviceId === 'string' ? msg.deviceInfo.deviceId : null,
            deviceName: typeof msg.deviceInfo.deviceName === 'string' ? msg.deviceInfo.deviceName : null,
            deviceType: ['phone', 'tablet', 'desktop', 'unknown'].includes(msg.deviceInfo.deviceType) ? msg.deviceInfo.deviceType : 'unknown',
            platform: typeof msg.deviceInfo.platform === 'string' ? msg.deviceInfo.platform : 'unknown',
          }
        }
        this._sendPostAuthInfo(ws)
        // Broadcast client_joined to other authenticated clients
        this._broadcastClientJoined(client, ws)
        console.log(`[ws] Client ${client.id} authenticated`)
      } else {
        // Track auth failure for rate limiting
        const now = Date.now()
        const existing = this._authFailures.get(ip) || { count: 0, firstFailure: now, blockedUntil: 0 }
        existing.count++
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 60s
        const backoff = Math.min(1000 * Math.pow(2, existing.count - 1), 60_000)
        existing.blockedUntil = now + backoff
        this._authFailures.set(ip, existing)
        console.warn(`[ws] Auth failure from IP ${client.ip} (attempt ${existing.count}, blocked for ${backoff}ms)`)
        this._send(ws, { type: 'auth_fail', reason: 'invalid_token' })
        ws.close()
      }
      return
    }

    // Ignore duplicate auth messages from already-authenticated clients (e.g. auto-auth mode)
    if (msg.type === 'auth') return

    // Handle key exchange for E2E encryption
    if (client.encryptionPending) {
      if (msg.type === 'key_exchange') {
        clearTimeout(client._keyExchangeTimeout)
        const keParsed = KeyExchangeSchema.safeParse(msg)
        if (!keParsed.success) {
          const details = keParsed.error.issues.map(i => i.message).join(', ')
          console.warn(`[ws] Invalid key_exchange message from ${client.id}: ${details}`)
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', details }))
          } catch (err) {
            console.error('[ws] Failed to send key_exchange error:', err.message)
          }
          ws.close(1008, 'Invalid key_exchange message')
          return
        }
        const serverKp = createKeyPair()
        const sharedKey = deriveSharedKey(msg.publicKey, serverKp.secretKey)
        client.encryptionState = { sharedKey, sendNonce: 0, recvNonce: 0 }
        client.encryptionPending = false
        // Send key_exchange_ok unencrypted (client needs our public key to derive shared key)
        try {
          ws.send(JSON.stringify({ type: 'key_exchange_ok', publicKey: serverKp.publicKey }))
        } catch (err) {
          console.error('[ws] Failed to send key_exchange_ok:', err.message)
        }
        console.log(`[ws] E2E encryption established with ${client.id}`)
        // Flush queued messages (now encrypted)
        const queue = client.postAuthQueue
        client.postAuthQueue = null
        for (const queued of queue) {
          this._send(ws, queued)
        }
        return
      }
      // Non-key_exchange message while pending — disconnect (never downgrade to plaintext)
      clearTimeout(client._keyExchangeTimeout)
      console.error(`[ws] Client ${client.id} sent ${msg.type} instead of key_exchange — disconnecting (encryption required)`)
      client.encryptionPending = false
      client.postAuthQueue = null
      try {
        ws.send(JSON.stringify({ type: 'server_error', message: 'Encryption required but client did not initiate key exchange.', recoverable: false }))
      } catch (_) {}
      ws.close(1008, 'Key exchange required')
      return
    }

    // Respond to client-side heartbeat pings immediately (even during drain)
    if (msg.type === 'ping') {
      this._send(ws, { type: 'pong' })
      return
    }

    // During drain, only allow permission_response and user_question_response
    if (this._draining && msg.type !== 'permission_response' && msg.type !== 'user_question_response') {
      if (msg.type === 'input') {
        this._send(ws, { type: 'server_status', message: 'Server is restarting, please wait...' })
      }
      return
    }

    // Validate message schema before routing
    const parsed = ClientMessageSchema.safeParse(msg)
    if (!parsed.success) {
      const details = parsed.error.issues.map(i => i.message).join(', ')
      console.warn(`[ws] Invalid message from ${client.id}: ${details}`)
      this._send(ws, { type: 'error', code: 'INVALID_MESSAGE', details })
      return
    }
    const validatedMsg = parsed.data

    // Route based on server mode
    if (this.sessionManager) {
      handleSessionMessage(ws, client, validatedMsg, this._handlerCtx)
    } else if (this.cliSession) {
      handleCliMessage(ws, client, validatedMsg, this._handlerCtx)
    }
  }

  /** Delegate: re-send pending permissions (test compat) */
  _resendPendingPermissions(ws) {
    this._permissions.resendPendingPermissions(ws)
  }

  /** Public broadcast: send a message to all authenticated clients */
  broadcast(message) {
    console.log(`[ws] Broadcasting ${message.type || 'unknown'} to all clients`)
    this._broadcast(message)
  }

  /** Broadcast a message to all authenticated clients matching a filter */
  _broadcast(message, filter = () => true) {
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        this._send(ws, message)
      }
    }
  }

  /**
   * Broadcast a session-scoped message to all authenticated clients.
   * Tags the message with `sessionId` so clients can route it to the correct
   * session state. The optional `filter` callback restricts delivery to
   * a subset of connected clients (e.g., status updates scoped to one session).
   */
  _broadcastToSession(sessionId, message, filter = () => true) {
    const tagged = { ...message, sessionId }
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        this._send(ws, tagged)
      }
    }
  }

  /** Get list of connected clients for auth_ok payload */
  _getConnectedClientList() {
    const list = []
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === 1) {
        const info = client.deviceInfo || {}
        list.push({
          clientId: client.id,
          deviceName: info.deviceName || null,
          deviceType: info.deviceType || 'unknown',
          platform: info.platform || 'unknown',
        })
      }
    }
    return list
  }

  /** Broadcast client_joined to all OTHER authenticated clients */
  _broadcastClientJoined(newClient, excludeWs) {
    const info = newClient.deviceInfo || {}
    const message = {
      type: 'client_joined',
      client: {
        clientId: newClient.id,
        deviceName: info.deviceName || null,
        deviceType: info.deviceType || 'unknown',
        platform: info.platform || 'unknown',
      },
    }
    for (const [ws, client] of this.clients) {
      if (ws !== excludeWs && client.authenticated && ws.readyState === 1) {
        this._send(ws, message)
      }
    }
  }

  /** Handle cleanup when an authenticated client disconnects or is terminated */
  _handleClientDeparture(departingClient) {
    // Clear primary for any sessions this client was primary on
    for (const [sessionId, primaryClientId] of this._primaryClients) {
      if (primaryClientId === departingClient.id) {
        this._primaryClients.delete(sessionId)
        this._broadcastToSession(sessionId, {
          type: 'primary_changed',
          sessionId,
          clientId: null,
        })
      }
    }

    // Broadcast client_left to remaining authenticated clients
    const message = { type: 'client_left', clientId: departingClient.id }
    for (const [ws, client] of this.clients) {
      if (client.id !== departingClient.id && client.authenticated && ws.readyState === 1) {
        this._send(ws, message)
      }
    }
  }

  /** Update primary client for a session (last-writer-wins) */
  _updatePrimary(sessionId, clientId) {
    if (!sessionId) return
    const current = this._primaryClients.get(sessionId)
    if (current === clientId) return // already primary
    this._primaryClients.set(sessionId, clientId)
    this._broadcastToSession(sessionId, {
      type: 'primary_changed',
      sessionId,
      clientId,
    })
  }

  /**
   * Broadcast a server-side error to all authenticated clients.
   * @param {'tunnel'|'session'|'permission'|'general'} category
   * @param {string} message - Human-readable error description
   * @param {boolean} recoverable - true for warnings, false for fatal errors
   */
  broadcastError(category, message, recoverable = true) {
    console.error(`[ws] Broadcasting server_error (${category}): ${message}`)
    this._broadcast({
      type: 'server_error',
      category,
      message,
      recoverable,
    })
  }

  /**
   * Broadcast a server status update to all authenticated clients.
   * Used for non-error status updates like recovery notifications.
   * @param {string} message - Human-readable status message
   */
  broadcastStatus(message) {
    console.log(`[ws] Broadcasting server_status: ${message}`)
    this._broadcast({
      type: 'server_status',
      message,
    })
  }

  /**
   * Broadcast a shutdown notification to all authenticated clients.
   * Sent before the server goes down so the app can show reason + ETA.
   *
   * Note: This is a global broadcast (not per-session), so server_shutdown
   * is intentionally not listed in TRANSIENT_EVENTS in session-manager.js.
   *
   * @param {'restart'|'shutdown'} reason - Why the server is going down
   * @param {number} restartEtaMs - Estimated ms until server is back (0 = not coming back)
   */
  broadcastShutdown(reason, restartEtaMs) {
    console.log(`[ws] Broadcasting server_shutdown: ${reason} (ETA: ${restartEtaMs}ms)`)
    this._broadcast({
      type: 'server_shutdown',
      reason,
      restartEtaMs,
    })
  }

  /** Set the draining state. When draining, new input is rejected. */
  setDraining(draining) {
    this._draining = !!draining
  }

  /** Count of authenticated, connected clients */
  get authenticatedClientCount() {
    let count = 0
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === 1) count++
    }
    return count
  }

  /** Check if any authenticated client is actively viewing the given session */
  hasActiveViewersForSession(sessionId) {
    for (const [ws, client] of this.clients) {
      if (client.authenticated && client.activeSessionId === sessionId && ws.readyState === 1) return true
    }
    return false
  }

  /** Send JSON to a single client */
  _send(ws, message) {
    const client = this.clients.get(ws)
    // Queue messages while key exchange is pending
    if (client?.encryptionPending && client.postAuthQueue) {
      client.postAuthQueue.push(message)
      return
    }
    // Assign per-client monotonic sequence number
    if (client) {
      client._seq++
      message = { ...message, seq: client._seq }
    }
    try {
      // Encrypt if encryption is active for this client
      if (client?.encryptionState) {
        const envelope = encrypt(JSON.stringify(message), client.encryptionState.sharedKey, client.encryptionState.sendNonce, DIRECTION_SERVER)
        client.encryptionState.sendNonce++
        ws.send(JSON.stringify(envelope))
      } else {
        ws.send(JSON.stringify(message))
      }
    } catch (err) {
      console.error('[ws] Send error:', err.message)
    }
  }

  /** Graceful shutdown */
  close() {
    // Remove TokenManager listener to prevent post-shutdown broadcasts
    if (this._tokenManager && this._tokenRotatedHandler) {
      this._tokenManager.off('token_rotated', this._tokenRotatedHandler)
      this._tokenRotatedHandler = null
    }

    if (this._pingInterval) {
      clearInterval(this._pingInterval)
      this._pingInterval = null
    }
    if (this._authCleanupInterval) {
      clearInterval(this._authCleanupInterval)
      this._authCleanupInterval = null
    }

    // Auto-deny any pending permission requests
    this._permissions.destroy()
    this._questionSessionMap.clear()
    this._primaryClients.clear()
    this._normalizer.destroy()

    // Clean up all dev preview tunnels (fire-and-forget; close() is synchronous
    // by contract, and tunnel process cleanup is best-effort before exit)
    void this._devPreview.closeAll()

    // Clean up web task manager
    this._webTaskManager.destroy()

    for (const [ws] of this.clients) {
      ws.close()
    }
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
  }
}
