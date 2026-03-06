import { EventEmitter } from 'node:events'

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
    get: () => sessionsMap.size > 0 ? sessionsMap.keys().next().value : null
  })

  Object.assign(manager, overrides)

  return { manager, sessionsMap }
}

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
