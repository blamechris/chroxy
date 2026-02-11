import { fork, execFileSync } from 'child_process'
import { createServer } from 'http'
import { dirname, resolve, join } from 'path'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { EventEmitter } from 'events'
import { TunnelManager } from './tunnel.js'
import { waitForTunnel } from './tunnel-check.js'
import { createLogger } from './logger.js'
import qrcode from 'qrcode-terminal'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEFAULT_PID_FILE = join(homedir(), '.chroxy', 'supervisor.pid')

const DRAIN_TIMEOUT = 30000
const RESTART_BACKOFFS = [2000, 2000, 3000, 3000, 5000, 5000, 8000, 8000, 10000, 10000]
const DEPLOY_CRASH_WINDOW = 60000
const MAX_DEPLOY_FAILURES = 3

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
export class Supervisor extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this._port = config.port || parseInt(process.env.PORT || '8765', 10)
    this._apiToken = config.apiToken || process.env.API_TOKEN
    this._tunnelMode = config.tunnel || 'quick'
    this._pidFilePath = config.pidFilePath || DEFAULT_PID_FILE
    this._knownGoodFile = config.knownGoodFile || join(homedir(), '.chroxy', 'known-good-ref')
    this._maxRestarts = (typeof config.maxRestarts === 'number' && config.maxRestarts >= 0)
      ? config.maxRestarts
      : 10

    this._child = null
    this._restartCount = 0
    this._standbyServer = null
    this._shuttingDown = false
    this._draining = false
    this._childReady = false
    this._tunnel = null
    this._heartbeatInterval = null
    this._currentWsUrl = null
    this._signalsRegistered = false
    this._log = createLogger('supervisor')

    // Deploy rollback tracking
    this._lastDeployTimestamp = 0
    this._deployFailureCount = 0

    this._metrics = {
      startedAt: Date.now(),
      childStartedAt: null,
      totalRestarts: 0,
      consecutiveRestarts: 0,
      lastExitReason: null,
      lastBackoffMs: 0,
    }
  }

  /** Override point: fork a child process */
  _fork(script, args, opts) {
    return fork(script, args, opts)
  }

  /** Override point: create TunnelManager instance */
  _createTunnel() {
    return new TunnelManager({
      port: this._port,
      mode: this._tunnelMode,
      tunnelName: this.config.tunnelName || null,
      tunnelHostname: this.config.tunnelHostname || null,
    })
  }

  /** Override point: wait for tunnel to be routable */
  _waitForTunnel(url) {
    return waitForTunnel(url)
  }

  /** Override point: exit the process */
  _exit(code) {
    process.exit(code)
  }

  /** Override point: display QR code */
  _displayQr(url) {
    qrcode.generate(url, { small: true })
  }

  /** Override point: register process signal handlers */
  _registerSignals() {
    if (this._signalsRegistered) return
    this._signalsRegistered = true

    process.on('SIGUSR2', () => {
      if (this._draining) {
        this._log.info('SIGUSR2 received but drain already in progress, ignoring')
        return
      }
      if (!this._childReady) {
        this._log.info('SIGUSR2 received but child not ready yet, ignoring')
        return
      }
      this._log.info('SIGUSR2 received (deploy restart)')
      this._lastDeployTimestamp = Date.now()
      this.restartChild()
    })

    process.on('SIGINT', () => this.shutdown('SIGINT'))
    process.on('SIGTERM', () => this.shutdown('SIGTERM'))
  }

  async start() {
    if (!this._apiToken) {
      console.error('[!] No API token configured. Run \'npx chroxy init\' first.')
      this._exit(1)
      return
    }

    console.log('')
    console.log('╔════════════════════════════════════════╗')
    console.log('║   Chroxy Supervisor v0.1.0              ║')
    console.log('╚════════════════════════════════════════╝')
    console.log('')

    // 1. Start the tunnel (supervisor owns it)
    this._tunnel = this._createTunnel()

    const { wsUrl, httpUrl } = await this._tunnel.start()
    this._currentWsUrl = wsUrl

    this._tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
      this._log.info(`Tunnel recovered after ${attempt} attempt(s)`)
      await this._waitForTunnel(newHttpUrl)

      if (newWsUrl !== this._currentWsUrl) {
        this._currentWsUrl = newWsUrl
        const connectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${this._apiToken}`
        console.log('\nNew tunnel URL:\n')
        this._displayQr(connectionUrl)
        console.log(`\n   URL:   ${newWsUrl}`)
        console.log(`   Token: ${this._apiToken.slice(0, 8)}...`)
        console.log('')
      }
    })

    this._tunnel.on('tunnel_failed', ({ message }) => {
      this._log.error(message)
    })

    // 2. Wait for tunnel to be routable
    await this._waitForTunnel(httpUrl)

    // 3. Display connection info
    const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${this._apiToken}`
    const modeLabel = this._tunnelMode === 'named' ? 'Named Tunnel' : 'Quick Tunnel'

    this._log.info(`${modeLabel} ready`)
    console.log('📱 Scan this QR code with the Chroxy app:\n')
    this._displayQr(connectionUrl)
    console.log(`\nOr connect manually:`)
    console.log(`   URL:   ${wsUrl}`)
    console.log(`   Token: ${this._apiToken.slice(0, 8)}...`)
    console.log('')

    // 4. Write PID file
    try {
      mkdirSync(dirname(this._pidFilePath), { recursive: true })
      writeFileSync(this._pidFilePath, String(process.pid))
      this._log.info(`PID file written: ${this._pidFilePath} (pid: ${process.pid})`)
    } catch (err) {
      this._log.error(`Failed to write PID file ${this._pidFilePath}: ${err.message}`)
    }

    // 5. Start the first child
    this.startChild()

    // 6. Periodic heartbeat
    this._heartbeatInterval = setInterval(() => {
      if (!this._child || this._shuttingDown) return
      const childUptime = this._metrics.childStartedAt ? Math.round((Date.now() - this._metrics.childStartedAt) / 1000) : 0
      const totalUptime = Math.round((Date.now() - this._metrics.startedAt) / 1000)
      this._log.info(`Heartbeat: uptime=${totalUptime}s, childUptime=${childUptime}s, totalRestarts=${this._metrics.totalRestarts}`)
    }, 5 * 60 * 1000)
    this._heartbeatInterval.unref()

    // 7. Register signal handlers
    this._registerSignals()
  }

  startChild() {
    if (this._shuttingDown) return

    const childScript = resolve(__dirname, 'server-cli-child.js')
    const childEnv = {
      ...process.env,
      CHROXY_SUPERVISED: '1',
      CHROXY_TUNNEL: 'none',
    }

    if (this.config.apiToken) childEnv.API_TOKEN = this.config.apiToken
    if (this.config.port) childEnv.PORT = String(this.config.port)
    if (this.config.cwd) childEnv.CHROXY_CWD = this.config.cwd
    if (this.config.model) childEnv.CHROXY_MODEL = this.config.model
    if (this.config.discoveryInterval) childEnv.CHROXY_DISCOVERY_INTERVAL = String(this.config.discoveryInterval)

    this._log.info(`Starting server child (attempt ${this._restartCount + 1})`)
    this._metrics.childStartedAt = Date.now()

    this._child = this._fork(childScript, [], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })

    let stdoutRl, stderrRl
    if (this._child.stdout) {
      stdoutRl = createInterface({ input: this._child.stdout })
      stdoutRl.on('line', (line) => {
        this._log.info(`[child:out] ${line}`)
      })
    }
    if (this._child.stderr) {
      stderrRl = createInterface({ input: this._child.stderr })
      stderrRl.on('line', (line) => {
        this._log.error(`[child:err] ${line}`)
      })
    }

    let deployResetTimer = null
    this._child.on('message', (msg) => {
      if (msg.type === 'ready') {
        this._log.info('Server child is ready')
        this._childReady = true
        this._restartCount = 0
        this._metrics.consecutiveRestarts = 0
        this._stopStandbyServer()
        this.emit('child_ready')

        // Only reset deploy failure count after child survives past the crash window
        if (this._lastDeployTimestamp > 0 && this._deployFailureCount > 0) {
          const remaining = DEPLOY_CRASH_WINDOW - (Date.now() - this._lastDeployTimestamp)
          if (remaining > 0) {
            deployResetTimer = setTimeout(() => {
              this._deployFailureCount = 0
              this._log.info('Deploy crash window passed, resetting failure count')
            }, remaining)
          } else {
            this._deployFailureCount = 0
          }
        }
      }

      if (msg.type === 'drain_complete') {
        this._log.info('Child drain complete, sending SIGTERM')
        this._draining = false
        try { this._child.kill('SIGTERM') } catch {}
      }
    })

    this._child.on('exit', (code, signal) => {
      stdoutRl?.close()
      stderrRl?.close()
      if (deployResetTimer) { clearTimeout(deployResetTimer); deployResetTimer = null }
      const childUptimeMs = this._metrics.childStartedAt ? Date.now() - this._metrics.childStartedAt : 0
      this._child = null
      this._childReady = false
      if (this._shuttingDown) return

      this._log.info(`Server child exited (code ${code}, signal ${signal})`)
      this._restartCount++
      this._metrics.totalRestarts++
      this._metrics.consecutiveRestarts = this._restartCount
      this._metrics.lastExitReason = { code, signal }
      this._metrics.childStartedAt = null
      this.emit('child_exit', { code, signal })

      // Deploy crash detection
      const timeSinceDeploy = Date.now() - this._lastDeployTimestamp
      if (this._lastDeployTimestamp > 0 && timeSinceDeploy < DEPLOY_CRASH_WINDOW) {
        this._deployFailureCount++
        this._log.error(`Deploy crash detected (${this._deployFailureCount}/${MAX_DEPLOY_FAILURES}) — child lasted ${Math.round(childUptimeMs / 1000)}s`)

        if (this._deployFailureCount >= MAX_DEPLOY_FAILURES) {
          this._log.error('Max deploy failures reached, attempting rollback')
          if (this._rollbackToKnownGood()) {
            this._deployFailureCount = 0
            this._lastDeployTimestamp = 0
            this._restartCount = 0
            this._startStandbyServer()
            setTimeout(() => this.startChild(), 2000)
            return
          }
          this._log.error('Rollback failed, continuing with normal restart')
        }
      }

      if (this._restartCount > this._maxRestarts) {
        this._log.error(`Max restarts (${this._maxRestarts}) exceeded, giving up`)
        this.emit('max_restarts_exceeded')
        this._exit(1)
        return
      }

      // Start standby health check server while child is down
      this._startStandbyServer()

      const delay = RESTART_BACKOFFS[Math.min(this._restartCount - 1, RESTART_BACKOFFS.length - 1)]
      this._metrics.lastBackoffMs = delay
      this._log.info(`Child ran for ${Math.round(childUptimeMs / 1000)}s | total restarts: ${this._metrics.totalRestarts} | next backoff: ${delay}ms`)
      setTimeout(() => this.startChild(), delay)
    })

    this._child.on('error', (err) => {
      this._log.error(`Child process error: ${err.message}`)
    })
  }

  /**
   * While the child is down, serve {"status":"restarting"} on the port
   * so the app knows the server is coming back (not permanently dead).
   */
  _startStandbyServer() {
    if (this._standbyServer) return

    this._standbyServer = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'restarting',
          metrics: {
            supervisorUptimeS: Math.round((Date.now() - this._metrics.startedAt) / 1000),
            totalRestarts: this._metrics.totalRestarts,
            consecutiveRestarts: this._metrics.consecutiveRestarts,
            lastExitReason: this._metrics.lastExitReason,
            lastBackoffMs: this._metrics.lastBackoffMs,
          },
        }))
        return
      }
      res.writeHead(503)
      res.end()
    })

    this._standbyServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        setTimeout(() => {
          if (this._standbyServer) {
            this._standbyServer.close()
            this._standbyServer = null
            this._startStandbyServer()
          }
        }, 500)
        return
      }
      this._log.error(`Standby server error: ${err.message}`)
    })

    this._standbyServer.listen(this._port, () => {
      this._log.info(`Standby health check server on port ${this._port}`)
    })
  }

  _stopStandbyServer() {
    if (this._standbyServer) {
      this._standbyServer.close()
      this._standbyServer = null
    }
  }

  /**
   * Graceful restart: drain the child, wait for completion, then restart.
   * Used by the deploy command via SIGUSR2.
   */
  restartChild() {
    if (this._draining || this._shuttingDown) {
      this._log.info('Restart requested but already draining/shutting down, ignoring')
      return
    }
    if (!this._child) {
      this._log.info('Restart requested but no child running, starting fresh')
      this.startChild()
      return
    }

    this._draining = true
    this._log.info('Graceful restart: sending drain to child')
    this._child.send({ type: 'drain', timeout: DRAIN_TIMEOUT })

    const drainTimer = setTimeout(() => {
      if (this._draining && this._child) {
        this._log.info(`Drain timeout (${DRAIN_TIMEOUT}ms), force-killing child`)
        this._draining = false
        try { this._child.kill('SIGTERM') } catch {}
      }
    }, DRAIN_TIMEOUT)

    if (this._child) {
      this._child.once('exit', () => clearTimeout(drainTimer))
    }
  }

  /**
   * Rollback to the last known-good git commit.
   */
  _rollbackToKnownGood() {
    if (!existsSync(this._knownGoodFile)) {
      this._log.error('No known-good ref file found, cannot rollback')
      return false
    }

    try {
      const ref = readFileSync(this._knownGoodFile, 'utf-8').trim()
      if (!ref || ref.length < 7) {
        this._log.error(`Invalid known-good ref: "${ref}"`)
        return false
      }

      const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
      if (!repoRoot) {
        this._log.error('Failed to determine git repository root, cannot rollback')
        return false
      }

      let originalBranch = 'unknown'
      try {
        originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', cwd: repoRoot }).trim()
      } catch {}

      this._log.info(`Rolling back to known-good commit: ${ref.slice(0, 8)}`)
      execFileSync('git', ['checkout', ref], { stdio: 'pipe', cwd: repoRoot })
      const recoverHint = originalBranch && originalBranch !== 'HEAD'
        ? `git checkout ${originalBranch}`
        : 'git reflog  # find your previous HEAD and git checkout <ref>'
      this._log.info(`Rollback successful. To recover: ${recoverHint}`)
      return true
    } catch (err) {
      const stderr = err.stderr?.toString?.().trim()
      if (stderr) this._log.error(`Rollback git stderr: ${stderr}`)
      this._log.error(`Rollback failed: ${err.message}`)
      return false
    }
  }

  async shutdown(signal) {
    if (this._shuttingDown) return
    this._shuttingDown = true
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval)
    this._log.info(`${signal} received, shutting down...`)

    // Remove PID file
    try { unlinkSync(this._pidFilePath) } catch {}

    this._stopStandbyServer()

    if (this._child) {
      this._child.send({ type: 'shutdown' })
      const forceKillTimer = setTimeout(() => {
        this._log.info('Force-killing child after 5s timeout')
        try { this._child.kill('SIGKILL') } catch {}
      }, 5000)

      this._child.on('exit', () => clearTimeout(forceKillTimer))
    }

    if (this._tunnel) {
      await this._tunnel.stop()
    }

    // Give child a moment to exit
    setTimeout(() => this._exit(0), 1000)
  }
}

/**
 * Backward-compatible wrapper: create and start a Supervisor.
 */
export async function startSupervisor(config) {
  const supervisor = new Supervisor(config)
  await supervisor.start()
}
