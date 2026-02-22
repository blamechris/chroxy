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
