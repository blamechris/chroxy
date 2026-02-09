import { SessionManager } from './session-manager.js'
import { WsServer } from './ws-server.js'
import { TunnelManager } from './tunnel.js'
import { waitForTunnel } from './tunnel-check.js'
import qrcode from 'qrcode-terminal'

/**
 * Start the Chroxy server in CLI headless mode.
 * Auto-discovers tmux sessions running Claude on startup.
 * Falls back to a default CLI session if none found.
 */
export async function startCliServer(config) {
  const PORT = config.port || parseInt(process.env.PORT || '8765', 10)
  const NO_AUTH = !!config.noAuth
  const API_TOKEN = NO_AUTH ? null : (config.apiToken || process.env.API_TOKEN)

  if (!NO_AUTH && !API_TOKEN) {
    console.error('[!] No API token configured. Run \'npx chroxy init\' first.')
    process.exit(1)
  }

  console.log('')
  console.log('╔════════════════════════════════════════╗')
  console.log('║     Chroxy Server v0.1.0 (CLI mode)    ║')
  console.log('╚════════════════════════════════════════╝')
  console.log('')

  if (NO_AUTH) {
    console.log('⚠  WARNING: Running without authentication (--no-auth)')
    console.log('⚠  Server bound to localhost only. Do NOT expose to network.')
    console.log('')
  }

  // 1. Create session manager
  const sessionManager = new SessionManager({
    maxSessions: 5,
    port: PORT,
    apiToken: API_TOKEN,
    defaultCwd: config.cwd || process.cwd(),
    defaultModel: config.model || null,
    defaultPermissionMode: 'approve',
  })

  // 2. Auto-discover tmux sessions running Claude
  let defaultSessionId
  const discovered = sessionManager.discoverSessions()
  if (discovered.length > 0) {
    console.log(`[cli] Found ${discovered.length} tmux session(s) running Claude`)
    for (const tmux of discovered) {
      try {
        const sid = await sessionManager.attachSession({ tmuxSession: tmux.sessionName, name: tmux.sessionName })
        if (!defaultSessionId) defaultSessionId = sid
        console.log(`[cli] Attached to tmux session: ${tmux.sessionName}`)
      } catch (err) {
        console.error(`[cli] Failed to attach tmux session '${tmux.sessionName}': ${err?.message ?? String(err)}`)
      }
    }
  }

  // Fall back to a default CLI session if no sessions attached (none found or all failed)
  if (!defaultSessionId) {
    if (discovered.length > 0) {
      console.log('[cli] All tmux attachments failed, creating default CLI session')
    } else {
      console.log('[cli] No tmux sessions found, creating default CLI session')
    }
    defaultSessionId = sessionManager.createSession({ name: 'Default' })
  }

  let wsServer

  // Log events for debugging and forward critical errors
  sessionManager.on('session_event', ({ sessionId, event, data }) => {
    if (event === 'ready') {
      console.log(`[cli] Session ${sessionId} ready: ${data.sessionId} (model: ${data.model})`)
    } else if (event === 'error') {
      console.error(`[cli] Session ${sessionId} error: ${data.message}`)
      // Forward session errors as server_error (in addition to the in-chat error message)
      const isFatal = /failed to stay alive|max respawn/i.test(data.message)
      if (wsServer) wsServer.broadcastError('session', data.message, !isFatal)
    } else if (event === 'result' && data.cost != null) {
      console.log(`[cli] Session ${sessionId} query: $${data.cost.toFixed(4)} in ${data.duration}ms`)
    }
  })

  sessionManager.on('session_created', ({ sessionId, name, cwd }) => {
    console.log(`[cli] Session created: ${sessionId} (${name}) in ${cwd}`)
  })

  sessionManager.on('session_destroyed', ({ sessionId }) => {
    console.log(`[cli] Session destroyed: ${sessionId}`)
  })

  // 3. Start the WebSocket server
  wsServer = new WsServer({
    port: PORT,
    apiToken: API_TOKEN,
    sessionManager,
    defaultSessionId,
    authRequired: !NO_AUTH,
  })
  // Bind to localhost-only when auth is disabled
  wsServer.start(NO_AUTH ? '127.0.0.1' : undefined)

  let tunnel = null
  let currentWsUrl = null
  if (!NO_AUTH) {
    // 4. Start the Cloudflare tunnel
    tunnel = new TunnelManager({ port: PORT })
    const { wsUrl, httpUrl } = await tunnel.start()
    currentWsUrl = wsUrl

    // 5. Wait for tunnel to be fully routable (DNS propagation)
    await waitForTunnel(httpUrl)

    // 6. Generate connection info
    const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${API_TOKEN}`

    console.log('\n[✓] Server ready! (CLI headless mode)\n')
    console.log('📱 Scan this QR code with the Chroxy app:\n')
    qrcode.generate(connectionUrl, { small: true })
    console.log(`\nOr connect manually:`)
    console.log(`   URL:   ${wsUrl}`)
    console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)

    // 7. Wire up tunnel lifecycle events
    tunnel.on('tunnel_lost', ({ code, signal }) => {
      const exitReason = signal ? `signal ${signal}` : `code ${code}`
      console.log(`\n[!] Tunnel lost (${exitReason})`)
      wsServer.broadcastError('tunnel', `Tunnel connection lost (${exitReason}). Recovering...`, true)
    })

    tunnel.on('tunnel_recovering', ({ attempt, delayMs }) => {
      console.log(`[!] Attempting tunnel recovery (attempt ${attempt}, waiting ${delayMs}ms)...`)
    })

    tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
      console.log(`[✓] Tunnel recovered after ${attempt} attempt(s)`)

      // Re-verify the new tunnel URL
      await waitForTunnel(newHttpUrl)

      // Only display new QR code if URL actually changed
      if (newWsUrl !== currentWsUrl) {
        currentWsUrl = newWsUrl
        const newConnectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${API_TOKEN}`
        console.log('\n[✓] New tunnel URL established:\n')
        console.log('📱 Scan this QR code with the Chroxy app:\n')
        qrcode.generate(newConnectionUrl, { small: true })
        console.log(`\nOr connect manually:`)
        console.log(`   URL:   ${newWsUrl}`)
        console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
        console.log('')
      } else {
        console.log(`[✓] Tunnel URL unchanged: ${newWsUrl}`)
      }
    })

    tunnel.on('tunnel_failed', ({ message, lastExitCode, lastSignal }) => {
      console.error(`\n[!] ${message}`)
      console.error(`[!] Last exit: code=${lastExitCode} signal=${lastSignal}`)
      console.error(`[!] Server will continue on localhost only. Remote connections will not work.`)
      wsServer.broadcastError('tunnel', 'Tunnel recovery failed. Remote connections will not work.', false)
    })
  } else {
    console.log(`[✓] Server ready! (CLI headless mode, no auth)\n`)
    console.log(`   Connect: ws://localhost:${PORT}`)
  }

  console.log('\nPress Ctrl+C to stop.\n')

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[${signal}] Shutting down...`)
    sessionManager.destroyAll()
    wsServer.close()
    if (tunnel) await tunnel.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
