import { createServer } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT, safeTokenCompare } from './crypto.js'
import { ClientMessageSchema, EncryptedEnvelopeSchema } from './ws-schemas.js'
import { EventNormalizer } from './event-normalizer.js'
import { createFileOps } from './ws-file-ops.js'
import { createPermissionHandler } from './ws-permissions.js'
import { setupForwarding } from './ws-forwarding.js'
import { handleSessionMessage, handleCliMessage } from './ws-message-handlers.js'
import { handleAuthMessage, handlePairMessage, handleKeyExchange } from './ws-auth.js'
import { sendPostAuthInfo, replayHistory, flushPostAuthQueue, sendSessionInfo } from './ws-history.js'
import { createHttpHandler } from './http-routes.js'
import { CheckpointManager } from './checkpoint-manager.js'
import { DevPreviewManager } from './dev-preview.js'
import { WebTaskManager } from './web-task-manager.js'
import { RateLimiter } from './rate-limiter.js'
import { createLogger, setLogListener } from './logger.js'
import { PermissionAuditLog } from './permission-audit.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version
const log = createLogger('ws')

/**
 * Protocol version — controls client/server compatibility negotiation.
 *
 * BUMP POLICY (Option B — breaking changes only):
 *
 *   - DO NOT bump for additive changes (new message types, new optional fields).
 *     Clients already ignore unknown message types with a console.warn when
 *     serverProtocolVersion > clientProtocolVersion.
 *
 *   - DO bump (increment by 1) for breaking changes:
 *       * Removing or renaming an existing message type
 *       * Changing the shape of an existing message (renaming/removing fields,
 *         changing field types, making optional fields required)
 *       * Changing auth handshake semantics
 *
 *   - When bumping, update PROTOCOL_CHANGELOG below and coordinate with
 *     CLIENT_PROTOCOL_VERSION in:
 *       * packages/app/src/store/message-handler.ts
 *       * packages/server/src/dashboard-next/src/store/message-handler.ts
 *
 *   - If a bump would break old clients, consider whether MIN_PROTOCOL_VERSION
 *     should also increase (rejecting clients that cannot speak the new protocol).
 *
 * See also: #1058 (enforce MIN_PROTOCOL_VERSION during auth)
 */
export const SERVER_PROTOCOL_VERSION = 1
/** Minimum protocol version this server can speak */
export const MIN_PROTOCOL_VERSION = 1

/**
 * PROTOCOL_CHANGELOG
 *
 * v1 (initial) — baseline message set: auth, auth_ok, message, assistant,
 *   result, raw_output, model_changed, permission_request, tool_use, etc.
 *   All subsequent additive message types (e.g. plan_started, plan_ready,
 *   models_updated, client_focus_changed) do NOT bump the version per the
 *   breaking-changes-only policy above.
 */

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
 * Determine if request is served over HTTPS (tunnel or reverse proxy).
 */
function _isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto']
  return proto === 'https'
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
 *   { type: 'create_session', name?, cwd?, provider? } — create a new session
 *   { type: 'destroy_session', sessionId }            — destroy a session
 *   { type: 'rename_session', sessionId, name }       — rename a session
 *   { type: 'register_push_token', token }             — register Expo push token for notifications
 *   { type: 'user_question_response', answer }         — respond to AskUserQuestion prompt
 *   { type: 'list_directory', path? }                  — request directory listing for file browser
 *   { type: 'browse_files', path? }                   — request file/directory listing for file browser
 *   { type: 'read_file', path }                       — request file content for file viewer
 *   { type: 'write_file', path, content }              — write file content (path validated, 5MB limit)
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
 *   { type: 'auth_ok', clientId, serverMode, serverVersion, latestVersion, serverCommit, cwd, defaultCwd, connectedClients, encryption } — auth succeeded (encryption: 'required'|'disabled')
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
 *   { type: 'server_error', category, message, recoverable, sessionId? } — server-side error forwarded to app
 *   { type: 'directory_listing', path, parentPath, entries, error } — directory listing response for file browser
 *   { type: 'file_listing', path, parentPath, entries, error } — file browser listing response
 *   { type: 'file_content', path, content, language, size, truncated, error } — file content response
 *   { type: 'slash_commands', commands: [{ name, description, source }] } — available slash commands
 *   { type: 'agent_list', agents: [{ name, description, source }] } — available custom agents
 *   { type: 'client_joined', client: { clientId, deviceName, deviceType, platform } } — new client connected
 *   { type: 'client_left', clientId }                — client disconnected
 *   { type: 'client_focus_changed', clientId, sessionId, timestamp } — another client changed session focus
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
  constructor({ port, apiToken, cliSession, sessionManager, defaultSessionId, authRequired = true, pushManager = null, maxPayload, noEncrypt, keyExchangeTimeoutMs, localhostBypass, tokenManager, pairingManager, maxPendingConnections, backpressureThreshold } = {}) {
    this.port = port
    this.apiToken = apiToken
    this._tokenManager = tokenManager || null
    this._pairingManager = pairingManager || null
    this._maxPayload = maxPayload || 10 * 1024 * 1024 // default 10MB (supports image/doc attachments)
    this.authRequired = authRequired
    this._encryptionEnabled = !noEncrypt
    this._keyExchangeTimeoutMs = keyExchangeTimeoutMs ?? 10_000
    this._localhostBypass = localhostBypass ?? true
    this._maxPendingConnections = maxPendingConnections ?? 20
    this._backpressureThreshold = backpressureThreshold ?? 1024 * 1024 // 1MB default
    this._rateLimiter = new RateLimiter()
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
      get permissionAudit() { return self._permissionAudit },
      updatePrimary: (sid, cid) => self._updatePrimary(sid, cid),
      sendSessionInfo: (ws, sid) => self._sendSessionInfo(ws, sid),
      replayHistory: (ws, sid) => self._replayHistory(ws, sid),
      get draining() { return self._draining },
    }

    // Context objects for extracted modules (ws-auth.js, ws-history.js)
    this._historyCtx = {
      get clients() { return self.clients },
      get sessionManager() { return self.sessionManager },
      get cliSession() { return self.cliSession },
      get defaultSessionId() { return self.defaultSessionId },
      get serverMode() { return self.serverMode },
      serverVersion: SERVER_VERSION,
      get latestVersion() { return self._latestVersion },
      get gitInfo() { return self._gitInfo },
      get encryptionEnabled() { return self._encryptionEnabled },
      get localhostBypass() { return self._localhostBypass },
      get keyExchangeTimeoutMs() { return self._keyExchangeTimeoutMs },
      protocolVersion: SERVER_PROTOCOL_VERSION,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      get webTaskManager() { return self._webTaskManager },
      send: sendFn,
      broadcast: broadcastFn,
      getConnectedClientList: () => self._getConnectedClientList(),
      get permissions() { return self._permissions },
    }
    this._authCtx = {
      get clients() { return self.clients },
      get authRequired() { return self.authRequired },
      isTokenValid: (token) => self._isTokenValid(token),
      get authFailures() { return self._authFailures },
      get pairingManager() { return self._pairingManager },
      send: sendFn,
      onAuthSuccess: (ws, client) => {
        // If paired, include sessionToken in auth_ok response
        if (client._sessionToken) {
          self._sendPostAuthInfo(ws, { sessionToken: client._sessionToken })
          delete client._sessionToken
        } else {
          self._sendPostAuthInfo(ws)
        }
        self._broadcastClientJoined(client, ws)
      },
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      serverProtocolVersion: SERVER_PROTOCOL_VERSION,
      flushPostAuthQueue: (ws, queue) => self._flushPostAuthQueue(ws, queue),
    }

    this.pushManager = pushManager

    // Permission audit trail
    this._permissionAudit = new PermissionAuditLog()

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
          log.warn(`Failed to clear checkpoints for destroyed session ${sessionId}: ${err.message}`)
        }
      })
    }

    // Dev server preview tunneling
    this._devPreview = new DevPreviewManager()

    // Web task manager (Claude Code Web cloud delegation)
    this._webTaskManager = new WebTaskManager({ cwd: sessionManager?.defaultCwd || process.cwd() })

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
        log.info(`Broadcasted token_rotated notification to all clients`)
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
    // Check session tokens issued via pairing
    if (this._pairingManager && this._pairingManager.isSessionTokenValid(token)) return true
    if (this._tokenManager) return this._tokenManager.validate(token)
    return safeTokenCompare(token, this.apiToken)
  }

  /**
   * Authenticate a dashboard HTTP request using cookie, bearer, or query token.
   * Returns true if auth passes (or auth is disabled). On failure or redirect,
   * writes the response and returns false (caller should stop processing).
   */
  _authenticateDashboardRequest(req, res, dashUrl, securityHeaders) {
    if (!this.authRequired) return true
    const bearerToken = (req.headers['authorization'] || '').startsWith('Bearer ')
      ? req.headers['authorization'].slice(7) : null
    const cookieToken = (req.headers['cookie'] || '').match(/(?:^|;\s*)chroxy_auth=([^;]*)/)
    let cookieVal = null
    if (cookieToken) {
      try { cookieVal = decodeURIComponent(cookieToken[1]) } catch { cookieVal = null }
    }
    const queryToken = dashUrl.searchParams.get('token')
    const token = queryToken || bearerToken || cookieVal
    if (!token || !this._isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'text/html', ...securityHeaders })
      res.end('<h1>403 Forbidden</h1><p>Invalid or missing token.</p>')
      return false
    }
    if (queryToken) {
      const encoded = encodeURIComponent(queryToken)
      // Set cookie for future requests, but DON'T redirect — serve content
      // directly. Tauri's WKWebView doesn't reliably send cookies on 302
      // redirects to 127.0.0.1 with SameSite=Strict.
      const securePart = _isSecureRequest(req) ? '; Secure' : ''
      res.setHeader('Set-Cookie', `chroxy_auth=${encoded}; Path=/dashboard; SameSite=Strict; HttpOnly${securePart}; Max-Age=86400`)
    }
    return true
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
    // Create HTTP server — route handling extracted to http-routes.js
    this.httpServer = createServer(createHttpHandler(this))

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
      // Enforce pre-auth connection limit to prevent FD exhaustion
      const pendingCount = this._countPendingConnections()
      if (pendingCount >= this._maxPendingConnections) {
        log.warn(`Pre-auth connection limit reached (${pendingCount}/${this._maxPendingConnections}), rejecting upgrade`)
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const clientId = randomUUID().slice(0, 8)
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
        subscribedSessionIds: new Set(),
        isAlive: true,
        deviceInfo: null,
        ip,
        socketIp,
        _seq: 0,                  // monotonic sequence number for outbound messages
        encryptionState: null,    // { sharedKey, sendNonce, recvNonce } when active
        encryptionPending: false, // true while waiting for key_exchange
        postAuthQueue: null,      // queued messages during key exchange
        _flushing: false,         // gates _send during setImmediate gaps in post-auth flush
        _flushOverflow: null,     // messages that arrived during flush
      })

      // Track pong responses for keepalive detection
      ws.on('pong', () => {
        const client = this.clients.get(ws)
        if (client) client.isAlive = true
      })

      log.info(`Client ${clientId} connected (awaiting auth)`)

      // When auth is disabled, auto-authenticate immediately
      if (!this.authRequired) {
        const client = this.clients.get(ws)
        client.authenticated = true
        client.authTime = Date.now()
        this._sendPostAuthInfo(ws)
        this._broadcastClientJoined(client, ws)
        log.info(`Client ${clientId} auto-authenticated (--no-auth)`)
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
            log.error(`Invalid encrypted message envelope from ${client.id}`)
            ws.close()
            return
          }
          try {
            msg = decrypt(msg, client.encryptionState.sharedKey, client.encryptionState.recvNonce, DIRECTION_CLIENT)
            client.encryptionState.recvNonce++
          } catch (err) {
            log.error(`Decryption failed from ${client.id}: ${err.message}`)
            ws.close()
            return
          }
        }
        this._handleMessage(ws, msg).catch((err) => {
          log.error(`Unhandled error in message handler: ${err.message}`)
        })
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const client = this.clients.get(ws)
        if (client?._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
        log.info(`Client ${client?.id} disconnected`)
        if (client?.authenticated) {
          this._handleClientDeparture(client)
        }
        if (client?.id) this._rateLimiter.remove(client.id)
        this.clients.delete(ws)
      })

      ws.on('error', (err) => {
        log.error(`Client error: ${err.message}`)
      })
    })

    this.httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${this.port} is already in use — is another Chroxy instance running?`)
        process.exit(1)
        return
      }
      log.error(`HTTP server error: ${err.message}`)
    })

    this.httpServer.listen(this.port, host)

    // Detect Claude Code Web features (non-blocking)
    this._webTaskManager.detectFeatures().then(({ remote, teleport }) => {
      if (remote || teleport) {
        log.info(`Claude Code Web features detected: remote=${remote}, teleport=${teleport}`)
      }
    }).catch(() => {})

    // Forward web task events to all authenticated clients
    this._webTaskManager.on('task_created', (task) => this._broadcast({ type: 'web_task_created', task }))
    this._webTaskManager.on('task_updated', (task) => this._broadcast({ type: 'web_task_updated', task }))
    this._webTaskManager.on('task_error', ({ taskId, message }) => this._broadcast({ type: 'web_task_error', taskId, message }))

    // Broadcast structured log entries to dashboard clients.
    // Re-entrancy guard prevents infinite recursion when _broadcast() itself
    // logs (e.g. backpressure debug messages) and log level is set to debug.
    let inLogBroadcast = false
    setLogListener((entry) => {
      if (inLogBroadcast) return
      inLogBroadcast = true
      try {
        this._broadcast({ type: 'log_entry', ...entry })
      } finally {
        inLogBroadcast = false
      }
    })

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
          log.info(`Client ${client.id} unresponsive, terminating`)
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

    log.info(`Server listening on ${host || '0.0.0.0'}:${this.port} (${this.serverMode} mode)`)
  }

  /** Delegates to ws-history.js */
  _sendPostAuthInfo(ws, extra) { sendPostAuthInfo(this._historyCtx, ws, extra) }
  _replayHistory(ws, sessionId) { replayHistory(this._historyCtx, ws, sessionId) }
  _flushPostAuthQueue(ws, queue) { flushPostAuthQueue(this._historyCtx, ws, queue) }
  _sendSessionInfo(ws, sessionId) { sendSessionInfo(this._historyCtx, ws, sessionId) }

  /** Route incoming client messages */
  async _handleMessage(ws, msg) {
    const client = this.clients.get(ws)
    if (!client) return

    // Auth handling (delegates to ws-auth.js)
    if (!client.authenticated) {
      if (msg.type === 'pair') {
        handlePairMessage(this._authCtx, ws, msg)
      } else {
        handleAuthMessage(this._authCtx, ws, msg)
      }
      return
    }
    if (msg.type === 'auth') return

    // Key exchange for E2E encryption (delegates to ws-auth.js)
    if (handleKeyExchange(this._authCtx, ws, msg)) return

    // Respond to client-side heartbeat pings immediately (even during drain)
    if (msg.type === 'ping') {
      this._send(ws, { type: 'pong' })
      return
    }

    // Rate limiting (skip for permission responses and pings)
    if (msg.type !== 'permission_response' && msg.type !== 'user_question_response') {
      const { allowed, retryAfterMs } = this._rateLimiter.check(client.id)
      if (!allowed) {
        this._send(ws, { type: 'rate_limited', retryAfterMs, message: 'Too many messages. Please slow down.' })
        return
      }
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
      log.warn(`Invalid message from ${client.id}: ${details}`)
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
    log.info(`Broadcasting ${message.type || 'unknown'} to all clients`)
    this._broadcast(message)
  }

  /** Broadcast a message to all authenticated clients matching a filter */
  _broadcast(message, filter = () => true) {
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        if (ws.bufferedAmount > this._backpressureThreshold) {
          log.debug(`Backpressure: skipping ${message.type || 'unknown'} for client ${client.id} (buffered: ${ws.bufferedAmount})`)
          continue
        }
        this._send(ws, message)
      }
    }
  }

  /**
   * Broadcast a session-scoped message to clients viewing that session.
   * Tags the message with `sessionId` so clients can route it to the correct
   * session state. By default only delivers to clients whose activeSessionId
   * matches — prevents cross-session info leakage and bandwidth waste.
   * Pass a custom filter to override the default recipient selection when needed.
   */
  _broadcastToSession(sessionId, message, filter = (client) => client.activeSessionId === sessionId || client.subscribedSessionIds.has(sessionId)) {
    const tagged = { ...message, sessionId }
    for (const [ws, client] of this.clients) {
      if (client.authenticated && filter(client) && ws.readyState === 1) {
        if (ws.bufferedAmount > this._backpressureThreshold) {
          log.debug(`Backpressure: skipping ${message.type || 'unknown'} for client ${client.id} (buffered: ${ws.bufferedAmount})`)
          continue
        }
        this._send(ws, tagged)
      }
    }
  }

  /** Count unauthenticated connections for pre-auth limit enforcement */
  _countPendingConnections() {
    let count = 0
    for (const [ws, client] of this.clients) {
      if (!client.authenticated && ws.readyState === 1) count++
    }
    return count
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
   * @param {string|null} [sessionId] - Optional session ID for scoped errors
   */
  broadcastError(category, message, recoverable = true, sessionId = null) {
    log.error(`Broadcasting server_error (${category}): ${message}`)
    const payload = { type: 'server_error', category, message, recoverable }
    if (sessionId) payload.sessionId = sessionId
    this._broadcast(payload)
  }

  /**
   * Broadcast a server status update to all authenticated clients.
   * Used for non-error status updates like recovery notifications.
   * @param {string} message - Human-readable status message
   */
  broadcastStatus(message) {
    log.info(`Broadcasting server_status: ${message}`)
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
   * @param {'restart'|'shutdown'|'crash'} reason - Why the server is going down
   * @param {number} restartEtaMs - Estimated ms until server is back (0 = not coming back)
   */
  broadcastShutdown(reason, restartEtaMs) {
    log.info(`Broadcasting server_shutdown: ${reason} (ETA: ${restartEtaMs}ms)`)
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
    // Buffer messages while post-auth queue is still flushing
    if (client?._flushing) {
      client._flushOverflow = client._flushOverflow || []
      client._flushOverflow.push(message)
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
      log.error(`Send error: ${err.message}`)
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

    // Clear log listener to prevent post-shutdown broadcasts and GC leak
    setLogListener(null)

    for (const [ws] of this.clients) {
      ws.close()
    }
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
  }
}
