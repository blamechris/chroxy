import { EventEmitter } from 'events'
import { CloudflareTunnelAdapter } from './tunnel/cloudflare.js'
import { createLogger } from './logger.js'

const log = createLogger('dev-preview')

/**
 * Detects when Claude starts a localhost dev server and creates
 * an ephemeral Cloudflare quick tunnel so the phone can preview it.
 *
 * Listens to tool_result events from sessions, scans output for
 * localhost server patterns, spawns a secondary tunnel, and emits
 * a dev_preview event for the WS layer to broadcast.
 *
 * Lifecycle:
 *   - One tunnel per (sessionId, port) pair
 *   - Auto-cleanup when session is destroyed
 *   - Manual close via closePreview()
 *
 * Events emitted:
 *   dev_preview_started     { sessionId, port, url }
 *   dev_preview_stopped     { sessionId, port }
 *   dev_preview_error       { sessionId, port, error }   — tunnel START failure
 *   dev_preview_stop_failed { sessionId, port, error }   — tunnel STOP failure (#5731)
 */

// Patterns that indicate a dev server started on localhost
const SERVER_PATTERNS = [
  // "listening on port 3000", "listening at port 8080"
  /listening\s+(?:on|at)\s+(?:port\s+)?(\d{2,5})/i,
  // "http://localhost:3000", "http://127.0.0.1:5173"
  /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/i,
  // "Local:   http://localhost:5173"  (Vite)
  /Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/i,
  // "ready on 0.0.0.0:3000", "started on port 8080"
  /(?:ready|started|running|serving)\s+(?:on|at)\s+(?:(?:0\.0\.0\.0|localhost|127\.0\.0\.1):)?(?:port\s+)?(\d{2,5})/i,
  // "Server is running on port 3000"
  /server\s+is\s+running\s+on\s+port\s+(\d{2,5})/i,
]

// Ports to ignore (common non-dev-server ports)
const IGNORED_PORTS = new Set([22, 80, 443, 5432, 3306, 6379, 27017])

// Reasonable dev server port range
const MIN_PORT = 1024
const MAX_PORT = 65535

export class DevPreviewManager extends EventEmitter {
  constructor() {
    super()
    // Map<string, Map<number, CloudflareTunnelAdapter>>  sessionId -> port -> tunnel
    this._tunnels = new Map()
    // Set<string> of "sessionId:port" keys currently being started (prevent duplicates)
    this._starting = new Set()
  }

  /**
   * Detect localhost server port from tool result text.
   * Returns the port number if found, null otherwise.
   */
  detectPort(text) {
    if (!text || typeof text !== 'string') return null
    for (const pattern of SERVER_PATTERNS) {
      const match = text.match(pattern)
      if (match) {
        const port = parseInt(match[1], 10)
        if (port >= MIN_PORT && port <= MAX_PORT && !IGNORED_PORTS.has(port)) {
          return port
        }
      }
    }
    return null
  }

  /**
   * Handle a tool_result event from a session.
   * If it contains a server start pattern, creates a preview tunnel.
   */
  async handleToolResult(sessionId, result) {
    const port = this.detectPort(result)
    if (!port) return

    // Already have a tunnel for this session+port
    if (this._getTunnel(sessionId, port)) return

    // Already starting one
    const key = `${sessionId}:${port}`
    if (this._starting.has(key)) return
    this._starting.add(key)

    try {
      await this._createPreviewTunnel(sessionId, port)
    } finally {
      this._starting.delete(key)
    }
  }

  /**
   * Create a preview tunnel for the given session and port.
   *
   * The tunnel object is registered in _tunnels BEFORE start() is called so
   * that closeSession() can find and stop it even if destruction races the
   * 30-second startup window (preventing zombie cloudflared processes).
   */
  async _createPreviewTunnel(sessionId, port) {
    const tunnel = new CloudflareTunnelAdapter({ port, mode: 'quick' })

    // Register before starting so closeSession() can reach it during startup
    if (!this._tunnels.has(sessionId)) {
      this._tunnels.set(sessionId, new Map())
    }
    this._tunnels.get(sessionId).set(port, tunnel)

    try {
      const { httpUrl } = await tunnel.start()
      log.info(`Tunnel started for session ${sessionId} port ${port}: ${httpUrl}`)

      // Check whether the session was destroyed while we were waiting for start()
      if (this._getTunnel(sessionId, port) !== tunnel) {
        // Session was closed during startup — stop the tunnel immediately
        log.info(`Session ${sessionId} destroyed during tunnel startup, stopping port ${port}`)
        try { await tunnel.stop() } catch { /* ignore */ }
        return
      }

      log.info(`Tunnel started for session ${sessionId} port ${port}: ${httpUrl}`)
      this.emit('dev_preview_started', { sessionId, port, url: httpUrl })
    } catch (err) {
      log.error(`Failed to create tunnel for port ${port}: ${err.message}`)
      this.emit('dev_preview_error', { sessionId, port, error: err.message })
      // Remove the placeholder entry left by pre-registration
      const sessionTunnels = this._tunnels.get(sessionId)
      if (sessionTunnels) {
        sessionTunnels.delete(port)
        if (sessionTunnels.size === 0) this._tunnels.delete(sessionId)
      }
      // Clean up failed tunnel
      try { await tunnel.stop() } catch { /* ignore */ }
    }
  }

  /**
   * Close a specific preview tunnel.
   */
  async closePreview(sessionId, port) {
    const tunnel = this._getTunnel(sessionId, port)
    if (!tunnel) return

    // #5731: capture (don't swallow) a stop() failure. The previous code
    // signalled a clean stop unconditionally — if tunnel.stop() threw, the
    // public tunnel (and thus the exposed local port) could still be live while
    // the user was told it was shut down.
    let stopError = null
    try {
      await tunnel.stop()
    } catch (err) {
      stopError = err
    }

    // Drop our tracking entry regardless: the tunnel handle is unusable for a
    // retry whether or not stop() succeeded, so keeping it would only wedge the
    // port slot. The UI still gets dev_preview_stopped so it doesn't show a
    // phantom live preview.
    const sessionTunnels = this._tunnels.get(sessionId)
    if (sessionTunnels) {
      sessionTunnels.delete(port)
      if (sessionTunnels.size === 0) this._tunnels.delete(sessionId)
    }

    if (stopError) {
      // Surface it so the user can verify / kill cloudflared manually instead of
      // assuming the port is no longer exposed. Normalize the message — a promise
      // rejection isn't guaranteed to be an Error (could be a string/null), so
      // `.message` alone can drop the actual detail.
      const stopMsg = stopError?.message || String(stopError)
      log.error(`Failed to stop tunnel for session ${sessionId} port ${port}: ${stopMsg}${stopError?.stack ? '\n' + stopError.stack : ''}`)
      this.emit('dev_preview_stop_failed', { sessionId, port, error: stopMsg })
    } else {
      log.info(`Tunnel stopped for session ${sessionId} port ${port}`)
    }
    this.emit('dev_preview_stopped', { sessionId, port })
  }

  /**
   * Close all preview tunnels for a session.
   */
  async closeSession(sessionId) {
    const sessionTunnels = this._tunnels.get(sessionId)
    if (!sessionTunnels) return

    const ports = [...sessionTunnels.keys()]
    for (const port of ports) {
      await this.closePreview(sessionId, port)
    }
  }

  /**
   * Close all preview tunnels.
   */
  async closeAll() {
    const sessionIds = [...this._tunnels.keys()]
    for (const sessionId of sessionIds) {
      await this.closeSession(sessionId)
    }
  }

  /**
   * Get active previews for a session.
   * Returns [{ port, url }] for client display.
   */
  getActivePreviews(sessionId) {
    const sessionTunnels = this._tunnels.get(sessionId)
    if (!sessionTunnels) return []

    const previews = []
    for (const [port, tunnel] of sessionTunnels) {
      if (tunnel.url) {
        previews.push({ port, url: tunnel.url })
      }
    }
    return previews
  }

  _getTunnel(sessionId, port) {
    return this._tunnels.get(sessionId)?.get(port) ?? null
  }
}
