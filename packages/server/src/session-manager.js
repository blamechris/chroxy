import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { statSync, readFileSync, unlinkSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { getProvider } from './providers.js'
import { resolveJsonlPath, readConversationHistoryAsync } from './jsonl-reader.js'
import { isWindows, writeFileRestricted } from './platform.js'
import { readSessionContext } from './session-context.js'
import { parseDuration } from './duration.js'

const DEFAULT_STATE_FILE = join(homedir(), '.chroxy', 'session-state.json')

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
 * Manages the lifecycle of multiple CLI sessions.
 *
 * Events emitted:
 *   session_event     { sessionId, event, data }   — proxied from each session
 *     Events: ready, stream_start, stream_delta, stream_end, message, tool_start, result, error
 *   session_created   { sessionId, name, cwd }
 *   session_destroyed { sessionId }
 *   session_updated   { sessionId, name }
 *   session_warning   { sessionId, name, reason, message, remainingMs } — session nearing idle timeout
 *   session_timeout   { sessionId, name, idleMs } — session destroyed due to idle timeout
 */
/**
 * Format milliseconds into a human-friendly duration string.
 * Examples: "2 minutes", "1 hour 30 minutes", "45 seconds"
 */
export function formatIdleDuration(ms) {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes !== 1 ? 's' : ''}`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const hPart = `${hours} hour${hours !== 1 ? 's' : ''}`
  return minutes > 0 ? `${hPart} ${minutes} minute${minutes !== 1 ? 's' : ''}` : hPart
}

export class SessionManager extends EventEmitter {
  constructor({ maxSessions = 5, port, apiToken, defaultCwd, defaultModel, defaultPermissionMode, providerType = 'claude-sdk', stateFilePath, stateTtlMs, persistDebounceMs = 2000, maxToolInput, transforms, sessionTimeout, costBudget } = {}) {
    super()
    this.maxSessions = maxSessions
    this._port = port || null
    this._apiToken = apiToken || null
    this._providerType = providerType
    this._defaultCwd = defaultCwd || process.cwd()
    this._defaultModel = defaultModel || null
    this._defaultPermissionMode = defaultPermissionMode || 'approve'
    this._maxToolInput = maxToolInput || null
    this._transforms = transforms || []
    this._stateFilePath = stateFilePath || DEFAULT_STATE_FILE
    this._stateTtlMs = stateTtlMs ?? 24 * 60 * 60 * 1000 // 24 hours
    this._persistDebounceMs = persistDebounceMs
    this._sessions = new Map() // sessionId -> { session, name, cwd, createdAt }
    this._messageHistory = new Map() // sessionId -> Array<{ type, ...data }>
    this._pendingStreams = new Map() // sessionId:messageId -> accumulated delta text
    this._maxHistory = 500
    this._historyTruncated = new Map() // sessionId -> boolean
    this._persistTimer = null
    this._sessionCosts = new Map() // sessionId -> cumulative cost in dollars
    this._budgetWarned = new Set() // sessionIds that have already received 80% warning
    this._budgetExceeded = new Set() // sessionIds that have already received 100% exceeded
    this._costBudget = typeof costBudget === 'number' && costBudget > 0 ? costBudget : null
    this._budgetPaused = new Set() // sessionIds paused due to budget exceeded

    // Session idle timeout
    const parsedTimeout = sessionTimeout ? parseDuration(sessionTimeout) : null
    if (sessionTimeout != null && parsedTimeout == null) {
      console.warn(`[session-manager] Invalid sessionTimeout value "${sessionTimeout}". Session timeouts are disabled.`)
    }
    this._sessionTimeoutMs = parsedTimeout
    this._lastActivity = new Map() // sessionId -> timestamp
    this._sessionWarned = new Set() // sessionIds that have received a timeout warning
    this._timeoutCheckTimer = null
    this._hasActiveViewersFn = null // Set via setActiveViewersFn() by WsServer

    // Validate provider exists at construction time for fail-fast behavior
    getProvider(this._providerType)
  }

  /**
   * Remove a session from all session-scoped maps and sets (#1204).
   * Called by destroySession(), sync catch, and async .catch() paths.
   * @param {string} sessionId
   */
  _cleanupSessionMaps(sessionId) {
    this._sessions.delete(sessionId)
    this._lastActivity.delete(sessionId)
    this._sessionWarned.delete(sessionId)
    this._messageHistory.delete(sessionId)
    this._historyTruncated.delete(sessionId)
    this._sessionCosts.delete(sessionId)
    this._budgetWarned.delete(sessionId)
    this._budgetExceeded.delete(sessionId)
    this._budgetPaused.delete(sessionId)

    // Clean up pending stream state (composite keys: `${sessionId}:messageId`).
    // destroySession() emits synthetic stream_end before calling this helper,
    // so remaining entries here are only from the sync catch path.
    const prefix = sessionId + ':'
    for (const key of this._pendingStreams.keys()) {
      if (key.startsWith(prefix)) {
        this._pendingStreams.delete(key)
      }
    }
  }

  /**
   * Create a new session.
   * @returns {string} sessionId
   */
  createSession({ name, cwd, model, permissionMode, resumeSessionId, provider } = {}) {
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

    const resolvedProvider = provider || this._providerType
    const ProviderClass = getProvider(resolvedProvider)
    const providerOpts = {
      cwd: resolvedCwd,
      model: resolvedModel,
      permissionMode: resolvedPermissionMode,
      port: this._port,
      apiToken: this._apiToken,
      resumeSessionId: resumeSessionId || null,
      transforms: this._transforms,
    }
    if (this._maxToolInput) providerOpts.maxToolInput = this._maxToolInput
    const session = new ProviderClass(providerOpts)

    const entry = {
      session,
      name: sessionName,
      cwd: resolvedCwd,
      provider: resolvedProvider,
      createdAt: Date.now(),
    }

    this._sessions.set(sessionId, entry)
    this._lastActivity.set(sessionId, Date.now())
    this._wireSessionEvents(sessionId, session)

    try {
      const result = session.start()
      // Guard: if start() returns a thenable, catch async rejections (#1141)
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          const message = err?.message || String(err)
          console.error(`[session-manager] Async start() rejected for session ${sessionId}: ${message}`, err)
          this.destroySession(sessionId)
        })
      }
    } catch (err) {
      // Clean up phantom session on start() failure (Guardian FM-03)
      // Mirror destroySession() teardown order: detach listeners before destroy
      session.removeAllListeners()
      session.on('error', () => {})
      try {
        session.destroy()
      } catch (destroyErr) {
        console.error(`[session-manager] Failed to destroy session ${sessionId} during start() failure cleanup:`, destroyErr)
      }
      this._cleanupSessionMaps(sessionId)
      throw err
    }

    console.log(`[session-manager] Created session ${sessionId} "${sessionName}" (${this._sessions.size}/${this.maxSessions})`)
    this.emit('session_created', { sessionId, name: sessionName, cwd: resolvedCwd })
    this._schedulePersist()
    return sessionId
  }

  /**
   * Get a session entry by ID.
   * @returns {{ session: object, name: string, cwd: string, createdAt: number } | null}
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
      const ProviderClass = entry.session.constructor
      list.push({
        sessionId,
        name: entry.name,
        cwd: entry.cwd,
        model: entry.session.model || null,
        permissionMode: entry.session.permissionMode || 'approve',
        isBusy: entry.session.isRunning,
        createdAt: entry.createdAt,
        conversationId: entry.session.resumeSessionId || null,
        provider: entry.provider || this._providerType,
        capabilities: ProviderClass.capabilities || {},
      })
    }
    return list
  }

  /**
   * Read git/project context for a session's working directory.
   * @param {string} [sessionId] - If omitted, uses first session
   * @returns {Promise<{ sessionId: string, gitBranch: string|null, gitDirty: number, gitAhead: number, projectName: string|null } | null>}
   */
  async getSessionContext(sessionId) {
    const entry = sessionId
      ? this._sessions.get(sessionId)
      : this._sessions.values().next().value
    if (!entry) return null
    const id = sessionId || this._sessions.keys().next().value
    const ctx = await readSessionContext(entry.cwd)
    return { sessionId: id, ...ctx }
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
    // Detach listeners BEFORE destroy to prevent orphaned events (FM-04)
    entry.session.removeAllListeners()
    // Prevent unhandled 'error' throw if session emits error during destroy
    entry.session.on('error', () => {})
    // Emit synthetic stream_end for any in-flight streams so clients see termination
    for (const key of this._pendingStreams.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        const messageId = key.slice(sessionId.length + 1)
        this.emit('session_event', { sessionId, event: 'stream_end', data: { messageId } })
        this._pendingStreams.delete(key)
      }
    }
    try {
      entry.session.destroy()
    } catch (destroyErr) {
      console.error(`[session-manager] Error destroying session ${sessionId} "${entry.name}":`, destroyErr)
    }
    this._cleanupSessionMaps(sessionId)
    console.log(`[session-manager] Destroyed session ${sessionId} "${entry.name}" (${this._sessions.size}/${this.maxSessions})`)
    this.emit('session_destroyed', { sessionId })
    this._schedulePersist()
    return true
  }

  /**
   * Destroy all sessions (shutdown cleanup).
   */
  destroyAll() {
    this.stopSessionTimeouts()
    clearTimeout(this._persistTimer)
    this._persistTimer = null
    this.serializeState()
    for (const [sessionId, entry] of this._sessions) {
      entry.session.removeAllListeners()
      entry.session.on('error', () => {})
      try {
        entry.session.destroy()
      } catch (destroyErr) {
        console.error(`[session-manager] Error destroying session ${sessionId} "${entry.name}" during destroyAll():`, destroyErr)
      }
      this.emit('session_destroyed', { sessionId })
    }
    this._sessions.clear()
    this._lastActivity.clear()
    this._sessionWarned.clear()
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
   * Serialize session state to disk for graceful restart.
   * Called during drain before the process exits.
   * @returns {object} The serialized state
   */
  serializeState() {
    const state = { version: 1, timestamp: Date.now(), sessions: [] }
    for (const [id, entry] of this._sessions) {
      const history = (this._messageHistory.get(id) || []).map(e => this._truncateEntry(e))
      state.sessions.push({
        id,
        sdkSessionId: (typeof entry.session.resumeSessionId !== 'undefined' ? entry.session.resumeSessionId : null),
        conversationId: entry.session.resumeSessionId || null,
        cwd: entry.cwd,
        model: entry.session.model,
        permissionMode: entry.session.permissionMode,
        provider: entry.provider || null,
        name: entry.name,
        history,
      })
    }

    // Persist cost tracking so budget survives restarts
    state.costs = {}
    for (const [sessionId, cost] of this._sessionCosts) {
      state.costs[sessionId] = cost
    }
    state.budgetWarned = [...this._budgetWarned]
    state.budgetExceeded = [...this._budgetExceeded]
    state.budgetPaused = [...this._budgetPaused]

    const dir = dirname(this._stateFilePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmpPath = this._stateFilePath + '.tmp'
    writeFileRestricted(tmpPath, JSON.stringify(state, null, 2))
    if (isWindows) {
      try { unlinkSync(this._stateFilePath) } catch (err) {
        if (err && err.code !== 'ENOENT') {
          console.error(`[session-manager] Failed to remove existing state file: ${err.message}`)
        }
      }
    }
    renameSync(tmpPath, this._stateFilePath)
    console.log(`[session-manager] Serialized ${state.sessions.length} session(s) to ${this._stateFilePath}`)
    return state
  }

  /**
   * Restore session state from disk after a restart.
   * Creates new sessions using saved parameters. SdkSession can resume
   * via resumeSessionId; CliSession starts fresh (process state is ephemeral).
   * @returns {string|null} The first restored session ID, or null
   */
  restoreState() {
    if (!existsSync(this._stateFilePath)) return null

    let state
    try {
      state = JSON.parse(readFileSync(this._stateFilePath, 'utf-8'))
    } catch (err) {
      console.error(`[session-manager] Failed to parse session state: ${err.message}`)
      try { unlinkSync(this._stateFilePath) } catch {}
      return null
    }

    if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
      console.log('[session-manager] No sessions to restore')
      return null
    }

    // Reject stale state (older than TTL, default 24h)
    if (state.timestamp && Date.now() - state.timestamp > this._stateTtlMs) {
      console.log(`[session-manager] Session state is stale (>${Math.round(this._stateTtlMs / 60000)}min), starting fresh`)
      return null
    }

    const hasVersion = typeof state.version === 'number'

    let firstId = null
    const oldToNew = new Map() // old serialized session ID → new session ID
    for (const saved of state.sessions) {
      try {
        const sessionId = this.createSession({
          name: saved.name,
          cwd: saved.cwd,
          model: saved.model,
          permissionMode: saved.permissionMode,
          resumeSessionId: saved.sdkSessionId,
          provider: saved.provider || undefined,
        })
        if (saved.id) oldToNew.set(saved.id, sessionId)
        // Restore message history if present (v1+)
        if (hasVersion && Array.isArray(saved.history) && saved.history.length > 0) {
          this._messageHistory.set(sessionId, saved.history)
        }
        if (!firstId) firstId = sessionId
        console.log(`[session-manager] Restored session "${saved.name}" (SDK resume: ${saved.sdkSessionId || 'none'})`)
      } catch (err) {
        console.error(`[session-manager] Failed to restore session "${saved.name}": ${err.message}`)
      }
    }

    // Restore cost tracking data (v1+), remapping old IDs to new IDs.
    // Only restore budget state for sessions that were successfully created;
    // if a session failed to restore, its old ID won't be in oldToNew and
    // we skip it to avoid orphaned budget tracking entries.
    if (state.costs && typeof state.costs === 'object') {
      for (const [oldId, cost] of Object.entries(state.costs)) {
        if (typeof cost === 'number' && cost > 0) {
          const newId = oldToNew.get(oldId)
          if (newId) {
            this._sessionCosts.set(newId, cost)
          } else if (oldToNew.size === 0) {
            // Backwards compat: old state files without id field have no mappings
            this._sessionCosts.set(oldId, cost)
          }
        }
      }
    }
    if (Array.isArray(state.budgetWarned)) {
      for (const id of state.budgetWarned) {
        const newId = oldToNew.get(id)
        if (newId) {
          this._budgetWarned.add(newId)
        } else if (oldToNew.size === 0) {
          this._budgetWarned.add(id)
        }
      }
    }
    if (Array.isArray(state.budgetExceeded)) {
      for (const id of state.budgetExceeded) {
        const newId = oldToNew.get(id)
        if (newId) {
          this._budgetExceeded.add(newId)
        } else if (oldToNew.size === 0) {
          this._budgetExceeded.add(id)
        }
      }
    }
    if (Array.isArray(state.budgetPaused)) {
      for (const id of state.budgetPaused) {
        const newId = oldToNew.get(id)
        if (newId) {
          this._budgetPaused.add(newId)
        } else if (oldToNew.size === 0) {
          this._budgetPaused.add(id)
        }
      }
    }

    return firstId
  }

  /**
   * Check if all sessions are idle (not busy).
   * Used by drain protocol to wait for in-flight work.
   * @returns {boolean}
   */
  allIdle() {
    for (const [, entry] of this._sessions) {
      if (entry.session.isRunning) return false
    }
    return true
  }

  /**
   * Get message history for a session.
   * @returns {Array<{ type, ...data }>}
   */
  getHistory(sessionId) {
    return this._messageHistory.get(sessionId) || []
  }

  /**
   * Get the count of messages in the ring buffer for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getHistoryCount(sessionId) {
    return (this._messageHistory.get(sessionId) || []).length
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  isHistoryTruncated(sessionId) {
    return this._historyTruncated.get(sessionId) || false
  }

  /**
   * Get the conversation ID (SDK session ID) for a session.
   * @returns {string|null}
   */
  getConversationId(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return null
    return entry.session.resumeSessionId || null
  }

  /**
   * Get full conversation history asynchronously by reading the JSONL file.
   * Avoids blocking the event loop for large files (use in WS handlers).
   * Falls back to the ring buffer if JSONL is unavailable.
   * @returns {Promise<Array<{ type, content, tool?, timestamp, messageId? }>>}
   */
  async getFullHistoryAsync(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return []

    const conversationId = entry.session.resumeSessionId
    if (conversationId) {
      const filePath = resolveJsonlPath(entry.cwd, conversationId)
      const history = await readConversationHistoryAsync(filePath)
      if (history.length > 0) return history
    }

    // Fallback to ring buffer
    return this.getHistory(sessionId)
  }

  /**
   * Record a user input message in the session's history ring buffer.
   * Public API for ws-server to record user messages so they survive reconnect replay.
   */
  recordUserInput(sessionId, text) {
    this._recordHistory(sessionId, 'message', {
      type: 'user_input',
      content: text,
      timestamp: Date.now(),
    })
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
        this._schedulePersist()
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
        this._schedulePersist()
        break

      case 'tool_start':
        this._pushHistory(history, {
          type: 'tool_start',
          messageId: data.messageId,
          toolUseId: data.toolUseId,
          tool: data.tool,
          input: data.input,
          timestamp: Date.now(),
        })
        break

      case 'tool_result':
        this._pushHistory(history, {
          type: 'tool_result',
          toolUseId: data.toolUseId,
          result: data.result,
          truncated: data.truncated,
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
        this._schedulePersist()
        break

      case 'user_question':
        this._pushHistory(history, {
          type: 'user_question',
          toolUseId: data.toolUseId,
          questions: data.questions,
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
    if (history.length > this._maxHistory) {
      while (history.length > this._maxHistory) {
        history.shift()
      }
      // Find the sessionId that owns this history array and mark it truncated
      for (const [sessionId, h] of this._messageHistory) {
        if (h === history) {
          this._historyTruncated.set(sessionId, true)
          break
        }
      }
    }
  }

  /**
   * Schedule a debounced persist. Multiple rapid calls reset the timer.
   */
  _schedulePersist() {
    clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      try {
        this.serializeState()
      } catch (err) {
        console.error('[session-manager] Failed to persist session state:', err)
      }
    }, this._persistDebounceMs)
  }

  /**
   * Shallow-clone and truncate a history entry for serialization.
   * Content/input fields >50KB are truncated to avoid bloated state files.
   */
  _truncateEntry(entry) {
    const MAX = 50 * 1024
    const clone = { ...entry }
    if (typeof clone.content === 'string' && clone.content.length > MAX) {
      clone.content = clone.content.slice(0, MAX) + '[truncated]'
    }
    if (typeof clone.input === 'string' && clone.input.length > MAX) {
      clone.input = clone.input.slice(0, MAX) + '[truncated]'
    }
    return clone
  }

  /**
   * Wire session events to unified session_event emission.
   * Handles both CliSession and PtySession events.
   */
  _wireSessionEvents(sessionId, session) {
    const PROXIED_EVENTS = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result', 'result', 'error', 'user_question']
    // Events that indicate meaningful activity (reset idle timeout)
    const ACTIVITY_EVENTS = new Set(['message', 'stream_start', 'tool_start', 'result', 'user_question'])
    for (const event of PROXIED_EVENTS) {
      session.on(event, (data) => {
        if (ACTIVITY_EVENTS.has(event)) this._touchActivity(sessionId)
        this._recordHistory(sessionId, event, data)
        this.emit('session_event', { sessionId, event, data })

        // When SDK session reports ready, emit conversation_id if available
        if (event === 'ready' && session.resumeSessionId) {
          this.emit('session_event', {
            sessionId,
            event: 'conversation_id',
            data: { conversationId: session.resumeSessionId },
          })
        }

        // Track cumulative cost and check budget on result events
        if (event === 'result' && typeof data.cost === 'number') {
          this._trackCost(sessionId, data.cost)
        }
      })
    }

    // Transient events — forwarded but not recorded in history (not replayed on reconnect)
    const TRANSIENT_EVENTS = ['permission_request', 'agent_spawned', 'agent_completed', 'plan_started', 'plan_ready', 'mcp_servers']
    for (const event of TRANSIENT_EVENTS) {
      session.on(event, (data) => {
        this.emit('session_event', { sessionId, event, data })
      })
    }

    // models_updated is global (not per-session) — forward as transient event
    session.on('models_updated', (data) => {
      this.emit('session_event', { sessionId, event: 'models_updated', data })
    })
  }

  // ---------------------------------------------------------------------------
  // Session idle timeout
  // ---------------------------------------------------------------------------

  /**
   * Set the function used to check if a session has active WebSocket viewers.
   * Called by WsServer after construction to wire the two components together.
   * @param {(sessionId: string) => boolean} fn
   */
  setActiveViewersFn(fn) {
    this._hasActiveViewersFn = fn
  }

  /**
   * Record activity for a session (resets idle timer).
   * Called internally on relevant events, and publicly by WsServer on user input.
   */
  touchActivity(sessionId) {
    this._touchActivity(sessionId)
  }

  /** @private */
  _touchActivity(sessionId) {
    this._lastActivity.set(sessionId, Date.now())
    // Clear warning flag if session becomes active again
    if (this._sessionWarned.has(sessionId)) {
      this._sessionWarned.delete(sessionId)
    }
  }

  // ---------------------------------------------------------------------------
  // Cost budget tracking
  // ---------------------------------------------------------------------------

  /**
   * Track cumulative cost for a session and check budget thresholds.
   * @param {string} sessionId
   * @param {number} cost - Cost of the latest query in dollars
   */
  _trackCost(sessionId, cost) {
    const prev = this._sessionCosts.get(sessionId) || 0
    const cumulative = prev + cost
    this._sessionCosts.set(sessionId, cumulative)

    // Emit cost_update for every result so app can track cumulative cost
    const entry = this._sessions.get(sessionId)
    this.emit('session_event', {
      sessionId,
      event: 'cost_update',
      data: {
        sessionCost: cumulative,
        totalCost: this.getTotalCost(),
        budget: this._costBudget,
      },
    })

    if (!this._costBudget) return

    const percent = cumulative / this._costBudget

    // Hard limit at 100% (checked first to avoid dual-emit with warning)
    if (percent >= 1.0 && !this._budgetExceeded.has(sessionId)) {
      this._budgetExceeded.add(sessionId)
      this._budgetPaused.add(sessionId)
      this.emit('session_event', {
        sessionId,
        event: 'budget_exceeded',
        data: {
          sessionCost: cumulative,
          budget: this._costBudget,
          percent: Math.round(percent * 100),
          message: `Session "${entry?.name || sessionId}" has exceeded the $${this._costBudget.toFixed(2)} budget ($${cumulative.toFixed(4)})`,
        },
      })
      return
    }

    // Warning at 80% (skipped if already at/past 100%)
    if (percent >= 0.8 && !this._budgetWarned.has(sessionId)) {
      this._budgetWarned.add(sessionId)
      this.emit('session_event', {
        sessionId,
        event: 'budget_warning',
        data: {
          sessionCost: cumulative,
          budget: this._costBudget,
          percent: Math.round(percent * 100),
          message: `Session "${entry?.name || sessionId}" has used ${Math.round(percent * 100)}% of the $${this._costBudget.toFixed(2)} budget ($${cumulative.toFixed(4)})`,
        },
      })
    }
  }

  /**
   * Start periodic session timeout checks.
   * Only starts if sessionTimeout was configured.
   */
  startSessionTimeouts() {
    if (!this._sessionTimeoutMs) return
    if (this._timeoutCheckTimer) return

    const checkIntervalMs = Math.min(60_000, Math.floor(this._sessionTimeoutMs / 4))
    console.log(`[session-manager] Session timeout enabled: ${this._sessionTimeoutMs}ms (check every ${checkIntervalMs}ms)`)
    this._timeoutCheckTimer = setInterval(() => {
      this._checkSessionTimeouts()
    }, checkIntervalMs)
  }

  /**
   * Stop periodic session timeout checks.
   */
  stopSessionTimeouts() {
    if (this._timeoutCheckTimer) {
      clearInterval(this._timeoutCheckTimer)
      this._timeoutCheckTimer = null
    }
  }

  /**
   * Check all sessions for idle timeout. Warn first, then destroy on next check.
   * Sessions with active WebSocket viewers or running queries are exempt.
   */
  _checkSessionTimeouts() {
    if (!this._sessionTimeoutMs) return

    const now = Date.now()
    // Warning threshold: 2 minutes before timeout (or half the timeout, whichever is smaller)
    const warningMs = Math.min(2 * 60_000, Math.floor(this._sessionTimeoutMs / 2))

    // Collect candidates before destroying to avoid Map mutation during iteration (#815)
    const toDestroy = []

    for (const [sessionId, entry] of this._sessions) {
      const lastActive = this._lastActivity.get(sessionId) || entry.createdAt
      const idleMs = now - lastActive

      // Skip sessions with active viewers
      if (this._hasActiveViewersFn && this._hasActiveViewersFn(sessionId)) {
        this._touchActivity(sessionId) // Viewing counts as activity
        continue
      }

      // Skip busy sessions (query in progress)
      if (entry.session.isRunning) {
        this._touchActivity(sessionId)
        continue
      }

      // Timeout fully elapsed — destroy (whether or not a warning was sent).
      // Handles both the normal warned->timeout path and the edge case where
      // the session jumped past the warning threshold (clock jump, stall). (#815)
      if (idleMs >= this._sessionTimeoutMs) {
        toDestroy.push({ sessionId, name: entry.name, idleMs })
        continue
      }

      // Warning threshold reached — send warning (#817: human-friendly durations)
      if (!this._sessionWarned.has(sessionId) && idleMs >= this._sessionTimeoutMs - warningMs) {
        const remainingMs = Math.max(0, this._sessionTimeoutMs - idleMs)
        const friendly = formatIdleDuration(remainingMs)
        console.log(`[session-manager] Session ${sessionId} idle warning (${friendly} remaining)`)
        this._sessionWarned.add(sessionId)
        this.emit('session_warning', {
          sessionId,
          name: entry.name,
          reason: 'idle_timeout',
          message: `Session "${entry.name}" will be closed in ${friendly} due to inactivity`,
          remainingMs,
        })
      }
    }

    // Destroy outside the iteration loop (#815)
    for (const { sessionId, name, idleMs } of toDestroy) {
      const friendly = formatIdleDuration(idleMs)
      console.log(`[session-manager] Session ${sessionId} timed out after ${friendly} idle`)
      this.emit('session_timeout', { sessionId, name, idleMs })
      this.destroySession(sessionId)
    }
  }

  /**
   * Get cumulative cost for a specific session.
   * @param {string} sessionId
   * @returns {number} Cost in dollars
   */
  getSessionCost(sessionId) {
    return this._sessionCosts.get(sessionId) || 0
  }

  /**
   * Get total cumulative cost across all sessions.
   * @returns {number} Cost in dollars
   */
  getTotalCost() {
    let total = 0
    for (const cost of this._sessionCosts.values()) total += cost
    return total
  }

  /**
   * Get the configured cost budget, or null if none set.
   * @returns {number|null}
   */
  getCostBudget() {
    return this._costBudget
  }

  /**
   * Check if a session is paused due to exceeding the cost budget.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isBudgetPaused(sessionId) {
    return this._budgetPaused.has(sessionId)
  }

  /**
   * Resume a budget-paused session (user override).
   * @param {string} sessionId
   */
  resumeBudget(sessionId) {
    this._budgetPaused.delete(sessionId)
    this._schedulePersist()
    console.log(`[session-manager] Budget pause overridden for session ${sessionId}`)
  }
}
