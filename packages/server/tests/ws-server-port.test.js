import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createMockSessionManager } from './test-helpers.js'

describe('WsServer EADDRINUSE handling (#1939)', { timeout: 10000 }, () => {
  let blockingServer
  let wsServer

  after(async () => {
    mock.restoreAll()
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

    // 2. Mock process.exit via mock.method (auto-restored in after())
    const exitMock = mock.method(process, 'exit', () => {})

    // 3. Use shared mock session manager from test-helpers
    const { WsServer } = await import('../src/ws-server.js')
    const { manager: mockSessionManager } = createMockSessionManager()

    wsServer = new WsServer({
      port,
      apiToken: 'test-token',
      sessionManager: mockSessionManager,
      authRequired: false,
    })

    wsServer.start('127.0.0.1')

    // 4. Wait for process.exit to be called (poll the mock directly)
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (exitMock.mock.callCount() > 0) {
          clearInterval(check)
          resolve()
        }
      }, 10)
      // Safety timeout — fail fast instead of hanging
      setTimeout(() => { clearInterval(check); resolve() }, 3000)
    })

    assert.ok(exitMock.mock.callCount() > 0, 'process.exit should have been called')
    assert.equal(exitMock.mock.calls[0].arguments[0], 1, 'should exit with code 1')
  })
})
