import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

describe('WsServer EADDRINUSE handling (#1939)', { timeout: 10000 }, () => {
  let blockingServer
  let wsServer

  after(async () => {
    if (wsServer) {
      try { wsServer.close() } catch {}
    }
    if (blockingServer) {
      await new Promise(resolve => blockingServer.close(resolve))
    }
  })

  it('calls process.exit(1) when port is already in use', async () => {
    // 1. Start a blocking server on a random port
    blockingServer = createServer()
    await new Promise((resolve, reject) => {
      blockingServer.listen(0, '127.0.0.1', () => resolve())
      blockingServer.on('error', reject)
    })
    const port = blockingServer.address().port

    // 2. Mock process.exit to capture the call
    const exitMock = mock.fn()
    const originalExit = process.exit
    process.exit = exitMock

    try {
      const { WsServer } = await import('../src/ws-server.js')

      const mockSessionManager = new EventEmitter()
      mockSessionManager.sessions = new Map()
      mockSessionManager.getSessions = () => []
      mockSessionManager.getSession = () => null

      wsServer = new WsServer({
        port,
        apiToken: 'test-token',
        sessionManager: mockSessionManager,
        authRequired: false,
      })

      wsServer.start('127.0.0.1')

      // Wait for the EADDRINUSE error event
      await new Promise((resolve) => {
        wsServer.httpServer.on('error', () => setTimeout(resolve, 50))
        setTimeout(resolve, 2000) // fallback
      })

      assert.ok(exitMock.mock.callCount() > 0, 'process.exit should have been called')
      assert.equal(exitMock.mock.calls[0].arguments[0], 1, 'should exit with code 1')
    } finally {
      process.exit = originalExit
    }
  })
})
