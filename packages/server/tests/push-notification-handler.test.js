// #5368 slice (a): unit tests for PushNotificationHandler — the session_event
// → push path extracted from startCliServer. These re-assert the four races
// that were impossible to test while the logic was inline in the god function
// (#3866 dedupe, #3870 synchronous latch, #3871 wsServer-undefined guard,
// #3872 tool_start dedupe reset), plus the per-event push fan-out.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PushNotificationHandler } from '../src/server-cli/push-notification-handler.js'

function makeFakes({ hasTokens = true, hasConfiguredSinks, sendResult = true, wsServer = undefined } = {}) {
  const sends = []
  // #5413 Phase 2: the handler gates on the sink-agnostic
  // hasConfiguredSinks(); `hasConfiguredSinks` defaults to mirroring
  // `hasTokens` so the pre-existing Expo-only cases keep their meaning.
  const sinksConfigured = hasConfiguredSinks ?? hasTokens
  const pushManager = {
    hasTokens,
    hasConfiguredSinks: () => sinksConfigured,
    send(category, title, body, data) {
      sends.push({ category, title, body, data })
      return Promise.resolve(sendResult)
    },
  }
  const sessionManager = new EventEmitter()
  sessionManager.getSession = (id) => ({ name: `name-${id}` })
  const logs = { debug: [], warn: [], error: [], info: [] }
  const logger = {
    debug: (m) => logs.debug.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
    info: (m) => logs.info.push(m),
  }
  let currentWs = wsServer
  const handler = new PushNotificationHandler({
    sessionManager,
    pushManager,
    getWsServer: () => currentWs,
    logger,
  })
  handler.start()
  return { handler, sessionManager, pushManager, sends, logs, setWsServer: (w) => { currentWs = w } }
}

function fakeWsServer({ authenticatedClientCount = 0, activeViewers = false } = {}) {
  return {
    authenticatedClientCount,
    hasActiveViewersForSession: () => activeViewers,
  }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('PushNotificationHandler — idle push (#3866 dedupe)', () => {
  it('fires one idle push on result when no clients are connected', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends } = makeFakes({ wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: { duration: 1200 } })
    assert.equal(sends.length, 1)
    assert.equal(sends[0].category, 'activity_update')
    assert.equal(sends[0].data.state, 'idle')
    assert.equal(sends[0].data.elapsed, 1200)
  })

  it('a duplicate result does NOT fire a second idle push (per-session dedupe)', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends } = makeFakes({ wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 1, 'second result suppressed by the dedupe Set')
  })
})

describe('PushNotificationHandler — #3870 synchronous latch', () => {
  it('two results in the SAME tick fire only one push (latched before send resolves)', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends } = makeFakes({ wsServer: ws })
    // Both emitted synchronously — the latch must be set before send()'s promise
    // settles, so the second can't pass the !alreadyNotified gate.
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 1)
  })

  it('releases the latch on hard send failure so the next cycle gets a fresh push', async () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends, logs } = makeFakes({ wsServer: ws, sendResult: false })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    await tick() // let the send() promise resolve(false) and release the latch
    assert.ok(logs.warn.some((m) => m.includes('Idle push send failed')))
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 2, 'latch released → a fresh idle push fires next cycle')
  })
})

describe('PushNotificationHandler — #3872 dedupe reset on tool_start (Codex)', () => {
  it('tool_start (no stream_start) clears the dedupe so the next result fires', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends } = makeFakes({ wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 1)
    // A Codex tool-only turn emits tool_start with no preceding stream_start.
    sessionManager.emit('session_event', { sessionId: 's1', event: 'tool_start', data: {} })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 2, 'tool_start reset the latch (would stay stuck without #3872)')
  })

  it('stream_start also clears the dedupe', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends } = makeFakes({ wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'stream_start', data: {} })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 2)
  })
})

describe('PushNotificationHandler — #3871 wsServer-undefined guard', () => {
  it('a result before wsServer exists is suppressed (no crash), logged at debug', () => {
    const { sessionManager, sends, logs } = makeFakes({ wsServer: undefined })
    assert.doesNotThrow(() => {
      sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    })
    assert.equal(sends.length, 0)
    assert.ok(logs.debug.some((m) => m.includes('wsServer not yet initialized')))
  })

  it('routes correctly once wsServer is later assigned', () => {
    const fakes = makeFakes({ wsServer: undefined })
    fakes.setWsServer(fakeWsServer({ authenticatedClientCount: 0 }))
    fakes.sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(fakes.sends.length, 1)
  })
})

describe('PushNotificationHandler — active-viewer + token gating', () => {
  it('suppresses the idle push when a viewer is actively watching the session', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 1, activeViewers: true })
    const { sessionManager, sends, logs } = makeFakes({ wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 0)
    assert.ok(logs.debug.some((m) => m.includes('active viewers present')))
  })

  it('sends nothing (and debug-logs) when no sink is configured', () => {
    const { sessionManager, sends, logs } = makeFakes({ hasTokens: false, wsServer: fakeWsServer() })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 0)
    assert.ok(logs.debug.some((m) => m.includes('no configured notification sinks')))
  })
})

describe('PushNotificationHandler — sink-agnostic gate (#5413 Phase 2)', () => {
  it('a Discord-only setup (no Expo tokens, sink configured) still gets the idle push', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 0 })
    const { sessionManager, sends } = makeFakes({ hasTokens: false, hasConfiguredSinks: true, wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 1, 'hasTokens=false must not suppress when another sink is configured')
    assert.equal(sends[0].category, 'activity_update')
  })

  it('a Discord-only setup gets error and waiting pushes too', () => {
    const { sessionManager, sends } = makeFakes({ hasTokens: false, hasConfiguredSinks: true, wsServer: fakeWsServer() })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'error', data: { message: 'boom' } })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'permission_request', data: { tool: 'Bash' } })
    assert.deepEqual(sends.map((s) => s.category), ['activity_error', 'activity_waiting'])
  })

  it('falls back to hasTokens for a legacy pushManager double without hasConfiguredSinks', () => {
    const sends = []
    const pushManager = {
      hasTokens: true,
      send(category, title, body, data) {
        sends.push({ category, title, body, data })
        return Promise.resolve(true)
      },
    }
    const sessionManager = new EventEmitter()
    sessionManager.getSession = () => ({ name: 'n' })
    const handler = new PushNotificationHandler({
      sessionManager,
      pushManager,
      getWsServer: () => fakeWsServer({ authenticatedClientCount: 0 }),
      logger: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    })
    handler.start()
    sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(sends.length, 1)
  })
})

describe('PushNotificationHandler — per-event push fan-out', () => {
  it('error event sends an activity_error push', () => {
    const { sessionManager, sends } = makeFakes({ wsServer: fakeWsServer() })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'error', data: { message: 'boom' } })
    assert.equal(sends.length, 1)
    assert.equal(sends[0].category, 'activity_error')
    assert.equal(sends[0].data.detail, 'boom')
  })

  it('permission_request sends an activity_waiting push with the tool', () => {
    const { sessionManager, sends } = makeFakes({ wsServer: fakeWsServer() })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'permission_request', data: { tool: 'Bash' } })
    assert.equal(sends.length, 1)
    assert.equal(sends[0].category, 'activity_waiting')
    assert.equal(sends[0].data.detail, 'Bash')
  })

  it('user_question sends an activity_waiting push', () => {
    const { sessionManager, sends } = makeFakes({ wsServer: fakeWsServer() })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'user_question', data: {} })
    assert.equal(sends.length, 1)
    assert.equal(sends[0].category, 'activity_waiting')
    assert.equal(sends[0].data.state, 'waiting')
  })

  it('inactivity_warning pushes regardless of active viewers (#3899)', () => {
    const ws = fakeWsServer({ authenticatedClientCount: 1, activeViewers: true })
    const { sessionManager, sends } = makeFakes({ wsServer: ws })
    sessionManager.emit('session_event', { sessionId: 's1', event: 'inactivity_warning', data: { prefab: 'p', idleMs: 999 } })
    assert.equal(sends.length, 1)
    assert.equal(sends[0].category, 'inactivity_warning')
    assert.equal(sends[0].data.idleMs, 999)
  })
})

describe('PushNotificationHandler — session_destroyed clears dedupe', () => {
  let fakes
  beforeEach(() => { fakes = makeFakes({ wsServer: fakeWsServer({ authenticatedClientCount: 0 }) }) })

  it('a destroyed-then-reused session id gets a fresh idle push', () => {
    fakes.sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(fakes.sends.length, 1)
    fakes.sessionManager.emit('session_destroyed', { sessionId: 's1' })
    fakes.sessionManager.emit('session_event', { sessionId: 's1', event: 'result', data: {} })
    assert.equal(fakes.sends.length, 2, 'dedupe cleared on destroy')
  })
})
