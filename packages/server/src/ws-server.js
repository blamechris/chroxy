import { createServer } from 'http'
import { execFileSync } from 'child_process'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import { statSync, readFileSync } from 'fs'
import { readdir, readFile, stat, realpath } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join, resolve, normalize, extname } from 'path'
import { homedir, hostname } from 'os'
import { timingSafeEqual } from 'crypto'
import { MODELS, ALLOWED_MODEL_IDS, toShortModelId } from './models.js'
import { createKeyPair, deriveSharedKey, encrypt, decrypt, DIRECTION_SERVER, DIRECTION_CLIENT } from './crypto.js'

// -- Permission TTL --
const PERMISSION_TTL_MS = 300_000 // 5 minutes

// -- Attachment validation constants --
const MAX_ATTACHMENT_COUNT = 5
const MAX_IMAGE_SIZE = 2 * 1024 * 1024       // 2MB decoded
const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024    // 5MB decoded
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ALLOWED_DOC_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'])

/**
 * Validate an attachments array from a WebSocket message.
 * Returns null if valid, or an error string if invalid.
 */
function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) return 'attachments must be an array'
  if (attachments.length > MAX_ATTACHMENT_COUNT) return `too many attachments (max ${MAX_ATTACHMENT_COUNT})`
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (!att || typeof att !== 'object') return `attachment[${i}]: not an object`
    if (typeof att.type !== 'string' || (att.type !== 'image' && att.type !== 'document')) {
      return `attachment[${i}]: type must be 'image' or 'document'`
    }
    if (typeof att.mediaType !== 'string') return `attachment[${i}]: missing mediaType`
    if (typeof att.data !== 'string') return `attachment[${i}]: missing data`
    if (typeof att.name !== 'string') return `attachment[${i}]: missing name`

    // Validate media type and cross-check against attachment type
    if (att.type === 'image' && !ALLOWED_IMAGE_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'image' requires an image mediaType`
    }
    if (att.type === 'document' && !ALLOWED_DOC_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'document' requires a document mediaType`
    }

    // Check decoded size (base64 is ~4/3 of original)
    const decodedSize = Math.ceil(att.data.length * 3 / 4)
    const maxSize = att.type === 'image' ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE
    if (decodedSize > maxSize) {
      return `attachment[${i}]: exceeds ${maxSize / (1024 * 1024)}MB limit`
    }
  }
  return null
}

/** Constant-time string comparison for auth tokens */
function safeTokenCompare(a, b) {
  let valid = true
  if (typeof a !== 'string' || typeof b !== 'string') {
    valid = false
    a = ''
    b = ''
  }

  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  const maxLen = Math.max(bufA.length, bufB.length)

  // Always compare buffers of equal length to avoid leaking length via timing
  const paddedA = Buffer.alloc(maxLen)
  const paddedB = Buffer.alloc(maxLen)
  bufA.copy(paddedA)
  bufB.copy(paddedB)

  const equal = maxLen === 0 ? false : timingSafeEqual(paddedA, paddedB)
  return valid && equal && bufA.length === bufB.length
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SERVER_VERSION = packageJson.version

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

const PERMISSION_MODES = [
  { id: 'approve', label: 'Approve' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
]
const ALLOWED_PERMISSION_MODE_IDS = new Set(PERMISSION_MODES.map((m) => m.id))

/**
 * WebSocket server that bridges the phone client to the backend.
 *
 * Supports three modes:
 *   - Multi-session (sessionManager): multiple concurrent CliSession instances
 *   - Single CLI (cliSession): headless `claude -p` with structured JSON (legacy)
 *   - PTY mode (ptyManager + outputParser): existing tmux/PTY behavior
 *
 * Protocol (JSON messages over WebSocket):
 *
 * Client -> Server:
 *   { type: 'auth',      token: '...', deviceInfo? }   — authenticate (deviceInfo: { deviceId, deviceName, deviceType, platform })
 *   { type: 'input',     data: '...' }               — send text to active session
 *   { type: 'resize',    cols: 120, rows: 40 }       — resize PTY (PTY mode only)
 *   { type: 'mode',      mode: 'terminal'|'chat' }   — switch view mode
 *   { type: 'interrupt' }                             — interrupt active session
 *   { type: 'set_model', model: '...' }              — change model on active session
 *   { type: 'set_permission_mode', mode: '...', confirmed? } — change permission mode (confirmed: true required for 'auto')
 *   { type: 'permission_response', requestId, decision } — respond to permission prompt
 *   { type: 'list_sessions' }                         — request session list
 *   { type: 'switch_session', sessionId }             — switch to a different session
 *   { type: 'create_session', name?, cwd? }           — create a new session
 *   { type: 'destroy_session', sessionId }            — destroy a session
 *   { type: 'rename_session', sessionId, name }       — rename a session
 *   { type: 'discover_sessions' }                     — scan for host tmux sessions
 *   { type: 'trigger_discovery' }                     — trigger on-demand tmux session discovery
 *   { type: 'attach_session', tmuxSession, name? }    — attach to a tmux session
 *   { type: 'register_push_token', token }             — register Expo push token for notifications
 *   { type: 'user_question_response', answer }         — respond to AskUserQuestion prompt
 *   { type: 'list_directory', path? }                  — request directory listing for file browser
 *   { type: 'browse_files', path? }                   — request file/directory listing for file browser
 *   { type: 'read_file', path }                       — request file content for file viewer
 *   { type: 'list_slash_commands' }                     — request available slash commands
 *   { type: 'list_agents' }                             — request available custom agents
 *   { type: 'request_full_history', sessionId? }         — request full JSONL history for a session
 *   { type: 'key_exchange', publicKey }                  — client's ephemeral X25519 public key (E2E encryption)
 *   { type: 'ping' }                                    — client heartbeat (server responds with pong)
 *
 * Server -> Client:
 *   All session-scoped messages include a `sessionId` field for background sync.
 *   { type: 'auth_ok', clientId, serverMode, serverVersion, latestVersion, serverCommit, cwd, connectedClients, encryption } — auth succeeded (encryption: 'required'|'disabled')
 *   { type: 'key_exchange_ok', publicKey }               — server's ephemeral X25519 public key (E2E encryption)
 *   { type: 'auth_fail',    reason: '...' }           — auth failed
 *   { type: 'server_mode',  mode: 'cli'|'terminal' }  — which backend mode is active
 *   { type: 'raw',          data: '...' }             — raw PTY output (terminal view)
 *   { type: 'message',      ... }                     — parsed chat message
 *   { type: 'stream_start', messageId: '...' }        — beginning of streaming response
 *   { type: 'stream_delta', messageId, delta }         — token-by-token text
 *   { type: 'stream_end',   messageId: '...' }        — streaming response complete
 *   { type: 'tool_start',   messageId, toolUseId, tool, input } — tool invocation
 *   { type: 'tool_result',  toolUseId, result, truncated }    — tool execution result
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
 *   { type: 'discovered_sessions', tmux: [...] }     — host tmux session scan results
 *   { type: 'discovery_triggered' }                  — ack that on-demand discovery started
 *   { type: 'history_replay_start', sessionId, fullHistory?, truncated? } — beginning of history replay
 *   { type: 'history_replay_end', sessionId }         — end of history replay
 *   { type: 'conversation_id', sessionId, conversationId } — SDK conversation ID for session portability
 *   { type: 'raw_background', data: '...' }           — raw PTY data for chat-mode clients
 *   { type: 'status_update', model, cost, ... }       — Claude Code status bar metadata
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
 *   { type: 'primary_changed', sessionId, clientId } — last-writer-wins primary changed (null on disconnect)
 *   { type: 'pong' }                                    — heartbeat response
 *   { type: 'permission_expired', requestId, sessionId, message }  — permission response could not be routed (expired/handled)
 *
 * Encrypted envelope (bidirectional, wraps any message above after key exchange):
 *   { type: 'encrypted', d: '<base64 ciphertext>', n: <nonce counter> }
 */
export class WsServer {
  constructor({ port, apiToken, ptyManager, outputParser, cliSession, sessionManager, defaultSessionId, authRequired = true, pushManager = null, maxPayload, noEncrypt, keyExchangeTimeoutMs } = {}) {
    this.port = port
    this.apiToken = apiToken
    this._maxPayload = maxPayload || 10 * 1024 * 1024 // default 10MB (supports image/doc attachments)
    this.ptyManager = ptyManager || null
    this.outputParser = outputParser || null
    this.authRequired = authRequired
    this._encryptionEnabled = !noEncrypt
    this._keyExchangeTimeoutMs = keyExchangeTimeoutMs ?? 10_000
    this.clients = new Map() // ws -> { id, authenticated, mode, activeSessionId, isAlive, deviceInfo }
    this.httpServer = null
    this.wss = null
    this._pingInterval = null
    this._pendingPermissions = new Map() // requestId -> { resolve, timer }
    this._permissionCounter = 0
    this._permissionSessionMap = new Map() // requestId -> sessionId (for routing responses to correct session)
    this._questionSessionMap = new Map() // toolUseId -> sessionId (for routing question responses)
    this._primaryClients = new Map() // sessionId -> clientId (last-writer-wins)
    this._cwdRealCache = new Map() // cwd string -> resolved realpath (avoids repeated realpath syscalls)
    this.pushManager = pushManager

    // Auth rate limiting: track failed attempts per IP
    this._authFailures = new Map() // ip -> { count, firstFailure, blockedUntil }
    this._authCleanupInterval = null

    // Multi-session support: prefer sessionManager, fall back to single cliSession
    this.sessionManager = sessionManager || null
    this.defaultSessionId = defaultSessionId || null

    // Legacy single-session mode: wrap cliSession in a minimal shim
    if (!sessionManager && cliSession) {
      this.cliSession = cliSession
    } else {
      this.cliSession = null
    }

    this.serverMode = (this.sessionManager || this.cliSession) ? 'cli' : 'terminal'
    this._gitInfo = getGitInfo()
    this._startedAt = Date.now()
    this._draining = false
    this._latestVersion = null

    // Background version check (non-blocking, skipped in test/CI)
    if (process.env.NODE_ENV !== 'test') {
      checkLatestVersion(packageJson.name).then((v) => { this._latestVersion = v }).catch(() => {})
    }
  }

  _formatStatusLog(status) {
    return `[ws] Broadcasting status_update: $${status.cost} | ${status.model} | msgs:${status.messageCount} | ${status.contextTokens} (${status.contextPercent}%)`
  }

  /**
   * Validate Bearer token on an HTTP request. Returns true if auth passes
   * (or auth is disabled). On failure, writes a 403 response and returns false.
   */
  _validateBearerAuth(req, res) {
    if (!this.authRequired) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || !safeTokenCompare(token, this.apiToken)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    return true
  }

  start(host) {
    // Create HTTP server that handles health checks, permission hooks, and WebSocket upgrades
    this.httpServer = createServer((req, res) => {
      // Health check endpoint — Cloudflare and the app verify connectivity via GET /
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', mode: this.serverMode, hostname: hostname(), version: SERVER_VERSION }))
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
        this._handlePermissionRequest(req, res)
        return
      }

      // Permission response endpoint — receives Approve/Deny from iOS notification actions
      // (HTTP fallback when WebSocket is disconnected)
      if (req.method === 'POST' && req.url === '/permission-response') {
        this._handlePermissionResponseHttp(req, res)
        return
      }

      res.writeHead(404)
      res.end()
    })

    // WebSocket server in noServer mode — we handle the upgrade manually
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this._maxPayload })

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const clientId = uuidv4().slice(0, 8)
      const ip = req.headers['cf-connecting-ip']
        || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown'
      this.clients.set(ws, {
        id: clientId,
        authenticated: false,
        mode: 'chat', // default to chat view
        activeSessionId: null,
        isAlive: true,
        deviceInfo: null,
        ip,
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
          if (typeof msg.d !== 'string' || typeof msg.n !== 'number') {
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

    // Wire up event forwarding based on mode
    if (this.sessionManager) {
      this._setupSessionForwarding()
    } else if (this.cliSession) {
      this._setupCliForwarding()
    } else {
      this._setupPtyForwarding()
    }

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
    // PTY mode: no session manager, no cliSession — cwd is unknown; prefer null to avoid a misleading value
    if (!sessionInfo.cwd) {
      sessionInfo.cwd = null
    }

    this._send(ws, {
      type: 'auth_ok',
      clientId: client.id,
      serverMode: this.serverMode,
      serverVersion: SERVER_VERSION,
      latestVersion: this._latestVersion,
      serverCommit: this._gitInfo.commit,
      cwd: sessionInfo.cwd,
      connectedClients: this._getConnectedClientList(),
      encryption: this._encryptionEnabled ? 'required' : 'disabled',
    })

    // If encryption enabled, queue all subsequent messages until key exchange completes
    if (this._encryptionEnabled) {
      client.encryptionPending = true
      client.postAuthQueue = []
      // Key exchange timeout: if no key_exchange arrives, disconnect (never downgrade to plaintext)
      client._keyExchangeTimeout = setTimeout(() => {
        if (client.encryptionPending) {
          console.error(`[ws] Key exchange timeout for ${client.id} — disconnecting (encryption required)`)
          client.encryptionPending = false
          client.postAuthQueue = null
          try {
            ws.send(JSON.stringify({ type: 'server_error', error: 'Encryption required but key exchange timed out. Please reconnect.', recoverable: false }))
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

      this._send(ws, { type: 'available_models', models: MODELS })
      this._send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })

      // Re-emit any pending permission requests across all sessions
      this._resendPendingPermissions(ws)
      return
    }

    // Legacy single-session mode
    // In PTY mode, tell client if Claude Code is already ready
    if (this.outputParser && this.outputParser.claudeReady) {
      this._send(ws, { type: 'claude_ready' })
    }

    // In CLI mode, gate on actual process readiness (may be respawning)
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
        models: MODELS,
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
    this._resendPendingPermissions(ws)
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

      // Check rate limit before processing auth
      const ip = client.ip
      const failure = this._authFailures.get(ip)
      if (failure && failure.blockedUntil > Date.now()) {
        console.warn(`[ws] Auth rate-limited for IP ${ip} (${failure.count} failures)`)
        this._send(ws, { type: 'auth_fail', reason: 'rate_limited' })
        ws.close()
        return
      }

      if (!this.authRequired || safeTokenCompare(msg.token, this.apiToken)) {
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
        console.warn(`[ws] Auth failure from IP ${ip} (attempt ${existing.count}, blocked for ${backoff}ms)`)
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
        if (!msg.publicKey || typeof msg.publicKey !== 'string') {
          console.warn(`[ws] Invalid key_exchange message from ${client.id}: missing or non-string publicKey`)
          try {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid key_exchange message: publicKey is required and must be a string' }))
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
        ws.send(JSON.stringify({ type: 'server_error', error: 'Encryption required but client did not initiate key exchange.', recoverable: false }))
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

    // Route based on server mode
    if (this.sessionManager) {
      this._handleSessionMessage(ws, client, msg)
    } else if (this.cliSession) {
      this._handleCliMessage(ws, client, msg)
    } else {
      this._handlePtyMessage(ws, client, msg)
    }
  }

  /** Handle messages in multi-session mode */
  async _handleSessionMessage(ws, client, msg) {
    switch (msg.type) {
      case 'input': {
        const text = msg.data
        let attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined
        const entry = this.sessionManager.getSession(client.activeSessionId)
        if (!entry) {
          this._send(ws, { type: 'session_error', message: 'No active session' })
          break
        }

        // Validate attachments before processing
        if (attachments?.length) {
          const err = validateAttachments(attachments)
          if (err) {
            this._send(ws, { type: 'session_error', message: `Invalid attachment: ${err}` })
            attachments = undefined
            break
          }
        }

        // PTY sessions: forward raw input without trimming (keystrokes, \r, escape sequences)
        if (entry.type === 'pty') {
          if (attachments?.length) {
            this._send(ws, { type: 'session_error', message: 'File attachments are not supported in terminal mode' })
          }
          if (typeof text !== 'string') break
          if (text && text !== '\r' && text !== '\n') {
            console.log(`[ws] PTY input from ${client.id} to session ${client.activeSessionId}: "${text.replace(/[\r\n]/g, '\\n').slice(0, 80)}"`)
          }
          entry.session.expectEcho?.(text)
          entry.session.writeRaw(text)
        } else {
          // CLI sessions: trim and drop empty input (unless attachments present)
          if ((!text || !text.trim()) && !attachments?.length) break
          const trimmed = text?.trim() || ''
          const attCount = attachments?.length || 0
          console.log(`[ws] Message from ${client.id} to session ${client.activeSessionId}: "${trimmed.slice(0, 80)}"${attCount ? ` (+${attCount} attachment(s))` : ''}`)
          // Record user input in history (without base64 blobs)
          const historyText = attCount ? `${trimmed}${trimmed ? ' ' : ''}[${attCount} file(s) attached]` : trimmed
          this.sessionManager.recordUserInput(client.activeSessionId, historyText)
          entry.session.sendMessage(trimmed, attachments, { isVoice: !!msg.isVoice })
        }

        // Track last-writer-wins primary for this session
        this._updatePrimary(client.activeSessionId, client.id)
        break
      }

      case 'interrupt': {
        const entry = this.sessionManager.getSession(client.activeSessionId)
        if (entry) {
          console.log(`[ws] Interrupt from ${client.id} to session ${client.activeSessionId}`)
          entry.session.interrupt()
        }
        break
      }

      case 'set_model': {
        if (
          typeof msg.model === 'string' &&
          ALLOWED_MODEL_IDS.has(msg.model)
        ) {
          const entry = this.sessionManager.getSession(client.activeSessionId)
          if (entry) {
            if (entry.type === 'pty') {
              console.warn(`[ws] Rejected model change on PTY session ${client.activeSessionId} from ${client.id}`)
              this._send(ws, { type: 'session_error', message: 'Cannot change model on PTY sessions' })
            } else {
              console.log(`[ws] Model change from ${client.id} on session ${client.activeSessionId}: ${msg.model}`)
              entry.session.setModel(msg.model)
              this._broadcastToSession(client.activeSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
            }
          }
        } else {
          console.warn(`[ws] Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
        }
        break
      }

      case 'set_permission_mode': {
        if (
          typeof msg.mode === 'string' &&
          ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
        ) {
          const entry = this.sessionManager.getSession(client.activeSessionId)
          if (entry) {
            if (entry.type === 'pty') {
              console.warn(`[ws] Rejected permission mode change on PTY session ${client.activeSessionId} from ${client.id}`)
              this._send(ws, { type: 'session_error', message: 'Cannot change permission mode on PTY sessions' })
            } else if (msg.mode === 'auto' && !msg.confirmed) {
              console.log(`[ws] Auto mode requested by ${client.id}, awaiting confirmation`)
              this._send(ws, {
                type: 'confirm_permission_mode',
                mode: 'auto',
                warning: 'Auto mode bypasses all permission checks. Claude will execute tools without asking.',
              })
            } else {
              if (msg.mode === 'auto') {
                console.log(`[ws] Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()}`)
              } else {
                console.log(`[ws] Permission mode change from ${client.id} on session ${client.activeSessionId}: ${msg.mode}`)
              }
              entry.session.setPermissionMode(msg.mode)
              this._broadcastToSession(client.activeSessionId, { type: 'permission_mode_changed', mode: msg.mode })
            }
          }
        } else {
          console.warn(`[ws] Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
        }
        break
      }

      case 'permission_response': {
        const { requestId, decision } = msg
        if (!requestId || !decision) break

        // Route to the session that originated the permission request
        const originSessionId = this._permissionSessionMap.get(requestId) || client.activeSessionId
        this._permissionSessionMap.delete(requestId)

        // Try SDK-mode first (in-process permission)
        if (originSessionId && this.sessionManager) {
          const entry = this.sessionManager.getSession(originSessionId)
          if (entry && typeof entry.session.respondToPermission === 'function') {
            // Check if the permission is still pending before responding
            const hasPending = entry.session._pendingPermissions?.has(requestId)
            if (hasPending !== false) {
              // Either _pendingPermissions exists and has this requestId, or
              // _pendingPermissions doesn't exist (legacy mock) — let respondToPermission decide
              entry.session.respondToPermission(requestId, decision)
            } else {
              this._send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
            }
            break
          }
        }

        // Fall through to legacy HTTP-based permission resolution
        if (this._pendingPermissions.has(requestId)) {
          this._resolvePermission(requestId, decision)
        } else {
          this._send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
        }
        break
      }

      case 'list_sessions':
        this._send(ws, { type: 'session_list', sessions: this.sessionManager.listSessions() })
        break

      case 'switch_session': {
        const targetId = msg.sessionId
        const entry = this.sessionManager.getSession(targetId)
        if (!entry) {
          this._send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
          break
        }
        client.activeSessionId = targetId
        console.log(`[ws] Client ${client.id} switched to session ${targetId}`)
        this._send(ws, { type: 'session_switched', sessionId: targetId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
        this._sendSessionInfo(ws, targetId)
        this._replayHistory(ws, targetId)
        break
      }

      case 'create_session': {
        const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
        const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined

        // Validate cwd if provided
        if (cwd) {
          try {
            const stat = statSync(cwd)
            if (!stat.isDirectory()) {
              this._send(ws, { type: 'session_error', message: `Not a directory: ${cwd}` })
              break
            }
          } catch (err) {
            this._send(ws, { type: 'session_error', message: `Directory does not exist: ${cwd}` })
            break
          }
        }

        try {
          const sessionId = this.sessionManager.createSession({ name, cwd })
          // Auto-switch the creating client to the new session
          client.activeSessionId = sessionId
          const entry = this.sessionManager.getSession(sessionId)
          this._send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
          this._sendSessionInfo(ws, sessionId)
          // Broadcast updated session list to all clients
          this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
        } catch (err) {
          this._send(ws, { type: 'session_error', message: err.message })
        }
        break
      }

      case 'destroy_session': {
        const targetId = msg.sessionId
        if (!this.sessionManager.getSession(targetId)) {
          this._send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
          break
        }

        // Prevent destroying the last session
        if (this.sessionManager.listSessions().length <= 1) {
          this._send(ws, { type: 'session_error', message: 'Cannot destroy the last session' })
          break
        }

        this.sessionManager.destroySession(targetId)
        this._primaryClients.delete(targetId)

        // Auto-switch orphaned clients to the first remaining session
        const firstId = this.sessionManager.firstSessionId
        for (const [clientWs, c] of this.clients) {
          if (c.authenticated && c.activeSessionId === targetId) {
            c.activeSessionId = firstId
            const entry = this.sessionManager.getSession(firstId)
            if (entry) {
              this._send(clientWs, { type: 'session_switched', sessionId: firstId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
              this._sendSessionInfo(clientWs, firstId)
            }
          }
        }

        // Broadcast updated session list
        this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
        break
      }

      case 'rename_session': {
        const targetId = msg.sessionId
        const newName = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : null
        if (!newName) {
          this._send(ws, { type: 'session_error', message: 'Name is required' })
          break
        }
        if (this.sessionManager.renameSession(targetId, newName)) {
          this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
        } else {
          this._send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
        }
        break
      }

      case 'discover_sessions': {
        try {
          const tmuxSessions = this.sessionManager.discoverSessions()
          this._send(ws, { type: 'discovered_sessions', tmux: tmuxSessions })
        } catch (err) {
          this._send(ws, { type: 'session_error', message: err.message })
        }
        break
      }

      case 'trigger_discovery':
        if (this.sessionManager) {
          console.log(`[ws] Triggering on-demand discovery from ${client.id}`)
          this._send(ws, { type: 'discovery_triggered' })
          this.sessionManager.pollForNewSessions()
        }
        break

      case 'attach_session': {
        const tmuxSession = typeof msg.tmuxSession === 'string' ? msg.tmuxSession.trim() : null
        if (!tmuxSession) {
          this._send(ws, { type: 'session_error', message: 'tmuxSession is required' })
          break
        }
        // Validate session name to prevent shell injection (PtyManager uses execSync with session names)
        if (!/^[a-zA-Z0-9_.-]+$/.test(tmuxSession)) {
          this._send(ws, { type: 'session_error', message: 'Invalid tmux session name' })
          break
        }

        try {
          const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
          const sessionId = await this.sessionManager.attachSession({ tmuxSession, name })
          // Auto-switch the attaching client to the new session
          client.activeSessionId = sessionId
          const entry = this.sessionManager.getSession(sessionId)
          this._send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session?.resumeSessionId || null })
          this._sendSessionInfo(ws, sessionId)
          // Broadcast updated session list to all clients
          this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
        } catch (err) {
          console.error(`[ws] Failed to attach session (tmux: '${tmuxSession}'):`, err)
          this._send(ws, { type: 'session_error', message: err.message })
        }
        break
      }

      case 'resize': {
        const cols = msg.cols
        const rows = msg.rows
        if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) break
        const entry = this.sessionManager.getSession(client.activeSessionId)
        if (entry && entry.type === 'pty' && entry.session.resize) {
          entry.session.resize(cols, rows)
        }
        break
      }

      case 'user_question_response': {
        // Route to the session that originated the question
        const questionSessionId = (msg.toolUseId && this._questionSessionMap.get(msg.toolUseId))
          || client.activeSessionId
        if (msg.toolUseId) this._questionSessionMap.delete(msg.toolUseId)
        const entry = this.sessionManager.getSession(questionSessionId)
        if (entry && entry.type !== 'pty' && typeof entry.session.respondToQuestion === 'function' && typeof msg.answer === 'string') {
          entry.session.respondToQuestion(msg.answer)
        }
        break
      }

      case 'register_push_token':
        if (this.pushManager && typeof msg.token === 'string') {
          this.pushManager.registerToken(msg.token)
        }
        break

      case 'list_directory':
        this._listDirectory(ws, msg.path)
        break

      case 'browse_files': {
        const browseEntry = this.sessionManager.getSession(client.activeSessionId)
        this._browseFiles(ws, msg.path, browseEntry?.cwd || null)
        break
      }

      case 'read_file': {
        const readEntry = this.sessionManager.getSession(client.activeSessionId)
        this._readFile(ws, msg.path, readEntry?.cwd || null)
        break
      }

      case 'list_slash_commands': {
        const entry = this.sessionManager.getSession(client.activeSessionId)
        const cwd = entry?.cwd || null
        this._listSlashCommands(ws, cwd, client.activeSessionId)
        break
      }

      case 'list_agents': {
        const entry = this.sessionManager.getSession(client.activeSessionId)
        const cwd = entry?.cwd || null
        this._listAgents(ws, cwd, client.activeSessionId)
        break
      }

      case 'request_full_history': {
        const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
        if (!targetId || !this.sessionManager.getSession(targetId)) {
          this._send(ws, { type: 'session_error', message: 'No active session' })
          break
        }
        const fullHistory = await this.sessionManager.getFullHistoryAsync(targetId)
        this._send(ws, { type: 'history_replay_start', sessionId: targetId, fullHistory: true })
        for (const entry of fullHistory) {
          // Convert JSONL format to WS message format
          if (entry.type === 'user_input' || entry.type === 'response' || entry.type === 'tool_use') {
            this._send(ws, {
              type: 'message',
              messageType: entry.type,
              content: entry.content,
              tool: entry.tool,
              timestamp: entry.timestamp,
              sessionId: targetId,
            })
          } else {
            // Ring buffer entries already have WS format
            this._send(ws, { ...entry, sessionId: targetId })
          }
        }
        this._send(ws, { type: 'history_replay_end', sessionId: targetId })
        break
      }

      case 'mode':
        if (msg.mode === 'terminal' || msg.mode === 'chat') {
          client.mode = msg.mode
        }
        break

      case 'request_session_context': {
        const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
        if (!targetId) {
          this._send(ws, { type: 'session_error', message: 'No active session' })
          break
        }
        try {
          const ctx = await this.sessionManager.getSessionContext(targetId)
          if (ctx) {
            this._send(ws, { type: 'session_context', ...ctx })
          } else {
            this._send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
          }
        } catch (err) {
          console.warn(`[ws] Failed to read session context: ${err.message}`)
          this._send(ws, { type: 'session_error', message: `Failed to read session context: ${err.message}` })
        }
        break
      }

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`)
    }
  }

  /** Handle messages in legacy single CLI mode */
  _handleCliMessage(ws, client, msg) {
    switch (msg.type) {
      case 'input': {
        const text = msg.data
        let attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined
        if (attachments?.length) {
          const err = validateAttachments(attachments)
          if (err) {
            this._send(ws, { type: 'session_error', message: `Invalid attachment: ${err}` })
            attachments = undefined
            break
          }
        }
        if ((!text || !text.trim()) && !attachments?.length) break
        const trimmed = text?.trim() || ''
        const attCount = attachments?.length || 0
        console.log(`[ws] Message from ${client.id}: "${trimmed.slice(0, 80)}"${attCount ? ` (+${attCount} attachment(s))` : ''}`)
        this.cliSession.sendMessage(trimmed, attachments, { isVoice: !!msg.isVoice })
        // Track last-writer-wins primary (uses 'default' as pseudo session ID)
        this._updatePrimary('default', client.id)
        break
      }

      case 'interrupt':
        console.log(`[ws] Interrupt from ${client.id}`)
        this.cliSession.interrupt()
        break

      case 'set_model': {
        if (
          typeof msg.model === 'string' &&
          ALLOWED_MODEL_IDS.has(msg.model)
        ) {
          console.log(`[ws] Model change from ${client.id}: ${msg.model}`)
          this.cliSession.setModel(msg.model)
          // Broadcast model change to all authenticated clients
          this._broadcast({ type: 'model_changed', model: toShortModelId(msg.model) })
        } else {
          console.warn(`[ws] Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
        }
        break
      }

      case 'set_permission_mode': {
        if (
          typeof msg.mode === 'string' &&
          ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
        ) {
          if (msg.mode === 'auto' && !msg.confirmed) {
            console.log(`[ws] Auto mode requested by ${client.id}, awaiting confirmation`)
            this._send(ws, {
              type: 'confirm_permission_mode',
              mode: 'auto',
              warning: 'Auto mode bypasses all permission checks. Claude will execute tools without asking.',
            })
          } else {
            if (msg.mode === 'auto') {
              console.log(`[ws] Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()}`)
            } else {
              console.log(`[ws] Permission mode change from ${client.id}: ${msg.mode}`)
            }
            this.cliSession.setPermissionMode(msg.mode)
            this._broadcast({ type: 'permission_mode_changed', mode: msg.mode })
          }
        } else {
          console.warn(`[ws] Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
        }
        break
      }

      case 'permission_response': {
        const { requestId, decision } = msg
        if (requestId && decision) {
          this._resolvePermission(requestId, decision)
        }
        break
      }

      case 'user_question_response': {
        if (this.cliSession && typeof msg.answer === 'string') {
          this.cliSession.respondToQuestion(msg.answer)
        }
        break
      }

      case 'list_directory':
        this._listDirectory(ws, msg.path)
        break

      case 'browse_files':
        this._browseFiles(ws, msg.path, this.cliSession?.cwd || null)
        break

      case 'read_file':
        this._readFile(ws, msg.path, this.cliSession?.cwd || null)
        break

      case 'list_slash_commands': {
        const cwd = this.cliSession?.cwd || null
        this._listSlashCommands(ws, cwd, null)
        break
      }

      case 'list_agents': {
        const cwd = this.cliSession?.cwd || null
        this._listAgents(ws, cwd, null)
        break
      }

      case 'mode':
        if (msg.mode === 'terminal' || msg.mode === 'chat') {
          client.mode = msg.mode
        }
        break

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`)
    }
  }

  /** Handle messages in PTY mode */
  _handlePtyMessage(ws, client, msg) {
    switch (msg.type) {
      case 'input':
        // Forward keystrokes to the PTY
        if (msg.data && msg.data !== '\r' && msg.data !== '\n') {
          console.log(`[ws] Input from ${client.id}: "${msg.data.replace(/[\r\n]/g, '\\n').slice(0, 80)}"`)
        }
        if (typeof msg.data === 'string') {
          if (this.outputParser) this.outputParser.expectEcho(msg.data)
          this.ptyManager.write(msg.data)
          // Track last-writer-wins primary (uses 'default' as pseudo session ID)
          this._updatePrimary('default', client.id)
        }
        break

      case 'resize':
        if (Number.isInteger(msg.cols) && msg.cols > 0 && Number.isInteger(msg.rows) && msg.rows > 0) {
          this.ptyManager.resize(msg.cols, msg.rows)
        }
        break

      case 'permission_response': {
        const { requestId, decision } = msg
        if (requestId && decision) {
          this._resolvePermission(requestId, decision)
        }
        break
      }

      case 'list_directory':
        this._listDirectory(ws, msg.path)
        break

      case 'browse_files':
        this._browseFiles(ws, msg.path, null)
        break

      case 'read_file':
        this._readFile(ws, msg.path, null)
        break

      case 'list_slash_commands':
        this._listSlashCommands(ws, null, null)
        break

      case 'list_agents':
        this._listAgents(ws, null, null)
        break

      case 'mode':
        // Switch between terminal and chat view
        if (msg.mode === 'terminal' || msg.mode === 'chat') {
          client.mode = msg.mode
        }
        break

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`)
    }
  }

  /** Wire up SessionManager events to broadcast to clients (multi-session) */
  _setupSessionForwarding() {
    // Buffer stream deltas to reduce WS message volume (50ms batch window).
    // Keyed by sessionId:messageId composite to handle concurrent session streams.
    const deltaBuffer = new Map() // `${sessionId}:${messageId}` -> accumulated text
    let deltaFlushTimer = null
    const flushDeltas = () => {
      deltaFlushTimer = null
      for (const [key, delta] of deltaBuffer) {
        const [sessionId, messageId] = key.split(':', 2)
        this._broadcastToSession(sessionId, { type: 'stream_delta', messageId, delta })
      }
      deltaBuffer.clear()
    }

    this.sessionManager.on('session_event', ({ sessionId, event, data }) => {
      switch (event) {
        case 'ready': {
          const entry = this.sessionManager.getSession(sessionId)
          this._broadcastToSession(sessionId, { type: 'claude_ready' })
          if (entry) {
            this._broadcastToSession(sessionId, {
              type: 'model_changed',
              model: entry.session.model ? toShortModelId(entry.session.model) : null,
            })
            this._broadcastToSession(sessionId, {
              type: 'permission_mode_changed',
              mode: entry.session.permissionMode || 'approve',
            })
          }
          break
        }

        case 'conversation_id':
          this._broadcastToSession(sessionId, {
            type: 'conversation_id',
            sessionId,
            conversationId: data.conversationId,
          })
          // Broadcast updated session list (conversationId now available)
          this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
          break

        case 'stream_start':
          console.log(`[ws] Broadcasting stream_start: ${data.messageId} (session ${sessionId})`)
          this._broadcastToSession(sessionId, { type: 'stream_start', messageId: data.messageId })
          this._broadcastToSession(sessionId, { type: 'agent_busy' })
          // Broadcast updated session list so SessionPicker busy dot appears immediately
          this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
          break

        case 'stream_delta': {
          const key = `${sessionId}:${data.messageId}`
          const existing = deltaBuffer.get(key) || ''
          deltaBuffer.set(key, existing + data.delta)
          if (!deltaFlushTimer) {
            deltaFlushTimer = setTimeout(flushDeltas, 50)
          }
          break
        }

        case 'stream_end':
          // Flush remaining deltas for this session before sending stream_end
          if (deltaBuffer.size > 0) {
            const prefix = `${sessionId}:`
            for (const [key, delta] of deltaBuffer) {
              if (key.startsWith(prefix)) {
                const messageId = key.slice(prefix.length)
                this._broadcastToSession(sessionId, { type: 'stream_delta', messageId, delta })
                deltaBuffer.delete(key)
              }
            }
            // If we flushed everything and the timer is pending, cancel it
            if (deltaBuffer.size === 0 && deltaFlushTimer) {
              clearTimeout(deltaFlushTimer)
              deltaFlushTimer = null
            }
          }
          console.log(`[ws] Broadcasting stream_end: ${data.messageId} (session ${sessionId})`)
          this._broadcastToSession(sessionId, { type: 'stream_end', messageId: data.messageId })
          break

        case 'message':
          this._broadcastToSession(sessionId, {
            type: 'message',
            messageType: data.type,
            content: data.content,
            tool: data.tool,
            options: data.options,
            timestamp: data.timestamp,
          })
          break

        case 'tool_start':
          this._broadcastToSession(sessionId, { type: 'tool_start', messageId: data.messageId, toolUseId: data.toolUseId, tool: data.tool, input: data.input })
          break

        case 'tool_result':
          this._broadcastToSession(sessionId, {
            type: 'tool_result',
            toolUseId: data.toolUseId,
            result: data.result,
            truncated: data.truncated,
          })
          break

        case 'agent_spawned':
          this._broadcastToSession(sessionId, {
            type: 'agent_spawned',
            toolUseId: data.toolUseId,
            description: data.description,
            startedAt: data.startedAt,
          })
          break

        case 'agent_completed':
          this._broadcastToSession(sessionId, {
            type: 'agent_completed',
            toolUseId: data.toolUseId,
          })
          break

        case 'plan_started':
          this._broadcastToSession(sessionId, { type: 'plan_started' })
          break

        case 'plan_ready':
          this._broadcastToSession(sessionId, {
            type: 'plan_ready',
            allowedPrompts: data.allowedPrompts,
          })
          break

        case 'result':
          this._broadcastToSession(sessionId, { type: 'result', cost: data.cost, duration: data.duration, usage: data.usage, sessionId: data.sessionId })
          this._broadcastToSession(sessionId, { type: 'agent_idle' })
          // Broadcast updated session list (isBusy may have changed)
          this._broadcast({ type: 'session_list', sessions: this.sessionManager.listSessions() })
          // Refresh session context (git branch may have changed during the turn)
          this.sessionManager.getSessionContext(sessionId).then((ctx) => {
            if (ctx) this._broadcastToSession(sessionId, { type: 'session_context', ...ctx })
          }).catch(() => {})
          break

        case 'raw':
          // Forward raw PTY data only to clients actively viewing this session (bandwidth-heavy)
          this._broadcastToSession(sessionId, { type: 'raw', data }, (client) => client.mode === 'terminal' && client.activeSessionId === sessionId)
          // Also send as raw_background to chat-mode clients on this session
          this._broadcastToSession(sessionId, { type: 'raw_background', data }, (client) => client.mode === 'chat' && client.activeSessionId === sessionId)
          break

        case 'status_update':
          // Status bar metadata only goes to clients on this session (global claudeStatus would get confused)
          console.log(this._formatStatusLog(data))
          this._broadcastToSession(sessionId, { type: 'status_update', ...data }, (client) => client.activeSessionId === sessionId)
          break

        case 'user_question':
          this._questionSessionMap.set(data.toolUseId, sessionId)
          this._broadcastToSession(sessionId, {
            type: 'user_question',
            toolUseId: data.toolUseId,
            questions: data.questions,
          })
          break

        case 'permission_request':
          this._permissionSessionMap.set(data.requestId, sessionId)
          this._broadcastToSession(sessionId, {
            type: 'permission_request',
            requestId: data.requestId,
            tool: data.tool,
            description: data.description,
            input: data.input,
            remainingMs: data.remainingMs,
          })
          // Push notification
          if (this.pushManager) {
            this.pushManager.send('permission', 'Permission needed', `Claude wants to use: ${data.tool}`, { requestId: data.requestId, tool: data.tool }, 'permission')
          }
          break

        case 'error':
          this._broadcastToSession(sessionId, {
            type: 'message',
            messageType: 'error',
            content: data.message,
            timestamp: Date.now(),
          })
          break
      }
    })

    // Handle session crashes detected by health checks
    this.sessionManager.on('session_crashed', ({ sessionId, reason, error }) => {
      console.log(`[ws] Session ${sessionId} crashed (${reason}): ${error}`)
      this._broadcastToSession(sessionId, {
        type: 'session_error',
        message: `Session crashed: ${error}`,
        category: 'crash',
        recoverable: false,
      })
    })
  }

  /** Wire up CLI session events to broadcast to clients (legacy single-session) */
  _setupCliForwarding() {
    // Notify clients when Claude process is ready (initial start or respawn)
    this.cliSession.on('ready', () => {
      this._broadcast({ type: 'claude_ready' })
      this._broadcast({
        type: 'model_changed',
        model: this.cliSession.model ? toShortModelId(this.cliSession.model) : null,
      })
      this._broadcast({
        type: 'permission_mode_changed',
        mode: this.cliSession.permissionMode || 'approve',
      })
    })

    // Buffer stream deltas to reduce WS message volume (50ms batch window).
    // This prevents flooding mobile clients over cellular/tunnel connections.
    const deltaBuffer = new Map() // messageId -> accumulated text
    let deltaFlushTimer = null
    const flushDeltas = () => {
      deltaFlushTimer = null
      for (const [messageId, delta] of deltaBuffer) {
        this._broadcast({ type: 'stream_delta', messageId, delta })
      }
      deltaBuffer.clear()
    }

    this.cliSession.on('stream_start', ({ messageId }) => {
      console.log(`[ws] Broadcasting stream_start: ${messageId}`)
      this._broadcast({ type: 'stream_start', messageId })
    })

    this.cliSession.on('stream_delta', ({ messageId, delta }) => {
      const existing = deltaBuffer.get(messageId) || ''
      deltaBuffer.set(messageId, existing + delta)
      if (!deltaFlushTimer) {
        deltaFlushTimer = setTimeout(flushDeltas, 50)
      }
    })

    this.cliSession.on('stream_end', ({ messageId }) => {
      // Flush remaining deltas before sending stream_end
      if (deltaBuffer.size > 0) {
        if (deltaFlushTimer) {
          clearTimeout(deltaFlushTimer)
          deltaFlushTimer = null
        }
        flushDeltas()
      }
      console.log(`[ws] Broadcasting stream_end: ${messageId}`)
      this._broadcast({ type: 'stream_end', messageId })
    })

    this.cliSession.on('message', (message) => {
      this._broadcast({
        type: 'message',
        messageType: message.type,
        content: message.content,
        tool: message.tool,
        timestamp: message.timestamp,
      })
    })

    this.cliSession.on('tool_start', ({ messageId, toolUseId, tool, input }) => {
      this._broadcast({ type: 'tool_start', messageId, toolUseId, tool, input })
    })

    this.cliSession.on('result', ({ cost, duration, usage, sessionId }) => {
      this._broadcast({ type: 'result', cost, duration, usage, sessionId })
    })

    this.cliSession.on('user_question', (data) => {
      this._broadcast({
        type: 'user_question',
        toolUseId: data.toolUseId,
        questions: data.questions,
      })
    })

    this.cliSession.on('agent_spawned', (data) => {
      this._broadcast({ type: 'agent_spawned', ...data })
    })
    this.cliSession.on('agent_completed', (data) => {
      this._broadcast({ type: 'agent_completed', ...data })
    })

    this.cliSession.on('plan_started', () => {
      this._broadcast({ type: 'plan_started' })
    })
    this.cliSession.on('plan_ready', (data) => {
      this._broadcast({ type: 'plan_ready', allowedPrompts: data.allowedPrompts })
    })

    this.cliSession.on('error', ({ message }) => {
      this._broadcast({
        type: 'message',
        messageType: 'error',
        content: message,
        timestamp: Date.now(),
      })
    })
  }

  /** Wire up PTY + parser output to broadcast to clients */
  _setupPtyForwarding() {
    // Raw PTY data -> terminal view clients
    this.outputParser.on('raw', (data) => {
      this._broadcast(
        { type: 'raw', data },
        (client) => client.mode === 'terminal'
      )
    })

    // Parsed messages -> chat view clients (only messages after client connected)
    this.outputParser.on('message', (message) => {
      this._broadcast(
        {
          type: 'message',
          messageType: message.type,
          content: message.content,
          tool: message.tool,
          options: message.options,
          timestamp: message.timestamp,
        },
        (client) => client.mode === 'chat' && message.timestamp > (client.authTime || 0)
      )
    })

    // Also send raw to chat clients (they may need it for the
    // embedded terminal view or for fallback rendering)
    this.outputParser.on('raw', (data) => {
      this._broadcast(
        { type: 'raw_background', data },
        (client) => client.mode === 'chat'
      )
    })

    // Claude Code ready signal -> all clients
    this.outputParser.on('claude_ready', () => {
      this._broadcast({ type: 'claude_ready' })
    })

    // Status bar metadata -> all clients
    this.outputParser.on('status_update', (status) => {
      console.log(this._formatStatusLog(status))
      this._broadcast({ type: 'status_update', ...status })
    })
  }

  /** List directories at a given path, sending a directory_listing response */
  async _listDirectory(ws, requestedPath) {
    // Resolve path outside try so error responses can include the resolved path
    let absPath = null
    try {
      // Resolve path: expand ~ to homedir, default to homedir if empty
      const home = homedir()
      if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
        absPath = home
      } else {
        const trimmed = requestedPath.trim()
        absPath = trimmed.startsWith('~')
          ? resolve(home, trimmed.slice(1).replace(/^\//, ''))
          : resolve(trimmed)
      }
      absPath = normalize(absPath)

      // Restrict directory listing to the user's home directory
      if (!absPath.startsWith(home + '/') && absPath !== home) {
        this._send(ws, {
          type: 'directory_listing',
          path: absPath,
          parentPath: null,
          entries: [],
          error: 'Access denied: directory listing is restricted to the home directory',
        })
        return
      }

      const dirents = await readdir(absPath, { withFileTypes: true })
      const entries = dirents
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => ({ name: d.name, isDirectory: true }))

      // Compute parent path (null at filesystem root)
      const parentPath = absPath === '/' ? null : resolve(absPath, '..')

      this._send(ws, {
        type: 'directory_listing',
        path: absPath,
        parentPath,
        entries,
        error: null,
      })
    } catch (err) {
      let errorMessage
      if (err.code === 'ENOENT') errorMessage = 'Directory not found'
      else if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else if (err.code === 'ENOTDIR') errorMessage = 'Not a directory'
      else errorMessage = err.message || 'Unknown error'

      this._send(ws, {
        type: 'directory_listing',
        path: absPath || requestedPath || null,
        parentPath: null,
        entries: [],
        error: errorMessage,
      })
    }
  }

  /** Resolve a session CWD to its real path, caching the result to avoid repeated syscalls */
  async _resolveSessionCwd(sessionCwd) {
    const key = resolve(sessionCwd)
    if (this._cwdRealCache.has(key)) return this._cwdRealCache.get(key)
    const resolved = await realpath(key)
    this._cwdRealCache.set(key, resolved)
    return resolved
  }

  /** Browse files and directories at a given path within the session CWD */
  async _browseFiles(ws, requestedPath, sessionCwd) {
    if (!sessionCwd) {
      this._send(ws, {
        type: 'file_listing',
        path: null,
        parentPath: null,
        entries: [],
        error: 'File browsing is not available in this mode',
      })
      return
    }

    let absPath = null
    try {
      if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
        absPath = resolve(sessionCwd)
      } else {
        absPath = resolve(sessionCwd, requestedPath.trim())
      }
      absPath = normalize(absPath)

      // Resolve symlinks and restrict to session CWD
      const cwdReal = await this._resolveSessionCwd(sessionCwd)
      let realAbsPath
      try {
        realAbsPath = await realpath(absPath)
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Path doesn't exist — let readdir handle the error naturally
          realAbsPath = absPath
        } else {
          throw err
        }
      }
      if (!realAbsPath.startsWith(cwdReal + '/') && realAbsPath !== cwdReal) {
        this._send(ws, {
          type: 'file_listing',
          path: absPath,
          parentPath: null,
          entries: [],
          error: 'Access denied: browsing is restricted to the project directory',
        })
        return
      }

      const dirents = await readdir(realAbsPath, { withFileTypes: true })
      const entries = []
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue
        if (d.name === 'node_modules') continue
        const entry = { name: d.name, isDirectory: d.isDirectory(), size: null }
        if (!d.isDirectory()) {
          try {
            const s = await stat(join(realAbsPath, d.name))
            entry.size = s.size
          } catch (_) { /* skip size on error */ }
        }
        entries.push(entry)
      }

      // Sort: directories first, then files, alphabetical within each
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      // parentPath is null at CWD root
      const parentPath = realAbsPath === cwdReal ? null : resolve(realAbsPath, '..')

      this._send(ws, {
        type: 'file_listing',
        path: realAbsPath,
        parentPath,
        entries,
        error: null,
      })
    } catch (err) {
      let errorMessage
      if (err.code === 'ENOENT') errorMessage = 'Directory not found'
      else if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else if (err.code === 'ENOTDIR') errorMessage = 'Not a directory'
      else errorMessage = err.message || 'Unknown error'

      this._send(ws, {
        type: 'file_listing',
        path: absPath || requestedPath || null,
        parentPath: null,
        entries: [],
        error: errorMessage,
      })
    }
  }

  /** Read file content at a given path within the session CWD */
  async _readFile(ws, requestedPath, sessionCwd) {
    if (!sessionCwd) {
      this._send(ws, {
        type: 'file_content',
        path: null,
        content: null,
        language: null,
        size: null,
        truncated: false,
        error: 'File reading is not available in this mode',
      })
      return
    }

    if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
      this._send(ws, {
        type: 'file_content',
        path: null,
        content: null,
        language: null,
        size: null,
        truncated: false,
        error: 'No file path provided',
      })
      return
    }

    let absPath = null
    try {
      absPath = normalize(resolve(sessionCwd, requestedPath.trim()))

      // Resolve symlinks and restrict to session CWD
      const cwdReal = await this._resolveSessionCwd(sessionCwd)
      let realAbsPath
      try {
        realAbsPath = await realpath(absPath)
      } catch (err) {
        if (err.code === 'ENOENT') {
          realAbsPath = absPath // let stat() handle it below
        } else {
          throw err
        }
      }
      if (!realAbsPath.startsWith(cwdReal + '/') && realAbsPath !== cwdReal) {
        this._send(ws, {
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: null,
          truncated: false,
          error: 'Access denied: file reading is restricted to the project directory',
        })
        return
      }

      const fileStat = await stat(realAbsPath)
      if (fileStat.isDirectory()) {
        this._send(ws, {
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: null,
          truncated: false,
          error: 'Cannot read a directory',
        })
        return
      }

      if (fileStat.size > 512 * 1024) {
        this._send(ws, {
          type: 'file_content',
          path: absPath,
          content: null,
          language: null,
          size: fileStat.size,
          truncated: false,
          error: 'File too large (max 512KB)',
        })
        return
      }

      // Read file content (use resolved path to avoid following symlinks after check)
      const buf = await readFile(realAbsPath)

      // Binary detection: check first 8KB for null bytes
      const checkLen = Math.min(buf.length, 8192)
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) {
          this._send(ws, {
            type: 'file_content',
            path: absPath,
            content: null,
            language: null,
            size: fileStat.size,
            truncated: false,
            error: 'Binary file cannot be displayed',
          })
          return
        }
      }

      let content = buf.toString('utf-8')
      let truncated = false
      if (content.length > 100 * 1024) {
        content = content.slice(0, 100 * 1024)
        truncated = true
      }

      const ext = extname(absPath).slice(1).toLowerCase()

      this._send(ws, {
        type: 'file_content',
        path: absPath,
        content,
        language: ext || null,
        size: fileStat.size,
        truncated,
        error: null,
      })
    } catch (err) {
      let errorMessage
      if (err.code === 'ENOENT') errorMessage = 'File not found'
      else if (err.code === 'EACCES') errorMessage = 'Permission denied'
      else errorMessage = err.message || 'Unknown error'

      this._send(ws, {
        type: 'file_content',
        path: absPath || requestedPath || null,
        content: null,
        language: null,
        size: null,
        truncated: false,
        error: errorMessage,
      })
    }
  }

  /**
   * List available slash commands from project and user command directories.
   * When cwd is provided, walks .claude/commands/ in the project cwd first;
   * always walks ~/.claude/commands/ for user commands. In PTY mode cwd is
   * null, so only user commands are returned.
   * @param {WebSocket} ws - Client socket to send the response on
   * @param {string|null} cwd - Project working directory (null in PTY mode)
   * @param {string|null} sessionId - Session ID to tag on the response (multi-session mode)
   * Returns { type: 'slash_commands', commands: [{ name, description, source }], sessionId? }
   */
  async _listSlashCommands(ws, cwd, sessionId) {
    const commands = []
    const seen = new Set()

    const scanDir = async (dir, source) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue
          // Guard against names with path separators (defensive — readdir returns filenames only)
          if (entry.name.includes('/') || entry.name.includes('\\')) continue
          const name = entry.name.slice(0, -3) // strip .md
          if (seen.has(name)) continue
          seen.add(name)

          // Read first non-heading, non-empty line as description
          let description = ''
          try {
            const content = await readFile(join(dir, entry.name), 'utf-8')
            const lines = content.split('\n')
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith('#')) continue
              description = trimmed.slice(0, 120)
              break
            }
          } catch (err) {
            console.error(`[ws] Failed to read command file ${join(dir, entry.name)}:`, err.message)
          }

          commands.push({ name, description, source })
        }
      } catch {
        // Directory doesn't exist or is unreadable — expected for missing .claude/commands/
      }
    }

    // Project commands take priority (scanned first, so they win in the `seen` set)
    if (cwd) {
      await scanDir(join(cwd, '.claude', 'commands'), 'project')
    }
    await scanDir(join(homedir(), '.claude', 'commands'), 'user')

    commands.sort((a, b) => a.name.localeCompare(b.name))

    const response = { type: 'slash_commands', commands }
    if (sessionId) response.sessionId = sessionId
    this._send(ws, response)
  }

  /**
   * List custom agents from project and user agent directories.
   * When cwd is provided, walks .claude/agents/ in the project cwd first;
   * always walks ~/.claude/agents/ for user agents. In PTY mode cwd is
   * null, so only user agents are returned.
   * @param {WebSocket} ws - Client socket to send the response on
   * @param {string|null} cwd - Project working directory (null in PTY mode)
   * @param {string|null} sessionId - Session ID to tag on the response (multi-session mode)
   * Returns { type: 'agent_list', agents: [{ name, description, source }], sessionId? }
   */
  async _listAgents(ws, cwd, sessionId) {
    const agents = []
    const seen = new Set()

    const scanDir = async (dir, source) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue
          // Guard against names with path separators (defensive)
          if (entry.name.includes('/') || entry.name.includes('\\')) continue
          const name = entry.name.slice(0, -3) // strip .md
          if (seen.has(name)) continue
          seen.add(name)

          // Read first non-heading, non-empty line as description
          let description = ''
          try {
            const content = await readFile(join(dir, entry.name), 'utf-8')
            const lines = content.split('\n')
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith('#')) continue
              description = trimmed.slice(0, 120)
              break
            }
          } catch (err) {
            console.error(`[ws] Failed to read agent file ${join(dir, entry.name)}:`, err.message)
          }

          agents.push({ name, description, source })
        }
      } catch {
        // Directory doesn't exist or is unreadable — expected for missing .claude/agents/
      }
    }

    // Project agents take priority (scanned first, so they win in the `seen` set)
    if (cwd) {
      await scanDir(join(cwd, '.claude', 'agents'), 'project')
    }
    await scanDir(join(homedir(), '.claude', 'agents'), 'user')

    agents.sort((a, b) => a.name.localeCompare(b.name))

    const response = { type: 'agent_list', agents }
    if (sessionId) response.sessionId = sessionId
    this._send(ws, response)
  }

  /** Handle POST /permission from the hook script */
  _handlePermissionRequest(req, res) {
    // Validate Bearer token — reject unauthenticated requests (unless --no-auth)
    if (!this._validateBearerAuth(req, res)) {
      console.warn('[ws] Rejected unauthenticated POST /permission')
      return
    }

    // Enforce body size limit (64KB) to prevent memory exhaustion
    const MAX_BODY = 65536
    let body = ''
    let oversized = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        oversized = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (oversized) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny' }))
        return
      }

      let hookData
      try {
        hookData = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny' }))
        return
      }

      const requestId = `perm-${++this._permissionCounter}-${Date.now()}`

      console.log(`[ws] Permission request ${requestId}: ${hookData.tool_name || 'unknown tool'}`)

      // Build description from hook data (PreToolUse format: tool_name, tool_input)
      const tool = hookData.tool_name || 'Unknown tool'
      const toolInput = hookData.tool_input || {}
      const description = toolInput.description
        || toolInput.command
        || toolInput.file_path
        || toolInput.pattern
        || toolInput.query
        || JSON.stringify(toolInput).slice(0, 200)

      // Forward to all authenticated clients
      this._broadcast({
        type: 'permission_request',
        requestId,
        tool,
        description,
        input: toolInput,
        remainingMs: 300_000,
      })

      // Send push notification for permission — user may have the app backgrounded
      if (this.pushManager) {
        this.pushManager.send('permission', 'Permission needed', `Claude wants to use: ${tool}`, { requestId, tool }, 'permission')
      }

      // Track whether the HTTP connection has been closed (client disconnect / abort)
      let closed = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this._pendingPermissions.delete(requestId)
        this._permissionSessionMap.delete(requestId)
      }

      const onClose = () => {
        if (closed) return
        closed = true
        console.log(`[ws] Permission ${requestId} connection closed by client`)
        cleanup()
      }

      req.on('aborted', onClose)
      res.on('close', onClose)

      // Hold the HTTP response open until the app responds or timeout
      const timer = setTimeout(() => {
        if (closed) return
        closed = true
        console.log(`[ws] Permission ${requestId} timed out, auto-denying`)
        cleanup()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny' }))
      }, 300_000) // 5 minutes

      this._pendingPermissions.set(requestId, {
        resolve: (decision) => {
          if (closed) return
          closed = true
          cleanup()
          console.log(`[ws] Permission ${requestId} resolved: ${decision}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ decision }))
        },
        timer,
        data: { requestId, tool, description, input: toolInput, remainingMs: 300_000, createdAt: Date.now() },
      })
    })
  }

  /** Handle POST /permission-response from iOS notification actions (HTTP fallback) */
  _handlePermissionResponseHttp(req, res) {
    if (!this._validateBearerAuth(req, res)) {
      console.warn('[ws] Rejected unauthenticated POST /permission-response')
      return
    }

    const MAX_BODY = 4096
    let body = ''
    let oversized = false
    req.on('data', (chunk) => {
      if (oversized) return
      body += chunk
      if (body.length > MAX_BODY) {
        oversized = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'body too large' }))
      }
    })
    req.on('end', () => {
      if (oversized) return

      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON' }))
        return
      }

      const { requestId, decision } = parsed
      if (!requestId || typeof requestId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing requestId' }))
        return
      }

      const validDecisions = ['allow', 'deny', 'allowAlways']
      if (!validDecisions.includes(decision)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `invalid decision, must be one of: ${validDecisions.join(', ')}` }))
        return
      }

      // Try SDK-mode first (in-process permission via sessionManager)
      const originSessionId = this._permissionSessionMap.get(requestId)
      if (originSessionId && this.sessionManager) {
        const entry = this.sessionManager.getSession(originSessionId)
        if (entry && typeof entry.session.respondToPermission === 'function') {
          this._permissionSessionMap.delete(requestId)
          entry.session.respondToPermission(requestId, decision)
          console.log(`[ws] Permission ${requestId} resolved via HTTP: ${decision} (SDK)`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
      }

      // Fall back to legacy HTTP-held permission
      const pending = this._pendingPermissions.get(requestId)
      if (pending) {
        this._permissionSessionMap.delete(requestId)
        this._resolvePermission(requestId, decision)
        console.log(`[ws] Permission ${requestId} resolved via HTTP: ${decision} (legacy)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown or expired requestId' }))
      }
    })
  }

  /** Re-send any pending permission requests to a newly connected/reconnected client */
  _resendPendingPermissions(ws) {
    // SDK-mode: check all sessions for pending permissions
    if (this.sessionManager?._sessions instanceof Map) {
      for (const [sessionId, entry] of this.sessionManager._sessions) {
        if (entry.session?._pendingPermissions instanceof Map) {
          for (const [requestId] of entry.session._pendingPermissions) {
            const permData = entry.session._lastPermissionData?.get(requestId)
            if (permData) {
              const elapsed = Math.max(0, Date.now() - (permData.createdAt ?? Date.now()))
              const ttl = permData.remainingMs ?? PERMISSION_TTL_MS
              const remainingMs = Math.min(ttl, Math.max(0, ttl - elapsed))
              if (remainingMs <= 0) {
                console.log(`[ws] Skipping expired permission ${requestId}`)
                continue
              }
              console.log(`[ws] Re-sending pending permission ${requestId} to reconnected client (${Math.round(remainingMs / 1000)}s remaining)`)
              // Ensure permission response routing survives reconnect
              this._permissionSessionMap.set(requestId, sessionId)
              // Strip createdAt — it's internal server state, not part of the client protocol
              const { createdAt: _ca, remainingMs: _origMs, ...clientPayload } = permData
              this._send(ws, { type: 'permission_request', ...clientPayload, remainingMs, sessionId })
            }
          }
        }
      }
    }

    // Legacy HTTP-held permissions
    for (const [requestId, pending] of this._pendingPermissions) {
      if (pending.data) {
        const elapsed = Math.max(0, Date.now() - (pending.data.createdAt ?? Date.now()))
        const ttl = pending.data.remainingMs ?? PERMISSION_TTL_MS
        const remainingMs = Math.min(ttl, Math.max(0, ttl - elapsed))
        if (remainingMs <= 0) {
          console.log(`[ws] Skipping expired legacy permission ${requestId}`)
          continue
        }
        console.log(`[ws] Re-sending pending legacy permission ${requestId} to reconnected client (${Math.round(remainingMs / 1000)}s remaining)`)
        // Strip createdAt — it's internal server state, not part of the client protocol
        const { createdAt: _ca, remainingMs: _origMs, ...clientPayload } = pending.data
        this._send(ws, { type: 'permission_request', ...clientPayload, remainingMs })
      }
    }
  }

  /** Resolve a pending permission request (called when app sends permission_response) */
  _resolvePermission(requestId, decision) {
    const pending = this._pendingPermissions.get(requestId)
    if (pending) {
      pending.resolve(decision)
    } else {
      console.warn(`[ws] No pending permission for ${requestId}`)
    }
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
   * session state. The optional `filter` callback restricts delivery (e.g.,
   * raw PTY data is only sent to clients actively viewing the session).
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
    if (this._pingInterval) {
      clearInterval(this._pingInterval)
      this._pingInterval = null
    }
    if (this._authCleanupInterval) {
      clearInterval(this._authCleanupInterval)
      this._authCleanupInterval = null
    }

    // Auto-deny any pending permission requests
    for (const [, pending] of this._pendingPermissions) {
      clearTimeout(pending.timer)
      try { pending.resolve('deny') } catch {}
    }
    this._pendingPermissions.clear()
    this._permissionSessionMap.clear()
    this._questionSessionMap.clear()
    this._primaryClients.clear()

    for (const [ws] of this.clients) {
      ws.close()
    }
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
  }
}
