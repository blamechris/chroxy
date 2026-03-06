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
    const result = predicate()
    if (result) return result
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timeout after ${timeoutMs}ms: ${label}`)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
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
  session.model = 'claude-sonnet-4-20250514'
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
