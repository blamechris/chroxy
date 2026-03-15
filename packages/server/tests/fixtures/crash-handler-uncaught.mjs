/**
 * Fixture: Simulates the server-cli.js uncaughtException handler behavior.
 *
 * Registers handlers that mirror the real crash handler — calls broadcastShutdown,
 * destroyAll, tunnel.stop, removeConnectionInfo, and deferred process.exit.
 * Outputs a JSON summary to stdout so the parent test can assert on call order.
 */

const calls = []

const mockWsServer = {
  broadcastShutdown(reason) {
    calls.push(`broadcastShutdown:${reason}`)
  },
  close() {
    calls.push('wsServer.close')
  },
}

const mockSessionManager = {
  destroyAll() {
    calls.push('destroyAll')
  },
}

const mockTunnel = {
  stop() {
    calls.push('tunnel.stop')
  },
}

function removeConnectionInfo() {
  calls.push('removeConnectionInfo')
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[fatal] Uncaught exception: ${err.message}\n`)
  try { mockWsServer.broadcastShutdown('crash', 0) } catch {}
  try { mockWsServer.close() } catch {}
  try { mockSessionManager.destroyAll() } catch {}
  try { mockTunnel.stop() } catch {}
  try { removeConnectionInfo() } catch {}
  setTimeout(() => {
    process.stdout.write(JSON.stringify(calls) + '\n')
    process.exit(1)
  }, 50)
})

// Trigger the handler
throw new Error('test uncaught exception')
