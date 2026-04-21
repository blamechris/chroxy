import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { statSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { getProvider } from './providers.js'
import { GIT } from './git.js'
import { resolveJsonlPath, readConversationHistoryAsync } from './jsonl-reader.js'
import { readSessionContext } from './session-context.js'
import { parseDuration } from './duration.js'
import { SessionLockManager } from './session-lock.js'
import { CostBudgetManager } from './cost-budget-manager.js'
import { SessionStatePersistence } from './session-state-persistence.js'
import { SessionTimeoutManager, formatIdleDuration } from './session-timeout-manager.js'
import { SessionMessageHistory } from './session-message-history.js'
import { createLogger } from './logger.js'
import { metrics } from './metrics.js'

const log = createLogger('session-manager')
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
 * Thrown when worktree creation fails (e.g. non-git directory).
 */
export class WorktreeError extends SessionError {
  constructor(message) {
    super(message, 'WORKTREE_ERROR')
    this.name = 'WorktreeError'
  }
}

/**
 * Default base directory for session worktrees.
 * @type {string}
 */
const DEFAULT_WORKTREE_BASE = join(homedir(), '.chroxy', 'worktrees')

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

// Re-export formatIdleDuration from SessionTimeoutManager for backward compatibility
export { formatIdleDuration }

/**
 * @typedef {Object} SessionManagerConfig
 *
 * Server identity
 * @property {number}  [port]                    - Server port (used in push notification metadata)
 * @property {string}  [apiToken]                - API token for authentication
 *
 * Session defaults
 * @property {number}  [maxSessions=5]           - Maximum concurrent sessions
 * @property {string}  [defaultCwd]              - Default working directory (falls back to process.cwd())
 * @property {string}  [defaultModel]            - Default Claude model identifier
 * @property {string}  [defaultPermissionMode='approve'] - Default permission mode
 * @property {string}  [providerType='claude-sdk'] - Provider type from providers.js registry
 *
 * Session behavior
 * @property {string}  [sessionTimeout]          - Idle timeout duration string (e.g. '30m', '2h'), parsed by parseDuration()
 * @property {number}  [maxToolInput]            - Max characters for tool input display
 * @property {Array}   [transforms=[]]           - Message transform functions
 * @property {object}  [sandbox]                 - SDK sandbox settings for lightweight isolation
 * @property {number}  [costBudget]              - Per-session cost budget in dollars (e.g. 5.00).
 *                                                  Applied independently to each session; not a shared/global pool.
 *
 * State persistence
 * @property {string}  [stateFilePath]           - Path to session state JSON file (default: ~/.chroxy/session-state.json)
 * @property {number}  [stateTtlMs]              - Max age of persisted state before discard (default: 24 hours)
 * @property {number}  [persistDebounceMs=2000]  - Debounce interval for state file writes
 *
 * Message history
 * @property {number}  [maxMessages=1000]        - Max history messages per session (alias: maxHistory)
 * @property {number}  [maxHistory]              - Legacy alias for maxMessages
 */
export class SessionManager extends EventEmitter {
  /**
   * @param {SessionManagerConfig} config
   */
  constructor({
    // Server identity
    port,
    apiToken,

    // Session defaults
    maxSessions = 5,
    defaultCwd,
    defaultModel,
    defaultPermissionMode,
    providerType = 'claude-sdk',

    // Session behavior
    sessionTimeout,
    maxToolInput,
    transforms,
    sandbox,
    costBudget,

    // State persistence
    stateFilePath,
    stateTtlMs,
    persistDebounceMs = 2000,

    // Message history
    maxMessages,
    maxHistory,
  } = {}) {
    super()

    // Server identity
    this._port = port || null
    this._apiToken = apiToken || null

    // Session defaults
    this.maxSessions = maxSessions
    this._defaultCwd = defaultCwd || process.cwd()
    this._defaultModel = defaultModel || null
    this._defaultPermissionMode = defaultPermissionMode || 'approve'
    this._providerType = providerType

    // Session behavior
    this._maxToolInput = maxToolInput || null
    this._transforms = transforms || []
    this._sandbox = sandbox || null
    this._costBudget = new CostBudgetManager({ budget: costBudget })

    // State persistence (delegated to SessionStatePersistence)
    this._persistence = new SessionStatePersistence({
      stateFilePath: stateFilePath || DEFAULT_STATE_FILE,
      stateTtlMs,
      persistDebounceMs,
    })
    // Backward-compatible accessors for tests that reference internal state
    this._stateFilePath = this._persistence._stateFilePath
    this._stateTtlMs = this._persistence._stateTtlMs
    this._persistDebounceMs = this._persistence._persistDebounceMs
    Object.defineProperty(this, '_persistTimer', {
      get: () => this._persistence._persistTimer,
      set: (v) => { this._persistence._persistTimer = v },
      enumerable: false,
      configurable: true,
    })

    // Message history (delegated to SessionMessageHistory)
    this._history = new SessionMessageHistory({ maxMessages: maxMessages ?? maxHistory, maxToolInput })
    // Backward-compatible accessors for tests that reference internal state
    this._maxHistory = this._history.maxHistory
    this._messageHistory = this._history._messageHistory
    this._pendingStreams = this._history.pendingStreams
    this._historyTruncated = this._history._historyTruncated

    // Wire auto_label events from history to session_updated emissions
    this._history.on('auto_label', ({ sessionId, label }) => {
      this.emit('session_updated', { sessionId, name: label })
    })

    // Internal state
    this._sessions = new Map() // sessionId -> { session, name, cwd, createdAt }
    this._sessionCounter = 0   // monotonically incrementing; used for auto-naming
    this._locks = new SessionLockManager()

    // Session idle timeout (delegated to SessionTimeoutManager)
    const parsedTimeout = sessionTimeout ? parseDuration(sessionTimeout) : null
    if (sessionTimeout != null && parsedTimeout == null) {
      log.warn(`Invalid sessionTimeout value "${sessionTimeout}". Session timeouts are disabled.`)
    }
    this._sessionTimeoutMs = parsedTimeout
    this._timeoutManager = new SessionTimeoutManager({ sessionTimeoutMs: parsedTimeout })

    // Wire timeout manager events to SessionManager events
    this._timeoutManager.on('warning', ({ sessionId, remainingMs }) => {
      const entry = this._sessions.get(sessionId)
      if (!entry) return
      const friendly = formatIdleDuration(remainingMs)
      log.info(`Session ${sessionId} idle warning (${friendly} remaining)`)
      this.emit('session_warning', {
        sessionId,
        name: entry.name,
        reason: 'idle_timeout',
        message: `Session "${entry.name}" will be closed in ${friendly} due to inactivity`,
        remainingMs,
      })
    })

    this._timeoutManager.on('timeout', ({ sessionId, idleMs }) => {
      const entry = this._sessions.get(sessionId)
      if (!entry) return
      const friendly = formatIdleDuration(idleMs)
      log.info(`Session ${sessionId} timed out after ${friendly} idle`)
      this.emit('session_timeout', { sessionId, name: entry.name, idleMs })
      this.destroySession(sessionId)
    })

    // Wire isRunning check so timeout manager can skip busy sessions
    this._timeoutManager.setIsRunningFn((sessionId) => {
      const entry = this._sessions.get(sessionId)
      return entry ? entry.session.isRunning : false
    })

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
    this._timeoutManager.removeSession(sessionId)
    this._history.cleanupSession(sessionId)
    this._costBudget.removeSession(sessionId)
  }

  /**
   * Create a new session.
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {string} [options.cwd]
   * @param {string} [options.model]
   * @param {string} [options.permissionMode]
   * @param {string} [options.resumeSessionId]
   * @param {string} [options.provider]
   * @param {boolean} [options.worktree] - When true, creates a git worktree for isolation
   * @param {object} [options.sandbox] - SDK sandbox settings for lightweight isolation
   * @returns {string} sessionId
   */
  createSession({ name, cwd, model, permissionMode, resumeSessionId, provider, worktree, sandbox, containerId, containerUser, containerCliPath } = {}) {
    if (this._sessions.size >= this.maxSessions) {
      log.error(`Cannot create session: limit reached (${this._sessions.size}/${this.maxSessions})`)
      throw new SessionLimitError(this.maxSessions)
    }

    const baseCwd = cwd || this._defaultCwd
    const resolvedModel = model || this._defaultModel
    const resolvedPermissionMode = permissionMode || this._defaultPermissionMode

    // Validate cwd exists
    try {
      const stat = statSync(baseCwd)
      if (!stat.isDirectory()) {
        throw new SessionDirectoryError(`Not a directory: ${baseCwd}`, baseCwd)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new SessionDirectoryError(`Directory does not exist: ${baseCwd}`, baseCwd)
      }
      throw err
    }

    const sessionId = randomBytes(16).toString('hex')
    const sessionName = name || `Session ${++this._sessionCounter}`

    // Worktree isolation — create a detached git worktree for this session
    let resolvedCwd = baseCwd
    let worktreePath = null
    if (worktree) {
      // Verify cwd is inside a git repository
      try {
        execFileSync(GIT, ['-C', baseCwd, 'rev-parse', '--git-dir'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        })
      } catch {
        throw new WorktreeError(`Not a git repository: ${baseCwd}`)
      }

      // Create worktree directory
      const worktreeBase = this._worktreeBase || DEFAULT_WORKTREE_BASE
      const worktreeDir = join(worktreeBase, sessionId)
      mkdirSync(worktreeBase, { recursive: true })

      try {
        execFileSync(GIT, ['-C', baseCwd, 'worktree', 'add', '--detach', worktreeDir, 'HEAD'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf-8',
        })
      } catch (err) {
        const msg = err?.stderr?.trim() || err?.message || String(err)
        throw new WorktreeError(`Failed to create worktree: ${msg}`)
      }

      resolvedCwd = worktreeDir
      worktreePath = worktreeDir
      log.info(`Created worktree for session ${sessionId} at ${worktreeDir}`)
    }

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
    // Sandbox: per-session overrides server-level default
    const resolvedSandbox = sandbox || this._sandbox
    if (resolvedSandbox) providerOpts.sandbox = resolvedSandbox
    // External container support (EnvironmentManager integration)
    if (containerId) providerOpts.containerId = containerId
    if (containerUser) providerOpts.containerUser = containerUser
    if (containerCliPath) providerOpts.containerCliPath = containerCliPath
    const session = new ProviderClass(providerOpts)

    // Derive isolation mode from actual session state, ignoring client-provided value
    // when it conflicts with reality (e.g. isolation:'container' with a non-container provider)
    let resolvedIsolation = 'none'
    if (worktreePath) resolvedIsolation = 'worktree'
    else if (ProviderClass.capabilities?.containerized) resolvedIsolation = 'container'
    else if (resolvedSandbox) resolvedIsolation = 'sandbox'

    const entry = {
      session,
      name: sessionName,
      cwd: resolvedCwd,
      provider: resolvedProvider,
      createdAt: Date.now(),
      worktreePath,
      // Original repo dir needed for `git worktree remove` during cleanup
      worktreeRepoDir: worktreePath ? baseCwd : null,
      isolation: resolvedIsolation,
    }

    this._sessions.set(sessionId, entry)
    metrics.inc('sessions.created')
    this._timeoutManager.touchActivity(sessionId)
    this._wireSessionEvents(sessionId, session)

    try {
      const result = session.start()
      // Guard: if start() returns a thenable, catch async rejections (#1141)
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          const message = err?.message || String(err)
          log.error(`Async start() rejected for session ${sessionId}: ${message}${err?.stack ? '\n' + err.stack : ''}`)
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
        log.error(`Failed to destroy session ${sessionId} during start() failure cleanup: ${destroyErr?.stack || destroyErr}`)
      }
      this._cleanupSessionMaps(sessionId)
      // Clean up worktree if one was created but session start failed
      if (worktreePath) {
        this._removeWorktree(worktreePath, baseCwd, sessionId)
      }
      throw err
    }

    log.info(`Created session ${sessionId} "${sessionName}" (${this._sessions.size}/${this.maxSessions})`)
    this.emit('session_created', { sessionId, name: sessionName, cwd: resolvedCwd })
    // Flush synchronously — a new session must survive an abrupt shutdown,
    // otherwise rebuilds / crashes during the 2s debounce window lose it.
    this._flushPersist()
    return sessionId
  }

  /**
   * Remove a git worktree, logging errors non-fatally.
   * @param {string} worktreePath - Absolute path to the worktree directory
   * @param {string} repoDir - The original git repo directory (needed for git context)
   * @param {string} sessionId - Used for log messages only
   */
  _removeWorktree(worktreePath, repoDir, sessionId) {
    try {
      execFileSync(GIT, ['-C', repoDir, 'worktree', 'remove', '--force', worktreePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      })
      log.info(`Removed worktree for session ${sessionId}: ${worktreePath}`)
      return
    } catch (err) {
      log.warn(`git worktree remove failed for session ${sessionId}, falling back to direct removal: ${err?.stderr?.trim() || err?.message || String(err)}`)
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true })
      log.info(`Removed worktree directory for session ${sessionId}: ${worktreePath}`)
    } catch (err) {
      log.error(`Failed to remove worktree directory ${worktreePath}: ${err.message}`)
    }
  }

  /**
   * Get a session entry by ID.
   * Returns null if the session does not exist or is currently being destroyed.
   * @returns {{ session: object, name: string, cwd: string, createdAt: number } | null}
   */
  getSession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry || entry._destroying) return null
    return entry
  }

  /**
   * List all sessions with summary info.
   * @returns {Array<{ sessionId, name, cwd, model, permissionMode, isBusy, createdAt }>}
   */
  listSessions() {
    const list = []
    for (const [sessionId, entry] of this._sessions) {
      if (entry._destroying) continue
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
        worktree: entry.worktreePath != null,
        repoCwd: entry.worktreeRepoDir || null,
        isolation: entry.isolation || 'none',
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
   * Check if a session is currently locked for mutation.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSessionLocked(sessionId) {
    return this._locks.isLocked(sessionId)
  }

  /**
   * Acquire a mutation lock for a session. Returns a release function.
   * @param {string} sessionId
   * @returns {Promise<() => void>}
   */
  acquireSessionLock(sessionId) {
    return this._locks.acquire(sessionId)
  }

  /**
   * Rename a session with mutation lock.
   * @returns {Promise<boolean>}
   */
  async renameSessionLocked(sessionId, name) {
    const release = await this._locks.acquire(sessionId)
    try {
      return this.renameSession(sessionId, name)
    } finally {
      release()
    }
  }

  /**
   * Destroy a session with mutation lock.
   * Sets _destroying immediately (before lock acquisition) so concurrent
   * getSession() calls see the session as unavailable right away.
   * @returns {Promise<boolean>}
   */
  async destroySessionLocked(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (entry) entry._destroying = true
    const release = await this._locks.acquire(sessionId)
    try {
      return this.destroySession(sessionId)
    } finally {
      release()
    }
  }

  /**
   * Rename a session.
   * @returns {boolean}
   */
  renameSession(sessionId, name) {
    const entry = this._sessions.get(sessionId)
    if (!entry) {
      log.error(`Cannot rename: session ${sessionId} not found`)
      return false
    }
    entry.name = name
    entry._autoLabeled = true // prevent auto-label from overwriting manual rename
    log.info(`Renamed session ${sessionId} to "${name}"`)
    this.emit('session_updated', { sessionId, name })
    // Flush synchronously — before this, renames were never persisted at all,
    // so a restart would show the pre-rename label.
    this._flushPersist()
    return true
  }

  /**
   * Destroy a specific session.
   * Sets _destroying = true at the start so concurrent getSession() calls
   * treat the session as unavailable while cleanup is in progress.
   * @returns {boolean}
   */
  destroySession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) {
      log.error(`Cannot destroy: session ${sessionId} not found`)
      return false
    }
    // Mark as destroying immediately — getSession() will return null from here on
    entry._destroying = true
    metrics.inc('sessions.destroyed')
    // Detach listeners BEFORE destroy to prevent orphaned events (FM-04)
    entry.session.removeAllListeners()
    // Prevent unhandled 'error' throw if session emits error during destroy
    entry.session.on('error', () => {})
    // Emit synthetic stream_end for any in-flight streams so clients see termination
    const closedMessageIds = this._history.closePendingStreams(sessionId)
    for (const messageId of closedMessageIds) {
      this.emit('session_event', { sessionId, event: 'stream_end', data: { messageId } })
    }
    try {
      entry.session.destroy()
    } catch (destroyErr) {
      log.error(`Error destroying session ${sessionId} "${entry.name}": ${destroyErr?.stack || destroyErr}`)
    }
    this._cleanupSessionMaps(sessionId)
    if (entry.worktreePath) {
      this._removeWorktree(entry.worktreePath, entry.worktreeRepoDir, sessionId)
    }
    log.info(`Destroyed session ${sessionId} "${entry.name}" (${this._sessions.size}/${this.maxSessions})`)
    this.emit('session_destroyed', { sessionId })
    // Flush synchronously so the deletion survives an abrupt shutdown.
    this._flushPersist()
    return true
  }

  /**
   * Destroy all sessions (shutdown cleanup).
   */
  destroyAll() {
    this.stopSessionTimeouts()
    this._persistence.cancelPersist()
    try {
      this.serializeState()
    } catch (err) {
      log.error(`Failed to serialize state during destroyAll: ${err?.stack || err}`)
    }
    for (const [sessionId, entry] of this._sessions) {
      entry.session.removeAllListeners()
      entry.session.on('error', () => {})
      try {
        entry.session.destroy()
      } catch (destroyErr) {
        log.error(`Error destroying session ${sessionId} "${entry.name}" during destroyAll(): ${destroyErr?.stack || destroyErr}`)
      }
      if (entry.worktreePath) {
        this._removeWorktree(entry.worktreePath, entry.worktreeRepoDir, sessionId)
      }
      this.emit('session_destroyed', { sessionId })
    }
    this._sessions.clear()
    this._timeoutManager.destroy()
    this._history.clear()
    this._costBudget.clear()
  }

  /**
   * Get the first session ID (used as default).
   * @returns {string | null}
   */
  get firstSessionId() {
    for (const [id, entry] of this._sessions) {
      if (!entry._destroying) return id
    }
    return null
  }

  get defaultCwd() {
    return this._defaultCwd
  }

  /**
   * Current max messages per session (from SessionMessageHistory).
   * @returns {number}
   */
  get maxMessages() {
    return this._history.maxMessages
  }

  /**
   * Serialize session state to disk for graceful restart.
   * Called during drain before the process exits.
   * @returns {object} The serialized state
   */
  serializeState() {
    const state = { version: 1, timestamp: Date.now(), sessions: [] }
    for (const [id, entry] of this._sessions) {
      const history = this._history.getHistory(id).map(e => this._history.truncateEntry(e))
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
    const budgetState = this._costBudget.serialize()
    state.costs = budgetState.costs
    state.budgetWarned = budgetState.budgetWarned
    state.budgetExceeded = budgetState.budgetExceeded
    state.budgetPaused = budgetState.budgetPaused

    return this._persistence.serializeState(state)
  }

  /**
   * Restore session state from disk after a restart.
   * Creates new sessions using saved parameters. SdkSession can resume
   * via resumeSessionId; CliSession starts fresh (process state is ephemeral).
   * @returns {string|null} The first restored session ID, or null
   */
  restoreState() {
    const state = this._persistence.restoreState()
    if (!state) return null

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
        // Keep _sessionCounter ahead of any restored "Session N" names so the
        // first new auto-named session after restore never collides (#2338).
        if (saved.name) {
          const match = saved.name.match(/^Session (\d+)$/)
          if (match) {
            const n = parseInt(match[1], 10)
            if (n > this._sessionCounter) this._sessionCounter = n
          }
        }
        // Restore message history if present (v1+)
        if (hasVersion && Array.isArray(saved.history) && saved.history.length > 0) {
          this._history.setHistory(sessionId, saved.history)
        }
        if (!firstId) firstId = sessionId
        log.info(`Restored session "${saved.name}" (SDK resume: ${saved.sdkSessionId || 'none'})`)
      } catch (err) {
        log.error(`Failed to restore session "${saved.name}": ${err.message}`)
      }
    }

    // Restore cost tracking data (v1+), remapping old IDs to new IDs.
    this._costBudget.restore(state, oldToNew.size > 0 ? oldToNew : null)

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
    return this._history.getHistory(sessionId)
  }

  /**
   * Get the count of messages in the ring buffer for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getHistoryCount(sessionId) {
    return this._history.getHistoryCount(sessionId)
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  isHistoryTruncated(sessionId) {
    return this._history.isHistoryTruncated(sessionId)
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
    if (!entry || entry._destroying) return []

    const conversationId = entry.session.resumeSessionId
    if (conversationId) {
      try {
        const filePath = resolveJsonlPath(entry.cwd, conversationId)
        const history = await readConversationHistoryAsync(filePath)
        if (history.length > 0) return history
      } catch (err) {
        log.error(`Failed to read JSONL history for session ${sessionId}: ${err?.message || err}`)
      }
    }

    // Fallback to ring buffer
    return this.getHistory(sessionId)
  }

  /**
   * Record a user input message in the session's history ring buffer.
   * Public API for ws-server to record user messages so they survive reconnect replay.
   *
   * On the first non-empty input, auto-labels sessions with default names
   * ("Session N" or "New Session") to a truncation of the input text.
   */
  recordUserInput(sessionId, text) {
    const entry = this._sessions.get(sessionId)
    this._history.recordUserInput(sessionId, text, entry || undefined)
  }

  /**
   * Record an event into the session's message history ring buffer.
   * Delegates to SessionMessageHistory and triggers persist when needed.
   */
  _recordHistory(sessionId, event, data) {
    const { persistNeeded } = this._history.recordHistory(sessionId, event, data)
    if (persistNeeded) {
      this._schedulePersist()
    }
  }

  /**
   * Push an entry to the history array, trimming to max size.
   * Backward-compatible delegate to SessionMessageHistory._pushHistory.
   * @param {Array} history - The session history array to push to
   * @param {object} entry - The history entry to add
   * @param {string} sessionId - The session ID (used for truncation tracking)
   */
  _pushHistory(history, entry, sessionId) {
    this._history._pushHistory(history, entry, sessionId)
  }

  /**
   * Schedule a debounced persist. Multiple rapid calls reset the timer.
   */
  _schedulePersist() {
    this._persistence.schedulePersist(() => this.serializeState())
  }

  /**
   * Flush persist synchronously, bypassing the debounce. Use for session-list
   * mutations (create/rename/destroy) where losing the write on abrupt
   * shutdown erases a user's session. History/budget updates should keep
   * using the debounced path to avoid write amplification.
   */
  _flushPersist() {
    this._persistence.flushPersist(() => this.serializeState())
  }

  /**
   * Wire session events to unified session_event emission.
   * Handles both CliSession and PtySession events.
   */
  _wireSessionEvents(sessionId, session) {
    const PROXIED_EVENTS = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result', 'result', 'error', 'user_question']
    // Events that indicate meaningful activity (reset idle timeout)
    const ACTIVITY_EVENTS = new Set(['message', 'stream_start', 'tool_start', 'result', 'user_question'])
    // Session-scoped logger — entries are tagged with sessionId for per-session routing
    const sessionLog = log.withSession(sessionId)
    // Events worth logging to the System tab (skip noisy delta/tool_result)
    const LOGGED_EVENTS = new Set(['ready', 'stream_start', 'stream_end', 'result', 'error'])
    for (const event of PROXIED_EVENTS) {
      session.on(event, (data) => {
        if (ACTIVITY_EVENTS.has(event)) this._timeoutManager.touchActivity(sessionId)
        this._recordHistory(sessionId, event, data)
        this.emit('session_event', { sessionId, event, data })
        if (LOGGED_EVENTS.has(event)) {
          const detail = event === 'error' ? `: ${data?.message || ''}` : ''
          const logFn = event === 'error' ? sessionLog.error : sessionLog.info
          logFn(`[${event}]${detail}`)
        }

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
          const sessionEntry = this._sessions.get(sessionId)
          const model = session.currentModel || sessionEntry?.model || null
          this._trackCost(sessionId, data.cost, model)
        }
      })
    }

    // Transient events — forwarded but not recorded in history (not replayed on reconnect)
    const builtinTransient = ['permission_request', 'permission_expired', 'agent_spawned', 'agent_completed', 'plan_started', 'plan_ready', 'mcp_servers']
    const customEvents = Array.isArray(session.constructor.customEvents) ? session.constructor.customEvents : []
    const TRANSIENT_EVENTS = [...new Set([...builtinTransient, ...customEvents])]
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
  // Session idle timeout (delegated to SessionTimeoutManager)
  // ---------------------------------------------------------------------------

  /**
   * Set the function used to check if a session has active WebSocket viewers.
   * Called by WsServer after construction to wire the two components together.
   * @param {(sessionId: string) => boolean} fn
   */
  setActiveViewersFn(fn) {
    this._timeoutManager.setActiveViewersFn(fn)
  }

  /**
   * Record activity for a session (resets idle timer).
   * Called internally on relevant events, and publicly by WsServer on user input.
   */
  touchActivity(sessionId) {
    this._timeoutManager.touchActivity(sessionId)
  }

  /**
   * Expose internal timeout tracking state for backward compatibility.
   * Tests and internal code may reference these directly.
   */
  get _lastActivity() {
    return this._timeoutManager._lastActivity
  }

  get _sessionWarned() {
    return this._timeoutManager._sessionWarned
  }

  // ---------------------------------------------------------------------------
  // Cost budget tracking
  // ---------------------------------------------------------------------------

  /**
   * Track cumulative cost for a session and check budget thresholds.
   * @param {string} sessionId
   * @param {number} cost - Cost of the latest query in dollars
   */
  _trackCost(sessionId, cost, model = null) {
    const budgetEvent = this._costBudget.trackCost(sessionId, cost, model)
    const cumulative = this._costBudget.getSessionCost(sessionId)

    // Emit cost_update for every result so app can track cumulative cost
    const entry = this._sessions.get(sessionId)
    this.emit('session_event', {
      sessionId,
      event: 'cost_update',
      data: {
        sessionCost: cumulative,
        totalCost: this._costBudget.getTotalCost(),
        budget: this._costBudget.getBudget(),
      },
    })

    if (budgetEvent) {
      const budget = this._costBudget.getBudget()
      this.emit('session_event', {
        sessionId,
        event: budgetEvent.event,
        data: {
          ...budgetEvent.data,
          message: budgetEvent.event === 'budget_exceeded'
            ? `Session "${entry?.name || sessionId}" has exceeded the $${budget.toFixed(2)} budget ($${cumulative.toFixed(4)})`
            : `Session "${entry?.name || sessionId}" has used ${budgetEvent.data.percent}% of the $${budget.toFixed(2)} budget ($${cumulative.toFixed(4)})`,
        },
      })
    }
  }

  /**
   * Start periodic session timeout checks.
   * Only starts if sessionTimeout was configured.
   */
  startSessionTimeouts() {
    this._timeoutManager.start()
  }

  /**
   * Stop periodic session timeout checks.
   */
  stopSessionTimeouts() {
    this._timeoutManager.stop()
  }

  getSessionCost(sessionId) {
    return this._costBudget.getSessionCost(sessionId)
  }

  getTotalCost() {
    return this._costBudget.getTotalCost()
  }

  getCostBudget() {
    return this._costBudget.getBudget()
  }

  isBudgetPaused(sessionId) {
    return this._costBudget.isPaused(sessionId)
  }

  resumeBudget(sessionId) {
    this._costBudget.resume(sessionId)
    this._schedulePersist()
    log.info(`Budget pause overridden for session ${sessionId}`)
  }

  getCostByModel() {
    return this._costBudget.getCostByModel()
  }

  getSpendRate() {
    return this._costBudget.getSpendRate()
  }
}
