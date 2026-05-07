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
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
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

// Ring-buffer capacity: number of output frames retained per session for
// replay on resume. Tunable at startup via CHROXY_AGENT_BUFFER_SIZE.
// Reject non-positive / NaN values so an invalid env var cannot disable
// eviction (NaN >= length is always false → unbounded buffer growth).
const FALLBACK_BUFFER_SIZE = 1000
const _PARSED_BUFFER_SIZE = parseInt(process.env.CHROXY_AGENT_BUFFER_SIZE ?? `${FALLBACK_BUFFER_SIZE}`, 10)
const DEFAULT_BUFFER_SIZE = Number.isFinite(_PARSED_BUFFER_SIZE) && _PARSED_BUFFER_SIZE > 0
  ? _PARSED_BUFFER_SIZE
  : FALLBACK_BUFFER_SIZE

// Maximum bytes buffered for a single NDJSON line on stdout.  If a line
// grows beyond this the child is killed, an error frame is emitted, and the
// WS is closed cleanly.  1 MiB is far above any normal SDK event but tight
// enough to prevent unbounded memory growth in constrained pods.
// Override at pod startup via CHROXY_AGENT_MAX_LINE_BYTES.
const FALLBACK_MAX_LINE_BYTES = 1024 * 1024  // 1 MiB
const _PARSED_MAX_LINE_BYTES = parseInt(process.env.CHROXY_AGENT_MAX_LINE_BYTES ?? `${FALLBACK_MAX_LINE_BYTES}`, 10)
export const DEFAULT_MAX_LINE_BYTES = Number.isFinite(_PARSED_MAX_LINE_BYTES) && _PARSED_MAX_LINE_BYTES > 0
  ? _PARSED_MAX_LINE_BYTES
  : FALLBACK_MAX_LINE_BYTES

// Idle resume window: how long a disconnected session waits for the client to
// reconnect before the child is killed and the session is evicted. Prevents
// orphaned child processes accumulating in long-lived pods.
// Configurable via CHROXY_AGENT_RESUME_TIMEOUT_MS (default 60 s).
const FALLBACK_RESUME_TIMEOUT_MS = 60_000
const _PARSED_RESUME_TIMEOUT = parseInt(process.env.CHROXY_AGENT_RESUME_TIMEOUT_MS ?? `${FALLBACK_RESUME_TIMEOUT_MS}`, 10)
const DEFAULT_RESUME_TIMEOUT_MS = Number.isFinite(_PARSED_RESUME_TIMEOUT) && _PARSED_RESUME_TIMEOUT > 0
  ? _PARSED_RESUME_TIMEOUT
  : FALLBACK_RESUME_TIMEOUT_MS

// Hard cap on concurrent sessions. When a new spawn would exceed the cap the
// oldest idle session (by lastActiveAt) is evicted first. Defense-in-depth
// against a client that reconnects repeatedly without resuming.
// Configurable via CHROXY_AGENT_MAX_SESSIONS (default 8).
const FALLBACK_MAX_SESSIONS = 8
const _PARSED_MAX_SESSIONS = parseInt(process.env.CHROXY_AGENT_MAX_SESSIONS ?? `${FALLBACK_MAX_SESSIONS}`, 10)
const DEFAULT_MAX_SESSIONS = Number.isFinite(_PARSED_MAX_SESSIONS) && _PARSED_MAX_SESSIONS > 0
  ? _PARSED_MAX_SESSIONS
  : FALLBACK_MAX_SESSIONS

// --- Auth token -----------------------------------------------------------------
// Read once at boot. If unset we stay up (dev convenience) but reject all WS
// upgrades so the agent is fail-secure in production.
const AGENT_TOKEN = process.env.CHROXY_AGENT_TOKEN ?? null

// Token-bearing env var names that must NOT leak into the spawned child's
// environment. The child is the user-facing CLI; agent-internal credentials
// have no business being readable from inside it.
const AGENT_SECRET_ENV_KEYS = ['CHROXY_AGENT_TOKEN']

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

// ---------------------------------------------------------------------------
// LineLimitTransform — guards readline from unbounded line growth.
//
// Sits between child.stdout and readline.createInterface.  Counts raw bytes
// in the current (not-yet-newline-terminated) fragment; if the running total
// exceeds maxBytes it emits an 'oversized_line' event on the transform
// instance and drops all further data so readline never buffers the overrun.
// The caller is responsible for killing the child and closing the WS.
// ---------------------------------------------------------------------------

export class LineLimitTransform extends Transform {
  /**
   * @param {object} opts
   * @param {number} opts.maxBytes  Maximum bytes per line before firing the
   *                                'oversized_line' event.  Must be a finite
   *                                positive number; falls back to
   *                                DEFAULT_MAX_LINE_BYTES if invalid.
   */
  constructor({ maxBytes, ...streamOpts } = {}) {
    super(streamOpts)
    this._maxBytes = Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : DEFAULT_MAX_LINE_BYTES
    this._pending = 0   // bytes counted in the current un-terminated line
    this._fired = false // emit the event at most once per instance
  }

  _transform(chunk, _encoding, callback) {
    if (this._fired) {
      // Already tripped — drop all further data so readline never sees it.
      callback()
      return
    }

    let offset = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a /* '\n' */) {
        // Newline resets the pending counter for the next line.
        this._pending = 0
        offset = i + 1
      } else {
        this._pending += 1
        if (this._pending > this._maxBytes) {
          this._fired = true
          // Pass through whatever bytes came before this overrun so readline
          // can flush any complete lines already buffered.
          this.push(chunk.slice(0, offset))
          this.emit('oversized_line')
          callback()
          return
        }
      }
    }
    this.push(chunk)
    callback()
  }

  _flush(callback) {
    callback()
  }
}

// --- PodAgent class -------------------------------------------------------------

export class PodAgent {
  /**
   * @param {object} opts
   * @param {Function} [opts.spawnFn]         Override child_process.spawn for tests.
   * @param {string}   [opts.token]           Override CHROXY_AGENT_TOKEN for tests.
   * @param {number}   [opts.killGraceMs]     Override SIGTERM→SIGKILL grace (tests).
   * @param {number}   [opts.bufferSize]      Override ring-buffer capacity per session (tests).
   * @param {number}   [opts.maxLineBytes]    Override NDJSON line length cap (tests).
   * @param {number}   [opts.resumeTimeoutMs] Override idle resume window in ms (tests).
   * @param {number}   [opts.maxSessions]     Override concurrent session cap (tests).
   * @param {Function} [opts.setTimeoutFn]    Override setTimeout for deterministic timer tests.
   * @param {Function} [opts.clearTimeoutFn]  Override clearTimeout for deterministic timer tests.
   */
  constructor({ spawnFn = nodeSpawn, token = AGENT_TOKEN, killGraceMs = KILL_GRACE_MS,
    bufferSize = DEFAULT_BUFFER_SIZE,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    resumeTimeoutMs = DEFAULT_RESUME_TIMEOUT_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout } = {}) {
    this._spawnFn = spawnFn
    this._token = token
    this._killGraceMs = killGraceMs
    // Validate bufferSize defensively — a NaN or non-positive value would
    // disable eviction (NaN >= length is always false) and let the buffer
    // grow without bound.
    this._bufferSize = Number.isFinite(bufferSize) && bufferSize > 0
      ? bufferSize
      : FALLBACK_BUFFER_SIZE
    this._maxLineBytes = Number.isFinite(maxLineBytes) && maxLineBytes > 0
      ? maxLineBytes
      : FALLBACK_MAX_LINE_BYTES
    this._resumeTimeoutMs = Number.isFinite(resumeTimeoutMs) && resumeTimeoutMs > 0
      ? resumeTimeoutMs
      : FALLBACK_RESUME_TIMEOUT_MS
    this._maxSessions = Number.isFinite(maxSessions) && maxSessions > 0
      ? maxSessions
      : FALLBACK_MAX_SESSIONS
    this._setTimeoutFn = setTimeoutFn
    this._clearTimeoutFn = clearTimeoutFn

    // Fail-secure warning. Emitted from the constructor (not module-load) so
    // tests and embedders that pass an explicit `token` don't see a misleading
    // log line, and the message reflects the actual configured behaviour.
    if (!this._token) {
      console.warn('[chroxy-pod-agent] WARNING: no auth token configured — all WS upgrades will be rejected')
    }

    this.httpServer = createServer((req, res) => this._handleHttp(req, res))
    this.wss = new WebSocketServer({ noServer: true })

    // Only one active client at a time. A second connection attempt is rejected
    // with an explicit error frame rather than silently queued or allowed to
    // clobber the first. K8sBackend is the sole consumer; concurrent connections
    // would indicate a bug in the backend reconnect logic.
    this._activeWs = null

    // Live sessions, keyed by sessionId. A session persists beyond its current
    // WS connection so that a reconnecting client can resume after a network
    // blip. Structure:
    //   { sessionId, child, activeWs, seq, buffer: Array<{seq, frame}>,
    //     lastActiveAt: number, idleTimer: TimerHandle|null }
    // `activeWs` is null while disconnected.
    // `idleTimer` fires when the resume window expires and evicts the session.
    this._sessions = new Map()

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
      // Kill children for all live sessions and cancel any idle timers.
      for (const session of this._sessions.values()) {
        this._cancelIdleTimer(session)
        if (session.child) {
          this._killChild(session.child)
          session.child = null
        }
        if (session.activeWs) {
          try { session.activeWs.terminate() } catch {}
          session.activeWs = null
        }
      }
      this._sessions.clear()

      // Also handle any active WS not yet associated with a session.
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
    ws._sessionId = null  // set by _handleSpawn / _handleResume

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
  // Connection cleanup — detach WS from session (child keeps running for
  // resume). Kill the child only if the session has no sessionId (pre-spawn
  // disconnect) because the child was never tracked in _sessions.
  // For sessions with a sessionId, start the idle-resume timer so the session
  // is evicted if the client does not reconnect within the resume window.
  // Idempotent: safe to call from both 'close' and 'error' handlers.
  // ---------------------------------------------------------------------------

  _cleanupConnection(ws) {
    const sessionId = ws._sessionId
    if (sessionId) {
      const session = this._sessions.get(sessionId)
      if (session && session.activeWs === ws) {
        session.activeWs = null
        // Start the idle-resume timer. The child stays alive until the timer
        // fires so a reconnecting client can resume within the window.
        this._startIdleTimer(session)
      }
    } else {
      // Pre-spawn connection — no session yet; kill any tracked child directly.
      if (ws._child) {
        this._killChild(ws._child)
        ws._child = null
      }
    }
    if (this._activeWs === ws) this._activeWs = null
  }

  // ---------------------------------------------------------------------------
  // Idle-resume timer — started when a session's WS disconnects. If the
  // client does not resume within _resumeTimeoutMs the session is evicted:
  // child is killed and the session is removed from _sessions.
  // ---------------------------------------------------------------------------

  _startIdleTimer(session) {
    // Idempotent guard: don't arm a second timer if one is already running.
    if (session.idleTimer !== null) return

    session.idleTimer = this._setTimeoutFn(() => {
      session.idleTimer = null
      this._evictSession(session, 'idle_timeout')
    }, this._resumeTimeoutMs)

    // Don't keep the event loop alive just for the eviction timer.
    if (session.idleTimer && typeof session.idleTimer.unref === 'function') {
      session.idleTimer.unref()
    }
  }

  _cancelIdleTimer(session) {
    if (session.idleTimer !== null) {
      this._clearTimeoutFn(session.idleTimer)
      session.idleTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Session eviction — kill the child, drop from _sessions. Called by the
  // idle timer or by the max-sessions cap enforcer.
  // ---------------------------------------------------------------------------

  _evictSession(session, reason) {
    const { sessionId, child } = session

    console.warn(`[chroxy-pod-agent] Evicting session ${sessionId} reason=${reason}`)

    if (child) {
      this._killChild(child)
      session.child = null
    }

    // If the session still has an activeWs at eviction time (e.g. evicted by
    // the size cap while a connection is live), close it cleanly.
    if (session.activeWs) {
      try { session.activeWs.close(1001, 'session evicted') } catch {}
      session.activeWs = null
    }

    this._sessions.delete(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Size-cap enforcer — evict the oldest idle session (by lastActiveAt) when
  // _sessions.size >= _maxSessions. Called before inserting a new session.
  // ---------------------------------------------------------------------------

  _enforceSessionCap() {
    if (this._sessions.size < this._maxSessions) return

    // Prefer evicting idle sessions (no activeWs) over live ones.
    let evictTarget = null
    for (const session of this._sessions.values()) {
      if (session.activeWs !== null) continue
      if (evictTarget === null || session.lastActiveAt < evictTarget.lastActiveAt) {
        evictTarget = session
      }
    }

    // Fall back to evicting the globally oldest session if all are active.
    if (evictTarget === null) {
      for (const session of this._sessions.values()) {
        if (evictTarget === null || session.lastActiveAt < evictTarget.lastActiveAt) {
          evictTarget = session
        }
      }
    }

    if (evictTarget) {
      this._cancelIdleTimer(evictTarget)
      this._evictSession(evictTarget, 'max_sessions')
    }
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

    if (msg.type === 'resume') {
      this._handleResume(ws, msg)
      return
    }

    if (msg.type === 'stdin') {
      this._handleStdin(ws, msg)
      return
    }

    if (msg.type === 'stdin_end') {
      this._handleStdinEnd(ws)
      return
    }

    this._send(ws, { type: 'error', message: `unknown message type: ${msg.type}` })
  }

  // ---------------------------------------------------------------------------
  // Spawn a child process and pipe its output back over WS
  // ---------------------------------------------------------------------------

  _handleSpawn(ws, msg) {
    const { cmd, args = [], env = {}, cwd, stdin: stdinMode = 'pipe' } = msg

    if (!cmd) {
      this._send(ws, { type: 'error', message: 'spawn: cmd is required' })
      return
    }

    // One spawn per connection. K8sBackend (#3320) is the sole consumer and
    // assumes single-child semantics; a second 'spawn' frame indicates a bug
    // upstream rather than a feature.
    //
    // We reject any second spawn while this WS is already bound to a session,
    // even if the child has just exited and the session-cleanup timer has not
    // yet fired (#3328 race window between child 'close' and the 50 ms WS-
    // close timer). After natural exit the agent closes the WS — clients are
    // expected to open a fresh connection rather than re-spawn on the same one.
    if (ws._sessionId && this._sessions.has(ws._sessionId)) {
      this._send(ws, { type: 'error', message: 'spawn: child already running' })
      return
    }

    // stdin option controls how the child's stdin is set up (#3329):
    //   'pipe'    — (default) writable stdin; client feeds data via stdin frames.
    //               Required for --input-format stream-json workflows.
    //   'inherit' — child inherits the agent's stdin (useful when running
    //               interactively; not meaningful when the agent has no tty).
    //   'ignore'  — child stdin is /dev/null; correct for fire-and-forget -p runs.
    // Any unrecognised value falls back to 'pipe'.
    const validStdinModes = ['pipe', 'inherit', 'ignore']
    const resolvedStdin = validStdinModes.includes(stdinMode) ? stdinMode : 'pipe'

    // Build the child env: start from the agent's env, strip agent-only
    // secrets, then layer the per-spawn env on top. This prevents the auth
    // token (and any future agent-internal credentials) from leaking into
    // the user-facing CLI process.
    const sanitizedAgentEnv = { ...process.env }
    for (const key of AGENT_SECRET_ENV_KEYS) {
      delete sanitizedAgentEnv[key]
    }
    const spawnOpts = {
      stdio: [resolvedStdin, 'pipe', 'pipe'],
      env: { ...sanitizedAgentEnv, ...env },
    }
    if (cwd) spawnOpts.cwd = cwd

    let child
    try {
      child = this._spawnFn(cmd, args, spawnOpts)
    } catch (err) {
      this._send(ws, { type: 'error', message: `spawn failed: ${err.message}` })
      return
    }

    // Spawn succeeded -- now enforce the concurrent session cap. Evicts the
    // oldest idle session if needed so the Map never exceeds _maxSessions.
    // Enforcing after spawn ensures a failed spawn (ENOENT, EACCES, etc.)
    // never evicts an existing session unnecessarily (#3392).
    this._enforceSessionCap()

    // Assign a sessionId and create the session object.
    const sessionId = randomUUID()
    const session = {
      sessionId,
      child,
      activeWs: ws,
      seq: 0,
      buffer: [],
      lastActiveAt: Date.now(),
      idleTimer: null,
    }
    this._sessions.set(sessionId, session)
    ws._sessionId = sessionId

    // Notify the client so it can store the sessionId for future resume.
    this._send(ws, { type: 'session_started', sessionId })

    // Sentinel: emit a recognisable per-spawn stderr frame immediately after
    // the spawn is accepted so that integration tests can assert the sidecar
    // code specifically handled the spawn (not a shorter path that bypasses
    // the agent). The format `[chroxy-pod-agent] spawn cmd=…` is distinct
    // from real child stderr and stable enough to grep reliably. See #3344.
    this._emitSessionFrame(session, {
      type: 'stderr',
      data: `[chroxy-pod-agent] spawn cmd=${cmd} args=${JSON.stringify(args)} sessionId=${sessionId}\n`,
    })

    // Handle async spawn failures (ENOENT, EACCES) so an unhandled 'error'
    // event does not crash the agent process. Spawn errors arrive after the
    // synchronous spawn() returns, which is why this can't go in the catch
    // block above.
    child.on('error', (err) => {
      if (session.child === child) session.child = null
      this._emitSessionFrame(session, { type: 'error', message: `spawn failed: ${err.message}` })
      // Async spawn never produced a child — there will be no 'close' event
      // to clean up the session. Synthesize an exit and drop the session
      // entry so the agent does not leak it indefinitely.
      this._emitSessionFrame(session, { type: 'exit', code: -1 })
      setTimeout(() => {
        if (session.activeWs && session.activeWs.readyState === 1) {
          session.activeWs.close(1000, 'spawn failed')
        }
        this._cancelIdleTimer(session)
        this._sessions.delete(sessionId)
      }, 50)
    })

    // stdout — read line-by-line; each NDJSON line becomes one 'event' frame.
    //
    // A LineLimitTransform sits upstream of readline and counts raw bytes per
    // line.  If a line exceeds _maxLineBytes (default 1 MiB) before a newline
    // arrives the transform fires 'oversized_line', the child is killed, an
    // error frame is emitted, and the WS is closed cleanly.  This prevents a
    // runaway tool result or streaming bug from growing the readline internal
    // buffer without bound and OOM-ing the pod.
    const lineGuard = new LineLimitTransform({ maxBytes: this._maxLineBytes })
    lineGuard.once('oversized_line', () => {
      console.error(`[chroxy-pod-agent] stdout line exceeded ${this._maxLineBytes} bytes — killing child`)
      session._oversized = true
      if (session.child === child) {
        this._killChild(child)
        session.child = null
      }
      this._emitSessionFrame(session, {
        type: 'error',
        code: 'line_too_long',
        message: `stdout line exceeded max length (${this._maxLineBytes} bytes) — child killed`,
      })
      setTimeout(() => {
        if (session.activeWs && session.activeWs.readyState === 1) {
          session.activeWs.close(1008, 'line_too_long')
        }
        this._sessions.delete(sessionId)
      }, 50)
    })
    child.stdout.pipe(lineGuard)

    const rl = createInterface({ input: lineGuard })
    rl.on('line', (line) => {
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        // Not valid JSON — forward as raw data inside the payload string.
        payload = line
      }
      this._emitSessionFrame(session, { type: 'event', payload })
    })

    // stderr — forward raw text as 'stderr' frames.
    child.stderr.on('data', (chunk) => {
      this._emitSessionFrame(session, { type: 'stderr', data: chunk.toString() })
    })

    // exit — emit exit code and close the WS. Clear the tracked child so the
    // disconnect handler does not try to kill an already-exited process.
    //
    // If the session was terminated by the oversized-line guard, the error
    // frame and WS close are already handled there.  Emitting a spurious exit
    // frame here would contradict the protocol (client already received
    // error+close(1008)) and could confuse K8sBackend.  Skip the exit path.
    child.on('close', (code) => {
      if (session.child === child) session.child = null
      if (session._oversized) return
      const exitFrame = { type: 'exit', code: code ?? 1 }
      this._emitSessionFrame(session, exitFrame)
      // Small delay so the exit frame is flushed before we close.
      setTimeout(() => {
        if (session.activeWs && session.activeWs.readyState === 1) {
          session.activeWs.close(1000, 'process exited')
        }
        // Cancel any pending idle timer and remove session from map.
        this._cancelIdleTimer(session)
        this._sessions.delete(sessionId)
      }, 50)
    })
  }

  // ---------------------------------------------------------------------------
  // stdin — forward data from the client into the child's stdin stream (#3329).
  //
  // Sequencing rules:
  //   - Must come AFTER spawn (ws._sessionId must be set and session must exist).
  //   - Must come BEFORE exit (session.child must still be alive).
  //   - Only usable when the child was spawned with stdin: 'pipe'; if stdin is
  //     'ignore' or 'inherit', child.stdin is null and the write is silently dropped.
  // ---------------------------------------------------------------------------

  _handleStdin(ws, msg) {
    const sessionId = ws._sessionId
    if (!sessionId) {
      this._send(ws, { type: 'error', message: 'stdin: no active session (send spawn first)' })
      return
    }

    const session = this._sessions.get(sessionId)
    if (!session) {
      this._send(ws, { type: 'error', message: 'stdin: no active session (send spawn first)' })
      return
    }

    const { data } = msg
    if (typeof data !== 'string') {
      this._send(ws, { type: 'error', message: 'stdin: data must be a string' })
      return
    }

    // child.stdin is null when spawned with stdin: 'ignore' or 'inherit'.
    // Silently drop — the caller may not know the mode.
    if (!session.child || !session.child.stdin) return

    try {
      session.child.stdin.write(data)
    } catch {
      // Ignore write errors — child may have closed its stdin already.
    }
  }

  // ---------------------------------------------------------------------------
  // stdin_end — signal EOF on the child's stdin (#3329).
  //
  // After this the child sees EOF on stdin. For --input-format stream-json this
  // causes claude to stop reading and begin processing the buffered input.
  // Subsequent stdin frames after stdin_end are silently dropped (stdin.end()
  // is idempotent on a WritableStream).
  // ---------------------------------------------------------------------------

  _handleStdinEnd(ws) {
    const sessionId = ws._sessionId
    if (!sessionId) {
      this._send(ws, { type: 'error', message: 'stdin_end: no active session (send spawn first)' })
      return
    }

    const session = this._sessions.get(sessionId)
    if (!session) {
      this._send(ws, { type: 'error', message: 'stdin_end: no active session (send spawn first)' })
      return
    }

    // No-op if stdin was not piped.
    if (!session.child || !session.child.stdin) return

    try {
      session.child.stdin.end()
    } catch {
      // Ignore — child may have already closed.
    }
  }

  // ---------------------------------------------------------------------------
  // Resume — re-attach a reconnecting client to an existing session
  // ---------------------------------------------------------------------------

  _handleResume(ws, msg) {
    const { sessionId, lastSeq = 0 } = msg

    const session = this._sessions.get(sessionId)
    if (!session) {
      this._send(ws, { type: 'session_lost', sessionId, reason: 'unknown_session' })
      return
    }

    // Single-client policy: if the session already has a live WS attached,
    // reject the second connection (same error behaviour as _handleConnection).
    if (session.activeWs) {
      this._send(ws, { type: 'error', message: 'another client is already connected' })
      ws.close(1008, 'already connected')
      return
    }

    // Resume arrived within the window — cancel the idle eviction timer.
    this._cancelIdleTimer(session)

    // Resume-with-gap detection (#3347).
    // If the oldest seq still in the ring buffer is greater than `lastSeq + 1`,
    // some events between (lastSeq, oldestSeq) were evicted by buffer overflow.
    // Silent partial replay would corrupt the client's NDJSON stream — surface
    // it as session_lost so the consumer can take recovery action (exit -2).
    if (session.buffer.length > 0 && session.buffer[0].seq > lastSeq + 1) {
      this._send(ws, { type: 'session_lost', sessionId, reason: 'buffer_overflow' })
      ws.close(1008, 'resume gap')
      return
    }

    // Attach this WS to the session and refresh activity timestamp.
    session.activeWs = ws
    session.lastActiveAt = Date.now()
    ws._sessionId = sessionId

    // Replay any buffered frames the client hasn't seen yet (seq > lastSeq).
    let replayedCount = 0
    for (const entry of session.buffer) {
      if (entry.seq > lastSeq) {
        this._send(ws, entry.frame)
        replayedCount += 1
      }
    }

    // Emit an explicit `resumed` frame so the client can confirm the resume
    // succeeded and reset its per-blip retry counter (#3348). Without this
    // frame the client treats `maxRetries` as a lifetime budget rather than
    // a per-disconnect budget. PROTOCOL.md documents this frame.
    this._send(ws, {
      type: 'resumed',
      sessionId,
      lastSeq,
      replayedCount,
    })
  }

  // ---------------------------------------------------------------------------
  // Session-scoped frame emission — assigns seq, ring-buffers, and sends
  // ---------------------------------------------------------------------------

  _emitSessionFrame(session, frame) {
    session.seq += 1
    session.lastActiveAt = Date.now()
    const seqFrame = { ...frame, seq: session.seq }

    // Ring buffer: drop oldest entry when at capacity.
    if (session.buffer.length >= this._bufferSize) {
      session.buffer.shift()
    }
    session.buffer.push({ seq: session.seq, frame: seqFrame })

    if (session.activeWs) {
      this._send(session.activeWs, seqFrame)
    }
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
