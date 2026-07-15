import { fork, execFileSync } from 'child_process'
import { isWindows, forceKill } from './platform.js'
import { createServer } from 'http'
import { dirname, resolve, join } from 'path'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { EventEmitter } from 'events'
import { createTunnel, parseTunnelArg } from './tunnel/index.js'
import { QUICK_TUNNEL_DNS_SETTLE_MS, waitForTunnel } from './tunnel-check.js'
import { createLogger } from './logger.js'
import QRCode from 'qrcode'
import { writeConnectionInfo, removeConnectionInfo } from './connection-info.js'
import { PushManager } from './push.js'

function maskToken(token) {
  if (!token) return ''
  if (token.length <= 8) return token
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

// #6566: the StartupDisplay connect-block lines that carry the API token —
// `   Token: <token>` and `   Dashboard: …?token=<token>`. Under --show-token the
// supervisor prints these RAW to the operator's terminal instead of letting the
// redacting logger scrub them back to [REDACTED] (the child's stdout is re-logged
// through that logger). Deliberately narrow — only the startup banner, never an
// arbitrary log line that happens to mention a token. Exported for the test.
export function isConnectBlockTokenLine(line) {
  return /^\s*Token:\s/.test(line) || /Dashboard:\s.*\?token=/.test(line)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const SUPERVISOR_VERSION = packageJson.version
const DEFAULT_PID_FILE = join(homedir(), '.chroxy', 'supervisor.pid')

const DRAIN_TIMEOUT = 30000
const RESTART_BACKOFFS = [2000, 2000, 3000, 3000, 5000, 5000, 8000, 8000, 10000, 10000]
const DEPLOY_CRASH_WINDOW = 60000
const MAX_DEPLOY_FAILURES = 3
const MAX_STANDBY_EADDRINUSE_RETRIES = 20
const STANDBY_EADDRINUSE_RETRY_DELAY_MS = 500

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
    this._standbyRetries = 0
    this._standbyRetryTimer = null
    // #6022: terminal-down state. When the restart budget is exhausted the
    // supervisor flips the standby server into a terminal `status:'down'`
    // response (reason `supervisor_gave_up`) and serves it for a bounded grace
    // window — long enough for a polling client to observe and latch the
    // terminal state — before exiting. Configurable: 0 keeps the prior
    // exit-immediately behaviour; a larger value extends the signal window.
    this._terminalDown = false
    this._terminalDownTimer = null
    this._terminalDownGraceMs =
      (typeof config.terminalDownGraceMs === 'number' && config.terminalDownGraceMs >= 0)
        ? config.terminalDownGraceMs
        : 15000
    this._shuttingDown = false
    this._draining = false
    this._childReady = false
    this._tunnel = null
    this._heartbeatInterval = null
    this._currentWsUrl = null
    // #6641: true while the tunnel is up but not routable — the server runs
    // local/LAN-only and advertises no remote/QR access. Read by the degrade
    // test; a natural gate for a future auto-reverify.
    this._tunnelDegraded = false
    this._signalsRegistered = false
    this._restartScheduledAt = null
    this._restartDelayMs = null
    this._restartTimer = null
    // #6027: deploy-window reset timer. Instance-scoped (was a startChild-local
    // closure var) so shutdown()/teardown can clear it — otherwise a child that
    // goes ready but never exits leaves a ~DEPLOY_CRASH_WINDOW timer pending.
    this._deployResetTimer = null
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

    this._pushStoragePath = config.pushStoragePath || join(homedir(), '.chroxy', 'push-tokens.json')
  }

  /** Override point: fork a child process */
  _fork(script, args, opts) {
    return fork(script, args, opts)
  }

  /** Override point: create tunnel adapter instance */
  _createTunnel() {
    const tunnelArg = parseTunnelArg(this._tunnelMode)
    if (!tunnelArg) {
      throw new Error('Supervisor requires a tunnel (cannot use tunnel=none)')
    }
    return createTunnel({
      port: this._port,
      mode: tunnelArg.mode,
      tunnelConfig: this.config.tunnelConfig,
      tunnelName: this.config.tunnelName || null,
      tunnelHostname: this.config.tunnelHostname || null,
    })
  }

  /** Override point: wait for tunnel to be routable */
  _waitForTunnel(url, mode = this._tunnelMode) {
    const tunnelArg = parseTunnelArg(mode)
    return waitForTunnel(url, {
      initialDelay: tunnelArg?.mode === 'quick' ? QUICK_TUNNEL_DNS_SETTLE_MS : 0,
    })
  }

  /**
   * #5314 (WP-1.4) — last-resort handler for an uncaught error in the supervisor
   * process. Logs it; stays alive so the child keeps being supervised (killing
   * the supervisor would take down the whole service). Exits only if a shutdown
   * is already underway. Extracted so tests can drive it without real signals.
   */
  _onProcessError(kind, err) {
    // Reflect the actual action: during a deliberate shutdown we exit(1); the
    // rest of the time we stay alive and keep supervising.
    const action = this._shuttingDown ? 'exiting — shutdown in progress' : 'staying alive'
    this._log.error(`Supervisor ${kind} (${action}): ${err?.stack || err}`)
    if (this._shuttingDown) this._exit(1)
  }

  /**
   * #5314 (WP-1.4) — single cleanup path for a boot failure that occurs after
   * cloudflared has started but before the child is forked. Stops cloudflared so
   * it doesn't leak as an orphan, then exits(1). Best-effort stop — we're exiting
   * regardless.
   */
  async _failBoot(err) {
    this._log.error(`Supervisor boot failed before the child started: ${err?.message || err}`)
    try {
      await this._tunnel.stop()
    } catch (stopErr) {
      this._log.error(`Failed to stop cloudflared after boot failure: ${stopErr?.message || stopErr}`)
    }
    this._exit(1)
  }

  /** Override point: exit the process */
  _exit(code) {
    process.exit(code)
  }

  /** Override point: send a push notification */
  async _sendPushNotification(category, title, body) {
    // Create a fresh PushManager each time to reload tokens from disk.
    // The child process writes tokens after clients connect, so the supervisor
    // must re-read the file to pick up any tokens registered since startup.
    //
    // #5430: plumb the `notifications.discord` config block through, mirroring
    // server-cli.js — otherwise the Discord sink runs with default botName/
    // colors/throttle and a supervisor-emitted embed update ("Chroxy server is
    // down") looks different from every other update. The statePath default
    // matches the child server's so both processes converge on the same
    // status message; the sink persists that state atomically (temp+rename).
    //
    // prefsPath mirrors server-cli.js too: without it the per-send manager
    // falls back to default prefs, so supervisor-sent notifications would
    // ignore the operator's category mutes / quiet hours (both sinks gate on
    // prefs) while the child server honors them. Read-only here — the
    // supervisor never calls setPrefs/registerToken — and fresh-per-send
    // picks up prefs the child persisted after startup, same as the tokens.
    const push = new PushManager({
      storagePath: this._pushStoragePath,
      prefsPath: join(homedir(), '.chroxy', 'notification-prefs.json'),
      discord: {
        statePath: join(homedir(), '.chroxy', 'discord-webhook-state.json'),
        ...(this.config.notifications?.discord || {}),
      },
    })
    try {
      await push.send(category, title, body)
    } finally {
      // #5413: release sink resources (the Discord heartbeat interval) —
      // these per-send managers are short-lived by design, and without the
      // destroy a configured Discord sink would leak one live interval per
      // supervisor notification.
      push.destroy()
    }
  }

  /** Override point: display QR code */
  async _displayQr(url) {
    const qrText = await QRCode.toString(url, { type: 'terminal', small: true })
    process.stdout.write(qrText)
  }

  /** Override point: register process signal handlers */
  _registerSignals() {
    if (this._signalsRegistered) return
    this._signalsRegistered = true

    if (!isWindows) {
      // Windows does not support SIGUSR2 — deploy restart is not available
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
    }

    process.on('SIGINT', () => this.shutdown('SIGINT'))
    process.on('SIGTERM', () => this.shutdown('SIGTERM'))

    // #5314 (WP-1.4) — the supervisor had no uncaughtException/unhandledRejection
    // handler, so a stray fault (e.g. the routine tunnel-DNS-settle rejection from
    // an async tunnel_recovered handler) silently killed the supervisor and
    // orphaned the child. Its job is uptime: log loudly and KEEP SUPERVISING.
    // Only let the process exit if we're already in a deliberate shutdown.
    process.on('uncaughtException', (err) => this._onProcessError('uncaughtException', err))
    process.on('unhandledRejection', (err) => this._onProcessError('unhandledRejection', err))
  }

  async start() {
    if (!this._apiToken) {
      process.stderr.write('[!] No API token configured. Run \'npx chroxy init\' first.\n')
      this._exit(1)
      return
    }

    const bannerText = `Chroxy Supervisor v${SUPERVISOR_VERSION}`
    const padded = bannerText.padEnd(36)
    process.stdout.write('\n')
    process.stdout.write('╔════════════════════════════════════════╗\n')
    process.stdout.write(`║   ${padded} ║\n`)
    process.stdout.write('╚════════════════════════════════════════╝\n')
    process.stdout.write('\n')

    // 1. Start the tunnel (supervisor owns it)
    this._tunnel = this._createTunnel()

    const { wsUrl, httpUrl } = await this._tunnel.start()
    this._currentWsUrl = wsUrl

    // Compute modeLabel early so tunnel_recovered handler can reference it
    const tunnelArg = parseTunnelArg(this._tunnelMode)
    this._modeLabel = tunnelArg ? `cloudflare:${tunnelArg.mode}` : this._tunnelMode

    this._tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
      // #5314 (WP-1.4) — this is an ASYNC event listener; an unhandled rejection
      // here (waitForTunnel throws on a routine DNS-settle failure) would crash
      // the supervisor. Contain it: log and let the next tunnel_recovered retry.
      try {
      this._log.info(`Tunnel recovered after ${attempt} attempt(s)`)
      await this._waitForTunnel(newHttpUrl)

      if (newWsUrl !== this._currentWsUrl) {
        this._currentWsUrl = newWsUrl
        const connectionUrl = `chroxy://${newWsUrl.replace('wss://', '')}?token=${this._apiToken}`
        process.stdout.write('\nNew tunnel URL:\n\n')
        await this._displayQr(connectionUrl)
        process.stdout.write(`\n   URL:   ${newWsUrl}\n`)
        process.stdout.write(`   Token: ${maskToken(this._apiToken)}\n`)
        process.stdout.write('\n')

        // Update connection info file with new tunnel URL
        writeConnectionInfo({
          wsUrl: newWsUrl,
          httpUrl: newHttpUrl,
          port: this._port, // #5683 — local loopback port for the CLI
          apiToken: this._apiToken,
          connectionUrl,
          tunnelMode: this._modeLabel,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        })
      }
      } catch (err) {
        this._log.error(`tunnel_recovered handler failed (will retry on next recovery): ${err?.message || err}`)
      }
    })

    this._tunnel.on('tunnel_failed', ({ message }) => {
      this._log.error(message)
    })

    // 2. Wait for the tunnel to be routable. #6641 — a not-yet-routable tunnel
    // must NOT abort the whole daemon. The default `chroxy start` used to
    // exit(1) here whenever a warming quick-tunnel edge answered with a status
    // outside {502,530} (e.g. a bare 404 during route propagation), taking down
    // local + LAN access with it. Instead, degrade to local/LAN: start the
    // child anyway so the server is usable right now.
    //
    // Degraded mode does NOT auto-recover to remote: `tunnel_recovered` only
    // fires when the cloudflared PROCESS flaps (tunnel/base.js), not when an
    // alive-but-unroutable tunnel finishes propagating, and there is no
    // routability re-poll. So we advertise NO remote/QR access and tell the
    // operator to restart (or use --tunnel named) once the tunnel is routable,
    // rather than promising a QR that would never appear. (An auto re-verify in
    // degraded mode is a possible follow-up — see #6641.)
    //
    // #5314 (WP-1.4) note: on the SIGINT/SIGTERM path the no-orphan guarantee
    // still holds — shutdown() stops the tunnel and the supervised child
    // together. (The crash-loop give-up path, _serveTerminalDown(), does not
    // stop the tunnel — a pre-existing gap, not introduced here.) A
    // NON-routability error (an unexpected throw) still takes the old
    // stop-cloudflared-then-exit cleanup path via _failBoot().
    let tunnelRoutable = true
    try {
      await this._waitForTunnel(httpUrl)
    } catch (err) {
      if (err?.code !== 'TUNNEL_NOT_ROUTABLE') {
        await this._failBoot(err)
        return
      }
      tunnelRoutable = false
      this._tunnelDegraded = true
      this._log.warn(
        'Tunnel not routable — starting in local/LAN mode; remote access is ' +
        'unavailable. Restart once your network/tunnel is ready, or use ' +
        `--tunnel named for a stable URL. ${err.message}`
      )
    }

    // 3. Display + persist connection info. The QR is shown ONLY for a routable
    // tunnel — a QR to a not-yet-routable endpoint just hangs the app (the exact
    // failure #6641 addresses), so in degraded mode we advertise local/LAN only.
    // A throw in this block (QR encode / disk write) still routes to _failBoot().
    try {
      const connectionUrl = `chroxy://${wsUrl.replace('wss://', '')}?token=${this._apiToken}`

      if (tunnelRoutable) {
        // 3a. Display connection info
        this._log.info(`${this._modeLabel} ready`)
        process.stdout.write('📱 Scan this QR code with the Chroxy app:\n\n')
        await this._displayQr(connectionUrl)
        process.stdout.write('\nOr connect manually:\n')
        process.stdout.write(`   URL:   ${wsUrl}\n`)
        process.stdout.write(`   Token: ${maskToken(this._apiToken)}\n`)
        const dashboardBase = httpUrl || `http://localhost:${this._port}`
        process.stdout.write(`   Dashboard: ${dashboardBase.replace(/\/+$/, '')}/dashboard\n`)
        process.stdout.write('\n')
      } else {
        // 3a. Degraded: local/LAN only, no QR to a dead endpoint, and no false
        // promise of auto-recovery (#6641 review).
        process.stdout.write('\n⚠️  Tunnel not routable — serving on local/LAN only (no remote/QR access).\n')
        process.stdout.write(`   Dashboard: http://localhost:${this._port}/dashboard\n`)
        process.stdout.write(`   LAN:       http://<this-machine-ip>:${this._port}/dashboard\n`)
        process.stdout.write(`   Token: ${maskToken(this._apiToken)}\n`)
        process.stdout.write('   For remote (phone) access, restart once the tunnel is routable, or use --tunnel named.\n\n')
      }

      // 3b. Write connection info file for programmatic access. In degraded mode
      // OMIT the public wsUrl/httpUrl/connectionUrl (they're not routable) so no
      // consumer advertises a dead endpoint — notably the dashboard /qr route
      // falls back to connectionUrl, which would otherwise resurface the exact
      // dead QR #6641 kills, just in the dashboard modal (#6641 review). The
      // local `port` is still written so loopback CLIs (chroxy publish / pages)
      // hit the right port even in tunnel mode (#5683).
      writeConnectionInfo({
        wsUrl: tunnelRoutable ? wsUrl : null,
        httpUrl: tunnelRoutable ? httpUrl : null,
        port: this._port,
        apiToken: this._apiToken,
        connectionUrl: tunnelRoutable ? connectionUrl : null,
        tunnelMode: this._modeLabel,
        tunnelDegraded: !tunnelRoutable,
        startedAt: new Date().toISOString(),
        pid: process.pid,
      })
    } catch (err) {
      await this._failBoot(err)
      return
    }

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

    // Defensive: cancel any pending crash-backoff restart so two startChild()
    // calls can't fork two children. A child crash schedules
    // `_restartTimer = setTimeout(startChild, backoff)`; if a restartChild()
    // lands during that backoff window its `!this._child` branch calls
    // startChild() immediately — without this, the still-pending backoff timer
    // would later fire a SECOND startChild() and orphan the first child. The
    // SIGUSR2 `_childReady` guard makes the race rare, but a direct/extra caller
    // would otherwise double-fork. Clearing an already-fired timer is a no-op,
    // so the normal timer-driven restart path is unaffected.
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }

    // Free the port BEFORE forking the replacement child. After a crash the
    // exit handler starts a standby health server bound to `this._port`; if it
    // is still listening when the new child forks, the child's own `listen()`
    // fails with EADDRINUSE and it exits before sending `ready` — so the
    // `_stopStandbyServer()` on `ready` (below) never runs, the standby stays
    // up, and every restart attempt hits the same EADDRINUSE until the restart
    // cap, silently bricking the daemon on the first crash. Stopping standby
    // here (idempotent when none is running, e.g. the first start) guarantees
    // the port is available for the child to bind. `close()` releases the
    // listening socket; the standby has no keep-alive clients to drain.
    this._stopStandbyServer()

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
    if (this.config.showToken) childEnv.CHROXY_SHOW_TOKEN = '1'
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
        // #6566: honour --show-token through the supervisor pipe. The child prints
        // the real token in the connect-block when --show-token is set, but the
        // logger's secret-redaction scrubs it on the way to the terminal. When the
        // operator explicitly asked to see it, print those lines RAW to the
        // terminal and log a REDACTED copy to the FILE only (toConsole:false), so
        // the token reaches the operator's terminal but never lands on disk.
        if (this.config.showToken && isConnectBlockTokenLine(line)) {
          process.stdout.write(`${line}\n`)
          this._log.info(`[child:out] ${line}`, { toConsole: false })
          return
        }
        this._log.info(`[child:out] ${line}`)
      })
    }
    if (this._child.stderr) {
      stderrRl = createInterface({ input: this._child.stderr })
      stderrRl.on('line', (line) => {
        this._log.error(`[child:err] ${line}`)
      })
    }

    this._child.on('message', (msg) => {
      if (msg.type === 'ready') {
        this._log.info('Server child is ready')
        this._childReady = true
        this._restartCount = 0
        this._restartScheduledAt = null
        this._restartDelayMs = null
        this._metrics.consecutiveRestarts = 0
        this._stopStandbyServer()
        this.emit('child_ready')

        // Only reset deploy failure count after child survives past the crash window
        if (this._lastDeployTimestamp > 0 && this._deployFailureCount > 0) {
          const remaining = DEPLOY_CRASH_WINDOW - (Date.now() - this._lastDeployTimestamp)
          if (remaining > 0) {
            this._deployResetTimer = setTimeout(() => {
              this._deployResetTimer = null
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
      // Use a non-async outer listener with a guarded inner async IIFE so that
      // any uncaught throw in the handler is logged rather than becoming an
      // unhandled promise rejection (EventEmitter does not observe returned promises).
      void (async () => {
        stdoutRl?.close()
        stderrRl?.close()
        if (this._deployResetTimer) { clearTimeout(this._deployResetTimer); this._deployResetTimer = null }
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
              this._restartScheduledAt = Date.now()
              this._restartDelayMs = 2000
              this._restartTimer = setTimeout(() => this.startChild(), 2000)
              return
            }
            this._log.error('Rollback failed — exiting to prevent crash loop')
            this._exit(1)
            return
          }
        }

        if (this._restartCount > this._maxRestarts) {
          this._log.error(`Max restarts (${this._maxRestarts}) exceeded, giving up`)
          this.emit('max_restarts_exceeded')
          try {
            // Cap the push wait at 5s so a slow network cannot delay process exit
            // meaningfully. The notification is best-effort.
            const pushTimeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('push notification timed out')), 5000)
            )
            await Promise.race([
              this._sendPushNotification(
                'activity_error',
                'Chroxy server is down',
                'Maximum restart attempts exceeded. Restart the Chroxy daemon.',
              ),
              pushTimeout,
            ])
          } catch (pushErr) {
            this._log.error(`Failed to send push notification on supervisor exit: ${pushErr.message}`)
          }
          // #6022: serve a terminal-down signal before exiting. The crash-looping
          // child is dead, so there is no live WS path to broadcast a final
          // shutdown through (the "dead-child problem"). Instead the supervisor —
          // which still owns the port and the tunnel — flips the standby server
          // into a terminal `status:'down'` response and serves it for a bounded
          // grace window. A reconnecting client (local or remote, via the tunnel)
          // polling /health during that window sees an explicit terminal-down
          // status and can latch its "server appears down" state, instead of
          // reconnect-looping forever once the port goes silent. After the grace
          // window the supervisor exits(1) as before — freeing the port and
          // preserving any outer launchd/KeepAlive recovery semantics.
          this._serveTerminalDown()
          return
        }

        // Start standby health check server while child is down
        this._startStandbyServer()

        const delay = RESTART_BACKOFFS[Math.min(this._restartCount - 1, RESTART_BACKOFFS.length - 1)]
        this._metrics.lastBackoffMs = delay
        this._restartScheduledAt = Date.now()
        this._restartDelayMs = delay
        this._log.info(`Child ran for ${Math.round(childUptimeMs / 1000)}s | total restarts: ${this._metrics.totalRestarts} | next backoff: ${delay}ms`)
        this._restartTimer = setTimeout(() => this.startChild(), delay)
      })().catch((err) => this._log.error(`Unexpected error in child exit handler: ${err.message}`))
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

    if (this._standbyRetries >= MAX_STANDBY_EADDRINUSE_RETRIES) {
      this._log.error(`Standby server: giving up after ${MAX_STANDBY_EADDRINUSE_RETRIES} EADDRINUSE retries`)
      // Reset so future restart cycles can attempt standby again
      this._standbyRetries = 0
      return
    }

    this._standbyServer = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        // #6022: terminal-down — the restart budget is exhausted and the
        // supervisor is about to exit. Report an explicit, non-transient down
        // status so a polling client distinguishes "gave up" from the
        // recoverable "restarting" state (and from a silent port = asleep).
        if (this._terminalDown) {
          // 200 (not 503) deliberately: the client health probe discards the
          // body on a non-2xx response (`if (!res.ok) throw`) and keys off the
          // `status` field — exactly as it does for the 200 `status:'restarting'`
          // signal. A 503 would make this terminal-down body invisible to the
          // reconnect ladder (#6023). The `status:'down'` field is the
          // discriminator; selection still keys off `status:'ok'`, so a 'down'
          // box is never mistaken for a healthy one.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            status: 'down',
            reason: 'supervisor_gave_up',
            fatal: true,
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
        // Calculate restart ETA: remaining backoff time + estimated child startup (~5s)
        // Uses actual scheduled time to account for elapsed wait since the restart was queued
        const STARTUP_ESTIMATE = 5000
        let restartEtaMs
        if (this._restartScheduledAt && this._restartDelayMs != null) {
          const elapsed = Date.now() - this._restartScheduledAt
          const remaining = Math.max(0, this._restartDelayMs - elapsed)
          restartEtaMs = remaining + STARTUP_ESTIMATE
        } else {
          // Fallback: estimate from backoff schedule (first request before tracking is set)
          const backoffIdx = Math.min(this._restartCount - 1, RESTART_BACKOFFS.length - 1)
          const nextBackoff = backoffIdx >= 0 ? RESTART_BACKOFFS[backoffIdx] : 2000
          restartEtaMs = nextBackoff + STARTUP_ESTIMATE
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'restarting',
          restartEtaMs,
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
        this._standbyRetries++
        this._standbyRetryTimer = setTimeout(() => {
          this._standbyRetryTimer = null
          if (this._standbyServer) {
            this._standbyServer.close()
            this._standbyServer = null
            this._startStandbyServer()
          }
        }, STANDBY_EADDRINUSE_RETRY_DELAY_MS)
        return
      }
      this._log.error(`Standby server error: ${err.message}`)
    })

    this._standbyServer.listen(this._port, () => {
      this._standbyRetries = 0
      this._log.info(`Standby health check server on port ${this._port}`)
    })
  }

  _stopStandbyServer() {
    if (this._standbyRetryTimer) {
      clearTimeout(this._standbyRetryTimer)
      this._standbyRetryTimer = null
    }
    if (this._standbyServer) {
      this._standbyServer.close()
      this._standbyServer = null
    }
  }

  /**
   * #6022 — the restart budget is exhausted. Bind the port (reusing the standby
   * server, now in terminal-down mode) to serve an explicit
   * `status:'down' reason:'supervisor_gave_up'` health response, hold it for the
   * configured grace window so a polling client can observe and latch the
   * terminal state, then exit(1). A grace of 0 preserves the prior
   * exit-immediately behaviour (the terminal server is started and torn down on
   * the next tick).
   */
  _serveTerminalDown() {
    // Idempotent: the give-up branch is single-call by construction (the child
    // is dead and not respawned), but guard defensively against a future caller.
    if (this._terminalDown) return
    this._terminalDown = true
    // Reuse the standby server machinery (incl. its EADDRINUSE retry) — the
    // crash-looped child is dead, so the port is normally free. The handler
    // serves the terminal-down body while `_terminalDown` is set.
    this._startStandbyServer()
    this._terminalDownTimer = setTimeout(() => {
      this._terminalDownTimer = null
      this._stopStandbyServer()
      this._exit(1)
    }, this._terminalDownGraceMs)
    // Do NOT unref: this timer is the supervisor's last responsibility — the
    // process must stay alive serving the terminal-down status until it fires.
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
    // #6043: fire-and-forget drain safety net — never gate process exit on it.
    // The supervisor stays alive via its own listening handles during a drain;
    // this timer is only the fallback SIGTERM if the child ignores drain.
    if (typeof drainTimer.unref === 'function') drainTimer.unref()

    if (this._child) {
      this._child.once('exit', () => clearTimeout(drainTimer))
    }
  }

  /**
   * Rollback to the last known-good git commit.
   *
   * Hardened against Adversary A9 (2026-04-11 audit): an attacker who
   * holds a session-capable WS token could previously create a
   * session with cwd=~/.chroxy, call `write_file` on `known-good-ref`
   * with an arbitrary git SHA, and wait for a crash-loop restart to
   * trigger the rollback — at which point the supervisor would check
   * out whatever commit the attacker chose (potentially an older,
   * exploitable version of the server).
   *
   * Two layers of defense now close this:
   *
   * 1. `~/.chroxy` is in FORBIDDEN_HOME_SUBDIRS, so sessions can no
   *    longer create a cwd inside it — the attacker can't reach
   *    `known-good-ref` via `write_file`.
   *
   * 2. This function validates that the ref resolves to the SAME
   *    commit as an existing `known-good-*` git tag. The tag is
   *    written by `chroxy deploy` immediately after the ref file, is
   *    never updated from the WS handlers, and lives in the git
   *    object database (not the filesystem). Even if layer 1 were
   *    bypassed, the attacker would need to also create a matching
   *    git tag — which requires filesystem access to `.git/refs/tags`
   *    or a local git invocation, both of which already imply full
   *    machine compromise.
   */
  _rollbackToKnownGood() {
    if (!existsSync(this._knownGoodFile)) {
      this._log.error('No known-good ref file found, cannot rollback')
      return false
    }

    try {
      const ref = readFileSync(this._knownGoodFile, 'utf-8').trim()
      // SHA-1 git commits are 40 hex chars; accept short SHAs
      // ≥ 7 chars to match historical behavior but require
      // hex-only content. Rejects arbitrary branch names, refspecs,
      // option flags (-rf, --help), etc.
      if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
        this._log.error(`Invalid known-good ref format: "${ref.slice(0, 64)}"`)
        return false
      }

      const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
      if (!repoRoot) {
        this._log.error('Failed to determine git repository root, cannot rollback')
        return false
      }

      // A9 defense: require the ref to match a `known-good-*` tag's
      // commit. This guarantees the ref was written by `chroxy deploy`
      // and not by a compromised WS handler — deploy creates the tag
      // immediately before/after writing the ref file.
      let refFullSha
      try {
        refFullSha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf-8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      } catch {
        this._log.error(`Known-good ref "${ref}" does not resolve to a git commit; refusing rollback`)
        return false
      }

      let knownGoodTags = ''
      try {
        knownGoodTags = execFileSync('git', ['tag', '--list', 'known-good-*'], { encoding: 'utf-8', cwd: repoRoot }).trim()
      } catch {}
      const tags = knownGoodTags ? knownGoodTags.split('\n').filter(Boolean) : []
      let matched = false
      for (const tag of tags) {
        try {
          const tagSha = execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf-8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
          if (tagSha === refFullSha) {
            matched = true
            break
          }
        } catch {
          // Skip unresolvable tags — real known-good tags always resolve
        }
      }
      if (!matched) {
        this._log.error(`Known-good ref "${ref.slice(0, 8)}" does not match any known-good-* tag; refusing rollback (possible A9 poisoning attempt)`)
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
    if (this._restartTimer) clearTimeout(this._restartTimer)
    if (this._deployResetTimer) { clearTimeout(this._deployResetTimer); this._deployResetTimer = null }
    // #6022: a SIGINT/SIGTERM during the terminal-down grace window pre-empts it
    // — drop the pending exit(1) timer; the shutdown path below exits(0) cleanly.
    if (this._terminalDownTimer) { clearTimeout(this._terminalDownTimer); this._terminalDownTimer = null }
    this._log.info(`${signal} received, shutting down...`)

    // Remove PID file
    try { unlinkSync(this._pidFilePath) } catch {}
    removeConnectionInfo()

    this._stopStandbyServer()

    if (this._child) {
      const childRef = this._child
      childRef.send({ type: 'shutdown' })
      const forceKillTimer = setTimeout(() => {
        this._log.info('Force-killing child after 5s timeout')
        try { forceKill(childRef) } catch {}
      }, 5000)
      // #6043: fire-and-forget shutdown safety net — never gate process exit on
      // it. During shutdown the supervisor is held alive by the awaited
      // tunnel.stop() and remaining handles; the goal of this path is exit, so
      // if the loop is otherwise idle the process should exit, not be pinned for
      // 5s. The child is in this process group and is reaped on full exit.
      if (typeof forceKillTimer.unref === 'function') forceKillTimer.unref()

      childRef.once('exit', () => clearTimeout(forceKillTimer))

      // Register the exit-driven _exit(0) call BEFORE awaiting the tunnel so
      // it is in place even if the child exits while the tunnel is stopping.
      // The 5s force-kill above ensures the child eventually exits even if it
      // ignores the shutdown message, so this listener always fires.
      childRef.once('exit', () => this._exit(0))

      if (this._tunnel) {
        await this._tunnel.stop()
      }
    } else {
      if (this._tunnel) {
        await this._tunnel.stop()
      }
      this._exit(0)
    }
  }
}

/**
 * Backward-compatible wrapper: create and start a Supervisor.
 */
export async function startSupervisor(config) {
  const supervisor = new Supervisor(config)
  await supervisor.start()
}
