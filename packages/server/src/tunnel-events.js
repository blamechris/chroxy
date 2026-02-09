/**
 * Wire up tunnel lifecycle events to WebSocket server broadcasts.
 * Extracted from duplicated code in server.js and server-cli.js.
 */
export function wireTunnelEvents(tunnel, wsServer) {
  tunnel.on('tunnel_lost', ({ code, signal }) => {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`
    console.log(`\n[!] Tunnel lost (${exitReason})`)
    wsServer.broadcastError('tunnel', `Tunnel connection lost (${exitReason}). Recovering...`, true)
  })

  tunnel.on('tunnel_recovering', ({ attempt, delayMs }) => {
    console.log(`[!] Attempting tunnel recovery (attempt ${attempt}, waiting ${delayMs}ms)...`)
    wsServer.broadcastStatus('Tunnel recovering...')
  })

  tunnel.on('tunnel_failed', ({ message, lastExitCode, lastSignal }) => {
    console.error(`\n[!] ${message}`)
    console.error(`[!] Last exit: code=${lastExitCode} signal=${lastSignal}`)
    console.error(`[!] Server will continue on localhost only. Remote connections will not work.`)
    wsServer.broadcastError('tunnel', 'Tunnel recovery failed. Remote connections will not work.', false)
  })
}
