import { EventEmitter } from 'node:events'

// Re-export GIT from the source module so test files can import it from here
export { GIT } from '../src/git.js'

/**
 * Poll until a predicate returns a truthy value, then return it.
 * Throws if timeoutMs elapses before the predicate is satisfied.
 *
 * Usage:
 *   const msg = await waitFor(() => messages.find(m => m.type === 'foo'))
 *   await waitFor(() => spy.callCount >= 1)
 *
 * @param {() => any} predicate - Checked every `intervalMs`; resolves when truthy.
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options] - Optional configuration.
 * @param {number} [options.timeoutMs=2000]  - Max wait in milliseconds.
 * @param {number} [options.intervalMs=10]   - Polling interval in milliseconds.
 * @param {string} [options.label='waitFor condition'] - Included in timeout error message.
 * @returns {Promise<any>} the truthy value returned by predicate
 */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10, label = 'waitFor condition' } = {}) {
  const start = Date.now()
  while (true) {
    const result = await predicate()
    if (result) return result
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms: ${label}`)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

/**
 * Wait for an EventEmitter to emit `event`, then return the emitted value.
 * Rejects with a helpful message if `timeoutMs` elapses first — prevents
 * tests from hanging until the global test timeout when an event never fires.
 *
 * Usage:
 *   const lostEvent = await waitForEvent(adapter, 'tunnel_lost')
 *   const recovered = await waitForEvent(adapter, 'tunnel_recovered', 2000)
 *
 * @param {import('node:events').EventEmitter} emitter - The emitter to listen on.
 * @param {string} event - Event name to wait for.
 * @param {number} [timeoutMs=5000] - Reject after this many ms.
 * @returns {Promise<any>} resolves with the first arg passed to the listener
 */
export function waitForEvent(emitter, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onEvent = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      emitter.removeListener(event, onEvent)
      reject(new Error(`Expected '${event}' event within ${timeoutMs}ms but it never fired`))
    }, timeoutMs)
    emitter.once(event, onEvent)
  })
}

/**
 * Wait until a message of the given `type` appears in `messages`, then return it.
 * Thin wrapper around waitFor for the common WS integration pattern.
 *
 * Usage:
 *   const authOk = await waitForType(messages, 'auth_ok')
 *
 * @param {Array<{type: string}>} messages - Array of received messages (mutated by ws.on('message'))
 * @param {string} type - Message type to wait for
 * @param {{timeoutMs?: number, intervalMs?: number}} [options]
 * @returns {Promise<object>} the matching message
 */
export async function waitForType(messages, type, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  return waitFor(() => messages.find(m => m.type === type), {
    timeoutMs,
    intervalMs,
    label: `message type: ${type}`,
  })
}

/**
 * Create a spy function that records all calls.
 *
 * Usage:
 *   const spy = createSpy()
 *   spy('hello', 42)
 *   spy.calls     // [['hello', 42]]
 *   spy.callCount // 1
 *   spy.lastCall  // ['hello', 42]
 *
 * With return value:
 *   const spy = createSpy(() => 'result')
 *   spy('a')      // returns 'result'
 *
 * Reset:
 *   spy.reset()
 */
export function createSpy(impl) {
  const calls = []
  const spy = (...args) => {
    calls.push(args)
    return impl ? impl(...args) : undefined
  }
  spy.calls = calls
  Object.defineProperty(spy, 'callCount', { get: () => calls.length })
  Object.defineProperty(spy, 'lastCall', { get: () => calls[calls.length - 1] || null })
  spy.reset = () => { calls.length = 0 }
  return spy
}

/**
 * Create a mock session manager with spy methods.
 *
 * Always returns { manager, sessionsMap } so callers can access
 * individual session entries when needed.
 *
 * Session data objects support:
 *   { id, name, cwd, type?, isRunning? }
 *
 * The manager is an EventEmitter with the same API surface as
 * the real SessionManager: getSession, listSessions, getHistory,
 * recordUserInput, touchActivity, getFullHistoryAsync,
 * isBudgetPaused, getSessionContext, firstSessionId.
 *
 * Override any method via the overrides parameter:
 *   createMockSessionManager(sessions, { getHistory: () => [...] })
 */
export function createMockSessionManager(sessions = [], overrides = {}) {
  const manager = new EventEmitter()
  const sessionsMap = new Map()

  for (const s of sessions) {
    const mockSession = createMockSession()
    mockSession.cwd = s.cwd
    if (s.isRunning !== undefined) mockSession.isRunning = s.isRunning
    sessionsMap.set(s.id, {
      session: mockSession,
      name: s.name,
      cwd: s.cwd || '/tmp',
      type: s.type || 'cli',
      isBusy: s.isRunning || false,
    })
  }

  manager.getSession = (id) => sessionsMap.get(id)
  manager.listSessions = () => {
    const list = []
    for (const [sessionId, entry] of sessionsMap) {
      list.push({
        sessionId,
        name: entry.name,
        cwd: entry.cwd,
        type: entry.type,
        isBusy: entry.isBusy,
      })
    }
    return list
  }
  manager.getHistory = () => []
  manager.recordUserInput = () => {}
  manager.touchActivity = () => {}
  manager.getFullHistoryAsync = async () => []
  manager.isBudgetPaused = () => false
  manager.getSessionContext = async () => null
  Object.defineProperty(manager, 'firstSessionId', {
    get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null,
    configurable: true,
  })

  for (const [key, value] of Object.entries(overrides)) {
    const desc = Object.getOwnPropertyDescriptor(manager, key)
    if (desc && !desc.writable && !desc.set) {
      Object.defineProperty(manager, key, typeof value === 'function'
        ? { get: value, configurable: true }
        : { value, configurable: true })
    } else {
      manager[key] = value
    }
  }

  return { manager, sessionsMap }
}

/**
 * Create a mock session with spy methods.
 *
 * All methods are spies — you can check calls, arguments, and call counts.
 *
 *   const session = createMockSession()
 *   session.sendMessage('hello')
 *   session.sendMessage.callCount  // 1
 *   session.sendMessage.lastCall   // ['hello']
 *
 * Override individual methods:
 *   const session = createMockSession({
 *     sendMessage: createSpy(() => 'sent'),
 *   })
 */
export function createMockSession(overrides = {}) {
  const session = new EventEmitter()
  session.isReady = true
  session.model = 'claude-sonnet-4-6'
  session.permissionMode = 'approve'
  session.sendMessage = createSpy()
  session.interrupt = createSpy()
  session.setModel = createSpy()
  session.setPermissionMode = createSpy()
  session.respondToQuestion = createSpy()
  session.respondToPermission = createSpy()
  Object.assign(session, overrides)
  return session
}

/**
 * Test helper: arm the SdkSession result-inactivity timeout without going
 * through sendMessage(). Lets unit tests exercise the 5-minute pause/resume
 * path in isolation. Lives in test-helpers so production module exports
 * only production API (#2870).
 *
 * @param {import('../src/sdk-session.js').SdkSession} session
 * @param {string} messageId
 * @param {boolean} [hasStreamStarted=false]
 */
export function armResultTimeoutForTest(session, messageId, hasStreamStarted = false) {
  const reset = () => {
    if (session._resultTimeout) clearTimeout(session._resultTimeout)
    session._resultTimeout = null
    if (session._resultTimeoutPaused) return
    session._resultTimeout = setTimeout(() => {
      session._handleResultTimeout(messageId, hasStreamStarted)
    }, 300_000)
  }
  session._resetResultTimeout = reset
  reset()
}
