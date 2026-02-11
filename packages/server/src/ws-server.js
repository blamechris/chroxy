import { createServer } from 'http'
import { execFileSync } from 'child_process'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import { statSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { timingSafeEqual } from 'crypto'
import { MODELS, ALLOWED_MODEL_IDS, toShortModelId } from './models.js'

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
 *
 * Server -> Client:
 *   All session-scoped messages include a `sessionId` field for background sync.
 *   { type: 'auth_ok', clientId, serverMode, serverVersion, serverCommit, cwd, connectedClients } — auth succeeded with server context
 *   { type: 'auth_fail',    reason: '...' }           — auth failed
 *   { type: 'server_mode',  mode: 'cli'|'terminal' }  — which backend mode is active
 *   { type: 'raw',          data: '...' }             — raw PTY output (terminal view)
 *   { type: 'message',      ... }                     — parsed chat message
 *   { type: 'stream_start', messageId: '...' }        — beginning of streaming response
 *   { type: 'stream_delta', messageId, delta }         — token-by-token text
 *   { type: 'stream_end',   messageId: '...' }        — streaming response complete
 *   { type: 'tool_start',   messageId, tool, input }   — tool invocation
 *   { type: 'result',       ... }                     — query stats
 *   { type: 'status',       connected: true }         — connection status
 *   { type: 'claude_ready' }                          — Claude Code ready for input
 *   { type: 'model_changed', model: '...' }          — active model updated
 *   { type: 'available_models', models: [...] }       — models the server accepts
 *   { type: 'permission_request', requestId, tool, description, input } — permission prompt
 *   { type: 'confirm_permission_mode', mode, warning } — server challenges auto mode (client must re-send with confirmed: true)
 *   { type: 'permission_mode_changed', mode: '...' } — permission mode updated
 *   { type: 'available_permission_modes', modes: [...] } — permission modes
 *   { type: 'session_list', sessions: [...] }         — all sessions
 *   { type: 'session_switched', sessionId, name, cwd } — switched active session
 *   { type: 'session_created', sessionId, name }      — new session created
 *   { type: 'session_destroyed', sessionId }          — session removed
 *   { type: 'session_error', message, category?, sessionId?, recoverable? } — session operation error
 *   { type: 'discovered_sessions', tmux: [...] }     — host tmux session scan results
 *   { type: 'discovery_triggered' }                  — ack that on-demand discovery started
 *   { type: 'history_replay_start', sessionId }      — beginning of history replay
 *   { type: 'history_replay_end', sessionId }         — end of history replay
 *   { type: 'raw_background', data: '...' }           — raw PTY data for chat-mode clients
 *   { type: 'status_update', model, cost, ... }       — Claude Code status bar metadata
 *   { type: 'user_question', toolUseId, questions }   — AskUserQuestion prompt from Claude
 *   { type: 'agent_busy' }                           — agent started processing (per-session)
 *   { type: 'agent_idle' }                           — agent finished processing (per-session)
 *   { type: 'plan_started' }                         — Claude entered plan mode (transient)
 *   { type: 'plan_ready', allowedPrompts }           — plan complete, awaiting approval (transient)
 *   { type: 'server_status', message }               — non-error status update (e.g., recovery)
 *   { type: 'server_error', category, message, recoverable } — server-side error forwarded to app
 *   { type: 'client_joined', client: { clientId, deviceName, deviceType, platform } } — new client connected
 *   { type: 'client_left', clientId }                — client disconnected
 *   { type: 'primary_changed', sessionId, clientId } — last-writer-wins primary changed (null on disconnect)
 */
export class WsServer {
  constructor({ port, apiToken, ptyManager, outputParser, cliSession, sessionManager, defaultSessionId, authRequired = true, pushManager = null }) {
    this.port = port
    this.apiToken = apiToken
    this.ptyManager = ptyManager || null
    this.outputParser = outputParser || null
    this.authRequired = authRequired
    this.clients = new Map() // ws -> { id, authenticated, mode, activeSessionId, isAlive, deviceInfo }
    this.httpServer = null
    this.wss = null
    this._pingInterval = null
    this._pendingPermissions = new Map() // requestId -> { resolve, timer }
    this._permissionCounter = 0
    this._primaryClients = new Map() // sessionId -> clientId (last-writer-wins)
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
        res.end(JSON.stringify({ status: 'ok', mode: this.serverMode }))
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

      res.writeHead(404)
      res.end()
    })

    // WebSocket server in noServer mode — we handle the upgrade manually
    this.wss = new WebSocketServer({ noServer: true })

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
        this._handleMessage(ws, msg)
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const client = this.clients.get(ws)
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
      serverCommit: this._gitInfo.commit,
      cwd: sessionInfo.cwd,
      connectedClients: this._getConnectedClientList(),
    })
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
        this._send(ws, { type: 'session_switched', sessionId: activeId, name: entry.name, cwd: entry.cwd })
        this._sendSessionInfo(ws, activeId)
        this._replayHistory(ws, activeId)
      }

      this._send(ws, { type: 'available_models', models: MODELS })
      this._send(ws, { type: 'available_permission_modes', modes: PERMISSION_MODES })
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

    this._send(ws, { type: 'history_replay_start', sessionId })
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
  _handleMessage(ws, msg) {
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
        const entry = this.sessionManager.getSession(client.activeSessionId)
        if (!entry) {
          this._send(ws, { type: 'session_error', message: 'No active session' })
          break
        }

        // PTY sessions: forward raw input without trimming (keystrokes, \r, escape sequences)
        if (entry.type === 'pty') {
          if (typeof text !== 'string') break
          if (text && text !== '\r' && text !== '\n') {
            console.log(`[ws] PTY input from ${client.id} to session ${client.activeSessionId}: "${text.replace(/[\r\n]/g, '\\n').slice(0, 80)}"`)
          }
          entry.session.expectEcho?.(text)
          entry.session.writeRaw(text)
        } else {
          // CLI sessions: trim and drop empty input
          if (!text || !text.trim()) break
          console.log(`[ws] Message from ${client.id} to session ${client.activeSessionId}: "${text.slice(0, 80)}"`)
          entry.session.sendMessage(text.trim())
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

        // Try SDK-mode first (in-process permission)
        if (client.activeSessionId && this.sessionManager) {
          const entry = this.sessionManager.getSession(client.activeSessionId)
          if (entry && typeof entry.session.respondToPermission === 'function') {
            entry.session.respondToPermission(requestId, decision)
            break
          }
        }

        // Fall through to legacy HTTP-based permission resolution
        this._resolvePermission(requestId, decision)
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
        this._send(ws, { type: 'session_switched', sessionId: targetId, name: entry.name, cwd: entry.cwd })
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
          this._send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd })
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
              this._send(clientWs, { type: 'session_switched', sessionId: firstId, name: entry.name, cwd: entry.cwd })
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
          this._send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd })
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
        // Forward resize to PTY sessions
        const entry = this.sessionManager.getSession(client.activeSessionId)
        if (entry && entry.type === 'pty' && entry.session.resize) {
          entry.session.resize(msg.cols, msg.rows)
        }
        break
      }

      case 'user_question_response': {
        const entry = this.sessionManager.getSession(client.activeSessionId)
        if (entry && entry.type === 'cli' && typeof msg.answer === 'string') {
          entry.session.respondToQuestion(msg.answer)
        }
        break
      }

      case 'register_push_token':
        if (this.pushManager && typeof msg.token === 'string') {
          this.pushManager.registerToken(msg.token)
        }
        break

      case 'mode':
        if (msg.mode === 'terminal' || msg.mode === 'chat') {
          client.mode = msg.mode
        }
        break

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`)
    }
  }

  /** Handle messages in legacy single CLI mode */
  _handleCliMessage(ws, client, msg) {
    switch (msg.type) {
      case 'input': {
        const text = msg.data
        if (!text || !text.trim()) break
        console.log(`[ws] Message from ${client.id}: "${text.slice(0, 80)}"`)
        this.cliSession.sendMessage(text.trim())
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
        this.ptyManager.resize(msg.cols, msg.rows)
        break

      case 'permission_response': {
        const { requestId, decision } = msg
        if (requestId && decision) {
          this._resolvePermission(requestId, decision)
        }
        break
      }

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
          this._broadcastToSession(sessionId, { type: 'tool_start', messageId: data.messageId, tool: data.tool, input: data.input })
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
          this._broadcastToSession(sessionId, {
            type: 'user_question',
            toolUseId: data.toolUseId,
            questions: data.questions,
          })
          break

        case 'permission_request':
          this._broadcastToSession(sessionId, {
            type: 'permission_request',
            requestId: data.requestId,
            tool: data.tool,
            description: data.description,
            input: data.input,
          })
          // Push notification
          if (this.pushManager) {
            this.pushManager.send('permission', 'Permission needed', `Claude wants to use: ${data.tool}`, { requestId: data.requestId, tool: data.tool })
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

    this.cliSession.on('tool_start', ({ messageId, tool, input }) => {
      this._broadcast({ type: 'tool_start', messageId, tool, input })
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
      })

      // Send push notification for permission — user may have the app backgrounded
      if (this.pushManager) {
        this.pushManager.send('permission', 'Permission needed', `Claude wants to use: ${tool}`, { requestId, tool })
      }

      // Track whether the HTTP connection has been closed (client disconnect / abort)
      let closed = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this._pendingPermissions.delete(requestId)
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
      })
    })
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
    try {
      ws.send(JSON.stringify(message))
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
    this._primaryClients.clear()

    for (const [ws] of this.clients) {
      ws.close()
    }
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
  }
}
