#!/usr/bin/env node
// chroxy-pod-agent — in-pod WebSocket agent for K8s sidecar environments.
//
// Starts an HTTP server with a /healthz endpoint and a WebSocket upgrade path.
// K8sBackend (#3320) connects here to spawn claude processes and stream their
// output back over the WS connection.
//
// Auth pattern adapted from packages/server/src/ws-server.js (token validation
// + ping/pong heartbeat). Spawn/stream pattern inspired by cli-session.js but
// intentionally minimal — this is a stdio↔WS pipe, not a full CliSession.

import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { spawn as nodeSpawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const _pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'))
const VERSION = _pkg.version

const PORT = parseInt(process.env.PORT ?? '7681', 10)

// Grace period between SIGTERM and SIGKILL when killing a child whose WS has
// disconnected. Long enough for claude to flush; short enough that a stuck
// child does not pin pod memory.
const KILL_GRACE_MS = 5_000

// --- Auth token -----------------------------------------------------------------
// Read once at boot. If unset we stay up (dev convenience) but reject all WS
// upgrades so the agent is fail-secure in production.
const AGENT_TOKEN = process.env.CHROXY_AGENT_TOKEN ?? null

if (!AGENT_TOKEN) {
  console.warn('[chroxy-pod-agent] WARNING: CHROXY_AGENT_TOKEN is not set — all WS upgrades will be rejected')
}

// Constant-time token comparison — adapted from token-compare.js in the main server.
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
  if (maxLen === 0) return false
  const paddedA = Buffer.alloc(maxLen)
  const paddedB = Buffer.alloc(maxLen)
  bufA.copy(paddedA)
  bufB.copy(paddedB)
  return valid && timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length
}

// --- PodAgent class -------------------------------------------------------------

export class PodAgent {
  /**
   * @param {object} opts
   * @param {Function} [opts.spawnFn]      Override child_process.spawn for tests.
   * @param {string}   [opts.token]        Override CHROXY_AGENT_TOKEN for tests.
   * @param {number}   [opts.killGraceMs]  Override SIGTERM→SIGKILL grace (tests).
   */
  constructor({ spawnFn = nodeSpawn, token = AGENT_TOKEN, killGraceMs = KILL_GRACE_MS } = {}) {
    this._spawnFn = spawnFn
    this._token = token
    this._killGraceMs = killGraceMs

    this.httpServer = createServer((req, res) => this._handleHttp(req, res))
    this.wss = new WebSocketServer({ noServer: true })

    // Only one active client at a time. A second connection attempt is rejected
    // with an explicit error frame rather than silently queued or allowed to
    // clobber the first. K8sBackend is the sole consumer; concurrent connections
    // would indicate a bug in the backend reconnect logic.
    this._activeWs = null

    // Ping/pong state mirrors ws-server.js: send ping every 30 s, terminate if
    // no pong received within the next cycle.
    this._pingInterval = null

    this.httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head))
    this.wss.on('connection', (ws) => this._handleConnection(ws))
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  listen(port = PORT, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.httpServer.listen(port, host, (err) => {
        if (err) { reject(err); return }
        const addr = this.httpServer.address()
        console.log(`[chroxy-pod-agent] Listening on ${addr.address}:${addr.port}`)
        this._startPingInterval()
        resolve(addr.port)
      })
      this.httpServer.once('error', reject)
    })
  }

  close() {
    return new Promise((resolve) => {
      if (this._pingInterval) {
        clearInterval(this._pingInterval)
        this._pingInterval = null
      }
      // Kill any in-flight child and force-close the active WS so wss.close()
      // does not hang waiting for the client to disconnect.
      if (this._activeWs) {
        if (this._activeWs._child) {
          this._killChild(this._activeWs._child)
          this._activeWs._child = null
        }
        try { this._activeWs.terminate() } catch {}
        this._activeWs = null
      }
      this.wss.close(() => {
        this.httpServer.close(() => resolve())
      })
    })
  }

  // ---------------------------------------------------------------------------
  // HTTP handler — /healthz requires no auth (K8s probes)
  // ---------------------------------------------------------------------------

  _handleHttp(req, res) {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body = JSON.stringify({ ok: true, version: VERSION })
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  }

  // ---------------------------------------------------------------------------
  // WS upgrade — auth gate
  // ---------------------------------------------------------------------------

  _handleUpgrade(req, socket, head) {
    const authHeader = req.headers['authorization'] ?? ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

    // Fail-secure: reject if no token configured at boot.
    if (!this._token) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      console.warn('[chroxy-pod-agent] Rejected upgrade: no CHROXY_AGENT_TOKEN configured')
      return
    }

    if (!bearer || !safeTokenCompare(bearer, this._token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      console.warn('[chroxy-pod-agent] Rejected upgrade: invalid token')
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  // ---------------------------------------------------------------------------
  // WS connection
  // ---------------------------------------------------------------------------

  _handleConnection(ws) {
    // Reject second concurrent connection with a clear error frame, then close.
    // We send the error frame first and close only after the send is flushed so
    // the client reliably receives the frame before the WS close handshake.
    if (this._activeWs) {
      const msg = JSON.stringify({ type: 'error', message: 'another client is already connected' })
      ws.send(msg, () => ws.close(1008, 'already connected'))
      return
    }

    this._activeWs = ws
    ws._isAlive = true
    ws._child = null

    ws.on('pong', () => { ws._isAlive = true })
    ws.on('message', (data) => this._handleMessage(ws, data))
    ws.on('close', () => {
      this._cleanupConnection(ws)
    })
    ws.on('error', (err) => {
      console.error('[chroxy-pod-agent] WS error:', err.message)
      this._cleanupConnection(ws)
    })
  }

  // ---------------------------------------------------------------------------
  // Connection cleanup — kill any in-flight child so the pod does not leak
  // PIDs/memory across reconnect cycles. Idempotent: safe to call from both
  // 'close' and 'error' handlers, and again from agent.close().
  // ---------------------------------------------------------------------------

  _cleanupConnection(ws) {
    if (ws._child) {
      this._killChild(ws._child)
      ws._child = null
    }
    if (this._activeWs === ws) this._activeWs = null
  }

  // ---------------------------------------------------------------------------
  // Kill an orphaned child: SIGTERM, then SIGKILL after grace if still alive.
  // ---------------------------------------------------------------------------

  _killChild(child) {
    if (child._chroxyKilled) return
    child._chroxyKilled = true
    try { child.kill('SIGTERM') } catch {}
    const graceTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, this._killGraceMs)
    // Don't keep the process alive just to wait for an unresponsive child.
    if (typeof graceTimer.unref === 'function') graceTimer.unref()
    // If the child exits before the grace expires, cancel the SIGKILL timer.
    child.once('close', () => clearTimeout(graceTimer))
  }

  // ---------------------------------------------------------------------------
  // Incoming frames from client
  // ---------------------------------------------------------------------------

  _handleMessage(ws, data) {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      this._send(ws, { type: 'error', message: 'invalid JSON' })
      return
    }

    if (msg.type === 'ping') {
      this._send(ws, { type: 'pong' })
      return
    }

    if (msg.type === 'spawn') {
      this._handleSpawn(ws, msg)
      return
    }

    // #3321 will add 'resume' handling here for session reconnect support.

    this._send(ws, { type: 'error', message: `unknown message type: ${msg.type}` })
  }

  // ---------------------------------------------------------------------------
  // Spawn a child process and pipe its output back over WS
  // ---------------------------------------------------------------------------

  _handleSpawn(ws, msg) {
    const { cmd, args = [], env = {}, cwd } = msg

    if (!cmd) {
      this._send(ws, { type: 'error', message: 'spawn: cmd is required' })
      return
    }

    // One spawn per connection. K8sBackend (#3320) is the sole consumer and
    // assumes single-child semantics; a second 'spawn' frame indicates a bug
    // upstream rather than a feature.
    if (ws._child) {
      this._send(ws, { type: 'error', message: 'spawn: child already running' })
      return
    }

    const spawnOpts = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    }
    if (cwd) spawnOpts.cwd = cwd

    let child
    try {
      child = this._spawnFn(cmd, args, spawnOpts)
    } catch (err) {
      this._send(ws, { type: 'error', message: `spawn failed: ${err.message}` })
      return
    }

    // Track the child on the WS so a disconnect can kill it (see _cleanupConnection).
    ws._child = child

    // stdout — read line-by-line; each NDJSON line becomes one 'event' frame.
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (ws.readyState !== 1) return
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        // Not valid JSON — forward as raw data inside the payload string.
        payload = line
      }
      this._send(ws, { type: 'event', payload })
    })

    // stderr — forward raw text as 'stderr' frames.
    child.stderr.on('data', (chunk) => {
      if (ws.readyState !== 1) return
      this._send(ws, { type: 'stderr', data: chunk.toString() })
    })

    // exit — emit exit code and close the WS. Clear the tracked child so the
    // disconnect handler does not try to kill an already-exited process.
    child.on('close', (code) => {
      if (ws._child === child) ws._child = null
      this._send(ws, { type: 'exit', code: code ?? 1 })
      // Small delay so the exit frame is flushed before we close.
      setTimeout(() => {
        if (ws.readyState === 1) ws.close(1000, 'process exited')
      }, 50)
    })
  }

  // ---------------------------------------------------------------------------
  // Ping/pong keepalive — mirrors ws-server.js interval logic
  // ---------------------------------------------------------------------------

  _startPingInterval() {
    this._pingInterval = setInterval(() => {
      if (!this._activeWs) return
      const ws = this._activeWs
      if (ws.readyState !== 1) return
      if (!ws._isAlive) {
        console.warn('[chroxy-pod-agent] Client unresponsive, terminating')
        // terminate() does not always fire 'close'; clean up the child here
        // to guarantee the orphan-PID path is closed even on hard terminate.
        this._cleanupConnection(ws)
        ws.terminate()
        return
      }
      ws._isAlive = false
      try { ws.ping() } catch {}
    }, 30_000)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _send(ws, obj) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(obj))
    } catch {
      // ignore send errors on a closing socket
    }
  }
}

// ---------------------------------------------------------------------------
// Entrypoint — only runs when executed directly, not when imported in tests.
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const agent = new PodAgent()
  agent.listen(PORT).catch((err) => {
    console.error('[chroxy-pod-agent] Failed to start:', err)
    process.exit(1)
  })

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`[chroxy-pod-agent] ${sig} received, shutting down`)
      agent.close().then(() => process.exit(0))
    })
  }
}
