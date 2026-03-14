import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createMockSessionManager } from './test-helpers.js'

describe('WsServer error handlers (#2195)', { timeout: 10000 }, () => {
  let wsServer

  after(async () => {
    mock.restoreAll()
    if (wsServer) {
      try { wsServer.close() } catch {}
    }
  })

  it('attaches an error handler to the WebSocketServer instance', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const { manager: mockSessionManager } = createMockSessionManager()

    wsServer = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockSessionManager,
      authRequired: false,
    })

    wsServer.start('127.0.0.1')

    // The wss should have at least one 'error' listener (our handler)
    const errorListeners = wsServer.wss.listeners('error')
    assert.ok(errorListeners.length > 0, 'WebSocketServer should have an error handler')
  })

  it('logs WebSocketServer errors without crashing', async () => {
    const { WsServer } = await import('../src/ws-server.js')
    const { manager: mockSessionManager } = createMockSessionManager()

    wsServer = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: mockSessionManager,
      authRequired: false,
    })

    wsServer.start('127.0.0.1')

    // Emitting an error on wss should not throw (handler catches it)
    assert.doesNotThrow(() => {
      wsServer.wss.emit('error', new Error('test wss error'))
    })
  })
})
