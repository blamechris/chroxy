import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { featureHandlers as extensionHandlers } from '../../src/handlers/feature-handlers.js'
import { createSpy, createMockSession } from '../test-helpers.js'

function makeCtx(sessions = new Map(), overrides = {}) {
  const sent = []

  return {
    send: createSpy((ws, msg) => { sent.push(msg) }),
    sessionManager: {
      getSession: createSpy((id) => sessions.get(id)),
    },
    _sent: sent,
    ...overrides,
  }
}

function makeClient(overrides = {}) {
  return {
    id: 'client-1',
    activeSessionId: null,
    ...overrides,
  }
}

function makeWs() { return {} }

describe('extension-handlers', () => {
  describe('extension_message', () => {
    it('sends session_error when provider is missing', () => {
      const ctx = makeCtx()
      extensionHandlers.extension_message(makeWs(), makeClient(), { subtype: 'event', data: {} }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /requires a non-empty provider/)
    })

    it('sends session_error when subtype is missing', () => {
      const ctx = makeCtx()
      extensionHandlers.extension_message(makeWs(), makeClient(), { provider: 'gemini', data: {} }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /requires a non-empty subtype/)
    })

    it('sends session_error when session not found', () => {
      const ctx = makeCtx()
      extensionHandlers.extension_message(makeWs(), makeClient(), {
        provider: 'gemini',
        subtype: 'thinking',
        data: {},
      }, ctx)
      assert.equal(ctx._sent[0].type, 'session_error')
      assert.match(ctx._sent[0].message, /No active session/)
    })

    it('calls handleExtensionMessage when session supports it', () => {
      const sessions = new Map()
      const session = createMockSession()
      session.handleExtensionMessage = createSpy()
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      extensionHandlers.extension_message(makeWs(), client, {
        provider: 'gemini',
        subtype: 'thinking',
        data: { content: 'pondering' },
      }, ctx)

      assert.equal(session.handleExtensionMessage.callCount, 1)
      const [payload] = session.handleExtensionMessage.lastCall
      assert.equal(payload.provider, 'gemini')
      assert.equal(payload.subtype, 'thinking')
      assert.deepEqual(payload.data, { content: 'pondering' })
    })

    it('is a no-op when session lacks handleExtensionMessage', () => {
      const sessions = new Map()
      const session = createMockSession()
      // session does NOT have handleExtensionMessage
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const client = makeClient({ activeSessionId: 's1' })

      // Should not throw
      extensionHandlers.extension_message(makeWs(), client, {
        provider: 'gemini',
        subtype: 'thinking',
        data: {},
      }, ctx)

      assert.equal(ctx._sent.length, 0)
    })
  })
})
