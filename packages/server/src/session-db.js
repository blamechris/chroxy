/**
 * SQLite-backed session persistence.
 *
 * Replaces the JSON state file + in-memory ring buffer with a single
 * SQLite database. Each message is individually crash-safe (WAL mode).
 *
 * Usage:
 *   const db = new SessionDB('~/.chroxy/sessions.db')
 *   db.saveSession({ id: 'abc', cwd: '/home/user', name: 'Main' })
 *   db.recordMessage('abc', { type: 'message', messageType: 'response', content: 'Hello', timestamp: Date.now() })
 *   const history = db.getHistory('abc', 100)
 *   db.close()
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sdk_session_id TEXT,
    cwd TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    model TEXT,
    permission_mode TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    destroyed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message_type TEXT,
    message_id TEXT,
    content TEXT,
    tool TEXT,
    tool_use_id TEXT,
    input TEXT,
    result TEXT,
    metadata TEXT,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(tool_use_id) WHERE tool_use_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(session_id, type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(session_id, message_id) WHERE message_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    cost REAL,
    duration REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation INTEGER,
    cache_read INTEGER,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_results_session ON results(session_id);
`

export class SessionDB {
  /**
   * @param {string} dbPath - Path to SQLite database file
   */
  constructor(dbPath) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this._db = new Database(dbPath)
    this._db.pragma('journal_mode = WAL')
    this._db.pragma('foreign_keys = ON')
    this._db.pragma('synchronous = NORMAL')  // Safe with WAL

    this._db.exec(SCHEMA_SQL)

    // Set schema version
    this._db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version', String(SCHEMA_VERSION)
    )

    // Prepare common statements for performance
    this._stmts = {
      insertSession: this._db.prepare(`
        INSERT OR REPLACE INTO sessions (id, sdk_session_id, cwd, name, model, permission_mode, created_at, updated_at)
        VALUES (@id, @sdkSessionId, @cwd, @name, @model, @permissionMode, @createdAt, @updatedAt)
      `),

      updateSession: this._db.prepare(`
        UPDATE sessions SET
          sdk_session_id = COALESCE(@sdkSessionId, sdk_session_id),
          name = COALESCE(@name, name),
          model = COALESCE(@model, model),
          permission_mode = COALESCE(@permissionMode, permission_mode),
          updated_at = @updatedAt
        WHERE id = @id
      `),

      destroySession: this._db.prepare(`
        UPDATE sessions SET destroyed_at = ? WHERE id = ?
      `),

      deleteSession: this._db.prepare(`
        DELETE FROM sessions WHERE id = ?
      `),

      getSession: this._db.prepare(`
        SELECT * FROM sessions WHERE id = ?
      `),

      getActiveSessions: this._db.prepare(`
        SELECT * FROM sessions WHERE destroyed_at IS NULL ORDER BY created_at
      `),

      insertMessage: this._db.prepare(`
        INSERT OR IGNORE INTO messages
          (session_id, type, message_type, message_id, content, tool, tool_use_id, input, result, metadata, timestamp)
        VALUES
          (@sessionId, @type, @messageType, @messageId, @content, @tool, @toolUseId, @input, @result, @metadata, @timestamp)
      `),

      getHistory: this._db.prepare(`
        SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
      `),

      getHistoryAfter: this._db.prepare(`
        SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?
      `),

      getMessageCount: this._db.prepare(`
        SELECT COUNT(*) as count FROM messages WHERE session_id = ?
      `),

      updateToolResult: this._db.prepare(`
        UPDATE messages SET result = ?, metadata = json_patch(COALESCE(metadata, '{}'), ?)
        WHERE tool_use_id = ? AND session_id = ?
      `),

      insertResult: this._db.prepare(`
        INSERT INTO results (session_id, cost, duration, input_tokens, output_tokens, cache_creation, cache_read, timestamp)
        VALUES (@sessionId, @cost, @duration, @inputTokens, @outputTokens, @cacheCreation, @cacheRead, @timestamp)
      `),

      getSessionCost: this._db.prepare(`
        SELECT COALESCE(SUM(cost), 0) as total_cost FROM results WHERE session_id = ?
      `),

      pruneOldMessages: this._db.prepare(`
        DELETE FROM messages WHERE session_id = ? AND id NOT IN (
          SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
        )
      `),
    }
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  /**
   * Create or update a session.
   * @param {object} session
   * @param {string} session.id
   * @param {string} [session.sdkSessionId]
   * @param {string} session.cwd
   * @param {string} [session.name]
   * @param {string} [session.model]
   * @param {string} [session.permissionMode]
   */
  saveSession(session) {
    const now = Date.now()
    this._stmts.insertSession.run({
      id: session.id,
      sdkSessionId: session.sdkSessionId || null,
      cwd: session.cwd,
      name: session.name || '',
      model: session.model || null,
      permissionMode: session.permissionMode || null,
      createdAt: session.createdAt || now,
      updatedAt: now,
    })
  }

  /**
   * Update specific fields on a session.
   */
  updateSession(sessionId, fields) {
    this._stmts.updateSession.run({
      id: sessionId,
      sdkSessionId: fields.sdkSessionId ?? null,
      name: fields.name ?? null,
      model: fields.model ?? null,
      permissionMode: fields.permissionMode ?? null,
      updatedAt: Date.now(),
    })
  }

  /**
   * Mark a session as destroyed (soft delete).
   */
  destroySession(sessionId) {
    this._stmts.destroySession.run(Date.now(), sessionId)
  }

  /**
   * Permanently delete a session and all its messages.
   */
  deleteSession(sessionId) {
    this._stmts.deleteSession.run(sessionId)
  }

  /**
   * Get a single session by ID.
   */
  getSession(sessionId) {
    return this._stmts.getSession.get(sessionId) || null
  }

  /**
   * Get all active (non-destroyed) sessions.
   */
  getActiveSessions() {
    return this._stmts.getActiveSessions.all()
  }

  // ---------------------------------------------------------------------------
  // Message recording
  // ---------------------------------------------------------------------------

  /**
   * Record a message to history.
   * Uses INSERT OR IGNORE with UNIQUE(session_id, message_id) for dedup.
   *
   * @param {string} sessionId
   * @param {object} entry
   * @param {string} entry.type - 'message', 'tool_start', 'tool_result', 'stream', 'result', 'user_question'
   * @param {string} [entry.messageType] - 'user_input', 'response', 'system', 'error', 'prompt'
   * @param {string} [entry.messageId] - Server-assigned ID for dedup
   * @param {string} [entry.content]
   * @param {string} [entry.tool]
   * @param {string} [entry.toolUseId]
   * @param {*} [entry.input] - Tool input (will be JSON.stringify'd if not string)
   * @param {*} [entry.result] - Tool result (will be JSON.stringify'd if not string)
   * @param {object} [entry.metadata] - Additional fields (options, attachments, usage, etc.)
   * @param {number} [entry.timestamp]
   */
  recordMessage(sessionId, entry) {
    const input = entry.input != null
      ? (typeof entry.input === 'string' ? entry.input : JSON.stringify(entry.input))
      : null
    const result = entry.result != null
      ? (typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result))
      : null
    const metadata = entry.metadata != null ? JSON.stringify(entry.metadata) : null

    this._stmts.insertMessage.run({
      sessionId,
      type: entry.type,
      messageType: entry.messageType || null,
      messageId: entry.messageId || null,
      content: entry.content || null,
      tool: entry.tool || null,
      toolUseId: entry.toolUseId || null,
      input,
      result,
      metadata,
      timestamp: entry.timestamp || Date.now(),
    })

    // Touch session updated_at
    this._db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
  }

  /**
   * Record multiple messages in a single transaction (bulk insert).
   */
  recordMessages(sessionId, entries) {
    const insert = this._db.transaction((items) => {
      for (const entry of items) {
        this.recordMessage(sessionId, entry)
      }
    })
    insert(entries)
  }

  /**
   * Update a tool result by toolUseId.
   */
  updateToolResult(sessionId, toolUseId, result, metadata) {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
    const metaStr = metadata ? JSON.stringify(metadata) : '{}'
    this._stmts.updateToolResult.run(resultStr, metaStr, toolUseId, sessionId)
  }

  // ---------------------------------------------------------------------------
  // History retrieval
  // ---------------------------------------------------------------------------

  /**
   * Get the last N messages for a session, in chronological order.
   * @param {string} sessionId
   * @param {number} [limit=500]
   * @returns {object[]}
   */
  getHistory(sessionId, limit = 500) {
    const rows = this._stmts.getHistory.all(sessionId, limit)
    // Reverse to chronological order (query was DESC for LIMIT efficiency)
    rows.reverse()
    return rows.map(this._deserializeRow)
  }

  /**
   * Get message count for a session.
   */
  getMessageCount(sessionId) {
    return this._stmts.getMessageCount.get(sessionId)?.count || 0
  }

  /**
   * Get the total cost for a session.
   */
  getSessionCost(sessionId) {
    return this._stmts.getSessionCost.get(sessionId)?.total_cost || 0
  }

  // ---------------------------------------------------------------------------
  // Result recording
  // ---------------------------------------------------------------------------

  /**
   * Record a result event (cost, usage, duration).
   */
  recordResult(sessionId, result) {
    this._stmts.insertResult.run({
      sessionId,
      cost: result.cost ?? null,
      duration: result.duration ?? null,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      cacheCreation: result.cacheCreation ?? null,
      cacheRead: result.cacheRead ?? null,
      timestamp: result.timestamp || Date.now(),
    })
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /**
   * Prune old messages, keeping only the last N per session.
   * Run periodically or on startup to control disk usage.
   */
  pruneMessages(sessionId, keepCount = 5000) {
    this._stmts.pruneOldMessages.run(sessionId, sessionId, keepCount)
  }

  /**
   * Delete destroyed sessions older than the given age.
   */
  purgeOldSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs
    this._db.prepare('DELETE FROM sessions WHERE destroyed_at IS NOT NULL AND destroyed_at < ?').run(cutoff)
  }

  // ---------------------------------------------------------------------------
  // Migration from JSON state file
  // ---------------------------------------------------------------------------

  /**
   * Import sessions and history from a JSON state file.
   * @param {string} jsonPath - Path to session-state.json
   * @returns {{ sessions: number, messages: number }} Import counts
   */
  migrateFromJson(jsonPath) {
    if (!existsSync(jsonPath)) return { sessions: 0, messages: 0 }

    let state
    try {
      state = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    } catch {
      console.warn('[session-db] Failed to parse JSON state file for migration')
      return { sessions: 0, messages: 0 }
    }

    if (!state.sessions || !Array.isArray(state.sessions)) {
      return { sessions: 0, messages: 0 }
    }

    let sessionCount = 0
    let messageCount = 0

    const migrate = this._db.transaction(() => {
      for (const session of state.sessions) {
        const id = session.sdkSessionId || `migrated-${Date.now()}-${Math.random().toString(36).slice(2)}`

        this.saveSession({
          id,
          sdkSessionId: session.sdkSessionId || null,
          cwd: session.cwd || homedir(),
          name: session.name || 'Migrated Session',
          model: session.model || null,
          permissionMode: session.permissionMode || null,
          createdAt: state.timestamp || Date.now(),
        })
        sessionCount++

        if (Array.isArray(session.history)) {
          for (const entry of session.history) {
            this.recordMessage(id, entry)
            messageCount++
          }
        }
      }
    })

    migrate()

    // Backup the old file
    try {
      renameSync(jsonPath, jsonPath + '.bak')
      console.log(`[session-db] Migrated ${sessionCount} sessions, ${messageCount} messages from JSON`)
    } catch {
      console.warn('[session-db] Could not rename old JSON state file')
    }

    return { sessions: sessionCount, messages: messageCount }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _deserializeRow(row) {
    const entry = { ...row }
    if (entry.input) {
      try { entry.input = JSON.parse(entry.input) } catch { /* keep as string */ }
    }
    if (entry.result) {
      try { entry.result = JSON.parse(entry.result) } catch { /* keep as string */ }
    }
    if (entry.metadata) {
      try { entry.metadata = JSON.parse(entry.metadata) } catch { entry.metadata = null }
    }
    return entry
  }

  /**
   * Convert a database row to the WebSocket message format expected by clients.
   * This mirrors the format used by SessionManager._recordHistory → _replayHistory.
   */
  toWsMessage(row) {
    switch (row.type) {
      case 'message':
        return {
          type: 'message',
          messageType: row.message_type,
          content: row.content || '',
          tool: row.tool || undefined,
          options: row.metadata?.options || undefined,
          timestamp: row.timestamp,
          sessionId: row.session_id,
        }
      case 'stream':
        return {
          type: 'message',
          messageType: 'response',
          content: row.content || '',
          timestamp: row.timestamp,
          sessionId: row.session_id,
        }
      case 'tool_start':
        return {
          type: 'tool_start',
          messageId: row.message_id,
          toolUseId: row.tool_use_id,
          tool: row.tool,
          input: row.input,
          sessionId: row.session_id,
        }
      case 'tool_result':
        return {
          type: 'tool_result',
          toolUseId: row.tool_use_id,
          result: row.result,
          sessionId: row.session_id,
        }
      case 'user_question':
        return {
          type: 'user_question',
          toolUseId: row.tool_use_id,
          questions: row.metadata?.questions || [],
          sessionId: row.session_id,
        }
      default:
        return {
          type: row.type,
          ...row.metadata,
          content: row.content,
          timestamp: row.timestamp,
          sessionId: row.session_id,
        }
    }
  }

  /**
   * Close the database connection.
   */
  close() {
    this._db.close()
  }
}

/**
 * Default database path.
 */
export function defaultDbPath() {
  return join(homedir(), '.chroxy', 'sessions.db')
}
