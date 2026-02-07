import { SessionManager } from './session-manager.js'
import { WsServer } from './ws-server.js'
import { TunnelManager } from './tunnel.js'
import { waitForTunnel } from './tunnel-check.js'
import qrcode from 'qrcode-terminal'

/**
 * Start the Chroxy server in CLI headless mode.
 * Uses `claude -p --output-format stream-json` instead of PTY/tmux.
 * No tmux or node-pty dependency required.
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

  // 1. Create session manager and default session
  const sessionManager = new SessionManager({
    maxSessions: 5,
    port: PORT,
    apiToken: API_TOKEN,
    defaultCwd: config.cwd || process.cwd(),
    defaultModel: config.model || null,
    defaultPermissionMode: 'approve',
  })

  const defaultSessionId = sessionManager.createSession({ name: 'Default' })

  // Log events for debugging
  sessionManager.on('session_event', ({ sessionId, event, data }) => {
    if (event === 'ready') {
      console.log(`[cli] Session ${sessionId} ready: ${data.sessionId} (model: ${data.model})`)
    } else if (event === 'error') {
      console.error(`[cli] Session ${sessionId} error: ${data.message}`)
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

  // 2. Start the WebSocket server
  const wsServer = new WsServer({
    port: PORT,
    apiToken: API_TOKEN,
    sessionManager,
    defaultSessionId,
    authRequired: !NO_AUTH,
  })
  // Bind to localhost-only when auth is disabled
  wsServer.start(NO_AUTH ? '127.0.0.1' : undefined)

  let tunnel = null
  if (!NO_AUTH) {
    // 3. Start the Cloudflare tunnel
    tunnel = new TunnelManager({ port: PORT })
    const { wsUrl, httpUrl } = await tunnel.start()

    // 4. Wait for tunnel to be fully routable (DNS propagation)
    await waitForTunnel(httpUrl)

    // 5. Generate connection info
    const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${API_TOKEN}`

    console.log('\n[✓] Server ready! (CLI headless mode)\n')
    console.log('📱 Scan this QR code with the Chroxy app:\n')
    qrcode.generate(connectionUrl, { small: true })
    console.log(`\nOr connect manually:`)
    console.log(`   URL:   ${wsUrl}`)
    console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
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
