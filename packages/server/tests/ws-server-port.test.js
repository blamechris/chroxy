import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const wsServerSrc = readFileSync(join(__dirname, '../src/ws-server.js'), 'utf-8')

describe('WsServer EADDRINUSE handling (#1939)', () => {
  it('registers an error listener on httpServer before listen()', () => {
    // The httpServer.on('error', ...) must appear before httpServer.listen()
    const errorListenerIndex = wsServerSrc.indexOf("this.httpServer.on('error'")
    const listenIndex = wsServerSrc.indexOf('this.httpServer.listen(')

    assert.ok(errorListenerIndex > -1, "Should have httpServer.on('error', ...) handler")
    assert.ok(listenIndex > -1, 'Should have httpServer.listen() call')
    assert.ok(errorListenerIndex < listenIndex,
      "Error listener should be registered BEFORE listen() call")
  })

  it('EADDRINUSE handler includes port number and process.exit', () => {
    // Find the error handler block
    const errorHandlerMatch = wsServerSrc.match(/this\.httpServer\.on\('error'[\s\S]*?(?=\n\s{4}\w|\n\s{4}\/\/|\n\s{4}this\.(httpServer|wss))/m)
    assert.ok(errorHandlerMatch, 'Should have an error handler block')
    const handler = errorHandlerMatch[0]

    assert.ok(handler.includes('EADDRINUSE'), 'Error handler should check for EADDRINUSE')
    assert.ok(handler.includes('process.exit'), 'EADDRINUSE handler should call process.exit')
    assert.ok(handler.includes('this.port') || handler.includes('port'), 'Error message should reference the port')
  })
})
