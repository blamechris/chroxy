import { EventEmitter } from 'node:events'
import { WsClientManager } from '../src/ws-client-manager.js'
import { CTX_NAMESPACES, CTX_NAMESPACE_NAMES, assertCtxShape } from '../src/ws-handler-context.js'

// Re-export GIT from the source module so test files can import it from here
export { GIT } from '../src/git.js'

// Re-export the ctx-shape assert so handler tests can guard their mocks.
export { assertCtxShape } from '../src/ws-handler-context.js'

// Reverse index: flat field name -> namespace it belongs to. Derived from the
// single source of truth (CTX_NAMESPACES) so the test mock builder can't drift.
const FIELD_TO_NS = {}
for (const ns of CTX_NAMESPACE_NAMES) {
  for (const key of CTX_NAMESPACES[ns]) FIELD_TO_NS[key] = ns
}

/**
 * Build a namespaced handler ctx (#5558) from a FLAT bag of fields.
 *
 * Handler tests historically built a flat `{ send, broadcast, sessionManager,
 * … }` ctx. The production ctx is now role-scoped into `ctx.transport` /
 * `ctx.sessions` / `ctx.permissions` / `ctx.services` / `ctx.runtime`. Rather
 * than hand-bucket every field in every test, wrap the existing flat literal:
 *
 *   const ctx = nsCtx({ send, broadcast, sessionManager, fileOps, … })
 *
 * Each known production field is routed into its namespace. Unknown keys —
 * including the optional DI seams handlers read with `ctx?.X ?? defaultX`
 * (`evaluateDraft`, `summarizeSession`, `scanConversations`, `resolveRepoSet`,
 * `surveyRunners`, `realpath`, `_pendingEvaluatorAwaits`, `correlationId`, …)
 * and the legacy `clientManager` handle from makeSessionIndexCtx — are left at
 * the top level, exactly where the handlers and tests expect them.
 *
 * A `transport` / `sessions` / … key in the flat bag whose VALUE is already an
 * object is treated as a pre-built namespace and MERGED (so callers can spread
 * `makeSessionIndexCtx()`'s namespaced output straight in).
 *
 * Every namespace bucket is always created (even if empty) so a handler that
 * reads `ctx.transport.send` never trips over an undefined bucket. Pass
 * `{ assert: true }` (2nd arg) to additionally run `assertCtxShape(ctx, { deep })`.
 *
 * @param {Record<string, any>} [flat={}] - Flat field bag (may also carry pre-built namespace objects).
 * @param {{assert?: boolean, deep?: boolean}} [options]
 * @returns {object} a namespaced ctx.
 */
export function nsCtx(flat = {}, { assert = false, deep = false } = {}) {
  const ctx = {}
  for (const ns of CTX_NAMESPACE_NAMES) ctx[ns] = {}
  for (const [key, value] of Object.entries(flat)) {
    // A key that names a namespace AND is NOT itself a field (i.e. not the
    // `permissions` collision — there is both a `permissions` namespace and a
    // `permissions` field) and whose value is an object is a pre-built
    // namespace bag, e.g. makeSessionIndexCtx()'s `transport`. Merge it.
    if (CTX_NAMESPACE_NAMES.includes(key) && !(key in FIELD_TO_NS) && value && typeof value === 'object') {
      Object.assign(ctx[key], value)
      continue
    }
    const ns = FIELD_TO_NS[key]
    if (ns) ctx[ns][key] = value
    else ctx[key] = value // test-injection seam / unknown — keep flat
  }
  if (assert) assertCtxShape(ctx, { deep })
  return ctx
}

/**
 * #5563/#5558: build the index-maintaining transport ctx fields backed by a
 * real WsClientManager so handler tests exercise the production
 * sessionId→clients reverse-index path. Returns the fields already bucketed
 * under a `transport` namespace plus a top-level `clientManager` handle:
 *
 *   { clientManager, transport: { clients, subscribeClient, unsubscribeClient, setActiveSession } }
 *
 * Spread the returned object into a flat bag passed to `nsCtx` (which merges a
 * pre-built `transport` bag) — `clients` IS the manager's Map, so clients
 * inserted directly into it are visible to the index and to
 * `verifyIndexIntegrity()`. `clientManager` stays top-level because tests call
 * its methods directly (it is not a handler-ctx field).
 *
 * @returns {{clientManager: WsClientManager, transport: {clients: Map, subscribeClient: Function, unsubscribeClient: Function, setActiveSession: Function}}}
 */
export function makeSessionIndexCtx() {
  const clientManager = new WsClientManager()
  return {
    clientManager,
    transport: {
      clients: clientManager.clients,
      subscribeClient: (client, sid) => clientManager.subscribe(client, sid),
      unsubscribeClient: (client, sid) => clientManager.unsubscribe(client, sid),
      setActiveSession: (client, sid) => clientManager.setActiveSession(client, sid),
      // #5563: primary-ownership surface backed by the real manager so handler
      // tests exercise the production claim/observe gate. These do NOT broadcast
      // (the full ws-server announces session_role/primary_changed) — they only
      // mutate the manager's primary map so getPrimary/isPrimary read correctly.
      updatePrimary: (sid, cid) => clientManager.claimPrimary(sid, cid, { force: true }),
      claimPrimary: (sid, cid, opts) => clientManager.claimPrimary(sid, cid, opts),
      getPrimary: (sid) => clientManager.getPrimary(sid),
      isPrimary: (sid, cid) => clientManager.isPrimary(sid, cid),
      clearPrimary: (sid) => clientManager.clearPrimary(sid),
    },
  }
}

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
  // #5555.3 — seq helpers used by replayHistory's cursor logic. Default to the
  // _seq stamped on the (overridable) getHistory entries so cursor-replay tests
  // can drive them by supplying entries with `_seq`; tests that don't care get
  // the no-history defaults (null oldest, 0 latest).
  manager.getOldestHistorySeq = () => {
    const h = manager.getHistory()
    if (!Array.isArray(h) || h.length === 0) return null
    return typeof h[0]._seq === 'number' ? h[0]._seq : null
  }
  manager.getLatestHistorySeq = () => {
    const h = manager.getHistory()
    if (!Array.isArray(h) || h.length === 0) return 0
    return typeof h[h.length - 1]._seq === 'number' ? h[h.length - 1]._seq : 0
  }
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
  // #3185: BaseSession surfaces this default; mocks track the same
  // shape so handler tests can assert toggle behaviour without
  // standing up the full session.
  session.promptEvaluator = false
  // #3639: per-session skip pattern, default null. Mock setter mirrors
  // BaseSession.setPromptEvaluatorSkipPattern semantics: empty/null clears,
  // valid regex source flips state, malformed source rejected.
  session.promptEvaluatorSkipPattern = null
  // #3805: per-session Chroxy context hint, default off. Setter mirrors
  // BaseSession.setChroxyContextHint: strict-boolean validation, returns
  // true only when state actually changes.
  session.chroxyContextHint = false
  // #4660: per-session preamble, default empty string. Setter mirrors
  // BaseSession.setSessionPreamble: string validation, trim+cap, returns
  // true only when the trimmed value differs from the stored value.
  session.sessionPreamble = ''
  session.sendMessage = createSpy()
  session.interrupt = createSpy()
  // #5711 (Gap 2): the real setModel returns true only when the model actually
  // changed (false when mid-turn or a same-model no-op), and the handler now
  // broadcasts model_changed only on a true return. Mirror that contract:
  // mutate `session.model` and report changed; `isBusy` defaults false so the
  // common "applied" path is the default. Tests that want the busy/no-op path
  // override `session.setModel` / `session.isBusy` after creation.
  session.isBusy = false
  session.setModel = createSpy((model) => {
    if (model === session.model) return false
    session.model = model
    return true
  })
  // #3729: handler now reads session.permissionMode AFTER setPermissionMode
  // returns to detect silently-rejected mid-turn changes. Mock the real
  // contract: state mutates on a successful set so handler tests don't
  // see false PERMISSION_MODE_NOT_APPLIED rejections. Tests that override
  // `session.setPermissionMode` after creation are responsible for
  // updating `session.permissionMode` themselves if they want the change
  // to propagate to the handler's broadcast path.
  session.setPermissionMode = createSpy((mode) => {
    session.permissionMode = mode
  })
  session.setPromptEvaluator = createSpy((value) => {
    if (typeof value !== 'boolean' || value === session.promptEvaluator) return false
    session.promptEvaluator = value
    return true
  })
  session.setChroxyContextHint = createSpy((value) => {
    if (typeof value !== 'boolean' || value === session.chroxyContextHint) return false
    session.chroxyContextHint = value
    return true
  })
  session.setSessionPreamble = createSpy((value) => {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    const next = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed
    if (next === session.sessionPreamble) return false
    session.sessionPreamble = next
    return true
  })
  session.setPromptEvaluatorSkipPattern = createSpy((value) => {
    let next
    if (value === null || value === '') {
      next = null
    } else if (typeof value === 'string') {
      try { new RegExp(value, 'i') } catch { return false }
      next = value
    } else {
      return false
    }
    if (next === session.promptEvaluatorSkipPattern) return false
    session.promptEvaluatorSkipPattern = next
    return true
  })
  session.respondToQuestion = createSpy()
  session.respondToPermission = createSpy()
  Object.assign(session, overrides)
  return session
}

/**
 * Snapshot the listed `process.env` keys, apply `overrides` (use undefined
 * to delete), invoke `fn()`, then restore. Supports both sync and async
 * callbacks — if `fn()` returns a Promise, env restoration happens after it
 * resolves so async tests don't race on cleanup.
 *
 * Usage (sync):
 *   withEnv({ FOO: 'bar' }, () => {
 *     assert.equal(process.env.FOO, 'bar')
 *   })
 *
 * Usage (async):
 *   await withEnv({ FOO: 'bar' }, async () => {
 *     await someAsyncWork()
 *   })
 *
 * @param {Record<string, string | undefined>} overrides - key/value env mutations; undefined deletes.
 * @param {() => any | Promise<any>} fn - callback to run with the mutated env.
 * @returns {any | Promise<any>} whatever `fn()` returns, Promise if `fn` is async.
 */
export function withEnv(overrides, fn) {
  const saved = {}
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key]
    if (overrides[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = overrides[key]
    }
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
  }
  let result
  try {
    result = fn()
  } catch (err) {
    restore()
    throw err
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { restore(); return value },
      (err) => { restore(); throw err },
    )
  }
  restore()
  return result
}

/**
 * Test helper: arm the SdkSession result-inactivity timeout without going
 * through sendMessage(). Lets unit tests exercise the pause/resume path
 * in isolation. Lives in test-helpers so production module exports
 * only production API (#2870).
 *
 * Reads `session._resultTimeoutMs` so the helper mirrors prod behavior
 * (the production reset closure in `sdk-session.js` does the same).
 * Previously hardcoded to 300_000, which silently broke the regression
 * window for #3757 — any test that constructed a session with a
 * non-default window would still get a 5-min timer here.
 *
 * #3899: SOFT + HARD timers are armed in parallel, mirroring the
 * production `resetResultTimeout` closure in `sdk-session.js`. The soft
 * timer fires `_handleInactivityWarning` (no state change); the hard
 * timer fires `_handleHardTimeout` (the pre-#3899 kill path). Tests
 * that constructed a session with both windows equal (the common case
 * in pre-existing pause/resume tests) will see the error fire at the
 * same tick as the soft warning — soft fires first, hard fires second,
 * the existing assertions about `errors.length === 1` continue to hold.
 *
 * @param {import('../src/sdk-session.js').SdkSession} session
 * @param {string} messageId
 * @param {boolean} [hasStreamStarted=false]
 */
export function armResultTimeoutForTest(session, messageId, hasStreamStarted = false) {
  const reset = () => {
    if (session._resultTimeout) clearTimeout(session._resultTimeout)
    if (session._hardTimeout) clearTimeout(session._hardTimeout)
    if (session._streamStallTimeout) clearTimeout(session._streamStallTimeout)
    session._resultTimeout = null
    session._hardTimeout = null
    session._streamStallTimeout = null
    if (session._resultTimeoutPaused) return
    session._resultTimeout = setTimeout(() => {
      session._resultTimeout = null
      session._handleInactivityWarning(messageId)
    }, session._resultTimeoutMs)
    session._hardTimeout = setTimeout(() => {
      session._hardTimeout = null
      session._handleHardTimeout(messageId, hasStreamStarted)
    }, session._hardTimeoutMs)
    // #4467: stream-stall recovery — only arm when the operator has not
    // disabled the active-recovery path (value > 0). Mirrors the
    // production reset closure in `sdk-session.js`.
    if (session._streamStallTimeoutMs > 0 && typeof session._handleStreamStall === 'function') {
      session._streamStallTimeout = setTimeout(() => {
        session._streamStallTimeout = null
        session._handleStreamStall(messageId, hasStreamStarted)
      }, session._streamStallTimeoutMs)
    }
  }
  session._resetResultTimeout = reset
  reset()
}
