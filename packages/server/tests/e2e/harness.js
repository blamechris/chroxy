/**
 * E2E test harness for Chroxy server.
 *
 * Provides a MockSessionManager that implements the SessionManager interface
 * with controllable mock sessions, plus helpers to start a real WsServer,
 * connect WebSocket clients, and drive the full protocol.
 */
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { WsServer } from '../../src/ws-server.js'

// ── Mock Session ──────────────────────────────────────────────────────────

/**
 * Mock session that implements the CliSession/SdkSession interface.
 * Test code can call helper methods (e.g. emitReady, emitStream) to
 * simulate Claude responses without spawning a real process.
 */
export class MockSession extends EventEmitter {
  constructor({ cwd, model, permissionMode } = {}) {
    super()
    this.cwd = cwd || process.cwd()
    this.model = model || 'claude-sonnet-4-20250514'
    this.permissionMode = permissionMode || 'approve'
    this.isReady = false
    this.isRunning = false
    this.destroyed = false
    this._messages = []         // input messages received
    this._interrupted = false
    this._permissionResponses = new Map()
    this._questionAnswer = null
    this.resumeSessionId = null
  }

  start() {
    // Auto-ready after a tick (simulates process startup)
    setTimeout(() => {
      this.isReady = true
      this.emit('ready', { sessionId: randomUUID().slice(0, 8), model: this.model })
    }, 10)
  }

  destroy() {
    this.destroyed = true
    this.isReady = false
  }

  sendMessage(text) {
    this._messages.push(text)
  }

  interrupt() {
    this._interrupted = true
  }

  setModel(model) {
    this.model = model
  }

  setPermissionMode(mode) {
    this.permissionMode = mode
  }

  respondToPermission(requestId, decision) {
    this._permissionResponses.set(requestId, decision)
  }

  respondToQuestion(answer) {
    this._questionAnswer = answer
  }

  resize() {}

  // ── Helpers for tests to trigger events ──

  /** Simulate Claude becoming ready */
  emitReady() {
    this.isReady = true
    this.emit('ready', { sessionId: randomUUID().slice(0, 8), model: this.model })
  }

  /** Simulate a full streaming response */
  emitStream(text) {
    const messageId = randomUUID().slice(0, 8)
    this.isRunning = true
    this.emit('stream_start', { messageId })
    // Send text in chunks
    const chunkSize = Math.ceil(text.length / 3)
    for (let i = 0; i < text.length; i += chunkSize) {
      this.emit('stream_delta', { messageId, delta: text.slice(i, i + chunkSize) })
    }
    this.emit('stream_end', { messageId })
    this.isRunning = false
    this.emit('result', { cost: 0.001, duration: 100, usage: {} })
    return messageId
  }

  /** Simulate a tool use event */
  emitToolStart(tool, input) {
    const messageId = randomUUID().slice(0, 8)
    this.emit('tool_start', { messageId, tool, input })
    return messageId
  }

  /** Simulate a parsed message */
  emitMessage(type, content, extra = {}) {
    this.emit('message', { type, content, timestamp: Date.now(), ...extra })
  }

  /** Simulate a permission request */
  emitPermissionRequest(tool, description, input = {}) {
    const requestId = `perm-${Date.now()}`
    this.emit('permission_request', { requestId, tool, description, input })
    return requestId
  }

  /** Simulate a user question */
  emitUserQuestion(questions) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
    this.emit('user_question', { toolUseId, questions })
    return toolUseId
  }
}

// ── Mock Session Manager ──────────────────────────────────────────────────

/**
 * Mock SessionManager that creates MockSession instances instead of real
 * CliSession/SdkSession. Implements the full SessionManager interface used
 * by WsServer.
 */
export class MockSessionManager extends EventEmitter {
  constructor({ maxSessions = 5, defaultCwd } = {}) {
    super()
    this.maxSessions = maxSessions
    this._defaultCwd = defaultCwd || process.cwd()
    this._sessions = new Map()
    this._messageHistory = new Map()
    this._pendingStreams = new Map()
  }

  createSession({ name, cwd } = {}) {
    if (this._sessions.size >= this.maxSessions) {
      throw new Error(`Maximum sessions (${this.maxSessions}) reached`)
    }

    const sessionId = randomUUID().slice(0, 8)
    const resolvedCwd = cwd || this._defaultCwd
    const sessionName = name || `Session ${this._sessions.size + 1}`

    const session = new MockSession({ cwd: resolvedCwd })
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

  getSession(sessionId) {
    return this._sessions.get(sessionId) || null
  }

  listSessions() {
    const list = []
    for (const [sessionId, entry] of this._sessions) {
      list.push({
        sessionId,
        name: entry.name,
        cwd: entry.cwd,
        type: entry.type,
        hasTerminal: false,
        model: entry.session.model || null,
        permissionMode: entry.session.permissionMode || 'approve',
        isBusy: entry.session.isRunning,
        createdAt: entry.createdAt,
      })
    }
    return list
  }

  renameSession(sessionId, name) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return false
    entry.name = name
    this.emit('session_updated', { sessionId, name })
    return true
  }

  destroySession(sessionId) {
    const entry = this._sessions.get(sessionId)
    if (!entry) return false
    entry.session.destroy()
    this._sessions.delete(sessionId)
    this._messageHistory.delete(sessionId)
    this.emit('session_destroyed', { sessionId })
    return true
  }

  destroyAll() {
    for (const [sessionId, entry] of this._sessions) {
      entry.session.destroy()
      this.emit('session_destroyed', { sessionId })
    }
    this._sessions.clear()
  }

  get firstSessionId() {
    const first = this._sessions.keys().next()
    return first.done ? null : first.value
  }

  discoverSessions() {
    return [] // No tmux in E2E tests
  }

  pollForNewSessions() {}

  async attachSession() {
    throw new Error('tmux not available in E2E tests')
  }

  getHistory(sessionId) {
    return this._messageHistory.get(sessionId) || []
  }

  allIdle() {
    for (const [, entry] of this._sessions) {
      if (entry.session.isRunning) return false
    }
    return true
  }

  startAutoDiscovery() {}
  stopAutoDiscovery() {}

  _wireSessionEvents(sessionId, session) {
    const PROXIED_EVENTS = ['ready', 'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'result', 'error', 'user_question']
    for (const event of PROXIED_EVENTS) {
      session.on(event, (data) => {
        this._recordHistory(sessionId, event, data)
        this.emit('session_event', { sessionId, event, data })
      })
    }

    const TRANSIENT_EVENTS = ['permission_request', 'agent_spawned', 'agent_completed', 'plan_started', 'plan_ready']
    for (const event of TRANSIENT_EVENTS) {
      session.on(event, (data) => {
        this.emit('session_event', { sessionId, event, data })
      })
    }

    session.on('raw', (data) => {
      this.emit('session_event', { sessionId, event: 'raw', data })
    })

    session.on('status_update', (data) => {
      this.emit('session_event', { sessionId, event: 'status_update', data })
    })
  }

  _recordHistory(sessionId, event, data) {
    if (!this._messageHistory.has(sessionId)) {
      this._messageHistory.set(sessionId, [])
    }
    const history = this._messageHistory.get(sessionId)

    switch (event) {
      case 'stream_start': {
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
        const key = `${sessionId}:${data.messageId}`
        const content = this._pendingStreams.get(key) || ''
        this._pendingStreams.delete(key)
        if (content) {
          history.push({
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
        history.push({
          type: 'message',
          messageType: data.type,
          content: data.content,
          tool: data.tool,
          timestamp: data.timestamp,
        })
        break
      case 'result':
        history.push({
          type: 'result',
          cost: data.cost,
          duration: data.duration,
          timestamp: Date.now(),
        })
        break
    }
  }
}

// ── Server Helpers ────────────────────────────────────────────────────────

/**
 * Start a WsServer on an OS-assigned port with the given session manager.
 * Returns the server instance and the assigned port.
 */
export async function startServer({ sessionManager, apiToken, authRequired = false } = {}) {
  const sm = sessionManager || new MockSessionManager()

  // Ensure at least one session exists
  let defaultSessionId = sm.firstSessionId
  if (!defaultSessionId) {
    defaultSessionId = sm.createSession({ name: 'Default' })
  }

  const server = new WsServer({
    port: 0,
    apiToken: apiToken || null,
    sessionManager: sm,
    defaultSessionId,
    authRequired,
  })

  server.start('127.0.0.1')

  // Wait for HTTP server to start listening
  await new Promise((resolve, reject) => {
    function onListening() {
      server.httpServer.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      server.httpServer.removeListener('listening', onListening)
      reject(err)
    }
    server.httpServer.once('listening', onListening)
    server.httpServer.once('error', onError)
  })

  const port = server.httpServer.address().port
  return { server, port, sessionManager: sm, defaultSessionId }
}

// ── Client Helpers ────────────────────────────────────────────────────────

/**
 * Wait for a condition with timeout.
 */
export async function waitFor(conditionFn, timeoutMs = 2000, message = 'Timeout') {
  const start = Date.now()
  while (!conditionFn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * Connect a WebSocket client to the server.
 * Returns the ws instance and a messages array that accumulates all received messages.
 * When authRequired is false, waits for auto-auth (auth_ok).
 * When authRequired is true, caller must send auth manually.
 */
export async function connectClient(port, { token, waitForAuth = true, deviceInfo } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []

  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()))
    } catch {
      // ignore non-JSON
    }
  })

  // Wait for connection
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 2000)
    function onOpen() {
      clearTimeout(timeout)
      ws.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      clearTimeout(timeout)
      ws.removeListener('open', onOpen)
      reject(err)
    }
    ws.once('open', onOpen)
    ws.once('error', onError)
  })

  // If token provided, send auth
  if (token) {
    const authMsg = { type: 'auth', token }
    if (deviceInfo) authMsg.deviceInfo = deviceInfo
    ws.send(JSON.stringify(authMsg))
  }

  // Wait for auth_ok if requested
  if (waitForAuth) {
    await waitFor(
      () => messages.some((m) => m.type === 'auth_ok'),
      2000,
      'Auth timeout',
    )
  }

  return { ws, messages }
}

/** Send a JSON message to the server */
export function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

/**
 * Wait for a message of a specific type to appear in the messages array.
 * Optionally match additional fields.
 */
export async function waitForMessage(messages, type, { timeout = 2000, match } = {}) {
  await waitFor(
    () => messages.some((m) => {
      if (m.type !== type) return false
      if (match) {
        for (const [k, v] of Object.entries(match)) {
          if (m[k] !== v) return false
        }
      }
      return true
    }),
    timeout,
    `Timeout waiting for message type: ${type}${match ? ` matching ${JSON.stringify(match)}` : ''}`,
  )

  return messages.find((m) => {
    if (m.type !== type) return false
    if (match) {
      for (const [k, v] of Object.entries(match)) {
        if (m[k] !== v) return false
      }
    }
    return true
  })
}

/**
 * Collect all messages of a specific type from the messages array.
 */
export function messagesOfType(messages, type) {
  return messages.filter((m) => m.type === type)
}

/**
 * Get the mock session for a session ID from the session manager.
 */
export function getMockSession(sessionManager, sessionId) {
  const entry = sessionManager.getSession(sessionId)
  return entry ? entry.session : null
}

/**
 * Close a WebSocket and wait for it to finish closing.
 */
export async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return
  return new Promise((resolve) => {
    ws.on('close', resolve)
    ws.close()
    // Force-close after 500ms
    setTimeout(() => resolve(), 500)
  })
}
