import { fork, execFileSync } from 'child_process'
import { createServer } from 'http'
import { dirname, resolve, join } from 'path'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { homedir } from 'os'
import { TunnelManager } from './tunnel.js'
import { waitForTunnel } from './tunnel-check.js'
import { createLogger } from './logger.js'
import qrcode from 'qrcode-terminal'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PID_FILE = join(homedir(), '.chroxy', 'supervisor.pid')

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
  const log = createLogger('supervisor')

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
    log.info(`Tunnel recovered after ${attempt} attempt(s)`)
    await waitForTunnel(newHttpUrl)

    if (newWsUrl !== currentWsUrl) {
      currentWsUrl = newWsUrl
      const connectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${API_TOKEN}`
      console.log('\nNew tunnel URL:\n')
      qrcode.generate(connectionUrl, { small: true })
      console.log(`\n   URL:   ${newWsUrl}`)
      console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
      console.log('')
    }
  })

  tunnel.on('tunnel_failed', ({ message }) => {
    log.error(message)
  })

  // 2. Wait for tunnel to be routable
  await waitForTunnel(httpUrl)

  // 3. Display connection info
  const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${API_TOKEN}`
  const modeLabel = TUNNEL_MODE === 'named' ? 'Named Tunnel' : 'Quick Tunnel'

  log.info(`${modeLabel} ready`)
  console.log('📱 Scan this QR code with the Chroxy app:\n')
  qrcode.generate(connectionUrl, { small: true })
  console.log(`\nOr connect manually:`)
  console.log(`   URL:   ${wsUrl}`)
  console.log(`   Token: ${API_TOKEN.slice(0, 8)}...`)
  console.log('')

  // 4. Write PID file for deploy command signaling
  writeFileSync(PID_FILE, String(process.pid))
  log.info(`PID file written: ${PID_FILE} (pid: ${process.pid})`)

  // 5. Child process management
  let child = null
  let restartCount = 0
  let standbyServer = null
  let shuttingDown = false
  let draining = false
  const DRAIN_TIMEOUT = 30000
  const MAX_RESTARTS = (typeof config.maxRestarts === 'number' && config.maxRestarts >= 0)
    ? config.maxRestarts
    : 10
  const RESTART_BACKOFFS = [2000, 2000, 3000, 3000, 5000, 5000, 8000, 8000, 10000, 10000]

  // Deploy rollback tracking
  let lastDeployTimestamp = 0
  let deployFailureCount = 0
  const DEPLOY_CRASH_WINDOW = 60000  // Crash within 60s of deploy = deploy failure
  const DEPLOY_FAILURE_WINDOW = 300000 // 5 min window for counting failures
  const MAX_DEPLOY_FAILURES = 3
  const KNOWN_GOOD_FILE = join(homedir(), '.chroxy', 'known-good-ref')

  const metrics = {
    startedAt: Date.now(),
    childStartedAt: null,
    totalRestarts: 0,
    consecutiveRestarts: 0,
    lastExitReason: null,
    lastBackoffMs: 0,
  }

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

    log.info(`Starting server child (attempt ${restartCount + 1})`)
    metrics.childStartedAt = Date.now()

    child = fork(childScript, [], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })

    let stdoutRl, stderrRl
    if (child.stdout) {
      stdoutRl = createInterface({ input: child.stdout })
      stdoutRl.on('line', (line) => {
        log.info(`[child:out] ${line}`)
      })
    }
    if (child.stderr) {
      stderrRl = createInterface({ input: child.stderr })
      stderrRl.on('line', (line) => {
        log.error(`[child:err] ${line}`)
      })
    }

    let deployResetTimer = null
    child.on('message', (msg) => {
      if (msg.type === 'ready') {
        log.info('Server child is ready')
        restartCount = 0
        metrics.consecutiveRestarts = 0
        stopStandbyServer()

        // Only reset deploy failure count after child survives past the crash window
        if (lastDeployTimestamp > 0 && deployFailureCount > 0) {
          const remaining = DEPLOY_CRASH_WINDOW - (Date.now() - lastDeployTimestamp)
          if (remaining > 0) {
            deployResetTimer = setTimeout(() => {
              deployFailureCount = 0
              log.info('Deploy crash window passed, resetting failure count')
            }, remaining)
          } else {
            deployFailureCount = 0
          }
        }
      }

      if (msg.type === 'drain_complete') {
        log.info('Child drain complete, sending SIGTERM')
        draining = false
        try { child.kill('SIGTERM') } catch {}
      }
    })

    child.on('exit', (code, signal) => {
      stdoutRl?.close()
      stderrRl?.close()
      if (deployResetTimer) { clearTimeout(deployResetTimer); deployResetTimer = null }
      const childUptimeMs = metrics.childStartedAt ? Date.now() - metrics.childStartedAt : 0
      child = null
      if (shuttingDown) return

      log.info(`Server child exited (code ${code}, signal ${signal})`)
      restartCount++
      metrics.totalRestarts++
      metrics.consecutiveRestarts = restartCount
      metrics.lastExitReason = { code, signal }
      metrics.childStartedAt = null

      // Deploy crash detection: if child crashes within 60s of a deploy restart,
      // count it as a deploy failure. 3 failures in 5 min triggers rollback.
      const timeSinceDeploy = Date.now() - lastDeployTimestamp
      if (lastDeployTimestamp > 0 && timeSinceDeploy < DEPLOY_CRASH_WINDOW) {
        deployFailureCount++
        log.error(`Deploy crash detected (${deployFailureCount}/${MAX_DEPLOY_FAILURES}) — child lasted ${Math.round(childUptimeMs / 1000)}s`)

        if (deployFailureCount >= MAX_DEPLOY_FAILURES) {
          log.error('Max deploy failures reached, attempting rollback')
          if (rollbackToKnownGood()) {
            deployFailureCount = 0
            lastDeployTimestamp = 0
            restartCount = 0
            startStandbyServer()
            setTimeout(startChild, 2000)
            return
          }
          log.error('Rollback failed, continuing with normal restart')
        }
      }

      if (restartCount > MAX_RESTARTS) {
        log.error(`Max restarts (${MAX_RESTARTS}) exceeded, giving up`)
        process.exit(1)
      }

      // Start standby health check server while child is down
      startStandbyServer()

      const delay = RESTART_BACKOFFS[Math.min(restartCount - 1, RESTART_BACKOFFS.length - 1)]
      metrics.lastBackoffMs = delay
      log.info(`Child ran for ${Math.round(childUptimeMs / 1000)}s | total restarts: ${metrics.totalRestarts} | next backoff: ${delay}ms`)
      setTimeout(startChild, delay)
    })

    child.on('error', (err) => {
      log.error(`Child process error: ${err.message}`)
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
        res.end(JSON.stringify({
          status: 'restarting',
          metrics: {
            supervisorUptimeS: Math.round((Date.now() - metrics.startedAt) / 1000),
            totalRestarts: metrics.totalRestarts,
            consecutiveRestarts: metrics.consecutiveRestarts,
            lastExitReason: metrics.lastExitReason,
            lastBackoffMs: metrics.lastBackoffMs,
          },
        }))
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
      log.error(`Standby server error: ${err.message}`)
    })

    standbyServer.listen(PORT, () => {
      log.info(`Standby health check server on port ${PORT}`)
    })
  }

  function stopStandbyServer() {
    if (standbyServer) {
      standbyServer.close()
      standbyServer = null
    }
  }

  /**
   * Graceful restart: drain the child, wait for completion, then restart.
   * Used by the deploy command via SIGUSR2.
   */
  function restartChild() {
    if (draining || shuttingDown) {
      log.info('Restart requested but already draining/shutting down, ignoring')
      return
    }
    if (!child) {
      log.info('Restart requested but no child running, starting fresh')
      startChild()
      return
    }

    draining = true
    log.info('Graceful restart: sending drain to child')
    child.send({ type: 'drain', timeout: DRAIN_TIMEOUT })

    // Safety net: if drain_complete never arrives, force restart
    const drainTimer = setTimeout(() => {
      if (draining && child) {
        log.info(`Drain timeout (${DRAIN_TIMEOUT}ms), force-killing child`)
        draining = false
        try { child.kill('SIGTERM') } catch {}
      }
    }, DRAIN_TIMEOUT)

    // Clean up timer when child exits (drain_complete → SIGTERM → exit triggers startChild)
    if (child) {
      child.once('exit', () => clearTimeout(drainTimer))
    }
  }

  /**
   * Rollback to the last known-good git commit.
   * Called when deploy crashes exceed MAX_DEPLOY_FAILURES.
   * @returns {boolean} true if rollback succeeded
   */
  function rollbackToKnownGood() {
    if (!existsSync(KNOWN_GOOD_FILE)) {
      log.error('No known-good ref file found, cannot rollback')
      return false
    }

    try {
      const ref = readFileSync(KNOWN_GOOD_FILE, 'utf-8').trim()
      if (!ref || ref.length < 7) {
        log.error(`Invalid known-good ref: "${ref}"`)
        return false
      }
      log.info(`Rolling back to known-good commit: ${ref.slice(0, 8)}`)
      execFileSync('git', ['checkout', ref], { stdio: 'pipe' })
      log.info('Rollback successful')
      return true
    } catch (err) {
      log.error(`Rollback failed: ${err.message}`)
      return false
    }
  }

  // SIGUSR2 handler: deploy command signals supervisor to restart child
  process.on('SIGUSR2', () => {
    log.info('SIGUSR2 received (deploy restart)')
    lastDeployTimestamp = Date.now()
    restartChild()
  })

  // 6. Start the first child
  startChild()

  // 6b. Periodic heartbeat
  const heartbeatInterval = setInterval(() => {
    if (!child || shuttingDown) return
    const childUptime = metrics.childStartedAt ? Math.round((Date.now() - metrics.childStartedAt) / 1000) : 0
    const totalUptime = Math.round((Date.now() - metrics.startedAt) / 1000)
    log.info(`Heartbeat: uptime=${totalUptime}s, childUptime=${childUptime}s, totalRestarts=${metrics.totalRestarts}`)
  }, 5 * 60 * 1000)
  heartbeatInterval.unref()

  // 7. Graceful shutdown
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(heartbeatInterval)
    log.info(`${signal} received, shutting down...`)

    // Remove PID file
    try { unlinkSync(PID_FILE) } catch {}

    stopStandbyServer()

    if (child) {
      // Send shutdown message to child, wait for graceful exit
      child.send({ type: 'shutdown' })
      const forceKillTimer = setTimeout(() => {
        log.info('Force-killing child after 5s timeout')
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
