import { CliSession } from './cli-session.js'
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

  // 1. Create and start the CLI session (persistent process)
  const cliSession = new CliSession({
    cwd: config.cwd || process.cwd(),
    allowedTools: config.allowedTools || [],
    model: config.model || null,
    port: PORT,
    apiToken: API_TOKEN,
  })
  cliSession.start()

  // Log events for debugging
  cliSession.on('ready', ({ sessionId, model }) => {
    console.log(`[cli] Session ready: ${sessionId} (model: ${model})`)
  })

  cliSession.on('error', ({ message }) => {
    console.error(`[cli] Error: ${message}`)
  })

  cliSession.on('result', ({ cost, duration }) => {
    if (cost != null) {
      console.log(`[cli] Query complete: $${cost.toFixed(4)} in ${duration}ms`)
    }
  })

  // 2. Start the WebSocket server
  const wsServer = new WsServer({
    port: PORT,
    apiToken: API_TOKEN,
    cliSession,
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
    cliSession.destroy()
    wsServer.close()
    if (tunnel) await tunnel.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
