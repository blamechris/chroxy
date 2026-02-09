import { fork } from 'child_process'
import { createServer } from 'http'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { TunnelManager } from './tunnel.js'
import { waitForTunnel } from './tunnel-check.js'
import qrcode from 'qrcode-terminal'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Supervisor process: owns the tunnel, restarts the server child on crash.
 *
 * Architecture:
 *   [supervisor]           (long-lived)
 *     ├── cloudflared      (managed by TunnelManager)
 *     └── server-cli.js    (child — restarted on crash, tunnel=none)
 *
 * The child server runs with CHROXY_SUPERVISED=1 and tunnel=none since the
 * supervisor owns the tunnel. During child restart, the supervisor binds the
 * port to serve a health check that returns {"status":"restarting"}.
 */
export async function startSupervisor(config) {
  const PORT = config.port || parseInt(process.env.PORT || '8765', 10)
  const API_TOKEN = config.apiToken || process.env.API_TOKEN
  const TUNNEL_MODE = config.tunnel || 'quick'

  if (!API_TOKEN) {
    console.error('[!] No API token configured. Run \'npx chroxy init\' first.')
    process.exit(1)
  }

  console.log('')
  console.log('╔════════════════════════════════════════╗')
  console.log('║   Chroxy Supervisor v0.1.0              ║')
  console.log('╚════════════════════════════════════════╝')
  console.log('')

  // 1. Start the tunnel (supervisor owns it)
  const tunnel = new TunnelManager({
    port: PORT,
    mode: TUNNEL_MODE,
    tunnelName: config.tunnelName || null,
    tunnelHostname: config.tunnelHostname || null,
  })

  const { wsUrl, httpUrl } = await tunnel.start()
  let currentWsUrl = wsUrl

  tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
    console.log(`[supervisor] Tunnel recovered after ${attempt} attempt(s)`)
    await waitForTunnel(newHttpUrl)

    if (newWsUrl !== currentWsUrl) {
      currentWsUrl = newWsUrl
      const connectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${API_TOKEN}`
      console.log('\n[supervisor] New tunnel URL:\n')
      qrcode.generate(connectionUrl, { small: true })
      console.log(`\n   URL:   ${newWsUrl}`)
      console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
      console.log('')
    }
  })

  tunnel.on('tunnel_failed', ({ message }) => {
    console.error(`[supervisor] ${message}`)
  })

  // 2. Wait for tunnel to be routable
  await waitForTunnel(httpUrl)

  // 3. Display connection info
  const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${API_TOKEN}`
  const modeLabel = TUNNEL_MODE === 'named' ? 'Named Tunnel' : 'Quick Tunnel'

  console.log(`\n[supervisor] ${modeLabel} ready\n`)
  console.log('📱 Scan this QR code with the Chroxy app:\n')
  qrcode.generate(connectionUrl, { small: true })
  console.log(`\nOr connect manually:`)
  console.log(`   URL:   ${wsUrl}`)
  console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
  console.log('')

  // 4. Child process management
  let child = null
  let restartCount = 0
  let standbyServer = null
  let shuttingDown = false
  const MAX_RESTARTS = 10
  const RESTART_BACKOFFS = [2000, 2000, 3000, 3000, 5000, 5000, 8000, 8000, 10000, 10000]

  function startChild() {
    if (shuttingDown) return

    const childScript = resolve(__dirname, 'server-cli-child.js')
    const childEnv = {
      ...process.env,
      CHROXY_SUPERVISED: '1',
      CHROXY_TUNNEL: 'none',
    }

    // Pass config to child via env vars
    if (config.apiToken) childEnv.API_TOKEN = config.apiToken
    if (config.port) childEnv.PORT = String(config.port)
    if (config.cwd) childEnv.CHROXY_CWD = config.cwd
    if (config.model) childEnv.CHROXY_MODEL = config.model
    if (config.discoveryInterval) childEnv.CHROXY_DISCOVERY_INTERVAL = String(config.discoveryInterval)

    console.log(`[supervisor] Starting server child (attempt ${restartCount + 1})`)

    child = fork(childScript, [], {
      env: childEnv,
      stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
    })

    child.on('message', (msg) => {
      if (msg.type === 'ready') {
        console.log('[supervisor] Server child is ready')
        restartCount = 0
        stopStandbyServer()
      }
    })

    child.on('exit', (code, signal) => {
      child = null
      if (shuttingDown) return

      console.log(`[supervisor] Server child exited (code ${code}, signal ${signal})`)
      restartCount++

      if (restartCount > MAX_RESTARTS) {
        console.error(`[supervisor] Max restarts (${MAX_RESTARTS}) exceeded, giving up`)
        process.exit(1)
      }

      // Start standby health check server while child is down
      startStandbyServer()

      const delay = RESTART_BACKOFFS[Math.min(restartCount - 1, RESTART_BACKOFFS.length - 1)]
      console.log(`[supervisor] Restarting in ${delay}ms...`)
      setTimeout(startChild, delay)
    })

    child.on('error', (err) => {
      console.error(`[supervisor] Child process error: ${err.message}`)
    })
  }

  /**
   * While the child is down, serve {"status":"restarting"} on the port
   * so the app knows the server is coming back (not permanently dead).
   */
  function startStandbyServer() {
    if (standbyServer) return

    standbyServer = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'restarting' }))
        return
      }
      res.writeHead(503)
      res.end()
    })

    standbyServer.on('error', (err) => {
      // Port may still be held briefly by the dying child — retry
      if (err.code === 'EADDRINUSE') {
        setTimeout(() => {
          if (standbyServer) {
            standbyServer.close()
            standbyServer = null
            startStandbyServer()
          }
        }, 500)
        return
      }
      console.error(`[supervisor] Standby server error: ${err.message}`)
    })

    standbyServer.listen(PORT, () => {
      console.log(`[supervisor] Standby health check server on port ${PORT}`)
    })
  }

  function stopStandbyServer() {
    if (standbyServer) {
      standbyServer.close()
      standbyServer = null
    }
  }

  // 5. Start the first child
  startChild()

  // 6. Graceful shutdown
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[supervisor] ${signal} received, shutting down...`)

    stopStandbyServer()

    if (child) {
      // Send shutdown message to child, wait for graceful exit
      child.send({ type: 'shutdown' })
      const forceKillTimer = setTimeout(() => {
        console.log('[supervisor] Force-killing child after 5s timeout')
        try { child.kill('SIGKILL') } catch {}
      }, 5000)

      child.on('exit', () => clearTimeout(forceKillTimer))
    }

    await tunnel.stop()

    // Give child a moment to exit
    setTimeout(() => process.exit(0), 1000)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
