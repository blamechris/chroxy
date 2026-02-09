import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { CliSession } from './cli-session.js'
import { PtySession } from './pty-session.js'
import { discoverTmuxSessions } from './session-discovery.js'

/**
 * Base error class for session management operations.
 */
export class SessionError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}

/**
 * Thrown when attempting to retrieve or operate on a non-existent session.
 */
export class SessionNotFoundError extends SessionError {
  constructor(sessionId) {
    super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND')
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/**
 * Thrown when attempting to create a session that already exists.
 */
export class SessionExistsError extends SessionError {
  constructor(tmuxSession) {
    super(`Already attached to tmux session: ${tmuxSession}`, 'SESSION_EXISTS')
    this.name = 'SessionExistsError'
    this.tmuxSession = tmuxSession
  }
}

/**
 * Thrown when session attachment fails.
 */
export class SessionAttachError extends SessionError {
  constructor(message, details) {
    super(message, 'SESSION_ATTACH_FAILED')
    this.name = 'SessionAttachError'
    this.details = details
  }
}

/**
 * Thrown when maximum session limit is reached.
 */
export class SessionLimitError extends SessionError {
  constructor(maxSessions) {
    super(`Maximum sessions (${maxSessions}) reached`, 'SESSION_LIMIT_REACHED')
    this.name = 'SessionLimitError'
    this.maxSessions = maxSessions
  }
}

/**
 * Thrown when session directory validation fails.
 */
export class SessionDirectoryError extends SessionError {
  constructor(message, path) {
    super(message, 'INVALID_DIRECTORY')
    this.name = 'SessionDirectoryError'
    this.path = path
  }
}

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
 *   new_sessions_discovered { tmux: [...] } — new tmux sessions found during polling
 */
export class SessionManager extends EventEmitter {
  constructor({ maxSessions = 5, port, apiToken, defaultCwd, defaultModel, defaultPermissionMode, autoDiscovery = true, discoveryIntervalMs = 45000 } = {}) {
    super()
    this.maxSessions = maxSessions
    this._port = port || null
    this._apiToken = apiToken || null
    this._defaultCwd = defaultCwd || process.cwd()
    this._defaultModel = defaultModel || null
    this._defaultPermissionMode = defaultPermissionMode || 'approve'
    this._sessions = new Map() // sessionId -> { session: CliSession|PtySession, type: 'cli'|'pty', name, cwd, createdAt, tmuxSession? }
    this._messageHistory = new Map() // sessionId -> Array<{ type, ...data }>
    this._pendingStreams = new Map() // sessionId:messageId -> accumulated delta text
    this._maxHistory = 100
    this._autoDiscovery = autoDiscovery
    this._discoveryIntervalMs = discoveryIntervalMs
    this._discoveryTimer = null
    this._lastDiscoveredSessions = new Set() // Track tmux session names we've seen
  }

  /**
   * Create a new session.
   * @returns {string} sessionId
   */
  createSession({ name, cwd, model, permissionMode } = {}) {
    if (this._sessions.size >= this.maxSessions) {
      console.error(`[session-manager] Cannot create session: limit reached (${this._sessions.size}/${this.maxSessions})`)
      throw new SessionLimitError(this.maxSessions)
    }

    const resolvedCwd = cwd || this._defaultCwd
    const resolvedModel = model || this._defaultModel
    const resolvedPermissionMode = permissionMode || this._defaultPermissionMode

    // Validate cwd exists
    try {
      const stat = statSync(resolvedCwd)
      if (!stat.isDirectory()) {
        throw new SessionDirectoryError(`Not a directory: ${resolvedCwd}`, resolvedCwd)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new SessionDirectoryError(`Directory does not exist: ${resolvedCwd}`, resolvedCwd)
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

    console.log(`[session-manager] Created session ${sessionId} "${sessionName}" (${this._sessions.size}/${this.maxSessions})`)
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
        permissionMode: entry.type === 'pty' ? null : (entry.session.permissionMode || 'approve'),
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
    if (!entry) {
      console.error(`[session-manager] Cannot rename: session ${sessionId} not found`)
      return false
    }
    entry.name = name
    console.log(`[session-manager] Renamed session ${sessionId} to "${name}"`)
    this.emit('session_updated', { sessionId, name })
    return true
  }

  /**
   * Destroy a specific session.
   * @returns {boolean}
   */
  destroySession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) {
      console.error(`[session-manager] Cannot destroy: session ${sessionId} not found`)
      return false
    }
    console.log(`[session-manager] Destroying session ${sessionId} "${entry.name}" (${this._sessions.size - 1}/${this.maxSessions} after removal)`)
    entry.session.destroy()
    this._sessions.delete(sessionId)
    this._messageHistory.delete(sessionId)
    // Clean up any pending streams for this session
    for (const key of this._pendingStreams.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this._pendingStreams.delete(key)
      }
    }
    this.emit('session_destroyed', { sessionId })
    return true
  }

  /**
   * Destroy all sessions (shutdown cleanup).
   */
  destroyAll() {
    this.stopAutoDiscovery()
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
   * @returns {Promise<string>} sessionId
   */
  async attachSession({ tmuxSession, name, cols, rows }) {
    if (this._sessions.size >= this.maxSessions) {
      throw new SessionLimitError(this.maxSessions)
    }

    console.log(`[session-manager] Attempting to attach to tmux session '${tmuxSession}'`)

    // Prevent duplicate attachments to the same tmux session
    for (const [, entry] of this._sessions) {
      if (entry.tmuxSession === tmuxSession) {
        throw new SessionExistsError(tmuxSession)
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

    try {
      // Wait for PTY start to complete — surface failures synchronously
      await session.start()
      console.log(`[session-manager] Successfully attached session ${sessionId} to tmux '${tmuxSession}'`)
    } catch (err) {
      // Clean up failed session entry before rethrowing
      this._sessions.delete(sessionId)
      console.error(`[session-manager] Attach failed for session ${sessionId} (tmux: '${tmuxSession}'):`, err)
      throw new SessionAttachError(`Failed to attach to tmux session '${tmuxSession}': ${err.message}`, { tmuxSession, sessionId, originalError: err })
    }

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
   * Start periodic auto-discovery of new tmux sessions.
   * Only runs if autoDiscovery is enabled.
   */
  startAutoDiscovery() {
    if (!this._autoDiscovery) return
    if (this._discoveryTimer) return // Already running

    console.log(`[session-manager] Starting auto-discovery (interval: ${this._discoveryIntervalMs}ms)`)

    // Initialize tracking with current discovered sessions
    const initial = this.discoverSessions()
    for (const session of initial) {
      this._lastDiscoveredSessions.add(session.sessionName)
    }

    this._discoveryTimer = setInterval(() => {
      this._pollForNewSessions()
    }, this._discoveryIntervalMs)
  }

  /**
   * Stop periodic auto-discovery.
   */
  stopAutoDiscovery() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer)
      this._discoveryTimer = null
      console.log('[session-manager] Stopped auto-discovery')
    }
  }

  /**
   * Poll for new tmux sessions and emit event if any are found.
   * @private
   */
  _pollForNewSessions() {
    const current = this.discoverSessions()
    const newSessions = []

    for (const session of current) {
      if (!this._lastDiscoveredSessions.has(session.sessionName)) {
        newSessions.push(session)
        this._lastDiscoveredSessions.add(session.sessionName)
      }
    }

    // Prune sessions that no longer exist
    const currentNames = new Set(current.map((s) => s.sessionName))
    for (const name of this._lastDiscoveredSessions) {
      if (!currentNames.has(name)) {
        this._lastDiscoveredSessions.delete(name)
      }
    }

    if (newSessions.length > 0) {
      console.log(`[session-manager] Discovered ${newSessions.length} new tmux session(s): ${newSessions.map((s) => s.sessionName).join(', ')}`)
      this.emit('new_sessions_discovered', { tmux: newSessions })
    }
  }

  /**
   * Get message history for a session.
   * @returns {Array<{ type, ...data }>}
   */
  getHistory(sessionId) {
    return this._messageHistory.get(sessionId) || []
  }

  /**
   * Record an event into the session's message history ring buffer.
   */
  _recordHistory(sessionId, event, data) {
    if (!this._messageHistory.has(sessionId)) {
      this._messageHistory.set(sessionId, [])
    }
    const history = this._messageHistory.get(sessionId)

    switch (event) {
      case 'stream_start': {
        // Start accumulating deltas for this stream
        const key = `${sessionId}:${data.messageId}`
        this._pendingStreams.set(key, '')
        break
      }

      case 'stream_delta': {
        const key = `${sessionId}:${data.messageId}`
        const existing = this._pendingStreams.get(key)
        if (existing !== undefined) {
          this._pendingStreams.set(key, existing + data.delta)
        }
        break
      }

      case 'stream_end': {
        // Reconstruct complete message from accumulated deltas
        const key = `${sessionId}:${data.messageId}`
        const content = this._pendingStreams.get(key) || ''
        this._pendingStreams.delete(key)
        if (content) {
          this._pushHistory(history, {
            type: 'message',
            messageType: 'response',
            content,
            messageId: data.messageId,
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'message':
        this._pushHistory(history, {
          type: 'message',
          messageType: data.type,
          content: data.content,
          tool: data.tool,
          options: data.options,
          timestamp: data.timestamp,
        })
        break

      case 'tool_start':
        this._pushHistory(history, {
          type: 'tool_start',
          messageId: data.messageId,
          tool: data.tool,
          input: data.input,
          timestamp: Date.now(),
        })
        break

      case 'result':
        this._pushHistory(history, {
          type: 'result',
          cost: data.cost,
          duration: data.duration,
          usage: data.usage,
          timestamp: Date.now(),
        })
        break
    }
  }

  /**
   * Push an entry to the history array, trimming to max size.
   */
  _pushHistory(history, entry) {
    history.push(entry)
    while (history.length > this._maxHistory) {
      history.shift()
    }
  }

  /**
   * Wire session events to unified session_event emission.
   * Handles both CliSession and PtySession events.
   */
  _wireSessionEvents(sessionId, session) {
    const PROXIED_EVENTS = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'result', 'error']
    for (const event of PROXIED_EVENTS) {
      session.on(event, (data) => {
        this._recordHistory(sessionId, event, data)
        this.emit('session_event', { sessionId, event, data })
      })
    }

    // PtySession emits 'raw' for terminal view — forward it (not recorded in history)
    session.on('raw', (data) => {
      this.emit('session_event', { sessionId, event: 'raw', data })
    })

    // PtySession emits 'status_update' for Claude Code status bar metadata (not recorded in history)
    session.on('status_update', (data) => {
      this.emit('session_event', { sessionId, event: 'status_update', data })
    })

    // PtySession emits 'session_crashed' when health checks detect a crashed Claude process
    session.on('session_crashed', (data) => {
      console.error(`[session-manager] Session ${sessionId} crashed: ${data.error}`)
      this.emit('session_crashed', { sessionId, reason: data.reason, error: data.error })
    })
  }
}
