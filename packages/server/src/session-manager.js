import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { CliSession } from './cli-session.js'
import { PtySession } from './pty-session.js'
import { discoverTmuxSessions } from './session-discovery.js'

/**
 * Manages the lifecycle of multiple sessions (CliSession and PtySession).
 *
 * Two session types:
 *   - 'cli': headless `claude -p` process (CliSession) — chat only
 *   - 'pty': tmux attachment (PtySession) — terminal + chat views
 *
 * Events emitted:
 *   session_event     { sessionId, event, data }   — proxied from each session
 *     CLI events: ready, stream_start, stream_delta, stream_end, message, tool_start, result, error
 *     PTY events: ready, message, error, raw
 *   session_created   { sessionId, name, cwd }
 *   session_destroyed { sessionId }
 *   session_updated   { sessionId, name }
 */
export class SessionManager extends EventEmitter {
  constructor({ maxSessions = 5, port, apiToken, defaultCwd, defaultModel, defaultPermissionMode } = {}) {
    super()
    this.maxSessions = maxSessions
    this._port = port || null
    this._apiToken = apiToken || null
    this._defaultCwd = defaultCwd || process.cwd()
    this._defaultModel = defaultModel || null
    this._defaultPermissionMode = defaultPermissionMode || 'approve'
    this._sessions = new Map() // sessionId -> { session: CliSession|PtySession, type: 'cli'|'pty', name, cwd, createdAt, tmuxSession? }
  }

  /**
   * Create a new session.
   * @returns {string} sessionId
   */
  createSession({ name, cwd, model, permissionMode } = {}) {
    if (this._sessions.size >= this.maxSessions) {
      throw new Error(`Maximum sessions (${this.maxSessions}) reached`)
    }

    const resolvedCwd = cwd || this._defaultCwd
    const resolvedModel = model || this._defaultModel
    const resolvedPermissionMode = permissionMode || this._defaultPermissionMode

    // Validate cwd exists
    try {
      const stat = statSync(resolvedCwd)
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${resolvedCwd}`)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Directory does not exist: ${resolvedCwd}`)
      }
      throw err
    }

    const sessionId = randomUUID().slice(0, 8)
    const sessionName = name || `Session ${this._sessions.size + 1}`

    const session = new CliSession({
      cwd: resolvedCwd,
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
      port: this._port,
      apiToken: this._apiToken,
    })

    const entry = {
      session,
      type: 'cli',
      name: sessionName,
      cwd: resolvedCwd,
      createdAt: Date.now(),
    }

    this._sessions.set(sessionId, entry)
    this._wireSessionEvents(sessionId, session)
    session.start()

    this.emit('session_created', { sessionId, name: sessionName, cwd: resolvedCwd })
    return sessionId
  }

  /**
   * Get a session entry by ID.
   * @returns {{ session: CliSession, name: string, cwd: string, createdAt: number } | null}
   */
  getSession(sessionId) {
    return this._sessions.get(sessionId) || null
  }

  /**
   * List all sessions with summary info.
   * @returns {Array<{ sessionId, name, cwd, model, permissionMode, isBusy, createdAt }>}
   */
  listSessions() {
    const list = []
    for (const [sessionId, entry] of this._sessions) {
      list.push({
        sessionId,
        name: entry.name,
        cwd: entry.cwd,
        type: entry.type,
        hasTerminal: entry.type === 'pty',
        model: entry.session.model || null,
        permissionMode: entry.session.permissionMode || 'approve',
        isBusy: entry.session.isRunning,
        createdAt: entry.createdAt,
      })
    }
    return list
  }

  /**
   * Rename a session.
   * @returns {boolean}
   */
  renameSession(sessionId, name) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return false
    entry.name = name
    this.emit('session_updated', { sessionId, name })
    return true
  }

  /**
   * Destroy a specific session.
   * @returns {boolean}
   */
  destroySession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return false
    entry.session.destroy()
    this._sessions.delete(sessionId)
    this.emit('session_destroyed', { sessionId })
    return true
  }

  /**
   * Destroy all sessions (shutdown cleanup).
   */
  destroyAll() {
    for (const [sessionId, entry] of this._sessions) {
      entry.session.destroy()
      this.emit('session_destroyed', { sessionId })
    }
    this._sessions.clear()
  }

  /**
   * Get the first session ID (used as default).
   * @returns {string | null}
   */
  get firstSessionId() {
    const first = this._sessions.keys().next()
    return first.done ? null : first.value
  }

  /**
   * Attach to an existing tmux session running Claude.
   * Creates a PtySession and adds it to the session map.
   * @returns {string} sessionId
   */
  attachSession({ tmuxSession, name, cols, rows }) {
    if (this._sessions.size >= this.maxSessions) {
      throw new Error(`Maximum sessions (${this.maxSessions}) reached`)
    }

    // Prevent duplicate attachments to the same tmux session
    for (const [, entry] of this._sessions) {
      if (entry.tmuxSession === tmuxSession) {
        throw new Error(`Already attached to tmux session: ${tmuxSession}`)
      }
    }

    const sessionId = randomUUID().slice(0, 8)
    const sessionName = name || tmuxSession

    const session = new PtySession({
      tmuxSession,
      cols: cols || 120,
      rows: rows || 40,
    })

    const entry = {
      session,
      type: 'pty',
      name: sessionName,
      cwd: process.cwd(),
      tmuxSession,
      createdAt: Date.now(),
    }

    this._sessions.set(sessionId, entry)
    this._wireSessionEvents(sessionId, session)
    session.start()

    this.emit('session_created', { sessionId, name: sessionName, cwd: entry.cwd })
    return sessionId
  }

  /**
   * Discover tmux sessions running Claude on the host.
   * Filters out sessions we're already attached to.
   * @returns {Array<{ sessionName: string, cwd: string, pid: number }>}
   */
  discoverSessions() {
    const discovered = discoverTmuxSessions()

    // Filter out already-attached sessions
    const attachedTmux = new Set()
    for (const [, entry] of this._sessions) {
      if (entry.tmuxSession) attachedTmux.add(entry.tmuxSession)
    }

    return discovered.filter((s) => !attachedTmux.has(s.sessionName))
  }

  /**
   * Wire session events to unified session_event emission.
   * Handles both CliSession and PtySession events.
   */
  _wireSessionEvents(sessionId, session) {
    const PROXIED_EVENTS = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'result', 'error']
    for (const event of PROXIED_EVENTS) {
      session.on(event, (data) => {
        this.emit('session_event', { sessionId, event, data })
      })
    }

    // PtySession emits 'raw' for terminal view — forward it
    session.on('raw', (data) => {
      this.emit('session_event', { sessionId, event: 'raw', data })
    })
  }
}
